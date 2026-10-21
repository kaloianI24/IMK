# Deploying IMK (site + portal API)

Two deploy targets exist in this repository. **The launch target is the Vercel tree**
(`api/` at the repository root). The Cloudflare tree (`site/functions/`) is a parity
twin whose portal is still a stub (it answers `501 { code: 'unimplemented' }` — it has
no writable store).

---

## 1. Vercel (the launch target)

### 1.1 Project settings — the part that is not in the repo

| Setting | Value | Why |
|---|---|---|
| **Root Directory** | **the repository root** (leave it empty) | the serverless functions live in `api/`, at the repository root. A project rooted at `site/` deploys **no functions at all** and the sign-in door answers 404. |
| Framework preset | `Other` (`"framework": null` in `vercel.json`) | the Astro app lives in `site/`, not at the root, so Vercel must not try to detect a framework at the root. |
| Install Command | `cd site && npm ci` | the dependencies live in `site/package.json`. |
| Build Command | `cd site && npm run build` | the Astro build. |
| Output Directory | `site/dist` | the static output. |
| Node.js version | 20.19.5 (`site/.node-version`) | matches the local build. |

`vercel.json` at the repository root already declares the framework, install command,
build command, output directory and the security headers. **Bare-path robots rules**
(`/login`, `/portal`, `/admin` without trailing slashes) are included alongside the
wildcard patterns; bare-path coverage is verified by pattern reading only (no Vercel
token, no deploy). Only **Root Directory** is a dashboard setting — it cannot be
committed.

### 1.2 Environment variables

| Variable | Required | Notes |
|---|---|---|
| `SITE_BASE_URL` | yes | the public origin, e.g. `https://imk.example`. Also used for the sign-in link and the one-click moderation link. Without it a production instance answers `500 { code: 'internal' }`. |
| `SITE_URL` | fallback | older name for `SITE_BASE_URL`. |
| `PORTAL_MAGIC_LINK_SECRET` | yes | HMAC key for the magic link and the moderation signature. Must be the **same value** on every instance. |
| `RESEND_API_KEY` | yes | without it a production instance answers `500` instead of sending a sign-in link. |
| `RESEND_FROM` | yes | a verified sender, e.g. `IMK <2imk4support@gmail.com>`. |
| `RESEND_TO` | yes | where the owner notifications go. |
| `FORM_WEBHOOK_SECRET` | yes | signs the one-click moderation links. |
| `ADMIN_EMAILS` | yes | comma-separated list of owner addresses (the owner role). |
| `TURNSTILE_SECRET_KEY` | yes | the public contact form. |
| `PORTAL_RATE_LIMIT_FILE` | no | only for a self-hosted target: a durable counter file. On Vercel the limit is per instance until the storage migration lands. |

### 1.3 Known blocker — the portal cannot run on Vercel with the file store

The portal currently uses a **file store** (`PORTAL_STORE=file`), which writes to
`site/data/portal/*.jsonl` and `site/data/moderation/reviews.jsonl`.
A Vercel serverless function has a **read-only filesystem** (only `/tmp` is writable), so
the file store **cannot persist** on Vercel — writes fail with `500 { code: 'storage' }`
and reads return empty data.

**What works on Vercel today (with `PORTAL_STORE=file`):**
- The Astro marketing site (`site/`) builds and deploys successfully.
- The public contact form (`/api/contact`) works.
- The moderation endpoint (`/api/moderate/review`) returns `501 { code: 'unimplemented' }` because the store is unreachable — this is the fail-closed behavior.

**What does NOT work on Vercel today:**
- All portal endpoints (`/api/portal/*`) return storage errors because the portal handlers are not yet wired to the libSQL adapter — they still read/write JSONL directly, which fails on Vercel's read-only filesystem.
- Rate limiting is per-instance only (no durable counter) until the storage migration lands.

**The durable answer is the libSQL adapter (T4):**
- Task T4 in `spec/08-portal-mvp.md` §4.8.5 and `spec/proposal-portal-storage.md`.
- The `PortalStore` interface and the file adapter already exist (`site/shared/portal-store/`).
- The libSQL adapter **is built and proven**: `npm run test:store` = 60 pass / 0 fail (the same 22 contract assertions run against both the file adapter and the libSQL adapter). `getStore(env)` at `site/shared/portal-store/index.ts:35` and `edge.ts:30` selects the libSQL adapter when `PORTAL_STORE=libsql`.
- What is **not yet wired** is the portal handlers: `api/portal/*`, `api/moderate/review.ts`, `api/lib/rate-limit.ts` and `site/scripts/publish-testimonials.mjs` still read/write JSONL directly. The wiring is in flight (wave 9).
- The owner needs only two values (`LIBSQL_URL`, `LIBSQL_TOKEN`) plus a database — the Turso vs Neon choice does **not** block the code (the adapter speaks the libSQL HTTP v2 protocol; `PortalStore` keeps Postgres swappable).

Do not claim the portal is deployable when it is not. Do not invent or stub a libSQL adapter.

### 1.4 Deploying from CI

`.github/workflows/ci.yml` has a `deploy-vercel` job that is gated on `VERCEL_TOKEN` and
currently deploys nothing on purpose. To enable it: link the project in the Vercel
dashboard (Root Directory = the repository root), add the token as a repository secret,
and uncomment the `npx vercel --prod` step. The job runs from the **repository root**.

---

## 1.5 Function budget — known blocker on Vercel Hobby

`api/` holds **20 `.ts` files** at the repository root. Vercel's documentation
(<https://vercel.com/docs/functions/runtimes>) states that **without a framework**
(`"framework": null` in `vercel.json`) **every file in `api/` becomes one Vercel
Function**. On the **Hobby plan** a no-framework project is capped at **12 functions
per deployment** (Pro and Enterprise are unlimited).

| Category | Count | Files |
|---|---|---|
| Real routes (have a default export handler) | 17 | `contact.ts`, `admin/session.ts`, `admin/reviews.ts`, `moderate/review.ts`, `portal/auth/logout.ts`, `portal/auth/request-link.ts`, `portal/auth/verify.ts`, `portal/comments.ts`, `portal/invites.ts`, `portal/plan-items.ts`, `portal/plan-items/[id].ts`, `portal/projects.ts`, `portal/projects/[id].ts`, `portal/testimonials.ts`, `portal/updates.ts`, `portal/session.ts`, `portal/auth.ts` |
| Shared utilities (NO default export — build a dead function that 500s on its URL) | 3 | `lib/jsonl.ts`, `lib/notifications.ts`, `lib/rate-limit.ts` |
| **Total Vercel functions on deploy** | **20** | **20 > 12 (Hobby cap)** |

**What this means:**
- **On Vercel Pro/Enterprise:** the deploy works, but 3 dead functions exist (they answer `"Can't detect way to handle request"` — a 500, not a build failure).
- **On Vercel Hobby:** the deploy **fails the function count check** (20 > 12). The portal cannot launch on Hobby until the function count drops to ≤ 12.

**The fix (not yet applied — see `spec/proposal-wave7-design-2026-10-21.md` §2):**
Move the 3 shared utilities out of `api/` (e.g. to `site/shared/server/`), add one shared entry point per route family, and use `vercel.json` rewrites. This brings the function count to **7** (`api/portal.ts` + `api/admin.ts` + `api/contact.ts` + `api/moderate/review.ts` + the **3** `/api/portal/auth/*` files) with 5 slots spare.

Do not claim the deploy works on Hobby. This is a hard platform limit, not a risk.

---

## 2. Cloudflare Pages (the parity twin — not the launch target)

- Pages Functions live in `site/functions/`; the route is the file path under `functions/`.
- The portal endpoints answer `501 { code: 'unimplemented' }`: there is no store on the
  edge. Making this target real needs a real store (D1/KV) — the same work as T4.
- The sign-in rate limiter is KV-backed (`KV_COUNTER` binding) and survives cold starts.
- The moderation link contract is identical on both targets: a link signed by one tree
  verifies in the other (`site/qa/qa-cf-parity.mjs`).

---

## 3. Local development

```bash
cd site
npm ci
npm run dev:portal      # builds the site and serves it + the API on :4321
```

`site/scripts/dev-portal.js` bundles the real `api/` handlers with esbuild and routes
them by **prefix**. That is more forgiving than either deploy target (a function is
served at its **file path** there), so use the route manifest check to catch a missing
route file:

```bash
cd site
npm run check:routes    # every /api path the client calls must have a function file
```

---

## 4. The checks that must be green before a release

```bash
cd site
npm run check:routes      # the route table (both trees)
npm run typecheck:api     # the api/ tree + the Cloudflare twin + the shared store
npm run test:store        # the store contract tests
npm run build             # the Astro build (23 pages)
npm run check             # astro check (0 errors, 0 warnings)
powershell -NoProfile -ExecutionPolicy Bypass -File site/qa/run-all-suites.ps1
```

---

## 4.1 Admin routes

The `/admin` owner inbox is served by two routes in both trees:

| Route | File (Vercel) | File (Cloudflare) | Response |
|---|---|---|---|
| `GET /api/admin/session` | `api/admin/session.ts` | `site/functions/api/admin/session.ts` | **200** `{ok:true,role:'admin',email:'...'}` for the allow-listed owner; **401** `{code:'unauthorized'}` for a non-owner (client session, no session, forged cookie, or address not on `ADMIN_EMAILS`); **500** `{code:'internal'}` when `ADMIN_EMAILS` is unset |
| `GET /api/admin/reviews` | `api/admin/reviews.ts` | `site/functions/api/admin/reviews.ts` | **200** `{ok:true,counts:{...},reviews:[...],recent:[...]}` for the allow-listed owner; **401** `{code:'unauthorized'}` for a non-owner; **500** `{code:'internal'}` when `ADMIN_EMAILS` or `FORM_WEBHOOK_SECRET` is unset; **501** `{code:'unimplemented'}` when the moderation store file is missing (read-only filesystem) |

### 4.1.1 Portal session route

The owner-role endpoint used by the portal UI:

| Route | File (Vercel) | File (Cloudflare) | Response |
|---|---|---|---|
| `GET /api/portal/session` | `api/portal/session.ts` | `site/functions/api/portal/session.ts` | **200** `{authenticated:true,role:'admin'|'client',expiresAt:number}` for a valid session; **401** `{code:'unauthorized'}` with no valid session; **500** `{code:'internal'}` when `ADMIN_EMAILS` is unset or session secrets are missing/invalid |

The `/admin` page itself is `site/src/pages/admin.astro` (server-rendered, `noindex,nofollow`, excluded from the sitemap — invariant D-4).

---

## 5. Owner step 1 — Vercel Root Directory

**Where in the dashboard:**  
Vercel → Project → **Settings** → **General** → **Root Directory**

**What to set:**  
Leave the field **empty** (the placeholder shows "Repository root").  
Do **not** set it to `site/` or `api/` or any subfolder.

**Why:**  
The serverless functions live in `api/` at the repository root. A project rooted at `site/` deploys **no functions at all** — the sign-in door (`/api/portal/auth/request-link`) answers **404**.

**How to verify after saving:**  
1. Trigger a new deployment (push to `main` or click **Redeploy** on the latest build).  
2. After the deployment shows **Ready**, open:  
   - `https://<your-project>.vercel.app/api/portal/auth/request-link` → must answer **200** (or 405 for GET; the endpoint accepts POST).  
   - `https://<your-project>.vercel.app/api/portal/auth/verify` → must answer **200** (or 405 for GET; the endpoint accepts POST).  
   - `https://<your-project>.vercel.app/api/portal/projects` → must answer **200** (or 405 for GET; the endpoint accepts POST).  
3. If any URL returns **404**, the Root Directory is wrong — re-open Settings → General and clear the field.

---

## 6. Owner step 2 — The database (Turso / libSQL)

The portal needs a libSQL database. The code reads **exactly these three variables** (see `site/shared/portal-store/index.ts` lines 9–13 and `edge.ts` line 22):

| Variable | Value | Where to paste |
|---|---|---|
| `PORTAL_STORE` | `libsql` | Vercel **Project → Settings → Environment Variables** (Production, Preview, Development) **and** Cloudflare **Pages → Settings → Environment variables** |
| `LIBSQL_URL` | `libsql://<your-db>.turso.io` | Same two places — never in the repo |
| `LIBSQL_TOKEN` | `eyJhbGciOi...` (the auth token) | Same two places — **never commit this token, never paste it into a report or chat** |

**Exact steps to create the free-tier database:**

1. Go to https://turso.tech and sign in (or create an account).  
2. Click **Create database** → choose a name (e.g. `imk-portal`) → select the **free tier** → pick a region close to your users.  
3. After the database is provisioned, open its **Details** page.  
4. Copy **Database URL** (looks like `libsql://imk-portal-<org>.turso.io`) → paste as `LIBSQL_URL`.  
5. Click **Generate auth token** → copy the token (starts with `eyJ…`) → paste as `LIBSQL_TOKEN`.  
6. In **Vercel**: Project → Settings → Environment Variables → add the three rows above for **Production**, **Preview**, and **Development**.  
7. In **Cloudflare Pages**: Project → Settings → Environment variables → add the same three rows for **Production** and **Preview**.  
8. Redeploy both targets (push to `main` or trigger a manual deploy).

> **Security note:** `LIBSQL_TOKEN` is a secret. It must never be committed to the repository, never appear in build logs, never be pasted into an issue or report. Treat it like a password.

---

## 7. What is still missing for launch

| # | Item | Owner | Status |
|---|---|---|---|
| 1 | **Vercel Root Directory = repository root** (dashboard setting) | You (Owner) | ❌ Not set — must be done manually in Vercel dashboard |
| 2 | **Turso database + credentials** (`LIBSQL_URL`, `LIBSQL_TOKEN`, `PORTAL_STORE=libsql`) | You (Owner) | ❌ Database not created; env vars not added to Vercel or Cloudflare |
| 3 | **Portal handlers not wired to the libSQL adapter** (adapters exist, but portal still uses JSONL) | Backend Developer | ❌ `api/portal/projects.ts` imports `readJsonlFile` from `../lib/jsonl.js`; `api/portal/auth.ts` imports `readJsonlFile` from `../lib/jsonl.js`; `api/lib/rate-limit.ts` selects the file backend instead of `createLibsqlRateLimitBackend`; `site/scripts/publish-testimonials.mjs` reads `data/moderation/reviews.jsonl` at build time. The `PortalStore` contract is built and proven offline; the wiring is not. |

All three must be complete before the portal can accept sign-ups, store projects, or serve reviews.

---

## 8. Environment variables — extended table (storage vars included)

| Variable | Required | Notes |
|---|---|---|
| `SITE_BASE_URL` | yes | the public origin, e.g. `https://imk.example`. Also used for the sign-in link and the one-click moderation link. Without it a production instance answers `500 { code: 'internal' }`. |
| `SITE_URL` | fallback | older name for `SITE_BASE_URL`. |
| `PORTAL_MAGIC_LINK_SECRET` | yes | HMAC key for the magic link and the moderation signature. Must be the **same value** on every instance. |
| `RESEND_API_KEY` | yes | without it a production instance answers `500` instead of sending a sign-in link. |
| `RESEND_FROM` | yes | a verified sender, e.g. `IMK <2imk4support@gmail.com>`. |
| `RESEND_TO` | yes | where the owner notifications go. |
| `FORM_WEBHOOK_SECRET` | yes | signs the one-click moderation links. |
| `ADMIN_EMAILS` | yes | comma-separated list of owner addresses (the owner role). |
| `TURNSTILE_SECRET_KEY` | yes | the public contact form. |
| `PORTAL_RATE_LIMIT_FILE` | no | only for a self-hosted target: a durable counter file. On Vercel the limit is per instance until the storage migration lands. |
| **`PORTAL_STORE`** | **yes (for portal)** | **`libsql` in production. The adapter is built and proven (60/60 contract tests); the portal handlers are being wired to it (in flight). The owner creates the database and sets the three variables below.** |
| **`LIBSQL_URL`** | **yes (for portal)** | **`libsql://<db>.turso.io`. The adapter is built and proven; the wiring is in flight.** |
| **`LIBSQL_TOKEN`** | **yes (for portal)** | **Turso auth token. The adapter is built and proven; the wiring is in flight. Never commit; never log.** |

> The three storage rows above document the libSQL adapter that exists at `site/shared/portal-store/libsql-adapter.ts`, `libsql-transport.ts`, `libsql-schema.ts` and is proven by `npm run test:store` (60/60). The portal still uses the file store today because the wiring to the libSQL adapter is not yet complete — the owner creates the database, adds the credentials, and the wiring lands in the next wave.
