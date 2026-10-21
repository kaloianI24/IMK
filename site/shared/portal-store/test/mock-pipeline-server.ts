// site/shared/portal-store/test/mock-pipeline-server.ts
//
// A libSQL/Turso HTTP v2 pipeline server — FOR TESTS ONLY.
//
// WHY IT EXISTS
//   The libSQL adapter has to be provable with NO cloud database. This server
//   speaks the REAL wire protocol, so the adapter is exercised through the
//   same code path it uses in production: real fetch, real JSON, real
//   headers, real error shapes.
//
//   The SQL is executed by a real SQLite engine (test/sqlite-worker.py — the
//   SQLite that ships with the Python standard library). libSQL is a fork of
//   SQLite, so the dialect is the same. That is what turns the contract test
//   from "the adapter says the right SQL" into "the adapter produces the
//   right DATA".
//
// WHAT IT REPRODUCES (design §3.1 — the trap)
//   A failed statement comes back as { "type": "error", "error": { … } }
//   INSIDE results[], while the HTTP status is still 200. A client that only
//   looks at the status code reports a successful write for a write that never
//   happened. This server reproduces that exactly.
//
// IT BINDS PORT 0
//   The OS picks a free port. Port 4321 is never used (a dev server owns it).
//
// IT IS TYPESCRIPT, NOT .mjs
//   The design doc named this file mock-pipeline-server.mjs. It is TypeScript
//   here because site/shared/** is type-checked (site/tsconfig.api.json
//   includes "shared/**/*.ts") and a test double with an untyped protocol
//   surface is exactly where a typo hides.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Find the Python worker.
 *
 * The contract test is BUNDLED with esbuild into a temp directory, so
 * import.meta.url no longer points at this folder. The candidates below cover
 * the bundled case (cwd = site/) and the unbundled case.
 */
export function findSqliteWorker(): string {
  const candidates = [
    process.env.LIBSQL_SQLITE_WORKER,
    join(HERE, 'sqlite-worker.py'),
    resolve(process.cwd(), 'shared/portal-store/test/sqlite-worker.py'),
    resolve(process.cwd(), 'site/shared/portal-store/test/sqlite-worker.py'),
    resolve(process.cwd(), '../site/shared/portal-store/test/sqlite-worker.py'),
  ].filter((c): c is string => typeof c === 'string' && c.length > 0);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `the sqlite worker could not be found (looked in: ${candidates.join(', ')}). ` +
      'Set LIBSQL_SQLITE_WORKER to point at it.',
  );
}

/** Find a python interpreter. The standard library's sqlite3 is all we need. */
export function findPython(): string {
  const candidates = process.env.LIBSQL_TEST_PYTHON
    ? [process.env.LIBSQL_TEST_PYTHON]
    : ['python3', 'python', 'py'];
  for (const candidate of candidates) {
    if (candidate) return candidate;
  }
  throw new Error('no python interpreter found (set LIBSQL_TEST_PYTHON)');
}

interface PendingAnswer {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
}

/** The Python worker: one SQLite connection, one statement at a time. */
class SqliteEngine {
  private child: ChildProcessWithoutNullStreams | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private pending: PendingAnswer[] = [];
  private buffer = '';
  private dead = false;

  constructor(
    private readonly python: string,
    private readonly workerPath: string,
  ) {}

  start(): void {
    const args = this.python === 'py' ? ['-3', this.workerPath] : [this.workerPath];
    this.child = spawn(this.python, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.onData(chunk));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => {
      process.stderr.write(`[sqlite-worker] ${chunk}`);
    });
    this.child.on('exit', () => {
      this.dead = true;
      for (const entry of this.pending.splice(0)) {
        entry.reject(new Error('the sqlite worker exited'));
      }
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf('\n');
    while (index !== -1) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line) {
        let answer: any;
        try {
          answer = JSON.parse(line);
        } catch {
          answer = { error: { message: `unparseable worker answer: ${line}`, code: 'BAD_JSON' } };
        }
        // The worker answers in order and only one statement is in flight at
        // a time (the queue below), so the answers are matched FIFO.
        const entry = this.pending.shift();
        if (entry) entry.resolve(answer);
      }
      index = this.buffer.indexOf('\n');
    }
  }

  private send(message: unknown): Promise<any> {
    if (this.dead || !this.child) {
      return Promise.reject(new Error('the sqlite worker is not running'));
    }
    const promise = new Promise((resolveAnswer, rejectAnswer) => {
      this.pending.push({ resolve: resolveAnswer, reject: rejectAnswer });
    });
    this.child.stdin.write(JSON.stringify(message) + '\n');
    return promise;
  }

  exec(sql: string, args: unknown[]): Promise<any> {
    const run = this.queue.then(() => this.send({ op: 'exec', sql, args }));
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  reset(): Promise<any> {
    const run = this.queue.then(() => this.send({ op: 'reset' }));
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  stop(): void {
    this.dead = true;
    try {
      this.child?.stdin.write(JSON.stringify({ op: 'close' }) + '\n');
      this.child?.stdin.end();
    } catch {
      /* the worker is going away anyway */
    }
    try {
      this.child?.kill();
    } catch {
      /* already gone */
    }
  }
}

export interface MockPipelineServer {
  /** The base URL of the mock database (without /v2/pipeline). */
  url: string;
  /** The bearer token the server expects. */
  token: string;
  /** Every request body the server received (for assertions). */
  requests: unknown[];
  /** Drop every row and start again with an empty database. */
  reset(): Promise<void>;
  /** Stop the server and the worker. */
  close(): Promise<void>;
}

export interface MockPipelineOptions {
  token?: string;
}

/**
 * Start the mock pipeline server on a free port.
 */
export async function startMockPipelineServer(
  options: MockPipelineOptions = {},
): Promise<MockPipelineServer> {
  const token = options.token ?? 'imk-test-token';
  const engine = new SqliteEngine(findPython(), findSqliteWorker());
  engine.start();

  const requests: unknown[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      void (async () => {
        const url = req.url ?? '';

        if (req.method === 'GET' && url === '/__control/health') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, engine: 'sqlite' }));
          return;
        }

        if (req.method === 'POST' && url === '/__control/reset') {
          try {
            await engine.reset();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: String(err) }));
          }
          return;
        }

        if (url !== '/v2/pipeline') {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'not found' }));
          return;
        }

        const authorization = req.headers.authorization ?? '';
        if (authorization !== `Bearer ${token}`) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'unauthorized' }));
          return;
        }

        let body: any;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'bad request' }));
          return;
        }

        const list: any[] = Array.isArray(body?.requests) ? body.requests : [];
        requests.push(body);

        const results: unknown[] = [];
        for (const request of list) {
          if (request?.type === 'close') {
            results.push({ type: 'ok', response: { type: 'close' } });
            continue;
          }
          if (request?.type !== 'execute') {
            results.push({
              type: 'error',
              error: { message: `unsupported request type: ${request?.type}`, code: 'UNSUPPORTED' },
            });
            continue;
          }
          const stmt = request.stmt ?? {};
          const answer = await engine.exec(String(stmt.sql ?? ''), stmt.args ?? []);
          if (answer?.error) {
            // The trap: HTTP 200, an error INSIDE results[].
            results.push({ type: 'error', error: answer.error });
            continue;
          }
          results.push({
            type: 'ok',
            response: {
              type: 'execute',
              result: {
                cols: answer.cols ?? [],
                rows: answer.rows ?? [],
                affected_row_count: answer.affected_row_count ?? 0,
                last_insert_rowid: null,
              },
            },
          });
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ baton: null, base_url: null, results }));
      })();
    });
  });

  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    // Port 0: the OS picks a free port. NEVER 4321 (the dev server owns it).
    server.listen(0, '127.0.0.1', () => resolvePromise());
  });

  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  if (port === 4321) {
    // Belt and braces: the dev server owns 4321 and this must never take it.
    await new Promise<void>((r) => server.close(() => r()));
    throw new Error('refusing to run the mock server on port 4321');
  }

  return {
    url: `http://127.0.0.1:${port}`,
    token,
    requests,
    reset: async () => {
      await engine.reset();
    },
    close: async () => {
      engine.stop();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
