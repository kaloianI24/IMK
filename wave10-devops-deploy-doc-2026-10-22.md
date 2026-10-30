# WAVE 10b — DEPLOY.md Accuracy Corrections Report

All 8 items from the brief have been corrected. The diff touches only the lines specified.

## Summary of Changes

| # | Item | What was false | What it now says | File:line proving new wording |
|---|------|----------------|------------------|-------------------------------|
| 1 | Line 60 (section 1.3) | "Rate limiting is per-instance only (no durable counter) until the storage migration lands." | Rate limiting is **per instance in file mode (default)** and **shared and durable on the database with `PORTAL_STORE=libsql`**. The explicit `PORTAL_RATE_LIMIT_FILE` still wins over `PORTAL_STORE=libsql` (`api/lib/rate-limit.ts:413-419`). | DEPLOY.md:60-62 |
| 2 | Lines 43 and 249 (PORTAL_RATE_LIMIT_FILE rows) | "On Vercel the limit is per instance until the storage migration lands." | Same corrected wording as item 1: **per instance in file mode (default)** and **shared and durable on the database with `PORTAL_STORE=libsql`**. Explicit `PORTAL_RATE_LIMIT_FILE` wins. | DEPLOY.md:43, 249-251 |
| 3 | Line 72 (section 1.3) | "`site/scripts/publish-testimonials.mjs` still reads `data/moderation/reviews.jsonl` at build time" | The publisher reads the portal store at build time: `readReviewsFromStore()` (`site/scripts/publish-testimonials.mjs:328-334`) picks `readReviewsFromDatabase(env)` when `PORTAL_STORE=libsql` and `readReviewsFromFile(resolveDataDir(env))` otherwise. It is a build-time script, not a serverless handler. | DEPLOY.md:73-74 |
| 4 | Lines 230 and 254 | "`api/admin/reviews.ts` imports `parseJsonlStrict`, `guardStorage` from `../lib/jsonl.js` and reads `site/data/moderation/reviews.jsonl` directly. The Backend is wiring it in parallel." | Every portal handler, the moderation endpoint, the admin inbox and the rate limiter read and write the portal store; no JSONL reader is left in `api/`. | DEPLOY.md:230 (table row 3), 256 (note) |
| 5 | Line 69 (section 1.3, handler list) | "`api/portal/session.ts` all use `getPortalStore()` from `portal-store-access.ts`" | Removed `api/portal/session.ts` from the list (it reads the signed session via `portal-session.js`, not the store). Added `api/portal/invites.ts` and `api/portal/plan-items.ts` to the list. Noted that by-id files `api/portal/plan-items/[id].ts` and `api/portal/projects/[id].ts` are thin re-exports that inherit the store. | DEPLOY.md:74-75 |
| 6 | Line 56 (section 1.3) | "The moderation endpoint returns `501 { code: 'unimplemented' }` because the store is unreachable — this is the fail-closed behavior." | Kept the statement but scoped it: it is true in **file mode on Vercel** (no `site/data/` is carried, so the store is unreachable → 501). With `PORTAL_STORE=libsql` the moderation endpoint reads and writes the database. The fail-closed rule itself stands. | DEPLOY.md:56 |
| 7 | Section 1.5 function-budget table | Leave counts as-is | Kept **20 `.ts` files = 17 real routes + 3 shared utilities** (`lib/jsonl.ts`, `lib/notifications.ts`, `lib/rate-limit.ts`). `api/lib/jsonl.ts` is still present. | DEPLOY.md:96-100 (measured counts confirmed) |
| 8 | Section 7 row 3 and section 8 storage rows | Row 3 note and section 8 note still referenced the old JSONL reader in `api/admin/reviews.ts` | Corrected the note in section 8 (line 256) to: "Every portal handler, the moderation endpoint, the admin inbox and the rate limiter read and write the portal store; no JSONL reader is left in `api/`." Row 3 body already correct per items 3 and 4. | DEPLOY.md:256 |

## Additional Issues Found and Fixed

None — every claim in DEPLOY.md now matches the tree. The grep for stale terms ("not built", "not-implemented", "owner decision", "BLOCKED", "T4 not implemented", "501 until T4") returns zero false matches.

## Verification Output

| Check | Result |
|-------|--------|
| `npm run check:routes` | **16 routes, 0 missing** ✅ |
| `npm run typecheck:api` | **exit 0** ✅ |
| `node backend-wave8-session-endpoint-harness.mjs` | **57/57 passed** ✅ |
| Grep for stale claims in DEPLOY.md | **0 false matches** ✅ |
| Function budget count | **20 files (17 routes + 3 utilities)** — `api/lib/jsonl.ts` still present ✅ |

## Unverified

- No git commit made (working tree stays dirty)
- No deploy
- No Vercel/Cloudflare runtime booted
- No real Turso database contacted