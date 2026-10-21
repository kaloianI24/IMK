# Proposal — Portal storage migration (JSONL on disk → shared storage layer)

**Status:** proposal for review (Architect, 2026-10-20). Planning deliverable only — no product code was changed.
**Scope:** `api/` (Vercel target), `site/functions/` (Cloudflare Pages Functions target), `site/scripts/` (dev server + prebuild publisher), `site/data/`.
**Problem:** the entire portal/moderation store is JSONL files appended with `node:fs`. Only `/tmp` is writable on Vercel; Cloudflare Pages Functions have **no writable filesystem at all**. On the CF target the testimonials endpoint answers `501 unimplemented` and every other write path is either a `501` or a swallowed best-effort no-op. The portal works only locally (via `site/scripts/dev-portal.js`, which runs the *Vercel* handlers in Node). Launch blocker.

All statements below were verified by reading the repo on 2026-10-20. Commands run are listed in §0.

---

## 0. Verification performed

```
Get-ChildItem (repo tree)                                  — layout of api/, site/functions/, site/scripts/, site/data/
glob **/*.jsonl                                            — 0 files: no JSONL exists on disk right now
Get-ChildItem site\data -Recurse -Force                    — only the two empty dirs site/data/portal, site/data/moderation
git ls-files / git status --porcelain                      — no .jsonl tracked; api/portal/* and site/functions/portal/* untracked-but-present working files
grep -e "readFileSync|appendFileSync|writeFile|..." api/   — 52 matches across 8 files
grep -e "readFileSync|appendFileSync|writeFile|..." site/functions/ — 29 matches across 8 files
grep -e "readFileSync|..." site/scripts/                   — 28 matches (publisher, dev server, brand/og generators)
grep -e "\.jsonl|_FILE =" api/ and site/functions/         — every handler → data-file mapping
grep -e "501|unimplemented|appendJsonl|rewriteJsonl" site/functions/ — CF write-path inventory
grep -e "appendJsonl\(|rewriteJsonl\(|readJsonl\(" api/portal — every call site
read: api/portal/{projects,auth,session,testimonials}.ts, api/moderate/review.ts,
      site/functions/api/portal/{testimonials,comments,session,plan-items,invites,updates,projects,auth}.ts,
      site/functions/api/moderate/review.ts, site/functions/api/contact.ts (grep),
      site/scripts/{dev-portal.js,api-index.ts,publish-testimonials.mjs}, site/package.json,
      site/.env.example, .github/workflows/ci.yml, site/docs/ops/rollback.md, vercel.json, spec/08 (grep)
```

Two findings that differ from the briefing, both verified:

1. **The Vercel target cannot persist either.** `api/` handlers resolve `process.cwd()/'site/data/portal'` and call `fs.appendFileSync`/`writeFileSync` **without try/catch** (e.g. `api/portal/projects.ts:75-84`). On Vercel's read-only lambda FS (writable only `/tmp`) these throw at runtime → the request 500s. The Vercel variant is not a working persistence target in production today; it works only because the local dev server runs it in plain Node against the repo directory. `spec/08` P-6 already calls Vercel "interim only", and CI's `deploy-vercel` job is a guard-stub, not a wired deploy (`.github/workflows/ci.yml:56-75`).
2. **The CF reads fail silently, not loudly.** Only testimonials has an explicit `501`. `comments`/`plan-items`/`projects`/`updates` GETs call `readJsonl`, which returns `[]` when the fs shim is absent (`site/functions/api/portal/comments.ts:22-35` etc.) — a signed-in client sees an **empty portal board** instead of "unavailable". CF `auth` likewise reads `invited.jsonl` as `[]`, so on CF only admin magic links work; invited clients are silently refused (`site/functions/api/portal/auth.ts:256-257`), and client-record creation on first login is explicitly deferred (`auth.ts:330-331`). This is arguably worse than the 501 and must be fixed by the same migration.

---

## 1. Current state — data files and their code paths

### 1.1 Data files (all under `site/data/`, all currently **absent** — dirs exist, zero files; created on first write)

| File | Contents | Semantics today |
|---|---|---|
| `site/data/portal/projects.jsonl` | project records (`prj_…`) | append on create; **full rewrite** on PATCH (status/title/testimonialStatus) |
| `site/data/portal/clients.jsonl` | client records (`cli_…`) | append-only, created on first client login |
| `site/data/portal/invited.jsonl` | invite records | append on invite; full rewrite to back-link `clientId` after first login |
| `site/data/portal/comments.jsonl` | comment records | append-only |
| `site/data/portal/planItems.jsonl` | plan-item records | append on create; full rewrite on status change |
| `site/data/portal/updates.jsonl` | changelog records | append-only |
| `site/data/moderation/reviews.jsonl` | review/testimonial revisions (`rev_…`) | **append-only revision log — newest line per `ref` wins**; moderation flip rewrites the whole file |

Note: `api/contact.ts` no longer writes reviews — review submissions there are refused with `410 review-moved` (`api/contact.ts:235-254`). The moderation queue is fed exclusively by `POST /api/portal/testimonials`.

### 1.2 Who reads / who writes / frequency

**`projects.jsonl`**

| Access | Vercel (`api/`) | Cloudflare (`site/functions/`) |
|---|---|---|
| Read | `portal/projects.ts` GET list + GET :id (L129,141); `portal/comments.ts` (L98); `portal/plan-items.ts` (L101); `portal/updates.ts` (L98); `portal/testimonials.ts` (L196,215) | `portal/projects.ts` GET (L58); `portal/comments.ts` (L54); `portal/plan-items.ts` (L57); `portal/updates.ts` (L54); `portal/testimonials.ts` (L192,210) |
| Write | `portal/projects.ts` append POST (L290), rewrite PATCH (L224); `portal/testimonials.ts` rewrite `setProjectTestimonialStatus` (L221) | `portal/testimonials.ts` rewrite (L216) — best-effort, errors swallowed; POST/PATCH on projects are `501` (L94,108) |

Frequency: reads on every portal page load and every comments/plan-items/updates/testimonials fetch (a few per week per active project, admin board daily-ish). Writes: a few per month (project create/status change) + one per testimonial action.

**`clients.jsonl`**

| Access | Vercel | Cloudflare |
|---|---|---|
| Read | `portal/projects.ts` POST resolve (L271); `portal/testimonials.ts` (L201) | `portal/testimonials.ts` (L197) — returns null silently |
| Write | `portal/auth.ts` append on first client login (L321) | none — explicitly deferred (`auth.ts:330-331`) |

Frequency: read on project create + every testimonial submission; write once per client lifetime.

**`invited.jsonl`**

| Access | Vercel | Cloudflare |
|---|---|---|
| Read | `portal/auth.ts` `isInvited` (L92) + verify (L315); `portal/invites.ts` (L104) | `portal/auth.ts` (L256,327) |
| Write | `portal/invites.ts` append (L120); `portal/auth.ts` rewrite to link clientId (L334) | none |

Frequency: read on **every magic-link request** (rate-limited to 5/h per IP); write on invite (a few per month).

**`comments.jsonl`**

| Access | Vercel | Cloudflare |
|---|---|---|
| Read | `portal/comments.ts` GET (L113) | `portal/comments.ts` GET (L55) |
| Write | `portal/comments.ts` append POST (L178) | `501` (L84) |

Frequency: read on every portal board open; write a few per week during active projects.

**`planItems.jsonl`**

| Access | Vercel | Cloudflare |
|---|---|---|
| Read | `portal/plan-items.ts` (L119,152,275) | `portal/plan-items.ts` (L58) |
| Write | `portal/plan-items.ts` append POST (L289), rewrite PATCH (L218) | `501` (L83,87) |

**`updates.jsonl`**

| Access | Vercel | Cloudflare |
|---|---|---|
| Read | `portal/updates.ts` (L112) | `portal/updates.ts` (L55) |
| Write | `portal/updates.ts` append POST (L178) | `501` (L80) |

**`reviews.jsonl`** (the load-bearing one — moderation depends on it)

| Access | Vercel | Cloudflare | Build |
|---|---|---|---|
| Read | `moderate/review.ts` (L54); `portal/testimonials.ts` GET + POST, `latestRecordForProject` takes the **last matching line** (L159) | `moderate/review.ts` (L64) — returns `[]` on edge → every moderation link answers **404 "review not found"**; `portal/testimonials.ts` (L156) | `site/scripts/publish-testimonials.mjs` prebuild reads it (`latestByRef` = last line per ref, L65-74) |
| Write | `portal/testimonials.ts` append revision (L443); `moderate/review.ts` full rewrite on approve/reject (L68) | both exist but are best-effort no-ops on the edge (`moderate/review.ts:77-87`, `testimonials.ts:99-123`, swallowed `catch`) | — |

Frequency: read on every testimonial card fetch and every moderation click; write once per submission/snooze/decline and once per moderation decision. **Ordering is the contract:** "later lines win" is stated identically in `api/moderate/review.ts:126-129`, `site/functions/api/moderate/review.ts:135-136`, `publish-testimonials.mjs:64`, and `site/functions/api/portal/testimonials.ts:155-161`.

### 1.3 Adjacent storage (in scope for the interface, called out separately)

- **Sessions:** in-memory `Map` on both targets (`api/portal/session.ts:18`, `site/functions/api/portal/session.ts:12` via `globalThis`). On CF this map is **per-isolate**, so sessions are effectively broken in production today regardless of filesystem: a request landing on a different isolate than the one that ran `/verify` gets 401. Any migration deploy wipes existing sessions either way (they also die on every redeploy by design — `spec/08` §"Session storage").
- **Magic-link tokens + auth rate limits:** in-memory Maps, same per-isolate caveat (`api/portal/auth.ts:32-38`, CF mirror).
- **`site/data/` in git:** nothing tracked; the dirs are empty placeholders. `publish-testimonials.mjs` treats a missing file as "write nothing" — safe.

---

## 2. Proposed data layer — one interface, both trees

### 2.1 Placement and wiring

New top-level directory **`shared/portal-store/`** (proposed; nothing exists yet), imported *relatively* from both handler trees:

- Vercel: `api/portal/*.ts` → `import { getStore } from '../../shared/portal-store/index.js'` — Vercel's builder bundles relative imports.
- Cloudflare: `site/functions/api/portal/*.ts` → `../../../shared/portal-store/` — Pages Functions bundle relative imports into the functions build. **Spike task required** (T2 below) to confirm with a smoke deploy before committing; the current code avoided imports outside `functions/` only for `node:fs`, not as a stated constraint.
- Local dev: `site/scripts/dev-portal.js` already esbuild-bundles everything from one entry (`api-index.ts`), so the shared module lands in that bundle with zero changes.

Backend selection is env-driven at request time, not build time — the same handler code runs everywhere:

```ts
// shared/portal-store/index.ts
export function getStore(env: Record<string, string | undefined>): PortalStore {
  if (!env.PORTAL_STORE || env.PORTAL_STORE === 'file') return fileStore();      // local dev / dev-stub
  if (env.PORTAL_STORE === 'libsql') return libsqlStore(env.LIBSQL_URL!, env.LIBSQL_TOKEN!);
  throw new Error('unknown PORTAL_STORE');
}
```

Vercel handlers pass `process.env`; CF handlers pass `ctx.env`. No handler ever imports `node:fs` again.

### 2.2 TypeScript signature

Small on purpose: `get / list / append / update` per collection, plus `latest` because the reviews collection is a revision log, not a record table.

```ts
export type Collection =
  | 'projects' | 'clients' | 'invites'
  | 'comments' | 'planItems' | 'updates'
  | 'reviews' | 'sessions';

export type Where = Record<string, string | number | boolean | undefined>;

export interface PortalStore {
  /** All records matching the (equality-only) filter, stable order.
   *  For 'reviews' (revision log): returns every revision, oldest first. */
  list(coll: Collection, where?: Where): Promise<Record<string, any>[]>;

  /** First record where field/value match, or null. */
  get(coll: Collection, key: { field: string; value: string }): Promise<Record<string, any> | null>;

  /** JSONL-append semantics: add a new record. For 'reviews' this adds a new
   *  revision of an existing ref (newest wins on read). Never swallows errors. */
  append(coll: Collection, record: Record<string, any>): Promise<void>;

  /** Record-store semantics: patch every record matching key. Returns how many
   *  were updated (0 = caller decides 404 vs idempotent-200). Atomic per record
   *  in the libsql adapter; read-modify-write in the file adapter. */
  update(coll: Collection, key: Where, patch: Record<string, any>): Promise<number>;

  /** Newest revision of a revision-log collection matching `where`
   *  (replaces read-all-then-take-last-line in every handler). */
  latest(coll: 'reviews', where: Where): Promise<Record<string, any> | null>;

  /** One-shot drain of every collection as JSONL lines — powers the backup
   *  script and the migration importer's export half. */
  exportAll(): Promise<Record<Collection, string[]>>;
}
```

Contract rules (to be asserted in adapter tests):

- `append`/`update` **throw** on failure. Handlers map a storage error to `503 { code: 'storage-unavailable' }`. The current "swallow and pretend success" behaviour on CF is a bug, not a feature — a client who submits a testimonial must never get `ok:true` for a write that vanished.
- `update` on `reviews` is **not** exposed; moderation decisions go through a dedicated method on the store so the flip stays atomic and idempotent:

```ts
  /** Atomically flip the newest pending revision of `ref`. Returns the updated
   *  record, or the already-decided record (idempotent), or null (unknown ref). */
  decideReview(ref: string, decision: 'approved' | 'rejected', at: string):
    Promise<Record<string, any> | null>;
```

  In the libsql adapter this is one statement — `UPDATE reviews SET state=?, decidedAt=?, decidedBy=? WHERE ref=? AND state='pending'` against the row already selected as newest-per-ref — which is *strictly stronger* than today's read-all → mutate → rewrite-whole-file, and preserves the idempotent "already decided → 200, no change" behaviour (`api/moderate/review.ts:139-144`).

### 2.3 Before/after handler examples

**(a) `api/portal/projects.ts` — GET list (Vercel; CF mirror is identical modulo `Response`)**

```ts
// BEFORE (L128-134)
const projects = readJsonl(PROJECTS_FILE);
const visible = session.role === 'admin' ? projects
  : projects.filter((p) => projectAccessible(p, session));
json(res, { ok: true, projects: visible }, 200);

// AFTER
const store = getStore(process.env);
const projects = await store.list('projects');
const visible = session.role === 'admin' ? projects
  : projects.filter((p) => projectAccessible(p, session));
json(res, { ok: true, projects: visible }, 200);
```

The 30-line local `readJsonl`/`appendJsonl`/`rewriteJsonl` blocks (duplicated ~8× per tree today) disappear from every handler.

**(b) `api/moderate/review.ts` — the state flip (the atomicity-critical path)**

```ts
// BEFORE (L125-151): read whole file, find LAST matching line, mutate, rewrite WHOLE file
const reviews = readReviews();
let idx = -1;
for (let i = 0; i < reviews.length; i++) {
  if (reviews[i].ref === ref && reviews[i].type === 'review') idx = i;
}
const record = reviews[idx];
if (record.state !== 'pending') { json(res, { ok: true, ref, state: record.state, ... }, 200); return; }
record.state = decision === 'approve' ? 'approved' : 'rejected';
record.decidedAt = now; record.decidedBy = 'one-click-link';
writeReviews(reviews);   // full-file rewrite — loses concurrent appends if ever parallel

// AFTER
const store = getStore(process.env);
const record = await store.decideReview(ref, decision, now);
if (!record) { json(res, { error: 'review not found', code: 'not-found' }, 404); return; }
json(res, { ok: true, ref, state: record.state, ...(record.decidedAt ? { decidedAt: record.decidedAt } : {}) }, 200);
```

**(c) `site/functions/api/portal/testimonials.ts` — POST, where the 501 dies**

```ts
// BEFORE (L262-267)
export const onRequestPost: any = async (ctx: any): Promise<Response> => {
  const { request, env } = ctx;
  if (!fsModule()) {
    return json({ error: 'not implemented on CF target', code: 'unimplemented' }, 501);
  }
  ...
  appendJsonl(REVIEWS_FILE, record);           // silent no-op on edge even if guard removed
  setProjectTestimonialStatus(project, ...);   // silent no-op on edge

// AFTER
export const onRequestPost: any = async (ctx: any): Promise<Response> => {
  const { request, env } = ctx;
  const store = getStore(env);
  ...
  try {
    await store.append('reviews', record);
    await store.update('projects', { id: project.id }, {
      testimonialStatus: action === 'submit' ? 'requested' : action === 'snooze' ? 'snoozed' : 'declined',
      updatedAt: now, updatedBy: session.email,
    });
  } catch {
    return json({ error: 'storage unavailable', code: 'storage-unavailable' }, 503);
  }
  return json({ ok: true, testimonial: clientView(record) }, 200);
};
```

Same validation, same provenance rules (verifiedClient/server-derived fields untouched) — only the persistence line changes. The `501` guards in all CF handlers are deleted as their handlers are ported (T7).

---

## 3. Store options, honestly assessed at this scale

Scale facts: ~a handful of clients; writes are single-digit per week at peak, not per second; values are small (< 4 KB each); total data at launch ≈ tens of kilobytes. Every option below costs **$0** on its free tier for the foreseeable future — cost is *not* the differentiator. Consistency, dual-target reach, and dev parity are.

| | CF KV | CF D1 | Turso (libSQL) | Upstash Redis | Vercel Postgres (Neon) |
|---|---|---|---|---|---|
| Reachable from CF Functions | native binding | native binding only¹ | yes — HTTP (`@libsql/client`, fetch-based) | yes — HTTP | via HTTP driver |
| Reachable from Vercel | yes, via REST w/ account token | **no clean path**¹ | yes — native/HTTP | yes — native/HTTP | native |
| One store serves both targets? | technically yes, but see consistency | **no** | **yes** | **yes** | yes (awkwardly — CF side needs HTTP driver + its own credential) |
| Consistency | **eventual, global — up to ~60 s stale reads; no CAS** | strongly consistent (SQLite) | strongly consistent (single-writer SQLite semantics) | strongly consistent per key | strongly consistent |
| Atomicity for moderation flip | ❌ last-write-wins races between admin click and concurrent client append | ✅ SQL transaction | ✅ SQL transaction | ⚠️ manual `WATCH`/Lua; easy to get subtly wrong | ✅ SQL transaction |
| Append/newest-line-wins fit | manual: one key per collection or per ref; rewrite-the-blob on every append (KV write quota 1,000/day free — fine, but every write rewrites everything) | natural: `ORDER BY seq` / `rowid` preserves JSONL order | natural: `ORDER BY seq`; `rowid` import preserves file order exactly | awkward: JSON blobs in hash keys; no ordered scan without extra bookkeeping | natural: SQL + `ORDER BY seq` |
| Local dev / offline parity | miniflare (already half-working in `.wrangler/state`) | wrangler d1 local | `file:` libSQL URL, or **keep the JSONL file adapter as the local default** | needs a local Redis or mock | needs a local pg or mock |
| Migrating existing JSONL | script → `kv bulk` | script → `d1 import`/batched inserts | script → batched inserts, `rowid` = line order | script → `set` per record | script → `COPY`/inserts |
| Free-tier headroom at this scale | 100k reads / 1k writes **per day** | 5M reads / 100k writes per day | 500 DBs / multiple GB | 10k cmds/day, 256 MB | 0.5 GB |

¹ D1 can technically be driven from outside CF via the Cloudflare *account* REST API, but that puts an account-scoped API token in the Vercel deployment and couples both platforms' availability to CF account auth. Not a foundation to build on.

**The dual-target question, answered directly:** *yes, one store can serve both — but only if it speaks HTTP*, because that is the one protocol both runtimes share without platform-native bindings. That constraint eliminates D1 (clean path) and makes plain "Vercel Postgres" lopsided (Neon-over-fetch works from CF, but then CF carries a second vendor credential and Vercel carries a first-party one). Turso, Upstash, and (via its HTTP driver) Neon all qualify.

**The consistency question, answered directly:** KV's eventual consistency is a poor match for the one place this app has a real correctness rule — `reviews.jsonl`'s "newest line wins" + idempotent moderation flip. Under KV, an approve click can land on a different edge than a concurrent client append, both rewrite the collection blob, and the slower write silently resurrects a stale revision — exactly the failure the full-file-rewrite code was (clumsily) protecting against. At this volume the race window is tiny but the *data loss is silent and permanent*, and the mitigation (per-ref keys + revision counters + retries) is more code than a SQLite row.

---

## 4. Recommendation

**Adopt one Turso (libSQL) database as the single production store for both targets, behind the `PortalStore` interface from §2, with the current JSONL behaviour preserved as the `file` adapter for local dev and as the rollback path.**

Rationale:

1. **It is the only option that is simultaneously (a)** reachable from both runtimes over HTTP with first-class clients, **(b)** strongly consistent — the moderation flip becomes an atomic `UPDATE … WHERE state='pending'`, strictly better than today, **(c)** a natural semantic fit for the JSONL access patterns (`append` → insert, ordering preserved via `seq`/`rowid`, `latest()` → `ORDER BY seq DESC LIMIT 1`), and **(d)** locally runnable offline via a `file:` libSQL URL — or simply by pointing `PORTAL_STORE=file` at the unchanged JSONL adapter, so `npm run dev:portal` keeps working with zero infrastructure.
2. **It matches the spec's own trajectory.** `spec/08` §3 defers the DB decision to "Phase 3.2: graduate to SQLite (Turso) or PostgreSQL (Neon)" (line 90) and Q4 listed exactly these two. This proposal *is* Phase 3.2, sized.
3. **Migration is a non-event today.** Verified: `site/data/portal` and `site/data/moderation` are empty — no JSONL file exists in the repo or on this machine. There is no production data to move; we only need the importer for data created between now and cutover (invites, projects, the first real reviews).
4. **Cost is $0** at this volume with 100× headroom on every axis; no downsides to defer.
5. **Rollback is cheap by construction:** the `PORTAL_STORE` env switch means rolling back is an env-var edit + redeploy on each dashboard, and the `file` adapter is the pre-migration behaviour exactly.

**Explicit alternative rejected: Cloudflare KV (+ REST access from Vercel).** It was the most attractive zero-dependency answer — the repo already uses a KV binding for contact-form rate limiting (`site/functions/api/contact.ts:55-63`, `KV_COUNTER` in `.env.example`), it is CF-native, and its REST API would let the Vercel tree share it. Rejected because: (1) **eventual global consistency** — the exact failure mode of the moderation flow described in §3; (2) **no compare-and-set** — every collision-prone update (moderation flip, plan-item status change, invite→clientId back-link) would need hand-rolled versioning with retries, i.e. a worse re-implementation of a database; (3) append semantics degrade to "rewrite the whole collection blob per write", which is fine on quota but triples the blast radius of a lost write. Runner-up, equally valid if the Manager prefers Postgres lineage or wants a vendor *not* named Cloudflare: **Neon via its HTTP driver** — same interface, swap the adapter; nothing in §2 or §5 changes.

**Adjacent decision folded in:** sessions move into the same store (`sessions` collection, 24 h TTL, indexed by token). This is not optional polish — it is what makes the portal work on CF at all, given per-isolate memory. Magic-link tokens can stay in-memory (15-minute lifetime; a miss just re-requests the link) — call this out to Backend as an explicit non-goal.

---

## 5. Task breakdown

Ordered; owner B = Backend, D = DevOps, M = Manager. Sizes: S ≤ 0.5 day, M ≤ 2 days, L ≤ 1 week.

| # | Task | Owner | Size | Depends on | Acceptance criteria |
|---|---|---|---|---|---|
| T1 | Ratify this proposal (incl. the §4 decision & the Turso-vs-Neon runner-up) | M | S | — | Written sign-off in this file's header or a linked decision record; open questions Q1–Q5 (§7) answered |
| T2 | **Spike:** verify CF Pages Functions bundle a relative import from a new top-level `shared/` dir, and that `@libsql/client` runs on the workers runtime | B | S | T1 | Throwaway branch: one function imports a `shared/` module, deploys to a Pages preview, returns 200; note bundle size; spike reverted |
| T3 | Create `shared/portal-store/`: types (§2.2), `file` adapter wrapping current readJsonl/appendJsonl/rewriteJsonl semantics, adapter contract tests (ordering, newest-wins, error-throwing, `decideReview` idempotency) | B | M | T1 | Tests green locally for the file adapter; `decideReview` proven idempotent (second call returns same state, no double-write) |
| T4 | Provision Turso DB (free tier), write `libsql` adapter + schema (`seq`-ordered tables per collection, unique newest-per-ref view or trigger for reviews) | B + D | M | T3 | Adapter passes the same contract test suite against `turso dev` locally and a cloud preview DB |
| T5 | Migration + backup tooling: `npm run data:import` (JSONL files → store, preserving line order as `seq`), `npm run data:export` (store → JSONL snapshot, `exportAll()`) | B | S | T3, T4 | Round-trip test: import an exported snapshot, export again, byte-identical per collection; importer is idempotent (re-run creates no dupes) |
| T6 | Data export/backup story: weekly GitHub Action on `main` runs `data:export` and uploads the JSONL snapshot as an artifact (retention ≥ 30 days); document restore | D | S | T5 | Action green on a PR; artifact contains every collection; restore steps verified once by hand |
| T7 | Port Vercel handlers (`api/portal/*`, `api/moderate/review.ts`) to `PortalStore`; delete local fs helpers; sessions → store | B | M | T3-T5 | `npm run dev:portal` full flow works locally with `PORTAL_STORE=file` (magic link → board → comment → plan item → testimonial → moderation flip → publisher reads); no `fs` import remains in `api/portal/` or `api/moderate/` |
| T8 | Port CF handlers to `PortalStore`; **remove every `501 unimplemented` and every fs-shim read** (testimonials GET/POST, comments POST, plan-items POST/PATCH, updates POST, projects POST/PATCH, invites POST, auth client-record creation, moderate/review) | B | M | T7 (same pattern), T4, T2 | On a Pages preview with bindings set: no endpoint returns `code:'unimplemented'`; a client invited via the portal can sign in **on CF**, submit a testimonial, and the one-click moderation link (emitted in the Resend email) flips state — end-to-end on the edge runtime |
| T9 | Remove CF silent-empty reads: any storage failure or missing config returns `503 storage-unavailable`, never `[]` pretending to be real data | B | S | T8 | With `LIBSQL_URL` unset in a preview, portal GETs return 503 (portal card hides itself per existing client behaviour); with it set, real data |
| T10 | Moderation write path hardening: `decideReview` in prod adapter, confirmation email only sent after the store confirms the flip; add redacted log line with outcome | B | S | T8 | Approve → email arrives only after state persisted; killing the DB makes the link answer 503, not send a false confirmation |
| T11 | Cutover: set `PORTAL_STORE=libsql` + `LIBSQL_URL/TOKEN` in CF Pages env **and** Vercel env; run `data:import`; smoke the five critical flows on production; tag `prod-YYYYMMDD` per `site/docs/ops/rollback.md` | D | S | T7-T10 | All §1 flows verified on prod URLs; rollback rehearsal performed once in a preview (flip back to `file`, confirm old behaviour) |
| T12 | Update docs: `site/docs/ops/rollback.md` (storage rollback section), `site/.env.example` (new vars), `spec/08` gets a numbered amendment pointer to this file | B + D | S | T11 | Docs merged; no existing spec file edited other than the permitted numbered amendment |

Critical path: T1 → T3 → T4 → T7 → T8 → T11. T2 is a parallel risk-buyer — if it fails, T8 becomes "deploy the CF tree as a Vercel-style Node function or accept Vercel-only launch", which escalates to the Manager immediately, not at T8.

---

## 6. Risks, session exposure, rollback

| Risk | Impact | Mitigation |
|---|---|---|
| **Cutover write-loss window** — data written between the final `data:import` and the env flip lands in the file store (or nowhere) | Lost invite/comment/review | Cutover outside working hours (low volume makes this easy); re-run `data:import` immediately before the flip (idempotent by design, T5); window is minutes, not days |
| **Session invalidation** | Every signed-in user (currently: whoever is signed into the owner's dev session — production has no working CF sessions today anyway, §1.3) is logged out on deploy | Unavoidable on any deploy (sessions are in-memory today — they already die on redeploy). Magic-link auth makes recovery one email; no password-reset analogue needed. After T8, sessions become durable — this "expires on redeploy" limitation in `spec/08` is *lifted*, and the spec table needs the amendment (T12) |
| **Turso outage / credential leak** | Portal reads fail; moderation links 503 (fail-loud, per T9 — acceptable: the email link can be re-sent) | Token lives only in dashboard env vars, never the repo (same discipline as `RESEND_API_KEY`; CI secrets-scan already guards the bundle); rollback path below |
| **`@libsql/client` on workers runtime proves problematic** (T2 spike failure class) | CF tree cannot use the store | Spike catches this before any porting; fallback is Upstash adapter (same interface) — one adapter swap, no handler changes |
| **Build-time publisher coupling** — `publish-testimonials.mjs` prebuild would need network access to the store, making CI builds depend on Turso availability | CI build fails without credentials on forks/PRs | Keep prebuild reading a **local JSONL snapshot**: CI runs `data:export` (read-only token) before `astro build`, or the snapshot is refreshed by the weekly action (T6) and committed to a git-ignored `site/data/snapshot/`. Decision recorded at T5; the publisher's `latestByRef` logic is untouched either way |
| **Dual-write drift during transition** (someone runs the old CF code after cutover) | Writes go to the void | T8 deletes the fs-shim paths outright — there is no dual-write mode to drift; the only switch is `PORTAL_STORE` |
| **Migration corrupts ordering** (reviews newest-wins depends on line order) | Wrong revision moderated/published | Importer sets `seq` from line number (verified byte-order-preserving round-trip in T5 acceptance); contract test asserts `latest()` equals the last JSONL line for a seeded file |

**Rollback plan (three tiers, cheapest first):**
1. **Bad handler logic, store fine** — revert the commit; CI redeploys (existing procedure, `site/docs/ops/rollback.md`).
2. **Store misbehaving** — set `PORTAL_STORE=file` in the dashboard env on CF Pages (and Vercel) + redeploy. The file adapter is the exact pre-migration behaviour; JSONL files resume in the deployment FS… **with the caveat that on CF they are ephemeral per-deploy** — i.e. tier 2 on CF restores the *launch-blocked* state, not a working store. Tier 2 is therefore a real option only on the Vercel/local side; on CF the honest rollback is tier 3.
3. **Total store failure on CF** — roll the deployment back to the pre-cutover tag (per `rollback.md`), accept the portal card self-hiding (existing client behaviour for non-OK answers, `site/functions/api/portal/testimonials.ts:11-13`), and re-run the cutover once the store is healthy. Data written to the store during the failed window is preserved (nothing overwrites it) and re-imports cleanly.

---

## 7. Open questions (need Manager/owner)

1. **Q1 — Is the Vercel target staying past launch?** `spec/08` P-6 says "Vercel is interim only" and CI's deploy job is an unwired stub. If Vercel is dropped at launch, D1 (CF-native, simplest ops) becomes viable and this proposal's main constraint disappears — worth 10 minutes before T1 sign-off. The recommendation holds either way, but the runner-up changes.
2. **Q2 — Turso or Neon?** Both pass §3. Turso is closer to the JSONL/SQLite mental model and `spec/08` Q4; Neon is preferable if the owner wants Postgres for future analytics or already has an account. Backend has no preference; pick one at T1.
3. **Q3 — Backup retention:** is the weekly JSONL artifact (T6) sufficient, or does the owner want Turso's managed backups enabled/verified (plan-dependent)? Affects T4 provisioning only.
4. **Q4 — Sessions durability:** moving sessions to the store makes them survive redeploys and be shared across isolates. Confirm this is wanted (it changes a documented `spec/08` limitation) vs. keeping 24 h TTL sliding expiry exactly as-is in the new store. Recommendation: move them, keep TTL identical.
5. **Q5 — `site/data/` housekeeping:** after migration the JSONL files exist only for local dev. Approve adding `site/data/` to `.gitignore` with a committed `.gitkeep` per directory (today they are untracked-but-present empty dirs) — trivial, but it touches a file outside this proposal's remit.
