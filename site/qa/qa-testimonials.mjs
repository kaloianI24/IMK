// site/qa/qa-testimonials.mjs
//
// QA harness for the reviews / testimonials feature
// (spec/08-portal-mvp.md §4.4, §4.5, §5 and spec/research-client-profiles-testimonials.md).
//
// WHAT THIS IS
//   An executable QA suite that drives the REAL, UNMODIFIED handlers from
//   `api/` and checks them against the acceptance criteria in spec/08.
//   Every assertion maps to a numbered requirement.
//
// ISOLATION (this is the important part)
//   - cwd      -> <sandbox>          the handlers resolve `site/data/...` from
//                                     process.cwd(), so every fixture lands in
//                                     the sandbox and NEVER in the repo
//   - port     -> 4399               never 4321 (the running dev server)
//   - network  -> global fetch stub  no request leaves the machine
//   - records  -> created in <sandbox>, listed in the report
//
// USAGE
//   node site/qa/qa-testimonials.mjs
//   node site/qa/qa-testimonials.mjs --keep          (leave the sandbox on disk)
//   node site/qa/qa-testimonials.mjs --json out.json
//
// NOTE: `esbuild` is imported here the same way site/scripts/dev-portal.js
// does it — it is not a declared dependency of site/package.json (audit
// finding m8); it only resolves because vite depends on it.

import { createServer } from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { handlerPath, fwd } from './handler-paths.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.resolve(__dirname, '..');
const REPO = path.resolve(SITE, '..');
const require = createRequire(import.meta.url);

const argv = process.argv.slice(2);
const KEEP = argv.includes('--keep');
const JSON_OUT = argv.includes('--json') ? argv[argv.indexOf('--json') + 1] : null;

const PORT = Number(process.env.QA_PORT || 4399);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const SANDBOX = path.join(
  os.tmpdir(),
  'opencode',
  `qa-testimonials-${new Date().toISOString().replace(/[:.]/g, '-')}`,
);

// ---------------------------------------------------------------------------
// tiny assertion framework
// ---------------------------------------------------------------------------
const results = [];
let currentGroup = 'general';

function group(name) {
  currentGroup = name;
}

async function t(id, name, fn) {
  const started = Date.now();
  try {
    await fn();
    results.push({ id, group: currentGroup, name, status: 'PASS', ms: Date.now() - started });
    console.log(`  PASS  ${id}  ${name}`);
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
    throw new Error(`${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function note(id, detail) {
  results.push({ id, group: currentGroup, name: id, status: 'PASS', detail });
}

// ---------------------------------------------------------------------------
// sandbox + bundling
// ---------------------------------------------------------------------------
function rmrf(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

// The handler modules under test. The bodies moved out of api/ in wave 13
// (the function budget) and live in site/shared/portal-handlers/ now; the pin
// follows the PRODUCT's route table so it cannot drift from the tree.
const ROOTS = { apiDir: path.join(REPO, 'api'), sharedDir: path.join(SITE, 'shared') };
const ENTRY = `export { default as auth } from '${fwd(handlerPath('portal-auth', ROOTS))}';
export { default as projects } from '${fwd(handlerPath('portal-projects', ROOTS))}';
export { default as invites } from '${fwd(handlerPath('portal-invites', ROOTS))}';
export { default as testimonials } from '${fwd(handlerPath('portal-testimonials', ROOTS))}';
export { default as contact } from '${fwd(handlerPath('contact', ROOTS))}';
export { default as moderate } from '${fwd(handlerPath('moderate', ROOTS))}';
export { default as portalSession } from '${fwd(handlerPath('portal-session', ROOTS))}';
`;

const ROUTES = [
  ['/api/contact', 'contact'],
  ['/api/moderate/review', 'moderate'],
  ['/api/portal/auth', 'auth'],
  ['/api/portal/projects', 'projects'],
  ['/api/portal/invites', 'invites'],
  ['/api/portal/testimonials', 'testimonials'],
  ['/api/portal/session', 'portalSession'],
];

const SANDBOX_PORTAL = path.join(SANDBOX, 'site', 'data', 'portal');
const SANDBOX_MODERATION = path.join(SANDBOX, 'site', 'data', 'moderation');
const INVITED_FILE = path.join(SANDBOX_PORTAL, 'invited.jsonl');
const CLIENTS_FILE = path.join(SANDBOX_PORTAL, 'clients.jsonl');
const PROJECTS_FILE = path.join(SANDBOX_PORTAL, 'projects.jsonl');
const REVIEWS_FILE = path.join(SANDBOX_MODERATION, 'reviews.jsonl');

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
        return null;
      }
    })
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// server + http helpers
// ---------------------------------------------------------------------------
let api = null;
let server = null;
const resendCalls = [];
const logLines = [];
let ipCounter = 0;

async function startServer() {
  const entryFile = path.join(SANDBOX, 'entry.ts');
  const outFile = path.join(SANDBOX, 'bundle', 'api.cjs');
  fs.mkdirSync(path.dirname(entryFile), { recursive: true });
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(entryFile, ENTRY, 'utf8');

  await build({
    entryPoints: [entryFile],
    outfile: outFile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    absWorkingDir: REPO,
    external: ['node:http', 'node:crypto', 'node:fs', 'node:path'],
    logLevel: 'silent',
  });

  // The handlers resolve their data paths from process.cwd() at module load,
  // so the cwd must already be the sandbox when the bundle is required.
  process.chdir(SANDBOX);
  api = require(outFile);

  server = createServer(async (req, res) => {
    const url = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;
    let name = null;
    for (const [prefix, handlerName] of ROUTES) {
      if (pathname === prefix || pathname.startsWith(prefix + '/')) {
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
      await api[name](req, res);
    } catch (err) {
      console.error('[qa] handler error', name, err);
      if (!res.writableEnded) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal server error' }));
      }
    }
  });

  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
}

async function req(method, pathname, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  let body;
  if (opts.body !== undefined) {
    if (opts.form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(opts.body).toString();
    } else {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }
  }
  if (opts.origin !== null) headers.origin = opts.origin === undefined ? ORIGIN : opts.origin;
  if (opts.cookie) headers.cookie = opts.cookie;
  // A unique client IP per request: the per-IP rate limiters must not
  // interfere with the functional checks (the rate-limit check itself is
  // driven with a FIXED ip).
  headers['x-forwarded-for'] = opts.ip || `10.0.${Math.floor(ipCounter / 250)}.${ipCounter % 250}`;
  ipCounter += 1;

  const res = await fetch(`${ORIGIN}${pathname}`, {
    method,
    headers,
    body,
    redirect: 'manual',
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return {
    status: res.status,
    headers: res.headers,
    text,
    json,
    setCookie: res.headers.getSetCookie ? res.headers.getSetCookie() : [],
  };
}

function takeResendCalls() {
  const calls = resendCalls.splice(0, resendCalls.length);
  return calls;
}

// ---------------------------------------------------------------------------
// fixture helpers
// ---------------------------------------------------------------------------
const OWNER = 'owner@imk.test';
const sessions = {}; // email -> cookie header value

async function signIn(email) {
  // The magic-link token is only printed to the log when RESEND_API_KEY is
  // absent (api/portal/auth.ts). Capture it from there.
  const previousKey = process.env.RESEND_API_KEY;
  delete process.env.RESEND_API_KEY;
  const before = logLines.length;
  await req('POST', '/api/portal/auth/request-link', { body: { email } });
  if (previousKey !== undefined) process.env.RESEND_API_KEY = previousKey;

  const magic = logLines
    .slice(before)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter((l) => l && l.outcome === 'magic_link_dev' && l.email === email)
    .pop();
  assert(magic && magic.token, `no magic-link token was issued for ${email}`);

  const res = await req(
    'GET',
    `/api/portal/auth/verify?token=${encodeURIComponent(magic.token)}&purpose=portal`,
  );
  assertEqual(res.status, 200, `verify failed for ${email}`);
  const cookie = res.setCookie[0];
  assert(cookie, `no session cookie for ${email}`);
  sessions[email] = cookie.split(';')[0];
  return sessions[email];
}

async function invite(email, profile = {}) {
  return req('POST', '/api/portal/invites', {
    body: { email, ...profile },
    cookie: sessions[OWNER],
  });
}

async function makeClient(email, profile) {
  await invite(email, profile);
  await signIn(email);
  const rec = readJsonl(CLIENTS_FILE).find((c) => c.email === email);
  assert(rec, `no client record for ${email}`);
  return rec;
}

async function makeProject(clientId, title, status = 'completed') {
  const res = await req('POST', '/api/portal/projects', {
    body: { title, clientId, status },
    cookie: sessions[OWNER],
  });
  assertEqual(res.status, 200, `could not create project "${title}"`);
  return res.json.project.id;
}

function latestReviewFor(projectId) {
  const all = readJsonl(REVIEWS_FILE).filter((r) => r.type === 'review' && r.projectId === projectId);
  return all.length ? all[all.length - 1] : null;
}

/** The newest stored revision for a ref (the log is append-only). */
function currentRevision(ref) {
  const lines = readJsonl(REVIEWS_FILE).filter((r) => r.ref === ref);
  if (!lines.length) return 1;
  return Number(lines[lines.length - 1].revision || 1);
}

/**
 * Sign a moderation link.
 *
 * The signed message is `ref|decision|revision|ts` — the REVISION is signed
 * (audit M5), so a link can only approve the exact revision it was built for.
 */
function signModeration(ref, decision, ts, revision) {
  const crypto = require('node:crypto');
  const secret = process.env.FORM_WEBHOOK_SECRET || '';
  const rev = revision === undefined ? currentRevision(ref) : revision;
  return crypto
    .createHmac('sha256', secret)
    .update(`${ref}|${decision}|${rev}|${ts}`)
    .digest('hex');
}

/** Build a moderation URL the way the notification e-mail does. */
function moderationUrl(ref, decision, ts, revision) {
  const rev = revision === undefined ? currentRevision(ref) : revision;
  const sig = signModeration(ref, decision, ts, rev);
  return `/api/moderate/review?ref=${encodeURIComponent(ref)}&decision=${encodeURIComponent(decision)}&revision=${rev}&sig=${encodeURIComponent(sig)}&ts=${ts}`;
}

/**
 * The signed fields of a moderation link.
 *
 * The signature covers `ref|decision|revision|ts`, so the same five values
 * verify whether they travel in the query string or in the body.
 */
const MODERATION_FIELDS = ['ref', 'decision', 'revision', 'ts', 'sig'];

/** The fields of a moderation link, as a plain object. */
function moderationFields(url) {
  const parsed = new URL(url, ORIGIN);
  const fields = {};
  for (const name of MODERATION_FIELDS) {
    fields[name] = parsed.searchParams.get(name) || '';
  }
  return fields;
}

/**
 * The hidden inputs of the confirmation page.
 *
 * The page is the ONLY thing a mail scanner sees, so the fields it carries
 * are the contract: whatever the page posts must be exactly what decides.
 */
function parseFormFields(html) {
  const fields = {};
  for (const tag of String(html).match(/<input\b[^>]*>/gi) || []) {
    const name = /name="([^"]*)"/i.exec(tag);
    const value = /value="([^"]*)"/i.exec(tag);
    if (name && value) fields[name[1]] = value[1];
  }
  return fields;
}

/**
 * POST the moderation decision -- the way the owner's confirmation form does.
 *
 * M-1 (wave-8A): a GET is NOT a decision. It only shows the confirmation
 * page; the state is changed by the POST that the form issues. The signed
 * parameters travel in the form body, exactly as the page's hidden inputs
 * carry them.
 */
async function postDecision(url) {
  return req('POST', '/api/moderate/review', {
    body: moderationFields(url),
    form: true,
  });
}

/**
 * The owner's real flow: open the link (a GET -> the confirmation page),
 * read the page's own hidden inputs and press the button (a POST).
 */
async function approveThroughTheForm(url) {
  const page = await req('GET', url);
  assertEqual(page.status, 200, 'the confirmation page must be served');
  assert(
    /<form[^>]*method="POST"/i.test(page.text),
    'the confirmation page must offer a POST form (a GET must never decide)',
  );
  const fields = parseFormFields(page.text);
  for (const name of MODERATION_FIELDS) {
    assert(fields[name], `the confirmation form must carry "${name}"`);
  }
  return req('POST', '/api/moderate/review', { body: fields, form: true });
}

/** Approve a quote: the decision is the POST, never the GET. */
async function approve(ref) {
  const ts = Math.floor(Date.now() / 1000);
  return postDecision(moderationUrl(ref, 'approve', ts));
}

async function submit(email, projectId, payload) {
  return req('POST', '/api/portal/testimonials', {
    cookie: sessions[email],
    body: { action: 'submit', projectId, ...payload },
  });
}

// ---------------------------------------------------------------------------
// suite
// ---------------------------------------------------------------------------
async function main() {
  const origLog = console.log;
  console.log = (...args) => {
    const line = args.map(String).join(' ');
    // The raw line is kept in memory only (the harness needs the token to
    // complete the sign-in flow); what reaches the screen is redacted.
    logLines.push(line);
    origLog(line.replace(/("token":")([^"]{8})[^"]*(")/g, (_m, a, head, c) => `${a}${head}…<redacted>${c}`));
  };

  console.log(`[qa] sandbox : ${SANDBOX}`);
  console.log(`[qa] endpoint: ${ORIGIN} (never 4321)`);

  fs.mkdirSync(SANDBOX_PORTAL, { recursive: true });
  fs.mkdirSync(SANDBOX_MODERATION, { recursive: true });

  // No real network: capture the Resend calls instead. Requests to the local
  // sandbox origin still go through the real fetch.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const href = typeof url === 'string' ? url : url.url;
    if (String(href).startsWith(ORIGIN)) return realFetch(url, init);
    if (String(href).includes('api.resend.com')) {
      resendCalls.push({ href: String(href), init });
      return { ok: true, status: 200, json: async () => ({ id: 'qa-stub' }) };
    }
    throw new Error(`[qa] unexpected outbound request: ${href}`);
  };

  process.env.SITE_BASE_URL = ORIGIN;
  process.env.SITE_URL = ORIGIN;
  process.env.ADMIN_EMAILS = OWNER;
  // H-1 (wave-8A): in production a secret that is PRESENT but UNUSABLE -- the
  // published placeholder, or shorter than MIN_SECRET_LENGTH (32) -- is refused
  // exactly like a missing one. This suite runs in development, but G4 flips
  // it into production, so the fixtures are 32+ characters long: otherwise
  // G4 would answer 500 for the wrong reason (a refused secret) instead of
  // the one it tests (a missing RESEND_API_KEY).
  process.env.PORTAL_MAGIC_LINK_SECRET = 'qa-testimonials-magic-link-secret-0123456789';
  process.env.FORM_WEBHOOK_SECRET = 'qa-testimonials-form-webhook-secret-0123456789';
  process.env.RESEND_API_KEY = 'qa-resend-key';
  process.env.RESEND_TO = OWNER;
  process.env.CONTACT_TO = OWNER;
  process.env.RESEND_FROM = 'IMK <2imk4support@gmail.com>';
  // The handlers treat an unset APP_ENV as production (same rule as
  // api/contact.ts), and in production the magic-link token is never written
  // to the log (audit M4 — fixed). The harness needs the token to sign the
  // fixtures in, so it opts into development explicitly. The G4 check below
  // deletes APP_ENV again to prove the production default.
  process.env.APP_ENV = 'development';
  delete process.env.DEV_STUB;

  await startServer();
  origLog(`[qa] server up on ${ORIGIN}`);

  // ---- fixtures -----------------------------------------------------------
  await signIn(OWNER);
  const alice = await makeClient('alice@client.test', { name: 'Alice Longname', company: 'Acme Ltd', role: 'CTO' });
  const bob = await makeClient('bob@client.test', { name: 'Bob Other' });
  const carol = await makeClient('carol@client.test', { name: 'Carol Anonymous', company: 'Carol Corp', role: 'CFO' });
  const dave = await makeClient('dave@client.test', { name: 'Dave Withdrawn', company: 'Dave Ltd', role: 'COO' });
  const erin = await makeClient('erin@client.test', { name: 'Erin Unfinished' });
  const frank = await makeClient('frank@client.test', { name: 'Frank Spoof' });
  const grace = await makeClient('grace@client.test', { name: 'Grace Rate' });
  const heidi = await makeClient('heidi@client.test', { name: 'Heidi Consent' });
  const ivan = await makeClient('ivan@client.test', { name: 'Ivan Moderation' });

  const prjAlice = await makeProject(alice.id, 'Acme Website', 'completed');
  const prjOther = await makeProject(bob.id, 'Bob Website', 'completed');
  const prjAnon = await makeProject(carol.id, 'Carol Website', 'completed');
  const prjRevoked = await makeProject(dave.id, 'Dave Website', 'completed');
  const prjUnfinished = await makeProject(erin.id, 'Erin Website', 'in-progress');
  const prjSpoof = await makeProject(frank.id, 'Frank Website', 'completed');
  const prjRate = await makeProject(grace.id, 'Grace Website', 'completed');
  const prjConsent = await makeProject(heidi.id, 'Heidi Website', 'completed');
  const prjMod = await makeProject(ivan.id, 'Ivan Website', 'completed');
  const prjSnooze = await makeProject(alice.id, 'Acme Second Website', 'completed');

  origLog('[qa] fixtures ready (sandbox only)');

  // =========================================================================
  group('A — public review door (spec/08 §4.4, §5 "Public review door")');

  await t('A1', 'POST /api/contact type=review (JSON) -> 410 review-moved', async () => {
    const res = await req('POST', '/api/contact', {
      body: { type: 'review', name: 'Mallory', email: 'mallory@evil.test', project: 'x', budget: '1k-5k', timeline: 'asap' },
    });
    assertEqual(res.status, 410, 'status');
    assertEqual(res.json.code, 'review-moved', 'code');
  });

  await t('A2', 'POST /api/contact type=review (form) -> 410', async () => {
    const res = await req('POST', '/api/contact', {
      form: true,
      body: { type: 'review', name: 'Mallory', email: 'mallory@evil.test', project: 'x', budget: '1k-5k', timeline: 'asap' },
    });
    assertEqual(res.status, 410, 'status');
  });

  await t('A3', 'a refused review writes NOTHING (no record, no e-mail)', async () => {
    takeResendCalls();
    await req('POST', '/api/contact', {
      body: { type: 'review', name: 'Mallory', email: 'mallory@evil.test', project: 'x', budget: '1k-5k', timeline: 'asap' },
    });
    assertEqual(readJsonl(REVIEWS_FILE).length, 0, 'reviews.jsonl must stay empty');
    assertEqual(takeResendCalls().length, 0, 'no e-mail may be sent');
  });

  await t('A4', 'control: a normal contact inquiry still works (200)', async () => {
    const res = await req('POST', '/api/contact', {
      body: {
        name: 'Real Lead', email: 'lead@prospect.test', project: 'A website',
        budget: '1k-5k', timeline: 'asap', ts: Date.now() - 5000,
      },
    });
    assertEqual(res.status, 200, 'status');
  });

  // =========================================================================
  group('B — portal endpoint contract (spec/08 §4.4 status codes)');

  await t('B1', 'GET without a session -> 401', async () => {
    const res = await req('GET', `/api/portal/testimonials?projectId=${prjAlice}`);
    assertEqual(res.status, 401, 'status');
    assertEqual(res.json.code, 'unauthorized', 'code');
  });

  await t('B2', 'POST without a session -> 401', async () => {
    const res = await req('POST', '/api/portal/testimonials', {
      body: { action: 'submit', projectId: prjAlice, review: 'hi', consent: { p1: true } },
    });
    assertEqual(res.status, 401, 'status');
  });

  await t('B3', "GET another client's project -> 404 (no id probing)", async () => {
    const res = await req('GET', `/api/portal/testimonials?projectId=${prjOther}`, {
      cookie: sessions['alice@client.test'],
    });
    assertEqual(res.status, 404, 'status');
    assertEqual(res.json.code, 'not-found', 'code');
  });

  await t('B4', "POST to another client's project -> 404", async () => {
    const res = await req('POST', '/api/portal/testimonials', {
      cookie: sessions['alice@client.test'],
      body: { action: 'submit', projectId: prjOther, review: 'hello', consent: { p1: true } },
    });
    assertEqual(res.status, 404, 'status');
    assertEqual(res.json.code, 'not-found', 'code');
  });

  await t('B5', 'POST for an unfinished project -> 409', async () => {
    const res = await req('POST', '/api/portal/testimonials', {
      cookie: sessions['erin@client.test'],
      body: { action: 'submit', projectId: prjUnfinished, review: 'hello', consent: { p1: true } },
    });
    assertEqual(res.status, 409, 'status');
    assertEqual(res.json.code, 'not-eligible', 'code');
  });

  await t('B6', 'POST submit without consent.p1 -> 400 consent-required, nothing stored', async () => {
    const before = readJsonl(REVIEWS_FILE).length;
    const res = await req('POST', '/api/portal/testimonials', {
      cookie: sessions['heidi@client.test'],
      body: { action: 'submit', projectId: prjConsent, review: 'A great quote', consent: { p1: false, p2: true } },
    });
    assertEqual(res.status, 400, 'status');
    assertEqual(res.json.code, 'consent-required', 'code');
    assertEqual(readJsonl(REVIEWS_FILE).length, before, 'no record may be stored');
  });

  await t('B7', 'POST with a wrong Origin -> 403', async () => {
    const res = await req('POST', '/api/portal/testimonials', {
      cookie: sessions['alice@client.test'],
      origin: 'http://evil.test',
      body: { action: 'submit', projectId: prjAlice, review: 'hello', consent: { p1: true } },
    });
    assertEqual(res.status, 403, 'status');
    assertEqual(res.json.code, 'origin', 'code');
  });

  await t('B8', 'POST with no Origin at all -> 403', async () => {
    const res = await req('POST', '/api/portal/testimonials', {
      cookie: sessions['alice@client.test'],
      origin: null,
      body: { action: 'submit', projectId: prjAlice, review: 'hello', consent: { p1: true } },
    });
    assertEqual(res.status, 403, 'status');
  });

  await t('B9', 'POST as the owner (admin session) -> 403', async () => {
    const res = await req('POST', '/api/portal/testimonials', {
      cookie: sessions[OWNER],
      body: { action: 'submit', projectId: prjAlice, review: 'hello', consent: { p1: true } },
    });
    assertEqual(res.status, 403, 'status');
    assertEqual(res.json.code, 'forbidden', 'code');
  });

  await t('B10', '6th submission within the hour -> 429 rate-limit', async () => {
    const cookie = sessions['grace@client.test'];
    const ip = '10.9.9.9';
    const codes = [];
    for (let i = 0; i < 6; i++) {
      const res = await req('POST', '/api/portal/testimonials', {
        cookie,
        ip,
        body: { action: 'submit', projectId: prjRate, review: `rate limited quote ${i}`, consent: { p1: true } },
      });
      codes.push(res.status);
    }
    assertEqual(codes.slice(0, 5).join(','), '200,200,200,200,200', 'the first five submissions');
    assertEqual(codes[5], 429, 'the sixth submission must be rate-limited');
  });

  await t('B11', 'PATCH /api/portal/testimonials -> 405', async () => {
    const res = await req('PATCH', '/api/portal/testimonials', {
      cookie: sessions['alice@client.test'],
      body: { action: 'submit' },
    });
    assertEqual(res.status, 405, 'status');
  });

  await t('B12', 'POST with an unknown action -> 400 validation', async () => {
    const res = await req('POST', '/api/portal/testimonials', {
      cookie: sessions['alice@client.test'],
      body: { action: 'publish-now', projectId: prjAlice, review: 'hello', consent: { p1: true } },
    });
    assertEqual(res.status, 400, 'status');
    assert((res.json.fields || []).includes('action'), 'field "action" must be named');
  });

  await t('B13', 'POST with an out-of-range rating -> 400 fields', async () => {
    const res = await req('POST', '/api/portal/testimonials', {
      cookie: sessions['alice@client.test'],
      body: { action: 'submit', projectId: prjAlice, review: 'hello', rating: 9, consent: { p1: true } },
    });
    assertEqual(res.status, 400, 'status');
    assert((res.json.fields || []).includes('rating'), 'field "rating" must be named');
  });

  await t('B14', 'POST with an empty quote -> 400 fields', async () => {
    const res = await req('POST', '/api/portal/testimonials', {
      cookie: sessions['alice@client.test'],
      body: { action: 'submit', projectId: prjAlice, review: '', consent: { p1: true } },
    });
    assertEqual(res.status, 400, 'status');
    assert((res.json.fields || []).includes('review'), 'field "review" must be named');
  });

  await t('B15', 'POST with a quote over 1000 chars -> 400 fields', async () => {
    const res = await req('POST', '/api/portal/testimonials', {
      cookie: sessions['alice@client.test'],
      body: { action: 'submit', projectId: prjAlice, review: 'x'.repeat(1001), consent: { p1: true } },
    });
    assertEqual(res.status, 400, 'status');
    assert((res.json.fields || []).includes('review'), 'field "review" must be named');
  });

  await t('B16', 'POST with a displayName over 80 chars -> 400 fields', async () => {
    const res = await req('POST', '/api/portal/testimonials', {
      cookie: sessions['alice@client.test'],
      body: { action: 'submit', projectId: prjAlice, review: 'hello', displayName: 'n'.repeat(81), consent: { p1: true } },
    });
    assertEqual(res.status, 400, 'status');
    assert((res.json.fields || []).includes('displayName'), 'field "displayName" must be named');
  });

  await t('B17', 'GET without projectId -> 400', async () => {
    const res = await req('GET', '/api/portal/testimonials', { cookie: sessions['alice@client.test'] });
    assertEqual(res.status, 400, 'status');
  });

  await t('B18', 'GET an unknown project -> 404', async () => {
    const res = await req('GET', '/api/portal/testimonials?projectId=prj_nope', {
      cookie: sessions['alice@client.test'],
    });
    assertEqual(res.status, 404, 'status');
  });

  // =========================================================================
  group('C — consent flow, provenance and withdrawal (spec/08 §4.4, RP-3/RP-5/RP-6)');

  let aliceRef = null;
  await t('C1', 'submit -> 200, server-derived identity, client-safe view', async () => {
    takeResendCalls();
    const res = await submit('alice@client.test', prjAlice, {
      rating: 5,
      review: 'The team rebuilt our site in three weeks and it doubled our inbound leads.',
      displayName: 'Alice L',
      consent: { p1: true, p2: true, p3: false },
    });
    assertEqual(res.status, 200, 'status');
    const view = res.json.testimonial;
    aliceRef = view.ref;
    assertEqual(view.verifiedClient, true, 'verifiedClient');
    assertEqual(view.source, 'portal', 'source');
    assertEqual(view.name, 'Alice Longname', 'name comes from the client record');
    assertEqual(view.company, 'Acme Ltd', 'company comes from the client record');
    assertEqual(view.role, 'CTO', 'role comes from the client record');
    assertEqual(view.consent.p1, true, 'consent.p1');
    assertEqual(view.consent.p2, true, 'consent.p2');
    assertEqual(view.consent.p3, false, 'consent.p3');
    assert(view.email === undefined, 'the client view must never contain the e-mail');
    assert(view.clientId === undefined, 'the client view must never contain the clientId');
    assert(view.projectId === undefined, 'the client view must not echo the projectId');
  });

  await t('C2', 'the owner IS notified with a signed one-click link', async () => {
    const calls = takeResendCalls();
    assertEqual(calls.length, 1, 'exactly one notification e-mail');
    const body = calls[0].init.body;
    assert(body.includes('Alice Longname'), 'the e-mail must carry the client identity');
    assert(/sig=/.test(body), 'the e-mail must carry a signed moderation link');
    assert(/api\/moderate\/review\?/.test(body), 'the e-mail must contain a moderation URL');
  });

  await t('C3', 'spoofed body fields are ignored (verifiedClient / source / name / company / role)', async () => {
    const res = await submit('frank@client.test', prjSpoof, {
      review: 'Spoofing attempt quote.',
      rating: 4,
      verifiedClient: false,
      source: 'public',
      clientId: 'cli_someone_else',
      name: 'Mallory Evil',
      company: 'Evil Corp',
      role: 'CEO',
      consent: { p1: true, p2: true, p3: true },
    });
    assertEqual(res.status, 200, 'status');
    const stored = latestReviewFor(prjSpoof);
    assertEqual(stored.verifiedClient, true, 'stored verifiedClient');
    assertEqual(stored.source, 'portal', 'stored source');
    assertEqual(stored.name, 'Frank Spoof', 'stored name');
    assertEqual(stored.company, '', 'stored company');
    assertEqual(stored.role, '', 'stored role');
    const view = res.json.testimonial;
    assertEqual(view.name, 'Frank Spoof', 'view name');
    assertEqual(view.company, '', 'view company');
  });

  await t('C4', 'snooze -> 200, state snoozed, project marked snoozed', async () => {
    const res = await req('POST', '/api/portal/testimonials', {
      cookie: sessions['alice@client.test'],
      body: { action: 'snooze', projectId: prjSnooze },
    });
    assertEqual(res.status, 200, 'status');
    assertEqual(res.json.testimonial.state, 'snoozed', 'state');
    const p = readJsonl(PROJECTS_FILE).find((x) => x.id === prjSnooze);
    assertEqual(p.testimonialStatus, 'snoozed', 'project.testimonialStatus');
  });

  await t('C5', 'owner re-requests -> GET shows no stale answer (the card returns)', async () => {
    const res = await req('PATCH', `/api/portal/projects/${prjSnooze}`, {
      cookie: sessions[OWNER],
      body: { testimonialStatus: 'requested' },
    });
    assertEqual(res.status, 200, 'status');
    const get = await req('GET', `/api/portal/testimonials?projectId=${prjSnooze}`, {
      cookie: sessions['alice@client.test'],
    });
    assertEqual(get.status, 200, 'GET status');
    assertEqual(get.json.testimonial, null, 'the client must be asked again');
  });

  await t('C6', 'decline -> 200, state declined', async () => {
    const res = await req('POST', '/api/portal/testimonials', {
      cookie: sessions['alice@client.test'],
      body: { action: 'decline', projectId: prjSnooze },
    });
    assertEqual(res.status, 200, 'status');
    assertEqual(res.json.testimonial.state, 'declined', 'state');
  });

  await t('C7', 'decline is final -> a second decline is 409 declined', async () => {
    const res = await req('POST', '/api/portal/testimonials', {
      cookie: sessions['alice@client.test'],
      body: { action: 'decline', projectId: prjSnooze },
    });
    assertEqual(res.status, 409, 'status');
    assertEqual(res.json.code, 'declined', 'code');
  });

  await t('C8', 'the client view never carries the e-mail or internal ids', async () => {
    const res = await req('GET', `/api/portal/testimonials?projectId=${prjAlice}`, {
      cookie: sessions['alice@client.test'],
    });
    assertEqual(res.status, 200, 'status');
    assert(!res.text.includes('alice@client.test'), 'the e-mail must not appear in the response');
  });

  await t('C9', 'an approved quote is publishable: the owner approves it', async () => {
    const res = await approve(aliceRef);
    assertEqual(res.status, 200, 'status');
    assertEqual(res.json.state, 'approved', 'state');
    assertEqual(latestReviewFor(prjAlice).state, 'approved', 'the stored state must be approved');
  });

  // =========================================================================
  group('D — invite flow and client profile (spec/08 §4.5)');

  await t('D1', 'POST /api/portal/invites as a client -> 403', async () => {
    const res = await req('POST', '/api/portal/invites', {
      cookie: sessions['alice@client.test'],
      body: { email: 'x@client.test' },
    });
    assertEqual(res.status, 403, 'status');
    assertEqual(res.json.code, 'forbidden', 'code');
  });

  await t('D2', 'POST /api/portal/invites without a session -> 403', async () => {
    const res = await req('POST', '/api/portal/invites', { body: { email: 'x@client.test' } });
    assertEqual(res.status, 403, 'status');
  });

  await t('D3', 'POST /api/portal/invites with a wrong Origin -> 403', async () => {
    const res = await req('POST', '/api/portal/invites', {
      cookie: sessions[OWNER], origin: 'http://evil.test', body: { email: 'x@client.test' },
    });
    assertEqual(res.status, 403, 'status');
  });

  await t('D4', 'POST /api/portal/invites with an invalid e-mail -> 400', async () => {
    const res = await req('POST', '/api/portal/invites', {
      cookie: sessions[OWNER], body: { email: 'not-an-email' },
    });
    assertEqual(res.status, 400, 'status');
    assert((res.json.fields || []).includes('email'), 'field "email" must be named');
  });

  await t('D5', 'the first sign-in creates the client record from the INVITE (not the e-mail local part)', async () => {
    const rec = readJsonl(CLIENTS_FILE).find((c) => c.email === 'alice@client.test');
    assert(rec, 'the client record must exist');
    assertEqual(rec.name, 'Alice Longname', 'name');
    assertEqual(rec.company, 'Acme Ltd', 'company');
    assertEqual(rec.role, 'CTO', 'role');
    assert(rec.name !== 'alice', 'the name must not fall back to the e-mail local part');
  });

  await t('D6', 'upsert: an omitted name is kept, a new company reaches the client record', async () => {
    const res = await invite('alice@client.test', { company: 'Acme Holdings' });
    assertEqual(res.status, 200, 'status');
    assertEqual(res.json.updated, true, 'the invite must be reported as updated');
    const inviteRec = readJsonl(INVITED_FILE).find((r) => r.email === 'alice@client.test');
    assertEqual(inviteRec.name, 'Alice Longname', 'the invite name must be untouched');
    assertEqual(inviteRec.company, 'Acme Holdings', 'the invite company must be updated');
    const clientRec = readJsonl(CLIENTS_FILE).find((c) => c.email === 'alice@client.test');
    assertEqual(clientRec.company, 'Acme Holdings', 'the client record must be patched');
  });

  await t('D7', 'an over-cap company -> 400, nothing written', async () => {
    const before = fs.readFileSync(INVITED_FILE, 'utf8');
    const res = await invite('alice@client.test', { company: 'c'.repeat(121) });
    assertEqual(res.status, 400, 'status');
    assert((res.json.fields || []).includes('company'), 'field "company" must be named');
    assertEqual(fs.readFileSync(INVITED_FILE, 'utf8'), before, 'nothing may be written');
  });

  await t('D8', 'an empty string clears the field on both records', async () => {
    const res = await invite('alice@client.test', { company: '' });
    assertEqual(res.status, 200, 'status');
    const inviteRec = readJsonl(INVITED_FILE).find((r) => r.email === 'alice@client.test');
    assertEqual(inviteRec.company, '', 'the invite company must be cleared');
    const clientRec = readJsonl(CLIENTS_FILE).find((c) => c.email === 'alice@client.test');
    assertEqual(clientRec.company, '', 'the client record company must be cleared');
  });

  await t('D9', 'an over-cap name -> 400', async () => {
    const res = await invite('alice@client.test', { name: 'n'.repeat(81) });
    assertEqual(res.status, 400, 'status');
    assert((res.json.fields || []).includes('name'), 'field "name" must be named');
  });

  await t('D10', 'a second invite for the same e-mail does not duplicate the record', async () => {
    const before = readJsonl(INVITED_FILE).filter((r) => r.email === 'alice@client.test').length;
    await invite('alice@client.test', { role: 'COO' });
    const after = readJsonl(INVITED_FILE).filter((r) => r.email === 'alice@client.test').length;
    assertEqual(after, before, 'the invite count must not change');
  });

  await t('D11', 'GET /api/portal/invites -> 404 (owner-only POST endpoint)', async () => {
    const res = await req('GET', '/api/portal/invites', { cookie: sessions[OWNER] });
    assertEqual(res.status, 404, 'status');
  });

  // =========================================================================
  group('E — moderation links fail closed (spec/08 §4.4, §5)');

  const modSubmit = await submit('ivan@client.test', prjMod, {
    review: 'A quote waiting for the owner decision.',
    consent: { p1: true, p2: true, p3: false },
  });
  const modRef = modSubmit.json.testimonial.ref;
  const nowSec = Math.floor(Date.now() / 1000);

  await t('E1', 'missing parameters -> 400', async () => {
    const res = await req('GET', '/api/moderate/review');
    assertEqual(res.status, 400, 'status');
    assertEqual(res.json.code, 'validation', 'code');
  });

  await t('E2', 'an invalid decision -> 400', async () => {
    const ts = nowSec;
    const res = await req('GET', moderationUrl(modRef, 'delete-everything', ts));
    assertEqual(res.status, 400, 'status');
  });

  await t('E3', 'an expired link -> 400 expired', async () => {
    const ts = nowSec - 8 * 24 * 3600;
    const res = await req('GET', moderationUrl(modRef, 'approve', ts));
    assertEqual(res.status, 400, 'status');
    assertEqual(res.json.code, 'expired', 'code');
  });

  await t('E4', 'a timestamp far in the future -> 400 expired', async () => {
    const ts = nowSec + 3600;
    const res = await req('GET', moderationUrl(modRef, 'approve', ts));
    assertEqual(res.status, 400, 'status');
    assertEqual(res.json.code, 'expired', 'code');
  });

  await t('E5', 'no FORM_WEBHOOK_SECRET -> 500 misconfigured (fails closed)', async () => {
    const ts = nowSec;
    const url = moderationUrl(modRef, 'approve', ts);
    const saved = process.env.FORM_WEBHOOK_SECRET;
    delete process.env.FORM_WEBHOOK_SECRET;
    const res = await req('GET', url);
    if (saved !== undefined) process.env.FORM_WEBHOOK_SECRET = saved;
    assertEqual(res.status, 500, 'status');
    assertEqual(res.json.code, 'internal', 'code');
  });

  await t('E6', 'a forged signature -> 400 signature', async () => {
    const ts = nowSec;
    const url = moderationUrl(modRef, 'approve', ts).replace(/sig=[^&]+/, `sig=${'0'.repeat(64)}`);
    const res = await req('GET', url);
    assertEqual(res.status, 400, 'status');
    assertEqual(res.json.code, 'signature', 'code');
  });

  await t('E7', 'a valid signature for an unknown ref -> 404', async () => {
    const ts = nowSec;
    const res = await req('GET', moderationUrl('rev_unknown', 'approve', ts));
    assertEqual(res.status, 404, 'status');
    assertEqual(res.json.code, 'not-found', 'code');
  });

  await t('E8', 'a valid signature approves the record', async () => {
    const ts = nowSec;
    // The DECISION is the POST (M-1, wave-8A): the GET only shows the
    // confirmation page.
    const res = await postDecision(moderationUrl(modRef, 'approve', ts));
    assertEqual(res.status, 200, 'status');
    assertEqual(res.json.state, 'approved', 'state');
    const stored = readJsonl(REVIEWS_FILE).filter((r) => r.ref === modRef).pop();
    assertEqual(stored.state, 'approved', 'the stored state must be approved');
  });

  await t('E9', 'the one-click link is idempotent (no second decision, no new line)', async () => {
    const linesBefore = readJsonl(REVIEWS_FILE).length;
    const ts = nowSec;
    const res = await postDecision(moderationUrl(modRef, 'approve', ts));
    assertEqual(res.status, 200, 'status');
    assertEqual(res.json.state, 'approved', 'state');
    assertEqual(readJsonl(REVIEWS_FILE).length, linesBefore, 'no new line may be appended');
  });

  await t('E10', 'a reject decision is honoured', async () => {
    const res = await submit('bob@client.test', prjOther, {
      review: 'A quote the owner will reject.',
      consent: { p1: true, p2: true, p3: false },
    });
    assertEqual(res.status, 200, 'submit status');
    const ref = res.json.testimonial.ref;
    const ts = nowSec;
    const res2 = await postDecision(moderationUrl(ref, 'reject', ts));
    assertEqual(res2.status, 200, 'status');
    assertEqual(res2.json.state, 'rejected', 'state');
  });

  // =========================================================================
  // M-1 (wave-8A): THE METHOD IS THE POINT.
  //
  // The approve/reject link is a signed GET URL, and a signed GET URL is
  // fetched AUTOMATICALLY by every mail scanner, chat preview and antivirus
  // gateway. Before wave-8A that prefetch WAS the approval: the owner's
  // quotes were published without the owner ever seeing them. A GET must
  // therefore decide NOTHING -- it only shows the confirmation page, and the
  // POST that the page's form issues is the decision.
  // =========================================================================

  await t('E11', 'M-1: a plain GET on the signed link shows the confirmation page and decides NOTHING', async () => {
    const prjM1 = await makeProject(erin.id, 'Erin Third Website', 'completed');
    const sub = await submit('erin@client.test', prjM1, {
      review: 'A quote that a mail scanner will prefetch.',
      consent: { p1: true, p2: true, p3: false },
    });
    assertEqual(sub.status, 200, 'submit status');
    const ref = sub.json.testimonial.ref;
    const before = readJsonl(REVIEWS_FILE).filter((r) => r.ref === ref).pop();
    assertEqual(before.state, 'pending', 'the quote must start pending');

    // What every mail scanner does by itself: fetch the link.
    const page = await req('GET', moderationUrl(ref, 'approve', nowSec));
    assertEqual(page.status, 200, 'the GET must serve the confirmation page');
    const contentType = String(page.headers.get('content-type') || '');
    assert(
      contentType.includes('text/html'),
      `the GET must answer a PAGE, not JSON (got ${contentType})`,
    );
    assert(/<form[^>]*method="POST"/i.test(page.text), 'the page must offer a POST form');
    assert(/name="sig"/.test(page.text), 'the page must carry the signature in the form');
    assert(/name="decision"/.test(page.text), 'the page must carry the decision in the form');
    assert(/name="revision"/.test(page.text), 'the page must carry the revision in the form');

    // ...and nothing at all was decided.
    const after = readJsonl(REVIEWS_FILE).filter((r) => r.ref === ref).pop();
    assertEqual(after.state, 'pending', 'a GET must not approve anything');
    assertEqual(after.decidedAt, undefined, 'a GET must not stamp a decision time');
    assertEqual(
      readJsonl(REVIEWS_FILE).filter((r) => r.ref === ref && r.state === 'approved').length,
      0,
      'no line may be approved by a GET',
    );
    note('E11-detail', 'a plain GET served the confirmation page and the quote stayed pending');
  });

  await t('E12', 'M-1: the confirmation page\'s own form POST is what decides the quote', async () => {
    // A client with room in its submit bucket (5 per hour) and NOT the
    // anonymous client of F3 -- a named quote of the anonymous client would
    // put that name on the page and break the publish-time check.
    const prjM1b = await makeProject(alice.id, 'Alice Fourth Website', 'completed');
    const sub = await submit('alice@client.test', prjM1b, {
      review: 'A quote the owner confirms on the page.',
      consent: { p1: true, p2: true, p3: false },
    });
    assertEqual(sub.status, 200, 'submit status');
    const ref = sub.json.testimonial.ref;

    // The owner's real flow: open the link, press the button.
    const res = await approveThroughTheForm(moderationUrl(ref, 'approve', nowSec));
    assertEqual(res.status, 200, 'the form POST must be accepted');
    assertEqual(res.json.state, 'approved', 'state');
    const stored = readJsonl(REVIEWS_FILE).filter((r) => r.ref === ref).pop();
    assertEqual(stored.state, 'approved', 'the stored state must be approved');
    note('E12-detail', 'the page\'s own hidden fields decided the quote');
  });

  await t('E13', 'M-1: a GET on an already-decided quote says so and still decides nothing', async () => {
    const prjM1c = await makeProject(bob.id, 'Bob Fifth Website', 'completed');
    const sub = await submit('bob@client.test', prjM1c, {
      review: 'A quote that was already decided.',
      consent: { p1: true, p2: true, p3: false },
    });
    assertEqual(sub.status, 200, 'submit status');
    const ref = sub.json.testimonial.ref;
    const decided = await postDecision(moderationUrl(ref, 'approve', nowSec));
    assertEqual(decided.status, 200, 'the first decision');
    const linesBefore = readJsonl(REVIEWS_FILE).length;

    const page = await req('GET', moderationUrl(ref, 'approve', nowSec));
    assertEqual(page.status, 200, 'the GET must still serve a page');
    assert(
      /already\s*decided/i.test(page.text),
      'the page must say the quote was already decided',
    );
    assert(
      !/<button[^>]*type="submit"/i.test(page.text),
      'an already-decided quote must not offer a decision button',
    );
    assertEqual(readJsonl(REVIEWS_FILE).length, linesBefore, 'a GET must not append a line');
  });

  // =========================================================================
  group('F — withdrawal / revocation (spec/08 §4.4, RP-6.4 / RP-6.5)');

  let revokedRef = null;
  await t('F1', 'a client who withdraws after approval produces a revoked record', async () => {
    const sub = await submit('dave@client.test', prjRevoked, {
      review: 'A quote the client will withdraw before it goes live.',
      consent: { p1: true, p2: true, p3: false },
    });
    assertEqual(sub.status, 200, 'submit status');
    revokedRef = sub.json.testimonial.ref;
    const appr = await approve(revokedRef);
    assertEqual(appr.status, 200, 'approve status');
    assertEqual(appr.json.state, 'approved', 'approved before the withdrawal');

    const res = await req('POST', '/api/portal/testimonials', {
      cookie: sessions['dave@client.test'],
      body: { action: 'decline', projectId: prjRevoked },
    });
    assertEqual(res.status, 200, 'decline status');
    const stored = readJsonl(REVIEWS_FILE).filter((r) => r.ref === revokedRef).pop();
    assertEqual(stored.revoked, true, 'the record must be marked revoked');
    assert(!!stored.withdrawnAt, 'a withdrawal timestamp must be recorded');
  });

  await t('F2', 'the revoked record is the newest line for the ref (later lines win)', async () => {
    const lines = readJsonl(REVIEWS_FILE).filter((r) => r.ref === revokedRef);
    assert(lines.length >= 2, 'there must be a submission and a withdrawal');
    assertEqual(lines[lines.length - 1].revoked, true, 'the newest line must be the revocation');
  });

  await t('F3', 'an anonymous quote (p2=false) is approved and stays anonymous in the store', async () => {
    const res = await submit('carol@client.test', prjAnon, {
      review: 'An anonymous quote that must not identify anybody.',
      consent: { p1: true, p2: false, p3: false },
    });
    assertEqual(res.status, 200, 'submit status');
    const ref = res.json.testimonial.ref;
    const appr = await approve(ref);
    assertEqual(appr.status, 200, 'approve status');
    const stored = readJsonl(REVIEWS_FILE).filter((r) => r.ref === ref).pop();
    assertEqual(stored.state, 'approved', 'state');
    assertEqual(stored.consent.p2, false, 'consent.p2 must stay false');
  });

  // =========================================================================
  group('G — independent re-verification of the code-review MAJOR findings');

  await t('G1', 'M1 FIXED — no identity is stored when the client withheld naming consent (p2=false)', async () => {
    const stored = readJsonl(REVIEWS_FILE).filter((r) => r.projectId === prjAnon).pop();
    assertEqual(stored.consent.p2, false, 'consent.p2 must be false');
    assertEqual(stored.name, '', 'the store must not keep the name of a client who withheld naming consent');
    assertEqual(stored.company, '', 'the store must not keep the company');
    assertEqual(stored.role, '', 'the store must not keep the role');
    note(
      'G1-detail',
      `p2=false -> stored name=${JSON.stringify(stored.name)} company=${JSON.stringify(stored.company)} role=${JSON.stringify(stored.role)} (all empty)`,
    );
  });

  await t('G2', 'M2 FIXED — the stored record no longer carries session.email', async () => {
    const stored = readJsonl(REVIEWS_FILE).filter((r) => r.projectId === prjAnon).pop();
    assert(!stored.email, 'the record must not carry the e-mail address');
    const withEmail = readJsonl(REVIEWS_FILE).filter((r) => r.email);
    assertEqual(withEmail.length, 0, 'no record in the moderation log may carry an e-mail address');
    note(
      'G2-detail',
      `the moderation log holds ${readJsonl(REVIEWS_FILE).length} records, none with an e-mail field`,
    );
  });

  await t('G3', 'M3 FIXED — one malformed line answers 500 storage instead of silently emptying the collection', async () => {
    const healthy = readJsonl(PROJECTS_FILE).length;
    assert(healthy > 1, 'the fixture needs several projects');
    const res0 = await req('GET', '/api/portal/projects', { cookie: sessions[OWNER] });
    assertEqual(res0.json.projects.length, healthy, 'the healthy store must list every project');

    const original = fs.readFileSync(PROJECTS_FILE, 'utf8');
    fs.appendFileSync(PROJECTS_FILE, '{ this is not json\n', 'utf8');
    let listStatus = -1;
    let listCode = '';
    let patchStatus = -1;
    try {
      const res = await req('GET', '/api/portal/projects', { cookie: sessions[OWNER] });
      listStatus = res.status;
      listCode = res.json.code;
      const patch = await req('PATCH', `/api/portal/projects/${prjAlice}`, {
        cookie: sessions[OWNER], body: { status: 'completed' },
      });
      patchStatus = patch.status;
    } finally {
      fs.writeFileSync(PROJECTS_FILE, original, 'utf8');
    }
    assertEqual(readJsonl(PROJECTS_FILE).length, healthy, 'the fixture must be restored');
    assertEqual(listStatus, 500, 'the GET must answer 500, not an empty list');
    assertEqual(listCode, 'storage', 'the answer must name the store as the cause');
    assertEqual(patchStatus, 500, 'the PATCH must answer 500, not 404');
    note(
      'G3-detail',
      `one malformed line -> GET answered ${listStatus} ${listCode}; PATCH answered ${patchStatus} (the healthy store holds ${healthy} projects)`,
    );
  });

  await t('G4', 'M4 FIXED — no sign-in token is written to the log in production', async () => {
    const before = logLines.length;
    const savedKey = process.env.RESEND_API_KEY;
    const savedEnv = process.env.APP_ENV;
    delete process.env.RESEND_API_KEY;
    delete process.env.APP_ENV; // the handler's default is 'production'
    const res = await req('POST', '/api/portal/auth/request-link', { body: { email: 'owner@imk.test' } });
    if (savedKey !== undefined) process.env.RESEND_API_KEY = savedKey;
    if (savedEnv !== undefined) process.env.APP_ENV = savedEnv;
    const logged = logLines
      .slice(before)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter((l) => l && l.outcome === 'magic_link_dev')
      .pop();
    assert(!logged, 'a bearer token was written to stdout in plain text');
    assertEqual(res.status, 500, 'the request must fail loudly instead of pretending a link was sent');
    assertEqual(res.json.code, 'internal', 'the answer must say the instance is misconfigured');
    note(
      'G4-detail',
      `APP_ENV unset + no RESEND_API_KEY -> answered ${res.status} ${res.json.code}; no token on stdout`,
    );
  });

  await t('G5', 'M5 FIXED — the approve link may only approve the revision the owner was shown', async () => {
    const prjM5 = await makeProject(erin.id, 'Erin Second Website', 'completed');
    const first = await submit('erin@client.test', prjM5, {
      review: 'REVISION ONE text', consent: { p1: true, p2: true, p3: false },
    });
    assertEqual(first.status, 200, 'first submit');
    const ref = first.json.testimonial.ref;
    const revision1 = currentRevision(ref);
    assertEqual(revision1, 1, 'the first revision must be 1');

    // The owner is emailed a link for revision 1.
    const ts = Math.floor(Date.now() / 1000);
    const linkForRevision1 = moderationUrl(ref, 'approve', ts, revision1);

    // The client then edits the quote -> revision 2.
    const second = await submit('erin@client.test', prjM5, {
      review: 'REVISION TWO text', consent: { p1: true, p2: true, p3: false },
    });
    assertEqual(second.status, 200, 'second submit');
    const storedSecond = readJsonl(REVIEWS_FILE).filter((r) => r.ref === ref).pop();
    assertEqual(storedSecond.revision, 2, 'the revision counter must have advanced');

    // The owner presses the button on a link that was built for revision 1.
    const approveRes = await postDecision(linkForRevision1);
    assertEqual(approveRes.status, 409, 'a stale link must be refused, not applied to another revision');
    assertEqual(approveRes.json.code, 'stale-revision', 'code');
    const afterStale = readJsonl(REVIEWS_FILE).filter((r) => r.ref === ref);
    assertEqual(
      afterStale.filter((l) => l.state === 'approved').length,
      0,
      'no revision may be approved by a stale link',
    );
    assertEqual(
      afterStale.filter((l) => l.state === 'pending').length,
      2,
      'both revisions must still be pending',
    );

    // The link for the CURRENT revision approves exactly that revision.
    const ok = await postDecision(moderationUrl(ref, 'approve', Math.floor(Date.now() / 1000)));
    assertEqual(ok.status, 200, 'the current link must approve');
    const approved = readJsonl(REVIEWS_FILE).filter((r) => r.ref === ref && r.state === 'approved');
    assertEqual(approved.length, 1, 'exactly one line may be approved');
    assertEqual(approved[0].revision, 2, 'the approved revision must be the one the link named');
    assertEqual(approved[0].review, 'REVISION TWO text', 'the approved text must be the one the link named');
    note(
      'G5-detail',
      'a link for revision 1 answered 409 stale-revision (nothing approved); the link for revision 2 approved exactly revision 2 = "REVISION TWO text"',
    );
  });

  await t('G6', 'M6 FIXED — the Cloudflare twin has a notification path', async () => {
    const cf = path.join(SITE, 'functions', 'api', 'portal', 'testimonials.ts');
    assert(fs.existsSync(cf), 'the Cloudflare twin must exist');
    const src = fs.readFileSync(cf, 'utf8');
    assert(/notifyReviewSubmitted/.test(src), 'the twin must call the notification module');
    const lib = path.join(SITE, 'functions', 'api', 'lib', 'notifications.ts');
    assert(fs.existsSync(lib), 'the CF notifications module must exist');
    const libSrc = fs.readFileSync(lib, 'utf8');
    assert(/revision/.test(libSrc), 'the CF module must bind the link to a revision');
    assert(
      !/from\s+['"]node:crypto['"]/.test(libSrc),
      'the CF module must stay edge-safe (no node:crypto import)',
    );
  });

  await t('G7', 'm6 FIXED — a malformed submission does not burn a rate-limit slot', async () => {
    for (let i = 0; i < 6; i++) {
      const res = await req('POST', '/api/portal/testimonials', {
        cookie: sessions['heidi@client.test'],
        body: { action: 'submit', projectId: prjConsent, review: '' },
      });
      assertEqual(res.status, 400, `malformed post ${i + 1} must be a validation error`);
    }
    assertEqual(
      readJsonl(REVIEWS_FILE).filter((r) => r.projectId === prjConsent).length,
      0,
      'a malformed post must not be stored',
    );
    // The slots are still free: a valid submission is accepted.
    const good = await req('POST', '/api/portal/testimonials', {
      cookie: sessions['heidi@client.test'],
      body: {
        action: 'submit',
        projectId: prjConsent,
        review: 'A valid quote after six malformed ones.',
        consent: { p1: true, p2: true, p3: false },
      },
    });
    assertEqual(good.status, 200, 'the valid submission must not be rate-limited away');
    assertEqual(
      readJsonl(REVIEWS_FILE).filter((r) => r.projectId === prjConsent).length,
      1,
      'only the valid submission may be stored',
    );
    note('G7-detail', '6 malformed posts -> 6 × 400 and NO rate-limit slot consumed; the next valid post was accepted');
  });

  await t('G8', 'M3b FIXED - a malformed line in invited.jsonl answers 500 storage instead of locking a client out', async () => {
    const original = fs.readFileSync(INVITED_FILE, 'utf8');
    fs.appendFileSync(INVITED_FILE, '{ broken\n', 'utf8');
    let allowed = null;
    let response = null;
    try {
      const savedKey = process.env.RESEND_API_KEY;
      delete process.env.RESEND_API_KEY;
      const before = logLines.length;
      response = await req('POST', '/api/portal/auth/request-link', {
        body: { email: 'ivan@client.test' },
      });
      if (savedKey !== undefined) process.env.RESEND_API_KEY = savedKey;
      const logged = logLines
        .slice(before)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter((l) => l && l.outcome === 'magic_link_requested')
        .pop();
      allowed = logged ? logged.allowed : null;
    } finally {
      fs.writeFileSync(INVITED_FILE, original, 'utf8');
    }
    assertEqual(response.status, 500, 'a corrupt store must answer 500, not the generic 200');
    assertEqual(response.json.code, 'storage', 'the answer must name the store as the cause');
    assertEqual(allowed, null, 'the invite list must not be read at all from a corrupt store');
    note('G8-detail', 'a malformed line in invited.jsonl -> 500 storage (the client is not silently denied a link)');
  });

  await t('G9', 'M3c FIXED - a malformed line in reviews.jsonl answers 500 storage instead of 404', async () => {
    const original = fs.readFileSync(REVIEWS_FILE, 'utf8');
    fs.appendFileSync(REVIEWS_FILE, '{ broken\n', 'utf8');
    let approveStatus = -1;
    let approveCode = '';
    try {
      const res = await req('GET', moderationUrl(modRef, 'approve', Math.floor(Date.now() / 1000)));
      approveStatus = res.status;
      approveCode = res.json.code;
    } finally {
      fs.writeFileSync(REVIEWS_FILE, original, 'utf8');
    }
    assertEqual(approveStatus, 500, 'a corrupt moderation log must answer 500, not 404');
    assertEqual(approveCode, 'storage', 'the answer must name the store as the cause');
    note('G9-detail', 'a malformed line in reviews.jsonl -> the one-click approve link answers 500 storage, so the owner sees a broken store instead of "review not found"');
  });

  await t('G10', 'm6 FIXED — snooze and decline are rate-limited', async () => {
    const prj = await makeProject(grace.id, 'Grace Append Website', 'completed');
    const before = readJsonl(REVIEWS_FILE).length;
    const codes = [];
    for (let i = 0; i < 12; i++) {
      const res = await req('POST', '/api/portal/testimonials', {
        cookie: sessions['grace@client.test'],
        body: { action: 'snooze', projectId: prj },
      });
      codes.push(res.status);
    }
    const accepted = codes.filter((c) => c === 200).length;
    const limited = codes.filter((c) => c === 429).length;
    assert(limited > 0, 'the snooze action must be rate-limited');
    assert(accepted <= 10, 'no more than the action limit may be accepted');
    assertEqual(
      readJsonl(REVIEWS_FILE).length - before,
      accepted,
      'only accepted snoozes may append a line',
    );
    note(
      'G10-detail',
      `${accepted} snoozes accepted, then ${limited} × 429 rate-limit — the append-only log can no longer grow without bound`,
    );
  });

  // =========================================================================
  group('H — auth invariants (spec/08 P-7, §2.2, §2.6)');

  await t('H1', 'P-7: an unknown e-mail gets the SAME generic answer and no sign-in token', async () => {
    const before = logLines.length;
    const res = await req('POST', '/api/portal/auth/request-link', {
      body: { email: 'stranger@nowhere.test' },
    });
    assertEqual(res.status, 200, 'status');
    assert(
      res.json.message === 'If you have an invitation, a sign-in link has been sent.',
      'the generic message must be identical to the invited case',
    );
    const issued = logLines
      .slice(before)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter((l) => l && l.outcome === 'magic_link_dev');
    assertEqual(issued.length, 0, 'no magic-link token may be issued for an unknown e-mail');
  });

  await t('H2', 'a magic-link token is single-use (a second verify is 400)', async () => {
    const savedKey = process.env.RESEND_API_KEY;
    delete process.env.RESEND_API_KEY;
    const before = logLines.length;
    await req('POST', '/api/portal/auth/request-link', { body: { email: 'bob@client.test' } });
    if (savedKey !== undefined) process.env.RESEND_API_KEY = savedKey;
    const magic = logLines
      .slice(before)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter((l) => l && l.outcome === 'magic_link_dev' && l.email === 'bob@client.test')
      .pop();
    assert(magic && magic.token, 'a token must have been issued');
    const url = `/api/portal/auth/verify?token=${encodeURIComponent(magic.token)}&purpose=portal`;
    const first = await req('GET', url);
    assertEqual(first.status, 200, 'the first verify must succeed');
    const second = await req('GET', url);
    assertEqual(second.status, 400, 'the second verify must be refused');
  });

  await t('H3', 'the session cookie is HttpOnly + SameSite=Strict', async () => {
    const savedKey = process.env.RESEND_API_KEY;
    delete process.env.RESEND_API_KEY;
    const before = logLines.length;
    await req('POST', '/api/portal/auth/request-link', { body: { email: 'carol@client.test' } });
    if (savedKey !== undefined) process.env.RESEND_API_KEY = savedKey;
    const magic = logLines
      .slice(before)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter((l) => l && l.outcome === 'magic_link_dev' && l.email === 'carol@client.test')
      .pop();
    const res = await req(
      'GET',
      `/api/portal/auth/verify?token=${encodeURIComponent(magic.token)}&purpose=portal`,
    );
    const cookie = res.setCookie[0];
    assert(cookie, 'a cookie must be set');
    assert(/HttpOnly/i.test(cookie), 'HttpOnly');
    assert(/SameSite=Strict/i.test(cookie), 'SameSite=Strict');
    assert(/Max-Age=/i.test(cookie), 'a Max-Age must be set');
    note('H3-detail', `cookie attributes: ${cookie.replace(/=[^;]+/g, '=…')}`);
  });

  await t('H4', 'm4: with an http base URL the cookie carries no Secure flag', async () => {
    const savedKey = process.env.RESEND_API_KEY;
    delete process.env.RESEND_API_KEY;
    const before = logLines.length;
    await req('POST', '/api/portal/auth/request-link', { body: { email: 'dave@client.test' } });
    if (savedKey !== undefined) process.env.RESEND_API_KEY = savedKey;
    const magic = logLines
      .slice(before)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter((l) => l && l.outcome === 'magic_link_dev' && l.email === 'dave@client.test')
      .pop();
    const res = await req(
      'GET',
      `/api/portal/auth/verify?token=${encodeURIComponent(magic.token)}&purpose=portal`,
    );
    const cookie = res.setCookie[0];
    assert(!/;\s*Secure/i.test(cookie), 'no Secure flag over plain http');
    note('H4-detail', `cookie attributes: ${cookie.replace(/=[^;]+/g, '=…')}`);
  });

  await t('H5', 'every body-bearing response declares the correct Content-Length', async () => {
    const res = await req('GET', `/api/portal/testimonials?projectId=${prjAlice}`, {
      cookie: sessions['alice@client.test'],
    });
    const declared = res.headers.get('content-length');
    assert(declared !== null, 'a Content-Length must be declared');
    assertEqual(Number(declared), Buffer.byteLength(res.text), 'Content-Length vs body bytes');
  });

  // =========================================================================
  group('I — the secret rule (H-1, wave-8A): a PRESENT but UNUSABLE secret is refused');

  // In production a secret is refused when it is missing, when it is the
  // published placeholder, and when it is shorter than 32 characters. A
  // published HMAC key is a public key: anybody who knows it can forge an
  // admin session, a sign-in link and a moderation link.
  const withProductionEnv = async (fn) => {
    const savedEnv = process.env.APP_ENV;
    delete process.env.APP_ENV; // unset = production
    try {
      return await fn();
    } finally {
      if (savedEnv !== undefined) process.env.APP_ENV = savedEnv;
    }
  };

  /**
   * Put an environment variable back the way it was.
   *
   * `process.env.X = undefined` writes the STRING "undefined" -- a 13
   * character secret that the next request would refuse. A variable that was
   * not set has to be DELETED again.
   */
  const restoreEnv = (name, value) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };

  await t('I1', 'H-1: in production a secret SHORTER than 32 characters is refused (500 internal)', async () => {
    const saved = process.env.FORM_WEBHOOK_SECRET;
    process.env.FORM_WEBHOOK_SECRET = 'qa-too-short-secret';
    let res = null;
    try {
      res = await withProductionEnv(() =>
        req('GET', moderationUrl(modRef, 'approve', Math.floor(Date.now() / 1000))),
      );
    } finally {
      restoreEnv('FORM_WEBHOOK_SECRET', saved);
    }
    assertEqual(res.status, 500, 'a short secret must be refused');
    assertEqual(res.json.code, 'internal', 'the answer must say the instance is misconfigured');
    note('I1-detail', 'a 17-character FORM_WEBHOOK_SECRET -> 500 {code:internal} in production');
  });

  await t('I2', 'H-1: in production the PUBLISHED PLACEHOLDER secret is refused as well', async () => {
    const saved = process.env.FORM_WEBHOOK_SECRET;
    process.env.FORM_WEBHOOK_SECRET = 'your-32-byte-hex-hmac-secret-here';
    let res = null;
    try {
      res = await withProductionEnv(() =>
        req('GET', moderationUrl(modRef, 'approve', Math.floor(Date.now() / 1000))),
      );
    } finally {
      restoreEnv('FORM_WEBHOOK_SECRET', saved);
    }
    assertEqual(res.status, 500, 'the published placeholder must be refused');
    assertEqual(res.json.code, 'internal', 'the answer must say the instance is misconfigured');
    note('I2-detail', 'the placeholder from site/.env.example -> 500 {code:internal} in production');
  });

  await t('I3', 'H-1: CONTROL - a secret of 32+ characters IS usable in production', async () => {
    // A client of its own: the submit bucket holds 5 per hour.
    const prjSecret = await makeProject(frank.id, 'Frank Secret Website', 'completed');
    const sub = await submit('frank@client.test', prjSecret, {
      review: 'A quote approved with a 32-character secret.',
      consent: { p1: true, p2: true, p3: false },
    });
    assertEqual(sub.status, 200, 'submit status');
    const ref = sub.json.testimonial.ref;

    const good = 'qa-exactly-thirty-two-characters-01'; // 33 characters
    assert(good.length >= 32, 'the control secret must be at least 32 characters');
    const saved = process.env.FORM_WEBHOOK_SECRET;
    process.env.FORM_WEBHOOK_SECRET = good;
    let res = null;
    try {
      const ts = Math.floor(Date.now() / 1000);
      const sig = require('node:crypto')
        .createHmac('sha256', good)
        .update(`${ref}|approve|1|${ts}`)
        .digest('hex');
      const url = `/api/moderate/review?ref=${encodeURIComponent(ref)}&decision=approve&revision=1&sig=${encodeURIComponent(sig)}&ts=${ts}`;
      res = await withProductionEnv(() => postDecision(url));
    } finally {
      restoreEnv('FORM_WEBHOOK_SECRET', saved);
    }
    assertEqual(res.status, 200, `a 32+ character secret must be accepted (got ${res.status}: ${res.text})`);
    assertEqual(res.json.state, 'approved', 'state');
    note('I3-detail', `a ${good.length}-character secret signed and approved a quote in production`);
  });

  await t('I4', 'H-1: in production a short SIGNING secret means no session can be minted', async () => {
    const savedSession = process.env.PORTAL_SESSION_SECRET;
    const savedMagic = process.env.PORTAL_MAGIC_LINK_SECRET;
    process.env.PORTAL_SESSION_SECRET = 'qa-short-session';
    process.env.PORTAL_MAGIC_LINK_SECRET = 'qa-short-magic';
    let res = null;
    try {
      res = await withProductionEnv(() =>
        req('POST', '/api/portal/auth/request-link', { body: { email: 'alice@client.test' } }),
      );
    } finally {
      restoreEnv('PORTAL_SESSION_SECRET', savedSession);
      restoreEnv('PORTAL_MAGIC_LINK_SECRET', savedMagic);
    }
    assertEqual(res.status, 500, 'a short signing secret must be refused');
    assertEqual(res.json.code, 'internal', 'the answer must say the instance is misconfigured');
    assertEqual(res.setCookie.length, 0, 'no session cookie may be issued');
    note('I4-detail', 'a 16-character PORTAL_SESSION_SECRET -> 500 {code:internal}, no cookie');
  });

  // =========================================================================
  group('J — GET /api/portal/session (the server truth about the requester)');

  await t('J1', 'no session -> 401 {code:unauthorized}', async () => {
    const res = await req('GET', '/api/portal/session');
    assertEqual(res.status, 401, 'status');
    assertEqual(res.json.code, 'unauthorized', 'code');
  });

  await t('J2', 'the owner -> 200 {role:admin}', async () => {
    const res = await req('GET', '/api/portal/session', { cookie: sessions[OWNER] });
    assertEqual(res.status, 200, 'status');
    assertEqual(res.json.ok, true, 'ok');
    assertEqual(res.json.authenticated, true, 'authenticated');
    assertEqual(res.json.role, 'admin', 'role');
    assertEqual(res.json.email, OWNER, 'email');
    assert(typeof res.json.expiresAt === 'number', 'the expiry must be reported');
    assert(!('clientId' in res.json), 'an owner session has no clientId');
  });

  await t('J3', 'a client -> 200 {role:client, clientId}', async () => {
    const res = await req('GET', '/api/portal/session', { cookie: sessions['alice@client.test'] });
    assertEqual(res.status, 200, 'status');
    assertEqual(res.json.role, 'client', 'role');
    assertEqual(res.json.email, 'alice@client.test', 'email');
    assert(res.json.clientId, 'a client session must carry its clientId');
  });

  await t('J4', 'another method -> 405 {code:method}', async () => {
    const res = await req('POST', '/api/portal/session', { cookie: sessions[OWNER], body: {} });
    assertEqual(res.status, 405, 'status');
    assertEqual(res.json.code, 'method', 'code');
  });

  await t('J5', 'an unset ADMIN_EMAILS -> 500 {code:internal} (a misconfiguration, not "nobody is the owner")', async () => {
    const saved = process.env.ADMIN_EMAILS;
    delete process.env.ADMIN_EMAILS;
    let res = null;
    try {
      res = await req('GET', '/api/portal/session', { cookie: sessions[OWNER] });
    } finally {
      process.env.ADMIN_EMAILS = saved;
    }
    assertEqual(res.status, 500, 'status');
    assertEqual(res.json.code, 'internal', 'code');
  });

  await t('J6', 'the allow-list is live: an owner whose address was removed is answered "client"', async () => {
    const saved = process.env.ADMIN_EMAILS;
    process.env.ADMIN_EMAILS = 'somebody.else@imk.test';
    let res = null;
    try {
      res = await req('GET', '/api/portal/session', { cookie: sessions[OWNER] });
    } finally {
      process.env.ADMIN_EMAILS = saved;
    }
    assertEqual(res.status, 200, 'the session itself is still valid');
    assertEqual(res.json.role, 'client', 'the owner powers must be gone at once');
    note('J6-detail', 'the same owner token was answered "client" after the address left the allow-list');
  });

  await t('J7', 'H-2: an unusable session secret is a MISCONFIGURATION (500), not a silent 401', async () => {
    // The Cloudflare twin answers 500 {code:'internal'} here ("a deployment
    // that cannot VERIFY a session must say so loudly -- a 401 would be the
    // silent 'signed out' symptom"). The two trees must answer the same way
    // for the same input (spec/07 §1, D-6).
    const savedSession = process.env.PORTAL_SESSION_SECRET;
    const savedMagic = process.env.PORTAL_MAGIC_LINK_SECRET;
    process.env.PORTAL_SESSION_SECRET = 'qa-short-session';
    process.env.PORTAL_MAGIC_LINK_SECRET = 'qa-short-magic';
    let res = null;
    try {
      res = await withProductionEnv(() =>
        req('GET', '/api/portal/session', { cookie: sessions[OWNER] }),
      );
    } finally {
      restoreEnv('PORTAL_SESSION_SECRET', savedSession);
      restoreEnv('PORTAL_MAGIC_LINK_SECRET', savedMagic);
    }
    assertEqual(
      res.status,
      500,
      `an unusable signing secret must be loud (got ${res.status}: ${res.text}) -- the Cloudflare twin answers 500 {code:'internal'} for the same input`,
    );
    assertEqual(res.json.code, 'internal', 'the answer must say the instance is misconfigured');
  });

  // =========================================================================
  const passed = results.filter((r) => r.status === 'PASS').length;
  const failed = results.filter((r) => r.status === 'FAIL').length;
  const summary = { passed, failed, total: results.length };

  origLog('');
  origLog(`[qa] ${passed} passed, ${failed} failed, ${results.length} checks`);
  origLog(`[qa] sandbox: ${SANDBOX}`);

  const report = {
    generatedAt: new Date().toISOString(),
    sandbox: SANDBOX,
    origin: ORIGIN,
    summary,
    results,
    fixtures: {
      projects: readJsonl(PROJECTS_FILE).map((p) => ({ id: p.id, title: p.title, status: p.status, clientId: p.clientId, testimonialStatus: p.testimonialStatus })),
      reviews: readJsonl(REVIEWS_FILE),
      clients: readJsonl(CLIENTS_FILE).map((c) => ({ id: c.id, email: c.email, name: c.name, company: c.company, role: c.role })),
      keys: {
        aliceRef,
        revokedRef,
      },
    },
  };
  const outPath = JSON_OUT || path.join(SANDBOX, 'qa-results.json');
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');
  origLog(`[qa] results: ${outPath}`);

  if (server) await new Promise((resolve) => server.close(resolve));
  process.chdir(REPO);
  if (!KEEP) {
    rmrf(SANDBOX);
    origLog('[qa] sandbox removed');
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('[qa] harness crashed:', err);
  process.exit(2);
});
