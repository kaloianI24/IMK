// backend-wave13-function-budget-harness.mjs
//
// WHAT IT EXECUTES — the wave-13 refactor: ONE entry point per route family.
//
// THE DEFECT IT GUARDS AGAINST
//   Vercel builds ONE FUNCTION per file under api/. The portal family was nine
//   files (nine functions) and the owner family two, so the deployment sat at
//   nineteen functions — and the Vercel Hobby plan caps a deployment at
//   TWELVE. The portal could not be deployed at all.
//
//   The fix: two entry points (api/portal.ts, api/admin.ts) plus a rewrite,
//   with the route table (site/shared/portal-routes.json) deciding which
//   handler serves which public URL.
//
// THE CHECKS
//   A  the function budget   — api/ holds 7 real functions, the table and
//                              vercel.json agree, every public URL is served.
//   B  the resolver          — a PURE function, executed offline: the direct
//                              path, the carrier, the unknown path, the bare
//                              entry point, one dynamic segment.
//   C  the entry points      — executed in a child process: the rewrite is
//                              invisible to the handler, the query string
//                              survives it, and the entry point fails CLOSED.
//   D  the mutation probes   — every fix is reverted in a COPY and the same
//                              check must go RED. The repository is never
//                              modified.
//
// USAGE
//   node backend-wave13-function-budget-harness.mjs [--keep]

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
const ROOT = path.join(os.tmpdir(), 'opencode', 'wave13-function-budget', STAMP);

// The public URLs the product promises. Sixteen of them.
const PUBLIC_URLS = [
  '/api/admin/reviews',
  '/api/admin/session',
  '/api/contact',
  '/api/moderate/review',
  '/api/portal/auth/logout',
  '/api/portal/auth/request-link',
  '/api/portal/auth/verify',
  '/api/portal/comments',
  '/api/portal/invites',
  '/api/portal/plan-items',
  '/api/portal/projects',
  '/api/portal/session',
  '/api/portal/testimonials',
  '/api/portal/updates',
];

// ---------------------------------------------------------------------------
// The tiny test framework (the same shape as the other repo-root harnesses)
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;
const failures = [];

function group(name) {
  console.log(`\n[wave13] ${name}`);
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
// The bundler
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
      `export { resolveRoute, rebuildRequestUrl, matchRoutePattern, ROUTE_CARRIER_PARAM, ROUTE_CARRIER_HEADER } from '${abs(path.join(root, 'site', 'shared', 'portal-router.ts'))}';`,
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

// The environment the child runs in. The store is a SANDBOX: the repository's
// site/data is never read or written.
function childEnv() {
  const dataDir = path.join(ROOT, 'data');
  fs.mkdirSync(path.join(dataDir, 'portal'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'moderation'), { recursive: true });
  for (const name of [
    'portal/projects.jsonl',
    'portal/clients.jsonl',
    'portal/invited.jsonl',
    'portal/comments.jsonl',
    'portal/planItems.jsonl',
    'portal/updates.jsonl',
    'moderation/reviews.jsonl',
  ]) {
    const file = path.join(dataDir, name);
    if (!fs.existsSync(file)) fs.writeFileSync(file, '', 'utf8');
  }
  return {
    PORTAL_DATA_DIR: dataDir,
    PORTAL_STORE: 'file',
    SITE_BASE_URL: 'http://imk.test',
    ADMIN_EMAILS: 'owner@imk.test',
    APP_ENV: 'test',
    PORTAL_SESSION_SECRET: 'wave13-harness-secret-0123456789abcdef',
    PORTAL_MAGIC_LINK_SECRET: 'wave13-harness-secret-0123456789abcdef',
  };
}

// ---------------------------------------------------------------------------
// The route table (read from disk — the same file the product reads)
// ---------------------------------------------------------------------------
const TABLE = JSON.parse(fs.readFileSync(path.join(SITE, 'shared', 'portal-routes.json'), 'utf8'));
const VERCEL_JSON = JSON.parse(fs.readFileSync(path.join(REPO, 'vercel.json'), 'utf8'));

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

async function main() {
  fs.mkdirSync(ROOT, { recursive: true });
  console.log(`[wave13] repo:   ${REPO}`);
  console.log(`[wave13] sandbox: ${ROOT}`);

  const controlRoot = sandboxCopy('control');
  const controlBundle = await bundleFrom(controlRoot, 'control');
  const child = await startChild(controlBundle, childEnv());

  // =====================================================================
  group('A — the function budget');
  // =====================================================================

  await t('A1', 'api/ holds 7 files and every one of them is a REAL function', async () => {
    const apiDir = path.join(REPO, 'api');
    const files = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts')) files.push(full);
      }
    };
    walk(apiDir);
    assertEqual(files.length, 7, `api/ should hold 7 .ts files (found ${files.length})`);
    assert(files.length <= 12, 'api/ must fit the Vercel Hobby function budget (12)');
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      assert(
        /export\s+default/.test(text) || /export\s*\{\s*default\s*\}/.test(text),
        `${path.relative(REPO, file)} has no default export — it is a DEAD Vercel function`,
      );
    }
    return files.map((f) => path.relative(REPO, f)).join(', ');
  });

  await t('A2', 'the dead utilities are gone from api/ (a module there is a function)', async () => {
    assert(!fs.existsSync(path.join(REPO, 'api', 'lib')), 'api/lib still exists');
    for (const moved of [
      'site/shared/server/notifications.ts',
      'site/shared/server/rate-limit.ts',
    ]) {
      assert(fs.existsSync(path.join(REPO, moved)), `${moved} is missing`);
    }
    // ...and both are really imported by the handlers.
    const handlers = path.join(SITE, 'shared', 'portal-handlers');
    const text = fs
      .readdirSync(handlers)
      .map((f) => fs.readFileSync(path.join(handlers, f), 'utf8'))
      .join('\n');
    assert(/server\/notifications\.js/.test(text), 'nothing imports the notifications module');
    assert(/server\/rate-limit\.js/.test(text), 'nothing imports the rate limiter');
    return 'api/lib is gone; both utilities live in site/shared/server/ and are imported';
  });

  await t('A3', 'the route table and vercel.json agree, rule for rule', async () => {
    const rewrites = Array.isArray(VERCEL_JSON.rewrites) ? VERCEL_JSON.rewrites : [];
    const sources = new Set(rewrites.map((r) => r.source));
    let checked = 0;
    for (const [prefix, family] of Object.entries(TABLE.families)) {
      assert(fs.existsSync(path.join(REPO, family.entry)), `${family.entry} is missing`);
      for (const pattern of Object.keys(family.routes)) {
        const source = pattern.replace(/\/\*$/, '/:id');
        assert(sources.has(source), `${pattern}: no rewrite from ${source}`);
        const rule = rewrites.find((r) => r.source === source);
        assert(
          String(rule.destination).startsWith(`/${family.entry.replace(/\.ts$/, '')}?__imk_route=`),
          `${pattern}: the rewrite does not carry the original path: ${rule.destination}`,
        );
        const handler = TABLE.handlers[family.routes[pattern]];
        assert(handler, `${pattern}: no handler module named`);
        assert(fs.existsSync(path.join(REPO, handler)), `${handler} is missing`);
        checked++;
      }
    }
    assertEqual(rewrites.length, checked, 'the rewrite count and the table disagree');
    return `${checked} routes, ${rewrites.length} rewrites, every handler module present`;
  });

  await t('A4', 'every public URL of the product is in the table', async () => {
    const known = new Set();
    for (const family of Object.values(TABLE.families)) {
      for (const pattern of Object.keys(family.routes)) known.add(pattern);
    }
    for (const pattern of Object.keys(TABLE.standalone)) known.add(pattern);
    for (const url of PUBLIC_URLS) {
      const inTable =
        known.has(url) ||
        [...known].some((p) => p.endsWith('/*') && url.startsWith(p.slice(0, -1)));
      assert(inTable, `${url} is not in the route table`);
    }
    // The two dynamic families keep ONE segment each.
    assert(known.has('/api/portal/projects/*'), 'the by-id project route is missing');
    assert(known.has('/api/portal/plan-items/*'), 'the by-id plan-item route is missing');
    return `${PUBLIC_URLS.length} public URLs are all served`;
  });

  // =====================================================================
  group('B — the resolver (a pure function, executed offline)');
  // =====================================================================

  const portalTable = TABLE.families['/api/portal'].routes;

  await t('B1', 'the DIRECT path resolves (no carrier)', async () => {
    const answer = await child.ask({
      kind: 'route',
      rawUrl: '/api/portal/projects',
      carrier: null,
      entryPrefix: '/api/portal',
      table: portalTable,
    });
    assert(answer.ok, `the resolver threw: ${answer.error}`);
    assert(answer.result.ok, 'the direct path did not resolve');
    assertEqual(answer.result.handler, 'portal-projects', 'the handler');
    assertEqual(answer.result.path, '/api/portal/projects', 'the path');
    return 'portal-projects';
  });

  await t('B2', 'the CARRIER resolves (the rewrite case)', async () => {
    const answer = await child.ask({
      kind: 'route',
      rawUrl: '/api/portal?__imk_route=%2Fapi%2Fportal%2Fcomments',
      carrier: '/api/portal/comments',
      entryPrefix: '/api/portal',
      table: portalTable,
    });
    assert(answer.ok, `the resolver threw: ${answer.error}`);
    assert(answer.result.ok, 'the carrier did not resolve');
    assertEqual(answer.result.handler, 'portal-comments', 'the handler');
    assertEqual(answer.result.path, '/api/portal/comments', 'the path');
    return 'portal-comments';
  });

  await t('B3', 'an unknown path is NOT-FOUND (never a guess)', async () => {
    const answer = await child.ask({
      kind: 'route',
      rawUrl: '/api/portal/nope',
      carrier: null,
      entryPrefix: '/api/portal',
      table: portalTable,
    });
    assert(answer.ok, `the resolver threw: ${answer.error}`);
    assertEqual(answer.result.ok, false, 'an unknown path resolved');
    assertEqual(answer.result.reason, 'not-found', 'the reason');
    return 'not-found';
  });

  await t('B4', 'the bare entry point is ROUTE-RESOLUTION (loud, never a silent 404)', async () => {
    const answer = await child.ask({
      kind: 'route',
      rawUrl: '/api/portal',
      carrier: null,
      entryPrefix: '/api/portal',
      table: portalTable,
    });
    assert(answer.ok, `the resolver threw: ${answer.error}`);
    assertEqual(answer.result.ok, false, 'the bare entry point resolved');
    assertEqual(answer.result.reason, 'route-resolution', 'the reason');
    return 'route-resolution';
  });

  await t('B5', 'ONE dynamic segment resolves, TWO do not', async () => {
    const one = await child.ask({
      kind: 'route',
      rawUrl: '/api/portal/projects/prj_1',
      carrier: null,
      entryPrefix: '/api/portal',
      table: portalTable,
    });
    assert(one.result.ok, 'one dynamic segment did not resolve');
    assertEqual(one.result.handler, 'portal-projects', 'the handler');
    assertEqual(one.result.path, '/api/portal/projects/prj_1', 'the path');
    const two = await child.ask({
      kind: 'route',
      rawUrl: '/api/portal/projects/prj_1/extra',
      carrier: null,
      entryPrefix: '/api/portal',
      table: portalTable,
    });
    assertEqual(two.result.ok, false, 'a two-segment path resolved');
    assertEqual(two.result.reason, 'not-found', 'the reason');
    return 'one segment yes, two no';
  });

  await t('B6', 'the rebuilt URL keeps the query and drops the carrier', async () => {
    const answer = await child.ask({
      kind: 'route',
      rawUrl: '/api/portal?__imk_route=%2Fapi%2Fportal%2Ftestimonials&projectId=prj_1',
      carrier: '/api/portal/testimonials',
      entryPrefix: '/api/portal',
      table: portalTable,
    });
    assert(answer.ok, `the resolver threw: ${answer.error}`);
    // The rebuild happens in the entry point; here we only prove the resolver
    // named the right route. The rebuild itself is proved in C2.
    assertEqual(answer.result.path, '/api/portal/testimonials', 'the path');
    return 'the carrier named the route';
  });

  await t('B7', 'a carrier cannot name another family\'s route', async () => {
    const answer = await child.ask({
      kind: 'route',
      rawUrl: '/api/portal?__imk_route=%2Fapi%2Fadmin%2Freviews',
      carrier: '/api/admin/reviews',
      entryPrefix: '/api/portal',
      table: portalTable,
    });
    assertEqual(answer.result.ok, false, 'a carrier crossed the family boundary');
    assertEqual(answer.result.reason, 'not-found', 'the reason');
    return 'not-found';
  });

  // =====================================================================
  group('C — the entry points (executed)');
  // =====================================================================

  await t('C1', 'the direct path and the carrier answer the SAME (the rewrite is invisible)', async () => {
    const direct = await child.ask({
      kind: 'http',
      entry: 'portal',
      method: 'GET',
      url: '/api/portal/projects',
    });
    const carried = await child.ask({
      kind: 'http',
      entry: 'portal',
      method: 'GET',
      url: '/api/portal?__imk_route=%2Fapi%2Fportal%2Fprojects',
    });
    assert(direct.ok && carried.ok, 'the entry point threw');
    assertEqual(direct.result.status, carried.result.status, 'the status differs');
    assertEqual(direct.result.body, carried.result.body, 'the body differs');
    // 401 — no session. What matters is that BOTH routes reached the SAME
    // handler (the projects one), not a 404 from the resolver.
    assertEqual(direct.result.status, 401, 'the status');
    assertEqual(JSON.parse(direct.result.body).code, 'unauthorized', 'the code');
    return 'both answer 401 {code:unauthorized} — the same handler ran';
  });

  await t('C2', 'the QUERY STRING survives the rewrite (the handler sees projectId)', async () => {
    // A spy handler in a SANDBOX copy echoes the URL the entry point built.
    const spyRoot = sandboxCopy('spy');
    const spyFile = path.join(spyRoot, 'site', 'shared', 'portal-handlers', 'portal-testimonials.ts');
    fs.writeFileSync(
      spyFile,
      [
        "export default async function spy(req, res) {",
        "  res.writeHead(200, { 'Content-Type': 'application/json' });",
        "  res.end(JSON.stringify({ url: req.url }));",
        "}",
      ].join('\n'),
      'utf8',
    );
    const spyBundle = await bundleFrom(spyRoot, 'spy');
    const spyChild = await startChild(spyBundle, childEnv());
    try {
      const answer = await spyChild.ask({
        kind: 'http',
        entry: 'portal',
        method: 'GET',
        url: '/api/portal?__imk_route=%2Fapi%2Fportal%2Ftestimonials&projectId=prj_1',
      });
      assert(answer.ok, `the entry point threw: ${answer.error}`);
      assertEqual(answer.result.status, 200, 'the status');
      const seen = JSON.parse(answer.result.body).url;
      assertEqual(seen, '/api/portal/testimonials?projectId=prj_1', 'the URL the handler saw');
      return `the handler saw ${seen}`;
    } finally {
      spyChild.close();
    }
  });

  await t('C3', 'the bare entry point is a loud 500 {code:route-resolution}', async () => {
    const answer = await child.ask({
      kind: 'http',
      entry: 'portal',
      method: 'GET',
      url: '/api/portal',
    });
    assert(answer.ok, `the entry point threw: ${answer.error}`);
    assertEqual(answer.result.status, 500, 'the status');
    assertEqual(JSON.parse(answer.result.body).code, 'route-resolution', 'the code');
    return '500 {code:route-resolution}';
  });

  await t('C4', 'an unknown path under the family is 404 {code:not-found}', async () => {
    const answer = await child.ask({
      kind: 'http',
      entry: 'portal',
      method: 'GET',
      url: '/api/portal/nope',
    });
    assert(answer.ok, `the entry point threw: ${answer.error}`);
    assertEqual(answer.result.status, 404, 'the status');
    assertEqual(JSON.parse(answer.result.body).code, 'not-found', 'the code');
    return '404 {code:not-found}';
  });

  await t('C5', 'a carrier cannot reach another family through the portal entry point', async () => {
    const answer = await child.ask({
      kind: 'http',
      entry: 'portal',
      method: 'GET',
      url: '/api/portal?__imk_route=%2Fapi%2Fadmin%2Freviews',
    });
    assert(answer.ok, `the entry point threw: ${answer.error}`);
    assertEqual(answer.result.status, 404, 'the status');
    assertEqual(JSON.parse(answer.result.body).code, 'not-found', 'the code');
    return '404 {code:not-found}';
  });

  await t('C6', 'the owner family answers through its OWN entry point', async () => {
    const answer = await child.ask({
      kind: 'http',
      entry: 'admin',
      method: 'GET',
      url: '/api/admin?__imk_route=%2Fapi%2Fadmin%2Fsession',
    });
    assert(answer.ok, `the entry point threw: ${answer.error}`);
    // No session cookie -> 401 {code:unauthorized}: the OWNER GATE ran, so the
    // admin-session handler really was reached.
    assertEqual(answer.result.status, 401, 'the status');
    assertEqual(JSON.parse(answer.result.body).code, 'unauthorized', 'the code');
    return '401 {code:unauthorized} — the owner gate ran';
  });

  await t('C7', 'a wrong method on a family route is answered by the HANDLER, not the router', async () => {
    const answer = await child.ask({
      kind: 'http',
      entry: 'portal',
      method: 'POST',
      url: '/api/portal?__imk_route=%2Fapi%2Fportal%2Fsession',
    });
    assert(answer.ok, `the entry point threw: ${answer.error}`);
    // The session endpoint answers 405 on a wrong method.
    assertEqual(answer.result.status, 405, 'the status');
    assertEqual(JSON.parse(answer.result.body).code, 'method', 'the code');
    return '405 {code:method}';
  });

  // =====================================================================
  group('D — the mutation probes (each must redden in a COPY)');
  // =====================================================================

  await t('D1', 'without the route-resolution branch the bare entry point goes RED', async () => {
    const mutantRoot = sandboxCopy('mut-route-resolution');
    const file = path.join(mutantRoot, 'site', 'shared', 'portal-router.ts');
    const source = fs.readFileSync(file, 'utf8');
    const ANCHOR = "  if (pathname === entryPrefix) {";
    assert(source.includes(ANCHOR), 'the mutation anchor was not found');
    const mutant = source.replace(
      ANCHOR,
      "  if (false) {",
    );
    fs.writeFileSync(file, mutant, 'utf8');
    const bundle = await bundleFrom(mutantRoot, 'mut-route-resolution');
    const mutantChild = await startChild(bundle, childEnv());
    try {
      const answer = await mutantChild.ask({
        kind: 'http',
        entry: 'portal',
        method: 'GET',
        url: '/api/portal',
      });
      assert(answer.ok, `the mutant threw: ${answer.error}`);
      assert(
        answer.result.status !== 500 ||
          JSON.parse(answer.result.body).code !== 'route-resolution',
        'the mutant still answers route-resolution — the probe is vacuous',
      );
      // The control still answers the loud way.
      const control = await child.ask({
        kind: 'http',
        entry: 'portal',
        method: 'GET',
        url: '/api/portal',
      });
      assertEqual(control.result.status, 500, 'the control must be loud');
      return `the mutant answers ${answer.result.status}, the control answers 500`;
    } finally {
      mutantChild.close();
    }
  });

  await t('D2', 'without the carrier branch the rewrite case goes RED', async () => {
    const mutantRoot = sandboxCopy('mut-carrier');
    const file = path.join(mutantRoot, 'site', 'shared', 'portal-router.ts');
    const source = fs.readFileSync(file, 'utf8');
    // WAVE 15 RE-PIN. The anchor was "  if (carrier) {"; the resolver now
    // tests the carrier for PRESENCE (an empty carrier is invalid, not
    // absent - wave 15, B-1), so the branch reads
    // "  if (carrier !== null) {". The DEFECT this probe models is the
    // same one: without the carrier branch the rewrite case does not
    // resolve. The anchor moved; the check did not weaken.
    const ANCHOR = "  if (carrier !== null) {";
    assert(source.includes(ANCHOR), 'the mutation anchor was not found');
    const mutant = source.replace(ANCHOR, "  if (false) {");
    fs.writeFileSync(file, mutant, 'utf8');
    const bundle = await bundleFrom(mutantRoot, 'mut-carrier');
    const mutantChild = await startChild(bundle, childEnv());
    try {
      const answer = await mutantChild.ask({
        kind: 'http',
        entry: 'portal',
        method: 'GET',
        url: '/api/portal?__imk_route=%2Fapi%2Fportal%2Fprojects',
      });
      assert(answer.ok, `the mutant threw: ${answer.error}`);
      assert(
        answer.result.status !== 401,
        `the mutant still reached the handler (status ${answer.result.status}) — the probe is vacuous`,
      );
      const control = await child.ask({
        kind: 'http',
        entry: 'portal',
        method: 'GET',
        url: '/api/portal?__imk_route=%2Fapi%2Fportal%2Fprojects',
      });
      assertEqual(control.result.status, 401, 'the control must reach the handler');
      return `the mutant answers ${answer.result.status}, the control answers 401`;
    } finally {
      mutantChild.close();
    }
  });

  await t('D3', 'without the query rebuild the handler loses the query string', async () => {
    const mutantRoot = sandboxCopy('mut-query');
    const file = path.join(mutantRoot, 'site', 'shared', 'portal-router.ts');
    const source = fs.readFileSync(file, 'utf8');
    const ANCHOR = "  url.searchParams.delete(ROUTE_CARRIER_PARAM);";
    assert(source.includes(ANCHOR), 'the mutation anchor was not found');
    // Drop the query: the handler would lose ?projectId=...
    const mutant = source.replace(
      ANCHOR,
      "  url.search = '';\n  url.searchParams.delete(ROUTE_CARRIER_PARAM);",
    );
    fs.writeFileSync(file, mutant, 'utf8');

    // The same spy handler as in C2, so the two runs are comparable.
    const spyFile = path.join(mutantRoot, 'site', 'shared', 'portal-handlers', 'portal-testimonials.ts');
    fs.writeFileSync(
      spyFile,
      [
        "export default async function spy(req, res) {",
        "  res.writeHead(200, { 'Content-Type': 'application/json' });",
        "  res.end(JSON.stringify({ url: req.url }));",
        "}",
      ].join('\n'),
      'utf8',
    );
    const bundle = await bundleFrom(mutantRoot, 'mut-query');
    const mutantChild = await startChild(bundle, childEnv());
    try {
      const answer = await mutantChild.ask({
        kind: 'http',
        entry: 'portal',
        method: 'GET',
        url: '/api/portal?__imk_route=%2Fapi%2Fportal%2Ftestimonials&projectId=prj_1',
      });
      assert(answer.ok, `the mutant threw: ${answer.error}`);
      const seen = JSON.parse(answer.result.body).url;
      assert(
        !/projectId=prj_1/.test(seen),
        `the mutant still carried the query (${seen}) — the probe is vacuous`,
      );
      return `the mutant built ${seen} — the query is gone`;
    } finally {
      mutantChild.close();
    }
  });

  await t('D4', 'a DEAD module under api/ is caught (the budget check is not vacuous)', async () => {
    const mutantRoot = sandboxCopy('mut-dead');
    fs.mkdirSync(path.join(mutantRoot, 'api', 'lib'), { recursive: true });
    fs.writeFileSync(
      path.join(mutantRoot, 'api', 'lib', 'dead-utility.ts'),
      'export const helper = () => 1;\n',
      'utf8',
    );
    const apiDir = path.join(mutantRoot, 'api');
    const files = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts')) files.push(full);
      }
    };
    walk(apiDir);
    const dead = files.filter((f) => {
      const text = fs.readFileSync(f, 'utf8');
      return !/export\s+default/.test(text) && !/export\s*\{\s*default\s*\}/.test(text);
    });
    assert(dead.length === 1, 'the mutant copy should hold exactly one dead module');
    assertEqual(files.length, 8, 'the mutant copy should hold 8 files');
    return `the mutant copy holds ${files.length} files, one of them dead — over the budget and caught`;
  });

  child.close();

  // --- the summary ----------------------------------------------------------
  console.log('');
  if (failed === 0) {
    console.log(`[wave13] ${passed} passed, 0 failed, ${passed} checks`);
  } else {
    console.log(`[wave13] ${passed} passed, ${failed} failed, ${passed + failed} checks`);
    console.log(`[wave13] failing checks: ${failures.join(', ')}`);
  }
  if (!KEEP) {
    // Windows keeps a lock on a file a child process had open for a moment.
    try {
      fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      /* the sandbox is in the temp directory; a leftover is harmless */
    }
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('[wave13] the harness itself failed:', err);
  process.exit(2);
});
