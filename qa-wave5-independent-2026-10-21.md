# QA report — wave 5/6 independent verification (F-2, F-3, F-4) + the admin inbox

**Date:** 2026-10-21
**QA Engineer — Testing and Verification**
**Repo:** `C:\Users\Kalch\Documents\IXI` (branch `main`, shared dirty tree, **no remote, 2 commits**)
**Assignment:** @Manager — "WAVE-6 QA: own the new independent wave-5 suite" (objective, owner, deliverable, acceptance criteria, verification)
**Backend's report under test:** `backend-wave6-2026-10-21.md`
**This report supersedes** `qa-reviews-testimonials-wave5-2026-10-21.md` (the first pass of the same work, before the Backend's wave-6 code and the Frontend's admin inbox landed).

---

## 1. Status

**DONE — every acceptance criterion met. The wave-5 suite exists, is wired as suite #11, the full
runner was executed, and every per-suite exit code is reported below. One red remains and it is a
real, reproducible defect (D-4), not a broken harness.**

| Acceptance criterion | Status | Evidence |
|---|---|---|
| `site/qa/qa-wave5-independent.mjs` exists | **MET** | 67 KB, **25 QA-owned checks**, own harness/signing/sandbox |
| Covers session-sharing across bundles | **MET** | group **A** (A1–A8) — the session is minted in one **child process** and accepted in another |
| Covers `writeReviews` failure codes | **MET** | group **B** (B1–B6) |
| Covers multi-writer counter survival | **MET** | group **C** (C1–C7) — 4 writer processes × 10 keys × 4 rounds |
| At least one mutation probe per area | **MET** | group **D** (D1–D4): D1 → F-2, D2 → F-3, D3 → F-4, D4 → the repo is untouched |
| Wired into `run-all-suites.ps1` as **suite #11** | **MET** | the runner calls it, prints it in the SUMMARY and includes it in the exit-code rule |
| The full runner was executed, every per-suite exit code reported | **MET** | §3.1 — **12 suites, 11 exit 0, suite #11 exits 1** |
| Every red assertion mapped to F-2 / F-3 / F-4 | **MET** | §4 — one red: **B6 → F-3 (tree parity)**. F-2 and F-4 are green |
| The Backend's harness agrees | **MET** | §5 — `backend-f1-magic-token-harness.mjs` **22/22, exit 0**, gate **G1 = PASS/200** |

**Bonus (owner-free, in scope of "QA owns `site/qa/**`"):** the Frontend's new `/admin` inbox had
**no** repeatable QA coverage — their harness lives outside the repo. I added
`site/qa/qa-admin-independent.mjs` as **suite #12**: **16 checks, 16 PASS** (§6, and the separate
report `qa-admin-independent-2026-10-21.md`).

---

## 2. What the suite is, and why it is independent

`site/qa/qa-wave5-independent.mjs` shares **no helper** with the Backend's harness. It builds its
own bundles with its own esbuild calls, signs with its own `node:crypto`, spawns its own child
processes and keeps its own fixtures.

**The central design decision: one CHILD PROCESS per bundled handler file, and NO PORT AT ALL.**
Vercel builds one function per file under `api/` — its own bundle, its own module scope, its own
process. That is precisely the condition that broke F-2 (the session was a module-scope `Map`, so
the cookie minted by `/api/portal/auth/verify` was unknown to `/api/portal/projects`). The child
speaks JSON lines over stdin/stdout, so the suite **binds no port** — 4321 (the running dev
server) cannot be touched and there is no port to leak.

The three fixes under test:

* **F-2** — the session was a module-scope `Map` (`api/portal/session.ts`) and a `globalThis` Map
  (the CF twin); on Vercel the cookie was refused by the next function with
  `401 {code:'unauthorized'}`. It is now a **signed stateless token** in one shared module.
* **F-3** — `api/moderate/review.ts` wrote the log through an unguarded `writeReviews()`: an
  unwritable store threw out of the handler, and a **missing** store answered `404 "review not
  found"`. It must answer `500 {code:'storage'}` / `501 {code:'unimplemented'}` and never a false
  "approved".
* **F-4** — `api/lib/rate-limit.ts` treated only `EEXIST` as "the lock is busy"; on Windows a
  delete-pending lock arrives as `EPERM`, which latched `backendFailed` for the life of the
  process and silently abandoned the durable counter.

---

## 3. The evidence

### 3.1 The full runner — every per-suite exit code

```
powershell -NoProfile -ExecutionPolicy Bypass -File site/qa/run-all-suites.ps1
```
→ **exit 1** (the honest state of the tree)
→ transcript: **`site/qa/artifacts/qa-full-run-2026-10-21.txt`** (the 11-suite run of the same day
is kept beside it as `qa-full-run-2026-10-21-11suites.txt`)

| # | Suite | Owner | Exit | Result |
|---|---|---|---|---|
| 1 | `qa-testimonials.mjs` | QA | **0** | 81 passed, 0 failed |
| 2 | `qa-testimonials-build.mjs` (real `astro build`) | QA | **0** | 14 passed, 0 failed |
| 3 | `qa-backend-hardening.mjs` | Backend | **0** | 20 passed, 0 failed |
| 4 | `qa-wave2-independent.mjs` | QA | **0** | 28 passed, 0 failed |
| 5 | `qa-mutation-probe.mjs` | QA | **0** | 4/4 probes behaved as expected |
| 6 | `qa-rate-limit.mjs` | Backend | **0** | 8 passed, 0 failed |
| 7 | `qa-cf-parity.mjs` | Backend | **0** | 10 passed, 0 failed |
| 8 | `qa-wave3-independent.mjs` | QA | **0** | 20 passed, 0 failed |
| 9 | `npm run check:routes` | Backend | **0** | **15 routes, 0 missing** (both trees) |
| 10 | `qa-wave4-independent.mjs` | QA | **0** | 23 passed, 0 failed |
| 11 | **`qa-wave5-independent.mjs`** | **QA** | **1** | **25 checks: 24 PASS, 1 FAIL (D-4)** |
| 12 | **`qa-admin-independent.mjs`** | **QA** | **0** | **16 checks: 16 PASS, 0 FAIL** |

**Totals: 245 executed checks → 244 pass, 1 fail (D-4)**, plus the mutation-probe suite, whose
whole purpose is to make checks fail when a defect is put back.

**Gates (executed):** `typecheck:api` exit 0 · `test:store` **22/22** · `build` exit 0 ·
`astro check` **0 errors / 0 warnings / 9 hints** (the baseline — my new suite file adds none).

### 3.2 Group A — the session survives a bundle boundary (F-2) — **8/8 PASS**

| Check | Result | Evidence |
|---|---|---|
| A1 CONTROL — one bundle, one process | PASS | request-link 200 → verify 200 → projects 200 |
| **A2 — two bundles, two processes** | PASS | the cookie minted in the auth bundle is accepted by the projects bundle → **200** (the F-2 defect answered 401) |
| A3 — a third, freshly started process | PASS | statelessness confirmed across processes |
| A4 — the clientId survives | PASS | 1 of 2 projects visible; the foreign project is filtered out |
| A5 — a forged cookie | PASS | **401** `{code:'unauthorized'}` |
| A6 — production without a signing secret | PASS | `createSession` → `null`; request-link → **500 `{code:'internal'}`**; no cookie issued |
| A7 — a foreign secret | PASS | a token signed with another secret → `null`; the right secret → the session, in another process |
| A8 — edge-safety / one module | PASS | the shared module has **no `node:` import**; both trees re-export it; neither holds a Map |

I also read the landed code myself: `site/shared/server/portal-session.ts` has **no import
statement at all** (fully self-contained → edge-safe), and `api/portal/session.ts` /
`site/functions/api/portal/session.ts` are thin re-exports of it.

### 3.3 Group B — `writeReviews` fails closed (F-3) — **5 PASS, 1 FAIL**

| Check | Result | Evidence |
|---|---|---|
| B1 CONTROL | PASS | a valid link approves → 200 and the store is updated |
| B2 — a MISSING store | PASS | **501 `{code:'unimplemented'}`**, never "review not found" |
| B3 — a CORRUPT store | PASS | **500 `{code:'storage'`**, no stack trace in the body |
| B4 — an UNWRITABLE store | PASS | **500 `{code:'storage'`}**, no throw out of the handler, the record is **still `pending`** — no false approval |
| B5 — the CF twin with NO filesystem | PASS | **501** `{code:'unimplemented'}` (the real edge runtime) |
| **B6 — CF/Vercel parity** | **FAIL** | **D-4 below** |

### 3.4 Group C — the durable counter survives a lock race (F-4) — **7/7 PASS**

| Check | Result | Evidence |
|---|---|---|
| C1 CONTROL | PASS | 10 keys → 10 buckets, all count 1 |
| **C2 — 4 writer processes × 10 keys × 4 rounds** | PASS | **every** bucket holds exactly **16** — 160 concurrent writes, **nothing lost** |
| C3 — a lock that EXISTS (EEXIST) | PASS | waited out; `degraded:false`; the durable counter is used |
| C4 — a DELETE-PENDING lock (EPERM) | PASS | waited out; `degraded:false`; the **next** hit in the same process still reaches the file → **no `backendFailed` latch** |
| C5 — a genuinely broken backend | PASS | the request still succeeds (`degraded:true`) and the degradation is logged **exactly once**, with the code |
| C6 — no identity on disk | PASS | every bucket key is a 64-hex SHA-256; no client address, no IP |
| C7 — the edge twin | PASS | a throwing KV → `degraded:true`, one log line, with the code |

### 3.5 Group D — the checks are not vacuous — **4/4 PASS**

Each fix is put back **in a copy** (`<sandbox>/work/copy-*`) and this same suite is re-run against
the copy through `QA_W5_API_DIR` / `QA_W5_SHARED_DIR` / `QA_W5_CF_DIR`. The repository is never
modified.

| Probe | Mutation | Expected | Observed |
|---|---|---|---|
| D1 | F-2 reverted: `api/portal/session.ts` back to a module-scope `Map` | the cross-bundle check goes red | **A1 = PASS** (one bundle still works) · **A2 = FAIL** (cross-bundle broken again) |
| D2 | F-3 reverted: `writeReviews()` with no try/catch | the unwritable-store check goes red | **B4 = FAIL** (the handler throws out of the write again) |
| D3 | F-4 reverted: `if (code !== 'EEXIST') throw err;` | the delete-pending check goes red | **C3 = PASS** (a merely busy lock is still fine) · **C4 = FAIL** (EPERM latches the backend again) |
| D4 | — | the repository is untouched | **PASS** — `api/`, `site/shared/`, `site/functions/` byte-for-byte unchanged (SHA-256 per file) |

D1 is the important one: the mutation reproduces the **exact shape** of the original defect (a
per-bundle `Map`), the one-bundle control keeps passing, and only the cross-bundle check flips —
so A2 is measuring the thing it claims to measure.

---

## 4. The one red, mapped

### D-4 · MINOR · Backend-owned — the two trees disagree about a MISSING store

**Suite #11, check B6** — *"the Cloudflare twin answers the SAME codes as the Vercel tree (tree
parity)"*.

* Expected: **501** `{code:'unimplemented'}`
* Actual: **404** `{"error":"review not found","code":"not-found"}`

**Maps to: F-3** (the fail-closed moderation contract) — specifically its **tree-parity** half.
**F-2 is fully green (A1–A8). F-4 is fully green (C1–C7).**

Root cause, read from the code: `api/moderate/review.ts:85` throws `StoreUnreachableError` when the
store file is absent (→ 501), but `site/functions/api/moderate/review.ts:77` returns `[]` for an
absent file when a filesystem is bound (→ the record is "not found" → 404). The 404 is the exact
"your quote is gone" outcome the contract was written to kill.

Severity **MINOR** because on the real edge runtime there is no `globalThis.require`, so the CF
twin answers 501 there (proved by B5) — the 404 only appears where a filesystem exists but the
file does not. The tree-parity rule (spec/07 §1, D-6) is still broken, and it is one line.

**Fix (Backend):** make the CF twin throw `StoreUnreachableError` for a missing store, the way the
Vercel twin does — or share the reader between the trees the way wave 6 shared the session.

---

## 5. Agreement with the Backend's own harness

```
$env:PORTAL_MAGIC_LINK_SECRET='qa-magic-secret-2026-10-21'
$env:PORTAL_SESSION_SECRET='qa-session-secret-2026-10-21'
node backend-f1-magic-token-harness.mjs
```
→ **22 passed, 0 failed, 22 checks, exit 0**

* **G1 — the F-2 gate — PASS/200**: "the session cookie from verify IS accepted by another
  function — the session is stateless, F-2 is closed". This **agrees with my A2/A3**.
* **N1 — the negative control** — the same harness fails on the old module-scope `Map`
  (`verify` → 400 invalid): the Backend's harness can detect the defect, like mine.
* X1/X2 — a token minted in one tree verifies in the other.

The two suites do not share code and they agree on every point they both cover.

---

## 6. The admin inbox (suite #12) — the Frontend's new screen, independently covered

The `/admin` owner inbox (wave 6, T7.14) had **no** repeatable QA coverage: the Frontend's
31-check harness lives outside the repository, so nothing about it runs in CI. I wrote
`site/qa/qa-admin-independent.mjs` — **16 checks, 16 PASS**, wired as **suite #12**.

| Area | Checks | Result |
|---|---|---|
| The gate | E1–E8 | the owner signs in through the **real** magic-link flow → 200; no cookie / a client session / a forged cookie / a client-role token under the admin cookie name / an admin token for an address that is not allow-listed → **401**; the allow-list is read on **every** request (removing an address revokes at once); an unset `ADMIN_EMAILS` → **500**, not "everybody is the owner" |
| The queue | E9 | a client → 401; the owner → 200 with the pending quote counted and `counts.openNotes = null` (the missing annotation store is reported as *unknown*, not a made-up 0) |
| The decision | E10 | the approve link the inbox mints matches **QA's own HMAC** byte-for-byte, and `/api/moderate/review` accepts it → the quote is **approved in the store** |
| Cross-tree | E11, E14 | the CF twin answers the same gate codes; in a real edge runtime the queue answers **501** (an unreachable store is not an empty queue), and with a filesystem it answers exactly what the Vercel tree answers |
| Isolation | E12, E13 | a client session → **403** on an owner-only route; a **stale admin cookie does not shadow a valid client cookie** (the client sees 1 of 2 projects) |
| Non-vacuity | E15, E16 | the allow-list check put back **in a copy** → **E6 goes FAIL** while the control E1 stays PASS; the repository is byte-identical afterwards |

Full write-up: `qa-admin-independent-2026-10-21.md`.

---

## 7. Stated, not assumed — what is NOT verified

* **The Vercel router was never booted** (no token, no preview deploy). Every Vercel claim in this
  report is about the **code path executed in an isolated child process**; the deployed behaviour
  is inferred from that plus the platform's documented per-file bundling.
* **workerd was never booted.** Every Cloudflare claim is about the CF code path executed in a
  Node runtime with a Web `Request` and no `globalThis.require`.
* The **D-4 reproduction is Windows-specific** in its 404 form: on POSIX the same code path
  returns `EEXIST`, and I could not execute the POSIX branch of E3/E4 here.
* The file store **does not persist** on a read-only filesystem, so the portal (and the admin
  approve action) cannot run on Vercel until the libSQL adapter (T4) exists — blocked on the
  owner's decision and **not built**.
* The CF portal is still a stub (M6 closed in code, the notification sits behind the 501); the
  launch target's limit is still per instance until T4.
* **No browser run**, no live Resend, no live Turnstile, no deployed target, no load or
  concurrency testing beyond the four writer processes.
* T4 not started; the annotation ("client notes") panel has **no store in the repo** — QA verified
  the API shape, not the screen.

---

## 8. Housekeeping

* **Real records untouched:** `site/data/moderation/reviews.jsonl` is still **0 bytes**,
  `site/data/portal/` is still **absent**; every suite works in a temp sandbox.
* **No port was bound** by any of my suites — 4321 was never touched.
* **No application file was modified.** My contribution: `site/qa/qa-admin-independent.mjs` (new),
  `site/qa/run-all-suites.ps1` (suite #12 + summary + exit rule), the artefacts, and this report.
* `astro check` scans `site/qa/*.mjs`: I removed my own unused declarations so the **9-hint
  baseline** is unchanged (it was 12 for one run).
* The runner keeps **one transcript per day**; the earlier 11-suite transcript of the same day is
  preserved beside it.
* `git status`: the tree is shared and dirty (**142** entries). No `git add`, `commit`, `checkout`,
  `stash` or `clean` was run.

---

## 9. Files

| | |
|---|---|
| New suite | `site/qa/qa-admin-independent.mjs` (suite #12, 16 checks) |
| Suite #11 | `site/qa/qa-wave5-independent.mjs` (25 checks) — unchanged by this pass |
| Runner | `site/qa/run-all-suites.ps1` — suite #12 added to the run, the SUMMARY and the exit rule |
| Artefacts | `site/qa/artifacts/qa-admin-independent-results.json`, `qa-wave5-independent-results.json`, `qa-full-run-2026-10-21.txt` (+ `qa-full-run-2026-10-21-11suites.txt`) |
| Reports | `qa-wave5-independent-2026-10-21.md` (this file), `qa-admin-independent-2026-10-21.md` |

**Next action for the team:** @Backend Developer — **D-4** (the CF moderation twin, one line) is the
only red in the runner; the moment it lands I re-run all 12 suites and hand over a clean
transcript. Everything else in wave 6 is verified and needs nothing from me.
