// site/functions/api/lib/rate-limit.ts — Cloudflare Pages Function module.
//
// The edge twin of api/lib/rate-limit.ts (Vercel). Same interface, same
// decision shape, same safety rules:
//
//   - a backend can never fail a request (in-memory fallback)
//   - keys are hashed before they reach a durable backend
//   - the counter is only consumed by a request that already passed validation
//
// EDGE-SAFE BY DESIGN: no node: imports. The hash uses crypto.subtle.
//
// BACKENDS
//   memory — per isolate. Always available, never durable.
//   kv    — a Workers KV binding (the same `KV_COUNTER` binding the public
//           contact form already uses, so the portal needs no new config).
//           Durable across cold starts. KV is eventually consistent: a few
//           seconds of lag around a cold start is acceptable for a rate
//           limiter, and it is still far better than a counter that resets
//           to zero on every request.

export interface RateLimitBackend {
  /** Count ONE hit for `key` inside a window of `windowMs`. */
  hit(key: string, windowMs: number): Promise<number>;
}

export interface RateLimitDecision {
  allowed: boolean;
  count: number;
  limit: number;
  remaining: number;
  /** true when the durable backend failed and the in-memory fallback was used. */
  degraded: boolean;
}

interface CounterEntry {
  count: number;
  reset: number;
}

/** The subset of the Workers KV binding this module needs. */
export interface KvCounter {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

export interface RateLimitEnv {
  KV_COUNTER?: KvCounter;
}

/**
 * In-memory backend.
 *
 * The map lives on globalThis so the counter survives a re-evaluation of the
 * module inside one isolate.
 */
export function createMemoryBackend(): RateLimitBackend {
  const g = globalThis as any;
  const store: Map<string, CounterEntry> =
    g.__imkRateLimitMemory || (g.__imkRateLimitMemory = new Map<string, CounterEntry>());

  return {
    async hit(key: string, windowMs: number): Promise<number> {
      const now = Date.now();
      const entry = store.get(key);
      if (entry && now < entry.reset) {
        entry.count += 1;
        return entry.count;
      }
      store.set(key, { count: 1, reset: now + windowMs });
      return 1;
    },
  };
}

/** Hash a key so no client id or IP address is written to KV. */
async function hashKey(key: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * KV backend — durable across cold starts.
 *
 * The window is stored with the count, and the KV entry expires when the
 * window closes, so the store does not grow without bound.
 */
export function createKvBackend(kv: KvCounter, prefix = 'portal'): RateLimitBackend {
  return {
    async hit(key: string, windowMs: number): Promise<number> {
      const now = Date.now();
      const id = await hashKey(key);
      const kvKey = `${prefix}:${id}`;
      const raw = await kv.get(kvKey);
      let entry: CounterEntry | null = null;
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as CounterEntry;
          if (parsed && typeof parsed.count === 'number' && typeof parsed.reset === 'number') {
            entry = parsed;
          }
        } catch {
          entry = null; // a damaged counter is not business data
        }
      }
      let count = 1;
      let reset = now + windowMs;
      if (entry && now < entry.reset) {
        count = entry.count + 1;
        reset = entry.reset;
      }
      const ttl = Math.max(60, Math.ceil((reset - now) / 1000));
      await kv.put(kvKey, JSON.stringify({ count, reset }), { expirationTtl: ttl });
      return count;
    },
  };
}

/**
 * A limiter: a backend, a fallback, and the decision rule.
 *
 * The check and the consumption are one operation, so they cannot race the
 * way a separate "check" and "consume" pair could.
 */
export class RateLimiter {
  private readonly backend: RateLimitBackend;
  private readonly fallback: RateLimitBackend;
  private backendFailed = false;
  /** The degradation is logged ONCE per isolate, not once per request. */
  private degradationLogged = false;

  constructor(backend: RateLimitBackend, fallback: RateLimitBackend = createMemoryBackend()) {
    this.backend = backend;
    this.fallback = fallback;
  }

  async consume(key: string, limit: number, windowMs: number): Promise<RateLimitDecision> {
    let count: number;
    let degraded = false;
    if (this.backendFailed) {
      count = await this.fallback.hit(key, windowMs);
      degraded = true;
    } else {
      try {
        count = await this.backend.hit(key, windowMs);
      } catch (err) {
        this.backendFailed = true;
        // …but never silently: a limiter that quietly falls back to a
        // per-isolate counter is not the limiter it claims to be, and the
        // operator has to be able to see that (audit wave-6, F-4 — the same
        // silent latch the Vercel tree had).
        this.logDegradation(err);
        count = await this.fallback.hit(key, windowMs);
        degraded = true;
      }
    }
    return {
      allowed: count <= limit,
      count,
      limit,
      remaining: Math.max(0, limit - count),
      degraded,
    };
  }

  /** Log the degradation once, with the underlying error code. */
  private logDegradation(err: unknown): void {
    if (this.degradationLogged) return;
    this.degradationLogged = true;
    const code = (err as { code?: string } | null)?.code || null;
    console.log(
      JSON.stringify({
        ts: Date.now(),
        outcome: 'rate_limit_degraded',
        backend: 'kv',
        code,
        reason: 'the durable counter is unavailable; the in-memory counter is used instead',
      }),
    );
  }
}

/**
 * The limiter the portal handlers use: KV-backed when the binding exists,
 * in-memory otherwise. A KV failure degrades to the in-memory counter — it
 * never fails the request.
 */
export function createPortalRateLimiter(env?: { KV_COUNTER?: unknown } | null): RateLimiter {
  const kv = (env as { KV_COUNTER?: unknown } | null | undefined)?.KV_COUNTER as KvCounter | undefined;
  if (kv && typeof kv.get === 'function' && typeof kv.put === 'function') {
    return new RateLimiter(createKvBackend(kv));
  }
  return new RateLimiter(createMemoryBackend());
}
