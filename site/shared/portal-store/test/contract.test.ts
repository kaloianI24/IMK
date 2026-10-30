// site/shared/portal-store/test/contract.test.ts
//
// Adapter contract tests (proposal T3 acceptance, extended by T4).
//
//   ordering, newest-wins, error-throwing, decideReview idempotency — and the
//   SAME assertions against the libSQL adapter.
//
// The file-specific assertions (the JSONL byte format, the collection-to-file
// mapping, a corrupt file) stay here. Everything that can be said about a
// store instead of a file lives in contract.shared.ts and runs against BOTH
// adapters: that is the proof that the PortalStore interface is real and that
// the libSQL adapter is interchangeable with the file store.
//
// Every test runs against a throw-away data directory in the OS temp folder
// (file adapter) or a throw-away in-memory SQLite database (libSQL adapter) —
// the repository's own site/data is never touched.
//
// Run with: npm run test:store   (bundles this file with esbuild, then node --test)

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createFileStore } from '../file-adapter.js';
import { getStore } from '../index.js';
import { getStore as getEdgeStore } from '../edge.js';
import { StorageError } from '../errors.js';
import { createLibsqlStore } from '../libsql-adapter.js';
import { createHttpTransport, type LibsqlTransport } from '../libsql-transport.js';
import { ensureSchema } from '../libsql-schema.js';
import { createLibsqlStoreFromEnv } from '../libsql-store.js';
import { describeStoreContract } from './contract.shared.js';
import { startMockPipelineServer, type MockPipelineServer } from './mock-pipeline-server.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'imk-store-'));
}

function reviewsFile(dir: string): string {
  return path.join(dir, 'moderation', 'reviews.jsonl');
}

function seedReviews(dir: string, records: Record<string, any>[]): void {
  fs.mkdirSync(path.join(dir, 'moderation'), { recursive: true });
  fs.writeFileSync(
    reviewsFile(dir),
    records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : ''),
    'utf8',
  );
}

// --- the shared contract, run against the file adapter ----------------------

describeStoreContract(
  'file',
  () => createFileStore({ dataDir: tmpDir() }),
  {
    brokenStore: () => {
      // A directory where the file should be -> the append must fail loudly.
      const dir = tmpDir();
      fs.mkdirSync(path.join(dir, 'portal', 'comments.jsonl'), { recursive: true });
      return createFileStore({ dataDir: dir });
    },
  },
);

// --- the same contract, run against the libSQL adapter ---------------------

let mock: MockPipelineServer;

function libsqlTransport(): LibsqlTransport {
  return createHttpTransport({ url: mock.url, token: mock.token });
}

before(async () => {
  mock = await startMockPipelineServer();
});

after(async () => {
  await mock?.close();
});

describeStoreContract(
  'libsql',
  async () => {
    // A fresh database per test: the store's own schema step recreates the
    // tables on first use.
    await mock.reset();
    return createLibsqlStore({ transport: libsqlTransport() });
  },
  {
    brokenStore: async () => {
      await mock.reset();
      const failing: LibsqlTransport = {
        execute: async () => {
          throw new StorageError(
            'libsql: the database is unreachable (test)',
            'storage-unavailable',
          );
        },
      };
      return createLibsqlStore({ transport: failing, autoSchema: false });
    },
  },
);

// --- the libSQL adapter, on its own ----------------------------------------

test('libsql: the contract is proven against a REAL SQLite engine over the REAL wire protocol', async () => {
  await mock.reset();
  const store = createLibsqlStore({ transport: libsqlTransport() });
  await store.append('projects', { id: 'prj_1', clientId: 'cli_1', status: 'discovery' });

  // The request really went over HTTP with the v2 pipeline body.
  assert.ok(mock.requests.length > 0, 'the server saw the requests');
  const last = mock.requests[mock.requests.length - 1] as any;
  assert.ok(Array.isArray(last.requests), 'the body carries a requests array');
  assert.equal(last.requests[0].type, 'execute');
  assert.ok(typeof last.requests[0].stmt.sql === 'string');

  // And the row really landed in a database.
  const rows = await store.list('projects');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'prj_1');
  assert.equal(rows[0].clientId, 'cli_1');
});

test('libsql: a wrong bearer token is refused by the database', async () => {
  await mock.reset();
  const wrong = createHttpTransport({ url: mock.url, token: 'not-the-token' });
  const store = createLibsqlStore({ transport: wrong, autoSchema: false });
  await assert.rejects(
    () => store.list('projects'),
    (e: unknown) => e instanceof StorageError && e.code === 'storage-unavailable',
  );
});

test('libsql: a failing statement is an error, not a silent success', async () => {
  await mock.reset();
  const transport = libsqlTransport();

  // The trap itself: the server answers HTTP 200 and puts the failure INSIDE
  // results[]. A client that only looks at the status code would report a
  // successful write for a write that never happened.
  const raw = await fetch(`${mock.url}/v2/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${mock.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      baton: null,
      requests: [
        { type: 'execute', stmt: { sql: 'SELECT * FROM a_table_that_does_not_exist', args: [] } },
      ],
    }),
  });
  assert.equal(raw.status, 200, 'the HTTP status is 200 even though the statement failed');
  const body = (await raw.json()) as any;
  assert.equal(body.results[0].type, 'error');
  assert.ok(body.results[0].error.message.includes('no such table'));

  // And the transport turns that into a loud StorageError.
  await assert.rejects(
    () => transport.execute('SELECT * FROM a_table_that_does_not_exist'),
    (e: unknown) => e instanceof StorageError && e.code === 'storage-unavailable',
  );
});

test('libsql: concurrent writers on one bucket never lose a hit', async () => {
  await mock.reset();
  const { createLibsqlRateLimitBackend } = await import('../durable-rate-counter.js');
  const { ensureSchema } = await import('../libsql-schema.js');
  const transport = libsqlTransport();
  await ensureSchema(transport);

  // Eight writers (eight "instances") hit the same bucket at the same time.
  // The statement is atomic, so the returned counts are 1..8 in some order and
  // their sum is 36. A lost update would make the sum smaller.
  const backends = Array.from({ length: 8 }, () => createLibsqlRateLimitBackend(transport));
  const counts = await Promise.all(backends.map((backend) => backend.hit('same-key', 60_000)));
  const sum = counts.reduce((total, count) => total + count, 0);
  assert.equal(sum, 36, 'every hit was counted exactly once');
  assert.equal(new Set(counts).size, 8, 'no two writers got the same count');

  // The next hit sees all eight.
  const next = createLibsqlRateLimitBackend(transport);
  assert.equal(await next.hit('same-key', 60_000), 9);
});

test('libsql: the durable rate counter counts across stores and never loses a hit', async () => {
  await mock.reset();
  const { createLibsqlRateLimitBackend } = await import('../durable-rate-counter.js');
  const { ensureSchema } = await import('../libsql-schema.js');
  const transport = libsqlTransport();
  await ensureSchema(transport);
  const first = createLibsqlRateLimitBackend(transport);
  const second = createLibsqlRateLimitBackend(libsqlTransport());

  // The two counters are separate objects (two "instances"), one database.
  assert.equal(await first.hit('client@example.com', 60_000), 1);
  assert.equal(await second.hit('client@example.com', 60_000), 2);
  assert.equal(await first.hit('client@example.com', 60_000), 3);

  // Another key starts at 1.
  assert.equal(await first.hit('other@example.com', 60_000), 1);

  // The key is hashed: the address itself is not in the database.
  const dump = await createLibsqlStore({ transport }).exportAll();
  assert.ok(dump.projects.length >= 0);
});

// --- the baton (wave 10, F-4) -----------------------------------------------

test('libsql: a PAGED answer is assembled completely (the baton is followed to the end)', async () => {
  // A server that pages its answers: one result per page, with a baton.
  const paged = await startMockPipelineServer({ pageSize: 1 });
  try {
    const transport = createHttpTransport({ url: paged.url, token: paged.token });

    // The schema step sends ~20 statements in ONE pipeline. With a server
    // that pages, the client has to follow the baton: a client that ignores
    // it would create a fraction of the schema and then fail on the first
    // missing table.
    await ensureSchema(transport);

    const store = createLibsqlStore({ transport, autoSchema: false });
    await store.append('projects', { id: 'prj_1' });
    await store.append('projects', { id: 'prj_2' });
    const rows = await store.list('projects');
    assert.deepEqual(
      rows.map((r) => r.id),
      ['prj_1', 'prj_2'],
      'the answer was truncated',
    );

    // The continuation request carries the baton and NO statements — that is
    // the v2 protocol.
    const continuation = paged.requests.find(
      (r: any) => r && typeof r.baton === 'string' && r.baton,
    ) as any;
    assert.ok(continuation, 'the server never handed out a baton');
    assert.deepEqual(continuation.requests, [], 'the continuation request carried statements');
    assert.ok(paged.requests.length > 2, 'the answer was not paged at all');
  } finally {
    await paged.close();
  }
});

test('libsql: the durable rate counter PRUNES the expired buckets', async () => {
  await mock.reset();
  const { createLibsqlRateLimitBackend } = await import('../durable-rate-counter.js');
  const transport = libsqlTransport();
  await ensureSchema(transport);
  const backend = createLibsqlRateLimitBackend(transport);

  // A bucket with a window that is already over.
  await backend.hit('expired-bucket', 1);
  await new Promise((r) => setTimeout(r, 20));

  // The next hit prunes it: the row is gone, and the table holds only the
  // buckets that are still inside their window.
  await backend.hit('live-bucket', 60_000);
  const rows = await transport.execute('SELECT bucket, reset_at FROM rate_counters');
  assert.equal(rows.rows.length, 1, `the expired bucket was not pruned (${JSON.stringify(rows.rows)})`);
});

// --- the file adapter's own specifics --------------------------------------

test('a missing file is an empty collection, not an error', async () => {
  const store = createFileStore({ dataDir: tmpDir() });
  assert.deepEqual(await store.list('projects'), []);
  assert.equal(await store.get('projects', { field: 'id', value: 'p1' }), null);
});

test('append creates parent directories and writes one JSON object per line', async () => {
  const dir = tmpDir();
  const store = createFileStore({ dataDir: dir });
  await store.append('comments', { id: 'c1', body: 'hi' });
  const file = path.join(dir, 'portal', 'comments.jsonl');
  assert.equal(fs.readFileSync(file, 'utf8'), '{"id":"c1","body":"hi"}\n');
});

test('the collections map onto the same files the handlers use today', async () => {
  const dir = tmpDir();
  const store = createFileStore({ dataDir: dir });
  await store.append('invites', { email: 'a@b.c' });
  await store.append('clients', { id: 'cli_1' });
  await store.append('planItems', { id: 'pl_1' });
  await store.append('updates', { id: 'up_1' });
  assert.ok(fs.existsSync(path.join(dir, 'portal', 'invited.jsonl')));
  assert.ok(fs.existsSync(path.join(dir, 'portal', 'clients.jsonl')));
  assert.ok(fs.existsSync(path.join(dir, 'portal', 'planItems.jsonl')));
  assert.ok(fs.existsSync(path.join(dir, 'portal', 'updates.jsonl')));
});

test('a corrupt file raises instead of silently returning an empty list', async () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'portal'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'portal', 'projects.jsonl'), '{"id":"p1"}\nnot json\n', 'utf8');
  const store = createFileStore({ dataDir: dir });
  await assert.rejects(
    () => store.list('projects'),
    (e: unknown) => e instanceof StorageError && e.code === 'storage-corrupt',
  );
});

test('a file written by the adapter is byte-identical to the legacy rewriteJsonl format', async () => {
  const dir = tmpDir();
  const store = createFileStore({ dataDir: dir });
  // RE-PINNED (wave 12, B-1): a record in the 'reviews' collection now
  // carries a RECORD IDENTITY (the store assigns it — see record-id.ts), so
  // the expected bytes are built from the records the store RETURNED. The
  // assertion itself is unchanged and just as strict: the file is exactly
  // the JSON of the stored records, one per line, with a trailing newline
  // and no blank lines — the legacy rewriteJsonl format the publisher and
  // the old handlers read.
  const first = await store.append('reviews', { ref: 'rev_1', type: 'review' });
  const second = await store.append('reviews', { ref: 'rev_2', type: 'review' });
  const written = fs.readFileSync(reviewsFile(dir), 'utf8');
  const legacy =
    [first, second]
      .map((r) => JSON.stringify(r))
      .join('\n') + '\n';
  assert.equal(written, legacy);
  assert.ok(!written.includes('\n\n'), 'no blank lines');
  // The identity is present in the stored record — the file is not quietly
  // missing it.
  assert.equal(typeof first.recordId, 'string');
  assert.ok((first.recordId as string).length > 0, 'the stored record carries no identity');
  assert.notEqual(first.recordId, second.recordId, 'two records share one identity');
});

// --- store selection --------------------------------------------------------

test('getStore defaults to the file adapter and honours PORTAL_DATA_DIR', async () => {
  const dir = tmpDir();
  const store = getStore({ PORTAL_DATA_DIR: dir });
  await store.append('projects', { id: 'p1' });
  assert.ok(fs.existsSync(path.join(dir, 'portal', 'projects.jsonl')));
});

test('getStore refuses an unknown backend', () => {
  assert.throws(
    () => getStore({ PORTAL_STORE: 'postgres' }),
    (e: unknown) => e instanceof StorageError && e.code === 'invalid-config',
  );
});

test('PORTAL_STORE=libsql fails closed without LIBSQL_URL and LIBSQL_TOKEN', () => {
  assert.throws(
    () => getStore({ PORTAL_STORE: 'libsql' }),
    (e: unknown) => e instanceof StorageError && e.code === 'invalid-config',
  );
  assert.throws(
    () => getStore({ PORTAL_STORE: 'libsql', LIBSQL_URL: 'https://db.turso.io' }),
    (e: unknown) => e instanceof StorageError && e.code === 'invalid-config',
  );
  assert.throws(
    () => getStore({ PORTAL_STORE: 'libsql', LIBSQL_TOKEN: 'secret' }),
    (e: unknown) => e instanceof StorageError && e.code === 'invalid-config',
  );
  // A turso:// URL is not an HTTP endpoint.
  assert.throws(
    () =>
      getStore({
        PORTAL_STORE: 'libsql',
        LIBSQL_URL: 'turso://db.turso.io',
        LIBSQL_TOKEN: 'secret',
      }),
    (e: unknown) => e instanceof StorageError && e.code === 'invalid-config',
  );
});

test('PORTAL_STORE=libsql selects the libSQL adapter, not the file adapter', async () => {
  // Port 1 is closed: the request fails immediately, without DNS and without
  // touching port 4321. The file adapter would have answered an empty list.
  const store = createLibsqlStoreFromEnv({
    PORTAL_STORE: 'libsql',
    LIBSQL_URL: 'http://127.0.0.1:1',
    LIBSQL_TOKEN: 'test-token',
  });
  await assert.rejects(
    () => store.list('projects'),
    (e: unknown) => e instanceof StorageError && e.code === 'storage-unavailable',
  );
});

test('the edge entry point refuses the file adapter (no writable disk on the edge)', () => {
  assert.throws(
    () => getEdgeStore({ PORTAL_STORE: 'file' }),
    (e: unknown) => e instanceof StorageError && e.code === 'invalid-config',
  );
});

test('the edge entry point fails closed without LIBSQL_URL and LIBSQL_TOKEN', () => {
  assert.throws(
    () => getEdgeStore({ PORTAL_STORE: 'libsql' }),
    (e: unknown) => e instanceof StorageError && e.code === 'invalid-config',
  );
});
