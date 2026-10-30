// backend-wave6-harness.mjs
//
// EXECUTED evidence for audit wave 6: F-2 (the session is a signed token),
// F-3 (the moderation write is guarded) and F-4 (the rate-limit lock stops
// misclassifying a busy lock as a broken backend).
//
// WHY THIS HARNESS EXISTS
//   F-2 was found by the Code Reviewer by execution: the session lived in a
//   module-scope Map, Vercel builds one function per file under api/, so the
//   cookie minted by /api/portal/auth/verify was refused by
//   /api/portal/projects with 401. The fix is a signed, stateless session —
//   which only counts if it really is stateless, so the harness proves it by
//   running the REAL handlers in SEPARATE bundles and SEPARATE processes, the
//   way the deploy target does.
//
//   F-3 and F-4 are the two findings QA and the reviewer reported against
//   wave 4/5: an unguarded review write that threw out of the handler, and a
//   lock that treated a Windows delete-pending lock (EPERM) as a broken
//   backend and silently abandoned the durable counter.
//
// WHAT IT EXECUTES
//   W1  the HMAC-SHA256 in site/shared/server/portal-session.ts is compared,
//       byte for byte, with node:crypto's createHmac over random inputs and
//       every padding/length boundary. The implementation exists because the
//       session API must stay SYNCHRONOUS (WebCrypto's only MAC is async) —
//       so it is proven against the platform, not trusted.
//   W2  the session cookie minted by the verify function is accepted by
//       ANOTHER function, in another bundle, in another process (200, not
//       401). A forged cookie is still refused (401).
//   W3  parity: a session minted by the Cloudflare tree is accepted by the
//       Vercel tree, and a session minted by the Vercel tree is resolved by
//       the Cloudflare tree. One shared module, one signing contract.
//   W4  the moderation endpoint: a missing store answers 501, a corrupt store
//       answers 500 {code:'storage'}, an unwritable store answers 500
//       {code:'storage'} — and NONE of them throws out of the handler, and
//       none of them ever answers "approved" for a decision that was not
//       stored.
//   W5  the file rate-limit backend under a multi-writer race loses no counts,
//       and a broken durable backend degrades to the in-memory counter with
//       exactly ONE log line carrying the error code.
//   W6  fail closed: a production instance without a signing secret mints no
//       session and answers 500 — on both trees.
//
// THE REPO IS NEVER TOUCHED
//   Every request runs in a child process whose cwd is a sandbox, so the
//   handlers resolve site/data/ inside the sandbox and the real store is
//   never read or written.
//
// USAGE
//   node backend-wave6-harness.mjs [--keep]

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync, spawn } from 'node:child_process';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = fs.existsSync(path.join(HERE, 'api', 'portal.ts')) ? HERE : path.resolve(HERE, '..');
const SITE = path.join(REPO, 'site');
const siteRequire = createRequire(path.join(SITE, 'package.json'));
const { build } = siteRequire('esbuild');

const KEEP = process.argv.includes('--keep');
// The origin the harness pretends to serve. It is HTTP on purpose.
//
// H-2 (wave-8A): a deployment is PRODUCTION when the base URL is an
// https:// URL (that is one of the three production signals in the brief), so
// an https origin here would put the children in production mode — where the
// magic-link token is NEVER written to the log and the harness could not
// read it. A real local dev server is http://localhost:4321, so the fixture
// now matches a local machine and the children stay in development mode.
const BASE = 'http://imk.test';
// At least 32 characters: H-1 refuses a shorter secret in production, and a
// fixture that the rule would reject proves nothing.
const SECRET = 'wave6-harness-secret-0123456789abc';
const CLIENT_EMAIL = 'client@imk.test';
const ADMIN_EMAIL = 'owner@imk.test';

const results = [];
let currentGroup = '';
const origLog = console.log;

function group(name) {
  currentGroup = name;
  origLog(`\n[wave6] ${name}`);
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
// Sandbox
// ---------------------------------------------------------------------------

const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const SANDBOX = path.join(os.tmpdir(), 'opencode', 'wave6', STAMP);
const SANDBOX_PORTAL = path.join(SANDBOX, 'site', 'data', 'portal');
const SANDBOX_MODERATION = path.join(SANDBOX, 'site', 'data', 'moderation');
const BUNDLES = path.join(SANDBOX, 'bundles');
const CHILD_FILE = path.join(SANDBOX, 'child.cjs');

function writeInvitedStore() {
  fs.mkdirSync(SANDBOX_PORTAL, { recursive: true });
  fs.writeFileSync(
    path.join(SANDBOX_PORTAL, 'invited.jsonl'),
    JSON.stringify({
      id: 'inv_w6',
      email: CLIENT_EMAIL,
      name: 'Nora Named',
      company: 'Named Co',
      role: 'CTO',
      clientId: 'cli_w6',
      createdAt: new Date().toISOString(),
    }) + '\n',
    'utf8',
  );
}

// ---------------------------------------------------------------------------
// Bundling — one entry point per function file, exactly like the deploy target
// ---------------------------------------------------------------------------

const BUNDLE_ENTRIES = {
  'vercel-request-link': path.join(REPO, 'api', 'portal', 'auth', 'request-link.ts'),
  'vercel-verify': path.join(REPO, 'api', 'portal', 'auth', 'verify.ts'),
  'vercel-projects': path.join(REPO, 'site', 'shared', 'portal-handlers', 'portal-projects.ts'),
  'vercel-moderate': path.join(REPO, 'api', 'moderate', 'review.ts'),
  'cf-auth': path.join(REPO, 'site', 'functions', 'api', 'portal', 'auth.ts'),
  'cf-invites': path.join(REPO, 'site', 'functions', 'api', 'portal', 'invites.ts'),
  'cf-session': path.join(REPO, 'site', 'functions', 'api', 'portal', 'session.ts'),
  'shared-session': path.join(REPO, 'site', 'shared', 'server', 'portal-session.ts'),
  'rate-limit': path.join(REPO, 'site', 'shared', 'server', 'rate-limit.ts'),
};

async function bundleAll() {
  fs.mkdirSync(BUNDLES, { recursive: true });
  for (const [name, entry] of Object.entries(BUNDLE_ENTRIES)) {
    await build({
      entryPoints: [entry],
      outfile: path.join(BUNDLES, `${name}.cjs`),
      bundle: true,
      platform: 'node',
      format: 'cjs',
      absWorkingDir: REPO,
      external: ['node:http', 'node:crypto', 'node:fs', 'node:path', 'node:stream'],
      logLevel: 'silent',
    });
  }
}

/**
 * Build the MUTATED bundles for the F-2 probe (W2f).
 *
 * The mutation reproduces the OLD session: the token is remembered in a
 * per-process registry instead of being proved by its signature. The copy is
 * made in the sandbox — the repo is never modified — and an esbuild plugin
 * redirects every import of the shared module to the copy, so the handlers
 * under test really use the mutated one.
 */
const MUTATED_SESSION = path.join(SANDBOX, 'mutated', 'portal-session.ts');

async function buildMutatedBundles() {
  fs.mkdirSync(path.dirname(MUTATED_SESSION), { recursive: true });
  const source = fs.readFileSync(
    path.join(REPO, 'site', 'shared', 'server', 'portal-session.ts'),
    'utf8',
  );

  // createSession registers the token; parseSession only accepts a token it
  // has seen — the module-scope Map the audit found.
  let mutated = source.replace(
    '  return `${TOKEN_VERSION}.${payloadB64}.${sig}`;',
    [
      '  const __token = `${TOKEN_VERSION}.${payloadB64}.${sig}`;',
      '  const __mut = (globalThis as any).__w6MutSessions;',
      '  if (__mut) __mut.set(__token, { email, role, clientId });',
      '  return __token;',
    ].join('\n'),
  );
  mutated = mutated.replace(
    'export function parseSession(token: string, env?: EnvLike): Session | null {\n  if (!token) return null;',
    [
      'export function parseSession(token: string, env?: EnvLike): Session | null {',
      '  if (!token) return null;',
      '  const __mut = (globalThis as any).__w6MutSessions;',
      '  if (__mut) { const __hit = __mut.get(token); return __hit ?? null; }',
    ].join('\n'),
  );
  assert(
    mutated !== source && mutated.includes('__w6MutSessions'),
    'the mutation must actually change the session module',
  );
  fs.writeFileSync(MUTATED_SESSION, mutated, 'utf8');

  // The mutated copy imports './secret.js' (H-1, wave-8A), so the secret
  // module has to sit next to it or the bundle cannot be built.
  fs.writeFileSync(
    path.join(path.dirname(MUTATED_SESSION), 'secret.ts'),
    fs.readFileSync(path.join(REPO, 'site', 'shared', 'server', 'secret.ts'), 'utf8'),
    'utf8',
  );

  const plugin = {
    name: 'mutated-session',
    setup(b) {
      b.onResolve({ filter: /portal-session\.js$/ }, () => ({ path: MUTATED_SESSION }));
    },
  };

  for (const name of ['vercel-verify-mut', 'vercel-projects-mut']) {
    const entry = BUNDLE_ENTRIES[name.replace('-mut', '')];
    await build({
      entryPoints: [entry],
      outfile: path.join(BUNDLES, `${name}.cjs`),
      bundle: true,
      platform: 'node',
      format: 'cjs',
      absWorkingDir: REPO,
      external: ['node:http', 'node:crypto', 'node:fs', 'node:path', 'node:stream'],
      plugins: [plugin],
      logLevel: 'silent',
    });
  }
}

function bundlePath(name) {
  return path.join(BUNDLES, `${name}.cjs`);
}

/**
 * Copy a tree of TypeScript sources.
 *
 * The mutation probes copy a module into a sandbox and build it there. A
 * module whose imports are relative needs its neighbours in the same relative
 * layout, or the bundle cannot be built at all.
 */
function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(src, dst);
    else if (entry.name.endsWith('.ts')) fs.copyFileSync(src, dst);
  }
}

// ---------------------------------------------------------------------------
// The child runner — one process per request (or per op list)
// ---------------------------------------------------------------------------

const CHILD = `
const { Readable } = require('node:stream');

// The mutation probe (W2f) reproduces the OLD, Map-based session: the token
// is only known to the process that minted it.
if (process.env.W6_MUTATE === '1') globalThis.__w6MutSessions = new Map();

// The Cloudflare code looks for \`globalThis.require\`. On the edge there is
// none, so the store cannot be read and the portal answers 501. This child
// runs as CommonJS, where \`require\` is module-scoped and globalThis.require
// is undefined — exactly like the edge — unless the harness asks for a
// filesystem.
if (process.env.W6_WITH_FS === '1') globalThis.require = require;
else delete globalThis.require;

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
      this.headers = headers || {};
      return this;
    },
    setHeader(name, value) {
      this.headers[name] = value;
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

async function runOp(op, bundlePath) {
  const mod = require(bundlePath);

  if (op.type === 'http') {
    if (op.mode === 'vercel') {
      const req = makeReq(op.method, op.url, op.headers, op.body);
      const res = makeRes();
      await mod.default(req, res);
      let parsed = null;
      try { parsed = JSON.parse(res.body || 'null'); } catch (e) { parsed = null; }
      return { status: res.statusCode, body: parsed, raw: res.body, headers: res.headers };
    }
    const env = JSON.parse(process.env.W6_CF_ENV || '{}');
    const init = { method: op.method, headers: op.headers || {} };
    if (op.body && op.method !== 'GET' && op.method !== 'HEAD') init.body = op.body;
    const request = new Request(op.url, init);
    const handler =
      op.method === 'GET' ? mod.onRequestGet :
      op.method === 'POST' ? mod.onRequestPost :
      mod.onRequestPatch;
    const response = await handler({ request, env });
    const text = await response.text();
    let parsed = null;
    try { parsed = JSON.parse(text || 'null'); } catch (e) { parsed = null; }
    const headers = {};
    response.headers.forEach((value, key) => { headers[key] = value; });
    return { status: response.status, body: parsed, raw: text, headers };
  }

  if (op.type === 'call') {
    const fn = mod[op.export];
    if (typeof fn !== 'function') throw new Error('no export ' + op.export);
    let args = op.args || [];
    if (op.mode === 'cf' && op.export === 'resolveSession') {
      args = [new Headers(op.headers || {})];
    }
    const value = await fn(...args);
    return { value: value === undefined ? null : value };
  }

  throw new Error('unknown op type: ' + op.type);
}

(async () => {
  const plan = JSON.parse(process.env.W6_PLAN || '{}');
  const out = [];
  for (const op of plan.ops || []) {
    out.push(await runOp(op, plan.bundle));
  }
  process.stdout.write('__RESULT__' + JSON.stringify(out) + '\\n');
})().catch((err) => {
  process.stdout.write(
    '__RESULT__' +
      JSON.stringify([{ error: String(err && err.message ? err.message : err) }]) +
      '\\n',
  );
  process.exitCode = 1;
});
`;

/**
 * Run one or more ops in a FRESH child process.
 *
 * @param {string} bundle
 * @param {Array} ops
 * @param {object} env       environment overrides for the child
 * @param {object} cfEnv    the Worker env the Cloudflare handlers see
 * @param {boolean} withFs  give the child a filesystem (the edge has none)
 * @param {string} mutate   '1' to switch the child into the old, Map-based
 *                           session (the mutation probe)
 */
function runChild(bundle, ops, env = {}, cfEnv = null, withFs = true, mutate = '') {
  fs.writeFileSync(CHILD_FILE, CHILD, 'utf8');

  const childEnv = { ...process.env };
  for (const key of [
    'RESEND_API_KEY',
    'PORTAL_RATE_LIMIT_FILE',
    'APP_ENV',
    'SITE_BASE_URL',
    'SITE_URL',
    'PORTAL_MAGIC_LINK_SECRET',
    'PORTAL_SESSION_SECRET',
    'ADMIN_EMAILS',
    'FORM_WEBHOOK_SECRET',
  ]) {
    delete childEnv[key];
  }
  childEnv.APP_ENV = 'development';
  childEnv.SITE_BASE_URL = BASE;
  childEnv.ADMIN_EMAILS = ADMIN_EMAIL;
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete childEnv[k];
    else childEnv[k] = String(v);
  }
  childEnv.W6_WITH_FS = withFs ? '1' : '0';
  childEnv.W6_MUTATE = mutate;
  childEnv.W6_PLAN = JSON.stringify({ bundle, ops });
  childEnv.W6_CF_ENV = JSON.stringify(
    cfEnv || {
      APP_ENV: childEnv.APP_ENV,
      SITE_BASE_URL: childEnv.SITE_BASE_URL,
      ADMIN_EMAILS: childEnv.ADMIN_EMAILS,
      PORTAL_MAGIC_LINK_SECRET: childEnv.PORTAL_MAGIC_LINK_SECRET,
      PORTAL_SESSION_SECRET: childEnv.PORTAL_SESSION_SECRET,
      FORM_WEBHOOK_SECRET: childEnv.FORM_WEBHOOK_SECRET,
    },
  );

  const res = spawnSync(process.execPath, [CHILD_FILE], {
    cwd: SANDBOX,
    env: childEnv,
    encoding: 'utf8',
    timeout: 120000,
  });

  const stdout = res.stdout || '';
  const stderr = res.stderr || '';
  const line = stdout.split('\n').find((l) => l.startsWith('__RESULT__'));
  if (!line) {
    throw new Error(
      `child produced no result\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    );
  }
  const out = JSON.parse(line.slice('__RESULT__'.length));
  const logs = stdout
    .split('\n')
    .filter((l) => l.trim().startsWith('{'))
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  return { out, logs, stdout, stderr };
}

function tokenFromLogs(logs) {
  const entry = logs.find((l) => l && l.outcome === 'magic_link_dev');
  return entry ? entry.token : null;
}

function sessionFromSetCookie(headers) {
  const raw = String(headers['set-cookie'] || headers['Set-Cookie'] || '');
  const match = raw.match(/imk_session=([^;]+)/);
  return match ? match[1] : null;
}

function signModeration(ref, decision, revision, ts, secret) {
  return crypto
    .createHmac('sha256', secret)
    .update(`${ref}|${decision}|${revision}|${ts}`)
    .digest('hex');
}

/**
 * Hold a lock file in the Windows "delete pending" state.
 *
 * The handle is opened, the file is unlinked while the handle is still open,
 * and the handle is kept for a few seconds. On Windows the name stays
 * visible but the file can no longer be opened with CREATE_NEW: the next
 * `open(lock, 'wx')` fails with EPERM, not EEXIST. That is the transient,
 * NORMAL condition the old lock code mistook for a broken backend.
 */
function spawnBusyLockHolder(lockPath, holdMs = 8000) {
  const script =
    `const fs=require('node:fs');` +
    `const fd=fs.openSync(${JSON.stringify(lockPath)},'wx');` +
    `fs.unlinkSync(${JSON.stringify(lockPath)});` +
    `console.log('pending');` +
    `setTimeout(()=>{try{fs.closeSync(fd);}catch(e){}},${holdMs});` +
    `setTimeout(()=>process.exit(0),${holdMs});`;
  const child = spawn(process.execPath, ['-e', script], { encoding: 'utf8' });
  return new Promise((resolve) => {
    let settled = false;
    child.stdout.on('data', (d) => {
      if (!settled && String(d).includes('pending')) {
        settled = true;
        resolve(child);
      }
    });
    child.on('close', () => {
      if (!settled) {
        settled = true;
        resolve(child);
      }
    });
  });
}

/** Call `hit()` on the file backend and report what happened. */
function hitWithBundle(bundleFile, counterFile) {
  const script = `
    const { createFileBackend } = require(${JSON.stringify(bundleFile)});
    const backend = createFileBackend(${JSON.stringify(counterFile)});
    (async () => {
      await backend.hit('busy-key', 600000);
      process.stdout.write('__RESULT__' + JSON.stringify({ ok: true }) + '\\n');
    })().catch((err) => {
      process.stdout.write('__RESULT__' + JSON.stringify({
        ok: false,
        code: err && err.code ? err.code : null,
        message: err && err.message ? err.message : String(err),
      }) + '\\n');
    });
  `;
  const file = path.join(SANDBOX, `hit-${path.basename(bundleFile)}-${Date.now()}.cjs`);
  fs.writeFileSync(file, script, 'utf8');
  const res = spawnSync(process.execPath, [file], {
    cwd: SANDBOX,
    env: { ...process.env },
    encoding: 'utf8',
    timeout: 60000,
  });
  const line = (res.stdout || '').split('\n').find((l) => l.startsWith('__RESULT__'));
  assert(line, `the probe produced no result:\n${res.stdout}\n${res.stderr}`);
  return JSON.parse(line.slice('__RESULT__'.length));
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

async function main() {
  origLog(`[wave6] sandbox: ${SANDBOX}`);
  fs.mkdirSync(SANDBOX, { recursive: true });
  writeInvitedStore();
  await bundleAll();

  // -- W1: the MAC is the platform's MAC -------------------------------------
  group('W1 — the HMAC implementation is proven against node:crypto');

  const shared = require(bundlePath('shared-session'));

  await t('W1a', 'hmacSha256Hex agrees with node:crypto on every input', () => {
    const cases = [];
    // Boundaries that break naive implementations: empty, 1, 55, 56, 63, 64,
    // 65 bytes (the SHA-256 padding boundary), plus unicode and long input.
    for (const n of [0, 1, 2, 55, 56, 63, 64, 65, 119, 120, 127, 128, 129]) {
      cases.push(['k'.repeat(n), 'm'.repeat(n)]);
    }
    cases.push(['', '']);
    cases.push(['secret', '']);
    cases.push(['', 'message']);
    cases.push(['ключ', 'сообщение — ünïcode ✓']);
    cases.push(['s', 'x'.repeat(100000)]);
    for (let i = 0; i < 300; i++) {
      const secret = crypto.randomBytes(1 + Math.floor(Math.random() * 48)).toString('hex');
      const message = crypto.randomBytes(Math.floor(Math.random() * 200)).toString('base64');
      cases.push([secret, message]);
    }
    for (const [secret, message] of cases) {
      const mine = shared.hmacSha256Hex(secret, message);
      const theirs = crypto.createHmac('sha256', secret).update(message, 'utf8').digest('hex');
      assertEqual(mine, theirs, `hmac mismatch for secret=${JSON.stringify(secret.slice(0, 12))}`);
    }
    return `${cases.length} inputs, byte-for-byte identical`;
  });

  await t('W1b', 'sha256Hex agrees with node:crypto', () => {
    for (let i = 0; i < 100; i++) {
      const data = crypto.randomBytes(Math.floor(Math.random() * 300)).toString('utf8');
      assertEqual(
        shared.sha256Hex(data),
        crypto.createHash('sha256').update(data, 'utf8').digest('hex'),
        'sha256 mismatch',
      );
    }
    return '100 random inputs, byte-for-byte identical';
  });

  // -- W2: the session crosses bundles and processes -------------------------
  group('W2 — the session is stateless: the cookie works in another function');

  const minted = runChild(
    bundlePath('vercel-request-link'),
    [
      {
        type: 'http',
        mode: 'vercel',
        method: 'POST',
        url: '/api/portal/auth/request-link',
        headers: {
          host: 'imk.test',
          origin: BASE,
          'content-type': 'application/json',
          'x-forwarded-for': '198.51.100.10',
        },
        body: JSON.stringify({ email: CLIENT_EMAIL }),
      },
    ],
    { PORTAL_MAGIC_LINK_SECRET: SECRET },
  );
  const magicToken = tokenFromLogs(minted.logs);

  await t('W2a', 'the request-link function mints a magic-link token', () => {
    assert(minted.out[0].status === 200, `expected 200, got ${minted.out[0].status}`);
    assert(magicToken, 'a token must be minted and logged');
    return '200, a token was minted';
  });

  const verified = runChild(
    bundlePath('vercel-verify'),
    [
      {
        type: 'http',
        mode: 'vercel',
        method: 'GET',
        url: `/api/portal/auth/verify?token=${encodeURIComponent(magicToken)}&purpose=portal`,
        headers: { host: 'imk.test', origin: BASE, 'x-forwarded-for': '198.51.100.11' },
      },
    ],
    { PORTAL_MAGIC_LINK_SECRET: SECRET },
  );
  const sessionCookie = sessionFromSetCookie(verified.out[0].headers);

  await t('W2b', 'the verify function (another bundle, another process) issues a session', () => {
    assertEqual(verified.out[0].status, 200, `the verify status (body ${verified.out[0].raw})`);
    assert(sessionCookie, 'a session cookie must be issued');
    return '200, a session cookie was issued';
  });

  await t('W2c', 'ANOTHER function accepts that cookie (200, not 401)', () => {
    const p = runChild(
      bundlePath('vercel-projects'),
      [
        {
          type: 'http',
          mode: 'vercel',
          method: 'GET',
          url: '/api/portal/projects',
          headers: {
            host: 'imk.test',
            origin: BASE,
            cookie: `imk_session=${sessionCookie}`,
          },
        },
      ],
      { PORTAL_MAGIC_LINK_SECRET: SECRET },
    );
    assertEqual(
      p.out[0].status,
      200,
      `the projects function must accept the cookie (got ${p.out[0].status} ${p.out[0].raw})`,
    );
    return '200 — the session survives the bundle split (F-2 closed)';
  });

  await t('W2d', 'a forged cookie is still refused (401)', () => {
    const forged = sessionCookie.slice(0, -4) + 'dead';
    const p = runChild(
      bundlePath('vercel-projects'),
      [
        {
          type: 'http',
          mode: 'vercel',
          method: 'GET',
          url: '/api/portal/projects',
          headers: { host: 'imk.test', origin: BASE, cookie: `imk_session=${forged}` },
        },
      ],
      { PORTAL_MAGIC_LINK_SECRET: SECRET },
    );
    assertEqual(p.out[0].status, 401, `a forged cookie must be refused (got ${p.out[0].status})`);
    return '401 — the signature is still checked';
  });

  await t('W2e', 'a cookie signed with another secret is refused (401)', () => {
    const p = runChild(
      bundlePath('vercel-projects'),
      [
        {
          type: 'http',
          mode: 'vercel',
          method: 'GET',
          url: '/api/portal/projects',
          headers: { host: 'imk.test', origin: BASE, cookie: `imk_session=${sessionCookie}` },
        },
      ],
      { PORTAL_MAGIC_LINK_SECRET: 'a-different-secret' },
    );
    assertEqual(p.out[0].status, 401, `another secret must not validate (got ${p.out[0].status})`);
    return '401 — the secret is part of the contract';
  });

  await t('W2f', 'the probe can fail: with the OLD Map-based session the cookie dies', async () => {
    await buildMutatedBundles();
    // Mint with the mutated (Map-based) verify, read with the mutated
    // projects — two separate processes, so the Map is not shared. That is
    // the defect the reviewer found, reproduced here on purpose.
    const v = runChild(
      bundlePath('vercel-verify-mut'),
      [
        {
          type: 'http',
          mode: 'vercel',
          method: 'GET',
          url: `/api/portal/auth/verify?token=${encodeURIComponent(magicToken)}&purpose=portal`,
          headers: { host: 'imk.test', origin: BASE },
        },
      ],
      { PORTAL_MAGIC_LINK_SECRET: SECRET },
      null,
      true,
      '1',
    );
    const mutatedCookie = sessionFromSetCookie(v.out[0].headers);
    assert(mutatedCookie, 'the mutated verify must issue a cookie');
    const p = runChild(
      bundlePath('vercel-projects-mut'),
      [
        {
          type: 'http',
          mode: 'vercel',
          method: 'GET',
          url: '/api/portal/projects',
          headers: { host: 'imk.test', origin: BASE, cookie: `imk_session=${mutatedCookie}` },
        },
      ],
      { PORTAL_MAGIC_LINK_SECRET: SECRET },
      null,
      true,
      '1',
    );
    assertEqual(
      p.out[0].status,
      401,
      `the mutated (Map-based) session must fail across processes (got ${p.out[0].status})`,
    );
    return '401 — the probe detects the old defect, so W2c is not vacuous';
  });

  // -- W3: parity between the two trees --------------------------------------
  group('W3 — one module, one signing contract: the trees accept each other');

  await t('W3a', 'a Cloudflare-minted session is accepted by the Vercel tree', () => {
    const cf = runChild(
      bundlePath('cf-auth'),
      [
        {
          type: 'http',
          mode: 'cf',
          method: 'GET',
          url: `${BASE}/api/portal/auth/verify?token=${encodeURIComponent(magicToken)}&purpose=portal`,
          headers: { host: 'imk.test', origin: BASE },
        },
      ],
      { PORTAL_MAGIC_LINK_SECRET: SECRET },
      {
        APP_ENV: 'development',
        SITE_BASE_URL: BASE,
        ADMIN_EMAILS: ADMIN_EMAIL,
        PORTAL_MAGIC_LINK_SECRET: SECRET,
      },
    );
    const cfSession = sessionFromSetCookie(cf.out[0].headers);
    assertEqual(cf.out[0].status, 200, `the Cloudflare verify status (${cf.out[0].raw})`);
    assert(cfSession, 'the Cloudflare tree must issue a session cookie');

    const p = runChild(
      bundlePath('vercel-projects'),
      [
        {
          type: 'http',
          mode: 'vercel',
          method: 'GET',
          url: '/api/portal/projects',
          headers: { host: 'imk.test', origin: BASE, cookie: `imk_session=${cfSession}` },
        },
      ],
      { PORTAL_MAGIC_LINK_SECRET: SECRET },
    );
    assertEqual(
      p.out[0].status,
      200,
      `the Vercel tree must accept the Cloudflare session (got ${p.out[0].status})`,
    );
    return 'a Cloudflare session works on the Vercel tree';
  });

  await t('W3b', 'a Vercel-minted session is resolved by the Cloudflare tree', () => {
    const cf = runChild(
      bundlePath('cf-session'),
      [
        {
          type: 'call',
          mode: 'cf',
          export: 'resolveSession',
          headers: { cookie: `imk_session=${sessionCookie}` },
        },
      ],
      { PORTAL_MAGIC_LINK_SECRET: SECRET },
      {
        APP_ENV: 'development',
        SITE_BASE_URL: BASE,
        ADMIN_EMAILS: ADMIN_EMAIL,
        PORTAL_MAGIC_LINK_SECRET: SECRET,
      },
    );
    const session = cf.out[0].value;
    assert(session, 'the Cloudflare session module must resolve the session');
    assertEqual(session.email, CLIENT_EMAIL, 'the resolved email');
    assertEqual(session.role, 'client', 'the resolved role');
    assertEqual(session.clientId, 'cli_w6', 'the resolved clientId');
    return 'the same email, role and clientId on the other tree';
  });

  await t('W3c', 'the Cloudflare tree refuses a cookie it cannot verify', () => {
    const cf = runChild(
      bundlePath('cf-session'),
      [
        {
          type: 'call',
          mode: 'cf',
          export: 'resolveSession',
          headers: { cookie: `imk_session=${sessionCookie.slice(0, -4)}dead` },
        },
      ],
      { PORTAL_MAGIC_LINK_SECRET: SECRET },
      {
        APP_ENV: 'development',
        SITE_BASE_URL: BASE,
        ADMIN_EMAILS: ADMIN_EMAIL,
        PORTAL_MAGIC_LINK_SECRET: SECRET,
      },
    );
    assertEqual(cf.out[0].value, null, 'a forged cookie must not resolve');
    return 'null — the edge tree verifies the signature too';
  });

  await t('W3d', 'the edge tree routes on the session it can verify (the QA C1 scenario)', () => {
    // The QA suite (site/qa/qa-cf-parity.mjs, check C1) mints a session with
    // the Cloudflare session module and then calls the owner-only invites
    // route: an owner session must reach the 501, a client session must be
    // refused with 403. With the fail-closed rule the harness needs a
    // signing secret in the Worker env — this check proves that with the
    // secret the scenario behaves exactly as before.
    const cfEnv = {
      APP_ENV: 'production',
      SITE_BASE_URL: BASE,
      ADMIN_EMAILS: ADMIN_EMAIL,
      PORTAL_SESSION_SECRET: SECRET,
    };
    const owner = runChild(
      bundlePath('cf-session'),
      [
        {
          type: 'call',
          mode: 'cf',
          export: 'createSession',
          args: [ADMIN_EMAIL, 'admin', undefined, cfEnv],
        },
      ],
      { PORTAL_SESSION_SECRET: SECRET },
      cfEnv,
    );
    const client = runChild(
      bundlePath('cf-session'),
      [
        {
          type: 'call',
          mode: 'cf',
          export: 'createSession',
          args: [CLIENT_EMAIL, 'client', 'cli_w6', cfEnv],
        },
      ],
      { PORTAL_SESSION_SECRET: SECRET },
      cfEnv,
    );
    const ownerToken = owner.out[0].value;
    const clientToken = client.out[0].value;
    assert(ownerToken, 'an owner session must be minted');
    assert(clientToken, 'a client session must be minted');

    const invites = runChild(
      bundlePath('cf-invites'),
      [
        {
          type: 'http',
          mode: 'cf',
          method: 'POST',
          url: `${BASE}/api/portal/invites`,
          headers: {
            origin: BASE,
            cookie: `imk_admin_session=${ownerToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ email: 'someone@client.test' }),
        },
        {
          type: 'http',
          mode: 'cf',
          method: 'POST',
          url: `${BASE}/api/portal/invites`,
          headers: {
            origin: BASE,
            cookie: `imk_session=${clientToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ email: 'someone@client.test' }),
        },
      ],
      { PORTAL_SESSION_SECRET: SECRET },
      cfEnv,
    );
    assertEqual(invites.out[0].status, 501, `the owner must reach the 501 (got ${invites.out[0].status})`);
    assertEqual(invites.out[1].status, 403, `a client must be refused (got ${invites.out[1].status})`);
    return 'owner -> 501, client -> 403 — the edge tree still routes on the session';
  });

  // -- W4: the moderation write is guarded ------------------------------------
  group('W4 — the moderation endpoint never throws and never lies (F-3)');

  const REF = 'inq_w6';
  const REVISION = 1;
  const TS = Math.floor(Date.now() / 1000);
  const SIG = signModeration(REF, 'approve', REVISION, TS, SECRET);
  const MODERATE_URL =
    `/api/moderate/review?ref=${REF}&decision=approve&revision=${REVISION}&sig=${SIG}&ts=${TS}`;

  await t('W4a', 'a MISSING store answers 501, not 404', () => {
    const dir = path.join(SANDBOX, 'missing-store');
    fs.mkdirSync(dir, { recursive: true });
    const r = runChild(
      bundlePath('vercel-moderate'),
      [
        {
          type: 'http',
          mode: 'vercel',
          method: 'GET',
          url: MODERATE_URL,
          headers: { host: 'imk.test' },
        },
      ],
      { FORM_WEBHOOK_SECRET: SECRET },
    );
    // The child's cwd is the sandbox, which has no moderation store yet.
    assertEqual(r.out[0].status, 501, `the status (body ${r.out[0].raw})`);
    assertEqual(r.out[0].body.code, 'unimplemented', 'the code');
    return '501 {code:unimplemented} — a store that cannot be reached is not an empty store';
  });

  await t('W4b', 'a CORRUPT store answers 500 {code:storage}', () => {
    fs.mkdirSync(SANDBOX_MODERATION, { recursive: true });
    fs.writeFileSync(
      path.join(SANDBOX_MODERATION, 'reviews.jsonl'),
      '{"type":"review","ref":"inq_x"}\nthis is not json\n',
      'utf8',
    );
    const r = runChild(
      bundlePath('vercel-moderate'),
      [
        {
          type: 'http',
          mode: 'vercel',
          method: 'GET',
          url: MODERATE_URL,
          headers: { host: 'imk.test' },
        },
      ],
      { FORM_WEBHOOK_SECRET: SECRET },
    );
    assertEqual(r.out[0].status, 500, `the status (body ${r.out[0].raw})`);
    assertEqual(r.out[0].body.code, 'storage', 'the code');
    return '500 {code:storage}';
  });

  await t('W4c', 'an UNWRITABLE store answers 500 {code:storage} and never "approved"', () => {
    fs.mkdirSync(SANDBOX_MODERATION, { recursive: true });
    const file = path.join(SANDBOX_MODERATION, 'reviews.jsonl');
    fs.writeFileSync(
      file,
      JSON.stringify({
        type: 'review',
        ref: REF,
        revision: REVISION,
        state: 'pending',
        review: 'A good quote',
        name: 'Nora',
      }) + '\n',
      'utf8',
    );
    // Read-only file: the read works, the write cannot. The DECISION is the
    // POST (M-1: a GET only shows the confirmation page), so the write is
    // attempted here.
    fs.chmodSync(file, 0o444);
    const r = runChild(
      bundlePath('vercel-moderate'),
      [
        {
          type: 'http',
          mode: 'vercel',
          method: 'POST',
          url: MODERATE_URL,
          headers: { host: 'imk.test', 'content-type': 'application/x-www-form-urlencoded' },
          body: '',
        },
      ],
      { FORM_WEBHOOK_SECRET: SECRET },
    );
    fs.chmodSync(file, 0o666);
    assertEqual(r.out[0].status, 500, `the status (body ${r.out[0].raw})`);
    assertEqual(r.out[0].body.code, 'storage', 'the code');
    assert(
      !r.out[0].body || r.out[0].body.state !== 'approved',
      'the endpoint must never answer "approved" for a decision that was not stored',
    );
    return '500 {code:storage} — the decision was never stored, so it is not "approved"';
  });

  await t('W4d', 'a GET does NOT flip the state (M-1: a mail scanner must not approve)', () => {
    // The owner receives a GET link. Everything that touches mail fetches a
    // link in an incoming message automatically, so a GET that decided
    // anything would publish the owner's quotes without anybody's consent.
    const r = runChild(
      bundlePath('vercel-moderate'),
      [
        {
          type: 'http',
          mode: 'vercel',
          method: 'GET',
          url: MODERATE_URL,
          headers: { host: 'imk.test' },
        },
      ],
      { FORM_WEBHOOK_SECRET: SECRET },
    );
    assertEqual(r.out[0].status, 200, `the status (body ${r.out[0].raw})`);
    const headers = r.out[0].headers || {};
    const contentType = String(
      headers['content-type'] || headers['Content-Type'] || '',
    ).toLowerCase();
    assert(
      contentType.includes('text/html'),
      `a GET must answer the confirmation page, got ${contentType}`,
    );
    const stored = fs
      .readFileSync(path.join(SANDBOX_MODERATION, 'reviews.jsonl'), 'utf8')
      .trim();
    assert(stored.includes('"pending"'), 'the state must still be pending');
    assert(!stored.includes('"approved"'), 'a GET must never approve a quote');
    return '200 + the confirmation page, and the store still says pending';
  });

  await t('W4e', 'the POST is the decision, and it is stored', () => {
    const r = runChild(
      bundlePath('vercel-moderate'),
      [
        {
          type: 'http',
          mode: 'vercel',
          method: 'POST',
          url: MODERATE_URL,
          headers: { host: 'imk.test', 'content-type': 'application/x-www-form-urlencoded' },
          body: '',
        },
      ],
      { FORM_WEBHOOK_SECRET: SECRET },
    );
    assertEqual(r.out[0].status, 200, `the status (body ${r.out[0].raw})`);
    assertEqual(r.out[0].body.state, 'approved', 'the state');
    const stored = fs
      .readFileSync(path.join(SANDBOX_MODERATION, 'reviews.jsonl'), 'utf8')
      .trim();
    assert(stored.includes('"approved"'), 'the decision must be on disk');
    return '200 {state:approved} and the decision is on disk';
  });

  // -- W5: the rate-limit lock ------------------------------------------------
  group('W5 — the file counter keeps its counts under a race (F-4)');

  await t('W5b', 'the durable counter survives a multi-writer race', () => {
    const counterFile = path.join(SANDBOX, 'race-counter.json');
    const writers = 4;
    const keys = 20;
    const rounds = 5;
    const expected = writers * rounds;

    const writerScript = `
      const { createFileBackend } = require(process.env.W6_PLAN_BUNDLE);
      const backend = createFileBackend(process.env.W6_COUNTER);
      (async () => {
        for (let r = 0; r < ${rounds}; r++) {
          for (let k = 0; k < ${keys}; k++) {
            await backend.hit('key-' + k, 600000);
          }
        }
        process.stdout.write('__RESULT__' + JSON.stringify({ done: true }) + '\\n');
      })().catch((err) => {
        process.stdout.write('__RESULT__' + JSON.stringify({ error: String(err && err.message ? err.message : err) }) + '\\n');
        process.exitCode = 1;
      });
    `;
    const writerFile = path.join(SANDBOX, 'writer.cjs');
    fs.writeFileSync(writerFile, writerScript, 'utf8');

    const runs = [];
    for (let w = 0; w < writers; w++) {
      const res = spawnSync(process.execPath, [writerFile], {
        cwd: SANDBOX,
        env: {
          ...process.env,
          W6_PLAN_BUNDLE: bundlePath('rate-limit'),
          W6_COUNTER: counterFile,
        },
        encoding: 'utf8',
        timeout: 120000,
      });
      const stdout = res.stdout || '';
      const line = stdout.split('\n').find((l) => l.startsWith('__RESULT__'));
      assert(line, `writer ${w} produced no result:\n${stdout}\n${res.stderr}`);
      const parsed = JSON.parse(line.slice('__RESULT__'.length));
      assert(!parsed.error, `writer ${w} failed: ${parsed.error}`);
      runs.push(parsed);
    }

    const state = JSON.parse(fs.readFileSync(counterFile, 'utf8'));
    const buckets = state.buckets || {};
    assertEqual(Object.keys(buckets).length, keys, 'the number of buckets');
    let lost = 0;
    for (let k = 0; k < keys; k++) {
      const id = crypto.createHash('sha256').update(`key-${k}`).digest('hex');
      const bucket = buckets[id];
      const count = bucket ? bucket.count : 0;
      if (count !== expected) lost += expected - count;
    }
    assertEqual(lost, 0, `${lost} counts were lost in the race`);
    return `${writers} writers x ${keys} keys x ${rounds} rounds — every bucket holds ${expected}`;
  });

  await t('W5c', 'a broken durable backend degrades ONCE, with the error code', () => {
    // A path whose parent is a FILE: the counter directory cannot be made.
    const blocker = path.join(SANDBOX, 'not-a-directory');
    fs.writeFileSync(blocker, 'x', 'utf8');
    const counterFile = path.join(blocker, 'counter.json');
    const script = `
      const { createFileBackend, RateLimiter } = require(process.env.W6_PLAN_BUNDLE);
      const limiter = new RateLimiter(createFileBackend(process.env.W6_COUNTER));
      (async () => {
        const decisions = [];
        for (let i = 0; i < 3; i++) {
          decisions.push(await limiter.consume('key', 5, 600000));
        }
        process.stdout.write('__RESULT__' + JSON.stringify({ decisions }) + '\\n');
      })().catch((err) => {
        process.stdout.write('__RESULT__' + JSON.stringify({ error: String(err && err.message ? err.message : err) }) + '\\n');
        process.exitCode = 1;
      });
    `;
    const scriptFile = path.join(SANDBOX, 'degrade.cjs');
    fs.writeFileSync(scriptFile, script, 'utf8');
    const res = spawnSync(process.execPath, [scriptFile], {
      cwd: SANDBOX,
      env: { ...process.env, W6_PLAN_BUNDLE: bundlePath('rate-limit'), W6_COUNTER: counterFile },
      encoding: 'utf8',
      timeout: 60000,
    });
    const stdout = res.stdout || '';
    const line = stdout.split('\n').find((l) => l.startsWith('__RESULT__'));
    assert(line, `the child produced no result:\n${stdout}\n${res.stderr}`);
    const parsed = JSON.parse(line.slice('__RESULT__'.length));
    assert(!parsed.error, `the child failed: ${parsed.error}`);
    assertEqual(parsed.decisions.length, 3, 'the number of decisions');
    for (const d of parsed.decisions) {
      assertEqual(d.degraded, true, 'the decision must report the degradation');
    }
    const degraded = stdout
      .split('\n')
      .filter((l) => l.includes('rate_limit_degraded'));
    assertEqual(degraded.length, 1, 'the degradation must be logged exactly once');
    const log = JSON.parse(degraded[0]);
    assert(log.code, 'the log must carry the underlying error code');
    return `one log line, code=${log.code}, the requests still succeed`;
  });

  await t('W5d', 'a busy (delete-pending) lock gives the module\'s own error, not a raw EPERM', async () => {
    const counterFile = path.join(SANDBOX, 'busy-counter.json');
    const lockPath = `${counterFile}.lock`;
    const holder = await spawnBusyLockHolder(lockPath);
    try {
      const result = hitWithBundle(bundlePath('rate-limit'), counterFile);
      assert(!result.ok, 'the busy lock must not be taken');
      assert(
        !/^(EPERM|EACCES|EBUSY)$/.test(String(result.code || '')),
        `the busy condition escaped as a raw platform error (${result.code}: ${result.message}) — ` +
          'the limiter would treat it as a broken backend and abandon the durable counter',
      );
      assert(
        /could not take the counter lock/.test(String(result.message || '')),
        `a busy lock must produce the module's own diagnosable error, got: ${result.message}`,
      );
      return `${result.code || 'error'}: ${result.message}`;
    } finally {
      try {
        holder.kill();
      } catch {
        /* ignore */
      }
    }
  });

  await t('W5e', 'the probe can fail: the OLD lock classification leaks the raw EPERM', async () => {
    // Put the old classification back — in a COPY. The repo is not touched.
    //
    // The copy KEEPS THE RELATIVE LAYOUT (site/shared/server/rate-limit.ts) and the
    // shared modules it imports are copied next to it, so the bundle can be
    // built: the rate limiter imports the libSQL counter and the store
    // access layer (wave 9). The same rule the session probe above follows —
    // "the module has to sit next to it or the bundle cannot be built".
    const mutatedDir = path.join(SANDBOX, 'mutated');
    const mutatedFile = path.join(mutatedDir, 'site', 'shared', 'server', 'rate-limit.ts');
    fs.mkdirSync(path.dirname(mutatedFile), { recursive: true });
    copyTree(path.join(REPO, 'site', 'shared'), path.join(mutatedDir, 'site', 'shared'));
    const source = fs.readFileSync(path.join(REPO, 'site', 'shared', 'server', 'rate-limit.ts'), 'utf8');
    const mutated = source.replace(
      "if (!LOCK_BUSY_CODES.has(code)) throw err;",
      "if (code !== 'EEXIST') throw err;",
    );
    assert(
      mutated !== source,
      'the mutation must actually change the lock classification',
    );
    fs.writeFileSync(mutatedFile, mutated, 'utf8');

    const outFile = path.join(BUNDLES, 'rate-limit-mut.cjs');
    await build({
      entryPoints: [mutatedFile],
      outfile: outFile,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      absWorkingDir: REPO,
      external: ['node:http', 'node:crypto', 'node:fs', 'node:path', 'node:stream'],
      logLevel: 'silent',
    });

    const counterFile = path.join(SANDBOX, 'busy-counter-mut.json');
    const lockPath = `${counterFile}.lock`;
    const holder = await spawnBusyLockHolder(lockPath);
    try {
      const result = hitWithBundle(outFile, counterFile);
      assert(!result.ok, 'the busy lock must not be taken');
      assert(
        /^(EPERM|EACCES|EBUSY)$/.test(String(result.code || '')),
        `the OLD classification must leak the raw platform error, got ${result.code}: ${result.message} ` +
          '— if it does not, the probe is vacuous',
      );
      return `${result.code}: ${result.message} — the old code leaks it (probe works)`;
    } finally {
      try {
        holder.kill();
      } catch {
        /* ignore */
      }
    }
  });

  // -- W6: fail closed --------------------------------------------------------
  group('W6 — no signing secret, no session (fail closed)');

  await t('W6a', 'a production instance without any secret mints no session', () => {
    const r = runChild(
      bundlePath('vercel-verify'),
      [
        {
          type: 'http',
          mode: 'vercel',
          method: 'GET',
          url: `/api/portal/auth/verify?token=${encodeURIComponent(magicToken)}&purpose=portal`,
          headers: { host: 'imk.test', origin: BASE },
        },
      ],
      { APP_ENV: 'production', PORTAL_MAGIC_LINK_SECRET: undefined, PORTAL_SESSION_SECRET: undefined },
    );
    assertEqual(r.out[0].status, 500, `the status (body ${r.out[0].raw})`);
    assertEqual(r.out[0].body.code, 'internal', 'the code');
    const cookie = sessionFromSetCookie(r.out[0].headers);
    assert(!cookie, 'no session cookie may be issued');
    return '500 {code:internal} and no session cookie';
  });

  await t('W6b', 'the Cloudflare tree fails closed too', () => {
    const r = runChild(
      bundlePath('cf-auth'),
      [
        {
          type: 'http',
          mode: 'cf',
          method: 'GET',
          url: `${BASE}/api/portal/auth/verify?token=${encodeURIComponent(magicToken)}&purpose=portal`,
          headers: { host: 'imk.test', origin: BASE },
        },
      ],
      {},
      {
        APP_ENV: 'production',
        SITE_BASE_URL: BASE,
        ADMIN_EMAILS: ADMIN_EMAIL,
      },
    );
    assertEqual(r.out[0].status, 500, `the status (body ${r.out[0].raw})`);
    assertEqual(r.out[0].body.code, 'internal', 'the code');
    const cookie = sessionFromSetCookie(r.out[0].headers);
    assert(!cookie, 'no session cookie may be issued');
    return '500 {code:internal} and no session cookie';
  });

  await t('W6c', 'a session minted with the magic-link secret as fallback still works', () => {
    // PORTAL_MAGIC_LINK_SECRET is the documented fallback for the session
    // secret, so a deployment configured with one secret still works.
    const r = runChild(
      bundlePath('vercel-verify'),
      [
        {
          type: 'http',
          mode: 'vercel',
          method: 'GET',
          url: `/api/portal/auth/verify?token=${encodeURIComponent(magicToken)}&purpose=portal`,
          headers: { host: 'imk.test', origin: BASE },
        },
      ],
      { APP_ENV: 'production', PORTAL_MAGIC_LINK_SECRET: SECRET, PORTAL_SESSION_SECRET: undefined },
    );
    assertEqual(r.out[0].status, 200, `the status (body ${r.out[0].raw})`);
    assert(sessionFromSetCookie(r.out[0].headers), 'a session cookie must be issued');
    return '200 — one secret is enough';
  });

  // -- summary ----------------------------------------------------------------
  const failed = results.filter((r) => r.status === 'FAIL');
  origLog(
    `\n[wave6] ${results.length - failed.length} passed, ${failed.length} failed, ${results.length} checks`,
  );
  if (failed.length) {
    origLog('[wave6] failing checks: ' + failed.map((f) => f.id).join(', '));
  }

  const artifact = path.join(SANDBOX, 'results.json');
  fs.writeFileSync(artifact, JSON.stringify(results, null, 2), 'utf8');
  origLog(`[wave6] results: ${artifact}`);

  if (!KEEP) {
    try {
      fs.rmSync(SANDBOX, { recursive: true, force: true });
      origLog('[wave6] sandbox removed');
    } catch {
      origLog('[wave6] sandbox left behind: ' + SANDBOX);
    }
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  origLog('[wave6] harness error', err);
  process.exit(1);
});
