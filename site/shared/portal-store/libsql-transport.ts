// site/shared/portal-store/libsql-transport.ts
//
// The libSQL/Turso transport: the HTTP v2 "pipeline" API over `global fetch`.
//
// WHY HTTP AND NOT @libsql/client (spec/proposal-wave7-design-2026-10-21.md §3.1):
//   The root package.json has NO dependencies and vercel.json installs only
//   site/, so a root-level driver would never be installed on Vercel. The HTTP
//   pipeline API is plain HTTP: it runs on Node AND on workerd with the same
//   file, needs no build step, adds no dependency, and it is the first-class
//   Turso interface (https://docs.turso.tech/sdk/http/reference).
//
// THE WIRE FORMAT (https://github.com/tursodatabase/libsql/blob/main/docs/HTTP_V2_SPEC.md):
//
//   POST {base}/v2/pipeline
//   Authorization: Bearer <token>
//   Content-Type: application/json
//
//   -> { "baton": null,
//        "requests": [ { "type": "execute",
//                        "stmt": { "sql": "SELECT … WHERE id = ?",
//                                   "args": [ { "type": "text", "value": "prj_1" } ] } } ] }
//
//   <- { "baton": null, "base_url": null,
//        "results": [ { "type": "ok",
//                       "response": { "type": "execute",
//                                     "result": { "cols": [ { "name": "data", "decltype": "TEXT" } ],
//                                                 "rows": [ [ { "type": "text", "value": "{…}" } ] ],
//                                                 "affected_row_count": 0,
//                                                 "last_insert_rowid": null } } } ] }
//
// THE BATON (wave 10, F-4)
//   A page that answers with a non-null "baton" is NOT the whole answer: the
//   server sends the rest of the results when the client repeats the request
//   with that baton and an EMPTY requests array. A client that ignores the
//   baton drops the results that did not fit on the first page — a truncated
//   result set that looks complete. This transport follows the baton to the
//   end, and it honours a "base_url" the server sends with the page.
//
// THE TRAP (the reason this module exists): a failed statement comes back as
//   { "type": "error", "error": { "message": …, "code": … } }
// INSIDE results[], while the HTTP status is still 200. A client that only
//   looks at the status code reports a successful write for a write that never
//   happened. This transport therefore inspects results[].
//
// NEVER ECHO THE TOKEN: nothing in this module puts the token, the
// Authorization header or a URL with credentials into an error message, a log
// line or a thrown error.
//
// NO node: IMPORTS: this file is imported by the Cloudflare tree as well, so
// it may only use Web APIs (fetch, TextEncoder, btoa/atob).

import { StorageError } from './errors.js';

/** A bound parameter, in the Hrana value shape. */
export interface SqlArg {
  type: 'null' | 'integer' | 'float' | 'text' | 'blob';
  /** The value. Integers travel as a STRING (64-bit precision). */
  value?: string | number | null;
  /** Base64 payload, for blobs. */
  base64?: string;
}

/** The result of one statement. */
export interface SqlResult {
  /** Column names, in order. */
  cols: string[];
  /** The rows, decoded into plain JavaScript values. */
  rows: unknown[][];
  /** How many rows the statement changed (0 for a SELECT). */
  changes: number;
}

/**
 * The seam between the store and the database.
 *
 * The adapter never talks HTTP itself: it talks to this interface, so the
 * same store code can be driven by the real transport, by a fake one in a
 * unit test, or by the local mock pipeline server.
 */
export interface LibsqlTransport {
  /** Run one statement and return its result. */
  execute(sql: string, args?: SqlArg[]): Promise<SqlResult>;
  /**
   * Run several statements in ONE round trip (the pipeline API supports it).
   * Optional: a transport without it falls back to one call per statement.
   */
  executeAll?(statements: Array<{ sql: string; args?: SqlArg[] }>): Promise<SqlResult[]>;
}

/** A JavaScript value that can be bound as a parameter. */
export type BindableValue = string | number | boolean | null | undefined | Uint8Array;

/**
 * Convert a JavaScript value into a bound parameter.
 *
 * Booleans become the TEXT 'true'/'false' — that is what String(value)
 * produces, and the store's equality filter compares the text form of both
 * sides (see libsql-adapter.ts). SQLite has no boolean type, so this keeps
 * the comparison identical to the file adapter's.
 */
export function toSqlArg(value: BindableValue): SqlArg {
  if (value === null || value === undefined) return { type: 'null' };
  if (typeof value === 'boolean') return { type: 'text', value: value ? 'true' : 'false' };
  if (typeof value === 'number') {
    if (Number.isInteger(value)) return { type: 'integer', value: String(value) };
    return { type: 'float', value };
  }
  if (typeof value === 'string') return { type: 'text', value };
  return { type: 'blob', base64: bytesToBase64(value) };
}

// btoa/atob exist in Node >= 16 and in workerd, so no Node-only Buffer here:
// this module is imported by the Cloudflare tree as well.
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  if (typeof btoa !== 'function') {
    throw new StorageError('libsql: btoa is not available in this runtime', 'invalid-config');
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  if (typeof atob !== 'function') {
    throw new StorageError('libsql: atob is not available in this runtime', 'invalid-config');
  }
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Decode one value from a result row.
 *
 * The protocol sends {type, value}; a plain primitive is accepted too, so a
 * server that sends the bare value still decodes.
 */
export function decodeSqlValue(raw: unknown): unknown {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object') return raw;
  const value = raw as { type?: string; value?: unknown; base64?: string };
  switch (value.type) {
    case 'null':
      return null;
    case 'integer': {
      const n = typeof value.value === 'number' ? value.value : Number(value.value);
      return Number.isFinite(n) ? n : null;
    }
    case 'float': {
      const n = typeof value.value === 'number' ? value.value : Number(value.value);
      return Number.isFinite(n) ? n : null;
    }
    case 'text':
      return value.value === null || value.value === undefined ? null : String(value.value);
    case 'blob':
      return base64ToBytes(String(value.base64 ?? value.value ?? ''));
    default:
      return raw;
  }
}

export interface HttpTransportOptions {
  /** The database URL, e.g. https://my-db-my-org.turso.io (no /v2/pipeline). */
  url: string;
  /** The database auth token. Never logged, never echoed. */
  token: string;
  /** Injected for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout. Defaults to 10 s. */
  timeoutMs?: number;
}

/** The default per-request timeout for a database call. */
export const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Build the pipeline endpoint from the database URL.
 *
 * The URL may already carry the endpoint path (some dashboards hand out the
 * full URL); either way exactly one '/v2/pipeline' is used.
 */
export function pipelineEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (/\/v2\/pipeline$/.test(trimmed)) return trimmed;
  return `${trimmed}/v2/pipeline`;
}

/**
 * Hide anything that could be a credential before it goes into an error
 * message. A URL can carry userinfo (https://user:pass@host); the token is
 * never in the URL, but the redaction is cheap insurance.
 */
function redact(value: string): string {
  return value.replace(/\/\/[^/@\s]*@/, '//***@').replace(/Bearer\s+\S+/gi, 'Bearer ***');
}

/**
 * The HTTP transport: libSQL/Turso over `global fetch`.
 *
 * One statement per call, or several in one pipeline round trip.
 */
export function createHttpTransport(options: HttpTransportOptions): LibsqlTransport {
  const token = options.token;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doFetch = options.fetchImpl ?? globalThis.fetch;

  if (typeof doFetch !== 'function') {
    throw new StorageError(
      'libsql: no fetch implementation is available (globalThis.fetch is missing)',
      'invalid-config',
    );
  }

  /**
   * THE MAXIMUM NUMBER OF PAGES of one pipeline.
   *
   * A page is a baton continuation. A server that keeps handing out a baton
   * would otherwise make this loop for ever, so the number of pages is
   * bounded: past the bound the answer is an error, never a truncated result
   * set that looks complete.
   */
  const MAX_PAGES = 100;

  /** One round trip: the request body goes out, the page comes back. */
  async function pipelinePage(
    body: unknown,
    endpointUrl: string,
  ): Promise<{ results: any[]; baton: string | null; baseUrl: string | null }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await doFetch(endpointUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new StorageError(
        `libsql: the database is unreachable (${redact(reason)})`,
        'storage-unavailable',
        err,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw new StorageError(
        `libsql: the database answered HTTP ${response.status}`,
        'storage-unavailable',
      );
    }

    let payload: any;
    try {
      payload = await response.json();
    } catch (err) {
      throw new StorageError('libsql: the database answer was not JSON', 'storage-unavailable', err);
    }

    const results = Array.isArray(payload?.results) ? payload.results : null;
    if (!results) {
      throw new StorageError('libsql: the database answer had no results array', 'storage-unavailable');
    }

    // THE BATON (wave 10, F-4).
    //
    // A page that carries a baton is NOT the whole answer: the server sends
    // the rest of the results when the client repeats the request with that
    // baton. A client that ignores the baton silently drops the results that
    // did not fit on the first page — a truncated result set that looks
    // complete (the schema step, which sends 20 statements in one pipeline,
    // is exactly the case that loses them).
    const baton = typeof payload?.baton === 'string' && payload.baton ? payload.baton : null;
    const baseUrl =
      typeof payload?.base_url === 'string' && payload.base_url ? payload.base_url : null;

    return { results, baton, baseUrl };
  }

  /**
   * Run the requests and FOLLOW THE BATON to the end.
   *
   * The first request carries the statements; every continuation carries the
   * baton and an EMPTY requests array — the baton itself encodes what is
   * left to do (https://github.com/tursodatabase/libsql HTTP v2 spec).
   */
  async function pipeline(
    requests: unknown[],
  ): Promise<Array<{ type: string; response?: any; error?: any }>> {
    const collected: Array<{ type: string; response?: any; error?: any }> = [];
    let baton: string | null = null;
    let endpointUrl = pipelineEndpoint(options.url);

    for (let page = 0; ; page++) {
      if (page >= MAX_PAGES) {
        throw new StorageError(
          `libsql: the database sent more than ${MAX_PAGES} pages for one pipeline`,
          'storage-unavailable',
        );
      }

      const body = baton === null ? { baton: null, requests } : { baton, requests: [] };
      const answer = await pipelinePage(body, endpointUrl);
      collected.push(...answer.results);

      // The server may tell the client to talk to another node from now on.
      if (answer.baseUrl) endpointUrl = pipelineEndpoint(answer.baseUrl);

      if (!answer.baton) return collected;
      baton = answer.baton;
    }
  }

  function toResult(result: any): SqlResult {
    if (result && result.type === 'error') {
      const message = String(result?.error?.message ?? 'unknown database error');
      const code = result?.error?.code ? ` (${result.error.code})` : '';
      throw new StorageError(`libsql: ${redact(message)}${code}`, 'storage-unavailable');
    }
    const raw = result?.response?.result;
    if (!raw) {
      throw new StorageError('libsql: the database answer had no statement result', 'storage-unavailable');
    }
    const cols = Array.isArray(raw.cols) ? raw.cols.map((c: any) => String(c?.name ?? '')) : [];
    const rows = Array.isArray(raw.rows) ? raw.rows.map((row: any[]) => (row ?? []).map(decodeSqlValue)) : [];
    const changes = typeof raw.affected_row_count === 'number' ? raw.affected_row_count : 0;
    return { cols, rows, changes };
  }

  return {
    async execute(sql: string, args: SqlArg[] = []): Promise<SqlResult> {
      const results = await pipeline([
        { type: 'execute', stmt: { sql, args } },
        { type: 'close' },
      ]);
      if (results.length === 0) {
        throw new StorageError('libsql: the database returned no result', 'storage-unavailable');
      }
      return toResult(results[0]);
    },

    async executeAll(statements: Array<{ sql: string; args?: SqlArg[] }>): Promise<SqlResult[]> {
      if (statements.length === 0) return [];
      const requests: unknown[] = statements.map((s) => ({
        type: 'execute',
        stmt: { sql: s.sql, args: s.args ?? [] },
      }));
      requests.push({ type: 'close' });
      const results = await pipeline(requests);
      // The last result answers the 'close' request — it carries no statement
      // result, so only the statement answers are mapped.
      return results.slice(0, statements.length).map(toResult);
    },
  };
}
