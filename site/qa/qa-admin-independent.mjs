// site/qa/qa-admin-independent.mjs
//
// QA-OWNED independent verification of the /admin owner inbox (wave 6, T7.14).
//
// WHY THIS FILE EXISTS
//   The Frontend Developer shipped the owner inbox and reported 31 checks of
//   their own. Their harness lives OUTSIDE the repo and is not repeatable in
//   CI, so nothing about the new admin endpoints is covered by the runner.
//   This file is QA's own evidence: it shares no helper with the Frontend's
//   harness, it builds its own bundles, signs with its own node:crypto and
//   spawns its own child processes.
//
// WHAT IS UNDER TEST
//   GET /api/admin/session   - "is this request the owner?"
//   GET /api/admin/reviews   - the owner's moderation queue
//   and the two of them TOGETHER with the moderation endpoint, because the
//   approve/reject action is only real if /api/moderate/review accepts the
//   link the inbox mints.
//
// WAVE 11 RE-PIN (2026-10-22)
//   E14 was re-pinned: wave 10 (F-6) rewrote the Cloudflare twin of the
//   inbox on purpose -- the JSONL read is GONE and that target answers
//   501 {code:'unimplemented'} instead of a queue. The old check demanded a
//   200 WITH A QUEUE from a target that cannot serve one, so it was pinning
//   behaviour the product deliberately no longer has. E14 now pins the NEW
//   contract (501 in both runtimes, the gate still first) and E16 proves the
//   re-pin still bites: a JSONL read put back into the CF inbox turns E14
//   RED.
//
// THE CONTRACT (spec/07 §7.3, A-9)
//   1. a SEPARATE cookie: `imk_admin_session` (the client one is
//      `imk_session`), so no admin capability can leak into the client path;
//   2. the session must resolve to role `admin`;
//   3. the session's email must be on the ADMIN_EMAILS allow-list, and that
//      list is read on EVERY request, so removing an address revokes access
//      immediately and not at the next token expiry;
//   4. every non-owner gets the SAME answer (401 {code:'unauthorized'}), so
//      the endpoint cannot be used to tell the states apart;
//   5. an unset allow-list is a MISCONFIGURATION (500 {code:'internal'}), never
//      "everybody is the owner".
//
// HOW THE SUITE SIMULATES THE RUNTIME
//   Each handler file is bundled SEPARATELY with esbuild and loaded in its own
//   CHILD PROCESS - Vercel builds one function per file under api/, and the
//   Cloudflare tree is a Worker, so the admin cookie is minted in one process
//   and presented to another. The child speaks JSON lines over stdin/stdout,
//   so the suite binds NO PORT AT ALL - 4321 (the running dev server) is never
//   touched. The Cloudflare twins are called through a Web Request, the way a
//   Worker calls them.
//
// ISOLATION
//   cwd     -> <sandbox>          the handlers resolve site/data/... from cwd
//   records -> <sandbox>          site/data/** in the repo is never touched
//   network -> global fetch stub, in the parent and in every child
//   repo    -> never modified; the mutation probe works on a COPY
//
// USAGE
//   node site/qa/qa-admin-independent.mjs
//   node site/qa/qa-admin-independent.mjs --keep
//   node site/qa/qa-admin-independent.mjs --json <ABSOLUTE path>
//   node site/qa/qa-admin-independent.mjs --only E6,E7

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { handlerPath, fwd } from './handler-paths.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const SITE = path.resolve(__dirname, '..');
const REPO = path.resolve(SITE, '..');

const argv = process.argv.slice(2);
const KEEP = argv.includes('--keep');
const JSON_OUT = argv.includes('--json')
  ? path.resolve(argv[argv.indexOf('--json') + 1])
  : null;
const ONLY = argv.includes('--only')
  ? new Set(argv[argv.indexOf('--only') + 1].split(',').map((s) => s.trim().toUpperCase()))
  : null;

// The module roots. The mutation probe points these at a COPY of the tree,
// which is how a defect is put back without touching the repository.
const API_DIR = path.resolve(process.env.QA_ADMIN_API_DIR || path.join(REPO, 'api'));
const SHARED_DIR = path.resolve(
  process.env.QA_ADMIN_SHARED_DIR || path.join(SITE, 'shared'),
);
const CF_DIR = path.resolve(process.env.QA_ADMIN_CF_DIR || path.join(SITE, 'functions'));

const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const SANDBOX = path.join(os.tmpdir(), 'opencode', `qa-admin-${STAMP}`);
const WORK = path.join(SANDBOX, 'work');

// H-1 (wave-8A): in production a secret that is PRESENT but UNUSABLE -- the
// published placeholder, or shorter than MIN_SECRET_LENGTH (32) -- is refused
// exactly like a missing one, so every fixture below is 32+ characters long.
const SECRET = 'qa-admin-form-webhook-secret-0123456789';
const MAGIC_SECRET = 'qa-admin-magic-link-secret-0123456789';
const SESSION_SECRET = 'qa-admin-session-secret-0123456789';
const ADMIN_EMAIL = 'owner@imk.test';
const OTHER_ADMIN_EMAIL = 'other.owner@imk.test';
const CLIENT_EMAIL = 'client@imk.test';
const STRANGER_EMAIL = 'stranger@imk.test';
const SITE_ORIGIN = 'https://imk.test';

// ---------------------------------------------------------------------------
// tiny assertion framework (QA's own)
// ---------------------------------------------------------------------------
const results = [];
let currentGroup = 'general';
let groupEnabled = true;

function group(letter, name) {
  currentGroup = `${letter} -- ${name}`;
  // `--only` takes a group letter (E) and/or single check ids (E1,E6).
  const wanted =
    !ONLY ||
    ONLY.has(letter) ||
    [...ONLY].some((x) => x.length > 1 && x.startsWith(letter));
  groupEnabled = wanted;
  if (!groupEnabled) {
    console.log(`[qa] ${currentGroup} (skipped)`);
    return false;
  }
  console.log(`\n[qa] ${currentGroup}`);
  return true;
}

async function t(id, name, fn) {
  // `--only` accepts a group letter (E) and/or single check ids (E1,E6).
  if (!groupEnabled) return;
  if (ONLY && !ONLY.has(currentGroup[0]) && !ONLY.has(id)) return;
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
    throw new Error(
      `${msg} -- expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// environment + network stub (the parent process)
// ---------------------------------------------------------------------------
process.env.APP_ENV = 'production';
process.env.SITE_BASE_URL = SITE_ORIGIN;
process.env.RESEND_API_KEY = 'qa-admin-resend-key';
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
  RESEND_API_KEY: 'qa-admin-resend-key',
  RESEND_FROM: 'IMK <qa@imk.test>',
  RESEND_TO: ADMIN_EMAIL,
  FORM_WEBHOOK_SECRET: SECRET,
  ADMIN_EMAILS: ADMIN_EMAIL,
  PORTAL_MAGIC_LINK_SECRET: MAGIC_SECRET,
  PORTAL_SESSION_SECRET: SESSION_SECRET,
  PORTAL_RATE_LIMIT_FILE: '',
  NODE_ENV: 'production',
};

globalThis.fetch = async (url) => {
  const target = String(url);
  if (target.includes('api.resend.com')) {
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
    for (const entry of fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        parts.push(
          `${path.relative(root, full)}:${crypto
            .createHash('sha256')
            .update(fs.readFileSync(full))
            .digest('hex')}`,
        );
      }
    }
  };
  walk(root);
  return parts.join('\n');
}

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

/** The state of the newest stored line of a ref. */
function latestState(ref) {
  const lines = readJsonl(REVIEWS_FILE).filter((l) => l.ref === ref);
  if (!lines.length) return null;
  return lines[lines.length - 1].state;
}

// ---------------------------------------------------------------------------
// the child runner: ONE bundle per process, JSON lines over stdin/stdout
// ---------------------------------------------------------------------------
const CHILD_SRC = [
  'const fs = require("node:fs");',
  'const { Readable } = require("node:stream");',
  '',
  'const bundlePath = process.env.QA_ADMIN_BUNDLE;',
  'const logFile = process.env.QA_ADMIN_LOG_FILE || "";',
  'const mailFile = process.env.QA_ADMIN_MAIL_FILE || "";',
  '',
  '// A Worker has no globalThis.require: the edge tree then cannot reach the',
  '// filesystem, which is what a real isolate looks like. QA_ADMIN_EDGE_FS=1',
  '// hands the edge tree a filesystem instead (a Node simulation).',
  'if (process.env.QA_ADMIN_EDGE_FS === "1") { globalThis.require = require; }',
  '',
  '// No request may leave the machine: the Resend call is captured.',
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
  '      if (msg.style === "web") {',
  '        const headers = {};',
  '        for (const k of Object.keys(msg.headers || {})) headers[k] = msg.headers[k];',
  '        const init = { method: msg.method || "GET", headers: headers };',
  '        if (msg.body !== undefined && msg.body !== null && (msg.method || "GET") !== "GET") {',
  '          init.body = String(msg.body);',
  '        }',
  '        const request = new Request("https://imk.test" + (msg.url || "/"), init);',
  '        const response = await fn({ request: request, env: process.env });',
  '        const text = await response.text();',
  '        const out = {};',
  '        response.headers.forEach(function (v, k) { out[k] = v; });',
  '        reply({ ok: true, status: response.status, headers: out, body: text });',
  '        return;',
  '      }',
  '      const made = makeRes();',
  '      await fn(makeReq(msg), made.res);',
  '      reply({ ok: true, status: made.state.status, headers: made.state.headers, body: made.state.body });',
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
        QA_ADMIN_BUNDLE: this.bundlePath,
        QA_ADMIN_MAIL_FILE: this.mailFile,
        QA_ADMIN_LOG_FILE: this.logFile,
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
      const err = new Error(
        `[qa] child ${this.name} exited with code ${code}: ${this.stderr}`,
      );
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
        else
          this.readyReject(
            new Error(`[qa] child ${this.name} could not load its bundle: ${msg.error}`),
          );
        continue;
      }
      const waiter = this.waiters.shift();
      if (waiter) waiter.resolve(msg);
    }
  }

  send(msg, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(
            `[qa] child ${this.name} timed out after ${timeoutMs}ms on ${JSON.stringify(msg)}`,
          ),
        );
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
      style: opts.style,
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

async function startChild(name, bundlePath, opts = {}) {
  const child = new BundleChild(name, bundlePath, opts);
  children.push(child);
  await child.start();
  return child;
}

// ---------------------------------------------------------------------------
// bundling (QA's own esbuild calls)
// ---------------------------------------------------------------------------
// The handler modules under test.
//
// The handler bodies moved out of api/ in wave 13 (the function budget): they
// live in site/shared/portal-handlers/ now, and the pin follows the PRODUCT's
// route table so it cannot drift from the tree.
const ROOTS = { apiDir: API_DIR, sharedDir: SHARED_DIR };
const BUNDLE_DEFS = {
  adminSession: {
    dir: () => SHARED_DIR,
    code: `export { default as handler } from '${fwd(handlerPath('admin-session', ROOTS))}';`,
  },
  adminReviews: {
    dir: () => SHARED_DIR,
    code: `export { default as handler } from '${fwd(handlerPath('admin-reviews', ROOTS))}';`,
  },
  auth: {
    dir: () => SHARED_DIR,
    code: `export { default as handler } from '${fwd(handlerPath('portal-auth', ROOTS))}';`,
  },
  projects: {
    dir: () => SHARED_DIR,
    code: `export { default as handler } from '${fwd(handlerPath('portal-projects', ROOTS))}';`,
  },
  moderate: {
    dir: () => API_DIR,
    code: `export { default as handler } from '${fwd(handlerPath('moderate', ROOTS))}';`,
  },
  session: {
    dir: () => SHARED_DIR,
    code: `export { createSession, parseSession } from './server/portal-session.ts';`,
  },
  cfAdminSession: { dir: () => CF_DIR, code: `export { onRequestGet } from './api/admin/session.ts';` },
  cfAdminReviews: { dir: () => CF_DIR, code: `export { onRequestGet } from './api/admin/reviews.ts';` },
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
// fixtures (in the SANDBOX - never in the repository)
// ---------------------------------------------------------------------------
const PORTAL_DIR = path.join(SANDBOX, 'site', 'data', 'portal');
const MODERATION_DIR = path.join(SANDBOX, 'site', 'data', 'moderation');
const INVITED_FILE = path.join(PORTAL_DIR, 'invited.jsonl');
const CLIENTS_FILE = path.join(PORTAL_DIR, 'clients.jsonl');
const PROJECTS_FILE = path.join(PORTAL_DIR, 'projects.jsonl');
const REVIEWS_FILE = path.join(MODERATION_DIR, 'reviews.jsonl');

const REVIEW_REF = 'inq_admin_1';
// The identity of the seeded review record (wave 12, B-1). A revision NUMBER
// is not an identity: the signed link must also name the exact record, or a
// decision can land on a record the owner never saw. The seed carries one so
// the identity path is really exercised -- a seed WITHOUT one would let the
// suite pass while the identity code was never touched.
const REVIEW_RECORD_ID = 'rec_qa_admin_0000000000000000000000000001';

function seedFixtures() {
  fs.mkdirSync(PORTAL_DIR, { recursive: true });
  fs.mkdirSync(MODERATION_DIR, { recursive: true });
  fs.writeFileSync(
    INVITED_FILE,
    JSON.stringify({
      email: CLIENT_EMAIL,
      name: 'Wenda Admin',
      company: 'Admin QA Ltd',
      role: 'CTO',
      invitedBy: ADMIN_EMAIL,
      invitedAt: new Date().toISOString(),
      clientId: 'cli_admin_qa',
    }) + '\n',
    'utf8',
  );
  fs.writeFileSync(
    CLIENTS_FILE,
    JSON.stringify({
      id: 'cli_admin_qa',
      email: CLIENT_EMAIL,
      name: 'Wenda Admin',
      company: 'Admin QA Ltd',
      createdAt: new Date().toISOString(),
    }) + '\n',
    'utf8',
  );
  fs.writeFileSync(
    PROJECTS_FILE,
    JSON.stringify({
      id: 'prj_admin_qa',
      clientId: 'cli_admin_qa',
      title: 'QA project',
      status: 'active',
      createdAt: new Date().toISOString(),
    }) + '\n' +
      JSON.stringify({
        id: 'prj_foreign',
        clientId: 'cli_someone_else',
        title: 'Another client project',
        status: 'active',
        createdAt: new Date().toISOString(),
      }) + '\n',
    'utf8',
  );
  fs.writeFileSync(
    REVIEWS_FILE,
    JSON.stringify({
      ref: REVIEW_REF,
      type: 'review',
      name: 'Wenda Admin',
      company: 'Admin QA Ltd',
      rating: 5,
      review: 'The admin inbox works.',
      revision: 1,
      recordId: REVIEW_RECORD_ID,
      state: 'pending',
      clientId: 'cli_admin_qa',
      receivedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    }) + '\n',
    'utf8',
  );
}

// ---------------------------------------------------------------------------
// scenario helpers
// ---------------------------------------------------------------------------
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

function tokenFromMail(mail) {
  const m = /(https?:\/\/\S*\/login\/verify\?token=([^\s&"']+))/.exec(String(mail.text || ''));
  assert(m, `no sign-in link in the mail: ${JSON.stringify(mail).slice(0, 300)}`);
  return decodeURIComponent(m[2]);
}

/** Sign in through the REAL auth bundle and return the cookie it issues. */
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
  const adminCookie = cookieFrom(v.headers, 'imk_admin_session');
  const clientCookie = cookieFrom(v.headers, 'imk_session');
  const cookie = adminCookie || clientCookie;
  assert(cookie, `no session cookie was issued for ${email}`);
  return { cookie, adminCookie, clientCookie, role: v.json && v.json.role };
}

/**
 * QA's OWN HMAC over the moderation parameters - not the project's helper.
 *
 * The signed message is `ref|decision|revision|recordId|ts` when the link
 * names a record (wave 12, B-1) and `ref|decision|revision|ts` when it does
 * not (a link minted before wave 12). QA computes the shape from the LINK,
 * so a product that changed the signed message would be caught here.
 */
function qaSignModeration(ref, decision, revision, ts, recordId) {
  const message =
    recordId === undefined || recordId === ''
      ? `${ref}|${decision}|${revision}|${ts}`
      : `${ref}|${decision}|${revision}|${recordId}|${ts}`;
  return crypto.createHmac('sha256', SECRET).update(message).digest('hex');
}

// ---------------------------------------------------------------------------
// the suite
// ---------------------------------------------------------------------------
async function main() {
  fs.mkdirSync(SANDBOX, { recursive: true });
  fs.mkdirSync(WORK, { recursive: true });
  fs.writeFileSync(CHILD_PATH, CHILD_SRC, 'utf8');
  seedFixtures();

  const repoDigestBefore = repoDigest();

  group('E', 'the /admin owner inbox gate (wave 6, T7.14)');

  const [adminSessionBundle, adminReviewsBundle, authBundle, projectsBundle, moderateBundle, sessionBundle, cfAdminSessionBundle, cfAdminReviewsBundle] =
    await Promise.all([
      bundle('adminSession'),
      bundle('adminReviews'),
      bundle('auth'),
      bundle('projects'),
      bundle('moderate'),
      bundle('session'),
      bundle('cfAdminSession'),
      bundle('cfAdminReviews'),
    ]);

  const auth = await startChild('e-auth', authBundle);
  const adminSession = await startChild('e-admin-session', adminSessionBundle);
  const adminReviews = await startChild('e-admin-reviews', adminReviewsBundle);
  const projects = await startChild('e-projects', projectsBundle);
  const moderate = await startChild('e-moderate', moderateBundle);
  const session = await startChild('e-session', sessionBundle);
  const cfSession = await startChild('e-cf-admin-session', cfAdminSessionBundle);

  // The owner signs in through the REAL magic-link flow.
  const owner = await signIn(auth, ADMIN_EMAIL);
  const client = await signIn(auth, CLIENT_EMAIL, '203.0.113.10');

  await t('E1', 'CONTROL: the owner signs in through the real flow and is the owner', async () => {
    assertEqual(owner.role, 'admin', `the owner's session role should be admin, got ${owner.role}`);
    assert(owner.adminCookie, 'the owner must get the imk_admin_session cookie, not the client one');
    assert(
      owner.adminCookie.startsWith('imk_admin_session='),
      `the owner cookie must be the admin cookie, got ${owner.adminCookie}`,
    );
    const r = await adminSession.request('GET', '/api/admin/session', {
      cookie: owner.adminCookie,
    });
    assertEqual(r.status, 200, `the owner should get 200 (got ${r.status}: ${r.text})`);
    assert(r.json && r.json.ok === true, `the owner should get ok:true (got ${r.text})`);
    assertEqual(r.json.role, 'admin', `the owner role should be admin (got ${r.text})`);
    return `owner ${r.json.email} -> 200 ${JSON.stringify(r.json)}`;
  });

  await t('E2', 'no cookie at all -> 401 {code:unauthorized}', async () => {
    const r = await adminSession.request('GET', '/api/admin/session');
    assertEqual(r.status, 401, `a request with no cookie should be 401 (got ${r.status}: ${r.text})`);
    assertEqual(r.json.code, 'unauthorized', `the code should be unauthorized (got ${r.text})`);
    return `401 ${r.text}`;
  });

  await t('E3', 'a CLIENT session cannot satisfy the admin gate -> 401', async () => {
    assert(client.clientCookie, 'the client must get the imk_session cookie');
    const r = await adminSession.request('GET', '/api/admin/session', {
      cookie: client.clientCookie,
    });
    assertEqual(r.status, 401, `a client session should be 401 (got ${r.status}: ${r.text})`);
    assertEqual(r.json.code, 'unauthorized', `the code should be unauthorized (got ${r.text})`);
    return `401 ${r.text}`;
  });

  await t('E4', 'a forged admin cookie -> 401', async () => {
    const r = await adminSession.request('GET', '/api/admin/session', {
      cookie: 'imk_admin_session=v1.eyJlbWFpbCI6Im93bmVyQGltay50ZXN0IiwiciJhZG1pbiJ9.deadbeef',
    });
    assertEqual(r.status, 401, `a forged cookie should be 401 (got ${r.status}: ${r.text})`);
    return `401 ${r.text}`;
  });

  await t('E5', 'a CLIENT-role token presented under the ADMIN cookie name -> 401', async () => {
    const minted = await session.send({
      cmd: 'session',
      op: 'create',
      email: CLIENT_EMAIL,
      role: 'client',
      clientId: 'cli_admin_qa',
    });
    assert(minted.token, 'the session module did not mint a client token');
    const r = await adminSession.request('GET', '/api/admin/session', {
      cookie: `imk_admin_session=${minted.token}`,
    });
    assertEqual(
      r.status,
      401,
      `a client-role token under the admin cookie name should be 401 (got ${r.status}: ${r.text})`,
    );
    return `the ROLE is checked, not the cookie name -> 401`;
  });

  await t('E6', 'an admin-role token for an email that is NOT on the allow-list -> 401', async () => {
    const minted = await session.send({
      cmd: 'session',
      op: 'create',
      email: STRANGER_EMAIL,
      role: 'admin',
      clientId: 'cli_admin_qa',
    });
    assert(minted.token, 'the session module did not mint an admin token');
    const r = await adminSession.request('GET', '/api/admin/session', {
      cookie: `imk_admin_session=${minted.token}`,
    });
    assertEqual(
      r.status,
      401,
      `a valid admin token for an address that is not allow-listed should be 401 (got ${r.status}: ${r.text})`,
    );
    return `401 ${r.text}`;
  });

  await t('E7', 'the allow-list is read on EVERY request: the same token stops working at once', async () => {
    // The same, still valid, owner token - but this process was started with
    // an allow-list that does NOT contain the owner any more.
    const revoked = await startChild('e-admin-session-revoked', adminSessionBundle, {
      env: { ADMIN_EMAILS: OTHER_ADMIN_EMAIL },
    });
    try {
      const r = await revoked.request('GET', '/api/admin/session', {
        cookie: owner.adminCookie,
      });
      assertEqual(
        r.status,
        401,
        `removing the address from ADMIN_EMAILS must revoke access at once (got ${r.status}: ${r.text})`,
      );
      return `the token is still valid, the allow-list is not -> 401`;
    } finally {
      await revoked.stop();
    }
  });

  await t('E8', 'an unset ADMIN_EMAILS is a MISCONFIGURATION -> 500, not "everybody is the owner"', async () => {
    const unconfigured = await startChild('e-admin-session-unset', adminSessionBundle, {
      env: { ADMIN_EMAILS: '' },
    });
    try {
      const r = await unconfigured.request('GET', '/api/admin/session', {
        cookie: owner.adminCookie,
      });
      assertEqual(
        r.status,
        500,
        `an unset allow-list should be 500 {code:internal} (got ${r.status}: ${r.text})`,
      );
      assertEqual(r.json.code, 'internal', `the code should be internal (got ${r.text})`);
      return `500 ${r.text}`;
    } finally {
      await unconfigured.stop();
    }
  });

  await t('E9', 'GET /api/admin/reviews: a non-owner is 401, the owner sees the queue', async () => {
    const denied = await adminReviews.request('GET', '/api/admin/reviews', {
      cookie: client.clientCookie,
    });
    assertEqual(
      denied.status,
      401,
      `a client should be 401 on the queue (got ${denied.status}: ${denied.text})`,
    );
    const allowed = await adminReviews.request('GET', '/api/admin/reviews', {
      cookie: owner.adminCookie,
    });
    assertEqual(
      allowed.status,
      200,
      `the owner should be 200 on the queue (got ${allowed.status}: ${allowed.text})`,
    );
    assert(allowed.json && Array.isArray(allowed.json.reviews), `the queue should list reviews (got ${allowed.text})`);
    assertEqual(
      allowed.json.counts.pendingReviews,
      1,
      `the seeded pending quote should be counted (got ${allowed.text})`,
    );
    assertEqual(
      allowed.json.counts.openNotes,
      null,
      `there is no annotation store, so the notes count must be null, not 0 (got ${allowed.text})`,
    );
    assertEqual(
      allowed.json.notesAvailable,
      false,
      `the notes panel must say it is not available (got ${allowed.text})`,
    );
    return `pending=${allowed.json.counts.pendingReviews}, openNotes=null`;
  });

  await t('E10', 'the approve link the inbox mints is HMAC-valid and /api/moderate/review accepts it', async () => {
    const queue = await adminReviews.request('GET', '/api/admin/reviews', {
      cookie: owner.adminCookie,
    });
    assertEqual(queue.status, 200, `the queue should be 200 (got ${queue.status}: ${queue.text})`);
    const item = (queue.json.reviews || []).find((r) => r.ref === REVIEW_REF);
    assert(item, `the queue does not carry ${REVIEW_REF}: ${queue.text}`);
    const approve = new URL(item.approvePath, SITE_ORIGIN);
    const ref = approve.searchParams.get('ref');
    const decision = approve.searchParams.get('decision');
    const revision = approve.searchParams.get('revision');
    const ts = approve.searchParams.get('ts');
    const sig = approve.searchParams.get('sig');
    // The identity of the record (wave 12, B-1). The seeded record carries
    // one, so the minted link MUST name it -- otherwise the suite would be
    // exercising the legacy revision-only shape and the identity code would
    // never run.
    const recordId = approve.searchParams.get('recordId') || '';
    assertEqual(ref, REVIEW_REF, 'the link points at another quote');
    assertEqual(decision, 'approve', 'the link is not an approve link');
    assert(
      approve.pathname === '/api/moderate/review',
      `the link must point at the moderation endpoint (got ${approve.pathname})`,
    );
    assertEqual(
      recordId,
      REVIEW_RECORD_ID,
      'the minted link must name the EXACT record the owner was shown',
    );
    // QA's own HMAC over the parameters - if the inbox signed it with another
    // secret, or over another shape, this is where it shows.
    const expected = qaSignModeration(ref, decision, revision, ts, recordId);
    assertEqual(
      sig,
      expected,
      'the link signature does not match QA\'s own HMAC over ref|decision|revision|recordId|ts',
    );
    // M-1 (wave-8A): the DECISION is the POST -- a GET only shows the
    // confirmation page, so a mail scanner that prefetches the owner's link
    // approves nothing. The signed parameters travel in the form body, the
    // way the confirmation page's own form sends them.
    const fields = new URLSearchParams();
    for (const name of ['ref', 'decision', 'revision', 'recordId', 'ts', 'sig']) {
      fields.set(name, approve.searchParams.get(name) || '');
    }
    const scanned = await moderate.request('GET', `${approve.pathname}${approve.search}`, {
      cookie: owner.adminCookie,
    });
    assertEqual(
      scanned.status,
      200,
      `the link must serve the confirmation page (got ${scanned.status}: ${scanned.text})`,
    );
    assert(
      /<form[^>]*method="POST"/i.test(scanned.text),
      'the confirmation page must offer a POST form (a GET must never decide)',
    );
    assertEqual(
      latestState(REVIEW_REF),
      'pending',
      'a GET must not approve anything -- the quote must still be pending',
    );

    const r = await moderate.request('POST', '/api/moderate/review', {
      cookie: owner.adminCookie,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: fields.toString(),
    });
    assertEqual(r.status, 200, `the moderation endpoint should accept the link (got ${r.status}: ${r.text})`);
    assertEqual(r.json.state, 'approved', 'the decision must be approved');
    const lines = readJsonl(REVIEWS_FILE);
    const latest = lines.filter((l) => l.ref === REVIEW_REF).pop();
    assert(latest, 'the decision was not written to the store');
    assertEqual(
      latest.state,
      'approved',
      `the quote should be approved in the store (got ${latest.state})`,
    );
    return `sig verified independently; the GET approved nothing, the POST made the quote ${latest.state}`;
  });

  await t('E11', 'the Cloudflare twin answers the SAME gate codes as the Vercel tree', async () => {
    const ownerCf = await cfSession.request('GET', '/api/admin/session', {
      which: 'onRequestGet',
      style: 'web',
      cookie: owner.adminCookie,
    });
    assertEqual(
      ownerCf.status,
      200,
      `the CF twin should let the owner in (got ${ownerCf.status}: ${ownerCf.text})`,
    );
    const clientCf = await cfSession.request('GET', '/api/admin/session', {
      which: 'onRequestGet',
      style: 'web',
      cookie: client.clientCookie,
    });
    assertEqual(
      clientCf.status,
      401,
      `the CF twin should refuse a client (got ${clientCf.status}: ${clientCf.text})`,
    );
    const noneCf = await cfSession.request('GET', '/api/admin/session', {
      which: 'onRequestGet',
      style: 'web',
    });
    assertEqual(
      noneCf.status,
      401,
      `the CF twin should refuse a request with no cookie (got ${noneCf.status}: ${noneCf.text})`,
    );
    return `owner 200, client 401, no cookie 401 - same as the Vercel tree`;
  });

  await t('E12', 'a client session cannot use the owner-only client route -> 403 {code:forbidden}', async () => {
    const r = await projects.request('PATCH', '/api/portal/projects/prj_admin_qa', {
      cookie: client.clientCookie,
      origin: SITE_ORIGIN,
      body: JSON.stringify({ status: 'paused' }),
    });
    assertEqual(
      r.status,
      403,
      `a client session should be 403 on an owner-only route (got ${r.status}: ${r.text})`,
    );
    assertEqual(r.json.code, 'forbidden', `the code should be forbidden (got ${r.text})`);
    return `403 ${r.text}`;
  });

  await t('E13', 'a STALE admin cookie does not shadow a valid client cookie', async () => {
    const cookie = `imk_admin_session=v1.broken.deadbeef; imk_session=${client.clientCookie.split('=')[1]}`;
    const r = await projects.request('GET', '/api/portal/projects', { cookie });
    assertEqual(r.status, 200, `the client should still be signed in (got ${r.status}: ${r.text})`);
    const visible = (r.json && r.json.projects) || [];
    assertEqual(
      visible.length,
      1,
      `the client must see only their own project (got ${visible.length})`,
    );
    assertEqual(
      visible[0].id,
      'prj_admin_qa',
      `the client saw the wrong project (got ${visible[0] && visible[0].id})`,
    );
    return 'the stale admin cookie was skipped, the client session won';
  });

  await t('E14', 'the Cloudflare inbox serves NO queue on either runtime -- 501, and the gate still comes first', async () => {
    // WAVE 10, F-6 (2026-10-22): the Cloudflare tree was rewritten ON PURPOSE.
    // The JSONL read is GONE and the endpoint answers 501 {code:'unimplemented'}
    // -- "a queue that cannot exist must never look like an empty one" (the
    // owner would believe there is nothing to moderate).
    //
    // This check was re-pinned: it used to demand a 200 WITH A QUEUE from this
    // target in the Node simulation of the edge tree (QA_ADMIN_EDGE_FS=1) --
    // an answer no Worker could ever give. It is now pinned to the contract
    // the product actually has.
    //
    // What must still hold:
    //   - the GATE comes before the store: 401 for a non-owner, 500 for a
    //     deployment without ADMIN_EMAILS or with an UNUSABLE
    //     FORM_WEBHOOK_SECRET (H-1: a published placeholder is not a secret);
    //   - the answer is 501 in BOTH runtimes -- the edge runtime (no
    //     filesystem) AND the Node simulation of the edge tree, which is
    //     exactly where the old implementation answered 200 with a queue;
    //   - the Vercel tree still answers 200 with a REAL queue: the two
    //     targets differ BY DESIGN, so the comparison with the Vercel tree
    //     is the GATE, not the queue body.
    const edge = await startChild('e-cf-admin-reviews-edge', cfAdminReviewsBundle);
    try {
      const r = await edge.request('GET', '/api/admin/reviews', {
        which: 'onRequestGet',
        style: 'web',
        cookie: owner.adminCookie,
      });
      assertEqual(
        r.status,
        501,
        `the CF twin with no filesystem should answer 501 {code:unimplemented} (got ${r.status}: ${r.text})`,
      );
      assertEqual(r.json.code, 'unimplemented', `the code should be unimplemented (got ${r.text})`);
      assert(
        !r.json.reviews && !r.json.counts,
        `a queue that cannot exist must not look like an empty one (got ${r.text})`,
      );

      // THE GATE COMES FIRST: a non-owner is 401, not 501.
      const denied = await edge.request('GET', '/api/admin/reviews', {
        which: 'onRequestGet',
        style: 'web',
        cookie: client.clientCookie,
      });
      assertEqual(
        denied.status,
        401,
        `the CF twin must refuse a client BEFORE it looks for the store (got ${denied.status}: ${denied.text})`,
      );
      assertEqual(
        denied.json.code,
        'unauthorized',
        `the code should be unauthorized (got ${denied.text})`,
      );

      const anon = await edge.request('GET', '/api/admin/reviews', {
        which: 'onRequestGet',
        style: 'web',
      });
      assertEqual(
        anon.status,
        401,
        `the CF twin must refuse a request with no cookie (got ${anon.status}: ${anon.text})`,
      );
    } finally {
      await edge.stop();
    }

    // An unset allow-list is a MISCONFIGURATION -> 500, not 501.
    const unconfigured = await startChild('e-cf-admin-reviews-unset', cfAdminReviewsBundle, {
      env: { ADMIN_EMAILS: '' },
    });
    try {
      const r = await unconfigured.request('GET', '/api/admin/reviews', {
        which: 'onRequestGet',
        style: 'web',
        cookie: owner.adminCookie,
      });
      assertEqual(
        r.status,
        500,
        `a deployment without ADMIN_EMAILS should answer 500 {code:internal} (got ${r.status}: ${r.text})`,
      );
      assertEqual(r.json.code, 'internal', `the code should be internal (got ${r.text})`);
    } finally {
      await unconfigured.stop();
    }

    // An UNUSABLE secret -- the published placeholder -- is a
    // MISCONFIGURATION too (H-1): 500, not 501.
    const unusable = await startChild('e-cf-admin-reviews-placeholder', cfAdminReviewsBundle, {
      env: { FORM_WEBHOOK_SECRET: 'your-32-byte-hex-hmac-secret-here' },
    });
    try {
      const r = await unusable.request('GET', '/api/admin/reviews', {
        which: 'onRequestGet',
        style: 'web',
        cookie: owner.adminCookie,
      });
      assertEqual(
        r.status,
        500,
        `a published placeholder secret must answer 500 {code:internal} (got ${r.status}: ${r.text})`,
      );
      assertEqual(r.json.code, 'internal', `the code should be internal (got ${r.text})`);
    } finally {
      await unusable.stop();
    }

    // With a filesystem (a Node simulation of the edge tree) the answer is
    // STILL 501: this target serves no queue, with or without a filesystem.
    const withFs = await startChild('e-cf-admin-reviews-fs', cfAdminReviewsBundle, {
      env: { QA_ADMIN_EDGE_FS: '1' },
    });
    try {
      const cf = await withFs.request('GET', '/api/admin/reviews', {
        which: 'onRequestGet',
        style: 'web',
        cookie: owner.adminCookie,
      });
      assertEqual(
        cf.status,
        501,
        `the CF twin with a filesystem must still answer 501 -- this target serves no queue (got ${cf.status}: ${cf.text})`,
      );
      assertEqual(cf.json.code, 'unimplemented', `the code should be unimplemented (got ${cf.text})`);
      assert(
        !cf.json.reviews && !cf.json.counts,
        `a queue that cannot exist must not look like an empty one (got ${cf.text})`,
      );

      const denied = await withFs.request('GET', '/api/admin/reviews', {
        which: 'onRequestGet',
        style: 'web',
        cookie: client.clientCookie,
      });
      assertEqual(
        denied.status,
        401,
        `the CF twin must refuse a client (got ${denied.status}: ${denied.text})`,
      );

      // THE COMPARISON WITH THE VERCEL TREE IS THE GATE, NOT THE QUEUE.
      const vercel = await adminReviews.request('GET', '/api/admin/reviews', {
        cookie: owner.adminCookie,
      });
      assertEqual(vercel.status, 200, `the Vercel tree should be 200 (got ${vercel.status}: ${vercel.text})`);
      assert(
        Array.isArray(vercel.json.reviews),
        `the Vercel tree serves a REAL queue (got ${vercel.text})`,
      );
      assertEqual(
        vercel.json.counts.openNotes,
        null,
        `the notes count must stay null on the Vercel tree (got ${vercel.text})`,
      );
      const vercelDenied = await adminReviews.request('GET', '/api/admin/reviews', {
        cookie: client.clientCookie,
      });
      assertEqual(
        vercelDenied.status,
        401,
        `the Vercel tree must refuse a client too (got ${vercelDenied.status}: ${vercelDenied.text})`,
      );
      return 'edge 501 and filesystem 501; the gate (401 / 500) comes first on both trees; the Vercel tree serves the queue';
    } finally {
      await withFs.stop();
    }
  });

  await t('E15', 'MUTATION PROBE: with the allow-list check removed, E6 goes RED', async () => {
    // The probe re-runs THIS file against a copy. Without the guard the
    // nested run would probe itself, forever.
    if (process.env.QA_ADMIN_PROBE_CHILD === '1') {
      return 'skipped: this run IS the probe';
    }
    const copyRoot = path.join(WORK, 'copy-admin');
    fs.mkdirSync(copyRoot, { recursive: true });
    copyDir(API_DIR, path.join(copyRoot, 'api'));
    copyDir(SHARED_DIR, path.join(copyRoot, 'site', 'shared'));
    copyDir(CF_DIR, path.join(copyRoot, 'site', 'functions'));

    // Put the defect back IN THE COPY: the allow-list no longer decides.
    //
    // The rule itself lives in the SHARED module (wave-8A moved it there:
    // site/shared/server/portal-session.ts); api/admin/session.ts only
    // delegates to it. The probe therefore patches the shared copy -- and
    // falls back to the admin route if the rule ever moves back.
    const ANCHOR = "return list.includes(String(email || '').trim().toLowerCase());";
    const candidates = [
      path.join(copyRoot, 'site', 'shared', 'server', 'portal-session.ts'),
      path.join(copyRoot, 'api', 'admin', 'session.ts'),
    ];
    let patched = null;
    for (const candidate of candidates) {
      if (!fs.existsSync(candidate)) continue;
      const original = fs.readFileSync(candidate, 'utf8');
      if (!original.includes(ANCHOR)) continue;
      fs.writeFileSync(candidate, original.replace(ANCHOR, 'return true;'), 'utf8');
      patched = candidate;
      break;
    }
    assert(
      patched !== null,
      'the mutation did not apply - the probe would be vacuous ' +
        `(no copy of the allow-list rule matched: ${candidates.join(', ')})`,
    );

    const outFile = path.join(WORK, 'probe-results.json');
    let probe = null;
    try {
      execFileSync(
        process.execPath,
        [SELF, '--only', 'E1,E6', '--json', outFile],
        {
          env: {
            ...process.env,
            QA_ADMIN_PROBE_CHILD: '1',
            QA_ADMIN_API_DIR: path.join(copyRoot, 'api'),
            QA_ADMIN_SHARED_DIR: path.join(copyRoot, 'site', 'shared'),
            QA_ADMIN_CF_DIR: path.join(copyRoot, 'site', 'functions'),
          },
          stdio: 'ignore',
        },
      );
    } catch {
      /* the probe is EXPECTED to fail - the results file is what matters */
    }
    assert(fs.existsSync(outFile), 'the probe produced no results file');
    probe = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    const statusOf = (id) => {
      const row = (probe.results || []).find((r) => r.id === id);
      return row ? row.status : 'MISSING';
    };
    assertEqual(
      statusOf('E6'),
      'FAIL',
      'the allow-list check did not go red on the mutated copy - the check is vacuous',
    );
    assertEqual(
      statusOf('E1'),
      'PASS',
      'the owner control must still pass on the mutated copy',
    );
    return `mutated copy: E1=${statusOf('E1')} (the owner still gets in), E6=${statusOf('E6')} (the allow-list no longer decides)`;
  });

  await t('E16', 'MUTATION PROBE: with a JSONL read put back into the CF inbox, E14 goes RED', async () => {
    // The re-pin of E14 is only worth something if it still BITES. The defect
    // it pins is the one wave 10 removed on purpose (F-6): the Cloudflare
    // inbox reading the moderation log itself and answering 200 with a
    // queue -- an answer no Worker could ever give, and a queue that cannot
    // exist on this target.
    //
    // The probe re-runs THIS file against a copy. Without the guard the
    // nested run would probe itself, forever.
    if (process.env.QA_ADMIN_PROBE_CHILD === '1') {
      return 'skipped: this run IS the probe';
    }
    const copyRoot = path.join(WORK, 'copy-cf-inbox');
    fs.mkdirSync(copyRoot, { recursive: true });
    copyDir(API_DIR, path.join(copyRoot, 'api'));
    copyDir(SHARED_DIR, path.join(copyRoot, 'site', 'shared'));
    copyDir(CF_DIR, path.join(copyRoot, 'site', 'functions'));

    // Put the defect back IN THE COPY: the Cloudflare inbox reads the
    // moderation log again and answers 200 with a queue. The gate above it
    // is untouched -- only the QUEUE is put back, so the mutation isolates
    // exactly the behaviour E14 pins.
    const cfInbox = path.join(copyRoot, 'site', 'functions', 'api', 'admin', 'reviews.ts');
    const ANCHOR = `  return json(
    { error: 'moderation store unavailable on this target', code: 'unimplemented' },
    501,
  );`;
    const MUTATION = `  // QA MUTATION (wave 10, F-6): the JSONL read is back.
  const edgeRequire = (globalThis as any).require;
  const edgeFs: any = edgeRequire ? edgeRequire('node:fs') : null;
  const reviewsFile = 'site/data/moderation/reviews.jsonl';
  if (!edgeFs || !edgeFs.existsSync(reviewsFile)) {
    return json(
      { error: 'moderation store unavailable on this target', code: 'unimplemented' },
      501,
    );
  }
  const records: Array<Record<string, any>> = edgeFs
    .readFileSync(reviewsFile, 'utf8')
    .split(/\\r?\\n/)
    .filter((line: string) => line.trim())
    .map((line: string) => JSON.parse(line));
  const pending = records.filter(
    (r: any) => r && r.type === 'review' && r.state === 'pending',
  );
  return json(
    {
      ok: true,
      counts: { pendingReviews: pending.length, decidedToday: 0, openNotes: null },
      notesAvailable: false,
      reviews: pending,
      recent: [],
    },
    200,
  );`;

    const original = fs.readFileSync(cfInbox, 'utf8');
    assert(
      original.includes(ANCHOR),
      'the mutation did not apply - the probe would be vacuous ' +
        '(the CF inbox no longer has the 501 answer it is supposed to have)',
    );
    fs.writeFileSync(cfInbox, original.replace(ANCHOR, MUTATION), 'utf8');

    const outFile = path.join(WORK, 'probe-e14-results.json');
    let probe = null;
    try {
      execFileSync(
        process.execPath,
        [SELF, '--only', 'E9,E14', '--json', outFile],
        {
          env: {
            ...process.env,
            QA_ADMIN_PROBE_CHILD: '1',
            QA_ADMIN_API_DIR: path.join(copyRoot, 'api'),
            QA_ADMIN_SHARED_DIR: path.join(copyRoot, 'site', 'shared'),
            QA_ADMIN_CF_DIR: path.join(copyRoot, 'site', 'functions'),
          },
          stdio: 'ignore',
        },
      );
    } catch {
      /* the probe is EXPECTED to fail - the results file is what matters */
    }
    assert(fs.existsSync(outFile), 'the probe produced no results file');
    probe = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    const statusOf = (id) => {
      const row = (probe.results || []).find((r) => r.id === id);
      return row ? row.status : 'MISSING';
    };
    assertEqual(
      statusOf('E14'),
      'FAIL',
      'a CF inbox with the JSONL read back did not make E14 red - the re-pin is vacuous',
    );
    assertEqual(
      statusOf('E9'),
      'PASS',
      'the Vercel tree control must still pass on the mutated copy',
    );
    return `mutated copy: E9=${statusOf('E9')} (the Vercel tree still serves the queue), E14=${statusOf('E14')} (the CF inbox with a JSONL read was caught)`;
  });

  await t('E17', 'the repository is byte-identical after the probe', async () => {
    const before = repoDigestBefore;
    const after = repoDigest();
    assert(before === after, 'the repository changed during the suite');
    return 'api/, site/shared/ and site/functions/ are byte-for-byte unchanged';
  });

  for (const child of children) {
    await child.stop();
  }
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------
let failed = 0;
try {
  await main();
} catch (err) {
  console.error('[qa] the suite itself failed:', err && err.stack ? err.stack : err);
  failed = 1;
}

const passed = results.filter((r) => r.status === 'PASS').length;
const failedChecks = results.filter((r) => r.status === 'FAIL');
failed += failedChecks.length;

console.log(`\n[qa] ${results.length} checks: ${passed} PASS, ${failedChecks.length} FAIL`);
console.log(`[qa] sandbox: ${SANDBOX}`);
if (failedChecks.length) {
  for (const r of failedChecks) console.log(`[qa] FAILED ${r.id}: ${r.error}`);
}

if (JSON_OUT) {
  fs.mkdirSync(path.dirname(JSON_OUT), { recursive: true });
  fs.writeFileSync(
    JSON_OUT,
    JSON.stringify(
      {
        suite: 'qa-admin-independent',
        at: new Date().toISOString(),
        checks: results.length,
        passed,
        failed: failedChecks.length,
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
