// site/scripts/check-api-routes.mjs
//
// ROUTE MANIFEST CHECK (QA wave-3, F-1)
//
// WHAT THIS CHECKS
//   Both deployment targets must answer every /api path the client calls.
//
//     Vercel             api/<rest>.ts            -> /api/<rest>
//     Cloudflare Pages  site/functions/api/<rest>.ts -> /api/<rest>
//
//   A URL with a segment after that had NO function behind it on the
//   deployed target:
//
//     POST /api/portal/auth/request-link  -> 404 (no client could sign in)
//     PATCH /api/portal/projects/<id>     -> 404 (the owner could not edit)
//     PATCH /api/portal/plan-items/<id>   -> 404
//
//   The local dev server (site/scripts/dev-portal.js) used to match by
//   PREFIX, so a local run could never show this. Three QA waves ran against
//   that server and could not see it.
//
//   This script reads every /api path the client calls and every /api path
//   the server names, and asserts that a function serves it in BOTH trees.
//
// WAVE 13 — THE FUNCTION BUDGET
//   Vercel builds ONE FUNCTION per file under api/, and the Hobby plan caps a
//   deployment at twelve. The portal family is now ONE function
//   (api/portal.ts) and the owner family another (api/admin.ts); the route
//   table (site/shared/portal-routes.json) says which handler serves which
//   public URL, and vercel.json rewrites every family URL to its entry
//   point.
//
//   So a Vercel URL is served EITHER by its own file (a standalone URL: the
//   contact form, the moderation link, the three sign-in URLs) OR by a
//   route-table entry (a family URL). Both are checked here, and the two
//   tables are also checked against each other: a route with no rewrite, or
//   a rewrite with no route, fails the build.
//
// USAGE
//   node scripts/check-api-routes.mjs        (from site/)
//   npm run check:routes
//
// Exit code 0 = every called path is served in both trees, every route of
// the table is served by its entry point's HANDLERS map, and api/ is within
// the function budget.
//
// WAVE 14 — TWO GAPS IN THIS GATE
//   F2  A missing entry point or handler module used to raise
//       TypeError: Cannot read properties of undefined (reading 'vercel')
//       in the printer, because the row was pushed without its `files`
//       object. The gate still failed closed, but the owner got a stack
//       trace instead of the line that names the miss.
//   F3  The route table was never compared with the HANDLERS maps of
//       api/portal.ts and api/admin.ts, so a table route the entry point
//       cannot serve passed this gate (exit 0) and answered 500
//       {code:'internal'} at runtime.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = resolve(SITE, '..');

/** The Vercel function budget: Hobby caps a deployment at twelve. */
const FUNCTION_BUDGET = 12;

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
// Where the server-side paths are read from. The handler bodies moved to
// site/shared/portal-handlers/ in wave 13, so that directory is scanned too.
const SERVER_DIRS = [join(REPO, 'api'), join(SITE, 'functions'), join(SITE, 'shared', 'portal-handlers')];

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

/* ------------------------------------------------------- the route table */

const TABLE_FILE = join(SITE, 'shared', 'portal-routes.json');
if (!existsSync(TABLE_FILE)) {
  console.error('[check-api-routes] FAILED: the route table is missing.');
  console.error(`[check-api-routes]   ${relative(REPO, TABLE_FILE)}`);
  process.exit(1);
}
const TABLE = JSON.parse(readFileSync(TABLE_FILE, 'utf8'));

/**
 * The table entry that serves a path, or null.
 *
 * A standalone URL (its own function file) is matched exactly. A family URL
 * is matched against the family's patterns: an exact one, or a '*' pattern
 * (exactly ONE dynamic segment).
 */
function tableEntryFor(pattern) {
  const standalone = TABLE.standalone?.[pattern];
  if (standalone) {
    return {
      kind: 'standalone',
      entry: standalone.entry,
      handler: standalone.handler,
      handlerFile: TABLE.handlers?.[standalone.handler] ?? null,
    };
  }
  for (const [prefix, family] of Object.entries(TABLE.families ?? {})) {
    const routes = family.routes ?? {};
    let matched = null;
    if (Object.prototype.hasOwnProperty.call(routes, pattern)) {
      matched = pattern;
    } else {
      for (const candidate of Object.keys(routes)) {
        if (!candidate.endsWith('/*')) continue;
        const base = candidate.slice(0, -2);
        if (!pattern.startsWith(base + '/')) continue;
        const rest = pattern.slice(base.length + 1);
        if (!rest || rest.includes('/')) continue;
        matched = candidate;
        break;
      }
    }
    if (matched) {
      const handler = routes[matched];
      return {
        kind: 'family',
        prefix,
        entry: family.entry,
        handler,
        handlerFile: TABLE.handlers?.[handler] ?? null,
      };
    }
  }
  return null;
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

/**
 * The handler module names an entry point can actually serve.
 *
 * The HANDLERS map in the entry point is the ONLY place a route table entry
 * can turn into a handler: the resolver names a handler, and the entry point
 * looks that name up in the map. A table entry whose handler is NOT in the
 * map passes every file-level check here — the handler module file exists,
 * the rewrite exists, the table and the rewrite agree — and then answers
 * 500 {code:'internal'} at runtime with route_handler_missing. So the gate
 * has to compare the table with the map (wave 14, F3).
 *
 * The map is read from the SOURCE, because this gate runs before any bundle
 * exists. Returns null when the entry point has no readable HANDLERS map.
 */
function handlerNamesIn(entryFile) {
  const file = join(REPO, entryFile);
  if (!existsSync(file)) return null;
  const text = readFileSync(file, 'utf8');
  const start = text.indexOf('const HANDLERS');
  if (start === -1) return null;
  const open = text.indexOf('{', start);
  if (open === -1) return null;
  // Brace-counted, so a nested object in the map cannot end it early.
  let depth = 0;
  let close = -1;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close === -1) return null;
  // Comments are stripped first: a quoted word in a comment must not be
  // read as a handler name.
  const body = text
    .slice(open + 1, close)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  const names = new Set();
  const re = /^\s*['"]([^'"]+)['"]\s*:/gm;
  let m;
  while ((m = re.exec(body)) !== null) names.add(m[1]);
  return names;
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

  // --- Cloudflare: one file per URL (unchanged) ------------------------------
  // The Cloudflare file is resolved FIRST, so that EVERY row carries a
  // complete `files` object. A row for a missing entry point used to be
  // pushed without one, and the printer then raised
  //   TypeError: Cannot read properties of undefined (reading 'vercel')
  // instead of naming the miss — the gate still failed closed, but the
  // owner got a stack trace instead of the one line that says what is
  // missing (wave 14, F2).
  const cf = handlerFor(TREES[1], pattern);
  files.cloudflare = cf ? relative(REPO, cf).split(sep).join('/') : null;

  // --- Vercel: a file of its own, or a route-table entry point --------------
  const own = handlerFor(TREES[0], pattern);
  if (own) {
    files.vercel = relative(REPO, own).split(sep).join('/');
  } else {
    const entry = tableEntryFor(pattern);
    if (!entry) {
      files.vercel = null;
    } else if (!existsSync(join(REPO, entry.entry))) {
      files.vercel = null;
      const reason = `the entry point ${entry.entry} is missing`;
      rows.push({ pattern, files, sources: [...patterns.get(pattern).sources], missingReason: reason });
      missing += 1;
      continue;
    } else if (entry.handlerFile && !existsSync(join(REPO, entry.handlerFile))) {
      files.vercel = null;
      const reason = `the handler module ${entry.handlerFile} is missing`;
      rows.push({ pattern, files, sources: [...patterns.get(pattern).sources], missingReason: reason });
      missing += 1;
      continue;
    } else {
      files.vercel = `${entry.entry} -> ${entry.handlerFile ?? entry.handler}`;
      files.vercelIsEntry = true;
    }
  }
  if (!files.vercel) missing += 1;
  if (!files.cloudflare) missing += 1;

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
    if (row.missingReason) console.log(`[check-api-routes]     ${row.missingReason}`);
  }
}
console.log(`[check-api-routes]`);
console.log(`[check-api-routes] ${rows.length} route(s), ${missing} missing function file(s)`);

/* ------------------------------------------------- the function budget */

const apiFiles = walk(join(REPO, 'api'))
  .filter((f) => f.endsWith('.ts'))
  .map((f) => relative(REPO, f).split(sep).join('/'))
  .sort();
console.log(`[check-api-routes] api/ holds ${apiFiles.length} .ts file(s): ${apiFiles.join(', ')}`);
if (apiFiles.length > FUNCTION_BUDGET) {
  console.error('');
  console.error(`[check-api-routes] FAILED: api/ holds ${apiFiles.length} files, the budget is ${FUNCTION_BUDGET}.`);
  console.error('[check-api-routes] Vercel builds ONE FUNCTION per file under api/, and the Hobby');
  console.error('[check-api-routes] plan caps a deployment at twelve — the portal cannot deploy.');
  process.exit(1);
}

/* ------------------------------------- the rewrites must match the table */

const VERCEL_JSON = join(REPO, 'vercel.json');
const vercelJson = JSON.parse(readFileSync(VERCEL_JSON, 'utf8'));
const rewrites = Array.isArray(vercelJson.rewrites) ? vercelJson.rewrites : [];

const rewriteSources = new Set(rewrites.map((r) => r.source));
const rewriteProblems = [];

for (const [prefix, family] of Object.entries(TABLE.families ?? {})) {
  const entryFile = family.entry;
  if (!existsSync(join(REPO, entryFile))) {
    rewriteProblems.push(`${prefix}: the entry point ${entryFile} does not exist`);
    continue;
  }
  for (const pattern of Object.keys(family.routes ?? {})) {
    // A '*' pattern is written as ':id' in the rewrite source.
    const source = pattern.replace(/\/\*$/, '/:id');
    if (!rewriteSources.has(source)) {
      rewriteProblems.push(`${pattern}: no rewrite from ${source} to ${entryFile}`);
      continue;
    }
    const rule = rewrites.find((r) => r.source === source);
    const expected = `?__imk_route=${pattern.replace(/\/\*$/, '/:id')}`;
    if (!String(rule.destination || '').startsWith(`/${entryFile.replace(/\.ts$/, '')}${expected}`)) {
      rewriteProblems.push(
        `${pattern}: the rewrite ${source} -> ${rule.destination} does not carry the original path in __imk_route`,
      );
    }
  }
}

for (const rule of rewrites) {
  const source = String(rule.source || '');
  if (!source.startsWith('/api/')) {
    rewriteProblems.push(`${source}: a rewrite outside /api/ is not part of the route table`);
  }
}

if (rewriteProblems.length > 0) {
  console.error('');
  console.error('[check-api-routes] FAILED: the rewrites and the route table disagree.');
  for (const problem of rewriteProblems) console.error(`[check-api-routes]   ${problem}`);
  process.exit(1);
}
console.log(
  `[check-api-routes] ${rewrites.length} rewrite(s) agree with the route table (${Object.keys(TABLE.families).length} families)`,
);

/* --------------------- the entry points must be able to serve the table */

// The route table says which handler serves which public URL; the entry
// point's HANDLERS map says which handler it actually HAS. The two can
// drift — a route added to the table without the handler added to the map —
// and then the route answers 500 {code:'internal'} at runtime while every
// other check here passes (wave 14, F3).

const handlerProblems = [];

for (const [prefix, family] of Object.entries(TABLE.families ?? {})) {
  const names = handlerNamesIn(family.entry);
  if (names === null) {
    handlerProblems.push(`${prefix}: ${family.entry} has no readable HANDLERS map`);
    continue;
  }
  for (const [pattern, handler] of Object.entries(family.routes ?? {})) {
    if (!names.has(handler)) {
      handlerProblems.push(
        `${pattern}: ${family.entry} cannot serve it — its HANDLERS map has no '${handler}'`,
      );
    }
  }
}

if (handlerProblems.length > 0) {
  console.error('');
  console.error(
    '[check-api-routes] FAILED: the route table names a route the entry point cannot serve.',
  );
  for (const problem of handlerProblems) console.error(`[check-api-routes]   ${problem}`);
  console.error('[check-api-routes] The route table and the entry point\'s HANDLERS map must agree.');
  console.error("[check-api-routes] A route the entry point cannot serve answers 500 {code:'internal'}");
  console.error('[check-api-routes] in production, while this gate would pass.');
  process.exit(1);
}
console.log('[check-api-routes] every route of the table is served by its entry point\'s HANDLERS map');

/* ---------------------------------------------------------------- verdict */

if (missing > 0) {
  console.error('');
  console.error('[check-api-routes] FAILED: a path is called but no function serves it.');
  console.error('[check-api-routes] On Vercel and Cloudflare a function is served at its FILE');
  console.error('[check-api-routes] PATH, or — on Vercel — through a route-table entry point.');
  console.error('[check-api-routes] A missing function means the request answers 404 in');
  console.error('[check-api-routes] production while the local dev server answers 200 — the bug');
  console.error('[check-api-routes] is invisible until deploy.');
  console.error('[check-api-routes]');
  console.error('[check-api-routes] WHAT IS MISSING:');
  for (const row of rows) {
    const vercelMissing = !row.files || !row.files.vercel;
    const cfMissing = !row.files || !row.files.cloudflare;
    if (!vercelMissing && !cfMissing) continue;
    if (row.missingReason) {
      console.error(`[check-api-routes]   ${row.pattern}: ${row.missingReason}`);
    } else if (vercelMissing && cfMissing) {
      console.error(`[check-api-routes]   ${row.pattern}: no function serves it in either tree`);
    } else if (vercelMissing) {
      console.error(`[check-api-routes]   ${row.pattern}: no function serves it on Vercel`);
    } else {
      console.error(`[check-api-routes]   ${row.pattern}: no function serves it on Cloudflare`);
    }
  }
  process.exit(1);
}

console.log(
  '[check-api-routes] OK: every called path has a function file (or a route-table entry point) in both trees.',
);
