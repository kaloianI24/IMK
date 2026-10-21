# Wave 8 contract — the server-truth role, the moderation POST, the production secret rule

**Architect — 2026-10-21.** Owner-free. Design only: no application file was changed to
produce this document.

This is the source of truth for the wave-8 contracts (a)–(e) that the Manager asked for on
2026-10-21, and it is also the **as-built record**: every claim below cites the file that proves
it, read from disk on 2026-10-21 at 23:5x (local time), **not** taken from a bot's report.

Wave-7 §3 (the store) is reconciled here too — the as-built DDL is in
[`proposal-wave7-design-2026-10-21.md`](proposal-wave7-design-2026-10-21.md) §3.2 as amended.

---

## 0. The wave-8 state in one table

| Contract | Built? | Where | The gap that is left |
|---|---|---|---|
| **A** — the owner role comes from the server | **Yes, Vercel only** | `api/portal/session.ts:94-147` | the Cloudflare twin does not serve the route (`site/functions/api/portal/session.ts` is a re-export with no handler); the local dev server does not route it (`site/scripts/dev-portal.js:85-101`) |
| **B** — a GET on the moderation link never decides | **Yes, both trees** | `api/moderate/review.ts:346-362`, `site/functions/api/moderate/review.ts:300-313` | — |
| **C** — the two-part owner gate in the portal | **Helpers only** | `site/shared/server/portal-session.ts:691-695`, `:707-718` | the portal handlers still gate on the token claim alone (`api/portal/projects.ts:167`, `api/portal/invites.ts:188`) |
| **D** — an admin cookie never widens a client's read scope | **NOT built** | — | the client-facing read endpoints still prefer the admin cookie (`api/portal/projects.ts:122`, `api/portal/comments.ts:82`, `api/portal/plan-items.ts:85`, `api/portal/updates.ts:82`) |
| **E** — a missing/placeholder/short secret fails loudly in production | **Yes** | `site/shared/server/secret.ts`, `site/shared/server/portal-session.ts:348-357` | — |
| **H-1/H-2** from the wave-6 audit | **Yes** | `site/shared/server/secret.ts:34-66` | — |
| **M-3** (token expiry bound) | **Yes** | `site/shared/server/portal-session.ts:593` | — |

Three of the seven rows still have a gap — **A** (the CF twin and the local dev route), **C** (the
helpers exist, the portal handlers do not use them) and **D** (not built at all). **All three are
owner-free** and they are the top of the next Backend wave (§11).

---

## 1. Contract A — `GET /api/portal/session`, the server truth for the role

### 1.1 The request and the answer

**Request:** `GET /api/portal/session`, no body, no query. The session is read from the two
cookies `imk_session` (client) and `imk_admin_session` (owner) — names in
`site/shared/server/portal-session.ts:124-125`.

**200 — authenticated.** `api/portal/session.ts:128-139`:

```jsonc
{
  "ok": true,
  "role": "admin" | "client",   // the effective role, right now
  "email": "…",                  // the requester's own address
  "clientId": "cli_…",           // present only for a client session
  "expiresAt": 1763680000000     // epoch ms; present when the token carries it
}
```

**401 — not authenticated.** `api/portal/session.ts:122-126`:
`{ "error": "authentication required", "code": "unauthorized" }`.

**500 — the owner allow-list is not configured.** `api/portal/session.ts:110-120`:
`{ "error": "misconfigured", "code": "internal" }`. An unset `ADMIN_EMAILS` is a **misconfiguration**,
not "nobody is the owner" — the two are told apart by the status code, exactly as
`/api/admin/session` does.

**405 — wrong method.** `api/portal/session.ts:103-106`, `Allow: GET`.

**404 — wrong path.** `api/portal/session.ts:98-101`, `{ "code": "not-found" }`.

Every answer carries `Cache-Control: no-store` (`api/portal/session.ts:88`).

### 1.2 The role is computed from TWO facts, not one

`api/portal/session.ts:63-76`:

1. the **role claim** inside the signed token, and
2. the **live `ADMIN_EMAILS` allow-list**, re-read on every request
   (`site/shared/server/portal-session.ts:645-663`).

An owner whose address was taken off the list is answered `client` — the owner powers are gone
at once, not after the 24 h token expires. This is the same rule `/api/admin/session` already
used (`api/admin/session.ts:78-88`), and the shared helper is
`effectiveRole()` (`site/shared/server/portal-session.ts:691-695`).

**The endpoint never exposes another client's data.** It reports the requester's own role only;
`clientId` is the requester's own (`api/portal/session.ts:135`).

### 1.3 What the UI keys off — and what it must never key off

The browser keys off **the server's `role` field and nothing else**. The Frontend already does
this: `site/src/pages/portal.astro:245-256` fetches the endpoint, treats any non-2xx as
`unknown`, and reads `data.role`; anything that is not exactly `admin` renders the client view
(`site/src/pages/portal.astro:252-256`, `:276-292`).

| Never allowed | Why |
|---|---|
| `sessionStorage` as the source of truth | a new tab has empty storage while the cookie says `admin` — the screen would lie and the API would answer 403 |
| inventing a role when the endpoint is missing | a 404/405/500/501/network error must degrade to the **client** view (`site/src/pages/portal.astro:251`) |
| treating a 403 from an owner-only action as "still the owner" | the UI re-reads the role and hides the owner tools (`site/src/pages/portal.astro:307-318`) |

`sessionStorage` is allowed as a **write-through cache hint** only
(`site/src/pages/portal.astro:282`): it is written from the server's answer and is never read as
authority.

### 1.4 The gap: the Cloudflare twin does not serve the route

`site/functions/api/portal/session.ts` is 23 lines and contains exactly one statement:

```ts
export * from '../../../shared/server/portal-session.js';
```

It has **no `onRequestGet`, no `onRequest`, no default export** — so the Cloudflare tree does not
serve `GET /api/portal/session` at all. `npm run check:routes` reports the route as present
(`site/scripts/check-api-routes.mjs` checks that a **file** exists in both trees), so the route
check cannot see this: **the check is file-existence, not handler-existence.** That is the gap
the interrupted Backend run died on.

**The contract for the twin:** the same status codes and the same body, computed by the same
shared module, with the Worker's `env` passed in place of `process.env`
(`site/shared/server/portal-session.ts:612-629` accepts `env` as its third argument). The Vercel
tree calls `resolveSession(source, role, process.env)` (`api/portal/session.ts:64-71`); the twin
must call `resolveSession(request.headers, role, env)` — the same shape the other edge handlers
already use (`site/functions/api/portal/comments.ts:55`).

### 1.5 The gap: the local dev server does not route it either

`site/scripts/dev-portal.js:85-101` lists the routes the local server serves, and
`/api/portal/session` is **not** among them; `site/scripts/api-index.ts:18-33` does not export
the handler either. So in local dev the endpoint answers the static 404.

That matters because the Frontend proved its work against a **local fixture** instead of the real
endpoint (`frontend-owner-role-2026-10-21.md`: "`api/portal/session.ts` still has no default
export and the dev server has no route for it"). That was true when it was written; the handler
now has a default export (`api/portal/session.ts:142-147`), but the dev route is still missing,
so the fixture is still what the browser sees.

**The fix is two lines in two files** (`site/scripts/api-index.ts` + `site/scripts/dev-portal.js`),
owned by whoever owns `site/scripts/**`.

---

## 2. Contract B — the moderation link: a GET shows, a POST decides

### 2.1 The rule

**A plain `GET` on the signed moderation link must never change the state of a quote.**

The reason is mechanical: a signed GET URL is fetched **automatically** by everything that
touches mail — corporate link scanners, chat-preview bots, antivirus gateways. Before wave 8,
one such prefetch flipped the quote to `approved` and published it. The HMAC protected the link
against forgery; it never protected it against a legitimate prefetch of a legitimate link.

### 2.2 The built contract

| Method | Answer | Where |
|---|---|---|
| `GET /api/moderate/review?ref&decision&revision&ts&sig` | **200 HTML** — a confirmation page with one button. **No state change.** | `api/moderate/review.ts:346-362`; the page itself is `site/shared/server/moderation.ts:160-229` |
| `POST /api/moderate/review` (the same signed params, in the query **or** in the body) | **200 JSON** `{ ok: true, ref, state }` — the decision is applied | `api/moderate/review.ts:370-403` |
| any other method | 405 `{ "code": "method" }`, `Allow: GET, POST` | `api/moderate/review.ts:221-224` |

The Cloudflare twin is in parity: `site/functions/api/moderate/review.ts:344-347` exports
`onRequestGet` (commit page, no write) and `onRequestPost` (the decision), and
`site/functions/api/moderate/review.ts:300-313` is the same `if (!commit)` branch.

**The confirmation form posts to the same path** with the signed parameters as hidden fields
(`site/shared/server/moderation.ts:183-190`) — no JavaScript, no auto-submit. A scanner that only
fetches the URL stops at the page. A scanner that parses forms still has to press a button.

**The signature is verified before the page is served** (`api/moderate/review.ts:254-257`), so a
forged or expired link is a `400 { "code": "signature" }` / `400 { "code": "expired" }` on a GET as
well — the page is never shown for a link that cannot be trusted.

**The POST has no `Origin` check, and that is deliberate:** the signature *is* the CSRF defence
here. A third-party page cannot produce a valid `sig` for `ref|decision|revision|ts`, so a
cross-site POST is rejected by the signature check before any state is touched.

### 2.3 The replay model

| Property | Value | Where |
|---|---|---|
| TTL | 7 days | `site/shared/server/moderation.ts:33` |
| Clock skew | a link dated more than 60 s in the future is refused | `site/shared/server/moderation.ts:36`, `:127-132` |
| Revision guard | a link for an old revision of a changed quote is refused with `409 { "code": "stale-revision" }`, and a **fresh** link is mailed for the current revision | `api/moderate/review.ts:296-339` |
| Idempotency | a decided record is never flipped again; the answer is `200 { ok: true, state }` with the existing decision | `api/moderate/review.ts:364-368` |
| Scanner | a GET **cannot** decide a quote — that is the whole point of §2.1 | `api/moderate/review.ts:346-362` |
| Later lines win | the newest line for a `ref` is the record that is decided | `api/moderate/review.ts:284-287` |

The moderation store is written **atomically** (temp file + rename) — `api/moderate/review.ts:132-143`,
`site/functions/api/moderate/review.ts:127-139`. A write that fails answers
`500 { "code": "storage" }`, never "approved" (`api/moderate/review.ts:378-382`).

---

## 3. Contract C — the two-part owner gate, in the portal too

### 3.1 The rule

**Owner access requires BOTH the token's role claim AND the live `ADMIN_EMAILS` allow-list.**
One of the two is not enough.

`/admin` already did this (`api/admin/session.ts:51-58`, called at `:86`). The portal did not: its owner branches
gate on `session.role === 'admin'` alone, and the role is baked into the token at sign-in time
(`api/portal/auth.ts:445`) — so removing an address from `ADMIN_EMAILS` revoked the owner's
`/admin` powers immediately but left the portal's owner powers alive for up to 24 h. The two
halves of the owner story disagreed.

The shared helpers exist (`site/shared/server/portal-session.ts:691-695` `effectiveRole`,
`:707-718` `resolveOwnerSession`) — **but the portal handlers do not call them yet:**

| Owner branch | Current gate | Should be |
|---|---|---|
| `api/portal/projects.ts:167` (PATCH project) | `session.role !== 'admin'` → 403 | `resolveOwnerSession(req, env)` → 403 |
| `api/portal/projects.ts:258` (POST project) | `session.role !== 'admin'` → 403 | idem |
| `api/portal/invites.ts:188` | `resolveSession(req, 'admin')` → role check | `resolveOwnerSession(req, env)` |
| `api/portal/plan-items.ts:248` (owner branches) | `session.role !== 'admin'` | idem |
| the CF twins of all of the above | same | idem |

**This is open.** It is owner-free work and it is the single highest-value item left in the
portal backend.

### 3.2 Why it is not a cosmetic change

`site/.env.example` promises the opposite of the current behaviour: *"The list is read on EVERY
admin request, so removing an address here revokes access immediately - not when the 24h session
token expires."* For `/admin` that is true. For the portal it is false for up to 24 h. The spec
must not promise what the code does not do.

---

## 4. Contract D — the client cookie is resolved first

### 4.1 The rule

**A live admin cookie in the browser must never widen a client's read scope.**

`resolveSession()` with no `preferRole` returns the **admin** cookie first
(`site/shared/server/portal-session.ts:618-627`: the order is `['admin','client']`). The
client-facing read endpoints call it exactly that way:

| Call site | Today | Should be |
|---|---|---|
| `api/portal/projects.ts:122` | `resolveSession(req, method === 'GET' ? undefined : 'admin')` → **admin first on GET** | `resolveSession(req, 'client')` for the client-scoped reads, with the owner check of §3 for the owner reads |
| `api/portal/comments.ts:82` | `resolveSession(req)` | `resolveSession(req, 'client')` |
| `api/portal/plan-items.ts:85` | `resolveSession(req)` | `resolveSession(req, 'client')` |
| `api/portal/updates.ts:82` | `resolveSession(req)` | `resolveSession(req, 'client')` |
| `site/functions/api/portal/projects.ts:62,96,112`, `comments.ts:55`, `plan-items.ts:58`, `updates.ts:55` | `resolveSession(request.headers, undefined, env)` | `resolveSession(request.headers, 'client', env)` |

**This is open.** The audit reproduced it: a request with a valid client cookie **and** a valid
admin cookie returned **2 of 2** projects, including another client's
(`review-wave6-audit-2026-10-21.md:196`).

The stale-cookie half of the same finding **is** fixed and must not be broken: a cookie that does
not resolve is skipped, so a stale admin cookie cannot shadow a valid client cookie
(`site/shared/server/portal-session.ts:621-626`).

**The rule that reconciles §3 and §4** (this is the one sentence to implement):

> For a **client-scoped** read, resolve the **client** cookie first; an admin session is accepted
> only where owner access is intended, and there it must pass the allow-list-backed owner check.

---

## 5. Contract E — the production secret rule

### 5.1 The rule

**In production a secret that is missing, that is still the published placeholder, or that is
shorter than 32 characters is a misconfiguration: the endpoint answers `500 { "code": "internal" }`.
There is no per-process random fallback in production.**

The rule lives in **one** module — `site/shared/server/secret.ts` — so the session module, the
magic-link module, the moderation endpoint and the contact form cannot drift:

| Rule | Value | Where |
|---|---|---|
| placeholder list | `your-32-byte-hex-hmac-secret-here`, `your-32-byte-hex-secret-here`, `change-me`, `changeme`, `replace-me`, `your-secret-here` (case-insensitive) | `site/shared/server/secret.ts:34-41` |
| minimum length | 32 characters | `site/shared/server/secret.ts:44` |
| the reason | `missing` \| `placeholder` \| `too-short` \| null | `site/shared/server/secret.ts:47`, `:55-61` |

### 5.2 "Production" is decided by `isProductionEnv()`, not by `APP_ENV`

`site/shared/server/portal-session.ts:348-357`. A deployment is **production** when **any** of
these is true:

- `APP_ENV` is **unset** (the default) — a missing `APP_ENV` must never be read as development;
- `APP_ENV` is anything other than `development` (unknown → fail closed);
- `NODE_ENV=production`;
- `VERCEL=1`;
- `SITE_BASE_URL` / `SITE_URL` starts with `https://`.

Only an explicit `APP_ENV=development` on a machine that is **not** deployed is development. The
shipped `site/.env.example` set exactly that one variable, which silently switched **every**
fail-closed guard off on a deployed instance — that was the H-2 defect.

### 5.3 The rule per secret

| Secret | Used for | In production, an unusable value | Where it is enforced |
|---|---|---|---|
| `PORTAL_SESSION_SECRET` | the session HMAC | `sessionSecret()` → null → the caller answers `500 { "code": "internal" }`; **no token is minted at all** | `site/shared/server/portal-session.ts:391-402`, `:543-559` |
| `PORTAL_MAGIC_LINK_SECRET` | the magic-link HMAC (and the session fallback) | `magicLinkSecret()` → null → `500`; the sign-in door refuses **before** the token is consumed | `site/shared/server/magic-link.ts` (`magicLinkMisconfigured`, `magicLinkSecret`) |
| `FORM_WEBHOOK_SECRET` | the moderation-link HMAC | `500 { "error": "misconfigured", "code": "internal" }` | `api/moderate/review.ts:240-252`; `site/functions/api/moderate/review.ts:195-209` |
| `ADMIN_EMAILS` | the owner allow-list | unset **or empty after parsing** → `500 { "code": "internal" }` (misconfigured), distinct from 401 | `site/shared/server/portal-session.ts:675-676`; `api/portal/session.ts:110-120` |
| `RESEND_API_KEY` | sending mail | a missing key must never write a live token to the log | `site/shared/server/magic-link.ts` (production rule) |

**No secret is ever logged.** The moderation log line names the *reason*
(`FORM_WEBHOOK_SECRET placeholder`), never the value (`api/moderate/review.ts:243-249`).

---

## 6. The as-built storage contract (wave-7 §3, reconciled)

The wave-7 design was **overruled in the Backend's favour** on the DDL, and the spec now matches
reality. The full as-built DDL and the deviation log are in
[`proposal-wave7-design-2026-10-21.md`](proposal-wave7-design-2026-10-21.md) §3.2 as amended.
The three facts a reader needs here:

1. **Transport:** the libSQL HTTP v2 pipeline API over `global fetch` — `POST {base}/v2/pipeline`,
   `Authorization: Bearer {token}` (`site/shared/portal-store/libsql-transport.ts:14-15`, `:178`,
   `:218`). **Zero new dependencies.** A failed statement comes back as `{"type":"error"}` **inside
   `results[]` with HTTP 200**, so the transport inspects `results[]` and not the status code
   (`site/shared/portal-store/libsql-transport.ts:249-257`).
2. **The typed columns are nullable, there is no `UNIQUE` and there are no `DEFAULT`s**
   (`site/shared/portal-store/libsql-schema.ts:14-29`). The file adapter accepts duplicate ids and
   records without fields; a `DEFAULT 'pending'` would make the database flip review records the
   file adapter leaves alone. The two adapters must stay **interchangeable** — that is the whole
   point of the `PortalStore` interface.
3. **The `Where` clause is a `CASE` over `json_type()`, not a plain `CAST`** —
   `site/shared/portal-store/libsql-adapter.ts:197-211`. SQLite turns `true` into `1` and `42.0`
   into `'42.0'`, while the file adapter compares `String(value)`; the `CASE` reproduces
   `String()` exactly.

---

## 7. NOT BUILT — the explicit list

Each item names the file that proves it is not built. **Nothing in this list may be described as
finished.**

| # | What is NOT built | The file that proves it | What it means |
|---|---|---|---|
| 1 | **The Cloudflare portal tree is a 501 stub.** Every portal read and write on CF answers `501 { "code": "unimplemented" }`. | `site/functions/api/portal/auth.ts:243,412`, `comments.ts:50,90`, `invites.ts:27`, `plan-items.ts:53,89,93`, `projects.ts:57,105,121`, `testimonials.ts:306,361`, `updates.ts:50,86` | CF can serve the sign-in page and the moderation endpoint, but **not** the portal itself. |
| 2 | **The portal handlers are NOT on the `PortalStore`/libSQL adapter.** They still read and write JSONL directly. | `api/portal/*.ts` import `api/lib/jsonl.ts` (which re-exports `site/shared/portal-store/jsonl.ts`); `api/lib/jsonl.ts:13` | The libSQL adapter exists and is proven offline, but **nothing calls it**. The portal still cannot persist on Vercel (read-only filesystem). |
| 3 | **The function-budget refactor is designed but NOT implemented.** `api/` still holds **20** `.ts` files = 20 Vercel functions, above the Hobby cap of 12. | `api/` (20 files; 3 of them — `api/lib/jsonl.ts`, `api/lib/notifications.ts`, `api/lib/rate-limit.ts` — have **no default export**, so their URLs are dead: a runtime 500, not a build failure) | The design is in wave-7 §2; the code is not written. **On Hobby this still blocks the deploy.** |
| 4 | **There is no annotations / open-notes store anywhere.** `/admin` shows the count of open client notes as **unknown (a dash)**, not zero. | `api/admin/reviews.ts:227-233` (`openNotes: null`, `notesAvailable: false`); `site/src/pages/admin.astro:193-197` | The owner's second inbox column has no data source and must not pretend to have one. |
| 5 | **The Cloudflare twin of `GET /api/portal/session` does not exist** (no handler in the file). | `site/functions/api/portal/session.ts` (23 lines, one `export *` statement) | Contract A holds on Vercel only. |
| 6 | **The local dev server does not route `GET /api/portal/session`.** | `site/scripts/dev-portal.js:85-101`, `site/scripts/api-index.ts:18-33` | The Frontend's browser proof ran against a local fixture, not the real endpoint. |
| 7 | **The portal owner gates are not on the allow-list** (contract C) and the client-scoped reads are not client-first (contract D). | `api/portal/projects.ts:122,167`, `api/portal/comments.ts:82`, `api/portal/plan-items.ts:85`, `api/portal/updates.ts:82`, `api/portal/invites.ts:188` | Two open audit findings (M-4, M-5) are **not** closed. |
| 8 | **The durable rate counter is not on the SQL backend.** `api/lib/rate-limit.ts` still selects the file backend; the libSQL backend exists (`site/shared/portal-store/durable-rate-counter.ts:81-102`) and is not wired in. | `api/lib/rate-limit.ts` (unchanged in this wave) | The counter is still per-instance on Vercel and still fails on a read-only filesystem. |
| 9 | **The build-time publisher still reads the file store.** | `site/scripts/publish-testimonials.mjs` (runs as `prebuild`) | After the cutover the build must read the database **and fail loudly** if the database is down (wave-7 §3.7). |
| 10 | **The moderation store is still a JSONL file** (not the `moderation_reviews` table). | `api/moderate/review.ts:114-143` | The moderation queue works on a writable filesystem (local dev) and cannot work on Vercel. |

---

## 8. What still needs the owner — one line each

None of these is code. None of them blocks the remaining engineering.

1. **Turso database** → `LIBSQL_URL` and `LIBSQL_TOKEN` (plus `PORTAL_STORE=libsql` in production).
   The adapter is built and proven offline; only the two values are missing.
2. **The production secret values** → `PORTAL_SESSION_SECRET`, `PORTAL_MAGIC_LINK_SECRET`,
   `FORM_WEBHOOK_SECRET`, `ADMIN_EMAILS` (the owner's own address), `SITE_BASE_URL`,
   `RESEND_API_KEY`, `RESEND_FROM`, `RESEND_TO`, `FORM_WEBHOOK_SECRET`, `TURNSTILE_SECRET_KEY` —
   each ≥ 32 characters and none of them the published placeholder (contract E).
3. **The Vercel Root Directory** → the repository root, left empty in the dashboard.
4. **The Resend sender identity** → verified for `2imk4support@gmail.com`.
5. **The real Calendly link** for `/book`.
6. **The consent wording** in `site/src/data/testimonial-consent.ts`.
7. **Public or private client profiles** → public `/clients/<slug>` pages, or portal-only.
8. **One preview deploy** → settles whether a rewrite preserves the query string, the 12-function
   cap, and the `X-Robots-Tag` path patterns, none of which can be verified offline.

---

## 9. What I could not verify

- **No runtime was booted.** The Vercel router was never started (no token, no deploy), and
  **workerd was never booted** — every Cloudflare statement in this document is a reading of the
  code, not an observation of the runtime.
- **No real Turso database was ever contacted.** The store's proof is execution-grade against a
  real SQLite engine over the real wire protocol
  (`site/shared/portal-store/test/sqlite-worker.py` behind
  `site/shared/portal-store/test/mock-pipeline-server.ts`), which is not the same as Turso's
  service.
- **No live mail.** The moderation link was never exercised through a real mail client, so the
  confirmation page was never rendered by a mail client.
- **The route check cannot see a missing handler** (`site/scripts/check-api-routes.mjs` checks
  file existence), so §1.4 and §1.5 are invisible to `npm run check:routes`.
- I read the tree at one moment on 2026-10-21; the Backend was editing `api/**` concurrently, so
  the line numbers cited here are correct **for that reading** and should be re-checked by name,
  not by line, when the next wave starts.

---

## 10. The acceptance checks for the next wave

How each contract above is proven, so the next wave has no argument about "done":

| Contract | The check | Type |
|---|---|---|
| A | a client cookie → 200 `{ role: 'client' }`; an owner cookie + the address on the list → 200 `{ role: 'admin' }`; an owner cookie **without** the address on the list → 200 `{ role: 'client' }`; no cookie → 401; `ADMIN_EMAILS` unset → 500; **the same assertions against the CF twin** | executed, both trees |
| A | the token minted by one implementation verifies in the other (the F-2 property, re-asserted) | executed, two processes |
| B | a GET on a valid signed link → 200 HTML, and **the review state is unchanged**; the POST → 200 and the state is `approved`; a GET with a forged signature → 400 | executed, both trees |
| B | a mutation probe: revert the GET branch to the old write → the check reddens | executed |
| C | the owner address removed from `ADMIN_EMAILS` → the portal's owner endpoint answers **403**, not 200 (the audit's probe C) | executed |
| D | a request with a valid client cookie **and** a valid admin cookie → the client sees **only its own** project (the audit's probe C) | executed |
| E | `PORTAL_SESSION_SECRET` = the published placeholder → 500; = 30 characters → 500; unset → 500; a good value → the flow works | executed, with a mutation probe |
| §7 | every row of the NOT BUILT list is either still open, or the file that proves it is now built | a reading of the tree, not a guess |

---

## 11. The next wave, in order (all owner-free)

1. **Backend — contract C** (the two-part owner gate in the portal handlers) and **contract D**
   (the client cookie first). Two findings, one small shared-helper change, one migration of ~10
   call sites in both trees.
2. **Backend — the CF twin of contract A** (`site/functions/api/portal/session.ts` gets a
   handler) and the **dev-server route** (`site/scripts/api-index.ts` +
   `site/scripts/dev-portal.js`).
3. **Backend — wire the store** (NOT BUILT §2): the portal handlers read through `PortalStore`
   instead of JSONL; the rate limiter uses the durable SQL counter (NOT BUILT §8); the publisher
   reads the database and **fails loudly** (NOT BUILT §9).
4. **DevOps — the function-budget refactor** (NOT BUILT §3): 20 files → ≤ 12 functions, every
   public URL byte-identical, with the QA re-pin list from wave-7 §2.8.
5. **QA** re-pins the runner against the new paths and writes the wave-8 suite from §10.

**Not on this list, and deliberately so:** the Cloudflare portal tree (NOT BUILT §1). It is a
half-day of work against a target nobody has said is in the plan. That is a decision, not an
engineering task, and it is on the owner's list above.
