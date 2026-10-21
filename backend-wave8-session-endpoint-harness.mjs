// backend-wave8-session-endpoint-harness.mjs
//
// EXECUTED evidence for wave 8A: GET /api/portal/session.
//
// WHAT THIS PROVES (by running the REAL handlers, not by reading them)
//   S  the route contract in BOTH trees — the Vercel handler
//      (api/portal/session.ts) and the Cloudflare twin
//      (site/functions/api/portal/session.ts):
//        200 {ok, authenticated, role}   a signed-in requester
//        401 {code:'unauthorized'}       nobody is signed in
//        405 + Allow: GET                 the wrong method
//        500 {code:'internal'}           the deployment is misconfigured
//   M-4  the role is the token claim AND the LIVE ADMIN_EMAILS allow-list:
//        an owner whose address was taken off the list is answered `client`
//        at once, not at the next token expiry.
//   M-5  the CLIENT cookie is resolved first: a browser that holds both
//        cookies is a client here, so the answer the UI paints and the scope
//        the read endpoints use can never disagree.
//   M-3  a token whose expiry is beyond the maximum TTL is refused.
//   H-1/H-2  in production a missing, placeholder or too-short signing secret
//        is a LOUD 500, never a per-process random fallback and never the
//        silent 401 that made the F-2 symptom invisible.
//   P   PARITY: for every scenario the two trees answer the same status and
//        the same body — the two trees cannot drift.
//
// THE MUTATION PROBES (D)
//   Every fix is reverted in a COPY (in a sandbox, never in the repo) and the
//   same assertions are re-run against the mutated build. A probe that does not
//   redden proves the assertion is not actually testing the fix.
//
// THE REPO IS NEVER TOUCHED
//   Every handler is built from a COPY of the tree in a temp sandbox. The
//   relative import layout is preserved exactly, so `api/portal/session.ts`
//   still finds `../../site/shared/server/portal-session.js` and the Cloudflare
//   twin still finds `../../../shared/server/portal-session.js`.
//
// USAGE
//   node backend-wave8-session-endpoint-harness.mjs [--keep]

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = fs.existsSync(path.join(HERE, 'api', 'portal', 'auth.ts')) ? HERE : path.resolve(HERE, '..');
const SITE = path.join(REPO, 'site');
const siteRequire = createRequire(path.join(SITE, 'package.json'));
const { build } = siteRequire('esbuild');

const KEEP = process.argv.includes('--keep');

// 45 characters: H-1 refuses a secret shorter than 32 in production.
const SECRET = 'wave8-session-harness-secret-0123456789abcdef';
const ADMIN_EMAIL = 'owner@imk.test';
const CLIENT_EMAIL = 'client@imk.test';
const CLIENT_ID = 'cli_w8';
const BASE = 'http://imk.test';

const ENV_KEYS = [
  'APP_ENV',
  'NODE_ENV',
  'VERCEL',
  'SITE_BASE_URL',
  'ADMIN_EMAILS',
  'PORTAL_SESSION_SECRET',
  'PORTAL_MAGIC_LINK_SECRET',
];

const results = [];
let currentGroup = '';
const origLog = console.log;

function group(name) {
  currentGroup = name;
  origLog(`\n[wave8-session] ${name}`);
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
const SANDBOX = path.join(os.tmpdir(), 'opencode', 'wave8-session', STAMP);
const BUNDLES = path.join(SANDBOX, 'bundles');

const SRC = {
  shared: path.join(SITE, 'shared', 'server', 'portal-session.ts'),
  sharedDir: path.join(SITE, 'shared', 'server'),
  vercel: path.join(REPO, 'api', 'portal', 'session.ts'),
  cf: path.join(REPO, 'site', 'functions', 'api', 'portal', 'session.ts'),
};

/**
 * Write a copy of the tree into `dir`, preserving the relative layout so the
 * relative imports resolve exactly as they do in the repo.
 *
 * `overrides` may replace the shared module and/or either endpoint.
 */
function writeTree(dir, overrides = {}) {
  const sharedDir = path.join(dir, 'site', 'shared', 'server');
  fs.mkdirSync(sharedDir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'api', 'portal'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'site', 'functions', 'api', 'portal'), { recursive: true });

  for (const name of fs.readdirSync(SRC.sharedDir)) {
    if (!name.endsWith('.ts')) continue;
    fs.writeFileSync(
      path.join(sharedDir, name),
      fs.readFileSync(path.join(SRC.sharedDir, name), 'utf8'),
      'utf8',
    );
  }
  fs.writeFileSync(
    path.join(sharedDir, 'portal-session.ts'),
    overrides.shared ?? fs.readFileSync(SRC.shared, 'utf8'),
    'utf8',
  );
  fs.writeFileSync(
    path.join(dir, 'api', 'portal', 'session.ts'),
    overrides.vercel ?? fs.readFileSync(SRC.vercel, 'utf8'),
    'utf8',
  );
  fs.writeFileSync(
    path.join(dir, 'site', 'functions', 'api', 'portal', 'session.ts'),
    overrides.cf ?? fs.readFileSync(SRC.cf, 'utf8'),
    'utf8',
  );
}

async function bundleTree(dir, tag) {
  fs.mkdirSync(BUNDLES, { recursive: true });
  const vercelOut = path.join(BUNDLES, `${tag}-vercel.cjs`);
  const cfOut = path.join(BUNDLES, `${tag}-cf.cjs`);
  const opts = {
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['node:http', 'node:crypto', 'node:fs', 'node:path', 'node:stream'],
    logLevel: 'silent',
  };
  await build({ ...opts, entryPoints: [path.join(dir, 'api', 'portal', 'session.ts')], outfile: vercelOut });
  await build({
    ...opts,
    entryPoints: [path.join(dir, 'site', 'functions', 'api', 'portal', 'session.ts')],
    outfile: cfOut,
  });
  return { vercel: vercelOut, cf: cfOut };
}

// ---------------------------------------------------------------------------
// The request drivers
// ---------------------------------------------------------------------------

function makeReq(method, url, headers) {
  const req = Readable.from([]);
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

function applyProcessEnv(env) {
  for (const key of ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || value === null) continue;
    process.env[key] = String(value);
  }
}

/** Call the Vercel handler (node:http style). */
async function callVercel(bundle, { method = 'GET', cookie = null, env = {} }) {
  applyProcessEnv(env);
  const mod = require(bundle);
  const headers = cookie ? { cookie } : {};
  const req = makeReq(method, `${BASE}/api/portal/session`, headers);
  const res = makeRes();
  await mod.default(req, res);
  let body = null;
  try {
    body = JSON.parse(res.body || 'null');
  } catch {
    body = null;
  }
  return { status: res.statusCode, body, headers: res.headers, raw: res.body };
}

/** Call the Cloudflare twin (Worker style). */
async function callCf(bundle, { method = 'GET', cookie = null, env = {} }) {
  const mod = require(bundle);
  const clean = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || value === null) continue;
    clean[key] = String(value);
  }
  const headers = cookie ? { cookie } : {};
  const request = new Request(`${BASE}/api/portal/session`, { method, headers });
  const handler = method === 'GET' ? mod.onRequestGet : mod.onRequest;
  const response = await handler({ request, env: clean });
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text || 'null');
  } catch {
    body = null;
  }
  const outHeaders = {};
  response.headers.forEach((value, key) => {
    outHeaders[key] = value;
  });
  return { status: response.status, body, headers: outHeaders, raw: text };
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

/**
 * Craft a token the way the module does — `v1.<base64url(payload)>.<hexsig>`.
 *
 * The HMAC is node:crypto's, NOT the module's own implementation, so the
 * tokens here are accepted only if the module's implementation really is a
 * standard HMAC-SHA256 over `v1.<payload>`.
 */
function craftToken(payload, secret = SECRET) {
  const b64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(`v1.${b64}`).digest('hex');
  return `v1.${b64}.${sig}`;
}

function cookieHeader(cookies) {
  return Object.entries(cookies)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

const now = Date.now();
const TTL = 24 * 60 * 60 * 1000;

const TOKENS = {
  admin: craftToken({ e: ADMIN_EMAIL, r: 'admin', x: now + TTL }),
  client: craftToken({ e: CLIENT_EMAIL, r: 'client', c: CLIENT_ID, x: now + TTL }),
  // Signed with the right key, but the address is not on the allow-list.
  adminOffList: craftToken({ e: 'not-the-owner@imk.test', r: 'admin', x: now + TTL }),
  expired: craftToken({ e: ADMIN_EMAIL, r: 'admin', x: now - 60_000 }),
  // M-3: claims to be valid for 30 days.
  tooLong: craftToken({ e: ADMIN_EMAIL, r: 'admin', x: now + 30 * TTL }),
  forged: craftToken({ e: ADMIN_EMAIL, r: 'admin', x: now + TTL }, 'a-different-secret-entirely'),
};

// ---------------------------------------------------------------------------
// The scenarios — the same list is run against BOTH trees
// ---------------------------------------------------------------------------

const BASE_ENV = {
  ADMIN_EMAILS: ADMIN_EMAIL,
  PORTAL_SESSION_SECRET: SECRET,
  SITE_BASE_URL: BASE,
};

const SCENARIOS = [
  {
    id: 'S1',
    name: 'no session -> 401 {code:unauthorized}',
    env: BASE_ENV,
    cookie: null,
    expect: { status: 401, code: 'unauthorized' },
  },
  {
    id: 'S2',
    name: 'wrong method (POST) -> 405 + Allow: GET',
    env: BASE_ENV,
    cookie: null,
    method: 'POST',
    expect: { status: 405, code: 'method' },
  },
  {
    id: 'S3',
    name: 'ADMIN_EMAILS unset -> 500 {code:internal}',
    env: { PORTAL_SESSION_SECRET: SECRET, SITE_BASE_URL: BASE },
    cookie: null,
    expect: { status: 500, code: 'internal' },
  },
  {
    id: 'S4',
    name: 'ADMIN_EMAILS set but empty after parsing -> 500 {code:internal}',
    env: { ADMIN_EMAILS: ' , ', PORTAL_SESSION_SECRET: SECRET, SITE_BASE_URL: BASE },
    cookie: null,
    expect: { status: 500, code: 'internal' },
  },
  {
    id: 'S5',
    name: 'the owner -> 200 {role:admin}',
    env: BASE_ENV,
    cookie: cookieHeader({ imk_admin_session: TOKENS.admin }),
    expect: { status: 200, role: 'admin' },
  },
  {
    id: 'S6',
    name: 'a client -> 200 {role:client}',
    env: BASE_ENV,
    cookie: cookieHeader({ imk_session: TOKENS.client }),
    expect: { status: 200, role: 'client' },
  },
  {
    id: 'S7',
    name: 'M-4: the owner was removed from the allow-list -> 200 {role:client}',
    env: BASE_ENV,
    cookie: cookieHeader({ imk_admin_session: TOKENS.adminOffList }),
    expect: { status: 200, role: 'client' },
  },
  {
    id: 'S8',
    name: 'M-5: a client cookie AND a live admin cookie -> 200 {role:client}',
    env: BASE_ENV,
    cookie: cookieHeader({
      imk_session: TOKENS.client,
      imk_admin_session: TOKENS.admin,
    }),
    expect: { status: 200, role: 'client' },
  },
  {
    id: 'S9',
    name: 'a forged cookie -> 401 {code:unauthorized}',
    env: BASE_ENV,
    cookie: cookieHeader({ imk_admin_session: TOKENS.forged }),
    expect: { status: 401, code: 'unauthorized' },
  },
  {
    id: 'S10',
    name: 'M-3: a token that outlives the maximum TTL -> 401',
    env: BASE_ENV,
    cookie: cookieHeader({ imk_admin_session: TOKENS.tooLong }),
    expect: { status: 401, code: 'unauthorized' },
  },
  {
    id: 'S11',
    name: 'an expired token -> 401',
    env: BASE_ENV,
    cookie: cookieHeader({ imk_admin_session: TOKENS.expired }),
    expect: { status: 401, code: 'unauthorized' },
  },
  {
    id: 'S12',
    name: 'H-2: production without a signing secret -> 500, never a 401',
    env: { NODE_ENV: 'production', ADMIN_EMAILS: ADMIN_EMAIL, SITE_BASE_URL: BASE },
    cookie: cookieHeader({ imk_admin_session: TOKENS.admin }),
    expect: { status: 500, code: 'internal' },
  },
  {
    id: 'S13',
    name: 'H-1: production with the published placeholder secret -> 500',
    env: {
      NODE_ENV: 'production',
      ADMIN_EMAILS: ADMIN_EMAIL,
      PORTAL_SESSION_SECRET: 'your-32-byte-hex-hmac-secret-here',
      SITE_BASE_URL: BASE,
    },
    cookie: cookieHeader({ imk_admin_session: TOKENS.admin }),
    expect: { status: 500, code: 'internal' },
  },
  {
    id: 'S14',
    name: 'H-1: production with a too-short secret -> 500',
    env: {
      NODE_ENV: 'production',
      ADMIN_EMAILS: ADMIN_EMAIL,
      PORTAL_SESSION_SECRET: 'short',
      SITE_BASE_URL: BASE,
    },
    cookie: cookieHeader({ imk_admin_session: TOKENS.admin }),
    expect: { status: 500, code: 'internal' },
  },
  {
    id: 'S15',
    name: 'H-2: an https base URL alone makes the instance production -> 500',
    env: { ADMIN_EMAILS: ADMIN_EMAIL, SITE_BASE_URL: 'https://imk.example' },
    cookie: cookieHeader({ imk_admin_session: TOKENS.admin }),
    expect: { status: 500, code: 'internal' },
  },
  {
    id: 'S16',
    name: 'the answer never carries another client\'s data',
    env: BASE_ENV,
    cookie: cookieHeader({ imk_session: TOKENS.client }),
    expect: { status: 200, role: 'client', noClientIdLeak: true },
  },
];

function checkExpectation(result, expect, label) {
  assertEqual(result.status, expect.status, `${label}: status`);
  if (expect.code !== undefined) {
    assert(result.body && typeof result.body === 'object', `${label}: a JSON body is expected`);
    assertEqual(result.body.code, expect.code, `${label}: body.code`);
  }
  if (expect.role !== undefined) {
    assert(result.body && typeof result.body === 'object', `${label}: a JSON body is expected`);
    assertEqual(result.body.role, expect.role, `${label}: body.role`);
  }
  if (expect.noClientIdLeak) {
    assert(
      !result.body || result.body.clientId === undefined || result.body.clientId === CLIENT_ID,
      `${label}: the answer must not carry another client's id`,
    );
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function main() {
  fs.mkdirSync(SANDBOX, { recursive: true });

  // The REAL tree.
  const realDir = path.join(SANDBOX, 'tree-real');
  writeTree(realDir);
  const real = await bundleTree(realDir, 'real');

  // The shared module on its own, for the independent HMAC cross-check and
  // for the access-rule assertions.
  const sharedOut = path.join(BUNDLES, 'shared-module.cjs');
  await build({
    entryPoints: [SRC.shared],
    outfile: sharedOut,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['node:http', 'node:crypto', 'node:fs', 'node:path', 'node:stream'],
    logLevel: 'silent',
  });
  const sharedMod = require(sharedOut);

  // --- The signature is a standard HMAC-SHA256 --------------------------------
  group('the token format (independent of the module)');
  await t('H-01', "node:crypto's HMAC matches the module's own implementation", () => {
    const message = 'v1.eyJlIjoib3duZXJfaW1rLnRlc3QifQ';
    assertEqual(
      sharedMod.hmacSha256Hex(SECRET, message),
      crypto.createHmac('sha256', SECRET).update(message).digest('hex'),
      'the module HMAC must equal node:crypto',
    );
    return 'hex HMAC-SHA256 over "v1.<payload>"';
  });

  // --- The route, in BOTH trees ---------------------------------------------
  group('GET /api/portal/session — the Vercel tree (api/portal/session.ts)');
  for (const sc of SCENARIOS) {
    await t(`V-${sc.id}`, sc.name, async () => {
      const res = await callVercel(real.vercel, {
        method: sc.method || 'GET',
        cookie: sc.cookie,
        env: sc.env,
      });
      checkExpectation(res, sc.expect, `V-${sc.id}`);
      return `${res.status} ${JSON.stringify(res.body)}`;
    });
  }

  group('GET /api/portal/session — the Cloudflare twin (site/functions/api/portal/session.ts)');
  for (const sc of SCENARIOS) {
    await t(`C-${sc.id}`, sc.name, async () => {
      const res = await callCf(real.cf, {
        method: sc.method || 'GET',
        cookie: sc.cookie,
        env: sc.env,
      });
      checkExpectation(res, sc.expect, `C-${sc.id}`);
      return `${res.status} ${JSON.stringify(res.body)}`;
    });
  }

  group('PARITY — the two trees must answer identically');
  for (const sc of SCENARIOS) {
    await t(`P-${sc.id}`, `${sc.name} — same status and body in both trees`, async () => {
      const v = await callVercel(real.vercel, {
        method: sc.method || 'GET',
        cookie: sc.cookie,
        env: sc.env,
      });
      const c = await callCf(real.cf, {
        method: sc.method || 'GET',
        cookie: sc.cookie,
        env: sc.env,
      });
      assertEqual(c.status, v.status, `P-${sc.id}: status differs between the trees`);
      assertEqual(
        JSON.stringify(c.body),
        JSON.stringify(v.body),
        `P-${sc.id}: body differs between the trees`,
      );
      return `both ${v.status}`;
    });
  }

  // --- M-4 / M-5 in the shared access helpers -------------------------------
  group('the shared access rules (M-4 / M-5)');

  await t('A-01', 'M-5: the client cookie wins — an owner cookie cannot widen a client read', () => {
    const access = sharedMod.resolveAccess(
      { headers: { cookie: cookieHeader({ imk_session: TOKENS.client, imk_admin_session: TOKENS.admin }) } },
      BASE_ENV,
    );
    assert(access.client, 'the client session must resolve');
    assert(access.owner, 'the owner session must resolve');
    assertEqual(access.session.email, CLIENT_EMAIL, 'the READ session must be the client one');
    assertEqual(
      sharedMod.canReadClient(access, 'cli_somebody_else'),
      false,
      'the client must not read another client',
    );
    assertEqual(sharedMod.canReadClient(access, CLIENT_ID), true, 'the client must read its own');
    return 'read session = the client';
  });

  await t('A-02', 'M-4: an owner off the allow-list has no owner powers at once', () => {
    const access = sharedMod.resolveAccess(
      { headers: { cookie: cookieHeader({ imk_admin_session: TOKENS.adminOffList }) } },
      BASE_ENV,
    );
    assert(access.any, 'the session itself is still valid');
    assertEqual(access.owner, null, 'the owner gate must not pass');
    assertEqual(
      sharedMod.canReadClient(access, 'cli_somebody_else'),
      false,
      'a revoked owner must not read every client',
    );
    assertEqual(
      sharedMod.effectiveRole(access.any, BASE_ENV),
      'client',
      'the role must be downgraded to client',
    );
    return 'owner powers revoked immediately';
  });

  await t('A-03', 'M-4: the owner on the allow-list keeps them', () => {
    const access = sharedMod.resolveAccess(
      { headers: { cookie: cookieHeader({ imk_admin_session: TOKENS.admin }) } },
      BASE_ENV,
    );
    assert(access.owner, 'the owner gate must pass');
    assertEqual(
      sharedMod.canReadClient(access, 'cli_somebody_else'),
      true,
      'the owner reads every client',
    );
    return 'owner gate passes';
  });

  await t('A-04', 'the allow-list is read case- and whitespace-insensitively', () => {
    const env = { ...BASE_ENV, ADMIN_EMAILS: '  Owner@IMK.test , other@imk.test ' };
    const access = sharedMod.resolveAccess(
      { headers: { cookie: cookieHeader({ imk_admin_session: TOKENS.admin }) } },
      env,
    );
    assert(access.owner, 'the owner gate must pass for a differently-cased address');
    return 'case/whitespace tolerant';
  });

  // --- The mutation probes --------------------------------------------------
  group('the mutation probes — each fix must REDDEN when it is reverted');

  const sharedSource = fs.readFileSync(SRC.shared, 'utf8');
  const vercelSource = fs.readFileSync(SRC.vercel, 'utf8');
  const cfSource = fs.readFileSync(SRC.cf, 'utf8');

  // D1: the role is the token claim ONLY (the allow-list is not consulted).
  const d1Shared = sharedSource.replace(
    '  return isAdminEmail(session.email, env) ? \'admin\' : \'client\';',
    '  return \'admin\';',
  );
  assert(d1Shared !== sharedSource, 'D1: the mutation must change the module');

  // D2: the ADMIN cookie is resolved first again (the pre-M-5 order). The
  // endpoint carries its own `resolveRequester`, so both endpoint files are
  // mutated — the shared module's `resolveAccess` is checked separately in A-01.
  const PRE_M5 = `  const client = cookies.client ? parseSession(cookies.client, env) : null;
  if (client) return client;
  const admin = cookies.admin ? parseSession(cookies.admin, env) : null;
  return admin;`;
  const POST_M5 = `  const admin = cookies.admin ? parseSession(cookies.admin, env) : null;
  if (admin) return admin;
  const client = cookies.client ? parseSession(cookies.client, env) : null;
  return client;`;
  const d2Vercel = vercelSource.replace(PRE_M5, POST_M5);
  const d2Cf = cfSource.replace(PRE_M5, POST_M5);
  assert(
    d2Vercel !== vercelSource && d2Cf !== cfSource,
    'D2: the mutation must change both endpoints',
  );

  // D3: the loud secret guard is removed from both endpoints.
  const d3Vercel = vercelSource.replace(
    /  if \(!sessionSecretConfigured\(process\.env\)\) \{[\s\S]*?\n  \}\n/,
    '',
  );
  const d3Cf = cfSource.replace(
    /  if \(!sessionSecretConfigured\(env\)\) \{[\s\S]*?\n  \}\n/,
    '',
  );
  assert(d3Vercel !== vercelSource && d3Cf !== cfSource, 'D3: the mutation must change an endpoint');

  // D4: the method is not checked.
  const d4Vercel = vercelSource.replace(
    "  if (method !== 'GET') {",
    "  if (false) {",
  );
  const d4Cf = cfSource.replace(
    "  if (method === 'GET') return handle(ctx);",
    "  return handle(ctx);",
  );
  assert(d4Vercel !== vercelSource && d4Cf !== cfSource, 'D4: the mutation must change an endpoint');

  const mutations = [
    {
      tag: 'd1-claim-only-role',
      label: 'D1 — the role claim alone decides the role (the live allow-list is ignored)',
      overrides: { shared: d1Shared },
      expectFail: ['S7'],
    },
    {
      tag: 'd2-admin-cookie-first',
      label: 'D2 — the admin cookie is resolved first again (pre-M-5)',
      overrides: { vercel: d2Vercel, cf: d2Cf },
      expectFail: ['S8'],
    },
    {
      tag: 'd3-no-secret-guard',
      label: 'D3 — the loud secret guard is removed (a broken deployment answers 401 again)',
      overrides: { vercel: d3Vercel, cf: d3Cf },
      expectFail: ['S12', 'S13', 'S14', 'S15'],
    },
    {
      tag: 'd4-no-method-check',
      label: 'D4 — the method is not checked (a POST is answered like a GET)',
      overrides: { vercel: d4Vercel, cf: d4Cf },
      expectFail: ['S2'],
    },
  ];

  for (const mut of mutations) {
    await t(mut.tag, `${mut.label} — the affected assertions must FAIL`, async () => {
      const dir = path.join(SANDBOX, `tree-${mut.tag}`);
      writeTree(dir, mut.overrides);
      const bundles = await bundleTree(dir, mut.tag);

      const failed = [];
      const stillPass = [];
      for (const sc of SCENARIOS) {
        if (!mut.expectFail.includes(sc.id)) continue;
        const v = await callVercel(bundles.vercel, {
          method: sc.method || 'GET',
          cookie: sc.cookie,
          env: sc.env,
        });
        const c = await callCf(bundles.cf, {
          method: sc.method || 'GET',
          cookie: sc.cookie,
          env: sc.env,
        });
        for (const [tree, res] of [['Vercel', v], ['Cloudflare', c]]) {
          let ok = true;
          try {
            checkExpectation(res, sc.expect, `${tree} ${sc.id}`);
          } catch {
            ok = false;
          }
          if (!ok) {
            failed.push(
              `${tree} ${sc.id}: ${res.status} ${JSON.stringify(res.body)} (expected ${sc.expect.status})`,
            );
          } else {
            stillPass.push(`${tree} ${sc.id}`);
          }
        }
      }
      assert(
        failed.length > 0,
        'the mutation did not change any answer — the assertion does not test the fix',
      );
      assert(
        stillPass.length === 0,
        `the mutation left these answers unchanged, so they do not test the fix: ${stillPass.join(', ')}`,
      );
      return `${failed.length} answers changed as expected`;
    });
  }

  // --- Summary --------------------------------------------------------------
  const failedCount = results.filter((r) => r.status === 'FAIL').length;
  origLog('');
  origLog(
    `[wave8-session] ${results.length - failedCount}/${results.length} passed, ${failedCount} failed`,
  );
  if (!KEEP) {
    try {
      fs.rmSync(SANDBOX, { recursive: true, force: true });
    } catch {
      /* the temp dir will be cleaned by the OS */
    }
  } else {
    origLog(`[wave8-session] sandbox kept at ${SANDBOX}`);
  }
  if (failedCount > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('[wave8-session] FATAL', err);
  process.exitCode = 1;
});
