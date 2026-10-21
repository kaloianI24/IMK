// site/shared/portal-store/file-adapter.ts
//
// The `file` adapter: the current JSONL-on-disk behaviour, behind the
// PortalStore interface. It is the local-dev adapter and the rollback path
// (proposal §2.1, T3, T7).
//
// Fidelity rules for this adapter:
//   1. Byte-compatible with today's helpers — readJsonl/appendJsonl/rewriteJsonl
//      produce and consume exactly this format, so `publish-testimonials.mjs`
//      and the moderation publisher keep working unchanged.
//   2. "Later lines win" for the reviews revision log — identical to
//      api/moderate/review.ts and the publisher.
//   3. Errors are thrown, never swallowed. The only difference from today's
//      readJsonl is that a CORRUPT file now raises instead of silently
//      returning [] (proposal T9: "never [] pretending to be real data").
//      A missing file is still an empty collection, not an error.

import * as fs from 'node:fs';
import * as path from 'node:path';

import { StorageError } from './errors.js';
import type {
  Collection,
  PortalStore,
  ReviewDecision,
  StoreRecord,
  Where,
} from './types.js';

/** Collection -> JSONL file, relative to the data directory.
 *  'invites' is the invited-clients file (invited.jsonl) and 'clients' is the
 *  client-record file (clients.jsonl) — they are different collections. */
export const COLLECTION_FILES: Record<Collection, string> = {
  projects: 'portal/projects.jsonl',
  clients: 'portal/clients.jsonl',
  invites: 'portal/invited.jsonl',
  comments: 'portal/comments.jsonl',
  planItems: 'portal/planItems.jsonl',
  updates: 'portal/updates.jsonl',
  reviews: 'moderation/reviews.jsonl',
  sessions: 'portal/sessions.jsonl',
};

export interface FileStoreOptions {
  /** Root that holds `portal/` and `moderation/` (i.e. site/data). */
  dataDir: string;
}

/** Equality-only match. Numbers and strings compare by their string form so a
 *  JSON-sourced id ("42") still matches a numeric filter (42) — the handlers
 *  already do this in places (e.g. String(r.email).toLowerCase()). */
function matches(record: StoreRecord, where?: Where): boolean {
  if (!where) return true;
  for (const key of Object.keys(where)) {
    const expected = where[key];
    if (expected === undefined) continue;
    const actual = record[key];
    if (actual === expected) continue;
    if (actual === undefined || actual === null) return false;
    if (String(actual) !== String(expected)) return false;
  }
  return true;
}

function readRecords(file: string): StoreRecord[] {
  let content: string;
  try {
    if (!fs.existsSync(file)) return [];
    content = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new StorageError(
      `cannot read ${file}: ${(e as Error).message}`,
      'storage-unavailable',
      e,
    );
  }

  const records: StoreRecord[] = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (e) {
      throw new StorageError(
        `corrupt record in ${file} at line ${i + 1}: ${(e as Error).message}`,
        'storage-corrupt',
        e,
      );
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new StorageError(
        `corrupt record in ${file} at line ${i + 1}: not a JSON object`,
        'storage-corrupt',
      );
    }
    records.push(parsed as StoreRecord);
  }
  return records;
}

/** Byte-identical to today's rewriteJsonl: one JSON object per line, trailing
 *  newline, no blank lines. */
function writeRecords(file: string, records: StoreRecord[]): void {
  const content =
    records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : '');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf8');
  } catch (e) {
    throw new StorageError(
      `cannot write ${file}: ${(e as Error).message}`,
      'storage-unavailable',
      e,
    );
  }
}

/** Byte-identical to today's appendJsonl. */
function appendRecord(file: string, record: StoreRecord): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8');
  } catch (e) {
    throw new StorageError(
      `cannot append to ${file}: ${(e as Error).message}`,
      'storage-unavailable',
      e,
    );
  }
}

export function createFileStore(options: FileStoreOptions): PortalStore {
  const dataDir = path.resolve(options.dataDir);
  const fileFor = (coll: Collection): string => path.join(dataDir, COLLECTION_FILES[coll]);

  return {
    async list(coll: Collection, where?: Where): Promise<StoreRecord[]> {
      const records = readRecords(fileFor(coll));
      return where ? records.filter((r) => matches(r, where)) : records;
    },

    async get(
      coll: Collection,
      key: { field: string; value: string },
    ): Promise<StoreRecord | null> {
      const records = readRecords(fileFor(coll));
      const found = records.find((r) => matches(r, { [key.field]: key.value } as Where));
      return found ?? null;
    },

    async append(coll: Collection, record: StoreRecord): Promise<void> {
      appendRecord(fileFor(coll), record);
    },

    async update(coll: Collection, key: Where, patch: StoreRecord): Promise<number> {
      if (coll === 'reviews') {
        // Moderation decisions must stay atomic and go through decideReview();
        // a generic patch would silently break the "newest wins" contract.
        throw new StorageError(
          "update() is not allowed on the 'reviews' collection — use decideReview()",
          'invalid-operation',
        );
      }
      const file = fileFor(coll);
      const records = readRecords(file);
      let count = 0;
      for (const record of records) {
        if (!matches(record, key)) continue;
        Object.assign(record, patch);
        count += 1;
      }
      if (count > 0) writeRecords(file, records);
      return count;
    },

    async remove(coll: Collection, key: Where): Promise<number> {
      if (coll === 'reviews') {
        throw new StorageError(
          "remove() is not allowed on the 'reviews' collection — the revision log is append-only",
          'invalid-operation',
        );
      }
      const file = fileFor(coll);
      const records = readRecords(file);
      const kept = records.filter((r) => !matches(r, key));
      const count = records.length - kept.length;
      if (count > 0) writeRecords(file, kept);
      return count;
    },

    async latest(coll: 'reviews', where: Where): Promise<StoreRecord | null> {
      const records = readRecords(fileFor(coll));
      // "Later lines win" — the newest matching revision is the last match.
      for (let i = records.length - 1; i >= 0; i--) {
        if (matches(records[i], where)) return records[i];
      }
      return null;
    },

    async decideReview(
      ref: string,
      decision: ReviewDecision,
      at: string,
      decidedBy = 'one-click-link',
    ): Promise<StoreRecord | null> {
      const file = fileFor('reviews');
      const records = readRecords(file);

      // Newest revision of this ref that is actually a review record — the same
      // rule as api/moderate/review.ts and the Cloudflare twin.
      let idx = -1;
      for (let i = records.length - 1; i >= 0; i--) {
        if (records[i].ref === ref && records[i].type === 'review') {
          idx = i;
          break;
        }
      }
      if (idx === -1) return null;

      const record = records[idx];
      if (record.state !== 'pending') {
        // Idempotent: already decided, nothing changes and nothing is written.
        return { ...record };
      }

      record.state = decision;
      record.decidedAt = at;
      record.decidedBy = decidedBy;
      writeRecords(file, records);
      return { ...record };
    },

    async exportAll(): Promise<Record<Collection, string[]>> {
      const out = {} as Record<Collection, string[]>;
      for (const coll of Object.keys(COLLECTION_FILES) as Collection[]) {
        const file = fileFor(coll);
        try {
          out[coll] = fs.existsSync(file)
            ? fs
                .readFileSync(file, 'utf8')
                .split('\n')
                .filter((line) => line.trim() !== '')
            : [];
        } catch (e) {
          throw new StorageError(
            `cannot export ${file}: ${(e as Error).message}`,
            'storage-unavailable',
            e,
          );
        }
      }
      return out;
    },
  };
}
