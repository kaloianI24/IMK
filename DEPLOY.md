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
| `PORTAL_RATE_LIMIT_FILE` | no | only for a self-hosted target: a durable counter file. On Vercel the limit is **per instance in file mode (default)** and **shared and durable on the database with `PORTAL_STORE=libsql`**. The explicit `PORTAL_RATE_LIMIT_FILE` still wins over `PORTAL_STORE=libsql` (`site/shared/server/rate-limit.ts:437-455`). |

### 1.3 What works on Vercel — file store vs libSQL

The portal supports two store modes. With `PORTAL_STORE=file` (default), writes go to `site/data/portal/*.jsonl` — this **cannot persist** on Vercel's read-only filesystem (only `/tmp` is writable). With `PORTAL_STORE=libsql`, the libSQL adapter runs over the libSQL HTTP v2 pipeline on global `fetch` — no writable disk is needed, and the portal persists on Vercel.

**What works on Vercel with `PORTAL_STORE=file` (default):**
- The Astro marketing site (`site/`) builds and deploys successfully.
- The public contact form (`/api/contact`) works.
- The moderation endpoint (`/api/moderate/review`) returns `501 { code: 'unimplemented' }` in **file mode on Vercel** (no `site/data/` is carried, so the store is unreachable → 501). With `PORTAL_STORE=libsql` the moderation endpoint reads and writes the database. The fail-closed rule itself stands.
- All portal endpoints (`/api/portal/*`) are **wired to the PortalStore contract** via `site/shared/server/portal-store-access.ts` (getPortalStore, guardStore, portalStoreMode, createPortalTransport). With `PORTAL_STORE=file` the very same records land in `site/data/portal/*.jsonl` as before — the wiring is complete, but the file store cannot persist on Vercel's read-only filesystem.

**What requires `PORTAL_STORE=libsql` to work on Vercel:**
- Portal writes that persist across invocations. The libSQL adapter runs over the libSQL HTTP v2 pipeline on global `fetch` — no writable disk is needed.
- **Rate limiting that is shared and durable across instances.** With `PORTAL_STORE=libsql` the limiter uses the durable counter on the same libSQL connection (`site/shared/portal-store/durable-rate-counter.ts`). The explicit `PORTAL_RATE_LIMIT_FILE` still wins over `PORTAL_STORE=libsql` (an operator who names a counter file wants that file).

**The durable answer is the libSQL adapter (T4):**
- Task T4 in `spec/08-portal-mvp.md` §4.8.5 and `spec/proposal-portal-storage.md`.
- The `PortalStore` interface and the file adapter already exist (`site/shared/portal-store/`).
- The libSQL adapter **is built and proven**: `npm run test:store` = **72 pass / 0 fail** (**27 file** assertions, **34 libsql** assertions, **11 shared** assertions — the revision-scope and identity-scope assertions added in waves 10 and 12). `getStore(env)` at `site/shared/portal-store/index.ts:35` and `edge.ts:30` selects the libSQL adapter when `PORTAL_STORE=libsql`.
- The portal handlers **are now wired** to the libSQL adapter (wave 9 landed, wave 13 refactored to entry points):
  - The entry point `api/portal.ts` routes nine `/api/portal/*` URLs to handlers in `site/shared/portal-handlers/`
  - The entry point `api/admin.ts` routes two `/api/admin/*` URLs to handlers in `site/shared/portal-handlers/`
  - `api/moderate/review.ts`, `api/contact.ts`, and the three `api/portal/auth/*.ts` shims keep their own URLs
  - All handlers import `getPortalStore`, `guardStore`, `assertStoreReachable`, `StoreUnreachableError` from `site/shared/server/portal-store-access.ts`
  - `site/scripts/publish-testimonials.mjs` reads the portal store at build time: `readReviewsFromStore()` (`site/scripts/publish-testimonials.mjs:669`) picks `readReviewsFromDatabase(env)` when `PORTAL_STORE=libsql` and `readReviewsFromFile(resolveDataDir(env))` otherwise. It is a build-time script, not a serverless handler, so it is not a Vercel function. **Wave 10 (F-1) changed the publisher's failure behaviour:** a missing store, an unparsable store, and a database with no schema each make the build **fail** (`exit 1`, message "Refusing to publish a partial set of testimonials.") and leave the published quotes untouched. **Wave 12 (B-4) changed the guard to count review-type records only:** `assertStoreIsNotEmpty()` (`site/scripts/publish-testimonials.mjs:293-304`) filters for `type === 'review'` and throws `EmptyStoreError` with the message "the portal store holds NO review records, but N published testimonial(s) exist. An empty store must never replace a published set — refusing to publish an empty set of testimonials. Check that the build reads the right store (PORTAL_STORE / PORTAL_DATA_DIR) before publishing again." The published set is now built in a **staging directory and swapped in** with crash-safe recovery (`site/scripts/publish-testimonials.mjs:736-836`), so a failed publish leaves the published directory exactly as it was. **If a Vercel build fails on the publisher:** the owner should check the build log for the reason (missing store, unparsable store, schema-less database, or empty store with existing published quotes) — the published client quotes are protected by this behaviour and are never deleted by a failed run.
- The portal session route is served by `api/portal.ts` → `site/shared/portal-handlers/portal-session.ts` (reads the signed session, not the store).
- The owner needs only two values (`LIBSQL_URL`, `LIBSQL_TOKEN`) plus a database — the Turso vs Neon choice does **not** block the code (the adapter speaks the libSQL HTTP v2 protocol; `PortalStore` keeps Postgres swappable).

Do not claim the portal is deployable when it is not. Do not invent or stub a libSQL adapter.

### 1.4 Deploying from CI

`.github/workflows/ci.yml` has a `deploy-vercel` job that is gated on `VERCEL_TOKEN` and
currently deploys nothing on purpose. To enable it: link the project in the Vercel
dashboard (Root Directory = the repository root), add the token as a repository secret,
and uncomment the `npx vercel --prod` step. The job runs from the **repository root**.

---

## 1.5 Function budget — RESOLVED (wave 13)

`api/` now holds **7 `.ts` files** at the repository root (was 20 before the wave-13 refactor). Vercel's documentation
(<https://vercel.com/docs/functions/runtimes>) states that **without a framework**
(`"framework": null` in `vercel.json`) **every file in `api/` becomes one Vercel
Function**. On the **Hobby plan** a no-framework project is capped at **12 functions
per deployment** (Pro and Enterprise are unlimited).

| Category | Count | Files |
|---|---|---|
| Real routes (have a default export handler) | 7 | `contact.ts`, `moderate/review.ts`, `portal.ts`, `admin.ts`, `portal/auth/logout.ts`, `portal/auth/request-link.ts`, `portal/auth/verify.ts` |
| Shared utilities (NO default export - build a dead function that 500s on its URL) | 0 | (moved to `site/shared/server/`) |
| **Total Vercel functions on deploy** | **7** | **7 ≤ 12 (Hobby cap) — DEPLOYABLE** |

**What this means:**
- **On Vercel Hobby/Pro/Enterprise:** the deploy works. The function count is 7, well under the 12-function Hobby cap. The two shared utilities (`lib/notifications.ts`, `lib/rate-limit.ts`) were moved to `site/shared/server/` and are imported by the entry points. `api/lib/jsonl.ts` was deleted (zero product importers, wave 12). The refactor from `spec/proposal-wave7-design-2026-10-21.md` §2 is **applied**: one shared entry point per route family (`api/portal.ts`, `api/admin.ts`) + `vercel.json` rewrites (11 rewrites) + the route table `site/shared/portal-routes.json` + the fail-closed resolver `site/shared/portal-router.ts`.

Do not claim the deploy works on Hobby without the refactor — it is now applied and the count is 7.

---

## 1.6 Routing on Vercel — how it actually works

**This is a documented trade-off of the 7-function budget, not a hardening guarantee.**

`vercel.json` defines 11 rewrites that map the 11 family routes (9 portal + 2 admin) to their two entry points:

| # | Rewrite Source | Rewrite Destination | Entry Point |
|---|---|---|---|
| 1 | `/api/portal/comments` | `/api/portal?__imk_route=/api/portal/comments` | `api/portal.ts` |
| 2 | `/api/portal/invites` | `/api/portal?__imk_route=/api/portal/invites` | `api/portal.ts` |
| 3 | `/api/portal/plan-items` | `/api/portal?__imk_route=/api/portal/plan-items` | `api/portal.ts` |
| 4 | `/api/portal/plan-items/:id` | `/api/portal?__imk_route=/api/portal/plan-items/:id` | `api/portal.ts` |
| 5 | `/api/portal/projects` | `/api/portal?__imk_route=/api/portal/projects` | `api/portal.ts` |
| 6 | `/api/portal/projects/:id` | `/api/portal?__imk_route=/api/portal/projects/:id` | `api/portal.ts` |
| 7 | `/api/portal/session` | `/api/portal?__imk_route=/api/portal/session` | `api/portal.ts` |
| 8 | `/api/portal/testimonials` | `/api/portal?__imk_route=/api/portal/testimonials` | `api/portal.ts` |
| 9 | `/api/portal/updates` | `/api/portal?__imk_route=/api/portal/updates` | `api/portal.ts` |
| 10 | `/api/admin/reviews` | `/api/admin?__imk_route=/api/admin/reviews` | `api/admin.ts` |
| 11 | `/api/admin/session` | `/api/admin?__imk_route=/api/admin/session` | `api/admin.ts` |

**On the deployed target:** the rewrite replaces the URL path with the entry point path and carries the original public path in the `__imk_route` query parameter. **The path no longer identifies the route** — a client-supplied `__imk_route` can select another route **of the same family**.

**What holds (invariants that are true regardless of the platform's query-merge order):**

1. **Family containment:** The portal and admin route tables are disjoint — a forged carrier cannot cross from one family to the other.
2. **Standalone routes are unreachable via carrier:** The five standalone URLs (`/api/contact`, `/api/moderate/review`, `/api/portal/auth/request-link`, `/api/portal/auth/verify`, `/api/portal/auth/logout`) are in no family table, so no carrier can reach them.
3. **Every handler authorizes itself:** Each handler enforces its own access control (`resolveAccess`, `canReadClient`, `canWriteClient`, owner session) — a forged carrier cannot grant a capability the handler would not otherwise grant.

**What is NOT guaranteed:** The platform's query-merge order (whether the client's `__imk_route` or the rewrite's `__imk_route` wins) is **unobserved** — no Vercel router has been booted, no preview deploy has been done. If the client's query wins, a forged carrier can still select another handler *of the same family* — bounded by that handler's own gate, so a routing surprise rather than an escalation.

**What the resolver does:** `site/shared/portal-router.ts` resolves the route in this order: (1) the literal path, (2) the `__imk_route` carrier **if present and non-empty**, (3) the `x-imk-route` header **only when the query parameter is genuinely absent**. An unknown path returns **404**; a bare entry point with no carrier returns a **loud 500 `{code:'route-resolution'}`** (never a silent 404). A carrier that is present but empty (`?__imk_route=`) is refused with **404 `{code:'not-found'}`** and the header is **not** consulted. The resolver also verifies the carrier belongs to the entry point's family (`isInsideEntry`).

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
| `GET /api/admin/session` | `api/admin.ts` | `site/functions/api/admin/session.ts` | **200** `{ok:true,role:'admin',email:'...'}` for the allow-listed owner; **401** `{code:'unauthorized'}` for a non-owner (client session, no session, forged cookie, or address not on `ADMIN_EMAILS`); **500** `{code:'internal'}` when `ADMIN_EMAILS` is unset |
| `GET /api/admin/reviews` | `api/admin.ts` | `site/functions/api/admin/reviews.ts` | **200** `{ok:true,counts:{...},reviews:[...],recent:[...]}` for the allow-listed owner; **401** `{code:'unauthorized'}` for a non-owner; **500** `{code:'internal'}` when `ADMIN_EMAILS` or `FORM_WEBHOOK_SECRET` is unset; **501** `{code:'unimplemented'}` when the moderation store file is missing (read-only filesystem) |

### 4.1.1 Portal session route

The owner-role endpoint used by the portal UI:

| Route | File (Vercel) | File (Cloudflare) | Response |
|---|---|---|---|
| `GET /api/portal/session` | `api/portal.ts` | `site/functions/api/portal/session.ts` | **200** `{authenticated:true,role:'admin'|'client',expiresAt:number}` for a valid session; **401** `{code:'unauthorized'}` with no valid session; **500** `{code:'internal'}` when `ADMIN_EMAILS` is unset or session secrets are missing/invalid |

The `/admin` page itself is `site/src/pages/admin.astro` (server-rendered, `noindex,nofollow`, excluded from the sitemap — invariant D-4).

---

## 4.2 All public API URLs (16 routes)

The table below lists every public API URL, its Vercel function file, and its Cloudflare twin. This is the authoritative list derived from `site/shared/portal-routes.json`.

| # | Route | Vercel Function File | Cloudflare Function File | Family / Type |
|---|---|---|---|---|
| 1 | `GET/POST /api/portal/comments` | `api/portal.ts` → `site/shared/portal-handlers/portal-comments.ts` | `site/functions/api/portal/comments.ts` | Portal family (rewrite) |
| 2 | `POST /api/portal/invites` | `api/portal.ts` → `site/shared/portal-handlers/portal-invites.ts` | `site/functions/api/portal/invites.ts` | Portal family (rewrite) |
| 3 | `GET /api/portal/plan-items` | `api/portal.ts` → `site/shared/portal-handlers/portal-plan-items.ts` | `site/functions/api/portal/plan-items.ts` | Portal family (rewrite) |
| 4 | `GET /api/portal/plan-items/*` | `api/portal.ts` → `site/shared/portal-handlers/portal-plan-items.ts` | `site/functions/api/portal/plan-items/[id].ts` | Portal family (rewrite) |
| 5 | `GET/POST /api/portal/projects` | `api/portal.ts` → `site/shared/portal-handlers/portal-projects.ts` | `site/functions/api/portal/projects.ts` | Portal family (rewrite) |
| 6 | `GET /api/portal/projects/*` | `api/portal.ts` → `site/shared/portal-handlers/portal-projects.ts` | `site/functions/api/portal/projects/[id].ts` | Portal family (rewrite) |
| 7 | `GET /api/portal/session` | `api/portal.ts` → `site/shared/portal-handlers/portal-session.ts` | `site/functions/api/portal/session.ts` | Portal family (rewrite) |
| 8 | `POST /api/portal/testimonials` | `api/portal.ts` → `site/shared/portal-handlers/portal-testimonials.ts` | `site/functions/api/portal/testimonials.ts` | Portal family (rewrite) |
| 9 | `GET /api/portal/updates` | `api/portal.ts` → `site/shared/portal-handlers/portal-updates.ts` | `site/functions/api/portal/updates.ts` | Portal family (rewrite) |
| 10 | `GET /api/admin/reviews` | `api/admin.ts` → `site/shared/portal-handlers/admin-reviews.ts` | `site/functions/api/admin/reviews.ts` | Admin family (rewrite) |
| 11 | `GET /api/admin/session` | `api/admin.ts` → `site/shared/portal-handlers/admin-session.ts` | `site/functions/api/admin/session.ts` | Admin family (rewrite) |
| 12 | `POST /api/contact` | `api/contact.ts` | `site/functions/api/contact.ts` | Standalone |
| 13 | `POST /api/moderate/review` | `api/moderate/review.ts` | `site/functions/api/moderate/review.ts` | Standalone |
| 14 | `POST /api/portal/auth/request-link` | `api/portal/auth/request-link.ts` | `site/functions/api/portal/auth/request-link.ts` | Standalone (auth family) |
| 15 | `POST /api/portal/auth/verify` | `api/portal/auth/verify.ts` | `site/functions/api/portal/auth/verify.ts` | Standalone (auth family) |
| 16 | `POST /api/portal/auth/logout` | `api/portal/auth/logout.ts` | `site/functions/api/portal/auth/logout.ts` | Standalone (auth family) |

**Notes:**
- The 9 portal-family and 2 admin-family routes (11 total) are served by **two entry points** (`api/portal.ts`, `api/admin.ts`) via `vercel.json` rewrites that carry the original path in the `__imk_route` query parameter.
- The 5 standalone routes (12–16) keep their own function files and are **not rewritten**.
- Total Vercel functions: **7** (`api/portal.ts`, `api/admin.ts`, `api/contact.ts`, `api/moderate/review.ts`, `api/portal/auth/request-link.ts`, `api/portal/auth/verify.ts`, `api/portal/auth/logout.ts`).

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
2. After the deployment shows **Ready**, open the three verify URLs. On a **healthy** deploy they answer:

| URL | Expected healthy answer | Why |
|---|---|---|
| `GET /api/portal/auth/request-link` | **404** `{code:'not-found'}` | POST-only endpoint — `site/shared/portal-handlers/portal-auth.ts:306` serves POST, `:622` answers 404 for other methods. |
| `GET /api/portal/auth/verify` | **400** `{code:'validation'}` | POST-only; GET fails validation — `site/shared/portal-handlers/portal-auth.ts:459-461`. |
| `GET /api/portal/projects` | **401** `{code:'unauthorized'}` | Requires a session — `site/shared/portal-handlers/portal-projects.ts:132-137`. |
| `GET /book` | **308** redirect to `/contact` | Vercel redirect (permanent) — `vercel.json` redirects array. |

All four responses **contain a JSON body with a `code` field** (or are a proper 308) — that proves a function was served or a redirect fired.  
**Do not** treat 404/400/401 as "wrong Root Directory".

**What "wrong Root Directory" looks like:**  
- Vercel's own 404 page (HTML, no `code` field)  
- `FUNCTION_NOT_FOUND` in the body  
- A response with **no `code` field at all** — nothing served the request.

If you see any of the above, re-open Settings → General and clear the Root Directory field.

**Authoritative preview check:** see `audit-wave15-2026-10-22.md` section 8 — one `vercel link` + three `curl` commands that distinguish a live rewrite from a dead one.

---

## 6. Owner step 2 — The database (Turso / libSQL)

The portal needs a libSQL database. The code reads **exactly these three variables** (see `site/shared/portal-store/index.ts` line 36 for `PORTAL_STORE` and lines 44–49 for LIBSQL fail-closed; `edge.ts` line 31 for `PORTAL_STORE` and lines 41–46 for LIBSQL fail-closed):

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
| 3 | **Portal handlers wired to the libSQL adapter** (wave 9 landed, wave 13 refactored) | Backend Developer | ✅ The entry points `api/portal.ts` (nine `/api/portal/*` URLs) and `api/admin.ts` (two `/api/admin/*` URLs) route to handlers in `site/shared/portal-handlers/` which import `getPortalStore`/`getPortalBackend` from `site/shared/server/portal-store-access.ts` and use the `PortalStore` contract. `site/scripts/publish-testimonials.mjs` reads the portal store at build time (`readReviewsFromStore()` picks the database branch when `PORTAL_STORE=libsql`, the file branch otherwise). Every portal handler, the moderation endpoint, the admin inbox and the rate limiter read and write the portal store. `api/lib/jsonl.ts` was deleted (wave 12, zero product importers). The shared utilities `notifications.ts` and `rate-limit.ts` were moved to `site/shared/server/` (wave 13). The function budget is now **7** (well under the Hobby 12-function cap). |

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
| `PORTAL_RATE_LIMIT_FILE` | no | only for a self-hosted target: a durable counter file. On Vercel the limit is **per instance in file mode (default)** and **shared and durable on the database with `PORTAL_STORE=libsql`**. The explicit `PORTAL_RATE_LIMIT_FILE` still wins over `PORTAL_STORE=libsql` (`site/shared/server/rate-limit.ts:437-455`). |
| `TRUST_CF_CONNECTING_IP` | no | **Set to `1` only when Cloudflare actually fronts Vercel** (i.e. the traffic flows Cloudflare → Vercel). Vercel never sets `cf-connecting-ip`; it sets `x-real-ip` and `x-vercel-forwarded-for`. When unset (default), the platform address falls back to Vercel's headers. The Cloudflare Pages twin sets this to `1` automatically. |
| **`PORTAL_STORE`** | **yes (for portal)** | **`libsql` in production. The adapter is built and proven (72/72 contract tests: 27 file, 34 libsql, 11 shared); the portal handlers are wired to it via `site/shared/server/portal-store-access.ts` (getPortalStore, guardStore, portalStoreMode, createPortalTransport). The owner creates the database and sets the three variables below.** |
| **`LIBSQL_URL`** | **yes (for portal)** | **`libsql://<db>.turso.io`. The adapter is built and proven; the wiring is landed (wave 9).** |
| **`LIBSQL_TOKEN`** | **yes (for portal)** | **Turso auth token. The adapter is built and proven; the wiring is landed (wave 9). Never commit; never log.** |

> The three storage rows above document the libSQL adapter that exists at `site/shared/portal-store/libsql-adapter.ts`, `site/shared/portal-store/libsql-transport.ts`, `site/shared/portal-store/libsql-schema.ts` and is proven by `npm run test:store` (72/72: 27 file, 34 libsql, 11 shared). The portal handlers are wired to the libSQL adapter via `site/shared/server/portal-store-access.ts` (wave 9 landed, wave 13 refactored to entry points). With `PORTAL_STORE=libsql` the portal persists on Vercel's read-only filesystem; with `PORTAL_STORE=file` the very same records land in `site/data/portal/*.jsonl` as before. Every portal handler, the moderation endpoint, the admin inbox and the rate limiter read and write the portal store. `api/lib/jsonl.ts` was deleted (wave 12, zero product importers). The shared utilities `notifications.ts` and `rate-limit.ts` were moved to `site/shared/server/` (wave 13). The function budget is now **7** (well under the Hobby 12-function cap).

---

## 9. Wave 18e — Booking flow removed, email contact page added

### 9.1 Redirect: `/book` → `/contact`

| Target | Redirect | Code | Location |
|---|---|---|---|
| Vercel | `/book` → `/contact` | **308 (permanent)** | `vercel.json` → `redirects` array |
| Cloudflare Pages / Netlify | `/book` → `/contact` | **301** | `site/public/_redirects` |

The old Calendly booking page (`site/src/pages/book.astro`) has been deleted. All CTAs across the site now point to `/contact`.

### 9.2 New `/contact` page — on-site email composer

- **Page:** `site/src/pages/contact.astro` (new)
- **POST target:** `/api/contact` (multipart/form-data)
- **Fields sent:** `type=contact`, `name`, `email` (Reply-To), `company`, `subject` (preset or free text), `project` (description), `budget=not-sure`, `timeline=exploring`, `website` (honeypot), `ts`, `turnstileToken`, `files` (repeated, max 3)
- **Attachments:** max 3 files, 4 MB total (under Vercel's 4.5 MB request ceiling); allowed types: PNG, JPEG, WebP, GIF, MP4, MOV, WebM; SVG refused (magic-byte sniffed)
- **Server limits:** `MAX.body = 4 MiB` (4194304 bytes) in both `api/contact.ts` and `site/functions/api/contact.ts`; enforced on `Content-Length` and actual bytes read
- **Success response:** `200 {ok:true, emailed:true, ref}` — inline toast shows **only when `emailed === true`** ("Thanks — your email is in. We'll review it and reply within 24 hours.")
- **Failure modes:** if `emailed === false`, the toast names `2imk4support@gmail.com` instead of promising a reply; new error codes: `too-many-files` (413), `unsupported-file` (415)

### 9.3 CSP — Calendly removed

Both CSP copies no longer allow Calendly domains:

| File | Before | After |
|---|---|---|
| `vercel.json` (headers[0].Content-Security-Policy) | `script-src 'self' https://challenges.cloudflare.com https://assets.calendly.com; img-src 'self' data: https://assets.calendly.com https://calendly.com; connect-src 'self' https://calendly.com https://challenges.cloudflare.com; frame-src https://calendly.com https://challenges.cloudflare.com` | `script-src 'self' https://challenges.cloudflare.com; img-src 'self' data:; connect-src 'self' https://api.resend.com https://challenges.cloudflare.com; frame-src 'self' https://challenges.cloudflare.com` |
| `site/public/_headers` (line 7) | same as above | same as above |

`challenges.cloudflare.com` retained for Turnstile; `https://api.resend.com` added for contact-form POSTs.

### 9.4 Environment cleanup

- `CALENDLY_URL` removed from `site/.env.example` (was lines 25–26)

### 9.5 Public URL list updated

The site now includes `/contact` as a public page. The `/book` path is a redirect only.
