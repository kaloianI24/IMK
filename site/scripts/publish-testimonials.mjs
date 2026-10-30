// scripts/publish-testimonials.mjs — prebuild script (T7.3)
//
// Runs from `site/` (npm prebuild). Reads the moderation log FROM THE PORTAL
// STORE, finds the records with state === 'approved', and writes them into
// src/content/testimonials/{ref}.md so Astro's content layer can render them
// via Testimonials.astro.
//
// THE STORE, NOT A FILE (wave 9)
//   The publisher used to read data/moderation/reviews.jsonl directly. It now
//   reads the store, exactly like the handlers do:
//
//     PORTAL_STORE=file    -> the JSONL file (the file adapter's view of the
//                             store). The same file, the same records.
//     PORTAL_STORE=libsql  -> the database, over the libSQL HTTP v2 pipeline.
//
//   A build that cannot reach the store FAILS LOUDLY (exit 1). A build that
//   published an empty testimonials page would look like a successful deploy
//   while the owner's quotes quietly disappeared (spec §3.7).
//
// A MISSING STORE IS NOT AN EMPTY STORE (wave 10, F-1)
//   The old publisher answered "empty" for every kind of trouble:
//
//     - a store file that was not there      -> []
//     - a database whose schema was not there -> []
//
//   and then it DELETED every published *.md before writing the (empty) new
//   set. A build that could not read the store therefore DESTROYED the
//   published quotes and reported success ("written": 0).
//
//   Now:
//     - a store that cannot be read            -> exit 1
//     - a database whose schema is missing     -> the schema is created and
//                                                the store is read again; if
//                                                the log is still not there,
//                                                exit 1
//     - a store that is there and is EMPTY     -> exit 0, nothing published
//
//   and the published directory is only touched AFTER the new set is known
//   and complete: the new set is built in a staging directory and swapped in.
//   A failed run leaves the published directory EXACTLY as it was.
//
// AN EMPTY STORE IS NOT AN EMPTY PUBLISH SET (wave 11)
//   Wave 10 closed the MISSING store. An EMPTY store — one that IS there, can
//   BE read, and holds no records at all — was still fatal by accident: the
//   publisher read zero records, built an empty file list and swapped it in,
//   which DELETED every published quote and reported success ("written": 0).
//   The database path had the same hole one run later: the first run created
//   the schema and refused, the second run found the schema, read zero rows
//   and deleted the published quotes. Same store state, opposite outcome, one
//   run apart.
//
//   Now, in BOTH modes (the file store and the database):
//     - zero records + published quotes exist -> exit 1, and the published
//                                                directory is left EXACTLY as
//                                                it was
//     - zero records + nothing published      -> exit 0, nothing published
//                                                (a fresh install must still
//                                                build)
//
// CONSENT IS ENFORCED HERE, AT PUBLISH TIME (spec RP-6) — not at approval time:
//   - a record without consent.p1 === true is never written (RP-6.1 / E15)
//   - consent.p2 === false publishes the quote anonymously: no name, no company,
//     and no badge that identifies them (RP-6.2 / RP-5.3)
//   - consent.p3 only unlocks a case study; it never affects the quote (RP-6.3)
//   - the CURRENT consent state is read on every build, so a withdrawal between
//     approval and build removes the item (RP-6.4)
//   - a revoked record is excluded and its published file disappears on the
//     next build (RP-6.5)
//
// The published `verified` flag is derived from the server-side
// `verifiedClient` field — never from anything the submitter sent (RP-5.1).
//
// Safe to run when the store is empty AND nothing is published (writes
// nothing). An empty store while published quotes exist is REFUSED (wave 11):
// it is the shape of a store this build cannot see, and mirroring it would
// delete the published quotes.
// Idempotent: the published directory is replaced with the approved records,
// so rejected/removed reviews never linger as published content.
//
// Runs automatically before `astro build` via the `prebuild` script in package.json.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.cwd();
const TESTIMONIALS_DIR = path.join(ROOT, 'src/content/testimonials');

/**
 * The data root of the portal store.
 *
 * PORTAL_DATA_DIR wins (the store honours it too). Without it the publisher
 * looks for the data directory next to the package it runs in: `data/` when
 * it runs from site/ (the normal case), `site/data/` when it runs from the
 * repository root.
 */
export function resolveDataDir(env = process.env) {
  if (env.PORTAL_DATA_DIR) return path.resolve(env.PORTAL_DATA_DIR);
  const candidates = [path.join(ROOT, 'data'), path.join(ROOT, 'site', 'data')];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return candidates[0];
}

/** JSON string literals are valid YAML double-quoted scalars — safest escape. */
function yamlString(value) {
  return JSON.stringify(String(value ?? '').replace(/[\r\n]+/g, ' ').trim());
}

function clampRating(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  const rounded = Math.round(n);
  return rounded >= 1 && rounded <= 5 ? rounded : undefined;
}

function consentOf(record) {
  const raw = record && typeof record.consent === 'object' && record.consent !== null ? record.consent : {};
  return {
    p1: raw.p1 === true,
    p2: raw.p2 === true,
    p3: raw.p3 === true,
    displayName: typeof raw.displayName === 'string' ? raw.displayName.trim() : '',
  };
}

function isRevoked(record) {
  return (
    record.state === 'revoked' ||
    record.revoked === true ||
    (record.consent && typeof record.consent === 'object' && record.consent.revoked === true)
  );
}

/** Later lines win — a record updated in place keeps its latest consent state. */
function latestByRef(records) {
  const byRef = new Map();
  let anon = 0;
  for (const record of records) {
    if (!record || record.type !== 'review') continue;
    const ref = typeof record.ref === 'string' && record.ref.trim() ? record.ref.trim() : `anonymous_${anon++}`;
    byRef.set(ref, record);
  }
  return [...byRef.values()];
}

function safeFileName(ref) {
  const cleaned = String(ref ?? '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || 'testimonial';
}

/**
 * Astro's content layer caches collection entries in a data store. When a
 * published testimonial is deleted — consent withdrawn, record revoked — the
 * cached entry survives and the quote keeps rendering on the site. That breaks
 * the promise that a withdrawal removes the quote on the next build
 * (spec RP-6.4 / RP-6.5).
 *
 * The store is a cache: dropping it costs one re-sync of the content
 * collections and guarantees the site shows exactly what is on disk.
 */
function clearAstroContentCache() {
  const candidates = [
    path.join(ROOT, 'node_modules', '.astro', 'data-store.json'),
    path.join(ROOT, '.astro', 'data-store.json'),
  ];
  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) fs.rmSync(file, { force: true });
    } catch {
      // A cache we cannot clear is not a reason to fail the build.
    }
  }
}

/**
 * Build the markdown file body for one approved record, or null when the
 * record must not be published.
 */
function toMarkdown(record) {
  const consent = consentOf(record);
  const quote = String(record.review ?? record.quote ?? '').trim();
  if (!quote) return null;

  // RP-6.2 / RP-5.3 — without P2 the quote publishes anonymously: no name, no
  // company, and no badge that identifies the client.
  const nameMe = consent.p2;
  const name = nameMe ? consent.displayName || String(record.name ?? '').trim() : '';
  const company = nameMe ? String(record.company ?? '').trim() : '';
  // RP-8.4 — `role` comes from its own record field; it is never copied from company.
  const role = nameMe ? String(record.role ?? '').trim() : '';
  const rating = clampRating(record.rating);
  // RP-5.1 — derived server-side, and only while the client is identified.
  const verified = record.verifiedClient === true && nameMe;
  const source = record.source === 'public' ? 'public' : 'portal';

  const lines = [
    '---',
    `quote: ${yamlString(quote)}`,
    `verified: ${verified}`,
    `source: ${yamlString(source)}`,
  ];
  if (name) lines.push(`name: ${yamlString(name)}`);
  if (company) lines.push(`company: ${yamlString(company)}`);
  if (role) lines.push(`role: ${yamlString(role)}`);
  if (rating !== undefined) lines.push(`rating: ${rating}`);
  lines.push('---', '', quote, '');

  return lines.join('\n');
}

/**
 * The store is NOT THERE.
 *
 * A store that cannot be READ (a corrupt file, a database that is down) is
 * always fatal. A store that is ABSENT is a different case: it is the state
 * of a fresh install, and it only becomes dangerous when there is something
 * to lose — the published quotes would be replaced by an empty set.
 */
class MissingStoreError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MissingStoreError';
    this.storeMissing = true;
  }
}

/**
 * The store is THERE, it can be READ, and it holds NOTHING.
 *
 * A different condition from a missing store, and a different danger: the
 * publisher mirrors the store, so mirroring an empty store over a non-empty
 * published set deletes every published quote. The refusal says exactly that.
 */
class EmptyStoreError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EmptyStoreError';
    this.storeEmpty = true;
  }
}

/**
 * The published quotes that are there right now.
 *
 * The publisher's job is to make the published set mirror the store. When
 * the store is absent AND the published set is empty, the mirror is already
 * the truth: there is nothing to publish and nothing to lose — a fresh
 * install must still build (QA BUILD-14). When the published set is NOT
 * empty, the store being absent is fatal: the build stops and the published
 * quotes are left exactly as they are.
 */
function publishedQuoteNames() {
  try {
    if (!fs.existsSync(TESTIMONIALS_DIR)) return [];
    return fs.readdirSync(TESTIMONIALS_DIR).filter((entry) => entry.endsWith('.md'));
  } catch {
    return [];
  }
}

/**
 * AN EMPTY STORE IS NOT AN EMPTY PUBLISH SET (wave 11, extended by wave 12).
 *
 * The store can be there, readable, and hold NOTHING. That is not the same as
 * "there is nothing to publish" — it is the same shape as a store this build
 * cannot see, and the publisher's job is to MIRROR the store. Mirroring an
 * empty store over a non-empty published set deletes every published quote
 * and reports success ("written": 0): a silent data loss that looks like a
 * clean build.
 *
 * The rule:
 *   - zero REVIEW records + published quotes exist -> FATAL (exit 1, the
 *     published directory is not touched at all)
 *   - zero REVIEW records + nothing published      -> exit 0, publish nothing
 *     (that is a fresh install, and a fresh install must still build)
 *
 * WAVE 12, B-4: the rule counts REVIEW records, not records. A store that
 * holds records but NONE of them is a review record (a leftover of another
 * kind) has exactly the same shape as an empty store as far as the published
 * set is concerned: mirroring it empties the published directory and reports
 * success. The data-loss class wave 11 closed is therefore closed for that
 * case too.
 *
 * A store that holds review records is NOT this case: a quote that was
 * revoked, declined or withheld still leaves a review record behind, and the
 * published set is then legitimately smaller (A5).
 *
 * This is a SEPARATE code path on purpose: the malformed-line handling above
 * must stay byte-identical (QA's mutation probe patches it by exact match).
 */
function assertStoreIsNotEmpty(records) {
  const reviews = records.filter((record) => record && record.type === 'review');
  const published = publishedQuoteNames();
  if (reviews.length > 0 || published.length === 0) return;
  throw new EmptyStoreError(
    'the portal store holds NO review records, but ' +
      `${published.length} published testimonial(s) exist. ` +
      'An empty store must never replace a published set — refusing to publish an empty set of ' +
      'testimonials. Check that the build reads the right store (PORTAL_STORE / PORTAL_DATA_DIR) ' +
      'before publishing again.',
  );
}

/**
 * Read the moderation log FROM THE FILE (the file adapter's view).
 *
 * A malformed line is NOT skipped: it makes the whole publish refuse to run
 * (audit m2). Skipping it silently deleted the record from the published set
 * — a quote the owner had approved simply vanished from the site, with
 * nothing in the build output to say so. Refusing is the only safe answer:
 * the store is small, hand-edited sometimes, and a broken line is an operator
 * problem that must be seen.
 *
 * A MISSING FILE IS ALSO AN ERROR (wave 10, F-1). The old publisher answered
 * "no reviews" for a file that was not there — and then deleted every
 * published quote. A store that is not there is a store this deployment
 * cannot serve: the build must stop, with the published set untouched.
 */
function readReviewsFromFile(dataDir) {
  const file = path.join(dataDir, 'moderation', 'reviews.jsonl');
  if (!fs.existsSync(file)) {
    throw new MissingStoreError(
      `${file} does not exist — the moderation store is not there. ` +
        'Refusing to publish a partial set of testimonials.',
    );
  }
  // Strip a UTF-8 BOM — a hand-edited store (Notepad) would otherwise lose
  // its first record.
  const content = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const records = [];
  content.split('\n').forEach((line, index) => {
    if (line.trim() === '') return;
    try {
      records.push(JSON.parse(line));
    } catch {
      throw new Error(
        `${file} line ${index + 1} is not valid JSON — ` +
          'refusing to publish a partial set of testimonials. Fix or remove that line.',
      );
    }
  });
  return records;
}

/**
 * THE SCHEMA — a copy of site/shared/portal-store/libsql-schema.ts.
 *
 * The publisher is plain JavaScript and runs in the prebuild step, where the
 * TypeScript store cannot be imported without a build step of its own — so
 * the DDL is duplicated here.
 *
 * THE DUPLICATION CANNOT DRIFT: backend-wave10-store-integrity-harness.mjs
 * compares this list with the DDL of libsql-schema.ts, statement by
 * statement, and fails when they differ. Every statement below is therefore
 * byte-identical to its counterpart there.
 */
export const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS portal_projects (
     seq        INTEGER PRIMARY KEY AUTOINCREMENT,
     id         TEXT,
     client_id  TEXT,
     status     TEXT,
     data       TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS portal_projects_id     ON portal_projects(id)`,
  `CREATE INDEX IF NOT EXISTS portal_projects_client ON portal_projects(client_id)`,

  `CREATE TABLE IF NOT EXISTS portal_clients (
     seq        INTEGER PRIMARY KEY AUTOINCREMENT,
     id         TEXT,
     email      TEXT,
     data       TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS portal_clients_id    ON portal_clients(id)`,
  `CREATE INDEX IF NOT EXISTS portal_clients_email ON portal_clients(email)`,

  `CREATE TABLE IF NOT EXISTS portal_invites (
     seq        INTEGER PRIMARY KEY AUTOINCREMENT,
     email      TEXT,
     client_id  TEXT,
     data       TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS portal_invites_email  ON portal_invites(email)`,
  `CREATE INDEX IF NOT EXISTS portal_invites_client ON portal_invites(client_id)`,

  `CREATE TABLE IF NOT EXISTS portal_comments (
     seq        INTEGER PRIMARY KEY AUTOINCREMENT,
     id         TEXT,
     project_id TEXT,
     data       TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS portal_comments_id      ON portal_comments(id)`,
  `CREATE INDEX IF NOT EXISTS portal_comments_project ON portal_comments(project_id)`,

  `CREATE TABLE IF NOT EXISTS portal_plan_items (
     seq        INTEGER PRIMARY KEY AUTOINCREMENT,
     id         TEXT,
     project_id TEXT,
     data       TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS portal_plan_items_id      ON portal_plan_items(id)`,
  `CREATE INDEX IF NOT EXISTS portal_plan_items_project ON portal_plan_items(project_id)`,

  `CREATE TABLE IF NOT EXISTS portal_updates (
     seq        INTEGER PRIMARY KEY AUTOINCREMENT,
     id         TEXT,
     project_id TEXT,
     data       TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS portal_updates_id      ON portal_updates(id)`,
  `CREATE INDEX IF NOT EXISTS portal_updates_project ON portal_updates(project_id)`,

  // The moderation revision log. `seq` is the append order (the file order),
  // `revision` is the client's revision counter (site/shared/portal-handlers/portal-testimonials.ts).
  `CREATE TABLE IF NOT EXISTS moderation_reviews (
     seq        INTEGER PRIMARY KEY AUTOINCREMENT,
     ref        TEXT,
     revision   INTEGER,
     type       TEXT,
     state      TEXT,
     project_id TEXT,
     data       TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS moderation_reviews_ref    ON moderation_reviews(ref, seq DESC)`,
  `CREATE INDEX IF NOT EXISTS moderation_reviews_state  ON moderation_reviews(state, seq DESC)`,
  `CREATE INDEX IF NOT EXISTS moderation_reviews_project ON moderation_reviews(project_id)`,

  `CREATE TABLE IF NOT EXISTS portal_sessions (
     seq        INTEGER PRIMARY KEY AUTOINCREMENT,
     token      TEXT,
     expires_at INTEGER,
     data       TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS portal_sessions_token ON portal_sessions(token)`,

  // The shared durable rate counter (durable-rate-counter.ts).
  `CREATE TABLE IF NOT EXISTS rate_counters (
     bucket    TEXT PRIMARY KEY,
     reset_at  INTEGER NOT NULL,
     count     INTEGER NOT NULL DEFAULT 0
   )`,
];

/**
 * One pipeline round trip against the libSQL HTTP v2 endpoint.
 *
 * The BATON is followed to the end (wave 10, F-4): a page that carries a
 * baton is not the whole answer, and a client that ignores it drops the
 * results that did not fit on the first page.
 */
async function pipeline(endpoint, token, requests) {
  let baton = null;
  const collected = [];
  for (let page = 0; page < 100; page++) {
    const body = baton === null ? { baton: null, requests } : { baton, requests: [] };

    let response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new Error(
        `the portal store is unreachable (${err && err.message ? err.message : String(err)}) — ` +
          'refusing to publish a partial set of testimonials.',
      );
    }

    if (!response.ok) {
      throw new Error(
        `the portal store answered HTTP ${response.status} — ` +
          'refusing to publish a partial set of testimonials.',
      );
    }

    let answer;
    try {
      answer = await response.json();
    } catch {
      throw new Error(
        'the portal store did not answer with JSON — ' +
          'refusing to publish a partial set of testimonials.',
      );
    }

    const results = Array.isArray(answer && answer.results) ? answer.results : null;
    if (!results) {
      throw new Error(
        'the portal store answer had no results array — ' +
          'refusing to publish a partial set of testimonials.',
      );
    }
    collected.push(...results);

    const next = typeof answer.baton === 'string' && answer.baton ? answer.baton : null;
    if (!next) return collected;
    baton = next;
  }
  throw new Error(
    'the portal store sent more than 100 pages for one pipeline — ' +
      'refusing to publish a partial set of testimonials.',
  );
}

/** The one statement that reads the moderation log. */
const READ_REVIEWS_SQL = 'SELECT data FROM moderation_reviews ORDER BY seq ASC';

/**
 * Create the schema of a database that does not have it yet.
 *
 * The DDL is idempotent (CREATE ... IF NOT EXISTS), so it is safe to run
 * against a database that already has it.
 */
async function createSchema(endpoint, token) {
  const requests = SCHEMA_STATEMENTS.map((sql) => ({ type: 'execute', stmt: { sql, args: [] } }));
  requests.push({ type: 'close' });
  const results = await pipeline(endpoint, token, requests);
  for (const result of results) {
    if (result && result.type === 'error') {
      const message = String((result.error && result.error.message) || 'unknown database error');
      throw new Error(
        `the portal store refused the schema (${message}) — ` +
          'refusing to publish a partial set of testimonials.',
      );
    }
  }
}

/**
 * Read the moderation log FROM THE DATABASE (the libSQL adapter's view).
 *
 * The wire format is the libSQL HTTP v2 pipeline API — the same one the
 * handlers use (site/shared/portal-store/libsql-transport.ts). This script is
 * plain JavaScript on purpose: it runs in the prebuild step, where the
 * TypeScript store cannot be imported without a build step of its own.
 *
 * THE TRAP (the reason this function exists): a failed statement comes back
 * as { "type": "error" } INSIDE results[] while the HTTP status is still
 * 200. A reader that only looks at the status code would treat a broken
 * query as an empty store and publish an empty testimonials page. So the
 * results are inspected, and an error is an error.
 *
 * A MISSING SCHEMA IS NOT AN EMPTY STORE (wave 10, F-1): the schema is
 * created (idempotently) and the log is read again. If the log is still not
 * there, the publish refuses — a database that never held a moderation log
 * must not silently empty the published quotes.
 *
 * The token is never echoed: not in the error, not in the log.
 */
async function readReviewsFromDatabase(env) {
  const url = String(env.LIBSQL_URL || '').trim();
  const token = String(env.LIBSQL_TOKEN || '').trim();
  if (!url) {
    throw new Error(
      'PORTAL_STORE=libsql requires LIBSQL_URL (the libSQL/Turso database URL) — ' +
        'refusing to publish a partial set of testimonials.',
    );
  }
  if (!token) {
    throw new Error(
      'PORTAL_STORE=libsql requires LIBSQL_TOKEN (the database auth token) — ' +
        'refusing to publish a partial set of testimonials.',
    );
  }
  const base = url.replace(/\/+$/, '');
  const endpoint = /\/v2\/pipeline$/.test(base) ? base : `${base}/v2/pipeline`;

  const read = async () => {
    const results = await pipeline(endpoint, token, [
      { type: 'execute', stmt: { sql: READ_REVIEWS_SQL, args: [] } },
      { type: 'close' },
    ]);

    const first = results[0];
    if (!first || first.type === 'error') {
      const message = String(
        (first && first.error && first.error.message) || 'unknown database error',
      );
      const error = new Error(message);
      error.libsql = true;
      throw error;
    }

    const rows = (first.response && first.response.result && first.response.result.rows) || [];
    return rows.map((row) => {
      const raw = row && row[0];
      const text = raw && typeof raw === 'object' ? raw.value : raw;
      if (typeof text !== 'string') {
        throw new Error(
          'the portal store holds a record that is not JSON — ' +
            'refusing to publish a partial set of testimonials.',
        );
      }
      try {
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('not a JSON object');
        }
        return parsed;
      } catch {
        throw new Error(
          'the portal store holds a record that is not JSON — ' +
            'refusing to publish a partial set of testimonials.',
        );
      }
    });
  };

  let records;
  try {
    records = await read();
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    if (!/no such table/i.test(message)) {
      throw new Error(
        `the portal store refused the query (${message}) — ` +
          'refusing to publish a partial set of testimonials.',
      );
    }

    // THE SCHEMA IS MISSING. That is not an empty store: the database has
    // never held a moderation log. The schema is created (idempotently) and
    // the log is read again.
    await createSchema(endpoint, token);

    try {
      records = await read();
    } catch (second) {
      const secondMessage = second && second.message ? second.message : String(second);
      throw new Error(
        `the portal store has no moderation log (${secondMessage}) — ` +
          'refusing to publish a partial set of testimonials.',
      );
    }

    throw new MissingStoreError(
      'the portal store had NO SCHEMA (the moderation log did not exist). ' +
        'The schema has been created, but a store that never held a moderation log ' +
        'must not empty the published quotes — refusing to publish an empty set of ' +
        'testimonials. If this is the right database, publish again.',
    );
  }

  return records;
}

/**
 * The moderation log, from whichever backend this deployment uses.
 *
 * This is the publisher's whole view of the store. It throws when the store
 * cannot be reached or cannot be read: the build must fail loudly rather than
 * publish an empty testimonials page.
 *
 * THE ONE EXCEPTION is a store that is ABSENT while there is nothing
 * published yet: that is a fresh install, and the site must still build
 * (the empty state it would publish is already the truth). As soon as there
 * are published quotes, an absent store is fatal — the build stops and the
 * published directory is left exactly as it is.
 *
 * The same rule, one step further (wave 11): a store that is THERE and
 * readable but holds NO records is fatal as soon as there are published
 * quotes. An empty store is not an empty publish set — mirroring it would
 * delete the published quotes and report success.
 */
export async function readReviewsFromStore(env = process.env) {
  let records = null;
  try {
    const mode = String(env.PORTAL_STORE || 'file').trim();
    if (mode === 'libsql') {
      records = await readReviewsFromDatabase(env);
    } else {
      records = readReviewsFromFile(resolveDataDir(env));
    }
  } catch (err) {
    if (err && err.storeMissing === true && publishedQuoteNames().length === 0) {
      console.log(
        JSON.stringify({
          ts: Date.now(),
          outcome: 'no_store_nothing_published',
          dir: TESTIMONIALS_DIR,
        }),
      );
      records = [];
    } else {
      throw err;
    }
  }

  // AN EMPTY STORE IS NOT AN EMPTY PUBLISH SET (wave 11). The store was
  // readable and held nothing: if there is a published set, that is the shape
  // of a store this build cannot see, and mirroring it would delete the
  // published quotes. Refuse instead. With nothing published, an empty store
  // is a fresh install — it still builds.
  assertStoreIsNotEmpty(records);

  return records;
}

/**
 * The millisecond stamp inside a swap directory name (`<pid>-<ms>`).
 *
 * The name is built as `<pid>-<Date.now()>`, so the stamp is the LAST part.
 * It is what orders two leftovers by age: the newest one is the set that was
 * published last.
 */
function swapStamp(name) {
  const tail = name.slice('.testimonials-previous-'.length);
  const ms = Number(tail.split('-').pop());
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Restore the published set after a crash in the middle of the swap
 * (wave 12, B-5).
 *
 * The swap is two renames: the published directory is moved aside
 * (`.testimonials-previous-<pid>-<ts>`) and the new one takes its place. A
 * process that is killed between the two leaves the published directory
 * MISSING — the quotes survive only in the sibling, which nothing ever
 * restored (audit MINOR-1). The build that follows would then publish the
 * site with NO testimonials at all, and report success.
 *
 * This restores the newest such sibling. It is a RECOVERY, not a rollback of
 * the store: the store stays the truth, and the publish that follows
 * rebuilds the set from it. What the recovery buys is that a build which
 * CANNOT publish (a missing store, an empty store) does not leave the site
 * without the quotes the owner approved.
 *
 * It runs FIRST, before the store is read, so even a build that fails
 * afterwards leaves the published set exactly as it was.
 */
function recoverInterruptedSwap() {
  const parent = path.dirname(TESTIMONIALS_DIR);
  if (fs.existsSync(TESTIMONIALS_DIR)) return null;

  let entries;
  try {
    entries = fs.readdirSync(parent);
  } catch {
    return null;
  }

  const leftovers = entries
    .filter((entry) => entry.startsWith('.testimonials-previous-'))
    .map((entry) => ({ entry, stamp: swapStamp(entry) }))
    .sort((a, b) => a.stamp - b.stamp);
  if (leftovers.length === 0) return null;

  const newest = leftovers[leftovers.length - 1];
  try {
    fs.renameSync(path.join(parent, newest.entry), TESTIMONIALS_DIR);
  } catch (err) {
    console.log(
      JSON.stringify({
        ts: Date.now(),
        outcome: 'testimonials_swap_recovery_failed',
        previous: newest.entry,
        error: String(err && err.message ? err.message : err),
      }),
    );
    return null;
  }

  // The staging directories of the crashed run are garbage: an incomplete
  // set. The store is the truth, so they are removed rather than kept.
  for (const entry of entries) {
    if (!entry.startsWith('.testimonials-publish-')) continue;
    try {
      fs.rmSync(path.join(parent, entry), { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }

  return newest.entry;
}

/**
 * Swap the published directory for the new set.
 *
 * The new set is built in a staging directory FIRST: the published
 * directory is not touched until the whole set is known and written. The
 * swap itself is two renames (the old directory is moved aside, the new one
 * takes its place), and a failure restores the old directory — so a failed
 * publish leaves the published quotes EXACTLY as they were.
 *
 * A process that is KILLED between the two renames cannot restore anything
 * itself: the published directory is simply gone. recoverInterruptedSwap()
 * puts it back on the next run.
 *
 * The staging directory is a SIBLING of the published directory, not a child
 * of it: Astro's content loader globs every markdown file inside the
 * published directory, and a staging directory inside it would be picked up
 * as published content.
 */
function swapIn(files) {
  const parent = path.dirname(TESTIMONIALS_DIR);
  const stamp = `${process.pid}-${Date.now()}`;
  const staging = path.join(parent, `.testimonials-publish-${stamp}`);
  const previous = path.join(parent, `.testimonials-previous-${stamp}`);

  fs.mkdirSync(staging, { recursive: true });
  try {
    for (const file of files) {
      fs.writeFileSync(path.join(staging, file.name), file.body, 'utf8');
    }

    // A file that is not a published quote is not ours to delete: it is
    // carried over into the new directory.
    if (fs.existsSync(TESTIMONIALS_DIR)) {
      for (const entry of fs.readdirSync(TESTIMONIALS_DIR)) {
        if (entry.endsWith('.md')) continue;
        fs.copyFileSync(path.join(TESTIMONIALS_DIR, entry), path.join(staging, entry));
      }
    }

    const hadPrevious = fs.existsSync(TESTIMONIALS_DIR);
    if (hadPrevious) fs.renameSync(TESTIMONIALS_DIR, previous);
    try {
      fs.renameSync(staging, TESTIMONIALS_DIR);
    } catch (err) {
      // The published directory must be EXACTLY as it was.
      if (hadPrevious && fs.existsSync(previous) && !fs.existsSync(TESTIMONIALS_DIR)) {
        fs.renameSync(previous, TESTIMONIALS_DIR);
      }
      throw err;
    }
    if (hadPrevious) fs.rmSync(previous, { recursive: true, force: true });
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

async function main() {
  const reviews = await readReviewsFromStore();
  const current = latestByRef(reviews);

  let revoked = 0;
  let noConsent = 0;
  let noQuote = 0;

  // The set that will be published — built BEFORE the published directory is
  // touched.
  const files = [];
  for (const record of current) {
    if (record.state !== 'approved') continue;
    if (isRevoked(record)) {
      revoked++;
      continue;
    }
    // RP-6.1 — approval alone is not enough; the client must have consented.
    if (!consentOf(record).p1) {
      noConsent++;
      continue;
    }
    const markdown = toMarkdown(record);
    if (!markdown) {
      noQuote++;
      continue;
    }
    files.push({ name: `${safeFileName(record.ref)}.md`, body: markdown });
  }

  // The swap: the published directory is replaced with the new set.
  swapIn(files);
  const written = files.length;

  console.log(
    JSON.stringify({
      ts: Date.now(),
      outcome: 'testimonials_published',
      totalReviews: reviews.length,
      currentRecords: current.length,
      approved: current.filter((r) => r.state === 'approved').length,
      written,
      skippedRevoked: revoked,
      skippedNoConsent: noConsent,
      skippedNoQuote: noQuote,
      dir: TESTIMONIALS_DIR,
    }),
  );

  // Run last: the cache must be dropped AFTER the files are written, so the
  // next build re-reads the testimonials from disk.
  clearAstroContentCache();
}

/**
 * Is this module the one the node process was started with?
 *
 * The module exports its SCHEMA_STATEMENTS so that the DDL can be compared
 * with the one of libsql-schema.ts (the harness imports it). Importing it
 * must NOT publish anything, so the publish only runs when the file is the
 * entry point.
 */
function isEntryPoint() {
  try {
    const invoked = path.resolve(process.argv[1] || '').replace(/\\/g, '/').toLowerCase();
    const self = fileURLToPath(import.meta.url).replace(/\\/g, '/').toLowerCase();
    return invoked !== '' && invoked === self;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  try {
    // A CRASH DURING THE SWAP MUST NOT LOSE THE PUBLISHED QUOTES (wave 12, B-5).
    //
    // The recovery runs BEFORE the store is read: a build that then fails (a
    // missing store, an empty store) still leaves the published set exactly
    // as it was, instead of publishing a site with no testimonials.
    const recovered = recoverInterruptedSwap();
    if (recovered) {
      console.log(
        JSON.stringify({
          ts: Date.now(),
          outcome: 'testimonials_swap_recovered',
          dir: TESTIMONIALS_DIR,
          previous: recovered,
        }),
      );
    }
    await main();
  } catch (err) {
    // A loud, clean failure: the build must not continue with a partial set of
    // testimonials.
    console.error(
      `[publish-testimonials] ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }
}
