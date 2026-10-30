// site/qa/qa-wave13-routing.mjs
//
// THE WAVE-13 ROUTING LAYER -- EXECUTED (suite #16).
//
// WHY THIS SUITE EXISTS
//   Wave 13 (the function budget) replaced nineteen Vercel function files
//   with seven, and the nine portal URLs are now served by ONE entry point
//   (api/portal.ts) through a RESOLVER and a ROUTE TABLE
//   (site/shared/portal-router.ts, site/shared/portal-routes.json), with the
//   original public path carried in the reserved query parameter
//   __imk_route.
//
//   That is a whole new layer between the platform and the handlers, and
//   before this suite NO QA suite executed it: the other suites bundle the
//   HANDLER MODULES directly, which is right for what they measure and
//   blind to the routing.
//
//   A bug here is invisible to the local dev server (it matches the route
//   table itself) and catastrophic in production: every portal URL answers
//   404, or -- worse -- a SILENT 404 where the route was deleted.
//
// WHAT IT PROVES, BY EXECUTION
//   R1/R2  every public URL of both families is SERVED, and the answer is
//          the RIGHT handler's answer (each route has its own distinctive key)
//   R3     the CARRIER (query parameter) form serves the same route
//   R4     the CARRIER (header) form serves the same route
//   R5     an unknown path is a 404
//   R6     the entry point reached with NO route is a LOUD 500
//          {code:'route-resolution'} -- never a silent 404
//   R7     the original QUERY STRING survives the carrier, and the carrier
//          parameter itself is removed before the handler sees it
//   R8     a forged carrier cannot make the portal entry point serve an
//          admin route, and vice versa
//   R9     DEPLOYED SHAPE: the CARRIER decides the route -- the path does
//          NOT identify it (wave 14 re-pin: the old R9 pinned the local
//          shape, which production never produces)
//   R9b    LOCAL SHAPE (a platform that did not rewrite): the path still
//          wins over the carrier -- the old R9's coverage, kept
//   R10    DEPLOYED SHAPE: a forged carrier is CONTAINED -- it never crosses
//          the family, never reaches a standalone URL, and the handler it
//          selects still authorises itself
//   R11    DEPLOYED SHAPE: an EMPTY query carrier is an INVALID carrier --
//          a clean 404 from the ROUTING LAYER, never a fall-through to the
//          client-controlled x-imk-route header (wave 15, B-1)
//   MP-R   seven mutation probes: the fail-closed 500, the query
//          preservation, the family separation (twice) and the handler's own
//          authorisation must each be load-bearing, and so must both halves
//          of the empty-carrier rule (the entry point and the resolver)
//
// THE SHAPE OF THE TEST
//   The two entry points are bundled with esbuild and called in THIS process
//   with a fake request/response, exactly as the platform would call them.
//   No port is bound. The store is the FILE adapter in a sandbox, so no
//   database and no network are involved.
//
// USAGE
//   node site/qa/qa-wave13-routing.mjs [--json out.json] [--only ID]

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Readable } from 'node:stream';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { handlerPath, familyEntry, fwd } from './handler-paths.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.resolve(__dirname, '..');
const REPO = path.resolve(SITE, '..');

const argv = process.argv.slice(2);
const JSON_OUT = argv.includes('--json')
  ? path.resolve(argv[argv.indexOf('--json') + 1])
  : null;
const ONLY = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : null;

// The tree under test. QA_W13_* point them at a COPY, which is how a defect
// is put back without touching the repository.
const API_DIR = process.env.QA_W13_API_DIR
  ? path.resolve(process.env.QA_W13_API_DIR)
  : path.join(REPO, 'api');
const SHARED_DIR = process.env.QA_W13_SHARED_DIR
  ? path.resolve(process.env.QA_W13_SHARED_DIR)
  : path.join(SITE, 'shared');
const ROOTS = { apiDir: API_DIR, sharedDir: SHARED_DIR };

const PROBE_CHILD = process.env.QA_W13_PROBE_CHILD === '1';

const STAMP = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
const SANDBOX = path.join(os.tmpdir(), 'opencode', `qa-wave13-routing-${STAMP}`);
const WORK = path.join(SANDBOX, 'work');

const ADMIN_EMAIL = 'owner@imk.test';
const CLIENT_EMAIL = 'client@imk.test';
const CLIENT_ID = 'cli_qa_routing';

const BASE_ENV = {
  APP_ENV: 'production',
  NODE_ENV: 'production',
  SITE_BASE_URL: 'https://imk.test',
  RESEND_API_KEY: 'qa-wave13-routing-resend-key',
  RESEND_FROM: 'IMK <qa@imk.test>',
  RESEND_TO: ADMIN_EMAIL,
  FORM_WEBHOOK_SECRET: 'qa-wave13-routing-form-secret-0123456789',
  ADMIN_EMAILS: ADMIN_EMAIL,
  PORTAL_MAGIC_LINK_SECRET: 'qa-wave13-routing-magic-secret-0123456789',
  PORTAL_SESSION_SECRET: 'qa-wave13-routing-session-secret-0123456789',
  PORTAL_RATE_LIMIT_FILE: '',
};

const PROJECT_ID = 'prj_qa_routing';
const PLAN_ITEM_ID = 'pli_qa_routing';

// ---------------------------------------------------------------------------
// the tiny assertion framework (QA's own)
// ---------------------------------------------------------------------------
const results = [];
let currentGroup = 'general';

function group(name) {
  currentGroup = name;
  console.log(`\n[qa] ${name}`);
}

const ONLY_TOKENS = ONLY ? ONLY.split(',').map((t) => t.trim()).filter(Boolean) : [];

async function check(id, groupName, name, fn) {
  if (ONLY_TOKENS.length && !ONLY_TOKENS.some((t) => id === t || String(groupName).startsWith(t))) {
    return;
  }
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
// the fake request / response
// ---------------------------------------------------------------------------
function makeReq(method, url, headers, body) {
  const req = new Readable({ read() {} });
  if (body !== undefined && body !== null) req.push(Buffer.from(String(body)));
  req.push(null);
  req.method = method;
  req.url = url;
  req.headers = headers || {};
  return req;
}

function makeRes() {
  const state = { status: 200, headers: {}, body: '' };
  const res = {
    statusCode: 200,
    headersSent: false,
    writableEnded: false,
    writeHead(status, headers) {
      state.status = status;
      state.headers = headers || {};
      res.statusCode = status;
      res.headersSent = true;
      return res;
    },
    setHeader(k, v) {
      state.headers[k] = v;
      return res;
    },
    getHeader(k) {
      return state.headers[k];
    },
    removeHeader(k) {
      delete state.headers[k];
    },
    write(chunk) {
      if (chunk !== undefined && chunk !== null) state.body += String(chunk);
      return true;
    },
    end(chunk) {
      if (chunk !== undefined && chunk !== null) state.body += String(chunk);
      res.writableEnded = true;
      res.headersSent = true;
      return res;
    },
    on() {
      return res;
    },
    once() {
      return res;
    },
    emit() {
      return false;
    },
  };
  return { res, state };
}

// ---------------------------------------------------------------------------
// bundling
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

/** The portal entry point (one function for nine public URLs). */
async function bundlePortalEntry() {
  const rel = familyEntry('/api/portal');
  return bundle('entry-portal', {
    dir: () => API_DIR,
    code: `export { default as handler } from './${rel.replace(/^api\//, '').replace(/\.ts$/, '.ts')}';`,
  });
}

/** The owner entry point (one function for two public URLs). */
async function bundleAdminEntry() {
  const rel = familyEntry('/api/admin');
  return bundle('entry-admin', {
    dir: () => API_DIR,
    code: `export { default as handler } from './${rel.replace(/^api\//, '').replace(/\.ts$/, '.ts')}';`,
  });
}

/** The session module, for minting a signed cookie. */
async function bundleSession() {
  return bundle('session', {
    dir: () => SHARED_DIR,
    code: `export { createSession } from '${fwd(handlerPath('portal-session', ROOTS))}';`,
  });
}

async function loadBundle(file) {
  const req = createRequire(import.meta.url);
  return req(file);
}

// ---------------------------------------------------------------------------
// the routes under test
// ---------------------------------------------------------------------------
// `key` is the distinctive key of the RIGHT handler's answer -- it is how the
// suite knows that the route reached the handler it names and not another.
const PORTAL_ROUTES = [
  { path: '/api/portal/session', key: 'authenticated', who: 'owner', method: 'GET' },
  { path: '/api/portal/projects', key: 'projects', who: 'owner', method: 'GET' },
  { path: `/api/portal/projects/${PROJECT_ID}`, key: 'project', who: 'owner', method: 'GET' },
  { path: '/api/portal/plan-items', key: 'planItems', who: 'owner', method: 'GET', query: `projectId=${PROJECT_ID}` },
  { path: `/api/portal/plan-items/${PLAN_ITEM_ID}`, key: 'planItem', who: 'owner', method: 'PATCH', body: { status: 'done' } },
  { path: '/api/portal/updates', key: 'updates', who: 'owner', method: 'GET', query: `projectId=${PROJECT_ID}` },
  { path: '/api/portal/comments', key: 'comments', who: 'owner', method: 'GET', query: `projectId=${PROJECT_ID}` },
  { path: '/api/portal/testimonials', key: 'testimonial', who: 'client', method: 'GET', query: `projectId=${PROJECT_ID}` },
  { path: '/api/portal/invites', key: 'invited', who: 'owner', method: 'POST', body: { email: 'new@client.test' } },
];

const ADMIN_ROUTES = [
  { path: '/api/admin/session', key: 'role', who: 'owner', method: 'GET' },
  { path: '/api/admin/reviews', key: 'counts', who: 'owner', method: 'GET' },
];

// ---------------------------------------------------------------------------
// the request helper
// ---------------------------------------------------------------------------
let portalEntry = null;
let adminEntry = null;
let sessionMod = null;

function urlWith(route, extra) {
  const query = route.query ? `?${route.query}` : '';
  return `${route.path}${query}${extra || ''}`;
}

/** Call an entry point exactly as the platform would. */
async function call(entry, method, url, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    // The write endpoints check the Origin against SITE_BASE_URL.
    headers.origin = headers.origin || 'https://imk.test';
  }
  const made = makeRes();
  await entry(makeReq(method, url, headers, opts.body === undefined ? null : JSON.stringify(opts.body)), made.res);
  let json = null;
  try {
    json = JSON.parse(made.state.body);
  } catch {
    /* not json */
  }
  return { status: made.state.status, body: made.state.body, json, headers: made.state.headers };
}

let ownerCookie = null;
let clientCookie = null;

function mintSession(email, role, clientId) {
  const token = sessionMod.createSession(email, role, clientId, { ...process.env, ...BASE_ENV });
  assert(token, `the ${role} session could not be minted`);
  return `${role === 'admin' ? 'imk_admin_session' : 'imk_session'}=${token}`;
}

// ---------------------------------------------------------------------------
// the sandbox: the store the handlers read
// ---------------------------------------------------------------------------
function seedStore() {
  const dataDir = path.join(SANDBOX, 'site', 'data');
  fs.mkdirSync(path.join(dataDir, 'portal'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'moderation'), { recursive: true });
  const client = {
    id: CLIENT_ID,
    email: CLIENT_EMAIL,
    name: 'Routing Client',
    company: 'Routing Ltd',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
  const project = {
    id: PROJECT_ID,
    clientId: CLIENT_ID,
    title: 'Routing project',
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
  fs.writeFileSync(path.join(dataDir, 'portal', 'clients.jsonl'), JSON.stringify(client) + '\n', 'utf8');
  fs.writeFileSync(path.join(dataDir, 'portal', 'projects.jsonl'), JSON.stringify(project) + '\n', 'utf8');
  fs.writeFileSync(
    path.join(dataDir, 'portal', 'planItems.jsonl'),
    JSON.stringify({
      id: PLAN_ITEM_ID,
      projectId: PROJECT_ID,
      title: 'Routing item',
      status: 'todo',
      createdAt: '2026-01-01T00:00:00.000Z',
    }) + '\n',
    'utf8',
  );
  for (const rel of ['comments.jsonl', 'updates.jsonl']) {
    fs.writeFileSync(path.join(dataDir, 'portal', rel), '', 'utf8');
  }
  fs.writeFileSync(path.join(dataDir, 'portal', 'invited.jsonl'), '', 'utf8');
  fs.writeFileSync(path.join(dataDir, 'moderation', 'reviews.jsonl'), '', 'utf8');
  return dataDir;
}

// ---------------------------------------------------------------------------
// the main run
// ---------------------------------------------------------------------------
async function main() {
  fs.mkdirSync(WORK, { recursive: true });
  const dataDir = seedStore();

  // The environment every handler sees.
  Object.assign(process.env, BASE_ENV);
  process.env.PORTAL_STORE = 'file';
  process.env.PORTAL_DATA_DIR = dataDir;

  console.log(`[qa] sandbox: ${SANDBOX}`);
  console.log(`[qa] tree:    api=${API_DIR}`);

  const portalFile = await bundlePortalEntry();
  const adminFile = await bundleAdminEntry();
  const sessionFile = await bundleSession();
  portalEntry = (await loadBundle(portalFile)).handler;
  adminEntry = (await loadBundle(adminFile)).handler;
  sessionMod = await loadBundle(sessionFile);
  assert(typeof portalEntry === 'function', 'the portal entry point exports no handler');
  assert(typeof adminEntry === 'function', 'the admin entry point exports no handler');

  ownerCookie = mintSession(ADMIN_EMAIL, 'admin');
  clientCookie = mintSession(CLIENT_EMAIL, 'client', CLIENT_ID);

  const cookieFor = (who) => (who === 'owner' ? ownerCookie : clientCookie);

  // =====================================================================
  group('R -- the route table, executed');
  // =====================================================================

  await check('R1', 'R -- the route table, executed', 'every PORTAL URL is served by the right handler', async () => {
    for (const route of PORTAL_ROUTES) {
      const res = await call(portalEntry, route.method, urlWith(route), {
        cookie: cookieFor(route.who),
        body: route.body,
      });
      assertEqual(res.status, 200, `${route.path} answered ${res.status}: ${res.body.slice(0, 200)}`);
      assert(
        res.json && Object.prototype.hasOwnProperty.call(res.json, route.key),
        `${route.path} was NOT served by its own handler (the answer has no "${route.key}" key): ${res.body.slice(0, 200)}`,
      );
    }
    return `${PORTAL_ROUTES.length} portal URLs served`;
  });

  await check('R2', 'R -- the route table, executed', 'every ADMIN URL is served by the right handler', async () => {
    for (const route of ADMIN_ROUTES) {
      const res = await call(adminEntry, route.method, urlWith(route), {
        cookie: cookieFor(route.who),
        body: route.body,
      });
      assertEqual(res.status, 200, `${route.path} answered ${res.status}: ${res.body.slice(0, 200)}`);
      assert(
        res.json && Object.prototype.hasOwnProperty.call(res.json, route.key),
        `${route.path} was NOT served by its own handler (the answer has no "${route.key}" key): ${res.body.slice(0, 200)}`,
      );
    }
    return `${ADMIN_ROUTES.length} admin URLs served`;
  });

  await check('R3', 'R -- the route table, executed', 'the CARRIER (query parameter) form serves the same route', async () => {
    for (const route of PORTAL_ROUTES) {
      const direct = await call(portalEntry, route.method, urlWith(route), {
        cookie: cookieFor(route.who),
        body: route.body,
      });
      const carrier = await call(
        portalEntry,
        route.method,
        `/api/portal?__imk_route=${encodeURIComponent(route.path)}${route.query ? `&${route.query}` : ''}`,
        { cookie: cookieFor(route.who), body: route.body },
      );
      assertEqual(carrier.status, direct.status, `${route.path} answered differently through the carrier`);
      assert(
        carrier.json && Object.prototype.hasOwnProperty.call(carrier.json, route.key),
        `${route.path} through the carrier did not reach its handler: ${carrier.body.slice(0, 200)}`,
      );
    }
    return `${PORTAL_ROUTES.length} portal URLs served through the carrier`;
  });

  await check('R4', 'R -- the route table, executed', 'the CARRIER (header) form serves the same route', async () => {
    const route = PORTAL_ROUTES[1];
    const res = await call(portalEntry, route.method, '/api/portal', {
      cookie: cookieFor(route.who),
      headers: { 'x-imk-route': route.path },
    });
    assertEqual(res.status, 200, `the header carrier answered ${res.status}: ${res.body.slice(0, 200)}`);
    assert(
      res.json && Object.prototype.hasOwnProperty.call(res.json, route.key),
      `the header carrier did not reach its handler: ${res.body.slice(0, 200)}`,
    );
    return `the x-imk-route header served ${route.path}`;
  });

  await check('R5', 'R -- the route table, executed', 'an unknown path is a 404', async () => {
    const res = await call(portalEntry, 'GET', '/api/portal/no-such-route');
    assertEqual(res.status, 404, `an unknown path answered ${res.status}: ${res.body.slice(0, 200)}`);
    assertEqual(res.json && res.json.code, 'not-found', `the code must be 'not-found': ${res.body.slice(0, 200)}`);
    return '404 {code:not-found}';
  });

  await check('R6', 'R -- the route table, executed', 'the entry point reached with NO route is a LOUD 500, never a silent 404', async () => {
    const res = await call(portalEntry, 'GET', '/api/portal');
    assertEqual(res.status, 500, `the bare entry point answered ${res.status}: ${res.body.slice(0, 200)}`);
    assertEqual(
      res.json && res.json.code,
      'route-resolution',
      `the code must be 'route-resolution' (a silent 404 would read as "the route was deleted"): ${res.body.slice(0, 200)}`,
    );
    const admin = await call(adminEntry, 'GET', '/api/admin');
    assertEqual(admin.status, 500, `the bare admin entry point answered ${admin.status}`);
    assertEqual(admin.json && admin.json.code, 'route-resolution', 'the admin entry point must be loud too');
    return '500 {code:route-resolution} on both entry points';
  });

  await check('R7', 'R -- the route table, executed', 'the original QUERY survives the carrier, and the carrier parameter is removed', async () => {
    // The testimonials handler answers 400 {error:'missing projectId'} when the
    // query carries no projectId. That is the observable.
    const without = await call(
      portalEntry,
      'GET',
      `/api/portal?__imk_route=${encodeURIComponent('/api/portal/testimonials')}`,
      { cookie: clientCookie },
    );
    assert(
      without.json && without.json.error === 'missing projectId',
      `the carrier parameter was mistaken for the query: ${without.body.slice(0, 200)}`,
    );
    const with_ = await call(
      portalEntry,
      'GET',
      `/api/portal?__imk_route=${encodeURIComponent('/api/portal/testimonials')}&projectId=${PROJECT_ID}`,
      { cookie: clientCookie },
    );
    assert(
      !(with_.json && with_.json.error === 'missing projectId'),
      `the original query was LOST through the carrier: ${with_.body.slice(0, 200)}`,
    );
    assertEqual(with_.status, 200, `the query-carrying request answered ${with_.status}`);
    return 'the query survives, the carrier parameter is removed';
  });

  await check('R8', 'R -- the route table, executed', 'a forged carrier cannot cross the families', async () => {
    const res = await call(
      portalEntry,
      'GET',
      `/api/portal?__imk_route=${encodeURIComponent('/api/admin/reviews')}`,
      { cookie: ownerCookie },
    );
    assertEqual(res.status, 404, `the portal entry point served an admin route: ${res.body.slice(0, 200)}`);
    assert(
      !(res.json && Object.prototype.hasOwnProperty.call(res.json, 'counts')),
      'the portal entry point answered with the admin queue',
    );
    const admin = await call(
      adminEntry,
      'GET',
      `/api/admin?__imk_route=${encodeURIComponent('/api/portal/projects')}`,
      { cookie: ownerCookie },
    );
    assertEqual(admin.status, 404, `the admin entry point served a portal route: ${admin.body.slice(0, 200)}`);
    return 'neither entry point serves the other family';
  });

  await check('R9', 'R -- the route table, executed', 'DEPLOYED SHAPE: the CARRIER decides the route (the path does NOT identify it)', async () => {
    // WAVE 14 RE-PIN. The old R9 asserted "the PATH wins over the carrier".
    //
    // That is the LOCAL shape: the dev server, `vercel dev` without the
    // rewrites applied, or a platform that did not rewrite. On the DEPLOYED
    // target the vercel.json rewrite REPLACES the path with the entry prefix,
    // so the path does not identify the route and the carrier does. The old
    // check therefore pinned a shape production never produces, and it said
    // nothing about the deployed target at all.
    //
    // What is pinned instead is the invariant that holds THERE: the carrier
    // decides, and the route it selects is bounded by the family table and
    // by the handler's own gate (R10 proves the bound; this check proves the
    // carrier decides).
    //
    // THE OBSERVABLE: on the SAME path (/api/portal, the entry prefix) two
    // DIFFERENT carriers produce two DIFFERENT handlers. If the path still
    // identified the route, the two answers would be identical. The path
    // alone resolves to nothing at all (R6: a loud 500 route-resolution), so
    // a 200 here can only have come from the carrier.
    const comments = await call(
      portalEntry,
      'GET',
      `/api/portal?__imk_route=${encodeURIComponent('/api/portal/comments')}&projectId=${PROJECT_ID}`,
      { cookie: ownerCookie },
    );
    assertEqual(comments.status, 200, `the carrier form answered ${comments.status}: ${comments.body.slice(0, 200)}`);
    assert(
      comments.json && Object.prototype.hasOwnProperty.call(comments.json, 'comments'),
      `the carrier did not reach the comments handler: ${comments.body.slice(0, 200)}`,
    );
    assert(
      !(comments.json && Object.prototype.hasOwnProperty.call(comments.json, 'projects')),
      'the comments carrier was served by the projects handler',
    );

    const projects = await call(
      portalEntry,
      'GET',
      `/api/portal?__imk_route=${encodeURIComponent('/api/portal/projects')}`,
      { cookie: ownerCookie },
    );
    assertEqual(projects.status, 200, `the carrier form answered ${projects.status}: ${projects.body.slice(0, 200)}`);
    assert(
      projects.json && Object.prototype.hasOwnProperty.call(projects.json, 'projects'),
      `the carrier did not reach the projects handler: ${projects.body.slice(0, 200)}`,
    );
    assert(
      !(projects.json && Object.prototype.hasOwnProperty.call(projects.json, 'comments')),
      'the projects carrier was served by the comments handler',
    );
    return 'the same path, two carriers, two handlers -- the carrier decides';
  });

  await check('R9b', 'R -- the route table, executed', 'LOCAL SHAPE (a platform that did not rewrite): the PATH still wins over the carrier', async () => {
    // The coverage the old R9 had, kept and relabelled: it is a true
    // property of the resolver (rule 1 before rule 2) and it is what
    // protects the local dev server, but it is NOT a claim about the
    // deployed target -- there the path is the entry prefix (R9).
    const res = await call(
      portalEntry,
      'GET',
      `/api/portal/projects?__imk_route=${encodeURIComponent('/api/portal/comments')}`,
      { cookie: ownerCookie },
    );
    assertEqual(res.status, 200, `the valid path answered ${res.status}: ${res.body.slice(0, 200)}`);
    assert(
      res.json && Object.prototype.hasOwnProperty.call(res.json, 'projects'),
      `the carrier hijacked the path: ${res.body.slice(0, 200)}`,
    );
    assert(
      !(res.json && Object.prototype.hasOwnProperty.call(res.json, 'comments')),
      'the carrier hijacked the path',
    );
    return 'the path is served by its own handler';
  });

  await check('R10', 'R -- the route table, executed', 'DEPLOYED SHAPE: a forged carrier is CONTAINED (no cross-family, no standalone, the handler still authorises itself)', async () => {
    // WAVE 14 (F2). The request is built the way the PLATFORM builds it:
    // the path is the ENTRY PREFIX and the original public path arrives in
    // the reserved query parameter __imk_route. A client can put ANY value
    // in that parameter, so this check asks what a forged carrier can
    // actually reach.
    //
    // The three invariants the shipped router claims (wave 14, F1) are
    // asserted here BY EXECUTION, against the real entry points:
    //
    //   1. FAMILY CONTAINMENT -- a carrier that names the OWNER's route is
    //      refused by the ROUTING LAYER: a clean 404 {code:'not-found'},
    //      not the owner's queue and not a handler that ran.
    //   2. THE STANDALONE URLS ARE OUT OF REACH -- api/contact.ts,
    //      api/moderate/review.ts and the three api/portal/auth/* files are
    //      in NO family table, so no carrier can name them.
    //   3. THE HANDLER AUTHORISES ITSELF -- a carrier that names a route of
    //      the RIGHT family still goes through that handler's own gate. The
    //      observable is a 401, NOT a 404: a 401 proves the HANDLER ran
    //      and applied its own gate, while a 404 would only mean the
    //      router refused the carrier.
    //
    // Every request below uses the deployed shape: path = the entry prefix.

    // --- 1. the family boundary ------------------------------------------------
    const cross = await call(
      portalEntry,
      'GET',
      `/api/portal?__imk_route=${encodeURIComponent('/api/admin/reviews')}`,
      { cookie: ownerCookie },
    );
    assertEqual(cross.status, 404, `the portal entry point answered ${cross.status} for a cross-family carrier: ${cross.body.slice(0, 200)}`);
    assertEqual(cross.json && cross.json.code, 'not-found', `the cross-family carrier must be a clean 404 {code:'not-found'}: ${cross.body.slice(0, 200)}`);
    assert(
      !(cross.json && Object.prototype.hasOwnProperty.call(cross.json, 'counts')),
      'the portal entry point answered with the OWNER\'S QUEUE',
    );
    const crossBack = await call(
      adminEntry,
      'GET',
      `/api/admin?__imk_route=${encodeURIComponent('/api/portal/projects')}`,
      { cookie: ownerCookie },
    );
    assertEqual(crossBack.status, 404, `the admin entry point answered ${crossBack.status} for a cross-family carrier: ${crossBack.body.slice(0, 200)}`);
    assertEqual(crossBack.json && crossBack.json.code, 'not-found', `the cross-family carrier must be a clean 404 {code:'not-found'}: ${crossBack.body.slice(0, 200)}`);

    // --- 2. the standalone URLs ------------------------------------------------
    const STANDALONE = [
      '/api/contact',
      '/api/moderate/review',
      '/api/portal/auth/verify',
      '/api/portal/auth/request-link',
      '/api/portal/auth/logout',
    ];
    for (const url of STANDALONE) {
      const res = await call(
        portalEntry,
        'GET',
        `/api/portal?__imk_route=${encodeURIComponent(url)}`,
        { cookie: ownerCookie },
      );
      assertEqual(res.status, 404, `a carrier named ${url} and the portal entry point answered ${res.status}: ${res.body.slice(0, 200)}`);
      assertEqual(res.json && res.json.code, 'not-found', `a carrier named ${url} and the answer must be a clean 404 {code:'not-found'}: ${res.body.slice(0, 200)}`);
    }

    // --- 3. the handler authorises itself -------------------------------------
    const noSession = await call(
      portalEntry,
      'GET',
      `/api/portal?__imk_route=${encodeURIComponent('/api/portal/session')}`,
    );
    assertEqual(noSession.status, 401, `the carrier-selected session route answered ${noSession.status} without a session: ${noSession.body.slice(0, 200)}`);
    assertEqual(noSession.json && noSession.json.code, 'unauthorized', `the handler's own gate must answer 401 {code:'unauthorized'}: ${noSession.body.slice(0, 200)}`);

    const clientAtInbox = await call(
      adminEntry,
      'GET',
      `/api/admin?__imk_route=${encodeURIComponent('/api/admin/reviews')}`,
      { cookie: clientCookie },
    );
    assertEqual(clientAtInbox.status, 401, `a CLIENT session reached the owner's inbox (${clientAtInbox.status}): ${clientAtInbox.body.slice(0, 200)}`);
    assertEqual(clientAtInbox.json && clientAtInbox.json.code, 'unauthorized', `the owner's gate must answer 401 {code:'unauthorized'}: ${clientAtInbox.body.slice(0, 200)}`);

    return 'no cross-family reach, no standalone reach, the handler gate still applies';
  });

  await check('R11', 'R -- the route table, executed', 'DEPLOYED SHAPE: an EMPTY query carrier is an INVALID carrier (404), never a fall-through to the header', async () => {
    // WAVE 15 (B-1). QA's OWN check, written from the requirement and not
    // from the Backend's harness: "the query carrier, when PRESENT, is
    // authoritative" -- so a carrier that is PRESENT but EMPTY names no
    // route, and it must NEVER fall through to the other (client-
    // controlled) channel, the x-imk-route header.
    //
    // The request is built the way the PLATFORM builds it: the path is the
    // ENTRY PREFIX, and the client's own query carries the carrier. The
    // header carries a LEGITIMATE same-family route, so a fall-through
    // would serve a real handler -- the defect would be visible, not
    // silent.
    //
    // THE OBSERVABLE: the answer must come from the ROUTING LAYER, not
    // from a handler. A 404 {code:'not-found'} proves the router refused
    // the carrier. A 401 {code:'unauthorized'} would prove the SESSION
    // HANDLER ran (and applied its own gate) -- so the check asserts the
    // code is 'not-found' and NOT 'unauthorized', and that no
    // handler-specific key is in the body.
    //
    // The CONTROLS are what make it non-vacuous: the header channel must
    // still work when the query parameter is genuinely ABSENT (that is the
    // documented contingency), and a PRESENT, non-empty query carrier must
    // still decide over the header.

    // --- 1. the empty carrier is refused, and the header is NOT consulted ---
    const emptyPortal = await call(portalEntry, 'GET', '/api/portal?__imk_route=', {
      headers: { 'x-imk-route': '/api/portal/session' },
    });
    assertEqual(emptyPortal.status, 404, `an EMPTY carrier answered ${emptyPortal.status}, not 404: ${emptyPortal.body.slice(0, 200)}`);
    assertEqual(emptyPortal.json && emptyPortal.json.code, 'not-found', `an EMPTY carrier must be a clean 404 {code:'not-found'}: ${emptyPortal.body.slice(0, 200)}`);
    assert(
      !(emptyPortal.json && emptyPortal.json.code === 'unauthorized'),
      'the answer came from the SESSION HANDLER (401), not from the routing layer -- the empty carrier fell through to the header',
    );
    assert(
      !(emptyPortal.json && Object.prototype.hasOwnProperty.call(emptyPortal.json, 'authenticated')),
      'the session handler ran for an EMPTY carrier',
    );

    // --- 2. the same on the ADMIN entry point ---
    const emptyAdmin = await call(adminEntry, 'GET', '/api/admin?__imk_route=', {
      headers: { 'x-imk-route': '/api/admin/reviews' },
    });
    assertEqual(emptyAdmin.status, 404, `an EMPTY carrier on the admin entry point answered ${emptyAdmin.status}: ${emptyAdmin.body.slice(0, 200)}`);
    assertEqual(emptyAdmin.json && emptyAdmin.json.code, 'not-found', `an EMPTY carrier must be a clean 404 {code:'not-found'}: ${emptyAdmin.body.slice(0, 200)}`);
    assert(
      !(emptyAdmin.json && Object.prototype.hasOwnProperty.call(emptyAdmin.json, 'counts')),
      "the OWNER'S INBOX ran for an EMPTY carrier",
    );

    // --- 3. it is a CLEAN 404, not the loud 500 ---
    // The loud 500 {code:'route-resolution'} belongs to the bare entry
    // point reached with NO carrier at all (R6). An empty carrier names a
    // route and names it wrong, so it is a 404 -- and saying so here stops
    // a future change from turning "invalid carrier" into "the platform ate
    // the path".
    assert(
      !(emptyPortal.json && emptyPortal.json.code === 'route-resolution'),
      'an EMPTY carrier must not be answered with the loud 500 {code:route-resolution}',
    );

    // --- 4. CONTROL: an ABSENT query carrier still resolves through the header ---
    const viaHeader = await call(portalEntry, 'GET', '/api/portal', {
      headers: { 'x-imk-route': '/api/portal/projects' },
      cookie: ownerCookie,
    });
    assertEqual(viaHeader.status, 200, `the header channel answered ${viaHeader.status} with an ABSENT query carrier: ${viaHeader.body.slice(0, 200)}`);
    assert(
      viaHeader.json && Object.prototype.hasOwnProperty.call(viaHeader.json, 'projects'),
      `the header channel did not serve the projects route: ${viaHeader.body.slice(0, 200)}`,
    );

    // --- 5. CONTROL: a PRESENT query carrier still decides over the header ---
    const queryWins = await call(
      portalEntry,
      'GET',
      `/api/portal?__imk_route=${encodeURIComponent('/api/portal/projects')}`,
      { headers: { 'x-imk-route': '/api/portal/session' }, cookie: ownerCookie },
    );
    assertEqual(queryWins.status, 200, `the query carrier answered ${queryWins.status}: ${queryWins.body.slice(0, 200)}`);
    assert(
      queryWins.json && Object.prototype.hasOwnProperty.call(queryWins.json, 'projects'),
      `the query carrier did not decide: ${queryWins.body.slice(0, 200)}`,
    );
    assert(
      !(queryWins.json && Object.prototype.hasOwnProperty.call(queryWins.json, 'authenticated')),
      'the HEADER won over a PRESENT query carrier',
    );

    return 'an empty carrier is a clean 404 from the router; the header channel is unchanged';
  });

  // =====================================================================
  // the mutation probes
  // =====================================================================
  if (!PROBE_CHILD) {
    await runProbes();
  }

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
  fs.rmSync(SANDBOX, { recursive: true, force: true });
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

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dst);
    else fs.copyFileSync(src, dst);
  }
}

function rmrf(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

function copyTree(name) {
  const root = path.join(WORK, `probe-${name}`);
  rmrf(root);
  copyDir(API_DIR, path.join(root, 'api'));
  copyDir(SHARED_DIR, path.join(root, 'site', 'shared'));
  return root;
}

function runSuiteAgainst(root, checkId) {
  const out = path.join(WORK, `probe-${checkId}-${Math.random().toString(36).slice(2)}.json`);
  let code = 0;
  let stdout = '';
  try {
    stdout = execFileSync(
      process.execPath,
      [path.join(__dirname, 'qa-wave13-routing.mjs'), '--json', out, '--only', checkId],
      {
        cwd: SITE,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          QA_W13_API_DIR: path.join(root, 'api'),
          QA_W13_SHARED_DIR: path.join(root, 'site', 'shared'),
          QA_W13_PROBE_CHILD: '1',
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

/**
 * Put the FAMILY CONTAINMENT back the way it was before wave 14.
 *
 * "The family containment is gone" is a defect with three sites, and all
 * three have to go for the defect to be REAL:
 *
 *   1. the TABLE -- the portal family gains the owner's route, so the
 *      resolver can name it;
 *   2. the ENTRY POINT -- the portal entry point's HANDLERS map gains the
 *      owner's handler, so the named route can really be served;
 *   3. the CODE -- the resolver no longer refuses a carrier that is not
 *      inside the entry point's own prefix
 *      (site/shared/portal-router.ts, `if (!isInsideEntry(carrier, ...))`).
 *
 * With only (1) the mutant was VACUOUS: wave 14's prefix check refused the
 * cross-family carrier before the table was ever consulted, and the probe
 * asserted a red that never came.
 *
 * With all three the forged carrier really reaches the owner's handler --
 * which is what makes the re-pin worth something.
 */
function removeFamilyContainment(root) {
  // 1. the TABLE
  patch(
    path.join(root, 'site', 'shared', 'portal-routes.json'),
    '        "/api/portal/projects": "portal-projects",',
    '        "/api/portal/projects": "portal-projects",\n        "/api/admin/reviews": "admin-reviews",',
  );
  // 2. the ENTRY POINT
  patch(
    path.join(root, 'api', 'portal.ts'),
    "import portalComments from '../site/shared/portal-handlers/portal-comments.js';",
    "import portalComments from '../site/shared/portal-handlers/portal-comments.js';\nimport adminReviews from '../site/shared/portal-handlers/admin-reviews.js';",
  );
  patch(
    path.join(root, 'api', 'portal.ts'),
    "const HANDLERS: Record<string, Handler> = {\n  'portal-comments': portalComments,",
    "const HANDLERS: Record<string, Handler> = {\n  'admin-reviews': adminReviews,\n  'portal-comments': portalComments,",
  );
  // 3. the CODE
  patch(
    path.join(root, 'site', 'shared', 'portal-router.ts'),
    '    if (!isInsideEntry(carrier, entryPrefix)) {',
    '    if (false) {',
  );
}

const PROBES = [
  {
    id: 'MP-R1',
    checkId: 'R6',
    defect: 'the entry point answers a SILENT 404 when it is reached with no route',
    patch(root) {
      patch(
        path.join(root, 'api', 'portal.ts'),
        `    if (resolution.reason === 'route-resolution') {`,
        `    if (false) {`,
      );
    },
  },
  {
    id: 'MP-R2',
    checkId: 'R7',
    defect: 'the original query string is LOST when the route is carried',
    patch(root) {
      patch(
        path.join(root, 'site', 'shared', 'portal-router.ts'),
        '  url.searchParams.delete(ROUTE_CARRIER_PARAM);',
        '  url.searchParams.delete(ROUTE_CARRIER_PARAM);\n  url.search = ""; // QA MUTATION: the original query is lost',
      );
    },
  },
  {
    id: 'MP-R3',
    checkId: 'R8',
    defect: 'the FAMILY SEPARATION is gone: the portal entry point also serves the owner routes',
    patch(root) {
      // The separation lives in TWO places, and wave 14 added the second:
      //
      //   1. the TABLE -- each family carries only its own routes, and the
      //      resolver is handed one family at a time;
      //   2. the CODE -- the resolver refuses a carrier that is not inside
      //      the entry point's own prefix (site/shared/portal-router.ts,
      //      `if (!isInsideEntry(carrier, entryPrefix))`).
      //
      // Patching the table ALONE no longer changed anything: the code
      // refused the cross-family carrier before the table was consulted,
      // and this probe went VACUOUS (it asserted the mutant was red and the
      // mutant stayed green -- the wave-14 report caught it).
      //
      // So the mutant now removes BOTH, and also gives the portal entry
      // point the owner's handler, so the forged carrier really reaches the
      // owner's route instead of failing on a missing handler.
      removeFamilyContainment(root);
    },
  },
  {
    id: 'MP-R4',
    checkId: 'R10',
    defect: 'the FAMILY CONTAINMENT is gone (the table AND the code check): a forged carrier crosses the family',
    patch(root) {
      // The SAME defect as MP-R3, aimed at the new deployed-shape check
      // (R10). The two probes share one mutation on purpose: R8 and R10
      // assert DIFFERENT things about the same containment, and each has to
      // be shown to bite on its own.
      removeFamilyContainment(root);
    },
  },
  {
    id: 'MP-R5',
    checkId: 'R10',
    defect: 'the HANDLER AUTHORISES ITSELF is gone: a carrier-selected route answers without a session',
    patch(root) {
      // The third invariant of the shipped router: whatever route the
      // resolver names, the handler behind it applies its OWN gate. Here
      // the portal session handler stops applying it -- the one line that
      // answers 401 for a request with no session.
      patch(
        path.join(root, 'site', 'shared', 'portal-handlers', 'portal-session.ts'),
        `  if (!session) {
    json(res, { error: 'authentication required', code: 'unauthorized' }, 401);
    return;
  }`,
        `  if (!session) {
    // QA MUTATION: the handler no longer authorises itself.
    json(res, { ok: true, authenticated: true, role: 'admin', email: 'mutant@imk.test' }, 200);
    return;
  }`,
      );
    },
  },
  {
    id: 'MP-R6',
    checkId: 'R11',
    defect: 'the EMPTY carrier falls through to the client-controlled header again (wave 15, B-1 reverted)',
    patch(root) {
      // The wave-15 defect, put back in a COPY: the truthiness test
      // (`if (fromQuery)`) treats a PRESENT but EMPTY carrier as ABSENT,
      // so the x-imk-route header is consulted instead. The mutant must
      // make R11 go RED -- the session handler answers (401), so the
      // routing layer did NOT refuse the carrier.
      patch(
        path.join(root, 'api', 'portal.ts'),
        '  if (fromQuery !== null) return fromQuery;',
        '  if (fromQuery) return fromQuery; // QA MUTATION: the empty carrier falls through again',
      );
    },
  },
  {
    id: 'MP-R7',
    checkId: 'R11',
    defect: 'the RESOLVER treats an empty carrier as ABSENT again (wave 15, B-1 reverted)',
    patch(root) {
      // The OTHER half of the wave-15 rule, in the resolver: the presence
      // test in rule 2. With a truthiness test an empty carrier drops
      // through to rule 3 and the bare entry point answers the LOUD 500
      // {code:'route-resolution'} -- so R11 must go RED here too. Both
      // halves have to bite, or the rule is pinned in one place only.
      patch(
        path.join(root, 'site', 'shared', 'portal-router.ts'),
        '  if (carrier !== null) {',
        '  if (carrier) { // QA MUTATION: an empty carrier is absent again',
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
          `the control run against the unmodified copy did not pass (${probe.checkId}). Its output was:\n${String(control.stdout).slice(-1200)}`,
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

main().catch((err) => {
  console.error('[qa] harness crashed:', err && err.stack ? err.stack : err);
  rmrf(SANDBOX);
  process.exit(2);
});
