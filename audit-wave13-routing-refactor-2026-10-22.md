# Independent audit — wave 12 + the wave-13 routing refactor

**Audit date:** 2026-10-22 (tree read at 09:09–09:40 Europe/Kiev)
**Auditor:** Code Reviewer — Independent Audit
**Tree audited:** `C:\Users\Kalch\Documents\IXI` (working tree as found, HEAD `a882606`)
**Read-only:** yes. The only file I created is this report. No product, test, doc or harness
file was touched; no git write command was run; every mutation probe ran on a copy in
`C:\Users\Kalch\AppData\Local\Temp\opencode\`.

---

## 1. What I executed (my own evidence, not the author's)

| Gate | Command | Result |
|---|---|---|
| Type check | `npm run typecheck:api` | **exit 0** |
| Route/function gate | `npm run check:routes` | **16 route(s), 0 missing; `api/` holds 7 .ts files; 11 rewrites agree; exit 0** |
| Store contract | `npm run test:store` | **72 pass / 0 fail** (27 `file:`, 34 `libsql:`, 11 other) |
| Wave-10 harness | `node backend-wave10-store-integrity-harness.mjs` | **42/42** (H1–H10, 5 mutation probes) |
| QA runner | `powershell -NoProfile -ExecutionPolicy Bypass -File site\qa\run-all-suites.ps1` | **16/16 suites exit 0**; transcript `site/qa/artifacts/qa-full-run-2026-10-22-091042.txt`; **20/20 anchor proofs** |

Plus three probes I wrote for this audit (temp directory only):

* `probe-vercel-routing.mjs` — runs Vercel's **own** `@vercel/routing-utils@6.6.0`
  `convertRewrites()` over the repo's real `vercel.json`, then applies the platform's
  documented query merge.
* `probe-routing-layer.mjs` — bundles the **real** `api/portal.ts` with esbuild and calls it
  with the `req.url` the platform would produce.
* `probe-publisher.mjs` — runs the **real** `site/scripts/publish-testimonials.mjs` on copies.

Everything else below is labelled *read-only* where that is all I did.

---

## 2. Verdicts

### 2.1 The wave-12 claims

| Claim | Verdict | Evidence |
|---|---|---|
| **recordId identity scope, both adapters** | **CONFIRMED CORRECT** | `site/shared/portal-store/file-adapter.ts:284-286` (identity scope) + `:295-297` (revision scope); `site/shared/portal-store/libsql-adapter.ts:554-558` (both clauses inside the statement) `:572-573` (args) `:610-612` (the "the record moved" answer). The libSQL write is **atomic**: one `UPDATE … WHERE seq = (SELECT seq …) AND state='pending' AND revision = ? AND json_extract(data,'$.recordId') = ?` (`libsql-adapter.ts:576-586`). The handler carries both scopes: `api/moderate/review.ts:350-358` and `:407-414`. |
| **platform-address order** | **CONFIRMED CORRECT** | `site/shared/server/platform-address.ts:78-101`: `cf-connecting-ip` only when `TRUST_CF_CONNECTING_IP` is truthy (`:111-114`), then `x-real-ip`, then the last hop of `x-vercel-forwarded-for`, then the last hop of `x-forwarded-for`, then the per-instance bucket. Used by `site/shared/portal-handlers/portal-auth.ts:178-186`, by `api/contact.ts:301-306` (also the Turnstile `remoteip`), and by the CF twin `site/functions/api/portal/auth.ts:206-209` with `trustCfConnectingIp: true` (correct — CF overwrites the header). |
| **`api/lib/jsonl.ts` deleted, zero product importers** | **CONFIRMED** | `api/lib` does not exist on disk. No product file imports `lib/jsonl`; the only remaining references are the shared store module (`site/shared/portal-store/jsonl.ts`), QA's frozen fixture and comments. |
| **publisher guards (wave 11 + wave 12 B-4)** | **CONFIRMED, independently executed** | see §3.3. |

### 2.2 The wave-13 refactor — the Manager's five questions

| Question | Verdict | Evidence |
|---|---|---|
| **Is the resolver fail-closed?** | **YES** | `site/shared/portal-router.ts:129-152`: unknown path → `not-found` (404); entry prefix with no route → `route-resolution` (**500, loud**); a carrier that names nothing in the family → 404 (`:141-143`). Executed: an unknown path is a 404, the bare entry point is a 500 `{code:'route-resolution'}`, and a forged cross-family carrier is a **404** (my probe case F) — the two families really are disjoint. A handler missing from the bundle is a loud 500 `{code:'internal'}` (`api/portal.ts:125-139`). |
| **Does the route table cover every public URL?** | **YES** | `check:routes` → 16/16. I listed the client's API calls independently (`site/src/pages/portal.astro:448,514-516,620-646,662,686,732,782,804,854,872`; `admin.astro:371,402`; `PortalTestimonialPrompt.astro:431,530,565`; `login.astro` → `/api/portal/auth/request-link`; `pricing.astro` → `/api/contact`) and every one of them maps to a table entry. The moderation link (`/api/moderate/review`) is a standalone route. |
| **Does the rewrite carrier preserve query strings?** | **YES — confirmed from Vercel's own implementation and executed end-to-end** | Vercel's `convertRewrites()` produces exactly `dest = /api/portal?__imk_route=%2Fapi%2Fportal%2Fprojects%2F$1&id=$1` for the dynamic routes (`:id` **is** substituted inside the destination's query string), and the platform merges the original query into the destination query. Executed: `GET /api/portal/plan-items?projectId=prj_probe1` arrives at the handler as `/api/portal/plan-items?projectId=prj_probe1` and answers `200 {ok,planItems}` — the `projectId` survives, and `rebuildRequestUrl` (`portal-router.ts:165-176`) strips only the carrier. |
| **Do both trees still agree?** | **YES for behaviour, NO for file headers** | Wave-12's identity change is present in the CF tree (`site/functions/api/portal/testimonials.ts:591,655`; `site/functions/api/moderate/review.ts:256-266,326,384-386`; `site/functions/api/lib/notifications.ts:103-150,188-189`) exactly as in the Vercel tree; the CF inbox is `501 {code:'unimplemented'}` with the gates in front (`site/functions/api/admin/reviews.ts:45-93`). Six CF files carry a **corrupted path comment** — see finding **m-4**. |
| **Are the QA pins still non-vacuous?** | **YES for 20/20 anchor proofs — but one pin (R9) tests a shape production never produces** | `site/qa/qa-anchor-nonvacuity.mjs` → 20/20, including the new `P1-half-identity` proof (the third layer is load-bearing on its own). The routing suite has 3 mutation probes. **But** `site/qa/qa-wave13-routing.mjs:541-558` (R9, "the PATH wins over the carrier") calls the entry point with the *resolved* path `/api/portal/projects?__imk_route=…`, which is a shape the platform never produces — after the rewrite the path is `/api/portal`. See finding **M-1**. |

---

## 3. Findings

### M-1 — MAJOR — on the deployed target the client chooses the handler; the router's stated hardening does not hold

**Where:** `site/shared/portal-router.ts:36-46` (the comment *"a client cannot smuggle a
different handler in with a forged carrier"*), `:129-144` (rules 1 and 2),
`api/portal.ts:78-85` + `:100-105`, `vercel.json` (11 rewrites).

**Observed behaviour (executed).** I ran Vercel's own routing implementation over the repo's
`vercel.json` and applied the platform's query merge
(`vercel/vercel` → `packages/cli/src/util/dev/router.ts`:

```js
const destQuery = parseQueryString(destSearch);
Object.assign(destQuery, reqQuery);   // the ORIGINAL request query wins
```

), then called the **real** `api/portal.ts` with the resulting `req.url`:

| # | client sent | `req.url` the function saw | who answered |
|---|---|---|---|
| A | `/api/portal/projects/prj_probe1` | `/api/portal?__imk_route=%2Fapi%2Fportal%2Fprojects%2Fprj_probe1&id=prj_probe1` | 200 `{ok,project}` ✔ |
| B | `/api/portal/projects` | `/api/portal?__imk_route=%2Fapi%2Fportal%2Fprojects` | 200 `{ok,projects}` ✔ |
| C | `/api/portal/plan-items?projectId=prj_probe1` | `…&projectId=prj_probe1` | 200 `{ok,planItems}` ✔ (query survives) |
| **D** | `/api/portal/projects/prj_probe1?__imk_route=%2Fapi%2Fportal%2Fsession` | `/api/portal?__imk_route=%2Fapi%2Fportal%2Fsession&id=prj_probe1` | **200 `{ok,authenticated,role,email,expiresAt}` — the SESSION handler answered a projects request** |
| **E** | `/api/portal/session?__imk_route=%2Fapi%2Fportal%2Fprojects` | `/api/portal?__imk_route=%2Fapi%2Fportal%2Fprojects` | **200 `{ok,projects}` — the PROJECTS handler answered a session request** |
| F | `…__imk_route=%2Fapi%2Fadmin%2Freviews` | — | 404 ✔ (the family separation holds) |

**Why.** After the rewrite the request path is the *entry prefix* (`/api/portal`), so rule 1
never matches and rule 2 (the carrier) always decides. The platform merges the **client's**
query over the destination query, and `__imk_route` is a plain query parameter — so the
client's value replaces the platform's. The "path wins over the carrier" rule only protects the
case where the platform did **not** rewrite (the local dev server, `site/scripts/dev-portal.js:131`,
matches by path and never exercises the carrier).

**Impact on the owner's launch.** *No privilege escalation today, and I want to be precise
about that:* every portal handler enforces its own session, role, method and origin gate
(`portal-comments.ts:107,129`; `portal-invites.ts:227-242`; `portal-plan-items.ts:107-144`;
`portal-projects.ts:135-178`; `portal-testimonials.ts:369-449`; `portal-updates.ts:107-170`),
and the carrier can only name a handler **of the same family** (the admin family is
unreachable from the portal entry point — case F). So a forged carrier changes *which handler
answers*, never *what the caller may do*. What it does cost:

1. **A security property stated in shipped code is false.** A maintainer reading
   `portal-router.ts:36-46` will rely on "a client cannot smuggle a different handler in".
2. **A QA check pins a fiction.** R9 (`qa-wave13-routing.mjs:541-558`) asserts the path wins
   over the carrier — true only for a shape production never produces, and its "non-vacuity"
   is therefore proof of the wrong thing.
3. **Latent risk**: the moment a route is added to a family whose gate is weaker than a
   sibling's, the reachability of that route stops being tied to its URL. Today every route is
   publicly reachable anyway, so nothing is gained — but the safety net is gone.

**Recommended fix** (in order of cost):

* **Cheap and correct — fix the claim and the pin.** Rewrite `portal-router.ts:36-46` to state
  the invariant that actually holds: *the carrier can only name a handler of the same family,
  and every handler enforces its own authorisation, so a forged carrier changes which handler
  answers, never what the caller may do.* Then re-pin R9 to the **deployed shape**: call the
  entry point with `req.url = /api/portal?__imk_route=…` (the entry prefix), assert that a
  forged carrier *does* change the handler, and assert that the handler's own gate still
  refuses. Keep the cross-family check (F) as the real security assertion.
* **Robust — drop the carrier.** A Vercel dynamic route (`api/portal/[...route].ts`) receives
  the **original path intact** in `req.url`: no rewrite, no carrier, no query merge, nothing
  for a client to forge. That also removes 11 rewrites. It needs one verification I could not
  do offline: that the static `api/portal/auth/*.ts` files still win over the splat route, and
  that a Vercel splat route may not also match `/api/portal/auth/*`.
* **Not available:** `missing` on a `rewrites` entry. The Vercel JSON schema
  (`https://openapi.vercel.sh/vercel.json`) gives `missing` to `headers` and `redirects` but
  **not** to `rewrites`, so "apply the rewrite only when the client did not send
  `__imk_route`" cannot be expressed in the high-level format.

**One honest caveat.** The merge rule above is Vercel's own routing implementation
(`@vercel/routing-utils@6.6.0` plus the `vercel dev` router), which is the reference
implementation of the same `routes` format the platform consumes — **I did not observe it on a
live deployment.** If the production proxy resolves the merge the other way (destination wins),
then the platform's carrier wins, the router's claim holds on the deployed target, and the
remaining defect is only that R9 and the dev server test a shape production never produces.
**Settling this costs one preview deployment and one `curl`** — worth doing before wave 14
touches the routing layer.

---

### m-2 — MEDIUM — `check-api-routes.mjs` crashes instead of naming the missing route

**Where:** `site/scripts/check-api-routes.mjs:304` and `:309` push a report row with
`missingReason` but **without** `files`; the printer at `:331-333` then reads `row.files.vercel`.

**Observed (executed on a copy).** Deleting one handler module
(`site/shared/portal-handlers/portal-comments.ts`) and running the gate:

```
TypeError: Cannot read properties of undefined (reading 'vercel')
    at .../site/scripts/check-api-routes.mjs:331:28
```

**Verdict:** this is QA's finding from wave 13, and it is **still open** — DevOps ran
`check:routes` on a healthy tree, so the crash never fired. It **fails closed** (exit 1), so
the deploy gate is not defeated; but the owner gets a stack trace instead of *"the handler
module site/shared/portal-handlers/portal-comments.ts is missing"*, and the crash happens
**before** the function-budget check and the rewrite↔table check, so those diagnostics are lost
too.

**Fix:** push `files` on those two rows as well (one line each), e.g.
`rows.push({ pattern, files: { vercel: null, cloudflare: null }, missingReason: … })`.

---

### m-3 — MEDIUM — the route table is not enforced against the entry point's handler map

**Where:** `site/shared/portal-routes.json:67-80` (table handler → module),
`api/portal.ts:52-60` and `api/admin.ts:38-42` (the `HANDLERS` maps the entry points actually
import), `site/scripts/check-api-routes.mjs:299-316`.

**Observed (executed on a copy).** I added one route to the portal family whose handler module
exists but is **not imported** by `api/portal.ts` (`"/api/portal/evil": "admin-reviews"`) plus
the matching rewrite. The gate said:

```
[check-api-routes] 16 route(s), 0 missing function file(s)
[check-api-routes] 12 rewrite(s) agree with the route table (2 families)
[check-api-routes] OK: every called path has a function file … exit 0
```

…and at runtime the route answered:

```
{"outcome":"route_handler_missing","entry":"/api/portal","handler":"admin-reviews"}
500 {error,code}
```

So a table entry the entry point cannot serve **passes the build gate** and breaks in
production with a 500. It fails closed at runtime (loud, logged), which is why it is MEDIUM and
not MAJOR — but the route table is advertised as "one machine-readable source of truth … so it
can never disagree with itself" (`portal-routes.json:4-14`), and today nothing checks the one
disagreement that matters: *the table names a handler the entry point does not import.*

**Fix:** in `check-api-routes.mjs`, parse the `HANDLERS` map out of each entry point
(`api/portal.ts`, `api/admin.ts`) and fail when the table names a handler that is not in it.

---

### m-4 — MINOR — six Cloudflare files carry a corrupted path in their header comment

**Where (all line 1):** `site/functions/api/admin/reviews.ts`, `site/functions/api/admin/session.ts`,
`site/functions/api/lib/notifications.ts`, `site/functions/api/lib/rate-limit.ts`,
`site/functions/api/portal/session.ts`, `site/functions/api/portal/testimonials.ts`.

Each now reads e.g.

```
// site/functions/site/shared/portal-handlers/portal-session.ts — Cloudflare Pages Function …
```

— the wave-13 bulk move replaced the path **inside** the path. The actual file is
`site/functions/api/portal/session.ts`. QA reported one of the six; there are six.

**Comment-only — no code is affected.** I checked the encoding of the whole tree as part of
this audit (the Backend reported a `Get-Content`/`Set-Content` ANSI round trip during wave 13
and claims a lossless repair): **282 source files checked, 0 problems** — every file is valid
UTF-8, byte-for-byte round-trips, and contains no replacement character. The repair was
lossless. Only these six header comments are wrong.

---

### m-5 — MINOR — `DEPLOY.md:68` cites the wrong lines for the publisher's swap

`DEPLOY.md:68` says the published set is *"built in a staging directory and swapped in with
crash-safe recovery (`:621-657`)"*. Lines 621-657 of `site/scripts/publish-testimonials.mjs` are
the **schema-less-database branch** of `readReviewsFromDatabase`. The swap and its recovery are
at **`:736-830`**: `recoverInterruptedSwap()` `:736`, the staging directory `:803`, the two
renames `:822` and `:824`, the rollback `:828`. (The other citation on that line —
`readReviewsFromStore()` at `:669` — is **correct**.) DevOps's file.

---

### m-6 — MINOR — `DEPLOY.md:244` and `:248` carry a stale `test:store` breakdown

Both lines say *"72/72 contract tests: 24 file, 31 libsql, 11 shared, 6 more shared"*. The total
is right; the split is not. Measured from `npm run test:store`: **27** assertions named
`file:`, **34** named `libsql:`, **11** neither — 27+34+11 = 72. The 24/31 figures are from
before wave 12 added the identity assertions to both adapters. DevOps's file.

---

### m-7 — MINOR (observation) — `DEPLOY.md` does not name the nine portal URLs it now serves

`DEPLOY.md:64-65` says the entry points route "nine `/api/portal/*` URLs" and "two
`/api/admin/*` URLs" without listing them; of the sixteen public URLs the document names only
`/api/admin/session`, `/api/admin/reviews`, `/api/contact`, `/api/moderate/review`,
`/api/portal/auth/request-link`, `/api/portal/auth/verify`, `/api/portal/projects` and
`/api/portal/session`. The nine names live in `site/shared/portal-routes.json:28-50`. Not a
defect — the machine check (`check:routes`) is exhaustive — but it is the table an owner would
read before a launch, and it now describes a tree it no longer matches one-for-one.

---

## 4. The finding I was handed: the publisher and the empty store

**The defect as described was real, and it is now closed.** I reproduced the wave-11 fix
independently on copies of the real publisher (probe P1–P4, temp directory):

| case | store | published set | exit | published afterwards | verdict |
|---|---|---|---|---|---|
| P1 | **empty** (0 bytes) | 1 quote | **1** | `["quote1.md"]` | ✔ refused, the quote survived |
| P2 | **empty** (0 bytes) | none | **0** | `[]` | ✔ a fresh install still builds |
| P3 | 1 record, **no `type:'review'`** | 1 quote | **1** | `["quote1.md"]` | ✔ wave-12 B-4 rule holds |
| P4 | 1 approved review record | 1 quote | 0 | rebuilt | ✔ the normal path still works |

The guard is one rule applied in one place — `assertStoreIsNotEmpty()`
(`site/scripts/publish-testimonials.mjs:293-304`), called from `readReviewsFromStore()` `:698`
— so the file path and the libSQL path cannot disagree.

**Residual boundary (by decision, not a defect).** The guard counts **review records**, not
*publishable* records. A store whose only review record lacks the publish consent empties the
published set and exits 0 (that is P4's sibling: `skippedNoConsent: 1`, `written: 0`). That is
the intended semantics — the published set mirrors the store — and it is the Manager's wave-12
decision. Recording it only so it is not rediscovered as a surprise.

**Siblings of the same class: none found.** I looked for the same shape elsewhere — "a missing
thing reads as an empty thing" — in the store access layer, the CF tree and the rate limiter.
The reachability guards are in place (`site/shared/server/portal-store-access.ts`, the 501
answers in `api/moderate/review.ts:307-322` and `site/functions/api/admin/reviews.ts:83-93`),
and the publisher is now the only place where an empty store can legitimately mean "nothing to
publish".

---

## 5. Things I checked that are CORRECT (recorded so they are not re-litigated)

* **The libSQL write is atomic.** The decision is one `UPDATE` with the revision and identity
  predicates **inside** the statement (`libsql-adapter.ts:576-586`); a concurrent append either
  lands before the statement (the `seq = (SELECT seq …)` sub-select then names a different row
  and nothing is updated) or after it. There is no read-then-write window in the write path.
  (The `SELECT` at `:597-602` runs only **after** the `UPDATE` updated nothing, to tell the
  caller which of the four failure reasons applies.)
* **A revision number is no longer the identity.** `record-id.ts` assigns the identity in the
  store (`file-adapter.ts:197`, `libsql-adapter.ts:410`), the caller cannot choose it, and the
  signed link carries it (`site/shared/server/moderation.ts:124-131`, `notifications.ts:140-159`).
  A **stripped** link is refused: without `recordId` the signed message changes shape
  (`notifications.ts:144-146`) and the signature no longer matches. **H3 proves it**; I read the
  same code path.
* **Both trees carry the identity.** Vercel: `site/shared/portal-handlers/portal-testimonials.ts:705`,
  `site/shared/portal-handlers/admin-reviews.ts:258-269`, `api/moderate/review.ts:178,273,295,350,374,413`.
  Cloudflare: `site/functions/api/portal/testimonials.ts:591,655`,
  `site/functions/api/moderate/review.ts:256-266,326,384-386`,
  `site/functions/api/lib/notifications.ts:103-150,188-189`.
* **The CF inbox is honest.** 501 `{code:'unimplemented'}` with the owner gate (401) and the
  configuration gate (500) **in front of it** (`site/functions/api/admin/reviews.ts:45-93`).
* **The rate-limit bucket key is platform-controlled on Vercel.** `cf-connecting-ip` is only
  trusted behind an explicit `TRUST_CF_CONNECTING_IP=1`; the default order is `x-real-ip` →
  last hop of `x-vercel-forwarded-for` → last hop of `x-forwarded-for` → per-instance bucket.
  H4/H5 (42/42) prove a rotating `cf-connecting-ip` no longer buys a fresh bucket, and the
  mutation proves the probe bites.
* **The 7-function budget is real.** `api/` holds exactly 7 `.ts` files; `check:routes` enforces
  `<= 12` (`check-api-routes.mjs:344-355`).
* **The tree is free of encoding damage.** 282 source files checked: valid UTF-8, lossless
  round-trip, no replacement characters (see m-4 for the six comment-only path defects).

---

## 6. UNVERIFIED — stated plainly

* **No real Turso was contacted.** The libSQL evidence in this repo is a real SQLite engine
  driven over the real wire protocol; I did not contact Turso and did not re-derive that proof.
* **No Vercel router was booted.** The rewrite→destination conversion and the query merge come
  from Vercel's own routing implementation (`@vercel/routing-utils@6.6.0` +
  `packages/cli/src/util/dev/router.ts`), executed offline against the repo's `vercel.json`.
  **They are not an observation of production.** No preview deployment was made and `vercel dev`
  was not run.
* **No workerd booted.** The Cloudflare tree was read and compared; the only execution evidence
  for it is QA's `qa-cf-parity.mjs` (exit 0 in the transcript above).
* **No deploy, no live mail.** No Vercel/Cloudflare runtime served a request; no email was sent.
* **The libSQL path was not exercised concurrently at the HTTP level.** The atomicity argument
  is a code argument plus a single-threaded statement; I did not run two writers against a live
  database.
* **The publisher never ran against the repository's own published directory** — my P1–P4 run on
  copies in temp, deliberately, because the brief forbids touching `site/data/**`.
* `astro check` was **not** re-run by me (QA's transcript covers it: 0 errors / 0 warnings / 11 hints).
* The dev server on port 4321 still runs the pre-wave-13 bundle; that is outside my scope and
  outside the repo's control from here.
* **My probes live in a temp directory** (`C:\Users\Kalch\AppData\Local\Temp\opencode\vru\`:
  `probe-vercel-routing.mjs`, `probe-routing-layer.mjs`, `probe-publisher.mjs`, `patch-table.mjs`)
  and may be cleaned. They are reproduced in enough detail above to be re-created; the report
  deliberately adds no file to the repository.

---

## 7. Recommended order of work

1. **Settle the merge order** (one preview deploy + one `curl` with a forged `__imk_route`).
   It decides whether M-1 is a broken hardening claim or only a mis-pinned check.
2. **M-1** — correct `portal-router.ts:36-46` and re-pin R9 to the deployed shape (both cheap;
   neither touches the behaviour of a route).
3. **m-2** — the one-line fix in `check-api-routes.mjs` (the deploy gate's diagnostic).
4. **m-3** — check the table against the entry points' `HANDLERS` maps in `check-api-routes.mjs`.
5. **m-4 / m-5 / m-6 / m-7** — the six CF header comments and the three DEPLOY.md corrections
   (DevOps's and the Backend's files, not mine).
6. Optional, larger: the splat-route design (`api/portal/[...route].ts`) that removes the carrier
   altogether — a wave-14 design question, not a wave-13 patch.

---

**Bottom line.** The wave-12 work is sound: the identity scope is real, atomic and enforced in
both adapters; the address rule is right on the launch target; the dead function is gone; and
the publisher's empty-store data-loss class is closed in both store modes — I re-proved all four
states by execution. The wave-13 refactor does what it claims: 7 functions, 16 URLs, a fail-closed
resolver, the query string survives the rewrite, both trees agree, and 20/20 anchor proofs bite.
**One MAJOR finding stands against it** (M-1: on the deployed target the client chooses the
handler, and the code claims otherwise), plus two MEDIUMs in the build gate itself. None of them
breaks a URL for the owner today; one of them (M-1) means the safety net the code advertises
is not the one that is actually there.
