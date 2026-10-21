// site/qa/qa-wave3-independent.mjs
//
// QA-OWNED independent verification of the fix wave 3 (the pluggable rate
// limiter + the Cloudflare tree), plus the three defects QA formed while
// reading the wave-3 diff.
//
// WHY THIS FILE EXISTS
//   The Backend Developer asked QA to re-run their suites and to write
//   independent checks for five behaviours. Their suites are their claim; this
//   file is QA's own evidence. It shares NO helper with the Backend's
//   qa-rate-limit.mjs or qa-cf-parity.mjs: it rebuilds its own harness, uses
//   its own port, its own sandbox and its own signing code.
//
// WHAT IS DIFFERENT ABOUT THIS SUITE
//   - The durable-counter checks read the COUNTER FILE on disk and recompute
//     the SHA-256 key the handler should have used, so the assertion is about
//     what was really written, not about what the handler reported.
//   - The cross-target link test signs the moderation link with QA's own
//     HMAC (node:crypto), not with the project's `moderationUrl()` helper, so
//     a link that the two trees build differently cannot pass by agreeing
//     with itself.
//   - The Cloudflare tree is executed with a FAKE filesystem bound to
//     `globalThis.require`, so the "no writable filesystem" runtime is
//     simulated exactly the way the edge runtime behaves.
//
// ISOLATION
//   cwd     -> <sandbox>      the handlers resolve site/data/... from cwd
//   ports   -> 4441 / 4442   never 4321 (the running dev server), never
//                             4399/4411/4421/4431-4433 (the other suites)
//   network -> global fetch stub   no request leaves the machine
//
// USAGE
//   node site/qa/qa-wave3-independent.mjs
//   node site/qa/qa-wave3-independent.mjs --keep
//   node site/qa/qa-wave3-independent.mjs --json <ABSOLUTE path>

import { createServer } from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { build } from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.resolve(__dirname, '..');
const REPO = path.resolve(SITE, '..');
const require = createRequire(import.meta.url);

const argv = process.argv.slice(2);
const KEEP = argv.includes('--keep');
const JSON_OUT = argv.includes('--json')
  ? path.resolve(argv[argv.indexOf('--json') + 1])
  : null;

const PORT = Number(process.env.QA_W3_PORT || 4441);
const PORT2 = Number(process.env.QA_W3_PORT2 || 4442);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const ORIGIN2 = `http://127.0.0.1:${PORT2}`;
const SANDBOX = path.join(
  os.tmpdir(),
  'opencode',
  `qa-wave3-${new Date().toISOString().replace(/[:.]/g, '-')}`,
);

// H-1 (wave-8A): a secret shorter than 32 characters is refused in
// production, so the fixture has to be a usable one (32+ characters).
const SECRET = 'qa-wave3-form-webhook-secret-0123456789';
const ADMIN_EMAIL = 'owner@imk.test';
const IP_A = '203.0.113.7';
const IP_B = '203.0.113.8';
const IP_C = '203.0.113.9';

// ---------------------------------------------------------------------------
// tiny assertion framework (QA's own)
// ---------------------------------------------------------------------------
const results = [];
let currentGroup = 'general';

function group(name) {
  currentGroup = name;
  console.log(`\n[qa] ${name}`);
}

async function t(id, name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    results.push({
      id,
      group: currentGroup,
      name,
      status: 'PASS',
      ms: Date.now() - started,
      ...(detail ? { detail: String(detail) } : {}),
    });
    console.log(`  PASS  ${id}  ${name}${detail ? ` -- ${detail}` : ''}`);
  } catch (err) {
    results.push({
      id,
      group: currentGroup,
      name,
      status: 'FAIL',
      ms: Date.now() - started,
      error: err && err.message ? err.message : String(err),
    });
    console.log(`  FAIL  ${id}  ${name}\n          ${err && err.message ? err.message : err}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg} -- expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// ---------------------------------------------------------------------------
// environment + network stub
// ---------------------------------------------------------------------------
process.env.APP_ENV = 'production';
process.env.SITE_BASE_URL = ORIGIN;
process.env.RESEND_API_KEY = 'qa-wave3-resend-key';
process.env.RESEND_FROM = 'IMK <qa@imk.test>';
process.env.RESEND_TO = ADMIN_EMAIL;
process.env.FORM_WEBHOOK_SECRET = SECRET;
process.env.ADMIN_EMAILS = ADMIN_EMAIL;
// The sign-in link is self-contained and signed (wave 5) and the session is a
// signed token (wave 6, F-2). In production BOTH secrets are mandatory: a
// missing one is a misconfiguration and the endpoint answers 500. These are
// QA-local test secrets, not credentials.
//
// H-1 (wave-8A): in production a secret that is PRESENT but UNUSABLE -- the
// published placeholder, or shorter than MIN_SECRET_LENGTH (32) -- is refused
// exactly like a missing one. The fixtures below are therefore 32+ characters
// long.
process.env.PORTAL_MAGIC_LINK_SECRET = 'qa-wave3-magic-link-secret-0123456789';
process.env.PORTAL_SESSION_SECRET = 'qa-wave3-session-secret-0123456789';

const emails = [];
const REAL_FETCH = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const target = String(url);
  if (target.startsWith(ORIGIN) || target.startsWith(ORIGIN2)) {
    return REAL_FETCH(url, init);
  }
  if (target.includes('api.resend.com')) {
    const body = JSON.parse(init.body);
    emails.push({
      to: Array.isArray(body.to) ? body.to.join(',') : String(body.to),
      subject: body.subject,
      text: String(body.text || ''),
    });
    return { ok: true, status: 200, json: async () => ({ id: 'qa-mail' }) };
  }
  throw new Error(`[qa] blocked outbound request: ${target}`);
};

// ---------------------------------------------------------------------------
// sandbox + bundling of the REAL handlers
// ---------------------------------------------------------------------------
function rmrf(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

const API_DIR = path.join(REPO, 'api');
const CF_DIR = path.join(SITE, 'functions');
const API_FWD = API_DIR.replace(/\\/g, '/');
const CF_FWD = CF_DIR.replace(/\\/g, '/');

const API_ENTRY = `export { default as auth } from '${API_FWD}/portal/auth.ts';
export { default as invites } from '${API_FWD}/portal/invites.ts';
export { default as projects } from '${API_FWD}/portal/projects.ts';
export { default as testimonials } from '${API_FWD}/portal/testimonials.ts';
export { default as moderate } from '${API_FWD}/moderate/review.ts';
export { RateLimiter, createFileBackend, createMemoryBackend, createPortalRateLimiter, portalRateLimiter } from '${API_FWD}/lib/rate-limit.ts';
`;

const CF_ENTRY = `export { onRequestGet as cfProjectsGet, onRequestPost as cfProjectsPost, onRequestPatch as cfProjectsPatch } from '${CF_FWD}/api/portal/projects.ts';
export { onRequestGet as cfTestimonialsGet, onRequestPost as cfTestimonialsPost } from '${CF_FWD}/api/portal/testimonials.ts';
export { onRequestGet as cfCommentsGet, onRequestPost as cfCommentsPost } from '${CF_FWD}/api/portal/comments.ts';
export { onRequestGet as cfPlanItemsGet, onRequestPost as cfPlanItemsPost, onRequestPatch as cfPlanItemsPatch } from '${CF_FWD}/api/portal/plan-items.ts';
export { onRequestGet as cfUpdatesGet, onRequestPost as cfUpdatesPost } from '${CF_FWD}/api/portal/updates.ts';
export { onRequestPost as cfInvitesPost } from '${CF_FWD}/api/portal/invites.ts';
export { onRequestGet as cfAuthGet, onRequestPost as cfAuthPost } from '${CF_FWD}/api/portal/auth.ts';
export { onRequestGet as cfModerateGet, onRequestPost as cfModeratePost } from '${CF_FWD}/api/moderate/review.ts';
export { createKvBackend as cfCreateKvBackend, createMemoryBackend as cfCreateMemoryBackend, RateLimiter as cfRateLimiter } from '${CF_FWD}/api/lib/rate-limit.ts';
export { buildModerationUrl as cfBuildModerationUrl } from '${CF_FWD}/api/lib/notifications.ts';
`;

const ROUTES = [
  ['/api/portal/auth', 'auth'],
  ['/api/portal/invites', 'invites'],
  ['/api/portal/projects', 'projects'],
  ['/api/portal/testimonials', 'testimonials'],
  ['/api/moderate/review', 'moderate'],
];

const PORTAL_DIR = path.join(SANDBOX, 'site', 'data', 'portal');
const MODERATION_DIR = path.join(SANDBOX, 'site', 'data', 'moderation');
const INVITED_FILE = path.join(PORTAL_DIR, 'invited.jsonl');
const PROJECTS_FILE = path.join(PORTAL_DIR, 'projects.jsonl');
const CLIENTS_FILE = path.join(PORTAL_DIR, 'clients.jsonl');
const REVIEWS_FILE = path.join(MODERATION_DIR, 'reviews.jsonl');
const COUNTER_FILE = path.join(SANDBOX, 'rate-counters.json');

let api = null;
let api2 = null;
let server = null;
let server2 = null;

async function bundleTo(entry, outFile) {
  const entryFile = path.join(SANDBOX, 'entry-' + path.basename(outFile) + '.ts');
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(entryFile, entry, 'utf8');
  await build({
    entryPoints: [entryFile],
    outfile: outFile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    absWorkingDir: REPO,
    external: ['node:http', 'node:crypto', 'node:fs', 'node:path', 'node:os'],
    logLevel: 'silent',
  });
  return outFile;
}

function makeServer(handlerMap, port) {
  return createServer(async (req, res) => {
    const url = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
    let name = null;
    for (const [prefix, handlerName] of ROUTES) {
      if (url.pathname === prefix || url.pathname.startsWith(prefix + '/')) {
        name = handlerName;
        break;
      }
    }
    if (!name) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }
    try {
      await handlerMap[name](req, res);
    } catch (err) {
      console.error('[qa] handler error', name, err);
      if (!res.writableEnded) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal server error' }));
      }
    }
  });
}

async function startServer() {
  const outFile = await bundleTo(API_ENTRY, path.join(SANDBOX, 'bundle', 'api.cjs'));
  // The handlers resolve their data paths from process.cwd() at module load --
  // the cwd must already be the sandbox before the bundle is required.
  process.chdir(SANDBOX);
  api = require(outFile);
  server = makeServer(api, PORT);
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
}

/** A SECOND, independent module instance of the same handlers (a bad path). */
async function startSecondServer() {
  const outFile = await bundleTo(API_ENTRY, path.join(SANDBOX, 'bundle', 'api2.cjs'));
  api2 = require(outFile);
  server2 = makeServer(api2, PORT2);
  await new Promise((resolve) => server2.listen(PORT2, '127.0.0.1', resolve));
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
async function req(method, pathname, opts = {}) {
  const base = opts.base || ORIGIN;
  const headers = { ...(opts.headers || {}) };
  if (opts.cookie) headers.Cookie = opts.cookie;
  if (opts.origin !== undefined) headers.Origin = opts.origin;
  if (opts.ip) headers['x-forwarded-for'] = opts.ip;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(`${base}${pathname}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    redirect: 'manual',
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  const setCookie = res.headers.getSetCookie
    ? res.headers.getSetCookie()
    : res.headers.get('set-cookie')
      ? [res.headers.get('set-cookie')]
      : [];
  return { status: res.status, headers: res.headers, text, json, setCookie };
}

function cookieValue(setCookie, name) {
  for (const c of setCookie) {
    const m = new RegExp(`(?:^|;\\s*)${name}=([^;]*)`).exec(c);
    if (m) return `${name}=${m[1]}`;
  }
  return null;
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return { __malformed: l };
      }
    });
}

function urlMatching(mail, pathFragment) {
  const re = new RegExp(`(https?://\\S*${pathFragment}\\S*)`);
  const m = re.exec(mail.text);
  assert(m, `no "${pathFragment}" link found in the mail -- subject: ${mail.subject}`);
  return m[1].trim();
}

// ---------------------------------------------------------------------------
// scenario helpers -- the whole flow goes through the REAL API
// ---------------------------------------------------------------------------
async function signIn(email, ip, base = ORIGIN) {
  const before = emails.length;
  const r = await req('POST', '/api/portal/auth/request-link', {
    base,
    body: { email },
    origin: base,
    ip,
  });
  assertEqual(r.status, 200, `request-link for ${email} should be 200 (got ${r.status}: ${r.text})`);
  const mail = emails.slice(before).find((e) => e.to.includes(email));
  assert(mail, `no sign-in mail was sent to ${email}`);
  const verifyUrl = urlMatching(mail, '/login/verify\\?token=');
  const parsed = new URL(verifyUrl);
  const v = await req(
    'GET',
    `/api/portal/auth/verify?token=${encodeURIComponent(parsed.searchParams.get('token') || '')}`,
    { base },
  );
  assertEqual(v.status, 200, `verify for ${email} should be 200 (got ${v.status}: ${v.text})`);
  const cookie =
    cookieValue(v.setCookie, 'imk_admin_session') || cookieValue(v.setCookie, 'imk_session');
  assert(cookie, `no session cookie was issued for ${email}`);
  return { cookie, role: v.json.role };
}

async function inviteClient(email, name, base = ORIGIN, cookie = null) {
  const inv = await req('POST', '/api/portal/invites', {
    base,
    cookie: cookie || owner.cookie,
    origin: base,
    body: { email, name, company: 'Wave3 Ltd', role: 'CTO' },
  });
  assertEqual(inv.status, 200, `invite for ${email} should be 200 (got ${inv.status}: ${inv.text})`);
  return inv.json.invited;
}

async function createProject(email, title, base = ORIGIN, cookie = null) {
  const proj = await req('POST', '/api/portal/projects', {
    base,
    cookie: cookie || owner.cookie,
    origin: base,
    body: { title, clientId: email, status: 'completed' },
  });
  assertEqual(proj.status, 200, `project should be 200 (got ${proj.status}: ${proj.text})`);
  return proj.json.project;
}

async function submitQuote(session, projectId, review, consent, base = ORIGIN) {
  return req('POST', '/api/portal/testimonials', {
    base,
    cookie: session.cookie,
    origin: base,
    body: { projectId, action: 'submit', review, rating: 5, consent },
  });
}

function counterState() {
  if (!fs.existsSync(COUNTER_FILE)) return { version: 1, buckets: {} };
  return JSON.parse(fs.readFileSync(COUNTER_FILE, 'utf8'));
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

/** QA's OWN signing of a moderation link -- not the project's helper. */
function qaSignModeration(ref, decision, revision, ts, secret = SECRET) {
  return crypto.createHmac('sha256', secret).update(`${ref}|${decision}|${revision}|${ts}`).digest('hex');
}

function qaModerationUrl(ref, decision, revision, ts, base = ORIGIN) {
  const sig = qaSignModeration(ref, decision, revision, ts);
  return `${base}/api/moderate/review?ref=${encodeURIComponent(ref)}&decision=${encodeURIComponent(
    decision,
  )}&revision=${revision}&sig=${encodeURIComponent(sig)}&ts=${ts}`;
}

// ---------------------------------------------------------------------------
// the Cloudflare tree, executed in a Web-standard runtime
// ---------------------------------------------------------------------------
let cf = null;

async function loadCf() {
  const outFile = await bundleTo(CF_ENTRY, path.join(SANDBOX, 'bundle', 'cf.cjs'));
  cf = require(outFile);
}

/**
 * A fake node:fs bound to globalThis.require, rooted at the sandbox.
 *
 * renameSync is part of it because the moderation log is written ATOMICALLY
 * (the content goes to a temporary file and is then renamed over the target).
 * The write path is only reached by a POST -- a GET decides nothing -- so a
 * mock without renameSync would fail exactly where the decision is made.
 */
function bindEdgeFs() {
  const real = require('node:fs');
  globalThis.require = (id) => {
    if (id === 'node:fs') {
      return {
        existsSync: (p) => real.existsSync(path.resolve(process.cwd(), p)),
        readFileSync: (p, enc) => real.readFileSync(path.resolve(process.cwd(), p), enc),
        writeFileSync: (p, data, enc) => real.writeFileSync(path.resolve(process.cwd(), p), data, enc),
        mkdirSync: (p, opts) => real.mkdirSync(path.resolve(process.cwd(), p), opts),
        renameSync: (from, to) =>
          real.renameSync(path.resolve(process.cwd(), from), path.resolve(process.cwd(), to)),
      };
    }
    return require(id);
  };
}

function unbindEdgeFs() {
  delete globalThis.require;
}

function cfCtx(url, method, env = {}, headers = {}) {
  const absolute = /^https?:\/\//.test(url) ? url : `${ORIGIN}${url}`;
  return {
    request: new Request(absolute, { method, headers }),
    env: {
      SITE_BASE_URL: ORIGIN,
      FORM_WEBHOOK_SECRET: SECRET,
      RESEND_API_KEY: 'qa-cf-key',
      RESEND_TO: ADMIN_EMAIL,
      ...env,
    },
    params: {},
  };
}

async function cfCall(fn, url, method, env, headers) {
  const res = await fn(cfCtx(url, method, env, headers));
  let body = null;
  try {
    body = await res.clone().json();
  } catch {
    /* not json */
  }
  return { status: res.status, body };
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------
let owner = null;
const clients = {};

async function main() {
  fs.mkdirSync(PORTAL_DIR, { recursive: true });
  fs.mkdirSync(MODERATION_DIR, { recursive: true });

  // ---------------------------------------------------------------------
  // The durable counter file MUST be configured before the handlers are
  // loaded: api/lib/rate-limit.ts creates its limiter at module load.
  // ---------------------------------------------------------------------
  process.env.PORTAL_RATE_LIMIT_FILE = COUNTER_FILE;

  await startServer();
  await loadCf();

  owner = await signIn(ADMIN_EMAIL, IP_A);

  // =====================================================================
  group('A -- the pluggable limiter through the REAL handlers (durable file backend)');
  // =====================================================================

  const emailA = 'wave3.a@client.test';
  await inviteClient(emailA, 'Wanda Wave3');
  const clientA = await signIn(emailA, IP_B);
  const projectA = await createProject(emailA, 'Wave3 project A');

  await t('A1', 'the durable counter file is really the backend in play', async () => {
    // one invalid request first, so a file must appear if the limiter writes
    const bad = await submitQuote(clientA, projectA.id, 'not a valid submission', { p1: false });
    assertEqual(bad.status, 400, 'a submission without consent p1 must be 400');
    assertEqual(bad.json.code, 'consent-required', 'the refusal must name the consent rule');
    assert(fs.existsSync(COUNTER_FILE), 'the durable counter file was never written');
    return `counter file: ${path.basename(COUNTER_FILE)} (${fs.statSync(COUNTER_FILE).size} bytes)`;
  });

  await t('A2', 'an invalid submission burns NO slot in the NEW code path', async () => {
    const state = counterState();
    const buckets = Object.values(state.buckets || {});
    // the sign-in requests consumed the per-IP bucket; the submit bucket must
    // not exist yet, because the only submit so far was refused.
    const client = readJsonl(CLIENTS_FILE).find((c) => c.email === emailA);
    assert(client, 'the client record was not written');
    const submitKey = sha256(`submit:${client.id}`);
    const present = state.buckets[submitKey];
    assert(
      !present || present.count === 0,
      `the refused submission consumed a slot -- the submit bucket is ${JSON.stringify(present)}`,
    );
    return `no submit bucket yet (${Object.keys(state.buckets || {}).length} bucket(s) in the file)`;
  });

  await t('A3', 'five valid submissions are allowed and the sixth is refused', async () => {
    const statuses = [];
    for (let i = 0; i < 6; i++) {
      const r = await submitQuote(
        clientA,
        projectA.id,
        `A wave-3 quote number ${i}`,
        { p1: true, p2: true, p3: false },
      );
      statuses.push(r.status);
    }
    assertEqual(
      statuses.join(','),
      '200,200,200,200,200,429',
      'the submit limit must be 5 per client per hour',
    );
    return `statuses=${statuses.join(',')}`;
  });

  await t('A4', 'the counter file counts the valid requests and not the refused one', async () => {
    const state = counterState();
    const client = readJsonl(CLIENTS_FILE).find((c) => c.email === emailA);
    const bucket = state.buckets[sha256(`submit:${client.id}`)];
    assert(bucket, 'the submit bucket is missing from the counter file');
    // 7 submit requests were made: 1 refused by validation + 5 allowed + 1
    // refused by the limit. The counter must have consumed 5 or 6 of them
    // (the blocked one is counted as well, because check and consume are one
    // operation) -- but never 7, which would mean the refused-by-validation
    // request burned a slot too.
    assert(
      bucket.count >= 5 && bucket.count <= 6,
      `the durable counter counted ${bucket.count} of 7 submit requests -- the request refused by validation must not consume a slot`,
    );
    return `submit bucket count=${bucket.count} of 7 requests (1 refused by validation)`;
  });

  await t('A5', 'no client id, email or IP address reaches the counter file', async () => {
    const raw = fs.readFileSync(COUNTER_FILE, 'utf8');
    const client = readJsonl(CLIENTS_FILE).find((c) => c.email === emailA);
    for (const secretish of [emailA, client.id, IP_B, 'submit:', client.email]) {
      assert(
        !raw.includes(secretish),
        `the counter file leaks "${secretish}": ${raw.slice(0, 400)}`,
      );
    }
    for (const key of Object.keys(counterState().buckets)) {
      assert(/^[0-9a-f]{64}$/.test(key), `bucket key is not a sha256 digest: ${key}`);
    }
    return `all bucket keys are sha256 digests (${Object.keys(counterState().buckets).length} keys)`;
  });

  await t('A6', 'the edge KV backend stores no raw key either', async () => {
    const seen = [];
    const fakeKv = {
      async get(k) {
        seen.push(k);
        return null;
      },
      async put(k) {
        seen.push(k);
      },
    };
    const backend = cf.cfCreateKvBackend(fakeKv, 'portal');
    await backend.hit(`ip:${IP_C}`, 3600_000);
    await backend.hit(`submit:wave3-kv-client@client.test`, 3600_000);
    assert(seen.length >= 2, 'the KV backend never wrote a key');
    for (const k of seen) {
      assert(!k.includes(IP_C), `the KV key leaks the IP address: ${k}`);
      assert(
        !k.includes('wave3-kv-client@client.test'),
        `the KV key leaks the client id: ${k}`,
      );
      assert(/^portal:[0-9a-f]{64}$/.test(k), `the KV key is not a hashed digest: ${k}`);
    }
    return `kv keys: ${seen.join(', ')}`;
  });

  await t('A7', 'a backend that throws degrades instead of failing the request', async () => {
    const rl = new api.RateLimiter({
      async hit() {
        throw new Error('backend exploded');
      },
    });
    const d = await rl.consume('degrade-key', 5, 60_000);
    assertEqual(d.degraded, true, 'the limiter must report the degraded fallback');
    assertEqual(d.allowed, true, 'the in-memory fallback must still enforce the limit');
    assertEqual(d.count, 1, 'the fallback counter must count the hit');
    const d2 = await rl.consume('degrade-key', 5, 60_000);
    assertEqual(d2.count, 2, 'the fallback counter must keep counting');
    return 'degraded=true, the request still proceeded';
  });

  await t('A8', 'a durable backend that cannot write degrades at the HANDLER level', async () => {
    // A path whose parent is a regular file: mkdirSync throws, so the file
    // backend throws on every hit -- the request must still be served.
    const blocker = path.join(SANDBOX, 'blocker');
    fs.writeFileSync(blocker, 'i am a file, not a directory', 'utf8');
    const badPath = path.join(blocker, 'counters.json');

    const emailB = 'wave3.b@client.test';
    await inviteClient(emailB, 'Wanda Degrade');

    // A second, independent instance of the same handlers -- a different
    // module instance, so it reads the environment now.
    const prev = process.env.PORTAL_RATE_LIMIT_FILE;
    process.env.PORTAL_RATE_LIMIT_FILE = badPath;
    await startSecondServer();
    process.env.PORTAL_RATE_LIMIT_FILE = prev;

    // The second instance answers on its own port, so its origin check needs
    // its own base URL while it runs.
    const withBase = async (base, fn) => {
      const saved = process.env.SITE_BASE_URL;
      process.env.SITE_BASE_URL = base;
      try {
        return await fn();
      } finally {
        process.env.SITE_BASE_URL = saved;
      }
    };

    // The client signs in on the second instance, so its session lives there.
    const clientB = await withBase(ORIGIN2, () => signIn(emailB, IP_C, ORIGIN2));
    // The project is created through the first instance, but only after the
    // client record exists (the owner may only attach a project to a client
    // that has signed in at least once).
    const projectB = await withBase(ORIGIN, () => createProject(emailB, 'Wave3 project B'));

    const r = await withBase(ORIGIN2, () =>
      submitQuote(
        clientB,
        projectB.id,
        'a quote that must survive a broken counter backend',
        { p1: true, p2: true, p3: false },
        ORIGIN2,
      ),
    );
    assert(
      r.status !== 500,
      `the broken counter backend produced a 500 -- the limiter must degrade, got ${r.status}: ${r.text}`,
    );
    assertEqual(r.status, 200, `the submission should have succeeded, got ${r.status}: ${r.text}`);
    assert(!fs.existsSync(badPath), 'the counter file must not exist -- the path is unusable');
    return `status=${r.status} (no 500, the request was served)`;
  });

  // =====================================================================
  group('B -- the Cloudflare tree, executed in a Web-standard runtime');
  // =====================================================================

  await t('B1', 'every Cloudflare portal endpoint refuses to answer 200', async () => {
    const env = { SITE_BASE_URL: ORIGIN };
    const headers = { origin: ORIGIN, cookie: 'imk_session=does-not-exist' };
    const cases = [
      ['cfProjectsGet', '/api/portal/projects', 'GET'],
      ['cfProjectsGet', '/api/portal/projects/proj_1', 'GET'],
      ['cfProjectsPost', '/api/portal/projects', 'POST'],
      ['cfProjectsPatch', '/api/portal/projects/proj_1', 'PATCH'],
      ['cfTestimonialsGet', '/api/portal/testimonials?projectId=proj_1', 'GET'],
      ['cfTestimonialsPost', '/api/portal/testimonials', 'POST'],
      ['cfCommentsGet', '/api/portal/comments?projectId=proj_1', 'GET'],
      ['cfCommentsPost', '/api/portal/comments', 'POST'],
      ['cfPlanItemsGet', '/api/portal/plan-items?projectId=proj_1', 'GET'],
      ['cfPlanItemsPost', '/api/portal/plan-items', 'POST'],
      ['cfPlanItemsPatch', '/api/portal/plan-items/pi_1', 'PATCH'],
      ['cfUpdatesGet', '/api/portal/updates?projectId=proj_1', 'GET'],
      ['cfUpdatesPost', '/api/portal/updates', 'POST'],
      ['cfInvitesPost', '/api/portal/invites', 'POST'],
      ['cfAuthPost', '/api/portal/auth/request-link', 'POST'],
      ['cfAuthGet', '/api/portal/auth/verify?token=abc', 'GET'],
    ];
    const seen = [];
    for (const [fn, url, method] of cases) {
      const r = await cfCall(cf[fn], url, method, env, headers);
      seen.push(`${method} ${url} -> ${r.status}${r.body && r.body.code ? ' ' + r.body.code : ''}`);
      assert(
        r.status !== 200,
        `${method} ${url} answered 200 on a runtime without a filesystem -- an empty answer must not look like a normal one: ${JSON.stringify(r.body)}`,
      );
      if (r.status === 200) {
        throw new Error('unreachable');
      }
      const listish =
        r.body &&
        (Array.isArray(r.body.projects) ||
          Array.isArray(r.body.comments) ||
          Array.isArray(r.body.updates) ||
          Array.isArray(r.body.planItems));
      assert(!listish, `${method} ${url} answered 200 with a collection: ${JSON.stringify(r.body)}`);
    }
    return seen.join(' | ');
  });

  await t('B2', 'the Cloudflare moderation endpoint accepts a Vercel-signed link', async () => {
    const ref = 'rev_cfparity0001';
    fs.writeFileSync(
      REVIEWS_FILE,
      JSON.stringify({
        ref,
        type: 'review',
        state: 'pending',
        revision: 1,
        name: 'Nora Edge',
        review: 'A quote that the owner is looking at right now.',
        rating: '5',
        receivedAt: new Date().toISOString(),
      }) + '\n',
      'utf8',
    );
    const ts = Math.floor(Date.now() / 1000);
    // QA signs the link itself, with node:crypto, exactly as the Vercel tree
    // does -- the CF tree must accept it.
    const url = qaModerationUrl(ref, 'approve', 1, ts);
    bindEdgeFs();
    try {
      // M-1 (wave-8A): the DECISION is the POST. A GET only shows the
      // confirmation page, so a mail scanner that prefetches the link
      // decides nothing.
      const r = await cfCall(
        cf.cfModeratePost,
        url.replace(ORIGIN, ''),
        'POST',
        { SITE_BASE_URL: ORIGIN },
        {},
      );
      unbindEdgeFs();
      assertEqual(r.status, 200, `the CF endpoint must accept the Vercel-signed link, got ${r.status}: ${JSON.stringify(r.body)}`);
      const record = readJsonl(REVIEWS_FILE).find((x) => x.ref === ref);
      assertEqual(record.state, 'approved', 'the link must have flipped the newest line');
      return 'the Vercel-signed link was accepted and the record was approved';
    } finally {
      unbindEdgeFs();
    }
  });

  await t('B2b', 'M-1: a GET on the Cloudflare moderation link decides NOTHING', async () => {
    const ref = 'rev_cfparity0001b';
    fs.writeFileSync(
      REVIEWS_FILE,
      JSON.stringify({
        ref,
        type: 'review',
        state: 'pending',
        revision: 1,
        name: 'Nora Edge',
        review: 'A quote a mail scanner will prefetch.',
        rating: '5',
        receivedAt: new Date().toISOString(),
      }) + '\n',
      'utf8',
    );
    const ts = Math.floor(Date.now() / 1000);
    const url = qaModerationUrl(ref, 'approve', 1, ts);
    bindEdgeFs();
    try {
      const r = await cfCall(cf.cfModerateGet, url.replace(ORIGIN, ''), 'GET', { SITE_BASE_URL: ORIGIN }, {});
      assertEqual(r.status, 200, `the GET must serve the confirmation page, got ${r.status}: ${JSON.stringify(r.body)}`);
      const record = readJsonl(REVIEWS_FILE).find((x) => x.ref === ref);
      assertEqual(record.state, 'pending', 'a GET must not approve anything');
      assertEqual(
        readJsonl(REVIEWS_FILE).filter((x) => x.ref === ref && x.state === 'approved').length,
        0,
        'no line may be approved by a GET',
      );
      // ...and the POST of the same link IS the decision.
      const decided = await cfCall(cf.cfModeratePost, url.replace(ORIGIN, ''), 'POST', { SITE_BASE_URL: ORIGIN }, {});
      assertEqual(decided.status, 200, `the POST must decide, got ${decided.status}: ${JSON.stringify(decided.body)}`);
      const after = readJsonl(REVIEWS_FILE).find((x) => x.ref === ref);
      assertEqual(after.state, 'approved', 'the POST must approve');
      return 'the GET left the quote pending; the POST approved it';
    } finally {
      unbindEdgeFs();
    }
  });

  await t('B3', 'the Cloudflare moderation endpoint rejects a forged link', async () => {
    const ref = 'rev_cfparity0002';
    fs.writeFileSync(
      REVIEWS_FILE,
      JSON.stringify({
        ref,
        type: 'review',
        state: 'pending',
        revision: 1,
        name: 'Nora Edge',
        review: 'A quote that must NOT be approved by a forged link.',
        rating: '5',
        receivedAt: new Date().toISOString(),
      }) + '\n',
      'utf8',
    );
    const ts = Math.floor(Date.now() / 1000);
    const forged = `${ORIGIN}/api/moderate/review?ref=${ref}&decision=approve&revision=1&sig=${'a'.repeat(64)}&ts=${ts}`;
    bindEdgeFs();
    const r = await cfCall(
      cf.cfModerateGet,
      forged.replace(ORIGIN, ''),
      'GET',
      { SITE_BASE_URL: ORIGIN },
      {},
    );
    // The DECISION path must refuse it as well (M-1: the POST decides).
    const posted = await cfCall(
      cf.cfModeratePost,
      forged.replace(ORIGIN, ''),
      'POST',
      { SITE_BASE_URL: ORIGIN },
      {},
    );
    unbindEdgeFs();
    assertEqual(r.status, 400, `a forged link must be refused, got ${r.status}: ${JSON.stringify(r.body)}`);
    assertEqual(
      posted.status,
      400,
      `a forged link must be refused on the decision path too, got ${posted.status}: ${JSON.stringify(posted.body)}`,
    );
    const record = readJsonl(REVIEWS_FILE).find((x) => x.ref === ref);
    assertEqual(record.state, 'pending', 'a forged link must not change anything');
    return `status=${r.status} code=${r.body && r.body.code} (the POST is refused too)`;
  });

  await t('B4', 'a link for a superseded revision approves nothing on Cloudflare', async () => {
    const ref = 'rev_cfparity0003';
    fs.writeFileSync(
      REVIEWS_FILE,
      JSON.stringify({
        ref,
        type: 'review',
        state: 'pending',
        revision: 3,
        name: 'Nora Edge',
        review: 'The CURRENT text of the quote.',
        rating: '5',
        receivedAt: new Date().toISOString(),
      }) + '\n',
      'utf8',
    );
    const ts = Math.floor(Date.now() / 1000);
    const url = qaModerationUrl(ref, 'approve', 1, ts);
    bindEdgeFs();
    const r = await cfCall(
      cf.cfModeratePost,
      url.replace(ORIGIN, ''),
      'POST',
      { SITE_BASE_URL: ORIGIN },
      {},
    );
    unbindEdgeFs();
    assertEqual(r.status, 409, `a stale link must be refused with 409, got ${r.status}: ${JSON.stringify(r.body)}`);
    const record = readJsonl(REVIEWS_FILE).find((x) => x.ref === ref);
    assertEqual(record.state, 'pending', 'a stale link must not approve anything');
    return `status=${r.status} code=${r.body && r.body.code}`;
  });

  await t('B5', 'a malformed moderation store must NOT read as "review not found" on Cloudflare', async () => {
    // The Vercel tree answers 500 {code:storage} for a corrupt store (the
    // shared strict parser). The CF twin keeps its own reader -- if that
    // reader swallows the bad line, the owner is told the quote is gone
    // while it is still pending. That is the M3/D3 class again.
    const ref = 'rev_cfparity0004';
    fs.writeFileSync(
      REVIEWS_FILE,
      JSON.stringify({
        ref,
        type: 'review',
        state: 'pending',
        revision: 1,
        name: 'Nora Edge',
        review: 'A quote that is still waiting for the owner.',
        rating: '5',
        receivedAt: new Date().toISOString(),
      }) +
        '\n{ this line is not json\n' +
        JSON.stringify({
          ref,
          type: 'review',
          state: 'pending',
          revision: 1,
          name: 'Nora Edge',
          review: 'A quote that is still waiting for the owner.',
          rating: '5',
          receivedAt: new Date().toISOString(),
        }) +
        '\n',
      'utf8',
    );
    const ts = Math.floor(Date.now() / 1000);
    const url = qaModerationUrl(ref, 'approve', 1, ts);
    bindEdgeFs();
    const r = await cfCall(
      cf.cfModerateGet,
      url.replace(ORIGIN, ''),
      'GET',
      { SITE_BASE_URL: ORIGIN },
      {},
    );
    unbindEdgeFs();
    assert(
      r.status !== 404,
      `a malformed store answered 404 "review not found" -- the corrupt store looks like a missing quote (audit M3 / QA D3). The CF twin must answer 500 {code:storage} like the Vercel tree. Got ${r.status}: ${JSON.stringify(r.body)}`,
    );
    assertEqual(r.status, 500, `the corrupt store must answer 500 storage, got ${r.status}`);
    return `status=${r.status} code=${r.body && r.body.code}`;
  });

  await t('B6', 'the Vercel tree answers 500 storage for the SAME malformed store', async () => {
    // The control: the Vercel tree is supposed to fail closed. If the CF twin
    // answers something else, the two trees disagree.
    fs.writeFileSync(
      REVIEWS_FILE,
      JSON.stringify({
        ref: 'rev_control0001',
        type: 'review',
        state: 'pending',
        revision: 1,
        name: 'Nora Edge',
        review: 'A quote that is still waiting for the owner.',
        rating: '5',
        receivedAt: new Date().toISOString(),
      }) + '\n{ this line is not json\n',
      'utf8',
    );
    const ts = Math.floor(Date.now() / 1000);
    const url = qaModerationUrl('rev_control0001', 'approve', 1, ts);
    const r = await req('GET', url.replace(ORIGIN, ''));
    assertEqual(r.status, 500, `the Vercel tree must answer 500 storage, got ${r.status}: ${r.text}`);
    return `status=${r.status} code=${r.json && r.json.code}`;
  });

  // =====================================================================
  group('C -- the durable counter file under the production topology');
  // =====================================================================

  await t('C1', 'CONTROL: one process writing the counter file loses nothing', async () => {
    const raceFile = path.join(SANDBOX, 'race-control.json');
    const bundle = path.join(SANDBOX, 'bundle', 'api.cjs');
    const KEYS = 25;
    rmrf(raceFile);
    const script =
      `const api = require(${JSON.stringify(bundle)});` +
      `(async () => { for (let i = 0; i < ${KEYS}; i++) ` +
      `await api.portalRateLimiter.consume('solo-' + i, 100000, 600000); ` +
      `process.exit(0); })().catch(() => process.exit(3));`;
    const rc = await new Promise((resolve) => {
      execFile(
        process.execPath,
        ['-e', script],
        { cwd: SANDBOX, env: { ...process.env, PORTAL_RATE_LIMIT_FILE: raceFile } },
        (err) => resolve(err ? `child failed: ${err.message}` : 'ok'),
      );
    });
    assertEqual(rc, 'ok', rc);
    const state = JSON.parse(fs.readFileSync(raceFile, 'utf8'));
    const keys = Object.keys(state.buckets || {});
    assertEqual(
      keys.length,
      KEYS,
      'a single writer must not lose a bucket -- if this fails, the loss is not caused by concurrency',
    );
    return `${keys.length}/${KEYS} buckets kept by one writer`;
  });

  await t('C2', 'two serverless functions writing the SAME counter file do not lose counts', async () => {
    // In production api/portal/testimonials.ts and api/portal/auth.ts are
    // SEPARATE Vercel functions: separate processes, separate module
    // instances, the same counter file. The file backend is a read-modify-
    // write with no lock, so the two processes can clobber each other.
    const raceFile = path.join(SANDBOX, 'race-counters.json');
    const bundle = path.join(SANDBOX, 'bundle', 'api.cjs');
    const KEYS = 25;
    const child = (tag) =>
      new Promise((resolve) => {
        const script =
          `const api = require(${JSON.stringify(bundle)});` +
          `(async () => { for (let i = 0; i < ${KEYS}; i++) ` +
          `await api.portalRateLimiter.consume(${JSON.stringify(tag)} + '-' + i, 100000, 600000); ` +
          `process.exit(0); })().catch(() => process.exit(3));`;
        execFile(
          process.execPath,
          ['-e', script],
          {
            cwd: SANDBOX,
            env: { ...process.env, PORTAL_RATE_LIMIT_FILE: raceFile },
          },
          (err) => resolve(err ? `child failed: ${err.message}` : 'ok'),
        );
      });

    let lostRounds = 0;
    let lostBuckets = 0;
    const rounds = 4;
    for (let i = 0; i < rounds; i++) {
      rmrf(raceFile);
      const results = await Promise.all([child(`alpha${i}`), child(`beta${i}`)]);
      for (const r of results) assert(r === 'ok', r);
      const state = JSON.parse(fs.readFileSync(raceFile, 'utf8'));
      const keys = Object.keys(state.buckets || {});
      if (keys.length < KEYS * 2) {
        lostRounds++;
        lostBuckets += KEYS * 2 - keys.length;
      }
    }
    assertEqual(
      lostRounds,
      0,
      `${lostRounds} of ${rounds} concurrent write rounds lost buckets (${lostBuckets} of ${rounds * KEYS * 2} in total) -- the file backend is a read-modify-write with no lock, and two Vercel functions share the file`,
    );
    return `${rounds} concurrent write rounds, no lost bucket`;
  });

  // =====================================================================
  group('D -- the route table of the launch target (static analysis)');
  // =====================================================================

  await t('D1', 'the bare auth path has no route (404) while the sub-path answers', async () => {
    // Vercel serves a function at its FILE PATH: api/portal/auth.ts serves
    // /api/portal/auth. The front-end calls /api/portal/auth/request-link
    // and /api/portal/auth/verify.
    const bare = await req('POST', '/api/portal/auth', {
      body: { email: 'route@client.test' },
      origin: ORIGIN,
      ip: IP_A,
    });
    assertEqual(
      bare.status,
      404,
      `the handler must not answer on the bare path, got ${bare.status}: ${bare.text}`,
    );
    const sub = await req('POST', '/api/portal/auth/request-link', {
      body: { email: 'route@client.test' },
      origin: ORIGIN,
      ip: IP_A,
    });
    assert(sub.status !== 404, `the handler must answer on the sub-path, got ${sub.status}`);
    return `bare path -> ${bare.status} (not-found), sub-path -> ${sub.status}`;
  });

  // INVERTED (fix wave 4). Before the fix this check asserted that the
  // repository had NO file that could serve the auth sub-paths -- i.e. it
  // asserted that the F-1 defect was PRESENT. The defect is fixed, so the
  // check now asserts the route table EXISTS. A regression test must assert
  // the required behaviour, not the absence of a file.
  await t('D2', 'the route table exists: the sub-path and by-id routes have a function file in BOTH trees', async () => {
    // Vercel serves a function at its FILE PATH, so /api/portal/auth/request-link
    // and /api/portal/projects/<id> need their own file in BOTH trees.
    const required = [
      ['portal', 'auth', 'request-link.ts'],
      ['portal', 'auth', 'verify.ts'],
      ['portal', 'auth', 'logout.ts'],
      ['portal', 'projects', '[id].ts'],
      ['portal', 'plan-items', '[id].ts'],
    ];
    const trees = [
      ['vercel', API_DIR],
      ['cloudflare', path.join(CF_DIR, 'api')],
    ];
    const missing = [];
    for (const [name, dir] of trees) {
      for (const segs of required) {
        const file = path.join(dir, ...segs);
        if (!fs.existsSync(file)) missing.push(`${name}: ${path.relative(REPO, file)}`);
      }
    }
    assertEqual(missing.length, 0, `the route table is incomplete -- missing: ${missing.join(', ')}`);

    // A dynamic segment is `[id].ts` -- the platform's dynamic-route syntax.
    // It is NOT a catch-all: a catch-all (`[...slug].ts`, `[[...slug]].ts`)
    // would swallow every unmatched path, which is a different and dangerous
    // shape.
    const catchalls = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/^\[\[|\[\.\.\./.test(e.name)) catchalls.push(path.relative(REPO, p));
      }
    };
    walk(API_DIR);
    walk(path.join(CF_DIR, 'api'));
    assertEqual(catchalls.length, 0, `the trees contain catch-all routes: ${catchalls.join(', ')}`);

    // The deploy root: the api/ tree lives outside site/, so the Vercel
    // project must be rooted at the REPO root and the build must say so.
    const vercelJson = JSON.parse(fs.readFileSync(path.join(REPO, 'vercel.json'), 'utf8'));
    assert(
      String(vercelJson.outputDirectory || '').includes('site'),
      `vercel.json does not point at the site build: ${JSON.stringify(vercelJson.outputDirectory)}`,
    );
    assert(
      fs.existsSync(path.join(REPO, 'package.json')),
      'the repo root has no package.json -- a Vercel project rooted at the repo root cannot install',
    );
    return '5 route files in each tree, no catch-all, the deploy root is declared';
  });

  await t('D3', 'the front-end calls the auth sub-paths that the route table lacks', async () => {
    const hits = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(astro|ts|tsx|js|mjs)$/.test(e.name)) {
          const text = fs.readFileSync(p, 'utf8');
          for (const m of text.matchAll(/\/api\/portal\/auth\/[a-z-]+/g)) hits.push(m[0]);
        }
      }
    };
    walk(path.join(SITE, 'src'));
    const unique = [...new Set(hits)].sort();
    assert(unique.length >= 2, `the front-end does not call the auth sub-paths: ${unique.join(', ')}`);
    return `front-end calls: ${unique.join(', ')}`;
  });

  // =====================================================================
  group('E -- housekeeping');
  // =====================================================================

  await t('E1', 'the repository site/data was never touched by this run', async () => {
    const repoReviews = path.join(REPO, 'site', 'data', 'moderation', 'reviews.jsonl');
    const size = fs.existsSync(repoReviews) ? fs.statSync(repoReviews).size : -1;
    assertEqual(size, 0, 'the repository moderation store must still be empty');
    assert(
      !fs.existsSync(path.join(REPO, 'site', 'data', 'portal')),
      'the repository portal store must not exist',
    );
    return 'repo site/data/ untouched';
  });
}

// ---------------------------------------------------------------------------
// teardown + report
// ---------------------------------------------------------------------------
async function shutdown() {
  try {
    if (server) await new Promise((r) => server.close(r));
  } catch {
    /* ignore */
  }
  try {
    if (server2) await new Promise((r) => server2.close(r));
  } catch {
    /* ignore */
  }
}

main()
  .catch((err) => {
    console.error('[qa] suite crashed:', err);
    results.push({
      id: 'FATAL',
      group: currentGroup,
      name: 'the suite itself ran to the end',
      status: 'FAIL',
      error: err && err.message ? err.message : String(err),
    });
  })
  .finally(async () => {
    await shutdown();
    const passed = results.filter((r) => r.status === 'PASS').length;
    const failed = results.filter((r) => r.status === 'FAIL').length;
    console.log(`\n[qa] ${passed} passed, ${failed} failed, ${results.length} checks`);

    if (JSON_OUT) {
      fs.mkdirSync(path.dirname(JSON_OUT), { recursive: true });
      fs.writeFileSync(
        JSON_OUT,
        JSON.stringify(
          {
            suite: 'qa-wave3-independent',
            startedFrom: 'HEAD ' + execHead(),
            passed,
            failed,
            total: results.length,
            results,
          },
          null,
          2,
        ),
        'utf8',
      );
      console.log(`[qa] results: ${JSON_OUT}`);
    }

    if (!KEEP) rmrf(SANDBOX);
    else console.log(`[qa] sandbox kept: ${SANDBOX}`);

    process.exit(failed ? 1 : 0);
  });

function execHead() {
  try {
    return require('node:child_process')
      .execFileSync('git', ['-C', REPO, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' })
      .trim();
  } catch {
    return 'unknown';
  }
}
