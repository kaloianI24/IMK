# Wave 11 — DevOps DEPLOY.md Accuracy Corrections Report

**Date:** 2026-10-22  
**Status:** DONE  
**Repo:** `C:\Users\Kalch\Documents\IXI` (tree permanently dirty, no git commands run)

---

## Summary of Changes

All 5 items from the brief corrected, plus the §1.5 function-budget note added. Every correction carries file:line evidence.

---

## Item 1 — Test store count: "60/60" → "66/66" with per-adapter breakdown

**Old text (3 locations):**
- Line 71: "`npm run test:store` = 60 pass / 0 fail (the same 22 contract assertions run against both the file adapter and the libSQL adapter)"
- Line 258: "The adapter is built and proven (60/60 contract tests)"
- Line 262: "proven by `npm run test:store` (60/60)"

**New text:**
- Line 71: "`npm run test:store` = 66 pass / 0 fail (**24 file** assertions, **31 libsql** assertions, **11 shared** assertions — the revision-scope assertions added in wave 10 are not symmetric across the two adapters)"
- Line 258: "The adapter is built and proven (66/66 contract tests: 24 file, 31 libsql, 11 shared)"
- Line 262: "proven by `npm run test:store` (66/66: 24 file, 31 libsql, 11 shared)"

**Evidence:** `npm run test:store` → **66/66** (24 file, 31 libsql, 11 shared)

---

## Item 2 — "What does NOT work on Vercel today:" heading contradicted the bullets

**Old text (lines 58-60):**
```
**What does NOT work on Vercel today:**
- All portal endpoints (`/api/portal/*`) are now wired to the libSQL adapter...
- Rate limiting is per instance in file mode (default), and shared and durable on the database...
```

**New text (lines 45-66):** Split into two clear sections:
- **What works on Vercel with `PORTAL_STORE=file` (default):** Astro site, contact form, moderation endpoint (501 in file mode), portal endpoints wired to PortalStore contract (but file store cannot persist on Vercel's read-only filesystem)
- **What requires `PORTAL_STORE=libsql` to work on Vercel:** Portal writes that persist, rate limiting that is shared/durable across instances

**Evidence:** Verified against current tree — the portal handlers ARE wired to the store contract (wave 9 landed), but file mode cannot persist on Vercel.

---

## Item 3 — Rate limit line references and substantive claim

**Old text (3 locations — lines 43, 60, 257):**
`api/lib/rate-limit.ts:413-419`

**New text:**
`api/lib/rate-limit.ts:430-440`

**Substantive claim updated:**
- **Old:** "The limiter's key is no longer a hash of the client-sent x-forwarded-for"
- **New:** "It is now derived **only from a platform-controlled address** — `api/portal/auth.ts:159-170` `platformAddress()`: `cf-connecting-ip` first, otherwise the **last** hop of `x-forwarded-for` (the platform's own view), never the client's first entry."

**Evidence:** 
- `api/lib/rate-limit.ts:430-440` — `createPortalRateLimiter` precedence logic at line 435
- `api/portal/auth.ts:159-170` — `platformAddress()` implementation

---

## Item 4 — Publisher store access line numbers and failure behaviour

**Old text (line 73):**
`readReviewsFromStore()` (`site/scripts/publish-testimonials.mjs:328-334`)

**New text (line 79):**
`readReviewsFromStore()` (`site/scripts/publish-testimonials.mjs:585-591`)

**Added wave-10 (F-1) failure behaviour documentation:**
> **Wave 10 (F-1) changed the publisher's failure behaviour:** a missing store, an unparsable store, and a database with no schema each make the build **fail** (`exit 1`, message "Refusing to publish a partial set of testimonials.") and leave the published quotes untouched. The published set is now built in a **staging directory and swapped in** (`:621-657`), so a failed publish leaves the published directory exactly as it was. **If a Vercel build fails on the publisher:** the owner should check the build log for the reason (missing store, unparsable store, schema-less database) — the published client quotes are protected by this behaviour and are never deleted by a failed run.

**Evidence:** `site/scripts/publish-testimonials.mjs:585-591` (readReviewsFromStore), `:621-657` (staging swap), `:246` (missing store = error), `:562` (no schema → create DDL then refuse)

---

## Item 5 — "No JSONL reader is left in api/" claim

**Old text (2 locations — lines 238, 262):**
"no JSONL reader is left in `api/`"

**New text:**
> `api/lib/jsonl.ts` still exists under `api/` with **zero product importers** (a dead Vercel function); `api/lib/notifications.ts` and `api/lib/rate-limit.ts` are still imported by real handlers and live in `api/` as shared utilities (costing 3 function slots against the 12-function Hobby cap).

**Evidence:**
- `api/lib/jsonl.ts` — exists, 0 product importers (wave-10 harness G1)
- `api/lib/notifications.ts` — imported by `api/admin/reviews.ts:45`, `api/moderate/review.ts:41`, `api/portal/testimonials.ts:27`, CF twins
- `api/lib/rate-limit.ts` — imported by `api/portal/auth.ts:31`, `api/portal/testimonials.ts:35`, CF twins

---

## Additional — §1.5 Function budget: why the refactor hasn't been applied

**Added sentence (line 113):**
> **The refactor has not been applied yet because the Vercel plan is not settled** (Hobby caps at 12 functions and blocks the deploy; Pro has no cap), and the refactor rewrites the handler bodies that wave 10 just changed, so it must not run concurrently with the wave-10 review.

**Evidence:** §1.5 table still shows 20 files / 17 routes / 3 utilities — correct and unchanged.

---

## Gate Results

| Check | Result |
|-------|--------|
| `npm run check:routes` | **16 routes, 0 missing** ✅ |
| `npm run typecheck:api` | **exit 0** ✅ |
| `node site/scripts/check-api-routes.mjs` | **16 routes, 0 missing** ✅ |
| Grep for "60/60" in DEPLOY.md | **0 matches** ✅ |
| Grep for "rate-limit.ts:413-419" in DEPLOY.md | **0 matches** ✅ |
| Grep for "publish-testimonials.mjs:328-334" in DEPLOY.md | **0 matches** ✅ |
| Grep for "no JSONL reader is left" in DEPLOY.md | **0 matches** ✅ |
| `site/.env.example` placeholders | **3 distinct `REPLACE_ME_*` values** ✅ |
| `backend-wave8-session-endpoint-harness.mjs` | **57/57 passed** ✅ |

---

## UNVERIFIED (per brief scope)

- No git commit made (working tree stays dirty)
- No deploy executed
- No Vercel/Cloudflare runtime booted
- No real Turso database contacted
- The function budget refactor (api/ consolidation) not applied — blocked on Vercel plan decision and wave-10 review completion

---

## Files Changed

- `DEPLOY.md` — 8 edits across 5 items + 1 additional note
- `site/.env.example` — **not changed** (already correct with 3 distinct placeholders)