# QA report — wave 5/6 independent verification (F-2, F-3, F-4)

**Date:** 2026-10-21
**QA Engineer — Testing and Verification**
**Repo:** `C:\Users\Kalch\Documents\IXI` (branch `main`, shared dirty tree)
**Assignment:** @Manager — "write and wire an INDEPENDENT wave-5 suite" (objective, deliverable, acceptance criteria, verification)
**Backend's report under test:** `C:\Users\Kalch\Documents\IXI\backend-wave6-2026-10-21.md`

---

## 1. Status

**DONE — with one open defect (D-4, MINOR) found by the new suite.**

| | |
|---|---|
| New suite | `site/qa/qa-wave5-independent.mjs` — **25 QA-owned checks** |
| Wired in | `site/qa/run-all-suites.ps1` as **suite #11** |
| Full runner | **10 of 11 suites exit 0**; suite #11 exits **1** — and that red is **a real defect**, not a broken harness |
| Checks executed | **229 checks + 4 mutation probes** → **228 pass, 1 fail** (D-4) |
| Gates | `typecheck:api` exit 0 · `test:store` **22/22** · `build` **22 pages**, exit 0 · `check` **0 errors / 0 warnings / 9 hints** (the baseline) |

---

## 2. What I built, and why it is not a copy of the Backend's harness

`site/qa/qa-wave5-independent.mjs` shares **no helper** with `backend-wave6-harness.mjs`. It builds its own
bundles with its own esbuild calls, signs with its own `node:crypto`, spawns its own child processes and
stores its own fixtures.

**The central design decision: one CHILD PROCESS per bundled handler file, and NO PORT AT ALL.**

Vercel builds one function per file under `api/`: its own bundle, its own module scope, its own process.
That is exactly the condition that broke F-2 (the session was a module-scope `Map`, so the cookie minted by
`/api/portal/auth/verify` was unknown to `/api/portal/projects`). To reproduce it honestly, each handler is
bundled separately and loaded in its own `node` child. The child speaks **JSON lines over stdin/stdout**
(`{cmd:'request'|'rate'|'session'}` → `{status, headers, body}`), so the suite **binds no port** — 4321 (the
running dev server) cannot be touched, and there is no port to leak.

| Group | Checks | What it proves |
|---|---|---|
| **A** — session sharing (F-2) | 8 | A session minted in one bundle/process is accepted by another; a forged cookie is not; production without a secret mints nothing; both trees re-export one edge-safe module |
| **B** — writeReviews (F-3) | 6 | The moderation store that is missing / corrupt / unwritable never reads as "review not found" and never reads as "approved" |
| **C** — the lock (F-4) | 7 | Concurrent writers lose no counts; a busy lock is waited out; the durable counter is never abandoned; a broken backend degrades instead of failing the request |
| **D** — mutation probes | 4 | Each fix is put back in a **copy** and the matching check is shown to go **red**; the repository is proven byte-identical afterwards |

---

## 3. The evidence

### 3.1 The full runner — every per-suite exit code

`powershell -NoProfile -ExecutionPolicy Bypass -File site/qa/run-all-suites.ps1`
→ **exit 1** (the honest state of the tree)
→ transcript: **`site/qa/artifacts/qa-full-run-2026-10-21.txt`**

| # | Suite | Owner | Exit | Result |
|---|---|---|---|---|
| 1 | `qa-testimonials.mjs` | QA | **0** | 81/81 |
| 2 | `qa-testimonials-build.mjs` (real `astro build`) | QA | **0** | 14/14 |
| 3 | `qa-backend-hardening.mjs` | Backend | **0** | 20/20 |
| 4 | `qa-wave2-independent.mjs` | QA | **0** | 28/28 |
| 5 | `qa-mutation-probe.mjs` | QA | **0** | 4/4 probes behaved as expected |
| 6 | `qa-rate-limit.mjs` | Backend | **0** | 8/8 |
| 7 | `qa-cf-parity.mjs` | Backend | **0** | 10/10 |
| 8 | `qa-wave3-independent.mjs` | QA | **0** | 20/20 |
| 9 | `npm run check:routes` | Backend | **0** | 13 routes, 0 missing |
| 10 | `qa-wave4-independent.mjs` | QA | **0** | 23/23 |
| 11 | **`qa-wave5-independent.mjs`** | **QA** | **1** | **25 checks: 24 PASS, 1 FAIL (D-4)** |

### 3.2 Group A — the session survives a bundle boundary (F-2)

| Check | Result | Evidence |
|---|---|---|
| A1 CONTROL — one bundle, one process | PASS | request-link 200 → verify 200 → projects 200 |
| **A2 — two bundles, two processes** | **PASS** | the cookie minted in the auth bundle is accepted by the projects bundle → **200** (the F-2 defect answered 401) |
| A3 — a third, fresh process | PASS | a client session minted in one process is accepted in another (statelessness) |
| A4 — the clientId survives | PASS | 1 of 2 projects visible; the foreign project is filtered out |
| A5 — a forged cookie | PASS | 401 `{code:'unauthorized'}` for both cookie names |
| A6 — production without a secret | PASS | `createSession` → **null**; request-link → **500 `{code:'internal'}`**; no cookie issued |
| A7 — a foreign secret | PASS | a token signed with another secret → null; the right secret → the session, in another process |
| A8 — edge-safety / one module | PASS | the shared module has **no `node:` import**; both trees re-export it; neither holds a Map |

### 3.3 Group B — writeReviews fails closed (F-3)

| Check | Result | Evidence |
|---|---|---|
| B1 CONTROL | PASS | a valid link approves → 200 and the store is updated |
| B2 — a MISSING store | PASS | **501 `{code:'unimplemented'}`**, and never "review not found" |
| B3 — a CORRUPT store | PASS | **500 `{code:'storage'`**, no stack trace in the body, the store is untouched |
| B4 — an UNWRITABLE store | PASS | **500 `{code:'storage'`**, no throw out of the handler, the record is **still `pending`** — no false approval |
| B5 — the CF twin, no filesystem | PASS | 501 `{code:'unimplemented'}` (the real edge runtime) |
| **B6 — CF/Vercel parity** | **FAIL** | **D-4 below** |

### 3.4 Group C — the durable counter survives a lock race (F-4)

| Check | Result | Evidence |
|---|---|---|
| C1 CONTROL | PASS | 10 keys → 10 buckets, all count 1 |
| **C2 — 4 writer processes × 10 keys × 4 rounds** | **PASS** | **every** bucket holds exactly **16** — 160 concurrent writes, **nothing lost** |
| C3 — a lock that EXISTS (EEXIST) | PASS | the writer waits it out; `degraded:false`; no degradation logged; the durable counter is used |
| C4 — a DELETE-PENDING lock (EPERM) | PASS | the writer waits it out; `degraded:false`; the **next** hit in the same process still reaches the file (count 2) — i.e. **no `backendFailed` latch** |
| C5 — a genuinely broken backend | PASS | the request still succeeds (`degraded:true`), and the degradation is logged **exactly once**, with the error code |
| C6 — no identity on disk | PASS | every bucket key is a 64-hex SHA-256; no client address, no IP |
| C7 — the edge twin | PASS | a throwing KV → `degraded:true`, one log line, with the code |

### 3.5 Group D — the checks are not vacuous

Each fix is put back **in a copy** (`<sandbox>/work/copy-*`) and this same suite is re-run against the copy
through `QA_W5_API_DIR` / `QA_W5_SHARED_DIR`. The repository is never modified.

| Probe | Mutation | Expected | Observed |
|---|---|---|---|
| D1 | F-2 reverted: `api/portal/session.ts` replaced with a module-scope `Map` session | the cross-bundle check goes red | **A1 = PASS** (one bundle still works) · **A2 = FAIL** (the cross-bundle session is broken again) |
| D2 | F-3 reverted: `writeReviews()` with no try/catch | the unwritable-store check goes red | **B4 = FAIL** (the handler throws out of the write again) |
| D3 | F-4 reverted: `if (code !== 'EEXIST') throw err;` | the delete-pending check goes red | **C3 = PASS** (a merely busy lock is still fine) · **C4 = FAIL** (EPERM latches the backend again) |
| D4 | — | the repository is untouched | **PASS** — `api/`, `site/shared/` and `site/functions/` are byte-for-byte unchanged (SHA-256 per file) |

D1 is the important one: the mutation reproduces the **exact** shape of the original defect (a per-bundle
`Map`), the one-bundle control keeps passing, and only the cross-bundle check flips — so A2 is measuring
the thing it claims to measure.

---

## 4. D-4 · MINOR — the two trees disagree about a MISSING moderation store

**File:** `site/functions/api/moderate/review.ts:77`
**Twin:** `api/moderate/review.ts:85`

```ts
// api/moderate/review.ts:85            (Vercel)
if (!fs.existsSync(REVIEWS_FILE)) throw new StoreUnreachableError();   // -> 501 {code:'unimplemented'}

// site/functions/api/moderate/review.ts:77   (Cloudflare)
if (!fs.existsSync(REVIEWS_FILE)) return [];                          // -> 404 {code:'not-found'}
```

**Reproduced by execution** (check B6): with a filesystem present and the store file absent, the Vercel tree
answers **501 `{code:'unimplemented'}`** and the Cloudflare tree answers
**404 `{"error":"review not found","code":"not-found"}`** for the *same* signed link.

**Why it matters:** `404 "review not found"` is the exact outcome the audit called "your quote is gone" — the
owner is told the pending review does not exist while the client still sees it waiting for approval. The
wave-4 fix (D-1) gave the edge tree the shared strict parser, so the **corrupt** store is handled; the
**missing** store is the case that was left lenient. It breaks the tree-parity rule (spec/07 §1, D-6).

**Severity: MINOR, not MAJOR** — on the real edge runtime there is no `globalThis.require`, so `edgeFs()`
returns null and the Cloudflare tree answers **501** (proved by check B5). The 404 is only reachable where a
filesystem exists but the file does not, and the Cloudflare portal is a stub anyway (every portal endpoint is
501 and the launch target is Vercel).

**Fix (one line, Backend-owned):** make the edge twin throw `StoreUnreachableError` for a missing file, the
way the Vercel twin does — or, better, share the reader between the trees the way the session was shared in
wave 6.

**Owner:** @Backend Developer (`site/functions/**` is Backend territory).

---

## 5. Wave 6 broke my own harnesses — what I repaired (and what it says about the product)

The first full run after wave 6 was **red in four suites**, and the cause is worth recording:

```
[qa] SUITE ERROR Error: request-link for owner@imk.test should be 200 -- expected 200, got 500
```

Wave 6 made the **session secret mandatory in production** (`createSession()` returns null without
`PORTAL_SESSION_SECRET` / `PORTAL_MAGIC_LINK_SECRET`; the endpoint answers 500). That is **correct product
behaviour** — fail closed — but my wave-2, wave-3 and wave-4 suites, written before wave 6, minted a session
with no secret configured and died at the first sign-in. The same trap took out the Backend's `qa-cf-parity`
suite (its `C1` answered 403 instead of 501), and the Backend asked QA for the fix.

**Repaired (QA-owned files only — no application code was touched):**

| File | Change |
|---|---|
| `site/qa/qa-cf-parity.mjs` | `PORTAL_SESSION_SECRET` added to **both** `cfEnv()` (what the handler verifies with) and `process.env` (what `createSession()` falls back to) — the Backend's requested two-line fix. **10/10 now.** |
| `site/qa/qa-wave2-independent.mjs` | `PORTAL_MAGIC_LINK_SECRET` + `PORTAL_SESSION_SECRET` added → **28/28** |
| `site/qa/qa-wave3-independent.mjs` | same → **20/20** |
| `site/qa/qa-wave4-independent.mjs` | same → **23/23** |

These are **QA-local test secrets**, not credentials.

**What it proves about the product:** the fail-closed rule is real and it is now covered by A6 — a production
instance without `PORTAL_SESSION_SECRET` cannot mint a session, cannot send a sign-in link and answers
**500 `{code:'internal'}`**. The Backend's own note ("`PORTAL_SESSION_SECRET` must be in the production env
list, or every sign-in answers 500") is **confirmed by execution**, not by reading the code.

---

## 6. Executed vs proposed

### Executed (every number above came from a run)

- `node site/qa/qa-wave5-independent.mjs` → **25 checks: 24 PASS, 1 FAIL (D-4)**, exit 1
- `powershell -NoProfile -ExecutionPolicy Bypass -File site/qa/run-all-suites.ps1` → **11 suites, exit 1**,
  transcript `site/qa/artifacts/qa-full-run-2026-10-21.txt`
- `npm run typecheck:api` → exit 0
- `npm run test:store` → **22/22**, exit 0
- `npm run build` → **22 pages**, exit 0
- `npm run check` → **0 errors / 0 warnings / 9 hints**, exit 0
- The four mutation probes: each executed against a patched copy, with the expected checks observed RED

### Proposed (NOT executed — no target available here)

- A **Vercel preview deploy** to observe the real router, the real function-per-file bundling and
  `process.cwd()` on the platform. Every claim about Vercel in this report is about the **code path executed
  in isolation**, not about a deployed instance.
- **workerd**: no `wrangler`/workerd binary on this machine, so the Cloudflare claims are about the CF
  **code path executed in Node's Web-standard runtime** (with `globalThis.require` bound to a fake `node:fs`,
  or absent — which reproduces the edge runtime exactly).
- A **browser** run of the sign-in flow, a live **Resend**/**Turnstile** call, and the **T4** storage
  migration (not started — every JSONL behaviour above is still live code).
- The **TTL boundaries** of the session token (the expiry check was exercised, the exact boundary was not).

### Not verified by this suite

- The CF portal is a **stub**: every portal endpoint answers 501, so the M6 notification path still sits
  behind the 501.
- The launch target's rate limit is still **per instance** until T4 (the file backend is opt-in via
  `PORTAL_RATE_LIMIT_FILE`; Vercel's function filesystem is read-only).

---

## 7. Housekeeping

- `site/data/moderation/reviews.jsonl` — still **0 bytes**; `site/data/portal/` — still **absent**. The suite
  resolves its data paths from `process.cwd()` and runs entirely in a temp sandbox.
- `site/src/content/testimonials/` — empty (no fixture was published by these runs).
- `git status` — **136 entries** (the shared dirty tree). My contribution: **1 new suite**, **3 new artifacts**
  (`qa-wave5-independent-results.json`, `qa-full-run-2026-10-21.txt`, and the earlier `qa-full-run-2026-10-20.txt`
  kept), and **5 modified QA files** (the four suites above + `run-all-suites.ps1`). **No application file was
  touched.**
- `run-all-suites.ps1` now writes **one transcript per day** instead of overwriting the previous run.
- `astro check` scans `site/qa/*.mjs`: my file initially added **one** unused-variable hint, which I removed
  — the baseline is back to **9 hints**.
- All sandboxes were removed; the two `--keep` sandboxes from the debug runs were deleted.

---

## 8. Verdict

**The wave-6 code passes.** F-2, F-3 and F-4 are closed **on the Vercel tree**, and each of the three fixes
is now covered by a check that was shown to go **red** when the fix is removed — so the checks are evidence,
not decoration. The Cloudflare tree is in parity for the corrupt store and for the no-filesystem case.

**One open defect: D-4** (`site/functions/api/moderate/review.ts:77` — a missing store answers 404 where the
Vercel tree answers 501). One line, Backend-owned, MINOR.

**Suggested order for the next wave:** D-4 (Backend) → the storage migration T4 (the portal still cannot run
on a read-only function filesystem) → a Vercel preview deploy to replace the last set of assumptions with
observations.
