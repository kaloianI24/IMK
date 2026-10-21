// site/shared/portal-store/libsql-store.ts
//
// Selecting the libSQL backend from the environment.
//
// WHY THIS FILE EXISTS
//   The Node entry point (index.ts) and the Cloudflare entry point (edge.ts)
//   both select the backend from an env object, but they read it from
//   different places:
//     Vercel   process.env
//     Cloudflare the request's context.env (a Pages function binding)
//   The SELECTION is the same in both trees, so it lives here — in a module
//   with NO node: imports, so both trees can import it.
//
// FAIL CLOSED
//   A missing LIBSQL_URL or LIBSQL_TOKEN is a StorageError('invalid-config'):
//   the store must never fall back to something else and must never send a
//   token-less request to the database (Turso would answer 401 and the error
//   would read like a network problem).

import { StorageError } from './errors.js';
import { createLibsqlStore } from './libsql-adapter.js';
import { createHttpTransport } from './libsql-transport.js';
import type { PortalStore } from './types.js';

/**
 * Build the libSQL-backed store from the environment.
 *
 * Throws StorageError('invalid-config') when the configuration is incomplete
 * or the URL is not an HTTP(S) URL.
 */
export function createLibsqlStoreFromEnv(
  env: Record<string, string | undefined>,
): PortalStore {
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

  return createLibsqlStore({ transport: createHttpTransport({ url, token }) });
}
