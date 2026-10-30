// backend-wave15-empty-carrier-harness.mjs
//
// WHAT IT EXECUTES -- wave 15, B-1: the EMPTY CARRIER.
//
// THE DEFECT IT GUARDS AGAINST
//   The routing layer reads the original public path from the reserved
//   query parameter __imk_route (or, if a platform ever drops the query,
//   from the x-imk-route header). Both entry points read the query
//   parameter with a TRUTHINESS test:
//
//       const fromQuery = url.searchParams.get(ROUTE_CARRIER_PARAM);
//       if (fromQuery) return fromQuery;            // '' is falsy
//       const header = req.headers[ROUTE_CARRIER_HEADER];
//       if (typeof header === 'string' && header) return header;
//
//   `searchParams.get` returns null only when the parameter is ABSENT, so
//   an EMPTY value (?__imk_route=) was treated as ABSENT and the
//   client-controlled header channel was consulted instead: two channels,
//   two rules, and an ambiguity in a security-relevant resolution path
//   (wave-14 audit, MINOR). It granted no extra capability -- the header
//   channel is client-controlled anyway -- but the rule was not a rule.
//
// THE RULE NOW (wave 15, B-1)
//   The query carrier, when PRESENT, is authoritative. An empty value is an
//   INVALID carrier -> 404 {code:'not-found'}. The header is read only when
//   the query parameter is genuinely absent, and it still resolves exactly
//   as it did.
//
//   Nothing else moved: the family containment, the unreachable standalone
//   URLs, the handler's own authorisation, the loud 500
//   {code:'route-resolution'} for a bare entry point and the carrier STRIP
//   are all unchanged.
//
// THE CHECKS
//   A  the rule, read from the tree
//   B  the resolver, executed as a pure function
//   C  the entry points, executed (HTTP)
//   D  the mutation probes -- every fix is reverted in a COPY and the same
//      property must go RED. The repository is never modified.
//
// USAGE
//   node backend-wave15-empty-carrier-harness.mjs [--keep]

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = fs.existsSync(path.join(HERE, 'api', 'portal.ts')) ? HERE : path.resolve(HERE, '..');
const SITE = path.join(REPO, 'site');
const siteRequire = createRequire(path.join(SITE, 'package.json'));
const { build } = siteRequire('esbuild');

const KEEP = process.argv.includes('--keep');

const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const ROOT = path.join(os.tmpdir(), 'opencode', 'wave15-empty-carrier', STAMP);

// The secret is 40 characters: the shared module refuses a shorter one in
// production, and the harness runs in production mode (APP_ENV=test).
const SESSION_SECRET = 'wave15-harness-session-secret-0123456789';
const WEBHOOK_SECRET = 'wave15-harness-webhook-secret-0123456789';
const OWNER_EMAIL = 'owner@imk.test';
const CLIENT_ONE = { email: 'one@imk.test', clientId: 'cli_1' };
const CLIENT_TWO = { email: 'two@imk.test', clientId: 'cli_2' };

// ---------------------------------------------------------------------------
// The tiny test framework (the same shape as the other repo-root harnesses)
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;
const failures = [];

function group(name) {
  console.log(`\n[wave15] ${name}`);
}

async function t(id, name, fn) {
  try {
    const detail = await fn();
    passed++;
    console.log(`  PASS  ${id}  ${name}`);
    if (detail) console.log(`          ${detail}`);
  } catch (err) {
    failed++;
    failures.push(id);
    console.log(`  FAIL  ${id}  ${name}`);
    console.log(`          ${err && err.message ? err.message : err}`);
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// ---------------------------------------------------------------------------
// The tree helpers
// ---------------------------------------------------------------------------

function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) {
      continue;
    }
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(src, dst);
    else fs.copyFileSync(src, dst);
  }
}

/**
 * A sandbox copy of the tree.
 *
 * The relative import layout is preserved exactly, so `api/portal.ts` still
 * finds `../site/shared/portal-router.js` and the handler modules still find
 * `../server/portal-session.js`.
 */
function sandboxCopy(name) {
  const root = path.join(ROOT, name);
  fs.rmSync(root, { recursive: true, force: true });
  copyTree(path.join(REPO, 'api'), path.join(root, 'api'));
  copyTree(path.join(SITE, 'shared'), path.join(root, 'site', 'shared'));
  return root;
}

/** Patch a file in a sandbox: the literal anchor must exist or this throws. */
function patchFile(file, anchor, replacement) {
  const source = fs.readFileSync(file, 'utf8');
  if (!source.includes(anchor)) {
    throw new Error(`the mutation anchor was not found in ${file}: ${JSON.stringify(anchor)}`);
  }
  fs.writeFileSync(file, source.replace(anchor, replacement), 'utf8');
}

async function bundleFrom(root, name) {
  const entryFile = path.join(ROOT, `${name}-entry.ts`);
  const outFile = path.join(ROOT, `${name}-bundle.cjs`);
  fs.mkdirSync(ROOT, { recursive: true });
  const abs = (p) => p.replace(/\\/g, '/');
  fs.writeFileSync(
    entryFile,
    [
      `export { default as portal } from '${abs(path.join(root, 'api', 'portal.ts'))}';`,
      `export { default as admin } from '${abs(path.join(root, 'api', 'admin.ts'))}';`,
      `export { resolveRoute, rebuildRequestUrl, matchRoutePattern, isInsideEntry, ROUTE_CARRIER_PARAM, ROUTE_CARRIER_HEADER } from '${abs(path.join(root, 'site', 'shared', 'portal-router.ts'))}';`,
      `export { createSession } from '${abs(path.join(root, 'site', 'shared', 'server', 'portal-session.ts'))}';`,
    ].join('\n'),
    'utf8',
  );
  await build({
    entryPoints: [entryFile],
    outfile: outFile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    absWorkingDir: REPO,
    external: ['node:http', 'node:crypto', 'node:fs', 'node:path', 'node:stream'],
    logLevel: 'silent',
  });
  return outFile;
}

// ---------------------------------------------------------------------------
// The child process: JSON in, JSON out. No port is bound.
// ---------------------------------------------------------------------------
const CHILD = `
const api = require(process.argv[2]);
const readline = require('readline');
const { Readable } = require('node:stream');

function makeReq(method, url, headers, body) {
  const req = Readable.from(body ? [Buffer.from(body)] : []);
  req.method = method;
  req.url = url;
  req.headers = Object.assign({ host: 'imk.test' }, headers || {});
  return req;
}

function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    writableEnded: false,
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers || {};
      return this;
    },
    end(payload) {
      if (payload !== undefined && payload !== null) this.body += String(payload);
      this.writableEnded = true;
    },
  };
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  let result;
  try {
    if (msg.kind === 'route') {
      result = api.resolveRoute(msg.rawUrl, msg.carrier === undefined ? null : msg.carrier, msg.entryPrefix, msg.table);
    } else if (msg.kind === 'inside') {
      result = api.isInsideEntry(msg.pathname, msg.entryPrefix);
    } else if (msg.kind === 'session') {
      result = api.createSession(msg.email, msg.role, msg.clientId || undefined, process.env);
    } else if (msg.kind === 'http') {
      const req = makeReq(msg.method, msg.url, msg.headers, msg.body);
      const res = makeRes();
      await api[msg.entry](req, res);
      result = { status: res.statusCode, body: res.body, headers: res.headers };
    } else {
      result = { error: 'unknown kind ' + msg.kind };
    }
    process.stdout.write('@@IMK@@' + JSON.stringify({ ok: true, result }) + '\\n');
  } catch (err) {
    process.stdout.write('@@IMK@@' + JSON.stringify({ ok: false, error: String((err && err.message) || err) }) + '\\n');
  }
});
`;

async function startChild(bundlePath, env) {
  const scriptFile = path.join(ROOT, 'child.js');
  fs.mkdirSync(ROOT, { recursive: true });
  fs.writeFileSync(scriptFile, CHILD, 'utf8');

  const child = spawn(process.execPath, [scriptFile, bundlePath], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const pending = [];
  const logs = [];
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      // Only the tagged lines are answers; everything else is a log line the
      // product wrote (console.log).
      if (!line.startsWith('@@IMK@@')) {
        logs.push(line);
        continue;
      }
      const resolve = pending.shift();
      if (resolve) resolve(JSON.parse(line.slice('@@IMK@@'.length)));
    }
  });

  const ask = (msg) =>
    new Promise((resolve) => {
      pending.push(resolve);
      child.stdin.write(JSON.stringify(msg) + '\n');
    });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => logs.push(chunk));

  return { ask, logs, close: () => child.kill() };
}

// ---------------------------------------------------------------------------
// The store: a SANDBOX. The repository's site/data is never read or written.
// ---------------------------------------------------------------------------
function makeDataDir(name) {
  const dataDir = path.join(ROOT, name, 'data');
  fs.mkdirSync(path.join(dataDir, 'portal'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'moderation'), { recursive: true });

  const line = (obj) => JSON.stringify(obj) + '\n';

  fs.writeFileSync(
    path.join(dataDir, 'portal', 'projects.jsonl'),
    line({ id: 'prj_mine', clientId: CLIENT_ONE.clientId, title: 'Mine', status: 'discovery' }) +
      line({ id: 'prj_other', clientId: CLIENT_TWO.clientId, title: 'OTHER CLIENT SECRET', status: 'discovery' }),
    'utf8',
  );
  fs.writeFileSync(
    path.join(dataDir, 'portal', 'clients.jsonl'),
    line({ id: CLIENT_ONE.clientId, email: CLIENT_ONE.email }) +
      line({ id: CLIENT_TWO.clientId, email: CLIENT_TWO.email }),
    'utf8',
  );
  fs.writeFileSync(
    path.join(dataDir, 'portal', 'comments.jsonl'),
    line({
      id: 'cmt_1',
      projectId: 'prj_mine',
      authorId: CLIENT_ONE.email,
      body: 'A comment of my own.',
      createdAt: '2026-10-22T09:00:00.000Z',
    }),
    'utf8',
  );
  for (const name2 of [
    'portal/invited.jsonl',
    'portal/planItems.jsonl',
    'portal/updates.jsonl',
    'portal/sessions.jsonl',
  ]) {
    fs.writeFileSync(path.join(dataDir, name2), '', 'utf8');
  }
  fs.writeFileSync(
    path.join(dataDir, 'moderation', 'reviews.jsonl'),
    line({
      type: 'review',
      ref: 'ref_one',
      revision: 1,
      recordId: 'rec_one',
      rating: 5,
      name: 'Ann',
      company: 'One Ltd',
      review: 'A good quote.',
      receivedAt: '2026-10-22T09:00:00.000Z',
      updatedAt: '2026-10-22T09:00:00.000Z',
      state: 'pending',
    }),
    'utf8',
  );
  return dataDir;
}

function childEnv(dataDir) {
  return {
    PORTAL_DATA_DIR: dataDir,
    PORTAL_STORE: 'file',
    SITE_BASE_URL: 'http://imk.test',
    ADMIN_EMAILS: OWNER_EMAIL,
    APP_ENV: 'test',
    FORM_WEBHOOK_SECRET: WEBHOOK_SECRET,
    PORTAL_SESSION_SECRET: SESSION_SECRET,
    PORTAL_MAGIC_LINK_SECRET: SESSION_SECRET,
  };
}

// ---------------------------------------------------------------------------
// The route table (read from disk — the same file the product reads)
// ---------------------------------------------------------------------------
const TABLE = JSON.parse(fs.readFileSync(path.join(SITE, 'shared', 'portal-routes.json'), 'utf8'));
const PORTAL_TABLE = TABLE.families['/api/portal'].routes;
const ADMIN_TABLE = TABLE.families['/api/admin'].routes;

// ---------------------------------------------------------------------------
// The helpers the checks use
// ---------------------------------------------------------------------------

async function http(child, entry, url, headers = {}) {
  const answer = await child.ask({ kind: 'http', entry, method: 'GET', url, headers });
  if (!answer.ok) throw new Error(`the entry point threw: ${answer.error}`);
  let json = null;
  try {
    json = JSON.parse(answer.result.body);
  } catch {
    /* not JSON — the checks that care about it assert on the status */
  }
  return { status: answer.result.status, body: answer.result.body, json };
}

/** A client session cookie, minted by the PRODUCT's own session module. */
async function clientCookie(child, client) {
  const answer = await child.ask({
    kind: 'session',
    email: client.email,
    role: 'client',
    clientId: client.clientId,
  });
  if (!answer.ok) throw new Error(`the session module threw: ${answer.error}`);
  assert(answer.result, 'the session module returned no token');
  return `imk_session=${answer.result}`;
}

/** An owner session cookie, minted by the PRODUCT's own session module. */
async function ownerCookie(child) {
  const answer = await child.ask({
    kind: 'session',
    email: OWNER_EMAIL,
    role: 'admin',
  });
  if (!answer.ok) throw new Error(`the session module threw: ${answer.error}`);
  assert(answer.result, 'the session module returned no token');
  return `imk_admin_session=${answer.result}`;
}

// The three shapes of the carrier that the checks use.
const EMPTY_QUERY = '/api/portal?__imk_route=';
const ADMIN_EMPTY_QUERY = '/api/admin?__imk_route=';

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

async function main() {
  fs.mkdirSync(ROOT, { recursive: true });
  console.log(`[wave15] repo:    ${REPO}`);
  console.log(`[wave15] sandbox: ${ROOT}`);

  const controlRoot = sandboxCopy('control');
  const controlBundle = await bundleFrom(controlRoot, 'control');
  const dataDir = makeDataDir('control');
  const child = await startChild(controlBundle, childEnv(dataDir));

  // =====================================================================
  group('A — the rule, read from the tree');
  // =====================================================================

  await t('A1', 'both entry points test the query carrier for PRESENCE, not truthiness', async () => {
    for (const file of ['api/portal.ts', 'api/admin.ts']) {
      const text = fs.readFileSync(path.join(REPO, file), 'utf8');
      assert(
        text.includes('if (fromQuery !== null) return fromQuery;'),
        `${file} does not test the query carrier for presence`,
      );
      assert(
        !text.includes('if (fromQuery) return fromQuery;'),
        `${file} still uses a truthiness test — an empty carrier falls through`,
      );
    }
    return 'api/portal.ts and api/admin.ts both use `!== null`';
  });

  await t('A2', 'the resolver refuses an EMPTY carrier explicitly and keeps the loud 500', async () => {
    const text = fs.readFileSync(path.join(SITE, 'shared', 'portal-router.ts'), 'utf8');
    assert(
      text.includes('if (carrier !== null) {'),
      'the resolver does not distinguish an absent carrier from an empty one',
    );
    assert(
      text.includes("if (carrier === '') {"),
      'the resolver does not refuse an empty carrier explicitly',
    );
    assert(
      text.includes("if (pathname === entryPrefix) {"),
      'the resolver lost the bare-entry-point rule (the loud 500)',
    );
    return 'rule 2 tests presence, refuses the empty carrier, rule 3 is intact';
  });

  // =====================================================================
  group('B — the resolver (a pure function, executed offline)');
  // =====================================================================

  await t('B1', 'an EMPTY carrier is not-found, never route-resolution', async () => {
    for (const [entryPrefix, table] of [
      ['/api/portal', PORTAL_TABLE],
      ['/api/admin', ADMIN_TABLE],
    ]) {
      const answer = await child.ask({
        kind: 'route',
        rawUrl: entryPrefix,
        carrier: '',
        entryPrefix,
        table,
      });
      assert(answer.ok, `the resolver threw: ${answer.error}`);
      assertEqual(answer.result.ok, false, `an empty carrier resolved at ${entryPrefix}`);
      assertEqual(
        answer.result.reason,
        'not-found',
        `an empty carrier at ${entryPrefix} must be 'not-found'`,
      );
    }
    return 'both entry points: not-found';
  });

  await t('B2', 'CONTROL: an ABSENT carrier on a bare entry point is still route-resolution', async () => {
    for (const [entryPrefix, table] of [
      ['/api/portal', PORTAL_TABLE],
      ['/api/admin', ADMIN_TABLE],
    ]) {
      const answer = await child.ask({
        kind: 'route',
        rawUrl: entryPrefix,
        carrier: null,
        entryPrefix,
        table,
      });
      assert(answer.ok, `the resolver threw: ${answer.error}`);
      assertEqual(answer.result.ok, false, `the bare entry point resolved at ${entryPrefix}`);
      assertEqual(
        answer.result.reason,
        'route-resolution',
        `the bare entry point at ${entryPrefix} must stay 'route-resolution'`,
      );
    }
    return 'the loud 500 is unchanged on both entry points';
  });

  await t('B3', 'CONTROL: a legitimate carrier still resolves', async () => {
    const answer = await child.ask({
      kind: 'route',
      rawUrl: '/api/portal',
      carrier: '/api/portal/comments',
      entryPrefix: '/api/portal',
      table: PORTAL_TABLE,
    });
    assert(answer.ok, `the resolver threw: ${answer.error}`);
    assert(answer.result.ok, 'a legitimate carrier did not resolve — the checks above are vacuous');
    assertEqual(answer.result.handler, 'portal-comments', 'the handler');
    return 'portal-comments';
  });

  await t('B4', 'CONTROL: the PATH still wins over a forged carrier', async () => {
    const answer = await child.ask({
      kind: 'route',
      rawUrl: '/api/portal/projects',
      carrier: '/api/portal/comments',
      entryPrefix: '/api/portal',
      table: PORTAL_TABLE,
    });
    assert(answer.ok, `the resolver threw: ${answer.error}`);
    assert(answer.result.ok, 'the direct path did not resolve');
    assertEqual(answer.result.handler, 'portal-projects', 'the handler');
    return 'portal-projects';
  });

  // =====================================================================
  group('C — the entry points (executed)');
  // =====================================================================

  await t('C1', 'an EMPTY query carrier is refused, and the header channel is NOT consulted', async () => {
    // The header names the session route. If the empty query carrier fell
    // through to it, the SESSION HANDLER would run — and it answers 401
    // {code:'unauthorized'} without a session. 404 {code:'not-found'} is the
    // only answer that proves the router refused it.
    const answer = await http(child, 'portal', EMPTY_QUERY, {
      'x-imk-route': '/api/portal/session',
    });
    assertEqual(answer.status, 404, `the status (${answer.body.slice(0, 200)})`);
    assertEqual(answer.json.code, 'not-found', 'the code');
    assert(
      answer.status !== 401 && !/unauthorized/.test(answer.body),
      `the session handler ran: ${answer.body.slice(0, 200)}`,
    );
    return '404 {code:not-found} — the session handler never ran';
  });

  await t('C2', 'the same on the ADMIN entry point', async () => {
    const answer = await http(child, 'admin', ADMIN_EMPTY_QUERY, {
      'x-imk-route': '/api/admin/reviews',
    });
    assertEqual(answer.status, 404, `the status (${answer.body.slice(0, 200)})`);
    assertEqual(answer.json.code, 'not-found', 'the code');
    assert(
      answer.status !== 401 && !/unauthorized/.test(answer.body),
      `the owner's inbox handler ran: ${answer.body.slice(0, 200)}`,
    );
    return '404 {code:not-found} — the owner inbox handler never ran';
  });

  await t('C3', 'an EMPTY query carrier alone is a 404, not the loud 500', async () => {
    const answer = await http(child, 'portal', EMPTY_QUERY);
    assertEqual(answer.status, 404, `the status (${answer.body.slice(0, 200)})`);
    assertEqual(answer.json.code, 'not-found', 'the code');
    assert(
      answer.json.code !== 'route-resolution',
      'the empty carrier fell through to the bare-entry-point rule',
    );
    return '404 {code:not-found}';
  });

  await t('C4', 'CONTROL: an ABSENT query carrier still resolves through the header', async () => {
    const cookie = await clientCookie(child, CLIENT_ONE);
    const answer = await http(child, 'portal', '/api/portal', {
      'x-imk-route': '/api/portal/comments',
      cookie,
    });
    assertEqual(answer.status, 200, `the status (${answer.body.slice(0, 200)})`);
    assert(
      answer.json && Object.prototype.hasOwnProperty.call(answer.json, 'comments'),
      `the header carrier did not reach the comments handler: ${answer.body.slice(0, 200)}`,
    );
    return '200 — the x-imk-route header still serves the comments route';
  });

  await t('C5', 'CONTROL: the header channel on the ADMIN side is unchanged too', async () => {
    const none = await http(child, 'admin', '/api/admin', {
      'x-imk-route': '/api/admin/reviews',
    });
    assertEqual(none.status, 401, 'no cookie: the status');
    assertEqual(none.json.code, 'unauthorized', 'no cookie: the code');
    const cookie = await ownerCookie(child);
    const asOwner = await http(child, 'admin', '/api/admin', {
      'x-imk-route': '/api/admin/reviews',
      cookie,
    });
    assertEqual(asOwner.status, 200, `the owner inbox: ${asOwner.body.slice(0, 200)}`);
    return '401 without a cookie, 200 with the owner session — unchanged';
  });

  await t('C6', 'CONTROL: a PRESENT query carrier wins over the header', async () => {
    const cookie = await clientCookie(child, CLIENT_ONE);
    const answer = await http(
      child,
      'portal',
      '/api/portal?__imk_route=%2Fapi%2Fportal%2Fcomments',
      { 'x-imk-route': '/api/portal/session', cookie },
    );
    assertEqual(answer.status, 200, `the status (${answer.body.slice(0, 200)})`);
    assert(
      answer.json && Object.prototype.hasOwnProperty.call(answer.json, 'comments'),
      `the header won over the query carrier: ${answer.body.slice(0, 200)}`,
    );
    assert(
      !answer.json || !Object.prototype.hasOwnProperty.call(answer.json, 'authenticated'),
      'the session handler answered instead of the comments handler',
    );
    return 'the comments handler ran — the query carrier decided';
  });

  await t('C7', 'CONTROL: the ordinary carrier path still serves the client\'s own data', async () => {
    const cookie = await clientCookie(child, CLIENT_ONE);
    const answer = await http(child, 'portal', '/api/portal?__imk_route=%2Fapi%2Fportal%2Fprojects', {
      cookie,
    });
    assertEqual(answer.status, 200, `the status (${answer.body.slice(0, 200)})`);
    const ids = (answer.json.projects || []).map((p) => p.id);
    assert(ids.includes('prj_mine'), `the client's own project is missing: ${ids.join(', ')}`);
    assert(!ids.includes('prj_other'), `another client's project leaked: ${ids.join(', ')}`);
    return `200, the client sees ${ids.length} project(s) of its own`;
  });

  // =====================================================================
  group('D — the mutation probes (each must redden in a COPY)');
  // =====================================================================

  await t('D1', 'restoring the fall-through in the PORTAL entry point makes C1 go RED', async () => {
    const mutantRoot = sandboxCopy('mut-portal-fallthrough');
    patchFile(
      path.join(mutantRoot, 'api', 'portal.ts'),
      '  if (fromQuery !== null) return fromQuery;',
      '  if (fromQuery) return fromQuery;',
    );
    const bundle = await bundleFrom(mutantRoot, 'mut-portal-fallthrough');
    const mutantChild = await startChild(bundle, childEnv(dataDir));
    try {
      const answer = await http(mutantChild, 'portal', EMPTY_QUERY, {
        'x-imk-route': '/api/portal/session',
      });
      assert(
        answer.status !== 404,
        `the mutant still answered 404 — the probe is vacuous (${answer.body.slice(0, 200)})`,
      );
      const control = await http(child, 'portal', EMPTY_QUERY, {
        'x-imk-route': '/api/portal/session',
      });
      assertEqual(control.status, 404, 'the control must refuse the empty carrier');
      return `the mutant answers ${answer.status} (the session handler ran), the control answers 404`;
    } finally {
      mutantChild.close();
    }
  });

  await t('D2', 'restoring the fall-through in the ADMIN entry point makes C2 go RED', async () => {
    const mutantRoot = sandboxCopy('mut-admin-fallthrough');
    patchFile(
      path.join(mutantRoot, 'api', 'admin.ts'),
      '  if (fromQuery !== null) return fromQuery;',
      '  if (fromQuery) return fromQuery;',
    );
    const bundle = await bundleFrom(mutantRoot, 'mut-admin-fallthrough');
    const mutantChild = await startChild(bundle, childEnv(dataDir));
    try {
      const answer = await http(mutantChild, 'admin', ADMIN_EMPTY_QUERY, {
        'x-imk-route': '/api/admin/reviews',
      });
      assert(
        answer.status !== 404,
        `the mutant still answered 404 — the probe is vacuous (${answer.body.slice(0, 200)})`,
      );
      const control = await http(child, 'admin', ADMIN_EMPTY_QUERY, {
        'x-imk-route': '/api/admin/reviews',
      });
      assertEqual(control.status, 404, 'the control must refuse the empty carrier');
      return `the mutant answers ${answer.status} (the owner inbox handler ran), the control answers 404`;
    } finally {
      mutantChild.close();
    }
  });

  await t('D3', 'the resolver treating an empty carrier as ABSENT makes C3 go RED', async () => {
    const mutantRoot = sandboxCopy('mut-resolver-truthy');
    patchFile(
      path.join(mutantRoot, 'site', 'shared', 'portal-router.ts'),
      '  if (carrier !== null) {',
      '  if (carrier) {',
    );
    const bundle = await bundleFrom(mutantRoot, 'mut-resolver-truthy');
    const mutantChild = await startChild(bundle, childEnv(dataDir));
    try {
      const answer = await http(mutantChild, 'portal', EMPTY_QUERY);
      assert(
        answer.status !== 404,
        `the mutant still answered 404 — the probe is vacuous (${answer.body.slice(0, 200)})`,
      );
      const control = await http(child, 'portal', EMPTY_QUERY);
      assertEqual(control.status, 404, 'the control must refuse the empty carrier');
      return `the mutant answers ${answer.status} ${answer.json && answer.json.code}, the control answers 404`;
    } finally {
      mutantChild.close();
    }
  });

  await t('D4', 'CONTROL PROOF: the header channel is really read (C4 is not vacuous)', async () => {
    const mutantRoot = sandboxCopy('mut-no-header');
    patchFile(
      path.join(mutantRoot, 'api', 'portal.ts'),
      '  const header = req.headers[ROUTE_CARRIER_HEADER];',
      '  const header = undefined; // WAVE-15 MUTATION: the header channel is dead',
    );
    const bundle = await bundleFrom(mutantRoot, 'mut-no-header');
    const mutantChild = await startChild(bundle, childEnv(dataDir));
    try {
      const cookie = await clientCookie(mutantChild, CLIENT_ONE);
      const answer = await http(mutantChild, 'portal', '/api/portal', {
        'x-imk-route': '/api/portal/comments',
        cookie,
      });
      assert(
        answer.status !== 200,
        `the mutant still answered 200 — the control check is vacuous (${answer.body.slice(0, 200)})`,
      );
      return `the mutant answers ${answer.status} — the header channel is load-bearing for C4`;
    } finally {
      mutantChild.close();
    }
  });

  child.close();

  // --- the summary ----------------------------------------------------------
  console.log('');
  if (failed === 0) {
    console.log(`[wave15] ${passed} passed, 0 failed, ${passed} checks`);
  } else {
    console.log(`[wave15] ${passed} passed, ${failed} failed, ${passed + failed} checks`);
    console.log(`[wave15] failing checks: ${failures.join(', ')}`);
  }
  if (!KEEP) {
    try {
      fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      /* the sandbox is in the temp directory; a leftover is harmless */
    }
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('[wave15] the harness itself failed:', err);
  process.exit(2);
});
