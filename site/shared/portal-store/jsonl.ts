// site/shared/portal-store/jsonl.ts
//
// Strict JSONL reading, shared by BOTH handler trees:
//   Vercel    api/…                     -> ../../site/shared/portal-store/jsonl.js
//   Cloudflare site/functions/api/…     -> ../../../shared/portal-store/jsonl.js
//
// WHY THIS EXISTS (audit M3 / QA D3):
// the live handlers read their append-only stores with `.map(JSON.parse)` and
// swallowed the error, so ONE malformed line made a whole collection read as
// EMPTY. The API then answered "project not found", "0 projects", "sign-in not
// allowed" or "review not found" — a silent outage that looks like a normal
// answer. The correct pattern already existed twice in this repo
// (api/portal/invites.ts `readJsonlForWrite`, portal-store/file-adapter.ts)
// and in the store module's own rule: "a handler that cannot reach the store
// must answer 503, never 'here is an empty list'" (portal-store/errors.ts).
//
// THE RULE NOW: a store that cannot be parsed is an ERROR, never an empty list.
// The handler turns it into 500 {code:'storage'}.
//
// No imports on purpose: this module must load in the edge runtime as well as
// in Node, and it must not drag node:fs into a Cloudflare bundle.

/** Thrown when a store file contains a line that is not a JSON object. */
export class StorageCorruptError extends Error {
  /** The store file the bad line came from. */
  readonly file: string;
  /** 1-based line number of the bad line. */
  readonly line: number;

  constructor(file: string, line: number, cause?: unknown) {
    super(`storage-corrupt: ${file}:${line}`);
    this.name = 'StorageCorruptError';
    this.file = file;
    this.line = line;
    if (cause !== undefined) {
      (this as { cause?: unknown }).cause = cause;
    }
  }
}

/** True when the error is a corrupt-store error (not any other failure). */
export function isStorageCorrupt(err: unknown): err is StorageCorruptError {
  return err instanceof StorageCorruptError;
}

/**
 * Parse a JSONL document. Every non-empty line must be a JSON object.
 * Throws StorageCorruptError (file + line) on the first bad line.
 */
export function parseJsonlStrict(
  content: string,
  label: string,
): Array<Record<string, any>> {
  // A hand-edited file (Notepad) can carry a UTF-8 BOM; it would break the
  // first record. The publisher already strips it — do the same here.
  const text = String(content ?? '').replace(/^\uFEFF/, '');
  const records: Array<Record<string, any>> = [];
  const lines = text.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '') continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      throw new StorageCorruptError(label, i + 1, err);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new StorageCorruptError(label, i + 1);
    }
    records.push(parsed as Record<string, any>);
  }

  return records;
}

/**
 * Run a handler and turn a corrupt store into a clean, explicit answer
 * instead of a crash or a misleading empty list.
 *
 *   guardStorage(() => handle(req, res), (err) => json(res, {code:'storage'}, 500))
 *
 * Any other error is re-thrown untouched — this guard only owns the store.
 */
export async function guardStorage<T>(
  fn: () => Promise<T> | T,
  onCorrupt: (err: StorageCorruptError) => T,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isStorageCorrupt(err)) return onCorrupt(err);
    throw err;
  }
}
