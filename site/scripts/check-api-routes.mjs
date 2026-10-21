// site/scripts/check-api-routes.mjs
//
// ROUTE MANIFEST CHECK (QA wave-3, F-1)
//
// WHAT THIS CHECKS
//   Both deployment targets route a function by its FILE PATH:
//
//     Vercel             api/portal/auth.ts            -> /api/portal/auth
//     Cloudflare Pages  site/functions/api/portal/auth.ts -> /api/portal/auth
//
//   A URL with a segment after that had NO function behind it on the
//   deployed target:
//
//     POST /api/portal/auth/request-link  -> 404 (no client could sign in)
//     PATCH /api/portal/projects/<id>     -> 404 (the owner could not edit)
//     PATCH /api/portal/plan-items/<id>   -> 404
//
//   The local dev server (site/scripts/dev-portal.js) matches by PREFIX, so
//   a local run can never show this. Three QA waves ran against that
//   server and could not see it.
//
//   This script reads every /api path the client calls and every /api path
//   the server names, and asserts that a function file exists for it in
//   BOTH trees. It is the machine check that catches F-1 the moment it is
//   introduced again.
//
// USAGE
//   node scripts/check-api-routes.mjs        (from site/)
//   npm run check:routes
//
// Exit code 0 = every path has a function file in both trees.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = resolve(SITE, '..');

// The two function trees. A path is served by a file in BOTH of them.
//
//   Vercel             api/<rest>.ts            -> /api/<rest>
//   Cloudflare Pages  functions/api/<rest>.ts  -> /api/<rest>
//
// `strip` is how many leading segments of the route the tree does NOT
// repeat in its directory layout.
const TREES = [
  { name: 'vercel', dir: join(REPO, 'api'), strip: 1 },
  { name: 'cloudflare', dir: join(SITE, 'functions'), strip: 0 },
];

// Where the client-side paths are read from.
const CLIENT_DIR = join(SITE, 'src');
// Where the server-side paths are read from.
const SERVER_DIRS = [join(REPO, 'api'), join(SITE, 'functions')];

/* ------------------------------------------------------------------ utils */

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) {
      continue;
    }
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/** Every quoted string in a file: single, double and template literals. */
function quotedStrings(text) {
  const found = [];
  const re = /'([^'\n]*)'|"([^"\n]*)"|`([^`]*)`/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    found.push(m[1] ?? m[2] ?? m[3] ?? '');
  }
  return found;
}

/**
 * The API base of a file, when it has one: `const API = '/api/portal'`.
 * That value is a PREFIX, not a route: no function file is expected for it.
 */
function apiBaseOf(text) {
  const m = text.match(/const\s+([A-Za-z_$][\w$]*)\s*=\s*['"](\/api\/[^'"]*)['"]/);
  return m ? { name: m[1], value: m[2] } : null;
}

/** Paths passed as an argument to a call: api('/projects'), api(`/x/${id}`). */
function callSitePaths(text) {
  const found = [];
  const re = /[A-Za-z_$][\w$.]*\s*\(\s*('([^'\n]*)'|"([^"\n]*)"|`([^`]*)`)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const literal = m[2] ?? m[3] ?? m[4] ?? '';
    if (literal.startsWith('/')) found.push(literal);
  }
  return found;
}

/** Normalise a path into a route pattern: no query, no trailing slash. */
function normalise(path) {
  // A template interpolation is one dynamic segment. It is replaced BEFORE
  // the query/quote cut, because an interpolation can contain spaces and
  // quotes of its own: ${encodeURIComponent(id ?? '')}.
  let p = path.replace(/\$\{[^}]*\}/g, '*');
  const q = p.search(/[?'"\s]/);
  if (q !== -1) p = p.slice(0, q);
  p = p.replace(/\/+$/, '');
  return p;
}

/**
 * Every route pattern a string names.
 *
 *   '/api/portal/auth/verify?token=${x}'   -> '/api/portal/auth/verify'
 *   '${base}/api/moderate/review?ref=..'   -> '/api/moderate/review'
 */
function absolutePatterns(str) {
  const patterns = new Set();
  let offset = 0;
  for (;;) {
    const idx = str.indexOf('/api/', offset);
    if (idx === -1) break;
    const pattern = normalise(str.slice(idx));
    if (pattern && pattern !== '/api') patterns.add(pattern);
    offset = idx + 5;
  }
  return patterns;
}

/* ----------------------------------------------------------------- collect */

const patterns = new Map(); // pattern -> { sources: Set<string> }

function record(pattern, source) {
  if (!pattern || pattern === '/api') return;
  if (!patterns.has(pattern)) patterns.set(pattern, { sources: new Set() });
  patterns.get(pattern).sources.add(source);
}

function collect(file) {
  const text = readFileSync(file, 'utf8');
  const rel = relative(REPO, file).split(sep).join('/');
  const base = apiBaseOf(text);

  // Absolute /api paths (client literals and server-side path checks).
  for (const str of quotedStrings(text)) {
    for (const pattern of absolutePatterns(str)) {
      // The base constant itself is a PREFIX, not a route.
      if (base && pattern === base.value.replace(/\/+$/, '')) continue;
      record(pattern, rel);
    }
  }

  // Paths built from the file's API base: api('/projects'), api(`/x/${id}`).
  if (base) {
    for (const str of callSitePaths(text)) {
      if (str.startsWith('/api/')) continue; // absolute, already recorded
      record(normalise(base.value + str), rel);
    }
  }
}

for (const file of walk(CLIENT_DIR)) {
  if (/\.(astro|ts|js|mjs)$/.test(file)) collect(file);
}
for (const dir of SERVER_DIRS) {
  for (const file of walk(dir)) {
    if (/\.(ts|js|mjs)$/.test(file)) collect(file);
  }
}

/* ------------------------------------------------------------------ report */

/**
 * The function file that serves a path in one tree, or null.
 *
 *   'portal/projects'            -> <tree>/portal/projects.ts
 *   'portal/projects/*'          -> <tree>/portal/projects/[id].ts
 */
function handlerFor(tree, pattern) {
  const segs = pattern.split('/').filter(Boolean).slice(tree.strip);
  if (segs.length === 0) return null;
  const last = segs[segs.length - 1];
  const dir = join(tree.dir, ...segs.slice(0, -1));

  if (last !== '*') {
    const file = join(dir, `${last}.ts`);
    return existsSync(file) ? file : null;
  }

  // A dynamic segment: a file named [param].ts in the directory
  if (!existsSync(dir)) return null;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!/^\[[^\]]+\]\.ts$/.test(entry.name)) continue;
    return join(dir, entry.name);
  }
  return null;
}

const rows = [];
let missing = 0;

for (const pattern of [...patterns.keys()].sort()) {
  const segs = pattern.split('/').filter(Boolean).slice(1); // drop 'api'
  const dynamic = segs.filter((s) => s === '*');
  if (dynamic.length > 1 || (dynamic.length === 1 && segs[segs.length - 1] !== '*')) {
    rows.push({ pattern, files: { vercel: 'UNSUPPORTED', cloudflare: 'UNSUPPORTED' } });
    missing += 1;
    continue;
  }
  const files = {};
  for (const tree of TREES) {
    const file = handlerFor(tree, pattern);
    files[tree.name] = file ? relative(REPO, file).split(sep).join('/') : null;
    if (!file) missing += 1;
  }
  rows.push({ pattern, files, sources: [...patterns.get(pattern).sources] });
}

const pad = (s, n) => String(s).padEnd(n, ' ');
console.log('[check-api-routes] route -> function file');
console.log('[check-api-routes]');
for (const row of rows) {
  const vercel = row.files.vercel || 'MISSING';
  const cf = row.files.cloudflare || 'MISSING';
  console.log(`[check-api-routes] ${pad(row.pattern, 44)} ${pad(vercel, 46)} ${cf}`);
  if (!row.files.vercel || !row.files.cloudflare) {
    for (const src of row.sources) console.log(`[check-api-routes]     named in: ${src}`);
  }
}
console.log(`[check-api-routes]`);
console.log(`[check-api-routes] ${rows.length} route(s), ${missing} missing function file(s)`);

if (missing > 0) {
  console.error('');
  console.error('[check-api-routes] FAILED: a path is called but no function file serves it.');
  console.error('[check-api-routes] On Vercel and Cloudflare a function is served at its FILE');
  console.error('[check-api-routes] PATH. A missing file means the request answers 404 in');
  console.error('[check-api-routes] production while the local dev server (prefix matching)');
  console.error('[check-api-routes] answers 200 - the bug is invisible until deploy.');
  process.exit(1);
}

console.log('[check-api-routes] OK: every called path has a function file in both trees.');
