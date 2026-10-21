// site/shared/portal-store/durable-rate-counter.ts
//
// The shared durable rate counter, on the same libSQL connection as the store.
//
// WHY THIS EXISTS (design §3.8)
//   api/lib/rate-limit.ts:203-252 (createFileBackend) keeps the counter in a
//   JSON file guarded by a lock file. On Vercel that fails twice over: the
//   filesystem is read-only, and every function instance keeps its OWN copy of
//   the file — so the limit is per instance, not per site. The Code Reviewer
//   also executed a case where 5 s of lock contention permanently abandons the
//   durable counter for the life of the process.
//
// THE CONTRACT IS ONE METHOD (api/lib/rate-limit.ts:41-48):
//   hit(key: string, windowMs: number): Promise<number>
// so the SQL backend needs NO change to the limiter itself: the existing
// RateLimiter class (rate-limit.ts:262-327) already falls back to the
// in-memory counter and reports `degraded: true` when a backend throws.
//
// ONE STATEMENT, NO LOCK, NO FILE:
//   INSERT … ON CONFLICT(bucket) DO UPDATE … RETURNING count
// is atomic inside the database, so two writers on two instances cannot lose
// each other's hits and there is no lock to leak.
//
// THE KEY IS HASHED before it reaches the database (SHA-256), exactly like the
// file backend does (rate-limit.ts:236): no client id, no e-mail address and
// no IP address is ever written to the database.
//
// NO node: IMPORTS: the hash uses WebCrypto, so the Cloudflare twin can use
// this module too.

import type { LibsqlTransport, SqlArg } from './libsql-transport.js';

/**
 * The one method a rate-limit backend has to provide.
 *
 * Structurally identical to `RateLimitBackend` in api/lib/rate-limit.ts, so
 * the limiter accepts this backend as-is. The type is declared here (and not
 * imported) because site/shared/** may not import from api/**: the Cloudflare
 * functions tree cannot see the Vercel tree.
 */
export interface DurableCounterBackend {
  hit(key: string, windowMs: number): Promise<number>;
}

/**
 * The statement that counts one hit.
 *
 * The CASE reproduces the file backend's rolling window exactly
 * (rate-limit.ts:236-240): a hit after the window has expired starts the
 * count again at 1 and sets a new reset; a hit inside the window counts up
 * and keeps the reset.
 */
export const RATE_COUNTER_SQL = `INSERT INTO rate_counters (bucket, reset_at, count)
VALUES (?, ?, 1)
ON CONFLICT(bucket) DO UPDATE SET
  count    = CASE WHEN rate_counters.reset_at <= ? THEN 1 ELSE rate_counters.count + 1 END,
  reset_at = CASE WHEN rate_counters.reset_at <= ? THEN ? + ? ELSE rate_counters.reset_at END
RETURNING count`;

/** SHA-256 of a key, as hex. WebCrypto only (Node >= 18, workerd). */
export async function hashCounterKey(key: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error(
      'the durable rate counter needs WebCrypto (globalThis.crypto.subtle is missing)',
    );
  }
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(key));
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return hex;
}

/**
 * The libSQL-backed durable counter.
 *
 * One row per bucket, so the table cannot grow without bound: the file
 * backend's bucket cleanup (rate-limit.ts:242-245) is unnecessary.
 */
export function createLibsqlRateLimitBackend(transport: LibsqlTransport): DurableCounterBackend {
  return {
    async hit(key: string, windowMs: number): Promise<number> {
      const bucket = await hashCounterKey(key);
      const now = Date.now();
      const args: SqlArg[] = [
        { type: 'text', value: bucket },
        { type: 'integer', value: String(now + windowMs) },
        { type: 'integer', value: String(now) },
        { type: 'integer', value: String(now) },
        { type: 'integer', value: String(now) },
        { type: 'integer', value: String(windowMs) },
      ];
      const result = await transport.execute(RATE_COUNTER_SQL, args);
      const count = result.rows[0]?.[0];
      const numeric = typeof count === 'number' ? count : Number(count);
      if (!Number.isFinite(numeric)) {
        throw new Error('the durable rate counter returned no count');
      }
      return numeric;
    },
  };
}
