// site/shared/portal-store/durable-rate-counter.ts
//
// The shared durable rate counter, on the same libSQL connection as the store.
//
// WHY THIS EXISTS (design §3.8)
//   site/shared/server/rate-limit.ts (createFileBackend) keeps the counter in a
//   JSON file guarded by a lock file. On Vercel that fails twice over: the
//   filesystem is read-only, and every function instance keeps its OWN copy of
//   the file — so the limit is per instance, not per site. The Code Reviewer
//   also executed a case where 5 s of lock contention permanently abandons the
//   durable counter for the life of the process.
//
// THE CONTRACT IS ONE METHOD (site/shared/server/rate-limit.ts):
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
 * Structurally identical to `RateLimitBackend` in site/shared/server/rate-limit.ts, so
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

/**
 * The statement that drops the expired buckets (wave 10, F-5).
 *
 * The old comment on this backend claimed "one row per bucket, so the table
 * cannot grow without bound". That was false: there was no DELETE for
 * `rate_counters` anywhere, so every bucket that was ever used stayed in the
 * table for ever. With a client-chosen bucket key (an x-forwarded-for the
 * client could vary) the table grew with every request.
 *
 * A bucket whose window has expired carries no information — the next hit on
 * it starts at 1 anyway — so it can go. The DELETE runs BEFORE the counter is
 * written, in the same pipeline round trip, so the table only ever holds the
 * buckets that are still inside their window.
 */
export const RATE_COUNTER_PRUNE_SQL = `DELETE FROM rate_counters WHERE reset_at <= ?`;

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
 * One row per LIVE bucket: the expired ones are pruned (see
 * RATE_COUNTER_PRUNE_SQL), so the table cannot grow without bound, and one
 * atomic statement, so two instances cannot lose each other's hits. The key
 * is hashed by the counter itself (SHA-256), so no client id and no IP
 * address reaches the database.
 */
export function createLibsqlRateLimitBackend(transport: LibsqlTransport): DurableCounterBackend {
  return {
    async hit(key: string, windowMs: number): Promise<number> {
      const bucket = await hashCounterKey(key);
      const now = Date.now();
      const counterArgs: SqlArg[] = [
        { type: 'text', value: bucket },
        { type: 'integer', value: String(now + windowMs) },
        { type: 'integer', value: String(now) },
        { type: 'integer', value: String(now) },
        { type: 'integer', value: String(now) },
        { type: 'integer', value: String(windowMs) },
      ];
      const pruneArgs: SqlArg[] = [{ type: 'integer', value: String(now) }];

      // The prune and the counter run in ONE round trip when the transport
      // can do a pipeline: the expired buckets go first, the hit is counted
      // after. The bucket being counted is never pruned — its window has not
      // expired yet.
      let count: unknown;
      if (typeof transport.executeAll === 'function') {
        const results = await transport.executeAll([
          { sql: RATE_COUNTER_PRUNE_SQL, args: pruneArgs },
          { sql: RATE_COUNTER_SQL, args: counterArgs },
        ]);
        count = results[1]?.rows?.[0]?.[0];
      } else {
        await transport.execute(RATE_COUNTER_PRUNE_SQL, pruneArgs);
        const result = await transport.execute(RATE_COUNTER_SQL, counterArgs);
        count = result.rows[0]?.[0];
      }

      const numeric = typeof count === 'number' ? count : Number(count);
      if (!Number.isFinite(numeric)) {
        throw new Error('the durable rate counter returned no count');
      }
      return numeric;
    },
  };
}
