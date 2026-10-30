// backend-wave14-carrier-containment-harness.mjs
//
// WHAT IT EXECUTES — wave 14: the carrier containment of the routing layer.
//
// THE DEFECT IT GUARDS AGAINST
//   Wave 13 moved the portal behind ONE entry point per family and a
//   vercel.json rewrite. The rewrite REPLACES the path with the entry
//   prefix and names the original public path in the reserved query
//   parameter __imk_route. The resolver (site/shared/portal-router.ts) then
//   decides which handler runs.
//
//   That made the PATH stop identifying the route on the deployed target,
//   and the shipped comment claimed a hardening that nobody had proven:
//   "a client cannot smuggle a different handler in with a forged carrier".
//   The Code Reviewer executed it: if the platform merges the client's
//   query over the rewrite's own query, a forged __imk_route decides the
//   handler. WHICH SIDE WINS IS NOT OBSERVED — no Vercel router was booted.
//
//   So the claim was replaced (wave 14, F1) by the set of invariants that
//   hold EITHER WAY, and this harness proves them BY EXECUTION:
//
//     1. FAMILY CONTAINMENT — an entry point resolves only its own family
//        table, and the two tables are disjoint.
//     2. THE STANDALONE URLS ARE OUT OF REACH — api/contact.ts,
//        api/moderate/review.ts and the three api/portal/auth/* files are in
//        no family table, so no carrier can name them.
//     3. THE HANDLER AUTHORIZES ITSELF — resolveAccess / canReadClient /
//        canWriteClient for the client routes, the owner session for the
//        owner routes. A forged carrier grants no capability the handler
//        would not have granted anyway.
//
//   Plus the deploy gate (wave 14, F2 and F3): the route check must NAME
//   the miss instead of crashing, and it must catch a table route the
//   entry point cannot serve.
//
// THE CHECKS
//   A  the invariants, read from the tree
//   B  the resolver, executed as a pure function
//   C  the entry points, executed (HTTP)
//   D  the mutation probes — every fix is reverted in a COPY and the same
//      property must go RED. The repository is never modified.
//   E  the deploy gate, executed in a throwaway tree
//
// USAGE
//   node backend-wave14-carrier-containment-harness.mjs [--keep]

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = fs.existsSync(path.join(HERE, 'api', 'portal.ts')) ? HERE : path.resolve(HERE, '..');
const SITE = path.join(REPO, 'site');
const siteRequire = createRequire(path.join(SITE, 'package.json'));
const { build } = siteRequire('esbuild');

const KEEP = process.argv.includes('--keep');

const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const ROOT = path.join(os.tmpdir(), 'opencode', 'wave14-carrier-containment', STAMP);

// The secret is 40 characters: the shared module refuses a shorter one in
// production, and the harness runs in production mode (APP_ENV=test).
const SESSION_SECRET = 'wave14-harness-session-secret-0123456789';
const WEBHOOK_SECRET = 'wave14-harness-webhook-secret-0123456789';
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
  console.log(`\n[wave14] ${name}`);
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
  for (const name2 of [
    'portal/invited.jsonl',
    'portal/comments.jsonl',
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
const STANDALONE_URLS = Object.keys(TABLE.standalone);

// The URLs of the two families, for the cross-family probes.
const PORTAL_URLS = Object.keys(PORTAL_TABLE);
const ADMIN_URLS = Object.keys(ADMIN_TABLE);

// ---------------------------------------------------------------------------
// The helpers the checks use
// ---------------------------------------------------------------------------

const carrier = (pathname) => `/api/portal?__imk_route=${encodeURIComponent(pathname)}`;
const adminCarrier = (pathname) => `/api/admin?__imk_route=${encodeURIComponent(pathname)}`;

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

// ---------------------------------------------------------------------------
// The deploy gate, executed in a throwaway tree
// ---------------------------------------------------------------------------

/** A minimal tree the route check can run in. Never the repository. */
function gateTree(name) {
  const root = path.join(ROOT, name);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.join(root, 'site', 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'site', 'shared'), { recursive: true });
  fs.copyFileSync(
    path.join(SITE, 'scripts', 'check-api-routes.mjs'),
    path.join(root, 'site', 'scripts', 'check-api-routes.mjs'),
  );
  fs.copyFileSync(
    path.join(SITE, 'shared', 'portal-routes.json'),
    path.join(root, 'site', 'shared', 'portal-routes.json'),
  );
  fs.copyFileSync(path.join(REPO, 'vercel.json'), path.join(root, 'vercel.json'));
  copyTree(path.join(REPO, 'api'), path.join(root, 'api'));
  copyTree(path.join(SITE, 'src'), path.join(root, 'site', 'src'));
  copyTree(path.join(SITE, 'functions'), path.join(root, 'site', 'functions'));
  copyTree(path.join(SITE, 'shared', 'portal-handlers'), path.join(root, 'site', 'shared', 'portal-handlers'));
  return root;
}

function runGate(root) {
  const r = spawnSync(process.execPath, [path.join(root, 'site', 'scripts', 'check-api-routes.mjs')], {
    cwd: root,
    encoding: 'utf8',
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

async function main() {
  fs.mkdirSync(ROOT, { recursive: true });
  console.log(`[wave14] repo:    ${REPO}`);
  console.log(`[wave14] sandbox: ${ROOT}`);

  const controlRoot = sandboxCopy('control');
  const controlBundle = await bundleFrom(controlRoot, 'control');
  const dataDir = makeDataDir('control');
  const child = await startChild(controlBundle, childEnv(dataDir));

  // =====================================================================
  group('A — the invariants, read from the tree');
  // =====================================================================

  await t('A1', 'the two family tables are DISJOINT', async () => {
    const portal = new Set(PORTAL_URLS);
    const admin = new Set(ADMIN_URLS);
    const shared = [...portal].filter((u) => admin.has(u));
    assertEqual(shared.length, 0, `both tables name ${shared.join(', ')}`);
    return `${portal.size} portal routes, ${admin.size} admin routes, no overlap`;
  });

  await t('A2', 'the standalone URLs are in NO family table', async () => {
    const familyUrls = new Set([...PORTAL_URLS, ...ADMIN_URLS]);
    for (const url of STANDALONE_URLS) {
      assert(!familyUrls.has(url), `${url} is in a family table`);
    }
    assert(
      STANDALONE_URLS.includes('/api/contact') &&
        STANDALONE_URLS.includes('/api/moderate/review') &&
        STANDALONE_URLS.includes('/api/portal/auth/verify') &&
        STANDALONE_URLS.includes('/api/portal/auth/request-link') &&
        STANDALONE_URLS.includes('/api/portal/auth/logout'),
      'the standalone set is not the one the brief names',
    );
    return `${STANDALONE_URLS.length} standalone URLs, none of them in a family table`;
  });

  await t('A3', 'the entry-prefix containment holds for the real prefixes', async () => {
    const cases = [
      ['/api/portal/projects', '/api/portal', true],
      ['/api/portal/projects/prj_1', '/api/portal', true],
      ['/api/admin/reviews', '/api/portal', false],
      ['/api/portalx/anything', '/api/portal', false],
      ['/api/portal', '/api/portal', false],
      ['/api/admin/session', '/api/admin', true],
      ['/api/portal/projects', '/api/admin', false],
      ['/api/contact', '/api/portal', false],
    ];
    for (const [pathname, prefix, expected] of cases) {
      const answer = await child.ask({ kind: 'inside', pathname, entryPrefix: prefix });
      assert(answer.ok, `isInsideEntry threw: ${answer.error}`);
      assertEqual(answer.result, expected, `isInsideEntry(${pathname}, ${prefix})`);
    }
    return `${cases.length} cases`;
  });

  await t('A4', 'the router comment claims NO unproven hardening', async () => {
    const file = path.join(SITE, 'shared', 'portal-router.ts');
    const text = fs.readFileSync(file, 'utf8');
    const header = text.slice(0, text.indexOf('export const ROUTE_CARRIER_PARAM'));
    // The wave-13 wording must be GONE.
    assert(
      !/a client cannot smuggle/.test(header),
      'the router comment still claims a client cannot smuggle a handler in',
    );
    assert(
      !/can never name a path outside the family/.test(header),
      'the router comment still claims the carrier can never leave the family',
    );
    // The honest statement must be THERE.
    assert(
      /NOT OBSERVED/.test(header),
      'the router comment does not say that the merge order is unobserved',
    );
    assert(
      /FAMILY CONTAINMENT/.test(header) && /DISJOINT/.test(header),
      'the router comment does not state the family containment invariant',
    );
    assert(
      /STANDALONE URLS ARE OUT OF REACH/.test(header),
      'the router comment does not state that the standalone URLs are out of reach',
    );
    assert(
      /THE HANDLER AUTHORIZES ITSELF/.test(header),
      'the router comment does not state that the handler authorizes itself',
    );
    return 'the false hardening is gone; the three invariants and the unobserved merge order are stated';
  });

  // =====================================================================
  group('B — the resolver (a pure function, executed offline)');
  // =====================================================================

  await t('B1', 'a carrier cannot name the OTHER family\'s route', async () => {
    const cases = [
      ['/api/portal', '/api/admin/reviews', ADMIN_TABLE],
      ['/api/admin', '/api/portal/projects', PORTAL_TABLE],
    ];
    for (const [entryPrefix, carried, table] of cases) {
      const answer = await child.ask({
        kind: 'route',
        rawUrl: `/${entryPrefix.replace(/^\//, '')}`,
        carrier: carried,
        entryPrefix,
        table,
      });
      assert(answer.ok, `the resolver threw: ${answer.error}`);
      assertEqual(answer.result.ok, false, `${carried} resolved at ${entryPrefix}`);
      assertEqual(answer.result.reason, 'not-found', 'the reason');
    }
    return 'both directions are refused';
  });

  await t('B2', 'a carrier cannot name a STANDALONE url', async () => {
    for (const url of STANDALONE_URLS) {
      for (const [entryPrefix, table] of [
        ['/api/portal', PORTAL_TABLE],
        ['/api/admin', ADMIN_TABLE],
      ]) {
        const answer = await child.ask({
          kind: 'route',
          rawUrl: entryPrefix,
          carrier: url,
          entryPrefix,
          table,
        });
        assert(answer.ok, `the resolver threw: ${answer.error}`);
        assertEqual(answer.result.ok, false, `${url} resolved at ${entryPrefix}`);
        assertEqual(answer.result.reason, 'not-found', 'the reason');
      }
    }
    return `${STANDALONE_URLS.length} standalone URLs x 2 entry points, all refused`;
  });

  await t('B3', 'CONTROL: a carrier INSIDE the family still resolves', async () => {
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

  await t('B4', 'CONTROL: the PATH wins over a forged carrier', async () => {
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
    assertEqual(answer.result.path, '/api/portal/projects', 'the path');
    return 'portal-projects';
  });

  // =====================================================================
  group('C — the entry points (executed)');
  // =====================================================================

  await t('C1', 'a forged carrier across the families answers 404, never a handler', async () => {
    const cases = [
      ['portal', carrier('/api/admin/reviews')],
      ['portal', carrier('/api/admin/session')],
      ['admin', adminCarrier('/api/portal/projects')],
      ['admin', adminCarrier('/api/portal/session')],
    ];
    for (const [entry, url] of cases) {
      const answer = await http(child, entry, url);
      assertEqual(answer.status, 404, `${entry} answered ${answer.status} for ${url}`);
      assertEqual(answer.json.code, 'not-found', 'the code');
    }
    return `${cases.length} cross-family forgeries, all 404 {code:not-found}`;
  });

  await t('C2', 'a forged carrier cannot reach the standalone urls', async () => {
    for (const url of STANDALONE_URLS) {
      for (const [entry, prefix] of [
        ['portal', '/api/portal'],
        ['admin', '/api/admin'],
      ]) {
        const target = `${prefix}?__imk_route=${encodeURIComponent(url)}`;
        const answer = await http(child, entry, target);
        assertEqual(answer.status, 404, `${entry} answered ${answer.status} for ${target}`);
        assertEqual(answer.json.code, 'not-found', 'the code');
      }
    }
    return `${STANDALONE_URLS.length} standalone URLs x 2 entry points, all 404 {code:not-found}`;
  });

  await t('C3', 'a portal-family forgery still needs a session', async () => {
    const answer = await http(child, 'portal', carrier('/api/portal/projects'));
    assertEqual(answer.status, 401, 'the status');
    assertEqual(answer.json.code, 'unauthorized', 'the code');
    return '401 {code:unauthorized} — no session, no data';
  });

  await t('C4', 'a portal-family forgery with a valid CLIENT session reads only that client', async () => {
    const cookie = await clientCookie(child, CLIENT_ONE);
    const answer = await http(child, 'portal', carrier('/api/portal/projects'), { cookie });
    assertEqual(answer.status, 200, `the status (${answer.body.slice(0, 200)})`);
    const ids = (answer.json.projects || []).map((p) => p.id);
    assert(ids.includes('prj_mine'), `the client's own project is missing: ${ids.join(', ')}`);
    assert(!ids.includes('prj_other'), `another client's project leaked: ${ids.join(', ')}`);
    assert(!/OTHER CLIENT SECRET/.test(answer.body), 'another client\'s data is in the body');
    return `200, the client sees ${ids.length} project(s) of its own`;
  });

  await t('C5', 'a forged carrier CANNOT widen a client\'s scope', async () => {
    const cookie = await clientCookie(child, CLIENT_ONE);
    // The carrier names the OTHER client's project.
    const answer = await http(
      child,
      'portal',
      carrier('/api/portal/projects/prj_other'),
      { cookie },
    );
    assert(answer.status !== 200, `the other client's project was served (${answer.status})`);
    assertEqual(answer.status, 403, 'the status');
    assertEqual(answer.json.code, 'forbidden', 'the code');
    assert(!/OTHER CLIENT SECRET/.test(answer.body), 'another client\'s data is in the body');
    return '403 {code:forbidden} — the handler\'s own scope rule held';
  });

  await t('C6', 'an admin-family forgery still needs the OWNER session', async () => {
    const none = await http(child, 'admin', adminCarrier('/api/admin/reviews'));
    assertEqual(none.status, 401, 'no cookie: the status');
    assertEqual(none.json.code, 'unauthorized', 'no cookie: the code');
    // A CLIENT session is not an owner session.
    const clientCookieHeader = await clientCookie(child, CLIENT_ONE);
    const asClient = await http(child, 'admin', adminCarrier('/api/admin/reviews'), {
      cookie: clientCookieHeader,
    });
    assertEqual(asClient.status, 401, 'a client session: the status');
    assertEqual(asClient.json.code, 'unauthorized', 'a client session: the code');
    return '401 {code:unauthorized} for no cookie AND for a client cookie';
  });

  await t('C7', 'an admin-family forgery WITH the owner session reaches the inbox', async () => {
    const cookie = await ownerCookie(child);
    const answer = await http(child, 'admin', adminCarrier('/api/admin/reviews'), { cookie });
    assertEqual(answer.status, 200, `the status (${answer.body.slice(0, 200)})`);
    assert(answer.json.ok === true, 'the inbox did not answer ok:true');
    return '200 — the owner queue is served';
  });

  await t('C8', 'the carrier parameter is STRIPPED from the url the handler sees', async () => {
    const spyRoot = sandboxCopy('spy');
    const spyFile = path.join(spyRoot, 'site', 'shared', 'portal-handlers', 'portal-testimonials.ts');
    fs.writeFileSync(
      spyFile,
      [
        'export default async function spy(req, res) {',
        "  res.writeHead(200, { 'Content-Type': 'application/json' });",
        '  res.end(JSON.stringify({ url: req.url }));',
        '}',
      ].join('\n'),
      'utf8',
    );
    const spyBundle = await bundleFrom(spyRoot, 'spy');
    const spyChild = await startChild(spyBundle, childEnv(dataDir));
    try {
      const answer = await http(
        spyChild,
        'portal',
        '/api/portal?__imk_route=%2Fapi%2Fportal%2Ftestimonials&projectId=prj_1',
      );
      assertEqual(answer.status, 200, 'the status');
      const seen = answer.json.url;
      assert(!seen.includes('__imk_route'), `the carrier reached the handler: ${seen}`);
      assertEqual(seen, '/api/portal/testimonials?projectId=prj_1', 'the url the handler saw');
      return `the handler saw ${seen}`;
    } finally {
      spyChild.close();
    }
  });

  // =====================================================================
  group('D — the mutation probes (each must redden in a COPY)');
  // =====================================================================

  /**
   * Give the PORTAL entry point the ability to serve an ADMIN route: the
   * table gains the cross-family route and the HANDLERS map gains the
   * handler. This is the broken state the containment has to survive.
   */
  function breakTheTable(root) {
    const tableFile = path.join(root, 'site', 'shared', 'portal-routes.json');
    const table = JSON.parse(fs.readFileSync(tableFile, 'utf8'));
    table.families['/api/portal'].routes['/api/admin/reviews'] = 'admin-reviews';
    fs.writeFileSync(tableFile, JSON.stringify(table, null, 2), 'utf8');

    const entryFile = path.join(root, 'api', 'portal.ts');
    patchFile(
      entryFile,
      "import portalComments from '../site/shared/portal-handlers/portal-comments.js';",
      "import portalComments from '../site/shared/portal-handlers/portal-comments.js';\nimport adminReviews from '../site/shared/portal-handlers/admin-reviews.js';",
    );
    patchFile(
      entryFile,
      "const HANDLERS: Record<string, Handler> = {\n  'portal-comments': portalComments,",
      "const HANDLERS: Record<string, Handler> = {\n  'admin-reviews': adminReviews,\n  'portal-comments': portalComments,",
    );
  }

  await t('D1', 'the CODE-level containment survives a BROKEN table', async () => {
    const mutantRoot = sandboxCopy('mut-broken-table');
    breakTheTable(mutantRoot);
    const bundle = await bundleFrom(mutantRoot, 'mut-broken-table');
    const mutantChild = await startChild(bundle, childEnv(dataDir));
    try {
      const answer = await http(mutantChild, 'portal', carrier('/api/admin/reviews'));
      assertEqual(
        answer.status,
        404,
        `the broken table broke the containment (${answer.status} ${answer.body.slice(0, 120)})`,
      );
      assertEqual(answer.json.code, 'not-found', 'the code');
      return '404 {code:not-found} — the explicit entry-prefix check refused it';
    } finally {
      mutantChild.close();
    }
  });

  await t('D2', 'removing the entry-prefix check lets the broken table ESCAPE', async () => {
    const mutantRoot = sandboxCopy('mut-no-containment');
    breakTheTable(mutantRoot);
    const routerFile = path.join(mutantRoot, 'site', 'shared', 'portal-router.ts');
    patchFile(
      routerFile,
      '    if (!isInsideEntry(carrier, entryPrefix)) {',
      '    if (false) {',
    );
    const bundle = await bundleFrom(mutantRoot, 'mut-no-containment');
    const mutantChild = await startChild(bundle, childEnv(dataDir));
    try {
      const answer = await http(mutantChild, 'portal', carrier('/api/admin/reviews'));
      // The control answers 404. The mutant must NOT.
      assert(
        answer.status !== 404,
        `the mutant still answered 404 — the containment check is vacuous (body: ${answer.body.slice(0, 120)})`,
      );
      const control = await http(child, 'portal', carrier('/api/admin/reviews'));
      assertEqual(control.status, 404, 'the control must refuse the forged carrier');
      return `the mutant answers ${answer.status} (the admin handler ran), the control answers 404`;
    } finally {
      mutantChild.close();
    }
  });

  await t('D3', 'stopping the carrier-strip makes the handler SEE the carrier', async () => {
    const mutantRoot = sandboxCopy('mut-no-strip');
    const routerFile = path.join(mutantRoot, 'site', 'shared', 'portal-router.ts');
    patchFile(
      routerFile,
      '  url.searchParams.delete(ROUTE_CARRIER_PARAM);',
      '  // WAVE-14 MUTATION: the carrier is NOT deleted from the query',
    );
    const spyFile = path.join(mutantRoot, 'site', 'shared', 'portal-handlers', 'portal-testimonials.ts');
    fs.writeFileSync(
      spyFile,
      [
        'export default async function spy(req, res) {',
        "  res.writeHead(200, { 'Content-Type': 'application/json' });",
        '  res.end(JSON.stringify({ url: req.url }));',
        '}',
      ].join('\n'),
      'utf8',
    );
    const bundle = await bundleFrom(mutantRoot, 'mut-no-strip');
    const mutantChild = await startChild(bundle, childEnv(dataDir));
    try {
      const answer = await http(
        mutantChild,
        'portal',
        '/api/portal?__imk_route=%2Fapi%2Fportal%2Ftestimonials&projectId=prj_1',
      );
      assertEqual(answer.status, 200, 'the status');
      const seen = answer.json.url;
      assert(
        seen.includes('__imk_route'),
        `the mutant did not keep the carrier (${seen}) — the probe is vacuous`,
      );
      return `the mutant built ${seen}`;
    } finally {
      mutantChild.close();
    }
  });

  await t('D4', 'removing the handler\'s own scope rule makes the forgery LEAK', async () => {
    const mutantRoot = sandboxCopy('mut-no-scope');
    const handlerFile = path.join(
      mutantRoot,
      'site',
      'shared',
      'portal-handlers',
      'portal-projects.ts',
    );
    patchFile(
      handlerFile,
      '    if (!canReadClient(access, project.clientId)) {',
      '    if (false) {',
    );
    const bundle = await bundleFrom(mutantRoot, 'mut-no-scope');
    const mutantChild = await startChild(bundle, childEnv(dataDir));
    try {
      const cookie = await clientCookie(mutantChild, CLIENT_ONE);
      const answer = await http(
        mutantChild,
        'portal',
        carrier('/api/portal/projects/prj_other'),
        { cookie },
      );
      assert(
        answer.status === 200 && /OTHER CLIENT SECRET/.test(answer.body),
        `the mutant did not leak (${answer.status}) — the probe is vacuous`,
      );
      return `the mutant answered ${answer.status} and leaked the other client's project`;
    } finally {
      mutantChild.close();
    }
  });

  await t('D5', 'removing the deploy gate\'s HANDLERS check lets an UNSERVABLE route pass', async () => {
    const mutantRoot = gateTree('mut-gate');
    const gateFile = path.join(mutantRoot, 'site', 'scripts', 'check-api-routes.mjs');
    patchFile(
      gateFile,
      'const handlerProblems = [];',
      'const handlerProblems = [];\nif (false) { /* WAVE-14 MUTATION: the HANDLERS check is off */ }',
    );
    // Make the check unreachable instead of empty.
    patchFile(
      gateFile,
      "if (handlerProblems.length > 0) {",
      "if (handlerProblems.length > 0 && false) {",
    );

    // The broken tree: a table route the entry point cannot serve.
    const tableFile = path.join(mutantRoot, 'site', 'shared', 'portal-routes.json');
    const table = JSON.parse(fs.readFileSync(tableFile, 'utf8'));
    table.families['/api/portal'].routes['/api/portal/ghost'] = 'portal-ghost';
    table.handlers['portal-ghost'] = 'site/shared/portal-handlers/portal-ghost.ts';
    fs.writeFileSync(tableFile, JSON.stringify(table, null, 2), 'utf8');
    fs.writeFileSync(
      path.join(mutantRoot, 'site', 'shared', 'portal-handlers', 'portal-ghost.ts'),
      'export default function () {}\n',
      'utf8',
    );
    const vercelFile = path.join(mutantRoot, 'vercel.json');
    const vercel = JSON.parse(fs.readFileSync(vercelFile, 'utf8'));
    vercel.rewrites.push({
      source: '/api/portal/ghost',
      destination: '/api/portal?__imk_route=/api/portal/ghost',
    });
    fs.writeFileSync(vercelFile, JSON.stringify(vercel, null, 2), 'utf8');

    const mutant = runGate(mutantRoot);
    assertEqual(mutant.code, 0, `the mutant gate still failed: ${mutant.out.slice(-400)}`);
    return 'the mutant gate exits 0 on an unservable route — the probe bites';
  });

  child.close();

  // =====================================================================
  group('E — the deploy gate (executed in a throwaway tree)');
  // =====================================================================

  await t('E1', 'the gate passes on the real tree', async () => {
    const r = spawnSync(process.execPath, [path.join(SITE, 'scripts', 'check-api-routes.mjs')], {
      cwd: SITE,
      encoding: 'utf8',
    });
    const out = (r.stdout || '') + (r.stderr || '');
    assertEqual(r.status, 0, `the gate failed: ${out.slice(-400)}`);
    assert(/16 route\(s\), 0 missing/.test(out), `the route count changed: ${out.slice(-400)}`);
    assert(!/TypeError/.test(out), 'the gate crashed');
    return '16 routes, 0 missing';
  });

  await t('E2', 'a missing entry point is NAMED, not crashed on', async () => {
    const root = gateTree('gate-missing-entry');
    fs.rmSync(path.join(root, 'api', 'portal.ts'));
    const r = runGate(root);
    assertEqual(r.code, 1, 'the gate did not fail');
    assert(!/TypeError/.test(r.out), `the gate crashed instead of naming the miss:\n${r.out.slice(-500)}`);
    assert(
      /the entry point api\/portal\.ts is missing/.test(r.out),
      `the gate did not name the missing entry point:\n${r.out.slice(-500)}`,
    );
    return 'exit 1, "the entry point api/portal.ts is missing", no stack trace';
  });

  await t('E3', 'a table route the entry point cannot serve is NAMED', async () => {
    const root = gateTree('gate-unservable');
    const tableFile = path.join(root, 'site', 'shared', 'portal-routes.json');
    const table = JSON.parse(fs.readFileSync(tableFile, 'utf8'));
    table.families['/api/portal'].routes['/api/portal/ghost'] = 'portal-ghost';
    table.handlers['portal-ghost'] = 'site/shared/portal-handlers/portal-ghost.ts';
    fs.writeFileSync(tableFile, JSON.stringify(table, null, 2), 'utf8');
    fs.writeFileSync(
      path.join(root, 'site', 'shared', 'portal-handlers', 'portal-ghost.ts'),
      'export default function () {}\n',
      'utf8',
    );
    const vercelFile = path.join(root, 'vercel.json');
    const vercel = JSON.parse(fs.readFileSync(vercelFile, 'utf8'));
    vercel.rewrites.push({
      source: '/api/portal/ghost',
      destination: '/api/portal?__imk_route=/api/portal/ghost',
    });
    fs.writeFileSync(vercelFile, JSON.stringify(vercel, null, 2), 'utf8');

    const r = runGate(root);
    assertEqual(r.code, 1, 'the gate did not fail on an unservable route');
    assert(
      /\/api\/portal\/ghost: api\/portal\.ts cannot serve it/.test(r.out),
      `the gate did not name the route:\n${r.out.slice(-600)}`,
    );
    return 'exit 1, "/api/portal/ghost: api/portal.ts cannot serve it"';
  });

  // --- the summary ----------------------------------------------------------
  console.log('');
  if (failed === 0) {
    console.log(`[wave14] ${passed} passed, 0 failed, ${passed} checks`);
  } else {
    console.log(`[wave14] ${passed} passed, ${failed} failed, ${passed + failed} checks`);
    console.log(`[wave14] failing checks: ${failures.join(', ')}`);
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
  console.error('[wave14] the harness itself failed:', err);
  process.exit(2);
});
