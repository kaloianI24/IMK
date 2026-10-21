// site/qa/qa-rate-limit.mjs
//
// Backend-owned suite for the rate limiter (api/lib/rate-limit.ts and its
// edge twin site/functions/api/lib/rate-limit.ts).
//
// It closes the gap QA named after the wave-2 re-run: the counters used to
// live in a module-level Map inside the handlers, so on a serverless target
// every cold start reset them. The limiter now has a BACKEND, and this suite
// proves what each backend actually guarantees.
//
// What it proves:
//   R1  the in-memory backend counts hits and blocks past the limit
//   R2  the file backend is DURABLE: a fresh limiter over the same file
//       still sees the count (a restart does not hand out free slots)
//   R3  the file backend writes NO client id and NO IP address to disk
//       (keys are hashed)
//   R4  two limiters over the same file share one counter
//   R5  a broken backend degrades to the in-memory fallback: the request is
//       still limited, and it never throws
//   R6  the edge KV backend is DURABLE across a cold start (a new backend
//       instance over the same binding still sees the count) and stores no
//       raw key
//   R7  the edge portal limiter uses KV when the binding exists and memory
//       when it does not
//   R8  the node portal limiter uses the file backend when a path is given
//
// USAGE
//   node site/qa/qa-rate-limit.mjs [--keep]
//
// The suite never touches the repo's site/data/ and never uses port 4321.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.resolve(HERE, '..');
const REPO = path.resolve(SITE, '..');
const KEEP = process.argv.includes('--keep');

const results = [];
let currentGroup = '';
const origLog = console.log;

function group(name) {
  currentGroup = name;
  origLog(`\n[qa] ${name}`);
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function t(id, name, fn) {
  try {
    const detail = await fn();
    results.push({ id, group: currentGroup, name, status: 'PASS', detail: detail ?? null });
    origLog(`  PASS  ${id}  ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (err) {
    results.push({ id, group: currentGroup, name, status: 'FAIL', error: String(err && err.message ? err.message : err) });
    origLog(`  FAIL  ${id}  ${name}\n          ${err && err.message ? err.message : err}`);
  }
}

const SANDBOX = path.join(
  os.tmpdir(),
  `qa-rate-limit-${new Date().toISOString().replace(/[:.]/g, '-')}`,
);

const REPO_FWD = REPO.replace(/\\/g, '/');
const ENTRY = `export {
  createMemoryBackend as nodeMemory,
  createFileBackend as nodeFile,
  RateLimiter as NodeLimiter,
  createPortalRateLimiter as nodePortal,
} from '${REPO_FWD}/api/lib/rate-limit.ts';
export {
  createMemoryBackend as edgeMemory,
  createKvBackend as edgeKv,
  RateLimiter as EdgeLimiter,
  createPortalRateLimiter as edgePortal,
} from '${REPO_FWD}/site/functions/api/lib/rate-limit.ts';
`;

let lib = null;

async function load() {
  const entryFile = path.join(SANDBOX, 'entry.ts');
  const outFile = path.join(SANDBOX, 'bundle', 'rate-limit.cjs');
  fs.mkdirSync(path.dirname(entryFile), { recursive: true });
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(entryFile, ENTRY, 'utf8');
  await build({
    entryPoints: [entryFile],
    outfile: outFile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    absWorkingDir: REPO,
    external: ['node:crypto', 'node:fs', 'node:path'],
    logLevel: 'silent',
  });
  lib = require(outFile);
}

/** A Workers-KV stand-in: a Map with the two methods the edge backend uses. */
function fakeKv() {
  const store = new Map();
  return {
    store,
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value) {
      store.set(key, value);
    },
  };
}

async function main() {
  origLog(`[qa] sandbox: ${SANDBOX}`);
  fs.mkdirSync(SANDBOX, { recursive: true });
  await load();

  const HOUR = 60 * 60 * 1000;

  group('R — the limiter contract');

  await t('R1', 'the in-memory backend counts hits and blocks past the limit', async () => {
    const limiter = new lib.NodeLimiter(lib.nodeMemory());
    const seen = [];
    for (let i = 0; i < 4; i += 1) {
      const d = await limiter.consume('submit:client-1', 3, HOUR);
      seen.push(`${d.allowed ? 'ok' : 'blocked'}:${d.count}`);
    }
    assertEqual(seen.join(' '), 'ok:1 ok:2 ok:3 blocked:4', 'the fourth hit must be blocked');
    const d = await limiter.consume('submit:client-1', 3, HOUR);
    assertEqual(d.remaining, 0, 'no requests may remain');
    assertEqual(d.degraded, false, 'the in-memory backend must not report a degradation');
    return seen.join(' ');
  });

  await t('R2', 'the file backend is durable: a restart does not hand out free slots', async () => {
    const file = path.join(SANDBOX, 'durable.json');
    const first = new lib.NodeLimiter(lib.nodeFile(file));
    const a = await first.consume('submit:client-2', 2, HOUR);
    const b = await first.consume('submit:client-2', 2, HOUR);
    assertEqual(a.allowed, true, 'the first hit is allowed');
    assertEqual(b.allowed, true, 'the second hit is allowed');
    // a brand new limiter — the process restarted, the file did not
    const second = new lib.NodeLimiter(lib.nodeFile(file));
    const c = await second.consume('submit:client-2', 2, HOUR);
    assertEqual(c.allowed, false, 'the third hit must still be blocked after a restart');
    assertEqual(c.count, 3, 'the counter carried over');
    return `count=${c.count}, blocked after restart`;
  });

  await t('R3', 'the file backend writes no client id and no IP address to disk', async () => {
    const file = path.join(SANDBOX, 'hashed.json');
    const limiter = new lib.NodeLimiter(lib.nodeFile(file));
    await limiter.consume('submit:client-visible-id', 5, HOUR);
    await limiter.consume('ip:203.0.113.7', 5, HOUR);
    const raw = fs.readFileSync(file, 'utf8');
    assert(!raw.includes('client-visible-id'), 'the client id must not be in the file');
    assert(!raw.includes('203.0.113.7'), 'the IP address must not be in the file');
    const parsed = JSON.parse(raw);
    const ids = Object.keys(parsed.buckets || {});
    assertEqual(ids.length, 2, 'both counters must be stored');
    for (const id of ids) {
      assert(/^[0-9a-f]{64}$/.test(id), `the bucket id must be a sha256 hex digest: ${id}`);
    }
    return 'keys are sha256 digests';
  });

  await t('R4', 'two limiters over the same file share one counter', async () => {
    const file = path.join(SANDBOX, 'shared.json');
    const a = new lib.NodeLimiter(lib.nodeFile(file));
    const b = new lib.NodeLimiter(lib.nodeFile(file));
    const one = await a.consume('submit:client-3', 2, HOUR);
    const two = await b.consume('submit:client-3', 2, HOUR);
    const three = await a.consume('submit:client-3', 2, HOUR);
    assertEqual(one.allowed, true, 'first hit');
    assertEqual(two.allowed, true, 'second hit');
    assertEqual(three.allowed, false, 'the third hit must be blocked — the counter is shared');
    return `count=${three.count}`;
  });

  await t('R5', 'a broken backend degrades to the in-memory fallback and never throws', async () => {
    const broken = {
      async hit() {
        throw new Error('backend is down');
      },
    };
    const limiter = new lib.NodeLimiter(broken);
    const first = await limiter.consume('submit:client-4', 1, HOUR);
    const second = await limiter.consume('submit:client-4', 1, HOUR);
    assertEqual(first.allowed, true, 'the first hit is allowed');
    assertEqual(second.allowed, false, 'the limit still applies with a broken backend');
    assertEqual(second.degraded, true, 'the degradation must be reported');
    return 'limit still enforced, degraded=true';
  });

  await t('R6', 'the edge KV backend is durable across a cold start and stores no raw key', async () => {
    const kv = fakeKv();
    const first = new lib.EdgeLimiter(lib.edgeKv(kv));
    const a = await first.consume('ip:198.51.100.9', 2, HOUR);
    const b = await first.consume('ip:198.51.100.9', 2, HOUR);
    assertEqual(a.allowed, true, 'the first hit is allowed');
    assertEqual(b.allowed, true, 'the second hit is allowed');
    // a NEW backend over the SAME binding: a cold start, same store
    const second = new lib.EdgeLimiter(lib.edgeKv(kv));
    const c = await second.consume('ip:198.51.100.9', 2, HOUR);
    assertEqual(c.allowed, false, 'the third hit must be blocked after a cold start');
    const keys = [...kv.store.keys()];
    for (const key of keys) {
      assert(!key.includes('198.51.100.9'), `the raw key must not be in KV: ${key}`);
      assert(/^portal:[0-9a-f]{64}$/.test(key), `the KV key must be a hashed portal key: ${key}`);
    }
    return `count=${c.count}, kv keys hashed`;
  });

  await t('R7', 'the edge portal limiter uses KV when the binding exists, memory when it does not', async () => {
    const kv = fakeKv();
    const withKv = lib.edgePortal({ KV_COUNTER: kv });
    const one = await withKv.consume('submit:client-5', 1, HOUR);
    const two = await withKv.consume('submit:client-5', 1, HOUR);
    assertEqual(one.allowed, true, 'the first hit is allowed');
    assertEqual(two.allowed, false, 'the KV-backed limiter must enforce the limit');
    assertEqual(kv.store.size, 1, 'the KV backend must have been used');

    const withoutKv = lib.edgePortal({});
    const three = await withoutKv.consume('submit:client-6', 1, HOUR);
    const four = await withoutKv.consume('submit:client-6', 1, HOUR);
    assertEqual(four.allowed, false, 'the in-memory limiter must enforce the limit');
    assertEqual(three.degraded, false, 'the in-memory fallback is not a degradation here');
    return 'KV path and memory path both enforce the limit';
  });

  await t('R8', 'the node portal limiter is file-backed when a path is given, memory otherwise', async () => {
    const file = path.join(SANDBOX, 'portal.json');
    const durable = lib.nodePortal({ filePath: file });
    const one = await durable.consume('submit:client-7', 1, HOUR);
    assertEqual(one.allowed, true, 'the first hit is allowed');
    assert(fs.existsSync(file), 'the file backend must have written the counter file');
    const again = lib.nodePortal({ filePath: file });
    const two = await again.consume('submit:client-7', 1, HOUR);
    assertEqual(two.allowed, false, 'the counter must survive a new limiter instance');
    return 'file backend chosen and durable';
  });

  // ---- summary -------------------------------------------------------------
  const failed = results.filter((r) => r.status === 'FAIL');
  origLog(`\n[qa] ${results.length - failed.length} passed, ${failed.length} failed, ${results.length} checks`);
  if (failed.length) {
    origLog('[qa] failing checks: ' + failed.map((f) => f.id).join(', '));
  }
  if (!KEEP) {
    try {
      fs.rmSync(SANDBOX, { recursive: true, force: true });
      origLog('[qa] sandbox removed');
    } catch {
      origLog('[qa] sandbox left behind: ' + SANDBOX);
    }
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  origLog('[qa] harness error', err);
  process.exit(1);
});
