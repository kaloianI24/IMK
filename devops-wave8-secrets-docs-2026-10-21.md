# DevOps Wave 8B — Secrets, Docs, Checkpoint Commit

**Date:** 2026-10-22  
**Commit:** `a882606` (second checkpoint)

---

## Summary

Executed the WAVE-8B DevOps rework: publish-safe `.env.example`, bare-path robots rules in `vercel.json`, DEPLOY.md accuracy fixes, and second checkpoint commit with clean secret scan.

---

## Files Changed

### 1. `vercel.json` — Bare-path robots rules

Added explicit bare-path `X-Robots-Tag: noindex, nofollow` rules for `/login`, `/portal`, `/admin` alongside the existing wildcard patterns (`/login/(.*)`, etc.).

**Before:** Only wildcard patterns  
**After:** Both bare paths and wildcard patterns covered

```json
{ "source": "/login", "headers": [{ "key": "X-Robots-Tag", "value": "noindex, nofollow" }] },
{ "source": "/login/(.*)", "headers": [{ "key": "X-Robots-Tag", "value": "noindex, nofollow" }] },
{ "source": "/portal", "headers": [{ "key": "X-Robots-Tag", "value": "noindex, nofollow" }] },
{ "source": "/portal/(.*)", "headers": [{ "key": "X-Robots-Tag", "value": "noindex, nofollow" }] },
{ "source": "/admin", "headers": [{ "key": "X-Robots-Tag", "value": "noindex, nofollow" }] },
{ "source": "/admin/(.*)", "headers": [{ "key": "X-Robots-Tag", "value": "noindex, nofollow" }] },
```

> **Note in DEPLOY.md:** Bare-path coverage is verified by pattern reading only (no Vercel token, no deploy).

---

### 2. `site/.env.example` — Distinct placeholders, APP_ENV warning, corrected storage text

| Variable | Old Placeholder | New Placeholder |
|---|---|---|
| `FORM_WEBHOOK_SECRET` | `your-32-byte-hex-hmac-secret-here` | `REPLACE_ME_FORM_WEBHOOK_SECRET_openssl_rand_hex_32` |
| `PORTAL_MAGIC_LINK_SECRET` | `your-32-byte-hex-hmac-secret-here` | `REPLACE_ME_PORTAL_MAGIC_LINK_SECRET_openssl_rand_hex_32` |
| `PORTAL_SESSION_SECRET` | `your-32-byte-hex-hmac-secret-here` | `REPLACE_ME_PORTAL_SESSION_SECRET_openssl_rand_hex_32` |

**APP_ENV comment (lines 48-52):** Added explicit warning that production guards are active when `APP_ENV ≠ development` OR `NODE_ENV=production` OR `VERCEL=1` OR `SITE_BASE_URL` starts with `https://`.

**Storage block (lines 77-89):** Corrected from "adapter is NOT implemented yet (task T4) — it throws 501" to "The libSQL adapter IS built and proven (npm run test:store = 60/60). The portal handlers are being wired to it (wave 9 in flight)."

---

### 3. `site/shared/server/secret.ts` — Registered new placeholders

Added the three new `REPLACE_ME_*` placeholders to `PUBLISHED_SECRET_PLACEHOLDERS` array (lines 41-43). The guard rule is unchanged: missing / placeholder / `<32-char` → `500 {code:'internal'}` in production.

---

### 4. `DEPLOY.md` — Route table, function budget, bare-path note

| Section | Change |
|---|---|
| §1.1 | Added note: bare-path robots rules verified by pattern reading only |
| §1.5 | Function budget: 17 real routes + 3 utilities = 20 total (was 17+3, already correct); clarified `api/portal/session.ts` IS a real route now |
| §4.1.1 (new) | Added `GET /api/portal/session` route table with Vercel/CF file paths and response specs |
| §7 | Status table: item 3 reflects wiring in flight (not owner-blocked) |
| §8 | Storage rows: all three state adapter built/proven, wiring in flight |

---

## Verification Results

| Check | Command | Result |
|---|---|---|
| Route manifest | `npm run check:routes` (site/) | **16 routes, 0 missing** ✅ |
| API typecheck | `npm run typecheck:api` | **exit 0** ✅ |
| Session endpoint harness | `node backend-wave8-session-endpoint-harness.mjs` | **57/57 passed** ✅ |
| Stale claims grep | `findstr` for "not implemented", "not built", "owner decision", "BLOCKED", "owner-blocked" in DEPLOY.md & .env.example | **0 matches** ✅ |
| Distinct placeholders | `findstr REPLACE_ME_ site\.env.example` | **3 distinct values** ✅ |
| Placeholders registered | `findstr REPLACE_ME_ site\shared\server\secret.ts` | **3 new entries** ✅ |
| Secret scan | Pattern scan of all staged files | **Only placeholders/test fixtures** — no real secrets ✅ |
| Zero-length files | Checked all staged files | **None** ✅ |
| node_modules/site/dist | Checked staged list | **Not staged** ✅ |
| Logo rebrand | Verified `Logo/**/Asset-1.png` exist, `Artboard 1.png` deleted | **Complete** ✅ |

---

## Checkpoint Commit

**Hash:** `a882606`  
**Files:** 100 files changed, 18,627 insertions(+), 1,787 deletions(-)  
**Scope:** All work since checkpoint `a4b10a8` (wave 6) — includes waves 7, 8A, 8B, 8C, 8D, 9

**Protected work:**
- Backend: T4 libSQL adapter (built, 60/60 tests), wave 8A security fixes, wave 9 store wiring
- Frontend: Owner role from server (wave 8C), portal UI fixes
- Architect: As-built DDL, wave-8 contracts, NOT BUILT list
- QA: 12/12 suites green, 271 checks + 5 mutation probes
- DevOps: Publish-safe env, bare-path robots, docs accuracy

---

## Unverified (per scope)

- No deployed runtime (Vercel router and workerd never booted)
- No real Turso database contacted (store proof: real SQLite engine over real v2 wire protocol)
- No live mail (Resend sender not verified)
- No preview deploy (would settle rewrite behavior, function cap, robots headers)

---

## What Still Needs Owner Input (unchanged from Manager's list)

1. Turso database → `LIBSQL_URL` + `LIBSQL_TOKEN` + `PORTAL_STORE=libsql`
2. 9 production secrets including `ADMIN_EMAILS` = owner's address
3. Vercel project with Root Directory = repository root (left empty)
4. Resend sender identity verified for `2imk4support@gmail.com`
5. Real Calendly link for `/book`
6. Consent wording in `site/src/data/testimonial-consent.ts`
7. Public `/clients/<slug>` pages vs portal-only decision
8. **Is Cloudflare still a target?** (portal tree is 501 stub — half day to finish)
9. `/admin` "client notes" definition (currently shows `—` — no notes store exists)
10. One preview deploy (needs Vercel access)