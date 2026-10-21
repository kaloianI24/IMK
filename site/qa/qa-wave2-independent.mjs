// site/qa/qa-wave2-independent.mjs
//
// QA-OWNED independent verification of the fix wave 2 (audit M5/M6 + m2-m8).
//
// WHY THIS FILE EXISTS
//   The Backend Developer inverted the checks inside MY harness and wrote a
//   harness of their own. Both of those are claims, not evidence. This file
//   is a third, independent set of assertions written by QA from the
//   acceptance criteria (spec/08 section 4.6) and from reading the shipped
//   code -- it does not reuse the Backend's helpers and does not trust their
//   inversion of my checks.
//
// WHAT IS DIFFERENT ABOUT THIS SUITE
//   - The one-click link is taken from the OWNER'S ACTUAL E-MAIL (captured
//     from the stubbed Resend call), not rebuilt from a helper that mirrors
//     the implementation. If the mail carried the wrong link, this suite
//     would fail even when the implementation is self-consistent.
//   - The publish script is executed as a child process in its own sandbox,
//     exactly the way `npm run build` runs it.
//
// ISOLATION
//   cwd     -> <sandbox>      the handlers resolve site/data/... from cwd,
//                               so every fixture lands in the sandbox
//   port    -> 4421           never 4321 (the running dev server), never
//                               4399/4411 (the other suites)
//   network -> global fetch stub   no request leaves the machine
//
// USAGE
//   node site/qa/qa-wave2-independent.mjs
//   node site/qa/qa-wave2-independent.mjs --keep
//   node site/qa/qa-wave2-independent.mjs --json out.json

import { createServer } from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.resolve(__dirname, '..');
const REPO = path.resolve(SITE, '..');
const require = createRequire(import.meta.url);

const argv = process.argv.slice(2);
const KEEP = argv.includes('--keep');
// The path must be absolute: the harness chdir()s into the sandbox before the
// results are written, so a relative path would land in the sandbox.
const JSON_OUT = argv.includes('--json')
  ? path.resolve(argv[argv.indexOf('--json') + 1])
  : null;

const PORT = Number(process.env.QA_PORT || 4421);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const SANDBOX = path.join(
  os.tmpdir(),
  'opencode',
  `qa-wave2-${new Date().toISOString().replace(/[:.]/g, '-')}`,
);

const SECRET = 'qa-wave2-form-webhook-secret';
const ADMIN_EMAIL = 'owner@imk.test';
const CLIENT_EMAIL = 'wanda@client.test';
const RL_EMAIL = 'ratelimit@client.test';
const CFG_EMAIL = 'config@client.test';

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
// NOTE: APP_ENV is left as 'production' on purpose -- the wave-2 contract says
// an unset APP_ENV must be read as production (audit M4). Everything below
// therefore runs in the same mode as a deployed instance.
process.env.APP_ENV = 'production';
process.env.SITE_BASE_URL = ORIGIN;
process.env.RESEND_API_KEY = 'qa-wave2-resend-key';
process.env.RESEND_FROM = 'IMK <qa@imk.test>';
process.env.RESEND_TO = ADMIN_EMAIL;
process.env.FORM_WEBHOOK_SECRET = SECRET;
process.env.ADMIN_EMAILS = ADMIN_EMAIL;
// The sign-in link is self-contained and signed (wave 5) and the session is a
// signed token (wave 6, F-2). In production BOTH secrets are mandatory: a
// missing one is a misconfiguration and the endpoint answers 500. These are
// QA-local test secrets, not credentials.
process.env.PORTAL_MAGIC_LINK_SECRET = 'qa-wave2-magic-link-secret';
process.env.PORTAL_SESSION_SECRET = 'qa-wave2-session-secret';

const emails = [];
// Keep a handle on the real fetch: the harness's OWN requests to the sandbox
// server go through it, everything else is blocked.
const REAL_FETCH = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const target = String(url);
  if (target.startsWith(ORIGIN)) {
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

// QA_API_DIR lets the suite run against a PATCHED COPY of the api/ tree, so a
// check can be proven to FAIL when the defect is put back (a mutation probe).
// It is never set in normal use -- the default is the repo's real handlers.
const API_DIR = process.env.QA_API_DIR
  ? path.resolve(process.env.QA_API_DIR)
  : path.join(REPO, 'api');
const API_FWD = API_DIR.replace(/\\/g, '/');
const PUBLISH_SCRIPT = process.env.QA_PUBLISH_SCRIPT
  ? path.resolve(process.env.QA_PUBLISH_SCRIPT)
  : path.join(SITE, 'scripts', 'publish-testimonials.mjs');

const ENTRY = `export { default as auth } from '${API_FWD}/portal/auth.ts';
export { default as invites } from '${API_FWD}/portal/invites.ts';
export { default as projects } from '${API_FWD}/portal/projects.ts';
export { default as testimonials } from '${API_FWD}/portal/testimonials.ts';
export { default as moderate } from '${API_FWD}/moderate/review.ts';
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
const REVIEWS_FILE = path.join(MODERATION_DIR, 'reviews.jsonl');

let api = null;
let server = null;

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

  // The handlers resolve their data paths from process.cwd() at module load --
  // the cwd must already be the sandbox before the bundle is required.
  process.chdir(SANDBOX);
  api = require(outFile);

  server = createServer(async (req, res) => {
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

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
async function req(method, pathname, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.cookie) headers.Cookie = opts.cookie;
  if (opts.origin !== undefined) headers.Origin = opts.origin;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(`${ORIGIN}${pathname}`, {
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

/** The newest line for a ref -- later lines win (the publisher's rule). */
function latestForRef(ref) {
  const lines = readJsonl(REVIEWS_FILE).filter(
    (r) => !r.__malformed && r.type === 'review' && r.ref === ref,
  );
  return lines.length ? lines[lines.length - 1] : null;
}

function allForRef(ref) {
  return readJsonl(REVIEWS_FILE).filter(
    (r) => !r.__malformed && r.type === 'review' && r.ref === ref,
  );
}

/**
 * Extract a URL by its path, independent of the wording of the mail.
 * Used so that a change in the copy cannot silently break (or pass) a check.
 */
function urlMatching(mail, pathFragment) {
  const re = new RegExp(`(https?://\\S*${pathFragment}\\S*)`);
  const m = re.exec(mail.text);
  assert(m, `no "${pathFragment}" link found in the mail -- subject: ${mail.subject}`);
  return m[1].trim();
}

function reviewMails() {
  return emails.filter((e) => /review/i.test(e.subject) && /Approve:/.test(e.text));
}

/**
 * The APPROVE link from an owner notification, found by its target and its
 * decision parameter -- not by the wording of the mail.
 */
function approveLink(mail) {
  const re = /(https?:\/\/\S*\/api\/moderate\/review\?\S*)/g;
  const found = (mail.text.match(re) || []).filter((u) => u.includes('decision=approve'));
  assert(found.length, `no approve link found in the mail -- subject: ${mail.subject}`);
  return found[0];
}

// ---------------------------------------------------------------------------
// scenario helpers -- the whole flow goes through the REAL API
// ---------------------------------------------------------------------------
async function signIn(email) {
  const before = emails.length;
  const r = await req('POST', '/api/portal/auth/request-link', {
    body: { email },
    origin: ORIGIN,
  });
  assertEqual(r.status, 200, `request-link for ${email} should be 200`);
  const mail = emails.slice(before).find((e) => e.to.includes(email));
  assert(mail, `no sign-in mail was sent to ${email}`);
  const verifyUrl = urlMatching(mail, '/login/verify\\?token=');
  const parsed = new URL(verifyUrl);
  // This is the call the real login page makes (site/src/pages/login/verify.astro):
  //   fetch(`/api/portal/auth/verify?token=${encodeURIComponent(token)}`)
  const v = await req(
    'GET',
    `/api/portal/auth/verify?token=${encodeURIComponent(parsed.searchParams.get('token') || '')}`,
  );
  assertEqual(v.status, 200, `verify for ${email} should be 200`);
  const cookie =
    cookieValue(v.setCookie, 'imk_admin_session') || cookieValue(v.setCookie, 'imk_session');
  assert(cookie, `no session cookie was issued for ${email}`);
  return { cookie, role: v.json.role };
}

/**
 * The owner invites a client. The invite is an UPSERT, so it can be called
 * again for the same address.
 */
async function inviteClient(email, name = 'Wanda Client') {
  const inv = await req('POST', '/api/portal/invites', {
    cookie: owner.cookie,
    origin: ORIGIN,
    body: { email, name, company: 'Wave2 Ltd', role: 'CTO' },
  });
  assertEqual(inv.status, 200, `invite for ${email} should be 200 (got ${inv.status}: ${inv.text})`);
  return inv.json.invited;
}

/**
 * The owner creates a project for a client. This needs the client RECORD to
 * exist, so the client has to have signed in at least once.
 */
async function createProject(email, title, status = 'completed') {
  const proj = await req('POST', '/api/portal/projects', {
    cookie: owner.cookie,
    origin: ORIGIN,
    body: { title, clientId: email, status },
  });
  assertEqual(proj.status, 200, `project should be 200 (got ${proj.status}: ${proj.text})`);
  return proj.json.project;
}

async function submitQuote(
  session,
  projectId,
  review,
  consent = { p1: true, p2: true, p3: false },
) {
  return req('POST', '/api/portal/testimonials', {
    cookie: session.cookie,
    origin: ORIGIN,
    body: { action: 'submit', projectId, rating: 5, review, consent },
  });
}

/** Click a one-click moderation link exactly as the owner would. */
async function clickLink(url) {
  const parsed = new URL(url);
  return req('GET', `${parsed.pathname}${parsed.search}`);
}

let owner = null;
let client = null;

// ---------------------------------------------------------------------------
// the suite
// ---------------------------------------------------------------------------
async function main() {
  await startServer();

  // ---- the real setup: owner invites, client signs in, project is finished --
  owner = await signIn(ADMIN_EMAIL);
  await inviteClient(CLIENT_EMAIL);
  client = await signIn(CLIENT_EMAIL);

  // =========================================================================
  group('M -- A stale one-click link must NOT approve (audit M5)');

  const project = await createProject(CLIENT_EMAIL, 'Wave2 project');

  const first = await submitQuote(client, project.id, 'Revision one text');
  assertEqual(first.status, 200, `first submit should be 200 (got ${first.text})`);
  const ref = first.json.testimonial.ref;
  // The client view does not expose the revision -- read it from the store.
  const storedFirst = latestForRef(ref);
  assert(storedFirst, 'the quote must be in the store');
  assertEqual(storedFirst.revision, 1, 'the first quote is revision 1');

  // The owner received a link BY MAIL for revision 1.
  const mail1 = reviewMails().pop();
  assert(mail1, 'the owner was not sent a review notification');
  const linkRev1 = approveLink(mail1);
  assert(
    linkRev1.includes('revision=1'),
    `the mailed link must name revision 1 (got ${linkRev1})`,
  );

  // The client changes the quote -> revision 2.
  const second = await submitQuote(client, project.id, 'Revision two text');
  assertEqual(second.status, 200, 'the second submit should be 200');
  assertEqual(second.json.testimonial.ref, ref, 'the edited quote keeps the same ref');
  assertEqual(latestForRef(ref).revision, 2, 'the edited quote is revision 2');

  await t('M1', "the owner's link for revision 1 cannot approve revision 2", async () => {
    const r = await clickLink(linkRev1);
    assertEqual(r.status, 409, `a stale link must answer 409 (got ${r.status})`);
    assertEqual(r.json.code, 'stale-revision', 'the error code must be stale-revision');
    return `409 ${r.json.code}`;
  });

  await t('M2', 'the stale link approved NOTHING -- the quote is still pending', async () => {
    const lines = allForRef(ref);
    const newest = lines[lines.length - 1];
    assertEqual(newest.state, 'pending', 'the newest line must still be pending');
    assertEqual(newest.revision, 2, 'the newest line must still be revision 2');
    const approved = lines.filter((l) => l.state === 'approved');
    assertEqual(approved.length, 0, 'no line for this ref may be approved');
    assertEqual(newest.review, 'Revision two text', 'the stored text must be the current one');
    return 'no approved line, newest = revision 2, pending';
  });

  await t('M3', 'a stale link does not overwrite the quote text either', async () => {
    const newest = latestForRef(ref);
    assertEqual(newest.review, 'Revision two text', 'the stored quote must be unchanged');
    return 'text unchanged';
  });

  await t('M4', 'after the 409 the owner gets a fresh link for the CURRENT revision', async () => {
    const before = emails.length;
    const r = await clickLink(linkRev1);
    assertEqual(r.status, 409, 'still a stale link');
    const sent = emails.slice(before);
    assert(
      sent.length >= 1,
      'the owner must be sent a fresh link so the moderation can be finished',
    );
    const fresh = sent.filter((e) => /Approve:/.test(e.text)).pop();
    assert(fresh, 'the fresh mail has no approve link');
    const freshUrl = approveLink(fresh);
    assert(
      freshUrl.includes('revision=2'),
      `the fresh link must name the current revision 2 (got ${freshUrl})`,
    );
    return 'fresh link names revision 2';
  });

  await t('M5', 'the fresh (current-revision) link approves exactly revision 2', async () => {
    const before = emails.length;
    await clickLink(linkRev1); // provoke the refresh mail again
    const fresh = emails.slice(before).filter((e) => /Approve:/.test(e.text)).pop();
    const r = await clickLink(approveLink(fresh));
    assertEqual(r.status, 200, `the current link must approve (got ${r.status})`);
    assertEqual(r.json.state, 'approved', 'the state must be approved');
    const newest = latestForRef(ref);
    assertEqual(newest.state, 'approved', 'the stored newest line must be approved');
    assertEqual(newest.revision, 2, 'the approved revision must be 2');
    assertEqual(newest.review, 'Revision two text', 'the approved text must be revision two');
    return 'revision 2 approved, revision 1 never approved';
  });

  await t('M6', 'tampering with the revision in a genuine link breaks the signature', async () => {
    const tampered = linkRev1.replace('revision=1', 'revision=2');
    assert(tampered !== linkRev1, 'the tampering must have changed the URL');
    const r = await clickLink(tampered);
    assertEqual(r.status, 400, `a tampered link must answer 400 (got ${r.status})`);
    assertEqual(r.json.code, 'signature', 'the error code must be signature');
    return '400 signature';
  });

  await t('M7', 'a link with the revision removed is refused (not approved)', async () => {
    const stripped = linkRev1.replace(/&revision=\d+/, '');
    const r = await clickLink(stripped);
    assertEqual(r.status, 400, `a link without a revision must answer 400 (got ${r.status})`);
    assertEqual(r.json.code, 'validation', 'the error code must be validation');
    return '400 validation';
  });

  // =========================================================================
  group('N -- the publish script refuses a malformed store (audit m2)');

  const pubDir = path.join(SANDBOX, 'publish', 'site');
  const pubReviews = path.join(pubDir, 'data', 'moderation', 'reviews.jsonl');
  const pubOut = path.join(pubDir, 'src', 'content', 'testimonials');
  fs.mkdirSync(path.dirname(pubReviews), { recursive: true });
  fs.mkdirSync(pubOut, { recursive: true });

  const goodRecord = {
    type: 'review',
    ref: 'rev_goodone',
    state: 'approved',
    source: 'portal',
    verifiedClient: true,
    name: 'Wanda Client',
    company: 'Wave2 Ltd',
    rating: '5',
    review: 'A perfectly good quote.',
    consent: { p1: true, p2: true, p3: false, displayName: 'Wanda Client' },
    revision: 1,
  };

  function runPublish() {
    try {
      const stdout = execFileSync(
        process.execPath,
        [PUBLISH_SCRIPT],
        { cwd: pubDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
      return { code: 0, stdout, stderr: '' };
    } catch (err) {
      return {
        code: typeof err.status === 'number' ? err.status : 1,
        stdout: String(err.stdout || ''),
        stderr: String(err.stderr || ''),
      };
    }
  }

  function publishedFiles() {
    return fs.existsSync(pubOut) ? fs.readdirSync(pubOut).filter((f) => f.endsWith('.md')) : [];
  }

  await t('N1', 'a malformed line makes the publish script exit 1', async () => {
    fs.writeFileSync(pubReviews, JSON.stringify(goodRecord) + '\n{ this is not json\n', 'utf8');
    const r = runPublish();
    assertEqual(r.code, 1, `the publish script must exit 1 (got ${r.code})`);
    return 'exit 1';
  });

  await t('N2', 'the failure names the file and the line', async () => {
    const r = runPublish();
    assert(
      r.stderr.includes('reviews.jsonl') && r.stderr.includes('line 2'),
      `stderr must name the file and line 2 -- got: ${r.stderr.trim()}`,
    );
    return r.stderr.trim().slice(0, 120);
  });

  await t('N3', 'nothing is published -- no partial set of testimonials', async () => {
    assertEqual(publishedFiles().length, 0, 'no testimonial may be written from a broken store');
    return '0 published files';
  });

  await t('N4', 'the corrupt store is NOT rewritten (no lossy rewrite)', async () => {
    const raw = fs.readFileSync(pubReviews, 'utf8');
    assert(raw.includes('{ this is not json'), 'the malformed line must survive the failed run');
    return 'corrupt line preserved';
  });

  await t('N5', 'CONTROL: with the malformed line removed the publish succeeds', async () => {
    fs.writeFileSync(pubReviews, JSON.stringify(goodRecord) + '\n', 'utf8');
    const r = runPublish();
    assertEqual(r.code, 0, `a healthy store must publish (got ${r.code}: ${r.stderr})`);
    assertEqual(publishedFiles().length, 1, 'exactly one testimonial must be published');
    const md = fs.readFileSync(path.join(pubOut, publishedFiles()[0]), 'utf8');
    assert(md.includes('A perfectly good quote.'), 'the published file must carry the quote');
    return 'exit 0, 1 file published';
  });

  // =========================================================================
  group('O -- a malformed submission burns no rate-limit slot (audit m6)');

  // The rate limit is per CLIENT, so this group uses its own client with its
  // own bucket -- otherwise the earlier groups would have spent its budget.
  await inviteClient(RL_EMAIL);
  const rlClient = await signIn(RL_EMAIL);
  const rlProject = await createProject(RL_EMAIL, 'Rate limit project');

  let ok = 0;
  for (let i = 0; i < 4; i++) {
    const r = await submitQuote(rlClient, rlProject.id, `Quote number ${i + 1}`);
    if (r.status === 200) ok++;
  }

  await t('O1', 'four valid submissions are accepted', async () => {
    assertEqual(ok, 4, 'the first four valid submissions must be accepted');
    return '4 accepted';
  });

  await t('O2', 'an invalid submission (no consent p1) is refused with 400', async () => {
    const r = await req('POST', '/api/portal/testimonials', {
      cookie: rlClient.cookie,
      origin: ORIGIN,
      body: { action: 'submit', projectId: rlProject.id, rating: 5, review: 'No consent here' },
    });
    assertEqual(r.status, 400, `an invalid submission must answer 400 (got ${r.status})`);
    assertEqual(r.json.code, 'consent-required', 'the error code must be consent-required');
    return '400 consent-required';
  });

  await t('O3', 'the invalid submission consumed NO slot -- a 5th valid one still passes', async () => {
    const r = await submitQuote(rlClient, rlProject.id, 'Quote number 5');
    assertEqual(
      r.status,
      200,
      `the 5th valid submit must still be accepted (got ${r.status}: ${r.text}) -- ` +
        'the rejected request must not have burned a rate-limit slot',
    );
    return '200 -- the slot was not consumed by the invalid request';
  });

  await t('O4', 'the 6th valid submission is rate-limited', async () => {
    const r = await submitQuote(rlClient, rlProject.id, 'Quote number 6');
    assertEqual(r.status, 429, `the 6th valid submit must answer 429 (got ${r.status})`);
    assertEqual(r.json.code, 'rate-limit', 'the error code must be rate-limit');
    assert(r.headers.get('retry-after'), 'a Retry-After header must be sent');
    return '429 rate-limit';
  });

  await t('O5', 'snooze has its OWN bucket -- the exhausted submit bucket does not block it', async () => {
    const r = await req('POST', '/api/portal/testimonials', {
      cookie: rlClient.cookie,
      origin: ORIGIN,
      body: { action: 'snooze', projectId: rlProject.id },
    });
    assertEqual(r.status, 200, `a snooze must still be accepted (got ${r.status})`);
    return '200';
  });

  await t('O6', 'the rate limit is PER CLIENT -- another client is unaffected', async () => {
    const other = await submitQuote(client, project.id, 'A quote from the other client');
    assertEqual(
      other.status,
      200,
      `another client must not inherit the exhausted bucket (got ${other.status}: ${other.text})`,
    );
    return '200 -- buckets are independent';
  });

  // =========================================================================
  group('P -- production without SITE_BASE_URL answers 500, not 403 (audit m4)');

  await inviteClient(CFG_EMAIL);
  const cfgClient = await signIn(CFG_EMAIL);
  const prodProject = await createProject(CFG_EMAIL, 'Config project');

  await t('P1', 'a production instance without SITE_BASE_URL answers 500, not 403 origin', async () => {
    const savedBase = process.env.SITE_BASE_URL;
    const savedUrl = process.env.SITE_URL;
    delete process.env.SITE_BASE_URL;
    delete process.env.SITE_URL;
    try {
      const r = await req('POST', '/api/portal/testimonials', {
        cookie: cfgClient.cookie,
        origin: ORIGIN,
        body: { action: 'submit', projectId: prodProject.id, rating: 5, review: 'Config test' },
      });
      assertEqual(r.status, 500, `a misconfigured instance must answer 500 (got ${r.status})`);
      assertEqual(r.json.code, 'internal', 'the error code must be internal');
      assert(
        r.json.code !== 'origin',
        'the answer must not be an origin rejection -- that reads like a CSRF attack',
      );
      return '500 internal';
    } finally {
      if (savedBase !== undefined) process.env.SITE_BASE_URL = savedBase;
      if (savedUrl !== undefined) process.env.SITE_URL = savedUrl;
    }
  });

  await t('P2', 'no session cookie is issued while the instance is misconfigured', async () => {
    const savedBase = process.env.SITE_BASE_URL;
    const savedUrl = process.env.SITE_URL;
    delete process.env.SITE_BASE_URL;
    delete process.env.SITE_URL;
    try {
      const r = await req('GET', '/api/portal/auth/verify?token=definitely-not-a-token');
      assertEqual(r.status, 500, `verify must answer 500 when misconfigured (got ${r.status})`);
      assertEqual(r.setCookie.length, 0, 'no cookie may be handed out while misconfigured');
      return 'no Set-Cookie';
    } finally {
      if (savedBase !== undefined) process.env.SITE_BASE_URL = savedBase;
      if (savedUrl !== undefined) process.env.SITE_URL = savedUrl;
    }
  });

  await t('P3', 'CONTROL: with SITE_BASE_URL restored the same call works again', async () => {
    const r = await submitQuote(cfgClient, prodProject.id, 'Config test after restore');
    assertEqual(r.status, 200, `the call must work once configured (got ${r.status}: ${r.text})`);
    return '200';
  });

  await t('P4', 'the moderation link follows SITE_BASE_URL, not the placeholder host', async () => {
    const mail = reviewMails().pop();
    const link = approveLink(mail);
    assert(
      link.startsWith(ORIGIN),
      `the link must start with SITE_BASE_URL ${ORIGIN} (got ${link})`,
    );
    assert(
      !link.includes('imk.example'),
      `the link must not point at the placeholder host (got ${link})`,
    );
    return link.slice(0, 60);
  });

  // =========================================================================
  group('Q -- wave-2 cross-checks (m3, m5, m7)');

  await t('Q1', 'm3: a project title is stored RAW (escaped once, at render time)', async () => {
    const raw = 'Tom & Jerry "Ltd" <Acme>';
    const p = await req('POST', '/api/portal/projects', {
      cookie: owner.cookie,
      origin: ORIGIN,
      body: { title: raw, clientId: CLIENT_EMAIL, status: 'completed' },
    });
    assertEqual(p.status, 200, 'the project should be created');
    const stored = readJsonl(PROJECTS_FILE).filter((x) => x.id === p.json.project.id).pop();
    assertEqual(stored.title, raw, 'the title must be stored raw');
    assert(
      !stored.title.includes('&amp;') && !stored.title.includes('&quot;'),
      'the stored title must not be HTML-escaped',
    );
    return `stored: ${stored.title}`;
  });

  await t('Q2', "m7: a second client does not inherit the first client's quote", async () => {
    const secondEmail = 'second@client.test';
    await inviteClient(secondEmail, 'Second Client');
    const second = await signIn(secondEmail);
    assert(second.cookie, 'the second client must be able to sign in');

    // The second client asks about the first client's project: the answer must
    // not be the first client's quote.
    const g = await req('GET', `/api/portal/testimonials?projectId=${project.id}`, {
      cookie: second.cookie,
    });
    assertEqual(g.status, 404, `a project of another client must answer 404 (got ${g.status})`);
    return '404 -- no cross-client quote';
  });

  await t('Q3', 'm5: a stale admin cookie does not shadow a valid client cookie', async () => {
    const combined = `${client.cookie}; imk_admin_session=stale-admin-cookie-value`;
    const r = await req('GET', '/api/portal/testimonials?projectId=not-a-project', {
      cookie: combined,
    });
    assertEqual(r.status, 404, `the client session must be the one that resolves (got ${r.status})`);
    assertEqual(r.json.code, 'not-found', 'the client session resolved (404, not 401/403)');
    return 'client session resolved despite the stale admin cookie';
  });

  await t('Q4', 'm5: logout clears BOTH cookies', async () => {
    const r = await req('POST', '/api/portal/auth/logout', {
      cookie: `${client.cookie}; ${owner.cookie}`,
      origin: ORIGIN,
    });
    assertEqual(r.status, 200, `logout should be 200 (got ${r.status})`);
    const names = r.setCookie.map((c) => c.split('=')[0]);
    assert(names.includes('imk_session'), `logout must clear imk_session (got ${names.join(',')})`);
    assert(
      names.includes('imk_admin_session'),
      `logout must clear imk_admin_session (got ${names.join(',')})`,
    );
    return names.join(', ');
  });

  // =========================================================================
  group('R -- housekeeping');

  await t('R1', "the repo's site/data/ was never touched by this run", async () => {
    const repoReviews = path.join(REPO, 'site', 'data', 'moderation', 'reviews.jsonl');
    const repoPortal = path.join(REPO, 'site', 'data', 'portal');
    if (fs.existsSync(repoReviews)) {
      const size = fs.statSync(repoReviews).size;
      assertEqual(size, 0, `the repo's reviews.jsonl must stay 0 bytes (got ${size})`);
    }
    assert(!fs.existsSync(repoPortal), "the repo's site/data/portal must not exist");
    return 'repo site/data/ untouched';
  });

  await t('R2', 'every fixture landed in the sandbox', async () => {
    assert(fs.existsSync(REVIEWS_FILE), 'the sandbox reviews.jsonl must exist');
    assert(fs.existsSync(INVITED_FILE), 'the sandbox invited.jsonl must exist');
    return `sandbox: ${SANDBOX}`;
  });
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------
try {
  await main();
} catch (err) {
  console.error('\n[qa] SUITE ERROR', err && err.stack ? err.stack : err);
  results.push({
    id: 'SUITE',
    group: 'runner',
    name: 'the suite itself completed',
    status: 'FAIL',
    error: err && err.message ? err.message : String(err),
  });
} finally {
  if (server) server.close();
}

const failed = results.filter((r) => r.status === 'FAIL').length;
const passed = results.filter((r) => r.status === 'PASS').length;

console.log(`\n[qa] ${passed} passed, ${failed} failed, ${results.length} checks`);
console.log(`[qa] sandbox: ${SANDBOX}`);

if (JSON_OUT) {
  fs.writeFileSync(
    JSON_OUT,
    JSON.stringify(
      {
        suite: 'qa-wave2-independent',
        generatedAt: new Date().toISOString(),
        port: PORT,
        sandbox: SANDBOX,
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

if (!KEEP) {
  rmrf(SANDBOX);
  console.log('[qa] sandbox removed');
} else {
  console.log('[qa] sandbox kept');
}

process.exit(failed ? 1 : 0);
