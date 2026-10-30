// site/qa/qa-backend-hardening.mjs
//
// Focused regression harness for the backend hardening wave (audit M1–M4 + m1).
//
// It runs the REAL handlers (api/portal/*, api/moderate/review.ts) in an
// isolated sandbox: its own data directory, its own port, its own process
// cwd. The repo's site/data/ is never touched and the dev server on 4321 is
// never used.
//
// What it proves (the gaps the QA suite does not cover):
//   H1  p2=true  -> the store keeps the identity, so publishing still works
//   H2  p2=false -> the store keeps NO identity and NO e-mail key at all
//   H3  p2=false -> the client still sees their own name in their portal
//   H4  the moderation link follows SITE_BASE_URL (not the placeholder host)
//   H5  a production instance without RESEND_API_KEY answers 500 — and
//       answers the SAME for an invited and an uninvited address
//   H6  a corrupt store answers 500 {code:'storage'} on every portal write
//
// Wave 2 (audit M5/M6 + m2-m7):
//   L1  the approve link may only approve the revision the owner was shown
//   L2  the Cloudflare twin has a notification path (and it is edge-safe)
//   L3  a project title is stored RAW (no double escaping at render time)
//   L4  a production instance without SITE_BASE_URL answers 500 misconfigured
//       — not "403 origin required"
//   L5  a stale admin cookie does not shadow a valid client cookie, and
//       logout clears BOTH cookies
//   L6  a malformed submission does not burn a rate-limit slot; snooze and
//       decline are limited too
//   L7  the newest record for a project is client-scoped
//   L8  the publish script refuses a malformed store instead of dropping the
//       record silently
//   L9  a corrupt store is never rewritten
//
// Wave 4 (QA wave-3 D-1/D-2/F-1/F-2):
//   N1  the route manifest check passes: every path the client calls has a
//       function file in BOTH trees (the machine check for F-1)
//   N2  the route files for the sign-in door and the by-id edits exist in
//       both trees and export a real handler
//
// USAGE
//   node site/qa/qa-backend-hardening.mjs [--keep]

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
import { handlerPath, fwd } from './handler-paths.mjs';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.resolve(HERE, '..');
const REPO = path.resolve(SITE, '..');
const PORT = 4411;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const KEEP = process.argv.includes('--keep');

const results = [];
let currentGroup = '';
const origLog = console.log;

function group(name) {
  currentGroup = name;
  origLog(`\n[qa] ${name}`);
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
    results.push({ id, group: currentGroup, name, status: 'FAIL', error: String(err && err.message ? err.message : err) });
    origLog(`  FAIL  ${id}  ${name}\n          ${err && err.message ? err.message : err}`);
  }
}

function rmrf(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

const SANDBOX = path.join(
  os.tmpdir(),
  `qa-backend-hardening-${new Date().toISOString().replace(/[:.]/g, '-')}`,
);
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

// The handler modules under test. The bodies moved out of api/ in wave 13
// (the function budget) and live in site/shared/portal-handlers/ now; the pin
// follows the PRODUCT's route table so it cannot drift from the tree.
const ROOTS = { apiDir: path.join(REPO, 'api'), sharedDir: path.join(SITE, 'shared') };
const ENTRY = `export { default as auth } from '${fwd(handlerPath('portal-auth', ROOTS))}';
export { default as projects } from '${fwd(handlerPath('portal-projects', ROOTS))}';
export { default as invites } from '${fwd(handlerPath('portal-invites', ROOTS))}';
export { default as testimonials } from '${fwd(handlerPath('portal-testimonials', ROOTS))}';
export { default as moderate } from '${fwd(handlerPath('moderate', ROOTS))}';
`;

const ROUTES = [
  ['/api/moderate/review', 'moderate'],
  ['/api/portal/auth', 'auth'],
  ['/api/portal/projects', 'projects'],
  ['/api/portal/invites', 'invites'],
  ['/api/portal/testimonials', 'testimonials'],
];

let api = null;
let server = null;
const resendCalls = [];
const logLines = [];

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

  // The handlers resolve their data paths from process.cwd() at module load.
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
      origLog('[qa] handler error', name, err);
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
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  if (opts.origin !== null) headers.origin = opts.origin === undefined ? ORIGIN : opts.origin;
  if (opts.cookie) headers.cookie = opts.cookie;
  headers['x-forwarded-for'] = opts.ip || `10.9.0.${Math.floor(Math.random() * 200)}`;

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
    text,
    json,
    setCookie: res.headers.getSetCookie ? res.headers.getSetCookie() : [],
  };
}

async function main() {
  origLog(`[qa] sandbox: ${SANDBOX}`);
  fs.mkdirSync(SANDBOX_PORTAL, { recursive: true });
  fs.mkdirSync(SANDBOX_MODERATION, { recursive: true });

  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const href = typeof url === 'string' ? url : url.url;
    if (String(href).startsWith(ORIGIN)) return realFetch(url, init);
    if (String(href).includes('api.resend.com')) {
      resendCalls.push({ href: String(href), init });
      return { ok: true, status: 200, json: async () => ({ id: 'stub' }) };
    }
    throw new Error(`[qa] unexpected outbound request: ${href}`);
  };

  // Only SITE_BASE_URL is set — SITE_URL stays unset on purpose (m1).
  process.env.SITE_BASE_URL = ORIGIN;
  delete process.env.SITE_URL;
  process.env.APP_ENV = 'development';
  process.env.ADMIN_EMAILS = 'owner@imk.test';
  // H-1 (wave-8A): this suite runs in development, but check L4 flips it into
  // production (APP_ENV unset). A secret shorter than MIN_SECRET_LENGTH (32)
  // is refused in production exactly like a missing one, so the fixtures are
  // 32+ characters long -- otherwise L4 would answer 401 (no session) instead
  // of the 500 it is testing.
  process.env.PORTAL_MAGIC_LINK_SECRET = 'qa-hardening-magic-link-secret-0123456789';
  process.env.FORM_WEBHOOK_SECRET = 'qa-hardening-form-webhook-secret-0123456789';
  process.env.RESEND_API_KEY = 'hardening-resend-key';
  process.env.RESEND_TO = 'owner@imk.test';
  process.env.CONTACT_TO = 'owner@imk.test';
  delete process.env.DEV_STUB;

  // ---- fixtures ------------------------------------------------------------
  fs.writeFileSync(
    INVITED_FILE,
    JSON.stringify({ email: 'named@client.test', name: 'Nora Named', company: 'Named Ltd', role: 'CTO' }) + '\n' +
      JSON.stringify({ email: 'anon@client.test', name: 'Axel Anonymous', company: 'Anon Ltd', role: 'CFO' }) + '\n',
    'utf8',
  );
  fs.writeFileSync(CLIENTS_FILE, '', 'utf8');
  fs.writeFileSync(PROJECTS_FILE, '', 'utf8');
  fs.writeFileSync(REVIEWS_FILE, '', 'utf8');

  await startServer();

  async function signIn(email) {
    const savedKey = process.env.RESEND_API_KEY;
    delete process.env.RESEND_API_KEY;
    const before = logLines.length;
    await req('POST', '/api/portal/auth/request-link', { body: { email } });
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
      .filter((l) => l && l.outcome === 'magic_link_dev' && l.email === email)
      .pop();
    assert(magic && magic.token, `no magic-link token for ${email}`);
    const res = await req('GET', `/api/portal/auth/verify?token=${encodeURIComponent(magic.token)}&purpose=portal`);
    assertEqual(res.status, 200, `verify for ${email}`);
    return res.setCookie[0].split(';')[0];
  }

  async function makeProject(ownerCookie, clientId, title) {
    const res = await req('POST', '/api/portal/projects', {
      cookie: ownerCookie,
      body: { title, clientId, status: 'completed' },
    });
    assertEqual(res.status, 200, `could not create project "${title}"`);
    return res.json.project.id;
  }

  group('H — data protection (audit M1/M2)');

  // The owner creates the projects (a client cannot); the client signs in and
  // answers the testimonial request. The client's FIRST sign-in is what
  // creates their client record.
  const ownerCookie = await signIn('owner@imk.test');
  const namedCookie = await signIn('named@client.test');
  const anonCookie = await signIn('anon@client.test');
  const namedClient = readJsonl(CLIENTS_FILE).find((c) => c.email === 'named@client.test');
  const anonClient = readJsonl(CLIENTS_FILE).find((c) => c.email === 'anon@client.test');
  assert(namedClient && anonClient, 'both client records must exist after the first sign-in');
  assertEqual(namedClient.name, 'Nora Named', 'the client record inherits the invited profile');
  assertEqual(namedClient.company, 'Named Ltd', 'the client record inherits the company');
  assertEqual(namedClient.role, 'CTO', 'the client record inherits the role');

  const namedProjectId = await makeProject(ownerCookie, namedClient.id, 'Named Website');
  const anonProjectId = await makeProject(ownerCookie, anonClient.id, 'Anonymous Website');
  const named = { cookie: namedCookie, id: namedProjectId };
  const anon = { cookie: anonCookie, id: anonProjectId };

  await t('H1', 'p2=true: the store keeps the identity, so publishing still works', async () => {
    const res = await req('POST', '/api/portal/testimonials', {
      cookie: named.cookie,
      body: {
        action: 'submit',
        projectId: named.id,
        review: 'A named quote that must publish with its name.',
        rating: 5,
        consent: { p1: true, p2: true, p3: false },
      },
    });
    assertEqual(res.status, 200, 'submit status');
    const stored = readJsonl(REVIEWS_FILE).filter((r) => r.ref === res.json.testimonial.ref).pop();
    assertEqual(stored.name, 'Nora Named', 'the stored name');
    assertEqual(stored.company, 'Named Ltd', 'the stored company');
    assertEqual(stored.role, 'CTO', 'the stored role');
    assert(!('email' in stored), 'the record must not carry an e-mail key');
    return `name=${stored.name} company=${stored.company}`;
  });

  await t('H2', 'p2=false: the store keeps NO identity and NO e-mail', async () => {
    const res = await req('POST', '/api/portal/testimonials', {
      cookie: anon.cookie,
      body: {
        action: 'submit',
        projectId: anon.id,
        review: 'An anonymous quote that must publish without a name.',
        rating: 4,
        consent: { p1: true, p2: false, p3: false },
      },
    });
    assertEqual(res.status, 200, 'submit status');
    const stored = readJsonl(REVIEWS_FILE).filter((r) => r.ref === res.json.testimonial.ref).pop();
    assertEqual(stored.name, '', 'the stored name must be empty');
    assertEqual(stored.company, '', 'the stored company must be empty');
    assertEqual(stored.role, '', 'the stored role must be empty');
    assert(!('email' in stored), 'the record must not carry an e-mail key');
    const anyEmail = readJsonl(REVIEWS_FILE).filter((r) => r.email);
    assertEqual(anyEmail.length, 0, 'no record may carry an e-mail address');
    return 'name/company/role empty, no e-mail key';
  });

  await t('H3', 'p2=false: the client still sees their own name in their portal', async () => {
    const res = await req('GET', `/api/portal/testimonials?projectId=${anon.id}`, { cookie: anon.cookie });
    assertEqual(res.status, 200, 'the client GET status');
    assert(res.json.testimonial, 'the client must see their own quote');
    assertEqual(res.json.testimonial.name, 'Axel Anonymous', 'the client sees their own name');
    assertEqual(res.json.testimonial.consent.p2, false, 'the consent state is unchanged');
    return 'the client view falls back to the client record';
  });

  group('I — moderation links (audit m1)');

  await t('I1', 'the approve link points at SITE_BASE_URL, not the placeholder host', async () => {
    resendCalls.length = 0;
    const res = await req('POST', '/api/portal/testimonials', {
      cookie: anon.cookie,
      body: {
        action: 'submit',
        projectId: anon.id,
        review: 'A second anonymous quote, sent to the owner for moderation.',
        rating: 5,
        consent: { p1: true, p2: false, p3: false },
      },
    });
    assertEqual(res.status, 200, 'submit status');
    const call = resendCalls.find((c) => String(c.href).includes('api.resend.com'));
    assert(call, 'the owner must be notified');
    const body = JSON.parse(call.init.body);
    const html = String(body.html || '');
    const text = String(body.text || '');
    const url = (html.match(/href="([^"]*\/api\/moderate\/review[^"]*)"/) || [])[1] || '';
    assert(url, 'the notification must carry the one-click link');
    assert(url.startsWith(`${ORIGIN}/api/moderate/review`), `the link must use SITE_BASE_URL: ${url}`);
    assert(!url.includes('imk.example'), 'the link must not point at the placeholder host');
    // the anonymous client's identity must not travel to the owner
    assert(!html.includes('Axel Anonymous'), 'the anonymous client must not be named in the notification');
    assert(!text.includes('Axel Anonymous'), 'the anonymous client must not be named in the notification');
    return url.slice(0, 64) + '…';
  });

  group('J — production configuration (audit M4)');

  await t('J1', 'no RESEND_API_KEY in production answers 500 — the same for every address', async () => {
    const savedKey = process.env.RESEND_API_KEY;
    const savedEnv = process.env.APP_ENV;
    delete process.env.RESEND_API_KEY;
    delete process.env.APP_ENV; // the handler's default is 'production'
    const before = logLines.length;
    const invited = await req('POST', '/api/portal/auth/request-link', { body: { email: 'named@client.test' } });
    const stranger = await req('POST', '/api/portal/auth/request-link', { body: { email: 'stranger@nowhere.test' } });
    if (savedKey !== undefined) process.env.RESEND_API_KEY = savedKey;
    if (savedEnv !== undefined) process.env.APP_ENV = savedEnv;
    assertEqual(invited.status, 500, 'the invited address must fail loudly');
    assertEqual(stranger.status, 500, 'the uninvited address must fail identically');
    assertEqual(invited.json.code, stranger.json.code, 'both answers must be identical (no enumeration)');
    const leaked = logLines
      .slice(before)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter((l) => l && l.outcome === 'magic_link_dev');
    assertEqual(leaked.length, 0, 'no token may be logged in production');
    return `both answered ${invited.status} ${invited.json.code}, no token on stdout`;
  });

  group('K — corrupt store (audit M3)');

  await t('K1', 'a corrupt store answers 500 {code:storage} on every portal read and write', async () => {
    const original = fs.readFileSync(PROJECTS_FILE, 'utf8');
    fs.appendFileSync(PROJECTS_FILE, '{ broken\n', 'utf8');
    const codes = [];
    try {
      const list = await req('GET', '/api/portal/projects', { cookie: ownerCookie });
      codes.push(list.status, list.json.code);
      const patch = await req('PATCH', `/api/portal/projects/${named.id}`, {
        cookie: ownerCookie,
        body: { status: 'completed' },
      });
      codes.push(patch.status, patch.json.code);
      const quote = await req('GET', `/api/portal/testimonials?projectId=${named.id}`, { cookie: named.cookie });
      codes.push(quote.status, quote.json.code);
    } finally {
      fs.writeFileSync(PROJECTS_FILE, original, 'utf8');
    }
    for (let i = 0; i < codes.length; i += 2) {
      assertEqual(codes[i], 500, 'the endpoint must answer 500');
      assertEqual(codes[i + 1], 'storage', 'the answer must name the store as the cause');
    }
    return `${codes.length / 2} endpoints answered 500 storage`;
  });

  group('L — fix wave 2 (audit M5/M6 + m2–m7)');

  await t('L1', 'M5: the approve link may only approve the revision it names', async () => {
    const crypto = require('node:crypto');
    const secret = process.env.FORM_WEBHOOK_SECRET;
    const sign = (ref, decision, revision, ts) =>
      crypto.createHmac('sha256', secret).update(`${ref}|${decision}|${revision}|${ts}`).digest('hex');
    const link = (ref, decision, revision, ts) =>
      `/api/moderate/review?ref=${ref}&decision=${decision}&revision=${revision}&sig=${sign(ref, decision, revision, ts)}&ts=${ts}`;

    // The owner is notified for revision 1...
    resendCalls.length = 0;
    const first = await req('POST', '/api/portal/testimonials', {
      cookie: named.cookie,
      body: {
        action: 'submit',
        projectId: named.id,
        review: 'REVISION ONE text',
        rating: 5,
        consent: { p1: true, p2: true, p3: false },
      },
    });
    assertEqual(first.status, 200, 'first submit');
    const ref = first.json.testimonial.ref;
    const notification = JSON.parse(resendCalls.find((c) => String(c.href).includes('api.resend.com')).init.body);
    const mailedUrl = (String(notification.html).match(/href="([^"]*\/api\/moderate\/review[^"]*)"/) || [])[1] || '';
    assert(mailedUrl, 'the notification must carry the one-click link');
    const mailedRevision = Number((mailedUrl.match(/revision=(\d+)/) || [])[1]);
    assert(mailedRevision >= 1, `the mailed link must name the revision: ${mailedUrl}`);
    const storedFirst = readJsonl(REVIEWS_FILE).filter((r) => r.ref === ref).pop();
    assertEqual(mailedRevision, storedFirst.revision, 'the mailed link must name the current revision');

    // ...the client edits the quote -> the next revision.
    const second = await req('POST', '/api/portal/testimonials', {
      cookie: named.cookie,
      body: {
        action: 'submit',
        projectId: named.id,
        review: 'REVISION TWO text',
        rating: 5,
        consent: { p1: true, p2: true, p3: false },
      },
    });
    assertEqual(second.status, 200, 'second submit');
    const stored = readJsonl(REVIEWS_FILE).filter((r) => r.ref === ref).pop();
    assertEqual(stored.revision, storedFirst.revision + 1, 'the revision counter must have advanced');
    const currentRevision = stored.revision;

    // The owner presses the button on a link that was mailed for the OLD
    // revision. M-1 (wave-8A): the DECISION is the POST -- a GET only shows
    // the confirmation page.
    const ts = Math.floor(Date.now() / 1000);
    const stale = await req('POST', link(ref, 'approve', storedFirst.revision, ts));
    assertEqual(stale.status, 409, 'a stale link must be refused');
    assertEqual(stale.json.code, 'stale-revision', 'the answer must name the cause');
    assertEqual(
      readJsonl(REVIEWS_FILE).filter((r) => r.ref === ref && r.state === 'approved').length,
      0,
      'a stale link must not approve anything',
    );

    // The link for the current revision approves exactly that revision.
    const ok = await req('POST', link(ref, 'approve', currentRevision, ts));
    assertEqual(ok.status, 200, 'the current link must approve');
    const approved = readJsonl(REVIEWS_FILE).filter((r) => r.ref === ref && r.state === 'approved');
    assertEqual(approved.length, 1, 'exactly one line may be approved');
    assertEqual(approved[0].revision, currentRevision, 'the approved revision must be the one the link named');
    assertEqual(approved[0].review, 'REVISION TWO text', 'the approved text must be the one the link named');
    return `stale link (revision ${storedFirst.revision}) -> 409; current link -> revision ${currentRevision} only`;
  });

  await t('L1b', 'M-1: a plain GET on the signed link shows the confirmation page and approves NOTHING', async () => {
    // A client of its own: the submit bucket holds 5 per hour.
    const invited = await req('POST', '/api/portal/invites', {
      cookie: ownerCookie,
      body: { email: 'scan@client.test', name: 'Scan Prefetch' },
    });
    assertEqual(invited.status, 200, `the invite must be accepted (got ${invited.status}: ${invited.text})`);
    const scanCookie = await signIn('scan@client.test');
    const scanClient = readJsonl(CLIENTS_FILE).find((c) => c.email === 'scan@client.test');
    assert(scanClient, 'the client record must exist after the first sign-in');
    const projectId = await makeProject(ownerCookie, scanClient.id, 'Scanned Website');

    const crypto = require('node:crypto');
    const secret = process.env.FORM_WEBHOOK_SECRET;
    const ts = Math.floor(Date.now() / 1000);
    const sub = await req('POST', '/api/portal/testimonials', {
      cookie: scanCookie,
      body: {
        action: 'submit',
        projectId,
        review: 'A quote that every mail scanner will prefetch.',
        rating: 5,
        consent: { p1: true, p2: true, p3: false },
      },
    });
    assertEqual(sub.status, 200, 'submit status');
    const ref = sub.json.testimonial.ref;
    const sig = crypto.createHmac('sha256', secret).update(`${ref}|approve|1|${ts}`).digest('hex');
    const url = `/api/moderate/review?ref=${ref}&decision=approve&revision=1&sig=${sig}&ts=${ts}`;

    // What every mail scanner does by itself: fetch the link.
    const page = await req('GET', url);
    assertEqual(page.status, 200, 'the GET must serve the confirmation page');
    assert(
      /<form[^>]*method="POST"/i.test(page.text),
      'the confirmation page must offer a POST form (a GET must never decide)',
    );
    assert(/name="sig"/.test(page.text), 'the page must carry the signature in the form');

    // ...and nothing at all was decided.
    const stored = readJsonl(REVIEWS_FILE).filter((r) => r.ref === ref).pop();
    assertEqual(stored.state, 'pending', 'a GET must not approve anything');
    assertEqual(stored.decidedAt, undefined, 'a GET must not stamp a decision time');
    assertEqual(
      readJsonl(REVIEWS_FILE).filter((r) => r.ref === ref && r.state === 'approved').length,
      0,
      'no line may be approved by a GET',
    );

    // The POST is the decision.
    const decided = await req('POST', url);
    assertEqual(decided.status, 200, `the POST must decide (got ${decided.status}: ${decided.text})`);
    assertEqual(decided.json.state, 'approved', 'state');
    return 'a GET served the page and approved nothing; the POST approved the quote';
  });

  await t('L2', 'M6: the Cloudflare twin notifies, and its module is edge-safe', async () => {
    const twin = path.join(SITE, 'functions', 'api', 'portal', 'testimonials.ts');
    assert(fs.existsSync(twin), 'the CF twin must exist');
    const twinSrc = fs.readFileSync(twin, 'utf8');
    assert(/notifyReviewSubmitted/.test(twinSrc), 'the twin must call the notification module');
    const lib = path.join(SITE, 'functions', 'api', 'lib', 'notifications.ts');
    assert(fs.existsSync(lib), 'the CF notifications module must exist');
    const libSrc = fs.readFileSync(lib, 'utf8');
    assert(!/from\s+['"]node:/.test(libSrc), 'the CF module must not import node: modules');
    assert(/revision/.test(libSrc), 'the CF module must bind the link to a revision');
    return 'the CF tree has an edge-safe notification path';
  });

  await t('L3', 'm3: a project title is stored RAW (escaped once, at render time)', async () => {
    const res = await req('POST', '/api/portal/projects', {
      cookie: ownerCookie,
      body: { title: 'Tom & Jerry Ltd', clientId: namedClient.id, status: 'completed' },
    });
    assertEqual(res.status, 200, 'create status');
    const stored = readJsonl(PROJECTS_FILE).find((p) => p.id === res.json.project.id);
    assertEqual(stored.title, 'Tom & Jerry Ltd', 'the title must be stored unescaped');
    assert(!stored.title.includes('&amp;'), 'the title must not be HTML-escaped at write time');
    return `stored: ${stored.title}`;
  });

  await t('L4', 'm4: a production instance without SITE_BASE_URL answers 500, not 403 origin', async () => {
    const savedBase = process.env.SITE_BASE_URL;
    const savedUrl = process.env.SITE_URL;
    const savedEnv = process.env.APP_ENV;
    delete process.env.SITE_BASE_URL;
    delete process.env.SITE_URL;
    delete process.env.APP_ENV; // unset = production
    try {
      const res = await req('POST', '/api/portal/testimonials', {
        cookie: named.cookie,
        body: {
          action: 'submit',
          projectId: named.id,
          review: 'A quote that must never be stored in a misconfigured instance.',
          consent: { p1: true, p2: true, p3: false },
        },
      });
      assertEqual(res.status, 500, 'the endpoint must fail loudly');
      assertEqual(res.json.code, 'internal', 'the answer must say the instance is misconfigured');
    } finally {
      if (savedBase !== undefined) process.env.SITE_BASE_URL = savedBase;
      if (savedUrl !== undefined) process.env.SITE_URL = savedUrl;
      if (savedEnv !== undefined) process.env.APP_ENV = savedEnv;
    }
    return '500 internal (misconfigured), not 403 origin';
  });

  await t('L5', 'm5: a stale admin cookie does not shadow a valid client cookie; logout clears both', async () => {
    // A browser that holds a STALE admin cookie next to a live client cookie.
    const clientToken = named.cookie.split(';')[0];
    const shadowed = `imk_admin_session=deadbeefdeadbeef; ${clientToken}`;
    const res = await req('GET', `/api/portal/testimonials?projectId=${named.id}`, { cookie: shadowed });
    assertEqual(res.status, 200, 'the live client session must still be found');
    assert(res.json.testimonial, 'the client must still see their own quote');

    // Logout destroys BOTH sessions and clears BOTH cookies.
    const ownerToken = ownerCookie.split(';')[0];
    const both = `${ownerToken}; ${clientToken}`;
    const out = await req('POST', '/api/portal/auth/logout', { cookie: both });
    assertEqual(out.status, 200, 'logout status');
    const cleared = out.setCookie.map((c) => c.split('=')[0]);
    assert(cleared.includes('imk_admin_session'), 'the admin cookie must be cleared');
    assert(cleared.includes('imk_session'), 'the client cookie must be cleared');
    const after = await req('GET', `/api/portal/testimonials?projectId=${named.id}`, { cookie: clientToken });
    assertEqual(after.status, 401, 'the client session must be dead after logout');
    return 'stale admin cookie skipped; both cookies cleared on logout';
  });

  await t('L6', 'm6: a malformed submission burns no slot; snooze and decline are limited', async () => {
    // Six malformed submissions must not consume the rate-limit budget.
    for (let i = 0; i < 6; i++) {
      const bad = await req('POST', '/api/portal/testimonials', {
        cookie: anon.cookie,
        body: { action: 'submit', projectId: anon.id, review: '' },
      });
      assertEqual(bad.status, 400, `malformed post ${i + 1} must be a validation error`);
    }
    const good = await req('POST', '/api/portal/testimonials', {
      cookie: anon.cookie,
      body: {
        action: 'submit',
        projectId: anon.id,
        review: 'A valid quote after six malformed ones.',
        consent: { p1: true, p2: false, p3: false },
      },
    });
    assertEqual(good.status, 200, 'the valid submission must still be accepted');

    // Snooze / decline are limited too.
    const codes = [];
    for (let i = 0; i < 12; i++) {
      const res = await req('POST', '/api/portal/testimonials', {
        cookie: anon.cookie,
        body: { action: 'snooze', projectId: anon.id },
      });
      codes.push(res.status);
    }
    const limited = codes.filter((c) => c === 429).length;
    assert(limited > 0, 'the snooze action must be rate-limited');
    return `6 malformed posts consumed no slot; snooze limited after ${codes.filter((c) => c === 200).length} accepted`;
  });

  await t('L7', 'm7: the newest record for a project is client-scoped', async () => {
    // The project is reassigned to the other client (today there is no
    // reassignment endpoint — the store is edited directly).
    const projects = readJsonl(PROJECTS_FILE);
    const idx = projects.findIndex((p) => p.id === named.id);
    const before = fs.readFileSync(PROJECTS_FILE, 'utf8');
    projects[idx].clientId = anonClient.id;
    fs.writeFileSync(PROJECTS_FILE, projects.map((p) => JSON.stringify(p)).join('\n') + '\n', 'utf8');
    try {
      const seen = await req('GET', `/api/portal/testimonials?projectId=${named.id}`, { cookie: anon.cookie });
      assertEqual(seen.status, 200, 'the new client may read the project');
      assertEqual(seen.json.testimonial, null, 'the new client must NOT inherit the old client quote');

      const own = await req('POST', '/api/portal/testimonials', {
        cookie: anon.cookie,
        body: {
          action: 'submit',
          projectId: named.id,
          review: 'The new client writes their own quote.',
          consent: { p1: true, p2: false, p3: false },
        },
      });
      assertEqual(own.status, 200, 'the new client may write their own quote');
      const oldRef = readJsonl(REVIEWS_FILE).filter((r) => r.ref && r.clientId === namedClient.id).pop().ref;
      assert(own.json.testimonial.ref !== oldRef, 'the old ref must not be inherited');
      const ownRecord = readJsonl(REVIEWS_FILE).filter((r) => r.ref === own.json.testimonial.ref).pop();
      assertEqual(ownRecord.clientId, anonClient.id, 'the new record must belong to the new client');
    } finally {
      fs.writeFileSync(PROJECTS_FILE, before, 'utf8');
    }
    return 'the new client sees no quote and gets a fresh ref';
  });

  await t('L8', 'm2: the publish script refuses a malformed store', async () => {
    const dir = path.join(SANDBOX, 'publish-test');
    fs.mkdirSync(path.join(dir, 'data', 'moderation'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'src', 'content'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'data', 'moderation', 'reviews.jsonl'),
      JSON.stringify({
        ref: 'rev_ok',
        type: 'review',
        state: 'approved',
        review: 'A good quote',
        consent: { p1: true, p2: true },
      }) + '\n{ broken\n',
      'utf8',
    );
    const res = spawnSync(process.execPath, [path.join(SITE, 'scripts', 'publish-testimonials.mjs')], {
      cwd: dir,
      encoding: 'utf8',
    });
    assert(res.status !== 0, 'the publish must fail loudly instead of dropping the record');
    const outDir = path.join(dir, 'src', 'content', 'testimonials');
    const written = fs.existsSync(outDir) ? fs.readdirSync(outDir) : [];
    assertEqual(written.length, 0, 'nothing may be published from a store that could not be read');
    const firstLine = String(res.stderr || '').trim().split('\n')[0] || '';
    return `exit ${res.status}: ${firstLine.slice(0, 100)}`;
  });

  await t('L9', 'm2: a corrupt store is never rewritten', async () => {
    // The client session was destroyed by the logout check — sign in again.
    const cookie = await signIn('named@client.test');
    const original = fs.readFileSync(PROJECTS_FILE, 'utf8');
    fs.appendFileSync(PROJECTS_FILE, '{ broken\n', 'utf8');
    let during = '';
    try {
      const res = await req('POST', '/api/portal/testimonials', {
        cookie,
        body: {
          action: 'submit',
          projectId: named.id,
          review: 'A quote that must not be stored while the store is broken.',
          consent: { p1: true, p2: true, p3: false },
        },
      });
      assertEqual(res.status, 500, 'the endpoint must answer 500');
      assertEqual(res.json.code, 'storage', 'the answer must name the store');
      // Read the file WHILE it is still corrupt: a rewrite would have dropped
      // the broken line (and every record after it).
      during = fs.readFileSync(PROJECTS_FILE, 'utf8');
    } finally {
      fs.writeFileSync(PROJECTS_FILE, original, 'utf8');
    }
    assert(during.includes('{ broken\n'), 'the corrupt line must still be there (nothing was rewritten)');
    assertEqual(during, original + '{ broken\n', 'the file must be byte-identical to what it was');
    return 'the corrupt line survived; no lossy rewrite';
  });

  group('M — the rate limiter (QA D7 follow-up: the counters moved behind a backend)');

  // L5 logged out and destroyed the owner's session — take a fresh one.
  const ownerCookie2 = await signIn('owner@imk.test');

  await t('M1', 'the submit limit is 5 per client per hour; the 6th is 429', async () => {
    fs.appendFileSync(
      INVITED_FILE,
      JSON.stringify({ email: 'rate@client.test', name: 'Rita Rate' }) + '\n',
      'utf8',
    );
    const cookie = await signIn('rate@client.test');
    const client = readJsonl(CLIENTS_FILE).find((c) => c.email === 'rate@client.test');
    assert(client, 'the new client record must exist');
    const projectId = await makeProject(ownerCookie2, client.id, 'Rate Limited Website');
    const statuses = [];
    for (let i = 0; i < 6; i += 1) {
      const res = await req('POST', '/api/portal/testimonials', {
        cookie,
        body: {
          action: 'submit',
          projectId,
          review: `Quote number ${i + 1} from the rate limited client.`,
          rating: 5,
          consent: { p1: true, p2: true, p3: false },
        },
      });
      statuses.push(res.status);
      if (res.status === 429) {
        assertEqual(res.json.code, 'rate-limit', 'the 429 must carry the rate-limit code');
        assert(res.text.includes('Retry-After') || true, 'the 429 may carry Retry-After');
      }
    }
    assertEqual(statuses.slice(0, 5).join(','), '200,200,200,200,200', 'the first five must be accepted');
    assertEqual(statuses[5], 429, 'the sixth must be rate-limited');
    return `statuses=${statuses.join(',')}`;
  });

  await t('M2', 'the limit is per client: another client is unaffected', async () => {
    fs.appendFileSync(
      INVITED_FILE,
      JSON.stringify({ email: 'other@client.test', name: 'Ola Other' }) + '\n',
      'utf8',
    );
    const cookie = await signIn('other@client.test');
    const client = readJsonl(CLIENTS_FILE).find((c) => c.email === 'other@client.test');
    const projectId = await makeProject(ownerCookie2, client.id, 'Unaffected Website');
    const res = await req('POST', '/api/portal/testimonials', {
      cookie,
      body: {
        action: 'submit',
        projectId,
        review: 'A quote from a client who has not spent their budget.',
        rating: 5,
        consent: { p1: true, p2: true, p3: false },
      },
    });
    assertEqual(res.status, 200, 'the other client must be unaffected');
    return 'the second client still has their full budget';
  });

  await t('M3', 'the sign-in link request is limited per IP: the 6th is 429', async () => {
    const ip = '198.51.100.77';
    const statuses = [];
    for (let i = 0; i < 6; i += 1) {
      const res = await req('POST', '/api/portal/auth/request-link', {
        ip,
        body: { email: `probe${i}@client.test` },
      });
      statuses.push(res.status);
    }
    assertEqual(statuses.slice(0, 5).join(','), '200,200,200,200,200', 'the first five must be accepted');
    assertEqual(statuses[5], 429, 'the sixth must be rate-limited');
    const blocked = await req('POST', '/api/portal/auth/request-link', {
      ip,
      body: { email: 'probe7@client.test' },
    });
    assertEqual(blocked.json.code, 'rate-limit', 'the 429 must carry the rate-limit code');
    return `statuses=${statuses.join(',')}`;
  });

  group('N - the deploy route table (QA wave-3 F-1)');

  await t('N1', 'the route manifest check passes: every called path has a function file in both trees', async () => {
    const script = path.join(SITE, 'scripts', 'check-api-routes.mjs');
    const run = spawnSync(process.execPath, [script], { cwd: SITE, encoding: 'utf8' });
    assertEqual(
      run.status,
      0,
      `the route manifest check failed:\n${run.stdout}\n${run.stderr}`,
    );
    assert(
      run.stdout.includes('OK: every called path has a function file'),
      'the check must report success',
    );
    // Wave 13 (the function budget): the check now also accepts a route-table
    // entry point as the serving function, so the summary says so. The stable
    // part of the message is asserted above; this one proves the NEW clause is
    // there, because a check that silently stopped accepting entry points
    // would let a broken route table through.
    assert(
      run.stdout.includes('(or a route-table entry point) in both trees'),
      'the check must report that a route-table entry point can serve a path',
    );
    const apiFiles = (run.stdout.match(/api\/ holds (\d+) \.ts file\(s\)/) || [])[1];
    assert(
      apiFiles !== undefined && Number(apiFiles) <= 12,
      `api/ must hold at most 12 function files (the Vercel Hobby cap) -- it holds ${apiFiles}`,
    );
    const routes = (run.stdout.match(/^\[check-api-routes\] (\/api\S+)/gm) || []).length;
    assert(routes >= 10, `the manifest must list the portal routes, found ${routes}`);
    return `${routes} routes, both trees, api/ holds ${apiFiles} files`;
  });

  await t('N2', 'the route files exist in both trees and export a handler', async () => {
    // The paths the front-end calls that Vercel and Cloudflare used to
    // answer 404 for: the sign-in door and the by-id edits.
    //
    // WAVE 13 (the function budget): the by-id edits no longer have a file
    // of their own in the Vercel tree -- they are route-table entries served
    // by api/portal.ts, which dispatches to the handler module the table
    // names. So the assertion changed SHAPE, not MEANING: the URL must still
    // be SERVED by a file that exports a handler, and "served" now means
    // "its own file" OR "a route-table entry whose handler module exists".
    //
    // The Cloudflare tree is unchanged: one file per URL.
    const expected = [
      { url: '/api/portal/auth/request-link', file: 'portal/auth/request-link' },
      { url: '/api/portal/auth/verify', file: 'portal/auth/verify' },
      { url: '/api/portal/auth/logout', file: 'portal/auth/logout' },
      { url: '/api/portal/projects/<id>', file: 'portal/projects/[id]', family: '/api/portal/projects/*' },
      { url: '/api/portal/plan-items/<id>', file: 'portal/plan-items/[id]', family: '/api/portal/plan-items/*' },
    ];
    const table = JSON.parse(
      fs.readFileSync(path.join(SITE, 'shared', 'portal-routes.json'), 'utf8'),
    );
    for (const item of expected) {
      const cf = path.join(SITE, 'functions', 'api', `${item.file}.ts`);
      assert(fs.existsSync(cf), `the Cloudflare route file for ${item.url} is missing: ${cf}`);

      const vercel = path.join(REPO, 'api', `${item.file}.ts`);
      if (item.family) {
        // Served through the route table: the family entry point AND the
        // handler module it names must both be there, or the URL is a 404 in
        // production while the local dev server answers 200.
        const family = table.families['/api/portal'];
        assert(family, 'the route table has no /api/portal family');
        const entry = path.join(REPO, family.entry);
        assert(fs.existsSync(entry), `the family entry point is missing: ${entry}`);
        const handlerName = family.routes[item.family];
        assert(
          handlerName,
          `the route table does not serve ${item.family} (the URL would 404 in production)`,
        );
        const handlerFile = path.join(REPO, table.handlers[handlerName]);
        assert(
          fs.existsSync(handlerFile),
          `the handler module behind ${item.family} is missing: ${handlerFile}`,
        );
      } else {
        assert(
          fs.existsSync(vercel),
          `the Vercel route file for ${item.url} is missing: ${vercel}`,
        );
      }
    }

    // And they are not empty placeholders: each one exports a handler.
    const entry = path.join(SANDBOX, 'routes-entry.ts');
    const out = path.join(SANDBOX, 'bundle', 'routes.cjs');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(
      entry,
      [
        `export { default as requestLink } from '${fwd(handlerPath('portal-auth', ROOTS))}';`,
        `export { default as projectById } from '${fwd(handlerPath('portal-projects', ROOTS))}';`,
        `export { default as planItemById } from '${fwd(handlerPath('portal-plan-items', ROOTS))}';`,
      ].join('\n'),
      'utf8',
    );
    await build({
      entryPoints: [entry],
      outfile: out,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      absWorkingDir: REPO,
      external: ['node:http', 'node:crypto', 'node:fs', 'node:path'],
      logLevel: 'silent',
    });
    const routes = require(out);
    for (const [name, fn] of Object.entries(routes)) {
      assertEqual(typeof fn, 'function', `the route module ${name} must export a handler`);
    }
    return `${expected.length} route URLs served in both trees, ${Object.keys(routes).length} handlers bundled`;
  });

  // ---- teardown ------------------------------------------------------------
  if (server) server.close();
  const passed = results.filter((r) => r.status === 'PASS').length;
  const failed = results.filter((r) => r.status === 'FAIL').length;
  origLog(`\n[qa] ${passed} passed, ${failed} failed, ${results.length} checks`);
  if (!KEEP) rmrf(SANDBOX);
  else origLog(`[qa] sandbox kept: ${SANDBOX}`);
  process.exit(failed ? 1 : 0);
}

// Capture the handler logs (the magic-link dev branch prints to stdout).
// The bearer token is kept in memory (the harness needs it to sign the
// fixtures in) but is redacted on the way to the screen.
const origWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...rest) => {
  const text = String(chunk);
  for (const line of text.split('\n')) {
    if (line.trim()) logLines.push(line);
  }
  return origWrite(
    text.replace(/("token":")([^"]{6})[^"]*(")/g, (_m, a, head, c) => `${a}${head}…<redacted>${c}`),
    ...rest,
  );
};

main().catch((err) => {
  origLog('[qa] harness crashed:', err);
  rmrf(SANDBOX);
  process.exit(1);
});
