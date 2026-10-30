# Wave 15 — DEPLOY.md Drift Corrections (DevOps)

**Date:** 2026-10-22  
**Status:** DONE  
**Report:** `C:\Users\Kalch\Documents\IXI\wave15-devops-deploy-doc-2026-10-22.md`

---

## Summary of Changes

All 7 DEPLOY.md corrections (D-1 through D-7) applied and verified.

| Item | Fix |
|------|-----|
| **D-1** | Rate-limit precedence rule citation: `api/lib/rate-limit.ts:430-440` → `site/shared/server/rate-limit.ts:437-455` (2 locations: lines 43, 297) |
| **D-2** | Durable rate counter path: `site/shared/server/durable-rate-counter.ts` → `site/shared/portal-store/durable-rate-counter.ts` (2 locations: lines 57, 297) |
| **D-3** | Publisher EmptyStoreError rule rewritten to match actual code at `site/scripts/publish-testimonials.mjs:293-301` — now correctly documents "no **review** records" guard with exact error message |
| **D-4** | Wildcard rewrite table replaced with **11 explicit rewrites** from `vercel.json` (lines 112-113) |
| **D-5** | Store env var source lines corrected: `index.ts` line 36 + 44-49, `edge.ts` line 31 + 41-46 (line 258) |
| **D-6** | Section order fixed: **4.1 Admin routes** now precedes **4.2 All public API URLs** |
| **D-7** | Bare filenames expanded: `libsql-transport.ts`, `libsql-schema.ts` → `site/shared/portal-store/libsql-transport.ts`, `site/shared/portal-store/libsql-schema.ts` (line 312) |

---

## Gate Results (all executed)

| Gate | Result |
|------|--------|
| `npm run check:routes` | **16 routes, 0 missing** ✅ |
| `npm run typecheck:api` | **exit 0** ✅ |
| `backend-wave10-store-integrity-harness.mjs` | **42/42 passed** ✅ |
| `backend-wave8-session-endpoint-harness.mjs` | **57/57 passed** ✅ |
| Stale string grep: `api/lib/rate-limit.ts` | **0 matches** ✅ |
| Stale string grep: `:path*` | **0 matches** ✅ |
| Stale string grep: `site/shared/server/durable-rate-counter.ts` | **0 matches** ✅ |
| `site/.env.example` REPLACE_ME placeholders | **3 distinct** ✅ |
| DEPLOY.md UTF-8 validity | **0 replacement chars (0xFFFD), 32 em-dashes intact** ✅ |

---

## Store Test Split Verification

**Confirmed from `npm run test:store` output:**  
`72/72` total = **27 file** assertions (tests 1–27) + **34 libsql** assertions (tests 28–61) + **11 shared** assertions (tests 62–72).  
The DEPLOY.md claim of "27 file, 34 libsql, 11 shared = 72" is **accurate**.

---

## Owner-Supplied Values Still Required (13)

| Variable | Required | Notes |
|---|---|---|
| `SITE_URL` | yes | canonical origin |
| `SITE_BASE_URL` | yes | public origin for links |
| `ADMIN_EMAILS` | yes | comma-separated owner emails |
| `RESEND_API_KEY` | yes | transactional email |
| `RESEND_FROM` | yes | verified sender |
| `RESEND_TO` | yes | owner notifications |
| `FORM_WEBHOOK_SECRET` | yes | HMAC for moderation links (REPLACE_ME) |
| `TURNSTILE_SECRET_KEY` | yes | contact form spam protection |
| `PORTAL_MAGIC_LINK_SECRET` | yes | magic link HMAC (REPLACE_ME) |
| `PORTAL_SESSION_SECRET` | yes | session HMAC (REPLACE_ME) |
| `PORTAL_STORE` | yes (portal) | `libsql` in production |
| `LIBSQL_URL` | yes (portal) | Turso database URL |
| `LIBSQL_TOKEN` | yes (portal) | Turso auth token (never commit) |

---

## Unverified

- No git commit, no deploy, no Vercel/Cloudflare runtime booted, no real Turso contacted
- Platform's query-merge order (client vs rewrite `__imk_route`) unobserved — no preview deploy + `curl` to settle MAJOR-1's core question
- Dev server on 4321 still runs pre-wave-15 bundle