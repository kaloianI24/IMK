// api/lib/rate-limit.ts — request counters with a pluggable backend.
//
// WHY THIS EXISTS (QA D7 follow-up, spec/08 §4.7)
//   The portal counted requests in a module-level Map. A serverless target
//   starts a fresh isolate on every cold start, so that Map starts empty:
//   the limit was a per-instance speed bump, not a limit. The product was
//   not broken — but the guarantee was weaker than the code implied and
//   nothing said so out loud.
//
// THE CONTRACT
//   A limiter owns a BACKEND, and the backend decides where the count lives:
//
//     memory — per instance. Always available, never durable. This is the
//             default and the only backend that works on a serverless
//             target without a shared store.
//     file   — a JSON file next to the portal data. Durable across restarts
//             and shared by every process on the same host: the
//             read-modify-write runs under an exclusive lock file, so two
//             writers cannot lose each other's hits. Opt-in via
//             PORTAL_RATE_LIMIT_FILE, for a self-hosted/VPS target.
//     store  — a shared counter service. RESERVED for the storage migration
//             (T4, libSQL/Turso). The seam exists so that adapter can land
//             without touching a single call site.
//
// SAFETY RULES
//   - A backend can NEVER fail a request. If it throws, the limiter falls
//     back to the in-memory counter and reports `degraded: true`.
//   - Keys are hashed before they reach a durable backend, so a client id or
//     an IP address never lands on disk.
//   - The counter is only consumed by a request that ALREADY passed
//     validation: the call sites keep that order (audit m6).
//
// TWIN
//   site/functions/api/lib/rate-limit.ts is the edge twin. Same interface,
//   same decision shape, `kv` instead of `file` for the durable backend.

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface RateLimitBackend {
  /**
   * Count ONE hit for `key` inside a window of `windowMs` and return the
   * number of hits in the current window. A window that has expired starts
   * again at 1.
   */
  hit(key: string, windowMs: number): Promise<number>;
}

export interface RateLimitDecision {
  /** true when the request may proceed. */
  allowed: boolean;
  /** hits in the current window, including this one. */
  count: number;
  limit: number;
  /** requests still available in this window (0 when blocked). */
  remaining: number;
  /** true when the durable backend failed and the in-memory fallback was used. */
  degraded: boolean;
}

interface CounterEntry {
  count: number;
  reset: number;
}

/**
 * In-memory backend.
 *
 * The map lives on globalThis so the counter survives a re-evaluation of the
 * module inside one process — the dev server rebuilds handlers per request,
 * and a limiter that resets on every rebuild is no limiter at all.
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

/** Hash a key so no client id or IP address is written to disk. */
function hashKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex');
}

interface FileState {
  version: 1;
  buckets: Record<string, CounterEntry>;
}

/**
 * Locking for the file backend.
 *
 * The counter is a read-modify-write, so two processes on the same host can
 * lose each other's hits (QA wave-3 D-2: two processes lost 75 of 200
 * buckets, 4 rounds out of 4). The counter file is therefore guarded by an
 * exclusive lock file: `open(..., 'wx')` is atomic on every POSIX and Windows
 * filesystem, so exactly one writer holds the lock at a time.
 *
 * A lock left behind by a killed process would block the limiter forever, so
 * a lock older than LOCK_STALE_MS is broken. If the lock cannot be taken at
 * all the caller degrades to the in-memory counter — the limiter must never
 * fail a request.
 */
const LOCK_SUFFIX = '.lock';
const LOCK_TIMEOUT_MS = 5000;
const LOCK_STALE_MS = 30000;

/**
 * The error codes that mean "the lock is BUSY", not "the lock is broken".
 *
 * EEXIST is the normal POSIX answer: somebody else holds the lock.
 *
 * On Windows the same situation can arrive as EPERM / EACCES: a lock file
 * that a process closed-and-unlinked while still holding the handle is
 * DELETE-PENDING, and `open(..., 'wx')` on it fails with EPERM until the
 * handle is released. That is a transient, NORMAL condition — treating it as
 * a broken backend made RateLimiter.consume() latch `backendFailed` for the
 * life of the process, so the durable counter was silently abandoned for
 * every later request and the cross-process limit stopped being enforced
 * (QA wave-4 D-3, confirmed by the Code Reviewer as F-4).
 *
 * EBUSY is the same idea on other filesystems.
 */
const LOCK_BUSY_CODES = new Set(['EEXIST', 'EPERM', 'EACCES', 'EBUSY']);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withFileLock<T>(filePath: string, fn: () => T): Promise<T> {
  const lockPath = `${filePath}${LOCK_SUFFIX}`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  for (;;) {
    let fd: number | undefined;
    try {
      fd = fs.openSync(lockPath, 'wx');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code || '';
      // Anything that is not "busy" is a real failure and must NOT be
      // mistaken for contention: it has to reach the caller so the limiter
      // can log it and degrade.
      if (!LOCK_BUSY_CODES.has(code)) throw err;
      // The lock is busy: another writer holds it, or it is delete-pending
      // on Windows. Break a stale one, wait otherwise.
      let broke = false;
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          fs.unlinkSync(lockPath);
          broke = true;
        }
      } catch {
        // The lock vanished between the open and the stat — or it is
        // delete-pending and cannot be stat'ed: try again straight away.
      }
      if (!broke) {
        if (Date.now() > deadline) {
          throw new Error('rate-limit: could not take the counter lock');
        }
        await sleep(5 + Math.floor(Math.random() * 20));
      }
      continue;
    }

    try {
      return fn();
    } finally {
      try {
        fs.closeSync(fd);
      } catch {
        /* the descriptor is gone either way */
      }
      try {
        fs.unlinkSync(lockPath);
      } catch {
        /* a stale lock is broken by the timeout above */
      }
    }
  }
}

/**
 * File backend — durable across restarts, shared by every process on the
 * same host.
 *
 * The read-modify-write runs under an exclusive lock, so concurrent writers
 * cannot lose a hit (QA wave-3 D-2).
 */
export function createFileBackend(filePath: string): RateLimitBackend {
  function readState(): FileState {
    try {
      if (!fs.existsSync(filePath)) return { version: 1, buckets: {} };
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw) as FileState;
      if (!parsed || typeof parsed !== 'object' || !parsed.buckets) {
        return { version: 1, buckets: {} };
      }
      return { version: 1, buckets: parsed.buckets as Record<string, CounterEntry> };
    } catch {
      // A damaged counter file is not business data: it must not take the
      // endpoint down. Start over and rewrite it.
      return { version: 1, buckets: {} };
    }
  }

  function writeState(state: FileState): void {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    // Write-then-rename: a reader never sees a half-written file.
    const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
    fs.renameSync(tmp, filePath);
  }

  return {
    async hit(key: string, windowMs: number): Promise<number> {
      // The lock file lives next to the counter file.
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      return withFileLock(filePath, () => {
        const now = Date.now();
        const state = readState();
        const id = hashKey(key);
        const entry = state.buckets[id];
        const live = entry && now < entry.reset;
        const count = live ? entry.count + 1 : 1;
        state.buckets[id] = { count, reset: live ? entry.reset : now + windowMs };

        // Drop expired buckets so the file cannot grow without bound.
        for (const [bucketId, bucket] of Object.entries(state.buckets)) {
          if (now >= bucket.reset) delete state.buckets[bucketId];
        }

        writeState(state);
        return count;
      });
    },
  };
}

/**
 * A limiter: a backend, a fallback, and the decision rule.
 *
 * The rule is deliberately simple and identical for every backend: a request
 * is allowed while the count stays within the limit. The counter is
 * consumed by the call itself, so the check and the consumption cannot race
 * the way a separate "check" and "consume" pair could.
 */
export class RateLimiter {
  private readonly backend: RateLimitBackend;
  private readonly fallback: RateLimitBackend;
  private backendFailed = false;
  /** The degradation is logged ONCE per process, not once per request. */
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
        // One failure is enough: stop trying the durable backend for the
        // lifetime of this process rather than failing a request per attempt.
        this.backendFailed = true;
        // …but never silently. A limiter that quietly falls back to a
        // per-process counter is not the limiter it claims to be, and the
        // operator has to be able to see that (audit wave-6, F-4).
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
        backend: 'durable',
        code,
        reason: 'the durable counter is unavailable; the in-memory counter is used instead',
      }),
    );
  }
}

/**
 * The limiter the portal handlers use.
 *
 * Default: in-memory (per instance).
 * With PORTAL_RATE_LIMIT_FILE=<path>: durable, file backed. The path is
 * created if needed; if the filesystem is read-only the limiter degrades to
 * the in-memory counter instead of failing the request.
 */
export function createPortalRateLimiter(options?: { filePath?: string }): RateLimiter {
  const configured = options?.filePath ?? process.env.PORTAL_RATE_LIMIT_FILE;
  if (!configured) return new RateLimiter(createMemoryBackend());
  const filePath = path.isAbsolute(configured)
    ? configured
    : path.resolve(process.cwd(), configured);
  return new RateLimiter(createFileBackend(filePath));
}

/**
 * The one limiter the portal handlers share.
 *
 * One instance per process is still the right shape: the in-memory backend
 * is per instance by definition, and the file backend now serialises its
 * read-modify-write with an exclusive lock, so two handlers on one host
 * cannot lose each other's hits.
 */
export const portalRateLimiter = createPortalRateLimiter();
