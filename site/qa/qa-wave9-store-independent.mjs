// site/qa/qa-wave9-store-independent.mjs
//
// QA WAVE-9 STORE WIRING -- INDEPENDENT COVERAGE (suite #14).
//
// WHAT IT PROVES, AT RUNTIME, IN BOTH STORE MODES
//   Area A  no JSONL fallback: every handler answers from the DATABASE. The
//          proof is DIFFERENTIAL, not a source scan: the database holds a
//          record marked QA-DB-MARKER and the JSONL file holds a DIFFERENT
//          record marked QA-FILE-MARKER, so a file fallback is visible in the
//          answer. All seeded JSONL files must be byte-identical afterwards.
//   Area B  the publisher: it publishes the DATABASE quote, and a failed
//          publish EXITS 1 and never replaces the published quotes with an
//          empty page.
//   Area C  the rate counter: the SQL counter is shared across two separate
//          processes, and the counter row lives in the DATABASE.
//   Area D  loud store errors: an unreachable or corrupt store answers
//          500 {code:'storage'} or 501 {code:'unimplemented'} -- never an
//          empty list and never an empty queue.
//   Area M  four mutation probes: each defect put back into a COPY of the
//          tree must redden the check that covers it, with the control
//          (unmodified copy) staying GREEN.
//
// THE SHAPE OF THE TEST
//   Every handler is bundled SEPARATELY (one esbuild bundle per module, as
//   Vercel builds one function per file) and loaded in its OWN child process.
//   The child speaks JSON lines over stdin/stdout, prefixed with the marker
//   @@QA@@ so the handlers' own console output can never be read as an answer.
//   No port is bound by the suite or by any child. The offline mock database
//   (the project's own test double) binds an OS-assigned ephemeral port on
//   127.0.0.1 and refuses 4321 explicitly; it speaks the real libSQL HTTP v2
//   pipeline protocol to a real SQLite engine (python's stdlib sqlite3).
//   Port 4321 (the running dev server) is never touched.
//
// WAVE 13 (the function budget) -- WHAT CHANGED IN THIS SUITE
//   The handler bodies moved out of api/ into site/shared/portal-handlers/,
//   and the rate limiter moved into site/shared/server/. The pins here now
//   resolve through site/qa/handler-paths.mjs, which reads the PRODUCT's own
//   route table (site/shared/portal-routes.json). A suite that hard-codes a
//   file path breaks on every move; a suite that resolves the path from the
//   product's single source of truth cannot drift from it.
//
// PROVENANCE
//   This file was REBUILT on 2026-10-22 after an accidental truncation by
//   QA's own tooling (a PowerShell path mistake wrote an empty file). The
//   rebuild follows the specification of the original suite, which is
//   preserved in qa-wave9-store-independent-2026-10-22.md (the report) and in
//   site/qa/artifacts/qa-wave9-store-independent-results.json (the check
//   list). Every check id, name and group below is the original one, so the
//   runner's transcript still lines up with the earlier evidence.
//
// USAGE
//   node site/qa/qa-wave9-store-independent.mjs [--json out.json] [--only ID]

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { handlerPath, serverPath, fwd } from './handler-paths.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.resolve(__dirname, '..');
const REPO = path.resolve(SITE, '..');

const argv = process.argv.slice(2);
const JSON_OUT = argv.includes('--json')
  ? path.resolve(argv[argv.indexOf('--json') + 1])
  : null;
const ONLY = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : null;

// The tree under test. QA_W9I_* point them at a COPY, which is how a defect
// is put back without touching the repository.
const API_DIR = process.env.QA_W9I_API_DIR
  ? path.resolve(process.env.QA_W9I_API_DIR)
  : path.join(REPO, 'api');
const SHARED_DIR = process.env.QA_W9I_SHARED_DIR
  ? path.resolve(process.env.QA_W9I_SHARED_DIR)
  : path.join(SITE, 'shared');
const PUBLISH_SCRIPT = process.env.QA_W9I_PUBLISH_SCRIPT
  ? path.resolve(process.env.QA_W9I_PUBLISH_SCRIPT)
  : path.join(SITE, 'scripts', 'publish-testimonials.mjs');

// The roots of the tree under test, for the handler-path resolver.
const ROOTS = { apiDir: API_DIR, sharedDir: SHARED_DIR };

// A nested run (the mutation probes) must not probe itself.
const PROBE_CHILD = process.env.QA_W9I_PROBE_CHILD === '1';

const STAMP = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
const SANDBOX = path.join(os.tmpdir(), 'opencode', `qa-wave9-independent-${STAMP}`);
const WORK = path.join(SANDBOX, 'work');

// ---------------------------------------------------------------------------
// the environment every child runs in: production-like, with LOCAL test
// secrets that are 32+ characters (the H-1 rule refuses anything shorter)
// ---------------------------------------------------------------------------
const SECRET = 'qa-wave9i-form-webhook-secret-0123456789';
const MAGIC_SECRET = 'qa-wave9i-magic-link-secret-0123456789';
const SESSION_SECRET = 'qa-wave9i-session-secret-0123456789';
const ADMIN_EMAIL = 'owner@imk.test';
const CLIENT_EMAIL = 'client@imk.test';
const CLIENT_ID = 'cli_qa_db';
const PROJECT_ID = 'prj_qa_db';
const SITE_ORIGIN = 'https://imk.test';

const BASE_ENV = {
  APP_ENV: 'production',
  NODE_ENV: 'production',
  SITE_BASE_URL: SITE_ORIGIN,
  RESEND_API_KEY: 'qa-wave9i-resend-key',
  RESEND_FROM: 'IMK <qa@imk.test>',
  RESEND_TO: ADMIN_EMAIL,
  FORM_WEBHOOK_SECRET: SECRET,
  ADMIN_EMAILS: ADMIN_EMAIL,
  PORTAL_MAGIC_LINK_SECRET: MAGIC_SECRET,
  PORTAL_SESSION_SECRET: SESSION_SECRET,
  PORTAL_RATE_LIMIT_FILE: '',
};

const DB_MARK = 'QA-DB-MARKER';
const FILE_MARK = 'QA-FILE-MARKER';

// ---------------------------------------------------------------------------
// helpers
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

/** A digest of every file under a root -- proves the repo is untouched. */
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
  path.join(SITE, 'scripts'),
  path.join(SITE, 'functions'),
];

function repoDigest() {
  return REPO_TREES.map((t) => `${t}\n${treeDigest(t)}`).join('\n---\n');
}

// ---------------------------------------------------------------------------
// the tiny assertion framework (QA's own)
// ---------------------------------------------------------------------------
const results = [];
let currentGroup = 'general';

function group(name) {
  currentGroup = name;
  console.log(`\n[qa] ${name}`);
}

/**
 * The --only filter.
 *
 * A token matches a check when it IS the check id, or when the check's GROUP
 * starts with it ('--only B' runs the whole B group). Several tokens may be
 * given, comma separated ('--only E9,E14'). An empty filter runs everything.
 */
const ONLY_TOKENS = ONLY ? ONLY.split(',').map((t) => t.trim()).filter(Boolean) : [];

function onlyMatches(id, groupName) {
  if (!ONLY_TOKENS.length) return true;
  return ONLY_TOKENS.some((t) => id === t || String(groupName).startsWith(t));
}

async function check(id, groupName, name, fn) {
  if (!onlyMatches(id, groupName)) return;
  currentGroup = groupName;
  try {
    const detail = await fn();
    results.push({
      id,
      group: currentGroup,
      name,
      status: 'PASS',
      detail: detail ?? null,
    });
    console.log(`  PASS  ${id}  ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (err) {
    results.push({
      id,
      group: groupName,
      name,
      status: 'FAIL',
      error: String(err && err.message ? err.message : err),
    });
    console.log(`  FAIL  ${id}  ${name}\n           ${err && err.message ? err.message : err}`);
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
// bundling (QA's own esbuild calls)
// ---------------------------------------------------------------------------
const built = new Map();

async function bundle(name, def) {
  if (built.has(name)) return built.get(name);
  const outFile = path.join(WORK, 'bundle', `${name}.cjs`);
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

/** Bundle ONE handler module (the route table's handler module name). */
async function bundleHandler(name, handlerModule) {
  return bundle(name, {
    dir: () => SHARED_DIR,
    code: `export { default as handler } from '${fwd(handlerPath(handlerModule, ROOTS))}';`,
  });
}

// ---------------------------------------------------------------------------
// the offline database: a real SQLite engine behind the real libSQL HTTP v2
// pipeline (site/shared/portal-store/test/mock-pipeline-server.ts)
// ---------------------------------------------------------------------------
let mockBundle = null;

async function startMock() {
  process.env.LIBSQL_SQLITE_WORKER = path.join(
    SHARED_DIR,
    'portal-store',
    'test',
    'sqlite-worker.py',
  );
  if (!mockBundle) {
    const outFile = path.join(WORK, 'mock-pipeline-server.mjs');
    await build({
      entryPoints: [path.join(SHARED_DIR, 'portal-store', 'test', 'mock-pipeline-server.ts')],
      outfile: outFile,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node20',
      logLevel: 'silent',
    });
    mockBundle = await import(pathToFileURL(outFile).href);
  }
  return mockBundle.startMockPipelineServer();
}

/** The store, in THIS process (for seeding and for reading the answer back). */
let storeModule = null;

async function loadStoreModule() {
  if (storeModule) return storeModule;
  const outFile = path.join(WORK, 'store-module.mjs');
  await build({
    entryPoints: [path.join(SHARED_DIR, 'portal-store', 'index.ts')],
    outfile: outFile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    logLevel: 'silent',
  });
  storeModule = await import(pathToFileURL(outFile).href);
  return storeModule;
}

function libsqlEnv(mock) {
  return {
    PORTAL_STORE: 'libsql',
    LIBSQL_URL: mock.url,
    LIBSQL_TOKEN: mock.token,
  };
}

// ---------------------------------------------------------------------------
// the child harness (QA's own): one bundle per process, JSON lines over
// stdin/stdout. Vercel builds one function per file, so that is the shape
// under test.
// ---------------------------------------------------------------------------
const CHILD_SRC = [
  'const fs = require("node:fs");',
  'const { Readable } = require("node:stream");',
  'const bundlePath = process.env.QA_W9I_BUNDLE;',
  'const logFile = process.env.QA_W9I_LOG_FILE || "";',
  'const mails = [];',
  '// The handlers LOG to stdout. stdout is the protocol channel here, so the',
  '// log lines go to a file instead -- otherwise a log line would be read as',
  '// the answer to a request.',
  'if (logFile) {',
  '  const write = function () {',
  '    const line = Array.prototype.map.call(arguments, function (a) {',
  '      return typeof a === "string" ? a : String(a);',
  '    }).join(" ");',
  '    try { fs.appendFileSync(logFile, line + "\\n"); } catch (e) {}',
  '  };',
  '  console.log = write;',
  '  console.error = write;',
  '}',
  '// No outbound request ever leaves this machine -- except the OFFLINE',
  '// mock database, which runs on this machine too.',
  'const REAL_FETCH = globalThis.fetch;',
  'globalThis.fetch = async function (url, init) {',
  '  const target = String(url);',
  '  const db = String(process.env.LIBSQL_URL || "");',
  '  if (db && target.indexOf(db) === 0) {',
  '    return await REAL_FETCH(url, init);',
  '  }',
  '  mails.push({ url: target, body: String((init && init.body) || ""), at: Date.now() });',
  '  if (target.includes("api.resend.com")) {',
  '    return { ok: true, status: 200, json: async () => ({ id: "qa-mail" }) };',
  '  }',
  '  throw new Error("[qa] blocked outbound request: " + target);',
  '};',
  '// The protocol marker: only a line that starts with it is an answer.',
  'const MARK = "@@QA@@";',
  'function reply(obj) { process.stdout.write(MARK + JSON.stringify(obj) + "\\n"); }',
  'function makeRes() {',
  '  const state = { status: 200, headers: {}, body: "" };',
  '  const res = {',
  '    statusCode: 200, headersSent: false, writableEnded: false,',
  '    writeHead: function (status, headers) {',
  '      state.status = status; state.headers = headers || {};',
  '      res.statusCode = status; res.headersSent = true; return res;',
  '    },',
  '    setHeader: function (k, v) { state.headers[k] = v; return res; },',
  '    getHeader: function (k) { return state.headers[k]; },',
  '    removeHeader: function (k) { delete state.headers[k]; return res; },',
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
  'function makeReq(msg) {',
  '  const body = msg.body === undefined || msg.body === null ? null : String(msg.body);',
  '  const req = new Readable({ read() {} });',
  '  if (body !== null) req.push(Buffer.from(body));',
  '  req.push(null);',
  '  req.method = msg.method || "GET";',
  '  req.url = msg.url || "/";',
  '  req.headers = msg.headers || {};',
  '  return req;',
  '}',
  'let mod = null;',
  'try {',
  '  mod = require(bundlePath);',
  '} catch (err) {',
  '  reply({ ready: false, error: String((err && err.stack) || err) });',
  '  process.exit(3);',
  '}',
  'async function handle(msg) {',
  '  try {',
  '    if (msg.cmd === "request") {',
  '      const fn = mod.handler;',
  '      if (typeof fn !== "function") throw new Error("the bundle has no handler");',
  '      const made = makeRes();',
  '      await fn(makeReq(msg), made.res);',
  '      reply({ ok: true, status: made.state.status, headers: made.state.headers, body: made.state.body });',
  '      return;',
  '    }',
  '    if (msg.cmd === "session") {',
  '      reply({ ok: true, token: mod.createSession(msg.email, msg.role, msg.clientId) });',
  '      return;',
  '    }',
  '    if (msg.cmd === "mails") { reply({ ok: true, mails: mails }); return; }',
  '    if (msg.cmd === "rate") {',
  '      if (typeof mod.createPortalRateLimiter !== "function") {',
  '        reply({ ok: false, error: "the bundle has no rate limiter" }); return;',
  '      }',
  '      const limiter = mod.createPortalRateLimiter(process.env);',
  '      const decision = await limiter.consume(msg.key, msg.limit, msg.windowMs);',
  '      reply({ ok: true, decision: decision });',
  '      return;',
  '    }',
  '    if (msg.cmd === "quit") { reply({ ok: true, bye: true }); process.exit(0); }',
  '    reply({ ok: false, error: "unknown command " + msg.cmd });',
  '  } catch (err) {',
  '    reply({ ok: false, error: String((err && err.stack) || err) });',
  '  }',
  '}',
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
  'reply({ ready: true });',
].join('\n');

const PROTOCOL_MARK = '@@QA@@';
const CHILD_PATH = path.join(SANDBOX, 'child.cjs');

class BundleChild {
  constructor(name, bundlePath, env) {
    this.name = name;
    this.bundlePath = bundlePath;
    this.env = env || {};
    this.waiters = [];
    this.buffer = '';
    this.stderr = '';
    this.noise = '';
    this.proc = null;
    this.readyPromise = null;
  }

  start() {
    this.proc = spawn(process.execPath, [CHILD_PATH], {
      cwd: SANDBOX,
      env: {
        ...process.env,
        ...BASE_ENV,
        ...this.env,
        QA_W9I_BUNDLE: this.bundlePath,
        QA_W9I_LOG_FILE: path.join(SANDBOX, 'logs', this.name + '.log'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    fs.mkdirSync(path.join(SANDBOX, 'logs'), { recursive: true });
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
      // Only the protocol marker is an answer. Anything else is the handler's
      // own output and must never be read as a response.
      if (!line.startsWith(PROTOCOL_MARK)) {
        this.noise += line + '\n';
        continue;
      }
      let msg;
      try {
        msg = JSON.parse(line.slice(PROTOCOL_MARK.length));
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

  async request(method, url, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    if (opts.cookie) headers.cookie = opts.cookie;
    let raw;
    try {
      raw = await this.send({
        cmd: 'request',
        method,
        url,
        headers,
        body: opts.body,
      });
    } catch (err) {
      return { threw: true, error: err.message, status: 0, headers: {}, text: '', json: null };
    }
    if (raw.ok === false) {
      return { threw: true, error: raw.error, status: 0, headers: {}, text: '', json: null };
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

  async mails() {
    const raw = await this.send({ cmd: 'mails' });
    return (raw && raw.mails) || [];
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

async function startChild(name, bundlePath, env) {
  const child = new BundleChild(name, bundlePath, env);
  children.push(child);
  await child.start();
  return child;
}

// ---------------------------------------------------------------------------
// the sandbox: the JSONL files that a file fallback would read
// ---------------------------------------------------------------------------
const DATA_DIR = path.join(SANDBOX, 'site', 'data');
const PUBLISHED_DIR = path.join(SANDBOX, 'site', 'src', 'content', 'testimonials');

// The seven JSONL files the store can read. The 'sessions' collection is
// not among them: no handler in the tree reads it.
const JSONL_FILES = [
  ['portal/projects.jsonl', { id: 'prj_qa_file', clientId: 'cli_file', title: `${FILE_MARK} project`, status: 'active', createdAt: '2026-01-01T00:00:00.000Z' }],
  ['portal/clients.jsonl', { id: 'cli_file', email: 'other@file.test', name: `${FILE_MARK} client`, company: 'File Ltd', createdAt: '2026-01-01T00:00:00.000Z' }],
  // The FILE invite belongs to ANOTHER address: a file fallback would find no
  // invite for the client and would send NO mail.
  ['portal/invited.jsonl', { email: 'other@file.test', name: `${FILE_MARK} client`, company: 'File Ltd', invitedBy: ADMIN_EMAIL, invitedAt: '2026-01-01T00:00:00.000Z', clientId: 'cli_file' }],
  ['portal/comments.jsonl', { id: 'cmt_qa_file', projectId: 'prj_qa_file', author: `${FILE_MARK} client`, body: `${FILE_MARK} comment`, createdAt: '2026-01-01T00:00:00.000Z' }],
  ['portal/planItems.jsonl', { id: 'pli_qa_file', projectId: 'prj_qa_file', title: `${FILE_MARK} plan item`, status: 'todo', createdAt: '2026-01-01T00:00:00.000Z' }],
  ['portal/updates.jsonl', { id: 'upd_qa_file', projectId: 'prj_qa_file', title: `${FILE_MARK} update`, body: `${FILE_MARK} body`, createdAt: '2026-01-01T00:00:00.000Z' }],
  ['moderation/reviews.jsonl', { ref: 'inq_qa_file', type: 'review', name: `${FILE_MARK} Client`, company: 'File Ltd', rating: 5, review: `${FILE_MARK} quote`, revision: 1, state: 'pending', projectId: 'prj_qa_file', clientId: 'cli_file', receivedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z' }],
];

/** Write the seven JSONL files, each with its FILE marker record. */
function seedJsonlFiles() {
  for (const [rel, record] of JSONL_FILES) {
    const file = path.join(DATA_DIR, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(record) + '\n', 'utf8');
  }
}

/** A digest of the seven JSONL files -- they must not change during a run. */
function jsonlDigest() {
  const parts = [];
  for (const [rel] of JSONL_FILES) {
    const file = path.join(DATA_DIR, rel);
    const hash = fs.existsSync(file)
      ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
      : 'absent';
    parts.push(`${rel}:${hash}`);
  }
  return parts.join('\n');
}

/** The DATABASE records -- the same shapes, marked QA-DB-MARKER. */
const DB_RECORDS = {
  clients: { id: CLIENT_ID, email: CLIENT_EMAIL, name: 'Client DB', company: 'DB Ltd', createdAt: '2026-01-01T00:00:00.000Z' },
  projects: { id: PROJECT_ID, clientId: CLIENT_ID, title: `${DB_MARK} project`, status: 'active', createdAt: '2026-01-01T00:00:00.000Z' },
  invites: { email: CLIENT_EMAIL, name: 'Client DB', company: 'DB Ltd', invitedBy: ADMIN_EMAIL, invitedAt: '2026-01-01T00:00:00.000Z', clientId: CLIENT_ID },
  comments: { id: 'cmt_qa_db', projectId: PROJECT_ID, author: 'Client DB', body: `${DB_MARK} comment`, createdAt: '2026-01-01T00:00:00.000Z' },
  planItems: { id: 'pli_qa_db', projectId: PROJECT_ID, title: `${DB_MARK} plan item`, status: 'todo', createdAt: '2026-01-01T00:00:00.000Z' },
  updates: { id: 'upd_qa_db', projectId: PROJECT_ID, title: `${DB_MARK} update`, body: `${DB_MARK} body`, createdAt: '2026-01-01T00:00:00.000Z' },
  // The review record carries the marker in BOTH the name and the text: the
  // owner's inbox answers with the name (and not with the quote), and the
  // client's own-quote endpoint answers with the text.
  reviews: { ref: 'inq_qa_db', type: 'review', name: `${DB_MARK} Client`, company: 'DB Ltd', rating: 5, review: `${DB_MARK} quote`, revision: 1, state: 'pending', projectId: PROJECT_ID, clientId: CLIENT_ID, consent: { p1: true, p2: true, p3: false }, receivedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z' },
};

/** Seed the database through the store contract itself. */
async function seedDatabase() {
  const store = getPortalStore();
  for (const [coll, record] of Object.entries(DB_RECORDS)) {
    await store.append(coll, { ...record });
  }
}

let portalStore = null;
function getPortalStore() {
  if (!portalStore) {
    // getStore(env) selects the backend from the ENVIRONMENT, so the whole
    // environment has to be handed over -- not an empty object.
    portalStore = storeModule.getStore(process.env);
  }
  return portalStore;
}

// ---------------------------------------------------------------------------
// QA's own HMAC over the moderation parameters -- not the project's helper
// ---------------------------------------------------------------------------
function qaSignModeration(ref, decision, revision, ts, recordId) {
  const message =
    recordId === undefined || recordId === ''
      ? `${ref}|${decision}|${revision}|${ts}`
      : `${ref}|${decision}|${revision}|${recordId}|${ts}`;
  return crypto.createHmac('sha256', SECRET).update(message).digest('hex');
}

// ---------------------------------------------------------------------------
// the per-handler scenarios of area A
// ---------------------------------------------------------------------------
// `collection`  the collection the handler must answer from
// `markerIn`    where the marker must appear ('response' | 'database')
const A_SCENARIOS = [
  {
    id: 'A1-projects',
    handler: 'portal-projects',
    bundle: 'a1-projects',
    collection: 'projects',
    markerIn: 'response',
    what: 'GET /api/portal/projects answers from the DATABASE',
    request: { method: 'GET', url: '/api/portal/projects', who: 'owner' },
  },
  {
    id: 'A2-plan-items',
    handler: 'portal-plan-items',
    bundle: 'a2-plan-items',
    collection: 'planItems',
    markerIn: 'response',
    what: 'GET /api/portal/plan-items answers from the DATABASE',
    request: {
      method: 'GET',
      url: `/api/portal/plan-items?projectId=${PROJECT_ID}`,
      who: 'client',
    },
  },
  {
    id: 'A3-updates',
    handler: 'portal-updates',
    bundle: 'a3-updates',
    collection: 'updates',
    markerIn: 'response',
    what: 'GET /api/portal/updates answers from the DATABASE',
    request: {
      method: 'GET',
      url: `/api/portal/updates?projectId=${PROJECT_ID}`,
      who: 'client',
    },
  },
  {
    id: 'A4-comments',
    handler: 'portal-comments',
    bundle: 'a4-comments',
    collection: 'comments',
    markerIn: 'response',
    what: 'GET /api/portal/comments answers from the DATABASE',
    request: {
      method: 'GET',
      url: `/api/portal/comments?projectId=${PROJECT_ID}`,
      who: 'client',
    },
  },
  {
    id: 'A5-testimonials',
    handler: 'portal-testimonials',
    bundle: 'a5-testimonials',
    collection: 'reviews',
    markerIn: 'response',
    what: 'GET /api/portal/testimonials answers from the DATABASE (the client\'s own quote)',
    request: {
      method: 'GET',
      url: `/api/portal/testimonials?projectId=${PROJECT_ID}`,
      who: 'client',
    },
  },
  {
    id: 'A6-auth',
    handler: 'portal-auth',
    bundle: 'a6-auth',
    collection: 'invites',
    markerIn: 'database',
    what:
      'POST /api/portal/auth/request-link finds the invite in the DATABASE (the FILE invite is for another address, so a file fallback would send NO mail)',
    request: {
      method: 'POST',
      url: '/api/portal/auth/request-link',
      who: 'none',
      body: { email: CLIENT_EMAIL },
    },
  },
  {
    id: 'A7-invites',
    handler: 'portal-invites',
    bundle: 'a7-invites',
    collection: 'invites',
    markerIn: 'database',
    what: 'POST /api/portal/invites writes the invite to the DATABASE',
    request: {
      method: 'POST',
      url: '/api/portal/invites',
      who: 'owner',
      body: { email: 'new@client.test', name: 'New Client', company: 'New Ltd' },
    },
  },
  {
    id: 'A8-moderate',
    handler: 'moderate',
    bundle: 'a8-moderate',
    collection: 'reviews',
    markerIn: 'database',
    what: 'POST /api/moderate/review decides in the DATABASE',
    request: { method: 'POST', url: '/api/moderate/review', who: 'owner', moderation: true },
  },
  {
    id: 'A9-admin-inbox',
    handler: 'admin-reviews',
    bundle: 'a9-admin-inbox',
    collection: 'reviews',
    markerIn: 'response',
    what: 'GET /api/admin/reviews (the owner\'s inbox) answers from the DATABASE',
    request: { method: 'GET', url: '/api/admin/reviews', who: 'owner' },
  },
];

// ---------------------------------------------------------------------------
// the publisher
// ---------------------------------------------------------------------------
/**
 * Run the publisher in a child process.
 *
 * It is ASYNCHRONOUS on purpose: the mock database runs inside THIS process,
 * and a synchronous spawn would block the event loop -- the database could
 * not answer the publisher and every libsql publish would fail with
 * "fetch failed" for a reason that has nothing to do with the product.
 */
function runPublisherIn(root, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [PUBLISH_SCRIPT], {
      cwd: root,
      env: { ...process.env, ...BASE_ENV, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => {
      stdout += c;
    });
    child.stderr.on('data', (c) => {
      stderr += c;
    });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.on('error', (err) => resolve({ status: 1, stdout, stderr: `${stderr}\n${err.message}` }));
  });
}

function publishedFiles(root) {
  // The publisher resolves its published directory as <cwd>/src/content/testimonials.
  const dir = path.join(root, 'src', 'content', 'testimonials');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
}

// ---------------------------------------------------------------------------
// the main run
// ---------------------------------------------------------------------------
let mock = null;
let sessionBundle = null;

async function mintSession(role, clientId) {
  const child = await startChild(`session-${role}`, sessionBundle);
  try {
    const raw = await child.send({ cmd: 'session', email: role === 'admin' ? ADMIN_EMAIL : CLIENT_EMAIL, role, clientId });
    assert(raw && raw.token, `the ${role} session could not be minted: ${raw && raw.error}`);
    const name = role === 'admin' ? 'imk_admin_session' : 'imk_session';
    return `${name}=${raw.token}`;
  } finally {
    await child.stop();
  }
}

async function runScenario(scenario, env) {
  const bundleFile = await bundleHandler(scenario.bundle, scenario.handler);
  const child = await startChild(scenario.id, bundleFile, env);
  try {
    const headers = { ...(scenario.request.headers || {}) };
    let body;
    if (scenario.request.who === 'owner') {
      headers.cookie = await mintSession('admin');
    } else if (scenario.request.who === 'client') {
      headers.cookie = await mintSession('client', CLIENT_ID);
    }
    if (scenario.request.moderation) {
      const ts = Math.floor(Date.now() / 1000);
      const record = await getPortalStore().latest('reviews', { ref: 'inq_qa_db', type: 'review' });
      const recordId = record ? String(record.recordId || '') : '';
      const sig = qaSignModeration('inq_qa_db', 'approve', 1, ts, recordId);
      const query = new URLSearchParams({
        ref: 'inq_qa_db',
        decision: 'approve',
        revision: '1',
        ts: String(ts),
        sig,
      });
      if (recordId) query.set('recordId', recordId);
      headers.origin = SITE_ORIGIN;
      body = query.toString();
      headers['content-type'] = 'application/x-www-form-urlencoded';
    } else if (scenario.request.body) {
      headers.origin = SITE_ORIGIN;
      headers['content-type'] = 'application/json';
      body = JSON.stringify(scenario.request.body);
    }
    const res = await child.request(scenario.request.method, scenario.request.url, {
      headers,
      body,
    });
    // The captured mails are read BEFORE the child is stopped -- a stopped
    // child has no stdin left to ask.
    const mails = await child.mails();
    return { res, child, mails };
  } finally {
    await child.stop();
  }
}

async function main() {
  fs.mkdirSync(SANDBOX, { recursive: true });
  fs.mkdirSync(WORK, { recursive: true });
  fs.mkdirSync(path.join(SANDBOX, 'logs'), { recursive: true });
  fs.writeFileSync(CHILD_PATH, CHILD_SRC, 'utf8');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(PUBLISHED_DIR, { recursive: true });

  console.log(`[qa] sandbox: ${SANDBOX}`);
  console.log(`[qa] tree:    api=${API_DIR}`);
  console.log(`[qa] shared:  ${SHARED_DIR}`);

  const repoBefore = repoDigest();

  // The database and the store module.
  mock = await startMock();
  process.env.PORTAL_STORE = 'libsql';
  process.env.LIBSQL_URL = mock.url;
  process.env.LIBSQL_TOKEN = mock.token;
  process.env.PORTAL_DATA_DIR = DATA_DIR;
  await loadStoreModule();
  await seedDatabase();
  seedJsonlFiles();

  const jsonlBefore = jsonlDigest();

  sessionBundle = await bundle('session', {
    dir: () => SHARED_DIR,
    code:
      `export { createSession } from '${fwd(handlerPath('portal-session', ROOTS))}';`,
  });

  const libEnv = libsqlEnv(mock);

  // =====================================================================
  // AREA A -- no JSONL fallback (differential, at runtime)
  // =====================================================================
  group('A -- no JSONL fallback');
  for (const scenario of A_SCENARIOS) {
    await check(
      scenario.id,
      'A -- no JSONL fallback',
      scenario.what,
      async () => {
        const { res, mails } = await runScenario(scenario, libEnv);
        assert(!res.threw, `the handler threw: ${res.error}`);

        if (scenario.markerIn === 'response') {
          assert(
            res.text.includes(DB_MARK),
            `the answer does not carry the DATABASE marker (${DB_MARK}) -- it came from the FILE store: ${res.text.slice(0, 400)}`,
          );
          assert(
            !res.text.includes(FILE_MARK),
            `the answer carries the FILE marker (${FILE_MARK}) -- the handler read the JSONL file`,
          );
        }

        if (scenario.id === 'A6-auth') {
          assert(
            mails.length >= 1,
            'no mail was sent -- the invite was NOT found in the DATABASE',
          );
          const decoded = mails.map((m) => decodeToken(m)).join(' ');
          assert(
            decoded.includes(CLIENT_EMAIL),
            `the mail went to the wrong address (decoded: ${decoded.slice(0, 200)}) -- ` +
              `the FILE invite was used. The captured mail was: ${JSON.stringify(mails[0]).slice(0, 500)}`,
          );
          assert(
            !decoded.includes('other@file.test'),
            'the mail carried the FILE invite address',
          );
        }

        if (scenario.id === 'A7-invites') {
          const stored = await getPortalStore().get('invites', {
            field: 'email',
            value: 'new@client.test',
          });
          assert(stored, 'the new invite is NOT in the DATABASE');
        }

        if (scenario.id === 'A8-moderate') {
          assertEqual(res.status, 200, `the decision failed: ${res.text.slice(0, 300)}`);
          const decided = await getPortalStore().latest('reviews', {
            ref: 'inq_qa_db',
            type: 'review',
          });
          assert(decided, 'the review is not in the DATABASE');
          assertEqual(decided.state, 'approved', 'the decision did not land in the DATABASE');
        }

        // The file adapter was not used for reading OR writing.
        assertEqual(
          jsonlDigest(),
          jsonlBefore,
          'a seeded JSONL file changed -- the file adapter was used',
        );
        return `answered from the DATABASE, ${JSONL_FILES.length} JSONL files byte-identical`;
      },
    );
  }

  // =====================================================================
  // AREA B -- the publisher
  // =====================================================================
  group('B -- the publisher');
  // The publisher runs with its OWN root: it resolves the published directory
  // as <cwd>/src/content/testimonials and the data directory as
  // <cwd>/site/data (or PORTAL_DATA_DIR). So the publisher gets a sandbox of
  // its own -- the repository's own published directory is never touched.
  const publishRoot = path.join(SANDBOX, 'publish');
  const published = path.join(publishRoot, 'src', 'content', 'testimonials');
  fs.mkdirSync(published, { recursive: true });
  fs.mkdirSync(path.join(publishRoot, 'site', 'data', 'moderation'), { recursive: true });
  fs.writeFileSync(
    path.join(publishRoot, 'site', 'data', 'moderation', 'reviews.jsonl'),
    JSON.stringify({
      ref: 'inq_qa_file',
      type: 'review',
      name: 'File Client',
      company: 'File Ltd',
      rating: 5,
      review: `${FILE_MARK} approved quote`,
      revision: 1,
      state: 'approved',
      clientId: 'cli_file',
      consent: { p1: true, p2: true, p3: false },
      receivedAt: '2026-01-01T00:00:00.000Z',
    }) + '\n',
    'utf8',
  );
  // The ALREADY PUBLISHED quote. B2 and B3 need one to survive a failed
  // publish, and it has to be there before the first check runs -- the suite
  // must be correct when a single check is run on its own (the mutation
  // probes do exactly that).
  fs.writeFileSync(
    path.join(published, 'inq_qa_db.md'),
    `---\nname: "Client DB"\nrating: 5\nverified: true\n---\n\n${DB_MARK} approved quote\n`,
    'utf8',
  );

  await check(
    'B1-publisher-database',
    'B -- the publisher',
    'the publisher publishes the quote from the DATABASE, not from the JSONL file',
    async () => {
      // An APPROVED record in the DATABASE, and an APPROVED but DIFFERENT
      // record in the JSONL file.
      await getPortalStore().append('reviews', {
        ref: 'inq_qa_db',
        type: 'review',
        name: 'Client DB',
        company: 'DB Ltd',
        rating: 5,
        review: `${DB_MARK} approved quote`,
        revision: 2,
        state: 'approved',
        clientId: CLIENT_ID,
        consent: { p1: true, p2: true, p3: false },
        receivedAt: '2026-01-01T00:00:00.000Z',
      });

      const res = await runPublisherIn(publishRoot, {
        ...libEnv,
        PORTAL_DATA_DIR: path.join(publishRoot, 'site', 'data'),
      });
      assertEqual(res.status, 0, `the publisher failed: ${res.stderr}`);
      const files = publishedFiles(publishRoot);
      assertEqual(files.length, 1, `expected one published file, got ${files.length}`);
      const body = fs.readFileSync(path.join(published, files[0]), 'utf8');
      assert(body.includes(DB_MARK), 'the published file does not carry the DATABASE quote');
      assert(!body.includes(FILE_MARK), 'the published file carries the JSONL quote');
      return `1 published file, the database quote (exit 0)`;
    },
  );

  await check(
    'B2-publisher-unreachable',
    'B -- the publisher',
    'the publisher EXITS 1 when the store is unreachable and never publishes an empty page',
    async () => {
      const before = publishedFiles(publishRoot);
      assert(before.length >= 1, 'the control needs an already published quote');
      const res = await runPublisherIn(publishRoot, {
        PORTAL_STORE: 'libsql',
        // A port nothing listens on.
        LIBSQL_URL: 'http://127.0.0.1:1',
        LIBSQL_TOKEN: mock.token,
        PORTAL_DATA_DIR: path.join(publishRoot, 'site', 'data'),
      });
      assert(res.status !== 0, `the publisher exited 0 with an unreachable store (${res.stdout})`);
      assert(
        /error|unreachable|storage/i.test(res.stderr + res.stdout),
        `the failure was not explained: ${res.stderr} ${res.stdout}`,
      );
      const after = publishedFiles(publishRoot);
      assertEqual(after.length, before.length, 'the published quotes were lost');
      const body = fs.readFileSync(path.join(published, after[0]), 'utf8');
      assert(body.includes(DB_MARK), 'the already published quote was replaced');
      return `exit ${res.status}, the published quote survived`;
    },
  );

  await check(
    'B3-publisher-misconfigured',
    'B -- the publisher',
    'the publisher EXITS 1 when the store is MISCONFIGURED and publishes nothing',
    async () => {
      const before = publishedFiles(publishRoot);
      const res = await runPublisherIn(publishRoot, {
        PORTAL_STORE: 'libsql',
        // No LIBSQL_URL at all.
        LIBSQL_TOKEN: '',
        PORTAL_DATA_DIR: path.join(publishRoot, 'site', 'data'),
      });
      assert(res.status !== 0, `the publisher exited 0 with a misconfigured store (${res.stdout})`);
      const after = publishedFiles(publishRoot);
      assertEqual(after.length, before.length, 'the published set changed');
      return `exit ${res.status}, nothing published`;
    },
  );

  await check(
    'B4-publisher-file-control',
    'B -- the publisher',
    'the publisher reads the FILE store in file mode (the control for B1)',
    async () => {
      for (const f of publishedFiles(publishRoot)) {
        fs.rmSync(path.join(published, f), { force: true });
      }
      const res = await runPublisherIn(publishRoot, {
        PORTAL_STORE: 'file',
        PORTAL_DATA_DIR: path.join(publishRoot, 'site', 'data'),
      });
      assertEqual(res.status, 0, `the publisher failed in file mode: ${res.stderr}`);
      const files = publishedFiles(publishRoot);
      assertEqual(files.length, 1, `expected one published file, got ${files.length}`);
      const body = fs.readFileSync(path.join(published, files[0]), 'utf8');
      assert(body.includes(FILE_MARK), 'the published file does not carry the JSONL quote');
      assert(!body.includes(DB_MARK), 'the published file carries the database quote');
      return `1 published file, the file quote (exit 0)`;
    },
  );

  // =====================================================================
  // AREA C -- the rate counter
  // =====================================================================
  group('C -- the rate counter');
  const rateBundle = await bundle('rate', {
    dir: () => SHARED_DIR,
    code: `export { createPortalRateLimiter } from '${fwd(serverPath('rate-limit', ROOTS))}';`,
  });

  /** One hit, in a process of its own. */
  async function rateHitInChild(name, env, key) {
    const child = await startChild(name, rateBundle, env);
    try {
      const raw = await child.send({ cmd: 'rate', key, limit: 5, windowMs: 60000 });
      assert(raw && raw.ok, `the ${name} child did not answer: ${raw && raw.error}`);
      return raw.decision;
    } finally {
      await child.stop();
    }
  }

  await check(
    'C1-counter-shared',
    'C -- the rate counter',
    'the SQL counter is SHARED across two separate processes',
    async () => {
      const key = `qa-shared-${Date.now()}`;
      const first = await rateHitInChild('counter-a', libEnv, key);
      const second = await rateHitInChild('counter-b', libEnv, key);
      assertEqual(first.count, 1, 'the first hit was not counted');
      assertEqual(
        second.count,
        2,
        `the second process did not SEE the first count (count=${second.count}) -- the counter is not shared`,
      );
      return `process A counted 1, process B counted ${second.count}`;
    },
  );

  await check(
    'C2-counter-per-process',
    'C -- the rate counter',
    'in file mode the counter is per PROCESS (as documented)',
    async () => {
      const key = `qa-per-process-${Date.now()}`;
      const first = await rateHitInChild('counter-file-a', { PORTAL_STORE: 'file' }, key);
      const second = await rateHitInChild('counter-file-b', { PORTAL_STORE: 'file' }, key);
      assertEqual(first.count, 1, 'the first hit was not counted');
      assertEqual(
        second.count,
        1,
        `the file counter was shared (count=${second.count}) -- it must be per process`,
      );
      return '1 and 1';
    },
  );

  await check(
    'C3-counter-in-database',
    'C -- the rate counter',
    'the counter row lives in the DATABASE, not in a file',
    async () => {
      const key = `qa-in-db-${Date.now()}`;
      await rateHitInChild('counter-db', libEnv, key);
      // The durable counter writes through the store, so the row is in the
      // DATABASE. The mock records every request body it received: the
      // counter's own statement names the table it wrote to.
      const counterStatements = mock.requests.filter((r) =>
        /rate_counters/.test(JSON.stringify(r)),
      );
      assert(
        counterStatements.length >= 1,
        'no statement against rate_counters reached the database -- the counter did not go to the DATABASE',
      );
      // And no counter FILE was written anywhere.
      const counterFiles = findFiles(path.join(SANDBOX, 'site', 'data'), 'rate');
      assertEqual(counterFiles.length, 0, `a counter file was written: ${counterFiles.join(', ')}`);
      return `${counterStatements.length} statement(s) against rate_counters, 0 files`;
    },
  );

  // =====================================================================
  // AREA D -- loud store errors
  // =====================================================================
  group('D -- loud store errors');
  await check(
    'D1-portal-db-down',
    'D -- loud store errors',
    'a portal route with an UNREACHABLE database answers 500 {code:storage}, never an empty list',
    async () => {
      const bundleFile = await bundleHandler('d1-projects', 'portal-projects');
      const child = await startChild('d1-projects', bundleFile, {
        PORTAL_STORE: 'libsql',
        LIBSQL_URL: 'http://127.0.0.1:1',
        LIBSQL_TOKEN: mock.token,
      });
      try {
        // The session is checked BEFORE the store is read, so the request
        // has to be signed in -- otherwise a 401 would hide the store
        // failure this check is about.
        const res = await child.request('GET', '/api/portal/projects', {
          headers: { cookie: await mintSession('admin') },
        });
        assert(!res.threw, `the handler threw: ${res.error}`);
        assertEqual(res.status, 500, `expected 500, got ${res.status}: ${res.text.slice(0, 300)}`);
        assertEqual(res.json && res.json.code, 'storage', `the code must be 'storage': ${res.text.slice(0, 300)}`);
        assert(!/"projects"\s*:\s*\[\s*\]/.test(res.text), 'the answer is an empty list');
        return '500 {code:storage}, no empty list';
      } finally {
        await child.stop();
      }
    },
  );

  await check(
    'D2-portal-corrupt-file',
    'D -- loud store errors',
    'a portal route with a CORRUPT store answers 500 {code:storage}, never an empty list',
    async () => {
      const corruptDir = path.join(SANDBOX, 'corrupt');
      fs.mkdirSync(path.join(corruptDir, 'portal'), { recursive: true });
      fs.writeFileSync(
        path.join(corruptDir, 'portal', 'projects.jsonl'),
        '{ this is not json\n',
        'utf8',
      );
      const bundleFile = await bundleHandler('d2-projects', 'portal-projects');
      const child = await startChild('d2-projects', bundleFile, {
        PORTAL_STORE: 'file',
        PORTAL_DATA_DIR: corruptDir,
      });
      try {
        const res = await child.request('GET', '/api/portal/projects', {
          headers: { cookie: await mintSession('admin') },
        });
        assert(!res.threw, `the handler threw: ${res.error}`);
        assertEqual(res.status, 500, `expected 500, got ${res.status}: ${res.text.slice(0, 300)}`);
        assertEqual(res.json && res.json.code, 'storage', `the code must be 'storage': ${res.text.slice(0, 300)}`);
        assert(!/"projects"\s*:\s*\[\s*\]/.test(res.text), 'the answer is an empty list');
        return '500 {code:storage}, no empty list';
      } finally {
        await child.stop();
      }
    },
  );

  await check(
    'D3-moderation-store-missing',
    'D -- loud store errors',
    'the moderation endpoint with NO store answers 501 {code:unimplemented} -- it never approves',
    async () => {
      const emptyDir = path.join(SANDBOX, 'no-store');
      fs.mkdirSync(emptyDir, { recursive: true });
      const bundleFile = await bundleHandler('d3-moderate', 'moderate');
      const child = await startChild('d3-moderate', bundleFile, {
        PORTAL_STORE: 'file',
        PORTAL_DATA_DIR: emptyDir,
      });
      try {
        const ts = Math.floor(Date.now() / 1000);
        const sig = qaSignModeration('inq_qa_db', 'approve', 1, ts, '');
        const url = `/api/moderate/review?ref=inq_qa_db&decision=approve&revision=1&ts=${ts}&sig=${sig}`;
        const res = await child.request('POST', url, {
          headers: { origin: SITE_ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
          body: '',
        });
        assert(!res.threw, `the handler threw: ${res.error}`);
        assertEqual(res.status, 501, `expected 501, got ${res.status}: ${res.text.slice(0, 300)}`);
        assertEqual(res.json && res.json.code, 'unimplemented', `the code must be 'unimplemented': ${res.text.slice(0, 300)}`);
        assert(!/approved/.test(res.text), 'the answer claims an approval');
        return '501 {code:unimplemented}, nothing approved';
      } finally {
        await child.stop();
      }
    },
  );

  await check(
    'D4-inbox-store-missing',
    'D -- loud store errors',
    "the owner's inbox with NO store answers 501 {code:unimplemented} -- never an empty queue",
    async () => {
      const emptyDir = path.join(SANDBOX, 'no-store-inbox');
      fs.mkdirSync(emptyDir, { recursive: true });
      const bundleFile = await bundleHandler('d4-inbox', 'admin-reviews');
      const child = await startChild('d4-inbox', bundleFile, {
        PORTAL_STORE: 'file',
        PORTAL_DATA_DIR: emptyDir,
      });
      try {
        // The owner gate comes BEFORE the store check, so the request has to
        // be signed in -- otherwise a 401 would hide the store failure.
        const res = await child.request('GET', '/api/admin/reviews', {
          headers: { cookie: await mintSession('admin') },
        });
        assert(!res.threw, `the handler threw: ${res.error}`);
        assertEqual(res.status, 501, `expected 501, got ${res.status}: ${res.text.slice(0, 300)}`);
        assertEqual(res.json && res.json.code, 'unimplemented', `the code must be 'unimplemented': ${res.text.slice(0, 300)}`);
        assert(!/pendingReviews/.test(res.text), 'the answer is an empty queue');
        return '501 {code:unimplemented}, no empty queue';
      } finally {
        await child.stop();
      }
    },
  );

  await check(
    'D5-inbox-db-down',
    'D -- loud store errors',
    "the owner's inbox with an UNREACHABLE database answers 501 {code:unimplemented}",
    async () => {
      const bundleFile = await bundleHandler('d5-inbox', 'admin-reviews');
      const child = await startChild('d5-inbox', bundleFile, {
        PORTAL_STORE: 'libsql',
        LIBSQL_URL: 'http://127.0.0.1:1',
        LIBSQL_TOKEN: mock.token,
      });
      try {
        const res = await child.request('GET', '/api/admin/reviews', {
          headers: { cookie: await mintSession('admin') },
        });
        assert(!res.threw, `the handler threw: ${res.error}`);
        assertEqual(res.status, 501, `expected 501, got ${res.status}: ${res.text.slice(0, 300)}`);
        assertEqual(res.json && res.json.code, 'unimplemented', `the code must be 'unimplemented': ${res.text.slice(0, 300)}`);
        assert(!/pendingReviews/.test(res.text), 'the answer is an empty queue');
        return '501 {code:unimplemented}, no empty queue';
      } finally {
        await child.stop();
      }
    },
  );

  // =====================================================================
  // AREA M -- the mutation probes
  // =====================================================================
  group('M -- mutation probes');
  if (!PROBE_CHILD) {
    await runProbes();
  }

  // =====================================================================
  // housekeeping
  // =====================================================================
  await check(
    'tree-untouched',
    'Z -- housekeeping',
    'the shipped tree is byte-identical after the run',
    async () => {
      assertEqual(repoDigest(), repoBefore, 'the shipped tree changed during the run');
      return 'api/, site/shared/, site/scripts/ and site/functions/ are byte-for-byte unchanged';
    },
  );

  // ---- report ----
  const passed = results.filter((r) => r.status === 'PASS').length;
  const failed = results.filter((r) => r.status === 'FAIL').length;
  console.log(`\n[qa] ${results.length} checks: ${passed} PASS, ${failed} FAIL`);
  if (JSON_OUT) {
    fs.writeFileSync(
      JSON_OUT,
      JSON.stringify({ results, passed, failed, at: new Date().toISOString() }, null, 2),
      'utf8',
    );
    console.log(`[qa] results: ${JSON_OUT}`);
  }
  rmrf(SANDBOX);
  process.exit(failed ? 1 : 0);
}

// ---------------------------------------------------------------------------
// the mutation probes
// ---------------------------------------------------------------------------
function patch(file, from, to) {
  const raw = fs.readFileSync(file, 'utf8');
  if (!raw.includes(from)) {
    throw new Error(`the patch anchor was not found in ${file}: ${from.slice(0, 70)}`);
  }
  fs.writeFileSync(file, raw.replace(from, to), 'utf8');
}

function copyTree(name) {
  const root = path.join(WORK, `probe-${name}`);
  rmrf(root);
  copyDir(API_DIR, path.join(root, 'api'));
  copyDir(SHARED_DIR, path.join(root, 'site', 'shared'));
  copyDir(path.join(SITE, 'scripts'), path.join(root, 'site', 'scripts'));
  return root;
}

function runSuiteAgainst(root, checkId) {
  const out = path.join(WORK, `probe-${checkId}-${crypto.randomBytes(4).toString('hex')}.json`);
  let code = 0;
  let stdout = '';
  try {
    stdout = execFileSync(
      process.execPath,
      [path.join(__dirname, 'qa-wave9-store-independent.mjs'), '--json', out, '--only', checkId],
      {
        cwd: SITE,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          QA_W9I_API_DIR: path.join(root, 'api'),
          QA_W9I_SHARED_DIR: path.join(root, 'site', 'shared'),
          QA_W9I_PUBLISH_SCRIPT: path.join(root, 'site', 'scripts', 'publish-testimonials.mjs'),
          QA_W9I_PROBE_CHILD: '1',
        },
      },
    );
  } catch (err) {
    code = typeof err.status === 'number' ? err.status : 1;
    stdout = `${stdout || ''}${err.stdout || ''}${err.stderr || ''}`;
  }
  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(out, 'utf8'));
  } catch (err) {
    throw new Error(
      `the probe run produced no report (${err.message}). Its output was:\n${String(stdout).slice(0, 3000)}`,
    );
  }
  return { code, results: parsed.results || [], stdout };
}

function statusOf(results, id) {
  const found = results.find((r) => r.id === id);
  return found ? found.status : 'MISSING';
}

const PROBES = [
  {
    id: 'MP-A',
    area: 'M -- mutation probes',
    checkId: 'A1-projects',
    defect: 'the projects handler falls back to the FILE store',
    patch(root) {
      patch(
        path.join(root, 'site', 'shared', 'portal-handlers', 'portal-projects.ts'),
        'const store = getPortalStore();',
        "const store = getPortalStore({ ...process.env, PORTAL_STORE: 'file' });",
      );
    },
  },
  {
    id: 'MP-B',
    area: 'M -- mutation probes',
    checkId: 'B2-publisher-unreachable',
    defect: 'the publisher treats an unreachable database as an EMPTY store',
    patch(root) {
      patch(
        path.join(root, 'site', 'scripts', 'publish-testimonials.mjs'),
        `async function main() {
  const reviews = await readReviewsFromStore();`,
        `async function main() {
  // QA MUTATION: a store failure is swallowed and the build publishes an
  // EMPTY testimonials page instead of failing.
  let reviews = [];
  try {
    reviews = await readReviewsFromStore();
  } catch {
    reviews = [];
  }`,
      );
    },
  },
  {
    id: 'MP-C',
    area: 'M -- mutation probes',
    checkId: 'C1-counter-shared',
    defect: 'the libsql mode uses the per-process in-memory counter',
    patch(root) {
      patch(
        path.join(root, 'site', 'shared', 'server', 'rate-limit.ts'),
        `  if ((env.PORTAL_STORE || 'file').trim() === 'libsql') {
    return new RateLimiter(createStoreBackend(env));
  }`,
        `  if ((env.PORTAL_STORE || 'file').trim() === 'libsql') {
    // QA MUTATION: the shared counter is replaced by a per-process one.
    return new RateLimiter(createMemoryBackend());
  }`,
      );
    },
  },
  {
    id: 'MP-D',
    area: 'M -- mutation probes',
    checkId: 'D1-portal-db-down',
    defect: 'the store guard swallows the failure instead of answering 500 {code:storage}',
    patch(root) {
      patch(
        path.join(root, 'site', 'shared', 'server', 'portal-store-access.ts'),
        `  } catch (err) {
    if (err instanceof StorageError || isStorageCorrupt(err)) {
      return onError(err as StorageError | StorageCorruptError);
    }
    throw err;
  }`,
        `  } catch (err) {
    if (err instanceof StorageError || isStorageCorrupt(err)) {
      // QA MUTATION: the failure becomes an empty answer.
      return undefined as any;
    }
    throw err;
  }`,
      );
    },
  },
];

async function runProbes() {
  for (const probe of PROBES) {
    await check(
      probe.id,
      'M -- mutation probes',
      `${probe.defect} -> ${probe.checkId} goes RED (control stays GREEN)`,
      async () => {
        const controlRoot = copyTree(`${probe.id}-control`);
        const control = runSuiteAgainst(controlRoot, probe.checkId);
        assertEqual(
          statusOf(control.results, probe.checkId),
          'PASS',
          `the control run against the unmodified copy did not pass (${probe.checkId}). Its output was:\n${String(control.stdout).slice(-1500)}`,
        );

        const mutantRoot = copyTree(`${probe.id}-mutant`);
        probe.patch(mutantRoot);
        const mutant = runSuiteAgainst(mutantRoot, probe.checkId);
        assertEqual(
          statusOf(mutant.results, probe.checkId),
          'FAIL',
          `the mutant run did not go RED (${probe.checkId} = ${statusOf(mutant.results, probe.checkId)})`,
        );
        return `control ${probe.checkId}=PASS, mutant ${probe.checkId}=FAIL`;
      },
    );
  }
}

// ---------------------------------------------------------------------------
// small utilities
// ---------------------------------------------------------------------------
/**
 * The address a captured mail carries.
 *
 * The mail is a Resend API call, so the magic link is in the BODY, not in the
 * URL. The link's token is base64 and carries the address, so the token is
 * decoded and the address is read out of it.
 */
function decodeToken(mail) {
  const haystack = `${(mail && mail.url) || ''} ${(mail && mail.body) || ''}`;
  const match = /token=([A-Za-z0-9_%-]+)/.exec(haystack);
  if (!match) return '';
  try {
    return Buffer.from(decodeURIComponent(match[1]), 'base64').toString('utf8');
  } catch {
    return '';
  }
}

function findFiles(root, needle) {
  const out = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.includes(needle)) out.push(path.relative(root, full));
    }
  };
  walk(root);
  return out;
}

main().catch((err) => {
  console.error('[qa] harness crashed:', err && err.stack ? err.stack : err);
  rmrf(SANDBOX);
  process.exit(2);
});
