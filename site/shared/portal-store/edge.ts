// site/shared/portal-store/edge.ts
//
// Cloudflare Pages entry point. Deliberately separate from index.ts so the
// edge bundle never pulls in `node:fs` (the file adapter is Node-only and
// Cloudflare has no writable filesystem — that is the whole reason this
// migration exists).
//
//   PORTAL_STORE=libsql  -> libSQL/Turso adapter (production; task T4)
//   PORTAL_STORE=file    -> rejected: there is no writable disk on the edge
//
// The libSQL adapter itself is Web-API only (global fetch, WebCrypto), so the
// SAME file serves the Vercel tree and this one — the two cannot drift.
//
// Import path from the functions tree:
//   site/functions/api/x.ts        -> ../../shared/portal-store/edge.js
//   site/functions/api/portal/x.ts -> ../../../shared/portal-store/edge.js

import { StorageError } from './errors.js';
import { createLibsqlStoreFromEnv } from './libsql-store.js';
import type { PortalStore } from './types.js';

export * from './types.js';
export { StorageError } from './errors.js';
export { createLibsqlStore } from './libsql-adapter.js';
export { createHttpTransport } from './libsql-transport.js';
export { createLibsqlStoreFromEnv } from './libsql-store.js';
export { ensureSchema, SCHEMA_STATEMENTS } from './libsql-schema.js';
export { createLibsqlRateLimitBackend } from './durable-rate-counter.js';

export function getStore(env: Record<string, string | undefined> = {}): PortalStore {
  const mode = env.PORTAL_STORE || 'libsql';

  if (mode === 'file') {
    throw new StorageError(
      'the file adapter is not available on the edge runtime (no writable filesystem) — set PORTAL_STORE=libsql',
      'invalid-config',
    );
  }

  if (mode === 'libsql') {
    // Fails closed on a missing LIBSQL_URL / LIBSQL_TOKEN.
    return createLibsqlStoreFromEnv(env);
  }

  throw new StorageError(
    `unknown PORTAL_STORE "${mode}" (expected "libsql")`,
    'invalid-config',
  );
}
