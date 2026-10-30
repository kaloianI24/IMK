// backend-wave9b-admin-inbox-store-harness.mjs
//
// EXECUTED evidence for wave 9B: the owner's inbox reads through the
// PortalStore, so the inbox and the moderation endpoint share ONE store — and
// the libSQL adapter no longer caches a REJECTED schema promise.
//
// WHAT IT PROVES
//   B1  a source scan: api/admin/reviews.ts no longer touches the JSONL store
//   B2  FILE MODE: a quote written THROUGH THE STORE shows up in the inbox,
//       and a decision made through /api/moderate/review shows up in the
//       inbox's "recently decided" list — one store, one truth
//   B3  the failure answers: a store that is not there -> 501
//       {code:'unimplemented'}, a store that cannot be parsed -> 500
//       {code:'storage'}, and NEVER a 200 with an empty queue
//   B4  the gate is unchanged: a client -> 401, no cookie -> 401, an unset
//       ADMIN_EMAILS -> 500, no FORM_WEBHOOK_SECRET -> 500, a wrong method ->
//       405, a wrong path -> 404, and the response shape is the one
//       site/src/pages/admin.astro consumes
//   B5  LIBSQL MODE: the same scenario against a real SQLite engine over the
//       real v2 wire protocol — the queue comes from the DATABASE, the
//       decision is written to the DATABASE, and no JSONL file is touched
//   B6  a store whose schema step failed ONCE recovers on the next call (the
//       rejected schema promise is not cached)
//   B7  two MUTATION PROBES: putting the defect back in a COPY reddens the
//       matching check
//   B8  the DIFFERENTIAL check: FILE MODE and LIBSQL MODE answer the inbox
//       IDENTICALLY on the same fixture (before AND after the decision)
//
// THE REPO IS NEVER TOUCHED
//   Every run happens in a sandbox under the OS temp folder, and the mutation
//   probes work on a COPY of the tree.
//
// USAGE
//   node backend-wave9b-admin-inbox-store-harness.mjs

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = fs.existsSync(path.join(HERE, 'api', 'portal.ts')) ? HERE : path.resolve(HERE, '..');
const SITE = path.join(REPO, 'site');
const siteRequire = createRequire(path.join(SITE, 'package.json'));
const { build } = siteRequire('esbuild');

const OWNER = 'owner@example.test';
const CLIENT = 'client@example.test';
const SESSION_SECRET = 'wave9b-admin-inbox-session-secret-0123456789';
const MODERATION_SECRET = 'wave9b-admin-inbox-moderation-secret-0123456789';
const REF = 'inq_wave9b_1';

const PENDING_REVIEW = {
  ref: REF,
  type: 'review',
  state: 'pending',
  revision: 1,
  name: 'Nora Vance',
  company: 'Named Co',
  role: 'CTO',
  rating: 5,
  review: 'Great work',
  clientId: 'cli_wave9b',
  verifiedClient: true,
  consent: { p1: true, p2: true, p3: false, displayName: '' },
  receivedAt: '2026-10-20T10:00:00.000Z',
  createdAt: '2026-10-20T10:00:00.000Z',
};

const results = [];
let currentGroup = '';
const origLog = console.log;

function group(name) {
  currentGroup = name;
  origLog(`\n[wave9b] ${name}`);
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

async function call(handler, method, url, options = {}) {
  const headers = { host: 'imk.test', ...(options.headers || {}) };
  if (options.cookie) headers.cookie = options.cookie;
  const req = makeReq(method, url, headers, options.body);
  const res = makeRes();
  await handler(req, res);
  let parsed = null;
  try {
    parsed = JSON.parse(res.body || 'null');
  } catch {
    parsed = null;
  }
  return { status: res.statusCode, body: parsed === null ? res.body : parsed, headers: res.headers };
}

// ---------------------------------------------------------------------------
// The environment
// ---------------------------------------------------------------------------

function baseEnv(extra = {}) {
  return {
    APP_ENV: 'development',
    NODE_ENV: 'development',
    SITE_BASE_URL: 'http://imk.test',
    ADMIN_EMAILS: OWNER,
    PORTAL_SESSION_SECRET: SESSION_SECRET,
    PORTAL_MAGIC_LINK_SECRET: SESSION_SECRET,
    FORM_WEBHOOK_SECRET: MODERATION_SECRET,
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

/** QA's own HMAC over the moderation parameters — not the project's helper. */
function signModeration(ref, decision, revision, ts) {
  return crypto
    .createHmac('sha256', MODERATION_SECRET)
    .update(`${ref}|${decision}|${revision}|${ts}`)
    .digest('hex');
}

// ---------------------------------------------------------------------------
// The bundler
// ---------------------------------------------------------------------------

const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const ROOT = path.join(os.tmpdir(), 'opencode', 'wave9b-admin-inbox', STAMP);

/** The roots a bundle is built from: the repo, or a COPY of it. */
function repoRoots() {
  return { apiDir: path.join(REPO, 'api'), sharedDir: path.join(SITE, 'shared') };
}

async function buildBundle(name, roots) {
  const entryFile = path.join(ROOT, `${name}-entry.ts`);
  const outFile = path.join(ROOT, `${name}-bundle.cjs`);
  fs.mkdirSync(ROOT, { recursive: true });
  const abs = (p) => p.replace(/\\/g, '/');
  fs.writeFileSync(
    entryFile,
    [
      `export { default as adminReviews } from '${abs(path.join(roots.sharedDir, 'portal-handlers/admin-reviews.ts'))}';`,
      `export { default as moderate } from '${abs(path.join(roots.apiDir, 'moderate/review.ts'))}';`,
      `export { createSession } from '${abs(path.join(roots.sharedDir, 'server/portal-session.ts'))}';`,
      `export { getPortalStore } from '${abs(path.join(roots.sharedDir, 'server/portal-store-access.ts'))}';`,
      `export { createLibsqlStore } from '${abs(path.join(roots.sharedDir, 'portal-store/libsql-adapter.ts'))}';`,
      `export { StorageError } from '${abs(path.join(roots.sharedDir, 'portal-store/errors.ts'))}';`,
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
    external: ['node:http', 'node:crypto', 'node:fs', 'node:path', 'node:stream', 'node:os'],
    logLevel: 'silent',
  });
  return outFile;
}

// ---------------------------------------------------------------------------
// The scenario
// ---------------------------------------------------------------------------

/**
 * The scenario, in FILE mode.
 *
 * The quote is written THROUGH THE STORE (not through a file write), so the
 * inbox proves that it reads the store. The decision is made through the
 * moderation endpoint, so the "recently decided" list proves that the two
 * endpoints share one store.
 */
async function fileModeRun(roots, name) {
  const sandbox = path.join(ROOT, name);
  const dataDir = path.join(sandbox, 'site', 'data');
  const reviewsFile = path.join(dataDir, 'moderation', 'reviews.jsonl');

  // The cwd must leave the directory that is about to be removed.
  process.chdir(ROOT);
  fs.rmSync(sandbox, { recursive: true, force: true });
  fs.mkdirSync(path.join(dataDir, 'moderation'), { recursive: true });
  fs.writeFileSync(reviewsFile, '', 'utf8');

  applyEnv(baseEnv({ PORTAL_STORE: 'file' }));
  process.chdir(sandbox);

  const bundleFile = await buildBundle(name, roots);
  const api = require(bundleFile);

  const ownerToken = api.createSession(OWNER, 'admin');
  const clientToken = api.createSession(CLIENT, 'client', 'cli_wave9b');
  assert(ownerToken, 'the owner session could not be minted');
  assert(clientToken, 'the client session could not be minted');
  const ownerCookie = `imk_admin_session=${ownerToken}`;
  const clientCookie = `imk_session=${clientToken}`;

  const store = api.getPortalStore();
  await store.append('reviews', PENDING_REVIEW);

  const queue = await call(api.adminReviews, 'GET', '/api/admin/reviews', {
    cookie: ownerCookie,
  });

  const ts = Math.floor(Date.now() / 1000);
  const sig = signModeration(REF, 'approve', 1, ts);
  const decided = await call(
    api.moderate,
    'POST',
    `/api/moderate/review?ref=${REF}&decision=approve&revision=1&sig=${sig}&ts=${ts}`,
  );

  const afterDecision = await call(api.adminReviews, 'GET', '/api/admin/reviews', {
    cookie: ownerCookie,
  });

  // What the store holds after the decision — the same store the inbox reads.
  const stored = await store.list('reviews');

  // The failure answers.
  fs.rmSync(reviewsFile);
  const storeMissing = await call(api.adminReviews, 'GET', '/api/admin/reviews', {
    cookie: ownerCookie,
  });

  fs.writeFileSync(reviewsFile, '{ this line is not json\n', 'utf8');
  const storeCorrupt = await call(api.adminReviews, 'GET', '/api/admin/reviews', {
    cookie: ownerCookie,
  });

  // The gate.
  const asClient = await call(api.adminReviews, 'GET', '/api/admin/reviews', {
    cookie: clientCookie,
  });
  const asNobody = await call(api.adminReviews, 'GET', '/api/admin/reviews');
  const wrongMethod = await call(api.adminReviews, 'POST', '/api/admin/reviews', {
    cookie: ownerCookie,
  });
  const wrongPath = await call(api.adminReviews, 'GET', '/api/admin/nothing', {
    cookie: ownerCookie,
  });

  const savedEmails = process.env.ADMIN_EMAILS;
  process.env.ADMIN_EMAILS = '';
  const noAllowList = await call(api.adminReviews, 'GET', '/api/admin/reviews', {
    cookie: ownerCookie,
  });
  process.env.ADMIN_EMAILS = savedEmails;

  const savedSecret = process.env.FORM_WEBHOOK_SECRET;
  delete process.env.FORM_WEBHOOK_SECRET;
  const noSecret = await call(api.adminReviews, 'GET', '/api/admin/reviews', {
    cookie: ownerCookie,
  });
  process.env.FORM_WEBHOOK_SECRET = savedSecret;

  return {
    queue,
    decided,
    afterDecision,
    stored,
    storeMissing,
    storeCorrupt,
    asClient,
    asNobody,
    wrongMethod,
    wrongPath,
    noAllowList,
    noSecret,
    reviewsFile,
  };
}

/**
 * The scenario, in LIBSQL mode.
 *
 * The same steps against a real SQLite engine over the real v2 wire protocol:
 * the queue comes from the DATABASE and the decision is written to the
 * DATABASE. No JSONL file is touched.
 */
async function libsqlModeRun(roots, name, mock) {
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

  const bundleFile = await buildBundle(name, roots);
  const api = require(bundleFile);

  const ownerToken = api.createSession(OWNER, 'admin');
  const ownerCookie = `imk_admin_session=${ownerToken}`;

  const store = api.getPortalStore();
  await store.append('reviews', PENDING_REVIEW);

  const queue = await call(api.adminReviews, 'GET', '/api/admin/reviews', {
    cookie: ownerCookie,
  });

  const ts = Math.floor(Date.now() / 1000);
  const sig = signModeration(REF, 'approve', 1, ts);
  const decided = await call(
    api.moderate,
    'POST',
    `/api/moderate/review?ref=${REF}&decision=approve&revision=1&sig=${sig}&ts=${ts}`,
  );

  const afterDecision = await call(api.adminReviews, 'GET', '/api/admin/reviews', {
    cookie: ownerCookie,
  });

  const onDisk = fs.existsSync(dataDir) ? fs.readdirSync(dataDir) : [];

  return { queue, decided, afterDecision, onDisk };
}

// ---------------------------------------------------------------------------
// The schema promise (B6)
// ---------------------------------------------------------------------------

/**
 * Drive a libSQL store whose schema step fails ONCE.
 *
 * The first call must fail. The SECOND call must succeed: the rejected
 * schema promise must not be cached, or the instance is dead for life.
 */
async function schemaPromiseOutcome(roots, name) {
  const bundleFile = await buildBundle(name, roots);
  const api = require(bundleFile);

  let schemaCalls = 0;
  const transport = {
    async executeAll() {
      schemaCalls += 1;
      if (schemaCalls === 1) {
        throw new api.StorageError('libsql: the database is unreachable', 'storage-unavailable');
      }
      return [];
    },
    async execute(sql) {
      if (/FROM moderation_reviews/.test(sql)) {
        return { cols: ['data'], rows: [], changes: 0 };
      }
      return { cols: [], rows: [], changes: 0 };
    },
  };

  const store = api.createLibsqlStore({ transport });

  let firstError = null;
  try {
    await store.list('reviews');
  } catch (err) {
    firstError = err;
  }

  let secondError = null;
  let secondValue = null;
  try {
    secondValue = await store.list('reviews');
  } catch (err) {
    secondError = err;
  }

  return { schemaCalls, firstError, secondError, secondValue };
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

// ---------------------------------------------------------------------------
// The mutation probes
// ---------------------------------------------------------------------------

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dst);
    else fs.copyFileSync(src, dst);
  }
}

/** A copy of the tree with the defect put back. */
function mutatedRoots(name) {
  const copyRoot = path.join(ROOT, name);
  fs.rmSync(copyRoot, { recursive: true, force: true });
  copyDir(path.join(REPO, 'api'), path.join(copyRoot, 'api'));
  copyDir(path.join(SITE, 'shared'), path.join(copyRoot, 'site', 'shared'));
  return { copyRoot, roots: { apiDir: path.join(copyRoot, 'api'), sharedDir: path.join(copyRoot, 'site', 'shared') } };
}

// ---------------------------------------------------------------------------
// The tests
// ---------------------------------------------------------------------------

/** The source without its comments — a comment may NAME the store, not use it. */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^[ \t]*\/\/.*$/gm, ' ');
}

async function main() {
  fs.mkdirSync(ROOT, { recursive: true });
  origLog(`[wave9b] sandbox: ${ROOT}`);

  group('B1 — the inbox reads the store, not the JSONL file');

  await t('B1', 'a source scan proves the inbox has no JSONL reader left', async () => {
    const source = stripComments(
      fs.readFileSync(path.join(REPO, 'site', 'shared', 'portal-handlers', 'admin-reviews.ts'), 'utf8'),
    );
    const hits = [];
    if (/from '\.\.\/lib\/jsonl\.js'/.test(source)) hits.push('the jsonl module');
    if (/parseJsonlStrict|guardStorage|readJsonlFile|appendJsonl|rewriteJsonl/.test(source)) {
      hits.push('a JSONL helper');
    }
    if (/site[\\/]data/.test(source)) hits.push('a site/data path');
    if (/node:fs|node:path/.test(source)) hits.push('a direct filesystem import');
    assert(
      hits.length === 0,
      `the admin inbox still reaches the file store: ${hits.join(', ')}`,
    );
    if (!/getPortalStore/.test(source)) {
      throw new Error('the admin inbox does not read through the store');
    }
    return 'no JSONL helper, no site/data path, no direct fs import';
  });

  group('B2 — FILE MODE: the inbox and the decision share one store');

  const roots = repoRoots();
  const fileRun = await fileModeRun(roots, 'file-mode');

  await t('B2a', 'a quote written THROUGH THE STORE shows up in the inbox', async () => {
    assertEqual(fileRun.queue.status, 200, `the inbox should be 200 (got ${fileRun.queue.status})`);
    const body = fileRun.queue.body;
    assert(body && typeof body === 'object', `unexpected body: ${JSON.stringify(body)}`);
    assertEqual(body.counts.pendingReviews, 1, `the queue should hold the quote (got ${JSON.stringify(body.counts)})`);
    const item = (body.reviews || [])[0];
    assert(item, `the queue does not carry ${REF}: ${JSON.stringify(body)}`);
    assertEqual(item.ref, REF, 'the queue carries another quote');
    assertEqual(item.state, 'pending', 'the quote is not pending');
    assertEqual(item.quote, PENDING_REVIEW.review, 'the quote text is not the stored one');
    assert(
      String(item.approvePath || '').startsWith('/api/moderate/review?'),
      `the approve link is not a moderation link (got ${item.approvePath})`,
    );
    assert(
      String(item.rejectPath || '').includes('decision=reject'),
      `the reject link is not a reject link (got ${item.rejectPath})`,
    );
    return `pending=1, ref=${item.ref}`;
  });

  await t('B2b', 'the response shape is the one admin.astro consumes', async () => {
    const body = fileRun.queue.body;
    assertEqual(
      JSON.stringify(Object.keys(body).sort()),
      JSON.stringify(['counts', 'notesAvailable', 'ok', 'recent', 'reviews']),
      'the top-level shape changed',
    );
    assertEqual(body.ok, true, 'ok must be true');
    assertEqual(body.notesAvailable, false, 'there is no notes store');
    assertEqual(body.counts.openNotes, null, 'the notes count must be null, not 0');
    assert(
      typeof body.counts.decidedToday === 'number',
      `decidedToday must be a number (got ${JSON.stringify(body.counts)})`,
    );
    assert(Array.isArray(body.reviews), 'reviews must be an array');
    assert(Array.isArray(body.recent), 'recent must be an array');
    return 'ok, counts{pendingReviews,decidedToday,openNotes}, notesAvailable, reviews, recent';
  });

  await t('B2c', 'a decision through /api/moderate/review shows up in the inbox', async () => {
    assertEqual(fileRun.decided.status, 200, `the decision should be 200 (got ${fileRun.decided.status})`);
    assertEqual(fileRun.decided.body.state, 'approved', 'the quote was not approved');
    const after = fileRun.afterDecision;
    assertEqual(after.status, 200, `the inbox should still be 200 (got ${after.status})`);
    assertEqual(
      after.body.counts.pendingReviews,
      0,
      `the approved quote must leave the pending queue (got ${JSON.stringify(after.body.counts)})`,
    );
    const recent = (after.body.recent || [])[0];
    assert(recent, `the decided quote is not in the "recent" list: ${JSON.stringify(after.body)}`);
    assertEqual(recent.ref, REF, 'the recent list carries another quote');
    assertEqual(recent.state, 'approved', 'the recent list does not carry the decision');
    return 'the decision made by the moderation endpoint is in the inbox';
  });

  await t('B2d', 'the store itself holds the decision (one store, one truth)', async () => {
    const stored = fileRun.stored.filter((r) => r.ref === REF);
    assertEqual(stored.length, 1, `the store holds ${stored.length} records for ${REF}`);
    assertEqual(stored[0].state, 'approved', 'the store does not carry the decision');
    return 'the store and the inbox agree: the quote is approved';
  });

  group('B3 — a store that cannot serve the queue is never an empty queue');

  await t('B3a', 'a store that is NOT THERE answers 501 {code:unimplemented}', async () => {
    assertEqual(fileRun.storeMissing.status, 501, `the answer should be 501 (got ${fileRun.storeMissing.status})`);
    assertEqual(fileRun.storeMissing.body.code, 'unimplemented', `the code should be unimplemented (got ${JSON.stringify(fileRun.storeMissing.body)})`);
    assert(
      !/pendingReviews/.test(JSON.stringify(fileRun.storeMissing.body)),
      'the answer looks like an empty queue',
    );
    return '501 {code:unimplemented} — never a 200 with an empty list';
  });

  await t('B3b', 'a store that cannot be PARSED answers 500 {code:storage}', async () => {
    assertEqual(fileRun.storeCorrupt.status, 500, `the answer should be 500 (got ${fileRun.storeCorrupt.status})`);
    assertEqual(fileRun.storeCorrupt.body.code, 'storage', `the code should be storage (got ${JSON.stringify(fileRun.storeCorrupt.body)})`);
    assert(
      !/pendingReviews/.test(JSON.stringify(fileRun.storeCorrupt.body)),
      'the answer looks like an empty queue',
    );
    return '500 {code:storage} — a corrupt log is never "nothing to moderate"';
  });

  group('B4 — the gate is unchanged');

  await t('B4a', 'a client session is 401, no cookie is 401', async () => {
    assertEqual(fileRun.asClient.status, 401, `a client should be 401 (got ${fileRun.asClient.status})`);
    assertEqual(fileRun.asClient.body.code, 'unauthorized', 'the code should be unauthorized');
    assertEqual(fileRun.asNobody.status, 401, `no cookie should be 401 (got ${fileRun.asNobody.status})`);
    assertEqual(fileRun.asNobody.body.code, 'unauthorized', 'the code should be unauthorized');
    return 'client 401, no cookie 401';
  });

  await t('B4b', 'an unset ADMIN_EMAILS is 500, a missing secret is 500', async () => {
    assertEqual(fileRun.noAllowList.status, 500, `an unset allow-list should be 500 (got ${fileRun.noAllowList.status})`);
    assertEqual(fileRun.noAllowList.body.code, 'internal', 'the code should be internal');
    assertEqual(fileRun.noSecret.status, 500, `a missing secret should be 500 (got ${fileRun.noSecret.status})`);
    assertEqual(fileRun.noSecret.body.code, 'internal', 'the code should be internal');
    return 'unset allow-list 500, missing FORM_WEBHOOK_SECRET 500';
  });

  await t('B4c', 'a wrong method is 405 and a wrong path is 404', async () => {
    assertEqual(fileRun.wrongMethod.status, 405, `a POST should be 405 (got ${fileRun.wrongMethod.status})`);
    assertEqual(fileRun.wrongPath.status, 404, `a wrong path should be 404 (got ${fileRun.wrongPath.status})`);
    return 'POST 405, wrong path 404';
  });

  group('B5 — LIBSQL MODE: the queue comes from the DATABASE');

  let libsqlRun = null;
  let mock = null;

  await t('B5a', 'the queue and the decision live in the database, not in a file', async () => {
    mock = await startMock();
    try {
      libsqlRun = await libsqlModeRun(roots, 'libsql-mode', mock);
      assertEqual(libsqlRun.queue.status, 200, `the inbox should be 200 (got ${libsqlRun.queue.status})`);
      assertEqual(
        libsqlRun.queue.body.counts.pendingReviews,
        1,
        `the database quote should be in the queue (got ${JSON.stringify(libsqlRun.queue.body.counts)})`,
      );
      assertEqual(
        (libsqlRun.queue.body.reviews || [])[0].ref,
        REF,
        'the queue carries another quote',
      );
      assertEqual(libsqlRun.decided.status, 200, `the decision should be 200 (got ${libsqlRun.decided.status})`);
      assertEqual(libsqlRun.decided.body.state, 'approved', 'the quote was not approved');
      assertEqual(
        libsqlRun.afterDecision.body.counts.pendingReviews,
        0,
        'the approved quote must leave the pending queue',
      );
      assertEqual(
        (libsqlRun.afterDecision.body.recent || [])[0].ref,
        REF,
        'the decided quote is not in the "recent" list',
      );
      assertEqual(
        JSON.stringify(libsqlRun.onDisk),
        JSON.stringify([]),
        'the file adapter was used in libsql mode',
      );
      const statements = JSON.stringify(mock.requests);
      assert(/moderation_reviews/.test(statements), 'the database was never asked about the reviews');
      assert(/UPDATE/.test(statements), 'the decision was never written to the database');
      return 'the database holds the quote and the decision; no JSONL file was written';
    } finally {
      await mock.close();
      mock = null;
    }
  });

  group('B6 — the rejected schema promise is not cached');

  await t('B6a', 'a store whose schema step failed ONCE recovers on the next call', async () => {
    const outcome = await schemaPromiseOutcome(roots, 'schema-retry');
    assert(outcome.firstError, 'the first attempt should have failed');
    assert(
      !outcome.secondError,
      `the second attempt failed too — the rejected schema promise is cached: ${outcome.secondError}`,
    );
    assert(Array.isArray(outcome.secondValue), 'the second attempt did not return a list');
    assertEqual(outcome.schemaCalls, 2, 'the schema step must be retried');
    return 'the first failure was not cached: the second call retried the schema';
  });

  group('B7 — the mutation probes');

  await t('B7a', 'MUTATION: with the inbox reading the FILE again, the libSQL queue is empty', async () => {
    const { copyRoot, roots: copyRoots } = mutatedRoots('copy-inbox');
    const target = path.join(copyRoot, 'site', 'shared', 'portal-handlers', 'admin-reviews.ts');
    const source = fs.readFileSync(target, 'utf8');
    const ANCHOR = "    records = await store.list('reviews');";
    assert(source.includes(ANCHOR), `the mutation anchor was not found in ${target}`);
    const MUTATION =
      "    records = await (await import('../portal-store/file-adapter.js'))" +
      ".createFileStore({ dataDir: process.cwd() + '/site/data' }).list('reviews');";
    fs.writeFileSync(target, source.replace(ANCHOR, MUTATION), 'utf8');

    const mutatedMock = await startMock();
    try {
      const mutated = await libsqlModeRun(copyRoots, 'libsql-mode-mutated', mutatedMock);
      const pending = mutated.queue?.body?.counts?.pendingReviews;
      assert(
        pending !== 1,
        `the mutation did not redden the check — the inbox still found the quote (pending=${pending})`,
      );
      return `the mutated copy shows ${pending} pending — the empty-queue defect is back`;
    } finally {
      await mutatedMock.close();
    }
  });

  await t('B7b', 'MUTATION: with the rejected schema promise cached, the store never recovers', async () => {
    const { copyRoot, roots: copyRoots } = mutatedRoots('copy-schema');
    const target = path.join(copyRoot, 'site', 'shared', 'portal-store', 'libsql-adapter.ts');
    const source = fs.readFileSync(target, 'utf8');
    const ANCHOR = 'if (schemaReady === attempt) schemaReady = null;';
    assert(source.includes(ANCHOR), `the mutation anchor was not found in ${target}`);
    fs.writeFileSync(
      target,
      source.replace(ANCHOR, '/* mutated: the rejected promise stays cached */'),
      'utf8',
    );

    const outcome = await schemaPromiseOutcome(copyRoots, 'schema-retry-mutated');
    assert(outcome.firstError, 'the first attempt should have failed');
    assert(
      outcome.secondError,
      'the mutation did not redden the check — the store recovered anyway',
    );
    return `the mutated copy stays dead: ${outcome.secondError}`;
  });

  group('B8 — the DIFFERENTIAL check: the two backends agree on one fixture');

  await t('B8a', 'FILE MODE and LIBSQL MODE answer the inbox identically', async () => {
    assert(libsqlRun, 'the libsql run did not happen');
    // The projection drops the two fields that CANNOT be equal between two
    // runs: the signed action links carry a timestamp and an HMAC, so they
    // differ by construction. Everything else must be identical.
    const project = (body) => ({
      ok: body.ok,
      notesAvailable: body.notesAvailable,
      openNotes: body.counts.openNotes,
      pendingReviews: body.counts.pendingReviews,
      reviews: (body.reviews || []).map((r) => ({
        ref: r.ref,
        revision: r.revision,
        rating: r.rating,
        name: r.name,
        company: r.company,
        quote: r.quote,
        receivedAt: r.receivedAt,
        state: r.state,
        approveIsALink: String(r.approvePath || '').startsWith('/api/moderate/review?'),
        rejectIsALink: String(r.rejectPath || '').includes('decision=reject'),
      })),
      recent: (body.recent || []).map((r) => ({
        ref: r.ref,
        state: r.state,
        rating: r.rating,
        name: r.name,
      })),
    });
    const file = project(fileRun.queue.body);
    const lib = project(libsqlRun.queue.body);
    assertEqual(
      JSON.stringify(lib),
      JSON.stringify(file),
      'the two backends disagree about the same fixture',
    );
    return `identical projection: pending=${file.pendingReviews}, openNotes=${file.openNotes}`;
  });

  await t('B8b', 'the decided queue is identical in both modes too', async () => {
    const project = (body) => ({
      pendingReviews: body.counts.pendingReviews,
      recent: (body.recent || []).map((r) => ({ ref: r.ref, state: r.state })),
    });
    const file = project(fileRun.afterDecision.body);
    const lib = project(libsqlRun.afterDecision.body);
    assertEqual(
      JSON.stringify(lib),
      JSON.stringify(file),
      'the two backends disagree about the decided queue',
    );
    assertEqual(file.pendingReviews, 0, 'the approved quote must leave the queue');
    // decidedToday depends on the wall clock, so it is compared with a
    // tolerance for a UTC midnight rollover between the two runs.
    const fileToday = fileRun.afterDecision.body.counts.decidedToday;
    const libToday = libsqlRun.afterDecision.body.counts.decidedToday;
    assert(
      typeof fileToday === 'number' && typeof libToday === 'number',
      'decidedToday must be a number in both modes',
    );
    if (fileToday !== libToday) {
      const day = (value) => String(value || '').slice(0, 10);
      const fileDay = day(fileRun.afterDecision.body.recent?.[0]?.decidedAt);
      const libDay = day(libsqlRun.afterDecision.body.recent?.[0]?.decidedAt);
      assert(
        fileDay !== libDay,
        `decidedToday differs (${fileToday} vs ${libToday}) on the SAME day (${fileDay})`,
      );
      return `the runs straddled UTC midnight (${fileDay} vs ${libDay}); everything else matched`;
    }
    return 'both modes: pending=0, recent=[approved]';
  });

  const failed = results.filter((r) => r.status === 'FAIL');
  origLog(
    `\n[wave9b] ${results.length - failed.length}/${results.length} checks passed` +
      (failed.length ? ` — ${failed.length} FAILED` : ''),
  );
  if (failed.length) {
    for (const f of failed) origLog(`  FAILED ${f.id}: ${f.error}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  origLog('[wave9b] harness error:', err);
  process.exitCode = 1;
});
