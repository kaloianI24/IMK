// site/qa/handler-paths.mjs
//
// WHERE THE CODE UNDER TEST LIVES (QA wave-13 re-pin).
//
// WHY THIS FILE EXISTS
//   Wave 13 moved the handler bodies out of api/ and into
//   site/shared/portal-handlers/, so that api/ holds seven Vercel functions
//   instead of nineteen (the Hobby plan caps a deployment at twelve). Every
//   QA suite used to name the file it exercised with a hard-coded string
//   ('api/portal/projects.ts'), so the move broke thirteen suites at once.
//
//   Instead of hard-coding the new paths in thirteen places (which would drift
//   again on the next move), the suites resolve the file from the PRODUCT'S
//   OWN route table: site/shared/portal-routes.json. One table, three
//   consumers (the two entry points, the route check, the dev server) — and
//   now the QA suites too. A move is a one-line change in the table.
//
//   FAIL LOUDLY. A name the table does not know, or a file that is not there,
//   throws with the file it looked for. A silent fallback would make a suite
//   measure nothing while still reporting PASS, which is worse than a red
//   suite.
//
// THE ROOTS
//   A suite that runs against a PATCHED COPY of the tree (a mutation probe)
//   points its roots at the copy: `roots.apiDir` and `roots.sharedDir`. The
//   repo-relative path from the table is re-anchored onto those roots, so the
//   patched copy is measured and the repo is never touched.
//
// WHAT THIS IS NOT
//   This module does not decide WHAT to test. It only says WHERE the code is.
//   Every assertion in every suite stays exactly as it was — a re-pin moves
//   the pin, it never weakens the check.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const SITE = path.resolve(__dirname, '..');
export const REPO = path.resolve(SITE, '..');

const TABLE_FILE = path.join(SITE, 'shared', 'portal-routes.json');

let table = null;

/** The product's route table (parsed once). Throws if it is not there. */
export function routeTable() {
  if (!table) {
    if (!fs.existsSync(TABLE_FILE)) {
      throw new Error(`[qa] the route table is missing: ${TABLE_FILE}`);
    }
    table = JSON.parse(fs.readFileSync(TABLE_FILE, 'utf8'));
  }
  return table;
}

/**
 * The repo-relative path of a handler module, e.g.
 *   handlerFile('portal-projects') -> 'site/shared/portal-handlers/portal-projects.ts'
 *
 * @throws when the table does not name the module.
 */
export function handlerFile(name) {
  const rel = routeTable().handlers?.[name];
  if (!rel) {
    const known = Object.keys(routeTable().handlers ?? {}).sort().join(', ');
    throw new Error(
      `[qa] the route table does not name a handler module "${name}" (known: ${known})`,
    );
  }
  return rel.split(path.sep).join('/');
}

/**
 * The repo-relative path of a shared server utility, e.g.
 *   serverFile('rate-limit') -> 'site/shared/server/rate-limit.ts'
 */
export function serverFile(name) {
  return `site/shared/server/${name}.ts`;
}

/**
 * The repo-relative path of a STANDALONE public URL's own function file, e.g.
 *   standaloneEntry('/api/portal/auth/verify') -> 'api/portal/auth/verify.ts'
 */
export function standaloneEntry(publicPath) {
  const entry = routeTable().standalone?.[publicPath]?.entry;
  if (!entry) {
    const known = Object.keys(routeTable().standalone ?? {}).sort().join(', ');
    throw new Error(
      `[qa] the route table does not name a standalone entry for "${publicPath}" (known: ${known})`,
    );
  }
  return entry.split(path.sep).join('/');
}

/**
 * The repo-relative path of a route FAMILY's entry point, e.g.
 *   familyEntry('/api/portal') -> 'api/portal.ts'
 */
export function familyEntry(prefix) {
  const entry = routeTable().families?.[prefix]?.entry;
  if (!entry) {
    const known = Object.keys(routeTable().families ?? {}).sort().join(', ');
    throw new Error(
      `[qa] the route table does not name a family entry for "${prefix}" (known: ${known})`,
    );
  }
  return entry.split(path.sep).join('/');
}

/**
 * Re-anchor a repo-relative path onto the roots a suite measures.
 *
 *   'api/...'            -> <apiDir>/...
 *   'site/shared/...'    -> <sharedDir>/...
 *   anything else        -> <REPO>/...
 *
 * @param rel   a repo-relative POSIX path
 * @param roots { apiDir, sharedDir } — the roots of the tree under test
 */
export function anchor(rel, roots = {}) {
  const apiDir = roots.apiDir || path.join(REPO, 'api');
  const sharedDir = roots.sharedDir || path.join(SITE, 'shared');
  const posix = rel.split(path.sep).join('/');
  if (posix.startsWith('api/')) {
    return path.join(apiDir, ...posix.slice('api/'.length).split('/'));
  }
  if (posix.startsWith('site/shared/')) {
    return path.join(sharedDir, ...posix.slice('site/shared/'.length).split('/'));
  }
  return path.join(REPO, ...posix.split('/'));
}

/**
 * The absolute path of a handler module, honouring the roots under test.
 * Throws when the file is not there — a missing file is a FAIL, never a skip.
 */
export function handlerPath(name, roots = {}) {
  const abs = anchor(handlerFile(name), roots);
  if (!fs.existsSync(abs)) {
    throw new Error(`[qa] the handler module "${name}" is not there: ${abs}`);
  }
  return abs;
}

/** The absolute path of a shared server utility, honouring the roots. */
export function serverPath(name, roots = {}) {
  const abs = anchor(serverFile(name), roots);
  if (!fs.existsSync(abs)) {
    throw new Error(`[qa] the shared server file "${name}" is not there: ${abs}`);
  }
  return abs;
}

/** The absolute path of a standalone public URL's own function file. */
export function standalonePath(publicPath, roots = {}) {
  const abs = anchor(standaloneEntry(publicPath), roots);
  if (!fs.existsSync(abs)) {
    throw new Error(`[qa] the standalone entry for "${publicPath}" is not there: ${abs}`);
  }
  return abs;
}

/** The absolute path of a family entry point. */
export function familyPath(prefix, roots = {}) {
  const abs = anchor(familyEntry(prefix), roots);
  if (!fs.existsSync(abs)) {
    throw new Error(`[qa] the family entry for "${prefix}" is not there: ${abs}`);
  }
  return abs;
}

/** A POSIX path, for an esbuild entry string. */
export function fwd(abs) {
  return abs.split(path.sep).join('/');
}
