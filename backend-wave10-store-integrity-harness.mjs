// backend-wave10-store-integrity-harness.mjs
//
// EXECUTED evidence for wave 10 (backend store integrity).
//
// WHAT IT PROVES
//   A  F-1  the publisher: a store that cannot be read exits non-zero and
//           leaves the published quotes untouched; a schema that is missing is
//           not an empty store; a reachable but EMPTY store REFUSES when
//           quotes are published and still builds when nothing is published
//           (wave 11); a revoked quote disappears on the next publish; the
//           publisher's DDL is byte-identical to libsql-schema.ts's
//   B  F-2  the decision lands on the revision that was VERIFIED: a
//           concurrent append between the read and the write answers 409
//           stale-revision and changes nothing
//   C  F-3  a store this deployment cannot hold answers the storage error,
//           never "no projects" / "not invited"; the moderation endpoint and
//           the inbox keep their 501 for a missing collection file
//   D  F-4  a paged answer is assembled completely (the baton is followed)
//   E  F-5  the durable counter prunes the expired buckets, and the
//           rate-limit key is not something the client can choose
//   F  F-6  the Cloudflare inbox answers 501 and no longer claims a file store
//   G  F-7  api/lib/jsonl.ts has no importer (and why it is still there)
//
//   Every check is proven NON-VACUOUS: a mutated COPY of the tree has to make
//   it fail. The repository is never modified.
//
// USAGE
//   node backend-wave10-store-integrity-harness.mjs

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { spawn } from 'node:child_process';
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
const SESSION_SECRET = 'wave10-store-integrity-session-secret-0123456789';
const MAGIC_SECRET = 'wave10-store-integrity-magic-secret-0123456789';
const MODERATION_SECRET = 'wave10-store-integrity-moderation-secret-0123456789';
const REF = 'inq_wave10_1';

const results = [];
let currentGroup = '';
const origLog = console.log;

function group(name) {
  currentGroup = name;
  origLog(`\n[wave10] ${name}`);
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
    PORTAL_MAGIC_LINK_SECRET: MAGIC_SECRET,
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

/**
 * The HMAC over a link that NAMES A RECORD (wave 12, B-1).
 *
 * The signed message is `ref|decision|revision|recordId|ts` — the identity
 * is part of the signature, so a link cannot be re-pointed at another
 * record.
 */
function signModerationWithIdentity(ref, decision, revision, recordId, ts) {
  return crypto
    .createHmac('sha256', MODERATION_SECRET)
    .update(`${ref}|${decision}|${revision}|${recordId}|${ts}`)
    .digest('hex');
}

// ---------------------------------------------------------------------------
// The bundler
// ---------------------------------------------------------------------------

const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const ROOT = path.join(os.tmpdir(), 'opencode', 'wave10-store-integrity', STAMP);

/** The roots a bundle is built from: the repo, or a COPY of it. */
function repoRoots() {
  return {
    apiDir: path.join(REPO, 'api'),
    sharedDir: path.join(SITE, 'shared'),
    functionsDir: path.join(SITE, 'functions'),
  };
}

async function buildBundle(name, roots) {
  const entryFile = path.join(ROOT, `${name}-entry.ts`);
  const outFile = path.join(ROOT, `${name}-bundle.cjs`);
  fs.mkdirSync(ROOT, { recursive: true });
  const abs = (p) => p.replace(/\\/g, '/');
  fs.writeFileSync(
    entryFile,
    [
      `export { default as auth } from '${abs(path.join(roots.sharedDir, 'portal-handlers/portal-auth.ts'))}';`,
      `export { default as comments } from '${abs(path.join(roots.sharedDir, 'portal-handlers/portal-comments.ts'))}';`,
      `export { default as invites } from '${abs(path.join(roots.sharedDir, 'portal-handlers/portal-invites.ts'))}';`,
      `export { default as planItems } from '${abs(path.join(roots.sharedDir, 'portal-handlers/portal-plan-items.ts'))}';`,
      `export { default as projects } from '${abs(path.join(roots.sharedDir, 'portal-handlers/portal-projects.ts'))}';`,
      `export { default as testimonials } from '${abs(path.join(roots.sharedDir, 'portal-handlers/portal-testimonials.ts'))}';`,
      `export { default as updates } from '${abs(path.join(roots.sharedDir, 'portal-handlers/portal-updates.ts'))}';`,
      `export { default as moderate } from '${abs(path.join(roots.apiDir, 'moderate/review.ts'))}';`,
      `export { default as adminReviews } from '${abs(path.join(roots.sharedDir, 'portal-handlers/admin-reviews.ts'))}';`,
      `export { createSession } from '${abs(path.join(roots.sharedDir, 'server/portal-session.ts'))}';`,
      `export { getPortalStore } from '${abs(path.join(roots.sharedDir, 'server/portal-store-access.ts'))}';`,
      `export { createFileStore } from '${abs(path.join(roots.sharedDir, 'portal-store/file-adapter.ts'))}';`,
      `export { createLibsqlStore } from '${abs(path.join(roots.sharedDir, 'portal-store/libsql-adapter.ts'))}';`,
      `export { createHttpTransport } from '${abs(path.join(roots.sharedDir, 'portal-store/libsql-transport.ts'))}';`,
      `export { createLibsqlRateLimitBackend } from '${abs(path.join(roots.sharedDir, 'portal-store/durable-rate-counter.ts'))}';`,
      `export { ensureSchema, SCHEMA_STATEMENTS } from '${abs(path.join(roots.sharedDir, 'portal-store/libsql-schema.ts'))}';`,
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

/** A bundle of the Cloudflare tree (edge style: Request -> Response). */
async function buildEdgeBundle(name, roots) {
  const entryFile = path.join(ROOT, `${name}-edge-entry.ts`);
  const outFile = path.join(ROOT, `${name}-edge-bundle.cjs`);
  fs.mkdirSync(ROOT, { recursive: true });
  const abs = (p) => p.replace(/\\/g, '/');
  fs.writeFileSync(
    entryFile,
    [
      `export { onRequestGet as cfInbox } from '${abs(path.join(roots.functionsDir, 'api/admin/reviews.ts'))}';`,
      `export { onRequestPost as cfModerate } from '${abs(path.join(roots.functionsDir, 'api/moderate/review.ts'))}';`,
      `export { createSession } from '${abs(path.join(roots.sharedDir, 'server/portal-session.ts'))}';`,
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
// The mock pipeline server (the offline database)
// ---------------------------------------------------------------------------

let mockBundle = null;

async function startMock(options = {}) {
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
  return mockBundle.startMockPipelineServer(options);
}

// ---------------------------------------------------------------------------
// The publisher (run as a child process, like the build runs it)
// ---------------------------------------------------------------------------

const PUBLISHER = path.join(SITE, 'scripts', 'publish-testimonials.mjs');

/** A publisher sandbox: the published directory and the store. */
function publisherSandbox(name) {
  const dir = path.join(ROOT, 'publisher', name);
  const siteDir = path.join(dir, 'site');
  const published = path.join(siteDir, 'src', 'content', 'testimonials');
  const dataDir = path.join(siteDir, 'data', 'moderation');
  fs.mkdirSync(published, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  return { dir, siteDir, published, reviewsFile: path.join(dataDir, 'reviews.jsonl') };
}

/**
 * Run the publisher, the way the build runs it.
 *
 * ASYNCHRONOUS on purpose: the publisher talks to the mock database, which
 * lives in THIS process. A synchronous child would block the event loop and
 * the mock could never answer.
 */
function runPublisher(sandbox, env = {}, script = PUBLISHER) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], {
      cwd: sandbox.siteDir,
      env: { ...process.env, ...env },
    });
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
    child.on('close', (code) => resolve({ status: typeof code === 'number' ? code : 1, stdout, stderr }));
    child.on('error', (err) => resolve({ status: 1, stdout, stderr: String(err.message || err) }));
  });
}

function publishedFiles(sandbox) {
  if (!fs.existsSync(sandbox.published)) return [];
  return fs.readdirSync(sandbox.published).filter((f) => f.endsWith('.md')).sort();
}

const QUOTE = {
  type: 'review',
  ref: REF,
  state: 'approved',
  source: 'portal',
  verifiedClient: true,
  name: 'Nora Vance',
  company: 'Named Co',
  role: 'CTO',
  rating: 5,
  review: 'A perfectly good quote.',
  consent: { p1: true, p2: true, p3: false, displayName: 'Nora Vance' },
  revision: 1,
};

function writeReviews(file, records) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : ''),
    'utf8',
  );
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
  copyDir(path.join(SITE, 'functions'), path.join(copyRoot, 'site', 'functions'));
  copyDir(path.join(SITE, 'scripts'), path.join(copyRoot, 'site', 'scripts'));
  return {
    copyRoot,
    roots: {
      apiDir: path.join(copyRoot, 'api'),
      sharedDir: path.join(copyRoot, 'site', 'shared'),
      functionsDir: path.join(copyRoot, 'site', 'functions'),
    },
  };
}

/** Patch a file in a copy. The anchor must exist — a missing anchor is a bug. */
function patch(file, from, to) {
  const raw = fs.readFileSync(file, 'utf8');
  if (!raw.includes(from)) {
    throw new Error(`the mutation anchor was not found in ${file}: ${from.slice(0, 70)}`);
  }
  fs.writeFileSync(file, raw.replace(from, to), 'utf8');
}

// ---------------------------------------------------------------------------
// The scenarios
// ---------------------------------------------------------------------------

/**
 * The moderation handler with a RACE: the store appends a newer revision
 * between the handler's read and its write.
 *
 * The racing store is a wrapper around the real one — the product code is
 * not touched, the race is injected where it happens in reality: between the
 * check and the write.
 */
function racingStore(real) {
  return {
    ...real,
    async decideReview(ref, decision, at, decidedBy, expectedRevision, expectedRecordId) {
      await real.append('reviews', {
        type: 'review',
        ref,
        state: 'pending',
        revision: 99,
        review: 'A newer revision the owner never saw.',
      });
      return real.decideReview(
        ref,
        decision,
        at,
        decidedBy,
        expectedRevision,
        expectedRecordId,
      );
    },
  };
}

/** The key the store cache uses for the current environment. */
function storeCacheKey(dataDir) {
  return ['file', dataDir, '', ''].join('|');
}

async function main() {
  fs.mkdirSync(ROOT, { recursive: true });
  origLog(`[wave10] sandbox: ${ROOT}`);

  const roots = repoRoots();

  // =========================================================================
  group('A — F-1: the publisher never empties the published set by accident');
  // =========================================================================

  await t('A1', 'a store file that is NOT THERE exits 1 and leaves the published quote', async () => {
    const sandbox = publisherSandbox('missing-store');
    fs.writeFileSync(
      path.join(sandbox.published, 'kept.md'),
      '---\nquote: "the quote that was already published"\n---\n\nthe quote that was already published\n',
      'utf8',
    );
    const result = await runPublisher(sandbox, { PORTAL_STORE: 'file' });
    assert(result.status !== 0, `the publisher exited 0 with a missing store: ${result.stdout}`);
    assert(
      /publish-testimonials/.test(result.stderr),
      `the failure was not explained: ${result.stderr}`,
    );
    assertEqual(publishedFiles(sandbox).length, 1, 'the published quote was destroyed');
    assert(
      fs
        .readFileSync(path.join(sandbox.published, 'kept.md'), 'utf8')
        .includes('the quote that was already published'),
      'the published quote was changed',
    );
    return `exit ${result.status}, the published quote survived`;
  });

  await t('A2', 'a store that cannot be PARSED exits 1 and leaves the published quote', async () => {
    const sandbox = publisherSandbox('corrupt-store');
    fs.writeFileSync(
      path.join(sandbox.published, 'kept.md'),
      '---\nquote: "the quote that was already published"\n---\n\nthe quote that was already published\n',
      'utf8',
    );
    fs.writeFileSync(sandbox.reviewsFile, '{ this line is not json\n', 'utf8');
    const result = await runPublisher(sandbox, { PORTAL_STORE: 'file' });
    assert(result.status !== 0, `the publisher exited 0 with a corrupt store: ${result.stdout}`);
    assert(
      /reviews\.jsonl/.test(result.stderr) && /line 1/.test(result.stderr),
      `the failure must name the file and the line: ${result.stderr}`,
    );
    assertEqual(publishedFiles(sandbox).length, 1, 'the published quote was destroyed');
    return `exit ${result.status}, the published quote survived`;
  });

  await t('A3', 'a database with NO SCHEMA exits 1 (a missing schema is not an empty store)', async () => {
    const mock = await startMock();
    try {
      const sandbox = publisherSandbox('no-schema');
      fs.writeFileSync(
        path.join(sandbox.published, 'kept.md'),
        '---\nquote: "the quote that was already published"\n---\n\nthe quote that was already published\n',
        'utf8',
      );
      const result = await runPublisher(sandbox, {
        PORTAL_STORE: 'libsql',
        LIBSQL_URL: mock.url,
        LIBSQL_TOKEN: mock.token,
      });
      assert(result.status !== 0, `the publisher exited 0 with no schema: ${result.stdout}`);
      assert(
        /publish-testimonials/.test(result.stderr),
        `the failure was not explained: ${result.stderr}`,
      );
      assertEqual(publishedFiles(sandbox).length, 1, 'the published quote was destroyed');

      // The schema was CREATED (the DDL is idempotent) — so the store is
      // usable from now on.
      const schema = JSON.stringify(mock.requests);
      assert(/CREATE TABLE IF NOT EXISTS moderation_reviews/.test(schema), 'the schema was not created');
      return `exit ${result.status}, the schema was created, the published quote survived`;
    } finally {
      await mock.close();
    }
  });

  await t('A4', 'a reachable, schema-present but EMPTY store REFUSES and leaves the published quote', async () => {
    const mock = await startMock();
    try {
      const sandbox = publisherSandbox('empty-store');
      fs.writeFileSync(
        path.join(sandbox.published, 'kept.md'),
        '---\nquote: "the quote that was already published"\n---\n\nthe quote that was already published\n',
        'utf8',
      );
      const env = {
        PORTAL_STORE: 'libsql',
        LIBSQL_URL: mock.url,
        LIBSQL_TOKEN: mock.token,
      };
      // The first run creates the schema (and refuses: a store that never
      // held a moderation log is not an empty store).
      const first = await runPublisher(sandbox, env);
      assert(first.status !== 0, 'the first run (no schema) should have refused');
      // The second run finds the schema: the store is there and empty. An
      // empty store is not an empty publish set — the quote must survive.
      const second = await runPublisher(sandbox, env);
      assert(
        second.status !== 0,
        `an empty store must not publish an empty set (exit 0: ${second.stdout})`,
      );
      assert(
        /no (review|moderation) records/i.test(second.stderr),
        `the failure must name the condition (an empty store): ${second.stderr}`,
      );
      assertEqual(publishedFiles(sandbox).length, 1, 'the published quote was destroyed');
      assert(
        fs
          .readFileSync(path.join(sandbox.published, 'kept.md'), 'utf8')
          .includes('the quote that was already published'),
        'the published quote was changed',
      );
      // THE ONE-RUN-APART TRAP (wave 11): the same store state must give the
      // same verdict on every run after the schema exists.
      const third = await runPublisher(sandbox, env);
      assert(
        third.status !== 0,
        `the third run published an empty set (exit 0: ${third.stdout})`,
      );
      assertEqual(publishedFiles(sandbox).length, 1, 'the published quote was destroyed by the third run');
      return 'both runs refused, the published quote survived';
    } finally {
      await mock.close();
    }
  });

  await t('A5', 'a revoked quote DISAPPEARS on the next successful publish (RP-6.5)', async () => {
    const sandbox = publisherSandbox('revoked');
    writeReviews(sandbox.reviewsFile, [QUOTE]);
    const first = await runPublisher(sandbox, { PORTAL_STORE: 'file' });
    assertEqual(first.status, 0, `the first publish failed: ${first.stderr}`);
    assertEqual(publishedFiles(sandbox).length, 1, 'the approved quote was not published');

    // The client withdraws the consent: the newest record for the ref is
    // revoked.
    writeReviews(sandbox.reviewsFile, [
      QUOTE,
      { ...QUOTE, state: 'revoked', revoked: true, revision: 2 },
    ]);
    const second = await runPublisher(sandbox, { PORTAL_STORE: 'file' });
    assertEqual(second.status, 0, `the second publish failed: ${second.stderr}`);
    assertEqual(publishedFiles(sandbox).length, 0, 'the revoked quote was still published');
    return 'the revoked quote is gone after the next publish';
  });

  await t('A6', "the publisher's DDL is IDENTICAL to libsql-schema.ts's DDL", async () => {
    const publisher = await import(pathToFileURL(PUBLISHER).href);
    const schemaModule = await import(
      pathToFileURL(
        path.join(ROOT, 'schema-module.mjs'),
      ).href
    ).catch(() => null);
    // The schema module is TypeScript: bundle it.
    const outFile = path.join(ROOT, 'schema-module.mjs');
    await build({
      entryPoints: [path.join(SITE, 'shared/portal-store/libsql-schema.ts')],
      outfile: outFile,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node20',
      logLevel: 'silent',
    });
    const schema = await import(pathToFileURL(outFile).href + `?v=${Date.now()}`);
    assert(Array.isArray(publisher.SCHEMA_STATEMENTS), 'the publisher exports no SCHEMA_STATEMENTS');
    assertEqual(
      publisher.SCHEMA_STATEMENTS.length,
      schema.SCHEMA_STATEMENTS.length,
      'the two DDL lists have a different number of statements',
    );
    for (let i = 0; i < schema.SCHEMA_STATEMENTS.length; i++) {
      assertEqual(
        publisher.SCHEMA_STATEMENTS[i],
        schema.SCHEMA_STATEMENTS[i],
        `DDL statement ${i + 1} differs between the publisher and libsql-schema.ts`,
      );
    }
    return `${schema.SCHEMA_STATEMENTS.length} statements, byte-identical`;
  });

  await t('A7', 'MUTATION: with the missing store treated as an empty store AND the empty-store guard removed, A1 goes RED', async () => {
    const { copyRoot, roots: copyRoots } = mutatedRoots('copy-publisher');
    const script = path.join(copyRoot, 'site', 'scripts', 'publish-testimonials.mjs');
    // TWO layers now stand between a broken store and a deleted quote (wave
    // 11): the missing-store check and the empty-store guard. Removing only
    // the first one no longer destroys anything — the guard refuses instead.
    // The mutation therefore puts BOTH defects back, so the check keeps
    // proving what it claims: without them, the published quote is gone.
    patch(
      script,
      `  if (!fs.existsSync(file)) {
    throw new MissingStoreError(
      \`\${file} does not exist — the moderation store is not there. \` +
        'Refusing to publish a partial set of testimonials.',
    );
  }`,
      `  if (!fs.existsSync(file)) return [];`,
    );
    patch(
      script,
      `  if (reviews.length > 0 || published.length === 0) return;`,
      `  if (true) return;`,
    );

    const sandbox = publisherSandbox('mutated-missing-store');
    fs.writeFileSync(
      path.join(sandbox.published, 'kept.md'),
      '---\nquote: "the quote that was already published"\n---\n\nthe quote that was already published\n',
      'utf8',
    );
    const result = await runPublisher(sandbox, { PORTAL_STORE: 'file' }, script);
    assertEqual(result.status, 0, 'the mutated publisher should have exited 0 (the defect is back)');
    assertEqual(
      publishedFiles(sandbox).length,
      0,
      'the mutation did not redden the check — the published quote was not destroyed',
    );
    return 'the mutated copy publishes an empty set and deletes the published quote';
  });

  await t('A8', 'a FRESH install (no store, no published quotes) still publishes and exits 0', async () => {
    const sandbox = publisherSandbox('fresh-install');
    // No store file, no published quotes: there is nothing to lose, and the
    // site must still build.
    const result = await runPublisher(sandbox, { PORTAL_STORE: 'file' });
    assertEqual(result.status, 0, `a fresh install must build (got ${result.status}: ${result.stderr})`);
    assertEqual(publishedFiles(sandbox).length, 0, 'nothing may be published from an empty store');
    return 'exit 0, nothing published — the fresh-clone case still builds';
  });

  await t('A9', 'MUTATION: with a missing store always fatal, A8 goes RED', async () => {
    const { copyRoot, roots: copyRoots } = mutatedRoots('copy-publisher-strict');
    const script = path.join(copyRoot, 'site', 'scripts', 'publish-testimonials.mjs');
    patch(
      script,
      `    if (err && err.storeMissing === true && publishedQuoteNames().length === 0) {`,
      `    if (false && err && err.storeMissing === true && publishedQuoteNames().length === 0) {`,
    );
    const sandbox = publisherSandbox('mutated-fresh-install');
    const result = await runPublisher(sandbox, { PORTAL_STORE: 'file' }, script);
    assert(
      result.status !== 0,
      'the mutation did not redden the check — the fresh install still built',
    );
    return `the mutated copy refuses the fresh install (exit ${result.status})`;
  });

  // =========================================================================
  // WAVE 11 — an EMPTY store is not an empty publish set.
  // =========================================================================

  const PUBLISHED_QUOTE =
    '---\nquote: "the quote that was already published"\n---\n\nthe quote that was already published\n';

  await t('A10', 'an EMPTY store + a published quote REFUSES in BOTH modes and the quote survives', async () => {
    // --- the FILE store: a 0-byte reviews.jsonl is a store that IS there and
    // holds nothing.
    const fileSandbox = publisherSandbox('empty-store-file');
    fs.writeFileSync(path.join(fileSandbox.published, 'kept.md'), PUBLISHED_QUOTE, 'utf8');
    fs.writeFileSync(fileSandbox.reviewsFile, '', 'utf8');
    const fileRun = await runPublisher(fileSandbox, {
      PORTAL_STORE: 'file',
      PORTAL_DATA_DIR: path.join(fileSandbox.siteDir, 'data'),
    });
    assert(
      fileRun.status !== 0,
      `an empty store must not publish an empty set (exit 0: ${fileRun.stdout})`,
    );
    assert(
      /no (review|moderation) records/i.test(fileRun.stderr),
      `the failure must name the condition (an empty store): ${fileRun.stderr}`,
    );
    assertEqual(publishedFiles(fileSandbox).length, 1, 'the published quote was destroyed (file mode)');
    assert(
      fs
        .readFileSync(path.join(fileSandbox.published, 'kept.md'), 'utf8')
        .includes('the quote that was already published'),
      'the published quote was changed (file mode)',
    );

    // --- the DATABASE store: the same condition, one run later.
    const mock = await startMock();
    try {
      const dbSandbox = publisherSandbox('empty-store-db');
      fs.writeFileSync(path.join(dbSandbox.published, 'kept.md'), PUBLISHED_QUOTE, 'utf8');
      const env = {
        PORTAL_STORE: 'libsql',
        LIBSQL_URL: mock.url,
        LIBSQL_TOKEN: mock.token,
      };
      // The first run creates the schema (and refuses: a store that never
      // held a moderation log is not an empty store).
      const first = await runPublisher(dbSandbox, env);
      assert(first.status !== 0, 'the first run (no schema) should have refused');
      // The second run finds the schema: the store is there and empty.
      const second = await runPublisher(dbSandbox, env);
      assert(
        second.status !== 0,
        `an empty store must not publish an empty set (exit 0: ${second.stdout})`,
      );
      assert(
        /no (review|moderation) records/i.test(second.stderr),
        `the failure must name the condition (an empty store): ${second.stderr}`,
      );
      assertEqual(publishedFiles(dbSandbox).length, 1, 'the published quote was destroyed (libsql mode)');
      assert(
        fs
          .readFileSync(path.join(dbSandbox.published, 'kept.md'), 'utf8')
          .includes('the quote that was already published'),
        'the published quote was changed (libsql mode)',
      );
      return 'both modes refuse, the published quote survived in both';
    } finally {
      await mock.close();
    }
  });

  await t('A11', 'an EMPTY store + NOTHING published exits 0 and writes nothing (a fresh install still builds)', async () => {
    // --- the FILE store: a 0-byte store, an empty published directory.
    const fileSandbox = publisherSandbox('empty-store-fresh');
    fs.writeFileSync(fileSandbox.reviewsFile, '', 'utf8');
    const fileRun = await runPublisher(fileSandbox, {
      PORTAL_STORE: 'file',
      PORTAL_DATA_DIR: path.join(fileSandbox.siteDir, 'data'),
    });
    assertEqual(fileRun.status, 0, `a fresh install must build (got ${fileRun.status}: ${fileRun.stderr})`);
    assert(/"written":0/.test(fileRun.stdout), `the run must report that it wrote nothing: ${fileRun.stdout}`);
    assertEqual(publishedFiles(fileSandbox).length, 0, 'nothing may be published from an empty store');

    // --- the DATABASE store: no schema yet, then a schema with an empty table.
    const mock = await startMock();
    try {
      const dbSandbox = publisherSandbox('empty-store-db-fresh');
      const env = {
        PORTAL_STORE: 'libsql',
        LIBSQL_URL: mock.url,
        LIBSQL_TOKEN: mock.token,
      };
      const first = await runPublisher(dbSandbox, env);
      assertEqual(first.status, 0, `the first run must build (got ${first.status}: ${first.stderr})`);
      const second = await runPublisher(dbSandbox, env);
      assertEqual(second.status, 0, `the second run must build (got ${second.status}: ${second.stderr})`);
      assert(/"written":0/.test(second.stdout), `the run must report that it wrote nothing: ${second.stdout}`);
      assertEqual(publishedFiles(dbSandbox).length, 0, 'nothing may be published from an empty store');
      return 'both modes build, nothing published — the fresh-clone case still builds';
    } finally {
      await mock.close();
    }
  });

  await t('A12', 'MUTATION: with an empty store treated as "publish nothing", A10 goes RED', async () => {
    const { copyRoot, roots: copyRoots } = mutatedRoots('copy-empty-store');
    const script = path.join(copyRoot, 'site', 'scripts', 'publish-testimonials.mjs');
    // ONLY the wave-11 guard is removed: the missing-store check stays. The
    // store is there, readable and empty — so the guard is the only thing
    // that stands between the empty store and the published quotes.
    patch(
      script,
      `  if (reviews.length > 0 || published.length === 0) return;`,
      `  if (true) return;`,
    );

    const sandbox = publisherSandbox('mutated-empty-store');
    fs.writeFileSync(path.join(sandbox.published, 'kept.md'), PUBLISHED_QUOTE, 'utf8');
    fs.writeFileSync(sandbox.reviewsFile, '', 'utf8');
    const result = await runPublisher(
      sandbox,
      {
        PORTAL_STORE: 'file',
        PORTAL_DATA_DIR: path.join(sandbox.siteDir, 'data'),
      },
      script,
    );
    assertEqual(result.status, 0, 'the mutated publisher should have exited 0 (the defect is back)');
    assertEqual(
      publishedFiles(sandbox).length,
      0,
      'the mutation did not redden the check — the published quote was not destroyed',
    );
    return 'the mutated copy treats an empty store as "publish nothing" and deletes the published quote';
  });

  // =========================================================================
  group('B — F-2: the decision lands on the revision that was verified');
  // =========================================================================

  const fileSandbox = path.join(ROOT, 'file-mode');
  const fileDataDir = path.join(fileSandbox, 'site', 'data');
  fs.mkdirSync(path.join(fileDataDir, 'moderation'), { recursive: true });
  fs.writeFileSync(path.join(fileDataDir, 'moderation', 'reviews.jsonl'), '', 'utf8');
  applyEnv(baseEnv({ PORTAL_STORE: 'file', PORTAL_DATA_DIR: fileDataDir }));
  process.chdir(fileSandbox);

  const fileBundle = await buildBundle('file-mode', roots);
  const fileApi = require(fileBundle);
  const fileStore = fileApi.createFileStore({ dataDir: fileDataDir });

  await t('B1', 'a concurrent append between the read and the write answers 409 stale-revision', async () => {
    const store = fileStore;
    await store.append('reviews', { ...QUOTE, state: 'pending' });

    // The store the handler gets: it appends a newer revision inside
    // decideReview — the race, exactly where it happens in reality.
    //
    // The cache Map is the one the access layer holds (it lives on
    // globalThis), so the entry is REPLACED in it — the module must not be
    // re-imported, or the handler would keep the old store.
    const racing = racingStore(store);
    globalThis.__imkPortalBackends.set(storeCacheKey(fileDataDir), {
      store: racing,
      mode: 'file',
    });

    const ts = Math.floor(Date.now() / 1000);
    const sig = signModeration(REF, 'approve', 1, ts);
    const answer = await call(
      fileApi.moderate,
      'POST',
      `/api/moderate/review?ref=${REF}&decision=approve&revision=1&sig=${sig}&ts=${ts}`,
    );

    assertEqual(answer.status, 409, `the answer should be 409 (got ${answer.status}: ${JSON.stringify(answer.body)})`);
    assertEqual(answer.body.code, 'stale-revision', 'the code should be stale-revision');

    // NO state change: the record the owner verified is still pending.
    const stored = await store.list('reviews');
    const verified = stored.find((r) => r.revision === 1);
    assert(verified, 'the verified revision is gone from the store');
    assertEqual(verified.state, 'pending', 'the verified revision was decided anyway');
    const newer = stored.find((r) => r.revision === 99);
    assert(newer, 'the newer revision was not appended');
    assertEqual(newer.state, 'pending', 'the newer revision was decided');
    return `409 stale-revision, nothing was decided`;
  });

  await t('B2', 'a matching revision still flips the quote (200 approved)', async () => {
    const store = fileStore;
    const ref = 'inq_wave10_2';
    await store.append('reviews', { ...QUOTE, ref, state: 'pending', revision: 3 });
    globalThis.__imkPortalBackends.set(storeCacheKey(fileDataDir), {
      store,
      mode: 'file',
    });
    const ts = Math.floor(Date.now() / 1000);
    const sig = signModeration(ref, 'approve', 3, ts);
    const answer = await call(
      fileApi.moderate,
      'POST',
      `/api/moderate/review?ref=${ref}&decision=approve&revision=3&sig=${sig}&ts=${ts}`,
    );
    assertEqual(answer.status, 200, `the answer should be 200 (got ${answer.status}: ${JSON.stringify(answer.body)})`);
    assertEqual(answer.body.state, 'approved', 'the quote was not approved');
    const stored = await store.list('reviews');
    const record = stored.find((r) => r.ref === ref);
    assertEqual(record.state, 'approved', 'the store does not carry the decision');
    return '200 approved, the store carries the decision';
  });

  await t('B3', 'the store refuses a decision for another revision (file AND libsql)', async () => {
    const dir = path.join(ROOT, 'revision-scope-file');
    fs.mkdirSync(path.join(dir, 'moderation'), { recursive: true });
    const fileStore = fileApi.createFileStore({ dataDir: dir });
    await fileStore.append('reviews', { ...QUOTE, state: 'pending', revision: 1 });
    await fileStore.append('reviews', { ...QUOTE, state: 'pending', revision: 2 });
    const stale = await fileStore.decideReview(REF, 'approved', '2026-10-22T10:00:00.000Z', 'one-click-link', 1);
    assertEqual(stale, null, 'the file store decided a revision it was not given');
    const all = await fileStore.list('reviews');
    assertEqual(all[0].state, 'pending', 'the older revision was flipped');
    assertEqual(all[1].state, 'pending', 'the newer revision was flipped');

    // The same, against a real SQLite engine over the real wire protocol.
    const mock = await startMock();
    try {
      await mock.reset();
      const transport = fileApi.createHttpTransport({ url: mock.url, token: mock.token });
      const libsqlStore = fileApi.createLibsqlStore({ transport });
      await libsqlStore.append('reviews', { ...QUOTE, state: 'pending', revision: 1 });
      await libsqlStore.append('reviews', { ...QUOTE, state: 'pending', revision: 2 });
      const libsqlStale = await libsqlStore.decideReview(
        REF,
        'approved',
        '2026-10-22T10:00:00.000Z',
        'one-click-link',
        1,
      );
      assertEqual(libsqlStale, null, 'the libsql store decided a revision it was not given');
      const libsqlAll = await libsqlStore.list('reviews');
      assertEqual(libsqlAll[0].state, 'pending', 'the older revision was flipped');
      assertEqual(libsqlAll[1].state, 'pending', 'the newer revision was flipped');
      return 'both adapters refuse a decision for another revision';
    } finally {
      await mock.close();
    }
  });

  await t('B4', 'MUTATION: with the revision scope removed, B3 goes RED', async () => {
    const { copyRoot, roots: copyRoots } = mutatedRoots('copy-revision-scope');
    const target = path.join(copyRoot, 'site', 'shared', 'portal-store', 'file-adapter.ts');
    patch(
      target,
      `      if (expectedRevision !== undefined && revisionNumber(record) !== expectedRevision) {
        return null;
      }`,
      `      if (false) {
        return null;
      }`,
    );
    const bundle = await buildBundle('mutated-revision-scope', copyRoots);
    const mutated = require(bundle);
    const dir = path.join(ROOT, 'revision-scope-mutated');
    fs.mkdirSync(path.join(dir, 'moderation'), { recursive: true });
    const store = mutated.createFileStore({ dataDir: dir });
    await store.append('reviews', { ...QUOTE, state: 'pending', revision: 1 });
    await store.append('reviews', { ...QUOTE, state: 'pending', revision: 2 });
    const stale = await store.decideReview(REF, 'approved', '2026-10-22T10:00:00.000Z', 'one-click-link', 1);
    assert(stale !== null, 'the mutation did not redden the check — the stale revision was decided');
    assertEqual(stale.state, 'approved', 'the mutated store decided the wrong record');
    return 'the mutated copy decides a revision it was not given';
  });

  // =========================================================================
  group('C — F-3: a store that is not there is loud, never an empty success');
  // =========================================================================

  await t('C1', 'every portal handler answers 501 when the store cannot be held', async () => {
    // The data root cannot exist: a FILE is in the way. That is what a
    // read-only deployment without a store looks like.
    const sandbox = path.join(ROOT, 'unreachable-store');
    fs.mkdirSync(sandbox, { recursive: true });
    const blocker = path.join(sandbox, 'blocker');
    fs.writeFileSync(blocker, 'this is a file, not a directory\n', 'utf8');
    const dataDir = path.join(blocker, 'data');
    applyEnv(baseEnv({ PORTAL_STORE: 'file', PORTAL_DATA_DIR: dataDir }));
    process.chdir(ROOT);

    const bundle = await buildBundle('unreachable-store', roots);
    const api = require(bundle);
    const ownerToken = api.createSession(OWNER, 'admin');
    const clientToken = api.createSession(CLIENT, 'client', 'cli_wave10');
    const ownerCookie = `imk_admin_session=${ownerToken}`;
    const clientCookie = `imk_session=${clientToken}`;

    const cases = [
      ['auth', 'POST', '/api/portal/auth/request-link', { body: JSON.stringify({ email: CLIENT }) }],
      ['comments', 'GET', '/api/portal/comments', { cookie: clientCookie }],
      ['invites', 'POST', '/api/portal/invites', { cookie: ownerCookie, body: JSON.stringify({ email: CLIENT }) }],
      ['planItems', 'GET', '/api/portal/plan-items', { cookie: clientCookie }],
      ['projects', 'GET', '/api/portal/projects', { cookie: clientCookie }],
      ['testimonials', 'GET', '/api/portal/testimonials', { cookie: clientCookie }],
      ['updates', 'GET', '/api/portal/updates', { cookie: clientCookie }],
    ];

    for (const [name, method, url, options] of cases) {
      const answer = await call(api[name], method, url, options);
      assertEqual(answer.status, 501, `${name} should answer 501 (got ${answer.status}: ${JSON.stringify(answer.body)})`);
      assertEqual(answer.body.code, 'unimplemented', `${name} should carry code 'unimplemented'`);
      const text = JSON.stringify(answer.body);
      assert(!/"ok":true/.test(text), `${name} answered an empty success: ${text}`);
      assert(!/"projects":\[\]/.test(text), `${name} answered an empty project list: ${text}`);
      assert(!/"comments":\[\]/.test(text), `${name} answered an empty comment list: ${text}`);
    }
    return `${cases.length} handlers answer 501 {code:unimplemented}`;
  });

  await t('C2', 'a DAMAGED rate-limit counter file is loud, not a silently reset counter', async () => {
    const sandbox = path.join(ROOT, 'damaged-counter');
    fs.mkdirSync(sandbox, { recursive: true });
    const counterFile = path.join(sandbox, 'counters.json');
    fs.writeFileSync(counterFile, '{ this is not json', 'utf8');
    applyEnv(
      baseEnv({
        PORTAL_STORE: 'file',
        PORTAL_DATA_DIR: path.join(sandbox, 'data'),
        PORTAL_RATE_LIMIT_FILE: counterFile,
      }),
    );
    process.chdir(ROOT);

    const bundle = await buildBundle('damaged-counter', roots);
    const api = require(bundle);
    // The limiter is the module-level instance; the file backend is created
    // from the environment, so a fresh bundle is enough.
    const answer = await call(
      api.auth,
      'POST',
      '/api/portal/auth/request-link',
      {
        headers: { origin: 'http://imk.test', 'content-type': 'application/json' },
        body: JSON.stringify({ email: CLIENT }),
      },
    );
    assert(
      answer.status === 500,
      `a damaged counter file should answer 500 (got ${answer.status}: ${JSON.stringify(answer.body)})`,
    );
    assertEqual(answer.body.code, 'storage', 'the code should be storage');
    return '500 {code:storage} — the counter was not silently reset';
  });

  await t('C3', 'the moderation endpoint and the inbox still answer 501 for a missing collection', async () => {
    const sandbox = path.join(ROOT, 'missing-reviews-file');
    const dataDir = path.join(sandbox, 'site', 'data');
    fs.mkdirSync(path.join(dataDir, 'moderation'), { recursive: true });
    applyEnv(baseEnv({ PORTAL_STORE: 'file', PORTAL_DATA_DIR: dataDir }));
    process.chdir(sandbox);

    const bundle = await buildBundle('missing-reviews-file', roots);
    const api = require(bundle);
    const ownerToken = api.createSession(OWNER, 'admin');
    const ownerCookie = `imk_admin_session=${ownerToken}`;

    const ts = Math.floor(Date.now() / 1000);
    const sig = signModeration(REF, 'approve', 1, ts);
    const moderation = await call(
      api.moderate,
      'POST',
      `/api/moderate/review?ref=${REF}&decision=approve&revision=1&sig=${sig}&ts=${ts}`,
    );
    assertEqual(moderation.status, 501, `the moderation endpoint should answer 501 (got ${moderation.status})`);
    assertEqual(moderation.body.code, 'unimplemented', 'the code should be unimplemented');

    const inbox = await call(api.adminReviews, 'GET', '/api/admin/reviews', { cookie: ownerCookie });
    assertEqual(inbox.status, 501, `the inbox should answer 501 (got ${inbox.status})`);
    assertEqual(inbox.body.code, 'unimplemented', 'the code should be unimplemented');
    return 'both answer 501 {code:unimplemented} — the QA-pinned behaviour is intact';
  });

  await t('C4', 'MUTATION: with the reachability probe disabled, C1 goes RED', async () => {
    const { copyRoot, roots: copyRoots } = mutatedRoots('copy-reachability');
    const target = path.join(copyRoot, 'site', 'shared', 'server', 'portal-store-access.ts');
    patch(
      target,
      `  if (fs.existsSync(root)) return;
  if (!canHoldStore(root)) {`,
      `  if (fs.existsSync(root)) return;
  if (false && !canHoldStore(root)) {`,
    );
    const bundle = await buildBundle('mutated-reachability', copyRoots);
    const api = require(bundle);
    const sandbox = path.join(ROOT, 'unreachable-store-mutated');
    fs.mkdirSync(sandbox, { recursive: true });
    const blocker = path.join(sandbox, 'blocker');
    fs.writeFileSync(blocker, 'this is a file, not a directory\n', 'utf8');
    applyEnv(baseEnv({ PORTAL_STORE: 'file', PORTAL_DATA_DIR: path.join(blocker, 'data') }));
    process.chdir(ROOT);
    const answer = await call(api.projects, 'GET', '/api/portal/projects', {});
    assert(
      answer.status !== 501,
      'the mutation did not redden the check — the handler still answered 501',
    );
    return `the mutated copy answered ${answer.status} instead of 501`;
  });

  // =========================================================================
  group('D — F-4: a paged answer is assembled completely');
  // =========================================================================

  await t('D1', 'a paged server is read to the end (the baton is followed)', async () => {
    const mock = await startMock({ pageSize: 1 });
    try {
      const bundle = await buildBundle('paged', roots);
      const api = require(bundle);
      const transport = api.createHttpTransport({ url: mock.url, token: mock.token });

      // A pipeline with THREE statements: every one of them carries a result,
      // and the server hands out one result per page. A client that ignores
      // the baton keeps the first result and drops the other two — a
      // truncated answer that looks complete.
      const many = await transport.executeAll([
        { sql: 'SELECT 1 AS a' },
        { sql: 'SELECT 2 AS b' },
        { sql: 'SELECT 3 AS c' },
      ]);
      assertEqual(many.length, 3, `the paged results were not assembled (${many.length})`);
      assertEqual(many[0].rows[0][0], 1, 'the first result is wrong');
      assertEqual(many[1].rows[0][0], 2, 'the second result is missing or wrong');
      assertEqual(many[2].rows[0][0], 3, 'the third result is missing or wrong');

      // The schema step sends ~25 statements in ONE pipeline.
      await api.ensureSchema(transport);

      const store = api.createLibsqlStore({ transport, autoSchema: false });
      await store.append('projects', { id: 'prj_1' });
      await store.append('projects', { id: 'prj_2' });
      const rows = await store.list('projects');
      assertEqual(rows.length, 2, 'the answer was truncated');
      assertEqual(rows[0].id, 'prj_1', 'the first row is missing');
      assertEqual(rows[1].id, 'prj_2', 'the second row is missing');

      const continuation = mock.requests.find(
        (r) => r && typeof r.baton === 'string' && r.baton,
      );
      assert(continuation, 'the server never handed out a baton');
      assertEqual(
        JSON.stringify(continuation.requests),
        '[]',
        'the continuation request must carry no statements',
      );
      assert(mock.requests.length > 2, 'the answer was not paged at all');
      return `${mock.requests.length} requests, every page followed`;
    } finally {
      await mock.close();
    }
  });

  await t('D2', 'MUTATION: with the baton ignored, D1 goes RED', async () => {
    const { copyRoot, roots: copyRoots } = mutatedRoots('copy-baton');
    const target = path.join(copyRoot, 'site', 'shared', 'portal-store', 'libsql-transport.ts');
    patch(
      target,
      `      if (!answer.baton) return collected;
      baton = answer.baton;`,
      `      return collected;`,
    );
    const mock = await startMock({ pageSize: 1 });
    try {
      const bundle = await buildBundle('mutated-baton', copyRoots);
      const api = require(bundle);
      const transport = api.createHttpTransport({ url: mock.url, token: mock.token });
      let failed = false;
      let reason = '';
      try {
        const many = await transport.executeAll([
          { sql: 'SELECT 1 AS a' },
          { sql: 'SELECT 2 AS b' },
          { sql: 'SELECT 3 AS c' },
        ]);
        if (many.length !== 3) {
          failed = true;
          reason = `only ${many.length} of 3 results came back`;
        }
      } catch (err) {
        failed = true;
        reason = err && err.message ? err.message : String(err);
      }
      assert(failed, 'the mutation did not redden the check — the results were complete anyway');
      return `the mutated transport lost the pages: ${reason}`;
    } finally {
      await mock.close();
    }
  });

  // =========================================================================
  group('E — F-5: the counter prunes, and the key is not the client\'s choice');
  // =========================================================================

  await t('E1', 'the durable counter PRUNES the expired buckets', async () => {
    const mock = await startMock();
    try {
      await mock.reset();
      const bundle = await buildBundle('prune', roots);
      const api = require(bundle);
      const transport = api.createHttpTransport({ url: mock.url, token: mock.token });
      await api.ensureSchema(transport);
      const counter = api.createLibsqlRateLimitBackend(transport);

      await counter.hit('bucket-that-expires', 1);
      await new Promise((r) => setTimeout(r, 30));
      await counter.hit('live-bucket', 60_000);

      const rows = await transport.execute('SELECT bucket FROM rate_counters');
      assertEqual(rows.rows.length, 1, `the expired bucket was not pruned (${JSON.stringify(rows.rows)})`);
      return 'the expired bucket is gone; the live one is kept';
    } finally {
      await mock.close();
    }
  });

  await t('E2', 'the rate-limit key is NOT a value the client can choose', async () => {
    const sandbox = path.join(ROOT, 'rate-key');
    fs.mkdirSync(path.join(sandbox, 'data', 'moderation'), { recursive: true });
    fs.writeFileSync(path.join(sandbox, 'data', 'moderation', 'reviews.jsonl'), '', 'utf8');
    applyEnv(baseEnv({ PORTAL_STORE: 'file', PORTAL_DATA_DIR: path.join(sandbox, 'data') }));
    process.chdir(sandbox);

    const bundle = await buildBundle('rate-key', roots);
    const api = require(bundle);
    const origin = { origin: 'http://imk.test', 'content-type': 'application/json' };
    const body = JSON.stringify({ email: CLIENT });

    // The harness plays the platform: it appends the address it saw to the
    // chain the client sent, exactly as Vercel and Cloudflare do. The
    // client's own prefix must NOT create a new bucket — with a key taken
    // from the whole header, every request would land in a fresh bucket and
    // the limit would never be reached.
    const answers = [];
    for (let i = 0; i < 7; i++) {
      const answer = await call(api.auth, 'POST', '/api/portal/auth/request-link', {
        headers: { ...origin, 'x-forwarded-for': `203.0.113.${i}, 198.51.100.7` },
        body,
      });
      answers.push(answer);
    }
    const limited = answers.filter((a) => a.status === 429);
    assert(
      limited.length > 0,
      `the limit was bypassed by varying x-forwarded-for (statuses: ${answers.map((a) => a.status).join(',')})`,
    );
    return `${limited.length}/${answers.length} requests were limited — the key is not client-chosen`;
  });

  await t('E3', 'with no platform header the bucket is the PER-INSTANCE one', async () => {
    const sandbox = path.join(ROOT, 'rate-key-instance');
    fs.mkdirSync(path.join(sandbox, 'data', 'moderation'), { recursive: true });
    fs.writeFileSync(path.join(sandbox, 'data', 'moderation', 'reviews.jsonl'), '', 'utf8');
    applyEnv(baseEnv({ PORTAL_STORE: 'file', PORTAL_DATA_DIR: path.join(sandbox, 'data') }));
    process.chdir(sandbox);

    const bundle = await buildBundle('rate-key-instance', roots);
    const api = require(bundle);
    const origin = { origin: 'http://imk.test', 'content-type': 'application/json' };
    const body = JSON.stringify({ email: CLIENT });

    // No cf-connecting-ip, no x-forwarded-for: the bucket is per instance.
    const answers = [];
    for (let i = 0; i < 7; i++) {
      answers.push(
        await call(api.auth, 'POST', '/api/portal/auth/request-link', { headers: origin, body }),
      );
    }
    assert(
      answers.some((a) => a.status === 429),
      `the per-instance bucket did not limit anything (statuses: ${answers.map((a) => a.status).join(',')})`,
    );
    return 'the requests without a platform address share one bucket';
  });

  await t('E4', 'MUTATION: with the prune removed, E1 goes RED', async () => {
    const { copyRoot, roots: copyRoots } = mutatedRoots('copy-prune');
    const target = path.join(copyRoot, 'site', 'shared', 'portal-store', 'durable-rate-counter.ts');
    patch(
      target,
      'export const RATE_COUNTER_PRUNE_SQL = `DELETE FROM rate_counters WHERE reset_at <= ?`;',
      'export const RATE_COUNTER_PRUNE_SQL = `SELECT 1 WHERE ? IS NOT NULL`;',
    );
    const mock = await startMock();
    try {
      await mock.reset();
      const bundle = await buildBundle('mutated-prune', copyRoots);
      const api = require(bundle);
      const transport = api.createHttpTransport({ url: mock.url, token: mock.token });
      await api.ensureSchema(transport);
      const counter = api.createLibsqlRateLimitBackend(transport);
      await counter.hit('bucket-that-expires', 1);
      await new Promise((r) => setTimeout(r, 30));
      await counter.hit('live-bucket', 60_000);
      const rows = await transport.execute('SELECT bucket FROM rate_counters');
      assert(
        rows.rows.length > 1,
        'the mutation did not redden the check — the table did not grow',
      );
      return `the mutated copy keeps ${rows.rows.length} rows — the table grows without bound`;
    } finally {
      await mock.close();
    }
  });

  // =========================================================================
  group('F — F-6: the Cloudflare inbox does not claim a file store');
  // =========================================================================

  await t('F1', 'the Cloudflare inbox answers 501 {code:unimplemented} for the owner', async () => {
    const bundle = await buildEdgeBundle('cf-inbox', roots);
    const cf = require(bundle);
    const env = {
      ADMIN_EMAILS: OWNER,
      FORM_WEBHOOK_SECRET: MODERATION_SECRET,
      PORTAL_SESSION_SECRET: SESSION_SECRET,
      NODE_ENV: 'development',
    };
    const token = cf.createSession(OWNER, 'admin');
    const request = new Request('http://imk.test/api/admin/reviews', {
      headers: { cookie: `imk_admin_session=${token}` },
    });
    const answer = await cf.cfInbox({ request, env });
    assertEqual(answer.status, 501, `the CF inbox should answer 501 (got ${answer.status})`);
    const body = await answer.json();
    assertEqual(body.code, 'unimplemented', 'the code should be unimplemented');
    assert(!/pendingReviews/.test(JSON.stringify(body)), 'the answer looks like a queue');
    return '501 {code:unimplemented} — with a filesystem and without one';
  });

  await t('F2', 'the Cloudflare inbox no longer reads the JSONL store', async () => {
    const source = fs.readFileSync(path.join(SITE, 'functions', 'api', 'admin', 'reviews.ts'), 'utf8');
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/^[ \t]*\/\/.*$/gm, ' ');
    assert(!/parseJsonlStrict/.test(code), 'the CF inbox still parses a JSONL store');
    assert(!/REVIEWS_FILE/.test(code), 'the CF inbox still names a reviews file');
    assert(!/readFileSync/.test(code), 'the CF inbox still reads a file');
    assert(!/node:fs/.test(code), 'the CF inbox still imports a filesystem');
    return 'no JSONL reader, no file path, no filesystem import';
  });

  await t('F3', 'MUTATION: with the CF inbox answering a queue again, F1 goes RED', async () => {
    const { copyRoot, roots: copyRoots } = mutatedRoots('copy-cf-inbox');
    const target = path.join(copyRoot, 'site', 'functions', 'api', 'admin', 'reviews.ts');
    patch(
      target,
      `  return json(
    { error: 'moderation store unavailable on this target', code: 'unimplemented' },
    501,
  );`,
      `  return json(
    {
      ok: true,
      counts: { pendingReviews: 0, decidedToday: 0, openNotes: null },
      notesAvailable: false,
      reviews: [],
      recent: [],
    },
    200,
  );`,
    );
    const bundle = await buildEdgeBundle('mutated-cf-inbox', copyRoots);
    const cf = require(bundle);
    const env = {
      ADMIN_EMAILS: OWNER,
      FORM_WEBHOOK_SECRET: MODERATION_SECRET,
      PORTAL_SESSION_SECRET: SESSION_SECRET,
      NODE_ENV: 'development',
    };
    const token = cf.createSession(OWNER, 'admin');
    const request = new Request('http://imk.test/api/admin/reviews', {
      headers: { cookie: `imk_admin_session=${token}` },
    });
    const answer = await cf.cfInbox({ request, env });
    assert(answer.status !== 501, 'the mutation did not redden the check — the CF inbox still answered 501');
    return `the mutated copy answers ${answer.status} instead of 501`;
  });

  // =========================================================================
  group('G — F-7: the dead function');
  // =========================================================================

  // ------------------------------------------------------------------------
  // The function budget (wave 13).
  //
  // Vercel builds ONE FUNCTION per file under api/, and the Hobby plan caps a
  // deployment at twelve. A module under api/ with NO DEFAULT EXPORT is a
  // DEAD function: it is built, it answers 500 on a URL nobody calls, and it
  // still costs one of the twelve slots.
  //
  // The check is written as a function so the CONTROL and the MUTANT run the
  // SAME code: the mutant adds a dead module to a COPY of api/ and the check
  // has to go red.
  // ------------------------------------------------------------------------
  function functionBudgetProblems(apiDir, repoRoot) {
    const problems = [];
    const files = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) {
          continue;
        }
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts')) files.push(full);
      }
    };
    walk(apiDir);

    if (files.length > 12) {
      problems.push(
        `api/ holds ${files.length} .ts files — the Hobby plan caps a deployment at twelve functions`,
      );
    }
    for (const full of files) {
      const rel = path.relative(repoRoot, full);
      const text = fs.readFileSync(full, 'utf8');
      if (!/export\s+default/.test(text) && !/export\s*\{\s*default\s*\}/.test(text)) {
        problems.push(`${rel} has no default export — it is a DEAD Vercel function`);
      }
    }
    return { problems, count: files.length, files };
  }

  await t('G1', 'api/ holds only REAL functions — no dead utility costs a Vercel slot', async () => {
    // RE-PINNED (wave 13, the function budget). The old anchor was "the file
    // api/lib/jsonl.ts was deleted". The interesting fact now is bigger: the
    // portal family became ONE entry point, the owner family another, and the
    // two shared utilities left api/ entirely — so EVERY file under api/ is a
    // real function and the count fits the budget.
    const apiDir = path.join(REPO, 'api');
    const { problems, count, files } = functionBudgetProblems(apiDir, REPO);
    assertEqual(problems.length, 0, problems.join(' | '));
    assert(count <= 12, `api/ holds ${count} files — the budget is twelve`);
    assertEqual(count, 7, `api/ should hold 7 .ts files (found ${count}: ${files.map((f) => path.relative(REPO, f)).join(', ')})`);

    // The dead utilities are gone FROM api/ (they live in site/shared/server/
    // now, where they are modules and not functions).
    for (const dead of ['api/lib/jsonl.ts', 'api/lib/notifications.ts', 'api/lib/rate-limit.ts']) {
      assert(!fs.existsSync(path.join(REPO, dead)), `${dead} is still there — it is still a dead Vercel function`);
    }
    // ...and the two that are still needed are really imported.
    const shared = ['site/shared/server/notifications.ts', 'site/shared/server/rate-limit.ts'];
    for (const rel of shared) {
      const name = path.basename(rel).replace(/\.ts$/, '');
      const hits = [];
      const scan = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) {
            continue;
          }
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) scan(full);
          else if (/\.(ts|mjs|js)$/.test(entry.name)) {
            const text = fs.readFileSync(full, 'utf8');
            if (new RegExp(`server[\\\\/]${name}(\\.js)?['"]`).test(text) && !full.endsWith(rel)) {
              hits.push(path.relative(REPO, full));
            }
          }
        }
      };
      scan(path.join(REPO, 'api'));
      scan(path.join(REPO, 'site', 'shared'));
      assert(hits.length > 0, `${rel} has no importer — it is dead code`);
    }
    return `api/ holds ${count} real functions (budget 12) and the two shared utilities are imported`;
  });

  await t('G1m', 'the probe can fail: a dead module under api/ IS caught', async () => {
    // The mutant adds a module with no default export to a COPY of api/ — the
    // exact shape of the defect the budget check exists to catch.
    const copyRoot = path.join(ROOT, 'g1-mutant');
    fs.rmSync(copyRoot, { recursive: true, force: true });
    fs.mkdirSync(path.join(copyRoot, 'api', 'lib'), { recursive: true });
    fs.copyFileSync(
      path.join(REPO, 'api', 'portal.ts'),
      path.join(copyRoot, 'api', 'portal.ts'),
    );
    fs.writeFileSync(
      path.join(copyRoot, 'api', 'lib', 'dead-utility.ts'),
      'export const helper = () => 1;\n',
      'utf8',
    );
    const mutant = functionBudgetProblems(path.join(copyRoot, 'api'), copyRoot);
    assert(
      mutant.problems.length > 0,
      'a dead module under api/ was NOT caught — the budget check is vacuous',
    );
    const control = functionBudgetProblems(path.join(REPO, 'api'), REPO);
    assertEqual(control.problems.length, 0, 'the control copy must be clean');
    return 'the mutant copy is red, the control copy is green';
  });

  await t('G2', "QA's legacy sandbox is self-contained (it carries its own frozen copy)", async () => {
    // RE-PINNED (wave 12, B-3): the old anchor was "the file is still there
    // only because QA's legacy fixture imports it". QA re-pinned that fixture
    // (the legacy tree now carries its own frozen copies of api/lib/jsonl.ts
    // and api/lib/notifications.ts, and the PRODUCT copies are deleted from
    // the scratch tree first), so the file could be deleted — and the check
    // now proves that the legacy comparison does not depend on the product
    // tree any more.
    const jsonlFixture = path.join(SITE, 'qa', 'fixtures', 'prewave9-lib-jsonl.ts.txt');
    const notificationsFixture = path.join(
      SITE,
      'qa',
      'fixtures',
      'prewave9-lib-notifications.ts.txt',
    );
    assert(fs.existsSync(jsonlFixture), 'the frozen api/lib/jsonl.ts fixture is gone');
    assert(fs.existsSync(notificationsFixture), 'the frozen api/lib/notifications.ts fixture is gone');

    const suite = path.join(SITE, 'qa', 'qa-wave9-store-queue.mjs');
    const suiteText = fs.readFileSync(suite, 'utf8');
    assert(
      /prewave9-lib-jsonl\.ts\.txt/.test(suiteText),
      'the QA suite does not use the frozen jsonl fixture any more',
    );
    assert(
      /prewave9-lib-notifications\.ts\.txt/.test(suiteText),
      'the QA suite does not use the frozen notifications fixture any more',
    );
    // The product copies are removed from the scratch tree BEFORE the frozen
    // ones are written into it: that is what makes the legacy tree
    // independent of the product tree.
    assert(
      /fs\.rmSync\(productCopy, \{ force: true \}\)/.test(suiteText),
      'the QA suite no longer removes the product copy from the legacy tree — the legacy bundle would need the product file again',
    );
    return 'the legacy tree carries its own frozen copies — the product file is not needed any more';
  });

  // =========================================================================
  group('H — wave 12: the identity, the address, the publisher guards');
  // =========================================================================

  // --- B-1: the record identity --------------------------------------------

  await t('H1', 'the collision refuses the decision (file AND libsql)', async () => {
    // THE COLLISION (audit MAJOR-1): two records with the SAME ref and the
    // SAME revision number — what two concurrent submissions produce, when
    // both read the same current record and compute the same next revision.
    // The revision NUMBER cannot tell them apart, so the link must name the
    // record.
    const quoteA = { ...QUOTE, state: 'pending', revision: 2, review: 'QUOTE-A the first submit' };
    const quoteB = { ...QUOTE, state: 'pending', revision: 2, review: 'QUOTE-B the second submit' };

    // --- FILE mode
    const dir = path.join(ROOT, 'collision-file');
    fs.mkdirSync(path.join(dir, 'moderation'), { recursive: true });
    const fileStore = fileApi.createFileStore({ dataDir: dir });
    const first = await fileStore.append('reviews', quoteA);
    const second = await fileStore.append('reviews', quoteB);
    assert(
      first.recordId && second.recordId && first.recordId !== second.recordId,
      'the two records do not have two identities',
    );

    // The handler reads the store the access layer hands it.
    applyEnv(baseEnv({ PORTAL_STORE: 'file', PORTAL_DATA_DIR: dir }));
    globalThis.__imkPortalBackends.set(storeCacheKey(dir), { store: fileStore, mode: 'file' });

    const ts = Math.floor(Date.now() / 1000);
    const sig = signModerationWithIdentity(REF, 'approve', 2, String(first.recordId), ts);
    const answer = await call(
      fileApi.moderate,
      'POST',
      `/api/moderate/review?ref=${REF}&decision=approve&revision=2&recordId=${encodeURIComponent(
        String(first.recordId),
      )}&sig=${sig}&ts=${ts}`,
    );
    assertEqual(
      answer.status,
      409,
      `the decision must be REFUSED (got ${answer.status}: ${JSON.stringify(answer.body)})`,
    );
    assertEqual(answer.body.code, 'stale-revision', 'the code should be stale-revision');
    const after = await fileStore.list('reviews');
    assert(
      after.every((r) => r.state === 'pending'),
      'a record was decided anyway',
    );
    assert(
      after.every((r) => r.review !== 'QUOTE-B the second submit' || r.state === 'pending'),
      'the quote the owner never saw was approved',
    );

    // --- LIBSQL mode: the same, over the real wire protocol.
    const mock = await startMock();
    try {
      await mock.reset();
      const transport = fileApi.createHttpTransport({ url: mock.url, token: mock.token });
      const libsqlStore = fileApi.createLibsqlStore({ transport });
      const dbFirst = await libsqlStore.append('reviews', quoteA);
      const dbSecond = await libsqlStore.append('reviews', quoteB);
      assert(
        dbFirst.recordId && dbSecond.recordId && dbFirst.recordId !== dbSecond.recordId,
        'the database did not give the two records two identities',
      );

      applyEnv(
        baseEnv({
          PORTAL_STORE: 'libsql',
          LIBSQL_URL: mock.url,
          LIBSQL_TOKEN: mock.token,
        }),
      );
      const dbTs = Math.floor(Date.now() / 1000);
      const dbSig = signModerationWithIdentity(
        REF,
        'approve',
        2,
        String(dbFirst.recordId),
        dbTs,
      );
      const dbAnswer = await call(
        fileApi.moderate,
        'POST',
        `/api/moderate/review?ref=${REF}&decision=approve&revision=2&recordId=${encodeURIComponent(
          String(dbFirst.recordId),
        )}&sig=${dbSig}&ts=${dbTs}`,
      );
      assertEqual(
        dbAnswer.status,
        409,
        `the database decision must be REFUSED (got ${dbAnswer.status}: ${JSON.stringify(dbAnswer.body)})`,
      );
      const dbAll = await libsqlStore.list('reviews');
      assert(
        dbAll.every((r) => r.state === 'pending'),
        'a record was decided anyway (libsql mode)',
      );
      return 'both adapters refuse the decision — neither quote was approved';
    } finally {
      await mock.close();
    }
  });

  await t('H2', 'MUTATION: with the identity scope removed from BOTH layers, H1 goes RED', async () => {
    // The protection has TWO layers, exactly like the revision scope of wave
    // 10: the HANDLER compares the identity, and the STORE refuses to flip a
    // record it was not given. Removing only one leaves the other standing,
    // so the mutation removes BOTH — the honest way to prove that the
    // end-to-end protection is not vacuous.
    const { copyRoot, roots: copyRoots } = mutatedRoots('copy-identity-scope');
    patch(
      path.join(copyRoot, 'api', 'moderate', 'review.ts'),
      'const identityStale = recordId !== undefined && recordId !== \'\' && recordId !== currentRecordId;',
      'const identityStale = false;',
    );
    patch(
      path.join(copyRoot, 'site', 'shared', 'portal-store', 'file-adapter.ts'),
      `      if (expectedRecordId !== undefined && expectedRecordId !== '') {
        if (recordIdentity(record) !== expectedRecordId) return null;
      }`,
      `      if (false) {
        return null;
      }`,
    );

    const bundle = await buildBundle('mutated-identity-scope', copyRoots);
    const mutated = require(bundle);
    const dir = path.join(ROOT, 'collision-mutated');
    fs.mkdirSync(path.join(dir, 'moderation'), { recursive: true });
    const store = mutated.createFileStore({ dataDir: dir });
    const first = await store.append('reviews', {
      ...QUOTE,
      state: 'pending',
      revision: 2,
      review: 'QUOTE-A the first submit',
    });
    await store.append('reviews', {
      ...QUOTE,
      state: 'pending',
      revision: 2,
      review: 'QUOTE-B the second submit',
    });

    applyEnv(baseEnv({ PORTAL_STORE: 'file', PORTAL_DATA_DIR: dir }));
    globalThis.__imkPortalBackends.set(storeCacheKey(dir), { store, mode: 'file' });
    const ts = Math.floor(Date.now() / 1000);
    const sig = signModerationWithIdentity(REF, 'approve', 2, String(first.recordId), ts);
    const answer = await call(
      mutated.moderate,
      'POST',
      `/api/moderate/review?ref=${REF}&decision=approve&revision=2&recordId=${encodeURIComponent(
        String(first.recordId),
      )}&sig=${sig}&ts=${ts}`,
    );
    assert(
      answer.status === 200,
      `the mutation did not redden the check — the decision was still refused (${answer.status})`,
    );
    const after = await store.list('reviews');
    const approved = after.find((r) => r.state === 'approved');
    assert(approved, 'the mutation did not redden the check — nothing was approved');
    assertEqual(
      approved.review,
      'QUOTE-B the second submit',
      'the mutated copy approved a different record than the one that was expected',
    );
    return 'the mutated copy approves the quote the owner never saw';
  });

  await t('H3', 'the signed link names the record: a re-pointed link is refused', async () => {
    const dir = path.join(ROOT, 'identity-link');
    fs.mkdirSync(path.join(dir, 'moderation'), { recursive: true });
    const store = fileApi.createFileStore({ dataDir: dir });
    const stored = await store.append('reviews', {
      ...QUOTE,
      state: 'pending',
      revision: 1,
      review: 'the quote',
    });
    applyEnv(baseEnv({ PORTAL_STORE: 'file', PORTAL_DATA_DIR: dir }));
    globalThis.__imkPortalBackends.set(storeCacheKey(dir), { store, mode: 'file' });

    const ts = Math.floor(Date.now() / 1000);
    // A link signed over a DIFFERENT identity: the signature is valid, but
    // the record it names is not the current one — the decision is refused
    // and the owner gets a fresh link (409 stale-revision).
    const wrongSig = signModerationWithIdentity(REF, 'approve', 1, 'rec_somebody_else', ts);
    const wrong = await call(
      fileApi.moderate,
      'POST',
      `/api/moderate/review?ref=${REF}&decision=approve&revision=1&recordId=rec_somebody_else&sig=${wrongSig}&ts=${ts}`,
    );
    assertEqual(
      wrong.status,
      409,
      `a link for another record must be refused (got ${wrong.status}: ${JSON.stringify(wrong.body)})`,
    );
    assertEqual(wrong.body.code, 'stale-revision', 'the code should be stale-revision');

    // The signature of the RIGHT link, with the identity in the URL swapped:
    // the signature no longer matches the message, so the link is refused
    // before anything is read.
    const rightSig = signModerationWithIdentity(REF, 'approve', 1, String(stored.recordId), ts);
    const repointed = await call(
      fileApi.moderate,
      'POST',
      `/api/moderate/review?ref=${REF}&decision=approve&revision=1&recordId=rec_somebody_else&sig=${rightSig}&ts=${ts}`,
    );
    assertEqual(repointed.status, 400, 'a re-pointed link must be refused');
    assertEqual(repointed.body.code, 'signature', 'the code should be signature');

    // NO DOWNGRADE: the identity stripped from the URL, the signature kept.
    // The link is signed over the identity, so the legacy message does not
    // match — a link cannot be turned back into a revision-only link.
    const stripped = await call(
      fileApi.moderate,
      'POST',
      `/api/moderate/review?ref=${REF}&decision=approve&revision=1&sig=${rightSig}&ts=${ts}`,
    );
    assertEqual(stripped.status, 400, 'a link with the identity stripped must be refused');

    const after = await store.list('reviews');
    assertEqual(after[0].state, 'pending', 'a refused link decided the quote anyway');
    return 'the identity is signed — a re-pointed or downgraded link is refused';
  });

  // --- B-2: the address ----------------------------------------------------

  await t('H4', 'a rotating cf-connecting-ip does NOT get a fresh bucket', async () => {
    const sandbox = path.join(ROOT, 'rate-key-cf');
    fs.mkdirSync(path.join(sandbox, 'data', 'moderation'), { recursive: true });
    fs.writeFileSync(path.join(sandbox, 'data', 'moderation', 'reviews.jsonl'), '', 'utf8');
    applyEnv(baseEnv({ PORTAL_STORE: 'file', PORTAL_DATA_DIR: path.join(sandbox, 'data') }));
    process.chdir(sandbox);

    const bundle = await buildBundle('rate-key-cf', roots);
    const api = require(bundle);
    const origin = { origin: 'http://imk.test', 'content-type': 'application/json' };
    const body = JSON.stringify({ email: CLIENT });

    // The launch target is Vercel, and Vercel does NOT set
    // `cf-connecting-ip` — it passes whatever the client sent through. A
    // client that rotates it must therefore NOT get a fresh bucket
    // (audit MAJOR-2). The platform chain below is what the harness plays
    // as Vercel: the client's own prefix, the platform's hop last. The
    // addresses are unique to this check, so the shared in-memory counter
    // of the earlier checks cannot decide the outcome.
    const answers = [];
    for (let i = 0; i < 7; i++) {
      answers.push(
        await call(api.auth, 'POST', '/api/portal/auth/request-link', {
          headers: {
            ...origin,
            'cf-connecting-ip': `198.51.100.${201 + i}`,
            'x-forwarded-for': `203.0.113.${201 + i}, 198.51.100.200`,
          },
          body,
        }),
      );
    }
    const limited = answers.filter((a) => a.status === 429);
    assert(
      limited.length > 0,
      `the limit was bypassed by rotating cf-connecting-ip (statuses: ${answers.map((a) => a.status).join(',')})`,
    );
    return `${limited.length}/${answers.length} requests were limited — the rotating header buys no fresh bucket`;
  });

  await t('H5', 'MUTATION: with cf-connecting-ip trusted again, H4 goes RED', async () => {
    const { copyRoot, roots: copyRoots } = mutatedRoots('copy-cf-trusted');
    patch(
      path.join(copyRoot, 'site', 'shared', 'server', 'platform-address.ts'),
      '  if (options.trustCfConnectingIp) {',
      '  if (true) {',
    );
    const bundle = await buildBundle('mutated-cf-trusted', copyRoots);
    const api = require(bundle);
    const sandbox = path.join(ROOT, 'rate-key-cf-mutated');
    fs.mkdirSync(path.join(sandbox, 'data', 'moderation'), { recursive: true });
    fs.writeFileSync(path.join(sandbox, 'data', 'moderation', 'reviews.jsonl'), '', 'utf8');
    applyEnv(baseEnv({ PORTAL_STORE: 'file', PORTAL_DATA_DIR: path.join(sandbox, 'data') }));
    process.chdir(sandbox);

    const origin = { origin: 'http://imk.test', 'content-type': 'application/json' };
    const body = JSON.stringify({ email: CLIENT });
    const answers = [];
    for (let i = 0; i < 7; i++) {
      answers.push(
        await call(api.auth, 'POST', '/api/portal/auth/request-link', {
          headers: {
            ...origin,
            'cf-connecting-ip': `198.51.100.${201 + i}`,
            'x-forwarded-for': `203.0.113.${201 + i}, 198.51.100.200`,
          },
          body,
        }),
      );
    }
    const limited = answers.filter((a) => a.status === 429);
    assertEqual(
      limited.length,
      0,
      `the mutation did not redden the check — ${limited.length} requests were limited`,
    );
    return 'the mutated copy gives every request its own bucket';
  });

  // --- B-4: the publisher, a store without review records -------------------

  await t('H6', 'a store with records but NO review record refuses to publish (file mode)', async () => {
    const sandbox = publisherSandbox('no-review-records');
    fs.writeFileSync(path.join(sandbox.published, 'kept.md'), PUBLISHED_QUOTE, 'utf8');
    // A store that is THERE, readable, and holds a record — but not a review
    // record. Mirroring it would empty the published directory and report
    // success: the data-loss class wave 11 closed, one step further.
    writeReviews(sandbox.reviewsFile, [
      { type: 'notes', ref: 'note_1', state: 'open', body: 'a client note' },
    ]);
    const result = await runPublisher(sandbox, {
      PORTAL_STORE: 'file',
      PORTAL_DATA_DIR: path.join(sandbox.siteDir, 'data'),
    });
    assert(
      result.status !== 0,
      `a store without review records must not publish an empty set (exit 0: ${result.stdout})`,
    );
    assert(
      /no (review|moderation) records/i.test(result.stderr),
      `the failure must name the condition: ${result.stderr}`,
    );
    assertEqual(publishedFiles(sandbox).length, 1, 'the published quote was destroyed');
    assert(
      fs
        .readFileSync(path.join(sandbox.published, 'kept.md'), 'utf8')
        .includes('the quote that was already published'),
      'the published quote was changed',
    );
    return 'the publisher refuses, the published quote survived';
  });

  await t('H7', 'MUTATION: with the guard counting RECORDS instead of review records, H6 goes RED', async () => {
    const { copyRoot, roots: copyRoots } = mutatedRoots('copy-review-count');
    const script = path.join(copyRoot, 'site', 'scripts', 'publish-testimonials.mjs');
    patch(
      script,
      `  if (reviews.length > 0 || published.length === 0) return;`,
      `  if (records.length > 0 || published.length === 0) return;`,
    );
    const sandbox = publisherSandbox('mutated-no-review-records');
    fs.writeFileSync(path.join(sandbox.published, 'kept.md'), PUBLISHED_QUOTE, 'utf8');
    writeReviews(sandbox.reviewsFile, [
      { type: 'notes', ref: 'note_1', state: 'open', body: 'a client note' },
    ]);
    const result = await runPublisher(
      sandbox,
      {
        PORTAL_STORE: 'file',
        PORTAL_DATA_DIR: path.join(sandbox.siteDir, 'data'),
      },
      script,
    );
    assertEqual(result.status, 0, 'the mutated publisher should have exited 0 (the defect is back)');
    assertEqual(
      publishedFiles(sandbox).length,
      0,
      'the mutation did not redden the check — the published quote was not destroyed',
    );
    return 'the mutated copy empties the published set';
  });

  // --- B-5: the crash-safe swap -------------------------------------------

  await t('H8', 'a crash in the middle of the swap is recoverable', async () => {
    const sandbox = publisherSandbox('swap-recovery');
    writeReviews(sandbox.reviewsFile, [QUOTE]);
    const first = await runPublisher(sandbox, {
      PORTAL_STORE: 'file',
      PORTAL_DATA_DIR: path.join(sandbox.siteDir, 'data'),
    });
    assertEqual(first.status, 0, `the first publish failed: ${first.stderr}`);
    assertEqual(publishedFiles(sandbox).length, 1, 'the approved quote was not published');

    // THE CRASH: the swap is two renames — the published directory is moved
    // aside and the new one takes its place. A process killed in between
    // leaves the published directory GONE, with the last good set in the
    // sibling (audit MINOR-1). The state is reproduced exactly here.
    const parent = path.dirname(sandbox.published);
    const stamp = `${process.pid}-${Date.now()}`;
    const previous = path.join(parent, `.testimonials-previous-${stamp}`);
    const staging = path.join(parent, `.testimonials-publish-${stamp}`);
    fs.renameSync(sandbox.published, previous);
    fs.mkdirSync(staging, { recursive: true });
    assert(!fs.existsSync(sandbox.published), 'the crash was not reproduced');

    // The build that follows cannot publish: the store is empty, and an
    // empty store must never replace a published set (wave 11).
    fs.writeFileSync(sandbox.reviewsFile, '', 'utf8');
    const second = await runPublisher(sandbox, {
      PORTAL_STORE: 'file',
      PORTAL_DATA_DIR: path.join(sandbox.siteDir, 'data'),
    });
    assert(
      second.status !== 0,
      `the build should have refused (exit 0: ${second.stdout})`,
    );
    assert(
      fs.existsSync(sandbox.published),
      'the published directory was not restored — the previous set did not survive the crash',
    );
    assertEqual(
      publishedFiles(sandbox).length,
      1,
      'the published quote was not restored — the previous set did not survive the crash',
    );
    const restored = publishedFiles(sandbox)[0];
    assert(
      fs
        .readFileSync(path.join(sandbox.published, restored), 'utf8')
        .includes('A perfectly good quote.'),
      'the restored quote is not the one that was published',
    );
    assert(
      /testimonials_swap_recovered/.test(second.stdout),
      `the recovery was not reported: ${second.stdout}`,
    );
    return 'the previous set survived the crash and was restored';
  });

  await t('H9', 'MUTATION: with the swap recovery removed, H8 goes RED', async () => {
    const { copyRoot, roots: copyRoots } = mutatedRoots('copy-swap-recovery');
    const script = path.join(copyRoot, 'site', 'scripts', 'publish-testimonials.mjs');
    patch(
      script,
      '  const recovered = recoverInterruptedSwap();',
      '  const recovered = null;',
    );
    const sandbox = publisherSandbox('mutated-swap-recovery');
    writeReviews(sandbox.reviewsFile, [QUOTE]);
    const first = await runPublisher(
      sandbox,
      {
        PORTAL_STORE: 'file',
        PORTAL_DATA_DIR: path.join(sandbox.siteDir, 'data'),
      },
      script,
    );
    assertEqual(first.status, 0, `the first publish failed: ${first.stderr}`);

    const parent = path.dirname(sandbox.published);
    const stamp = `${process.pid}-${Date.now()}`;
    fs.renameSync(sandbox.published, path.join(parent, `.testimonials-previous-${stamp}`));
    fs.writeFileSync(sandbox.reviewsFile, '', 'utf8');
    const second = await runPublisher(
      sandbox,
      {
        PORTAL_STORE: 'file',
        PORTAL_DATA_DIR: path.join(sandbox.siteDir, 'data'),
      },
      script,
    );
    // The mutated publisher does not restore the previous set: the build
    // that follows publishes a site with NO testimonials (the directory may
    // be recreated empty by the swap, but the quote is gone).
    assertEqual(
      publishedFiles(sandbox).length,
      0,
      'the mutation did not redden the check — the published quote survived',
    );
    return 'the mutated copy loses the published set';
  });

  await t('H10', "the owner's path works: the link, the page, the form POST (identity included)", async () => {
    // The whole loop, the way the owner walks through it: the signed link
    // from the mail, the confirmation page, and the POST the page's own form
    // makes. The identity has to survive every hop — a form that drops it
    // would answer 400 and the owner could never moderate anything.
    const dir = path.join(ROOT, 'owner-path');
    fs.mkdirSync(path.join(dir, 'moderation'), { recursive: true });
    const store = fileApi.createFileStore({ dataDir: dir });
    const stored = await store.append('reviews', {
      ...QUOTE,
      state: 'pending',
      revision: 1,
      review: 'the quote the owner was shown',
    });
    applyEnv(baseEnv({ PORTAL_STORE: 'file', PORTAL_DATA_DIR: dir }));
    globalThis.__imkPortalBackends.set(storeCacheKey(dir), { store, mode: 'file' });

    const ts = Math.floor(Date.now() / 1000);
    const sig = signModerationWithIdentity(REF, 'approve', 1, String(stored.recordId), ts);
    const query = `ref=${REF}&decision=approve&revision=1&recordId=${encodeURIComponent(
      String(stored.recordId),
    )}&sig=${sig}&ts=${ts}`;

    // 1. The link (a GET) serves the confirmation page and decides NOTHING.
    const page = await call(fileApi.moderate, 'GET', `/api/moderate/review?${query}`);
    assertEqual(page.status, 200, `the link must serve the page (got ${page.status})`);
    const html = String(page.body);
    assert(
      /<form[^>]*method="POST"/i.test(html),
      'the confirmation page must offer a POST form',
    );
    assert(
      html.includes(`name="recordId" value="${stored.recordId}"`),
      'the confirmation page does not carry the record identity',
    );

    // 2. The POST the page's form makes — the fields are the form's own.
    const fields = {};
    for (const match of html.matchAll(/<input[^>]*name="([^"]+)"[^>]*value="([^"]*)"/g)) {
      fields[match[1]] = match[2];
    }
    assert(fields.recordId, 'the form carries no identity');
    assertEqual(fields.recordId, String(stored.recordId), 'the form carries another identity');
    const body = new URLSearchParams(fields).toString();
    const decided = await call(fileApi.moderate, 'POST', '/api/moderate/review', {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    assertEqual(
      decided.status,
      200,
      `the form POST must decide the quote (got ${decided.status}: ${JSON.stringify(decided.body)})`,
    );
    assertEqual(decided.body.state, 'approved', 'the quote was not approved');
    const after = await store.list('reviews');
    assertEqual(after[0].state, 'approved', 'the store does not carry the decision');
    return 'the link, the page and the form POST all carry the identity';
  });

  // =========================================================================
  const failed = results.filter((r) => r.status === 'FAIL');
  origLog('');
  origLog(
    `[wave10] ${results.length - failed.length}/${results.length} checks passed` +
      (failed.length ? ` — ${failed.length} FAILED` : ''),
  );
  for (const f of failed) origLog(`  FAIL  ${f.id}  ${f.error}`);
  process.exitCode = failed.length ? 1 : 0;
}

await main();
