# Wave 15 — Backend report: the empty carrier (B-1) and the Cloudflare twin headers (B-2)

**Date:** 2026-10-22
**Owner:** Backend Developer
**Repo:** `C:\Users\Kalch\Documents\IXI` (branchless, permanently dirty shared tree)
**Status:** **DONE** — both items landed, every gate executed, no QA re-pin needed.

---

## 1. What landed

### B-1 — an EMPTY carrier is an INVALID carrier, never a fall-through to the header

The defect (wave-14 audit, MINOR): both entry points read the query carrier with a
**truthiness** test, so `?__imk_route=` (present but empty) was treated as *absent* and the
client-controlled `x-imk-route` header was consulted instead. It granted no extra
capability, but the rule was ambiguous and sat in a security-relevant resolution path.

**The rule now: the query carrier, when PRESENT, is authoritative. An empty value is
invalid → `404 {code:'not-found'}`. The header is read only when the query parameter is
genuinely absent.**

| # | File:line | Change |
|---|---|---|
| B-1.1 | `api/portal.ts:77-110` (the `carrierOf` block) | the doc comment states the rule and why; the code line is `api/portal.ts:105` |
| B-1.2 | `api/portal.ts:105` | `if (fromQuery) return fromQuery;` → **`if (fromQuery !== null) return fromQuery;`** — `searchParams.get` returns `null` ONLY when the parameter is absent |
| B-1.3 | `api/admin.ts:58-91` (the `carrierOf` block) | the same doc comment |
| B-1.4 | `api/admin.ts:86` | the same one-line change |
| B-1.5 | `site/shared/portal-router.ts:24-35` | the rules comment: rule 2 now states that a present-but-empty carrier is invalid, is never a fall-through, and that the header is read only when the query parameter is absent |
| B-1.6 | `site/shared/portal-router.ts:179-185` | the `@param carrier` contract: `null` = no carrier at all, `''` = present but empty |
| B-1.7 | `site/shared/portal-router.ts:208` | `if (carrier) {` → **`if (carrier !== null) {`** — the resolver now distinguishes *absent* from *present-but-empty* |
| B-1.8 | `site/shared/portal-router.ts:211-213` | the explicit guard: `if (carrier === '') return { ok: false, reason: 'not-found' };` — refused before the table is consulted |

**Nothing else moved.** The family containment (`isInsideEntry`), the unreachable standalone
URLs (`api/contact.ts`, `api/moderate/review.ts`, `api/portal/auth/*`), the handler-level
authorisation, the loud `500 {code:'route-resolution'}` for a bare entry point and the
carrier STRIP (`rebuildRequestUrl`) are all unchanged and all re-verified by execution
(§3, B2/C4/C5 and the wave-14 harness).

### B-2 — the Cloudflare twin headers say what the files actually are

Each header now says: *a Cloudflare Pages Function that is a SEPARATE COPY of the named
Vercel module — an edit to the Vercel module does not reach this file.* For
`portal/session.ts` it also names the part that **is** shared
(`site/shared/server/portal-session.ts`, which the file imports).

| # | File:line | Change |
|---|---|---|
| B-2.1 | `site/functions/api/admin/reviews.ts:1-9` | header replaced: a separate copy of `site/shared/portal-handlers/admin-reviews.ts` |
| B-2.2 | `site/functions/api/admin/session.ts:1-9` | header replaced: a separate copy of `site/shared/portal-handlers/admin-session.ts` |
| B-2.3 | `site/functions/api/portal/testimonials.ts:1-9` | header replaced: a separate copy of `site/shared/portal-handlers/portal-testimonials.ts` |
| B-2.4 | `site/functions/api/portal/session.ts:1-12` | header replaced: a separate copy of `site/shared/portal-handlers/portal-session.ts`, **and** the shared implementation it imports (`site/shared/server/portal-session.ts`) |
| B-2.5 | `site/functions/api/lib/rate-limit.ts:1-7` | header replaced: a separate copy of `site/shared/server/rate-limit.ts` |
| B-2.6 | `site/functions/api/lib/notifications.ts:1-7` | **NOT IN THE BRIEF — extended by me, see §6.1**: the same first-line pattern (`// site/shared/server/notifications.ts — …` read as identity), the same fix |

**Comment text only. No code, no restructure, no re-encoding.** Proof in §5.

---

## 2. The harness

**`C:\Users\Kalch\Documents\IXI\backend-wave15-empty-carrier-harness.mjs`** — new, repo root.
**17 checks, 17/17, 4 mutation probes, all four redden.**

It bundles the real `api/portal.ts` and `api/admin.ts` with esbuild (the product's own
module graph, not a re-implementation) and drives them in a child process over a synthetic
request/response — no port is bound, and the repository's `site/data` is never read or
written (the store is a temp sandbox).

| id | Check |
|---|---|
| A1 | both entry points test the query carrier for **presence**, not truthiness |
| A2 | the resolver refuses an empty carrier explicitly and keeps the bare-entry-point rule |
| B1 | an empty carrier is `not-found` at both entry points (never `route-resolution`) |
| B2 | **CONTROL** an absent carrier on a bare entry point is still `route-resolution` (the loud 500) |
| B3 | **CONTROL** a legitimate carrier still resolves |
| B4 | **CONTROL** the path still wins over a forged carrier |
| C1 | `?__imk_route=` + `x-imk-route: /api/portal/session` → **404 `not-found`**, and the session handler never ran |
| C2 | the same on the admin entry point (`/api/admin/reviews`) → **404 `not-found`** |
| C3 | `?__imk_route=` alone → **404 `not-found`**, not the loud 500 |
| C4 | **CONTROL** an absent query carrier + the header still resolves (the comments handler answers 200 with its own key) |
| C5 | **CONTROL** the header channel on the admin side is unchanged (401 without a cookie, 200 with the owner session) |
| C6 | **CONTROL** a present query carrier wins over the header |
| C7 | **CONTROL** the ordinary carrier path still serves the client's own data only |
| D1 | **PROBE** restoring the fall-through in `api/portal.ts` → C1 goes RED |
| D2 | **PROBE** restoring the fall-through in `api/admin.ts` → C2 goes RED |
| D3 | **PROBE** the resolver treating an empty carrier as absent → C3 goes RED |
| D4 | **PROBE** the header channel is dead → C4 goes RED (so C4 is not vacuous) |

**The probes, by execution (not by reading):**

- **D1** — the mutant answers **401** (the session handler ran), the control answers **404**.
- **D2** — the mutant answers **401** (the owner inbox handler ran), the control answers **404**.
- **D3** — the mutant answers **500 `route-resolution`**, the control answers **404**.
- **D4** — the mutant answers **500**, the control answers **200**.

Every mutation is applied to a **copy** in `%TEMP%`; the repository is never modified.

---

## 3. Gates (all executed by me)

| Gate | Result |
|---|---|
| `npm run typecheck:api` | **exit 0** (covers `api/**`, `site/shared/**` **and** `site/functions/**` — see `site/tsconfig.api.json`) |
| `npm run check:routes` | **16 route(s), 0 missing**; `api/` holds **7** .ts files; 11 rewrites agree; every table route is served by its entry point's HANDLERS map |
| `npm run test:store` | **72/72** (0 failed) |
| repo-root harnesses | **12 harnesses, 306 checks, 0 red** |
| — `backend-f1-magic-token-harness.mjs` | 22/22 |
| — `backend-review-fixes-harness.mjs` | 23/23 |
| — `backend-wave6-harness.mjs` | 24/24 |
| — `backend-wave8-harness.mjs` | 35/35 |
| — `backend-wave8-moderation-m1-harness.mjs` | 11/11 |
| — `backend-wave8-session-endpoint-harness.mjs` | 57/57 |
| — `backend-wave9-store-wiring-harness.mjs` | 13/13 |
| — `backend-wave9b-admin-inbox-store-harness.mjs` | 16/16 |
| — `backend-wave10-store-integrity-harness.mjs` | 42/42 |
| — `backend-wave13-function-budget-harness.mjs` | 22/22 (after the re-pin, §4) |
| — `backend-wave14-carrier-containment-harness.mjs` | 24/24 |
| — **`backend-wave15-empty-carrier-harness.mjs` (new)** | **17/17** |
| QA runner (`powershell -NoProfile -ExecutionPolicy Bypass -File site\qa\run-all-suites.ps1`) | **17 entries, ALL exit 0** — 16 QA suites + `check:routes` + the wave-14 harness; **20/20 anchor proofs** behaved as expected |
| `site/data` untouched | `site/data/moderation/reviews.jsonl` **0 bytes**, SHA-256 `e3b0c442…b852` (the empty string); **no** `site/data/portal/` |
| git write command | **none** — `git status`/`git diff` only, read-only |

**QA transcript:** `site/qa/artifacts/qa-full-run-2026-10-22-105924.txt`
(started 10:59:24, finished 11:00:25 +03:00).

> Note on reading that transcript: it contains `FAIL` lines because the mutation-probe
> suites print their **intentional** mutant failures (`N1=FAIL … (suite exit 1)`,
> `D2=FAIL … the patch anchor was not found`). Every suite still exited 0 and the anchor
> prover reports 20/20 — the runner's summary block is the authoritative part.

---

## 4. One re-pin I had to make (my own file, and it bites)

`backend-wave13-function-budget-harness.mjs` went **RED** after B-1: its probe **D2**
("without the carrier branch the rewrite case goes RED") patched the resolver's branch
head, and the anchor text moved.

- **Anchor moved:** `"  if (carrier) {"` → `"  if (carrier !== null) {"`.
- **Re-pinned at** `backend-wave13-function-budget-harness.mjs:692-696` (the anchor plus a
  comment saying why it moved and that the check was not weakened).
- **The defect the probe models is unchanged** — without the carrier branch the rewrite
  case does not resolve — and the probe **still bites**: the mutant answers **500**, the
  control answers **401** (the handler was reached).
- The check was **re-pinned, not deleted**, and it is one of my own repo-root harnesses
  (not in `site/qa/**`).

**No QA file was touched.** `site/qa/**` is untouched by me (verified by mtime across the
repo — the only `site/qa/**` writes are the runner's own artifacts).

---

## 5. The "no ANSI round-trip" proof for B-2 (and for the product files)

The wave-13 move had an ANSI re-encoding incident, so I did not trust the editor. I
verified by **inverse replacement**, from a script in `%TEMP%` (never in the repo):

- For the six Cloudflare twins: the **pre-edit byte length was measured before the edit**
  (3890 / 4130 / 24481 / 5557 / 6563 / 8371 bytes). Applying the inverse of my replacement
  (new text → old text) **restores each file byte-for-byte** to that measured length — so
  the only bytes that changed are the ones in the replacement, i.e. **comment text only**.
- For the three product files the pre-edit length was not recorded, so the inverse is
  applied and the two versions are diffed **line by line**:
  - `api/portal.ts` — **one** code line changed: `if (fromQuery)` → `if (fromQuery !== null)`. The other 26 changed lines are comments.
  - `api/admin.ts` — **one** code line changed, the same way. The other 26 changed lines are comments.
  - `site/shared/portal-router.ts` — **two** code lines added (`if (carrier !== null) {`, `if (carrier === '') {`) and **one** removed (`if (carrier) {`). Every other changed line is a comment.
- **UTF-8 health of all nine files:** no BOM, **0** replacement characters (0xFFFD), **0**
  CRLF (LF kept), and the em-dash count unchanged in every file
  (admin/reviews 7, admin/session 8, testimonials 27, portal/session 9, rate-limit 6,
  notifications 12, api/portal.ts 2, api/admin.ts 2, portal-router.ts 4).

---

## 6. Behaviour differences and decisions — reported, not hidden

### 6.1 B-2 covers six files, the brief named five
The brief listed five twins and then said "the two in `site/functions/api/lib/*` already
use better wording". `site/functions/api/lib/rate-limit.ts` was in the five **and**
`site/functions/api/lib/notifications.ts` was not — but the two have the **same** first
line (`// site/shared/server/<module>.ts — Cloudflare Pages Function module.`, which reads
as identity). I fixed both, because B-2's requirement is "make each header say what the
file actually is". The brief's two statements cannot both be true, so I took the one that
leaves no file with a misleading header.

### 6.2 An empty carrier answers 404, not the loud 500
The brief requires `404 {code:'not-found'}` for an empty carrier. Note that on a bare entry
point the loud `500 {code:'route-resolution'}` is the *absence-of-route* signal; an empty
carrier is a *present-but-wrong* route, so it is a clean 404. The loud 500 is untouched
for a request with **no** carrier at all (verified: B2, and QA's R6).

### 6.3 An empty **header** value is still treated as "no header" (unchanged)
The brief scoped the new rule to the query channel. The header channel has no fallback
behind it, so there is nothing to fall through to, and I left it exactly as it was: an
empty `x-imk-route` is no header. On a bare entry point that is still the loud 500. This is
the one asymmetry in the rule, and it is deliberate and documented in the code.

### 6.4 The explicit `if (carrier === '')` guard is redundant — and I do not claim otherwise
With `if (carrier !== null)` in place, an empty carrier would already be refused by
`isInsideEntry('', prefix) === false`. The explicit guard is there for readability (it says
what happens, not what follows from a prefix check). **Probe D3 proves the presence test
(`carrier !== null`) is load-bearing — it is the test that turns the empty carrier from
"absent" (→ the loud 500) into "invalid" (→ 404).** I do not claim the explicit guard is
independently load-bearing, because it is not.

### 6.5 The dev server inherits the fix
`site/scripts/dev-portal.js` calls the entry point with the original request URL, so the
local dev server goes through the same `carrierOf`/`resolveRoute` path — no second copy of
the rule exists anywhere. I grepped the whole tree: `ROUTE_CARRIER_PARAM` /
`__imk_route` appear only in `api/portal.ts`, `api/admin.ts`, `site/shared/portal-router.ts`,
the rewrites in `vercel.json` and the QA/test harnesses.

---

## 7. Files changed (this wave)

| File | Kind |
|---|---|
| `api/portal.ts` | product — 1 code line + a doc comment |
| `api/admin.ts` | product — 1 code line + a doc comment |
| `site/shared/portal-router.ts` | product — 2 code lines added, 1 removed + comments |
| `site/functions/api/admin/reviews.ts` | comment only |
| `site/functions/api/admin/session.ts` | comment only |
| `site/functions/api/portal/testimonials.ts` | comment only |
| `site/functions/api/portal/session.ts` | comment only |
| `site/functions/api/lib/rate-limit.ts` | comment only |
| `site/functions/api/lib/notifications.ts` | comment only |
| `backend-wave15-empty-carrier-harness.mjs` | **new** — the harness (17 checks) |
| `backend-wave13-function-budget-harness.mjs` | one probe anchor re-pinned (§4) |
| `backend-wave15-carrier-2026-10-22.md` | this report |

**Not touched:** `site/qa/**` (QA's), `DEPLOY.md` and `site/.env.example` (DevOps's),
`site/data/**`, `site/scripts/**`, `vercel.json`, the route table, the store, the
handlers. **No git write command** (no reset / clean / checkout / stash — the tree stays
permanently dirty as it was).

---

## 8. What stays UNVERIFIED

- **No Vercel router was booted.** The merge order behind MAJOR-1 (the client's query vs
  the rewrite's `__imk_route`) is still unobserved, and the platform's own routing
  behaviour is still documentation, not an observation.
- **No deploy, no preview, no production request.** The `vercel.json` rewrites firing at
  all is still unproven — the Code Reviewer's point that the portal is dead on arrival if
  they do not.
- **No workerd booted** (the Cloudflare tree was not executed at the runtime level; the
  B-2 changes are comment text, and `typecheck:api` covers `site/functions/**`).
- **No real Turso.** The libSQL path remains proven only against a real SQLite engine over
  the real wire protocol.
- **No live mail.**
- The `astro check` baseline was not re-run by me (the QA runner's build suite
  `qa-testimonials-build.mjs` did a real `astro build` → exit 0).
- The dev server on 4321 still runs a pre-wave-15 bundle; it must be restarted in place
  (`npm run dev:portal`) to pick the new rule up. I did not touch it.

---

## 9. For the next owner

1. **QA:** the new harness is **not in the runner** (the runner is QA's file). It is a
   repo-root harness, like the wave-14 one that became suite #17. Ask QA to add it as
   suite #18:
   `backend-wave15-empty-carrier-harness.mjs` → **17 checks, 4 probes, all reddening**.
2. **DevOps:** `DEPLOY.md` §1.6 (the wave-14 routing section) describes the carrier
   channels. One line is now true that was not before: *a present but empty `__imk_route`
   is refused with 404; the `x-imk-route` header is read only when the query parameter is
   absent.* No new environment variable was added — `TRUST_CF_CONNECTING_IP` and the rest
   are unchanged, and `site/.env.example` needed no edit.
3. **Code Reviewer:** the two items this wave were rated MINOR; the proofs are in §2 and
   §5, and the re-pin in §4 is the only place an existing check moved (my own file, probe
   still biting).
