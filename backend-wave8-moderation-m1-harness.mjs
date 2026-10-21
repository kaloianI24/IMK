// backend-wave8-moderation-m1-harness.mjs
//
// EXECUTED evidence + a MUTATION PROBE for audit finding M-1 (wave 8A):
// "a plain GET on the signed moderation link flips the state, so every mail
// scanner approves the owner's quotes".
//
// WHAT IT PROVES (by running the REAL handlers)
//   M1  a GET on the signed link answers the CONFIRMATION PAGE and the store
//       still says "pending" — a mail scanner cannot decide a quote.
//   M2  the POST that the confirmation form issues DOES decide it.
//   M3  a second POST changes nothing (the idempotency guard).
//   M4  a link signed for revision 1 cannot decide a record that is now at
//       revision 2 (the revision guard) -> 409 {code:'stale-revision'}.
//   M5  a link older than the 7-day TTL is refused -> 400 {code:'expired'}.
//   M6  a forged signature is refused -> 400 {code:'signature'}.
//   P   PARITY: the Cloudflare twin answers the same codes as the Vercel tree.
//
// THE MUTATION PROBE (D1)
//   The GET branch is reverted to the OLD behaviour ("a GET decides the
//   quote") in a COPY of the tree, in the sandbox. The same M1 assertion is
//   re-run against it and MUST FAIL — a probe that stays green proves the
//   assertion does not test the fix.
//
// THE REPO IS NEVER TOUCHED
//   Every request runs in a child process whose cwd is a sandbox, so the
//   handlers resolve `site/data/moderation` inside the sandbox and the real
//   store is never read or written.
//
// USAGE
//   node backend-wave8-moderation-m1-harness.mjs [--keep]

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = fs.existsSync(path.join(HERE, 'api', 'portal', 'auth.ts')) ? HERE : path.resolve(HERE, '..');
const SITE = path.join(REPO, 'site');
const siteRequire = createRequire(path.join(SITE, 'package.json'));
const { build } = siteRequire('esbuild');

const KEEP = process.argv.includes('--keep');
const SECRET = 'wave8-m1-moderation-secret-0123456789abcdef';
const BASE = 'http://imk.test';
const REF = 'inq_wave8_m1';

const results = [];
let currentGroup = '';
const origLog = console.log;

function group(name) {
  currentGroup = name;
  origLog(`\n[wave8-m1] ${name}`);
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(
      `${message} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

async function t(id, name, fn) {
  try {
    const detail = await fn();
    results.push({ id, group: currentGroup, name, status: 'PASS', detail: detail ?? null });
    origLog(`  PASS  ${id}  ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (err) {
    results.push({
      id,
      group: currentGroup,
      name,
      status: 'FAIL',
      error: String(err && err.message ? err.message : err),
    });
    origLog(`  FAIL  ${id}  ${name}\n          ${err && err.message ? err.message : err}`);
  }
}

// ---------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------

const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const SANDBOX = path.join(os.tmpdir(), 'opencode', 'wave8-m1', STAMP);
const STORE_DIR = path.join(SANDBOX, 'site', 'data', 'moderation');
const STORE_FILE = path.join(STORE_DIR, 'reviews.jsonl');
const BUNDLES = path.join(SANDBOX, 'bundles');
const CHILD_FILE = path.join(SANDBOX, 'child.cjs');

function writeStore(record) {
  fs.mkdirSync(STORE_DIR, { recursive: true });
  fs.writeFileSync(STORE_FILE, JSON.stringify(record) + '\n', 'utf8');
}

function readStore() {
  if (!fs.existsSync(STORE_FILE)) return [];
  return fs
    .readFileSync(STORE_FILE, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function pendingRecord(revision = 1) {
  return {
    type: 'review',
    ref: REF,
    revision,
    state: 'pending',
    review: 'A good quote',
    name: 'Nora',
    company: 'Named Co',
    clientId: 'cli_wave8',
    createdAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// The child runner — one process per request
// ---------------------------------------------------------------------------

const CHILD = `
const { Readable } = require('node:stream');

// The Cloudflare code looks for \`globalThis.require\`. On the edge there is
// none, so the store cannot be read and the endpoint answers 501. This child
// runs as CommonJS, where \`require\` is module-scoped and globalThis.require
// is undefined — exactly like the edge — unless the harness asks for a
// filesystem.
if (process.env.W8_WITH_FS === '1') globalThis.require = require;
else delete globalThis.require;

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
    writeHead(status, headers) {
      this.statusCode = status;
      // Node MERGES the headers set with setHeader() into the ones passed to
      // writeHead(); the fake must do the same, and the keys are compared
      // lowercased (as the Headers class does).
      const merged = { ...this.headers, ...(headers || {}) };
      this.headers = {};
      for (const [key, value] of Object.entries(merged)) {
        this.headers[String(key).toLowerCase()] = value;
      }
      return this;
    },
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value;
    },
    end(payload) {
      if (payload) {
        this.body += Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload);
      }
      this.ended = true;
      this.writableEnded = true;
      return this;
    },
  };
}

async function runOp(op, bundlePath) {
  const mod = require(bundlePath);

  if (op.mode === 'vercel') {
    const req = makeReq(op.method, op.url, op.headers, op.body);
    const res = makeRes();
    await mod.default(req, res);
    let parsed = null;
    try { parsed = JSON.parse(res.body || 'null'); } catch (e) { parsed = null; }
    return { status: res.statusCode, body: parsed, raw: res.body, headers: res.headers };
  }

  const env = JSON.parse(process.env.W8_CF_ENV || '{}');
  const init = { method: op.method, headers: op.headers || {} };
  if (op.body && op.method !== 'GET' && op.method !== 'HEAD') init.body = op.body;
  const request = new Request(op.url, init);
  const handler =
    op.method === 'GET' ? mod.onRequestGet :
    op.method === 'POST' ? mod.onRequestPost :
    mod.onRequest;
  const response = await handler({ request, env });
  const text = await response.text();
  let parsed = null;
  try { parsed = JSON.parse(text || 'null'); } catch (e) { parsed = null; }
  const headers = {};
  response.headers.forEach((value, key) => { headers[key] = value; });
  return { status: response.status, body: parsed, raw: text, headers };
}

(async () => {
  const plan = JSON.parse(process.env.W8_PLAN || '{}');
  const out = [];
  for (const op of plan.ops || []) {
    out.push(await runOp(op, plan.bundle));
  }
  process.stdout.write('__RESULT__' + JSON.stringify(out) + '\\n');
})().catch((err) => {
  process.stdout.write(
    '__RESULT__' + JSON.stringify([{ error: String(err && err.message ? err.message : err) }]) + '\\n',
  );
  process.exitCode = 1;
});
`;

function runChild(bundle, ops, env = {}, cfEnv = null, withFs = true) {
  fs.writeFileSync(CHILD_FILE, CHILD, 'utf8');

  const childEnv = { ...process.env };
  for (const key of [
    'RESEND_API_KEY',
    'PORTAL_RATE_LIMIT_FILE',
    'APP_ENV',
    'SITE_BASE_URL',
    'SITE_URL',
    'PORTAL_MAGIC_LINK_SECRET',
    'PORTAL_SESSION_SECRET',
    'ADMIN_EMAILS',
    'FORM_WEBHOOK_SECRET',
  ]) {
    delete childEnv[key];
  }
  childEnv.APP_ENV = 'development';
  childEnv.SITE_BASE_URL = BASE;
  childEnv.FORM_WEBHOOK_SECRET = SECRET;
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete childEnv[k];
    else childEnv[k] = String(v);
  }
  childEnv.W8_WITH_FS = withFs ? '1' : '0';
  childEnv.W8_PLAN = JSON.stringify({ bundle, ops });
  childEnv.W8_CF_ENV = JSON.stringify(
    cfEnv || {
      APP_ENV: childEnv.APP_ENV,
      SITE_BASE_URL: childEnv.SITE_BASE_URL,
      FORM_WEBHOOK_SECRET: childEnv.FORM_WEBHOOK_SECRET,
    },
  );

  const res = spawnSync(process.execPath, [CHILD_FILE], {
    cwd: SANDBOX,
    env: childEnv,
    encoding: 'utf8',
    timeout: 120000,
  });

  const stdout = res.stdout || '';
  const line = stdout.split('\n').find((l) => l.startsWith('__RESULT__'));
  if (!line) {
    throw new Error(
      `the child produced no result (exit ${res.status}): ${(res.stderr || '').slice(0, 800)}`,
    );
  }
  return JSON.parse(line.slice('__RESULT__'.length));
}

// ---------------------------------------------------------------------------
// Bundling
// ---------------------------------------------------------------------------

const SRC = {
  vercel: path.join(REPO, 'api', 'moderate', 'review.ts'),
  cf: path.join(REPO, 'site', 'functions', 'api', 'moderate', 'review.ts'),
  notifications: path.join(REPO, 'api', 'lib', 'notifications.ts'),
};

async function bundleEntry(entry, outfile) {
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['node:http', 'node:crypto', 'node:fs', 'node:path', 'node:stream'],
    logLevel: 'silent',
  });
  return outfile;
}

/**
 * A COPY of the tree with the GET branch reverted to the OLD behaviour.
 *
 * The copy keeps the relative layout, so `api/moderate/review.ts` still finds
 * `../../site/shared/server/moderation.js` and the Cloudflare twin still finds
 * `../../../shared/server/moderation.js`.
 */
async function buildMutated() {
  const dir = path.join(SANDBOX, 'mutated');
  fs.mkdirSync(dir, { recursive: true });

  // Copy the WHOLE trees first, so every relative import still resolves
  // (api/lib/jsonl.js, api/lib/notifications.js, ...), then overwrite the two
  // endpoint files with the mutated copies.
  const copyDir = (from, to) => {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const src = path.join(from, entry.name);
      const dst = path.join(to, entry.name);
      if (entry.isDirectory()) copyDir(src, dst);
      else if (entry.name.endsWith('.ts')) fs.copyFileSync(src, dst);
    }
  };
  copyDir(path.join(REPO, 'api'), path.join(dir, 'api'));
  copyDir(path.join(REPO, 'site', 'functions'), path.join(dir, 'site', 'functions'));
  copyDir(path.join(SITE, 'shared'), path.join(dir, 'site', 'shared'));

  // The OLD behaviour: a GET decides the quote. The confirmation branch is
  // replaced by the decision code, exactly as it was before M-1.
  const OLD_GET = `  if (method === 'GET') {
    html(
      res,
      renderConfirmationPage({
        ref,
        decision,
        revision,
        ts,
        sig,
        ...(record.state !== 'pending'
          ? { alreadyDecided: String(record.state) }
          : {}),
      }),
      200,
    );
    return;
  }`;

  const NEW_GET = `  if (method === 'GET') {
    // MUTATED (pre-M-1): a GET decides the quote, exactly as it used to.
    // The decision now goes through the store (wave 9), so the mutation uses
    // decideReview() — the same atomic statement the POST uses.
    const now = new Date().toISOString();
    const decidedState = decision === 'approve' ? 'approved' : 'rejected';
    await store.decideReview(ref, decidedState, now, 'one-click-link');
    json(res, { ok: true, ref, state: decidedState }, 200);
    return;
  }`;

  // The Cloudflare twin has the same rule in its own shape: `handle(ctx,
  // commit)` decides whether the request may commit.
  const OLD_CF_GET = `  if (!commit) {
    return html(
      renderConfirmationPage({
        ref,
        decision,
        revision,
        ts,
        sig,
        ...(record.state !== 'pending' ? { alreadyDecided: String(record.state) } : {}),
      }),
      200,
    );
  }`;

  const NEW_CF_GET = `  if (!commit) {
    // MUTATED (pre-M-1): a GET decides the quote, exactly as it used to.
    record.state = decision === 'approve' ? 'approved' : 'rejected';
    record.decidedAt = new Date().toISOString();
    record.decidedBy = 'one-click-link';
    if (!writeReviews(reviews)) {
      return json({ error: 'storage unavailable', code: 'storage' }, 500);
    }
    return json({ ok: true, ref, state: record.state }, 200);
  }`;

  let mutatedVercel = false;
  let mutatedCf = false;

  const vercelSource = fs.readFileSync(SRC.vercel, 'utf8');
  const vercelMutated = vercelSource.replace(OLD_GET, NEW_GET);
  if (vercelMutated !== vercelSource) mutatedVercel = true;
  fs.writeFileSync(path.join(dir, 'api', 'moderate', 'review.ts'), vercelMutated, 'utf8');

  const cfSource = fs.readFileSync(SRC.cf, 'utf8');
  const cfMutated = cfSource.replace(OLD_CF_GET, NEW_CF_GET);
  if (cfMutated !== cfSource) mutatedCf = true;
  fs.writeFileSync(path.join(dir, 'site', 'functions', 'api', 'moderate', 'review.ts'), cfMutated, 'utf8');

  assert(
    mutatedVercel && mutatedCf,
    'the mutation did not apply to BOTH endpoints — the probe would be vacuous',
  );

  return {
    vercel: await bundleEntry(
      path.join(dir, 'api', 'moderate', 'review.ts'),
      path.join(BUNDLES, 'mut-vercel.cjs'),
    ),
    cf: await bundleEntry(
      path.join(dir, 'site', 'functions', 'api', 'moderate', 'review.ts'),
      path.join(BUNDLES, 'mut-cf.cjs'),
    ),
  };
}

// ---------------------------------------------------------------------------
// The signed link
// ---------------------------------------------------------------------------

async function main() {
  fs.mkdirSync(SANDBOX, { recursive: true });
  fs.mkdirSync(BUNDLES, { recursive: true });

  const vercelBundle = await bundleEntry(SRC.vercel, path.join(BUNDLES, 'vercel-moderate.cjs'));
  const cfBundle = await bundleEntry(SRC.cf, path.join(BUNDLES, 'cf-moderate.cjs'));
  const notificationsBundle = await bundleEntry(
    SRC.notifications,
    path.join(BUNDLES, 'notifications.cjs'),
  );

  process.env.FORM_WEBHOOK_SECRET = SECRET;
  process.env.SITE_BASE_URL = BASE;
  const notifications = require(notificationsBundle);
  const ts = Math.floor(Date.now() / 1000);
  const link = notifications.moderationUrl(REF, 'approve', 1, ts);
  const oldLink = notifications.moderationUrl(REF, 'approve', 1, ts - 8 * 24 * 3600);
  const staleLink = notifications.moderationUrl(REF, 'approve', 1, ts); // revision 1
  const freshLink = notifications.moderationUrl(REF, 'approve', 2, ts); // revision 2
  const forgedLink = link.replace(/sig=[^&]+/, 'sig=' + 'f'.repeat(64));

  // --- M1: a GET must NOT decide the quote ---------------------------------
  group('M-1 — a GET must not decide the quote');

  await t('M1', 'a GET answers the confirmation page and the store still says pending', () => {
    writeStore(pendingRecord(1));
    const r = runChild(vercelBundle, [
      {
        type: 'http',
        mode: 'vercel',
        method: 'GET',
        url: link,
        headers: { host: 'imk.test' },
      },
    ])[0];
    assertEqual(r.status, 200, 'the status');
    assert(
      String(r.headers['content-type'] || '').includes('text/html'),
      `a GET must answer the confirmation page, got ${r.headers['content-type']}`,
    );
    const store = readStore();
    assertEqual(store.length, 1, 'the store must still have exactly one line');
    assertEqual(store[0].state, 'pending', 'the quote must still be pending');
    assertEqual(store[0].decidedAt, undefined, 'the quote must carry no decision');
    return '200 + the confirmation page, the store still says pending';
  });

  await t('M2', 'the POST the form issues DOES decide the quote', () => {
    writeStore(pendingRecord(1));
    const r = runChild(vercelBundle, [
      {
        type: 'http',
        mode: 'vercel',
        method: 'POST',
        url: link,
        headers: { host: 'imk.test', 'content-type': 'application/x-www-form-urlencoded' },
        body: '',
      },
    ])[0];
    assertEqual(r.status, 200, 'the status');
    assertEqual(r.body.state, 'approved', 'the state');
    const store = readStore();
    assertEqual(store.length, 1, 'the store must still have exactly one line');
    assertEqual(store[0].state, 'approved', 'the quote must be approved');
    return '200 {ok:true, state:approved} and the store says approved';
  });

  await t('M3', 'a second POST changes nothing (the idempotency guard)', () => {
    writeStore(pendingRecord(1));
    const r = runChild(vercelBundle, [
      {
        type: 'http',
        mode: 'vercel',
        method: 'POST',
        url: link,
        headers: { host: 'imk.test', 'content-type': 'application/x-www-form-urlencoded' },
        body: '',
      },
      {
        type: 'http',
        mode: 'vercel',
        method: 'POST',
        url: link,
        headers: { host: 'imk.test', 'content-type': 'application/x-www-form-urlencoded' },
        body: '',
      },
    ]);
    assertEqual(r[0].body.state, 'approved', 'the first decision');
    assertEqual(r[1].status, 200, 'the second POST status');
    assertEqual(r[1].body.state, 'approved', 'the second POST state');
    const store = readStore();
    assertEqual(store.length, 1, 'a second decision must not append a line');
    return 'the second POST is a no-op';
  });

  await t('M4', 'a link for revision 1 cannot decide a record at revision 2 -> 409', () => {
    writeStore(pendingRecord(2));
    const r = runChild(vercelBundle, [
      {
        type: 'http',
        mode: 'vercel',
        method: 'POST',
        url: staleLink,
        headers: { host: 'imk.test', 'content-type': 'application/x-www-form-urlencoded' },
        body: '',
      },
    ])[0];
    assertEqual(r.status, 409, 'the status');
    assertEqual(r.body.code, 'stale-revision', 'the code');
    assertEqual(readStore()[0].state, 'pending', 'the quote must still be pending');
    return '409 {code:stale-revision}, nothing decided';
  });

  await t('M5', 'a link older than the 7-day TTL is refused -> 400 expired', () => {
    writeStore(pendingRecord(1));
    const r = runChild(vercelBundle, [
      {
        type: 'http',
        mode: 'vercel',
        method: 'POST',
        url: oldLink,
        headers: { host: 'imk.test', 'content-type': 'application/x-www-form-urlencoded' },
        body: '',
      },
    ])[0];
    assertEqual(r.status, 400, 'the status');
    assertEqual(r.body.code, 'expired', 'the code');
    assertEqual(readStore()[0].state, 'pending', 'the quote must still be pending');
    return '400 {code:expired}, nothing decided';
  });

  await t('M6', 'a forged signature is refused -> 400 signature', () => {
    writeStore(pendingRecord(1));
    const r = runChild(vercelBundle, [
      {
        type: 'http',
        mode: 'vercel',
        method: 'POST',
        url: forgedLink,
        headers: { host: 'imk.test', 'content-type': 'application/x-www-form-urlencoded' },
        body: '',
      },
    ])[0];
    assertEqual(r.status, 400, 'the status');
    assertEqual(r.body.code, 'signature', 'the code');
    assertEqual(readStore()[0].state, 'pending', 'the quote must still be pending');
    return '400 {code:signature}, nothing decided';
  });

  await t('M7', 'the correct link for the current revision DOES decide it', () => {
    writeStore(pendingRecord(2));
    const r = runChild(vercelBundle, [
      {
        type: 'http',
        mode: 'vercel',
        method: 'POST',
        url: freshLink,
        headers: { host: 'imk.test', 'content-type': 'application/x-www-form-urlencoded' },
        body: '',
      },
    ])[0];
    assertEqual(r.status, 200, 'the status');
    assertEqual(r.body.state, 'approved', 'the state');
    return 'the revision guard does not block the CURRENT revision';
  });

  // --- Parity with the Cloudflare twin --------------------------------------
  group('PARITY — the Cloudflare twin answers the same codes');

  await t('P1', 'a GET on the CF twin answers the page and decides nothing', () => {
    writeStore(pendingRecord(1));
    const r = runChild(
      cfBundle,
      [
        {
          type: 'http',
          mode: 'cf',
          method: 'GET',
          url: link,
          headers: { host: 'imk.test' },
        },
      ],
      {},
      { APP_ENV: 'development', SITE_BASE_URL: BASE, FORM_WEBHOOK_SECRET: SECRET },
    )[0];
    assertEqual(r.status, 200, 'the status');
    assert(
      String(r.headers['content-type'] || '').includes('text/html'),
      `a GET must answer the confirmation page, got ${r.headers['content-type']}`,
    );
    assertEqual(readStore()[0].state, 'pending', 'the quote must still be pending');
    return 'the CF twin behaves like the Vercel tree';
  });

  await t('P2', 'the CF twin and the Vercel tree answer the SAME codes', () => {
    const cases = [
      { name: 'a GET', method: 'GET', url: link, status: 200 },
      { name: 'a forged link', method: 'POST', url: forgedLink, status: 400 },
      { name: 'an expired link', method: 'POST', url: oldLink, status: 400 },
      { name: 'a stale revision', method: 'POST', url: staleLink, status: 409 },
    ];
    const cfEnv = { APP_ENV: 'development', SITE_BASE_URL: BASE, FORM_WEBHOOK_SECRET: SECRET };
    for (const c of cases) {
      writeStore(pendingRecord(1));
      const v = runChild(vercelBundle, [
        {
          type: 'http',
          mode: 'vercel',
          method: c.method,
          url: c.url,
          headers: { host: 'imk.test', 'content-type': 'application/x-www-form-urlencoded' },
          body: c.method === 'POST' ? '' : undefined,
        },
      ])[0];
      writeStore(pendingRecord(1));
      const cf = runChild(
        cfBundle,
        [
          {
            type: 'http',
            mode: 'cf',
            method: c.method,
            url: c.url,
            headers: { host: 'imk.test', 'content-type': 'application/x-www-form-urlencoded' },
            body: c.method === 'POST' ? '' : undefined,
          },
        ],
        {},
        cfEnv,
      )[0];
      assertEqual(cf.status, v.status, `${c.name}: the two trees must answer the same status`);
    }
    return 'GET, forged, expired and stale-revision all agree';
  });

  // --- The mutation probe ----------------------------------------------------
  group('the mutation probe — the reverted GET must REDDEN the M1 assertion');

  await t('D1', 'with the old "a GET decides the quote" the M1 assertion FAILS', async () => {
    const mutated = await buildMutated();

    writeStore(pendingRecord(1));
    const r = runChild(mutated.vercel, [
      {
        type: 'http',
        mode: 'vercel',
        method: 'GET',
        url: link,
        headers: { host: 'imk.test' },
      },
    ])[0];
    const store = readStore();
    const flipped = store[0].state !== 'pending';
    assert(
      flipped,
      'the mutation did not change the behaviour — the M1 assertion does not test the fix',
    );
    assert(
      r.status === 200 && r.body && r.body.state === 'approved',
      'the mutated GET must answer 200 {state:approved} — the old behaviour',
    );
    return `the mutated GET decided the quote (${store[0].state}) — M1 would fail`;
  });

  await t('D2', 'the same is true for the Cloudflare twin', async () => {
    const mutated = await buildMutated();
    writeStore(pendingRecord(1));
    const r = runChild(
      mutated.cf,
      [
        {
          type: 'http',
          mode: 'cf',
          method: 'GET',
          url: link,
          headers: { host: 'imk.test' },
        },
      ],
      {},
      { APP_ENV: 'development', SITE_BASE_URL: BASE, FORM_WEBHOOK_SECRET: SECRET },
    )[0];
    const store = readStore();
    assert(
      store[0].state !== 'pending',
      'the mutated CF twin did not decide the quote — the parity assertion does not test the fix',
    );
    return `the mutated CF GET decided the quote (${store[0].state})`;
  });

  // --- Summary ---------------------------------------------------------------
  const failedCount = results.filter((r) => r.status === 'FAIL').length;
  origLog('');
  origLog(
    `[wave8-m1] ${results.length - failedCount}/${results.length} passed, ${failedCount} failed`,
  );
  if (!KEEP) {
    try {
      fs.rmSync(SANDBOX, { recursive: true, force: true });
    } catch {
      /* the temp dir will be cleaned by the OS */
    }
  } else {
    origLog(`[wave8-m1] sandbox kept at ${SANDBOX}`);
  }
  if (failedCount > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('[wave8-m1] FATAL', err);
  process.exitCode = 1;
});
