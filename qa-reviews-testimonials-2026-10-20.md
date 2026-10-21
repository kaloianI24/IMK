# QA Verification — Reviews / Testimonials feature

**Tester:** QA Engineer — Testing and Verification (Chief QA Engineer)
**Date:** 2026-10-20
**Repo:** `C:\Users\Kalch\Documents\IXI`
**Baseline:** `spec/08-portal-mvp.md` (Rev. 5) §4.4, §4.5, §5, §1 invariants · `spec/research-client-profiles-testimonials.md` (RP-3, RP-5, RP-6, RP-7, RP-8) · audit report `audit-reviews-testimonials-2026-10-20.md`

---

> # ⚠ UPDATE — RE-RUN AFTER FIX WAVE 2 (same day, later)
>
> **This section below describes the state BEFORE the fixes and is kept as the historical record.**
>
> The Backend Developer closed all 8 defects (D1–D8) in two fix waves and asked QA to re-run and own the harness. That re-run is done:
>
> **→ Full re-run report: `qa-reviews-testimonials-rerun-2026-10-20.md`**
>
> | | |
> |---|---|
> | **Result** | **138/138 executed checks PASS, 0 FAIL** (81 API + 14 build + 15 hardening + **28 new QA-independent**) |
> | **Defects** | **D1–D8 all CLOSED** and re-verified; no new defect found |
> | **Independence** | a **new QA-owned suite** (`site/qa/qa-wave2-independent.mjs`) that shares no helper with the Backend's harness, plus a **mutation probe** proving the checks fail when a defect is put back |
> | **Gates** | `typecheck:api` exit 0 · `test:store` 22/22 · `build` 22 pages exit 0 · `check` 0 errors / 0 warnings / 8 hints |
> | **Still unverified** | the **Cloudflare runtime** (D6/M6 is static only) · the rate limit is in-memory per instance |
>
> The verdict, the defect list and the limits below are the **pre-fix** ones. Read them as history; the re-run report above is current.

---

## Verdict: **DONE — PASS on every executed acceptance check; 8 defects confirmed open (6 MAJOR, 2 MINOR)**

All 94 executed checks passed. The feature **behaves as specified** on every path I was asked to verify: the public review door is closed, the portal endpoint returns the exact status codes in the spec, consent is enforced at store *and* publish time, a withdrawal removes the quote from a fresh build, the invite upsert works, moderation links fail closed, and the build + typecheck gates are green.

The defects below are **pre-existing and unfixed** — the reviews/testimonials feature is **not release-ready** until M1–M4 are closed (M1/M2 are a data-protection issue, M3 is a silent total-outage class of bug).

**Nothing in this report was taken on trust.** Every claim below was produced by driving the **real, unmodified handlers** from `api/` and a **real `astro build`** — see §2. Where I could not execute something, it is listed as *unverified*, not as a pass.

---

## 1. What was executed, and how

### 1.1 Harnesses (added to the repo, reproducible)

| File | What it does |
|---|---|
| `site/qa/qa-testimonials.mjs` | 80 API checks against the real handlers. Bundles `api/` with esbuild, runs it in-process on **port 4399** with **cwd = a temp sandbox**, stubs `globalThis.fetch` so **no request leaves the machine**. |
| `site/qa/qa-testimonials-build.mjs` | 14 build checks. Copies the site source into a sandbox, runs the **real** `scripts/publish-testimonials.mjs` + **real `npm run build`**, and inspects the rendered `dist/index.html`. |
| `site/qa/artifacts/qa-testimonials-results.json` | Machine-readable results of the API run (e-mails redacted). |

```
node site/qa/qa-testimonials.mjs --keep          # API suite
node site/qa/qa-testimonials-build.mjs --sandbox <that sandbox>
```

### 1.2 Isolation (this is the point of the harness)

| Isolation | How |
|---|---|
| Repo data | The handlers resolve `site/data/…` from `process.cwd()`; the harness `chdir`s into `<temp>\opencode\qa-testimonials-…` **before** the bundle is loaded. Every fixture landed in the sandbox. |
| Repo source | Never modified by the tests. `site/data/moderation/reviews.jsonl` is **still 0 bytes**; `git status` is byte-identical before and after (verified by diffing the porcelain output). |
| The running dev server | Untouched — port **4321** kept its original PID 2556 throughout and still answers `401` for an unauthenticated portal call. My harness used **4399** and shut it down. |
| Network | `globalThis.fetch` is stubbed: `api.resend.com` calls are captured and counted, anything else throws. **No outbound request was made.** |
| Fixtures | All created inside the sandbox; both sandboxes deleted afterwards. |
| Build | The site is **copied** into a second sandbox (`node_modules` a junction, read-only); `dist/`, `src/content/testimonials/` and the Astro content cache were written only there. |

### 1.3 Environment

Node v20.19.5 · Windows · `astro check` → **0 errors, 0 warnings, 10 hints** · `npm run test:store` → **22/22** · `npm run typecheck:api` → **exit 0** · `npm run build` → **22 pages, exit 0, no warnings in the output**.

---

## 2. Executed checks — 94/94 PASS

### Group A — the public review door is closed (§4.4, §5 "Public review door")

| ID | Check | Result | Evidence |
|---|---|---|---|
| A1 | `POST /api/contact` `type=review` (JSON) | **PASS** | `410`, body `{code:"review-moved"}` |
| A2 | same, form-encoded | **PASS** | `410` |
| A3 | a refused review **writes nothing** | **PASS** | `reviews.jsonl` still empty; **0** Resend calls |
| A4 | control: a normal inquiry still works | **PASS** | `200 {ok:true,ref}` |

### Group B — portal endpoint contract (§4.4 status codes)

| ID | Check | Result |
|---|---|---|
| B1 / B2 | no session → `401` (GET and POST) | **PASS** |
| B3 / B4 | another client's project → `404` (not `403` — no id probing) | **PASS** |
| B5 | unfinished project → `409 not-eligible` | **PASS** |
| B6 | missing `consent.p1` → `400 consent-required`, **nothing stored** | **PASS** |
| B7 / B8 | wrong Origin / no Origin → `403 origin` | **PASS** |
| B9 | the owner submitting → `403 forbidden` | **PASS** |
| B10 | 6th submission in the hour → `429` (first five `200`) | **PASS** |
| B11 | `PATCH` → `405` | **PASS** |
| B12–B16 | bad action / rating / empty quote / >1000 chars / displayName >80 → `400` **naming the field** | **PASS** |
| B17 / B18 | missing `projectId` → `400`; unknown project → `404` | **PASS** |

### Group C — consent flow, provenance, provenance spoofing

| ID | Check | Result | Evidence |
|---|---|---|---|
| C1 | submit → `200`; identity is **server-derived** (`Alice Longname`, `Acme Ltd`, `CTO`), `verifiedClient:true`, `source:'portal'`; the view carries **no** e-mail / clientId / projectId | **PASS** | |
| C2 | the owner is notified with a **signed** one-click link | **PASS** | 1 Resend call, body contains `sig=` and `/api/moderate/review?` |
| C3 | **spoofed body fields ignored** (`verifiedClient:false`, `source:'public'`, `clientId`, `name`, `company`, `role`) | **PASS** | stored: `verifiedClient:true`, `source:'portal'`, `name:'Frank Spoof'`, `company:''` |
| C4 | snooze → `200`, state `snoozed`, `project.testimonialStatus='snoozed'` | **PASS** | |
| C5 | owner re-requests → GET returns `testimonial:null` (the card returns) | **PASS** | |
| C6 / C7 | decline → `200 declined`; a **second decline → `409 declined`** (decline is final, RP-3.5) | **PASS** | |
| C8 | the client view never leaks the e-mail | **PASS** | |
| C9 | the owner can approve the quote | **PASS** | state → `approved` |

### Group D — invite flow and client profile (§4.5)

| ID | Check | Result |
|---|---|---|
| D1 / D2 / D3 | client session / no session / wrong Origin → `403` | **PASS** |
| D4 | invalid e-mail → `400` naming `email` | **PASS** |
| D5 | the first sign-in builds the client record **from the invite**, not the e-mail local part | **PASS** — `Alice Longname`, not `alice` |
| D6 | upsert: omitted `name` kept, new `company` reaches **both** the invite and the client record | **PASS** |
| D7 | company of 121 chars → `400` naming `company`, **nothing written** | **PASS** |
| D8 | empty string **clears** the field on both records | **PASS** |
| D9 / D10 | over-cap name → `400`; a re-invite does not duplicate the record | **PASS** |
| D11 | `GET /api/portal/invites` → `404` | **PASS** |

### Group E — moderation links fail closed

| ID | Check | Result |
|---|---|---|
| E1 / E2 | missing parameters / invalid decision → `400 validation` | **PASS** |
| E3 / E4 | expired link → `400 expired`; timestamp > 60 s in the future → `400 expired` | **PASS** |
| E5 | **no `FORM_WEBHOOK_SECRET` → `500 misconfigured`** (fails closed, does not approve) | **PASS** |
| E6 | forged signature → `400 signature` | **PASS** |
| E7 | valid signature, unknown ref → `404` | **PASS** |
| E8 | valid signature → `200`, state `approved` | **PASS** |
| E9 | **idempotent**: a second click → `200`, no second decision, **no new line** | **PASS** |
| E10 | `reject` → state `rejected` | **PASS** |

### Group F — withdrawal / revocation (RP-6.4 / RP-6.5)

| ID | Check | Result | Evidence |
|---|---|---|---|
| F1 | approve, then the client withdraws → the newest line carries `revoked:true` + `withdrawnAt` | **PASS** | |
| F2 | the revocation is the **newest** line for the ref (later lines win) | **PASS** | |
| F3 | an anonymous quote (`p2=false`) approves and stays anonymous in the store | **PASS** | |

### Group G — independent re-verification of the code review's MAJOR findings

| ID | Finding | Result | Evidence produced by me |
|---|---|---|---|
| G1 | **M1** identity stored despite `p2=false` | **CONFIRMED** | `p2=false` but the record still holds `email="carol@client.test" name="Carol Anonymous" company="Carol Corp" role="CFO"` |
| G2 | **M2** `session.email` → a file `git add .` will commit | **CONFIRMED** | `git check-ignore site/data/moderation/reviews.jsonl` → **exit 1** (not ignored) |
| G3 | **M3** one malformed line empties the whole collection | **CONFIRMED** | 1 bad line → `GET /api/portal/projects` returns **0** of 10 projects; `PATCH` → **404 project not found** |
| G4 | **M4** magic-link token logged with no production guard | **CONFIRMED** | a **178-char bearer token** written to stdout in plain text with `APP_ENV` unset (handler default = production) |
| G5 | **M5** the approve link approves a *newer* revision | **CONFIRMED** | owner shown “REVISION ONE text” (rev 1) → the link approved rev 2 = “REVISION TWO text” |
| G6 | **M6** the Cloudflare twin never notifies | **CONFIRMED** | no `notifyReviewSubmitted` in `site/functions/api/portal/testimonials.ts`; no notifications module in the CF tree |
| G7 | **m6** the rate limiter is consumed before validation | **CONFIRMED** | a malformed submit burns a slot |
| G8 | **M3** in `invited.jsonl` | **CONFIRMED** | 1 bad line → a **genuinely invited client is denied a sign-in link** (`allowed:false`) while the owner still gets the normal generic `200` — a silent total lock-out |
| G9 | **M3** in `reviews.jsonl` | **CONFIRMED** | 1 bad line → the one-click approve answers **404 "review not found"** — the owner can never approve a quote |
| G10 | **m6** snooze/decline are not rate-limited | **CONFIRMED** | 8 snoozes → 8×`200` and **8 new lines** appended to the append-only log |

### Group H — auth invariants (P-7, §2.2, §2.6)

| ID | Check | Result | Evidence |
|---|---|---|---|
| H1 | **P-7 no enumeration**: an unknown e-mail gets the *same* generic answer and **no token** | **PASS** | identical message; 0 tokens issued |
| H2 | a magic-link token is **single-use** | **PASS** | 2nd verify → `400` |
| H3 | the session cookie is `HttpOnly; SameSite=Strict; Max-Age=…` | **PASS** | cookie attributes read back |
| H4 | over plain http the cookie carries **no `Secure`** flag | **PASS** (see D8) | |
| H5 | every body-bearing response declares the **correct `Content-Length`** | **PASS** | declared bytes == body bytes |

### Group BUILD — the publish pipeline and a real build

| ID | Check | Result | Evidence |
|---|---|---|---|
| BUILD-1 | the pre-withdrawal store builds the site | **PASS** | `npm run build` exit 0, "Complete!" |
| BUILD-2 | the approved named quote renders with the name and the **“✓ Verified client”** badge | **PASS** | rendered in `dist/index.html` |
| BUILD-3 | a `p2=false` quote renders **without** a name and **without** a badge | **PASS** | no name/company in the page; badge count == number of named quotes |
| BUILD-4 | the rendered quote set is **exactly** the publishable set | **PASS** | 5 published / 7 withheld — every withheld quote absent |
| BUILD-5 | the empty-state copy is absent while quotes exist | **PASS** | |
| BUILD-6 | the build emits **no** “collection does not exist or is empty” warning | **PASS** | 0 warnings |
| BUILD-7 | **CONTROL**: the not-yet-withdrawn quote *is* published before the withdrawal | **PASS** | proves BUILD-10 is a real before/after, not an artefact |
| BUILD-8 | the published frontmatter honours p1/p2 (`verified: true/false`, name present/absent) | **PASS** | frontmatter inspected |
| BUILD-9 | the store with the withdrawal builds the site | **PASS** | exit 0 |
| BUILD-10 | **the withdrawn quote is GONE from the fresh build** (RP-6.4 / RP-6.5) | **PASS** | the quote text and the published `.md` are both absent |
| BUILD-11 | the card count after the withdrawal matches the publishable set | **PASS** | 4 cards == 4 publishable |
| BUILD-12 | the published markdown files match the publishable refs | **PASS** | 4 files |
| BUILD-13 | no empty-collection warning in the second build | **PASS** | 0 warnings |
| BUILD-14 | a site with **no moderation store at all** (fresh clone) builds quietly and shows the empty state | **PASS** | exit 0, empty-state copy shown |

### Repo-level gates (run in the repo, current HEAD)

| Gate | Result |
|---|---|
| `npm run typecheck:api` | **exit 0** |
| `npm run build` | **exit 0** — 22 pages, no warnings in the output |
| `npm run check` (astro check) | **exit 0** — 0 errors, 0 warnings, 10 hints |
| `npm run test:store` | **22/22** |
| `git status` before vs after all runs | **identical** — the repo was not modified by any test |

---

## 3. Defects (open, not fixed by me)

Severity follows the Code Reviewer's scale so the two reports can be read side by side. **I reproduced every one of these against the real handlers** — none is a reading-only claim.

| # | Severity | Defect | Where | Repro / evidence | Owner |
|---|---|---|---|---|---|
| **D1** | **MAJOR** | **The identity of a client who withheld naming consent is persisted** (`p2=false` still stores `name`, `company`, `role`, `email`). The published site is correct; the store and the moderation e-mail are not. | `api/portal/testimonials.ts:444-447` · CF twin | G1 — `p2=false` → stored `email/name/company/role` all present. | Backend |
| **D2** | **MAJOR** | **`session.email` is written into a file that `git add .` will commit.** `site/data/moderation/` is deliberately not ignored (the publisher reads it), and nothing ever reads `record.email` back. | `api/portal/testimonials.ts:445` · `.gitignore` | G2 — `git check-ignore` → exit 1, and the record carries the e-mail. | Backend |
| **D3** | **MAJOR** | **One malformed JSONL line silently disables whole collections.** 6 of 7 readers use `.map(JSON.parse)` with no per-line guard; the outer `catch` returns `[]`, so the API answers “empty” instead of “broken”. Reproduced in **three** stores: `projects.jsonl` (list → 0 projects, PATCH → 404), `invited.jsonl` (a genuinely invited client is **locked out** while the owner sees a normal `200`), `reviews.jsonl` (one-click approve → 404 — **the owner can never approve a quote**). | `api/portal/{projects,auth,invites,comments,plan-items,updates}.ts`, `api/moderate/review.ts` | G3, G8, G9. | Backend |
| **D4** | **MAJOR** | **The sign-in token is written to the server log in plain text whenever `RESEND_API_KEY` is missing — with no `APP_ENV` guard.** The handler's default is `production`, so a misspelled key in production logs a live bearer credential and the live verify URL. | `api/portal/auth.ts:187-199` · CF twin | G4 — a 178-char token in stdout with `APP_ENV` unset. | Backend |
| **D5** | **MAJOR** | **The one-click approve link approves a different revision than the owner was shown.** The signature covers `ref|decision|ts` but not the revision; the handler flips the newest line for the ref. Links live 7 days and the client has a “Change my feedback” button. | `api/moderate/review.ts:130-151` · `api/lib/notifications.ts:111` | G5 — owner shown rev 1, link approved rev 2. | Backend |
| **D6** | **MAJOR** | **The Cloudflare twin never notifies the owner.** No `notifyReviewSubmitted`, no notifications module in the CF tree → a submitted quote sits `pending` forever and nobody knows it exists. Masked today by the `501`, fatal the moment CF is live. | `site/functions/api/portal/testimonials.ts` | G6 (static — see §4). | Backend |
| **D7** | **MINOR** | **The submit rate limiter is consumed before validation, and snooze/decline are not rate-limited at all.** Five malformed posts lock a client out for an hour; eight snoozes append eight lines to the append-only log. | `api/portal/testimonials.ts:383` | G7, G10. | Backend |
| **D8** | **MINOR** | **The moderation link host is resolved from a different variable than the portal base URL** (`SITE_URL` vs `SITE_BASE_URL`), so with only `SITE_BASE_URL` set the owner's approve/reject links point at `https://www.imk.example` and 404. Related: with both unset the origin falls back to `http://localhost:4321` — every state-changing call then answers `403 origin required`, and the session cookie is issued **without `Secure`**. | `api/lib/notifications.ts:83` · `api/portal/session.ts:91-97` | H4 confirms the missing `Secure`; the host mismatch is a static read (not executed). | Backend |

### 3.1 Observations (not defects — recorded so nobody re-investigates them)

- **The published name prefers the client's own `displayName`** over the owner's client record (`displayName || record.name`). Design consequence worth knowing: if the owner later corrects a typo in the client record, the published quote keeps the client-supplied name. The client is entitled to that choice; the owner should know it exists.
- **The withdrawal line carries no quote text** (`review: ""` on a decline). The log keeps the quote on the earlier revision, so nothing is lost — but a reader of the log sees an empty quote on the final line.
- **The client view does not expose the revision number**, so the client UI cannot show which revision it is editing. Informational.

---

## 4. Limits of this verification (unverified — stated, not assumed)

1. **The Cloudflare runtime was not exercised** — no `wrangler`/`wrangler pages dev` run. D6 is a static finding (code reading of the twins against the Vercel handlers), matching the Code Reviewer's own limit. D6 will bite on the Cloudflare target only.
2. **No real browser run.** I drove the HTTP contract directly, so component behaviour, client-side validation and the visual result were not exercised in a browser. The Frontend Developer's browser evidence stands on its own and is not re-verified here.
3. **No live e-mail and no Turnstile.** `RESEND_API_KEY` was a stub and the Turnstile secret was unset, so I verified *that the right call is made and the right payload is built*, not that Resend accepts it or that Turnstile passes. The Resend **sender identity** remains open (not my call).
4. **The storage migration is not started** (Turso/Neon/D1 still undecided), so every JSONL behaviour in D3 is still live code, and the launch blocker is unchanged.
5. **Only the reviews/testimonials feature was tested.** The portal's other endpoints (`plan-items`, `updates`, `comments`) were read but not exercised; `plan-items`/`updates`/`comments` share the unguarded-reader pattern flagged in D3.
6. **Timing-dependent paths** (the 15-minute token TTL, the 7-day link TTL) were tested at the boundaries that are reachable without waiting (expired link, future timestamp, token reuse) — not by waiting out the clock.
7. **No performance, load or accessibility testing** was performed; `site/qa/artifacts/lighthouse` holds the earlier Lighthouse evidence, which I did not re-run.

---

## 5. Recommendation

**Reviews/testimonials: functionally PASS, not release-ready.**

The feature meets every acceptance criterion in `spec/08` §4.4/§4.5 that I was able to execute, including the two that matter most and are hardest to get right — **consent is enforced at publish time** and **a withdrawal removes the quote from a fresh build** (with a control proving the before/after). The public door is genuinely closed and nothing is written or mailed through it.

Block the launch of this feature on **D1 + D2** (data protection — one client record, one line, one `.gitignore` entry) and **D3 + D4** (silent total outages and a credential in the logs). **D5** and **D6** are integrity/target issues: D5 before the first real quote is moderated, D6 before Cloudflare is used. D7/D8 can ride along.

Recommended order: **D1+D2 → D3 → D4 → D8 → D5 → D6 → D7.**

Re-test after the fixes with the same two harnesses — they are deterministic and need no manual steps.

---

*Report produced by QA Engineer — Testing and Verification. All 94 checks were executed; none is proposed-only. The repo was not modified by the verification itself — the only additions are the two harness scripts and the redacted results file listed in §1.1.*
