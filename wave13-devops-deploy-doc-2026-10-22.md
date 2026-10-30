# Wave 13 DevOps DEPLOY.md Corrections — Report

**Date:** 2026-10-22  
**Status:** DONE  
**Repo:** C:\Users\Kalch\Documents\IXI

---

## Summary

All 5 DEPLOY.md corrections (D-1 through D-4, plus the §1.5 function-budget note) and the site/.env.example updates have been applied and verified.

---

## Changes Made

### D-1: `readReviewsFromStore()` line reference (DEPLOY.md:68)
- **Old:** `site/scripts/publish-testimonials.mjs:657`
- **New:** `site/scripts/publish-testimonials.mjs:669`
- **Evidence:** `grep -n "readReviewsFromStore" site/scripts/publish-testimonials.mjs` → line 669

### D-2: Wave-11 EmptyStoreError behaviour documented (DEPLOY.md:68-70)
- **Added:** Documentation of the wave-11 rule: a store yielding zero records while published quotes exist → exit 1 (published dir untouched); a store with zero records while nothing published → exit 0 (fresh build works).
- **Evidence:** DEPLOY.md lines 68-70 now include: "Wave 11 added a second guard: a store that yields ZERO records while published quotes EXIST also fails the build (exit 1, message 'Refusing to publish an empty set — published quotes exist.') and leaves the published set untouched; a store with zero records while nothing is published still builds (exit 0)."

### D-3: Function budget table corrected (DEPLOY.md:83-112)
- **Old:** 20 files = 17 routes + 3 utilities (jsonl.ts, notifications.ts, rate-limit.ts)
- **New:** 7 files = 7 routes + 0 utilities (all moved to site/shared/server/)
- **Key changes:**
  - Table updated to show 7 real routes: `contact.ts`, `moderate/review.ts`, `portal.ts`, `admin.ts`, `portal/auth/logout.ts`, `portal/auth/request-link.ts`, `portal/auth/verify.ts`
  - Shared utilities count: 0 (moved to `site/shared/server/`)
  - Total Vercel functions: 7 (≤ 12 Hobby cap — DEPLOYABLE)
  - Note added: refactor from spec/proposal-wave7-design-2026-10-21.md §2 is **applied**
  - Note: `api/lib/jsonl.ts` was deleted (wave 11, zero product importers)
  - The "not yet applied" paragraph rewritten to state the refactor **is applied**
- **Evidence:** `check:routes` output shows "api/ holds 7 .ts file(s)"

### D-4: No stale strings remain in DEPLOY.md (verified by grep)
- `60/60` → 0 matches
- `rate-limit.ts:413-419` → 0 matches (now references `site/shared/server/durable-rate-counter.ts`)
- `publish-testimonials.mjs:328-334` → 0 matches (now `:669`)
- `no JSONL reader is left` → 0 matches
- **Evidence:** All grep checks return no output

### Section 1.3: "Known blocker" rewritten (DEPLOY.md:45-82)
- **Old heading:** "Known blocker — the portal cannot run on Vercel with the file store"
- **New heading:** "What works on Vercel — file store vs libSQL"
- **Content updated** to reflect:
  - Portal works on Vercel with `PORTAL_STORE=libsql`
  - Handler paths now point to entry points (`api/portal.ts`, `api/admin.ts`) and `site/shared/portal-handlers/`
  - test:store count updated to 72/72 (24 file, 31 libsql, 11 shared, 6 more shared)
  - publish-testimonials.mjs line updated to 669
  - api/portal/session.ts → api/portal.ts (entry point)
  - By-id files removed (now route-table entries)

### Section 4.1: Admin routes updated (DEPLOY.md:155-164)
- **Vercel files** changed from `api/admin/session.ts` and `api/admin/reviews.ts` to `api/admin.ts`
- **Portal session route** changed from `api/portal/session.ts` to `api/portal.ts`
- **Evidence:** check:routes shows these routes served by the entry points

### Section 7: Launch checklist item 3 updated (DEPLOY.md:223)
- **Updated** to reflect: entry points, site/shared/portal-handlers/, jsonl.ts deleted, shared utilities moved, function budget = 7
- **Evidence:** Matches the actual tree state

### Section 8: Environment variables table updated (DEPLOY.md:229-248)
- test:store count: 66/66 → 72/72 (with breakdown 24/31/11/6)
- Rate-limit reference: `api/lib/rate-limit.ts:430-440` → `site/shared/server/durable-rate-counter.ts`
- **Added** `TRUST_CF_CONNECTING_IP` variable with documentation
- **Note at end** updated: jsonl.ts deleted, shared utilities moved, function budget = 7

### site/.env.example updated
- test:store comment: 60/60 → 72/72
- Wave 9 comment: "in flight" → "landed, wave 13 refactored"
- **Added** `TRUST_CF_CONNECTING_IP=` variable with comment
- Still has 3 distinct `REPLACE_ME_*` placeholders (FORM_WEBHOOK_SECRET, PORTAL_MAGIC_LINK_SECRET, PORTAL_SESSION_SECRET)

---

## Gate Results

| Check | Result |
|-------|--------|
| `npm run check:routes` | **16 routes, 0 missing** ✅ |
| `npm run typecheck:api` | **exit 0** ✅ |
| `node backend-wave10-store-integrity-harness.mjs` | **42/42 passed** ✅ |
| `node backend-wave8-session-endpoint-harness.mjs` | **57/57 passed** ✅ |
| Grep for stale strings (`60/60`, `rate-limit.ts:413-419`, `publish-testimonials.mjs:328-334`, `no JSONL reader`) | **0 matches each** ✅ |
| `site/.env.example` REPLACE_ME_* placeholders | **3 distinct** ✅ |

---

## Unverified

- No git commit
- No deploy
- No Vercel/Cloudflare runtime booted
- No real Turso contacted
- Dev server on 4321 still runs pre-wave-13 bundle (needs `npm run dev:portal` restart)
- The Vercel router rewrite query-merge behaviour is from docs, not observed (belongs to Code Reviewer's audit)