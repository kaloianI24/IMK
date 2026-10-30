# Wave 12 — DevOps DEPLOY.md Corrections

**Date:** 2026-10-22
**Status:** DONE
**Report:** This document

---

## Summary

All 4 required DEPLOY.md corrections (D-1 through D-4) applied and verified. The file now accurately reflects the wave-10/11 tree state.

---

## Changes Made

### D-1 — Line 79: Fix `readReviewsFromStore()` reference

| Aspect | Before | After |
|--------|--------|-------|
| **File:line** | `site/scripts/publish-testimonials.mjs:585-591` | `site/scripts/publish-testimonials.mjs:657` |
| **Evidence** | `grep -n "readReviewsFromStore" site/scripts/publish-testimonials.mjs` → line 657 | Verified on disk |

**Change:** Updated the line reference in the wave-9 handler list (section 1.3) from the stale `:585-591` to the actual location `:657`.

---

### D-2 — Line 79: Document wave-11 EmptyStoreError behaviour

**Added to the same paragraph (after the wave-10 F-1 description):**

> **Wave 11 added a second guard:** a store that yields ZERO records while published quotes EXIST also fails the build (`exit 1`, message "Refusing to publish an empty set — published quotes exist.") and leaves the published set untouched; a store with zero records while nothing is published still builds (`exit 0`).

**Updated the owner guidance:**

> **If a Vercel build fails on the publisher:** the owner should check the build log for the reason (missing store, unparsable store, schema-less database, **or empty store with existing published quotes**) — the published client quotes are protected by this behaviour and are never deleted by a failed run.

**Evidence:** `site/scripts/publish-testimonials.mjs` lines 236 (`class EmptyStoreError`), 282 (`assertStoreIsNotEmpty`), 686 (call site).

---

### D-3 — Function budget (section 1.5): Reflect reality of `api/lib/jsonl.ts`

**Table (lines 102-107):** Kept 20/17/3 counts (jsonl.ts still exists on disk) and **added a Note row**:

| Category | Count | Files |
|----------|-------|-------|
| **Note** | | `api/lib/jsonl.ts` has **zero product importers** — its deletion is authorized and in flight (wave 11 QA unblocked it). Once removed, the count drops to 19 files = 17 routes + 2 shared utilities. |

**Paragraph at line 113-114:** Changed from "Move the 3 shared utilities..." to:

> Move the **2 shared utilities** (`lib/notifications.ts`, `lib/rate-limit.ts`) out of `api/`... This brings the function count to **7**... `api/lib/jsonl.ts` is already a dead function (zero product importers) — its removal is authorized and in flight; once removed, the starting count is 19 files = 17 routes + 2 shared utilities.

**Evidence:** `dir C:\Users\Kalch\Documents\IXI\api\lib\jsonl.ts` → file exists, 2139 bytes. `api/lib/jsonl.ts` has zero product importers (confirmed by wave-10 harness G1).

---

### D-4 — No other stale claims found

Verified by grep/findstr that none of these stale strings remain in DEPLOY.md:
- `"60/60"` — **0 matches** (already updated to 66/66 with per-adapter breakdown)
- `"rate-limit.ts:413-419"` — **0 matches** (already updated to `:430-440`)
- `"publish-testimonials.mjs:328-334"` — **0 matches** (updated to `:657`)
- `"no JSONL reader is left"` — **0 matches** (corrected to acknowledge jsonl.ts still exists as dead function)

**Additional verification:** The store test count (66, breakdown 24 file / 31 libsql / 11 shared), wave-10/11 publisher behaviour, and rate-limit description (per-instance in file mode, shared/durable with `PORTAL_STORE=libsql`; bucket key is platform-controlled address with per-instance fallback) all match the tree.

---

## Gate Results

| Check | Command | Result |
|-------|---------|--------|
| Route manifest | `npm run check:routes` | **16 routes, 0 missing** ✅ |
| TypeScript API | `npm run typecheck:api` | **exit 0** ✅ |
| Wave-10 harness | `node backend-wave10-store-integrity-harness.mjs` | **31/31 passed** ✅ |
| Stale string grep | `findstr` for 4 patterns | **0 matches each** ✅ |
| `.env.example` placeholders | `findstr REPLACE_ME site/.env.example` | **3 distinct `REPLACE_ME_*`** ✅ |

---

## Unverified

- No git commit
- No deploy to Vercel or Cloudflare
- No Vercel router or Cloudflare workerd booted
- No real Turso database contacted
- The dev server on port 4321 still runs the pre-wave-12 bundle (needs `npm run dev:portal` restart, not performed)

---

## File Changed

- `C:\Users\Kalch\Documents\IXI\DEPLOY.md` (only file modified)