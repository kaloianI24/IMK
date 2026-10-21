// site/shared/portal-store/libsql-adapter.ts
//
// The `libsql` adapter: the PortalStore interface on top of a libSQL/Turso
// database (task T4, design in spec/proposal-wave7-design-2026-10-21.md §3).
//
// THIS IS THE ANSWER TO "THE PORTAL CANNOT RUN ON VERCEL": a serverless
// function has a read-only filesystem, so the JSONL files under site/data/
// cannot be written by a deployed function. A database can.
//
// FIDELITY RULES (the adapter is only useful if it is interchangeable with
// the file adapter):
//
//   1. ORDER. list() returns the records oldest-first, exactly like the lines
//      of the JSONL file. `seq` IS the file order.
//
//   2. THE EQUALITY FILTER. The file adapter compares with
//      `String(actual) !== String(expected)` (file-adapter.ts:52-63). The SQL
//      below reproduces that EXACTLY, including the number/string coercion
//      and the boolean case — SQLite's json_extract turns `true` into 1 and
//      its CAST would yield '1', while String(true) is 'true'. That is why
//      the predicate is a CASE over json_type() and not a plain CAST.
//
//   3. A MISSING FIELD NEVER MATCHES, and a field that is present but null
//      never matches either (the file adapter: `actual === undefined ||
//      actual === null` -> no match).
//
//   4. THE REVIEWS COLLECTION IS APPEND-ONLY. update() and remove() are
//      refused with `invalid-operation`, exactly like the file adapter
//      (file-adapter.ts:159-166, :180-186), and a decision goes through
//      decideReview().
//
//   5. ONE STATEMENT PER LOGICAL OPERATION, so a write is atomic: a
//      moderation decision is a single UPDATE ... RETURNING and can never be
//      half written.
//
// NO node: IMPORTS: the same file serves the Vercel tree and the Cloudflare
// tree.

import { StorageError } from './errors.js';
import { ensureSchema } from './libsql-schema.js';
import { toSqlArg, type LibsqlTransport, type SqlArg } from './libsql-transport.js';
import type {
  Collection,
  PortalStore,
  ReviewDecision,
  StoreRecord,
  Where,
} from './types.js';

/** A typed column and the record field it is derived from. */
interface ColumnSpec {
  /** The column name in the table. */
  column: string;
  /** The field of the record the column mirrors. */
  field: string;
}

interface CollectionSpec {
  /** The table name. */
  table: string;
  /** The typed columns, derived from the record at write time. */
  columns: ColumnSpec[];
  /**
   * Record field -> column, for the fields a filter may use the index for.
   * Only used when the compared value is a STRING, so the comparison stays
   * identical to the file adapter's (see the predicate builder).
   */
  indexed: Record<string, string>;
}

/**
 * The table and the derived columns of every collection.
 *
 * The field names come from the handlers that write the records:
 *   projects   api/portal/projects.ts:302   { id, clientId, title, status, … }
 *   clients    api/portal/auth.ts:487       { id, email, name, company, … }
 *   invites    api/portal/invites.ts:263    { email, name, company, clientId, … }
 *   comments   api/portal/comments.ts:172   { id, projectId, authorId, … }
 *   planItems  api/portal/plan-items.ts:298 { id, projectId, title, status, order, … }
 *   updates    api/portal/updates.ts:174    { id, projectId, title, body, … }
 *   reviews    api/portal/testimonials.ts:580 { ref, type, state, revision, … }
 *   sessions   portal/sessions.jsonl        { token, expiresAt }
 */
const COLLECTIONS: Record<Collection, CollectionSpec> = {
  projects: {
    table: 'portal_projects',
    columns: [
      { column: 'id', field: 'id' },
      { column: 'client_id', field: 'clientId' },
      { column: 'status', field: 'status' },
    ],
    indexed: { id: 'id', clientId: 'client_id', status: 'status' },
  },
  clients: {
    table: 'portal_clients',
    columns: [
      { column: 'id', field: 'id' },
      { column: 'email', field: 'email' },
    ],
    indexed: { id: 'id', email: 'email' },
  },
  invites: {
    table: 'portal_invites',
    columns: [
      { column: 'email', field: 'email' },
      { column: 'client_id', field: 'clientId' },
    ],
    indexed: { email: 'email', clientId: 'client_id' },
  },
  comments: {
    table: 'portal_comments',
    columns: [
      { column: 'id', field: 'id' },
      { column: 'project_id', field: 'projectId' },
    ],
    indexed: { id: 'id', projectId: 'project_id' },
  },
  planItems: {
    table: 'portal_plan_items',
    columns: [
      { column: 'id', field: 'id' },
      { column: 'project_id', field: 'projectId' },
    ],
    indexed: { id: 'id', projectId: 'project_id' },
  },
  updates: {
    table: 'portal_updates',
    columns: [
      { column: 'id', field: 'id' },
      { column: 'project_id', field: 'projectId' },
    ],
    indexed: { id: 'id', projectId: 'project_id' },
  },
  reviews: {
    table: 'moderation_reviews',
    columns: [
      { column: 'ref', field: 'ref' },
      { column: 'revision', field: 'revision' },
      { column: 'type', field: 'type' },
      { column: 'state', field: 'state' },
      { column: 'project_id', field: 'projectId' },
    ],
    indexed: { ref: 'ref', state: 'state', projectId: 'project_id' },
  },
  sessions: {
    table: 'portal_sessions',
    columns: [
      { column: 'token', field: 'token' },
      { column: 'expires_at', field: 'expiresAt' },
    ],
    indexed: { token: 'token' },
  },
};

/**
 * The JSON path of a record field.
 *
 * The path is always BOUND as a parameter, never inlined: a field name is
 * data, and data must never become SQL.
 */
function jsonPath(field: string): string {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(field)) return `$.${field}`;
  // A quoted key: SQLite's JSON path accepts `$."key with spaces"`.
  return `$."${field.replace(/"/g, '')}"`;
}

/**
 * The text form of a field, as the file adapter would compute it.
 *
 * `String(value)` — the number 42 becomes '42', the boolean true becomes
 * 'true'. This is the right-hand side of every comparison.
 */
function textForm(value: string | number | boolean): string {
  return String(value);
}

/**
 * The predicate for one field, faithful to the file adapter's comparison.
 *
 *   CASE json_type(data, ?)
 *     WHEN 'true'  THEN 'true'        -- SQLite stores a boolean as 1
 *     WHEN 'false' THEN 'false'
 *     WHEN 'real'  THEN CASE WHEN CAST(json_extract(data, ?) AS INTEGER)
 *                                 = json_extract(data, ?)
 *                            THEN CAST(CAST(json_extract(data, ?) AS INTEGER) AS TEXT)
 *                            ELSE CAST(json_extract(data, ?) AS TEXT) END
 *     ELSE CAST(json_extract(data, ?) AS TEXT)
 *   END = ?
 *
 * A missing field: json_type() is NULL -> the CASE falls through to
 * CAST(NULL AS TEXT) -> NULL -> the row is excluded, exactly like the file
 * adapter's `actual === undefined -> no match`.
 *
 * A field that is present but null: json_type() is 'null' -> CAST(NULL AS
 * TEXT) -> excluded, like the file adapter's `actual === null -> no match`.
 */
function jsonPredicate(field: string, expected: string): { sql: string; args: SqlArg[] } {
  const path = (): SqlArg => ({ type: 'text', value: jsonPath(field) });
  const sql =
    'CASE json_type(data, ?)' +
    " WHEN 'true' THEN 'true'" +
    " WHEN 'false' THEN 'false'" +
    " WHEN 'real' THEN CASE WHEN CAST(json_extract(data, ?) AS INTEGER) = json_extract(data, ?)" +
    ' THEN CAST(CAST(json_extract(data, ?) AS INTEGER) AS TEXT)' +
    ' ELSE CAST(json_extract(data, ?) AS TEXT) END' +
    ' ELSE CAST(json_extract(data, ?) AS TEXT) END = ?';
  return {
    sql,
    args: [path(), path(), path(), path(), path(), path(), { type: 'text', value: expected }],
  };
}

/** The predicate for a field whose value is null. */
function nullPredicate(field: string): { sql: string; args: SqlArg[] } {
  return {
    sql: "json_type(data, ?) IS 'null'",
    args: [{ type: 'text', value: jsonPath(field) }],
  };
}

/**
 * Build the WHERE clause for an equality-only filter.
 *
 * `undefined` values are skipped, like the file adapter does
 * (file-adapter.ts:57). A field with an index is compared through its typed
 * column — but only when the compared value is a STRING, because the typed
 * column holds the text form of the record's value, and the file adapter's
 * String() comparison is exact only for that case.
 */
function buildWhere(
  coll: Collection,
  where?: Where,
): { sql: string; args: SqlArg[] } {
  if (!where) return { sql: '', args: [] };
  const spec = COLLECTIONS[coll];
  const parts: string[] = [];
  const args: SqlArg[] = [];

  for (const field of Object.keys(where)) {
    const value = where[field];
    if (value === undefined) continue;

    if (value === null) {
      const predicate = nullPredicate(field);
      parts.push(predicate.sql);
      args.push(...predicate.args);
      continue;
    }

    const column = spec.indexed[field];
    if (column && typeof value === 'string') {
      parts.push(`${column} = ?`);
      args.push({ type: 'text', value });
      continue;
    }

    const predicate = jsonPredicate(field, textForm(value));
    parts.push(predicate.sql);
    args.push(...predicate.args);
  }

  if (parts.length === 0) return { sql: '', args: [] };
  return { sql: ` WHERE ${parts.join(' AND ')}`, args };
}

/** Parse one `data` column. A value we cannot parse is corruption, not data. */
function parseRecord(raw: unknown, table: string): StoreRecord {
  if (typeof raw !== 'string') {
    throw new StorageError(
      `libsql: the ${table} table returned a row that is not a record`,
      'storage-corrupt',
    );
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not a JSON object');
    }
    return parsed as StoreRecord;
  } catch (err) {
    throw new StorageError(
      `libsql: the ${table} table holds a record that is not a JSON object`,
      'storage-corrupt',
      err,
    );
  }
}

/**
 * The JSON text of a patch value.
 *
 * The file adapter patches with Object.assign, so a number stays a number and
 * a boolean stays a boolean. `json(?)` parses the JSON text back into the
 * right JSON type, which keeps the stored record identical.
 *
 * `undefined` is special: Object.assign(record, { k: undefined }) REMOVES
 * the key from the JSON (JSON.stringify drops undefined values), so an
 * undefined patch removes the field instead of writing a null.
 */
function patchJsonText(value: unknown): string | null {
  if (value === undefined) return null;
  return JSON.stringify(value) ?? 'null';
}

export interface LibsqlStoreOptions {
  /** The transport the store talks through. */
  transport: LibsqlTransport;
  /**
   * Create the schema on first use (default true). A database that is
   * reachable but empty must work; a database whose schema cannot be created
   * must fail loudly rather than behave like an empty store.
   */
  autoSchema?: boolean;
}

/**
 * Build the libSQL-backed portal store.
 */
export function createLibsqlStore(options: LibsqlStoreOptions): PortalStore {
  const transport = options.transport;
  const autoSchema = options.autoSchema !== false;

  let schemaReady: Promise<void> | null = null;
  function ready(): Promise<void> {
    if (!autoSchema) return Promise.resolve();
    if (!schemaReady) schemaReady = ensureSchema(transport);
    return schemaReady;
  }

  async function rowsOf(coll: Collection, where?: Where): Promise<StoreRecord[]> {
    const spec = COLLECTIONS[coll];
    const filter = buildWhere(coll, where);
    const result = await transport.execute(
      `SELECT data FROM ${spec.table}${filter.sql} ORDER BY seq ASC`,
      filter.args,
    );
    return result.rows.map((row) => parseRecord(row[0], spec.table));
  }

  return {
    async list(coll: Collection, where?: Where): Promise<StoreRecord[]> {
      await ready();
      return rowsOf(coll, where);
    },

    async get(
      coll: Collection,
      key: { field: string; value: string },
    ): Promise<StoreRecord | null> {
      await ready();
      const spec = COLLECTIONS[coll];
      const filter = buildWhere(coll, { [key.field]: key.value } as Where);
      const result = await transport.execute(
        `SELECT data FROM ${spec.table}${filter.sql} ORDER BY seq ASC LIMIT 1`,
        filter.args,
      );
      if (result.rows.length === 0) return null;
      return parseRecord(result.rows[0][0], spec.table);
    },

    async append(coll: Collection, record: StoreRecord): Promise<void> {
      await ready();
      const spec = COLLECTIONS[coll];
      const columns = ['data', ...spec.columns.map((c) => c.column)];
      const values: Array<string | number | boolean | null> = [
        JSON.stringify(record),
        ...spec.columns.map((c) => {
          const value = record[c.field];
          return value === undefined ? null : (value as string | number | boolean | null);
        }),
      ];
      const placeholders = columns.map(() => '?').join(', ');
      await transport.execute(
        `INSERT INTO ${spec.table} (${columns.join(', ')}) VALUES (${placeholders})`,
        values.map(toSqlArg),
      );
    },

    async update(coll: Collection, key: Where, patch: StoreRecord): Promise<number> {
      if (coll === 'reviews') {
        // Moderation decisions must stay atomic and go through decideReview();
        // a generic patch would silently break the "newest wins" contract.
        throw new StorageError(
          "update() is not allowed on the 'reviews' collection — use decideReview()",
          'invalid-operation',
        );
      }
      await ready();
      const spec = COLLECTIONS[coll];
      const filter = buildWhere(coll, key);

      const fields = Object.keys(patch);
      if (fields.length === 0) {
        // Nothing to change: the file adapter would rewrite the file with the
        // same content. Counting the matching rows keeps the answer honest.
        const result = await transport.execute(
          `SELECT COUNT(*) AS n FROM ${spec.table}${filter.sql}`,
          filter.args,
        );
        return Number(result.rows[0]?.[0] ?? 0);
      }

      // The data column. json_set() takes several path/value pairs at once,
      // so the whole patch is ONE expression; json_remove() takes the fields
      // whose value is undefined (Object.assign with undefined REMOVES the
      // key once the record is serialised) and runs after the sets.
      const setPairs: string[] = [];
      const removePaths: string[] = [];
      const dataArgs: SqlArg[] = [];
      for (const field of fields) {
        const value = patch[field];
        if (value === undefined) {
          removePaths.push(jsonPath(field));
          continue;
        }
        setPairs.push('?', 'json(?)');
        dataArgs.push({ type: 'text', value: jsonPath(field) });
        dataArgs.push({ type: 'text', value: patchJsonText(value) as string });
      }

      let dataExpression = 'data';
      if (setPairs.length > 0) dataExpression = `json_set(${dataExpression}, ${setPairs.join(', ')})`;
      if (removePaths.length > 0) {
        const placeholders = removePaths.map(() => '?').join(', ');
        dataExpression = `json_remove(${dataExpression}, ${placeholders})`;
        for (const path of removePaths) dataArgs.push({ type: 'text', value: path });
      }

      // The typed columns of the patched fields move with the record.
      const columnSets: string[] = [];
      const columnArgs: SqlArg[] = [];
      for (const column of spec.columns) {
        if (!fields.includes(column.field)) continue;
        columnSets.push(`${column.column} = ?`);
        const value = patch[column.field];
        columnArgs.push(toSqlArg(value === undefined ? null : (value as string | number | boolean)));
      }

      const assignments = [`data = ${dataExpression}`, ...columnSets];
      const result = await transport.execute(
        `UPDATE ${spec.table} SET ${assignments.join(', ')}${filter.sql}`,
        [...dataArgs, ...columnArgs, ...filter.args],
      );
      return result.changes;
    },

    async remove(coll: Collection, key: Where): Promise<number> {
      if (coll === 'reviews') {
        throw new StorageError(
          "remove() is not allowed on the 'reviews' collection — the revision log is append-only",
          'invalid-operation',
        );
      }
      await ready();
      const spec = COLLECTIONS[coll];
      const filter = buildWhere(coll, key);
      const result = await transport.execute(
        `DELETE FROM ${spec.table}${filter.sql}`,
        filter.args,
      );
      return result.changes;
    },

    async latest(coll: 'reviews', where: Where): Promise<StoreRecord | null> {
      await ready();
      const spec = COLLECTIONS[coll];
      const filter = buildWhere(coll, where);
      // "Later lines win": the newest matching revision is the last match.
      const result = await transport.execute(
        `SELECT data FROM ${spec.table}${filter.sql} ORDER BY seq DESC LIMIT 1`,
        filter.args,
      );
      if (result.rows.length === 0) return null;
      return parseRecord(result.rows[0][0], spec.table);
    },

    async decideReview(
      ref: string,
      decision: ReviewDecision,
      at: string,
      decidedBy = 'one-click-link',
    ): Promise<StoreRecord | null> {
      await ready();
      const spec = COLLECTIONS['reviews'];

      // ONE statement, ONE row: the newest revision of this ref that is a
      // review record, and only while it is still pending. The `state =
      // 'pending'` guard is what makes "never flip an already-decided record,
      // not even the other way" a property of the statement.
      const result = await transport.execute(
        `UPDATE ${spec.table}
            SET state = ?,
                data = json_set(data, ?, json(?), ?, json(?), ?, json(?))
          WHERE seq = (SELECT seq FROM ${spec.table}
                        WHERE ref = ? AND type = 'review'
                        ORDER BY seq DESC LIMIT 1)
            AND state = 'pending'
        RETURNING data`,
        [
          { type: 'text', value: decision },
          { type: 'text', value: jsonPath('state') },
          { type: 'text', value: JSON.stringify(decision) },
          { type: 'text', value: jsonPath('decidedAt') },
          { type: 'text', value: JSON.stringify(at) },
          { type: 'text', value: jsonPath('decidedBy') },
          { type: 'text', value: JSON.stringify(decidedBy) },
          { type: 'text', value: ref },
        ],
      );

      if (result.rows.length > 0) {
        return parseRecord(result.rows[0][0], spec.table);
      }

      // Nothing was updated: either the ref is unknown, or the newest revision
      // is already decided. The second SELECT tells the two apart and returns
      // the already-decided record unchanged (the idempotency the contract
      // test asserts).
      const existing = await transport.execute(
        `SELECT data FROM ${spec.table}
          WHERE ref = ? AND type = 'review'
          ORDER BY seq DESC LIMIT 1`,
        [{ type: 'text', value: ref }],
      );
      if (existing.rows.length === 0) return null;
      return parseRecord(existing.rows[0][0], spec.table);
    },

    async exportAll(): Promise<Record<Collection, string[]>> {
      await ready();
      const out = {} as Record<Collection, string[]>;
      for (const coll of Object.keys(COLLECTIONS) as Collection[]) {
        const spec = COLLECTIONS[coll];
        const result = await transport.execute(
          `SELECT data FROM ${spec.table} ORDER BY seq ASC`,
        );
        out[coll] = result.rows.map((row) => String(row[0]));
      }
      return out;
    },
  };
}
