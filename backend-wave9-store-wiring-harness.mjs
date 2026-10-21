// backend-wave9-store-wiring-harness.mjs
//
// EXECUTED evidence for wave 9: the portal handlers read and write through
// the PortalStore contract, so PORTAL_STORE=libsql persists on Vercel.
//
// WHAT IT PROVES (by running the REAL handlers)
//   W1  no api/portal handler and no api/moderate/review.ts reads or writes
//       the portal JSONL any more (a source scan — the grep is printed).
//   W2  FILE MODE: the handlers read and write the SAME site/data/portal/*.jsonl
//       files with the SAME records as before the change. The expectation is
//       a FIXTURE captured from the pre-wave-9 code (--capture), so this is a
//       differential comparison, not a restatement of the new code.
//   W3  LIBSQL MODE: the same scenario writes to the DATABASE (the offline
//       mock pipeline server — a real SQLite engine over the real wire
//       protocol) and the JSONL files are never touched.
//   W4  the publisher: exit 0 with the right quotes when the store is
//       reachable, exit NON-ZERO when it is not.
//   W5  the rate counter is durable across two PROCESSES on the SQL backend,
//       and per-process in file mode.
//   W6  the publisher's own database read returns exactly the records the
//       store returns (one set of rules, two readers).
//
// THE REPO IS NEVER TOUCHED
//   Every run happens in a sandbox under the OS temp folder, and the
//   publisher runs with its cwd inside the sandbox.
//
// USAGE
//   node backend-wave9-store-wiring-harness.mjs             (assert)
//   node backend-wave9-store-wiring-harness.mjs --capture   (rewrite the fixture)

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = fs.existsSync(path.join(HERE, 'api', 'portal', 'auth.ts')) ? HERE : path.resolve(HERE, '..');
const SITE = path.join(REPO, 'site');
const siteRequire = createRequire(path.join(SITE, 'package.json'));
const { build } = siteRequire('esbuild');

const CAPTURE = process.argv.includes('--capture');
const FIXTURE = path.join(HERE, 'backend-wave9-store-wiring-fixture.json');

const BASE = 'http://imk.test';
const OWNER = 'owner@example.test';
const CLIENT = 'client@example.test';
const CLIENT_ID = 'cli_test';
const SESSION_SECRET = 'wave9-store-wiring-session-secret-0123456789';
const MODERATION_SECRET = 'wave9-store-wiring-moderation-secret-0123456789';

const results = [];
let currentGroup = '';
const origLog = console.log;

function group(name) {
  currentGroup = name;
  origLog(`\n[wave9] ${name}`);
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(
      `${message} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

async function t(id, name, fn) {
  try {
    const detail = await fn();
    results.push({ id, group: currentGroup, name, status: 'PASS', detail: detail ?? null });
    origLog(`  PASS  ${id}  ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (err) {
    results.push({
      id,
      group: currentGroup,
      name,
      status: 'FAIL',
      error: String(err && err.message ? err.message : err),
    });
    origLog(`  FAIL  ${id}  ${name}\n          ${err && err.message ? err.message : err}`);
  }
}

// ---------------------------------------------------------------------------
// Normalisation — the volatile values (generated ids, timestamps) are replaced
// so two runs can be compared exactly.
// ---------------------------------------------------------------------------

const GENERATED_ID = /^[a-z]{3}_[0-9a-f]{8,}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

function normalise(value) {
  if (typeof value === 'string') {
    if (GENERATED_ID.test(value)) return '<generated-id>';
    if (TIMESTAMP.test(value)) return '<timestamp>';
    return value;
  }
  if (Array.isArray(value)) return value.map(normalise);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) out[key] = normalise(value[key]);
    return out;
  }
  return value;
}

/** The source without its comments — a comment may NAME the store, not use it. */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^[ \t]*\/\/.*$/gm, ' ');
}

// ---------------------------------------------------------------------------
// The fake request / response (the shape the node:http handlers expect)
// ---------------------------------------------------------------------------

function makeReq(method, url, headers, body) {
  const req = Readable.from(body ? [Buffer.from(body)] : []);
  req.method = method;
  req.url = url;
  req.headers = headers || {};
  return req;
}

function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    ended: false,
    writeHead(status, headers) {
      this.statusCode = status;
      const merged = { ...this.headers, ...(headers || {}) };
      this.headers = {};
      for (const [key, value] of Object.entries(merged)) {
        this.headers[String(key).toLowerCase()] = value;
      }
      return this;
    },
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value;
    },
    end(payload) {
      if (payload) {
        this.body += Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload);
      }
      this.ended = true;
      this.writableEnded = true;
      return this;
    },
  };
}

// ---------------------------------------------------------------------------
// The scenario — one deterministic run against the real handlers
// ---------------------------------------------------------------------------

const SEED_FILES = {
  'portal/clients.jsonl': [
    {
      id: CLIENT_ID,
      email: CLIENT,
      name: 'Alice Longname',
      company: 'Acme Ltd',
      role: 'CTO',
      createdAt: '2026-01-01T00:00:00.000Z',
    },
  ],
  'portal/projects.jsonl': [
    {
      id: 'prj_test',
      clientId: CLIENT_ID,
      title: 'Project One',
      status: 'discovery',
      startedAt: '2026-01-01T00:00:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedBy: OWNER,
    },
  ],
  'portal/invited.jsonl': [
    {
      email: CLIENT,
      name: 'Alice Longname',
      company: 'Acme Ltd',
      role: 'CTO',
      invitedBy: OWNER,
      invitedAt: '2026-01-01T00:00:00.000Z',
      clientId: CLIENT_ID,
    },
  ],
};

const COLLECTIONS = [
  'projects',
  'clients',
  'invites',
  'comments',
  'planItems',
  'updates',
  'reviews',
];

const FILE_OF_COLLECTION = {
  projects: 'portal/projects.jsonl',
  clients: 'portal/clients.jsonl',
  invites: 'portal/invited.jsonl',
  comments: 'portal/comments.jsonl',
  planItems: 'portal/planItems.jsonl',
  updates: 'portal/updates.jsonl',
  reviews: 'moderation/reviews.jsonl',
};

/** The seed records per collection — the same in both backends. */
const SEED_OF_COLLECTION = {
  clients: SEED_FILES['portal/clients.jsonl'],
  projects: SEED_FILES['portal/projects.jsonl'],
  invites: SEED_FILES['portal/invited.jsonl'],
};

function seedFiles(dataDir) {
  for (const [relative, records] of Object.entries(SEED_FILES)) {
    const file = path.join(dataDir, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : ''),
      'utf8',
    );
  }
}

function readJsonlFile(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

function moderationSignature(ref, decision, revision, ts) {
  return crypto
    .createHmac('sha256', MODERATION_SECRET)
    .update(`${ref}|${decision}|${revision}|${ts}`)
    .digest('hex');
}

/**
 * The scenario.
 *
 * It walks every write path of the portal and every read path, in a fixed
 * order, so the resulting stores are comparable between two runs.
 */
async function runScenario(api, cookies, options = {}) {
  const responses = [];

  async function call(name, method, url, options = {}) {
    const headers = { host: 'imk.test', origin: BASE, ...(options.headers || {}) };
    if (options.cookie) headers.cookie = options.cookie;
    let payload;
    if (options.body !== undefined) {
      payload = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
      headers['content-type'] = 'application/json';
    }
    const req = makeReq(method, url, headers, payload);
    const res = makeRes();
    await api[name](req, res);
    let parsed = null;
    try {
      parsed = JSON.parse(res.body || 'null');
    } catch {
      parsed = null;
    }
    const answer = {
      status: res.statusCode,
      body: parsed === null ? res.body : parsed,
    };
    responses.push(answer);
    return answer;
  }

  // 1. the owner creates a project for an existing client
  await call('projects', 'POST', '/api/portal/projects', {
    cookie: cookies.owner,
    body: { title: 'Project Two', clientId: CLIENT_ID },
  });

  // 2. the owner moves the project on and asks for a testimonial
  await call('projects', 'PATCH', '/api/portal/projects/prj_test', {
    cookie: cookies.owner,
    body: { status: 'completed', testimonialStatus: 'requested' },
  });

  // 3. the owner adds a plan item
  const planItem = await call('planItems', 'POST', '/api/portal/plan-items', {
    cookie: cookies.owner,
    body: { projectId: 'prj_test', title: 'Step one', description: 'Do the thing' },
  });
  const planItemId = planItem.body?.planItem?.id;

  // 4. the client approves the plan item
  await call('planItems', 'PATCH', `/api/portal/plan-items/${planItemId}`, {
    cookie: cookies.client,
    body: { status: 'done' },
  });

  // 5. the client posts an update
  await call('updates', 'POST', '/api/portal/updates', {
    cookie: cookies.client,
    body: { projectId: 'prj_test', title: 'Update one', body: 'Body text' },
  });

  // 6. the client posts a comment
  await call('comments', 'POST', '/api/portal/comments', {
    cookie: cookies.client,
    body: { projectId: 'prj_test', body: 'A comment' },
  });

  // 7. the owner invites a NEW client
  await call('invites', 'POST', '/api/portal/invites', {
    cookie: cookies.owner,
    body: { email: 'new@example.test', name: 'Bob', company: 'Beta Ltd', role: 'CEO' },
  });

  // 8. the owner re-sends the SAME invite with no change (the upsert, no write)
  await call('invites', 'POST', '/api/portal/invites', {
    cookie: cookies.owner,
    body: { email: CLIENT, name: 'Alice Longname', company: 'Acme Ltd', role: 'CTO' },
  });

  // 9. the owner re-sends the invite with a CHANGED company (the upsert writes
  //    the invite record AND the client record)
  await call('invites', 'POST', '/api/portal/invites', {
    cookie: cookies.owner,
    body: { email: CLIENT, company: 'Acme International Ltd' },
  });

  // 10. the client submits a quote
  const quote = await call('testimonials', 'POST', '/api/portal/testimonials', {
    cookie: cookies.client,
    body: {
      action: 'submit',
      projectId: 'prj_test',
      review: 'Great work',
      rating: 5,
      consent: { p1: true, p2: true, p3: false },
    },
  });
  const ref = quote.body?.testimonial?.ref;

  // 11. the owner approves the quote with the signed link (the POST decides)
  const ts = Math.floor(Date.now() / 1000);
  const sig = moderationSignature(ref, 'approve', 1, ts);
  await call(
    'moderate',
    'POST',
    `/api/moderate/review?ref=${ref}&decision=approve&revision=1&sig=${sig}&ts=${ts}`,
    { headers: { 'content-type': 'application/x-www-form-urlencoded' } },
  );

  // 12. the read paths
  await call('projects', 'GET', '/api/portal/projects', { cookie: cookies.client });
  await call('planItems', 'GET', '/api/portal/plan-items?projectId=prj_test', {
    cookie: cookies.client,
  });
  await call('testimonials', 'GET', '/api/portal/testimonials?projectId=prj_test', {
    cookie: cookies.client,
  });

  // 13. the client changes their mind (a new revision of the same ref)
  if (options.snooze !== false) {
    await call('testimonials', 'POST', '/api/portal/testimonials', {
      cookie: cookies.client,
      body: { action: 'snooze', projectId: 'prj_test' },
    });
  }

  return responses;
}

// ---------------------------------------------------------------------------
// The runner: one sandbox, one bundle, one scenario
// ---------------------------------------------------------------------------

const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const ROOT = path.join(os.tmpdir(), 'opencode', 'wave9-store-wiring', STAMP);

async function bundleHandlers(name) {
  const entryFile = path.join(ROOT, `${name}-entry.ts`);
  const outFile = path.join(ROOT, `${name}-bundle.cjs`);
  fs.mkdirSync(ROOT, { recursive: true });
  const from = (relative) => path.join(REPO, relative).replace(/\\/g, '/');
  fs.writeFileSync(
    entryFile,
    [
      `export { default as auth } from '${from('api/portal/auth.ts')}';`,
      `export { default as projects } from '${from('api/portal/projects.ts')}';`,
      `export { default as planItems } from '${from('api/portal/plan-items.ts')}';`,
      `export { default as updates } from '${from('api/portal/updates.ts')}';`,
      `export { default as comments } from '${from('api/portal/comments.ts')}';`,
      `export { default as invites } from '${from('api/portal/invites.ts')}';`,
      `export { default as testimonials } from '${from('api/portal/testimonials.ts')}';`,
      `export { default as moderate } from '${from('api/moderate/review.ts')}';`,
      `export { createSession } from '${from('site/shared/server/portal-session.ts')}';`,
      `export { createPortalRateLimiter } from '${from('api/lib/rate-limit.ts')}';`,
      `export { getPortalStore } from '${from('site/shared/server/portal-store-access.ts')}';`,
    ].join('\n'),
    'utf8',
  );
  await build({
    entryPoints: [entryFile],
    outfile: outFile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    absWorkingDir: REPO,
    external: ['node:http', 'node:crypto', 'node:fs', 'node:path', 'node:stream'],
    logLevel: 'silent',
  });
  return outFile;
}

/**
 * The environment every run uses.
 *
 * There is NO RESEND_API_KEY: without one the notification path logs
 * "email_skipped" and never touches the network, so the harness never sends
 * anything to anybody.
 */
function baseEnv(extra = {}) {
  return {
    APP_ENV: 'development',
    SITE_BASE_URL: BASE,
    ADMIN_EMAILS: OWNER,
    PORTAL_SESSION_SECRET: SESSION_SECRET,
    PORTAL_MAGIC_LINK_SECRET: SESSION_SECRET,
    FORM_WEBHOOK_SECRET: MODERATION_SECRET,
    NODE_ENV: 'development',
    ...extra,
  };
}

function applyEnv(env) {
  for (const key of Object.keys(process.env)) {
    if (
      key.startsWith('PORTAL_') ||
      (key.startsWith('LIBSQL_') && key !== 'LIBSQL_SQLITE_WORKER') ||
      key === 'SITE_BASE_URL' ||
      key === 'ADMIN_EMAILS' ||
      key === 'FORM_WEBHOOK_SECRET'
    ) {
      delete process.env[key];
    }
  }
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || value === null) delete process.env[key];
    else process.env[key] = String(value);
  }
}

/** A run in FILE mode: the handlers write the JSONL files. */
async function runFileMode() {
  const sandbox = path.join(ROOT, 'file-mode');
  const dataDir = path.join(sandbox, 'site', 'data');
  // The cwd must leave the directory that is about to be removed (Windows
  // refuses to delete the directory a process is standing in).
  process.chdir(ROOT);
  fs.rmSync(sandbox, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });
  seedFiles(dataDir);

  applyEnv(baseEnv({ PORTAL_STORE: 'file' }));
  process.chdir(sandbox);

  const bundleFile = await bundleHandlers('file-mode');
  const api = require(bundleFile);

  const ownerToken = api.createSession(OWNER, 'admin');
  const clientToken = api.createSession(CLIENT, 'client', CLIENT_ID);
  assert(ownerToken, 'the owner session could not be minted');
  assert(clientToken, 'the client session could not be minted');

  const responses = await runScenario(api, {
    owner: `imk_admin_session=${ownerToken}`,
    client: `imk_session=${clientToken}`,
  });

  const files = {};
  for (const relative of Object.values(FILE_OF_COLLECTION)) {
    const file = path.join(dataDir, relative);
    files[relative] = readJsonlFile(file).map(normalise);
  }

  return { files, responses: responses.map(normalise), dataDir };
}

/**
 * A run in LIBSQL mode: the handlers write to the database.
 *
 * The database is seeded with the SAME records the file mode seeds, through
 * the store itself — so the two runs are comparable.
 */
async function runLibsqlMode(mock, name = 'libsql-mode', options = {}) {
  const sandbox = path.join(ROOT, name);
  const dataDir = path.join(sandbox, 'site', 'data');
  process.chdir(ROOT);
  fs.rmSync(sandbox, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });

  applyEnv(
    baseEnv({
      PORTAL_STORE: 'libsql',
      LIBSQL_URL: mock.url,
      LIBSQL_TOKEN: mock.token,
    }),
  );
  process.chdir(sandbox);

  const bundleFile = await bundleHandlers(name);
  const api = require(bundleFile);

  // The seed, through the store. The store creates the schema on this first
  // call — the handler tree never has to know about DDL.
  const store = api.getPortalStore(process.env);
  for (const [collection, records] of Object.entries(SEED_OF_COLLECTION)) {
    for (const record of records) {
      await store.append(collection, record);
    }
  }

  const ownerToken = api.createSession(OWNER, 'admin');
  const clientToken = api.createSession(CLIENT, 'client', CLIENT_ID);

  const responses = await runScenario(
    api,
    {
      owner: `imk_admin_session=${ownerToken}`,
      client: `imk_session=${clientToken}`,
    },
    options,
  );

  // What is on disk after a libSQL run? NOTHING: the file adapter was never
  // touched.
  const onDisk = fs.existsSync(dataDir) ? fs.readdirSync(dataDir) : [];

  return { responses: responses.map(normalise), dataDir, onDisk, store };
}

// ---------------------------------------------------------------------------
// The mock pipeline server (the offline database)
// ---------------------------------------------------------------------------

let mockBundle = null;

async function startMock() {
  process.env.LIBSQL_SQLITE_WORKER = path.join(
    SITE,
    'shared/portal-store/test/sqlite-worker.py',
  );
  if (!mockBundle) {
    const outFile = path.join(ROOT, 'mock-pipeline-server.mjs');
    await build({
      entryPoints: [path.join(SITE, 'shared/portal-store/test/mock-pipeline-server.ts')],
      outfile: outFile,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node20',
      logLevel: 'silent',
    });
    mockBundle = await import(pathToFileURL(outFile).href);
  }
  return mockBundle.startMockPipelineServer();
}

/** Read the database through the store itself (TypeScript — bundled here). */
async function readStoreFromDatabase(mock) {
  const outFile = path.join(ROOT, 'store-reader.mjs');
  await build({
    entryPoints: [path.join(SITE, 'shared/portal-store/index.ts')],
    outfile: outFile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    logLevel: 'silent',
  });
  process.env.LIBSQL_SQLITE_WORKER = path.join(
    SITE,
    'shared/portal-store/test/sqlite-worker.py',
  );
  const mod = await import(pathToFileURL(outFile).href + `?v=${Date.now()}`);
  const store = mod.getStore({
    PORTAL_STORE: 'libsql',
    LIBSQL_URL: mock.url,
    LIBSQL_TOKEN: mock.token,
  });
  const out = {};
  for (const coll of COLLECTIONS) {
    out[coll] = await store.list(coll);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The publisher
// ---------------------------------------------------------------------------

/**
 * Run the publisher in a CHILD PROCESS — and ASYNCHRONOUSLY.
 *
 * Asynchronous on purpose: the mock database runs INSIDE this process, and a
 * synchronous spawn would block the event loop, so the database could never
 * answer the publisher's request. (That is not a theoretical concern: it is
 * exactly what happened the first time this harness ran.)
 */
function runPublisher(env, cwd) {
  const childEnv = { ...process.env };
  for (const key of Object.keys(childEnv)) {
    if (key.startsWith('PORTAL_') || key.startsWith('LIBSQL_')) delete childEnv[key];
  }
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || value === null) delete childEnv[key];
    else childEnv[key] = String(value);
  }
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [path.join(SITE, 'scripts/publish-testimonials.mjs')],
      { cwd, env: childEnv },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (status) => {
      resolve({ status, stdout, stderr });
    });
  });
}

function publishedFiles(dir) {
  const target = path.join(dir, 'src', 'content', 'testimonials');
  if (!fs.existsSync(target)) return [];
  return fs
    .readdirSync(target)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => ({ name: f, body: fs.readFileSync(path.join(target, f), 'utf8') }));
}

// ---------------------------------------------------------------------------
// The rate limiter, in two PROCESSES (two serverless instances)
// ---------------------------------------------------------------------------

const RATE_CHILD = `
const api = require(process.env.W9_BUNDLE);
(async () => {
  const limiter = api.createPortalRateLimiter();
  const decision = await limiter.consume(process.env.W9_KEY, 1000, 60000);
  process.stdout.write('__RESULT__' + JSON.stringify({
    count: decision.count,
    degraded: decision.degraded,
    allowed: decision.allowed,
  }));
})().catch((err) => {
  process.stdout.write('__RESULT__' + JSON.stringify({ error: String(err && err.message ? err.message : err) }));
  process.exitCode = 1;
});
`;

/**
 * Run one rate-limit child.
 *
 * Asynchronous on purpose: the mock database runs inside this process, so a
 * synchronous spawn would block the event loop and the database could never
 * answer the child's request.
 */
function runRateChild(bundleFile, env, key) {
  const childFile = path.join(ROOT, 'rate-child.cjs');
  fs.writeFileSync(childFile, RATE_CHILD, 'utf8');
  const childEnv = { ...process.env };
  for (const k of Object.keys(childEnv)) {
    if (k.startsWith('PORTAL_') || (k.startsWith('LIBSQL_') && k !== 'LIBSQL_SQLITE_WORKER')) {
      delete childEnv[k];
    }
  }
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || v === null) delete childEnv[k];
    else childEnv[k] = String(v);
  }
  childEnv.W9_BUNDLE = bundleFile;
  childEnv.W9_KEY = key;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [childFile], { cwd: ROOT, env: childEnv });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (status) => {
      const line = stdout.split('\n').find((l) => l.startsWith('__RESULT__'));
      if (!line) {
        reject(
          new Error(
            `the rate child produced no result (exit ${status}): ${stderr.slice(0, 600)}`,
          ),
        );
        return;
      }
      const answer = JSON.parse(line.slice('__RESULT__'.length));
      if (answer.error) {
        reject(new Error(`the rate child failed: ${answer.error}`));
        return;
      }
      resolve(answer);
    });
  });
}

// ---------------------------------------------------------------------------
// The tests
// ---------------------------------------------------------------------------

const SCANNED_FILES = [
  'api/portal/auth.ts',
  'api/portal/comments.ts',
  'api/portal/invites.ts',
  'api/portal/plan-items.ts',
  'api/portal/projects.ts',
  'api/portal/session.ts',
  'api/portal/testimonials.ts',
  'api/portal/updates.ts',
  'api/moderate/review.ts',
];

async function main() {
  fs.mkdirSync(ROOT, { recursive: true });
  origLog(`[wave9] sandbox: ${ROOT}`);

  group('W1 — the handlers do not touch the portal JSONL any more');

  await t('W1', 'a source scan proves no handler reads or writes portal JSONL', async () => {
    const offenders = [];
    for (const relative of SCANNED_FILES) {
      const source = stripComments(fs.readFileSync(path.join(REPO, relative), 'utf8'));
      const hits = [];
      if (/readJsonlFile|\breadJsonl\b|appendJsonl|rewriteJsonl|parseJsonlStrict/.test(source)) {
        hits.push('a JSONL helper');
      }
      if (/site[\\/]data/.test(source)) hits.push('a site/data path');
      if (/from '\.\.\/lib\/jsonl\.js'/.test(source)) hits.push('the jsonl module');
      if (hits.length) offenders.push(`${relative}: ${hits.join(', ')}`);
    }
    assert(
      offenders.length === 0,
      `these files still reach the JSONL store:\n    ${offenders.join('\n    ')}`,
    );
    return `${SCANNED_FILES.length} files scanned, 0 JSONL readers left`;
  });

  group('W2 — FILE MODE: the same files, the same records');

  const fileRun = await runFileMode();

  if (CAPTURE) {
    await t('W2', 'the fixture is captured from the pre-wave-9 code', async () => {
      fs.writeFileSync(
        FIXTURE,
        JSON.stringify({ capturedAt: new Date().toISOString(), ...fileRun }, null, 2),
        'utf8',
      );
      const total = Object.values(fileRun.files).reduce((n, list) => n + list.length, 0);
      return `${total} records written to ${path.basename(FIXTURE)}`;
    });
  } else {
    await t('W2a', 'the file-mode answers are the pre-wave-9 answers', async () => {
      const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
      assertEqual(
        JSON.stringify(fileRun.responses),
        JSON.stringify(fixture.responses),
        'the answers changed',
      );
      return `${fileRun.responses.length} answers, identical`;
    });

    await t('W2b', 'the file-mode records are the pre-wave-9 records', async () => {
      const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
      for (const relative of Object.keys(fileRun.files)) {
        assertEqual(
          JSON.stringify(fileRun.files[relative]),
          JSON.stringify(fixture.files[relative] || []),
          `the records of ${relative} changed`,
        );
      }
      const total = Object.values(fileRun.files).reduce((n, list) => n + list.length, 0);
      return `${total} records across ${Object.keys(fileRun.files).length} files, identical`;
    });
  }

  group('W3 — LIBSQL MODE: the store, not the files');

  await t('W3a', 'the same scenario writes to the database and to no file', async () => {
    const mock = await startMock();
    try {
      const libsqlRun = await runLibsqlMode(mock);
      assertEqual(
        JSON.stringify(libsqlRun.onDisk),
        JSON.stringify([]),
        'the file adapter was used in libsql mode',
      );

      const store = await readStoreFromDatabase(mock);
      for (const coll of COLLECTIONS) {
        const expected = fileRun.files[FILE_OF_COLLECTION[coll]] || [];
        assertEqual(
          JSON.stringify((store[coll] || []).map(normalise)),
          JSON.stringify(expected),
          `the database rows of ${coll} differ from the file records`,
        );
      }
      return 'the database holds the same records; no JSONL file was written';
    } finally {
      await mock.close();
    }
  });

  await t('W3b', 'the answers are the same in both backends', async () => {
    const mock = await startMock();
    try {
      const libsqlRun = await runLibsqlMode(mock, 'libsql-mode-2');
      assertEqual(
        JSON.stringify(libsqlRun.responses),
        JSON.stringify(fileRun.responses),
        'the answers differ between the backends',
      );
      return `${libsqlRun.responses.length} answers, identical`;
    } finally {
      await mock.close();
    }
  });

  group('W4 — the publisher reads the store and fails loudly');

  await t('W4a', 'the publisher publishes the approved quote from the DATABASE', async () => {
    const mock = await startMock();
    try {
      // No snooze at the end: the quote stays approved, so there IS something
      // to publish.
      await runLibsqlMode(mock, 'libsql-mode-publisher', { snooze: false });
      const build = path.join(ROOT, 'publisher-libsql');
      fs.mkdirSync(path.join(build, 'src', 'content', 'testimonials'), { recursive: true });
      const result = await runPublisher(
        {
          PORTAL_STORE: 'libsql',
          LIBSQL_URL: mock.url,
          LIBSQL_TOKEN: mock.token,
        },
        build,
      );
      assertEqual(result.status, 0, `the publisher failed: ${result.stderr}`);
      const files = publishedFiles(build);
      assert(files.length >= 1, 'the publisher wrote no testimonial');
      const body = files.map((f) => f.body).join('\n');
      assert(body.includes('Great work'), 'the approved quote was not published');
      return `${files.length} published file(s), exit 0`;
    } finally {
      await mock.close();
    }
  });

  await t('W4e', 'the publisher follows the same "newest revision wins" rule', async () => {
    const mock = await startMock();
    try {
      // The client snoozes at the end: the newest revision is no longer
      // approved, so there is NOTHING to publish — and the publisher must not
      // publish the older, approved revision.
      await runLibsqlMode(mock, 'libsql-mode-revoked');
      const build = path.join(ROOT, 'publisher-revoked');
      fs.mkdirSync(path.join(build, 'src', 'content', 'testimonials'), { recursive: true });
      const result = await runPublisher(
        {
          PORTAL_STORE: 'libsql',
          LIBSQL_URL: mock.url,
          LIBSQL_TOKEN: mock.token,
        },
        build,
      );
      assertEqual(result.status, 0, `the publisher failed: ${result.stderr}`);
      const files = publishedFiles(build);
      assertEqual(files.length, 0, 'the publisher published a quote the client withdrew');
      return 'exit 0 and nothing published — the newest revision wins';
    } finally {
      await mock.close();
    }
  });

  await t('W4b', 'the publisher exits NON-ZERO when the store is unreachable', async () => {
    const build = path.join(ROOT, 'publisher-unreachable');
    fs.mkdirSync(path.join(build, 'src', 'content', 'testimonials'), { recursive: true });
    const result = await runPublisher(
      {
        PORTAL_STORE: 'libsql',
        // Port 1 is closed: the request fails at once, without DNS.
        LIBSQL_URL: 'http://127.0.0.1:1',
        LIBSQL_TOKEN: 'imk-test-token',
      },
      build,
    );
    assert(result.status !== 0, 'the publisher exited 0 with an unreachable store');
    assert(
      /publish-testimonials/.test(result.stderr),
      `the failure was not explained: ${result.stderr}`,
    );
    return `exit ${result.status}`;
  });

  await t('W4c', 'the publisher exits NON-ZERO when the store is MISCONFIGURED', async () => {
    const build = path.join(ROOT, 'publisher-misconfigured');
    fs.mkdirSync(path.join(build, 'src', 'content', 'testimonials'), { recursive: true });
    const result = await runPublisher({ PORTAL_STORE: 'libsql' }, build);
    assert(result.status !== 0, 'the publisher exited 0 without LIBSQL_URL');
    return `exit ${result.status}`;
  });

  await t('W4d', 'the publisher publishes from the FILE store exactly as before', async () => {
    const build = path.join(ROOT, 'publisher-file');
    const dataDir = path.join(build, 'data');
    fs.mkdirSync(path.join(dataDir, 'moderation'), { recursive: true });
    fs.mkdirSync(path.join(build, 'src', 'content', 'testimonials'), { recursive: true });
    fs.writeFileSync(
      path.join(dataDir, 'moderation', 'reviews.jsonl'),
      JSON.stringify({
        ref: 'rev_file',
        type: 'review',
        state: 'approved',
        verifiedClient: true,
        name: 'Nora',
        company: 'Named Co',
        role: 'CTO',
        rating: '5',
        review: 'Great work',
        consent: { p1: true, p2: true, p3: false, displayName: '' },
        revision: 1,
      }) + '\n',
      'utf8',
    );
    const result = await runPublisher({}, build);
    assertEqual(result.status, 0, `the publisher failed: ${result.stderr}`);
    const files = publishedFiles(build);
    assert(files.length === 1, `the publisher wrote ${files.length} files`);
    assert(files[0].body.includes('Great work'), 'the quote was not published');
    return 'exit 0, the quote was published from the file store';
  });

  group('W5 — the rate counter');

  await t('W5a', 'the SQL counter is durable across two PROCESSES', async () => {
    const mock = await startMock();
    try {
      const bundleFile = await bundleHandlers('rate-limit-sql');
      const env = baseEnv({
        PORTAL_STORE: 'libsql',
        LIBSQL_URL: mock.url,
        LIBSQL_TOKEN: mock.token,
      });
      const first = await runRateChild(bundleFile, env, 'wave9:shared-key');
      const second = await runRateChild(bundleFile, env, 'wave9:shared-key');
      assertEqual(first.count, 1, 'the first process did not count 1');
      assertEqual(second.count, 2, 'the second process did not continue the count');
      assertEqual(second.degraded, false, 'the counter degraded to the in-memory one');
      return 'process A counted 1, process B counted 2 — one shared counter';
    } finally {
      await mock.close();
    }
  });

  await t('W5b', 'in FILE mode the counter is per process', async () => {
    const bundleFile = await bundleHandlers('rate-limit-file');
    const env = baseEnv({ PORTAL_STORE: 'file' });
    const first = await runRateChild(bundleFile, env, 'wave9:file-key');
    const second = await runRateChild(bundleFile, env, 'wave9:file-key');
    assertEqual(first.count, 1, 'the first process did not count 1');
    assertEqual(second.count, 1, 'the second process did not start at 1');
    return 'each process counts on its own — per instance, as documented';
  });

  group('W6 — the publisher and the store read the same records');

  await t('W6', "the publisher's own database read matches the store's", async () => {
    const mock = await startMock();
    try {
      await runLibsqlMode(mock, 'libsql-mode-parity');
      const store = await readStoreFromDatabase(mock);
      const publisherRecords = await readThroughPublisher(mock);
      assertEqual(
        JSON.stringify(publisherRecords.map(normalise)),
        JSON.stringify((store.reviews || []).map(normalise)),
        'the publisher and the store disagree',
      );
      return `${publisherRecords.length} review records, identical`;
    } finally {
      await mock.close();
    }
  });

  const failed = results.filter((r) => r.status === 'FAIL');
  origLog(
    `\n[wave9] ${results.length - failed.length}/${results.length} checks passed` +
      (failed.length ? ` — ${failed.length} FAILED` : ''),
  );
  if (failed.length) {
    for (const f of failed) origLog(`  FAILED ${f.id}: ${f.error}`);
    process.exitCode = 1;
  }
}

/** Read the reviews through the publisher's own database read. */
async function readThroughPublisher(mock) {
  const script = path.join(ROOT, 'publisher-read.mjs');
  fs.writeFileSync(
    script,
    `
import { readReviewsFromStore } from '${pathToFileURL(path.join(SITE, 'scripts/publish-testimonials.mjs')).href}';
const records = await readReviewsFromStore({
  PORTAL_STORE: 'libsql',
  LIBSQL_URL: '${mock.url}',
  LIBSQL_TOKEN: '${mock.token}',
});
process.stdout.write('__RESULT__' + JSON.stringify(records));
`,
    'utf8',
  );
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { cwd: ROOT });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (status) => {
      const line = stdout.split('\n').find((l) => l.startsWith('__RESULT__'));
      if (!line) {
        reject(
          new Error(
            `the publisher read produced no result (exit ${status}): ${stderr.slice(0, 500)}`,
          ),
        );
        return;
      }
      resolve(JSON.parse(line.slice('__RESULT__'.length)));
    });
  });
}

main().catch((err) => {
  origLog('[wave9] harness error:', err);
  process.exitCode = 1;
});
