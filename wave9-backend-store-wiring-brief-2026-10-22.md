# WAVE-9 — Backend brief: wire the portal to the PortalStore

Owner-free. This is the last thing standing between the portal and working on Vercel.

**Repo:** `C:\Users\Kalch\Documents\IXI`
No git remote, and the working tree is permanently dirty (several agents work in it at once).
**NEVER** run `git reset`, `git clean`, `git checkout` or `git stash`. Touch only the files listed here.

---

## 1. GOAL

Today 7 `api/portal` handlers plus `api/moderate/review.ts` still read and write JSONL through
`api/lib/jsonl.js`. On Vercel the filesystem is read-only, so every portal endpoint answers
`500 { code: 'storage' }`.

Make every portal read/write go through the **existing** `PortalStore` contract, so that
`PORTAL_STORE=libsql` actually persists.

## 2. THE CONTRACT EXISTS — do not redesign it

`site/shared/portal-store/`
(`types.ts`, `file-adapter.ts`, `libsql-adapter.ts`, `libsql-store.ts`, `libsql-transport.ts`,
`libsql-schema.ts`, `durable-rate-counter.ts`, `index.ts`, `edge.ts`)

- `getStore(env)` is at `index.ts:35` (Node / Vercel) and `edge.ts:30` (Cloudflare).
- `index.ts:38-41` returns `createLibsqlStoreFromEnv(env)`, which **fails closed** on a missing or
  invalid `LIBSQL_URL` / `LIBSQL_TOKEN` (`libsql-store.ts`).
- It is **proven**: `npm run test:store` = 60 pass / 0 fail — the same 22 contract assertions run
  against the file adapter **and** the libSQL adapter.

Keep the contract's shape. If you believe it needs a change, say so in the report instead of
redesigning it.

## 3. FILES TO CONVERT

Vercel tree only. **The Cloudflare portal tree stays a 501 stub — that is a decision, not a task.**

1. `api/portal/auth.ts`
2. `api/portal/comments.ts`
3. `api/portal/invites.ts`
4. `api/portal/plan-items.ts`
5. `api/portal/projects.ts`
6. `api/portal/testimonials.ts`
7. `api/portal/updates.ts`
8. `api/portal/projects/[id].ts`
9. `api/portal/plan-items/[id].ts`
10. `api/moderate/review.ts` (the moderation store)
11. `api/lib/rate-limit.ts` (the durable counter — `durable-rate-counter.ts` already exports
    `createLibsqlRateLimitBackend(transport)`; the schema already has a `rate_counters` table)
12. `site/scripts/publish-testimonials.mjs` (the prebuild publisher must read the store, not
    `data/moderation/reviews.jsonl`)

## 4. MAPPING FACTS — verify, do not assume

- `file-adapter.ts:33` `COLLECTION_FILES` **already matches today's filenames**:
  `projects` → `portal/projects.jsonl`, `clients` → `portal/clients.jsonl`,
  `invites` → `portal/invited.jsonl`, `comments` → `portal/comments.jsonl`,
  `planItems` → `portal/planItems.jsonl`, `updates` → `portal/updates.jsonl`,
  `reviews` → `moderation/reviews.jsonl`.
  The adapter's `dataDir` holds `portal/` and `moderation/` **under** `site/data`, so
  **FILE MODE IS A DROP-IN: same files, same records.**
- `'reviews'` is a **revision log**: generic `update()` / `remove()` **throw** by contract.
  Use `decideReview()` for the moderation flip, `append()` for a new revision, `latest()` for
  newest-wins. `api/moderate/review.ts:136-138` does an atomic tmp-file rename today — that
  atomicity now comes from `decideReview()` in SQL; **drop the file-rename path.**
- `rewriteJsonl()` (full-file rewrite) has **no** store equivalent. Convert each call site to
  `update()` / `remove()` + `append()` semantics and **prove** the records equal the old behaviour.
- `guardStorage()` produced `500 { code: 'storage' }`. A `StorageError` must still answer
  `500 { code: 'storage' }` — not a 200 with empty data, not a different code.
  The QA suites assert these codes; **read them before you change anything.**
- `readJsonlFile` treats a malformed line as an **ERROR** (audit M3 / QA D3), never as an empty
  list ("empty" reads as "no project" = a silent outage). Decide and document how the SQL path
  surfaces malformed JSON, and keep it an error.
- **No server-side session store.** The portal session is a signed stateless token. The
  `'sessions'` collection is not for auth.

## 5. OUT OF SCOPE — DO NOT TOUCH

- `DEPLOY.md`, `site/.env.example` — **DevOps** has them in this wave.
- `site/functions/**` — the CF portal tree stays a 501 stub.
- The **function-budget refactor** (20 → 7 functions). It moves these same handler bodies
  (`spec/proposal-wave7-design-2026-10-21.md` §2.9). It is **deferred** until this lands.

## 6. GATES THAT MUST STAY GREEN — quote every count

- `npm run typecheck:api` → exit 0
- `npm run check:routes` → 16 routes, 0 missing
- `npm run test:store` → 60/60
- `npm run build` → exit 0
- the 12-suite QA runner → 12/12 exit 0
- `backend-wave6-harness.mjs` → 24/24
- `backend-f1-magic-token-harness.mjs` → 22/22
- `backend-wave8-harness.mjs` → 35/35
- `backend-wave8-session-endpoint-harness.mjs` → 57/57
- `backend-wave8-moderation-m1-harness.mjs` → 11/11

## 7. DONE ONLY IF — execution, not assertion

1. No `api/portal` handler and not `api/moderate/review.ts` reads or writes portal JSONL any more
   (quote the grep). With `PORTAL_STORE=libsql` a read and a write go **to the store** — run it
   against the offline mock pipeline server in `site/shared/portal-store/test/`.
2. With `PORTAL_STORE=file` the same handlers read and write the **same** `site/data/portal/*.jsonl`
   files with the **same** records — prove it by execution.
3. The publisher **exits non-zero** when the store is unreachable, and exits 0 with the right quotes
   when it is reachable. (Spec §3.7: a build that silently publishes an empty testimonials page is a
   silent outage wearing the costume of a successful deploy.)
4. The rate counter is **durable across two instances** on the SQL backend, and per-instance in
   file mode.
5. Every gate in §6 still passes.
6. **Report** at `C:\Users\Kalch\Documents\IXI\backend-wave9-store-wiring-2026-10-22.md`:
   - per handler, the old path and the new store call,
   - every gate count,
   - what stays **UNVERIFIED** (no real Turso has ever been contacted; the Vercel router was never
     booted; no live mail).

**Never write `LIBSQL_TOKEN` into a file, a log or a report.**
