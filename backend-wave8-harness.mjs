// backend-wave8-harness.mjs
//
// EXECUTED evidence for wave 8A — the audit's HIGH/MEDIUM findings and the
// owner-role endpoint:
//
//   H-1  a secret that is PRESENT but UNUSABLE (the published placeholder, or
//        shorter than 32 characters) is refused in production, exactly like a
//        missing one.
//   H-2  `APP_ENV=development` alone no longer switches the fail-closed
//        guards off: a deployment (NODE_ENV=production, VERCEL=1, or an
//        https:// base URL) fails loudly, never with a random fallback, and
//        never writes a token to the log.
//   M-1  a plain GET on the signed moderation link no longer flips the state.
//        The GET shows a confirmation page; the POST is the decision.
//   M-3  a session token whose expiry is beyond the maximum TTL is refused.
//   M-4  the owner gate is TWO parts: the role claim AND the live
//        ADMIN_EMAILS allow-list, so removing an address revokes the owner's
//        portal powers at once.
//   M-5  a live admin cookie can never widen a client's READ scope: the read
//        path resolves the CLIENT cookie first.
//   R    GET /api/portal/session — the server truth about the requester — in
//        BOTH trees, with the contract the Architect §4.2 and the Frontend
//        agreed on.
//
// EVERY CHECK HAS A MUTATION PROBE
//   Each check is run a second time against a MUTATED COPY of the tree in
//   the sandbox (the repository is never modified): the mutation undoes the
//   one line that closes the finding, and the check MUST go red. A check
//   that stays green against the mutation proves nothing.
//
// THE REPO IS NEVER TOUCHED
//   Every request runs in a child process whose cwd is a sandbox, so the
//   handlers resolve site/data/ inside the sandbox and the real store is
//   never read or written.
//
// USAGE
//   node backend-wave8-harness.mjs [--keep]

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = fs.existsSync(path.join(HERE, 'api', 'portal.ts')) ? HERE : path.resolve(HERE, '..');
const SITE = path.join(REPO, 'site');
const siteRequire = createRequire(path.join(SITE, 'package.json'));
const { build } = siteRequire('esbuild');

const KEEP = process.argv.includes('--keep');

// The origin the harness pretends to serve. HTTP on purpose: an https:// base
// URL is one of the three PRODUCTION signals (H-2), and the children have to
// be in development mode to reach the dev-only paths (a token written to the
// log). A real local dev server is http://localhost:4321.
const BASE = 'http://imk.test';
// At least 32 characters: H-1 refuses a shorter secret in production, and a
// fixture the rule would reject proves nothing.
const SECRET = 'wave8-harness-secret-0123456789abcd';
// The value that ships in site/.env.example — published in the repository.
const PLACEHOLDER = 'your-32-byte-hex-hmac-secret-here';

const CLIENT_EMAIL = 'client@imk.test';
const OWNER_EMAIL = 'owner@imk.test';
const CLIENT_ID = 'cli_w8';
const OTHER_CLIENT_ID = 'cli_other';

const results = [];
let currentGroup = '';
const origLog = console.log;

function group(name) {
  currentGroup = name;
  origLog(`\n[wave8] ${name}`);
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
    results.push({ id, group: currentGroup, name, status: 'PASS', detail: detail || '' });
    origLog(`  PASS  ${id}  ${name}\n          ${detail || ''}`);
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

/**
 * Run a check against a MUTATED bundle and require it to FAIL.
 *
 * A check that stays green against the mutation proves nothing, so this is
 * not a nicety: it is the proof that the check detects the defect it claims
 * to detect.
 */
async function probe(id, name, bundle, fn) {
  try {
    await fn(bundle);
    results.push({
      id,
      group: currentGroup,
      name,
      status: 'FAIL',
      error: 'the check stayed GREEN against the mutated copy — it does not detect the defect',
    });
    origLog(`  FAIL  ${id}  ${name}\n          the check stayed GREEN against the mutated copy`);
  } catch (err) {
    const detail = String(err && err.message ? err.message : err).split('\n')[0];
    results.push({ id, group: currentGroup, name, status: 'PASS', detail });
    origLog(`  PASS  ${id}  ${name}\n          the mutated copy answers: ${detail}`);
  }
}

// ---------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------

const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const SANDBOX = path.join(os.tmpdir(), 'opencode', 'wave8', STAMP);
const SANDBOX_PORTAL = path.join(SANDBOX, 'site', 'data', 'portal');
const SANDBOX_MODERATION = path.join(SANDBOX, 'site', 'data', 'moderation');
const BUNDLES = path.join(SANDBOX, 'bundles');
const CHILD_FILE = path.join(SANDBOX, 'child.cjs');

/**
 * The stores the handlers read.
 *
 * Two projects for TWO different clients: that is the M-5 fixture — a client
 * who owns ONE of them must see ONE, even with a live admin cookie in the
 * same browser.
 */
function writeStores() {
  fs.mkdirSync(SANDBOX_PORTAL, { recursive: true });
  fs.mkdirSync(SANDBOX_MODERATION, { recursive: true });

  fs.writeFileSync(
    path.join(SANDBOX_PORTAL, 'invited.jsonl'),
    JSON.stringify({
      id: 'inv_w8',
      email: CLIENT_EMAIL,
      name: 'Nora Named',
      company: 'Named Co',
      role: 'CTO',
      clientId: CLIENT_ID,
      createdAt: new Date().toISOString(),
    }) + '\n',
    'utf8',
  );

  fs.writeFileSync(
    path.join(SANDBOX_PORTAL, 'clients.jsonl'),
    JSON.stringify({
      id: CLIENT_ID,
      email: CLIENT_EMAIL,
      name: 'Nora Named',
      company: 'Named Co',
      role: 'CTO',
    }) + '\n',
    'utf8',
  );

  fs.writeFileSync(
    path.join(SANDBOX_PORTAL, 'projects.jsonl'),
    [
      JSON.stringify({
        id: 'prj_own',
        clientId: CLIENT_ID,
        title: 'The client own project',
        status: 'in-progress',
        startedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      }),
      JSON.stringify({
        id: 'prj_other',
        clientId: OTHER_CLIENT_ID,
        title: 'Another client project',
        status: 'in-progress',
        startedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      }),
    ].join('\n') + '\n',
    'utf8',
  );

  fs.writeFileSync(
    path.join(SANDBOX_MODERATION, 'reviews.jsonl'),
    JSON.stringify({
      type: 'review',
      ref: 'inq_w8',
      revision: 1,
      state: 'pending',
      review: 'A quote waiting for a decision',
      name: 'Nora',
    }) + '\n',
    'utf8',
  );
}

// ---------------------------------------------------------------------------
// Bundling — one entry point per function file, exactly like the deploy target
// ---------------------------------------------------------------------------

const BUNDLE_ENTRIES = {
  'vercel-session': path.join(REPO, 'site', 'shared', 'portal-handlers', 'portal-session.ts'),
  'vercel-projects': path.join(REPO, 'site', 'shared', 'portal-handlers', 'portal-projects.ts'),
  'vercel-moderate': path.join(REPO, 'api', 'moderate', 'review.ts'),
  'vercel-request-link': path.join(REPO, 'api', 'portal', 'auth', 'request-link.ts'),
  'cf-session': path.join(REPO, 'site', 'functions', 'api', 'portal', 'session.ts'),
  'cf-projects': path.join(REPO, 'site', 'functions', 'api', 'portal', 'projects.ts'),
  'shared-session': path.join(REPO, 'site', 'shared', 'server', 'portal-session.ts'),
  'shared-magic': path.join(REPO, 'site', 'shared', 'server', 'magic-link.ts'),
};

const EXTERNALS = ['node:http', 'node:crypto', 'node:fs', 'node:path', 'node:stream'];

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
      external: EXTERNALS,
      logLevel: 'silent',
    });
  }
}

function bundlePath(name) {
  return path.join(BUNDLES, `${name}.cjs`);
}

// ---------------------------------------------------------------------------
// The mutated trees (the repository is never modified)
// ---------------------------------------------------------------------------

function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) {
      continue;
    }
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(src, dst);
    else fs.copyFileSync(src, dst);
  }
}

/**
 * Build a mutated COPY of the tree.
 *
 * The copy keeps the directory layout, so the relative imports inside the
 * copied files still resolve — the mutated handler really imports the
 * mutated shared module.
 */
async function buildMutated(name, edits) {
  const root = path.join(SANDBOX, 'mut', name);
  fs.rmSync(root, { recursive: true, force: true });
  copyTree(path.join(REPO, 'api'), path.join(root, 'api'));
  copyTree(path.join(SITE, 'shared'), path.join(root, 'site', 'shared'));
  copyTree(path.join(SITE, 'functions'), path.join(root, 'site', 'functions'));

  for (const [rel, replacements] of Object.entries(edits)) {
    const file = path.join(root, rel);
    let text = fs.readFileSync(file, 'utf8');
    for (const [find, replace] of replacements) {
      assert(
        text.includes(find),
        `the mutation target must be present in ${rel}:\n${find}`,
      );
      text = text.replace(find, replace);
    }
    fs.writeFileSync(file, text, 'utf8');
  }
  return root;
}

async function bundleFrom(root, name, entryRel) {
  const out = path.join(BUNDLES, `${name}.cjs`);
  await build({
    entryPoints: [path.join(root, entryRel)],
    outfile: out,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    absWorkingDir: root,
    external: EXTERNALS,
    logLevel: 'silent',
  });
  return out;
}

// ---------------------------------------------------------------------------
// The child runner — one process per request (or per op list)
// ---------------------------------------------------------------------------

const CHILD = `
const { Readable } = require('node:stream');

// The Cloudflare code looks for \`globalThis.require\`. On the edge there is
// none, so the store cannot be read and the portal answers 501. This child
// runs as CommonJS, where \`require\` is module-scoped and globalThis.require
// is undefined — exactly like the edge — unless the harness asks for a
// filesystem.
if (process.env.W8_WITH_FS === '1') globalThis.require = require;
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
    const env = JSON.parse(process.env.W8_CF_ENV || '{}');
    const init = { method: op.method, headers: op.headers || {} };
    if (op.body && op.method !== 'GET' && op.method !== 'HEAD') init.body = op.body;
    const request = new Request(op.url, init);
    // The method-specific handler when there is one, the generic one
    // otherwise — a Cloudflare Pages Function that only exports onRequest
    // answers every method through it.
    const specific = 'onRequest' + op.method.charAt(0) + op.method.slice(1).toLowerCase();
    const handler = mod[specific] || mod.onRequest;
    if (typeof handler !== 'function') throw new Error('no handler for ' + op.method);
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
  const plan = JSON.parse(process.env.W8_PLAN || '{}');
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

function runChild(bundle, ops, env = {}, cfEnv = null, withFs = true) {
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
    'NODE_ENV',
    'VERCEL',
  ]) {
    delete childEnv[key];
  }
  childEnv.APP_ENV = 'development';
  childEnv.SITE_BASE_URL = BASE;
  childEnv.ADMIN_EMAILS = OWNER_EMAIL;
  childEnv.PORTAL_SESSION_SECRET = SECRET;
  childEnv.PORTAL_MAGIC_LINK_SECRET = SECRET;
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete childEnv[k];
    else childEnv[k] = String(v);
  }
  childEnv.W8_WITH_FS = withFs ? '1' : '0';
  childEnv.W8_PLAN = JSON.stringify({ bundle, ops });
  childEnv.W8_CF_ENV = JSON.stringify(
    cfEnv || {
      APP_ENV: childEnv.APP_ENV,
      SITE_BASE_URL: childEnv.SITE_BASE_URL,
      ADMIN_EMAILS: childEnv.ADMIN_EMAILS,
      PORTAL_SESSION_SECRET: childEnv.PORTAL_SESSION_SECRET,
      PORTAL_MAGIC_LINK_SECRET: childEnv.PORTAL_MAGIC_LINK_SECRET,
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Mint a session token exactly the way the module does — with a chosen
 * expiry, so a token that outlives the TTL can be produced on purpose.
 */
function mintSession(email, role, clientId, expMs, secret = SECRET) {
  const payload = { e: email, r: role, x: expMs };
  if (clientId) payload.c = clientId;
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8')
    .toString('base64url')
    .replace(/=+$/, '');
  const sig = crypto
    .createHmac('sha256', secret)
    .update(`v1.${payloadB64}`)
    .digest('hex');
  return `v1.${payloadB64}.${sig}`;
}

function signModeration(ref, decision, revision, ts, secret = SECRET) {
  return crypto
    .createHmac('sha256', secret)
    .update(`${ref}|${decision}|${revision}|${ts}`)
    .digest('hex');
}

function moderationUrl(ref = 'inq_w8', decision = 'approve', revision = 1, secret = SECRET) {
  const ts = Math.floor(Date.now() / 1000);
  const sig = signModeration(ref, decision, revision, ts, secret);
  return `/api/moderate/review?ref=${ref}&decision=${decision}&revision=${revision}&sig=${sig}&ts=${ts}`;
}

function cookieHeader(...values) {
  return values.filter(Boolean).join('; ');
}

function clientCookie() {
  return `imk_session=${mintSession(CLIENT_EMAIL, 'client', CLIENT_ID, Date.now() + 3600_000)}`;
}

function adminCookie(email = OWNER_EMAIL) {
  return `imk_admin_session=${mintSession(email, 'admin', undefined, Date.now() + 3600_000)}`;
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

/**
 * H-1 — a secret that is present but UNUSABLE is refused in production.
 *
 * The fixture is a link signed WITH the published placeholder as the key: if
 * the placeholder were accepted, the link would verify and the endpoint would
 * answer 200. Refused, it answers 500 — exactly like a missing secret.
 */
async function checkH1(bundle = bundlePath('vercel-moderate')) {
  const r = runChild(
    bundle,
    [
      {
        type: 'http',
        mode: 'vercel',
        method: 'GET',
        url: moderationUrl('inq_w8', 'approve', 1, PLACEHOLDER),
        headers: { host: 'imk.test' },
      },
    ],
    {
      APP_ENV: 'production',
      SITE_BASE_URL: BASE,
      FORM_WEBHOOK_SECRET: PLACEHOLDER,
    },
  );
  assertEqual(r.out[0].status, 500, 'the status');
  assertEqual(r.out[0].body.code, 'internal', 'the code');
  return '500 {code:internal} — the published placeholder is refused like a missing secret';
}

/**
 * H-1b — the session and the magic-link secret, same rule, same module.
 */
async function checkH1b(bundle = bundlePath('shared-session')) {
  const r = runChild(
    bundle,
    [
      {
        type: 'call',
        export: 'sessionSecret',
        args: [{ APP_ENV: 'production', PORTAL_SESSION_SECRET: PLACEHOLDER }],
      },
      {
        type: 'call',
        export: 'sessionSecret',
        args: [{ APP_ENV: 'production', PORTAL_SESSION_SECRET: 'too-short' }],
      },
      {
        type: 'call',
        export: 'sessionSecret',
        args: [{ APP_ENV: 'production', PORTAL_SESSION_SECRET: SECRET }],
      },
    ],
    {},
  );
  assertEqual(r.out[0].value, null, 'the published placeholder must be refused');
  assertEqual(r.out[1].value, null, 'a secret under 32 characters must be refused');
  assertEqual(r.out[2].value, SECRET, 'a real secret must be accepted');
  return 'placeholder -> null, too short -> null, a real secret -> accepted';
}

/**
 * H-2 — APP_ENV=development alone must not switch the guards off.
 */
async function checkH2(bundle = bundlePath('vercel-request-link')) {
  const r = runChild(
    bundle,
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
          'x-forwarded-for': '198.51.100.11',
        },
        body: JSON.stringify({ email: CLIENT_EMAIL }),
      },
    ],
    {
      APP_ENV: 'development',
      VERCEL: '1',
      SITE_BASE_URL: BASE,
      PORTAL_MAGIC_LINK_SECRET: SECRET,
      PORTAL_SESSION_SECRET: SECRET,
    },
  );
  assertEqual(r.out[0].status, 500, 'the status (a deployed instance must fail loudly)');
  assertEqual(r.out[0].body.code, 'internal', 'the code');
  const logged = r.logs.some((l) => l && l.outcome === 'magic_link_dev');
  assert(!logged, 'a deployed instance must never write a sign-in token to the log');
  return 'APP_ENV=development + VERCEL=1 -> 500 {code:internal}, no token in the log';
}

/**
 * M-1 — a plain GET on the signed moderation link must not flip the state.
 */
async function checkM1(bundle = bundlePath('vercel-moderate')) {
  const r = runChild(
    bundle,
    [
      {
        type: 'http',
        mode: 'vercel',
        method: 'GET',
        url: moderationUrl(),
        headers: { host: 'imk.test' },
      },
    ],
    { FORM_WEBHOOK_SECRET: SECRET },
  );
  assertEqual(r.out[0].status, 200, 'the status');
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
}

/**
 * M-3 — a session token whose expiry is beyond the maximum TTL is refused.
 */
async function checkM3(bundle = bundlePath('vercel-projects')) {
  const longLived = `imk_session=${mintSession(
    CLIENT_EMAIL,
    'client',
    CLIENT_ID,
    Date.now() + 365 * 24 * 3600_000,
  )}`;
  const r = runChild(
    bundle,
    [
      {
        type: 'http',
        mode: 'vercel',
        method: 'GET',
        url: '/api/portal/projects',
        headers: { host: 'imk.test', origin: BASE, cookie: longLived },
      },
    ],
    {},
  );
  assertEqual(r.out[0].status, 401, 'a token that outlives the TTL must be refused');
  assertEqual(r.out[0].body.code, 'unauthorized', 'the code');
  return '401 {code:unauthorized} — a token valid until the year 3000 is refused';
}

/**
 * M-4 — the owner gate is the role claim AND the live allow-list.
 */
async function checkM4(bundle = bundlePath('vercel-projects')) {
  const r = runChild(
    bundle,
    [
      {
        type: 'http',
        mode: 'vercel',
        method: 'PATCH',
        url: '/api/portal/projects/prj_other',
        headers: {
          host: 'imk.test',
          origin: BASE,
          cookie: adminCookie(),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ status: 'review' }),
      },
    ],
    { ADMIN_EMAILS: 'somebody-else@imk.test' },
  );
  assertEqual(r.out[0].status, 403, 'an address that is off the allow-list must be refused');
  assertEqual(r.out[0].body.code, 'forbidden', 'the code');
  const projects = fs
    .readFileSync(path.join(SANDBOX_PORTAL, 'projects.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  const other = projects.find((p) => p.id === 'prj_other');
  assertEqual(other.status, 'in-progress', 'the project must be untouched');
  return '403 {code:forbidden} and the project is unchanged';
}

/**
 * M-5 — a live admin cookie must never widen a client's read scope.
 */
async function checkM5(bundle = bundlePath('vercel-projects')) {
  const r = runChild(
    bundle,
    [
      {
        type: 'http',
        mode: 'vercel',
        method: 'GET',
        url: '/api/portal/projects',
        headers: {
          host: 'imk.test',
          origin: BASE,
          cookie: cookieHeader(clientCookie(), adminCookie()),
        },
      },
    ],
    {},
  );
  assertEqual(r.out[0].status, 200, 'the status');
  const projects = (r.out[0].body && r.out[0].body.projects) || [];
  assertEqual(projects.length, 1, 'the number of projects a client may read');
  assertEqual(projects[0].id, 'prj_own', 'the project a client may read');
  return '1 of 2 — the client sees only its own project, admin cookie present';
}

/**
 * R — GET /api/portal/session answers the server truth about the requester.
 */
async function checkRoute(bundle = bundlePath('vercel-session')) {
  const r = runChild(
    bundle,
    [
      {
        type: 'http',
        mode: 'vercel',
        method: 'GET',
        url: '/api/portal/session',
        headers: { host: 'imk.test', cookie: clientCookie() },
      },
    ],
    {},
  );
  assertEqual(r.out[0].status, 200, 'the status');
  assertEqual(r.out[0].body.ok, true, 'ok');
  assertEqual(r.out[0].body.role, 'client', 'the role');
  assertEqual(r.out[0].body.email, CLIENT_EMAIL, 'the email');
  assertEqual(r.out[0].body.clientId, CLIENT_ID, 'the clientId');
  assert(
    typeof r.out[0].body.expiresAt === 'number',
    'expiresAt must be the signed expiry',
  );
  return '200 {ok:true, role:client, email, clientId, expiresAt}';
}

/**
 * R-CF — the Cloudflare twin answers the same.
 */
async function checkRouteCf(bundle = bundlePath('cf-session')) {
  const r = runChild(
    bundle,
    [
      {
        type: 'http',
        mode: 'cf',
        method: 'GET',
        url: 'https://imk.test/api/portal/session',
        headers: { cookie: clientCookie() },
      },
    ],
    {},
    {
      APP_ENV: 'production',
      SITE_BASE_URL: 'https://imk.test',
      ADMIN_EMAILS: OWNER_EMAIL,
      PORTAL_SESSION_SECRET: SECRET,
      PORTAL_MAGIC_LINK_SECRET: SECRET,
    },
  );
  assertEqual(r.out[0].status, 200, 'the status');
  assertEqual(r.out[0].body.role, 'client', 'the role');
  assertEqual(r.out[0].body.email, CLIENT_EMAIL, 'the email');
  return '200 {role:client} — the edge twin answers the same';
}

async function main() {
  origLog(`[wave8] sandbox: ${SANDBOX}`);
  fs.mkdirSync(SANDBOX, { recursive: true });
  writeStores();
  await bundleAll();

  // -- H-1 -------------------------------------------------------------------
  group('H-1 — a secret that is PRESENT but UNUSABLE is refused');

  await t('H1a', 'the published placeholder is refused in production', () => checkH1());

  await t('H1b', 'the session and magic-link secrets obey the same rule', () => checkH1b());

  await t('H1c', 'the probe can fail: with the value check removed the placeholder passes', async () => {
    const root = await buildMutated('h1', {
      'site/shared/server/secret.ts': [
        [
          "  if (PUBLISHED_SECRET_PLACEHOLDERS.includes(raw.toLowerCase())) return 'placeholder';",
          "  if (false) return 'placeholder';",
        ],
        [
          "  if (raw.length < MIN_SECRET_LENGTH) return 'too-short';",
          "  if (false) return 'too-short';",
        ],
      ],
    });
    const moderate = await bundleFrom(
      root,
      'mut-h1-moderate',
      path.join('api', 'moderate', 'review.ts'),
    );
    const session = await bundleFrom(
      root,
      'mut-h1-session',
      path.join('site', 'shared', 'server', 'portal-session.ts'),
    );
    await probe('H1c', 'the probe can fail (the moderation endpoint)', moderate, () =>
      checkH1(moderate),
    );
    await probe('H1c', 'the probe can fail (the session secret)', session, () =>
      checkH1b(session),
    );
    return 'the mutated copy accepts the published placeholder — the probe works';
  });

  // -- H-2 -------------------------------------------------------------------
  group('H-2 — APP_ENV=development alone no longer disables the guards');

  await t('H2a', 'a deployed instance (VERCEL=1) fails loudly and logs no token', () => checkH2());

  await t('H2b', 'an https:// base URL is a deployment too', async () => {
    const r = runChild(
      bundlePath('vercel-request-link'),
      [
        {
          type: 'http',
          mode: 'vercel',
          method: 'POST',
          url: '/api/portal/auth/request-link',
          headers: {
            host: 'imk.test',
            origin: 'https://imk.test',
            'content-type': 'application/json',
            'x-forwarded-for': '198.51.100.12',
          },
          body: JSON.stringify({ email: CLIENT_EMAIL }),
        },
      ],
      {
        APP_ENV: 'development',
        SITE_BASE_URL: 'https://imk.test',
        PORTAL_MAGIC_LINK_SECRET: SECRET,
        PORTAL_SESSION_SECRET: SECRET,
      },
    );
    assertEqual(r.out[0].status, 500, 'the status');
    assertEqual(r.out[0].body.code, 'internal', 'the code');
    const logged = r.logs.some((l) => l && l.outcome === 'magic_link_dev');
    assert(!logged, 'no token may be written to the log');
    return 'APP_ENV=development + https:// base URL -> 500 {code:internal}, no token in the log';
  });

  await t('H2c', 'the probe can fail: with the old production rule the token is logged', async () => {
    const root = await buildMutated('h2', {
      'site/shared/server/portal-session.ts': [
        [
          "  if (appEnv !== 'development') return true; // unset, 'production' or unknown -> production",
          "  if (false) return true;",
        ],
        [
          "  if (String(e.NODE_ENV || '').trim().toLowerCase() === 'production') return true;",
          "  if (false) return true;",
        ],
        [
          "  if (String(e.VERCEL || '').trim() === '1') return true;",
          "  if (false) return true;",
        ],
        [
          "  if (base.startsWith('https://')) return true;",
          "  if (false) return true;",
        ],
      ],
    });
    const bundle = await bundleFrom(
      root,
      'mut-h2-request-link',
      path.join('api', 'portal', 'auth', 'request-link.ts'),
    );
    await probe('H2c', 'the mutation probe', bundle, () => checkH2(bundle));
    return 'the mutated copy logs the token — the probe works';
  });

  // -- M-1 -------------------------------------------------------------------
  group('M-1 — a GET on the moderation link decides nothing');

  await t('M1a', 'a GET shows the confirmation page and changes nothing', () => checkM1());

  await t('M1b', 'the POST is the decision, and it is stored', async () => {
    const r = runChild(
      bundlePath('vercel-moderate'),
      [
        {
          type: 'http',
          mode: 'vercel',
          method: 'POST',
          url: moderationUrl(),
          headers: { host: 'imk.test', 'content-type': 'application/x-www-form-urlencoded' },
          body: '',
        },
      ],
      { FORM_WEBHOOK_SECRET: SECRET },
    );
    assertEqual(r.out[0].status, 200, 'the status');
    assertEqual(r.out[0].body.state, 'approved', 'the state');
    const stored = fs
      .readFileSync(path.join(SANDBOX_MODERATION, 'reviews.jsonl'), 'utf8')
      .trim();
    assert(stored.includes('"approved"'), 'the decision must be on disk');
    return '200 {state:approved} and the decision is on disk';
  });

  await t('M1c', 'the probe can fail: with the old GET the link approves on its own', async () => {
    const root = await buildMutated('m1', {
      'api/moderate/review.ts': [
        [
          "  if (method === 'GET') {",
          "  if (false) {",
        ],
      ],
    });
    const bundle = await bundleFrom(
      root,
      'mut-m1-moderate',
      path.join('api', 'moderate', 'review.ts'),
    );
    await probe('M1c', 'the mutation probe', bundle, () => checkM1(bundle));
    return 'the mutated copy approves on a plain GET — the probe works';
  });

  // -- M-3 -------------------------------------------------------------------
  group('M-3 — a session token may not outlive the TTL');

  await t('M3a', 'a token valid until the year 3000 is refused', () => checkM3());

  await t('M3b', 'the probe can fail: without the cap the token is accepted', async () => {
    const root = await buildMutated('m3', {
      'site/shared/server/portal-session.ts': [
        [
          '  if (payload.x - Date.now() > SESSION_TTL_MS + CLOCK_SKEW_MS) return null;',
          '  if (false) return null;',
        ],
      ],
    });
    const bundle = await bundleFrom(
      root,
      'mut-m3-projects',
      path.join('site', 'shared', 'portal-handlers', 'portal-projects.ts'),
    );
    await probe('M3b', 'the mutation probe', bundle, () => checkM3(bundle));
    return 'the mutated copy accepts the long-lived token — the probe works';
  });

  // -- M-4 -------------------------------------------------------------------
  group('M-4 — the owner gate is the role claim AND the live allow-list');

  await t('M4a', 'an address taken off ADMIN_EMAILS loses the portal powers at once', () =>
    checkM4());

  await t('M4b', 'an address that IS on the allow-list still works', async () => {
    const r = runChild(
      bundlePath('vercel-projects'),
      [
        {
          type: 'http',
          mode: 'vercel',
          method: 'PATCH',
          url: '/api/portal/projects/prj_other',
          headers: {
            host: 'imk.test',
            origin: BASE,
            cookie: adminCookie(),
            'content-type': 'application/json',
          },
          body: JSON.stringify({ status: 'review' }),
        },
      ],
      { ADMIN_EMAILS: OWNER_EMAIL },
    );
    assertEqual(r.out[0].status, 200, 'the status');
    assertEqual(r.out[0].body.project.status, 'review', 'the stored status');
    return '200 — the allow-listed owner may still act';
  });

  await t('M4c', 'the probe can fail: with the role claim alone the owner still wins', async () => {
    const root = await buildMutated('m4', {
      'site/shared/portal-handlers/portal-projects.ts': [
        [
          "    const owner = resolveOwnerSession(req, process.env);\n    if (!owner) {",
          "    const owner = session.role === 'admin' ? session : null;\n    if (!owner) {",
        ],
      ],
    });
    const bundle = await bundleFrom(
      root,
      'mut-m4-projects',
      path.join('site', 'shared', 'portal-handlers', 'portal-projects.ts'),
    );
    await probe('M4c', 'the mutation probe', bundle, () => checkM4(bundle));
    return 'the mutated copy accepts the removed address — the probe works';
  });

  // -- M-5 -------------------------------------------------------------------
  group('M-5 — a live admin cookie never widens a client read scope');

  await t('M5a', 'a client with a live admin cookie sees only its own project', () => checkM5());

  await t('M5b', 'the owner (no client cookie) still sees every project', async () => {
    const r = runChild(
      bundlePath('vercel-projects'),
      [
        {
          type: 'http',
          mode: 'vercel',
          method: 'GET',
          url: '/api/portal/projects',
          headers: { host: 'imk.test', origin: BASE, cookie: adminCookie() },
        },
      ],
      {},
    );
    assertEqual(r.out[0].status, 200, 'the status');
    const projects = (r.out[0].body && r.out[0].body.projects) || [];
    assertEqual(projects.length, 2, 'the number of projects the owner may read');
    return '2 of 2 — the owner reads every project';
  });

  await t('M5c', 'the probe can fail: with the owner gate widening the read again', async () => {
    // The old rule was "the session that resolves decides the scope", and
    // the admin cookie resolved first. This mutation puts the owner gate
    // back in front of the client scope — the shape of the old defect.
    const root = await buildMutated('m5', {
      'site/shared/server/portal-session.ts': [
        [
          'export function canReadClient(access: RequestAccess, clientId?: string): boolean {\n  if (access.client) {',
          'export function canReadClient(access: RequestAccess, clientId?: string): boolean {\n  if (access.owner) return true;\n  if (access.client) {',
        ],
      ],
    });
    const bundle = await bundleFrom(
      root,
      'mut-m5-projects',
      path.join('site', 'shared', 'portal-handlers', 'portal-projects.ts'),
    );
    await probe('M5c', 'the mutation probe', bundle, () => checkM5(bundle));
    return 'the mutated copy widens the read scope to 2 of 2 — the probe works';
  });

  // -- R ---------------------------------------------------------------------
  group('R — GET /api/portal/session, the server truth, in BOTH trees');

  await t('R1a', 'a client session answers 200 with the role and the expiry', () => checkRoute());

  await t('R1b', 'an allow-listed owner answers role:admin', async () => {
    const r = runChild(
      bundlePath('vercel-session'),
      [
        {
          type: 'http',
          mode: 'vercel',
          method: 'GET',
          url: '/api/portal/session',
          headers: { host: 'imk.test', cookie: adminCookie() },
        },
      ],
      {},
    );
    assertEqual(r.out[0].status, 200, 'the status');
    assertEqual(r.out[0].body.role, 'admin', 'the role');
    return '200 {role:admin}';
  });

  await t('R1c', 'an owner whose address left the allow-list is downgraded to client', async () => {
    const r = runChild(
      bundlePath('vercel-session'),
      [
        {
          type: 'http',
          mode: 'vercel',
          method: 'GET',
          url: '/api/portal/session',
          headers: { host: 'imk.test', cookie: adminCookie() },
        },
      ],
      { ADMIN_EMAILS: 'somebody-else@imk.test' },
    );
    assertEqual(r.out[0].status, 200, 'the status');
    assertEqual(r.out[0].body.role, 'client', 'the role');
    return '200 {role:client} — the owner powers are gone, the session is not';
  });

  await t('R1d', 'a browser with both cookies is a client here', async () => {
    const r = runChild(
      bundlePath('vercel-session'),
      [
        {
          type: 'http',
          mode: 'vercel',
          method: 'GET',
          url: '/api/portal/session',
          headers: {
            host: 'imk.test',
            cookie: cookieHeader(clientCookie(), adminCookie()),
          },
        },
      ],
      {},
    );
    assertEqual(r.out[0].status, 200, 'the status');
    assertEqual(r.out[0].body.role, 'client', 'the role');
    return '200 {role:client} — the client cookie wins, exactly like the read scope';
  });

  await t('R1e', 'no session answers 401 {code:unauthorized}', async () => {
    const r = runChild(
      bundlePath('vercel-session'),
      [
        {
          type: 'http',
          mode: 'vercel',
          method: 'GET',
          url: '/api/portal/session',
          headers: { host: 'imk.test' },
        },
      ],
      {},
    );
    assertEqual(r.out[0].status, 401, 'the status');
    assertEqual(r.out[0].body.code, 'unauthorized', 'the code');
    return '401 {code:unauthorized}';
  });

  await t('R1f', 'a wrong method answers 405, not 404', async () => {
    const r = runChild(
      bundlePath('vercel-session'),
      [
        {
          type: 'http',
          mode: 'vercel',
          method: 'POST',
          url: '/api/portal/session',
          headers: { host: 'imk.test' },
        },
      ],
      {},
    );
    assertEqual(r.out[0].status, 405, 'the status');
    assertEqual(r.out[0].body.code, 'method', 'the code');
    return '405 {code:method}';
  });

  await t('R1g', 'ADMIN_EMAILS unset answers 500 {code:internal}', async () => {
    const r = runChild(
      bundlePath('vercel-session'),
      [
        {
          type: 'http',
          mode: 'vercel',
          method: 'GET',
          url: '/api/portal/session',
          headers: { host: 'imk.test', cookie: clientCookie() },
        },
      ],
      { ADMIN_EMAILS: '' },
    );
    assertEqual(r.out[0].status, 500, 'the status');
    assertEqual(r.out[0].body.code, 'internal', 'the code');
    return '500 {code:internal} — a misconfigured instance says so';
  });

  await t('R1h', 'the Cloudflare twin answers the same', () => checkRouteCf());

  await t('R1i', 'the Cloudflare twin refuses a wrong method with 405 too', async () => {
    const r = runChild(
      bundlePath('cf-session'),
      [
        {
          type: 'http',
          mode: 'cf',
          method: 'POST',
          url: 'https://imk.test/api/portal/session',
          headers: { cookie: clientCookie() },
        },
      ],
      {},
      {
        APP_ENV: 'production',
        SITE_BASE_URL: 'https://imk.test',
        ADMIN_EMAILS: OWNER_EMAIL,
        PORTAL_SESSION_SECRET: SECRET,
        PORTAL_MAGIC_LINK_SECRET: SECRET,
      },
    );
    assertEqual(r.out[0].status, 405, 'the status');
    assertEqual(r.out[0].body.code, 'method', 'the code');
    return '405 {code:method} — the two trees agree';
  });

  await t('R1j', 'the probe can fail: with the route gone the URL answers 404', async () => {
    const root = await buildMutated('route', {
      'site/shared/portal-handlers/portal-session.ts': [
        [
          'export default function (\n  req: IncomingMessage,\n  res: ServerResponse,\n): Promise<void> {\n  return handler(req, res);\n}',
          'export default function (\n  req: IncomingMessage,\n  res: ServerResponse,\n): Promise<void> {\n  json(res, { error: \'not found\', code: \'not-found\' }, 404);\n}',
        ],
      ],
    });
    const bundle = await bundleFrom(
      root,
      'mut-route-session',
      path.join('site', 'shared', 'portal-handlers', 'portal-session.ts'),
    );
    await probe('R1j', 'the mutation probe', bundle, () => checkRoute(bundle));
    return 'the mutated copy answers 404 — the probe works';
  });

  // -- the summary ----------------------------------------------------------
  const failed = results.filter((r) => r.status === 'FAIL');
  origLog('');
  origLog(`[wave8] ${results.length - failed.length} passed, ${failed.length} failed, ${results.length} checks`);
  if (failed.length) {
    origLog(`[wave8] failing checks: ${failed.map((r) => r.id).join(', ')}`);
  }
  const resultsFile = path.join(SANDBOX, 'results.json');
  fs.writeFileSync(resultsFile, JSON.stringify(results, null, 2), 'utf8');
  origLog(`[wave8] results: ${resultsFile}`);

  if (!KEEP) fs.rmSync(SANDBOX, { recursive: true, force: true });
  else origLog(`[wave8] sandbox kept: ${SANDBOX}`);

  process.exitCode = failed.length ? 1 : 0;
}

main().catch((err) => {
  origLog('[wave8] the harness itself failed:');
  origLog(String(err && err.stack ? err.stack : err));
  process.exitCode = 1;
});
