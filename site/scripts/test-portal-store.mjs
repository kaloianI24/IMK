// site/scripts/test-portal-store.mjs
//
// Runs the shared portal-store contract tests.
//
// The tests are TypeScript (the store is TypeScript, like the handlers), so
// they are bundled with esbuild — the same bundler dev-portal.js already uses
// — and executed under node:test. The bundle is written to a temp directory,
// never into the repo.
//
// Usage: npm run test:store

import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SITE = resolve(__dirname, '..');
const ENTRY = resolve(SITE, 'shared/portal-store/test/contract.test.ts');
const OUT_DIR = resolve(os.tmpdir(), 'imk-portal-store-test');
const OUT_FILE = resolve(OUT_DIR, 'contract.test.mjs');

fs.mkdirSync(OUT_DIR, { recursive: true });

await build({
  entryPoints: [ENTRY],
  outfile: OUT_FILE,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  logLevel: 'warning',
});

const result = spawnSync(process.execPath, ['--test', OUT_FILE], { stdio: 'inherit' });
process.exit(result.status ?? 1);
