// site/shared/portal-store/edge.ts
//
// Cloudflare Pages entry point. Deliberately separate from index.ts so the
// edge bundle never pulls in `node:fs` (the file adapter is Node-only and
// Cloudflare has no writable filesystem — that is the whole reason this
// migration exists).
//
//   PORTAL_STORE=libsql  -> libSQL/Turso adapter (production; lands in T4)
//   PORTAL_STORE=file    -> rejected: there is no writable disk on the edge
//
// Import path from the functions tree:
//   site/functions/api/x.ts        -> ../../shared/portal-store/edge.js
//   site/functions/api/portal/x.ts -> ../../../shared/portal-store/edge.js

import { StorageError } from './errors.js';
import type { PortalStore } from './types.js';

export * from './types.js';
export { StorageError } from './errors.js';

export function getStore(env: Record<string, string | undefined> = {}): PortalStore {
  const mode = env.PORTAL_STORE || 'libsql';

  if (mode === 'file') {
    throw new StorageError(
      'the file adapter is not available on the edge runtime (no writable filesystem) — set PORTAL_STORE=libsql',
      'invalid-config',
    );
  }

  if (mode === 'libsql') {
    throw new StorageError(
      'the libsql adapter is not implemented yet (task T4) — the edge tree has no working store until then',
      'not-implemented',
    );
  }

  throw new StorageError(
    `unknown PORTAL_STORE "${mode}" (expected "libsql")`,
    'invalid-config',
  );
}
