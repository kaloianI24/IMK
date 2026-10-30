# WAVE 10b — DEPLOY.md accuracy corrections (doc-only)

Repo: `C:\Users\Kalch\Documents\IXI`. Read the tree from disk; do not trust any
report's line numbers.

## YOU OWN (edit these)

- `DEPLOY.md` — ONLY this file. Nothing else.

## DO NOT TOUCH

- `api/**`, `site/**`, `site/shared/**`, `site/scripts/**`, `site/qa/**`,
  `site/.env.example`, `spec/**`, any `*-brief-*.md`, any `*-wave*-*.md`

A Backend wave is running in parallel and owns the code. Do not edit code, and do
not describe code that has not landed.

---

Each claim below was verified by the Manager against the tree today.

## 1. Line 60 — "Rate limiting is per-instance only (no durable counter) until the storage migration lands."

**FALSE.** `api/lib/rate-limit.ts:420-421` selects `createStoreBackend(env)` when
`PORTAL_STORE=libsql`, which uses `createLibsqlRateLimitBackend` on the SAME
transport as the portal store (`api/lib/rate-limit.ts:289`, `:298`). The durable
counter has landed.

Required wording: the limit is **per instance** in file mode (default), and
**shared and durable** on the database with `PORTAL_STORE=libsql`. The explicit
`PORTAL_RATE_LIMIT_FILE` still wins over `PORTAL_STORE=libsql`
(`api/lib/rate-limit.ts:413-419`).

## 2. Lines 43 and 249 — the `PORTAL_RATE_LIMIT_FILE` row

**FALSE** in the same way: "On Vercel the limit is per instance until the storage
migration lands." The storage migration HAS landed. Correct the row to the same
wording as item 1. The row's "no" (not required) and "only for a self-hosted
target" parts stay correct.

## 3. Line 72 — "`site/scripts/publish-testimonials.mjs` still reads `data/moderation/reviews.jsonl` at build time"

**FALSE.** The publisher reads the STORE: `readReviewsFromStore()`
(`site/scripts/publish-testimonials.mjs:328-334`) picks
`readReviewsFromDatabase(env)` when `PORTAL_STORE=libsql` and
`readReviewsFromFile(resolveDataDir(env))` otherwise.

Required wording: the publisher reads the portal store (the database under
`PORTAL_STORE=libsql`, the JSONL file in file mode). It is a build-time script,
not a serverless handler, so it is not a Vercel function.

## 4. Lines 230 and 254 — "`api/admin/reviews.ts` ... imports `parseJsonlStrict`,
`guardStorage` from `../lib/jsonl.js` and reads `site/data/moderation/reviews.jsonl`
directly. The Backend is wiring it in parallel."

**FALSE.** That landed: `api/admin/reviews.ts:49-55` imports
`getPortalStore`/`guardStore`/`assertStoreReachable` from
`site/shared/server/portal-store-access.js` and reads `store.list('reviews')`
(line 206). It has no `node:fs`, no `node:path`, no `site/data` path. `api/lib/jsonl.ts`
has zero importers now.

Required wording: every portal handler, the moderation endpoint, the admin inbox
and the rate limiter read and write the portal store; no JSONL reader is left in
`api/`.

## 5. Line 69 — "`api/portal/session.ts` all use `getPortalStore()` from `portal-store-access.ts`"

**FALSE.** `api/portal/session.ts` imports only `site/shared/server/portal-session.js`
(lines 54-64) — it reads the signed session, not the store. Remove it from that list.

The list is also incomplete: `api/portal/invites.ts` and `api/portal/plan-items.ts`
use the store and are not named. The by-id files `api/portal/plan-items/[id].ts`
and `api/portal/projects/[id].ts` are thin re-exports of their parent handler
(`export { default } from '../x.js'`) and inherit the store — say so once instead
of listing them as separate importers.

## 6. Line 56 — "The moderation endpoint (`/api/moderate/review`) returns `501
{ code: 'unimplemented' }` because the store is unreachable — this is the
fail-closed behavior."

Keep this, but scope it: it is true in FILE mode on Vercel (no `site/data/` is
carried, so the store is unreachable → 501). With `PORTAL_STORE=libsql` the
moderation endpoint reads and writes the database. The fail-closed rule itself
stands.

## 7. Section 1.5 — the function-budget table

Leave the counts alone: `api/` holds exactly 20 `.ts` files = 17 real routes + 3
shared utilities with no default export (`api/lib/jsonl.ts`,
`api/lib/notifications.ts`, `api/lib/rate-limit.ts`). A Backend wave may delete
the now-dead `api/lib/jsonl.ts`, which would make it 19 files / 2 dead utilities.
Do NOT pre-empt that: if `api/lib/jsonl.ts` is gone when you edit, update the
table to the counts you measure and say so in your report; otherwise keep 20 / 17
/ 3 and say the file is still present.

## 8. Section 7 row 3 and section 8 storage rows

Row 3 is `✅` and may stay `✅`. Correct only its body per items 3 and 4.
The three storage rows in section 8 (lines 250-252) say "the wiring is landed
(wave 9)" — that is correct and stays. Their note (line 254) needs item 4.

---

## Do not touch

- Section 5 (the Vercel Root Directory click path) — the owner's steps.
- Section 6 (the Turso/libSQL creation steps and the variable names
  `PORTAL_STORE`, `LIBSQL_URL`, `LIBSQL_TOKEN`).
- The `LIBSQL_TOKEN` warning.
- The owner's three-step launch list (section 7 rows 1 and 2).
- Section 8's variable table, except the `PORTAL_RATE_LIMIT_FILE` row (item 2).

## Acceptance

- Every one of the 8 items above is either corrected or explicitly reported as
  already-correct with the file:line that proves it.
- No claim in `DEPLOY.md` contradicts the tree. Re-read the file after your edits.
- `DEPLOY.md` diff touches only the lines above.

## Report

`C:\Users\Kalch\Documents\IXI\wave10-devops-deploy-doc-2026-10-22.md` — one line
per item: what was false, what it now says, the file:line that proves the new
wording. List anything in `DEPLOY.md` you found still wrong that was not in this
brief, with the evidence.

Answer with **DONE / PARTIAL / BLOCKED**.
