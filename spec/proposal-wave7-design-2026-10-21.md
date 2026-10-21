# Wave 7 design proposal — function budget, libSQL store, owner role

- **Author:** Architect — Technical Design
- **Date:** 2026-10-21
- **Repo:** `C:\Users\Kalch\Documents\IXI` (branch `main`, no git remote, shared dirty tree)
- **Scope:** design only. This document changes **no application file**. It owns `spec/**`.
- **Requested by:** @Manager (wave-7 design assignment, 2026-10-21)

Every statement about the current tree in this document cites a file path (and a line number where
the line matters). Statements about Vercel and Turso cite their documentation. Everything else is
labelled either *executed* (I ran it) or *unverified*.

---

## 0. The three decisions, in one table

| # | Decision | Recommendation | Cost | Owner input needed |
|---|---|---|---|---|
| **A** | Vercel function budget (20 → cap 12) | **7 functions** via one shared entry point per route family + `vercel.json` rewrites. Every public URL byte-identical. | one wave (5 steps, §2.9) | **one preview deploy** to prove the rewrite carrier (§2.7) |
| **B** | Portal store T4 | **libSQL/Turso over the HTTP v2 pipeline API** (`global fetch`, **zero new dependencies**), 9 tables, one-statement atomicity, injectable transport so the contract test runs offline | one wave (§3) | `LIBSQL_URL` + `LIBSQL_TOKEN` **values** only — the code does not need the Turso-vs-Neon call |
| **C** | Owner role in the portal | **one server-truth endpoint** `GET /api/portal/session`; the UI keys off the server, never off `sessionStorage`; every owner-only action uses the **two-part gate** (role **and** live allow-list) | small (2 files + 1 API) | none |

The three are independent. A can ship without B. C is one endpoint and can ship before either.

**Status as of 2026-10-21 (read from the tree, not from a report):**

- **A is DESIGNED, not built.** `api/` still holds **20** `.ts` files = 20 Vercel functions, above
  the Hobby cap of 12. Three of them have no default export and are dead URLs
  (`api/lib/jsonl.ts`, `api/lib/notifications.ts`, `api/lib/rate-limit.ts`).
- **B is BUILT** — the adapter, the DDL, the transport, the durable counter and the importer are in
  `site/shared/portal-store/`, and the contract runs against both stores offline (§3.2 as amended,
  §3.6, §3.9). **What is not built: no handler calls it** (§3.9).
- **C is HALF built** — the endpoint exists on Vercel (`api/portal/session.ts`), the UI keys off it
  (`site/src/pages/portal.astro`), and the two-part gate is **not** in the portal handlers.
  The full contract, with the gaps named, is in
  [`proposal-wave8-contract-2026-10-21.md`](proposal-wave8-contract-2026-10-21.md).

---

## 1. Facts established from the tree (read, not assumed)

### 1.1 What Vercel does with the `api/` directory

Vercel's own documentation, quoted:

> "For projects without a framework, Vercel creates a separate function for each supported source
> file in the root `api/` directory and doesn't automatically combine these files into one function.
> **Avoid creating a separate function for each API endpoint.** Keep related routes in a shared
> function so Fluid compute can reuse instances across routes and Vercel builds fewer functions […]
> define a single `fetch` handler that receives requests for all HTTP methods and **routes them by
> URL pathname**. […] **Configure rewrites to send the API paths to that function.** Keep its route
> modules and shared utilities outside the root `api/` directory because Vercel deploys each
> supported source file there as a separate function and does not combine them automatically."
> — <https://vercel.com/docs/functions/quickstart> and <https://vercel.com/docs/functions/runtimes/node-js>

> "For Hobby, this approach is limited to **12 Vercel Functions per deployment**." — <https://vercel.com/docs/functions/runtimes>

> "To avoid turning these files into functions, Vercel ignores files with the following
> characters: Files that start with an underscore, `_`; Files that start with `.`; Files that end
> with `.d.ts`." — <https://vercel.com/docs/functions/configuring-functions/advanced-configuration>

> "**File system support:** Read-only filesystem with writable `/tmp` scratch space up to 500 MB."
> — <https://vercel.com/docs/functions/runtimes>

`vercel.json` declares `"framework": null`, so the project is in the "no framework" case above.
The repo already quotes this rule in `site/shared/server/portal-session.ts:6-9` ("A module inside
api/ is not a shared module — it is a FUNCTION with a URL of its own").

### 1.2 The current `api/` tree — 20 files, 20 functions

`api/` holds 20 `.ts` files. Four of them have **no default export**, so Vercel builds a function
for a URL nobody calls (it answers "Can't detect way to handle request" — a 500 on a dead URL, not
a build failure).

| # | File | default export? | Public URL it serves | Counts as a function? |
|---|---|---|---|---|
| 1 | `api/contact.ts` | yes | `/api/contact` | yes |
| 2 | `api/admin/reviews.ts` | yes | `/api/admin/reviews` | yes |
| 3 | `api/admin/session.ts` | yes | `/api/admin/session` | yes |
| 4 | `api/lib/jsonl.ts` | **no** | — (a utility) | **yes — dead** |
| 5 | `api/lib/notifications.ts` | **no** | — (a utility) | **yes — dead** |
| 6 | `api/lib/rate-limit.ts` | **no** | — (a utility) | **yes — dead** |
| 7 | `api/moderate/review.ts` | yes | `/api/moderate/review` | yes |
| 8 | `api/portal/auth.ts` | yes | `/api/portal/auth` — **called by nothing** | yes |
| 9 | `api/portal/comments.ts` | yes | `/api/portal/comments` | yes |
| 10 | `api/portal/invites.ts` | yes | `/api/portal/invites` | yes |
| 11 | `api/portal/plan-items.ts` | yes | `/api/portal/plan-items` | yes |
| 12 | `api/portal/plan-items/[id].ts` | yes (re-export) | `/api/portal/plan-items/<id>` | yes |
| 13 | `api/portal/projects.ts` | yes | `/api/portal/projects` | yes |
| 14 | `api/portal/projects/[id].ts` | yes (re-export) | `/api/portal/projects/<id>` | yes |
| 15 | `api/portal/testimonials.ts` | yes | `/api/portal/testimonials` | yes |
| 16 | `api/portal/updates.ts` | yes | `/api/portal/updates` | yes |
| 17 | `api/portal/session.ts` | **no** | — (a utility; a re-export of `site/shared/server/portal-session.ts`) | **yes — dead** |
| 18 | `api/portal/auth/logout.ts` | yes (re-export of `../auth.js`) | `/api/portal/auth/logout` | yes |
| 19 | `api/portal/auth/request-link.ts` | yes (re-export of `../auth.js`) | `/api/portal/auth/request-link` | yes |
| 20 | `api/portal/auth/verify.ts` | yes (re-export of `../auth.js`) | `/api/portal/auth/verify` | yes |

**20 > 12 → the Hobby deploy is blocked.** The four dead utilities are free to remove; the other
sixteen are routes and each one costs a function.

### 1.3 The public URL list (executed)

`npm run check:routes` at the repo root, run today, output verbatim:

```
[check-api-routes] /api/admin/reviews       api/admin/reviews.ts       site/functions/api/admin/reviews.ts
[check-api-routes] /api/admin/session       api/admin/session.ts       site/functions/api/admin/session.ts
[check-api-routes] /api/contact              api/contact.ts              site/functions/api/contact.ts
[check-api-routes] /api/moderate/review      api/moderate/review.ts      site/functions/api/moderate/review.ts
[check-api-routes] /api/portal/auth/logout   api/portal/auth/logout.ts   site/functions/api/portal/auth/logout.ts
[check-api-routes] /api/portal/auth/request-link  api/portal/auth/request-link.ts  site/functions/api/portal/auth/request-link.ts
[check-api-routes] /api/portal/auth/verify   api/portal/auth/verify.ts   site/functions/api/portal/auth/verify.ts
[check-api-routes] /api/portal/comments      api/portal/comments.ts      site/functions/api/portal/comments.ts
[check-api-routes] /api/portal/invites       api/portal/invites.ts       site/functions/api/portal/invites.ts
[check-api-routes] /api/portal/plan-items    api/portal/plan-items.ts    site/functions/api/portal/plan-items.ts
[check-api-routes] /api/portal/plan-items/*  api/portal/plan-items/[id].ts  site/functions/api/portal/plan-items/[id].ts
[check-api-routes] /api/portal/projects      api/portal/projects.ts      site/functions/api/portal/projects.ts
[check-api-routes] /api/portal/projects/*    api/portal/projects/[id].ts  site/functions/api/portal/projects/[id].ts
[check-api-routes] /api/portal/testimonials  api/portal/testimonials.ts  site/functions/api/portal/testimonials.ts
[check-api-routes] /api/portal/updates       api/portal/updates.ts       site/functions/api/portal/updates.ts
[check-api-routes] 15 route(s), 0 missing function file(s)
```

**These 15 URLs are the contract. They must not change — not in shape, not in method, not in
query string, not in status code.** The client calls them from
`site/src/pages/portal.astro:119` (`const API = '/api/portal'`), `site/src/pages/admin.astro` and
`site/src/pages/login.astro`.

### 1.4 Which routes carry a query string (this decides the risk profile)

| URL | Query string? | Source |
|---|---|---|
| `/api/portal/auth/verify` | **yes** — `?token=` | the magic link in the e-mail (`site/shared/server/magic-link.ts`) |
| `/api/moderate/review` | **yes** — `?ref=&decision=&sig=&ts=` | the one-click moderation link (`api/lib/notifications.ts`) |
| every other route | no | `api/portal/*.ts` read the path only |

Both query-bearing routes are **GET** and both are read by a *link*, not by the SPA. Everything
else is a POST with a JSON body or a path-only GET.

### 1.5 How the handlers read their route

Every handler parses the pathname out of `req.url` and matches it literally:

- `api/portal/auth.ts:231-237` — `pathname === '/api/portal/auth/request-link'`
- `api/portal/auth.ts:373` — `pathname === '/api/portal/auth/verify'`
- `api/portal/auth.ts:526` — `pathname === '/api/portal/auth/logout'`
- `api/portal/projects.ts:129` — `pathname === '/api/portal/projects'`
- `api/portal/projects.ts:143` — `pathname.match(/^\/api\/portal\/projects\/([^\/]+)$/)`
- `api/portal/plan-items.ts:114,143`, `api/portal/comments.ts:107,136`, `api/portal/invites.ts:181`,
  `api/portal/testimonials.ts:328`, `api/portal/updates.ts:107,132`,
  `api/admin/session.ts:113`, `api/admin/reviews.ts:111`

**Consequence for the design:** a handler is already a router over its own path. If the original
path reaches the handler, the handler works unchanged. If a rewrite replaces `req.url`, the handler
sees the wrong path and answers 404. §2.7 handles this.

### 1.6 The store interface that already exists

- `site/shared/portal-store/types.ts` — `PortalStore` (8 methods), `Collection` (8 names),
  `Where` (equality-only), `ReviewState`, `ReviewDecision`
- `site/shared/portal-store/index.ts` — `getStore(env)` for Node; `PORTAL_STORE=libsql` currently
  throws `StorageError('not-implemented')` (`index.ts:37-42`)
- `site/shared/portal-store/edge.ts` — `getStore(env)` for the edge; same `not-implemented` throw
  (`edge.ts:31-36`)
- `site/shared/portal-store/file-adapter.ts` — `createFileStore({dataDir})`, `COLLECTION_FILES`
- `site/shared/portal-store/jsonl.ts`, `errors.ts` — strict parsing and the error taxonomy
- `site/shared/portal-store/test/contract.test.ts` — 22 assertions, run by `npm run test:store`

---

## 2. (A) The function budget

### 2.1 The target

**7 Vercel functions** (cap 12 → **5 slots of headroom**), every one of the 15 public URLs
byte-identical.

```
api/
  contact.ts                 → /api/contact                       (unchanged file)
  moderate/review.ts         → /api/moderate/review               (unchanged file)
  admin.ts                   → /api/admin/session, /api/admin/reviews
  portal.ts                  → /api/portal/comments, /invites, /plan-items,
                               /plan-items/<id>, /projects, /projects/<id>,
                               /testimonials, /updates
  portal/auth/request-link.ts → /api/portal/auth/request-link     (unchanged path)
  portal/auth/verify.ts      → /api/portal/auth/verify            (unchanged path)
  portal/auth/logout.ts      → /api/portal/auth/logout            (unchanged path)
= 7 functions
```

The four dead utilities and `api/portal/auth.ts` leave `api/` entirely:

```
site/shared/server/jsonl.ts          ← from api/lib/jsonl.ts
site/shared/server/notifications.ts  ← from api/lib/notifications.ts
site/shared/server/rate-limit.ts     ← from api/lib/rate-limit.ts
site/shared/server/portal-session.ts ← already exists; api/portal/session.ts is a re-export of it
site/shared/portal-handlers/portal-auth.ts     ← from api/portal/auth.ts
site/shared/portal-handlers/portal-projects.ts  ← from api/portal/projects.ts
site/shared/portal-handlers/portal-comments.ts  ← from api/portal/comments.ts
site/shared/portal-handlers/portal-invites.ts   ← from api/portal/invites.ts
site/shared/portal-handlers/portal-plan-items.ts ← from api/portal/plan-items.ts
site/shared/portal-handlers/portal-testimonials.ts ← from api/portal/testimonials.ts
site/shared/portal-handlers/portal-updates.ts    ← from api/portal/updates.ts
site/shared/portal-handlers/admin-session.ts     ← from api/admin/session.ts
site/shared/portal-handlers/admin-reviews.ts     ← from api/admin/reviews.ts
```

The two entry points `api/portal.ts` and `api/admin.ts` are **new files** and the only new URLs
(`/api/portal`, `/api/admin`). They are not linked from anywhere and answer `500
{code:'route-resolution'}` if reached directly — see §2.7.

### 2.2 Why the sign-in door stays three separate functions

`/api/portal/auth/*` is the most security-sensitive surface in the product, and
`/api/portal/auth/verify` is one of the two query-bearing URLs (§1.4). The design keeps all three
auth files exactly where they are, so:

- no rewrite touches a query-bearing URL → the "does the original query survive a rewrite?"
  question (§2.7) cannot affect sign-in or moderation;
- four QA suites keep their pinned paths for the auth family — the smallest possible blast radius;
- the cost is 3 functions instead of 1, and the budget still fits (7 ≤ 12).

**If the budget ever gets tight, the lever is the opposite direction**: consolidate the auth family
*last*, and only after the preview test in §2.7 has passed.

### 2.3 Before / after URL → file map (all 15 URLs)

| Public URL (unchanged) | Vercel file **before** | Vercel file **after** | Handler module **after** | CF file (unchanged) |
|---|---|---|---|---|
| `/api/contact` | `api/contact.ts` | `api/contact.ts` | `api/contact.ts` | `site/functions/api/contact.ts` |
| `/api/moderate/review` | `api/moderate/review.ts` | `api/moderate/review.ts` | `api/moderate/review.ts` | `site/functions/api/moderate/review.ts` |
| `/api/admin/session` | `api/admin/session.ts` | `api/admin.ts` | `site/shared/portal-handlers/admin-session.ts` | `site/functions/api/admin/session.ts` |
| `/api/admin/reviews` | `api/admin/reviews.ts` | `api/admin.ts` | `site/shared/portal-handlers/admin-reviews.ts` | `site/functions/api/admin/reviews.ts` |
| `/api/portal/auth/request-link` | `api/portal/auth/request-link.ts` | **same** | `site/shared/portal-handlers/portal-auth.ts` | `site/functions/api/portal/auth/request-link.ts` |
| `/api/portal/auth/verify` | `api/portal/auth/verify.ts` | **same** | `site/shared/portal-handlers/portal-auth.ts` | `site/functions/api/portal/auth/verify.ts` |
| `/api/portal/auth/logout` | `api/portal/auth/logout.ts` | **same** | `site/shared/portal-handlers/portal-auth.ts` | `site/functions/api/portal/auth/logout.ts` |
| `/api/portal/comments` | `api/portal/comments.ts` | `api/portal.ts` | `…/portal-comments.ts` | `site/functions/api/portal/comments.ts` |
| `/api/portal/invites` | `api/portal/invites.ts` | `api/portal.ts` | `…/portal-invites.ts` | `site/functions/api/portal/invites.ts` |
| `/api/portal/plan-items` | `api/portal/plan-items.ts` | `api/portal.ts` | `…/portal-plan-items.ts` | `site/functions/api/portal/plan-items.ts` |
| `/api/portal/plan-items/<id>` | `api/portal/plan-items/[id].ts` | `api/portal.ts` | `…/portal-plan-items.ts` | `site/functions/api/portal/plan-items/[id].ts` |
| `/api/portal/projects` | `api/portal/projects.ts` | `api/portal.ts` | `…/portal-projects.ts` | `site/functions/api/portal/projects.ts` |
| `/api/portal/projects/<id>` | `api/portal/projects/[id].ts` | `api/portal.ts` | `…/portal-projects.ts` | `site/functions/api/portal/projects/[id].ts` |
| `/api/portal/testimonials` | `api/portal/testimonials.ts` | `api/portal.ts` | `…/portal-testimonials.ts` | `site/functions/api/portal/testimonials.ts` |
| `/api/portal/updates` | `api/portal/updates.ts` | `api/portal.ts` | `…/portal-updates.ts` | `site/functions/api/portal/updates.ts` |
| `/api/portal/auth` (uncalled) | `api/portal/auth.ts` | **gone** | — | `site/functions/api/portal/auth.ts` |

**The Cloudflare tree does not change in this wave.** Cloudflare Pages Functions are not
function-capped, and the CF tree is not the deploy blocker. Behavioural parity is kept by the
existing `site/qa/qa-cf-parity.mjs` suite. The *logic* duplication between the trees is a separate
problem, addressed in §2.10.

### 2.4 The route table — one source of truth for three consumers

`site/shared/portal-routes.json` (new, machine-readable):

```json
{
  "entries": {
    "/api/portal": {
      "handler": "portal-router",
      "routes": {
        "/api/portal/comments":      "portal-comments",
        "/api/portal/invites":       "portal-invites",
        "/api/portal/plan-items":    "portal-plan-items",
        "/api/portal/plan-items/*":  "portal-plan-items",
        "/api/portal/projects":      "portal-projects",
        "/api/portal/projects/*":    "portal-projects",
        "/api/portal/testimonials":  "portal-testimonials",
        "/api/portal/updates":       "portal-updates"
      }
    },
    "/api/admin": {
      "handler": "admin-router",
      "routes": {
        "/api/admin/session": "admin-session",
        "/api/admin/reviews": "admin-reviews"
      }
    }
  }
}
```

Three consumers read it, so it can never disagree with itself:

1. **the entry points** — `api/portal.ts` / `api/admin.ts` map a route to a handler module;
2. **`site/scripts/check-api-routes.mjs`** — verifies every called URL is in a table and that the
   handler module behind it exists (replaces today's "a file exists at this path" rule for the
   Vercel tree; the CF tree keeps the file-per-URL rule);
3. **`site/scripts/dev-portal.js`** — the local dev server must serve the **same** table. This
   matters: the dev server matches by PREFIX today (`site/scripts/dev-portal.js`), which is exactly
   why three QA waves could not see the F-1 defect (`site/scripts/check-api-routes.mjs:14-20`).
   After this change the dev server implements the real table, so local and deployed routing
   agree.

### 2.5 The rewrites

`vercel.json` gains a `rewrites` array. The capture carries the original path in a reserved query
parameter; the entry point reads it back.

```json
"rewrites": [
  { "source": "/api/admin/session", "destination": "/api/admin?__imk_route=/api/admin/session" },
  { "source": "/api/admin/reviews", "destination": "/api/admin?__imk_route=/api/admin/reviews" },

  { "source": "/api/portal/comments",     "destination": "/api/portal?__imk_route=/api/portal/comments" },
  { "source": "/api/portal/invites",      "destination": "/api/portal?__imk_route=/api/portal/invites" },
  { "source": "/api/portal/plan-items",   "destination": "/api/portal?__imk_route=/api/portal/plan-items" },
  { "source": "/api/portal/plan-items/:id", "destination": "/api/portal?__imk_route=/api/portal/plan-items/:id" },
  { "source": "/api/portal/projects",     "destination": "/api/portal?__imk_route=/api/portal/projects" },
  { "source": "/api/portal/projects/:id", "destination": "/api/portal?__imk_route=/api/portal/projects/:id" },
  { "source": "/api/portal/testimonials", "destination": "/api/portal?__imk_route=/api/portal/testimonials" },
  { "source": "/api/portal/updates",      "destination": "/api/portal?__imk_route=/api/portal/updates" }
]
```

**Nine rules, ten URLs** (`plan-items/:id` and `projects/:id` are covered by the `:id` capture).
`/api/contact`, `/api/moderate/review` and the three auth URLs are **not** rewritten — they keep
their own files and are therefore untouched by any rewrite behaviour.

Vercel documents the capture-into-query form:

> "You can also capture multiple path segments:
> `{ "source": "/blog/:year/:month/:slug*", "destination": "/posts?date=:year-:month&slug=:slug*" }`"
> — <https://vercel.com/docs/routing/rewrites>

### 2.6 The resolver — one pure function, fail-closed

`site/shared/portal-router.ts` (new, platform-neutral, no `node:` imports):

```ts
export function resolveRoute(
  rawUrl: string,
  carrier: string | null,
  entryPrefix: string,
  table: Record<string, string>,
): { ok: true; route: string; handler: string } | { ok: false; reason: 'not-found' | 'route-resolution' }
```

Rules, in order:

1. `carrier` present **and** present in `table` → serve it. (The rewrite path.)
2. `carrier` absent, and the raw pathname is in `table` → serve it. (The dev server, `vercel dev`,
   or any future non-rewrite path.)
3. `carrier` absent and the raw pathname **equals the entry prefix** (`/api/portal`) →
   `route-resolution` → **500 `{error:'route resolution failed', code:'route-resolution'}`** plus a
   log line `{"outcome":"route_resolution_failed","entry":"/api/portal"}`. This is the "the
   platform ate the path" case: it must be loud, never a silent 404.
4. otherwise → `not-found` → **404 `{error:'not found', code:'not-found'}`**.

The resolver is a pure function over a string, so it is unit-testable offline with no server and
no platform — which is exactly what the QA suite should do.

The `carrier` argument is filled by the entry point from **either** the reserved query parameter
**or** the `x-imk-route` request header, in that order. One resolver, two transports — which is
what makes the contingency in §2.7 a one-line change in `vercel.json` rather than a code change.

The entry point then **rebuilds `req.url`** before calling the handler, so the handler's own
`pathname` match (§1.5) succeeds unchanged:

```
original path  = resolved route           (e.g. /api/portal/projects/prj_1)
rebuilt req.url = original path + (original query, minus the carrier parameter)
```

Because the handler modules keep their `export default (req, res) => Promise<void>` shape
**byte-identically**, the QA suites that call a handler directly with a synthetic `req` keep working
after a path swap (§2.8).

### 2.7 The one thing that cannot be designed away

**Unverified:** whether Vercel preserves the original query string when a rewrite destination
carries its own query. I could not boot the Vercel router (no token, no deploy — and the wave-7
assignment forbids deploys), so this is a documented behaviour I have *not* observed.

Why it does not put the product at risk in this design:

- the two query-bearing URLs (`/api/portal/auth/verify`, `/api/moderate/review`) are **not
  rewritten** — the sign-in door and the moderation link keep their own function files and their
  original `req.url` (§2.2). If the platform dropped the query, only the ten rewritten URLs would
  be affected, and **none of them carries a query**;
- if the carrier itself were not delivered, the failure is a loud `500 route-resolution` (§2.6
  rule 3) — never a silent 404 and never a wrong answer.

**The test that settles it (needs a Vercel token, ~15 minutes, one preview deployment):**

```
GET /api/portal/projects        → must be 200 with the caller's projects
GET /api/portal/projects/prj_1  → must be 200 for the owner, 403 for another client
GET /api/portal/typo            → must be 404 {code:'not-found'}
GET /api/portal                  → must be 500 {code:'route-resolution'}
POST /api/portal/invites        → must be 200/403 as before
```

**Contingency if the carrier does not survive:** use the legacy `routes` form with a request-header
transform instead of a query carrier, so the query is never touched:

```json
"routes": [
  { "src": "/api/portal/(.*)", "dest": "/api/portal",
    "transforms": [{ "type": "request.headers", "op": "set",
                     "target": { "key": "x-imk-route" }, "args": "$1" }] }
]
```

The resolver already accepts a header carrier, so **only the rewrite rule changes** — the handler
code, the route table and the QA suite are unaffected. This is why the resolver is written to
accept more than one carrier.

### 2.8 Every QA-pinned path (the re-pin list)

`site/qa/*.mjs` and the repo-root harnesses import handler modules **by path**. A file move breaks
that methodology, so here is every pin, with its new home. The suites live in `site/qa/`
(`run-all-suites.ps1` is the runner) except the two repo-root harnesses.

| Suite | Pinned path today | Pinned path after | Note |
|---|---|---|---|
| `qa-admin-independent.mjs` | `api/admin/reviews.ts` | `site/shared/portal-handlers/admin-reviews.ts` | path swap |
| | `api/admin/session.ts` | `site/shared/portal-handlers/admin-session.ts` | path swap |
| `qa-backend-hardening.mjs` | `api/moderate/review.ts` | **unchanged** | |
| | `api/portal/auth.ts` | `site/shared/portal-handlers/portal-auth.ts` | path swap |
| | `api/portal/auth/logout.ts` | **unchanged** | |
| | `api/portal/auth/request-link.ts` | **unchanged** | |
| | `api/portal/auth/verify.ts` | **unchanged** | |
| | `api/portal/invites.ts` | `…/portal-invites.ts` | path swap |
| | `api/portal/plan-items/[id].ts` | `…/portal-plan-items.ts` | **two pins collapse into one module** |
| | `api/portal/projects.ts` | `…/portal-projects.ts` | path swap |
| | `api/portal/projects/[id].ts` | `…/portal-projects.ts` | **two pins collapse into one module** |
| | `api/portal/testimonials.ts` | `…/portal-testimonials.ts` | path swap |
| `qa-cf-parity.mjs` | `api/lib/notifications.ts` | `site/shared/server/notifications.ts` | path swap |
| | `api/moderate/review.ts` | **unchanged** | |
| | `api/portal/{auth,comments,invites,plan-items,projects,testimonials,updates}.ts` | `…/portal-*.ts` | 8 path swaps |
| | `api/portal/session.ts` | `site/shared/server/portal-session.ts` | path swap |
| | `site/functions/api/**` (9 files) | **unchanged** | CF tree does not move in this wave |
| `qa-mutation-probe.mjs` | `api/lib/jsonl.ts` | `site/shared/server/jsonl.ts` | path swap; the probe copies `api/` + `site/shared/` into a sandbox (`qa-mutation-probe.mjs:63-64`) — the copy list must add `site/shared/server/` |
| `qa-rate-limit.mjs` | `api/lib/rate-limit.ts` | `site/shared/server/rate-limit.ts` | path swap |
| | `site/functions/api/lib/rate-limit.ts` | **unchanged** | |
| `qa-testimonials.mjs` | `api/contact.ts` | **unchanged** | |
| | `api/moderate/review.ts` | **unchanged** | |
| | `api/portal/auth.ts` | `…/portal-auth.ts` | path swap |
| | `api/portal/invites.ts` | `…/portal-invites.ts` | path swap |
| | `api/portal/projects.ts` | `…/portal-projects.ts` | path swap |
| | `api/portal/testimonials.ts` | `…/portal-testimonials.ts` | path swap |
| `qa-wave2-independent.mjs` | `API_DIR = <repo>/api` (env-overridable) | unchanged | it points at the *directory*, not a file — but it must now load the entry points, see below |
| `qa-wave3-independent.mjs` | `api/lib/notifications.ts`, `api/lib/rate-limit.ts` | `site/shared/server/…` | 2 path swaps |
| | `api/moderate/review.ts` | **unchanged** | |
| | `api/portal/{auth,comments,invites,plan-items,projects,testimonials,updates}.ts` | `…/portal-*.ts` | 8 path swaps |
| | *check D2* asserts five route files exist in **both** trees (`qa-wave3-independent.mjs:1015-1038`) | **must be rewritten** | see below |
| | *check D2* asserts **no catch-all** in either tree (`qa-wave3-independent.mjs:1042-1052`) | **stays true** | this design introduces no catch-all |
| `qa-wave4-independent.mjs` | `api/contact.ts`, `api/moderate/review.ts` | **unchanged** | |
| `qa-wave5-independent.mjs` | `api/lib/rate-limit.ts` | `site/shared/server/rate-limit.ts` | path swap |
| | `api/moderate/review.ts` | **unchanged** | |
| | `api/portal/session.ts` | `site/shared/server/portal-session.ts` | path swap |
| `backend-f1-magic-token-harness.mjs` (repo root) | `api/portal/auth.ts` | `…/portal-auth.ts` | path swap |
| | `api/portal/auth/request-link.ts`, `api/portal/auth/verify.ts` | **unchanged** | |
| | `api/portal/session.ts` | `site/shared/server/portal-session.ts` | path swap |

**Total: 34 path pins, 25 of them change, 9 stay.** Every change is a *path swap of the same
module* — no suite needs a new harness, a new mock or a new assertion. That is the property that
makes this refactor safe for the test methodology.

Two suites need more than a path swap:

- **`qa-wave3-independent.mjs` check D2** asserts that five route files exist in both trees
  (`qa-wave3-independent.mjs:1015-1038`, the `required` array at :1018-1025 and the existence
  loop at :1029-1036). After the change, the Vercel side of that assertion becomes "the route
  table in `site/shared/portal-routes.json` contains these five URLs and the handler module behind
  each one exists". The CF side is unchanged. The check keeps its meaning — it still fails if a
  route loses its handler — but it reads the table instead of the directory. The same file's ban on
  catch-all routes (`qa-wave3-independent.mjs:1042-1052`) **stays in force**: this design
  introduces none.
- **`qa-backend-hardening.mjs` check N2** (`qa-backend-hardening.mjs:826-838`) has the same shape and
  the same required change.

### 2.9 Migration order — lowest risk first

Each step is independently revertible. **Nothing ships before step 4**, and step 4 is one atomic
change.

| Step | Change | Functions after | Risk | Rollback |
|---|---|---|---|---|
| **0** | Move the four dead utilities out of `api/` into `site/shared/server/` and re-point their importers — **22 import statements across 10 files**: `api/lib/jsonl.ts` (9 importers), `api/portal/session.ts` (8 importers), `api/lib/notifications.ts` (3), `api/lib/rate-limit.ts` (2). No URL, no behaviour, no signature changes. | 20 → **16** | low — a pure import move; `npm run typecheck:api` and the full QA runner are the gate | revert the import statements |
| **1** | Write `site/shared/portal-routes.json`, `site/shared/portal-router.ts` (the resolver), and a **unit test for the resolver** (pure function, no server). Nothing is wired to a URL yet. | 16 | none — no deploy-visible change | delete the new files |
| **2** | Write the two entry points `api/portal.ts`, `api/admin.ts` and the handler modules under `site/shared/portal-handlers/`, **copying the handler bodies byte-for-byte**. The entry points are not reachable yet (no rewrite). | 18 (2 dead entries) | low — additive | delete the new files |
| **3** | Update `site/scripts/check-api-routes.mjs` to read the route table, and add a **new check: the function budget** (count the default-exporting files under `api/`, fail above 12). Update `site/scripts/dev-portal.js` to serve the table. | 18 | low | revert the scripts |
| **4** | **The switchover, one atomic commit:** add the `rewrites` to `vercel.json`; delete the **11** superseded files from `api/` (`api/portal/{auth,comments,invites,plan-items,projects,testimonials,updates}.ts`, `api/portal/projects/[id].ts`, `api/portal/plan-items/[id].ts`, `api/admin/{session,reviews}.ts`); the three auth shims now re-point to `site/shared/portal-handlers/portal-auth.ts`; `api/admin/reviews.ts`'s `./session.js` import follows it to `./admin-session.js`. | 18 → **7** | **medium — this is the deploy-visible step** | revert the commit; the old files come back and the rewrites go with them |
| **5** | QA re-pins (§2.8): 25 path swaps + the two rewritten route-table checks + a new resolver unit suite. | 7 | low | revert the re-pin commit |

**Step 4 is the only one that can break production, and it is the only one that must be
accompanied by the §2.7 preview test.** If the preview test is not possible, ship steps 0–3 and
stop: 18 functions is still over the cap, so the deploy stays blocked, but nothing is broken.

### 2.10 What this design deliberately does not do

- **It does not consolidate the Cloudflare tree.** CF Pages Functions are not function-capped, and
  the CF tree is not the blocker. Consolidating it would double the QA re-pin for no deploy value.
- **It does not remove the logic duplication between the two trees.** The trees still carry two
  copies of every handler's logic, which is the drift class that produced D-4 (the CF moderation
  twin answering 404 where the Vercel tree answered 501). The cure is a **shared, platform-neutral
  handler core** — `site/shared/portal-core/<resource>.ts` returning `{status, body, headers}`
  instead of touching `req`/`res` — with each tree keeping a thin adapter. That is a *separate,
  larger* wave (it touches every handler's body) and it should be scheduled **after** the deploy
  is unblocked. It is not required by the function budget.
- **It does not introduce a catch-all route.** Vercel's catch-all convention (`[...slug].ts`) is a
  Next.js feature; the repository's own QA bans catch-alls on the record
  (`qa-wave3-independent.mjs:1040-1048`), and the rewrite mechanism is what Vercel documents for
  frameworkless projects. If a future preview test proves that dynamic segments work in a
  frameworkless `api/` directory, a catch-all becomes an *alternative* implementation of the same
  entry point — but the rewrite design needs no such assumption and stays the recommendation.

### 2.11 The two additive route costs this design makes free

Under the current one-file-per-URL layout, **every new route costs a function**. Under this
layout, a new route inside `/api/portal` or `/api/admin` costs **zero**: it is one line in
`site/shared/portal-routes.json` plus a handler module.

Two routes are already queued and would otherwise have cost 2 of the 5 remaining slots:

- `GET /api/portal/session` — the owner-role endpoint of §4 (1 function today, **0** after);
- `GET /api/portal/notes` — the client-notes store that `/admin` reports as
  `notesAvailable: false` (`api/admin/reviews.ts:227-233`) (1 function today, **0** after).

Budget after both: **7 functions**, 5 slots still free.

---

## 3. (B) The libSQL / Turso store (task T4)

### 3.1 The transport — decision and reasons

**Decision, and this is what shipped (2026-10-21): the libSQL HTTP v2 pipeline API over
`global fetch`. Zero new dependencies.**
Implementation: `site/shared/portal-store/libsql-transport.ts` — `POST {base}/v2/pipeline`
(`:178`), `Authorization: Bearer {token}` (`:218`), the `results[]` error trap handled
(`:249-257`), the token never echoed (`:37-38`).

Protocol (cited):
`POST {LIBSQL_URL}/v2/pipeline`, `Authorization: Bearer {LIBSQL_TOKEN}`,
`Content-Type: application/json` — <https://docs.turso.tech/sdk/http/reference> and the
specification <https://github.com/tursodatabase/libsql/blob/main/docs/HTTP_V2_SPEC.md>.

```jsonc
// request
{ "requests": [
    { "type": "execute", "stmt": { "sql": "SELECT … WHERE id = ?",
                                   "args": [ { "type": "text", "value": "prj_1" } ] } },
    { "type": "close" }
] }
// response
{ "baton": null, "base_url": null,
  "results": [ { "type": "ok", "response": { "type": "execute",
                        "result": { "cols": [ … ], "rows": [ … ],
                                    "affected_row_count": 0, "last_insert_rowid": null } } } ] }
```

A failed statement comes back as `{"type":"error","error":{"message":…,"code":…}}` inside
`results[]` — the HTTP status can still be 200, so **the adapter must inspect `results[]`, not only
the status code**. That is a real trap and the mock server in §3.6 must reproduce it.

**Why not `@libsql/client`:**

1. **It would not even be installed.** `vercel.json` declares `"installCommand": "cd site && npm ci"`.
   The root `package.json` has **no `dependencies` block** at all. A root-level dependency is
   therefore never installed on Vercel, and `site/node_modules` is not on the module-resolution
   path of a file in `api/` (Node walks *up* from `api/…`, never sideways into `site/`). Using
   `@libsql/client` would require: a root `dependencies` entry **+** a root lockfile **+** an
   `installCommand` change to `npm ci && cd site && npm ci`. That is three deploy-config changes
   to save writing a JSON body.
2. **The HTTP API is a first-class Turso interface**, not a fallback: "You can use the `/v2/pipeline`
   endpoint to query a database" — <https://docs.turso.tech/sdk/http/reference>.
3. **It runs on both runtimes with no build step.** `global fetch` exists in Node ≥ 18 (the repo
   requires `node >= 20.3.0` — `package.json`) and in workerd. The adapter is therefore *the same
   file* in the Vercel tree and the CF tree, exactly like `site/shared/server/portal-session.ts`.
4. **It is testable offline** (§3.6) because it is just HTTP.

**The one thing the HTTP API gives up** relative to the native client: no WebSocket/embedded
replica, and no local file. Neither is needed — the portal is a handful of clients, and the whole
point of T4 is to stop writing to a read-only filesystem.

### 3.2 The DDL — AS BUILT (2026-10-21)

**Status: implemented, and the draft above this line was overruled in the Backend's favour.**
The DDL that ships is the one in `site/shared/portal-store/libsql-schema.ts:37-122`
(`SCHEMA_STATEMENTS`, applied by `ensureSchema()` at `:131-140`). It is reproduced verbatim below
so the spec and the code cannot drift.

Nine tables: the eight `Collection` names in `site/shared/portal-store/types.ts:25-33` plus the
rate counter. **Every record is stored whole in a `data` JSON column**, so the round trip is exact
(`JSON.parse` → `JSON.stringify` preserves key order for non-numeric keys, which every record in
this repo has). Typed columns are *derived* from the same record at write time, so they cannot
drift, and they exist only to make the hot lookups indexable.

```sql
-- The sequence column reproduces "the order of the lines in the JSONL file".
-- ORDER BY seq IS the file order, which is what the contract test asserts.
-- Every statement is IF NOT EXISTS: the DDL is idempotent and is applied
-- once per store instance, in ONE pipeline round trip
-- (libsql-schema.ts:131-140).

CREATE TABLE IF NOT EXISTS portal_projects (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  id         TEXT,
  client_id  TEXT,
  status     TEXT,
  data       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS portal_projects_id     ON portal_projects(id);
CREATE INDEX IF NOT EXISTS portal_projects_client ON portal_projects(client_id);

CREATE TABLE IF NOT EXISTS portal_clients (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  id         TEXT,
  email      TEXT,
  data       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS portal_clients_id    ON portal_clients(id);
CREATE INDEX IF NOT EXISTS portal_clients_email ON portal_clients(email);

CREATE TABLE IF NOT EXISTS portal_invites (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  email      TEXT,
  client_id  TEXT,
  data       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS portal_invites_email  ON portal_invites(email);
CREATE INDEX IF NOT EXISTS portal_invites_client ON portal_invites(client_id);

CREATE TABLE IF NOT EXISTS portal_comments (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  id         TEXT,
  project_id TEXT,
  data       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS portal_comments_id      ON portal_comments(id);
CREATE INDEX IF NOT EXISTS portal_comments_project ON portal_comments(project_id);

CREATE TABLE IF NOT EXISTS portal_plan_items (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  id         TEXT,
  project_id TEXT,
  data       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS portal_plan_items_id      ON portal_plan_items(id);
CREATE INDEX IF NOT EXISTS portal_plan_items_project ON portal_plan_items(project_id);

CREATE TABLE IF NOT EXISTS portal_updates (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  id         TEXT,
  project_id TEXT,
  data       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS portal_updates_id      ON portal_updates(id);
CREATE INDEX IF NOT EXISTS portal_updates_project ON portal_updates(project_id);

-- The moderation revision log. `seq` is the append order (the file order),
-- `revision` is the client's revision counter (api/portal/testimonials.ts).
CREATE TABLE IF NOT EXISTS moderation_reviews (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  ref        TEXT,
  revision   INTEGER,
  type       TEXT,
  state      TEXT,
  project_id TEXT,
  data       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS moderation_reviews_ref    ON moderation_reviews(ref, seq DESC);
CREATE INDEX IF NOT EXISTS moderation_reviews_state  ON moderation_reviews(state, seq DESC);
CREATE INDEX IF NOT EXISTS moderation_reviews_project ON moderation_reviews(project_id);

CREATE TABLE IF NOT EXISTS portal_sessions (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  token      TEXT,
  expires_at INTEGER,
  data       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS portal_sessions_token ON portal_sessions(token);

-- The shared durable rate counter (section 3.8).
CREATE TABLE IF NOT EXISTS rate_counters (
  bucket    TEXT PRIMARY KEY,
  reset_at  INTEGER NOT NULL,
  count     INTEGER NOT NULL DEFAULT 0
);
```

Field names taken from the handlers: `projects` (`api/portal/projects.ts:302-310`),
`comments` (`api/portal/comments.ts:172-180`), `invites` (`api/portal/invites.ts:263-271`),
`planItems` (`api/portal/plan-items.ts:298-305`), `updates` (`api/portal/updates.ts:174-181`),
`clients` (`api/portal/auth.ts:487-494`), `reviews` (`api/portal/testimonials.ts:580-603`).

#### 3.2.1 The deviations from the draft above — and why they are right

The draft DDL (the one the design originally proposed) had `NOT NULL`, `UNIQUE` and `DEFAULT`s on
the typed columns. **The implementation has none of them, on purpose**, and the Architect
accepted the implementation as the contract. The rationale is in the code as well
(`site/shared/portal-store/libsql-schema.ts:14-29`):

| Draft | As built | Why the as-built wins |
|---|---|---|
| `id TEXT NOT NULL UNIQUE` | `id TEXT` | The file adapter's `append()` never rejects a record: two projects with the same id, or a record with no id at all, are both accepted and both readable (`site/shared/portal-store/file-adapter.ts`). A `UNIQUE` column would make the libSQL adapter **refuse writes the file adapter accepts** — the two adapters would stop being interchangeable, which is the entire point of the `PortalStore` interface. |
| `email TEXT NOT NULL` | `email TEXT` | Same reason: a record may legitimately carry no address. |
| `revision INTEGER NOT NULL DEFAULT 1` | `revision INTEGER` | A record with no `revision` must stay "no revision", because the file adapter compares `String()` values, not defaulted ones. |
| `type TEXT NOT NULL DEFAULT 'review'` | `type TEXT` | A `DEFAULT 'review'` would make the database treat a record with no type as a review, while the file adapter's search is exact (`file-adapter.ts`). |
| `state TEXT NOT NULL DEFAULT 'pending'` | `state TEXT` | **The dangerous one.** `decideReview()` treats a record whose state is not exactly `'pending'` as already decided (`site/shared/portal-store/file-adapter.ts:224`). A `DEFAULT 'pending'` would make the database **flip review records the file adapter leaves alone** — the database would approve things the file store never would. |
| `token TEXT NOT NULL UNIQUE` | `token TEXT` | Same interchangeability rule. |
| `CREATE INDEX` without `IF NOT EXISTS` | `CREATE INDEX IF NOT EXISTS` | The DDL is applied once per store instance; it must be idempotent or the second instance fails to start. |

**The rule behind all seven rows:** the two adapters must be **interchangeable**. A database
constraint that the file adapter does not enforce is a divergence, and the contract test (the same
22 assertions against both stores, §3.6) is what proves there is none.

#### 3.2.2 SQLite type fidelity — why the `Where` clause is a `CASE`

The draft §3.3 below proposes a plain `CAST(json_extract(data,'$.<field>') AS TEXT) = ?`. The
as-built predicate is a `CASE` over `json_type()` instead
(`site/shared/portal-store/libsql-adapter.ts:197-211`), because SQLite's type handling does not
match JavaScript's `String()`:

| Value in the record | `String(value)` (file adapter) | SQLite `json_extract` | A plain `CAST(... AS TEXT)` |
|---|---|---|---|
| `true` | `'true'` | `1` | `'1'` → **no match** |
| `false` | `'false'` | `0` | `'0'` → **no match** |
| `42` | `'42'` | `42` (integer) | `'42'` → match |
| `42.0` | `'42'` (JS `String(42)`) | `42.0` (real) | `'42.0'` → **no match** |
| `"42"` (string) | `'42'` | `'42'` | `'42'` → match |

The as-built predicate:

```sql
CASE json_type(data, ?)
  WHEN 'true'  THEN 'true'
  WHEN 'false' THEN 'false'
  WHEN 'real'  THEN CASE WHEN CAST(json_extract(data, ?) AS INTEGER) = json_extract(data, ?)
                          THEN CAST(CAST(json_extract(data, ?) AS INTEGER) AS TEXT)
                          ELSE CAST(json_extract(data, ?) AS TEXT) END
  ELSE CAST(json_extract(data, ?) AS TEXT)
END = ?
```

- a **missing** field → `json_type()` is NULL → the `CASE` falls through to `CAST(NULL AS TEXT)` →
  NULL → the row is excluded, exactly like the file adapter's `actual === undefined → no match`;
- a field that is present but **null** → `json_type()` is `'null'` → `CAST(NULL AS TEXT)` → excluded,
  like the file adapter's `actual === null → no match`;
- a **real** that is integral (`42.0`) → the inner `CASE` compares the integer cast with the raw
  value and yields `'42'`, matching `String(42)`.

The five extra assertions that pin this are in the shared contract
(`site/shared/portal-store/test/contract.shared.ts`): numbers, booleans, missing fields and patch
types. They run against **both** stores, so the two cannot drift.

### 3.3 `Where` → SQL

**The as-built predicate is in §3.2.2** — a `CASE` over `json_type()`, not the plain `CAST` this
section originally proposed. The reasoning is in §3.2.2 (SQLite turns `true` into `1` and `42.0`
into `'42.0'`, while the file adapter compares `String()`), and the implementation is
`site/shared/portal-store/libsql-adapter.ts:197-211`. The rule this section states is unchanged:

`Where` is equality-only (`types.ts:36`). The file adapter compares with
`String(actual) !== String(expected)` and treats a missing field as "no match"
(`file-adapter.ts:52-63`). The SQL must reproduce that **exactly**, including the number/string
coercion, because the contract test asserts it.

```sql
-- generic equality, faithful to the file adapter's String() comparison
-- (the DRAFT form; the as-built form is the CASE in §3.2.2)
CAST(json_extract(data, '$.<field>') AS TEXT) = ?      -- bound: String(expected)
```

- a missing field → `json_extract` returns NULL → `CAST(NULL AS TEXT) = 'x'` is NULL → the row is
  excluded — the same as the file adapter's `actual === undefined → return false`;
- a numeric field compared with a string → both sides become text → `'42' = '42'` → match — the
  same as the file adapter's `String(actual) !== String(expected)` fallback;
- `undefined` filter values are dropped before the SQL is built — the file adapter skips them
  (`file-adapter.ts:57`).

For the fields that carry an index, the adapter uses the typed column instead
(`projects.client_id`, `comments.project_id`, `reviews.ref`, `reviews.state`, `clients.email`,
`invites.email`). The typed column is written from the same record, so the two are equal by
construction; the adapter must not read a typed column for a field it did not write.

`get(coll, {field, value})` → the same predicate with `LIMIT 1` (the file adapter returns the
**first** match in file order — `file-adapter.ts:150` — so the SQL must `ORDER BY seq ASC`).

### 3.4 Atomicity of a write

The requirement: *a moderation decision must never be half-written.* The rule is **one statement
per logical operation**, so the database's own statement atomicity is the guarantee. No
multi-statement transaction is needed anywhere.

| `PortalStore` method | SQL | Atomic because |
|---|---|---|
| `append(coll, rec)` | `INSERT INTO <t> (…) VALUES (…)` | one statement |
| `update(coll, key, patch)` | `UPDATE <t> SET data = json_set(data,'$.k',json('…'), …) WHERE <pred>` — one statement per patched field, or one `json_patch` | one statement; `changes()` is the count the interface returns |
| `remove(coll, key)` | `DELETE FROM <t> WHERE <pred>` | one statement; `changes()` is the count |
| `latest('reviews', where)` | `SELECT data FROM moderation_reviews WHERE <pred> ORDER BY seq DESC LIMIT 1` | read-only; `seq DESC` is exactly the file adapter's "last matching line" (`file-adapter.ts:194-201`) |
| `decideReview(ref, decision, at, by)` | see below | one statement |

`decideReview` — the operation that must never be half-written:

```sql
UPDATE moderation_reviews
   SET state = ?1, decided_at = ?2, decided_by = ?3, data = json_set(data, …)
 WHERE seq = (SELECT seq FROM moderation_reviews
               WHERE ref = ?4 AND type = 'review' ORDER BY seq DESC LIMIT 1)
   AND state = 'pending'
RETURNING data;
```

- **0 rows returned** → either the ref is unknown or the newest revision is already decided. A
  second `SELECT … WHERE ref = ?4 AND type='review' ORDER BY seq DESC LIMIT 1` decides which:
  `null` → unknown ref (the file adapter's `null`, `file-adapter.ts:221`); a record → the
  already-decided record, returned unchanged (the idempotency the contract test asserts at
  `contract.test.ts:180-198`);
- **1 row returned** → the decision is applied and the old revision rows are untouched
  (`contract.test.ts:153-178`);
- the `AND state = 'pending'` clause is what makes "never flip an already-decided record, not even
  the other way" (`contract.test.ts:200-211`) a property of the statement, not of the code around it.

The file adapter's `update()`/`remove()` on `reviews` are *refused*
(`file-adapter.ts:159-166`, `:180-186`); the libSQL adapter must refuse them identically
(`StorageError` with code `invalid-operation`).

The `data` column and the typed columns must be updated together. `json_set` on `data` and the
typed columns in the same `UPDATE` keeps them consistent because both are derived from the same
patch.

### 3.5 `PORTAL_STORE=libsql` and the two environments — AS BUILT

`site/shared/portal-store/index.ts:29-47` and `edge.ts:21-41` already select the backend from
`env` and already threw `StorageError('not-implemented')` for `libsql`. **That throw is replaced by
the real adapter:**

```
index.ts (Node / Vercel)      getStore(env) -> env = process.env      (index.ts:35-52)
edge.ts  (workerd / CF)       getStore(env) -> env = the request's context.env (edge.ts:30-49)
```

The two entry points differ in one more thing, and the difference is deliberate:

| | `PORTAL_STORE` unset | `PORTAL_STORE=file` | `PORTAL_STORE=libsql` | anything else |
|---|---|---|---|---|
| `index.ts` (Vercel) | the **file** adapter (the local-dev default) | the file adapter | the libSQL adapter | `StorageError('invalid-config')` (`index.ts:48-51`) |
| `edge.ts` (Cloudflare) | the **libSQL** adapter — there is no writable disk on the edge | `StorageError('invalid-config')` — "the file adapter is not available on the edge runtime" (`edge.ts:33-38`) | the libSQL adapter | `StorageError('invalid-config')` (`edge.ts:45-48`) |

**The Vercel tree** reads `process.env.LIBSQL_URL` / `process.env.LIBSQL_TOKEN`.
**The Cloudflare tree** reads `LIBSQL_URL` / `LIBSQL_TOKEN` from the Pages function `env` (the
same object the notification module already types as `Env` —
`site/functions/api/lib/notifications.ts`, imported as `type { Env }` in
`site/functions/api/moderate/review.ts`).

Because `getStore(env)` already takes the environment as an argument in **both** trees, **one
adapter file serves both**:

```
site/shared/portal-store/libsql-adapter.ts   (no node: imports — Web APIs only)
site/shared/portal-store/libsql-transport.ts  (fetch → /v2/pipeline)
```

A missing `LIBSQL_URL` or `LIBSQL_TOKEN` in production must be a loud `StorageError`
(`invalid-config`) — never a silent fallback to the file adapter on the edge (there is no file
there) and never a token-less request to a database (Turso would answer 401 and the error would
read like a network problem). **As built** (`site/shared/portal-store/libsql-store.ts:34-56`): a
missing URL, a missing token, and a non-http(s) URL each raise
`StorageError('invalid-config')` with a message that names the missing variable. The token is
never echoed (`libsql-transport.ts:37-38`).

### 3.6 How the adapter is verified with no cloud database — AS BUILT

Three levels, each with a different claim. **Only level 3 proves real SQL semantics** — the
others prove the adapter's own logic and the wire format. **All three now exist.**

**Level 1 — the SQL contract (offline, no network).**
`createLibsqlStore({ transport })` takes an **injectable transport**
(`site/shared/portal-store/libsql-transport.ts`, the `LibsqlTransport` interface), and
`libsql-adapter.ts` is driven through it. A fake transport records the statements and returns
canned rows, so the test can assert the *exact* statement sequence for each `PortalStore` method.

**Level 2 — the wire format (offline, local HTTP server).**
A mock pipeline server (`site/shared/portal-store/test/mock-pipeline-server.ts`, `node:http`, port
chosen free at run time, **never 4321**) implements `POST /v2/pipeline`:

- asserts `Authorization: Bearer <token>` is present and correct;
- asserts the request body shape (`requests[]`, `type:'execute'`, `stmt.sql`, `stmt.args[]` with
  `{type,value}`);
- returns a **canned v2 response**, including the `{type:'error'}` result shape and the
  `results[].response.result.cols/rows` shape;
- never touches a database.

The adapter is driven through the **real `fetch`** against this server. This proves the HTTP
contract end to end — the part that the native client would have hidden.

**Level 3 — the real database (gated).**
The same contract suite runs against a real Turso database when `LIBSQL_URL` is set
(`npm run test:store:libsql`). This is the acceptance test and it needs the owner's database.
**It has never been run: no real Turso database exists yet.**

**What the implementation actually did, and it is better than the plan.** The contract test was
parameterised as planned — `site/shared/portal-store/test/contract.shared.ts` holds the contract
body and `site/shared/portal-store/test/contract.test.ts` runs it **twice** (`describeStoreContract('file', …)`
at `:55` and `describeStoreContract('libsql', …)` at `:84`). The libSQL half does not stop at the
mock: `site/shared/portal-store/test/sqlite-worker.py` runs the **real SQLite engine** (the
Python standard library's `sqlite3`) behind the mock's HTTP server, so the assertions execute
**real SQL semantics over the real wire protocol** — which is level-3-grade proof of the SQL with
no cloud database. The contract is now **60 tests** (22 assertions × 2 stores + the adapter's own
tests), all green.

**The `Where`-clause fidelity cases are part of the shared body**, not an add-on: numbers,
booleans, missing fields and patch types run against both stores, which is what forced the
`CASE`-over-`json_type()` predicate in §3.2.2.

### 3.7 The migration from the file store

The file store stays the **local development** adapter and the **rollback** path
(`index.ts:31-35`, `file-adapter.ts:5`). Cutover is one env var: `PORTAL_STORE=libsql`.

```
site/scripts/import-portal-store.mjs      (new)
  reads  site/data/portal/*.jsonl  +  site/data/moderation/reviews.jsonl
  writes one row per line, in file order (seq = line number)
  writes site/data/libsql-import-manifest.json  {collection, file, lines, sha256}
```

The importer must run against a **copy** of the data (`--from <dir>`), never against
`site/data/**` in place.

**As built** (`site/scripts/import-portal-store.mjs`): the script exists with exactly this shape —
`--from <dir>`, `--manifest <file>`, `--verify`, `--dry-run`, `--url`, `--token`; the source is
only ever **read** (`:21-23`), the manifest goes to `--manifest`, and the token is never logged
(`:24-25`). The `--verify` pass reads both sides back and compares them **record by record, in
order** (`:16-19`) — an import that silently reorders or drops records is worse than no import.
It has been exercised end to end against the mock pipeline server; **it has never run against a
real Turso database.**

**Verification (the part that matters):** a compare pass that reads both sides and asserts, per
collection, the same number of records and the same `JSON.stringify(record)` for every record, in
the same order. The order matters: `list()` must return the records oldest-first, exactly like the
file (`contract.test.ts:47-57`).

**The build-time dependency nobody has listed yet — and it is real.**
`site/scripts/publish-testimonials.mjs` runs as `prebuild` (`site/package.json`: `"prebuild":
"node scripts/publish-testimonials.mjs"`) and reads the moderation file to publish approved
quotes. After the cutover, the approved quotes live in the database, so **the build must be able to
read the store**. Two consequences:

1. the build needs `LIBSQL_URL` / `LIBSQL_TOKEN` and outbound network access at build time
   (Turso is reachable from a Vercel build; that is normal, but it must be configured);
2. **if the database is unreachable during a build, the build must FAIL LOUDLY.** A build that
   silently publishes an empty testimonials page is a silent outage wearing the costume of a
   successful deploy. The publisher must exit non-zero on a storage error, and it must fall back
   to the file store only when `PORTAL_STORE=file`.

### 3.8 The shared durable rate counter

Today's counter is a **file lock**: `api/lib/rate-limit.ts:203-252` (`createFileBackend`) reads a
JSON file, mutates it and writes it back under `withFileLock`. On Vercel that fails twice over —
the filesystem is read-only, and every function instance has its own copy. The Code Reviewer also
executed a case where 5 s of lock contention permanently abandons the durable counter for the life
of the process.

**The interface is one method** (`rate-limit.ts:41-48`):

```ts
export interface RateLimitBackend { hit(key: string, windowMs: number): Promise<number>; }
```

So the SQL backend is one statement, and the existing `RateLimiter` class
(`rate-limit.ts:262-327`) needs no change at all. **As built**
(`site/shared/portal-store/durable-rate-counter.ts:53-58`, the exported constant
`RATE_COUNTER_SQL`):

```sql
INSERT INTO rate_counters (bucket, reset_at, count)
VALUES (?, ?, 1)
ON CONFLICT(bucket) DO UPDATE SET
  count    = CASE WHEN rate_counters.reset_at <= ? THEN 1 ELSE rate_counters.count + 1 END,
  reset_at = CASE WHEN rate_counters.reset_at <= ? THEN ? + ? ELSE rate_counters.reset_at END
RETURNING count
```

with the six bound arguments in order (`durable-rate-counter.ts:86-93`): the **hashed** bucket, the
new `reset_at` (`now + windowMs`), then `now`, `now`, `now`, `windowMs`.

- `?1` = the **hashed** key — SHA-256 (`api/lib/rate-limit.ts:94` `hashKey()`, called at `:236`),
  exactly like the file backend's, so no e-mail address, client id or IP address is ever written
  to the database; the hash uses **WebCrypto**, so the edge twin can use the module too
  (`durable-rate-counter.ts:60-73`);
- the `CASE` reproduces the file backend's rolling window exactly: a hit after `reset_at` starts
  the count again at 1 and sets a new reset
  (`rate-limit.ts:238-240`);
- one row per bucket, so the table cannot grow without bound — the file backend's bucket cleanup
  (`rate-limit.ts:242-245`) is unnecessary;
- **one atomic statement → no lost updates across instances, and no lock, and no file.**
  Executed proof: eight concurrent writers on one bucket return `1…8` and the sum is 36 — no lost
  update.

The `degraded` flag (`rate-limit.ts:50-60`) keeps its meaning: if the statement fails, the
limiter falls back to the in-memory backend and reports `degraded: true` — exactly as it does for
the file backend today. The difference is that with libSQL there is no *permanent* abandonment:
the next request tries the database again.

**Status: the backend exists, the wiring does not.** `api/lib/rate-limit.ts` still selects the
file backend, so the durable counter is **not** on SQL yet — it is on the next-wave list
([`proposal-wave8-contract-2026-10-21.md`](proposal-wave8-contract-2026-10-21.md) §7, row 8).

### 3.9 The as-built file map (2026-10-21) — and what is still NOT built

**Built** (`site/shared/portal-store/`, all new unless stated):

| File | What it is |
|---|---|
| `libsql-transport.ts` | the v2 pipeline transport over `global fetch`; the `{"type":"error"}`-inside-`results[]` trap is handled (`:249-257`); the token is never echoed (`:37-38`) |
| `libsql-schema.ts` | the DDL of §3.2 as built (`:37-122`) and `ensureSchema()` (`:131-140`) |
| `libsql-adapter.ts` | the `PortalStore` implementation; the `CASE`-over-`json_type()` predicate (`:197-211`) |
| `libsql-store.ts` | `env` → store; fails closed on a missing/invalid URL or token (`:34-56`) |
| `libsql-entry.ts` | the edge-safe entry point for the CF tree |
| `durable-rate-counter.ts` | the shared durable rate counter (§3.8) |
| `test/contract.shared.ts` | the contract body, run against **both** stores |
| `test/mock-pipeline-server.ts` | the v2 pipeline mock server |
| `test/sqlite-worker.py` | the **real SQLite engine** behind the mock — this is what makes the offline proof execution-grade |
| `test/contract.test.ts` | the runner (edited) — the file adapter, the libSQL adapter, and the adapter's own tests |
| `index.ts`, `edge.ts` | the two entry points (edited) — `PORTAL_STORE` selection per §3.5 |
| `site/scripts/import-portal-store.mjs` | the importer (§3.7) |

**NOT built** — and the spec must not read as if it were:

1. **No handler uses the adapter.** `api/portal/*.ts` still read and write JSONL through
   `api/lib/jsonl.ts`. The store exists; nothing calls it.
2. **The rate limiter is not on the SQL backend.** `api/lib/rate-limit.ts` still selects the file
   backend.
3. **The build-time publisher still reads the file store** (`site/scripts/publish-testimonials.mjs`,
   the `prebuild` step) and **must** be changed to read the database and fail loudly when the
   database is unreachable.
4. **The moderation store is still a JSONL file** (`api/moderate/review.ts:114-143`), not the
   `moderation_reviews` table.
5. **No real Turso database has ever been contacted.** The proof is a real SQLite engine over the
   real wire protocol — that is execution-grade evidence of the SQL, and documentation-grade
   evidence of Turso's service.

The full list, with the file that proves each item, is in
[`proposal-wave8-contract-2026-10-21.md`](proposal-wave8-contract-2026-10-21.md) §7.

---

### 3.10 What section B does not need from the owner

- The **Turso-vs-Neon** decision does not block the code: the adapter speaks the libSQL HTTP
  protocol, and the `PortalStore` interface keeps a Postgres adapter possible later. The
  `PortalStore` interface is the seam, and it already exists.
- The owner is needed only for the **two values** `LIBSQL_URL` and `LIBSQL_TOKEN` (and, for level-3
  testing, the database itself). A Turso database is one `turso db create` away and the token is
  one `turso db tokens create` away.
- **The adapter needs no new dependency and no deploy-config change** — the transport is
  `global fetch`, so the root `package.json` stays dependency-free and `vercel.json`'s
  `installCommand` needs no root install (the DevOps change of 2026-10-21 to
  `npm install --no-audit --no-fund && cd site && npm ci` is compatible with it either way).

---

## 4. (C) The owner role in the portal

### 4.1 The defect, stated precisely

`site/src/pages/portal.astro:120`:

```ts
let role: Role = (sessionStorage.getItem('imk_portal_role') as Role | null) ?? 'client';
```

The role that decides whether the owner sees the owner UI lives in **`sessionStorage`** — per tab,
per browser, cleared by the user, and never written by the server. A new tab shows the client view
while the cookie says `admin`. The API still refuses the owner's actions with 403 (the server is
correct), so the UI and the API disagree.

**There is no endpoint that tells the browser who it is.** `api/admin/session.ts` is the closest
thing, but it is admin-only: a client gets `401 {code:'unauthorized'}`
(`api/admin/session.ts:133-140`), which cannot be used to answer "which role am I".

### 4.2 The decision

**One server-truth endpoint: `GET /api/portal/session`.**

It costs **0 additional functions** under §2's layout (§2.11) — it is one line in
`site/shared/portal-routes.json`.

**Contract:**

| Case | Answer |
|---|---|
| No valid session cookie | `401 {error:'authentication required', code:'unauthorized'}` |
| A valid **client** session | `200 {ok:true, role:'client', email, clientId?, expiresAt}` |
| A valid **admin** session whose email is **on** `ADMIN_EMAILS` | `200 {ok:true, role:'admin', email, expiresAt}` |
| A valid **admin** session whose email is **no longer** on `ADMIN_EMAILS` | `200 {ok:true, role:'client', email, clientId?}` — **downgraded**, because the token is still a valid client session and the owner powers must be gone |
| `ADMIN_EMAILS` unset or empty | `500 {error:'misconfigured', code:'internal'}` — the same failure the admin endpoints report (`api/admin/session.ts:121-131`) |

`expiresAt` is the `x` field of the signed payload (`site/shared/server/portal-session.ts:99-104`),
so the UI can warn before the token dies.

**The role is computed on the server from two facts, in this order:**

1. the **role claim** in the signed token (`payload.r`, validated in `parseSession`,
   `portal-session.ts:499-507`);
2. the **live allow-list** — `isAdminEmail(email, env)`
   (`api/admin/session.ts:51-58`, which already lower-cases, trims and drops empty entries).

```
role = (claim.role === 'admin' && isAdminEmail(claim.email, env)) ? 'admin' : 'client'
```

**The same helper must be used by every owner-only action**, not just by the new endpoint. This is
the fix for the audit finding that *removing an address from `ADMIN_EMAILS` does not revoke the
owner's portal powers for up to 24 h*: the owner-only branches today check only
`session.role !== 'admin'` (`api/portal/projects.ts:167-170`, and the same shape in
`api/portal/plan-items.ts`, `api/portal/invites.ts`, `api/portal/testimonials.ts`).

**Recommendation:** reuse `resolveAdmin()` from `api/admin/session.ts:78-95` (it is exactly the
two-part gate) — and move it into `site/shared/portal-handlers/admin-session.ts` (§2.1) so both
trees can use it. The rule becomes: **an owner-only action requires `role === 'admin'` **and** the
email is on the live allow-list**; the answer for everyone else stays `403 {code:'forbidden'}`
(the server already answers 403, and 401 vs 403 must not change — the client uses 403 to mean
"you are not the owner", `site/src/pages/portal.astro:236`).

### 4.3 The read-scope rule (the second half of the audit finding)

The Code Reviewer executed this: **a live admin cookie widens a client's read scope to every
client** (2 of 2 projects returned to a client who owns 1). The cause is in
`site/shared/server/portal-session.ts:522-539`:

```ts
const order: Role[] = preferRole ? [preferRole, …] : ['admin', 'client'];
```

`resolveSession(req, undefined)` prefers the **admin** cookie, and
`api/portal/projects.ts:122` calls it that way for GETs. So a browser that holds both cookies
reads as the owner.

**Decision — the read path resolves the client cookie first:**

| Cookie present | Read scope |
|---|---|
| `imk_session` resolves | that client, only (`projectAccessible`, `api/portal/projects.ts:131-133`) — **even if an admin cookie is also present** |
| no client cookie, `imk_admin_session` resolves **and** the email is on the live allow-list | the owner: every project |
| neither | `401 {code:'unauthorized'}` |

This keeps the audit m5 property in place (a *stale* admin cookie cannot shadow a valid client
cookie, `portal-session.ts:510-512`) and adds the missing one: a *live* admin cookie cannot widen
a client's read scope either. The owner signs in with the admin cookie and sees everything; the
owner's own client view (if the owner also has a client record) is deliberately the narrow one.

**Consequence to state plainly:** if the owner is also a client of the consultancy, the portal
shows them their own project, and the owner view is the `/admin` inbox plus the owner's
project-management actions. That is the intended split, and it is what
`spec/07-reviews-portal-design.md §7.3` asks for ("separate from `/portal`").

### 4.4 What the UI does (Frontend's wave-7b task)

1. **On load**, call `GET /api/portal/session` with `credentials:'include'`. The response is the
   **only** source of truth for the role.
2. `sessionStorage` becomes a **cache hint, never an input**: it may be used to paint the owner UI
   one frame earlier, but it is overwritten by the server's answer as soon as it arrives, and it is
   never used to decide whether to *send* an owner-only request. A stale `imk_portal_role` in
   `sessionStorage` must never survive the server's answer — today it is read once at
   `portal.astro:120` and trusted for the rest of the session.
3. **On `401`** → the sign-in screen. **On `403`** → the owner UI is hidden and the role is
   re-read from the server (the allow-list may have changed under the session).
4. The owner-only controls (`portal-admin-controls`, `admin-status-card`, the invite form — all
   hidden behind `role === 'admin'` today, `portal.astro:284-286`) are shown only when the server
   said `admin` **and** the last owner-only action did not answer 403.
5. The role is also re-read after the magic-link sign-in (`site/src/pages/login.astro` → the
   portal) — today `sessionStorage` is cleared on logout (`portal.astro:676-677`), which is the
   only place the hint is trusted.

### 4.5 What section C does not do

- It does not change the cookie names, the 24 h TTL, the cookie flags, or the session module
  (`site/shared/server/portal-session.ts`) — the signed token is already correct and
  cross-instance safe.
- It does not change any client→client data access: a client still sees only its own projects.
- It does not add a role field to any existing response body (that would change a contract the QA
  suites assert on); it adds **one new endpoint** whose answer is additive.

---

## 5. Risks, and what stays unverified

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| R1 | The rewrite carrier (`__imk_route`) is not delivered, or the original query is dropped | **high for the deploy, none for the product** | the two query-bearing URLs are not rewritten (§2.2); the resolver fails closed with `500 route-resolution` (§2.6); the contingency is a `routes` + header transform (§2.7). **Settle it with one preview deploy before step 4.** |
| R2 | The dev server and the deployed router disagree | high (the F-1 class) | one route table, three consumers (§2.4); `check:routes` is extended to read it |
| R3 | The QA suites break on the file moves | medium | the full re-pin list is in §2.8 — 25 path swaps, no new harnesses; the route-table checks in `qa-wave3` and `qa-backend-hardening` are rewritten, not deleted |
| R4 | The libSQL adapter drifts from the file adapter's semantics | high | the same 22 contract assertions run against both (§3.6); the `Where` mapping reproduces the file adapter's `String()` comparison exactly (§3.3) |
| R5 | The Turso HTTP API returns HTTP 200 with an error inside `results[]` | medium | the adapter inspects `results[]`; the mock server (§3.6 level 2) reproduces the shape |
| R6 | The build cannot reach the database, and publishes an empty testimonials page | **high (silent)** | the publisher must exit non-zero on a storage error (§3.7) |
| R7 | The switchover (step 4) breaks a URL | medium | one atomic commit; the old files come back with the revert; the §2.7 preview test runs against the *new* routing first |
| R8 | The owner role fix changes a 401/403 that a client depends on | low | the owner-only branches keep answering 403; the new endpoint is additive |

**Explicitly unverified in this document:**

- **The Vercel router was never booted** (no token, no deploy — forbidden by the assignment). Every
  statement about Vercel's behaviour is read from Vercel's documentation, not measured.
- **workerd was never booted.** The CF-tree statements are read from the code.
- **No Turso database exists yet**, so no SQL in §3.2/§3.3/§3.4 has been executed. The only
  executed evidence in this document is the `check:routes` output in §1.3 and the file inventory in
  §1.2 (both produced by me, today, from the tree).
- The **catch-all alternative** (§2.10) is not recommended precisely because it is unverified for a
  frameworkless `api/` directory — Vercel's own community answer says the catch-all behaviour is a
  Next.js feature, while the repo's QA bans catch-alls anyway.
- The **Cloudflare tree's function count** is irrelevant (not capped) and was not measured.

---

## 6. What this needs from the owner, and what it does not

**Does not need the owner (all of §2, §3, §4 can be built now):**

- the function-budget refactor — including the route table, the resolver, the entry points, the
  `check:routes` extension, the dev-server alignment and the QA re-pins;
- the libSQL adapter, the DDL, the durable rate counter, the importer, the compare pass and the
  three-level offline verification;
- the owner-role endpoint and the UI change;
- the Code Reviewer's HIGH pair (H-1 placeholder secrets, H-2 `APP_ENV=development`) and the
  MEDIUMs that are owner-free (the plain-GET moderation flip, the non-atomic moderation write, the
  unbounded session-token expiry) — those are the Backend's wave-7b queue, not this document's.

**Needs the owner, and only these:**

1. **`LIBSQL_URL` and `LIBSQL_TOKEN`** — the *values*. The adapter, the DDL, the importer and the
   offline tests do not need the database; only the level-3 acceptance test does. (The Turso-vs-Neon
   *call* is no longer on the critical path: the `PortalStore` interface keeps Postgres possible,
   and libSQL is what exists today.)
2. **One Vercel preview deploy** — to settle R1 (§2.7). This is the single item in this document
   that a design cannot remove: the rewrite mechanism's behaviour is documented but unobserved, and
   the one route family that would suffer from being wrong (the query-bearing URLs) is
   deliberately excluded from the mechanism.
3. **The Vercel plan** (Hobby vs Pro) — it decides whether §2 is *required* or merely *desirable*.
   The design does the work either way.
4. Everything already on the owner's list and not touched here: the production secrets, the Resend
   sender identity, the real Calendly link, the consent wording, and the research Q1
   (public `/clients/<slug>` vs portal-only).

---

*Nothing in this document was applied to the tree. The only file this wave adds is this document.*
