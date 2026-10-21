// site/shared/portal-store/index.ts
//
// Node entry point (Vercel + local dev). Selects the backend at request time
// from the environment — one codebase, both targets (proposal §2.1).
//
//   PORTAL_STORE=file    -> JSONL adapter (local dev, Vercel rollback path)
//   PORTAL_STORE=libsql  -> libSQL/Turso adapter (production; task T4)
//
// Env keys:
//   PORTAL_STORE       'file' | 'libsql'      (default: 'file')
//   PORTAL_DATA_DIR    data root for the file adapter
//                       (default: <cwd>/site/data — the path the handlers use today)
//   LIBSQL_URL/LIBSQL_TOKEN  libSQL credentials
//
// Import paths:
//   Vercel  api/portal/x.ts               -> ../../site/shared/portal-store/index.js
//   CF      site/functions/api/portal/x.ts -> ../../../shared/portal-store/edge.js

import * as path from 'node:path';

import { createFileStore } from './file-adapter.js';
import { StorageError } from './errors.js';
import { createLibsqlStoreFromEnv } from './libsql-store.js';
import type { PortalStore } from './types.js';

export * from './types.js';
export { StorageError } from './errors.js';
export { createFileStore, COLLECTION_FILES } from './file-adapter.js';
export { createLibsqlStore } from './libsql-adapter.js';
export { createHttpTransport } from './libsql-transport.js';
export { createLibsqlStoreFromEnv } from './libsql-store.js';
export { ensureSchema, SCHEMA_STATEMENTS } from './libsql-schema.js';
export { createLibsqlRateLimitBackend } from './durable-rate-counter.js';

export function getStore(env: Record<string, string | undefined> = {}): PortalStore {
  const mode = env.PORTAL_STORE || 'file';

  if (mode === 'file') {
    const dataDir = env.PORTAL_DATA_DIR || path.resolve(process.cwd(), 'site/data');
    return createFileStore({ dataDir });
  }

  if (mode === 'libsql') {
    // Fails closed on a missing LIBSQL_URL / LIBSQL_TOKEN.
    return createLibsqlStoreFromEnv(env);
  }

  throw new StorageError(
    `unknown PORTAL_STORE "${mode}" (expected "file" or "libsql")`,
    'invalid-config',
  );
}
