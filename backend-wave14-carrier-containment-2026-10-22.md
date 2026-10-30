# Wave 14 — Backend: carrier containment, and the two gaps in the deploy gate

**Verdict: DONE**
**Report:** `C:\Users\Kalch\Documents\IXI\backend-wave14-carrier-containment-2026-10-22.md`
**Harness:** `C:\Users\Kalch\Documents\IXI\backend-wave14-carrier-containment-harness.mjs` (new, repo root) — **24 checks, 24/24 PASS**, 4 of the 5 probes redden.
**Date:** 2026-10-22 · **Repo:** `C:\Users\Kalch\Documents\IXI` · no git write command was run.

---

## 0. Summary

| Item | Item | Status |
|---|---|---|
| **F1 MAJOR** | the router shipped a hardening claim nobody had proven | **CLOSED** — the false claim is deleted; the comment now states the three invariants that hold under *either* merge order, and says plainly that the merge order is unobserved. One behaviour change, reported below, that makes the family containment a property of the code and not only of the table's shape. |
| **F2 MEDIUM** | the deploy gate crashed instead of naming the miss | **CLOSED** — reproduced by execution, then fixed; the gate now prints the missing entry point / handler module and exits 1 with no stack trace. |
| **F3 MEDIUM** | the deploy gate missed an unservable route | **CLOSED** — reproduced by execution (the gate exited **0**), then fixed; the gate now compares the route table with the entry points' `HANDLERS` maps and names the route. |
| **F4 cosmetic** | six Cloudflare header comments named a path that does not exist | **CLOSED** — comment text only. |

**Two QA suites are now red, and BOTH reds are the signals QA designed for wave 14** (§5). They need a QA re-pin; I did not touch `site/qa/**`.

---

## 1. F1 — the router's hardening claim (MAJOR)

### 1.1 What was wrong

`site/shared/portal-router.ts:36-46` (the wave-13 text) claimed:

> *"a request whose path IS in the table is always served by the handler for THAT path — a client cannot smuggle a different handler in with a forged carrier"*
> *"the carrier is validated against the table, so it can never name a path outside the family"*

On the deployed target the `vercel.json` rewrite **replaces the path** with the entry prefix, so the path no longer identifies the route and `__imk_route` decides it. The Code Reviewer executed the merge with Vercel's own routing code: `GET /api/portal/projects/prj_x?__imk_route=…/session` made the **session** handler answer. Which side of the merge wins — the platform's carrier or the client's query — is **unobserved** (no Vercel router was booted), so the shipped comment stated a hardening that nobody had proven.

### 1.2 What I changed

**`site/shared/portal-router.ts:36-40`** — "WHY THE PATH IS CHECKED FIRST" now states only what is true: the path is checked first, so a request whose path is in the table is served by the handler for that path. The false claim is gone.

**`site/shared/portal-router.ts:42-87`** — new section "WHAT A FORGED CARRIER CAN DO, AND WHAT IT CANNOT":

* `:44-50` — the rewrite replaces the path, so the carrier decides it; **"WHICH SIDE WINS … IS NOT OBSERVED"** — the merge order is taken from the platform's routing implementation and its documentation, not from an observed production request.
* `:52-73` — the three invariants that hold **either way**:
  1. **FAMILY CONTAINMENT** — an entry point resolves against ONE table, its own family's, and the two tables are disjoint; rule 2 checks the carrier against the entry prefix explicitly.
  2. **THE STANDALONE URLS ARE OUT OF REACH** — `api/contact.ts`, `api/moderate/review.ts` and the three `api/portal/auth/*` files are in **no** family table, so no carrier can name them.
  3. **THE HANDLER AUTHORIZES ITSELF** — `resolveAccess` / `canReadClient` / `canWriteClient` for the client routes, the owner session (role claim **and** the live `ADMIN_EMAILS` allow-list) for the owner routes, the sign-in flow for the auth URLs. A forged carrier cannot grant a capability the handler would not have granted anyway.
* `:75-80` — the honest remainder, stated rather than hidden: the blast radius is bounded by the table and the handler's own gate, **never by the merge order**; what a forged carrier **can** do is select another handler **of the same family**. That is a routing surprise, not an escalation.
* `:82-87` — what wave 14 changed and why.

**`site/shared/portal-router.ts:154-169`** — a new exported helper `isInsideEntry(pathname, entryPrefix)`.
**`site/shared/portal-router.ts:193-210`** — rule 2 now refuses a carrier that is outside the entry point's own prefix.

> **The behaviour change, reported as the brief asks.** For the route table as it stands this check is a **no-op**: every key of the portal table starts with `/api/portal/` and every key of the admin table with `/api/admin/`, so a carrier that resolved before still resolves, and one that did not still does not. **No legitimate request changes behaviour.** What changes is the *shape of the guarantee*: the family containment is now enforced by the code, so a cross-family route added to a table later could not be reached with a carrier. Probe **D1** proves the containment survives a deliberately broken table; probe **D2** proves the new check is load-bearing.

### 1.3 What this does NOT settle

The family containment is **not** a fix for MAJOR-1's core. Under the merge order where the client's query wins, a forged carrier can still select a **different handler of the same family** (`/api/portal/session` instead of `/api/portal/projects`). That remains bounded by the handler's own gate, but it is a routing surprise that only a real Vercel observation (or a preview deploy + one `curl`) can settle. It is listed under §7 UNVERIFIED and needs an owner decision.

---

## 2. F2 — the deploy gate crashed instead of naming the miss (MEDIUM)

### 2.1 Reproduced first (execution, in a throwaway tree)

`site/scripts/check-api-routes.mjs` with `api/portal.ts` removed:

```
TypeError: Cannot read properties of undefined (reading 'vercel')
    at ModuleJob.run (node:internal/modules/esm/module_job:1063:16)
exit code: 1
```

The gate failed closed, but the owner got a stack trace instead of the one line that says what is missing.

### 2.2 The fix

* **`site/scripts/check-api-routes.mjs:354-365`** — the Cloudflare file is resolved **first**, so every row carries a complete `files` object whatever the Vercel branch decides.
* **`:375-386`** — the two missing-entry-point / missing-handler-module branches now push `{ pattern, files, sources, missingReason }` instead of `{ pattern, missingReason }`.
* **`:517-542`** — the verdict grew a **"WHAT IS MISSING:"** block that names the miss per route (`the entry point api/portal.ts is missing`, `the handler module … is missing`) or says which tree has no function.
* **`:47-56`** — the script's own header now records both wave-14 gaps.

### 2.3 Verified

Harness check **E2**: with `api/portal.ts` deleted the gate exits **1**, the output contains **"the entry point api/portal.ts is missing"**, and contains **no `TypeError`**.

---

## 3. F3 — the deploy gate missed an unservable route (MEDIUM)

### 3.1 Reproduced first (execution, in a throwaway tree)

A route added to `site/shared/portal-routes.json` whose handler module name is **not** in `api/portal.ts`'s `HANDLERS` map (with the rewrite and the handler file present, so every other check passed):

```
exit code: 0        ← the gate PASSED an unservable route
```

At runtime that route answers `500 {code:'internal'}` (`route_handler_missing`, `api/portal.ts:125-139`) — a table route the entry point cannot serve.

### 3.2 The fix

* **`site/scripts/check-api-routes.mjs:292-340`** — a new `handlerNamesIn(entryFile)` reads the entry point's `HANDLERS` map **from the source** (the gate runs before any bundle exists). The map is brace-counted and comments are stripped, so a quoted word in a comment cannot be read as a handler name.
* **`:477-513`** — a new check compares the route table with the `HANDLERS` map of every family. On a mismatch it exits 1 and **names the route**: `/api/portal/ghost: api/portal.ts cannot serve it — its HANDLERS map has no 'portal-ghost'`.
* **`:513`** — the success line: `every route of the table is served by its entry point's HANDLERS map`.

### 3.3 Verified

Harness check **E3** (exit 1, route named) and mutation probe **D5** (remove the comparison → the mutant gate exits **0** on the same broken tree → the probe bites).

---

## 4. F4 — the six Cloudflare header comments (cosmetic)

Comment text only, line 1 of each file; `site/functions/site/shared/…` → `site/shared/…`:

| File | Now names |
|---|---|
| `site/functions/api/admin/reviews.ts:1` | `site/shared/portal-handlers/admin-reviews.ts` |
| `site/functions/api/admin/session.ts:1` | `site/shared/portal-handlers/admin-session.ts` |
| `site/functions/api/lib/notifications.ts:1` | `site/shared/server/notifications.ts` |
| `site/functions/api/lib/rate-limit.ts:1` | `site/shared/server/rate-limit.ts` |
| `site/functions/api/portal/session.ts:1` | `site/shared/portal-handlers/portal-session.ts` |
| `site/functions/api/portal/testimonials.ts:1` | `site/shared/portal-handlers/portal-testimonials.ts` |

Verified: **0** remaining `site/functions/site/shared` occurrences in `site/functions/api/**`; all 20 files in that tree are BOM-free UTF-8 (unchanged from before the edit); the em-dashes survived (`read` shows `—` intact on line 1 of each).

---

## 5. The two QA suites that need a re-pin (QA owns these files)

I did **not** touch `site/qa/**`. Both reds below are the signals QA built for this wave.

### 5.1 `qa-wave4-independent.mjs` → **B2b** (the F2 tripwire fired)

QA's own note in the file says:

> *"THIS CHECK IS A TRIPWIRE. It asserts the CURRENT (broken) behaviour. When the Backend fixes the script, this check goes RED — that is the signal to re-pin it to the fixed behaviour and to delete this note."*

and the failure message says *"the route check now NAMES the missing route — the defect in `site/scripts/check-api-routes.mjs` is FIXED: re-pin this check to the fixed behaviour, assert that the report names the missing route, and delete this note"*.

**What QA should re-pin it to:** the same copy, `api/portal/auth/request-link.ts` removed → `res.code !== 0` **and** `res.out.includes('/api/portal/auth/request-link')` must now be **true**, **and** the output must contain no `TypeError`. The new gate prints `the entry point api/portal/auth/request-link.ts is missing` (verified by my check E2 on the sibling case).

### 5.2 `qa-wave13-routing.mjs` → **MP-R3** (my hardening made the probe vacuous)

MP-R3 patches `site/shared/portal-routes.ts` to merge the admin routes into the portal family, and expects **R8** ("a forged carrier cannot cross the families") to go RED.

It no longer goes red, **because the defect it models can no longer occur**: with the explicit entry-prefix check in place, a merged table still cannot be reached with a carrier. This is the wave-12/13 pattern QA already uses — *"the guard has a second layer; the probe must remove both."*

**The re-pin, exactly:**

* keep the existing patch to `site/shared/portal-routes.ts` (anchor: `export const PORTAL_FAMILY: RouteFamily = PORTAL_ROUTE_TABLE.families[PORTAL_FAMILY_PREFIX];`), **and**
* additionally patch **`site/shared/portal-router.ts`**, anchor (4 spaces of indent):

  ```
      if (!isInsideEntry(carrier, entryPrefix)) {
  ```

  replace with:

  ```
      if (false) {
  ```

  (that is `site/shared/portal-router.ts:208`).

With both layers removed the mutant serves the owner route from the portal entry point and R8 goes RED again. The probe then proves something **stronger** than before: not "the table's separation is load-bearing" but "the separation is load-bearing **in the code**".

`site/qa/qa-anchor-nonvacuity.mjs` has **no** MP-R3 / R8 / `isInsideEntry` reference, so it needs **no** re-pin — and it is green (20/20 proofs in the run below).

---

## 6. The harness — `backend-wave14-carrier-containment-harness.mjs`

New file in the repo root. It bundles the two entry points, the resolver and the session module with esbuild, runs them in a child process (JSON in / JSON out, no port bound), and seeds a **sandbox** store — the repository's `site/data` is never read or written.

| Group | Check | What it proves |
|---|---|---|
| **A** — the invariants, read from the tree | A1 | the two family tables are **disjoint** (9 portal routes, 2 admin routes, no overlap) |
| | A2 | the **5 standalone URLs are in no family table** |
| | A3 | `isInsideEntry` — 8 cases, incl. `/api/portalx/anything` **not** inside `/api/portal` |
| | A4 | the router comment claims **no unproven hardening**: the wave-13 wording is gone, and `NOT OBSERVED`, `FAMILY CONTAINMENT`, `DISJOINT`, `STANDALONE URLS ARE OUT OF REACH`, `THE HANDLER AUTHORIZES ITSELF` are all present |
| **B** — the resolver, executed | B1 | a carrier cannot name the **other family's** route (both directions) |
| | B2 | a carrier cannot name a **standalone** URL (5 × 2 entry points) |
| | B3 | **CONTROL** — a carrier *inside* the family still resolves (so B1/B2 are not vacuous) |
| | B4 | **CONTROL** — the path wins over a forged carrier |
| **C** — the entry points, executed (HTTP) | C1 | 4 cross-family forgeries → **404 {code:'not-found'}** at both entry points |
| | C2 | 5 standalone URLs × 2 entry points → **404 {code:'not-found'}** |
| | C3 | a portal-family forgery with no session → **401 {code:'unauthorized'}** |
| | C4 | with a valid **client** session (minted by the product's own `createSession`) → 200, and the client sees **only its own** project |
| | C5 | a forged carrier **cannot widen** a client's scope → **403 {code:'forbidden'}**, the other client's data is not in the body |
| | C6 | an admin-family forgery → **401** for no cookie **and** for a client cookie (a client session is never an owner) |
| | C7 | with a valid **owner** session → 200, the inbox is served |
| | C8 | the carrier parameter is **stripped** from the URL the handler sees (spy handler): the handler saw `/api/portal/testimonials?projectId=prj_1` |
| **D** — the mutation probes (in a COPY, the repo is never modified) | **D1** | *hardening control* — a deliberately **broken table** (the admin route added to the portal family **and** the handler added to `HANDLERS`) is still refused → **404**. The code-level containment holds against a broken table. |
| | **D2** | **RED** — remove the entry-prefix check **and** break the table → the mutant answers **401** (the admin handler ran), the control answers **404** |
| | **D3** | **RED** — stop deleting the carrier from the query → the handler sees `__imk_route=…` |
| | **D4** | **RED** — remove the handler's own scope rule → the mutation **leaks** the other client's project (200 + the data) |
| | **D5** | **RED** — remove the deploy gate's `HANDLERS` comparison → the mutant gate exits **0** on an unservable route |
| **E** — the deploy gate, executed in a throwaway tree | E1 | the gate passes on the real tree: **16 routes, 0 missing**, no `TypeError` |
| | E2 | a missing entry point is **named**, not crashed on |
| | E3 | a table route the entry point cannot serve is **named** |

**Four probes redden (D2, D3, D4, D5) — the brief asked for at least two.** D1 is the control that shows the hardening works, not a probe of a removed fix.

---

## 7. Gates — every one executed by me

| Gate | Result |
|---|---|
| `npm run typecheck:api` | **exit 0** |
| `npm run check:routes` | **16 routes / 0 missing** · `api/ holds 7 .ts files` · `11 rewrites agree` · `every route of the table is served by its entry point's HANDLERS map` |
| `npm run test:store` | **72 pass / 0 fail** |
| `node backend-wave14-carrier-containment-harness.mjs` | **24 / 24**, exit 0 |
| `node backend-wave13-function-budget-harness.mjs` | 22 / 22 |
| `node backend-wave10-store-integrity-harness.mjs` | 42 / 42 |
| `node backend-wave6-harness.mjs` | 24 / 24 |
| `node backend-f1-magic-token-harness.mjs` | 22 / 22 |
| `node backend-wave8-harness.mjs` | 35 / 35 |
| `node backend-wave8-session-endpoint-harness.mjs` | 57 / 57 |
| `node backend-wave8-moderation-m1-harness.mjs` | 11 / 11 |
| `node backend-wave9-store-wiring-harness.mjs` | 13 / 13 |
| `node backend-wave9b-admin-inbox-store-harness.mjs` | 16 / 16 |
| `node backend-review-fixes-harness.mjs` | 23 / 23 |
| **all eleven repo-root harnesses** | **green** |
| QA runner (`site\qa\run-all-suites.ps1`) | **16 suites: 14 exit 0, 2 exit 1** — 292 PASS lines, 2 FAIL lines, 20 anchor proofs. Transcript: **`site/qa/artifacts/qa-full-run-2026-10-22-095521.txt`** (finished 2026-10-22 09:56:20 +03:00, on the final tree) |
| `site/data` untouched | `moderation/reviews.jsonl` **0 bytes**, SHA-256 `E3B0C442…52B855` (the empty-string hash), **no** `site/data/portal/` |
| git | **no write command** — `git diff`/`git status` only, read-only |

**The two QA suites that exit 1** are `qa-wave4-independent.mjs` (**B2b**, the F2 tripwire — the fix landed) and `qa-wave13-routing.mjs` (**MP-R3**, my hardening made the probe vacuous). Both need the re-pin in §5. Every other QA suite is green.

---

## 8. Findings, ranked by severity

1. **MAJOR — F1, the false hardening claim (CLOSED).** `site/shared/portal-router.ts:36-46` stated a containment nobody had proven on the deployed target. Now replaced by three invariants that hold under either merge order, plus an explicit "the merge order is NOT OBSERVED".
2. **MEDIUM — F3, the gate missed an unservable route (CLOSED).** A table route the entry point cannot serve passed the deploy gate with **exit 0** and would 500 in production. Reproduced before the fix.
3. **MEDIUM — F2, the gate crashed instead of naming the miss (CLOSED).** Reproduced before the fix: `TypeError: Cannot read properties of undefined (reading 'vercel')`.
4. **MINOR (new, reported not fixed) — a forged carrier can still select another handler of the SAME family.** `isInsideEntry` stops a cross-family forgery; nothing stops `/api/portal/session` being selected in place of `/api/portal/projects` when the client's query wins the merge. No escalation (every handler gates itself), but it is a routing surprise. It needs the merge-order observation, not another code change.
5. **MINOR (new, reported not fixed) — the gate still does not compare the route table with the CLOUDFLARE tree.** `site/functions/api/**` keeps one file per URL and is checked file-by-file; a family route that exists in the table but has no Cloudflare twin is caught by the per-route file check, but there is no table↔Cloudflare symmetry check like the one wave 14 added for the Vercel `HANDLERS` maps. Not a defect today (16/16 routes have a Cloudflare file); noted for the next wave.
6. **COSMETIC (CLOSED) — F4**, the six Cloudflare header comments.

---

## 9. UNVERIFIED — stated plainly

* **No Vercel router was booted.** The merge order between the platform's `__imk_route` and a client's `__imk_route` is taken from Vercel's routing implementation and its documentation, **not observed**. Nothing in this wave depends on it — that was the point of F1 — but MAJOR-1's core question is still open.
* **No preview deploy, no deploy, no live environment.** Nothing here was exercised on a real Vercel project.
* **No Cloudflare `workerd` was booted.** The Cloudflare tree was not executed; the F4 change is comment text only.
* **No real Turso / libSQL database was contacted.** The store used here is the file adapter in a sandbox.
* **No live mail.** No RESEND call was made; the moderation links are minted with a test secret only.
* **The `isInsideEntry` no-op claim was verified by reading the table, not by a production request**: every key of the portal table starts with `/api/portal/` and every key of the admin table with `/api/admin/` (checked by A1/A2 and by the `check:routes` run).
* **The harness executes the Vercel tree only.** The Cloudflare tree is a separate implementation and was not executed in this wave.
* **The transcript pins the tree at 2026-10-22 09:56:20 +03:00**, not a commit — the working tree is permanently dirty and no git write command was run.

---

## 10. Files changed

| File | Change |
|---|---|
| `site/shared/portal-router.ts` | the comment block `:36-87` rewritten; new `isInsideEntry` `:154-169`; the containment check in rule 2 `:193-210` |
| `site/scripts/check-api-routes.mjs` | header note `:47-56`; `handlerNamesIn` `:292-340`; the Cloudflare-first row shape `:354-365`; the named-miss rows `:375-386`; the `HANDLERS` check `:477-513`; the "WHAT IS MISSING" verdict `:517-542` |
| `site/functions/api/admin/reviews.ts` | line 1 comment |
| `site/functions/api/admin/session.ts` | line 1 comment |
| `site/functions/api/lib/notifications.ts` | line 1 comment |
| `site/functions/api/lib/rate-limit.ts` | line 1 comment |
| `site/functions/api/portal/session.ts` | line 1 comment |
| `site/functions/api/portal/testimonials.ts` | line 1 comment |
| `backend-wave14-carrier-containment-harness.mjs` | **new** — 24 checks, 4 reddening probes |

**Not touched:** `site/qa/**`, `DEPLOY.md`, `site/.env.example`, `site/data/**`, `api/**` (except that `api/portal.ts` and `api/admin.ts` were **copied and patched in the sandbox only** by the mutation probes).
