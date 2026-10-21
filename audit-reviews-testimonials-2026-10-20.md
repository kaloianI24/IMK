# Independent Code Review — Reviews / Testimonials feature

**Reviewer:** Code Reviewer — Independent Audit (Principal Code Reviewer)
**Date:** 2026-10-20
**Repo:** `C:\Users\Kalch\Documents\IXI`
**Verdict:** **DONE** — audit complete. 6 MAJOR, 8 MINOR findings. No CRITICAL findings.

> Read-only audit. No repo file was created, modified or deleted by this review
> (the only artifact is this report). All behavioural claims below were produced by
> driving the **real, unmodified handlers** from this repo in an isolated sandbox
> under `%TEMP%\opencode\review-audit\` (esbuild bundle of the actual `api/` tree,
> own cwd, own data stores). No behavioural suite was re-run and no build was
> re-run — the Manager's 43/43, 8/8, 85/85 and clean-build evidence is taken as
> given and was not repeated.

---

## 1. Files checked

**Backend (`api/`)**
- `api/portal/testimonials.ts` (504 lines) — full read
- `api/portal/session.ts` (105) — full read
- `api/portal/auth.ts` (390) — full read
- `api/portal/invites.ts` (295) — full read
- `api/portal/projects.ts` (307) — full read
- `api/moderate/review.ts` (173) — full read
- `api/contact.ts` (403) — full read
- `api/lib/notifications.ts` (158) — full read

**Cloudflare twins (`site/functions/api/`)** — parity check
- `site/functions/api/portal/testimonials.ts` (455)
- `site/functions/api/portal/session.ts` (101)
- `site/functions/api/portal/auth.ts` (dev-fallback block, lines 176–205)
- `site/functions/api/moderate/review.ts` (169)
- `site/functions/api/contact.ts` (grep)

**Frontend (`site/src/`, `site/scripts/`)**
- `site/src/loaders/testimonials.ts` (77)
- `site/src/content.config.ts` (77)
- `site/src/types/contracts.ts` (57)
- `site/src/data/testimonial-consent.ts` (26)
- `site/src/components/Testimonials.astro` (130)
- `site/src/components/PortalTestimonialPrompt.astro` (550)
- `site/src/components/PortalInviteForm.astro` (42)
- `site/src/pages/index.astro` (188)
- `site/src/pages/portal.astro` (300+)
- `site/src/pages/login/verify.astro` (46)
- `site/scripts/publish-testimonials.mjs` (223)
- `site/scripts/api-index.ts` (19)
- `site/scripts/dev-portal.js` (177)

**Shared store (`site/shared/portal-store/`)**
- `types.ts` (82), `file-adapter.ts` (258), `edge.ts` (42), `index.ts` (48), `errors.ts` (23)

**Config / ignore rules**
- `.gitignore`, `site/.env.example`, `site/package.json`, `site/tsconfig.api.json` (referenced), `site/functions/` tree listing, `git ls-files` / `git check-ignore` on the data paths

---

## 2. MAJOR findings

### M1 — Client identity (and email) is persisted for clients who explicitly withheld naming consent
**Where:** `api/portal/testimonials.ts:444-447` · twin `site/functions/api/portal/testimonials.ts:441-444` · file `site/data/moderation/reviews.jsonl`

The record always stores `email: session.email`, `name`, `company`, `role` —
**regardless of `consent.p2`**. `p2` only gates what the *publisher* writes.

Evidence (real handler, sandbox):
```
consent given by the client: p1=true p2=false
stored at rest -> email:   "alice@client.test"
stored at rest -> name:    "Alice Longname"
stored at rest -> company: "Acme Ltd"
stored at rest -> role:    "CTO"
```
The published site is correct (the publisher honours `p2`), but the **store** — and
the moderation email, which prints name and company
(`api/lib/notifications.ts:118-119`) — contains the identity of a client who asked
not to be named. RP-6.2 is enforced at publish time and nowhere else.

**Fix:** in `api/portal/testimonials.ts`, write `name`/`company`/`role` into the
record only when `consent.p2 === true`; otherwise write empty strings and let the
publisher resolve identity from the client record at publish time (it already
re-reads consent on every build). Apply the same to the CF twin.

### M2 — `session.email` is written to a file that `git add .` will commit
**Where:** `api/portal/testimonials.ts:445` · `.gitignore:19-25` · `site/data/moderation/reviews.jsonl`

The Backend flagged this and proposed dropping the field. Confirmed and quantified:
- `git check-ignore -v site/data/moderation/reviews.jsonl` → **exit 1 (not ignored)**.
- `.gitignore` ignores `site/data/portal/` and `site/data/snapshot/` only. The
  comment on `.gitignore:22` says *"site/data/moderation/ is NOT ignored: the
  build-time publisher reads it"* — that is the right call for the **publisher**,
  but it puts the email field in git.
- `git ls-files site/data` → empty (not tracked yet), `git status` → `?? site/data/`.
  So the file is one `git add .` away from committing live client emails.
- Nothing reads `record.email` back: the publisher ignores it, the moderation
  endpoint ignores it, `clientView()` omits it. Its only consumer is the
  submit-time notification (`api/portal/testimonials.ts:489`).

**Fix (as proposed by the Backend, unchanged):** drop `email` from the record and
pass `session.email` straight to `notifyReviewSubmitted(...)`. Combined with M1
this also removes the identity of anonymous clients from the file.

### M3 — One malformed line in a JSONL store silently disables the whole collection
**Where:** 6 of the 7 JSONL readers use the unguarded pattern —
`api/portal/projects.ts:62-72`, `api/portal/auth.ts:67-78`,
`api/portal/invites.ts:62-73`, `api/portal/comments.ts`, `api/portal/plan-items.ts`,
`api/portal/updates.ts`, `api/moderate/review.ts:52-63`.

`.map((line) => JSON.parse(line))` throws on the first bad line; the outer `catch`
returns `[]`. Every caller then behaves as if the store were **empty**, and the API
answers "not found" instead of "the store is broken". Only
`api/portal/testimonials.ts:99-117` has a per-line guard.

Evidence (real handlers, sandbox; controls on a healthy store passed first):
| Store | Operation | Healthy store | One malformed line elsewhere in the file |
|---|---|---|---|
| `projects.jsonl` | `PATCH /api/portal/projects/:id` | **200** updated | **404 `project not found`** |
| `projects.jsonl` | `GET /api/portal/projects` | 200 + N projects | **200 + 0 projects** (silent empty portal) |
| `invited.jsonl` | `POST /api/portal/auth/request-link` for a genuinely invited client | `allowed:true`, mail sent | **`allowed:false`** → client locked out; the client still gets the generic `200 {"ok":true,"message":"If you have an invitation, a sign-in link has been sent."}` — so the owner sees a normal response while nobody can sign in |
| `reviews.jsonl` | one-click `GET /api/moderate/review` (valid HMAC) | **200 approved** | **404 `review not found`** → the owner can never approve a quote |

**The correct pattern already exists twice in this codebase:**
`api/portal/invites.ts:92-105` (`readJsonlForWrite` — throws, caller answers
`500 store unreadable`) and `site/shared/portal-store/file-adapter.ts:65-101`
(throws `StorageError('storage-corrupt')`). The new store module even documents
the rule in `site/shared/portal-store/errors.ts:4-5`: *"a handler that cannot
reach the store must answer 503, never 'here is an empty list'"*. The live
handlers just never got it.

**Fix:** replace the six `readJsonl` implementations with one shared, guarded
reader (per-line parse with the file name + line number in the error) and map
the failure to `500 {code:'storage'}`. `api/portal/invites.ts:62` `readJsonl` is
now dead code — delete it, it is a trap for the next editor.

### M4 — Sign-in tokens are written to server logs when `RESEND_API_KEY` is absent, with no production guard
**Where:** `api/portal/auth.ts:187-199` · twin `site/functions/api/portal/auth.ts:190-202`

```js
if (!apiKey) {
  console.log(JSON.stringify({ ts, outcome: 'magic_link_dev', email, purpose, token, verifyUrl }));
  return;
}
```
There is **no `APP_ENV` / `DEV_STUB` check** — the branch is taken whenever the
key is missing or misspelled, including in production. The logged `token` is the
complete bearer credential for a client session, and `verifyUrl` is the live
sign-in link.

Evidence (real handler): with `RESEND_API_KEY` unset, stdout contains
```
{"ts":...,"outcome":"magic_link_dev","email":"owner@imk.test","purpose":"portal","token":"b3duZXJAaW1rLnRlc3R8cG9ydGFsfDE3OT...","verifyUrl":...}
```
This is directly connected to the pending launch item: if `RESEND_API_KEY` is set
but the **sender identity is not verified** (still open), the send fails, no mail
arrives, and the client simply cannot sign in — a silent auth failure.

Note the inconsistency: `api/contact.ts:180-183` **does** refuse to run with
`DEV_STUB=1` in production. `api/portal/auth.ts` has no equivalent.

**Fix:** gate the dev branch on `APP_ENV !== 'production'` (and fail with
`500 misconfigured` in production instead of logging the token). Same in the CF
twin.

### M5 — The one-click approve link approves a *different revision* than the owner was shown
**Where:** `api/moderate/review.ts:130-151` (and CF twin `:137-153`) · link built in `api/lib/notifications.ts:111-112`

The signed link carries `ref|decision|ts` — **not the revision**. The handler
finds the newest line for that ref and flips it to `approved`. The publisher
(`site/scripts/publish-testimonials.mjs:65-74`, "later lines win") then publishes
the newest line. So if the client edits their quote between the notification
email and the owner's click, the owner approves text they were never shown.

Evidence (real handlers, sandbox):
```
stored lines: 2, revisions: 1,2
quote per line: "REVISION ONE text" | "REVISION TWO text"
moderation result: 200 {"ok":true,"ref":"rev_4940676ba183","state":"approved"}
approved line(s): revision=2 text="REVISION TWO text"
>>> the owner was emailed "REVISION ONE text" but the published text is "REVISION TWO text"
```
The link lives **7 days** (`LINK_TTL_SECONDS`), and the client has a
"Change my feedback" button (`PortalTestimonialPrompt.astro:50`) that produces
exactly this revision.

**Fix:** include `revision` in the signed message and the URL, and have the
moderation endpoint approve that specific revision (or refuse if it is no longer
the newest). Same for the publisher: publish the revision the owner approved.

### M6 — Cloudflare twin never notifies the owner, and the CF tree has no notifications module
**Where:** `site/functions/api/portal/testimonials.ts:434-454` — the POST path
ends at `return json({ ok: true, testimonial: clientView(record) }, 200)`. There
is **no** `notifyReviewSubmitted` call and **no import of any notifications
module**; the CF tree has no `site/functions/api/lib/notifications.ts` at all
(the CF moderation endpoint carries its own inline copy).

Consequence: on the CF target a submitted testimonial produces no email, no
one-click approve/reject link, and no owner notification — the quote sits
`pending` forever and nobody knows it exists. The Vercel twin does notify
(`api/portal/testimonials.ts:483-497`).

This is currently masked by the 501 (`site/functions/api/portal/testimonials.ts:244`
and `:285` return 501 when `node:fs` is unavailable), but it must be fixed
before the CF target is used — and the same file must gain a notification path
for the eventual D1/Turso adapter.

**Fix:** port `api/lib/notifications.ts` to the CF tree (`site/functions/api/lib/`)
and call it from the CF POST path, mirroring the Vercel handler.

---

## 3. MINOR findings

**m1 — Moderation links point at the wrong host.** `api/lib/notifications.ts:83`
uses `process.env.SITE_URL || 'https://www.imk.example'`, while the portal base
URL is resolved as `SITE_BASE_URL || SITE_URL`
(`api/portal/session.ts:91-97`, CF twin `session.ts:87-93`). `.env.example:48-50`
tells the operator to change **one** env var (`SITE_BASE_URL`) for the portal.
Verified:
```
SITE_BASE_URL=https://imk.com, SITE_URL unset  ->  host: www.imk.example
SITE_BASE_URL=https://imk.com, SITE_URL set    ->  host: imk.com
```
The owner's approve/reject links would point at the placeholder domain and 404.
Fix: resolve the moderation base the same way the session base is resolved.

**m2 — The publish path silently deletes unparseable records from the store.**
`api/portal/testimonials.ts:230-242` rewrites `projects.jsonl` from a read that
skips unparseable lines. Verified: after one client submission the malformed
line was **gone** from the file (`3 lines → 2`). A record that failed to parse is
lost rather than surfaced. Fix: use the guarded reader (M3) and refuse to
rewrite when the read was lossy.

**m3 — Project titles are HTML-escaped at write time, then escaped again on read.**
`api/portal/projects.ts:201` and `:283` store `escapeHtml(title)`; the client
escapes again (`site/src/pages/portal.astro:195`). Verified:
```
owner typed:   "Tom & Jerry Ltd"
stored:        "Tom &amp; Jerry Ltd"
client shows:  "Tom &amp;amp; Jerry Ltd"
```
Fix: store the raw title; escape at the point of output only.

**m4 — `expectedOrigin()` silently falls back to `http://localhost:4321`.**
`api/portal/session.ts:91-97`. If `SITE_BASE_URL`/`SITE_URL` are unset in
production, every state-changing portal call (`POST /testimonials`,
`POST /invites`, `PATCH /projects`, `auth/request-link`) answers
`403 origin required` — an error that looks like a CSRF attack, not a missing
env var. The same fallback also makes `isSecureBaseUrl()` false, so the session
cookie is issued **without `Secure`**. Fix: fail fast in production with
`500 misconfigured`, and add both vars to the launch checklist.

**m5 — `readSessionCookie` matches either cookie name; first match wins.**
`api/portal/session.ts:30` / CF `session.ts:25`. If a browser holds both
`imk_admin_session` and `imk_session`, the first one in the header decides the
role for every request. A stale admin cookie therefore shadows a valid client
cookie, and `POST /api/portal/auth/logout` (`api/portal/auth.ts:375-387`)
destroys and clears only the one that matched. Fix: prefer the cookie matching
the requested role, and clear both on logout.

**m6 — The submit rate limiter is consumed before validation.**
`api/portal/testimonials.ts:383` increments the counter before the consent
check (`:418`) and the field validation (`:424`), so five malformed submissions
lock a client out for an hour. Conversely `snooze`/`decline` are **not** limited
at all — a client can append unbounded revisions to the append-only log. Fix:
move the limit check after validation; add a limit to the other two actions.

**m7 — `latestRecordForProject` filters by `projectId` only, not by `clientId`.**
`api/portal/testimonials.ts:178-184`. If a project is ever reassigned to a
different client, the new client inherits the old client's `ref` and `revision`
counter and overwrites the old client's quote. Low probability today (no
reassignment endpoint), but it is the exact class of bug the ownership check at
`:350-353` exists to prevent. Fix: include `clientId` in the filter.

**m8 — Two smaller items.**
- `site/scripts/api-index.ts` does not export the moderation handler, so
  `/api/moderate/review` is unavailable in local dev — a dev/prod parity gap in
  the harness QA relies on.
- `site/scripts/dev-portal.js:26` imports `esbuild`, which is **not** declared
  in `site/package.json` (it only resolves because vite depends on it). A
  dependency change upstream could break the dev server.

---

## 4. Verified correct (cleared, no action)

These were checked and are sound — the team should not spend time here.

- **`api/contact.ts` Content-Length fix is complete.** Every body-bearing
  response now computes `Buffer.byteLength(body)`
  (`api/contact.ts:78-90`); the only literal `'Content-Length': '0'` left in the
  tree is the two `303` redirects (`:319`, `:398`), which correctly send no
  body. The CF twin was already clean.
- **Server-derived provenance is not spoofable.** `verifiedClient`, `source`,
  `name`, `company` and `role` are never read from the request body
  (`api/portal/testimonials.ts:436-454`); the request supplies only
  `projectId`, `review`, `rating`, `displayName` and the consent booleans.
  The client record is the only source of identity.
- **Publish-time consent enforcement is correct.**
  `site/scripts/publish-testimonials.mjs:109-139` — `p1` gates publication
  (`:189`), `p2` gates name/company/role (`:116-120`), `verified` requires
  `verifiedClient && nameMe` (`:123`), and revoked/declined records are excluded
  (`:183-187`). The current consent state is re-read on every build.
- **No injection path from a quote into the homepage.** The card renders
  `t.data.quote` from frontmatter (`site/src/pages/index.astro:82` →
  `site/src/components/Testimonials.astro:43`) through Astro's expression
  escaping. The markdown body written by the publisher
  (`publish-testimonials.mjs:136`) is never rendered.
- **Length caps line up.** 80/120/120 in `api/portal/testimonials.ts:44-46`,
  `api/portal/invites.ts:30-32`, `site/src/types/contracts.ts:40-42` and
  `site/src/content.config.ts:67-69`; the quote cap is 1000 at the API and 2000
  in the schema — deliberately looser, and the schema can never be the tighter
  side.
- **CSRF / authorisation layering is right.** State-changing endpoints require
  `Origin === expectedOrigin()`; the owner-only rules are enforced server-side
  (`api/portal/invites.ts:204-208`, `api/portal/projects.ts:157-160`) rather
  than relying on the client-side role gate in `portal.astro` — which is the
  correct split, and the Frontend's fix for the build-time `role` bug was the
  right call.
- **`site/shared/portal-store/` is good work.** Correct error taxonomy
  (`errors.ts`), refuse-on-corrupt reads (`file-adapter.ts:80-92`), refusal to
  `update()`/`remove()` the append-only reviews log (`:159-166`, `:179-185`),
  `decideReview` flips only the newest revision of a ref and is idempotent
  (`:203-234`), and `edge.ts` never pulls in `node:fs`. The Backend's
  **correction of the proposal's import paths is right**: I verified
  `api/portal/x.ts → ../../site/shared/portal-store/index.js` and
  `site/functions/api/portal/x.ts → ../../../shared/portal-store/edge.js` both
  resolve. `site/shared/portal-store/index.ts:33` also defaults
  `PORTAL_DATA_DIR` to `<cwd>/site/data`, matching the handlers' paths.
- **Invite upsert semantics are correct** (`api/portal/invites.ts:124-151`:
  omitted = leave unchanged, empty = clear, over-long = 400 not truncation),
  and the client record is kept in step (`:161-180`).
- **The Frontend's "invite form was unreachable in the built site" find was
  real and correctly fixed** — the build-time `role` is always `'client'`
  (`site/src/pages/portal.astro:10`), so a template-level admin branch can
  never render. Rendering unconditionally and revealing client-side is right.

---

## 5. Shared-file conflicts

I checked every file both the Backend and the Frontend touched:

| File | Touched by | Conflict |
|---|---|---|
| `site/package.json` | Backend (`typecheck:api`, `test:store`) + Frontend/earlier (`brand`, `dev:portal`, `prebuild`) | **None** — all six scripts are present in the diff |
| `spec/08-portal-mvp.md` | Backend (§4.4, §4.5, T9k–T9o) + Frontend (Revision 5, T8l) | **No loss detected**, but both agents are appending to one document — assign a single owner per section from here |
| `site/src/types/contracts.ts` | Frontend only | None |
| `site/src/content.config.ts` | Frontend only | None |
| `.gitignore` | Backend only | None |
| `site/scripts/publish-testimonials.mjs` | Frontend only | None |
| `api/portal/*`, `api/contact.ts`, `api/moderate/*` | Backend only | None |
| `site/functions/api/**` | Backend (twins) | None |

The two agents' file sets do not overlap, as the Backend reported. The one file
that genuinely needs a single owner is `spec/08-portal-mvp.md`.

---

## 6. Recommended order of work

| # | Fix | Owner | Blocks launch? |
|---|---|---|---|
| 1 | M1 + M2 — stop persisting identity for anonymous clients; drop `email` from the record | @Backend Developer | **Yes** (data protection) |
| 2 | M4 — production guard on the magic-link dev log | @Backend Developer | **Yes** (auth) |
| 3 | M3 — one guarded JSONL reader across the API tree, `500` on a corrupt store | @Backend Developer | **Yes** (silent total outages) |
| 4 | m1 — moderation links must use the same base URL as the portal | @Backend Developer | **Yes** (moderation unusable) |
| 5 | M5 — bind the approve link to a revision | @Backend Developer | No (integrity) |
| 6 | M6 — notification path for the CF twin | @Backend Developer | No (CF target) |
| 7 | m2–m8 — the minor list | split: @Backend (m2–m7), @Frontend (m7 portal title, m8) | No |

---

## 7. Limits of this review

- I did **not** re-run the behavioural suites or `npm run build` — that evidence
  was on record and the Manager asked me not to repeat it.
- I did **not** exercise the Cloudflare runtime (no `wrangler` run): the CF
  findings are from reading the twins and comparing them to the Vercel
  handlers.
- The `spec/proposal-portal-storage.md` migration plan was read only insofar as
  it is referenced by the code in scope; I did not audit the plan itself.
- Everything in §4 is a **static read plus, where stated, a sandbox run** — I
  did not click through the built site in a browser.
