# QA re-run — reviews/testimonials, fix wave 4

**Date:** 2026-10-20 · **Author:** QA Engineer — Testing and Verification
**Repo:** `C:\Users\Kalch\Documents\IXI` · **HEAD:** `8303af9` (+ the uncommitted wave-4 tree)
**Scope:** the Backend's fix wave 4 — the F-1 route table, the deploy root, the route manifest check, the F-2 CI paths, and the wave-3 findings D-1 (CF moderation reader) and D-2 (file counter lock).

---

## 1. Verdict

**Status: DONE — the re-run is complete. One new defect is open (D-3).**

**204 executed checks + 4 mutation probes → 202 pass, 2 fail.** Both failures are the **same root cause**, found by my own new suite:

> **D-3 · MAJOR (file backend, Windows) — the durable rate counter still loses counts under contention, because a transient "lock is busy" condition is misread as "the backend is broken".**

Everything else the wave-4 change claimed is **verified by execution**, including the six behaviours the Backend asked me to check independently.

---

## 2. What I ran (executed — not proposed)

`powershell -NoProfile -ExecutionPolicy Bypass -File site/qa/run-all-suites.ps1`

| # | Suite | Owner | Result |
|---|---|---|---|
| 1 | `qa-testimonials.mjs` (API, real handlers) | QA | **81/81**, exit 0 |
| 2 | `qa-testimonials-build.mjs` (real `astro build`) | QA | **14/14**, exit 0 |
| 3 | `qa-backend-hardening.mjs` | Backend | **20/20**, exit 0 |
| 4 | `qa-wave2-independent.mjs` | QA | **28/28**, exit 0 |
| 5 | `qa-mutation-probe.mjs` | QA | **4/4** probes behaved as expected |
| 6 | `qa-rate-limit.mjs` | Backend | **8/8**, exit 0 |
| 7 | `qa-cf-parity.mjs` | Backend | **10/10**, exit 0 |
| 8 | `qa-wave3-independent.mjs` | QA | **20/20**, exit 0 *(was 19/20 — my `D2` is inverted, see §4)* |
| 9 | `npm run check:routes` | Backend | **13 routes, 0 missing**, exit 0 |
| 10 | `qa-wave4-independent.mjs` **(new, QA-owned)** | QA | **21/23**, exit 1 — `E3`, `E4` red (§5) |

**Runner exit code: 1** — and that is the honest state of the tree. Every suite is green except the two checks that cover D-3.

**Transcript:** `site/qa/artifacts/qa-full-run-2026-10-20.txt` (the runner now writes there; the earlier wave-2 file is kept as history).
**Machine-readable:** `site/qa/artifacts/qa-wave4-independent-results.json` (21 passed / 2 failed, per check).

**Gates** (`site/`): `npm run check:routes` exit 0 (13 routes, 0 missing) · `npm run typecheck:api` exit 0 · `npm run test:store` 22/22 · `npm run build` 22 pages, exit 0 · `npm run check` **0 errors, 0 warnings, 13 hints** — the Backend's baseline, unchanged: my new suite file first added 2 hints (an unused parameter and an unused variable) and I removed them.

---

## 3. My own independent checks (the Backend's claim is not the evidence)

New file: **`site/qa/qa-wave4-independent.mjs`** — 23 checks, own harness, own port (4451), own sandbox, own signing code, no shared helper with the Backend's suites. It maps 1:1 onto the six behaviours the Backend asked for:

| Asked | My check | What it proves | Result |
|---|---|---|---|
| (a) every `/api` URL the front-end calls has a function file in **both** trees | **A1** | QA's own parser over `site/src` (frontmatter + `<script>` blocks only) finds **13 client routes**; each has a function file in `api/` **and** `site/functions/api/`. The check also asserts the inventory really contains the 7 critical routes, so the check cannot pass vacuously | PASS |
| | **A2** | the same for the **11** routes the server trees name | PASS |
| | **A3 / A4** | the 5 wave-4 route files exist in both trees; **no catch-all** route file (`[...slug].ts`) hides a missing path; the only dynamic files are the 4 `[id].ts` | PASS |
| (b) `check:routes` FAILS when a route file is missing | **B1/B2/B3** | CONTROL: exit 0 on an untouched **copy** of the tree. Then, **on the copy**: delete `api/portal/auth/request-link.ts` → exit ≠ 0 and the output names the missing route; delete `site/functions/api/portal/projects/[id].ts` → exit ≠ 0 and names the dynamic route. The repository is never modified — verified byte-identical afterwards (G2) | PASS |
| (c) the CI invariant check names paths that exist for `working-directory: site` | **C1** | QA's own workflow parser (jobs × their own `working-directory`, falling back to the workflow default) resolves all three `test -f` assertions — `../api/contact.ts`, `functions/api/contact.ts`, `../vercel.json` — against `site/`; **2 of the 3 live outside `site/`**, so the resolution base is genuinely exercised | PASS |
| | **C2/C3** | the new CI steps (`check:routes`, `typecheck:api`) exist in `site/package.json`; the workflow runs in `site/` and says so | PASS |
| (d) the by-id handlers answer with the id **from the path and from `req.query.id`**, and a foreign id is refused | **D1–D4** | owner `PATCH /api/portal/projects/<id>` → 200, status changed · owner `PATCH /api/portal/projects` with `req.query.id` → 200, status changed · **foreign** id: GET → **403**, PATCH → **403**, unknown id → **404** · same for plan items (path → `done`, `query.id` → `in-progress`, foreign → 403, unknown → 404) | PASS |
| | **D5** | the by-id route files really export a callable handler (bundled and executed, not read) | PASS |
| (e) keep `B5` (corrupt store → 500) and `C2` (two writers lose no counts) | **E1/E2** | a corrupt moderation store answers **500 `{code:'storage'}`** on the CF tree **and** on the Vercel tree — never 404 | PASS |
| | **E3/E4** | the two-writer property | **FAIL — see §5** |
| (f) the CF moderation endpoint answers 501 (not 404) when the store cannot be reached | **F1** | with `globalThis.require` absent (the real edge runtime) → **501 `{code:'unimplemented'}`** | PASS |
| | **F2** | a forged link is refused before the store is touched → 400 `{code:'signature'}` | PASS |
| housekeeping | **G1/G2** | the repository `site/data/` untouched; the copy-based vacuity proof left the repository byte-identical | PASS |

---

## 4. My `D2` is inverted

`qa-wave3-independent.mjs` → `D2` asserted that the repository had **no** file able to serve the auth sub-paths — i.e. it asserted that the F-1 defect was **present**. The defect is fixed, so the check now asserts the route table **exists**: the 5 route files in both trees, no catch-all, and the deploy root declared in `vercel.json` + a root `package.json`.

`D1` was re-titled ("the bare auth path has no route (404) while the sub-path answers") because that is what it actually asserts now. `D3` (the front-end really calls the sub-paths) is unchanged.

**Wave-3 suite: 19/20 → 20/20.**

---

## 5. D-3 — the durable rate counter still loses counts (OPEN)

**Severity: MAJOR for the `file` backend (spec/08 §4.7.1 promises "durable … shared by every process on the host"). MINOR for the launch target (Vercel uses the memory backend, where the limit is per instance and already documented as best-effort). Platform: the failure mode below is Windows-specific.**

### 5.1 The mechanism

`api/lib/rate-limit.ts` → `withFileLock()` decides "somebody else holds the lock" by comparing the error code with `EEXIST`:

```ts
} catch (err) {
  const code = (err as NodeJS.ErrnoException).code;
  if (code !== 'EEXIST') throw err;          // <-- everything else = "the backend is broken"
  ...
}
```

On Windows a lock file can be in the **"delete pending"** state (a process closed-and-unlinked it while a handle is still open). Opening it again with `'wx'` then fails with **EPERM**, not `EEXIST`. EPERM is therefore rethrown out of `hit()`, and `RateLimiter.consume()` catches it and sets `backendFailed = true` **for the lifetime of the process**:

- every later hit goes to the **per-process in-memory counter**;
- the **durable counts are lost** (the file no longer sees that process's hits);
- the cross-process limit **stops being enforced** — exactly the guarantee the file backend was added for;
- the error is swallowed with **no log** (`catch { ... }` in `consume()`).

### 5.2 Reproduction (all executed)

1. **Deterministic** — check `E3`: a helper process puts the lock into the delete-pending state (open with `'wx'`, unlink, keep the handle). Then:
   `createFileBackend(file).hit('qa-busy-key', 600000)` →
   `EPERM: operation not permitted, open '…/busy-counters.json.lock'`
   instead of the module's own diagnosable `rate-limit: could not take the counter lock`.
2. **Under load** — check `E4`: 4 writers × 40 keys × 8 rounds against one counter file →
   **2 of 8 rounds lost buckets (80 of 1280)**.
3. **Instrumented** (a QA probe that printed the swallowed error):
   `[probe] BACKEND ERROR EPERM EPERM: operation not permitted, open '…/race.json.lock'` —
   and the rounds that lost buckets are exactly the rounds in which a process took the EPERM and degraded.
4. **Control**: a lock that is merely *held* (not delete-pending) is handled correctly — the waiter retries and the module reports its own error. Only the transient Windows state is misclassified.

### 5.3 Why the wave-3 fix did not close it

The exclusive lock file serialised the read-modify-write, and that part works: the loss dropped from "75 of 200 buckets, 4 rounds out of 4" (wave 3, pre-fix) to "80 of 1280, 2 rounds out of 8". What is left is the *error classification*: a normal, transient condition on the platform is treated as a broken backend.

### 5.4 Suggested fix (small)

- treat the platform's busy codes as **busy, retry**: `EEXIST`, `EPERM`, `EACCES`, `EBUSY` → wait and retry instead of rethrowing; **or**
- use a **directory lock** (`fs.mkdirSync`, atomic on every platform) instead of `open(…, 'wx')`;
- and **log the degradation once** (the decision already carries `degraded: true`; nobody looks at it), so a silent loss of the durable guarantee is diagnosable.

After the fix, `E3` and `E4` go green and the runner exits 0 again.

---

## 6. One informational note on the Backend's own route script (no defect today)

`site/scripts/check-api-routes.mjs` finds routes with a **regex over quoted text**. An apostrophe in HTML prose — `site/src/pages/login.astro`: *"we'll send a one-time sign-in link"* — pairs with the next quote in the file, so the scanner swallows the route that sits in between (`/api/portal/auth/request-link`). In this repository the server trees name the same routes, so the manifest still ends up complete (13 routes, 0 missing) and the check is not wrong **today**. But a **client-only** route — one the server never names — could slip through the manifest unnoticed.

QA's own parser (scan the frontmatter and the `<script>` blocks, not the HTML prose) finds the same 13 client routes and is immune to this. Not a blocker; worth hardening if the route surface grows.

---

## 7. My own harness had two false alarms (reported, not hidden)

The first execution of my new suite failed 2 of 22 — both in **my** code, not the product:

1. my string scanner walked the whole `.astro` file and paired an apostrophe in the HTML with a quote in the script → a route was missed;
2. my workflow parser attributed the workflow-level `defaults` to a fake job and resolved the CI paths against the repository root → a false CI failure.

Both were fixed (a real scanner over the code parts only; a job-aware workflow parser) and the suite re-run. The product was right in both cases; my harness was wrong.

---

## 8. Housekeeping

- `site/data/moderation/reviews.jsonl` — still **0 bytes** (`SHA-256 E3B0C442…B855`), mtime unchanged.
- `site/data/portal/` — still **absent**.
- The dev server on **4321** was **not** touched (PID 29204 before and after).
- Every sandbox was created under `%TEMP%\opencode\qa-wave4-*` and removed afterwards; the copy used by the vacuity proof was removed too.
- Tracked-file `git status` — **128 lines = the session baseline 124 + my 4 new files** (`site/qa/qa-wave4-independent.mjs`, `site/qa/artifacts/qa-wave4-independent-results.json`, `site/qa/artifacts/qa-full-run-2026-10-20.txt`, this report). The two files I edited (`site/qa/qa-wave3-independent.mjs`, `site/qa/run-all-suites.ps1`) live inside the untracked `site/qa/` folder, so they do not change the count.
- New files: `site/qa/qa-wave4-independent.mjs`, `site/qa/artifacts/qa-wave4-independent-results.json`, `qa-reviews-testimonials-wave4-2026-10-20.md` (this report). Changed: `site/qa/qa-wave3-independent.mjs` (D2 inverted, D1 re-titled), `site/qa/run-all-suites.ps1` (suites #9 and #10).

---

## 9. Not verified — stated, not assumed

1. **The workerd runtime was never booted.** `wrangler`/workerd is not installed on this machine. Every Cloudflare claim here is a claim about the **Cloudflare code path executed in Node's Web-standard runtime** (`Request`/`Response`/`crypto.subtle`), not about Cloudflare's runtime.
2. **The Vercel router was never booted** (`vercel build` refuses without a valid token). The route table is verified statically, by the machine check, and by executing the handlers — not by running the real router.
3. **The Cloudflare portal is still a stub**: every portal endpoint answers `501 {code:'unimplemented'}`. M6 is closed **in code**, but the notification path sits behind that 501 — the launch target stays the Vercel tree.
4. **The rate limit is per instance on the launch target** until the shared store (T4) lands. The storage migration is **not started**, so every JSONL behaviour above is still live code.
5. No browser run · no live Resend/Turnstile · TTL paths tested at their boundaries rather than by waiting out the clock.
6. The D-3 reproduction is **Windows-specific**; on Linux the same code path returns `EEXIST` and behaves correctly. I did not run the suite on Linux — the POSIX branch of `E3` is written but **not executed here**.

---

## 10. Fix order

1. **D-3** — the lock's error classification in `api/lib/rate-limit.ts` (+ the edge twin if it shares the pattern) → `E3`/`E4` green, runner exit 0.
2. *(optional)* harden `check-api-routes.mjs` against apostrophes in HTML prose (§6).
3. After that: the launch blockers are unchanged and are **not** QA's to close — the storage decision (Turso/Neon + Vercel), the consent wording, the domain, the Calendly link, the Resend sender identity, and the Vercel **Root Directory = repo root** setting (DevOps).
