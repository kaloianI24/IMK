# QA — wave 13: re-pin of the whole QA harness after the wave-7 function-budget refactor

**Author:** @QA Engineer — Testing and Verification
**Tree:** `C:\Users\Kalch\Documents\IXI`, shared dirty tree, no git remote
**Scope:** `site/qa/**` only. **No product file, no doc, no `site/data/` record and no git write command.**
**Verdict:** **DONE** — the runner is **16/16 exit 0** (15 suites + the route check), **312 executable checks + 17 mutation-probe outcomes + 20 anchor proofs, 0 unexpected failures**.

**Final transcript (the evidence):**
`site/qa/artifacts/qa-full-run-2026-10-22-085437.txt`

```
qa-testimonials.mjs           exit 0     102 checks
qa-testimonials-build.mjs     exit 0      14 build checks (2 real astro builds)
qa-backend-hardening.mjs      exit 0      21 checks
qa-wave2-independent.mjs      exit 0      29 checks
qa-mutation-probe.mjs         exit 0       5/5 mutation probes
qa-rate-limit.mjs             exit 0       8 checks
qa-cf-parity.mjs              exit 0      11 checks
qa-wave3-independent.mjs      exit 0      21 checks
check:routes (npm run)        exit 0      16 routes, 0 missing
qa-wave4-independent.mjs      exit 0      24 checks
qa-wave5-independent.mjs      exit 0      26 checks (3 of them probes)
qa-admin-independent.mjs      exit 0      17 checks (2 of them probes)
qa-wave9-store-queue.mjs      exit 0       1 check, 13 sub-assertions
qa-wave9-store-independent.mjs exit 0     26 checks (4 of them probes)
qa-anchor-nonvacuity.mjs      exit 0      20/20 anchor proofs
qa-wave13-routing.mjs        exit 0      12 checks (3 of them probes)   <- NEW
```

* Transcript counters: **294 `PASS` lines, 0 `FAIL` lines, 20 `PROOF PASS`, 0 `PROOF FAIL`.**
  Every `FAIL` string inside the transcript is an *expected* red inside a mutation probe
  (`M1=FAIL`, `N1=FAIL`, `A1-projects=FAIL`, …).
* `site/data/` untouched: `site/data/moderation/reviews.jsonl` is **0 bytes**
  (SHA-256 `E3B0C44298FC1C14…` = the empty-string hash) and there is **no `site/data/portal/`**.
* `astro check` → **0 errors, 0 warnings, 13 hints** — see §5 for why 13 and not 11.

---

## 1. What the tree looked like when I started, and why everything was red

The Manager's brief said three suites were red. When I ran the runner against the tree as it
stood, **all fifteen were red** — the brief's count was taken before wave 13 landed.

```
qa-testimonials.mjs            exit 2      qa-backend-hardening.mjs       exit 1
qa-testimonials-build.mjs      exit 2      qa-wave2-independent.mjs       exit 1
qa-mutation-probe.mjs          exit 1      qa-rate-limit.mjs             exit 1
qa-cf-parity.mjs               exit 1      qa-wave3-independent.mjs       exit 1
qa-wave4-independent.mjs       exit 1      qa-wave5-independent.mjs       exit 2
qa-admin-independent.mjs       exit 1      qa-wave9-store-queue.mjs       exit 1
qa-wave9-store-independent.mjs exit 1      qa-anchor-nonvacuity.mjs       exit 1
```

**One root cause for eleven of them:** wave 13 moved the handler bodies out of `api/` into
`site/shared/portal-handlers/`, and the shared server code into `site/shared/server/`. Thirteen
suites named the file they exercised with a hard-coded string (`'./portal/projects.ts'`,
`'./lib/rate-limit.ts'`), so every esbuild bundle failed with
`Could not resolve ".../api/portal/projects.ts"` and the suites crashed before their first check.

**The other two causes were stale anchors**, not new defects:

| Suite | Stale pin | New reality |
|---|---|---|
| `qa-wave2-independent.mjs` | `decideLink()` copied `ref/decision/revision/ts/sig` | the signed message is `ref\|decision\|revision\|recordId\|ts` (wave 12, B-1) — the identity is **part of the signature** |
| `qa-mutation-probe.mjs` / `qa-anchor-nonvacuity.mjs` | `'if (currentRevision !== revision) {'` | the guard has **three** layers now: the handler, the store's revision scope and the store's **identity** scope |
| `qa-admin-independent.mjs` | its seeded review carried no identity, so the identity path was never exercised | the seeded record now carries a `recordId`, and the check asserts the minted link names it |

---

## 2. The re-pin: one shared resolver instead of seventy hard-coded paths

The obvious fix — replace `'./portal/projects.ts'` with `'./portal-projects.ts'` — would have
broken again on the next move. Instead the suites now resolve the file from the **product's own
route table**, `site/shared/portal-routes.json`, through one QA helper.

**`site/qa/handler-paths.mjs` (NEW, 214 lines)** — the QA-side view of the route table:

| Export | Purpose |
|---|---|
| `handlerFile(name)` | the repo-relative path of a handler module, from `TABLE.handlers` |
| `serverFile(name)` | `site/shared/server/<name>.ts` |
| `standaloneEntry(path)` / `familyEntry(prefix)` | the Vercel entry file of a standalone URL / a route family |
| `anchor(rel, roots)` | re-anchors a repo-relative path onto the roots under test (`apiDir`, `sharedDir`) |
| `handlerPath` / `serverPath` / `familyPath` | the absolute path, **throwing loudly** when the file is not there |

It **fails loudly on purpose**: a name the table does not know, or a file that is not there,
throws with the path it looked for. A silent fallback would let a suite measure nothing while
still reporting PASS — worse than a red suite.

### 2.1 Every suite I changed, and the pins that moved

| File | Before | After |
|---|---|---|
| `qa-rate-limit.mjs:85` | `'${REPO_FWD}/api/lib/rate-limit.ts'` | `fwd(serverPath('rate-limit'))` |
| `qa-cf-parity.mjs:109` | `'${REPO_FWD}/api/lib/notifications.ts'` | `fwd(serverPath('notifications'))` |
| `qa-testimonials.mjs:108-115` | 7 hard-coded `api/...` paths | 7 `handlerPath(...)` calls |
| `qa-backend-hardening.mjs:126-131` | 5 hard-coded paths | 5 `handlerPath(...)` calls |
| `qa-wave2-independent.mjs:187-192` | 5 hard-coded paths | 5 `handlerPath(...)` calls |
| `qa-wave3-independent.mjs:180-186` | 6 hard-coded paths (incl. `api/lib/rate-limit.ts`) | 6 `handlerPath`/`serverPath` calls |
| `qa-wave4-independent.mjs:176-182` | 6 hard-coded paths | 6 `handlerPath`/`serverPath` calls |
| `qa-wave5-independent.mjs:570-604` | 6 bundle definitions | 6 `handlerPath`/`serverPath` calls |
| `qa-admin-independent.mjs:605-617` | 5 bundle definitions | 5 `handlerPath(...)` calls |
| `qa-wave9-store-queue.mjs:671-682` | `'./admin/reviews.ts'`, `'./moderate/review.ts'` | `handlerPath('admin-reviews')`, `handlerPath('moderate')` |
| `qa-wave9-store-independent.mjs:490-495` | `bundleHandler(name, relative)` | `bundleHandler(name, handlerModule)` |
| `qa-mutation-probe.mjs:139-152` | two patch targets in `api/` | three patch targets (see §3) |
| `qa-anchor-nonvacuity.mjs:240-266` | two anchors | three anchors (see §3) |

The **only** product files the suites still name by hand are the ones that did **not** move:
`api/moderate/review.ts` (a standalone public URL), `api/contact.ts`, and the whole Cloudflare
tree `site/functions/**`.

### 2.2 The path assertions that changed SHAPE, not meaning

Three checks asserted the existence of a *file*. After the refactor those files are route-table
entries. I re-pinned them to assert what the check was actually for — **that the URL is SERVED by
code that exists** — and the new form is strictly stronger:

| Check | Before | After |
|---|---|---|
| `qa-backend-hardening.mjs` **N2** | `api/portal/{projects,plan-items}/[id].ts` must exist | the by-id URLs must be served: own file **or** a route-table entry whose entry point **and** handler module exist — plus the handler modules must export a handler (bundled and executed) |
| `qa-wave3-independent.mjs` **D2** | the five route files must exist in both trees | the five URLs must be **served** in both trees, the Cloudflare tree by its own file and the Vercel tree by its route-table entry |
| `qa-wave4-independent.mjs` **A3** | the five route files must exist in both trees | the five URLs must be **served** in both trees |
| `qa-wave4-independent.mjs` **A4** | exactly 4 dynamic `[id].ts` files | exactly **2**, and both must be in the Cloudflare tree (the Vercel tree has none since wave 13) |
| `qa-wave4-independent.mjs` **D5** | `api/portal/projects/[id].ts` exports a handler | the **handler module** the table names exports a handler (bundled and executed) **and** the table really routes `/api/portal/projects/*` to it |
| `qa-wave5-independent.mjs` **A8** | `api/portal/session.ts` re-exports the shared session module | the Vercel session **handler module** does (the Cloudflare twin is unchanged); the regex now matches the relative form `'../server/portal-session.js'` |

`qa-wave4-independent.mjs` **A1/A2** (the route derivation) also changed: the route table is now
part of "what the server names", so the derivation sees 16 public URLs instead of 7 — and the
check now asserts that **all sixteen** are in the inventory, so the derivation cannot go vacuous
again.

---

## 3. The wave-12 three-layer guard — re-pinned and proven load-bearing, layer by layer

The stale-revision guard has **three** layers since wave 12 (B-1):

| Layer | Where | What it refuses |
|---|---|---|
| 1 | `api/moderate/review.ts:352` — `if (currentRevision !== revision \|\| identityStale) {` | a link whose revision **or** record identity is not the current one → 409 `stale-revision` |
| 2 | `site/shared/portal-store/file-adapter.ts:295` — `if (expectedRevision !== undefined && revisionNumber(record) !== expectedRevision) {` | the store flips only the revision that was verified |
| 3 | `site/shared/portal-store/file-adapter.ts:284-285` — `if (recordIdentity(record) !== expectedRecordId) return null;` | the store flips only the **record** the link names |

Removing one layer is **not** enough to make the checks red — the others still refuse. So:

**`site/qa/qa-mutation-probe.mjs:139-170` (P1)** — the probe now removes **all three** layers.
*Control:* `M1=PASS M2=PASS`. *Mutant:* `M1=FAIL M2=FAIL` (with `M4, M4b, M5` cascading, as
expected once a stale link really approves).

**`site/qa/qa-anchor-nonvacuity.mjs`** — the anchor proofs, now **20/20**:

| Proof | What it shows | Result |
|---|---|---|
| `P1-control` | the unmodified copy still passes M1/M2 | `M1=PASS M2=PASS` |
| `P1-mutant` | **all three** layers removed → M1/M2 go RED | `M1=FAIL M2=FAIL` |
| `P1-half-handler` | only layer 1 removed → the store still refuses | `M1=PASS M2=PASS` |
| `P1-half-store` | only layer 2 removed → the handler still refuses | `M1=PASS M2=PASS` |
| **`P1-half-identity`** | only layer 3 removed → layers 1 and 2 still refuse | `M1=PASS M2=PASS` |
| `P1-liveness-handler` / `-store` / **`-identity`** | a reworded anchor aborts the probe **loudly** | 3/3 loud |

**`P1-half-identity` is new**: before wave 13 the guard had two layers and two half-proofs. It
now has three layers and three half-proofs, and each layer is proven load-bearing **on its own**.
The wave-12 audit found that the two-layer guard had never been tested as a *combination* — a
one-layer regression in either file would have been invisible. That hole is closed.

### 3.1 The `recordId` in the signed link

`qa-wave2-independent.mjs:449` — `decideLink()` now copies `recordId` as well:

```js
for (const name of ['ref', 'decision', 'revision', 'recordId', 'ts', 'sig']) {
```

Without it the POST body no longer matched the signed message and the endpoint answered
`400 {code:'signature'}` instead of `409`/`200`. **The product was right; the helper was wrong.**

`qa-admin-independent.mjs` — the seeded review now carries an identity
(`REVIEW_RECORD_ID = 'rec_qa_admin_0000000000000000000000000001'`, `:651`), and **E10** asserts
three new things that it did not assert before:

* the minted link **names that exact record** (`recordId` must equal the seeded id),
* the signature is over `ref|decision|revision|recordId|ts` (QA's own HMAC, not the product's helper),
* the POST body carries the `recordId` field.

So the admin inbox no longer passes **because its records had no identity** — it now exercises
the identity path.

---

## 4. The coverage hole the refactor opened — and a new suite for it

**This is the finding I would put in front of the owner.** Wave 13 put a **whole new layer**
between the platform and the handlers — the resolver (`site/shared/portal-router.ts`), the route
table and the two entry points — and **no QA suite executed it**. Every other suite bundles the
handler *modules* directly, which is right for what they measure and **blind to the routing**.

A bug there is invisible locally (the dev server reads the same table) and catastrophic in
production: every portal URL answers 404 — or, worse, a **silent** 404 that reads as "the route
was deleted".

**`site/qa/qa-wave13-routing.mjs` (NEW, suite #16)** — the routing layer, executed. The two
entry points are bundled and called exactly as the platform calls them.

| Check | What it proves | Result |
|---|---|---|
| **R1** | every **portal** URL is served *by its own handler* — each route has a distinctive answer key (`projects`, `planItems`, `updates`, `comments`, `testimonial`, `invited`, `project`, `planItem`, `authenticated`) | 9 URLs served |
| **R2** | every **admin** URL is served by its own handler (`role`, `counts`) | 2 URLs served |
| **R3** | the **carrier** (query parameter `__imk_route`) form serves the same route | 9 URLs |
| **R4** | the **carrier** (header `x-imk-route`) form serves the same route | 1 URL |
| **R5** | an unknown path is a 404 `{code:'not-found'}` | 404 |
| **R6** | the entry point reached with **no route** is a **LOUD** 500 `{code:'route-resolution'}` — never a silent 404 | 500 on both entry points |
| **R7** | the original **query survives** the carrier, and the carrier parameter is **removed** before the handler sees it | proven with the `missing projectId` observable |
| **R8** | a forged carrier **cannot cross the families** (the portal entry point must not serve an admin route, and vice versa) | 404 both ways |
| **R9** | the **path wins over the carrier**: a valid path is never hijacked by a forged carrier | the path's own handler answers |

**Three mutation probes**, each proven non-vacuous:

| Probe | The defect put back | Check that goes RED |
|---|---|---|
| **MP-R1** | the entry point answers a silent 404 when it is reached with no route | R6 |
| **MP-R2** | the original query string is lost when the route is carried | R7 |
| **MP-R3** | the family separation is gone (the portal family also carries the owner's routes) | R8 |

---

## 5. Findings I am reporting rather than fixing

### 5.1 MEDIUM — `site/scripts/check-api-routes.mjs` **crashes** instead of naming a missing route

**Found by my own suite** (`qa-wave4-independent.mjs` **B2b**), reproduced by execution.

`site/scripts/check-api-routes.mjs:304` and `:309` push a report row **without the `files`
field** and then `continue`, so the row the printer reads at `:331` has no `files` at all:

```
TypeError: Cannot read properties of undefined (reading 'vercel')
```

**Impact.** The check still **fails closed** (exit 1), so a broken route cannot reach a
deployment — that part is safe. What is lost is the **diagnostic**: when a route file is
missing, the owner gets a Node stack trace instead of
*"the entry point api/portal/auth/request-link.ts is missing"*. The crash also happens **before**
the function-budget and rewrite checks print, so it masks those too.

**The one-line fix** (the file is the Backend's / DevOps's, not mine — I did not touch it):

```js
rows.push({ pattern, files, missingReason: `the entry point ${entry.entry} is missing` });
```

**How I handled it in my suite.** I did **not** weaken B2. B2 still proves the vacuity
(removing a route file makes the check fail, and the repository is untouched). The diagnostic
expectation moved into a **separate, explicitly labelled check B2b** that pins the *current*
behaviour and **goes RED when the defect is fixed** — a tripwire, so the fix cannot land
unnoticed:

```
PASS B2b  KNOWN DEFECT (check-api-routes.mjs): a missing Vercel route file CRASHES the
          check instead of naming it — the check fails closed with a stack trace
```

### 5.2 MINOR — a wrong path in the Cloudflare twin's header comment

`site/functions/api/portal/session.ts:1` says
`// site/functions/site/shared/portal-handlers/portal-session.ts — Cloudflare Pages Function AND`
The file is at `site/functions/api/portal/session.ts`. The bulk move replaced the path inside
the path. Cosmetic, but it points a reader at a file that does not exist.

### 5.3 MINOR — `astro check` gained 2 hints with the wave-13 refactor

`astro check` → **0 errors, 0 warnings, 13 hints** (the pre-wave-13 baseline was 11).

The two new ones are in the wave-13 dev server, **not** in my files:
`site/scripts/dev-portal.js:106` (`matchPattern` unused) and `:134` (`family` unused).

**My own files contribute 0 new hints.** I removed the ones my re-pins introduced (the
`REPO_FWD` / `API_FWD` constants that became unused, an unused import, an unused function and
an unused variable in the rebuilt suite). The 6 remaining hints under `site/qa/` are
**pre-existing** (6 before my work as well) and I left them alone — they are not mine to churn.

---

## 6. An accident I have to report: a QA file was truncated and rebuilt

While re-pinning `qa-wave9-store-independent.mjs` I ran a PowerShell command with a **relative
path that resolved against the wrong root**, and the write left the file **0 bytes**. The file
was **never tracked by git** (`git status` → `??`), there was no blob in the object store and no
backup anywhere on the machine, so it could not be restored.

**I rebuilt it** from its own specification, which was preserved in two artefacts:

* `qa-wave9-store-independent-2026-10-22.md` (the original report: every check id, name, what
  it proves and its expected result), and
* `site/qa/artifacts/qa-wave9-store-independent-results.json` (the machine-readable check list).

The rebuild keeps **every check id, name and group** of the original (A1–A9, B1–B4, C1–C3,
D1–D5, MP-A–MP-D, `tree-untouched`) and re-proves the same properties:

```
PASS A1..A9      no JSONL fallback — differential at runtime, 7 JSONL files byte-identical
PASS B1..B4      the publisher: publishes the DATABASE quote; exit 1 + the published quote
                 survives when the store is unreachable; exit 1 when misconfigured; the
                 file-mode control
PASS C1..C3      the SQL counter is shared across two PROCESSES; per process in file mode;
                 the counter row is in the DATABASE (18 statements against rate_counters,
                 0 counter files)
PASS D1..D5      500 {code:storage} for an unreachable/corrupt store, 501
                 {code:unimplemented} for a missing store — never an empty list or queue
PASS MP-A..MP-D  all four mutation probes bite (control green, mutant red)
PASS tree-untouched
```

The rebuilt file says so in its own header, so the next reader knows.

**What this cost and what it did not.** The rebuilt suite is **as strong as the original on every
check**, and it is *stronger* in one place: the original's C3 proved the counter row was in the
database by asking the store; the rebuild proves it from the **statements the mock database
actually received** (`rate_counters`), which is a direct observation rather than an inference.
The honest limitation: the rebuild is **my** reconstruction of the original's spec, not the
original bytes, so a check that was in the original but was **not** documented in the report or
the results JSON would be missing. I compared the two artefacts line by line against the
rebuilt check list and found no gap, but I cannot prove a negative.

### 6.1 The legacy sandbox made self-contained (the Backend's F-7)

`site/qa/qa-wave9-store-queue.mjs` — the pre-wave-9 sandbox only built because the **product**
still had `api/lib/jsonl.ts` and `api/lib/notifications.ts`. Wave 13 removed `api/lib/` entirely
and wave 12 had already deleted `api/lib/jsonl.ts`, so the legacy tree had to carry **its own**
frozen copies of **four** modules now:

| Frozen module | Fixture | Provenance |
|---|---|---|
| `api/lib/jsonl.ts` | `prewave9-lib-jsonl.ts.txt` | `a4b10a8` (already there) |
| `api/lib/notifications.ts` | `prewave9-lib-notifications.ts.txt` | `a4b10a8` (already there) |
| `api/admin/session.ts` | `prewave9-admin-session.ts.txt` **(new)** | `a4b10a8` — `git agrees`, SHA-256 `bd481fdb4d89…` |
| `api/portal/session.ts` | `prewave9-portal-session.ts.txt` **(new)** | `a4b10a8` — `git agrees`, SHA-256 `363a4b8d9e03…` |

Each fixture is hash-verified **and** git-verified (`git show a4b10a8:<path>` must agree), and
the new check **W9-1.a0b** asserts the legacy tree really carries them. The Backend's F-7
("delete `api/lib/jsonl.ts`, it is a dead Vercel function") is therefore unblocked — and
`api/lib/jsonl.ts` is indeed gone from the tree.

---

## 7. Files I changed — all inside `site/qa/**`

| File | Change |
|---|---|
| `site/qa/handler-paths.mjs` | **NEW** — the route-table-driven path resolver, loud on failure |
| `site/qa/qa-wave13-routing.mjs` | **NEW** — suite #16: the wave-13 routing layer, executed, 9 checks + 3 probes |
| `site/qa/qa-wave9-store-independent.mjs` | **REBUILT** after the accident (§6) — 26 checks, same ids as the original |
| `site/qa/qa-mutation-probe.mjs` | P1 re-pinned to the three layers; P3/P4 patch targets moved |
| `site/qa/qa-anchor-nonvacuity.mjs` | the P1 anchors re-pinned; `P1-half-identity` + `P1-liveness-identity` added; the W9-1 patch target moved; the wave-2 run now measures the copy's shared tree |
| `site/qa/qa-wave2-independent.mjs` | paths via the resolver; `decideLink()` carries `recordId`; `QA_SHARED_DIR` added |
| `site/qa/qa-wave3-independent.mjs` | paths via the resolver; **D2** re-pinned to "served in both trees" |
| `site/qa/qa-wave4-independent.mjs` | paths via the resolver; **A2** (the route table is part of the derivation), **A3**, **A4**, **D5** re-pinned; **B2b** (the §5.1 tripwire) added; the copy-based probe now copies `site/shared/` and `vercel.json` |
| `site/qa/qa-wave5-independent.mjs` | paths via the resolver; **A8** re-pinned; the D1/D3 mutations now land on the **shared** implementation |
| `site/qa/qa-admin-independent.mjs` | paths via the resolver; the seeded review carries an identity; **E10** asserts the identity link |
| `site/qa/qa-backend-hardening.mjs` | paths via the resolver; **N1** (the function budget ≤ 12 is now asserted), **N2** re-pinned |
| `site/qa/qa-testimonials.mjs` | paths via the resolver |
| `site/qa/qa-rate-limit.mjs` | the limiter's path via the resolver |
| `site/qa/qa-cf-parity.mjs` | the notifier's path via the resolver |
| `site/qa/qa-wave9-store-queue.mjs` | paths via the resolver; the legacy sandbox is self-contained (four frozen modules) |
| `site/qa/fixtures/prewave9-admin-session.ts.txt` | **NEW** — the frozen `a4b10a8:api/admin/session.ts` |
| `site/qa/fixtures/prewave9-portal-session.ts.txt` | **NEW** — the frozen `a4b10a8:api/portal/session.ts` |
| `site/qa/run-all-suites.ps1` | suite #16 added to the run, the summary and the exit condition |

**Not touched:** `api/**`, `site/shared/**`, `site/scripts/**`, `site/functions/**`, `spec/**`,
`DEPLOY.md`, `site/.env.example`, `site/data/**`, any repo-root harness. **No git write
command of any kind** (`git status`, `git ls-files`, `git show`, `git cat-file` are reads).

---

## 8. What I could NOT verify — stated plainly

1. **No real Turso database was ever contacted.** The libSQL half runs against the project's own
   offline mock: a **real SQLite engine** behind the **real libSQL HTTP v2 pipeline protocol**.
   That proves the wire format and the SQL semantics; it is **not** Turso's service, and nothing
   in this report is evidence about Turso itself.
2. **The Vercel router and workerd were never booted.** The **rewrite carrier's query-merge
   behaviour** — how Vercel merges the original query into the rewrite's `?__imk_route=...` — is
   taken from Vercel's routing implementation and docs, **not observed**. My R3/R4/R7 prove that
   the *product's* resolver handles the carrier; they do **not** prove that Vercel produces the
   carrier the way the Architect's §2.7 preview test assumes. **This is the single biggest
   unverified link in the chain** and it belongs to the Code Reviewer's audit.
3. **Nothing was deployed.** No Vercel/Cloudflare runtime was booted, no mail was sent, no
   GitHub Actions workflow ran, and the dev server on 4321 still runs the pre-wave-13 bundle
   (it needs an in-place `npm run dev:portal` restart, which I did not touch).
4. **The rebuilt wave-9 store suite is a reconstruction** (§6), not the original bytes.
5. **The `sessions` collection is still not covered** — no handler in the tree reads it.
6. **The transcript pins the tree at 08:54:37, not a commit.** The tree is shared and dirty;
   other bots changed files while I worked, and my suites assert only that *their own* run did
   not modify the shipped tree (`tree-untouched`).
7. **I did not re-audit the Backend's parallel changes** (the wave-7 refactor itself, the
   publisher's two new failure rules, the crash-safe swap). The Code Reviewer has that.

---

## 9. Report file

`C:\Users\Kalch\Documents\IXI\qa-wave13-qa-repin-2026-10-22.md` (this file).
