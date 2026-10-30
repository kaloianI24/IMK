# Wave 14 — DevOps: DEPLOY.md and site/.env.example Corrections

**Date:** 2026-10-22  
**Status:** DONE  
**Report:** `C:\Users\Kalch\Documents\IXI\wave14-devops-deploy-doc-2026-10-22.md`

---

## Summary of Changes

All four DEPLOY.md corrections (D-1 through D-4) and site/.env.example updates applied and verified.

---

## Changes Made

| Item | Fix |
|------|-----|
| **D-1** | Store contract test count: `24 file, 31 libsql, 11 shared` → `27 file, 34 libsql, 11 shared = 72` at three locations (DEPLOY.md lines 62, 244, 248) |
| **D-2** | Publisher crash-safe swap line reference: `:621-657` → `site/scripts/publish-testimonials.mjs:736-836` (actual `recoverInterruptedSwap` + `swapIn` functions) |
| **D-3** | Added complete list of all 16 public API URLs with Vercel function file, Cloudflare function file, and family/type in new section 4.2 |
| **D-4** | Added section 1.6 "Routing on Vercel — how it actually works" documenting the rewrite + carrier mechanism, the three invariants that hold, the unobserved query-merge order, and the fail-closed resolver behavior |
| **D-5** | site/.env.example: Added owner-supplied values header comment listing all 13 required values; updated test:store count to `72/72: 27 file, 34 libsql, 11 shared`; three `REPLACE_ME_*` placeholders remain distinct |

---

## Gate Results

| Check | Result |
|-------|--------|
| `npm run check:routes` | **16 routes, 0 missing** ✅ |
| `npm run typecheck:api` | **exit 0** ✅ |
| `backend-wave10-store-integrity-harness.mjs` | **42/42 passed** ✅ |
| `backend-wave8-session-endpoint-harness.mjs` | **57/57 passed** ✅ |
| Grep for stale `60/60` | **0 matches** ✅ |
| Grep for stale `rate-limit.ts:413-419` | **0 matches** ✅ |
| Grep for stale `publish-testimonials.mjs:328-334` | **0 matches** ✅ |
| Grep for stale `no JSONL reader` | **0 matches** ✅ |
| `site/.env.example` REPLACE_ME placeholders | **3 distinct** ✅ |

---

## File Evidence (line-by-line)

### DEPLOY.md

| Change | Old Text | New Text | Location |
|--------|----------|----------|----------|
| D-1a | `72 pass / 0 fail (24 file assertions, 31 libsql assertions, 11 shared assertions)` | `72 pass / 0 fail (27 file assertions, 34 libsql assertions, 11 shared assertions)` | Line ~62 |
| D-1b | `72/72 contract tests: 24 file, 31 libsql, 11 shared, 6 more shared` | `72/72 contract tests: 27 file, 34 libsql, 11 shared` | Line ~244 |
| D-1c | `proven by npm run test:store (72/72: 24 file, 31 libsql, 11 shared, 6 more shared)` | `proven by npm run test:store (72/72: 27 file, 34 libsql, 11 shared)` | Line ~248 |
| D-2 | `crash-safe recovery (\`:621-657\`)` | `crash-safe recovery (\`site/scripts/publish-testimonials.mjs:736-836\`)` | Line ~68 |
| D-3 | (no 16-URL table existed) | **New section 4.2** with all 16 routes | After section 4.1.1 |
| D-4 | (no routing section existed) | **New section 1.6** with full routing explanation | After section 1.5 |

### site/.env.example

| Change | Old Text | New Text | Location |
|--------|----------|----------|----------|
| D-5a | (no owner-supplied header) | **New header comment** listing all 13 owner-supplied values | Lines 1-16 |
| D-5b | `test:store = 72/72` | `test:store = 72/72: 27 file, 34 libsql, 11 shared` | Line ~79 |
| D-5c | (TRUST_CF_CONNECTING_IP already documented) | Verified present with correct guidance | Lines 90-93 |
| D-5d | Three REPLACE_ME placeholders | **Three distinct placeholders remain** | Lines 47, 83, 89 |

---

## Owner-Supplied Values Still Required

The following 13 values must be supplied by the owner for production deployment:

| Variable | Purpose |
|----------|---------|
| `SITE_URL` | Canonical URL for sitemap, canonical tags, OG images |
| `SITE_BASE_URL` | Public origin for magic links, moderation links, cookies |
| `ADMIN_EMAILS` | Comma-separated owner emails (grants admin role) |
| `RESEND_API_KEY` | Transactional email (contact form + reviews) |
| `RESEND_FROM` | Verified sender identity (e.g., `IMK <2imk4support@gmail.com>`) |
| `RESEND_TO` | Owner notification destination |
| `FORM_WEBHOOK_SECRET` | HMAC secret for signed approve/reject links (`openssl rand -hex 32`) |
| `TURNSTILE_SECRET_KEY` | Cloudflare Turnstile secret for contact form |
| `PORTAL_MAGIC_LINK_SECRET` | HMAC secret for magic links (`openssl rand -hex 32`) |
| `PORTAL_SESSION_SECRET` | HMAC secret for session tokens (`openssl rand -hex 32`) |
| `PORTAL_STORE` | `libsql` in production |
| `LIBSQL_URL` | Turso database URL (e.g., `libsql://imk-portal-<org>.turso.io`) |
| `LIBSQL_TOKEN` | Turso auth token (never commit, never log) |

**Note:** `TRUST_CF_CONNECTING_IP` is documented but left unset unless Cloudflare actually fronts Vercel (Cloudflare Pages twin sets it automatically).

---

## Unverified

- No git commit, no deploy, no Vercel/Cloudflare runtime booted, no real Turso contacted
- Dev server on port 4321 still runs pre-wave-14 bundle (not restarted)
- The platform's query-merge order (whether client's `__imk_route` or rewrite's `__imk_route` wins) is **unobserved** — no preview deploy + `curl` has been done to settle MAJOR-1's core question