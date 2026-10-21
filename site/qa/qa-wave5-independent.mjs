// site/qa/qa-wave5-independent.mjs
//
// QA-OWNED independent verification of fix wave 5/6 (F-2, F-3, F-4 as fixed
// by the Backend Developer in wave 6).
//
// WHY THIS FILE EXISTS
//   The Backend Developer asked QA to write an INDEPENDENT suite for three
//   fixes and to prove the checks are not vacuous. Their harness
//   (backend-wave6-harness.mjs) and their report are their CLAIM. This file
//   is QA's own evidence. It shares no helper with the Backend's suites:
//   it builds its own bundles, spawns its own child processes, signs with
//   its own node:crypto, and stores its own fixtures.
//
// THE THREE FIXES UNDER TEST
//   F-2  The portal session was a module-scope Map (api/portal/session.ts)
//        and a globalThis Map (the Cloudflare twin). Vercel builds ONE
//        function per file under api/, so the cookie minted by
//        /api/portal/auth/verify was refused by /api/portal/projects with
//        401 {code:'unauthorized'} — no client could sign in. The session is
//        now a SIGNED, STATELESS token in one shared module
//        (site/shared/server/portal-session.ts).
//   F-3  api/moderate/review.ts wrote the moderation log with an unguarded
//        writeReviews(): an unwritable store threw out of the handler, and a
//        MISSING store answered 404 "review not found" — the exact "your
//        quote is gone" outage. It must answer 500 {code:'storage'} /
//        501 {code:'unimplemented'} and never a false "approved".
//   F-4  api/lib/rate-limit.ts treated only EEXIST as "the lock is busy"; any
//        other error (EPERM on a delete-pending Windows lock) latched
//        backendFailed for the life of the process, silently abandoning the
//        durable counter. EEXIST/EPERM/EACCES/EBUSY must be busy-and-retry.
//
// HOW THE SUITE SIMULATES VERCEL
//   Each handler file is bundled SEPARATELY with esbuild and loaded in its
//   OWN CHILD PROCESS. That is what Vercel does: one function per file,
//   each with its own bundle, its own module scope and its own process. A
//   session that only survives inside one bundle is exactly the F-2 defect.
//
//   The child talks JSON lines over stdin/stdout, so the suite binds NO
//   PORT AT ALL — 4321 (the running dev server) is never touched.
//
// ISOLATION
//   cwd     -> <sandbox>       the handlers resolve site/data/... from cwd
//   records -> <sandbox>       site/data/** in the repo is never read or written
//   network -> global fetch stub, in the parent and in every child
//   repo    -> never modified; the mutation probes work on COPIES
//
// USAGE
//   node site/qa/qa-wave5-independent.mjs
//   node site/qa/qa-wave5-independent.mjs --keep
//   node site/qa/qa-wave5-independent.mjs --json <ABSOLUTE path>
//   node site/qa/qa-wave5-independent.mjs --only A,B

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { build } from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const SITE = path.resolve(__dirname, '..');
const REPO = path.resolve(SITE, '..');
const require = createRequire(import.meta.url);

const argv = process.argv.slice(2);
const KEEP = argv.includes('--keep');
const JSON_OUT = argv.includes('--json')
  ? path.resolve(argv[argv.indexOf('--json') + 1])
  : null;
const ONLY = argv.includes('--only')
  ? new Set(argv[argv.indexOf('--only') + 1].split(',').map((s) => s.trim().toUpperCase()))
  : null;

// The module roots. The mutation probes point these at a COPY of the tree,
// which is how a defect is put back without touching the repository.
const API_DIR = path.resolve(process.env.QA_W5_API_DIR || path.join(REPO, 'api'));
const SHARED_DIR = path.resolve(process.env.QA_W5_SHARED_DIR || path.join(SITE, 'shared'));
const CF_DIR = path.resolve(process.env.QA_W5_CF_DIR || path.join(SITE, 'functions'));

const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const SANDBOX = path.join(os.tmpdir(), 'opencode', `qa-wave5-${STAMP}`);
const WORK = path.join(SANDBOX, 'work');

// H-1 (wave-8A): in production a secret that is PRESENT but UNUSABLE -- the
// published placeholder, or shorter than MIN_SECRET_LENGTH (32) -- is refused
// exactly like a missing one, so every fixture below is 32+ characters long.
// They stay distinguishable from each other: OTHER_SESSION_SECRET must not
// verify a token signed with SESSION_SECRET (check A7).
const SECRET = 'qa-wave5-form-webhook-secret-0123456789';
const MAGIC_SECRET = 'qa-wave5-magic-link-secret-0123456789';
const SESSION_SECRET = 'qa-wave5-session-secret-0123456789';
const OTHER_SESSION_SECRET = 'qa-wave5-other-session-secret-0123456789';
const ADMIN_EMAIL = 'owner@imk.test';
const CLIENT_EMAIL = 'client@imk.test';
const SITE_ORIGIN = 'https://imk.test';

// ---------------------------------------------------------------------------
// tiny assertion framework (QA's own)
// ---------------------------------------------------------------------------
const results = [];
let currentGroup = 'general';
let groupEnabled = true;

function group(letter, name) {
  currentGroup = `${letter} -- ${name}`;
  groupEnabled = !ONLY || ONLY.has(letter);
  if (!groupEnabled) {
    console.log(`[qa] ${currentGroup} (skipped)`);
    return false;
  }
  console.log(`\n[qa] ${currentGroup}`);
  return true;
}

async function t(id, name, fn) {
  if (!groupEnabled) return;
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
    const message = err && err.message ? err.message : String(err);
    results.push({
      id,
      group: currentGroup,
      name,
      status: 'FAIL',
      ms: Date.now() - started,
      error: message,
    });
    console.log(`  FAIL  ${id}  ${name}\n          ${message}`);
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
// environment + network stub (the parent process)
// ---------------------------------------------------------------------------
process.env.APP_ENV = 'production';
process.env.SITE_BASE_URL = SITE_ORIGIN;
process.env.RESEND_API_KEY = 'qa-wave5-resend-key';
process.env.RESEND_FROM = 'IMK <qa@imk.test>';
process.env.RESEND_TO = ADMIN_EMAIL;
process.env.FORM_WEBHOOK_SECRET = SECRET;
process.env.ADMIN_EMAILS = ADMIN_EMAIL;
process.env.PORTAL_MAGIC_LINK_SECRET = MAGIC_SECRET;
process.env.PORTAL_SESSION_SECRET = SESSION_SECRET;
delete process.env.PORTAL_RATE_LIMIT_FILE;

const BASE_ENV = {
  APP_ENV: 'production',
  SITE_BASE_URL: SITE_ORIGIN,
  RESEND_API_KEY: 'qa-wave5-resend-key',
  RESEND_FROM: 'IMK <qa@imk.test>',
  RESEND_TO: ADMIN_EMAIL,
  FORM_WEBHOOK_SECRET: SECRET,
  ADMIN_EMAILS: ADMIN_EMAIL,
  PORTAL_MAGIC_LINK_SECRET: MAGIC_SECRET,
  PORTAL_SESSION_SECRET: SESSION_SECRET,
  PORTAL_RATE_LIMIT_FILE: '',
  NODE_ENV: 'production',
};

const parentMails = [];
globalThis.fetch = async (url, init) => {
  const target = String(url);
  if (target.includes('api.resend.com')) {
    let body = {};
    try {
      body = JSON.parse((init && init.body) || '{}');
    } catch {
      body = {};
    }
    parentMails.push({ to: body.to, subject: body.subject, text: body.text });
    return { ok: true, status: 200, json: async () => ({ id: 'qa-mail' }) };
  }
  throw new Error(`[qa] blocked outbound request: ${target}`);
};

// ---------------------------------------------------------------------------
// filesystem helpers
// ---------------------------------------------------------------------------
function rmrf(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dst);
    else fs.copyFileSync(src, dst);
  }
}

/** A digest of every file under a root -- used to prove the repo is untouched. */
function treeDigest(root) {
  const parts = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        parts.push(
          `${path.relative(root, full)}:${crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')}`,
        );
      }
    }
  };
  walk(root);
  return parts.join('\n');
}

/**
 * The digest of the REAL repository trees.
 *
 * Deliberately not the whole repo: node_modules and dist are huge and are
 * not what the probes could damage. These three trees hold every file the
 * Backend owns and every file the mutation probes copy.
 */
const REPO_TREES = [
  path.join(REPO, 'api'),
  path.join(SITE, 'shared'),
  path.join(SITE, 'functions'),
];

function repoDigest() {
  return REPO_TREES.map((tree) => `== ${tree}\n${treeDigest(tree)}`).join('\n');
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

// ---------------------------------------------------------------------------
// the child runner: ONE bundle per process, JSON lines over stdin/stdout
// ---------------------------------------------------------------------------
const CHILD_SRC = [
  'const fs = require("node:fs");',
  'const { Readable } = require("node:stream");',
  '',
  'const bundlePath = process.env.QA_W5_BUNDLE;',
  'const mailFile = process.env.QA_W5_MAIL_FILE || "";',
  'const logFile = process.env.QA_W5_LOG_FILE || "";',
  '',
  '// No request may leave the machine: the Resend call is captured to a file.',
  'const mails = [];',
  'globalThis.fetch = async function (url, init) {',
  '  const target = String(url);',
  '  if (target.indexOf("api.resend.com") !== -1) {',
  '    let body = {};',
  '    try { body = JSON.parse((init && init.body) || "{}"); } catch (e) { body = {}; }',
  '    mails.push({ to: body.to, subject: body.subject, text: body.text, html: body.html });',
  '    if (mailFile) fs.writeFileSync(mailFile, JSON.stringify(mails));',
  '    return { ok: true, status: 200, json: async () => ({ id: "qa-mail" }) };',
  '  }',
  '  throw new Error("[qa] blocked outbound request: " + target);',
  '};',
  '',
  '// stdout is the protocol; the handler log goes to a file.',
  'if (logFile) {',
  '  console.log = function () {',
  '    const line = Array.prototype.map.call(arguments, function (a) {',
  '      return typeof a === "string" ? a : String(a);',
  '    }).join(" ");',
  '    try { fs.appendFileSync(logFile, line + "\\n"); } catch (e) {}',
  '  };',
  '}',
  '',
  'function makeRes() {',
  '  const state = { status: 200, headers: {}, body: "" };',
  '  const res = {',
  '    statusCode: 200, headersSent: false, writableEnded: false,',
  '    writeHead: function (status, headers) {',
  '      state.status = status; state.headers = headers || {};',
  '      res.statusCode = status; res.headersSent = true; return res;',
  '    },',
  '    setHeader: function (k, v) { state.headers[k] = v; },',
  '    getHeader: function (k) { return state.headers[k]; },',
  '    removeHeader: function (k) { delete state.headers[k]; },',
  '    write: function (chunk) {',
  '      if (chunk !== undefined && chunk !== null) state.body += String(chunk);',
  '      return true;',
  '    },',
  '    end: function (chunk) {',
  '      if (chunk !== undefined && chunk !== null) state.body += String(chunk);',
  '      res.writableEnded = true; res.headersSent = true; return res;',
  '    },',
  '    on: function () { return res; }, once: function () { return res; }, emit: function () { return false; },',
  '  };',
  '  return { res: res, state: state };',
  '}',
  '',
  'function makeReq(msg) {',
  '  const body = msg.body === undefined || msg.body === null ? null : String(msg.body);',
  '  const req = new Readable({ read() {} });',
  '  if (body !== null) req.push(Buffer.from(body));',
  '  req.push(null);',
  '  req.method = msg.method || "GET";',
  '  req.url = msg.url || "/";',
  '  req.headers = msg.headers || {};',
  '  req.query = msg.query || {};',
  '  return req;',
  '}',
  '',
  'function reply(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }',
  '',
  'let mod = null;',
  'try {',
  '  mod = require(bundlePath);',
  '} catch (err) {',
  '  reply({ ready: false, error: String((err && err.stack) || err) });',
  '  process.exit(3);',
  '}',
  '',
  'async function handle(msg) {',
  '  try {',
  '    if (msg.cmd === "request") {',
  '      const name = msg.which || "handler";',
  '      const fn = mod[name];',
  '      if (typeof fn !== "function") throw new Error("the bundle has no handler named " + name);',
  '      const made = makeRes();',
  '      await fn(makeReq(msg), made.res);',
  '      reply({ ok: true, status: made.state.status, headers: made.state.headers, body: made.state.body });',
  '      return;',
  '    }',
  '    if (msg.cmd === "rate") {',
  '      const d = await mod.rateHit(msg.key, msg.limit, msg.windowMs);',
  '      reply({ ok: true, decision: d });',
  '      return;',
  '    }',
  '    if (msg.cmd === "session") {',
  '      if (msg.op === "create") {',
  '        reply({ ok: true, token: mod.createSession(msg.email, msg.role, msg.clientId) });',
  '        return;',
  '      }',
  '      if (msg.op === "parse") {',
  '        reply({ ok: true, session: mod.parseSession(msg.token) });',
  '        return;',
  '      }',
  '      if (msg.op === "configured") {',
  '        reply({ ok: true, configured: mod.sessionSecretConfigured() });',
  '        return;',
  '      }',
  '      throw new Error("unknown session op " + msg.op);',
  '    }',
  '    if (msg.cmd === "mail") { reply({ ok: true, mails: mails }); return; }',
  '    if (msg.cmd === "quit") { reply({ ok: true, bye: true }); process.exit(0); }',
  '    reply({ ok: false, error: "unknown command " + msg.cmd });',
  '  } catch (err) {',
  '    reply({ ok: false, error: String((err && err.stack) || err) });',
  '  }',
  '}',
  '',
  'let chain = Promise.resolve();',
  'let buffer = "";',
  'process.stdin.setEncoding("utf8");',
  'process.stdin.on("data", function (chunk) {',
  '  buffer += chunk;',
  '  let idx;',
  '  while ((idx = buffer.indexOf("\\n")) !== -1) {',
  '    const line = buffer.slice(0, idx);',
  '    buffer = buffer.slice(idx + 1);',
  '    if (line.trim()) {',
  '      const msg = JSON.parse(line);',
  '      chain = chain.then(function () { return handle(msg); });',
  '    }',
  '  }',
  '});',
  '',
  'reply({ ready: true });',
].join('\n');

const CHILD_PATH = path.join(SANDBOX, 'child.cjs');

class BundleChild {
  constructor(name, bundlePath, opts = {}) {
    this.name = name;
    this.bundlePath = bundlePath;
    this.env = opts.env || {};
    this.mailFile = path.join(SANDBOX, 'mails', `${name}.json`);
    this.logFile = path.join(SANDBOX, 'logs', `${name}.log`);
    this.waiters = [];
    this.buffer = '';
    this.stderr = '';
    this.proc = null;
    this.readyPromise = null;
  }

  start() {
    fs.mkdirSync(path.dirname(this.mailFile), { recursive: true });
    fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
    this.proc = spawn(process.execPath, [CHILD_PATH], {
      cwd: SANDBOX,
      env: {
        ...process.env,
        ...BASE_ENV,
        ...this.env,
        QA_W5_BUNDLE: this.bundlePath,
        QA_W5_MAIL_FILE: this.mailFile,
        QA_W5_LOG_FILE: this.logFile,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => this.onData(chunk));
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (chunk) => {
      this.stderr += chunk;
    });
    this.proc.on('exit', (code) => {
      const err = new Error(`[qa] child ${this.name} exited with code ${code}: ${this.stderr}`);
      while (this.waiters.length) this.waiters.shift().reject(err);
    });
    this.readyPromise = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    return this.readyPromise;
  }

  onData(chunk) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.ready !== undefined) {
        if (msg.ready) this.readyResolve(msg);
        else this.readyReject(new Error(`[qa] child ${this.name} could not load its bundle: ${msg.error}`));
        continue;
      }
      const waiter = this.waiters.shift();
      if (waiter) waiter.resolve(msg);
    }
  }

  send(msg, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`[qa] child ${this.name} timed out after ${timeoutMs}ms on ${JSON.stringify(msg)}`));
      }, timeoutMs);
      this.waiters.push({
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.proc.stdin.write(JSON.stringify(msg) + '\n');
    });
  }

  /** One HTTP-ish request against the bundled handler. */
  async request(method, url, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    if (opts.cookie) headers.cookie = opts.cookie;
    if (opts.origin) headers.origin = opts.origin;
    if (opts.ip) headers['x-forwarded-for'] = opts.ip;
    const raw = await this.send({
      cmd: 'request',
      which: opts.which,
      method,
      url,
      headers,
      body: opts.body,
      query: opts.query,
    });
    if (raw.ok === false) {
      return { threw: true, error: raw.error, status: 0, headers: {}, text: '' };
    }
    let json = null;
    try {
      json = JSON.parse(raw.body);
    } catch {
      /* not json */
    }
    return {
      threw: false,
      status: raw.status,
      headers: raw.headers || {},
      text: raw.body || '',
      json,
    };
  }

  mails() {
    if (!fs.existsSync(this.mailFile)) return [];
    try {
      return JSON.parse(fs.readFileSync(this.mailFile, 'utf8'));
    } catch {
      return [];
    }
  }

  log() {
    if (!fs.existsSync(this.logFile)) return '';
    return fs.readFileSync(this.logFile, 'utf8');
  }

  async stop() {
    if (!this.proc) return;
    try {
      await this.send({ cmd: 'quit' }, 3000);
    } catch {
      /* the child may already be gone */
    }
    try {
      this.proc.kill();
    } catch {
      /* ignore */
    }
    this.proc = null;
  }
}

const children = [];

async function startChild(name, bundlePath, opts) {
  const child = new BundleChild(name, bundlePath, opts);
  children.push(child);
  await child.start();
  return child;
}

// ---------------------------------------------------------------------------
// bundling (QA's own esbuild calls)
// ---------------------------------------------------------------------------
const BUNDLE_DEFS = {
  auth: { dir: () => API_DIR, code: `export { default as handler } from './portal/auth.ts';` },
  projects: { dir: () => API_DIR, code: `export { default as handler } from './portal/projects.ts';` },
  comments: { dir: () => API_DIR, code: `export { default as handler } from './portal/comments.ts';` },
  combined: {
    dir: () => API_DIR,
    code:
      `export { default as authHandler } from './portal/auth.ts';\n` +
      `export { default as projectsHandler } from './portal/projects.ts';`,
  },
  moderate: { dir: () => API_DIR, code: `export { default as handler } from './moderate/review.ts';` },
  rate: {
    dir: () => API_DIR,
    code:
      `import { portalRateLimiter, createFileBackend, createMemoryBackend, RateLimiter } from './lib/rate-limit.ts';\n` +
      `export { portalRateLimiter, createFileBackend, createMemoryBackend, RateLimiter };\n` +
      `export async function rateHit(key, limit, windowMs) {\n` +
      `  return await portalRateLimiter.consume(key, limit, windowMs);\n` +
      `}`,
  },
  session: {
    dir: () => SHARED_DIR,
    code:
      `export { createSession, parseSession, resolveSession, sessionSecretConfigured, readSessionCookies }` +
      ` from './server/portal-session.ts';`,
  },
  cfModerate: { dir: () => CF_DIR, code: `export { onRequestGet } from './api/moderate/review.ts';` },
  cfRate: {
    dir: () => CF_DIR,
    code:
      `export { createMemoryBackend, createKvBackend, RateLimiter, createPortalRateLimiter }` +
      ` from './api/lib/rate-limit.ts';`,
  },
};

const built = new Map();

async function bundle(name) {
  if (built.has(name)) return built.get(name);
  const def = BUNDLE_DEFS[name];
  const outFile = path.join(SANDBOX, 'bundle', `${name}.cjs`);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  await build({
    stdin: { contents: def.code, resolveDir: def.dir(), loader: 'ts' },
    outfile: outFile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    absWorkingDir: REPO,
    external: ['node:http', 'node:crypto', 'node:fs', 'node:path', 'node:os', 'node:stream'],
    logLevel: 'silent',
  });
  built.set(name, outFile);
  return outFile;
}

// ---------------------------------------------------------------------------
// scenario helpers
// ---------------------------------------------------------------------------
const PORTAL_DIR = path.join(SANDBOX, 'site', 'data', 'portal');
const MODERATION_DIR = path.join(SANDBOX, 'site', 'data', 'moderation');
const INVITED_FILE = path.join(PORTAL_DIR, 'invited.jsonl');
const REVIEWS_FILE = path.join(MODERATION_DIR, 'reviews.jsonl');
const COUNTER_FILE = path.join(SANDBOX, 'rate', 'counters.json');
const LOCK_FILE = `${COUNTER_FILE}.lock`;

function seedInvited() {
  fs.mkdirSync(PORTAL_DIR, { recursive: true });
  fs.writeFileSync(
    INVITED_FILE,
    JSON.stringify({
      email: CLIENT_EMAIL,
      name: 'Wenda Wave5',
      company: 'Wave5 Ltd',
      role: 'CTO',
      invitedBy: ADMIN_EMAIL,
      invitedAt: new Date().toISOString(),
      clientId: 'cli_wave5',
    }) + '\n',
    'utf8',
  );
}

function seedReview(state = 'pending') {
  fs.mkdirSync(MODERATION_DIR, { recursive: true });
  fs.writeFileSync(
    REVIEWS_FILE,
    JSON.stringify({
      ref: 'inq_wave5',
      type: 'review',
      name: 'Wenda Wave5',
      company: 'Wave5 Ltd',
      rating: 5,
      review: 'Excellent work.',
      revision: 1,
      state,
      clientId: 'cli_wave5',
      createdAt: new Date().toISOString(),
    }) + '\n',
    'utf8',
  );
}

/** QA's OWN signing of a moderation link (not the project's helper). */
function qaSignModeration(ref, decision, revision, ts) {
  return crypto
    .createHmac('sha256', SECRET)
    .update(`${ref}|${decision}|${revision}|${ts}`)
    .digest('hex');
}

function qaModerationPath(ref, decision, revision, ts) {
  const sig = qaSignModeration(ref, decision, revision, ts);
  return (
    `/api/moderate/review?ref=${encodeURIComponent(ref)}` +
    `&decision=${encodeURIComponent(decision)}` +
    `&revision=${revision}` +
    `&sig=${encodeURIComponent(sig)}` +
    `&ts=${ts}`
  );
}

/**
 * The body of the confirmation form.
 *
 * M-1 (wave-8A): the DECISION is the POST the page's form issues; the signed
 * parameters travel in the body. A GET only shows the page.
 */
function qaModerationForm(ref, decision, revision, ts) {
  const sig = qaSignModeration(ref, decision, revision, ts);
  return new URLSearchParams({
    ref: String(ref),
    decision: String(decision),
    revision: String(revision),
    ts: String(ts),
    sig: String(sig),
  }).toString();
}

const FORM_HEADERS = { 'content-type': 'application/x-www-form-urlencoded' };

function tokenFromMail(mail) {
  const m = /(https?:\/\/\S*\/login\/verify\?token=([^\s&"']+))/.exec(String(mail.text || ''));
  assert(m, `no sign-in link in the mail: ${JSON.stringify(mail).slice(0, 300)}`);
  return decodeURIComponent(m[2]);
}

function cookieFrom(setCookie, name) {
  const headers = setCookie || {};
  const raw = headers['Set-Cookie'] || headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  for (const c of list) {
    const m = new RegExp(`(?:^|;\\s*)${name}=([^;]*)`).exec(String(c));
    if (m) return `${name}=${m[1]}`;
  }
  return null;
}

/** Sign a client in through the REAL auth bundle and return the cookie. */
async function signIn(authChild, email, ip = '203.0.113.9') {
  const before = authChild.mails().length;
  const r = await authChild.request('POST', '/api/portal/auth/request-link', {
    origin: SITE_ORIGIN,
    ip,
    body: JSON.stringify({ email }),
  });
  assertEqual(r.status, 200, `request-link for ${email} should be 200 (got ${r.status}: ${r.text})`);
  const mail = authChild.mails().slice(before).find((m) => String(m.to).includes(email));
  assert(mail, `no sign-in mail was sent to ${email}`);
  const token = tokenFromMail(mail);
  const v = await authChild.request(
    'GET',
    `/api/portal/auth/verify?token=${encodeURIComponent(token)}&purpose=portal`,
  );
  assertEqual(v.status, 200, `verify for ${email} should be 200 (got ${v.status}: ${v.text})`);
  const cookie =
    cookieFrom(v.headers, 'imk_admin_session') || cookieFrom(v.headers, 'imk_session');
  assert(cookie, `no session cookie was issued for ${email}`);
  return { cookie, role: v.json.role };
}

// ---------------------------------------------------------------------------
// the suite
// ---------------------------------------------------------------------------
async function main() {
  fs.mkdirSync(SANDBOX, { recursive: true });
  fs.mkdirSync(WORK, { recursive: true });
  fs.mkdirSync(PORTAL_DIR, { recursive: true });
  fs.mkdirSync(MODERATION_DIR, { recursive: true });
  fs.writeFileSync(CHILD_PATH, CHILD_SRC, 'utf8');
  seedInvited();

  const repoDigestBefore = repoDigest();

  // =====================================================================
  group('A', 'the session survives a per-file bundle boundary (F-2)');
  // =====================================================================

  let authBundle = null;
  let projectsBundle = null;
  let commentsBundle = null;
  let combinedBundle = null;
  let sessionBundle = null;

  if (groupEnabled) {
    [authBundle, projectsBundle, commentsBundle, combinedBundle, sessionBundle] = await Promise.all([
      bundle('auth'),
      bundle('projects'),
      bundle('comments'),
      bundle('combined'),
      bundle('session'),
    ]);
  }

  await t('A1', 'CONTROL: inside ONE bundle/process the session is accepted', async () => {
    const child = await startChild('a1-combined', combinedBundle);
    try {
      const before = child.mails().length;
      const r = await child.request('POST', '/api/portal/auth/request-link', {
        which: 'authHandler',
        origin: SITE_ORIGIN,
        ip: '203.0.113.10',
        body: JSON.stringify({ email: ADMIN_EMAIL }),
      });
      assertEqual(r.status, 200, `request-link should be 200 (got ${r.status}: ${r.text})`);
      const mail = child.mails().slice(before).find((m) => String(m.to).includes(ADMIN_EMAIL));
      assert(mail, 'no sign-in mail was captured');
      const token = tokenFromMail(mail);
      const v = await child.request(
        'GET',
        `/api/portal/auth/verify?token=${encodeURIComponent(token)}&purpose=portal`,
        { which: 'authHandler' },
      );
      assertEqual(v.status, 200, `verify should be 200 (got ${v.status}: ${v.text})`);
      const cookie = cookieFrom(v.headers, 'imk_admin_session');
      assert(cookie, 'no admin session cookie was issued');
      const p = await child.request('GET', '/api/portal/projects', {
        which: 'projectsHandler',
        cookie,
      });
      assertEqual(p.status, 200, `projects should be 200 (got ${p.status}: ${p.text})`);
      assert(p.json && p.json.ok === true, `the projects answer is not ok: ${p.text}`);
      return 'one bundle: request-link 200, verify 200, projects 200';
    } finally {
      await child.stop();
    }
  });

  await t('A2', 'a session minted by one bundle is accepted by ANOTHER bundle (Vercel)', async () => {
    const auth = await startChild('a2-auth', authBundle);
    const projects = await startChild('a2-projects', projectsBundle);
    try {
      const { cookie, role } = await signIn(auth, ADMIN_EMAIL, '203.0.113.11');
      const p = await projects.request('GET', '/api/portal/projects', { cookie });
      assert(
        p.status === 200,
        `the cookie minted in the auth bundle was refused by the projects bundle ` +
          `(status ${p.status}: ${p.text}) -- this is the F-2 defect`,
      );
      assert(p.json && p.json.ok === true, `the projects answer is not ok: ${p.text}`);
      return `role=${role}, cross-bundle projects -> 200`;
    } finally {
      await auth.stop();
      await projects.stop();
    }
  });

  await t('A3', 'the same cookie is accepted by a THIRD, freshly started process', async () => {
    const auth = await startChild('a3-auth', authBundle);
    const comments = await startChild('a3-comments', commentsBundle);
    try {
      const { cookie } = await signIn(auth, CLIENT_EMAIL, '203.0.113.12');
      const c = await comments.request('GET', '/api/portal/comments', { cookie });
      assert(
        c.status === 200,
        `the session was refused by a third process (status ${c.status}: ${c.text})`,
      );
      return 'a client session minted in one process is accepted in another';
    } finally {
      await auth.stop();
      await comments.stop();
    }
  });

  await t('A4', 'a client session carries its clientId and the projects are filtered by it', async () => {
    const auth = await startChild('a4-auth', authBundle);
    const projects = await startChild('a4-projects', projectsBundle);
    try {
      fs.writeFileSync(
        path.join(PORTAL_DIR, 'projects.jsonl'),
        JSON.stringify({
          id: 'prj_wave5_a',
          clientId: 'cli_wave5',
          title: 'Wave5 project A',
          status: 'completed',
        }) + '\n' +
          JSON.stringify({
            id: 'prj_wave5_b',
            clientId: 'cli_other',
            title: 'Wave5 project B',
            status: 'completed',
          }) + '\n',
        'utf8',
      );
      const { cookie, role } = await signIn(auth, CLIENT_EMAIL, '203.0.113.13');
      assertEqual(role, 'client', `the invited client should get the client role (got ${role})`);
      const p = await projects.request('GET', '/api/portal/projects', { cookie });
      assertEqual(p.status, 200, `projects should be 200 (got ${p.status}: ${p.text})`);
      const list = (p.json && p.json.projects) || [];
      assertEqual(list.length, 1, `the client should see exactly its own project (got ${list.length})`);
      assertEqual(list[0].id, 'prj_wave5_a', 'the wrong project was returned');
      return '1 of 2 projects visible; the foreign one is filtered out';
    } finally {
      await auth.stop();
      await projects.stop();
    }
  });

  await t('A5', 'a FORGED cookie is refused by every bundle', async () => {
    const auth = await startChild('a5-auth', authBundle);
    const projects = await startChild('a5-projects', projectsBundle);
    try {
      const forged = 'v1.eyJlIjoiY2xpZW50QGltay50ZXN0IiwiciI6ImNsaWVudCIsIngiOjk5OTk5OTk5OTk5OTk5fQ.deadbeef';
      const p = await projects.request('GET', '/api/portal/projects', {
        cookie: `imk_session=${forged}`,
      });
      assertEqual(p.status, 401, `a forged cookie must be 401 (got ${p.status}: ${p.text})`);
      assert(p.json && p.json.code === 'unauthorized', `unexpected body: ${p.text}`);
      const a = await projects.request('GET', '/api/portal/projects', {
        cookie: `imk_admin_session=${forged}`,
      });
      assertEqual(a.status, 401, `a forged admin cookie must be 401 too (got ${a.status}: ${a.text})`);
      return '401 {code:unauthorized} for both cookie names';
    } finally {
      await auth.stop();
      await projects.stop();
    }
  });

  await t('A6', 'in production without a signing secret NO session can be minted', async () => {
    const child = await startChild('a6-nosecret', sessionBundle, {
      env: { PORTAL_SESSION_SECRET: '', PORTAL_MAGIC_LINK_SECRET: '' },
    });
    try {
      const configured = await child.send({ cmd: 'session', op: 'configured' });
      assertEqual(configured.configured, false, 'the session must report no secret');
      const created = await child.send({
        cmd: 'session',
        op: 'create',
        email: ADMIN_EMAIL,
        role: 'admin',
      });
      assertEqual(created.token, null, 'createSession must return null without a secret');
      const auth = await startChild('a6-auth', authBundle, {
        env: { PORTAL_SESSION_SECRET: '', PORTAL_MAGIC_LINK_SECRET: '' },
      });
      try {
        const r = await auth.request('POST', '/api/portal/auth/request-link', {
          origin: SITE_ORIGIN,
          ip: '203.0.113.14',
          body: JSON.stringify({ email: ADMIN_EMAIL }),
        });
        assertEqual(r.status, 500, `a misconfigured instance must answer 500 (got ${r.status}: ${r.text})`);
        assert(r.json && r.json.code === 'internal', `unexpected body: ${r.text}`);
        const cookie = cookieFrom(r.headers, 'imk_session');
        assert(!cookie, 'no session cookie may be issued without a secret');
      } finally {
        await auth.stop();
      }
      return 'createSession -> null, request-link -> 500 {code:internal}, no cookie';
    } finally {
      await child.stop();
    }
  });

  await t('A7', 'a token signed with another secret is refused; the right secret still works', async () => {
    const signer = await startChild('a7-signer', sessionBundle);
    const other = await startChild('a7-other', sessionBundle, {
      env: { PORTAL_SESSION_SECRET: OTHER_SESSION_SECRET },
    });
    const same = await startChild('a7-same', sessionBundle);
    try {
      const created = await signer.send({
        cmd: 'session',
        op: 'create',
        email: CLIENT_EMAIL,
        role: 'client',
        clientId: 'cli_wave5',
      });
      assert(created.token, 'no token was minted');
      assertEqual(created.token.split('.').length, 3, `unexpected token shape: ${created.token}`);
      const wrong = await other.send({ cmd: 'session', op: 'parse', token: created.token });
      assertEqual(wrong.session, null, 'a token signed with another secret must not parse');
      const right = await same.send({ cmd: 'session', op: 'parse', token: created.token });
      assert(right.session, 'the token must parse in another process with the right secret');
      assertEqual(right.session.email, CLIENT_EMAIL, 'the payload email is wrong');
      assertEqual(right.session.clientId, 'cli_wave5', 'the payload clientId is wrong');
      return 'v1.<payload>.<sig>; another secret -> null, the right secret -> the session';
    } finally {
      await signer.stop();
      await other.stop();
      await same.stop();
    }
  });

  await t('A8', 'the shared session module is edge-safe and BOTH trees re-export it', async () => {
    const shared = path.join(SHARED_DIR, 'server', 'portal-session.ts');
    assert(fs.existsSync(shared), `the shared session module is missing: ${shared}`);
    const text = fs.readFileSync(shared, 'utf8');
    assert(
      !/from\s+['"]node:/.test(text),
      'the shared session module imports a node: builtin -- it cannot load in a Worker',
    );
    const vercel = fs.readFileSync(path.join(API_DIR, 'portal', 'session.ts'), 'utf8');
    const edge = fs.readFileSync(path.join(CF_DIR, 'api', 'portal', 'session.ts'), 'utf8');
    for (const [name, text2] of [['api/portal/session.ts', vercel], ['site/functions/api/portal/session.ts', edge]]) {
      assert(
        /shared\/server\/portal-session\.js/.test(text2),
        `${name} does not re-export the shared session module -- the trees can drift again`,
      );
      assert(
        !/new Map<string,\s*SessionEntry>|__portalSessions/.test(text2),
        `${name} still holds its own session Map`,
      );
    }
    return 'no node: imports; both trees re-export site/shared/server/portal-session.ts';
  });

  // =====================================================================
  group('B', 'writeReviews fails closed (F-3)');
  // =====================================================================

  let moderateBundle = null;
  if (groupEnabled) moderateBundle = await bundle('moderate');

  await t('B1', 'CONTROL: a valid moderation link approves and the store is updated', async () => {
    seedReview('pending');
    const child = await startChild('b1-moderate', moderateBundle);
    try {
      const ts = Math.floor(Date.now() / 1000);
      // The DECISION is the POST (M-1, wave-8A).
      const r = await child.request('POST', '/api/moderate/review', {
        body: qaModerationForm('inq_wave5', 'approve', 1, ts),
        headers: FORM_HEADERS,
      });
      assertEqual(r.status, 200, `approve should be 200 (got ${r.status}: ${r.text})`);
      assert(r.json && r.json.state === 'approved', `unexpected body: ${r.text}`);
      const rows = readJsonl(REVIEWS_FILE);
      assertEqual(rows.length, 1, 'the store should hold exactly one record');
      assertEqual(rows[0].state, 'approved', 'the store was not updated');
      return `approved and written to ${path.basename(REVIEWS_FILE)}`;
    } finally {
      await child.stop();
    }
  });

  await t('B1b', 'M-1: a GET on the signed link shows the confirmation page and decides NOTHING', async () => {
    seedReview('pending');
    const child = await startChild('b1b-moderate', moderateBundle);
    try {
      const ts = Math.floor(Date.now() / 1000);
      // What every mail scanner does by itself: fetch the link.
      const page = await child.request('GET', qaModerationPath('inq_wave5', 'approve', 1, ts));
      assertEqual(page.status, 200, `the GET must serve the confirmation page (got ${page.status}: ${page.text})`);
      assert(
        /<form[^>]*method="POST"/i.test(page.text),
        'the confirmation page must offer a POST form (a GET must never decide)',
      );
      const rows = readJsonl(REVIEWS_FILE);
      assertEqual(rows.length, 1, 'the store must not grow');
      assertEqual(rows[0].state, 'pending', 'a GET must not approve anything');
      assertEqual(rows[0].decidedAt, undefined, 'a GET must not stamp a decision time');

      // ...and the POST of the same link is the decision.
      const decided = await child.request('POST', '/api/moderate/review', {
        body: qaModerationForm('inq_wave5', 'approve', 1, ts),
        headers: FORM_HEADERS,
      });
      assertEqual(decided.status, 200, `the POST must decide (got ${decided.status}: ${decided.text})`);
      assert(decided.json && decided.json.state === 'approved', `unexpected body: ${decided.text}`);
      assertEqual(readJsonl(REVIEWS_FILE)[0].state, 'approved', 'the store was not updated');
      return 'the GET served the page and approved nothing; the POST approved the quote';
    } finally {
      await child.stop();
    }
  });

  await t('B2', 'a MISSING store answers 501, never 404 "review not found"', async () => {
    rmrf(REVIEWS_FILE);
    const child = await startChild('b2-moderate', moderateBundle);
    try {
      const ts = Math.floor(Date.now() / 1000);
      const r = await child.request('GET', qaModerationPath('inq_wave5', 'approve', 1, ts));
      assertEqual(r.status, 501, `a missing store must be 501 (got ${r.status}: ${r.text})`);
      assert(r.json && r.json.code === 'unimplemented', `unexpected body: ${r.text}`);
      assert(
        !/review not found/.test(r.text),
        `the answer still says "review not found" -- that reads as "your quote is gone" (${r.text})`,
      );
      return `501 {code:'unimplemented'}`;
    } finally {
      await child.stop();
    }
  });

  await t('B3', 'a CORRUPT store answers 500 {code:storage} with no stack trace', async () => {
    seedReview('pending');
    fs.appendFileSync(REVIEWS_FILE, '{ this is not json\n', 'utf8');
    const before = fs.readFileSync(REVIEWS_FILE, 'utf8');
    const child = await startChild('b3-moderate', moderateBundle);
    try {
      const ts = Math.floor(Date.now() / 1000);
      const r = await child.request('GET', qaModerationPath('inq_wave5', 'approve', 1, ts));
      assertEqual(r.status, 500, `a corrupt store must be 500 (got ${r.status}: ${r.text})`);
      assert(r.json && r.json.code === 'storage', `unexpected body: ${r.text}`);
      assert(
        !/\bat\s+\S+\s+\(/.test(r.text) && !/Error:/.test(r.text),
        `the answer leaks a stack trace: ${r.text.slice(0, 200)}`,
      );
      assertEqual(
        fs.readFileSync(REVIEWS_FILE, 'utf8'),
        before,
        'the corrupt store was rewritten',
      );
      return `500 {code:'storage'}, the store is untouched`;
    } finally {
      await child.stop();
    }
  });

  await t('B4', 'an UNWRITABLE store answers 500 {code:storage} and approves NOTHING', async () => {
    seedReview('pending');
    const child = await startChild('b4-moderate', moderateBundle);
    try {
      // Make the store file read-only: on Windows that sets the read-only
      // attribute, and writeFileSync then fails with EPERM.
      fs.chmodSync(REVIEWS_FILE, 0o444);
      let r;
      try {
        const ts = Math.floor(Date.now() / 1000);
        // The DECISION is the POST (M-1, wave-8A).
        r = await child.request('POST', '/api/moderate/review', {
          body: qaModerationForm('inq_wave5', 'approve', 1, ts),
          headers: FORM_HEADERS,
        });
      } finally {
        fs.chmodSync(REVIEWS_FILE, 0o644);
      }
      assert(!r.threw, `the handler threw instead of answering: ${r.error}`);
      assertEqual(r.status, 500, `an unwritable store must be 500 (got ${r.status}: ${r.text})`);
      assert(r.json && r.json.code === 'storage', `unexpected body: ${r.text}`);
      assert(!/approved/.test(r.text), `the answer claims an approval: ${r.text}`);
      const rows = readJsonl(REVIEWS_FILE);
      assertEqual(rows[0].state, 'pending', 'the store was changed even though the write failed');
      return '500 {code:storage}, no throw, the record is still pending';
    } finally {
      await child.stop();
    }
  });

  await t('B5', 'the Cloudflare twin with NO filesystem answers 501 (the real edge runtime)', async () => {
    const cfBundle = await bundle('cfModerate');
    const cf = require(cfBundle);
    // The real edge runtime has no `require` at all: there is no filesystem,
    // so there is no moderation store. That must read as "this target cannot
    // moderate", never as "this review does not exist".
    delete globalThis.require;
    const ts = Math.floor(Date.now() / 1000);
    const url = `https://imk.test${qaModerationPath('inq_wave5', 'approve', 1, ts)}`;
    const res = await cf.onRequestGet({
      request: new Request(url, { method: 'GET' }),
      env: {
        SITE_BASE_URL: SITE_ORIGIN,
        FORM_WEBHOOK_SECRET: SECRET,
        RESEND_API_KEY: 'qa-wave5-resend-key',
        RESEND_TO: ADMIN_EMAIL,
      },
      params: {},
    });
    let body = null;
    try {
      body = await res.clone().json();
    } catch {
      /* not json */
    }
    assertEqual(res.status, 501, `the CF twin must answer 501 without a store (got ${res.status})`);
    assertEqual(body.code, 'unimplemented', `unexpected body: ${JSON.stringify(body)}`);
    assert(
      !/review not found/.test(JSON.stringify(body)),
      'the answer says "review not found" -- that reads as "your quote is gone"',
    );
    return '501 {code:unimplemented} with no filesystem';
  });

  await t('B6', 'the Cloudflare twin answers the SAME codes as the Vercel tree (tree parity)', async () => {
    const cfBundle = await bundle('cfModerate');
    const cf = require(cfBundle);
    const realFs = require('node:fs');
    const prevCwd = process.cwd();
    globalThis.require = (id) => {
      if (id === 'node:fs') {
        return {
          existsSync: (p) => realFs.existsSync(path.resolve(process.cwd(), p)),
          readFileSync: (p, enc) => realFs.readFileSync(path.resolve(process.cwd(), p), enc),
          writeFileSync: (p, data, enc) => realFs.writeFileSync(path.resolve(process.cwd(), p), data, enc),
          mkdirSync: (p, opts) => realFs.mkdirSync(path.resolve(process.cwd(), p), opts),
          // The moderation log is written ATOMICALLY (temp file + rename), so
          // a mock without renameSync fails exactly where the decision is
          // written.
          renameSync: (from, to) =>
            realFs.renameSync(path.resolve(process.cwd(), from), path.resolve(process.cwd(), to)),
        };
      }
      return require(id);
    };
    const call = async () => {
      const ts = Math.floor(Date.now() / 1000);
      const url = `https://imk.test${qaModerationPath('inq_wave5', 'approve', 1, ts)}`;
      const res = await cf.onRequestGet({
        request: new Request(url, { method: 'GET' }),
        env: {
          SITE_BASE_URL: SITE_ORIGIN,
          FORM_WEBHOOK_SECRET: SECRET,
          RESEND_API_KEY: 'qa-wave5-resend-key',
          RESEND_TO: ADMIN_EMAIL,
        },
        params: {},
      });
      let body = null;
      try {
        body = await res.clone().json();
      } catch {
        /* not json */
      }
      return { status: res.status, body };
    };
    try {
      process.chdir(SANDBOX);
      // 1. a corrupt store -- both trees must answer 500 {code:'storage'}
      seedReview('pending');
      fs.appendFileSync(REVIEWS_FILE, '{ not json\n', 'utf8');
      const corrupt = await call();
      assertEqual(corrupt.status, 500, `the CF twin must answer 500 for a corrupt store (got ${corrupt.status})`);
      assertEqual(corrupt.body.code, 'storage', `unexpected body: ${JSON.stringify(corrupt.body)}`);

      // 2. a MISSING store -- the Vercel tree answers 501 {code:'unimplemented'}
      rmrf(REVIEWS_FILE);
      const missing = await call();
      assertEqual(
        missing.status,
        501,
        `the CF twin must answer 501 for a missing store like the Vercel tree ` +
          `(got ${missing.status}: ${JSON.stringify(missing.body)}) -- a 404 reads as "your quote is gone"`,
      );
      assertEqual(missing.body.code, 'unimplemented', `unexpected body: ${JSON.stringify(missing.body)}`);
      return 'missing -> 501, corrupt -> 500 (the same codes as the Vercel tree)';
    } finally {
      process.chdir(prevCwd);
      delete globalThis.require;
    }
  });

  // =====================================================================
  group('C', 'the durable counter survives a lock race (F-4)');
  // =====================================================================

  let rateBundle = null;
  if (groupEnabled) rateBundle = await bundle('rate');

  await t('C1', 'CONTROL: one process, N keys -> N buckets with the exact counts', async () => {
    rmrf(COUNTER_FILE);
    const child = await startChild('c1-rate', rateBundle, {
      env: { PORTAL_RATE_LIMIT_FILE: COUNTER_FILE },
    });
    try {
      for (let i = 0; i < 10; i++) {
        const r = await child.send({ cmd: 'rate', key: `client:qa${i}@imk.test`, limit: 100, windowMs: 3600000 });
        assert(r.ok, `the hit failed: ${r.error}`);
        assertEqual(r.decision.count, 1, `the count is wrong for key ${i}`);
      }
      const state = JSON.parse(fs.readFileSync(COUNTER_FILE, 'utf8'));
      const keys = Object.keys(state.buckets || {});
      assertEqual(keys.length, 10, `the counter file should hold 10 buckets (got ${keys.length})`);
      for (const k of keys) {
        assertEqual(state.buckets[k].count, 1, `bucket ${k} has the wrong count`);
      }
      return `10 buckets, all count 1`;
    } finally {
      await child.stop();
    }
  });

  await t('C2', '4 concurrent writer processes x 10 keys x 4 rounds -> nothing is lost', async () => {
    rmrf(COUNTER_FILE);
    rmrf(LOCK_FILE);
    const writers = [];
    for (let w = 0; w < 4; w++) {
      writers.push(
        startChild(`c2-rate-${w}`, rateBundle, { env: { PORTAL_RATE_LIMIT_FILE: COUNTER_FILE } }),
      );
    }
    const childrenC2 = await Promise.all(writers);
    try {
      const rounds = 4;
      const keys = 10;
      await Promise.all(
        childrenC2.map(async (child) => {
          for (let round = 0; round < rounds; round++) {
            for (let k = 0; k < keys; k++) {
              const r = await child.send({
                cmd: 'rate',
                key: `race:${k}`,
                limit: 1000,
                windowMs: 3600000,
              });
              assert(r.ok, `a hit failed: ${r.error}`);
            }
          }
        }),
      );
      const expected = 4 * rounds; // every writer hit every key every round
      const state = JSON.parse(fs.readFileSync(COUNTER_FILE, 'utf8'));
      const buckets = state.buckets || {};
      assertEqual(
        Object.keys(buckets).length,
        keys,
        `the counter file holds ${Object.keys(buckets).length} buckets, expected ${keys}`,
      );
      const lost = [];
      for (const [k, v] of Object.entries(buckets)) {
        if (v.count !== expected) lost.push(`${k}=${v.count}`);
      }
      assert(
        lost.length === 0,
        `${lost.length} bucket(s) lost hits (expected ${expected} each): ${lost.slice(0, 5).join(', ')}`,
      );
      return `4 writers x ${keys} keys x ${rounds} rounds -> every bucket holds exactly ${expected}`;
    } finally {
      for (const child of childrenC2) await child.stop();
    }
  });

  await t('C3', 'a lock file that EXISTS (EEXIST) is waited out, not treated as broken', async () => {
    rmrf(COUNTER_FILE);
    rmrf(LOCK_FILE);
    const child = await startChild('c3-rate', rateBundle, {
      env: { PORTAL_RATE_LIMIT_FILE: COUNTER_FILE },
    });
    try {
      fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true });
      fs.writeFileSync(LOCK_FILE, 'held by QA', 'utf8');
      const pending = child.send({ cmd: 'rate', key: 'busy:eexist', limit: 100, windowMs: 3600000 });
      await new Promise((r) => setTimeout(r, 800));
      rmrf(LOCK_FILE);
      const r = await pending;
      assert(r.ok, `the hit failed instead of waiting for the lock: ${r.error}`);
      assertEqual(r.decision.count, 1, `the count is wrong: ${JSON.stringify(r.decision)}`);
      assertEqual(r.decision.degraded, false, 'the limiter degraded even though the lock was merely busy');
      const log = child.log();
      assert(
        !/rate_limit_degraded/.test(log),
        `the limiter logged a degradation for a busy lock:\n${log}`,
      );
      const state = JSON.parse(fs.readFileSync(COUNTER_FILE, 'utf8'));
      assertEqual(Object.keys(state.buckets || {}).length, 1, 'the hit did not reach the durable counter');
      return 'the writer waited for the lock and the durable counter was used';
    } finally {
      await child.stop();
    }
  });

  await t('C4', 'a DELETE-PENDING lock (EPERM) is waited out and the counter is NOT abandoned', async () => {
    rmrf(COUNTER_FILE);
    rmrf(LOCK_FILE);
    const child = await startChild('c4-rate', rateBundle, {
      env: { PORTAL_RATE_LIMIT_FILE: COUNTER_FILE },
    });
    try {
      fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true });
      // Open the lock and unlink it while the handle is still open: on Windows
      // the file is DELETE-PENDING and `open(..., 'wx')` on it fails with
      // EPERM -- a transient, NORMAL condition that used to be classified as
      // "the backend is broken" and latched backendFailed for the process.
      const fd = fs.openSync(LOCK_FILE, 'wx');
      fs.unlinkSync(LOCK_FILE);
      const pending = child.send({ cmd: 'rate', key: 'busy:eperm', limit: 100, windowMs: 3600000 });
      await new Promise((r) => setTimeout(r, 800));
      fs.closeSync(fd);
      const r = await pending;
      assert(r.ok, `the hit failed instead of waiting for the lock: ${r.error}`);
      assertEqual(r.decision.count, 1, `the count is wrong: ${JSON.stringify(r.decision)}`);
      assertEqual(r.decision.degraded, false, 'the limiter degraded on a busy lock');
      const log = child.log();
      assert(!/rate_limit_degraded/.test(log), `the limiter logged a degradation:\n${log}`);

      // The latch: the NEXT hit in the SAME process must still reach the
      // durable counter. If backendFailed were latched, the file would stay
      // at 1 and the cross-process limit would silently stop being enforced.
      const again = await child.send({ cmd: 'rate', key: 'busy:eperm', limit: 100, windowMs: 3600000 });
      assert(again.ok, `the second hit failed: ${again.error}`);
      const state = JSON.parse(fs.readFileSync(COUNTER_FILE, 'utf8'));
      const bucket = Object.values(state.buckets || {})[0];
      assert(bucket, 'the durable counter file is empty');
      assertEqual(
        bucket.count,
        2,
        `the durable counter holds ${bucket.count} after two hits -- the limiter latched backendFailed`,
      );
      const platform = process.platform === 'win32' ? 'EPERM (delete-pending)' : 'EEXIST (POSIX has no delete-pending)';
      return `busy code ${platform} waited out; the durable counter still holds both hits`;
    } finally {
      await child.stop();
    }
  });

  await t('C5', 'a genuinely broken backend degrades instead of failing the request', async () => {
    // A file where a directory is expected: mkdirSync fails with ENOTDIR.
    const blocker = path.join(SANDBOX, 'rate-blocker');
    fs.writeFileSync(blocker, 'this is a file, not a directory', 'utf8');
    const broken = path.join(blocker, 'counters.json');
    const child = await startChild('c5-rate', rateBundle, {
      env: { PORTAL_RATE_LIMIT_FILE: broken },
    });
    try {
      const r = await child.send({ cmd: 'rate', key: 'broken:backend', limit: 100, windowMs: 3600000 });
      assert(r.ok, `a broken backend must not fail the request: ${r.error}`);
      assertEqual(r.decision.degraded, true, 'the decision must report the degradation');
      assertEqual(r.decision.count, 1, 'the fallback counter did not take over');
      const log = child.log();
      const lines = log.split(/\r?\n/).filter((l) => l.includes('rate_limit_degraded'));
      assertEqual(lines.length, 1, `the degradation must be logged ONCE (found ${lines.length} lines)`);
      assert(/"code"\s*:\s*"[^"]+"/.test(lines[0]), `the log line carries no error code: ${lines[0]}`);
      // A second hit must not log again.
      const r2 = await child.send({ cmd: 'rate', key: 'broken:backend', limit: 100, windowMs: 3600000 });
      assert(r2.ok, `the second hit failed: ${r2.error}`);
      const lines2 = child.log().split(/\r?\n/).filter((l) => l.includes('rate_limit_degraded'));
      assertEqual(lines2.length, 1, `the degradation was logged ${lines2.length} times`);
      return `degraded:true, one log line with a code: ${lines[0].slice(0, 120)}`;
    } finally {
      await child.stop();
    }
  });

  await t('C6', 'the durable counter holds no client id and no IP', async () => {
    rmrf(COUNTER_FILE);
    const child = await startChild('c6-rate', rateBundle, {
      env: { PORTAL_RATE_LIMIT_FILE: COUNTER_FILE },
    });
    try {
      await child.send({ cmd: 'rate', key: 'client:alice@imk.test', limit: 100, windowMs: 3600000 });
      await child.send({ cmd: 'rate', key: 'ip:203.0.113.77', limit: 100, windowMs: 3600000 });
      const raw = fs.readFileSync(COUNTER_FILE, 'utf8');
      assert(!/alice@imk\.test/.test(raw), 'the client address is written to the counter file');
      assert(!/203\.0\.113\.77/.test(raw), 'the IP address is written to the counter file');
      assert(!/client:|ip:/.test(raw), 'the raw key is written to the counter file');
      const state = JSON.parse(raw);
      for (const k of Object.keys(state.buckets || {})) {
        assert(/^[0-9a-f]{64}$/.test(k), `the bucket key is not a SHA-256 hex digest: ${k}`);
      }
      return `${Object.keys(state.buckets).length} buckets, every key a 64-hex SHA-256`;
    } finally {
      await child.stop();
    }
  });

  await t('C7', 'the edge twin degrades the same way (a throwing KV)', async () => {
    const cfBundle = await bundle('cfRate');
    const cf = require(cfBundle);
    const lines = [];
    const origLog = console.log;
    console.log = (...args) => {
      lines.push(args.map(String).join(' '));
    };
    try {
      const kv = {
        get: async () => null,
        put: async () => {
          const err = new Error('kv is down');
          err.code = 'ECONNREFUSED';
          throw err;
        },
      };
      const limiter = new cf.RateLimiter(cf.createKvBackend(kv));
      const d = await limiter.consume('client:alice@imk.test', 5, 3600000);
      assertEqual(d.degraded, true, 'the edge limiter must degrade, not fail');
      assertEqual(d.count, 1, 'the fallback counter did not take over');
      const degradations = lines.filter((l) => l.includes('rate_limit_degraded'));
      assertEqual(degradations.length, 1, `the degradation must be logged ONCE (found ${degradations.length})`);
      assert(/"code"\s*:\s*"[^"]+"/.test(degradations[0]), `the log line carries no error code: ${degradations[0]}`);
      return `degraded:true, one log line: ${degradations[0].slice(0, 120)}`;
    } finally {
      console.log = origLog;
    }
  });

  // =====================================================================
  group('D', 'mutation probes -- the checks are not vacuous');
  // =====================================================================

  /**
   * Run THIS suite again, in a child process, against a patched copy of the
   * tree. The copy is the thing under test; the repository is never touched.
   */
  function runSuiteAgainst(apiDir, sharedDir, only) {
    const outFile = path.join(WORK, `probe-${only}-${crypto.randomBytes(4).toString('hex')}.json`);
    let code = 0;
    let stdout = '';
    try {
      stdout = execFileSync(
        process.execPath,
        [SELF, '--json', outFile, '--only', only],
        {
          cwd: SITE,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            QA_W5_API_DIR: apiDir,
            QA_W5_SHARED_DIR: sharedDir,
            QA_W5_CHILD: '1',
          },
        },
      );
    } catch (err) {
      code = typeof err.status === 'number' ? err.status : 1;
      stdout = `${stdout || ''}${err.stdout || ''}${err.stderr || ''}`;
    }
    let parsed = null;
    try {
      parsed = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    } catch (err) {
      // The child died before it could write its report: say so with the
      // child's own output instead of an ENOENT that hides the cause.
      throw new Error(
        `the probe run produced no report (${err.message}). The child said:\n${stdout.slice(0, 4000)}`,
      );
    }
    return { code, results: parsed.results, stdout };
  }

  function statusOf(results, id) {
    const r = results.find((x) => x.id === id);
    return r ? r.status : 'MISSING';
  }

  /** Copy the api/ + site/shared trees so a defect can be put back safely. */
  function copyTree(name) {
    const root = path.join(WORK, `copy-${name}`);
    rmrf(root);
    copyDir(API_DIR, path.join(root, 'api'));
    copyDir(SHARED_DIR, path.join(root, 'site', 'shared'));
    return root;
  }

  /** Replace a whole function body (matched by braces) in a file. */
  function replaceFunction(file, signature, replacement) {
    const raw = fs.readFileSync(file, 'utf8');
    const at = raw.indexOf(signature);
    if (at === -1) throw new Error(`the patch anchor was not found in ${file}: ${signature}`);
    const open = raw.indexOf('{', at);
    let depth = 0;
    let end = -1;
    for (let i = open; i < raw.length; i++) {
      if (raw[i] === '{') depth++;
      else if (raw[i] === '}') {
        depth--;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    if (end === -1) throw new Error(`the patch anchor is not balanced in ${file}`);
    fs.writeFileSync(file, raw.slice(0, at) + replacement + raw.slice(end), 'utf8');
  }

  await t('D1', 'F-2 reverted (a Map session) -> the cross-bundle check goes RED', async () => {
    const root = copyTree('f2');
    const sessionFile = path.join(root, 'api', 'portal', 'session.ts');
    // The pre-wave-6 session: a module-scope Map. Each bundle gets its own
    // copy, so the cookie minted in one function is unknown to the next.
    fs.writeFileSync(
      sessionFile,
      [
        '// QA MUTATION (F-2): the session used to be a module-scope Map.',
        "const sessions = new Map<string, any>();",
        'function nowMs() { return Date.now(); }',
        'export function isProductionEnv(env?: any): boolean {',
        "  const e = env || (globalThis as any).process?.env || {};",
        "  return (e.APP_ENV || 'production') === 'production';",
        '}',
        'export function sessionSecret(env?: any): string | null {',
        "  const e = env || (globalThis as any).process?.env || {};",
        "  return (e.PORTAL_SESSION_SECRET || e.PORTAL_MAGIC_LINK_SECRET || 'qa-mutation') || null;",
        '}',
        'export function sessionSecretConfigured(env?: any): boolean { return sessionSecret(env) !== null; }',
        'export function createSession(email: string, role: any, clientId?: string, env?: any): string | null {',
        "  const token = 'qa_' + Math.random().toString(16).slice(2) + nowMs().toString(16);",
        '  sessions.set(token, { email: email, role: role, clientId: clientId, expires: nowMs() + 86400000 });',
        '  return token;',
        '}',
        'export function parseSession(token: string, env?: any): any {',
        '  const s = sessions.get(token);',
        '  if (!s) return null;',
        '  if (nowMs() > s.expires) { sessions.delete(token); return null; }',
        '  const out: any = { email: s.email, role: s.role };',
        '  if (s.clientId) out.clientId = s.clientId;',
        '  return out;',
        '}',
        'export function destroySession(token: string): void { sessions.delete(token); }',
        'export function readSessionCookies(source: any): any {',
        "  const headers = (source && source.headers) || {};",
        '  const raw = typeof headers.get === "function" ? headers.get("cookie") : headers.cookie;',
        '  const out: any = {};',
        "  for (const part of String(raw || '').split(';')) {",
        '    const eq = part.indexOf("=");',
        '    if (eq === -1) continue;',
        '    const name = part.slice(0, eq).trim();',
        '    const value = part.slice(eq + 1).trim();',
        '    if (!value) continue;',
        '    if (name === "imk_session" && out.client === undefined) out.client = value;',
        '    if (name === "imk_admin_session" && out.admin === undefined) out.admin = value;',
        '  }',
        '  return out;',
        '}',
        'export function readSessionCookie(source: any): string | null {',
        '  const c = readSessionCookies(source);',
        '  return c.client || c.admin || null;',
        '}',
        'export function resolveSession(source: any, preferRole?: any, env?: any): any {',
        '  const cookies = readSessionCookies(source);',
        "  const order = preferRole ? [preferRole, preferRole === 'admin' ? 'client' : 'admin'] : ['admin', 'client'];",
        '  for (const role of order) {',
        '    const token = cookies[role === "admin" ? "admin" : "client"];',
        '    if (!token) continue;',
        '    const s = parseSession(token, env);',
        '    if (s) return s;',
        '  }',
        '  return null;',
        '}',
        "export function sessionCookieName(role: any): string { return role === 'admin' ? 'imk_admin_session' : 'imk_session'; }",
        'export function sessionCookieString(token: string, role: any, isSecure: boolean): string {',
        '  const attrs = [',
        '    sessionCookieName(role) + "=" + token,',
        '    "Path=/",',
        '    "HttpOnly",',
        '    "SameSite=Strict",',
        '    isSecure ? "Secure" : "",',
        '    "Max-Age=86400",',
        '  ].filter(Boolean).join("; ");',
        '  return attrs;',
        '}',
        'export function clearSessionCookieString(role: any): string {',
        '  return sessionCookieName(role) + "=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0";',
        '}',
        'export function configuredBaseUrl(env?: any): string | null {',
        "  const e = env || (globalThis as any).process?.env || {};",
        "  const raw = String((e.SITE_BASE_URL || e.SITE_URL || '').trim());",
        '  return raw ? raw.replace(/\\/$/, "") : null;',
        '}',
        'export function baseUrl(env?: any): string { return configuredBaseUrl(env) || "http://localhost:4321"; }',
        'export function baseUrlConfigured(env?: any): boolean { return !!configuredBaseUrl(env) || !isProductionEnv(env); }',
        'export function isSecureBaseUrl(env?: any): boolean { return baseUrl(env).indexOf("https://") === 0; }',
        'export function expectedOrigin(env?: any): string { return new URL(baseUrl(env)).origin; }',
        // The tree imports the access helpers from './session.js' as well, so
        // the fake has to provide them: without them the MUTATED COPY does
        // not even build, and the probe would prove nothing.
        'export function sessionSecretProblem(env?: any): string | null {',
        "  const e = env || (globalThis as any).process?.env || {};",
        "  const raw = String((e.PORTAL_SESSION_SECRET || e.PORTAL_MAGIC_LINK_SECRET || '').trim());",
        "  if (!raw) return isProductionEnv(e) ? 'missing' : null;",
        '  if (!isProductionEnv(e)) return null;',
        "  return raw.length < 32 ? 'too-short' : null;",
        '}',
        'export function adminEmailsConfigured(env?: any): boolean {',
        "  const e = env || (globalThis as any).process?.env || {};",
        "  return String(e.ADMIN_EMAILS || '').split(',').map((x: string) => x.trim().toLowerCase()).filter(Boolean).length > 0;",
        '}',
        'export function isAdminEmail(email: string, env?: any): boolean {',
        "  const e = env || (globalThis as any).process?.env || {};",
        "  const list = String(e.ADMIN_EMAILS || '').split(',').map((x: string) => x.trim().toLowerCase()).filter(Boolean);",
        '  return list.indexOf(String(email || "").trim().toLowerCase()) !== -1;',
        '}',
        'export function effectiveRole(session: any, env?: any): any {',
        '  if (!session) return null;',
        "  if (session.role !== 'admin') return 'client';",
        '  return isAdminEmail(session.email, env) ? "admin" : "client";',
        '}',
        'export function resolveAccess(source: any, env?: any): any {',
        '  const cookies = readSessionCookies(source);',
        '  const client = cookies.client ? parseSession(cookies.client, env) : null;',
        '  const admin = cookies.admin ? parseSession(cookies.admin, env) : null;',
        '  const owner = admin && admin.role === "admin" && isAdminEmail(admin.email, env) ? admin : null;',
        '  return { client: client, owner: owner, session: client || owner, any: client || admin };',
        '}',
        'export function resolveClientSession(source: any, env?: any): any { return resolveAccess(source, env).session; }',
        'export function canReadClient(access: any, clientId?: string): boolean {',
        '  if (access.client) {',
        '    if (!access.client.clientId) return false;',
        '    return access.client.clientId === clientId;',
        '  }',
        '  return !!access.owner;',
        '}',
        'export function canWriteClient(access: any, clientId?: string): boolean {',
        '  if (access.owner) return true;',
        '  if (!access.client || !access.client.clientId) return false;',
        '  return access.client.clientId === clientId;',
        '}',
        'export function resolveOwnerSession(source: any, env?: any, sessionEnv?: any): any {',
        '  const cookies = readSessionCookies(source);',
        '  if (!cookies.admin) return null;',
        '  const s = parseSession(cookies.admin, sessionEnv || env);',
        '  if (!s) return null;',
        "  if (s.role !== 'admin') return null;",
        '  if (!isAdminEmail(s.email, env)) return null;',
        '  return s;',
        '}',
        // The route file itself (wave-8A): the fake is a module, not a
        // handler, so the route answers "not found".
        'export default async function handler(req: any, res: any): Promise<void> {',
        "  res.writeHead(404, { 'Content-Type': 'application/json' });",
        "  res.end(JSON.stringify({ error: 'not found', code: 'not-found' }));",
        '}',
        '',
      ].join('\n'),
      'utf8',
    );
    const run = runSuiteAgainst(path.join(root, 'api'), path.join(root, 'site', 'shared'), 'A');
    const a2 = statusOf(run.results, 'A2');
    const a1 = statusOf(run.results, 'A1');
    assertEqual(a2, 'FAIL', `the cross-bundle check did not go red on the mutated copy (A2=${a2})`);
    assertEqual(a1, 'PASS', `the one-bundle control must still pass on the mutated copy (A1=${a1})`);
    assert(
      fs.readFileSync(sessionFile, 'utf8').includes('new Map<string, any>()'),
      'the mutation was not applied',
    );
    return `mutated copy: A1=${a1} (one bundle still works), A2=${a2} (cross-bundle is broken again)`;
  });

  await t('D2', 'F-3 reverted (an unguarded store failure) -> the unwritable-store check goes RED', async () => {
    const root = copyTree('f3');
    // Wave 9 moved the write into the store, so the old `writeReviews()`
    // function is gone. The DEFECT F-3 found is still there in a different
    // shape: a store failure that is NOT caught escapes the handler and the
    // request dies with an unhandled error instead of answering
    // 500 {code:'storage'}. The guard that prevents it lives in
    // site/shared/server/portal-store-access.ts — so that is what the
    // mutation removes.
    const accessFile = path.join(
      root,
      'site',
      'shared',
      'server',
      'portal-store-access.ts',
    );
    replaceFunction(
      accessFile,
      'export async function guardStore<T>(',
      [
        'export async function guardStore<T>(',
        '  fn: () => Promise<T> | T,',
        '  onError: (err: StorageError | StorageCorruptError) => T,',
        '): Promise<T> {',
        '  // QA MUTATION (F-3): the store failure is NOT guarded — it throws',
        '  // out of the handler, exactly as the old unguarded write did.',
        '  return await fn();',
        '}',
      ].join('\n'),
    );
    const run = runSuiteAgainst(path.join(root, 'api'), path.join(root, 'site', 'shared'), 'B');
    const b4 = statusOf(run.results, 'B4');
    assertEqual(b4, 'FAIL', `the unwritable-store check did not go red on the mutated copy (B4=${b4})`);
    const detail = (run.results.find((r) => r.id === 'B4') || {}).error || '';
    assert(
      /threw|throw|error/i.test(detail),
      `B4 failed for an unexpected reason: ${detail}`,
    );
    return `mutated copy: B4=${b4} (the handler throws out of the store failure again)`;
  });

  await t('D3', 'F-4 reverted (only EEXIST is busy) -> the delete-pending check goes RED', async () => {
    const root = copyTree('f4');
    const rateFile = path.join(root, 'api', 'lib', 'rate-limit.ts');
    const raw = fs.readFileSync(rateFile, 'utf8');
    const anchor = 'if (!LOCK_BUSY_CODES.has(code)) throw err;';
    assert(raw.includes(anchor), `the patch anchor was not found in ${rateFile}`);
    fs.writeFileSync(rateFile, raw.replace(anchor, "if (code !== 'EEXIST') throw err;"), 'utf8');
    const run = runSuiteAgainst(path.join(root, 'api'), path.join(root, 'site', 'shared'), 'C');
    const c4 = statusOf(run.results, 'C4');
    assertEqual(c4, 'FAIL', `the delete-pending check did not go red on the mutated copy (C4=${c4})`);
    const c3 = statusOf(run.results, 'C3');
    return `mutated copy: C3=${c3} (a merely busy lock is still fine), C4=${c4} (EPERM latches the backend again)`;
  });

  await t('D4', 'the repository is byte-identical after the probes', async () => {
    const after = repoDigest();
    assertEqual(after, repoDigestBefore, 'the repository changed during the suite');
    return 'the api/, site/shared/ and site/functions/ trees are byte-for-byte unchanged';
  });

  // ---------------------------------------------------------------------
  // cleanup
  // ---------------------------------------------------------------------
  for (const child of children) {
    try {
      await child.stop();
    } catch {
      /* ignore */
    }
  }

  const passed = results.filter((r) => r.status === 'PASS').length;
  const failed = results.filter((r) => r.status === 'FAIL').length;
  console.log(`\n[qa] ${results.length} checks: ${passed} PASS, ${failed} FAIL`);
  console.log(`[qa] sandbox: ${SANDBOX}${KEEP ? ' (kept)' : ''}`);

  if (JSON_OUT) {
    fs.mkdirSync(path.dirname(JSON_OUT), { recursive: true });
    fs.writeFileSync(
      JSON_OUT,
      JSON.stringify(
        {
          suite: 'qa-wave5-independent',
          startedAt: new Date().toISOString(),
          apiDir: API_DIR,
          sharedDir: SHARED_DIR,
          cfDir: CF_DIR,
          results,
          passed,
          failed,
        },
        null,
        2,
      ),
      'utf8',
    );
    console.log(`[qa] results: ${JSON_OUT}`);
  }

  if (!KEEP) rmrf(SANDBOX);
  return failed === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('[qa] the suite itself failed:', err);
    process.exit(2);
  });
