// backend-review-fixes-harness.mjs
//
// Executed evidence for the code-review fix wave on the testimonials /
// contact / moderation feature (findings B1-B8, both handler trees).
//
// WHAT IT EXECUTES — the REAL, UNMODIFIED handler files, bundled one entry
// per file with the repo's own esbuild (exactly how Vercel builds them) and
// driven in child processes whose cwd is a throw-away sandbox, so the repo's
// site/data/ is never read or written.
//
//   R   the parsed body must be a plain object: body `null`, `[]` and
//       malformed JSON all answer the SAME 400 {error:'invalid payload'} on
//       BOTH trees — and never 500 (B1), with byte-identical shapes across
//       targets
//   O   a client session without a clientId is refused 403 on GET and POST,
//       including against a project that itself has no clientId — the
//       cross-tenant hole (B3)
//   N   with naming consent (p2) but no profile name, the stored name is
//       blank, never the e-mail local part; a named client still stores the
//       profile name; p2=false still stores nothing (B6)
//   C   POST /api/contact refuses 'Review' / ' review' / 'REVIEW' with 410
//       review-moved on BOTH trees, before any write, and a normal contact
//       still passes (B4)
//   B   an oversized testimonial POST answers 413 {code:'payload-too-large'}
//       on both trees, via the content-length check AND via the streamed-bytes
//       cap (B5)
//   W   a FAILED write on the Cloudflare tree answers 500 {code:'storage'}
//       and never ok:true (B7)
//   M   a stale-revision 409 on the Cloudflare moderation endpoint re-mails
//       the owner a WORKING link for the current revision — signature
//       verified in the harness — and mails nothing for a snoozed quote;
//       Vercel parity re-checked (B2)
//   P   the signed FORM_WEBHOOK_URL delivery + CONTACT_TO fallback + linkedin
//       parsing behave identically on both contact handlers (B8 parity port)
//
// USAGE
//   node backend-review-fixes-harness.mjs [--keep]

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
const BASE = 'https://imk.test';
const SECRET = 'review-fix-harness-secret-0123456789';
const WEBHOOK_SECRET = 'review-fix-webhook-secret-9876543210';

const results = [];
let currentGroup = '';
const origLog = console.log;

function group(name) {
  currentGroup = name;
  origLog(`\n[review-fix] ${name}`);
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function t(id, name, fn) {
  try {
    const detail = await fn();
    results.push({ id, group: currentGroup, name, status: 'PASS', detail: detail ?? null });
    origLog(`  PASS  ${id}  ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (err) {
    results.push({
      id, group: currentGroup, name, status: 'FAIL',
      error: String(err && err.message ? err.message : err),
    });
    origLog(`  FAIL  ${id} ${name}\n          ${err && err.message ? err.message : err}`);
  }
}

// ---------------------------------------------------------------------------
// Sandbox + bundles
// ---------------------------------------------------------------------------

const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const ROOT = path.join(os.tmpdir(), 'opencode', 'review-fix', STAMP);
const BUNDLES = path.join(ROOT, 'bundles');
const CHILD_FILE = path.join(ROOT, 'child.cjs');

const ENTRIES = {
  'vercel-testimonials': path.join(REPO, 'site', 'shared', 'portal-handlers', 'portal-testimonials.ts'),
  'vercel-contact': path.join(REPO, 'api', 'contact.ts'),
  'vercel-moderate': path.join(REPO, 'api', 'moderate', 'review.ts'),
  'cf-testimonials': path.join(REPO, 'site', 'functions', 'api', 'portal', 'testimonials.ts'),
  'cf-contact': path.join(REPO, 'site', 'functions', 'api', 'contact.ts'),
  'cf-moderate': path.join(REPO, 'site', 'functions', 'api', 'moderate', 'review.ts'),
  'shared-session': path.join(REPO, 'site', 'shared', 'server', 'portal-session.ts'),
};

async function bundleAll() {
  fs.mkdirSync(BUNDLES, { recursive: true });
  for (const [name, entry] of Object.entries(ENTRIES)) {
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

function bundlePath(name) {
  return path.join(BUNDLES, `${name}.cjs`);
}

// ---------------------------------------------------------------------------
// The child runner
// ---------------------------------------------------------------------------

const CHILD = `
const { Readable } = require('node:stream');
const fs = require('node:fs');
const path = require('node:path');

// The Cloudflare code looks for globalThis.require to reach a filesystem
// (there is none on the real edge). This child is CommonJS, where require is
// module-scoped and globalThis.require is undefined unless we install it —
// so the CF handlers get the sandbox filesystem, like the wave-6 harness.
globalThis.require = require;

// Capture every structured log line the handlers print.
const LOGS = [];
console.log = (...args) => {
  try { LOGS.push(JSON.parse(String(args[0]))); } catch { /* noise */ }
};

// No real network: every fetch is captured and answered ok.
const FETCHES = [];
globalThis.fetch = async (url, init) => {
  FETCHES.push({
    url: String(url),
    headers: (init && init.headers) || {},
    body: (init && init.body) || '',
  });
  return { ok: true, status: 200, json: async () => ({ success: true }) };
};

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
    writeHead(status, headers) { this.statusCode = status; this.headers = headers || {}; return this; },
    setHeader(name, value) { this.headers[name] = value; },
    end(payload) {
      if (payload) this.body += Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload);
      this.ended = true; this.writableEnded = true; return this;
    },
  };
}

function parseResult(status, raw, headers) {
  let body = null;
  try { body = JSON.parse(raw || 'null'); } catch { body = null; }
  return { status, body, raw, headers: headers || {} };
}

async function runStep(step, state, cfEnv) {
  if (step.op === 'seed') {
    for (const [file, lines] of Object.entries(step.files)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(
        file,
        lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\\n') + '\\n',
        'utf8',
      );
    }
    return null;
  }
  if (step.op === 'chmod') { fs.chmodSync(step.file, step.mode); return null; }
  if (step.op === 'mint') {
    const ss = require(step.sessionBundle);
    const token = ss.createSession(step.email, step.role, step.clientId);
    state.tokens[step.id] = token;
    return token ? 'minted' : 'NULL';
  }
  if (step.op === 'vercel') {
    const mod = require(step.bundle);
    const headers = { ...(step.headers || {}) };
    if (step.as) {
      headers.cookie = (step.asRole === 'admin' ? 'imk_admin_session=' : 'imk_session=') + state.tokens[step.as];
    }
    const req = makeReq(step.method, step.url, headers, step.body);
    const res = makeRes();
    await mod.default(req, res);
    return parseResult(res.statusCode, res.body, res.headers);
  }
  if (step.op === 'cf') {
    const mod = require(step.bundle);
    const headers = new Headers(step.headers || {});
    if (step.as) {
      headers.set('cookie', (step.asRole === 'admin' ? 'imk_admin_session=' : 'imk_session=') + state.tokens[step.as]);
    }
    const init = { method: step.method, headers };
    if (step.stream && step.body && step.method !== 'GET' && step.method !== 'HEAD') {
      // A streamed body: no content-length is set, so only the handler's
      // streamed-bytes cap can stop it.
      init.body = new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode(step.body)); controller.close(); },
      });
      // undici requires duplex:'half' when the body is a stream.
      init.duplex = 'half';
    } else if (step.body && step.method !== 'GET' && step.method !== 'HEAD') {
      init.body = step.body;
    }
    const request = new Request('https://imk.test' + step.url, init);
    const env = { ...(cfEnv || {}), ...(step.env || {}) };
    const handler = step.method === 'GET' ? mod.onRequestGet : mod.onRequestPost;
    const response = await handler({ request, env });
    const raw = await response.text();
    const hdrs = {};
    response.headers.forEach((value, key) => { hdrs[key] = value; });
    return parseResult(response.status, raw, hdrs);
  }
  if (step.op === 'store') {
    if (!fs.existsSync(step.file)) return [];
    return fs.readFileSync(step.file, 'utf8').split('\\n').filter((l) => l.trim() !== '').map((l) => {
      try { return JSON.parse(l); } catch { return { __malformed: l }; }
    });
  }
  if (step.op === 'fetches') return FETCHES.splice(0, FETCHES.length);
  if (step.op === 'logs') return LOGS.slice();
  throw new Error('unknown step op: ' + step.op);
}

(async () => {
  const plan = JSON.parse(process.env.RF_PLAN || '{}');
  const state = { tokens: {} };
  const out = [];
  for (const step of plan.steps || []) {
    let result;
    try {
      result = await runStep(step, state, plan.cfEnv);
    } catch (err) {
      result = { error: String((err && err.message) || err) };
    }
    out.push({ id: step.id, op: step.op, result });
  }
  process.stdout.write('__RESULT__' + JSON.stringify({ out, logs: LOGS }) + '\\n');
})().catch((err) => {
  process.stdout.write('__RESULT__' + JSON.stringify([{ error: String((err && err.message) || err) }]) + '\\n');
  process.exitCode = 1;
});
`;

function runChild(caseId, plan, env = {}, cfEnv = null) {
  fs.writeFileSync(CHILD_FILE, CHILD, 'utf8');
  const sandbox = path.join(ROOT, 'cases', caseId);
  fs.mkdirSync(sandbox, { recursive: true });

  const childEnv = { ...process.env };
  for (const key of [
    'RESEND_API_KEY', 'RESEND_TO', 'CONTACT_TO', 'RESEND_FROM', 'APP_ENV', 'SITE_BASE_URL',
    'SITE_URL', 'PORTAL_SESSION_SECRET', 'PORTAL_MAGIC_LINK_SECRET', 'ADMIN_EMAILS',
    'FORM_WEBHOOK_SECRET', 'FORM_WEBHOOK_URL', 'TURNSTILE_SECRET_KEY', 'DEV_STUB',
  ]) {
    delete childEnv[key];
  }
  childEnv.APP_ENV = 'development';
  childEnv.SITE_BASE_URL = BASE;
  childEnv.PORTAL_SESSION_SECRET = SECRET;
  childEnv.FORM_WEBHOOK_SECRET = WEBHOOK_SECRET;
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete childEnv[k];
    else childEnv[k] = String(v);
  }
  childEnv.RF_PLAN = JSON.stringify({ cfEnv: cfEnv || {}, steps: plan });
  delete childEnv.RF_PLAN_REDACT;

  const res = spawnSync(process.execPath, [CHILD_FILE], {
    cwd: sandbox,
    env: childEnv,
    encoding: 'utf8',
    timeout: 120000,
  });
  const stdout = res.stdout || '';
  const line = stdout.split('\n').find((l) => l.startsWith('__RESULT__'));
  if (!line) {
    throw new Error(`child produced no result\nstdout:\n${stdout}\nstderr:\n${res.stderr || ''}`);
  }
  const parsed = JSON.parse(line.slice('__RESULT__'.length));
  const byId = {};
  for (const entry of parsed.out || []) byId[entry.id] = entry.result;
  return { byId, logs: parsed.logs || [], stdout, stderr: res.stderr || '', sandbox };
}

// ---------------------------------------------------------------------------
// Fixtures shared by most cases
// ---------------------------------------------------------------------------

const NOW = new Date().toISOString();

function portalFixtures() {
  return {
    'site/data/portal/projects.jsonl': [
      { id: 'prj_named', clientId: 'cli_named', title: 'Named project', status: 'completed', createdAt: NOW },
      { id: 'prj_noname', clientId: 'cli_noname', title: 'No-name project', status: 'completed', createdAt: NOW },
      { id: 'prj_orphan', title: 'No tenant at all', status: 'completed', createdAt: NOW },
    ],
    'site/data/portal/clients.jsonl': [
      { id: 'cli_named', email: 'named@client.test', name: 'Alice Named', company: 'Acme Ltd', role: 'CTO', createdAt: NOW },
      { id: 'cli_noname', email: 'noname@client.test', company: 'Noname Co', createdAt: NOW },
    ],
  };
}

function signInSteps() {
  return [
    { op: 'mint', id: 'named', email: 'named@client.test', role: 'client', clientId: 'cli_named', sessionBundle: bundlePath('shared-session') },
    { op: 'mint', id: 'noname', email: 'noname@client.test', role: 'client', clientId: 'cli_noname', sessionBundle: bundlePath('shared-session') },
    { op: 'mint', id: 'ghost', email: 'ghost@client.test', role: 'client', sessionBundle: bundlePath('shared-session') },
  ];
}

const ORIGIN_HDR = { origin: BASE, 'content-type': 'application/json' };

function post(body, as = 'named') {
  return { headers: { ...ORIGIN_HDR }, body: typeof body === 'string' ? body : JSON.stringify(body), as };
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

async function main() {
  origLog(`[review-fix] bundling ${Object.keys(ENTRIES).length} handler files…`);
  await bundleAll();

  // =========================================================================
  group('B1 — a non-object body is 400, never 500, same shape on both trees');

  await t('R1', "POST body literally 'null' -> 400 invalid payload (Vercel)", async () => {
    const c = runChild('r1', [
      { op: 'seed', files: portalFixtures() },
      ...signInSteps(),
      { op: 'vercel', id: 'p', bundle: bundlePath('vercel-testimonials'), method: 'POST', url: '/api/portal/testimonials', ...post('null'), as: 'named' },
    ]);
    const r = c.byId.p;
    assertEqual(r.status, 400, 'status');
    assertEqual(r.body && r.body.error, 'invalid payload', 'error');
    assertEqual(r.body && r.body.code, 'validation', 'code');
    return `400 ${JSON.stringify(r.body)}`;
  });

  await t('R2', "POST body literally 'null' -> 400 invalid payload (Cloudflare)", async () => {
    const c = runChild('r2', [
      { op: 'seed', files: portalFixtures() },
      ...signInSteps(),
      { op: 'cf', id: 'p', bundle: bundlePath('cf-testimonials'), method: 'POST', url: '/api/portal/testimonials', ...post('null'), as: 'named' },
    ], {}, { SITE_BASE_URL: BASE, PORTAL_SESSION_SECRET: SECRET, APP_ENV: 'development' });
    const r = c.byId.p;
    assertEqual(r.status, 400, 'status');
    assertEqual(r.body && r.body.error, 'invalid payload', 'error');
    assertEqual(r.body && r.body.code, 'validation', 'code');
    return `400 ${JSON.stringify(r.body)}`;
  });

  await t('R3', 'an array body and a malformed body answer identically on BOTH trees', async () => {
    const cfEnv = { SITE_BASE_URL: BASE, PORTAL_SESSION_SECRET: SECRET, APP_ENV: 'development' };
    const shapes = [];
    for (const [label, bodyStr] of [['array', '[1,2]'], ['malformed', '{"oops"'], ['number', '42']]) {
      const run = (tree) => runChild(`r3-${tree}-${label}`, [
        { op: 'seed', files: portalFixtures() },
        ...signInSteps(),
        tree === 'v'
          ? { op: 'vercel', id: 'p', bundle: bundlePath('vercel-testimonials'), method: 'POST', url: '/api/portal/testimonials', ...post(bodyStr), as: 'named' }
          : { op: 'cf', id: 'p', bundle: bundlePath('cf-testimonials'), method: 'POST', url: '/api/portal/testimonials', ...post(bodyStr), as: 'named' },
      ], {}, cfEnv);
      const v = run('v').byId.p;
      const f = run('cf').byId.p;
      assertEqual(v.status, 400, `${label}: vercel status`);
      assertEqual(f.status, 400, `${label}: cf status`);
      assertEqual(v.body && v.body.error, 'invalid payload', `${label}: vercel error`);
      assertEqual(f.body && f.body.error, 'invalid payload', `${label}: cf error`);
      assertEqual(JSON.stringify(v.body), JSON.stringify(f.body), `${label}: cross-tree body parity`);
      shapes.push(`${label}:400/invalid payload`);
    }
    return shapes.join(', ');
  });

  await t('R4', 'a valid object with a bad action still answers 400 fields:[action] (unchanged)', async () => {
    const c = runChild('r4', [
      { op: 'seed', files: portalFixtures() },
      ...signInSteps(),
      { op: 'vercel', id: 'p', bundle: bundlePath('vercel-testimonials'), method: 'POST', url: '/api/portal/testimonials', ...post({ action: 'publish-now' }), as: 'named' },
    ]);
    const r = c.byId.p;
    assertEqual(r.status, 400, 'status');
    assert((r.body.fields || []).includes('action'), 'action must be named');
    return JSON.stringify(r.body);
  });

  // =========================================================================
  group('B3 — the ownership gate: a client session without a clientId is 403');

  await t('O1', 'POST from a clientId-less client session -> 403, even for a clientId-less project (Vercel)', async () => {
    const c = runChild('o1', [
      { op: 'seed', files: portalFixtures() },
      ...signInSteps(),
      { op: 'vercel', id: 'p', bundle: bundlePath('vercel-testimonials'), method: 'POST', url: '/api/portal/testimonials', ...post({ action: 'submit', projectId: 'prj_orphan', review: 'hello', consent: { p1: true } }), as: 'ghost' },
    ]);
    const r = c.byId.p;
    assertEqual(r.status, 403, 'status');
    assertEqual(r.body && r.body.code, 'forbidden', 'code');
    const store = runChild('o1b', [{ op: 'seed', files: portalFixtures() }, { op: 'store', id: 's', file: 'site/data/moderation/reviews.jsonl' }]);
    assertEqual(store.byId.s.length, 0, 'nothing may be stored');
    return `403 ${JSON.stringify(r.body)}`;
  });

  await t('O2', 'the same 403 on the Cloudflare tree (GET and POST)', async () => {
    const cfEnv = { SITE_BASE_URL: BASE, PORTAL_SESSION_SECRET: SECRET, APP_ENV: 'development' };
    const c = runChild('o2', [
      { op: 'seed', files: portalFixtures() },
      ...signInSteps(),
      { op: 'cf', id: 'g', bundle: bundlePath('cf-testimonials'), method: 'GET', url: '/api/portal/testimonials?projectId=prj_orphan', headers: {}, as: 'ghost' },
      { op: 'cf', id: 'p', bundle: bundlePath('cf-testimonials'), method: 'POST', url: '/api/portal/testimonials', ...post({ action: 'submit', projectId: 'prj_orphan', review: 'hello', consent: { p1: true } }), as: 'ghost' },
    ], {}, cfEnv);
    assertEqual(c.byId.g.status, 403, 'GET status');
    assertEqual(c.byId.p.status, 403, 'POST status');
    assertEqual(c.byId.p.body && c.byId.p.body.code, 'forbidden', 'code');
    return 'GET 403, POST 403';
  });

  await t('O3', 'a NORMAL client session is unaffected (GET 200, submit 200)', async () => {
    const c = runChild('o3', [
      { op: 'seed', files: portalFixtures() },
      ...signInSteps(),
      { op: 'vercel', id: 'g', bundle: bundlePath('vercel-testimonials'), method: 'GET', url: '/api/portal/testimonials?projectId=prj_named', headers: { cookie: '' }, as: 'named' },
      { op: 'vercel', id: 'p', bundle: bundlePath('vercel-testimonials'), method: 'POST', url: '/api/portal/testimonials', ...post({ action: 'submit', projectId: 'prj_named', review: 'A fine studio.', consent: { p1: true, p2: true } }), as: 'named' },
    ]);
    assertEqual(c.byId.g.status, 200, 'GET status');
    assertEqual(c.byId.p.status, 200, 'submit status');
    assertEqual(c.byId.p.body && c.byId.p.body.ok, true, 'ok');
    return 'GET 200, submit 200';
  });

  // =========================================================================
  group('B6 — the published name never falls back to the e-mail local part');

  await t('N1', 'p2=true with NO profile name stores a BLANK name, not the local part (Vercel)', async () => {
    const c = runChild('n1', [
      { op: 'seed', files: portalFixtures() },
      ...signInSteps(),
      { op: 'vercel', id: 'p', bundle: bundlePath('vercel-testimonials'), method: 'POST', url: '/api/portal/testimonials', ...post({ action: 'submit', projectId: 'prj_noname', review: 'Great work.', rating: 5, consent: { p1: true, p2: true } }), as: 'noname' },
      { op: 'store', id: 's', file: 'site/data/moderation/reviews.jsonl' },
    ]);
    assertEqual(c.byId.p.status, 200, 'submit status');
    const rec = c.byId.s.filter((r) => r.type === 'review').pop();
    assertEqual(rec.name, '', 'stored name must be blank');
    assert(rec.name !== 'noname', 'the e-mail local part must not be published');
    assertEqual(rec.company, 'Noname Co', 'company still travels with consent');
    assertEqual(rec.consent.p2, true, 'consent unchanged');
    return 'name="" company="Noname Co"';
  });

  await t('N2', 'p2=true with NO profile name stores a BLANK name on the Cloudflare tree too', async () => {
    const cfEnv = { SITE_BASE_URL: BASE, PORTAL_SESSION_SECRET: SECRET, APP_ENV: 'development' };
    const c = runChild('n2', [
      { op: 'seed', files: portalFixtures() },
      ...signInSteps(),
      { op: 'cf', id: 'p', bundle: bundlePath('cf-testimonials'), method: 'POST', url: '/api/portal/testimonials', ...post({ action: 'submit', projectId: 'prj_noname', review: 'Great work.', rating: 5, consent: { p1: true, p2: true } }), as: 'noname' },
      { op: 'store', id: 's', file: 'site/data/moderation/reviews.jsonl' },
    ], {}, cfEnv);
    assertEqual(c.byId.p.status, 200, 'submit status');
    const rec = c.byId.s.filter((r) => r.type === 'review').pop();
    assertEqual(rec.name, '', 'stored name must be blank');
    assert(rec.name !== 'noname', 'the e-mail local part must not be published');
    return 'name=""';
  });

  await t('N3', 'regression: a NAMED client still stores the profile name; p2=false still stores nothing', async () => {
    const c = runChild('n3', [
      { op: 'seed', files: portalFixtures() },
      ...signInSteps(),
      { op: 'vercel', id: 'named', bundle: bundlePath('vercel-testimonials'), method: 'POST', url: '/api/portal/testimonials', ...post({ action: 'submit', projectId: 'prj_named', review: 'Named quote.', consent: { p1: true, p2: true } }), as: 'named' },
      { op: 'vercel', id: 'anon', bundle: bundlePath('vercel-testimonials'), method: 'POST', url: '/api/portal/testimonials', ...post({ action: 'submit', projectId: 'prj_noname', review: 'Anon quote.', consent: { p1: true, p2: false } }), as: 'noname' },
      { op: 'store', id: 's', file: 'site/data/moderation/reviews.jsonl' },
    ]);
    assertEqual(c.byId.named.status, 200, 'named submit');
    const named = c.byId.s.filter((r) => r.review === 'Named quote.').pop();
    assertEqual(named.name, 'Alice Named', 'the profile name is stored');
    assertEqual(c.byId.anon.status, 200, 'p2=false submit');
    const anon = c.byId.s.filter((r) => r.review === 'Anon quote.').pop();
    assertEqual(anon.name, '', 'p2=false stores no name');
    assertEqual(anon.company, '', 'p2=false stores no company');
    return 'Alice Named / blank';
  });

  // =========================================================================
  group('B5 — the testimonial body is capped (~16 KB) on both trees');

  await t('B1x', 'an oversized body answers 413 payload-too-large (Vercel + Cloudflare)', async () => {
    const cfEnv = { SITE_BASE_URL: BASE, PORTAL_SESSION_SECRET: SECRET, APP_ENV: 'development' };
    const big = { action: 'submit', projectId: 'prj_named', review: 'x'.repeat(20000), consent: { p1: true } };
    const steps = (tree) => [
      { op: 'seed', files: portalFixtures() },
      ...signInSteps(),
      tree === 'v'
        ? { op: 'vercel', id: 'p', bundle: bundlePath('vercel-testimonials'), method: 'POST', url: '/api/portal/testimonials', ...post(big), as: 'named' }
        : { op: 'cf', id: 'p', bundle: bundlePath('cf-testimonials'), method: 'POST', url: '/api/portal/testimonials', ...post(big), as: 'named' },
    ];
    const v = runChild('b1x-v', steps('v')).byId.p;
    const f = runChild('b1x-cf', steps('cf'), {}, cfEnv).byId.p;
    assertEqual(v.status, 413, 'vercel status');
    assertEqual(f.status, 413, 'cf status');
    assertEqual(v.body && v.body.code, 'payload-too-large', 'vercel code');
    assertEqual(f.body && f.body.code, 'payload-too-large', 'cf code');
    assertEqual(JSON.stringify(v.body), JSON.stringify(f.body), 'cross-tree parity');
    return '413 both trees';
  });

  await t('B2x', 'the streamed-bytes cap fires when content-length is absent (both trees)', async () => {
    // Vercel: a raw IncomingMessage with no content-length header.
    const v = runChild('b2x-v', [
      { op: 'seed', files: portalFixtures() },
      ...signInSteps(),
      {
        op: 'vercel', id: 'p', bundle: bundlePath('vercel-testimonials'), method: 'POST', url: '/api/portal/testimonials',
        headers: { origin: BASE }, // no content-type, no content-length
        body: JSON.stringify({ action: 'submit', projectId: 'prj_named', review: 'y'.repeat(20000), consent: { p1: true } }),
        as: 'named',
      },
    ]).byId.p;
    assertEqual(v.status, 413, 'vercel streaming status');

    // Cloudflare: a Request with a streamed body (no content-length).
    const cfEnv = { SITE_BASE_URL: BASE, PORTAL_SESSION_SECRET: SECRET, APP_ENV: 'development' };
    const f = runChild('b2x-cf', [
      { op: 'seed', files: portalFixtures() },
      ...signInSteps(),
      {
        op: 'cf', id: 'p', bundle: bundlePath('cf-testimonials'), method: 'POST', url: '/api/portal/testimonials',
        headers: { origin: BASE },
        stream: true,
        body: JSON.stringify({ action: 'submit', projectId: 'prj_named', review: 'y'.repeat(20000), consent: { p1: true } }),
        as: 'named',
      },
    ], {}, cfEnv).byId.p;
    assertEqual(f.status, 413, 'cf streaming status');
    return '413 both, no content-length';
  });

  await t('B3x', 'a normal-sized submission under the cap still succeeds (both trees)', async () => {
    const cfEnv = { SITE_BASE_URL: BASE, PORTAL_SESSION_SECRET: SECRET, APP_ENV: 'development' };
    // A full-size quote (MAX_QUOTE is 1000) inside a body far under the 16 KB
    // cap must pass on both trees.
    const body = { action: 'submit', projectId: 'prj_named', review: 'z'.repeat(900), consent: { p1: true } };
    const v = runChild('b3x-v', [
      { op: 'seed', files: portalFixtures() }, ...signInSteps(),
      { op: 'vercel', id: 'p', bundle: bundlePath('vercel-testimonials'), method: 'POST', url: '/api/portal/testimonials', ...post(body), as: 'named' },
    ]).byId.p;
    const f = runChild('b3x-cf', [
      { op: 'seed', files: portalFixtures() }, ...signInSteps(),
      { op: 'cf', id: 'p', bundle: bundlePath('cf-testimonials'), method: 'POST', url: '/api/portal/testimonials', ...post(body), as: 'named' },
    ], {}, cfEnv).byId.p;
    assertEqual(v.status, 200, 'vercel status');
    assertEqual(f.status, 200, 'cf status');
    return '200 both (900-char quote, body under cap)';
  });

  // =========================================================================
  group('B4 — POST /api/contact refuses case-variant type=review with 410');

  await t('C1x', "'Review' / ' review' / 'REVIEW' -> 410 review-moved on BOTH trees, nothing accepted", async () => {
    const cfEnv = { SITE_BASE_URL: BASE, APP_ENV: 'development' };
    const variants = ['Review', ' review', 'REVIEW'];
    const details = [];
    for (const type of variants) {
      const contactBody = { type, name: 'Mallory', email: 'mallory@evil.test', project: 'x', budget: '1k-5k', timeline: 'asap' };
      const v = runChild(`c1x-v-${type.trim()}`, [
        { op: 'seed', files: portalFixtures() },
        { op: 'vercel', id: 'p', bundle: bundlePath('vercel-contact'), method: 'POST', url: '/api/contact', headers: { 'content-type': 'application/json' }, body: JSON.stringify(contactBody) },
        { op: 'logs', id: 'l' },
      ]).byId.p;
      assertEqual(v.status, 410, `vercel ${JSON.stringify(type)} status`);
      assertEqual(v.body && v.body.code, 'review-moved', 'code');
      assertEqual(v.body && v.body.where, '/api/portal/testimonials', 'where');

      const f = runChild(`c1x-cf-${type.trim()}`, [
        { op: 'seed', files: portalFixtures() },
        { op: 'cf', id: 'p', bundle: bundlePath('cf-contact'), method: 'POST', url: '/api/contact', headers: { 'content-type': 'application/json' }, body: JSON.stringify(contactBody) },
      ], {}, cfEnv).byId.p;
      assertEqual(f.status, 410, `cf ${JSON.stringify(type)} status`);
      assertEqual(f.body && f.body.code, 'review-moved', 'cf code');
      details.push(`${JSON.stringify(type)}->410`);
    }
    // the refusal happens before anything is accepted or stored
    const logs = runChild('c1x-logs', [
      { op: 'vercel', id: 'p', bundle: bundlePath('vercel-contact'), method: 'POST', url: '/api/contact', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'Review', name: 'M', email: 'm@e.test', project: 'x', budget: '1k-5k', timeline: 'asap' }) },
      { op: 'logs', id: 'l' },
    ]).logs;
    assert(logs.some((l) => l.outcome === 'review_refused'), 'a review_refused log line must exist');
    assert(!logs.some((l) => l.outcome === 'accepted'), 'nothing may be logged as accepted');
    return details.join(', ') + ' (+review_refused log)';
  });

  await t('C2x', 'a form-encoded Review is refused too, and a normal contact still passes', async () => {
    const cfEnv = { SITE_BASE_URL: BASE, APP_ENV: 'development' };
    const form = 'type=Review&name=Mallory&email=mallory%40evil.test&project=x&budget=1k-5k&timeline=asap';
    const v = runChild('c2x-v', [
      { op: 'vercel', id: 'p', bundle: bundlePath('vercel-contact'), method: 'POST', url: '/api/contact', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form },
    ]).byId.p;
    const f = runChild('c2x-cf', [
      { op: 'cf', id: 'p', bundle: bundlePath('cf-contact'), method: 'POST', url: '/api/contact', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form },
    ], {}, cfEnv).byId.p;
    assertEqual(v.status, 410, 'vercel form status');
    assertEqual(f.status, 410, 'cf form status');

    const good = { type: 'contact', name: 'Inquirer', email: 'inq@client.test', project: 'A new site', budget: '1k-5k', timeline: 'asap', ts: Date.now() - 5000 };
    const v2 = runChild('c2x-v2', [
      { op: 'vercel', id: 'p', bundle: bundlePath('vercel-contact'), method: 'POST', url: '/api/contact', headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.9.0.1' }, body: JSON.stringify(good) },
    ]).byId.p;
    const f2 = runChild('c2x-cf2', [
      { op: 'cf', id: 'p', bundle: bundlePath('cf-contact'), method: 'POST', url: '/api/contact', headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.9.0.2' }, body: JSON.stringify(good) },
    ], {}, cfEnv).byId.p;
    assertEqual(v2.status, 200, 'vercel contact status');
    assertEqual(f2.status, 200, 'cf contact status');
    assert(v2.body && v2.body.ok, 'vercel ok');
    assert(f2.body && f2.body.ok, 'cf ok');
    return '410 form-encoded both; 200 normal contact both';
  });

  // =========================================================================
  group('B7 — a failed write on Cloudflare is 500, never ok:true');

  await t('W1x', 'read-only moderation store -> 500 {code:storage} and nothing persisted', async () => {
    const cfEnv = { SITE_BASE_URL: BASE, PORTAL_SESSION_SECRET: SECRET, APP_ENV: 'development' };
    const c = runChild('w1x', [
      // The store file must EXIST before it can be made read-only, and it must
      // hold one valid line so the strict reader accepts it.
      { op: 'seed', files: { ...portalFixtures(), 'site/data/moderation/reviews.jsonl': [{ ref: 'rev_seed', type: 'review', state: 'pending', source: 'portal', verifiedClient: true, clientId: 'cli_seed', projectId: 'prj_seed', name: '', company: '', role: '', rating: '', review: 'seed line', consent: { p1: true, p2: false, p3: false, displayName: '' }, revision: 1, receivedAt: NOW, updatedAt: NOW }] } },
      ...signInSteps(),
      { op: 'chmod', file: 'site/data/moderation/reviews.jsonl', mode: 0o444 },
      { op: 'cf', id: 'p', bundle: bundlePath('cf-testimonials'), method: 'POST', url: '/api/portal/testimonials', ...post({ action: 'submit', projectId: 'prj_named', review: 'Must not silently vanish.', consent: { p1: true } }), as: 'named' },
      { op: 'store', id: 's', file: 'site/data/moderation/reviews.jsonl' },
      { op: 'logs', id: 'l' },
    ], {}, cfEnv);
    const r = c.byId.p;
    assertEqual(r.status, 500, `status (got ${r.status} ${r.raw})`);
    assertEqual(r.body && r.body.code, 'storage', 'code');
    assert(!r.body || r.body.ok !== true, 'never ok:true for an unpersisted record');
    assert(!c.byId.s.some((x) => x.review === 'Must not silently vanish.'), 'the quote must not be persisted');
    assert(c.logs.some((l) => l.outcome === 'storage_write_failed'), 'storage_write_failed must be logged');
    // restore the read-only flag so the sandbox can be deleted
    try { fs.chmodSync(path.join(c.sandbox, 'site/data/moderation/reviews.jsonl'), 0o666); } catch {}
    return `500 ${JSON.stringify(r.body)}, store empty`;
  });

  // =========================================================================
  group('B2 — the Cloudflare moderation 409 re-mails a WORKING fresh link');

  const MOD_SECRET = WEBHOOK_SECRET;

  function modFixtures(state) {
    return {
      'site/data/moderation/reviews.jsonl': [
        {
          ref: 'rev_stale', type: 'review', state, source: 'portal', verifiedClient: true,
          clientId: 'cli_named', projectId: 'prj_named', name: 'Alice Named', company: 'Acme Ltd',
          rating: '4', review: 'The current revision of the quote.',
          consent: { p1: true, p2: true, p3: false, displayName: '' },
          revision: 2, receivedAt: NOW, updatedAt: NOW,
        },
      ],
      'site/data/portal/clients.jsonl': portalFixtures()['site/data/portal/clients.jsonl'],
    };
  }

  function signLink(ref, decision, revision, ts) {
    return crypto.createHmac('sha256', MOD_SECRET).update(`${ref}|${decision}|${revision}|${ts}`).digest('hex');
  }

  await t('M1x', 'CF: a stale link -> 409 AND a fresh e-mail whose approve link verifies for revision 2', async () => {
    const ts = Math.floor(Date.now() / 1000);
    const sig = signLink('rev_stale', 'approve', 1, ts);
    const cfEnv = { SITE_BASE_URL: BASE, APP_ENV: 'development', FORM_WEBHOOK_SECRET: MOD_SECRET, RESEND_API_KEY: 'test-key', RESEND_TO: 'owner@imk.test' };
    const c = runChild('m1x', [
      { op: 'seed', files: modFixtures('pending') },
      { op: 'cf', id: 'p', bundle: bundlePath('cf-moderate'), method: 'GET', url: `/api/moderate/review?ref=rev_stale&decision=approve&revision=1&sig=${sig}&ts=${ts}` },
      { op: 'fetches', id: 'f' },
      { op: 'store', id: 's', file: 'site/data/moderation/reviews.jsonl' },
    ], {}, cfEnv);
    const r = c.byId.p;
    assertEqual(r.status, 409, 'status');
    assertEqual(r.body && r.body.code, 'stale-revision', 'code');
    assertEqual(r.body && r.body.revision, 2, 'the current revision is named');

    const mail = c.byId.f.find((x) => x.url.includes('api.resend.com'));
    assert(mail, 'the owner must be re-mailed');
    const mailBody = JSON.parse(mail.body);
    assert(String(mailBody.subject).startsWith('Updated IMK review'), `subject: ${mailBody.subject}`);
    // The mail HTML escapes & as &amp; — unescape before parsing the URL.
    const url = ((String(mailBody.html).match(/href="([^"]*\/api\/moderate\/review[^"]*)"/) || [])[1] || '').replace(/&amp;/g, '&');
    assert(url, 'the mail must carry a fresh one-click link');
    const u = new URL(url);
    assertEqual(u.searchParams.get('revision'), '2', 'the fresh link names the current revision');
    const freshTs = Number(u.searchParams.get('ts'));
    const expected = crypto.createHmac('sha256', MOD_SECRET).update(`rev_stale|approve|2|${freshTs}`).digest('hex');
    assertEqual(u.searchParams.get('sig'), expected, 'the fresh link signature must VERIFY (a working link)');
    assertEqual(c.byId.s[0].state, 'pending', 'the 409 approves nothing');
    return `409 + fresh revision-2 link, signature verified`;
  });

  await t('M2x', 'CF: a stale link for a SNOOZED quote mails NOTHING', async () => {
    const ts = Math.floor(Date.now() / 1000);
    const sig = signLink('rev_stale', 'approve', 1, ts);
    const cfEnv = { SITE_BASE_URL: BASE, APP_ENV: 'development', FORM_WEBHOOK_SECRET: MOD_SECRET, RESEND_API_KEY: 'test-key', RESEND_TO: 'owner@imk.test' };
    const c = runChild('m2x', [
      { op: 'seed', files: modFixtures('snoozed') },
      { op: 'cf', id: 'p', bundle: bundlePath('cf-moderate'), method: 'GET', url: `/api/moderate/review?ref=rev_stale&decision=approve&revision=1&sig=${sig}&ts=${ts}` },
      { op: 'fetches', id: 'f' },
    ], {}, cfEnv);
    assertEqual(c.byId.p.status, 409, 'status');
    assertEqual(c.byId.f.filter((x) => x.url.includes('api.resend.com')).length, 0, 'no mail for a snoozed quote');
    return '409, no mail';
  });

  await t('M3x', 'the stale re-notify still works, a CURRENT link approves, and a GET decides NOTHING', async () => {
    // RE-PINNED (wave 13): this check pinned the PRE-wave-8 contract, where a
    // GET on the moderation link was the approval. Wave 8 changed that (audit
    // M-1): a GET serves the CONFIRMATION PAGE and decides nothing — a
    // prefetched link must never approve a quote. The check now pins the
    // CURRENT contract and is STRONGER: it asserts that the GET really
    // decides nothing before the POST does the deciding.
    const ts = Math.floor(Date.now() / 1000);
    const staleSig = signLink('rev_stale', 'approve', 1, ts);
    const env = { RESEND_API_KEY: 'test-key', RESEND_TO: 'owner@imk.test' };

    // A GET on a CURRENT link: the confirmation page, and NOTHING decided.
    const goodSig0 = signLink('rev_stale', 'approve', 2, ts);
    const cGet = runChild('m3x-get', [
      { op: 'seed', files: modFixtures('pending') },
      { op: 'vercel', id: 'get', bundle: bundlePath('vercel-moderate'), method: 'GET', url: `/api/moderate/review?ref=rev_stale&decision=approve&revision=2&sig=${goodSig0}&ts=${ts}` },
      { op: 'store', id: 's', file: 'site/data/moderation/reviews.jsonl' },
      { op: 'fetches', id: 'f0' },
    ], env);
    assertEqual(cGet.byId.get.status, 200, 'the confirmation page status');
    assert(
      /text\/html/i.test(
        Object.entries(cGet.byId.get.headers || {})
          .map(([k, v]) => k + ': ' + v)
          .join('\n'),
      ),
      `the confirmation page must be HTML (got ${JSON.stringify(cGet.byId.get.headers)})`,
    );
    assert(!cGet.byId.get.body || cGet.byId.get.body.state !== 'approved', 'a GET must not approve');
    assertEqual(cGet.byId.s[0].state, 'pending', 'a GET must not change the store');
    assertEqual(cGet.byId.f0.filter((x) => x.url.includes('api.resend.com')).length, 0, 'a GET must not mail');

    // A GET on a STALE link is REFUSED (409) — the stale check runs before the
    // confirmation page — and it still decides nothing.
    const cGetStale = runChild('m3x-get-stale', [
      { op: 'seed', files: modFixtures('pending') },
      { op: 'vercel', id: 'get', bundle: bundlePath('vercel-moderate'), method: 'GET', url: `/api/moderate/review?ref=rev_stale&decision=approve&revision=1&sig=${staleSig}&ts=${ts}` },
      { op: 'store', id: 's', file: 'site/data/moderation/reviews.jsonl' },
    ], env);
    assertEqual(cGetStale.byId.get.status, 409, 'a stale GET is refused');
    assertEqual(cGetStale.byId.s[0].state, 'pending', 'a stale GET must not change the store');

    // A POST on a STALE link: 409 and a fresh link in a fresh mail.
    const c = runChild('m3x', [
      { op: 'seed', files: modFixtures('pending') },
      { op: 'vercel', id: 'stale', bundle: bundlePath('vercel-moderate'), method: 'POST', url: `/api/moderate/review?ref=rev_stale&decision=approve&revision=1&sig=${staleSig}&ts=${ts}` },
      { op: 'fetches', id: 'f1' },
    ], env);
    assertEqual(c.byId.stale.status, 409, 'stale status');
    const mail1 = c.byId.f1.find((x) => x.url.includes('api.resend.com'));
    assert(mail1, 'the Vercel tree must re-mail too');
    assert(String(JSON.parse(mail1.body).subject).startsWith('Updated IMK review'), 'updated wording');

    const goodSig = signLink('rev_stale', 'approve', 2, ts);
    const c2 = runChild('m3x-2', [
      { op: 'seed', files: modFixtures('pending') },
      { op: 'vercel', id: 'ok', bundle: bundlePath('vercel-moderate'), method: 'POST', url: `/api/moderate/review?ref=rev_stale&decision=approve&revision=2&sig=${goodSig}&ts=${ts}` },
      { op: 'store', id: 's', file: 'site/data/moderation/reviews.jsonl' },
    ], env);
    assertEqual(c2.byId.ok.status, 200, 'current-link status');
    assertEqual(c2.byId.ok.body && c2.byId.ok.body.state, 'approved', 'state');
    assertEqual(c2.byId.s[0].state, 'approved', 'stored state');

    // and the Cloudflare tree accepts the CURRENT link as well
    const cfEnv = { SITE_BASE_URL: BASE, APP_ENV: 'development', FORM_WEBHOOK_SECRET: MOD_SECRET, RESEND_API_KEY: 'test-key', RESEND_TO: 'owner@imk.test' };
    const c3 = runChild('m3x-3', [
      { op: 'seed', files: modFixtures('pending') },
      { op: 'cf', id: 'ok', bundle: bundlePath('cf-moderate'), method: 'POST', url: `/api/moderate/review?ref=rev_stale&decision=approve&revision=2&sig=${goodSig}&ts=${ts}` },
      { op: 'store', id: 's', file: 'site/data/moderation/reviews.jsonl' },
    ], {}, cfEnv);
    assertEqual(c3.byId.ok.status, 200, 'cf current-link status');
    assertEqual(c3.byId.s[0].state, 'approved', 'cf stored state');
    return 'a GET decides nothing; a stale POST re-mails 409; a current POST approves on both trees';
  });

  // =========================================================================
  group('B8 — contact parity: webhook signature, CONTACT_TO fallback, linkedin');

  function hookAssert(label, captured, refPrefix) {
    const hook = captured.find((x) => x.url === 'https://hooks.test/ixi');
    assert(hook, `${label}: the webhook must be called`);
    const sigHeader = String(hook.headers['X-Signature'] || hook.headers['x-signature'] || '');
    assert(sigHeader.startsWith('sha256='), `${label}: signed webhook (${sigHeader})`);
    const expected = crypto.createHmac('sha256', WEBHOOK_SECRET).update(String(hook.body)).digest('hex');
    assertEqual(sigHeader, `sha256=${expected}`, `${label}: the signature must verify against the payload`);
    const payload = JSON.parse(hook.body);
    for (const key of ['ref', 'name', 'email', 'company', 'project', 'budget', 'timeline', 'submittedAt', 'ipHash']) {
      assert(key in payload, `${label}: webhook payload must carry ${key}`);
    }
    assert(String(payload.ref).startsWith(refPrefix), `${label}: ref shape`);
    assert(typeof payload.submittedAt === 'string', `${label}: submittedAt`);
    return payload;
  }

  await t('P1', 'Vercel contact delivers a SIGNED webhook whose HMAC verifies (ported hardening)', async () => {
    const good = { type: 'contact', name: 'Inquirer', email: 'inq@client.test', company: 'Inq Co', project: 'A new site', budget: '5k-15k', timeline: '1-month', ts: Date.now() - 5000 };
    const c = runChild('p1', [
      { op: 'vercel', id: 'p', bundle: bundlePath('vercel-contact'), method: 'POST', url: '/api/contact', headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.11.0.1' }, body: JSON.stringify(good) },
      { op: 'fetches', id: 'f' },
    ], { FORM_WEBHOOK_URL: 'https://hooks.test/ixi', FORM_WEBHOOK_SECRET: WEBHOOK_SECRET });
    assertEqual(c.byId.p.status, 200, 'status');
    const payload = hookAssert('vercel', c.byId.f, 'inq_');
    assertEqual(payload.budget, '5k-15k', 'budget travels');
    assertEqual(payload.timeline, '1-month', 'timeline travels');
    return `signed webhook verified (${payload.ref})`;
  });

  await t('P2', 'Cloudflare contact: same signed webhook, same payload keys (byte-level HMAC parity)', async () => {
    const cfEnv = { SITE_BASE_URL: BASE, APP_ENV: 'development', FORM_WEBHOOK_URL: 'https://hooks.test/ixi', FORM_WEBHOOK_SECRET: WEBHOOK_SECRET };
    const good = { type: 'contact', name: 'Inquirer', email: 'inq@client.test', company: 'Inq Co', project: 'A new site', budget: '5k-15k', timeline: '1-month', ts: Date.now() - 5000 };
    const c = runChild('p2', [
      { op: 'cf', id: 'p', bundle: bundlePath('cf-contact'), method: 'POST', url: '/api/contact', headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.11.0.2' }, body: JSON.stringify(good) },
      { op: 'fetches', id: 'f' },
    ], {}, cfEnv);
    assertEqual(c.byId.p.status, 200, 'status');
    hookAssert('cf', c.byId.f, 'inq_');
    return 'signed webhook verified';
  });

  await t('P3', 'CONTACT_TO is a fallback destination on BOTH trees', async () => {
    const good = { type: 'contact', name: 'Inquirer', email: 'inq@client.test', project: 'A new site', budget: '1k-5k', timeline: 'asap', ts: Date.now() - 5000 };
    const runV = runChild('p3-v', [
      { op: 'vercel', id: 'p', bundle: bundlePath('vercel-contact'), method: 'POST', url: '/api/contact', headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.11.0.3' }, body: JSON.stringify(good) },
      { op: 'fetches', id: 'f' },
    ], { CONTACT_TO: 'owner@alt.test', RESEND_API_KEY: 'test-key' });
    assertEqual(runV.byId.p.status, 200, 'vercel status');
    const mailV = runV.byId.f.find((x) => x.url.includes('api.resend.com'));
    assert(mailV, 'vercel must send');
    assertEqual(JSON.parse(mailV.body).to[0], 'owner@alt.test', 'vercel CONTACT_TO fallback');

    const cfEnv = { SITE_BASE_URL: BASE, APP_ENV: 'development', CONTACT_TO: 'owner@alt.test', RESEND_API_KEY: 'test-key' };
    const runF = runChild('p3-cf', [
      { op: 'cf', id: 'p', bundle: bundlePath('cf-contact'), method: 'POST', url: '/api/contact', headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.11.0.4' }, body: JSON.stringify(good) },
      { op: 'fetches', id: 'f' },
    ], {}, cfEnv);
    assertEqual(runF.byId.p.status, 200, 'cf status');
    const mailF = runF.byId.f.find((x) => x.url.includes('api.resend.com'));
    assert(mailF, 'cf must send');
    assertEqual(JSON.parse(mailF.body).to[0], 'owner@alt.test', 'cf CONTACT_TO fallback');
    return 'CONTACT_TO honoured on both trees';
  });

  await t('P4', 'a form-encoded linkedin field parses on both trees (303, no crash)', async () => {
    const form = 'name=Inquirer&email=inq%40client.test&project=A+new+site&budget=1k-5k&timeline=asap&linkedin=linkedin.com%2Fin%2Finq&ts=' + (Date.now() - 5000);
    const v = runChild('p4-v', [
      { op: 'vercel', id: 'p', bundle: bundlePath('vercel-contact'), method: 'POST', url: '/api/contact', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': '10.11.0.5' }, body: form },
    ]).byId.p;
    assertEqual(v.status, 303, 'vercel status');
    const cfEnv = { SITE_BASE_URL: BASE, APP_ENV: 'development' };
    const f = runChild('p4-cf', [
      { op: 'cf', id: 'p', bundle: bundlePath('cf-contact'), method: 'POST', url: '/api/contact', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': '10.11.0.6' }, body: form },
    ], {}, cfEnv).byId.p;
    assertEqual(f.status, 303, 'cf status');
    return '303 both';
  });

  // =========================================================================
  const passed = results.filter((r) => r.status === 'PASS').length;
  const failed = results.length - passed;
  origLog(`\n[review-fix] ${passed} passed, ${failed} failed, ${results.length} checks`);
  if (failed) {
    origLog('[review-fix] failing checks: ' + results.filter((r) => r.status === 'FAIL').map((r) => r.id).join(', '));
  }
  fs.writeFileSync(path.join(ROOT, 'results.json'), JSON.stringify(results, null, 2), 'utf8');
  origLog(`[review-fix] results: ${path.join(ROOT, 'results.json')}`);
  if (KEEP) {
    origLog(`[review-fix] sandbox kept: ${ROOT}`);
  } else {
    try {
      // undo read-only flags so the tree can be removed
      const casesDir = path.join(ROOT, 'cases');
      const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else { try { fs.chmodSync(full, 0o666); } catch {} }
        }
      };
      if (fs.existsSync(casesDir)) walk(casesDir);
      fs.rmSync(ROOT, { recursive: true, force: true });
      origLog('[review-fix] sandbox removed');
    } catch (err) {
      origLog(`[review-fix] sandbox cleanup failed: ${err}`);
    }
  }
  process.exitCode = failed ? 1 : 0;
}

main().catch((err) => {
  origLog(`[review-fix] harness error: ${err && err.stack ? err.stack : err}`);
  process.exitCode = 1;
});
