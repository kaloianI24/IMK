// site/qa/qa-wave4-independent.mjs
//
// QA-OWNED independent verification of fix wave 4 (QA wave-3 findings F-1,
// F-2, D-1 and D-2 as fixed by the Backend Developer).
//
// WHY THIS FILE EXISTS
//   The Backend Developer asked QA to re-run their suites and to write
//   independent checks for six behaviours. Their suites, their
//   `npm run check:routes` script and their report are their CLAIM. This
//   file is QA's own evidence. It shares no helper with the Backend's
//   suites: it rebuilds its own harness, uses its own port, its own sandbox
//   and its own signing code.
//
// WHAT IS DIFFERENT ABOUT THIS SUITE
//   - The route inventory is derived by QA from site/src and from the two
//     server trees with QA's OWN parser. The Backend's check script is not
//     imported, executed or trusted: it is the thing under test.
//   - The vacuity proof (the route check must FAIL when a route file is
//     missing) runs on a COPY of the tree in the temp directory. The
//     repository is never modified.
//   - The by-id handlers are executed twice: once with the id in the PATH
//     and once with the id in `req.query.id` (the dynamic-route parameter a
//     host resolves before the function runs). QA injects it with a header,
//     so the real handler sees a real HTTP request.
//   - The moderation links are signed with QA's own node:crypto HMAC.
//
// ISOLATION
//   cwd     -> <sandbox>       the handlers resolve site/data/... from cwd
//   ports   -> 4451            never 4321 (the running dev server), never
//                               4399/4411/4421/4431-4434/4441-4442
//   network -> global fetch stub   no request leaves the machine
//
// USAGE
//   node site/qa/qa-wave4-independent.mjs
//   node site/qa/qa-wave4-independent.mjs --keep
//   node site/qa/qa-wave4-independent.mjs --json <ABSOLUTE path>

import { createServer } from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFile, execFileSync } from 'node:child_process';
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

const PORT = Number(process.env.QA_W4_PORT || 4451);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const SANDBOX = path.join(
  os.tmpdir(),
  'opencode',
  `qa-wave4-${new Date().toISOString().replace(/[:.]/g, '-')}`,
);

const SECRET = 'qa-wave4-form-webhook-secret';
const ADMIN_EMAIL = 'owner@imk.test';
const IP_A = '203.0.113.21';
const IP_B = '203.0.113.22';

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
process.env.RESEND_API_KEY = 'qa-wave4-resend-key';
process.env.RESEND_FROM = 'IMK <qa@imk.test>';
process.env.RESEND_TO = ADMIN_EMAIL;
process.env.FORM_WEBHOOK_SECRET = SECRET;
process.env.ADMIN_EMAILS = ADMIN_EMAIL;
// The sign-in link is self-contained and signed (wave 5) and the session is a
// signed token (wave 6, F-2). In production BOTH secrets are mandatory: a
// missing one is a misconfiguration and the endpoint answers 500. These are
// QA-local test secrets, not credentials.
process.env.PORTAL_MAGIC_LINK_SECRET = 'qa-wave4-magic-link-secret';
process.env.PORTAL_SESSION_SECRET = 'qa-wave4-session-secret';

const emails = [];
const REAL_FETCH = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const target = String(url);
  if (target.startsWith(ORIGIN)) return REAL_FETCH(url, init);
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
export { default as planItems } from '${API_FWD}/portal/plan-items.ts';
export { default as moderate } from '${API_FWD}/moderate/review.ts';
export { portalRateLimiter, createFileBackend, createMemoryBackend, createPortalRateLimiter } from '${API_FWD}/lib/rate-limit.ts';
`;

const CF_ENTRY = `export { onRequestGet as cfModerateGet } from '${CF_FWD}/api/moderate/review.ts';
`;

const ROUTES = [
  ['/api/portal/auth', 'auth'],
  ['/api/portal/invites', 'invites'],
  ['/api/portal/projects', 'projects'],
  ['/api/portal/plan-items', 'planItems'],
  ['/api/moderate/review', 'moderate'],
];

const PORTAL_DIR = path.join(SANDBOX, 'site', 'data', 'portal');
const MODERATION_DIR = path.join(SANDBOX, 'site', 'data', 'moderation');
const REVIEWS_FILE = path.join(MODERATION_DIR, 'reviews.jsonl');
const COUNTER_FILE = path.join(SANDBOX, 'rate-counters.json');

let api = null;
let cf = null;
let server = null;

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

function makeServer(handlerMap) {
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
    // QA simulates the platform's dynamic-route parameter: a host that
    // resolves /api/portal/projects/<id> before the function runs hands the
    // id to the handler as req.query.id. The header is QA's own channel.
    const injected = req.headers['x-qa-query-id'];
    if (injected) req.query = { id: String(injected) };
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
  server = makeServer(api);
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
async function req(method, pathname, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.cookie) headers.Cookie = opts.cookie;
  if (opts.origin !== undefined) headers.Origin = opts.origin;
  if (opts.ip) headers['x-forwarded-for'] = opts.ip;
  if (opts.queryId) headers['x-qa-query-id'] = opts.queryId;
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

function urlMatching(mail, pathFragment) {
  const re = new RegExp(`(https?://\\S*${pathFragment}\\S*)`);
  const m = re.exec(mail.text);
  assert(m, `no "${pathFragment}" link found in the mail -- subject: ${mail.subject}`);
  return m[1].trim();
}

// ---------------------------------------------------------------------------
// scenario helpers -- the whole flow goes through the REAL API
// ---------------------------------------------------------------------------
async function signIn(email, ip) {
  const before = emails.length;
  const r = await req('POST', '/api/portal/auth/request-link', {
    body: { email },
    origin: ORIGIN,
    ip,
  });
  assertEqual(r.status, 200, `request-link for ${email} should be 200 (got ${r.status}: ${r.text})`);
  const mail = emails.slice(before).find((e) => e.to.includes(email));
  assert(mail, `no sign-in mail was sent to ${email}`);
  const verifyUrl = urlMatching(mail, '/login/verify\\?token=');
  const parsed = new URL(verifyUrl);
  const v = await req('GET', `/api/portal/auth/verify?token=${encodeURIComponent(parsed.searchParams.get('token') || '')}`);
  assertEqual(v.status, 200, `verify for ${email} should be 200 (got ${v.status}: ${v.text})`);
  const cookie =
    cookieValue(v.setCookie, 'imk_admin_session') || cookieValue(v.setCookie, 'imk_session');
  assert(cookie, `no session cookie was issued for ${email}`);
  return { cookie, role: v.json.role };
}

async function inviteClient(email, name) {
  const inv = await req('POST', '/api/portal/invites', {
    cookie: owner.cookie,
    origin: ORIGIN,
    body: { email, name, company: 'Wave4 Ltd', role: 'CTO' },
  });
  assertEqual(inv.status, 200, `invite for ${email} should be 200 (got ${inv.status}: ${inv.text})`);
  return inv.json.invited;
}

async function createProject(email, title) {
  const proj = await req('POST', '/api/portal/projects', {
    cookie: owner.cookie,
    origin: ORIGIN,
    body: { title, clientId: email, status: 'completed' },
  });
  assertEqual(proj.status, 200, `project should be 200 (got ${proj.status}: ${proj.text})`);
  return proj.json.project;
}

async function createPlanItem(projectId, title) {
  const item = await req('POST', '/api/portal/plan-items', {
    cookie: owner.cookie,
    origin: ORIGIN,
    body: { projectId, title },
  });
  assertEqual(item.status, 200, `plan item should be 200 (got ${item.status}: ${item.text})`);
  return item.json.planItem;
}

/** QA's OWN signing of a moderation link -- not the project's helper. */
function qaSignModeration(ref, decision, revision, ts, secret = SECRET) {
  return crypto.createHmac('sha256', secret).update(`${ref}|${decision}|${revision}|${ts}`).digest('hex');
}

function qaModerationUrl(ref, decision, revision, ts) {
  const sig = qaSignModeration(ref, decision, revision, ts);
  return `/api/moderate/review?ref=${encodeURIComponent(ref)}&decision=${encodeURIComponent(
    decision,
  )}&revision=${revision}&sig=${encodeURIComponent(sig)}&ts=${ts}`;
}

// ---------------------------------------------------------------------------
// the Cloudflare tree, executed in a Web-standard runtime
// ---------------------------------------------------------------------------
async function loadCf() {
  const outFile = await bundleTo(CF_ENTRY, path.join(SANDBOX, 'bundle', 'cf.cjs'));
  cf = require(outFile);
}

/** A fake node:fs bound to globalThis.require, rooted at the sandbox. */
function bindEdgeFs() {
  const real = require('node:fs');
  globalThis.require = (id) => {
    if (id === 'node:fs') {
      return {
        existsSync: (p) => real.existsSync(path.resolve(process.cwd(), p)),
        readFileSync: (p, enc) => real.readFileSync(path.resolve(process.cwd(), p), enc),
        writeFileSync: (p, data, enc) => real.writeFileSync(path.resolve(process.cwd(), p), data, enc),
        mkdirSync: (p, opts) => real.mkdirSync(path.resolve(process.cwd(), p), opts),
      };
    }
    return require(id);
  };
}

function unbindEdgeFs() {
  delete globalThis.require;
}

function cfCtx(url, method, env = {}) {
  const absolute = /^https?:\/\//.test(url) ? url : `${ORIGIN}${url}`;
  return {
    request: new Request(absolute, { method }),
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

async function cfCall(fn, url, method, env) {
  const res = await fn(cfCtx(url, method, env));
  let body = null;
  try {
    body = await res.clone().json();
  } catch {
    /* not json */
  }
  return { status: res.status, body };
}

// ---------------------------------------------------------------------------
// QA's OWN route parser (the Backend's check script is the thing under test)
// ---------------------------------------------------------------------------
function walkFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(full, out);
    else out.push(full);
  }
  return out;
}

/**
 * The CODE parts of a file.
 *
 * An .astro file is HTML with a script block inside it, and HTML prose has
 * apostrophes ("we'll send a link"). A string scanner that walks the whole
 * file pairs that apostrophe with the next quote in the document and swallows
 * the route that sits between them -- so only the frontmatter and the script
 * blocks are scanned.
 */
function codeParts(text, file) {
  if (!/\.astro$/.test(file)) return [text];
  const parts = [];
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (fm) parts.push(fm[1]);
  const re = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(text)) !== null) parts.push(m[1]);
  return parts;
}

/**
 * Every string literal in a text, comments excluded.
 *
 * A plain regex over quoted text is not enough: a single quote inside a
 * template literal (`${x ?? ''}`) would pair with an apostrophe in a comment
 * and swallow the route that follows it. QA's scanner walks the text instead.
 */
function scanStrings(text) {
  const out = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      i++;
      let buf = '';
      while (i < n) {
        if (text[i] === '\\') {
          buf += text[i] + (text[i + 1] || '');
          i += 2;
          continue;
        }
        if (text[i] === quote) {
          i++;
          break;
        }
        buf += text[i];
        i++;
      }
      out.push(buf);
      continue;
    }
    i++;
  }
  return out;
}

/** A route pattern out of a URL-ish string: '/api/x/y?z' -> '/api/x/y'. */
function routePattern(str) {
  const idx = str.indexOf('/api/');
  if (idx === -1) return null;
  let p = str.slice(idx);
  // An interpolation becomes a placeholder first, so the query cut cannot
  // land inside `${...}`.
  p = p.replace(/\$\{[^{}]*\}/g, '\u0000');
  const cut = p.search(/[?'"\s`]/);
  if (cut !== -1) p = p.slice(0, cut);
  p = p.replace(/\u0000/g, '*');
  p = p.replace(/\/+$/, '');
  if (p === '/api' || p === '') return null;
  return p;
}

/** The base of a client file: `const API = '/api/portal'`. */
function apiBaseOf(text) {
  const m = text.match(/const\s+[A-Za-z_$][\w$]*\s*=\s*['"](\/api\/[^'"]*)['"]/);
  return m ? m[1] : null;
}

/** The paths passed to a call: api('/projects'), api(`/x/${id}`). */
function callSitePaths(text) {
  const found = [];
  const re = /[A-Za-z_$][\w$.]*\s*\(\s*('([^'\n]*)'|"([^"\n]*)"|`([^`]*)`)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const literal = m[2] ?? m[3] ?? m[4] ?? '';
    if (literal.startsWith('/')) found.push(literal);
  }
  return found;
}

/**
 * Every route pattern a directory of sources names.
 * Returns Map<pattern, Set<source file>>.
 */
function collectRoutes(dir, exts) {
  const patterns = new Map();
  const record = (pattern, source) => {
    if (!pattern) return;
    if (!patterns.has(pattern)) patterns.set(pattern, new Set());
    patterns.get(pattern).add(source);
  };
  for (const file of walkFiles(dir)) {
    if (!exts.test(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    const rel = path.relative(REPO, file).split(path.sep).join('/');
    for (const part of codeParts(text, file)) {
      for (const str of scanStrings(part)) record(routePattern(str), rel);
      const base = apiBaseOf(part);
      if (base) {
        for (const str of callSitePaths(part)) {
          if (str.startsWith('/api/')) continue; // already recorded as absolute
          const joined = base.replace(/\/+$/, '') + str;
          record(routePattern(joined), rel);
        }
      }
    }
  }
  return patterns;
}

/**
 * QA's own workflow parser: the jobs of a GitHub Actions file and the
 * working-directory each of them runs in.
 *
 * A job's base directory is its OWN `defaults.run.working-directory` when it
 * has one, otherwise the workflow-level default, otherwise the repository
 * root. Getting this wrong is exactly the bug wave 4 fixed: the invariant
 * check asserted `api/contact.ts` while the job ran in `site/`.
 */
function parseWorkflow(text) {
  const lines = text.split(/\r?\n/);
  let workflowWd = null;
  const jobs = [];
  let job = null;
  let topBlock = null; // 'defaults' | 'jobs' | other
  let inDefaults = false;

  for (const line of lines) {
    const trimmed = line.trim();
    const indent = line.length - line.trimStart().length;

    if (indent === 0 && trimmed && !trimmed.startsWith('#')) {
      topBlock = trimmed.replace(/:$/, '');
      inDefaults = topBlock === 'defaults';
      job = null;
      continue;
    }
    if (inDefaults) {
      const m = /working-directory:\s*(\S+)/.exec(trimmed);
      if (m) workflowWd = m[1];
      continue;
    }
    if (topBlock !== 'jobs') continue;

    const jobHeader = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (jobHeader) {
      job = { name: jobHeader[1], lines: [], wd: null };
      jobs.push(job);
      continue;
    }
    if (!job) continue;
    job.lines.push(line);
    const m = /working-directory:\s*(\S+)/.exec(trimmed);
    if (m && !job.wd) job.wd = m[1];
  }
  return { workflowWd, jobs };
}

/**
 * The function file that serves a pattern in one tree, or null.
 *
 *   'portal/projects'   -> <tree>/portal/projects.ts
 *   'portal/projects/*' -> <tree>/portal/projects/[id].ts
 *   'portal'            -> a BASE prefix: the directory holds the routes
 */
function handlerFor(treeDir, pattern) {
  const segs = pattern.split('/').filter(Boolean).slice(1); // drop 'api'
  if (!segs.length) return null;
  const last = segs[segs.length - 1];
  const dir = path.join(treeDir, ...segs.slice(0, -1));

  if (last !== '*') {
    const file = path.join(dir, `${last}.ts`);
    if (fs.existsSync(file)) return file;
    // A base prefix ('/api/portal'): the directory exists and holds routes.
    if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
      if (fs.readdirSync(dir).some((n) => n.endsWith('.ts'))) return dir;
    }
    return null;
  }
  if (!fs.existsSync(dir)) return null;
  const hit = fs.readdirSync(dir).find((n) => /^\[[^\]]+\]\.ts$/.test(n));
  return hit ? path.join(dir, hit) : null;
}

const TREES = [
  ['vercel', path.join(REPO, 'api')],
  ['cloudflare', path.join(SITE, 'functions', 'api')],
];

/** The routes a set of patterns is missing, per tree. */
function missingRoutes(patterns) {
  const missing = [];
  for (const pattern of [...patterns.keys()].sort()) {
    for (const [tree, dir] of TREES) {
      if (!handlerFor(dir, pattern)) {
        missing.push(`${tree}: ${pattern} (named in ${[...patterns.get(pattern)].join(', ')})`);
      }
    }
  }
  return missing;
}

/**
 * A helper process that puts the lock file into the Windows "delete pending"
 * state: it opens the lock with 'wx' (which creates it) and unlinks it while
 * keeping the handle open. Opening it again with 'wx' then fails with EPERM
 * instead of EEXIST -- the transient condition the file backend misreads.
 */
function spawnBusyLockHolder(lockPath) {
  const script =
    `const fs=require('node:fs');` +
    `const fd=fs.openSync(${JSON.stringify(lockPath)},'wx');` +
    `fs.unlinkSync(${JSON.stringify(lockPath)});` +
    `console.log('pending');` +
    `setTimeout(()=>{try{fs.closeSync(fd);}catch(e){}},8000);` +
    `setTimeout(()=>process.exit(0),8000);`;
  const child = execFile(process.execPath, ['-e', script], { encoding: 'utf8' });
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

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------
let owner = null;

async function main() {
  fs.mkdirSync(PORTAL_DIR, { recursive: true });
  fs.mkdirSync(MODERATION_DIR, { recursive: true });
  process.env.PORTAL_RATE_LIMIT_FILE = COUNTER_FILE;

  await startServer();
  await loadCf();

  owner = await signIn(ADMIN_EMAIL, IP_A);

  // =====================================================================
  group('A -- the route table, derived by QA from the sources');
  // =====================================================================

  await t('A1', 'every /api URL the front-end calls has a function file in BOTH trees', async () => {
    const clientRoutes = collectRoutes(path.join(SITE, 'src'), /\.(astro|ts|js|mjs)$/);
    assert(
      clientRoutes.size >= 8,
      `QA's parser found only ${clientRoutes.size} client route(s) -- the derivation itself is broken, so this check would be vacuous: ${[...clientRoutes.keys()].join(', ')}`,
    );
    // The routes that were broken before wave 4 must be in the inventory,
    // otherwise the check proves nothing.
    for (const must of [
      '/api/portal/auth/request-link',
      '/api/portal/auth/verify',
      '/api/portal/auth/logout',
      '/api/portal/projects',
      '/api/portal/projects/*',
      '/api/portal/plan-items',
      '/api/portal/plan-items/*',
    ]) {
      assert(
        clientRoutes.has(must),
        `QA's parser did not find the client route ${must} -- the inventory is incomplete: ${[...clientRoutes.keys()].join(', ')}`,
      );
    }
    const missing = missingRoutes(clientRoutes);
    assertEqual(missing.length, 0, `a client route has no function file: ${missing.join(' | ')}`);
    return `${clientRoutes.size} client routes, all served in both trees`;
  });

  await t('A2', 'every /api path the server names has a function file in BOTH trees', async () => {
    const serverRoutes = new Map();
    for (const dir of [API_DIR, CF_DIR]) {
      const found = collectRoutes(dir, /\.(ts|js|mjs)$/);
      for (const [p, sources] of found) {
        if (!serverRoutes.has(p)) serverRoutes.set(p, new Set());
        for (const s of sources) serverRoutes.get(p).add(s);
      }
    }
    assert(serverRoutes.size >= 8, `only ${serverRoutes.size} server route(s) found -- the derivation is broken`);
    const missing = missingRoutes(serverRoutes);
    assertEqual(missing.length, 0, `a server route has no function file: ${missing.join(' | ')}`);
    return `${serverRoutes.size} server routes, all served in both trees`;
  });

  await t('A3', 'the five wave-4 route files exist in BOTH trees', async () => {
    const required = [
      ['portal', 'auth', 'request-link.ts'],
      ['portal', 'auth', 'verify.ts'],
      ['portal', 'auth', 'logout.ts'],
      ['portal', 'projects', '[id].ts'],
      ['portal', 'plan-items', '[id].ts'],
    ];
    const missing = [];
    for (const [tree, dir] of TREES) {
      for (const segs of required) {
        const file = path.join(dir, ...segs);
        if (!fs.existsSync(file)) missing.push(`${tree}: ${path.relative(REPO, file)}`);
      }
    }
    assertEqual(missing.length, 0, `the route table is incomplete: ${missing.join(', ')}`);
    return '5 route files x 2 trees';
  });

  await t('A4', 'no catch-all route file hides a missing path', async () => {
    const catchalls = [];
    for (const [, dir] of TREES) {
      for (const file of walkFiles(dir)) {
        const name = path.basename(file);
        if (/^\[\[|\[\.\.\./.test(name)) catchalls.push(path.relative(REPO, file));
      }
    }
    assertEqual(catchalls.length, 0, `the trees contain catch-all routes: ${catchalls.join(', ')}`);
    // The dynamic files are exactly [id].ts -- one dynamic segment.
    const dynamics = [];
    for (const [, dir] of TREES) {
      for (const file of walkFiles(dir)) {
        if (/^\[[^\]]+\]\.ts$/.test(path.basename(file))) dynamics.push(path.relative(REPO, file));
      }
    }
    assertEqual(dynamics.length, 4, `unexpected dynamic route files: ${dynamics.join(', ')}`);
    return `no catch-all; ${dynamics.length} dynamic [id].ts files`;
  });

  // =====================================================================
  group('B -- the route manifest check is not vacuous');
  // =====================================================================

  const ROUTE_SCRIPT = path.join(SITE, 'scripts', 'check-api-routes.mjs');
  const COPY_ROOT = path.join(SANDBOX, 'copy');

  function copyTree() {
    fs.mkdirSync(COPY_ROOT, { recursive: true });
    fs.cpSync(API_DIR, path.join(COPY_ROOT, 'api'), { recursive: true });
    fs.cpSync(path.join(SITE, 'src'), path.join(COPY_ROOT, 'site', 'src'), { recursive: true });
    fs.cpSync(CF_DIR, path.join(COPY_ROOT, 'site', 'functions'), { recursive: true });
    fs.mkdirSync(path.join(COPY_ROOT, 'site', 'scripts'), { recursive: true });
    fs.copyFileSync(ROUTE_SCRIPT, path.join(COPY_ROOT, 'site', 'scripts', 'check-api-routes.mjs'));
  }

  function runRouteScript(root) {
    try {
      const stdout = execFileSync(
        process.execPath,
        [path.join(root, 'site', 'scripts', 'check-api-routes.mjs')],
        { cwd: path.join(root, 'site'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
      return { code: 0, out: stdout };
    } catch (err) {
      return {
        code: typeof err.status === 'number' ? err.status : 1,
        out: `${err.stdout || ''}${err.stderr || ''}`,
      };
    }
  }

  await t('B1', 'CONTROL: the route check passes on the current tree', async () => {
    copyTree();
    const res = runRouteScript(COPY_ROOT);
    assertEqual(res.code, 0, `the route check failed on an untouched copy: ${res.out}`);
    assert(/OK: every called path has a function file/.test(res.out), `unexpected output: ${res.out}`);
    return 'exit 0 on the untouched copy';
  });

  await t('B2', 'the route check FAILS when a static route file is missing (on a COPY)', async () => {
    const victim = path.join(COPY_ROOT, 'api', 'portal', 'auth', 'request-link.ts');
    const original = fs.readFileSync(victim, 'utf8');
    fs.rmSync(victim);
    const res = runRouteScript(COPY_ROOT);
    assert(res.code !== 0, `the route check still passed with ${victim} deleted -- the check is vacuous`);
    assert(
      res.out.includes('/api/portal/auth/request-link') && res.out.includes('MISSING'),
      `the failure did not name the missing route: ${res.out}`,
    );
    // The real repository is untouched.
    const repoFile = path.join(API_DIR, 'portal', 'auth', 'request-link.ts');
    assert(fs.existsSync(repoFile), 'the repository lost a route file');
    assertEqual(fs.readFileSync(repoFile, 'utf8'), original, 'the repository file was modified');
    return 'exit != 0, the missing route is named, the repo is unchanged';
  });

  await t('B3', 'the route check FAILS when a dynamic route file is missing (on a COPY)', async () => {
    copyTree();
    const victim = path.join(COPY_ROOT, 'site', 'functions', 'api', 'portal', 'projects', '[id].ts');
    assert(fs.existsSync(victim), 'the copy has no dynamic route file to remove');
    fs.rmSync(victim);
    const res = runRouteScript(COPY_ROOT);
    assert(res.code !== 0, 'the route check still passed with the dynamic route file deleted');
    assert(
      res.out.includes('/api/portal/projects/*'),
      `the failure did not name the missing dynamic route: ${res.out}`,
    );
    const repoFile = path.join(CF_DIR, 'api', 'portal', 'projects', '[id].ts');
    assert(fs.existsSync(repoFile), 'the repository lost a dynamic route file');
    return 'exit != 0, the dynamic route is named';
  });

  // =====================================================================
  group('C -- the CI static invariant check (F-2)');
  // =====================================================================

  const WORKFLOW = path.join(REPO, '.github', 'workflows', 'ci.yml');

  await t('C1', 'every `test -f <path>` in the workflow resolves against its job working-directory', async () => {
    const text = fs.readFileSync(WORKFLOW, 'utf8');
    const { workflowWd, jobs } = parseWorkflow(text);
    assert(jobs.length >= 3, `only ${jobs.length} job(s) found in the workflow -- the parser is broken`);
    assertEqual(workflowWd, 'site', `the workflow-level working-directory is ${workflowWd}, not 'site'`);
    const checked = [];
    let outside = 0;
    for (const job of jobs) {
      const base = job.wd || workflowWd || '.';
      for (const line of job.lines) {
        const m = /test -f\s+(\S+)/.exec(line);
        if (!m) continue;
        const target = path.resolve(REPO, base, m[1]);
        checked.push(`${job.name}:${m[1]}`);
        if (!target.startsWith(path.join(REPO, 'site'))) outside++;
        assert(
          fs.existsSync(target),
          `the CI invariant check asserts ${m[1]} (job ${job.name}, working-directory ${base}) but ${target} does not exist -- CI is red for a reason unrelated to the code`,
        );
      }
    }
    assert(checked.length >= 3, `only ${checked.length} path assertions found -- the parser is broken`);
    assert(
      outside >= 1,
      'no asserted path lives outside site/ -- the working-directory resolution is not being exercised',
    );
    return `${checked.length} path assertions, all exist (${outside} outside site/): ${checked.join(', ')}`;
  });

  await t('C2', 'the new CI steps call npm scripts that exist', async () => {
    const text = fs.readFileSync(WORKFLOW, 'utf8');
    const pkg = JSON.parse(fs.readFileSync(path.join(SITE, 'package.json'), 'utf8'));
    const scripts = pkg.scripts || {};
    for (const name of ['check:routes', 'typecheck:api']) {
      assert(
        text.includes(`npm run ${name}`),
        `the workflow does not run npm run ${name}`,
      );
      assert(
        typeof scripts[name] === 'string',
        `site/package.json has no "${name}" script -- the CI step would fail`,
      );
    }
    return `check:routes and typecheck:api exist and are wired into CI`;
  });

  await t('C3', 'the api/ tree is outside the CI working-directory and the paths say so', async () => {
    const text = fs.readFileSync(WORKFLOW, 'utf8');
    assert(
      /working-directory:\s*site/.test(text),
      'the workflow does not run in site/ -- the ../api/... paths would be wrong',
    );
    assert(
      text.includes('test -f ../api/contact.ts'),
      'the workflow does not check ../api/contact.ts',
    );
    assert(fs.existsSync(path.join(REPO, 'api', 'contact.ts')), 'api/contact.ts is missing');
    assert(fs.existsSync(path.join(SITE, 'functions', 'api', 'contact.ts')), 'the CF contact handler is missing');
    return 'working-directory: site, ../api/contact.ts and functions/api/contact.ts both exist';
  });

  // =====================================================================
  group('D -- the by-id handlers (F-1)');
  // =====================================================================

  const clientA = 'wave4.a@client.test';
  const clientB = 'wave4.b@client.test';
  await inviteClient(clientA, 'Wanda Wave4');
  await inviteClient(clientB, 'Walter Wave4');
  const sessionA = await signIn(clientA, IP_B);
  // The second client signs in too: the invite -> client record -> project
  // binding is what makes the "foreign id" check below meaningful.
  await signIn(clientB, IP_B);
  const projectA = await createProject(clientA, 'Wave4 project A');
  const projectB = await createProject(clientB, 'Wave4 project B');
  const itemA = await createPlanItem(projectA.id, 'Wave4 plan item A');
  const itemB = await createPlanItem(projectB.id, 'Wave4 plan item B');

  await t('D1', 'the owner edits a project with the id in the PATH', async () => {
    const r = await req('PATCH', `/api/portal/projects/${projectA.id}`, {
      cookie: owner.cookie,
      origin: ORIGIN,
      body: { status: 'in-progress' },
    });
    assertEqual(r.status, 200, `PATCH by path should be 200 (got ${r.status}: ${r.text})`);
    const g = await req('GET', `/api/portal/projects/${projectA.id}`, { cookie: owner.cookie });
    assertEqual(g.status, 200, `GET by path should be 200 (got ${g.status}: ${g.text})`);
    assertEqual(g.json.project.status, 'in-progress', 'the status was not changed');
    return `status -> ${g.json.project.status}`;
  });

  await t('D2', 'the owner edits a project with the id in req.query.id', async () => {
    const r = await req('PATCH', '/api/portal/projects', {
      cookie: owner.cookie,
      origin: ORIGIN,
      queryId: projectA.id,
      body: { status: 'completed' },
    });
    assertEqual(r.status, 200, `PATCH by query.id should be 200 (got ${r.status}: ${r.text})`);
    const g = await req('GET', `/api/portal/projects/${projectA.id}`, { cookie: owner.cookie });
    assertEqual(g.json.project.status, 'completed', 'the status was not changed by the query.id route');
    return `status -> ${g.json.project.status}`;
  });

  await t('D3', 'a foreign project id is still refused', async () => {
    const g = await req('GET', `/api/portal/projects/${projectB.id}`, { cookie: sessionA.cookie });
    assertEqual(g.status, 403, `another client's project must be 403 (got ${g.status}: ${g.text})`);
    const p = await req('PATCH', `/api/portal/projects/${projectB.id}`, {
      cookie: sessionA.cookie,
      origin: ORIGIN,
      body: { status: 'in-progress' },
    });
    assert(
      p.status === 403 || p.status === 401,
      `a client must not be able to patch another client's project (got ${p.status}: ${p.text})`,
    );
    const missing = await req('GET', '/api/portal/projects/does-not-exist', { cookie: owner.cookie });
    assertEqual(missing.status, 404, `an unknown id must be 404 (got ${missing.status}: ${missing.text})`);
    return `GET foreign -> 403, PATCH foreign -> ${p.status}, unknown id -> 404`;
  });

  await t('D4', 'a plan item is edited with the id in the PATH and in req.query.id', async () => {
    const byPath = await req('PATCH', `/api/portal/plan-items/${itemA.id}`, {
      cookie: owner.cookie,
      origin: ORIGIN,
      body: { status: 'done' },
    });
    assertEqual(byPath.status, 200, `PATCH by path should be 200 (got ${byPath.status}: ${byPath.text})`);
    assertEqual(byPath.json.planItem.status, 'done', 'the plan item status was not changed');

    const byQuery = await req('PATCH', '/api/portal/plan-items', {
      cookie: owner.cookie,
      origin: ORIGIN,
      queryId: itemA.id,
      body: { status: 'in-progress' },
    });
    assertEqual(byQuery.status, 200, `PATCH by query.id should be 200 (got ${byQuery.status}: ${byQuery.text})`);
    assertEqual(byQuery.json.planItem.status, 'in-progress', 'the plan item status was not changed');

    const foreign = await req('PATCH', `/api/portal/plan-items/${itemB.id}`, {
      cookie: sessionA.cookie,
      origin: ORIGIN,
      body: { status: 'done' },
    });
    assertEqual(foreign.status, 403, `another client's plan item must be 403 (got ${foreign.status}: ${foreign.text})`);
    const unknown = await req('PATCH', '/api/portal/plan-items/nope', {
      cookie: owner.cookie,
      origin: ORIGIN,
      body: { status: 'done' },
    });
    assertEqual(unknown.status, 404, `an unknown plan item must be 404 (got ${unknown.status}: ${unknown.text})`);
    return 'path -> done, query.id -> in-progress, foreign -> 403, unknown -> 404';
  });

  await t('D5', 'the by-id routes are reachable on the deployed target (the route files really export a handler)', async () => {
    // The route file is a re-export: it must expose a default handler that the
    // platform can call. Executed through esbuild, not read.
    const entry = `export { default as byId } from '${path
      .join(API_DIR, 'portal', 'projects', '[id].ts')
      .replace(/\\/g, '/')}';`;
    const outFile = path.join(SANDBOX, 'bundle', 'byid.cjs');
    await bundleTo(entry, outFile);
    const mod = require(outFile);
    assertEqual(typeof mod.byId, 'function', 'the by-id route file does not export a handler');
    const cfEntry = `export { onRequestPatch as cfById } from '${path
      .join(CF_DIR, 'api', 'portal', 'projects', '[id].ts')
      .replace(/\\/g, '/')}';`;
    const cfOut = path.join(SANDBOX, 'bundle', 'cfbyid.cjs');
    await bundleTo(cfEntry, cfOut);
    const cfMod = require(cfOut);
    assertEqual(typeof cfMod.cfById, 'function', 'the CF by-id route file does not export a handler');
    return 'both by-id route files export a callable handler';
  });

  // =====================================================================
  group('E -- the wave-3 regressions, kept (D-1 and D-2)');
  // =====================================================================

  await t('E1', 'a corrupt moderation store on Cloudflare answers 500 storage, not 404', async () => {
    fs.writeFileSync(
      REVIEWS_FILE,
      JSON.stringify({ ref: 'inq_test', type: 'review', state: 'pending', revision: 1 }) +
        '\n{ this is not json\n',
      'utf8',
    );
    bindEdgeFs();
    try {
      const ts = Math.floor(Date.now() / 1000);
      const url = qaModerationUrl('inq_test', 'approve', 1, ts);
      const res = await cfCall(cf.cfModerateGet, url, 'GET');
      assertEqual(res.status, 500, `a corrupt store must be 500 (got ${res.status}: ${JSON.stringify(res.body)})`);
      assertEqual(res.body.code, 'storage', `the code must be 'storage' (got ${res.body.code})`);
    } finally {
      unbindEdgeFs();
    }
    return '500 {code:storage}';
  });

  await t('E2', 'the same corrupt store answers 500 storage on the Vercel tree', async () => {
    const ts = Math.floor(Date.now() / 1000);
    const url = qaModerationUrl('inq_test', 'approve', 1, ts);
    const res = await req('GET', url);
    assertEqual(res.status, 500, `a corrupt store must be 500 (got ${res.status}: ${res.text})`);
    assertEqual(res.json.code, 'storage', `the code must be 'storage' (got ${res.json.code})`);
    return '500 {code:storage}';
  });

  await t('E3', 'a busy lock must not escape as a raw platform error (the limiter would degrade for good)', async () => {
    // DETERMINISTIC reproduction of the Windows lock race.
    //
    // The file backend guards its read-modify-write with an exclusive lock
    // file. It detects "somebody else holds the lock" by comparing the error
    // code with EEXIST -- and treats EVERY other code as a broken backend.
    //
    // On Windows the lock file can be in the "delete pending" state (another
    // process closed-and-unlinked it while a handle is still open), and
    // opening it with 'wx' then fails with EPERM, not EEXIST. The module
    // therefore classifies a TRANSIENT, normal condition as "the backend is
    // broken" -- and `RateLimiter.consume` sets `backendFailed = true` for the
    // rest of the process lifetime: every later hit goes to the per-process
    // in-memory counter, the durable counts are lost, and the cross-process
    // limit stops being enforced. The error is swallowed with no log.
    const busyFile = path.join(SANDBOX, 'busy-counters.json');
    const busyLock = `${busyFile}.lock`;
    const holder = await spawnBusyLockHolder(busyLock);
    let err = null;
    try {
      await api.createFileBackend(busyFile).hit('qa-busy-key', 600000);
    } catch (e) {
      err = e;
    }
    try {
      holder.kill();
    } catch {
      /* ignore */
    }

    if (process.platform !== 'win32') {
      // POSIX has no delete-pending state: the lock is simply free again.
      assert(err === null, `the backend failed to take a free lock: ${err && err.message}`);
      return 'POSIX: the lock was free, the hit was recorded';
    }

    assert(err !== null, 'the busy lock did not produce an error -- the state was not reproduced');
    assert(
      !/^(EPERM|EACCES|EBUSY)$/.test(String(err.code || '')),
      `the lock-busy condition escaped as a raw platform error (${err.code}: ${err.message}) -- ` +
        'the limiter treats that as a broken backend and degrades to the in-memory counter for the ' +
        'rest of the process lifetime, so the durable counts are lost and the cross-process limit ' +
        'stops being enforced (and nothing is logged)',
    );
    assert(
      /could not take the counter lock/.test(String(err.message)),
      `a busy lock must produce the module's own diagnosable error, got: ${err.message}`,
    );
    return `busy lock -> ${err.code}: ${err.message}`;
  });

  await t('E4', 'N writers into the same counter file lose no counts', async () => {
    const KEYS = 40;
    const WRITERS = 4;
    const ROUNDS = 8;
    const raceFile = path.join(SANDBOX, 'race-counters.json');
    const bundle = path.join(SANDBOX, 'bundle', 'api.cjs');

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
          { cwd: SANDBOX, env: { ...process.env, PORTAL_RATE_LIMIT_FILE: raceFile } },
          (err) => resolve(err ? `child failed: ${err.message}` : 'ok'),
        );
      });

    let lostRounds = 0;
    let lostBuckets = 0;
    for (let i = 0; i < ROUNDS; i++) {
      fs.rmSync(raceFile, { force: true });
      const results = await Promise.all(
        Array.from({ length: WRITERS }, (_, w) => child(`w${w}-r${i}`)),
      );
      for (const r of results) assert(r === 'ok', r);
      const state = JSON.parse(fs.readFileSync(raceFile, 'utf8'));
      const keys = Object.keys(state.buckets || {}).length;
      const expected = KEYS * WRITERS;
      if (keys < expected) {
        lostRounds++;
        lostBuckets += expected - keys;
      }
    }
    assertEqual(
      lostRounds,
      0,
      `${lostRounds} of ${ROUNDS} concurrent write rounds lost buckets (${lostBuckets} of ${ROUNDS * KEYS * WRITERS}) -- ` +
        'the file backend still loses durable counts under contention (see E3 for the mechanism)',
    );
    return `${ROUNDS} rounds x ${WRITERS} writers x ${KEYS} keys, nothing lost`;
  });

  // =====================================================================
  group('F -- the Cloudflare moderation endpoint on a runtime without a filesystem');
  // =====================================================================

  await t('F1', 'no filesystem -> 501 unimplemented (not 404, not 200)', async () => {
    unbindEdgeFs();
    const ts = Math.floor(Date.now() / 1000);
    const url = qaModerationUrl('inq_test', 'approve', 1, ts);
    const res = await cfCall(cf.cfModerateGet, url, 'GET');
    assertEqual(res.status, 501, `an unreachable store must be 501 (got ${res.status}: ${JSON.stringify(res.body)})`);
    assertEqual(res.body.code, 'unimplemented', `the code must be 'unimplemented' (got ${res.body.code})`);
    return '501 {code:unimplemented}';
  });

  await t('F2', 'a forged link is refused before the store is touched', async () => {
    const ts = Math.floor(Date.now() / 1000);
    const url = `/api/moderate/review?ref=inq_test&decision=approve&revision=1&sig=${'0'.repeat(64)}&ts=${ts}`;
    const res = await cfCall(cf.cfModerateGet, url, 'GET');
    assertEqual(res.status, 400, `a forged signature must be 400 (got ${res.status}: ${JSON.stringify(res.body)})`);
    assertEqual(res.body.code, 'signature', `the code must be 'signature' (got ${res.body.code})`);
    return '400 {code:signature}';
  });

  // =====================================================================
  group('G -- housekeeping');
  // =====================================================================

  await t('G1', 'the repository site/data was never touched by this run', async () => {
    const repoReviews = path.join(REPO, 'site', 'data', 'moderation', 'reviews.jsonl');
    const size = fs.existsSync(repoReviews) ? fs.statSync(repoReviews).size : -1;
    assertEqual(size, 0, 'the repository moderation store must still be empty');
    assert(
      !fs.existsSync(path.join(REPO, 'site', 'data', 'portal')),
      'the repository portal store must not exist',
    );
    return 'repo site/data/ untouched';
  });

  await t('G2', 'the copy-based vacuity proof left the repository byte-identical', async () => {
    const files = [
      path.join(API_DIR, 'portal', 'auth', 'request-link.ts'),
      path.join(API_DIR, 'portal', 'auth', 'verify.ts'),
      path.join(API_DIR, 'portal', 'auth', 'logout.ts'),
      path.join(API_DIR, 'portal', 'projects', '[id].ts'),
      path.join(API_DIR, 'portal', 'plan-items', '[id].ts'),
      path.join(CF_DIR, 'api', 'portal', 'auth', 'request-link.ts'),
      path.join(CF_DIR, 'api', 'portal', 'projects', '[id].ts'),
    ];
    for (const f of files) {
      assert(fs.existsSync(f), `${path.relative(REPO, f)} is missing`);
    }
    return `${files.length} route files present`;
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
  if (!KEEP) rmrf(SANDBOX);
  else console.log(`[qa] sandbox kept: ${SANDBOX}`);
}

function report() {
  const passed = results.filter((r) => r.status === 'PASS').length;
  const failed = results.filter((r) => r.status === 'FAIL').length;
  console.log('');
  console.log(`[qa] ${passed} passed, ${failed} failed, ${results.length} checks`);
  if (JSON_OUT) {
    fs.mkdirSync(path.dirname(JSON_OUT), { recursive: true });
    fs.writeFileSync(
      JSON_OUT,
      JSON.stringify({ suite: 'qa-wave4-independent', passed, failed, results }, null, 2),
      'utf8',
    );
    console.log(`[qa] results written: ${JSON_OUT}`);
  }
  return failed === 0 ? 0 : 1;
}

main()
  .catch((err) => {
    console.error('[qa] suite error', err && err.stack ? err.stack : err);
    results.push({ id: 'SUITE', group: currentGroup, name: 'suite crashed', status: 'FAIL', error: String(err) });
  })
  .then(async () => {
    await shutdown();
    process.exit(report());
  });
