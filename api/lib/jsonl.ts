// api/lib/jsonl.ts — Vercel-side store reader.
//
// The parsing rules live in site/shared/portal-store/jsonl.ts so both handler
// trees use the same one (see that file for why: audit M3 / QA D3).
// This module only adds the Node filesystem access.

import * as fs from 'node:fs';
import {
  parseJsonlStrict,
  StorageCorruptError,
  isStorageCorrupt,
  guardStorage,
} from '../../site/shared/portal-store/jsonl.js';

export { parseJsonlStrict, StorageCorruptError, isStorageCorrupt, guardStorage };

/**
 * Read a JSONL store file.
 *   - a missing file is an empty store (a fresh install) — not an error
 *   - a malformed line throws StorageCorruptError (file + line)
 */
export function readJsonlFile(file: string): Array<Record<string, any>> {
  if (!fs.existsSync(file)) return [];
  return parseJsonlStrict(fs.readFileSync(file, 'utf8'), file);
}
