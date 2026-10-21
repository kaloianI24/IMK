# Frontend wave 6 — the `/admin` owner inbox (T7.14) + the portal audit

**Status: DONE** — the `/admin` screen is built, wired to the real moderation store, and
exercised end-to-end in a browser. Two gaps are reported rather than faked, and one
client-side defect in `/portal` is fixed. One pre-existing Backend defect (QA's D-4) is
still open and is not mine.

Repo: `C:\Users\Kalch\Documents\IXI` · site at `site/` · Vercel handlers in `api/` ·
Cloudflare twins in `site/functions/` · spec: `spec/07` §7.3 / T7.14, `spec/08` §4.8 / §4.9.

---

## 1 · What I built

| File | What it is |
|---|---|
| `api/admin/session.ts` (new) | `GET /api/admin/session` — "is this request the owner?" |
| `api/admin/reviews.ts` (new) | `GET /api/admin/reviews` — the owner's moderation queue + the signed actions |
| `site/functions/api/admin/session.ts` (new) | Cloudflare twin of the above |
| `site/functions/api/admin/reviews.ts` (new) | Cloudflare twin of the above |
| `site/src/pages/admin.astro` (new) | The `/admin` screen |
| `site/src/layouts/BaseLayout.astro` (edited) | New optional `nofollow` prop → `noindex, nofollow` |
| `site/src/pages/portal.astro` (edited) | Client-side gap fixes (§5) |
| `site/scripts/api-index.ts`, `site/scripts/dev-portal.js` (edited) | The local dev server now serves `/api/admin/*` — see §7 (shared file) |
| `site/.env.example` (edited) | `ADMIN_EMAILS` documented as the `/admin` allow-list; `PORTAL_SESSION_SECRET` added |

The site is a static build (`output: 'static'`), so `/admin` is a shell page whose
content is fetched from two admin endpoints. That is the pattern `portal.astro` already
uses, and I chose it deliberately — see §4 for how the 401 is proved.

---

## 2 · The owner gate

**Two checks, not one.** A request must carry a session whose role is `admin` **and** the
session's email must be on the `ADMIN_EMAILS` allow-list. The allow-list is read on
*every* request, so removing an address revokes access immediately instead of at the end
of the 24h signed-token life.

**The cookie is a separate one.** The owner session lives in `imk_admin_session`, the
client session in `imk_session` (spec/07 §7.3, A-9). `resolveSession(req, 'admin')`
prefers the admin cookie, and the role is checked as well — a client cookie can never
satisfy the gate.

**Every non-owner gets the same answer**: `401 {error:'unauthorized', code:'unauthorized'}` —
not signed in, a client session, a forged cookie, an address off the allow-list. One
answer for every state, so the endpoint cannot be used to tell them apart.

---

## 3 · What the screen shows, and what it does not

- **Counts header**: pending reviews · open client notes · decided today.
- **Pending reviews**: ref, rating, name/company, date, the quote, and **Approve / Reject**
  buttons with accessible names (`Approve the quote inq_demo1`).
- **Recently decided**: the last five decisions.
- **Client notes panel**: **explicitly marked "Not implemented yet"** — there is no
  annotation store in this repo (`spec/07` T7.8 / T7.10 were never built). The count of
  open notes is reported as `null` and rendered as a dash, **not** as `0`: zero would be a
  claim, and there is nothing to count. No sample data, no invented clients.
- **States**: loading (`role="status"`), not-authorised (401), error with a **Try again**
  button, empty queue, disabled buttons while a decision is in flight, and a live region
  that reports each outcome in words.

**The decision goes through the existing moderation contract.** `api/admin/reviews.ts`
mints the signature (server-side, from `FORM_WEBHOOK_SECRET`) over
`ref|decision|revision|ts` and returns the **path** of the signed moderation link. The
browser calls `/api/moderate/review` with it, so the decision is made by the one
implementation of the contract — with its revision guard, its idempotency, its fail-closed
store handling and its confirmation mail. `api/moderate/review.ts` was **not** touched.

Two deliberate choices worth stating:

- The links are returned as **path + query, not absolute URLs**, so the page always calls
  its own origin. The signature does not cover the origin, so dropping it changes nothing
  about what the link may do.
- The links are visible to the owner's browser. That is the same exposure the e-mail
  one-click link already has (spec/07 §7.3 designs the decision around a signed URL), and
  the URL cannot be read cross-origin.

---

## 4 · Checks — all executed, with the real output

### 4.1 Gates

| Gate | Result |
|---|---|
| `npm run build` (in `site/`) | **exit 0 — 23 pages** (22 before, `/admin` added) |
| `npm run check:routes` (repo root) | **exit 0 — 15 routes, 0 missing** (13 before; `/api/admin/session` and `/api/admin/reviews` are listed, each with its file in **both** trees) |
| `npm run typecheck:api` | **exit 0** |
| `npm run check` (`astro check`) | **0 errors, 0 warnings, 9 hints** — the baseline; none of the hints are in my files |
| `npm run test:store` | not re-run by me — QA's runner covers it (see §6) |

### 4.2 The 401 — how it was proved

A harness **outside the repo** (`C:\Users\Kalch\AppData\Local\Temp\opencode\imk-admin-harness\`)
bundles the **real handlers** with esbuild and calls them with real request/response
objects. The moderation store is a **sandbox copy**: the handlers resolve it from
`process.cwd()`, so the harness runs in a temp directory that holds its own
`site/data/moderation/reviews.jsonl`. The repo's real store was never opened for writing.

**31 checks, 31 pass, 0 fail.**

```
A. no cookie                                   -> 401 {"error":"unauthorized","code":"unauthorized"}
B. a CLIENT session (imk_session)              -> 401
C. a forged cookie                             -> 401
D. an admin session NOT on the allow-list      -> 401
E. an allow-listed admin session               -> 200 {"ok":true,"role":"admin","email":"owner@imk.example"}
G. GET /api/admin/reviews with no cookie       -> 401
```

### 4.3 The queue and the decision

```
F. admin session -> 200  counts {pendingReviews:1, decidedToday:0, openNotes:null}
   approvePath = /api/moderate/review?ref=inq_one&decision=approve&revision=1&sig=<64 hex>&ts=<epoch>
   the path carries no absolute origin
   open client notes are reported as unknown, not zero
H. the moderation endpoint accepts the signed approve -> 200 {"ok":true,"ref":"inq_one","state":"approved"}
   the STORE says approved           (state, decidedAt, decidedBy: "one-click-link")
   the queue is empty again, and it counts as decided today
I. the signed reject                 -> 200 {"ok":true,"ref":"inq_two","state":"rejected"}
J. a corrupt store                   -> 500 {"error":"storage unavailable","code":"storage"}
K. a missing store                   -> 501 {"error":"moderation store unavailable on this target","code":"unimplemented"}
L. CF twin: client session -> 401 ; allow-listed admin -> 200 ; no edge filesystem -> 501
M. a link signed the Cloudflare way is accepted by the Vercel moderation endpoint (the signed
   message is identical on both trees)
N. a forged signature                -> 400 {"error":"invalid signature","code":"signature"}
```

### 4.4 In a real browser

A throwaway server (free port **4399**; 4321 belongs to the dev server that was already
running) served the built site and the real handlers on one origin.

1. `/admin` with no cookie → the page renders and the browser log shows
   `GET /api/admin/session → 401`; the screen shows *"This page is for the site owner."*
2. Signed in through the **real magic-link flow** (`/login` → the dev-mode link → `/login/verify`).
3. `/admin` → the inbox renders: `1 pending reviews`, `— open client notes (not
   implemented yet)`, `0 decided today`, the quote card with its Approve/Reject buttons,
   the client-notes panel marked not-implemented, and *"Recently decided — Nothing has
   been decided yet."*
4. Clicked **Approve** → the store on disk became `state: "approved"` with `decidedAt`,
   the counts went to `0 pending / 1 decided today`, the card disappeared, the empty
   state appeared, *"Recently decided"* gained the row, and the live region said
   *"Approved — done. The list is up to date."*
5. Clicked **Reject** on a second quote → `state: "rejected"`, `2 decided today`, and
   *"Rejected — done."*

**Stated, not assumed:** the file store does not persist on a read-only filesystem, so on
Vercel the *list* works wherever the file can be read and a *decision* answers
`500 {code:'storage'}` — never a false "approved". The durable answer is the libSQL
adapter (T4), blocked on the owner decision and **not** built here. On Cloudflare the
queue answers `501 {code:'unimplemented'}`, exactly like the moderation twin does today.

---

## 5 · The `/portal` audit against spec/08 §4.8 / §4.9

### 5.1 The route contract (§4.8) — clean

Every path `portal.astro` calls has a function file in **both** trees, and
`check:routes` proves it: `/projects`, `/plan-items`, `/plan-items/<id>`, `/updates`,
`/comments`, `/invites`, `/projects/<id>`, `/auth/logout`. The by-id calls go to
`api/portal/plan-items/[id].ts` and `api/portal/projects/[id].ts` ✓.

### 5.2 The session contract (§4.9) — the page uses it correctly

`portal.astro` sends the cookie (`credentials: 'include'`) and reads nothing from the
token itself ✓. The stateless signed token needs nothing from the page.

### 5.3 Fixed on the client (no API change)

| # | Gap | Fix |
|---|---|---|
| F1 | A 500 or a network error fell into the same branch as a 401 and told the owner *"Your session has expired or you're not signed in."* — a wrong answer that also hid the fact that the portal was not loading. | A separate error state with its own text and a **Try again** button; only a 401 says "signed out". *Verified in the browser: a corrupt store now shows "The portal store could not be read, so nothing is shown.", and Try again recovers.* |
| F2 | A failed section request left the section **empty**, which reads as "you have no plan items" when the truth is "we could not ask the server". | Each section says what went wrong (plan items / updates / comments). |
| F3 | `showMessage('plan-items-list', …)` **overwrote the plan-item list** with the message text. | A dedicated `#plan-items-message` status line. |
| F4 | A failed project-status update used `alert()` — a blocking modal, not announced reliably by a screen reader. | An inline `#project-status-message` live region. |
| F5 | The loading text was not announced. | `role="status" aria-live="polite"` on the loading, error and status regions; short announcements for what loaded. |

### 5.4 Listed, NOT built — these need an API change

| # | Gap | Why it needs the API |
|---|---|---|
| G1 | **The owner UI in `/portal` is driven by `sessionStorage`, not by the server.** *Verified in the browser:* a new tab has an empty `sessionStorage` → `role` falls back to `'client'` → the owner sees the client view even though the session cookie says `admin`. The mirror image: a client can set `imk_portal_role = 'admin'` and *see* the owner controls (invite form, status card). The **API still refuses every one of those actions (403)** — it is a UI defect, not an auth hole. | The page needs to learn the role from the server: either a `role` field on `GET /api/portal/projects`, or a `GET /api/portal/session` endpoint. Owner decision + Backend. |
| G2 | The portal has no way to show **which project** it is looking at when a client has more than one — it always takes `projects[0]`. | Needs a project switcher in the API response / a route. Backend + Product. |
| G3 | The portal has no **annotation** surface (spec/07 T7.9/T7.10) and no store behind it. | The annotation store and endpoint do not exist at all. |

### 5.5 Not changed on purpose

`portal.astro` keeps `noindex, follow` — I did **not** flip the client portal to
`nofollow`: the BaseLayout prop I added is opt-in, and the portal's robots directive is a
deliberate existing choice. `/admin` asks for `noindex, nofollow` as spec/07 §7.3 requires.
Changing `/portal` is a one-word edit if the owner wants it — their call.

---

## 6 · The full QA runner — 10 of 11 suites green, and the one red is not mine

`powershell -NoProfile -ExecutionPolicy Bypass -File site\qa\run-all-suites.ps1`
→ transcript: `site/qa/artifacts/qa-full-run-2026-10-21.txt`

| Suite | Exit | | Suite | Exit |
|---|---|---|---|---|
| qa-testimonials | 0 | | qa-cf-parity | 0 |
| qa-testimonials-build | 0 | | qa-wave3-independent | 0 |
| qa-backend-hardening | 0 | | check:routes | 0 |
| qa-wave2-independent | 0 | | qa-wave4-independent | 0 |
| qa-mutation-probe | 0 | | **qa-wave5-independent** | **1** |
| qa-rate-limit | 0 | | | |

The single red is **`B6 — the Cloudflare twin answers the SAME codes as the Vercel tree`**:
that is QA's **D-4**, which QA reported as Backend-owned and which the Backend has not
fixed yet (`site/functions/api/moderate/review.ts:77` returns `[]` for a missing store →
`404`, where the Vercel tree answers `501`). **It is pre-existing and untouched by me** —
I did not modify `api/moderate/**` or `site/functions/api/moderate/**`.

Note for QA: the runner writes **one transcript per day**, so my run replaced the
transcript QA produced earlier today with the same file name. The suite results are the
same; only the transcript is newer.

---

## 7 · Shared files I touched — please look here

Two files outside my ownership were edited because `/admin` is otherwise unreachable
locally. Both are additive; both are easy to revert if the Backend prefers another shape:

- `site/scripts/api-index.ts` — two exports: `adminSession`, `adminReviews`.
- `site/scripts/dev-portal.js` — two route prefixes: `/api/admin/session`,
  `/api/admin/reviews`.

Without them the local dev server answers 404 for `/api/admin/*` (it matches by prefix),
so `/admin` would always show its error state on every machine. **The dev server that is
running right now was started before this change and has to be restarted** to pick it up.
The esbuild bundle of `api-index.ts` compiles clean (verified: 98.2 kB, no errors).

`site/.env.example` is mine for this task: `ADMIN_EMAILS` now says it opens `/admin` and
that removing an address revokes access immediately, and `PORTAL_SESSION_SECRET` is
documented (the Backend flagged it as missing from the production env list).

---

## 8 · What is NOT done, and who owns it

1. **T4, the libSQL adapter** — not started, not touched, blocked on the owner decision
   (Turso or Neon). Until it lands the portal cannot run on Vercel, and the admin
   **decisions** cannot persist there either — the list reads, the write answers
   `500 {code:'storage'}`.
2. **QA's D-4** — the CF moderation twin answers `404` where the Vercel tree answers
   `501`. Backend-owned, untouched by me, still open.
3. **DEPLOY.md does not mention the two new admin routes** — DevOps owns that file.
4. **The Vercel Root Directory is still unset** — DevOps/owner.
5. **The annotation store** — does not exist; the `/admin` panel says so instead of
   pretending.

## 9 · Unverified, stated plainly

- The **Vercel router was never booted** (no token here): every Vercel claim above is
  about the code path executed in isolation. `check:routes` proves the *file contract*,
  not the deployed router.
- The **workerd runtime was never booted**: every Cloudflare claim is about the CF code
  path executed in Node's Web-standard runtime. In that runtime there is no
  `globalThis.require`, so the CF queue answers `501` — which is also what a real Worker
  does.
- **No live Resend, no live Turnstile**; the confirmation mail of a decision was not
  exercised against the real provider.
- The browser run used a **sandbox copy** of the moderation store (the repo's real store
  is 0 bytes and off-limits to writes), and the **dev-mode magic link** — no real mail
  was sent.
- The portal audit is a **read of the page plus a browser run**; it is not a substitute for
  a QA pass on the portal UI.

## 10 · Re-verification (21:40–21:55) — the assignment was re-sent, so everything was re-run

The wave-6 assignment arrived a second time. Nothing was left to build, so this turn
re-ran the gates on the current tree and found two things that were **not** in the
report above, both local-environment, both fixed here.

### 10.1 Two local gaps, found by actually using the screen

1. **The dev server predated the admin routes.** It had been started before
   `site/scripts/api-index.ts` / `dev-portal.js` changed, so `/api/admin/session` and
   `/api/admin/reviews` answered **404** on every machine — `/admin` could only ever
   show its error state. Restarted it identically (`npm run dev:portal` →
   `npm run build && node scripts/dev-portal.js`, port 4321, the dev server's own
   port — never bound a second one there). Both routes now answer **401** to an
   unauthenticated request, i.e. the route exists and the gate is in front of it.
2. **`site/.env` had no `FORM_WEBHOOK_SECRET`**, so `/api/admin/reviews` answered
   **500 {code:'internal'}** (`admin_misconfigured`) even for the owner. That is the
   endpoint failing closed *on purpose* — an empty HMAC key is a public key, so it
   refuses to mint an approve link it knows cannot be verified. The fix is not in the
   code: the local `.env` needed the secret. I generated one (32 random bytes, hex)
   with `RNGCryptoServiceProvider`. It is a **local dev value only**, it is not a
   production value, and `site/.env` is gitignored (`site/.gitignore:8`) — it does not
   appear in `git status` at all. (The first generation attempt produced an all-zero
   string because the static `RandomNumberGenerator.Fill` does not exist on this
   PowerShell; I checked the value, caught it, and regenerated it properly rather than
   shipping a known key.)

### 10.2 Gates re-run on the current tree

| Gate | Result |
|---|---|
| `npm run build` (in `site/`) | **exit 0 — 23 pages** |
| `npm run check:routes` (repo root) | **exit 0 — 15 routes, 0 missing**, both admin routes listed with their file in **both** trees |
| `npm run typecheck:api` | **exit 0** |
| `npm run check` (`astro check`) | **0 errors, 0 warnings, 9 hints** — the baseline, none in my files |
| `node site/qa/qa-admin-independent.mjs` (QA's own suite #12) | **16 checks, 16 PASS, exit 0** |

### 10.3 The screen in a browser, on the real store

Signed in through the real magic-link flow (dev mode) and opened `/admin`:

- signed out: `GET /api/admin/session → 401`, the screen shows *"This page is for the
  site owner."*
- signed in as the owner: `GET /api/admin/session → 200`, the inbox renders — three
  regions, **Pending reviews**, **Client notes**, **Recently decided**.
- counts header: `0 pending reviews`, **`—` open client notes (not implemented yet)**,
  `0 decided today`. The dash is a dash: the count is *unknown*, not zero, and the
  panel says *"Client notes are not built in this project: there is no note store, so
  there is nothing to list and nothing to resolve."*
- pending reviews: *"No quotes are waiting for a decision."* — the real store is
  0 bytes, so that is the truth, and there are **no invented rows**.
- recently decided: *"Nothing has been decided yet."*

The approve/reject click was **not** re-exercised against the repo's store this turn:
that would mean writing to `site/data/**` (and the prebuild publisher would then
republish the quote as a testimonial). It is proven twice on this same code instead —
§4.4 above (browser click, sandbox store: `approved` then `rejected` on disk) and QA's
E10 (the minted link is HMAC-valid, `/api/moderate/review` accepts it, the quote flips).
My files are byte-unchanged since that run (`admin.astro` 20:59, `reviews.ts` 20:57),
so both proofs still stand for the code that is on disk now.

### 10.4 Still open, unchanged

- **DEPLOY.md still does not list the two admin routes** — checked again this turn;
  only `ADMIN_EMAILS` appears (twice, in the env tables). DevOps owns that file.
- QA's **D-4** (CF moderation twin `404` vs Vercel `501`) — Backend-owned.
- **T4 / libSQL** — owner decision.

---

@Manager — wave-6 frontend is landed and verified. @Backend Developer — one item is
yours: **D-4** (the CF moderation twin answers `404` where the Vercel tree answers
`501`); it is the only red in the QA runner. @QA Engineer — the `/admin` screen is new
and untested by you: the two endpoints are `GET /api/admin/session` and
`GET /api/admin/reviews`, the owner gate is a session **plus** the `ADMIN_EMAILS`
allow-list, and the approve/reject actions are signed links to `/api/moderate/review`
(`ref|decision|revision|ts`, minted server-side). **Update: QA has since written that
suite** — `site/qa/qa-admin-independent.mjs`, suite #12, **16 checks, 16 PASS** — so my
out-of-repo harness is no longer needed and stays out of the tree. @DevOps — the dev
server **has** been restarted (it is serving `/api/admin/*` again); DEPLOY.md still
needs the two admin routes added.
