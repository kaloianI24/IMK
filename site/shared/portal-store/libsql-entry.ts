// site/shared/portal-store/libsql-entry.ts
//
// The one module a Node script needs to talk to the portal store.
//
// It exists because the store modules are TypeScript (the handlers are
// TypeScript too) while the scripts in site/scripts/ are plain .mjs. A
// script bundles this entry with esbuild — the same bundler
// site/scripts/test-portal-store.mjs already uses — and imports the result.
//
// It is NOT imported by the handler trees: they import the modules directly,
// so nothing here can end up in a function bundle by accident.

export { createFileStore, COLLECTION_FILES } from './file-adapter.js';
export { createLibsqlStore } from './libsql-adapter.js';
export { createHttpTransport, pipelineEndpoint } from './libsql-transport.js';
export { createLibsqlStoreFromEnv } from './libsql-store.js';
export { ensureSchema, SCHEMA_STATEMENTS } from './libsql-schema.js';
export { createLibsqlRateLimitBackend, hashCounterKey } from './durable-rate-counter.js';
export { StorageError } from './errors.js';
export type { Collection, PortalStore, Where, StoreRecord } from './types.js';
