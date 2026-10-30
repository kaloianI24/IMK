// backend-f1-magic-token-harness.mjs
//
// EXECUTED evidence for audit wave 5, F-1: the one-time magic-link token must
// work across SEPARATE Vercel function bundles, on both trees.
//
// WHY THIS HARNESS EXISTS
//   Vercel builds one function per file under api/. Each function gets its own
//   bundle AND its own process, so a token held in a module-scope Map (or in a
//   globalThis map) is invisible to the function that verifies it. The Code
//   Reviewer reproduced the failure by execution (audit-wave4-routes-2026-10-20,
//   F-1): request-link 200, verify 400 "link expired or invalid".
//
// HOW IT EXECUTES THE REAL HANDLERS
//   1. esbuild bundles each ROUTE FILE as its OWN entry point
//      (api/portal/auth/request-link.ts, api/portal/auth/verify.ts,
//      site/shared/portal-handlers/portal-auth.ts, site/functions/api/portal/auth.ts) — the way the
//      deploy target does.
//   2. every request runs in a CHILD PROCESS, so no module state and no
//      globalThis can be shared between the request-link function and the
//      verify function. That is the Vercel situation.
//   3. the repo's own data directory is never touched: the children run with
//      cwd = a sandbox that holds its own site/data/portal/invited.jsonl.
//
// WHAT IT PROVES
//   V1  the Vercel tree: request-link (bundle A, process 1) -> 200,
//       verify (bundle B, process 2) -> 200. The link survives the split.
//   V2  the same flow on the Cloudflare twin: request-link -> 200,
//       verify in a SEPARATE process -> 200 (no shared isolate needed).
//   V3  a link minted by the Vercel tree verifies with the Cloudflare
//       verifier and the other way round (one shared signing module).
//   V4  single use PER INSTANCE: a second verification on the same instance
//       is refused (400); on another instance it is not — the documented
//       limitation, executed rather than asserted.
//   V5  fail closed: a production instance without PORTAL_MAGIC_LINK_SECRET
//       answers 500 and never verifies a token; a token signed with an empty
//       key (the old, forgeable shape) is refused.
//   V6  a forged / wrong-secret / expired / wrong-purpose token is refused,
//       and an uninvited address still gets no link.
//
// USAGE
//   node backend-f1-magic-token-harness.mjs [--keep]

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
// This file lives in the repository root (next to api/ and site/). If it is
// run from somewhere else, walk up until the repo root is found.
const REPO = fs.existsSync(path.join(HERE, 'api', 'portal.ts')) ? HERE : path.resolve(HERE, '..');
const SITE = path.join(REPO, 'site');
// esbuild is a devDependency of site/ — resolve it from there.
const siteRequire = createRequire(path.join(SITE, 'package.json'));
const { build } = siteRequire('esbuild');

const KEEP = process.argv.includes('--keep');
// The origin the harness pretends to serve. It is HTTP on purpose.
//
// H-2 (wave-8A): a deployment is PRODUCTION when the base URL is an https://
// URL (one of the three production signals in the brief), so an https origin
// here would put the children in production mode — where the magic-link token
// is NEVER written to the log and the harness could not read it. A real local
// dev server is http://localhost:4321, so the fixture now matches a local
// machine and the children stay in development mode.
const BASE = 'http://imk.test';
// At least 32 characters: H-1 refuses a shorter secret in production, and a
// fixture the rule would reject proves nothing.
const SECRET = 'f1-harness-secret-0123456789abcdef';
const CLIENT_EMAIL = 'client@imk.test';
const ADMIN_EMAIL = 'owner@imk.test';

const results = [];
let currentGroup = '';
const origLog = console.log;

function group(name) {
  currentGroup = name;
  origLog(`\n[f1] ${name}`);
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
const SANDBOX = path.join(os.tmpdir(), 'opencode', 'f1-magic-token', STAMP);
const SANDBOX_PORTAL = path.join(SANDBOX, 'site', 'data', 'portal');
const BUNDLES = path.join(SANDBOX, 'bundles');
const CHILD_FILE = path.join(SANDBOX, 'child.cjs');

function writeInvitedStore() {
  fs.mkdirSync(SANDBOX_PORTAL, { recursive: true });
  const invited = {
    id: 'inv_f1',
    email: CLIENT_EMAIL,
    name: 'Nora Named',
    company: 'Named Co',
    role: 'CTO',
    clientId: 'cli_f1',
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(
    path.join(SANDBOX_PORTAL, 'invited.jsonl'),
    JSON.stringify(invited) + '\n',
    'utf8',
  );
}

// ---------------------------------------------------------------------------
// Bundling — one entry point per function file, exactly like the deploy target
// ---------------------------------------------------------------------------

const BUNDLE_ENTRIES = {
  'vercel-request-link': path.join(REPO, 'api', 'portal', 'auth', 'request-link.ts'),
  'vercel-verify': path.join(REPO, 'api', 'portal', 'auth', 'verify.ts'),
  'vercel-auth': path.join(REPO, 'site', 'shared', 'portal-handlers', 'portal-auth.ts'),
  'vercel-projects': path.join(REPO, 'site', 'shared', 'portal-handlers', 'portal-projects.ts'),
  'cf-auth': path.join(REPO, 'site', 'functions', 'api', 'portal', 'auth.ts'),
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

// ---------------------------------------------------------------------------
// The child runner — one process per request (or per step list)
// ---------------------------------------------------------------------------

const CHILD = `
// The Cloudflare code looks for \`globalThis.require\`. On the edge there is
// none, so the store cannot be read and the portal answers 501. This child
// runs as CommonJS, where \`require\` is module-scoped and globalThis.require
// is undefined — exactly like the edge — unless the harness asks for a
// filesystem.
if (process.env.F1_WITH_FS === '1') globalThis.require = require;
else delete globalThis.require;

const { Readable } = require('node:stream');

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

async function runStep(step, bundlePath, mode) {
  if (mode === 'vercel') {
    const mod = require(bundlePath);
    const req = makeReq(step.method, step.url, step.headers, step.body);
    const res = makeRes();
    await mod.default(req, res);
    let parsed = null;
    try { parsed = JSON.parse(res.body || 'null'); } catch (e) { parsed = null; }
    return { status: res.statusCode, body: parsed, raw: res.body, headers: res.headers };
  }

  const mod = require(bundlePath);
  const env = JSON.parse(process.env.F1_CF_ENV || '{}');
  const request = new Request(step.url, {
    method: step.method,
    headers: step.headers || {},
    body: step.body,
  });
  const handler = step.method === 'GET' ? mod.onRequestGet : mod.onRequestPost;
  const response = await handler({ request, env });
  const text = await response.text();
  let parsed = null;
  try { parsed = JSON.parse(text || 'null'); } catch (e) { parsed = null; }
  const headers = {};
  response.headers.forEach((value, key) => { headers[key] = value; });
  return { status: response.status, body: parsed, raw: text, headers };
}

(async () => {
  const plan = JSON.parse(process.env.F1_PLAN || '{}');
  const out = [];
  for (const step of plan.steps || []) {
    out.push(await runStep(step, plan.bundle, plan.mode));
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
 * Run one or more steps in a FRESH child process.
 *
 * @param {string} bundle   bundle file
 * @param {'vercel'|'cf'} mode
 * @param {Array} steps
 * @param {object} env      environment overrides for the child
 * @param {boolean} withFs  give the child a filesystem (the edge has none)
 */
function runChild(bundle, mode, steps, env = {}, withFs = true) {
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
  childEnv.F1_WITH_FS = withFs ? '1' : '0';
  childEnv.F1_PLAN = JSON.stringify({ bundle, mode, steps });
  childEnv.F1_CF_ENV = JSON.stringify({
    APP_ENV: childEnv.APP_ENV,
    SITE_BASE_URL: childEnv.SITE_BASE_URL,
    ADMIN_EMAILS: childEnv.ADMIN_EMAILS,
    PORTAL_MAGIC_LINK_SECRET: childEnv.PORTAL_MAGIC_LINK_SECRET,
  });

  const res = spawnSync(process.execPath, [CHILD_FILE], {
    cwd: SANDBOX,
    env: childEnv,
    encoding: 'utf8',
    timeout: 60000,
  });

  const stdout = res.stdout || '';
  const stderr = res.stderr || '';
  const line = stdout.split('\n').find((l) => l.startsWith('__RESULT__'));
  if (!line) {
    throw new Error(`child produced no result\nstdout:\n${stdout}\nstderr:\n${stderr}`);
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
// Steps
// ---------------------------------------------------------------------------

function requestLinkStep(email, ip = '198.51.100.10') {
  return {
    method: 'POST',
    url: '/api/portal/auth/request-link',
    headers: {
      host: 'imk.test',
      origin: BASE,
      'content-type': 'application/json',
      'x-forwarded-for': ip,
    },
    body: JSON.stringify({ email }),
  };
}

function verifyStep(token, purpose = 'portal', ip = '198.51.100.11') {
  return {
    method: 'GET',
    url: `/api/portal/auth/verify?token=${encodeURIComponent(token)}&purpose=${encodeURIComponent(purpose)}`,
    headers: { host: 'imk.test', origin: BASE, 'x-forwarded-for': ip },
  };
}

function projectsStep(cookie) {
  return {
    method: 'GET',
    url: '/api/portal/projects',
    headers: { host: 'imk.test', origin: BASE, cookie: `imk_session=${cookie}` },
  };
}

function cfRequestLinkStep(email, ip = '203.0.113.10') {
  return {
    method: 'POST',
    url: `${BASE}/api/portal/auth/request-link`,
    headers: {
      origin: BASE,
      'content-type': 'application/json',
      'CF-Connecting-IP': ip,
    },
    body: JSON.stringify({ email }),
  };
}

function cfVerifyStep(token, purpose = 'portal', ip = '203.0.113.11') {
  return {
    method: 'GET',
    url: `${BASE}/api/portal/auth/verify?token=${encodeURIComponent(token)}&purpose=${encodeURIComponent(purpose)}`,
    headers: { origin: BASE, 'CF-Connecting-IP': ip },
  };
}

function tokenFromLogs(logs) {
  const line = logs.find((l) => l && l.outcome === 'magic_link_dev');
  return line ? line.token : null;
}

// ---------------------------------------------------------------------------
// The negative control — the OLD module-scope Map, in a COPY of the tree
// ---------------------------------------------------------------------------

/**
 * The harness must be able to FAIL. So it also runs the flow against a COPY
 * of the tree in which the magic-token table is a module-scope Map again —
 * the code that audit wave 4, F-1 proved broken. The copy lives in the
 * sandbox; the repository is never touched.
 */
const OLD_IMPORT = `import {
  createMagicToken,
  verifyMagicToken,
  consumeMagicToken,
  magicLinkMisconfigured,
  magicLinkUrl,
  PORTAL_MAGIC_PURPOSE,
} from '../server/magic-link.js';`;

const OLD_FUNCTIONS = `import {
  magicLinkMisconfigured,
  magicLinkUrl,
  PORTAL_MAGIC_PURPOSE,
} from '../server/magic-link.js';

const OLD_MAGIC_TTL_MS = 15 * 60 * 1000;
const magicTokens = new Map<string, {
  email: string;
  purpose: string;
  expiresAt: number;
  used: boolean;
}>();

function generateMagicToken(email: string, purpose: string): { token: string; tokenHash: string } {
  const secret = process.env.PORTAL_MAGIC_LINK_SECRET || '';
  const nonce = crypto.randomBytes(16).toString('hex');
  const ts = Date.now();
  const message = \`\${email}|\${purpose}|\${ts}|\${nonce}\`;
  const sig = crypto.createHmac('sha256', secret).update(message).digest('hex');
  const token = Buffer.from(\`\${message}|\${sig}\`).toString('base64url');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  return { token, tokenHash };
}

function validateMagicToken(token: string): { valid: boolean; email?: string; purpose?: string } {
  try {
    const decoded = Buffer.from(token, 'base64url').toString('utf8');
    const parts = decoded.split('|');
    if (parts.length !== 5) return { valid: false };
    const [email, purpose, tsStr, nonce, sig] = parts;
    const ts = Number(tsStr);
    if (!Number.isFinite(ts)) return { valid: false };
    if (Date.now() - ts > OLD_MAGIC_TTL_MS || ts - Date.now() > 60000) return { valid: false };
    const secret = process.env.PORTAL_MAGIC_LINK_SECRET || '';
    const message = \`\${email}|\${purpose}|\${ts}|\${nonce}\`;
    const expected = crypto.createHmac('sha256', secret).update(message).digest('hex');
    if (expected !== sig) return { valid: false };
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const entry = magicTokens.get(tokenHash);
    if (!entry || entry.used || Date.now() > entry.expiresAt) return { valid: false };
    return { valid: true, email, purpose };
  } catch {
    return { valid: false };
  }
}

function consumeMagicTokenOld(token: string): void {
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const entry = magicTokens.get(tokenHash);
  if (entry) entry.used = true;
}`;

const OLD_MINT = `      const token = await createMagicToken(email, PORTAL_MAGIC_PURPOSE, process.env);`;
const OLD_MINT_REPLACEMENT = `      const { token, tokenHash } = generateMagicToken(email, 'portal');
      magicTokens.set(tokenHash, {
        email,
        purpose: 'portal',
        expiresAt: Date.now() + OLD_MAGIC_TTL_MS,
        used: false,
      });`;

const OLD_VERIFY = `    const validation = await verifyMagicToken(token, purpose, process.env);
    if (!validation.valid) {
      if (validation.reason === 'misconfigured') {
        json(res, { error: 'misconfigured', code: 'internal' }, 500);
        return;
      }
      json(res, { error: 'link expired or invalid', code: 'invalid' }, 400);
      return;
    }`;
const OLD_VERIFY_REPLACEMENT = `    const validation = validateMagicToken(token);
    if (!validation.valid) {
      json(res, { error: 'link expired or invalid', code: 'invalid' }, 400);
      return;
    }`;

const OLD_CONSUME = `    const consumed = await consumeMagicToken(token, validation.exp!);
    if (!consumed) {
      json(res, { error: 'link expired or invalid', code: 'invalid' }, 400);
      return;
    }`;
const OLD_CONSUME_REPLACEMENT = `    consumeMagicTokenOld(token);`;

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}

async function buildOldTree() {
  const oldRoot = path.join(SANDBOX, 'oldtree');
  copyDir(path.join(REPO, 'api'), path.join(oldRoot, 'api'));
  copyDir(path.join(REPO, 'site', 'shared'), path.join(oldRoot, 'site', 'shared'));

  const file = path.join(oldRoot, 'site', 'shared', 'portal-handlers', 'portal-auth.ts');
  let src = fs.readFileSync(file, 'utf8');
  const patches = [
    [OLD_IMPORT, OLD_FUNCTIONS],
    [OLD_MINT, OLD_MINT_REPLACEMENT],
    [OLD_VERIFY, OLD_VERIFY_REPLACEMENT],
    [OLD_CONSUME, OLD_CONSUME_REPLACEMENT],
  ];
  for (const [from, to] of patches) {
    if (!src.includes(from)) {
      throw new Error(`the negative-control patch no longer matches the file:\n${from}`);
    }
    src = src.replace(from, to);
  }
  fs.writeFileSync(file, src, 'utf8');

  const out = {
    requestLink: path.join(BUNDLES, 'old-request-link.cjs'),
    verify: path.join(BUNDLES, 'old-verify.cjs'),
  };
  for (const [key, entry] of [
    ['requestLink', path.join(oldRoot, 'api', 'portal', 'auth', 'request-link.ts')],
    ['verify', path.join(oldRoot, 'api', 'portal', 'auth', 'verify.ts')],
  ]) {
    await build({
      entryPoints: [entry],
      outfile: out[key],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      absWorkingDir: REPO,
      external: ['node:http', 'node:crypto', 'node:fs', 'node:path', 'node:stream'],
      logLevel: 'silent',
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------

async function main() {
  origLog(`[f1] repo: ${REPO}`);
  origLog(`[f1] sandbox: ${SANDBOX}`);
  fs.mkdirSync(SANDBOX, { recursive: true });
  writeInvitedStore();
  await bundleAll();

  const V = {
    requestLink: path.join(BUNDLES, 'vercel-request-link.cjs'),
    verify: path.join(BUNDLES, 'vercel-verify.cjs'),
    auth: path.join(BUNDLES, 'vercel-auth.cjs'),
    projects: path.join(BUNDLES, 'vercel-projects.cjs'),
    cf: path.join(BUNDLES, 'cf-auth.cjs'),
  };

  let vercelToken = null;
  let cfToken = null;

  // -- V1: the Vercel tree, one function per file ----------------------------
  group('V — the Vercel tree, one function per file');

  await t('V1a', 'request-link (its own bundle, its own process) answers 200', async () => {
    const r = runChild(V.requestLink, 'vercel', [requestLinkStep(CLIENT_EMAIL)], {
      PORTAL_MAGIC_LINK_SECRET: SECRET,
    });
    assertEqual(r.out[0].status, 200, `the request-link status (body: ${r.out[0].raw})`);
    assertEqual(r.out[0].body.ok, true, 'the request-link body');
    vercelToken = tokenFromLogs(r.logs);
    assert(vercelToken, 'the dev log must carry the minted token');
    return `token length ${vercelToken.length}`;
  });

  await t('V1b', 'verify (a DIFFERENT bundle, a DIFFERENT process) answers 200', async () => {
    const r = runChild(V.verify, 'vercel', [verifyStep(vercelToken)], {
      PORTAL_MAGIC_LINK_SECRET: SECRET,
    });
    assertEqual(r.out[0].status, 200, `the verify status (body: ${r.out[0].raw})`);
    assertEqual(r.out[0].body.ok, true, 'the verify body');
    assertEqual(r.out[0].body.role, 'client', 'the role');
    assertEqual(r.out[0].body.email, CLIENT_EMAIL, 'the email');
    assert(
      String(r.out[0].headers['Set-Cookie'] || '').includes('imk_session='),
      'a session cookie must be issued',
    );
    return '200, session cookie issued';
  });

  await t('V1c', 'the combined portal-auth.ts bundle still serves both routes', async () => {
    // The local dev server bundles everything from ONE entry point
    // (site/scripts/api-index.ts). That path must keep working.
    const mint = runChild(V.auth, 'vercel', [requestLinkStep(CLIENT_EMAIL, '198.51.100.20')], {
      PORTAL_MAGIC_LINK_SECRET: SECRET,
    });
    assertEqual(mint.out[0].status, 200, `the request-link status (body: ${mint.out[0].raw})`);
    const token = tokenFromLogs(mint.logs);
    assert(token, 'a token must be minted');
    const v = runChild(V.auth, 'vercel', [verifyStep(token, 'portal', '198.51.100.21')], {
      PORTAL_MAGIC_LINK_SECRET: SECRET,
    });
    assertEqual(v.out[0].status, 200, `the verify status (body: ${v.out[0].raw})`);
    return '200 then 200';
  });

  await t('V1d', 'the token is self-contained: it carries the address, purpose and expiry', async () => {
    const decoded = Buffer.from(vercelToken, 'base64url').toString('utf8');
    const parts = decoded.split('|');
    assertEqual(parts.length, 5, 'the token payload must have five parts');
    assertEqual(parts[0], CLIENT_EMAIL, 'the address');
    assertEqual(parts[1], 'portal', 'the purpose');
    assert(Number.isFinite(Number(parts[2])), 'the third part must be the expiry');
    const ttl = Number(parts[2]) - Date.now();
    assert(ttl > 0 && ttl <= 15 * 60 * 1000 + 5000, `the expiry must be within the TTL (${ttl} ms)`);
    assertEqual(parts[4].length, 64, 'the signature must be a SHA-256 hex digest');
    return `expires in ${Math.round(ttl / 1000)}s, sig ${parts[4].slice(0, 12)}…`;
  });

  // -- V2: the Cloudflare twin ------------------------------------------------
  group('C — the Cloudflare twin');

  await t('C1', 'the Cloudflare request-link answers 200 and mints a token', async () => {
    const r = runChild(V.cf, 'cf', [cfRequestLinkStep(CLIENT_EMAIL)], {
      PORTAL_MAGIC_LINK_SECRET: SECRET,
    }, true);
    assertEqual(r.out[0].status, 200, `the CF request-link status (body: ${r.out[0].raw})`);
    cfToken = tokenFromLogs(r.logs);
    assert(cfToken, 'the dev log must carry the minted token');
    return `token length ${cfToken.length}`;
  });

  await t('C2', 'the Cloudflare verify answers 200 in a SEPARATE process (no shared isolate)', async () => {
    const r = runChild(V.cf, 'cf', [cfVerifyStep(cfToken)], {
      PORTAL_MAGIC_LINK_SECRET: SECRET,
    }, true);
    assertEqual(r.out[0].status, 200, `the CF verify status (body: ${r.out[0].raw})`);
    assertEqual(r.out[0].body.ok, true, 'the CF verify body');
    assertEqual(r.out[0].body.email, CLIENT_EMAIL, 'the email');
    return '200';
  });

  await t('C3', 'the Cloudflare verify also works with NO filesystem (the edge itself)', async () => {
    // The owner is an admin, so the verify path never touches the store: this
    // is the genuine edge code path (no fs, no globalThis.require).
    const mint = runChild(V.cf, 'cf', [cfRequestLinkStep(ADMIN_EMAIL, '203.0.113.30')], {
      PORTAL_MAGIC_LINK_SECRET: SECRET,
    }, true);
    const adminToken = tokenFromLogs(mint.logs);
    assert(adminToken, 'an admin token must be minted');
    const v = runChild(V.cf, 'cf', [cfVerifyStep(adminToken)], {
      PORTAL_MAGIC_LINK_SECRET: SECRET,
    }, false);
    assertEqual(v.out[0].status, 200, `the edge verify status (body: ${v.out[0].raw})`);
    assertEqual(v.out[0].body.role, 'admin', 'the role');
    return '200 on the edge path';
  });

  // -- V3: one signing module, both trees ------------------------------------
  group('X — the two trees sign identically');

  await t('X1', 'a Vercel-minted token verifies with the Cloudflare verifier', async () => {
    const r = runChild(V.cf, 'cf', [cfVerifyStep(vercelToken)], {
      PORTAL_MAGIC_LINK_SECRET: SECRET,
    }, true);
    assertEqual(r.out[0].status, 200, `the CF verify status (body: ${r.out[0].raw})`);
    return '200';
  });

  await t('X2', 'a Cloudflare-minted token verifies with the Vercel verifier', async () => {
    const r = runChild(V.verify, 'vercel', [verifyStep(cfToken)], {
      PORTAL_MAGIC_LINK_SECRET: SECRET,
    });
    assertEqual(r.out[0].status, 200, `the Vercel verify status (body: ${r.out[0].raw})`);
    return '200';
  });

  // -- V4: what "single use" means ------------------------------------------
  group('S — single use');

  await t('S1', 'a second verification on the SAME instance is refused', async () => {
    const mint = runChild(V.requestLink, 'vercel', [requestLinkStep(CLIENT_EMAIL, '198.51.100.40')], {
      PORTAL_MAGIC_LINK_SECRET: SECRET,
    });
    const token = tokenFromLogs(mint.logs);
    assert(token, 'a token must be minted');
    const twice = runChild(
      V.verify,
      'vercel',
      [verifyStep(token, 'portal', '198.51.100.41'), verifyStep(token, 'portal', '198.51.100.41')],
      { PORTAL_MAGIC_LINK_SECRET: SECRET },
    );
    assertEqual(twice.out[0].status, 200, 'the first verification');
    assertEqual(twice.out[1].status, 400, 'the second verification on the same instance');
    assertEqual(twice.out[1].body.code, 'invalid', 'the refusal code');
    return 'first 200, second 400 invalid';
  });

  await t('S2', 'a verification on ANOTHER instance is NOT refused (the stated limit)', async () => {
    const mint = runChild(V.requestLink, 'vercel', [requestLinkStep(CLIENT_EMAIL, '198.51.100.50')], {
      PORTAL_MAGIC_LINK_SECRET: SECRET,
    });
    const token = tokenFromLogs(mint.logs);
    const first = runChild(V.verify, 'vercel', [verifyStep(token, 'portal', '198.51.100.51')], {
      PORTAL_MAGIC_LINK_SECRET: SECRET,
    });
    const second = runChild(V.verify, 'vercel', [verifyStep(token, 'portal', '198.51.100.52')], {
      PORTAL_MAGIC_LINK_SECRET: SECRET,
    });
    assertEqual(first.out[0].status, 200, 'the first verification');
    assertEqual(
      second.out[0].status,
      200,
      'the replay on another instance is accepted — that IS the limitation, executed',
    );
    return 'replay on another instance: 200 (the limit)';
  });

  // -- V5: fail closed --------------------------------------------------------
  group('F — fail closed');

  await t('F1', 'a production instance without PORTAL_MAGIC_LINK_SECRET answers 500', async () => {
    const r = runChild(V.requestLink, 'vercel', [requestLinkStep(CLIENT_EMAIL, '198.51.100.60')], {
      APP_ENV: 'production',
      PORTAL_MAGIC_LINK_SECRET: undefined,
      RESEND_API_KEY: 'stub-key-not-used',
    });
    assertEqual(r.out[0].status, 500, `the status (body: ${r.out[0].raw})`);
    assertEqual(r.out[0].body.code, 'internal', 'the code');
    assert(!tokenFromLogs(r.logs), 'no token may be minted or logged');
    return '500 {code:internal}';
  });

  await t('F2', 'the same 500 for an invited AND an uninvited address (no oracle)', async () => {
    const r = runChild(
      V.requestLink,
      'vercel',
      [
        requestLinkStep(CLIENT_EMAIL, '198.51.100.61'),
        requestLinkStep('stranger@imk.test', '198.51.100.62'),
      ],
      {
        APP_ENV: 'production',
        PORTAL_MAGIC_LINK_SECRET: undefined,
        RESEND_API_KEY: 'stub-key-not-used',
      },
    );
    assertEqual(r.out[0].status, 500, 'the invited address');
    assertEqual(r.out[1].status, 500, 'the uninvited address');
    assertEqual(r.out[0].raw, r.out[1].raw, 'the two answers must be identical');
    return 'identical 500 for both';
  });

  await t('F3', 'a production instance without the secret refuses to verify anything', async () => {
    const r = runChild(V.verify, 'vercel', [verifyStep(vercelToken)], {
      APP_ENV: 'production',
      PORTAL_MAGIC_LINK_SECRET: undefined,
    });
    assertEqual(r.out[0].status, 500, `the status (body: ${r.out[0].raw})`);
    assertEqual(r.out[0].body.code, 'internal', 'the code');
    return '500 {code:internal}';
  });

  await t('F4', 'a token signed with an EMPTY key (the old forgeable shape) is refused', async () => {
    const crypto = require('node:crypto');
    const payload = `${CLIENT_EMAIL}|portal|${Date.now() + 600000}|deadbeef`;
    const sig = crypto.createHmac('sha256', '').update(payload).digest('hex');
    const forged = Buffer.from(`${payload}|${sig}`).toString('base64url');
    const r = runChild(V.verify, 'vercel', [verifyStep(forged)], {
      APP_ENV: 'production',
      PORTAL_MAGIC_LINK_SECRET: SECRET,
    });
    assertEqual(r.out[0].status, 400, `the status (body: ${r.out[0].raw})`);
    assertEqual(r.out[0].body.code, 'invalid', 'the code');
    return '400 invalid';
  });

  await t('F5', 'the Cloudflare twin fails closed the same way', async () => {
    const r = runChild(V.cf, 'cf', [cfRequestLinkStep(CLIENT_EMAIL, '203.0.113.40')], {
      APP_ENV: 'production',
      PORTAL_MAGIC_LINK_SECRET: undefined,
      RESEND_API_KEY: 'stub-key-not-used',
    }, true);
    assertEqual(r.out[0].status, 500, `the status (body: ${r.out[0].raw})`);
    assertEqual(r.out[0].body.code, 'internal', 'the code');
    return '500 {code:internal}';
  });

  // -- V6: refusals -----------------------------------------------------------
  group('R — refusals');

  await t('R1', 'a token signed with the WRONG secret is refused', async () => {
    const crypto = require('node:crypto');
    const payload = `${CLIENT_EMAIL}|portal|${Date.now() + 600000}|deadbeef`;
    const sig = crypto.createHmac('sha256', 'some-other-secret').update(payload).digest('hex');
    const forged = Buffer.from(`${payload}|${sig}`).toString('base64url');
    const r = runChild(V.verify, 'vercel', [verifyStep(forged)], {
      PORTAL_MAGIC_LINK_SECRET: SECRET,
    });
    assertEqual(r.out[0].status, 400, `the status (body: ${r.out[0].raw})`);
    return '400 invalid';
  });

  await t('R2', 'an EXPIRED token is refused', async () => {
    const crypto = require('node:crypto');
    const payload = `${CLIENT_EMAIL}|portal|${Date.now() - 1000}|deadbeef`;
    const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
    const expired = Buffer.from(`${payload}|${sig}`).toString('base64url');
    const r = runChild(V.verify, 'vercel', [verifyStep(expired)], {
      PORTAL_MAGIC_LINK_SECRET: SECRET,
    });
    assertEqual(r.out[0].status, 400, `the status (body: ${r.out[0].raw})`);
    return '400 invalid';
  });

  await t('R3', 'a token presented with the WRONG purpose is refused', async () => {
    const r = runChild(V.verify, 'vercel', [verifyStep(vercelToken, 'not-portal')], {
      PORTAL_MAGIC_LINK_SECRET: SECRET,
    });
    assertEqual(r.out[0].status, 400, `the status (body: ${r.out[0].raw})`);
    assertEqual(r.out[0].body.code, 'invalid', 'the code');
    return '400 invalid';
  });

  await t('R4', 'the portal stays INVITE-ONLY: an uninvited address gets no link', async () => {
    const r = runChild(V.requestLink, 'vercel', [requestLinkStep('stranger@imk.test', '198.51.100.70')], {
      PORTAL_MAGIC_LINK_SECRET: SECRET,
    });
    assertEqual(r.out[0].status, 200, 'the generic answer');
    assertEqual(r.out[0].body.ok, true, 'the generic body');
    assert(!tokenFromLogs(r.logs), 'no token may be minted for an uninvited address');
    const asked = r.logs.find((l) => l && l.outcome === 'magic_link_requested');
    assert(asked && asked.allowed === false, 'the log must show the address was not invited');
    return '200, no token minted';
  });

  // -- G: the session half (F-2) is a SEPARATE finding ------------------------
  group('G — the session half (F-2), executed');

  await t('G1', 'the session cookie from verify IS accepted by another function', async () => {
    // F-1 (the magic-link token) is closed by this change. The SESSION half is
    // a different finding (F-2): site/shared/server/portal-session.ts holds a
    // signed, stateless session, but NOTHING imports it — the session handler
    // is still the module-scope Map that every handler uses. So the cookie the
    // verify function issues lives in that function's own Map and another
    // function cannot resolve it. This check asserts the FIXED behaviour: the
    // session is a SIGNED token now (audit wave-6, F-2), so the cookie works
    // in another bundle, in another process, after every cold start.
    const mint = runChild(V.requestLink, 'vercel', [requestLinkStep(CLIENT_EMAIL, '198.51.100.90')], {
      PORTAL_MAGIC_LINK_SECRET: SECRET,
    });
    const token = tokenFromLogs(mint.logs);
    assert(token, 'a token must be minted');
    const v = runChild(V.verify, 'vercel', [verifyStep(token, 'portal', '198.51.100.91')], {
      PORTAL_MAGIC_LINK_SECRET: SECRET,
    });
    assertEqual(v.out[0].status, 200, `the verify status (body: ${v.out[0].raw})`);
    const setCookie = String(v.out[0].headers['Set-Cookie'] || '');
    const session = (setCookie.match(/imk_session=([^;]+)/) || [])[1];
    assert(session, 'the verify must issue a session cookie');
    const p = runChild(V.projects, 'vercel', [projectsStep(session)], {
      PORTAL_MAGIC_LINK_SECRET: SECRET,
    });
    assertEqual(
      p.out[0].status,
      200,
      `another function must ACCEPT the cookie — F-2 is closed (got ${p.out[0].status} ${p.out[0].raw})`,
    );
    return '200 on the next function — the session is stateless, F-2 is closed';
  });

  // -- N: the negative control ------------------------------------------------
  group('N — the negative control (the old module-scope Map, in a sandbox copy)');

  await t('N1', 'the SAME harness fails on the old module-scope Map (it can detect the defect)', async () => {
    const old = await buildOldTree();
    const mint = runChild(old.requestLink, 'vercel', [requestLinkStep(CLIENT_EMAIL, '198.51.100.80')], {
      PORTAL_MAGIC_LINK_SECRET: SECRET,
    });
    assertEqual(mint.out[0].status, 200, `the old request-link status (body: ${mint.out[0].raw})`);
    const token = tokenFromLogs(mint.logs);
    assert(token, 'the old code must mint a token');
    const v = runChild(old.verify, 'vercel', [verifyStep(token, 'portal', '198.51.100.81')], {
      PORTAL_MAGIC_LINK_SECRET: SECRET,
    });
    assertEqual(
      v.out[0].status,
      400,
      `the old code must answer 400 across bundles (got ${v.out[0].status})`,
    );
    assertEqual(v.out[0].body.code, 'invalid', 'the F-1 symptom');
    return 'old code: request-link 200, verify 400 invalid — the defect, reproduced';
  });

  const failed = results.filter((r) => r.status === 'FAIL');  origLog(
    `\n[f1] ${results.length - failed.length} passed, ${failed.length} failed, ${results.length} checks`,
  );
  if (failed.length) {
    origLog('[f1] failing checks: ' + failed.map((f) => f.id).join(', '));
  }

  const artifact = path.join(SANDBOX, 'results.json');
  fs.writeFileSync(artifact, JSON.stringify(results, null, 2), 'utf8');
  origLog(`[f1] results: ${artifact}`);

  if (!KEEP) {
    try {
      fs.rmSync(SANDBOX, { recursive: true, force: true });
      origLog('[f1] sandbox removed');
    } catch {
      origLog('[f1] sandbox left behind: ' + SANDBOX);
    }
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  origLog('[f1] harness error', err);
  process.exit(1);
});
