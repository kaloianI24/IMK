// site/shared/portal-store/index.ts
//
// Node entry point (Vercel + local dev). Selects the backend at request time
// from the environment — one codebase, both targets (proposal §2.1).
//
//   PORTAL_STORE=file    -> JSONL adapter (local dev, Vercel rollback path)
//   PORTAL_STORE=libsql  -> libSQL/Turso adapter (production; lands in T4)
//
// Env keys:
//   PORTAL_STORE       'file' | 'libsql'      (default: 'file')
//   PORTAL_DATA_DIR    data root for the file adapter
//                       (default: <cwd>/site/data — the path the handlers use today)
//   LIBSQL_URL/LIBSQL_TOKEN  libSQL credentials (T4)
//
// Import paths:
//   Vercel  api/portal/x.ts               -> ../../site/shared/portal-store/index.js
//   CF      site/functions/api/portal/x.ts -> ../../../shared/portal-store/edge.js

import * as path from 'node:path';

import { createFileStore } from './file-adapter.js';
import { StorageError } from './errors.js';
import type { PortalStore } from './types.js';

export * from './types.js';
export { StorageError } from './errors.js';
export { createFileStore, COLLECTION_FILES } from './file-adapter.js';

export function getStore(env: Record<string, string | undefined> = {}): PortalStore {
  const mode = env.PORTAL_STORE || 'file';

  if (mode === 'file') {
    const dataDir = env.PORTAL_DATA_DIR || path.resolve(process.cwd(), 'site/data');
    return createFileStore({ dataDir });
  }

  if (mode === 'libsql') {
    throw new StorageError(
      'the libsql adapter is not implemented yet (task T4) — use PORTAL_STORE=file until it lands',
      'not-implemented',
    );
  }

  throw new StorageError(
    `unknown PORTAL_STORE "${mode}" (expected "file" or "libsql")`,
    'invalid-config',
  );
}
