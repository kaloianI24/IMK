// site/shared/portal-store/types.ts
//
// The storage interface shared by the two handler trees:
//   - Vercel:  api/…                (project root = repo root)
//   - Cloudflare Pages: site/functions/api/…  (project root = site/)
//
// Design: spec/proposal-portal-storage.md §2.2.
//
// WHY THIS LIVES UNDER site/ (and not at the repo root as §2.1 proposes):
// Cloudflare Pages requires the `functions/` directory at the *project root*.
// The functions tree is site/functions/, so the Pages build context is site/ —
// a repo-root `shared/` directory is not uploaded to Cloudflare and cannot be
// imported from site/functions/. Placing the canonical module in site/shared/
// makes one copy visible to both trees:
//
//   Vercel   api/portal/x.ts               -> ../../site/shared/portal-store/index.js
//   CF       site/functions/api/x.ts       -> ../../shared/portal-store/index.js
//   CF       site/functions/api/portal/x.ts -> ../../../shared/portal-store/index.js
//
// The proposal's §2.1 path examples are mutually inconsistent (the Vercel path
// assumes a repo-root `shared/`, the CF path assumes a site-root `shared/`).
// Exactly one of them can be right; see the report for the correction.

/** Every collection the portal stores. */
export type Collection =
  | 'projects'
  | 'clients'
  | 'invites'
  | 'comments'
  | 'planItems'
  | 'updates'
  | 'reviews'
  | 'sessions';

/** Equality-only filter. `undefined` values are ignored (match everything). */
export type Where = Record<string, string | number | boolean | undefined>;

/** A stored record. Shape is per-collection and owned by the handlers. */
export type StoreRecord = Record<string, any>;

export type ReviewState = 'pending' | 'approved' | 'rejected';

export type ReviewDecision = 'approved' | 'rejected';

export interface PortalStore {
  /** All records matching the (equality-only) filter, in stable order.
   *  For 'reviews' (a revision log) this is every revision, oldest first. */
  list(coll: Collection, where?: Where): Promise<StoreRecord[]>;

  /** First record where field/value match, or null. */
  get(coll: Collection, key: { field: string; value: string }): Promise<StoreRecord | null>;

  /** JSONL-append semantics: add a new record. For 'reviews' this adds a new
   *  revision of an existing ref (newest wins on read). Never swallows errors. */
  append(coll: Collection, record: StoreRecord): Promise<void>;

  /** Record-store semantics: patch every record matching key. Returns how many
   *  were updated (0 = the caller decides 404 vs idempotent-200). */
  update(coll: Collection, key: Where, patch: StoreRecord): Promise<number>;

  /** Delete every record matching key. Returns how many were removed.
   *  (Amendment to proposal §2.2 — see the note in the interface docs below.) */
  remove(coll: Collection, key: Where): Promise<number>;

  /** Newest revision of a revision-log collection matching `where`
   *  (replaces read-all-then-take-last-line in every handler). */
  latest(coll: 'reviews', where: Where): Promise<StoreRecord | null>;

  /** Atomically flip the newest pending revision of `ref`. Returns the updated
   *  record, or the already-decided record (idempotent), or null (unknown ref).
   *  Never rewrites records other than the newest revision of that ref. */
  decideReview(
    ref: string,
    decision: ReviewDecision,
    at: string,
    decidedBy?: string,
  ): Promise<StoreRecord | null>;

  /** One-shot drain of every collection as JSONL lines — powers the backup
   *  script and the migration importer's export half. */
  exportAll(): Promise<Record<Collection, string[]>>;
}
