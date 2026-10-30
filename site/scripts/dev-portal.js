// site/scripts/dev-portal.js
//
// Local dev server for the portal MVP.
//
// Serves the built static site (site/dist) AND the /api/* handlers on a
// single origin, so the magic-link login flow can be tested end-to-end in a
// browser against http://localhost:4321.
//
// Why: astro dev serves pages only (no /api/*), and wrangler pages dev does not
// reliably run the Cloudflare Pages Functions under this Node/wrangler combo.
//
// Usage:
//   npm run dev:portal        (builds, then starts this server on port 4321)
//
// The Vercel handlers are bundled together from api-index.ts with esbuild at
// startup and invoked directly, so process.env (SITE_BASE_URL, ADMIN_EMAILS,
// PORTAL_MAGIC_LINK_SECRET) is honoured from site/.env.
//
// ROUTING (wave 13)
//   The dev server used to match by PREFIX, which is exactly why three QA
//   waves could not see the F-1 defect (a path with no function behind it
//   answered 200 locally and 404 in production). It now serves the SAME
//   route table the deployed target serves
//   (site/shared/portal-routes.json): a family URL goes to its entry point
//   (api/portal.ts, api/admin.ts), a standalone URL to its own handler.
//
//   The entry point is called with the ORIGINAL request URL, so the resolver
//   inside it does the routing - the local server and production take the
//   same code path.
//
// Magic links are printed to this server's stdout in dev mode (no Resend key).

import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import * as os from 'node:os';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const SITE = resolve(__dirname, '..');
const REPO_ROOT = resolve(SITE, '..');
const DIST = resolve(SITE, 'dist');
const OUT_DIR = resolve(os.tmpdir(), 'imk-portal-api'); // bundles live outside the repo
const ENV_FILE = resolve(SITE, '.env');

// The Vercel handlers resolve `site/data/portal` from process.cwd(), which in
// production is the repo root. Mirror that here so data paths resolve correctly.
process.chdir(REPO_ROOT);

// --- Load site/.env into process.env (never committed) -----------------------
function loadEnv() {
  if (!existsSync(ENV_FILE)) return;
  for (const raw of readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m) process.env[m[1]] = m[2].replace(/^"|"$/, '');
  }
}
loadEnv();

// The handlers treat an unset APP_ENV as PRODUCTION (same rule as
// api/contact.ts): with no RESEND_API_KEY a production instance must not
// print a sign-in token to its log (audit M4). A local dev server is exactly
// the case where the token HAS to be printed — the developer reads the link
// from the console — so the dev server opts in explicitly.
if (!process.env.APP_ENV) process.env.APP_ENV = 'development';

// The port the dev server binds.
//
// DEV_PORT wins over everything: site/.env pins SITE_BASE_URL (and therefore
// the port) to 4321, and that port is often taken by another instance — so a
// second dev server could not start at all. DEV_PORT is not in .env, so the
// environment wins over the file for it.
const PORT = Number(process.env.DEV_PORT) || Number(new URL(process.env.SITE_BASE_URL || 'http://localhost:4321').port) || 4321;

// --- The route table (ONE source of truth, shared with the deployed target) --
const ROUTE_TABLE = JSON.parse(
  readFileSync(join(SITE, 'shared', 'portal-routes.json'), 'utf8'),
);

// The bundle export behind a family entry point.
const FAMILY_EXPORT = {
  '/api/portal': 'portal',
  '/api/admin': 'admin',
};

// The bundle export behind a standalone handler name.
const HANDLER_EXPORT = {
  contact: 'contact',
  moderate: 'moderate',
  'portal-auth': 'auth',
};

/**
 * Does this path match a pattern of the table?
 *
 * An exact pattern matches exactly; a '*' pattern matches exactly ONE
 * dynamic segment — the same shape as the platform's [id].ts route. There is
 * no catch-all.
 */
function matchPattern(pathname, routes) {
  if (Object.prototype.hasOwnProperty.call(routes, pathname)) return pathname;
  for (const pattern of Object.keys(routes)) {
    if (!pattern.endsWith('/*')) continue;
    const prefix = pattern.slice(0, -2);
    if (!pathname.startsWith(prefix + '/')) continue;
    const rest = pathname.slice(prefix.length + 1);
    if (!rest || rest.includes('/')) continue;
    return pattern;
  }
  return null;
}

/**
 * The bundle export that serves this path, or null.
 *
 * The standalone URLs come first: each of them keeps a function file of its
 * own, exactly as on the deployed target.
 *
 * A path under a family prefix goes to that family's ENTRY POINT, and the
 * entry point decides — the same way the deployed target does after the
 * rewrite has sent the URL there. The entry point answers 404 for a path it
 * does not know and a loud 500 for the bare prefix, so the dev server and
 * production never disagree about which handler ran.
 */
function resolveHandler(pathname) {
  const standalone = ROUTE_TABLE.standalone[pathname];
  if (standalone) return HANDLER_EXPORT[standalone.handler] || null;
  for (const [prefix, family] of Object.entries(ROUTE_TABLE.families)) {
    if (pathname === prefix || pathname.startsWith(prefix + '/')) {
      return FAMILY_EXPORT[prefix] || null;
    }
  }
  return null;
}

// --- Bundle all handlers from ONE entry -> one shared sessions Map -----------
const API_INDEX = resolve(SITE, 'scripts', 'api-index.ts');
const OUT_FILE = resolve(OUT_DIR, 'api-index.js');

let api;
(async () => {
  await build({
    entryPoints: [API_INDEX],
    outfile: OUT_FILE,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['node:http', 'node:crypto', 'node:fs', 'node:path'],
    logLevel: 'silent',
  });
  // eslint-disable-next-line no-console
  console.log('[dev-portal] bundled portal API handlers');
  api = require(OUT_FILE);
})();

// --- Static file serving -----------------------------------------------------
const CT = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain',
};

function serveStatic(res, filePath) {
  try {
    if (!existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }
    const st = statSync(filePath);
    if (st.isDirectory()) return serveStatic(res, join(filePath, 'index.html'));
    const ext = extname(filePath);
    res.writeHead(200, {
      'Content-Type': CT[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(readFileSync(filePath));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end(e.message);
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  // --- /api/* -> the Vercel handlers ----------------------------------------
  const name = resolveHandler(pathname);
  if (name) {
    const handler = api ? api[name] : null;
    if (!handler) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'handler unavailable', handler: name }));
      return;
    }
    try {
      // The ORIGINAL request URL is passed on: the entry points resolve the
      // route themselves, exactly as they do after the platform's rewrite.
      await handler(req, res);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`[dev-portal] ${pathname} error:`, e);
      if (!res.writableEnded) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal server error' }));
      }
    }
    return;
  }

  // --- static site ----------------------------------------------------------
  // "/" serves the home page (dist/index.html) like a real host, not the login
  // page. Extensionless routes fall back to "<route>/index.html".
  let filePath;
  if (pathname === '/') {
    filePath = join(DIST, 'index.html');
  } else if (extname(pathname)) {
    filePath = join(DIST, pathname);
  } else {
    filePath = join(DIST, pathname, 'index.html');
  }
  serveStatic(res, filePath);
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(
    `[dev-portal] listening on http://localhost:${PORT} (SITE_BASE_URL=${process.env.SITE_BASE_URL})`,
  );
  // eslint-disable-next-line no-console
  console.log(`[dev-portal] open http://localhost:${PORT}/ to load the site (home page)`);
  // eslint-disable-next-line no-console
  console.log(`[dev-portal] sign in at http://localhost:${PORT}/login to test the magic-link flow`);
});
