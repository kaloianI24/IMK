// site/shared/server/portal-store-access.ts
//
// The ONE place where the Vercel handler tree reaches the portal store.
//
// WHY THIS FILE EXISTS (wave 9)
//   Until now every portal handler read and wrote the JSONL files under
//   site/data/ by itself (api/lib/jsonl.ts plus a local appendJsonl /
//   rewriteJsonl in each handler). On Vercel the filesystem is READ-ONLY, so
//   every portal endpoint answered 500 {code:'storage'} — the portal could
//   not run on the launch target at all.
//
//   The PortalStore contract (site/shared/portal-store/**) already exists and
//   is proven: `npm run test:store` = 60/60, the same 22 assertions against
//   the file adapter AND the libSQL adapter. This module binds the handlers
//   to that contract:
//
//     - it selects the backend from the environment (PORTAL_STORE=file |
//     libsql) and keeps ONE store per configuration, so the libSQL schema
//       step happens once instead of once per request;
//     - it resolves the data root ONCE, at module load, exactly like the
//       handlers did (the QA suites chdir into their sandbox BEFORE the
//       bundle is required, so a load-time path is what they expect);
//     - it maps a StorageError to the answer the product already uses:
//       500 {code:'storage'} — never a 200 with empty data.
//
//   NO CONTRACT CHANGE. The PortalStore interface, the file adapter, the
//   libSQL adapter, the transport and the schema are untouched: this file
//   only USES them.
//
// NODE ONLY
//   This module uses node:fs for one thing — the "is the store there at all?"
//   probe that keeps the moderation endpoint's 501 answer. The Cloudflare
//   tree uses site/shared/portal-store/edge.ts and its own 501 stub; it must
//   never import this file.

import * as fs from 'node:fs';
import * as path from 'node:path';

import { COLLECTION_FILES } from '../portal-store/file-adapter.js';
import { createFileStore, createLibsqlStore, createHttpTransport } from '../portal-store/index.js';
import { StorageError } from '../portal-store/errors.js';
import { StorageCorruptError, isStorageCorrupt } from '../portal-store/jsonl.js';
import type { LibsqlTransport } from '../portal-store/libsql-transport.js';
import type { Collection, PortalStore } from '../portal-store/types.js';

/**
 * The data root, resolved AT MODULE LOAD.
 *
 * The handlers used to do exactly this (`path.resolve(process.cwd(),
 * 'site/data/portal')` as a module-level constant), and the QA suites rely
 * on it: they chdir into their sandbox BEFORE the bundle is required, so the
 * path must be pinned at load time and not resolved per request.
 */
const DATA_DIR = path.resolve(process.cwd(), 'site/data');

/** The backend the handlers talk to. */
export interface PortalBackend {
  /** The store itself. */
  store: PortalStore;
  /** 'file' or 'libsql'. */
  mode: 'file' | 'libsql';
  /** The libSQL transport — libsql mode only. The rate counter shares it. */
  transport?: LibsqlTransport;
}

/**
 * The store instances, cached per configuration.
 *
 * The map lives on globalThis so it survives a re-evaluation of this module
 * inside one process (the dev server bundles the handlers once, but a test
 * harness may re-require them). One store per configuration means the libSQL
 * schema step (CREATE TABLE IF NOT EXISTS …) happens once, not per request.
 */
const cache: Map<string, PortalBackend> = (() => {
  const g = globalThis as any;
  if (!g.__imkPortalBackends) g.__imkPortalBackends = new Map<string, PortalBackend>();
  return g.__imkPortalBackends as Map<string, PortalBackend>;
})();

/** A short, non-reversible fingerprint of the token — never the token itself. */
function fingerprint(value: string): string {
  if (!value) return '';
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

/** The environment the store is built from. */
function envBag(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  return { ...env, PORTAL_DATA_DIR: env.PORTAL_DATA_DIR || DATA_DIR };
}

/** The cache key: everything that can change the store. */
function cacheKey(bag: Record<string, string | undefined>): string {
  return [
    (bag.PORTAL_STORE || 'file').trim(),
    bag.PORTAL_DATA_DIR || '',
    (bag.LIBSQL_URL || '').trim(),
    fingerprint((bag.LIBSQL_TOKEN || '').trim()),
  ].join('|');
}

/**
 * Build the libSQL transport from the environment.
 *
 * FAIL CLOSED: a missing LIBSQL_URL / LIBSQL_TOKEN is a StorageError
 * ('invalid-config'). The rules are the ones in
 * site/shared/portal-store/libsql-store.ts — the same three checks, with the
 * same messages, so both entry points refuse the same configurations.
 */
export function createPortalTransport(
  env: Record<string, string | undefined> = process.env,
): LibsqlTransport {
  const url = (env.LIBSQL_URL || '').trim();
  const token = (env.LIBSQL_TOKEN || '').trim();

  if (!url) {
    throw new StorageError(
      'PORTAL_STORE=libsql requires LIBSQL_URL (the libSQL/Turso database URL)',
      'invalid-config',
    );
  }
  if (!token) {
    throw new StorageError(
      'PORTAL_STORE=libsql requires LIBSQL_TOKEN (the database auth token)',
      'invalid-config',
    );
  }
  if (!/^https?:\/\//i.test(url)) {
    throw new StorageError(
      'PORTAL_STORE=libsql: LIBSQL_URL must be an http(s) URL (the /v2/pipeline endpoint is HTTP)',
      'invalid-config',
    );
  }

  return createHttpTransport({ url, token });
}

/**
 * The store backend for this environment.
 *
 * The libSQL mode builds the transport ONCE and hands the SAME transport to
 * the store and to the durable rate counter, so both talk to the same
 * database over the same client.
 */
export function getPortalBackend(
  env: Record<string, string | undefined> = process.env,
): PortalBackend {
  const bag = envBag(env);
  const key = cacheKey(bag);
  const cached = cache.get(key);
  if (cached) return cached;

  const mode = (bag.PORTAL_STORE || 'file').trim();

  let backend: PortalBackend;
  if (mode === 'libsql') {
    const transport = createPortalTransport(bag);
    backend = { store: createLibsqlStore({ transport }), mode: 'libsql', transport };
  } else if (mode === 'file' || mode === '') {
    backend = {
      store: createFileStore({ dataDir: bag.PORTAL_DATA_DIR as string }),
      mode: 'file',
    };
  } else {
    throw new StorageError(
      `unknown PORTAL_STORE "${mode}" (expected "file" or "libsql")`,
      'invalid-config',
    );
  }

  cache.set(key, backend);
  return backend;
}

/** The store the handlers read and write. */
export function getPortalStore(
  env: Record<string, string | undefined> = process.env,
): PortalStore {
  return getPortalBackend(env).store;
}

/** 'file' or 'libsql' — which backend this environment selects. */
export function portalStoreMode(
  env: Record<string, string | undefined> = process.env,
): 'file' | 'libsql' {
  return (env.PORTAL_STORE || 'file').trim() === 'libsql' ? 'libsql' : 'file';
}

/**
 * Thrown when the store is not there AT ALL.
 *
 * A store that cannot be reached must never look like a store that is empty:
 * "review not found" tells the owner their quote is gone, which is the exact
 * silent outage the strict parser was introduced to kill (audit M3 / QA D3).
 * The moderation endpoint answers 501 {code:'unimplemented'} for it.
 */
export class StoreUnreachableError extends Error {
  constructor(message = 'the store is not reachable on this target') {
    super(message);
    this.name = 'StoreUnreachableError';
  }
}

/**
 * Can this deployment hold a store at `dir`?
 *
 * The answer is asked for a directory that does not exist yet: a fresh
 * install has no data directory, and the first request must not be refused
 * for that (the owner's first sign-in is what creates the store).
 *
 * The nearest existing ancestor decides: it has to be a DIRECTORY and it has
 * to be writable. A file in the way (ENOTDIR) or a read-only ancestor (a
 * serverless function's filesystem) means this deployment can never hold a
 * store.
 */
function canHoldStore(dir: string): boolean {
  let current = dir;
  for (;;) {
    if (fs.existsSync(current)) {
      try {
        if (!fs.statSync(current).isDirectory()) return false;
        fs.accessSync(current, fs.constants.W_OK);
        return true;
      } catch {
        return false;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

/**
 * Is the collection reachable at all?
 *
 * FILE MODE: the store is a file. A missing file means this target cannot
 * serve the collection (the function filesystem is read-only in production
 * and a deployment that does not carry site/data/ has no store at all) —
 * that is 501, not an empty list.
 *
 * LIBSQL MODE: the store is a database. It is reachable by definition; an
 * empty table means "nothing stored yet", which is a normal answer.
 *
 * WITH a collection: that collection's FILE must be there. This is the check
 * the moderation endpoint and the owner's inbox use — they serve exactly one
 * collection, and a missing file means the store cannot serve it.
 *
 * WITHOUT a collection: the STORE itself must be reachable — it is either
 * there, or this deployment can put it there (a fresh install has no data
 * directory yet, and the owner's first request creates it). A deployment that
 * can do NEITHER — a read-only function filesystem with no store, which is
 * what a serverless target looks like — cannot serve the portal at all, and
 * it must say so (501) instead of answering "not invited" / "no projects" /
 * "no quote" (wave 10, F-3).
 *
 * WHY THE STORE AND NOT EVERY COLLECTION: the file adapter's own contract is
 * that a missing collection file is an EMPTY collection ("a missing file is
 * still an empty collection, not an error"), and the product depends on it:
 * a client who has no comments yet must get an empty list, and the owner's
 * first sign-in must work before the invite file exists. The store itself is
 * a different question, and it has exactly two answers: it is reachable, or
 * this deployment cannot serve it.
 */
export function assertStoreReachable(
  coll?: Collection,
  env: Record<string, string | undefined> = process.env,
): void {
  if (portalStoreMode(env) !== 'file') return;
  const bag = envBag(env);
  const root = bag.PORTAL_DATA_DIR as string;
  if (coll) {
    const file = path.join(root, COLLECTION_FILES[coll]);
    if (!fs.existsSync(file)) {
      throw new StoreUnreachableError(`the ${coll} store is not there: ${file}`);
    }
    return;
  }
  if (fs.existsSync(root)) return;
  if (!canHoldStore(root)) {
    throw new StoreUnreachableError(
      `the portal store is not there and this deployment cannot hold one: ${root}`,
    );
  }
}

/**
 * Run a handler and turn a store failure into a clean, explicit answer
 * instead of a crash or a misleading empty list.
 *
 *   guardStore(() => handle(req, res), (err) => json(res, {code:'storage'}, 500))
 *
 * A StorageError of ANY kind is the store's problem and becomes
 * 500 {code:'storage'} — the answer the product already used for a broken
 * store (audit M3 / QA D3). Any other error is re-thrown untouched.
 */
export async function guardStore<T>(
  fn: () => Promise<T> | T,
  onError: (err: StorageError | StorageCorruptError) => T,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof StorageError || isStorageCorrupt(err)) {
      return onError(err as StorageError | StorageCorruptError);
    }
    throw err;
  }
}

/** The log line for a store failure. Never carries a secret. */
export function storageFailureLog(
  err: StorageError | StorageCorruptError,
): Record<string, unknown> {
  const code = (err as StorageError).code;
  return {
    ts: Date.now(),
    outcome: 'storage_error',
    code: code || 'storage-corrupt',
    message: err.message,
  };
}
