// site/shared/portal-store/libsql-schema.ts
//
// The libSQL/Turso schema (spec/proposal-wave7-design-2026-10-21.md §3.2).
//
// HOW A RECORD IS STORED
//   Every record is stored WHOLE in a `data` JSON column, so the round trip is
//   exact: what goes in is what comes out, key order included. The typed
//   columns next to it are DERIVED from the same record at write time, so they
//   cannot drift, and they exist only to make the hot lookups indexable.
//
//   `seq` reproduces "the order of the lines in the JSONL file". ORDER BY seq
//   IS the file order, which is what the store contract asserts.
//
// TWO DEVIATIONS FROM THE DRAFT IN THE DESIGN DOC — both deliberate:
//
//   1. The typed columns are NULLABLE and there is NO UNIQUE constraint.
//      The file adapter's append() never rejects a record: two projects with
//      the same id, or a record without an id at all, are both accepted and
//      both readable. A NOT NULL/UNIQUE column would make the libSQL adapter
//      REJECT writes the file adapter accepts — the two adapters would stop
//      being interchangeable, which is the entire point of the PortalStore
//      interface. The typed columns therefore hold exactly what the record
//      holds, including NULL for an absent field.
//
//   2. There are NO DEFAULT values on the typed columns either, for the same
//      reason: a record with no `state` must stay "no state", because
//      decideReview() treats a record whose state is not exactly 'pending' as
//      already decided (file-adapter.ts:224). A DEFAULT 'pending' would make
//      the database flip records the file adapter leaves alone.
//
// The DDL is idempotent (IF NOT EXISTS) and is applied once per store
// instance, in ONE pipeline round trip.

import type { LibsqlTransport } from './libsql-transport.js';

/** Every statement that makes up the schema, in order. */
export const SCHEMA_STATEMENTS: string[] = [
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
 * Create the schema if it is not there yet.
 *
 * One round trip when the transport supports a pipeline, one per statement
 * otherwise. A failure here is a StorageError: a store whose schema is
 * missing must not pretend to be empty.
 */
export async function ensureSchema(transport: LibsqlTransport): Promise<void> {
  const statements = SCHEMA_STATEMENTS.map((sql) => ({ sql }));
  if (typeof transport.executeAll === 'function') {
    await transport.executeAll(statements);
    return;
  }
  for (const statement of statements) {
    await transport.execute(statement.sql);
  }
}
