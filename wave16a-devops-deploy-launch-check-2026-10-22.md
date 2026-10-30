# Wave 16a — DevOps: DEPLOY.md Section 5 Fix + .gitignore

**Status: DONE** — both corrections applied and verified.

---

## Changes Made

| Item | Fix |
|------|-----|
| **F-1** | DEPLOY.md §5 (lines 246-252) rewritten with **real healthy answers** per verify URL:<br>`GET /api/portal/auth/request-link` → **404** `{code:'not-found'}` (POST-only)<br>`GET /api/portal/auth/verify` → **400** `{code:'validation'}` (POST-only)<br>`GET /api/portal/projects` → **401** `{code:'unauthorized'}` (needs session)<br>Replaced "404 means wrong Root Directory" with **"a function answered vs nothing served it"** rule: any JSON body with a `code` field = function served; Vercel's own 404 page / `FUNCTION_NOT_FOUND` / no `code` field = nothing served. Added pointer to `audit-wave15-2026-10-22.md` §8 for the authoritative preview `curl` check. |
| **F-5** | Added **`.vercel/`** to `.gitignore` (line 39) — the Vercel CLI writes `.vercel/project.json` on `vercel link`. |

---

## Gate Results (all executed)

| Gate | Result |
|------|--------|
| `npm run check:routes` | **16 routes, 0 missing** ✅ |
| `npm run typecheck:api` | **exit 0** ✅ |
| DEPLOY.md UTF-8 validity | **0 replacement chars (0xFFFD), 37 em-dashes intact** ✅ |
| .gitignore UTF-8 validity | **0 replacement chars, 3 em-dashes intact** ✅ |

---

## Owner-Supplied Values Still Required (13)

`SITE_URL`, `SITE_BASE_URL`, `ADMIN_EMAILS`, `RESEND_API_KEY`, `RESEND_FROM`, `RESEND_TO`, `FORM_WEBHOOK_SECRET`, `TURNSTILE_SECRET_KEY`, `PORTAL_MAGIC_LINK_SECRET`, `PORTAL_SESSION_SECRET`, `PORTAL_STORE=libsql`, `LIBSQL_URL`, `LIBSQL_TOKEN`

---

## Unverified

- No git commit, no deploy, no Vercel/Cloudflare runtime booted, no real Turso contacted
- Platform's query-merge order unobserved — no preview deploy + `curl` to settle MAJOR-1's core question
- Dev server on 4321 still runs pre-wave-15 bundle