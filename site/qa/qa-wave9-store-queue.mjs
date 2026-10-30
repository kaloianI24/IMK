// site/qa/qa-wave9-store-queue.mjs
//
// QA's INDEPENDENT wave-9 check: THE OWNER'S INBOX AND THE MODERATION LINK
// ARE ONE QUEUE -- AND FILE MODE STILL BEHAVES LIKE BEFORE WAVE 9.
//
// WHY THIS FILE EXISTS
//   Wave 9 moved the moderation log out of "a JSONL file every handler read
//   for itself" and into the PortalStore contract (site/shared/portal-store/
//   **). Two endpoints touch that queue:
//
//     api/moderate/review.ts  the signed one-click approve/reject
//     api/admin/reviews.ts     the owner's inbox: the list + the links
//
//   The risk of that move is not a crash -- it is a SPLIT. If the two
//   endpoints end up on different queues, the owner approves a quote the
//   inbox does not show, or the inbox shows a quote the moderation endpoint
//   cannot find, and neither side ever says so.
//
// THE CHECK (W9-1) HAS TWO HALVES
//   (a) THE SAME QUEUE
//       The link the inbox mints is accepted by /api/moderate/review, the
//       decision it stores is visible to the inbox on the next read, and the
//       decision lands in THE store (the file the file adapter owns), not in
//       a side file.
//
//   (b) FILE-MODE PARITY WITH THE PRE-WAVE-9 IMPLEMENTATION
//       The inbox answers the SAME fixture the way it answered it BEFORE
//       wave 9. The "before" is not a copy of today's file: it is the frozen
//       pre-wave-9 implementation (site/qa/fixtures/
//       prewave9-admin-reviews.ts.txt, taken from git a4b10a8), copied into
//       a scratch tree that keeps the CURRENT shared helpers -- so the only
//       difference measured is HOW the queue is reached. A corrupt store
//       must still answer 500 {code:'storage'} in both, never an empty queue.
//
// THE LEGACY TREE IS SELF-CONTAINED (wave 11, F-7)
//   The frozen pre-wave-9 inbox imports '../lib/jsonl.js' and
//   '../lib/notifications.js'. Those resolve against the COPIED CURRENT
//   api/ tree, so the legacy bundle only built as long as the product file
//   api/lib/jsonl.ts existed -- and it has no importer in the product any
//   more (the inbox reads through the portal store since wave 9), so it is
//   a dead Vercel function the Backend wants to delete.
//
//   The legacy tree therefore carries its OWN copies of the two helpers,
//   frozen at the same checkpoint (a4b10a8, site/qa/fixtures/
//   prewave9-lib-*.ts.txt), and the PRODUCT copies are deleted from the
//   scratch tree first. The legacy comparison is byte-for-byte faithful to
//   pre-wave-9 and does not depend on the current product tree.
//
// ISOLATION
//   cwd     -> <sandbox>   the store resolves site/data from cwd
//   records -> <sandbox>   site/data/** in the repository is never touched
//   network -> the child's fetch is blocked; no mail leaves the machine
//   repo    -> never modified; the pre-wave-9 tree is a scratch COPY
//
// USAGE
//   node site/qa/qa-wave9-store-queue.mjs
//   node site/qa/qa-wave9-store-queue.mjs --json <ABSOLUTE path>

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { handlerPath, fwd } from './handler-paths.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.resolve(__dirname, '..');
const REPO = path.resolve(SITE, '..');

const argv = process.argv.slice(2);
const JSON_OUT = argv.includes('--json')
  ? path.resolve(argv[argv.indexOf('--json') + 1])
  : null;

const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const SANDBOX = path.join(os.tmpdir(), 'opencode', `qa-wave9-queue-${STAMP}`);
const WORK = path.join(SANDBOX, 'work');

// The module roots. QA_W9_API_DIR / QA_W9_SHARED_DIR point them at a COPY of
// the tree, which is how a defect is put back without touching the repository
// (the --probe mode of qa-anchor-nonvacuity.mjs uses it).
const API_DIR = process.env.QA_W9_API_DIR
  ? path.resolve(process.env.QA_W9_API_DIR)
  : path.join(REPO, 'api');
const SHARED_DIR = process.env.QA_W9_SHARED_DIR
  ? path.resolve(process.env.QA_W9_SHARED_DIR)
  : path.join(SITE, 'shared');

// The roots of the tree under test, for the handler-path resolver.
const ROOTS = { apiDir: API_DIR, sharedDir: SHARED_DIR };

// ---------------------------------------------------------------------------
// the environment of every child (production-like: the secrets are long
// enough for the H-1 fail-closed rule, and they are LOCAL test values)
// ---------------------------------------------------------------------------
const SECRET = 'qa-wave9-form-webhook-secret-0123456789';
const MAGIC_SECRET = 'qa-wave9-magic-link-secret-0123456789';
const SESSION_SECRET = 'qa-wave9-session-secret-0123456789';
const ADMIN_EMAIL = 'owner@imk.test';
const SITE_ORIGIN = 'https://imk.test';

const BASE_ENV = {
  APP_ENV: 'production',
  NODE_ENV: 'production',
  SITE_BASE_URL: SITE_ORIGIN,
  RESEND_API_KEY: 'qa-wave9-resend-key',
  RESEND_FROM: 'IMK <qa@imk.test>',
  RESEND_TO: ADMIN_EMAIL,
  FORM_WEBHOOK_SECRET: SECRET,
  ADMIN_EMAILS: ADMIN_EMAIL,
  PORTAL_MAGIC_LINK_SECRET: MAGIC_SECRET,
  PORTAL_SESSION_SECRET: SESSION_SECRET,
  PORTAL_STORE: 'file',
  PORTAL_RATE_LIMIT_FILE: '',
};

// ---------------------------------------------------------------------------
// the fixture: the shape the moderation log had before wave 9
// ---------------------------------------------------------------------------
const REF_A = 'inq_wave9_a';
const REF_B = 'inq_wave9_b';
const REF_C = 'inq_wave9_c';

const MODERATION_DIR = path.join(SANDBOX, 'site', 'data', 'moderation');
const REVIEWS_FILE = path.join(MODERATION_DIR, 'reviews.jsonl');

function fixtureLines() {
  const now = new Date().toISOString();
  return [
    {
      ref: REF_A,
      type: 'review',
      name: 'Wanda Client',
      company: 'Wave9 Ltd',
      rating: 5,
      review: 'The portal store keeps one queue.',
      revision: 1,
      state: 'pending',
      clientId: 'cli_wave9',
      receivedAt: now,
      createdAt: now,
    },
    {
      ref: REF_B,
      type: 'review',
      name: 'Rita Client',
      company: 'Wave9 Two Ltd',
      rating: 4,
      review: 'The inbox and the link agree.',
      revision: 1,
      state: 'pending',
      clientId: 'cli_wave9_b',
      receivedAt: now,
      createdAt: now,
    },
    {
      ref: REF_C,
      type: 'review',
      name: 'Old Client',
      company: 'Wave9 Old Ltd',
      rating: 5,
      review: 'A quote decided earlier today.',
      revision: 1,
      state: 'approved',
      decidedAt: now,
      decidedBy: 'one-click-link',
      clientId: 'cli_wave9_c',
      receivedAt: now,
      createdAt: now,
    },
  ];
}

function seedFixture() {
  fs.mkdirSync(MODERATION_DIR, { recursive: true });
  fs.writeFileSync(
    REVIEWS_FILE,
    fixtureLines()
      .map((r) => JSON.stringify(r))
      .join('\n') + '\n',
    'utf8',
  );
}

function readStoreRecords() {
  if (!fs.existsSync(REVIEWS_FILE)) return [];
  return fs
    .readFileSync(REVIEWS_FILE, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

// ---------------------------------------------------------------------------
// the child harness (QA's own): one bundle per process, JSON lines over
// stdin/stdout. Vercel builds one function per file, so that is the shape
// under test.
// ---------------------------------------------------------------------------
const CHILD_SRC = [
  'const fs = require("node:fs");',
  'const { Readable } = require("node:stream");',
  'const bundlePath = process.env.QA_W9_BUNDLE;',
  'const logFile = process.env.QA_W9_LOG_FILE || "";',
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
  '// No outbound request ever leaves this machine.',
  'globalThis.fetch = async function (url, init) {',
  '  mails.push({ url: String(url), at: Date.now() });',
  '  if (String(url).includes("api.resend.com")) {',
  '    return { ok: true, status: 200, json: async () => ({ id: "qa-mail" }) };',
  '  }',
  '  throw new Error("[qa] blocked outbound request: " + url);',
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
  '      reply({ ok: true, token: mod.createSession(msg.email, msg.role) });',
  '      return;',
  '    }',
  '    if (msg.cmd === "mails") { reply({ ok: true, mails: mails }); return; }',
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
  constructor(name, bundlePath) {
    this.name = name;
    this.bundlePath = bundlePath;
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
        QA_W9_BUNDLE: this.bundlePath,
        QA_W9_LOG_FILE: path.join(SANDBOX, 'logs', this.name + '.log'),
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
    if (process.env.QA_W9_DEBUG) {
      console.log(`[qa] raw reply on ${this.name}: ${JSON.stringify(raw).slice(0, 300)}`);
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

async function startChild(name, bundlePath) {
  const child = new BundleChild(name, bundlePath);
  children.push(child);
  await child.start();
  return child;
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

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dst);
    else fs.copyFileSync(src, dst);
  }
}

// ---------------------------------------------------------------------------
// QA's own HMAC over the moderation parameters -- not the project's helper.
// If the inbox signed with another secret, or over another shape, it shows
// here.
// ---------------------------------------------------------------------------
function qaSignModeration(ref, decision, revision, ts) {
  return crypto
    .createHmac('sha256', SECRET)
    .update(`${ref}|${decision}|${revision}|${ts}`)
    .digest('hex');
}

// ---------------------------------------------------------------------------
// the frozen pre-wave-9 helpers the legacy tree needs
// ---------------------------------------------------------------------------
// The provenance marker every frozen fixture carries.
const MARKER = '// ===== END OF PROVENANCE HEADER =====';

// The two modules the frozen pre-wave-9 inbox imports. They are frozen at
// git checkpoint a4b10a8 -- the SAME checkpoint the inbox fixture comes
// from -- so the legacy tree does not depend on the CURRENT product tree.
const LEGACY_LIBS = [
  {
    file: 'jsonl.ts',
    git: 'api/lib/jsonl.ts',
    fixture: 'prewave9-lib-jsonl.ts.txt',
    sha256: '31b5d1be7a8cb6911c507dc408e363b4a8819d3d00d3f3236ef28f6be4d57df4',
    exports: ['parseJsonlStrict', 'guardStorage'],
  },
  {
    file: 'notifications.ts',
    git: 'api/lib/notifications.ts',
    fixture: 'prewave9-lib-notifications.ts.txt',
    sha256: 'def777b3a1b7403b135bb9bbdcc3ac0ba22bcc0b9af2d09c22c4ed88d5d044b5',
    exports: ['moderationUrl'],
  },
];

// The two SESSION modules the frozen pre-wave-9 files import. They are frozen
// at the SAME checkpoint (a4b10a8) for the same reason: wave 13 moved the
// handler bodies out of api/, so api/admin/session.ts and api/portal/session.ts
// no longer exist in the product -- and the legacy tree has to build without
// them.
//
//   the frozen inbox          -> './session.js'          (api/admin/session.ts)
//   the frozen notifications  -> '../portal/session.js'  (api/portal/session.ts)
//
// `dir` is where the file goes INSIDE the legacy api/ tree.
const LEGACY_SESSIONS = [
  {
    dir: 'admin',
    file: 'session.ts',
    git: 'api/admin/session.ts',
    fixture: 'prewave9-admin-session.ts.txt',
    sha256: 'bd481fdb4d89636782d0973bc2d648e3877fa099bd671cb13d2fbd38f420c22b',
    exports: ['default'],
  },
  {
    dir: 'portal',
    file: 'session.ts',
    git: 'api/portal/session.ts',
    fixture: 'prewave9-portal-session.ts.txt',
    sha256: '363a4b8d9e03741b87b72e682c2d54013d583cd5fa1612ea35f87eec92f720aa',
    exports: ['export *'],
  },
];

/**
 * Read a frozen pre-wave-9 source from its QA fixture.
 *
 * The body is verified against its recorded SHA-256 and -- when git is
 * available -- against the file at checkpoint a4b10a8, so a stale snapshot
 * can never pass silently. The provenance string is returned for the report.
 */
function frozenSource(lib) {
  const fixturePath = path.join(SITE, 'qa', 'fixtures', lib.fixture);
  const raw = fs.readFileSync(fixturePath, 'utf8');
  const markerAt = raw.indexOf(MARKER);
  assert(markerAt !== -1, `the fixture has no provenance marker: ${fixturePath}`);
  const source = raw.slice(markerAt + MARKER.length).replace(/^\r?\n/, '');
  const hash = crypto.createHash('sha256').update(source, 'utf8').digest('hex');
  assert(
    hash === lib.sha256,
    `the frozen ${lib.git} does not match its recorded hash ` +
      `(fixture ${hash}, recorded ${lib.sha256})`,
  );

  let fromGit = null;
  let gitError = '';
  try {
    fromGit = execFileSync('git', ['show', `a4b10a8:${lib.git}`], {
      cwd: REPO,
      encoding: 'utf8',
      maxBuffer: 1e8,
    });
  } catch (err) {
    gitError = String((err && err.message) || err).split('\n')[0];
  }
  let provenance;
  if (fromGit === null) {
    provenance = `git not available (${gitError})`;
  } else {
    const gitHash = crypto.createHash('sha256').update(fromGit, 'utf8').digest('hex');
    assert(
      gitHash === hash,
      `the frozen ${lib.git} does not match git a4b10a8 (git ${gitHash}, fixture ${hash})`,
    );
    provenance = 'git agrees';
  }
  for (const name of lib.exports) {
    assert(
      source.includes(name),
      `the frozen ${lib.git} does not export ${name} -- the legacy inbox would not build`,
    );
  }
  return { source, hash, provenance };
}

// ---------------------------------------------------------------------------
// the check
// ---------------------------------------------------------------------------
const results = [];

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg} -- expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function main() {
  fs.mkdirSync(SANDBOX, { recursive: true });
  fs.mkdirSync(WORK, { recursive: true });
  fs.mkdirSync(path.join(SANDBOX, 'logs'), { recursive: true });
  fs.writeFileSync(CHILD_PATH, CHILD_SRC, 'utf8');

  // -------------------------------------------------------------------
  // the pre-wave-9 implementation: a scratch tree that keeps the CURRENT
  // helpers and replaces exactly ONE file -- api/admin/reviews.ts
  // -------------------------------------------------------------------
  const FIXTURE = path.join(SITE, 'qa', 'fixtures', 'prewave9-admin-reviews.ts.txt');
  const fixtureRaw = fs.readFileSync(FIXTURE, 'utf8');
  const markerAt = fixtureRaw.indexOf(MARKER);
  assert(markerAt !== -1, `the fixture has no provenance marker: ${FIXTURE}`);
  const legacySource = fixtureRaw.slice(markerAt + MARKER.length).replace(/^\r?\n/, '');
  const legacyHash = crypto.createHash('sha256').update(legacySource, 'utf8').digest('hex');

  let gitAgrees = 'git not available';
  try {
    const fromGit = execFileSync('git', ['show', 'a4b10a8:api/admin/reviews.ts'], {
      cwd: REPO,
      encoding: 'utf8',
      maxBuffer: 1e8,
    });
    const gitHash = crypto.createHash('sha256').update(fromGit, 'utf8').digest('hex');
    gitAgrees = gitHash === legacyHash ? 'git agrees' : `git DISAGREES (${gitHash})`;
  } catch (err) {
    gitAgrees = `git not available (${err.message.split('\n')[0]})`;
  }

  const legacyRoot = path.join(WORK, 'legacy');
  copyDir(API_DIR, path.join(legacyRoot, 'api'));
  copyDir(SHARED_DIR, path.join(legacyRoot, 'site', 'shared'));
  // WAVE 13 (the function budget): the current api/ tree no longer has an
  // api/admin/ directory (the inbox is a route-table entry served by
  // api/admin.ts) and no api/lib/ directory at all. The frozen pre-wave-9
  // files are written INTO the scratch tree below, so their directories have
  // to exist first.
  fs.mkdirSync(path.join(legacyRoot, 'api', 'admin'), { recursive: true });
  fs.mkdirSync(path.join(legacyRoot, 'api', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(legacyRoot, 'api', 'admin', 'reviews.ts'), legacySource, 'utf8');

  // -------------------------------------------------------------------
  // THE LEGACY TREE IS SELF-CONTAINED (wave 11, F-7)
  // -------------------------------------------------------------------
  // The frozen pre-wave-9 inbox imports '../lib/jsonl.js' and
  // '../lib/notifications.js'. Those resolve against the COPIED CURRENT
  // api/ tree -- so the legacy bundle only built as long as the product
  // file api/lib/jsonl.ts existed. It has NO importer in the product any
  // more (the inbox reads through the portal store since wave 9), so it is
  // a dead Vercel function the Backend wants to delete (wave 10, F-7) --
  // and this suite was the last thing standing in the way.
  //
  // So the legacy tree gets its OWN copies of the two modules, frozen at
  // the SAME checkpoint the inbox fixture comes from (a4b10a8). The
  // product copies are DELETED from the scratch tree first, so this suite
  // proves the product file is not needed: the legacy comparison is
  // byte-for-byte faithful to pre-wave-9 and independent of the current
  // product tree.
  const legacyLibProvenance = [];
  for (const lib of LEGACY_LIBS) {
    const frozen = frozenSource(lib);
    const productCopy = path.join(legacyRoot, 'api', 'lib', lib.file);
    if (fs.existsSync(productCopy)) fs.rmSync(productCopy, { force: true });
    fs.writeFileSync(productCopy, frozen.source, 'utf8');
    assertEqual(
      fs.readFileSync(productCopy, 'utf8'),
      frozen.source,
      `the frozen ${lib.file} was not written into the legacy tree`,
    );
    legacyLibProvenance.push(`${lib.file}: frozen at a4b10a8 (${frozen.provenance}, ${frozen.hash.slice(0, 12)})`);
  }

  // The frozen SESSION modules, for the same reason (wave 13): the frozen
  // inbox imports './session.js' (api/admin/session.ts) and the frozen
  // notifier imports '../portal/session.js' (api/portal/session.ts). Neither
  // file exists in the product any more -- the handler bodies moved to
  // site/shared/portal-handlers/ -- so the legacy tree carries its OWN
  // copies, frozen at the same checkpoint.
  const legacySessionProvenance = [];
  for (const session of LEGACY_SESSIONS) {
    const frozen = frozenSource(session);
    const target = path.join(legacyRoot, 'api', session.dir, session.file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (fs.existsSync(target)) fs.rmSync(target, { force: true });
    fs.writeFileSync(target, frozen.source, 'utf8');
    assertEqual(
      fs.readFileSync(target, 'utf8'),
      frozen.source,
      `the frozen ${session.git} was not written into the legacy tree`,
    );
    legacySessionProvenance.push(
      `${session.git}: frozen at a4b10a8 (${frozen.provenance}, ${frozen.hash.slice(0, 12)})`,
    );
  }

  // -------------------------------------------------------------------
  // the bundles
  // -------------------------------------------------------------------
  const inboxBundle = await bundle('inbox', {
    dir: () => SHARED_DIR,
    code: `export { default as handler } from '${fwd(handlerPath('admin-reviews', ROOTS))}';`,
  });
  const moderateBundle = await bundle('moderate', {
    dir: () => API_DIR,
    code: `export { default as handler } from '${fwd(handlerPath('moderate', ROOTS))}';`,
  });
  const legacyBundle = await bundle('legacy-inbox', {
    dir: () => path.join(legacyRoot, 'api'),
    code: `export { default as handler } from './admin/reviews.ts';`,
  });
  const sessionBundle = await bundle('session', {
    dir: () => SHARED_DIR,
    code: `export { createSession } from './server/portal-session.ts';`,
  });

  const inbox = await startChild('inbox', inboxBundle);
  const moderate = await startChild('moderate', moderateBundle);
  const legacy = await startChild('legacy-inbox', legacyBundle);
  const session = await startChild('session', sessionBundle);

  try {
    const token = (
      await session.send({ cmd: 'session', email: ADMIN_EMAIL, role: 'admin' })
    ).token;
    assert(token, 'the owner session could not be minted');
    const cookie = `imk_admin_session=${token}`;

    // ==============================================================
    // W9-1 -- one queue, and file mode that still behaves like before
    // ==============================================================
    const started = Date.now();
    const sub = [];
    const step = async (id, what, fn) => {
      try {
        const detail = await fn();
        sub.push({ id, ok: true, detail });
        console.log(`    ok   ${id}  ${what}${detail ? ` -- ${detail}` : ''}`);
      } catch (err) {
        const message = err && err.message ? err.message : String(err);
        sub.push({ id, ok: false, detail: message });
        console.log(`    FAIL ${id}  ${what}\n           ${message}`);
      }
    };

    seedFixture();

    // ---- (b) the parity half: the pre-wave-9 inbox, side by side ----
    const legacyQueue = await legacy.request('GET', '/api/admin/reviews', { cookie });
    const currentQueue = await inbox.request('GET', '/api/admin/reviews', { cookie });

    await step('W9-1.a0', 'the legacy tree is SELF-CONTAINED (it does not need the product api/lib/jsonl.ts)', () => {
      // The legacy bundle above was built from the scratch tree, and the
      // product copies of the two helpers were DELETED from that tree before
      // the frozen pre-wave-9 ones were written into it. So the legacy
      // comparison does not depend on api/lib/jsonl.ts existing in the
      // product -- which is what wave 10, F-7 needs to delete that dead
      // Vercel function.
      for (const lib of LEGACY_LIBS) {
        const inLegacy = fs.readFileSync(path.join(legacyRoot, 'api', 'lib', lib.file), 'utf8');
        const hash = crypto.createHash('sha256').update(inLegacy, 'utf8').digest('hex');
        assertEqual(
          hash,
          lib.sha256,
          `the legacy ${lib.file} is not the frozen pre-wave-9 source (${hash})`,
        );
        for (const name of lib.exports) {
          assert(
            inLegacy.includes(name),
            `the legacy ${lib.file} does not export ${name} -- the legacy inbox would not build`,
          );
        }
      }
      return `self-contained: ${legacyLibProvenance.join('; ')}`;
    });

    await step('W9-1.a0b', 'the legacy tree also carries its own frozen SESSION modules', () => {
      // Wave 13 moved the handler bodies out of api/, so the product has no
      // api/admin/session.ts and no api/portal/session.ts any more. The
      // frozen pre-wave-9 inbox and notifier import them, so the legacy tree
      // needs its own copies -- frozen at the same checkpoint. Without them
      // the legacy bundle would not even build, and the pre-wave-9
      // comparison would be impossible.
      for (const session of LEGACY_SESSIONS) {
        const inLegacy = fs.readFileSync(
          path.join(legacyRoot, 'api', session.dir, session.file),
          'utf8',
        );
        const hash = crypto.createHash('sha256').update(inLegacy, 'utf8').digest('hex');
        assertEqual(
          hash,
          session.sha256,
          `the legacy ${session.git} is not the frozen pre-wave-9 source (${hash})`,
        );
        for (const name of session.exports) {
          assert(
            inLegacy.includes(name),
            `the legacy ${session.git} does not carry ${name} -- the legacy inbox would not build`,
          );
        }
      }
      return `self-contained: ${legacySessionProvenance.join('; ')}`;
    });

    await step('W9-1.a1', 'both inboxes answer the same fixture with 200', () => {
      assertEqual(legacyQueue.status, 200, `the pre-wave-9 inbox should be 200 (got ${legacyQueue.status}: ${legacyQueue.text})`);
      assertEqual(currentQueue.status, 200, `the wave-9 inbox should be 200 (got ${currentQueue.status}: ${currentQueue.text})`);
      return `both 200`;
    });

    await step('W9-1.a2', 'the answer shape is identical (keys, counts, flags)', () => {
      const legacyKeys = Object.keys(legacyQueue.json || {}).sort().join(',');
      const currentKeys = Object.keys(currentQueue.json || {}).sort().join(',');
      assertEqual(currentKeys, legacyKeys, 'the answer carries different keys');
      for (const key of ['pendingReviews', 'decidedToday', 'openNotes']) {
        assertEqual(
          (currentQueue.json.counts || {})[key],
          (legacyQueue.json.counts || {})[key],
          `counts.${key} differs`,
        );
      }
      assertEqual(currentQueue.json.notesAvailable, legacyQueue.json.notesAvailable, 'notesAvailable differs');
      return `keys [${currentKeys}], counts identical`;
    });

    await step('W9-1.a3', 'the queue itself is identical, item by item', () => {
      const legacyReviews = legacyQueue.json.reviews || [];
      const currentReviews = currentQueue.json.reviews || [];
      assertEqual(currentReviews.length, legacyReviews.length, 'a different number of pending quotes');
      for (const field of ['ref', 'revision', 'rating', 'name', 'company', 'quote', 'receivedAt', 'state']) {
        for (let i = 0; i < legacyReviews.length; i++) {
          assertEqual(
            String(currentReviews[i][field]),
            String(legacyReviews[i][field]),
            `reviews[${i}].${field} differs`,
          );
        }
      }
      const legacyRecent = legacyQueue.json.recent || [];
      const currentRecent = currentQueue.json.recent || [];
      assertEqual(currentRecent.length, legacyRecent.length, 'a different number of recent decisions');
      for (const field of ['ref', 'state', 'decidedAt', 'rating', 'name']) {
        for (let i = 0; i < legacyRecent.length; i++) {
          assertEqual(
            String(currentRecent[i][field]),
            String(legacyRecent[i][field]),
            `recent[${i}].${field} differs`,
          );
        }
      }
      return `${currentReviews.length} pending + ${currentRecent.length} recent, identical`;
    });

    await step('W9-1.a4', 'the links have the same shape and a signature QA can verify', () => {
      const legacyItem = (legacyQueue.json.reviews || [])[0];
      const currentItem = (currentQueue.json.reviews || [])[0];
      assert(legacyItem && currentItem, 'the queue carried no item to compare');
      for (const key of ['approvePath', 'rejectPath']) {
        const legacyUrl = new URL(legacyItem[key], SITE_ORIGIN);
        const currentUrl = new URL(currentItem[key], SITE_ORIGIN);
        assertEqual(currentUrl.pathname, legacyUrl.pathname, `${key} points somewhere else`);
        assertEqual(
          [...currentUrl.searchParams.keys()].sort().join(','),
          [...legacyUrl.searchParams.keys()].sort().join(','),
          `${key} carries different parameters`,
        );
        for (const param of ['ref', 'decision', 'revision']) {
          assertEqual(currentUrl.searchParams.get(param), legacyUrl.searchParams.get(param), `${key}.${param} differs`);
        }
        const ts = Number(currentUrl.searchParams.get('ts'));
        const legacyTs = Number(legacyUrl.searchParams.get('ts'));
        assert(
          Math.abs(ts - legacyTs) <= 10,
          `${key} was minted ${Math.abs(ts - legacyTs)}s apart -- too far to compare`,
        );
        assertEqual(
          currentUrl.searchParams.get('sig'),
          qaSignModeration(
            currentUrl.searchParams.get('ref'),
            currentUrl.searchParams.get('decision'),
            currentUrl.searchParams.get('revision'),
            currentUrl.searchParams.get('ts'),
          ),
          `${key} is not signed with QA's own HMAC over ref|decision|revision|ts`,
        );
      }
      return 'same path, same parameters, signature verified with QA\'s own HMAC';
    });

    await step('W9-1.a5', 'a CORRUPT store still answers 500 {code:storage} in both', async () => {
      const good = fs.readFileSync(REVIEWS_FILE, 'utf8');
      fs.appendFileSync(REVIEWS_FILE, '{ this is not json\n', 'utf8');
      try {
        const legacyCorrupt = await legacy.request('GET', '/api/admin/reviews', { cookie });
        const currentCorrupt = await inbox.request('GET', '/api/admin/reviews', { cookie });
        assertEqual(currentCorrupt.status, legacyCorrupt.status, 'the two inboxes answer differently');
        assertEqual(currentCorrupt.status, 500, `a corrupt store must be 500 (got ${currentCorrupt.status}: ${currentCorrupt.text})`);
        assert(
          currentCorrupt.json && currentCorrupt.json.code === 'storage',
          `the answer must carry code 'storage' (got ${currentCorrupt.text})`,
        );
        assert(
          !/pendingReviews/.test(currentCorrupt.text),
          `the answer looks like a queue (got ${currentCorrupt.text})`,
        );
        return `both 500 {code:'storage'}`;
      } finally {
        fs.writeFileSync(REVIEWS_FILE, good, 'utf8');
      }
    });

    step('W9-1.a6', 'both handlers reach the store through the SAME accessor', () => {
      // WAVE 13: the inbox handler moved out of api/ into
      // site/shared/portal-handlers/admin-reviews.ts. The moderation handler
      // keeps its own file (a standalone public URL). What the check asserts
      // is unchanged: both read the queue through the SAME store accessor.
      const files = {
        'api/moderate/review.ts': path.join(API_DIR, 'moderate', 'review.ts'),
        'site/shared/portal-handlers/admin-reviews.ts': path.join(
          SHARED_DIR,
          'portal-handlers',
          'admin-reviews.ts',
        ),
      };
      for (const [label, file] of Object.entries(files)) {
        const src = fs.readFileSync(file, 'utf8');
        assert(
          /getPortalStore/.test(src),
          `${label} does not use getPortalStore() -- it does not read the store contract`,
        );
        assert(
          /getPortalStore\(\s*\)/.test(src),
          `${label} calls getPortalStore() with an argument -- it may not be the same store`,
        );
        assert(
          /'reviews'/.test(src),
          `${label} does not work on the 'reviews' collection`,
        );
        assert(
          !/parseJsonlStrict/.test(src),
          `${label} still parses the moderation log itself -- it does not share the store`,
        );
        assert(
          !/readFileSync\(\s*REVIEWS/.test(src),
          `${label} still reads the moderation log file directly -- it does not share the store`,
        );
      }
      return 'both use getPortalStore() on the \'reviews\' collection, neither reads the file';
    });

    // ---- (a) the shared-queue half: the decision round trip ----
    await step('W9-1.b1', 'the inbox lists the two pending quotes', () => {
      const queue = currentQueue;
      assertEqual(queue.json.counts.pendingReviews, 2, `two quotes are pending (got ${queue.text})`);
      const refs = (queue.json.reviews || []).map((r) => r.ref).sort().join(',');
      assertEqual(refs, [REF_A, REF_B].sort().join(','), `the queue holds another set of quotes (got ${refs})`);
      return `pending: ${refs}`;
    });

    let approvePath = null;
    await step('W9-1.b2', 'the link the inbox mints is accepted by /api/moderate/review', () => {
      const item = (currentQueue.json.reviews || []).find((r) => r.ref === REF_A);
      assert(item, `the queue does not carry ${REF_A}`);
      approvePath = item.approvePath;
      const url = new URL(approvePath, SITE_ORIGIN);
      assertEqual(url.pathname, '/api/moderate/review', 'the link points somewhere else');
      return `approve link for ${REF_A}`;
    });

    await step('W9-1.b3', 'the POST decides, and the answer is the decision', async () => {
      assert(approvePath, 'there was no link to post');
      const decided = await moderate.request('POST', approvePath, {
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      });
      assertEqual(decided.status, 200, `the decision should be 200 (got ${decided.status}: ${decided.text})`);
      assert(
        decided.json && decided.json.state === 'approved',
        `the answer does not carry the approval (got ${decided.text})`,
      );
      return `200 ${decided.text}`;
    });

    await step('W9-1.b4', 'the inbox sees the decision on its next read (ONE queue)', async () => {
      const after = await inbox.request('GET', '/api/admin/reviews', { cookie });
      assertEqual(after.status, 200, `the queue should be 200 (got ${after.status}: ${after.text})`);
      assertEqual(after.json.counts.pendingReviews, 1, `one quote is left pending (got ${after.text})`);
      const pendingRefs = (after.json.reviews || []).map((r) => r.ref);
      assert(!pendingRefs.includes(REF_A), `${REF_A} is still in the pending queue`);
      assert(pendingRefs.includes(REF_B), `${REF_B} disappeared from the queue`);
      const recent = (after.json.recent || []).find((r) => r.ref === REF_A);
      assert(recent, `${REF_A} is not in the recently decided list: ${after.text}`);
      assertEqual(recent.state, 'approved', `${REF_A} is not approved in the inbox`);
      return `pending ${after.json.counts.pendingReviews}, ${REF_A} moved to recent`;
    });

    await step('W9-1.b5', 'the decision landed in THE store, not in a side file', () => {
      const records = readStoreRecords();
      const decided = records.filter((r) => r.ref === REF_A).pop();
      assert(decided, `${REF_A} is not in the store at all`);
      assertEqual(decided.state, 'approved', 'the stored record is not approved');
      assert(decided.decidedAt, 'the stored record carries no decidedAt');
      assertEqual(decided.decidedBy, 'one-click-link', 'the stored record carries no decidedBy');
      const files = fs.readdirSync(MODERATION_DIR);
      assertEqual(files.join(','), 'reviews.jsonl', 'the store directory holds another file');
      return `the store file holds the decision (files: ${files.join(',')})`;
    });

    const failed = sub.filter((s) => !s.ok);
    results.push({
      id: 'W9-1',
      group: 'W9 -- one queue (wave 9)',
      name: 'the owner inbox and the moderation link are ONE queue, and file mode still behaves like before wave 9',
      status: failed.length ? 'FAIL' : 'PASS',
      ms: Date.now() - started,
      detail: `${sub.length - failed.length}/${sub.length} sub-assertions passed; the pre-wave-9 fixture ${gitAgrees} (${legacyHash.slice(0, 12)}); legacy tree self-contained (${legacyLibProvenance.join('; ')})`,
      sub,
    });
    console.log(
      `  ${failed.length ? 'FAIL' : 'PASS'}  W9-1  the owner inbox and the moderation link are ONE queue (${sub.length - failed.length}/${sub.length} sub-assertions)`,
    );
  } finally {
    for (const child of children) {
      try {
        await child.stop();
      } catch {
        /* ignore */
      }
    }
  }
}

main()
  .then(() => {
    const passed = results.filter((r) => r.status === 'PASS').length;
    const failed = results.filter((r) => r.status === 'FAIL').length;
    console.log(`\n[qa] ${results.length} checks: ${passed} PASS, ${failed} FAIL`);
    console.log(`[qa] sandbox: ${SANDBOX}`);
    if (JSON_OUT) {
      fs.mkdirSync(path.dirname(JSON_OUT), { recursive: true });
      fs.writeFileSync(
        JSON_OUT,
        JSON.stringify(
          {
            suite: 'qa-wave9-store-queue',
            startedAt: new Date().toISOString(),
            results,
            passed,
            failed,
          },
          null,
          2,
        ),
        'utf8',
      );
    }
    process.exit(failed ? 1 : 0);
  })
  .catch((err) => {
    console.error('[qa] SUITE ERROR', err && err.stack ? err.stack : err);
    console.log(`\n[qa] 0 checks: 0 PASS, 1 FAIL`);
    process.exit(1);
  });
