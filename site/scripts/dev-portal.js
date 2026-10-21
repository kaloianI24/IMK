// site/scripts/dev-portal.js
//
// Local dev server for the portal MVP.
//
// Serves the built static site (site/dist) AND the /api/portal/* API handlers
// on a single origin, so the magic-link login flow can be tested end-to-end in
// a browser against http://localhost:4321.
//
// Why: astro dev serves pages only (no /api/*), and wrangler pages dev does not
// reliably run the Cloudflare Pages Functions under this Node/wrangler combo.
//
// Usage:
//   npm run dev:portal        (builds, then starts this server on port 4321)
//
// The Vercel handlers (api/portal/*.ts, standard node:http req/res) are bundled
// together from api-index.ts with esbuild at startup and invoked directly, so
// process.env (SITE_BASE_URL, ADMIN_EMAILS, PORTAL_MAGIC_LINK_SECRET) is
// honoured from site/.env and all handlers share one in-memory sessions Map.
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

const PORT = Number(new URL(process.env.SITE_BASE_URL || 'http://localhost:4321').port) || 4321;

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

// route -> handler name
const ROUTES = [
  // The moderation endpoint is routed too, so the one-click approve link
  // works in local dev exactly as it does in production (audit m8).
  ['/api/moderate/review', 'moderate'],
  ['/api/portal/auth', 'auth'],
  ['/api/portal/projects', 'projects'],
  ['/api/portal/plan-items', 'planItems'],
  ['/api/portal/updates', 'updates'],
  ['/api/portal/comments', 'comments'],
  ['/api/portal/invites', 'invites'],
  ['/api/portal/testimonials', 'testimonials'],
  // The owner inbox (spec/07 §7.3, T7.14). Two separate handlers, so two
  // prefixes: the local server matches by prefix, and the deployed targets
  // match by file path.
  ['/api/admin/session', 'adminSession'],
  ['/api/admin/reviews', 'adminReviews'],
];

function resolveHandler(pathname) {
  for (const [prefix, name] of ROUTES) {
    if (pathname === prefix || pathname.startsWith(prefix + '/')) return name;
  }
  return null;
}

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

  // --- /api/portal/* -> Vercel handlers -------------------------------------
  const name = resolveHandler(pathname);
  if (name) {
    const handler = api ? api[name] : null;
    if (!handler) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'handler unavailable', handler: name }));
      return;
    }
    try {
      await handler(req, res);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`[dev-portal] /api/portal/${name} error:`, e);
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
