# QA re-run — reviews/testimonials, fix wave 3

**Date:** 2026-10-20 · **Tester:** QA Engineer (Chief QA Engineer) · **Repo:** `C:\Users\Kalch\Documents\IXI`
**HEAD:** `8303af9` · **Scope:** the wave-3 diff (pluggable rate limiter, Cloudflare tree executed) + the two open items QA carried from wave 2.

---

## 1. Verdict

| | |
|---|---|
| **Status** | **DONE** — the re-run is complete |
| **Functional result** | **PASS** — every acceptance check in the wave-3 brief passes |
| **Defects** | **2 confirmed new defects (1 MAJOR, 1 MINOR)** + **1 MAJOR deployment finding** outside the wave-3 diff |
| **Release posture** | The backend contract is green, but the **launch target cannot currently serve the sign-in door** (F-1). This is not a wave-3 regression — it was never wired. |

**One line:** the wave-3 code is sound and every check the Backend asked for passes; the two things I could not let through are a silent-outage class that survived in one Cloudflare file, and a counter file that loses counts when two serverless functions share it.

---

## 2. What I executed (no invented results)

### 2.1 The seven existing suites — `powershell -NoProfile -ExecutionPolicy Bypass -File site/qa/run-all-suites.ps1`

Runner exit code **0**. Every suite ran in its own sandbox on its own port (4399 / 4411 / 4421 / 4431-4433). Port 4321 (the running dev server) was never used.

| Suite | Owner | Result |
|---|---|---|
| `qa-testimonials.mjs` (API, real handlers) | QA | **81 / 81**, exit 0 |
| `qa-testimonials-build.mjs` (real `astro build`) | QA | **14 / 14**, exit 0 |
| `qa-backend-hardening.mjs` | Backend | **18 / 18**, exit 0 |
| `qa-wave2-independent.mjs` | QA | **28 / 28**, exit 0 |
| `qa-mutation-probe.mjs` | QA | **4 / 4 probes behaved as expected**, exit 0 |
| `qa-rate-limit.mjs` | Backend | **8 / 8**, exit 0 |
| `qa-cf-parity.mjs` | Backend | **9 / 9**, exit 0 |
| | | **158 checks + 4 probes, 0 failures** |

### 2.2 My own independent suite — `site/qa/qa-wave3-independent.mjs` (new, QA-owned)

**20 checks — 18 PASS, 2 FAIL.** It shares no helper with the Backend's `qa-rate-limit.mjs` or `qa-cf-parity.mjs`: its own harness, its own sandbox, its own ports (4441 / 4442), and — for the cross-target link test — **its own HMAC signing with `node:crypto`**, so a link the two trees build differently cannot pass by agreeing with itself.

### 2.3 The four gates — run in `site/`

| Gate | Result |
|---|---|
| `npm run typecheck:api` | **exit 0** (api + functions + shared) |
| `npm run test:store` | **22 tests, 22 pass, 0 fail** |
| `npm run build` | **exit 0 — 22 pages** (verified by counting `site/dist/**/*.html`) |
| `npm run check` | **exit 0 — 0 errors, 0 warnings, 8 hints** (the baseline) |

**Total executed this run: 178 checks + 4 mutation probes → 176 pass, 2 fail.**

---

## 3. The five checks the Backend asked QA to write independently

| # | Required check | Result | Evidence |
|---|---|---|---|
| **(a)** | A request that fails validation must still burn **no** rate-limit slot, through the **new** code path | **PASS** | A1, A2, A3, A4. Seven submit requests were made (1 refused by validation, 5 allowed, 1 refused by the limit). The durable counter file holds a submit bucket of **6** — the five valid requests plus the blocked one, because check and consume are one operation. The refused-by-validation request consumed **nothing**: no submit bucket existed at all until the first valid request. |
| **(b)** | The limiter must not fail a request when its backend throws (degrade, not 500) | **PASS** | A7 (module level: `degraded=true`, the fallback still enforces the limit, no throw) and **A8 (handler level)**: a second, independent instance of the handlers was pointed at a counter path whose parent is a regular file, so `mkdirSync` throws on every write. The submission came back **200**, not 500 — the limiter degraded to the in-memory counter and the request was served. |
| **(c)** | No client id and no IP address may appear in a durable counter file or in a KV key | **PASS** | A5: the counter file contains **no** email, **no** client id, **no** IP, and every bucket key is a 64-hex SHA-256 digest. A6: the edge KV backend writes `portal:<sha256>` only — the raw IP and the raw client id are absent. |
| **(d)** | Every Cloudflare portal endpoint must answer 501 on a runtime without a filesystem, and must **not** answer 200 with an empty list | **PASS** | B1: all **16** CF portal paths were executed with `globalThis.require` absent (exactly the edge runtime). None answered 200. Reads answer **501 unimplemented**; the write paths answer **403 forbidden** (an authorisation refusal, which is honest); auth answers 400. No endpoint returns a collection. |
| **(e)** | A link signed by the Vercel tree must be accepted by the Cloudflare moderation endpoint, and a forged one rejected | **PASS** | B2: QA signed the link itself with `node:crypto` → the CF endpoint answered **200** and flipped the record. B3: a forged signature → **400 signature**, the record untouched. B4 (extra): a link for a superseded revision → **409 stale-revision**, nothing approved. |

---

## 4. Defects found by QA in this re-run

### D-1 — MAJOR · The Cloudflare moderation endpoint still swallows a corrupt store (audit M3 / QA D3 class)

**Where:** `site/functions/api/moderate/review.ts:32-52`

```ts
resolve(content.split('\n').filter(...).map((l: string) => JSON.parse(l)));
} catch {
  resolve([]);          // <-- a malformed line becomes an EMPTY store
}
```

The CF twin keeps its own reader instead of using the shared strict parser, and a bad line makes it resolve an **empty array**. The comment above the function claims the opposite — *"a malformed line is reported by the store adapter, not silently skipped"*. It is skipped.

**Reproduced (B5):** one malformed line in `site/data/moderation/reviews.jsonl` + a correctly signed approve link →

| Tree | Answer |
|---|---|
| Vercel (`api/moderate/review.ts`) | **500 `{code:'storage'}`** ✅ (control B6 — passed) |
| Cloudflare (`site/functions/api/moderate/review.ts`) | **404 `{code:'not-found'}`** ❌ |

**Impact:** exactly the outage class wave 1 closed. The owner clicks the one-click approve link and is told **"review not found"** — while the quote is still `pending` and the client is still waiting for approval. The owner has no way to tell "the quote is gone" from "the store is broken". On the Vercel tree the same store answers 500 and names the file and the line.

**Scope check (executed):** a sweep of every `JSON.parse` in both trees shows this is the **only** lenient JSONL reader left in the repository. The Vercel tree is clean.

**Fix:** make the CF moderation reader use `parseJsonlStrict` from `site/shared/portal-store/jsonl.ts` and wrap the handler in `guardStorage` → 500 `{code:'storage'}` with the file and the line, exactly like the Vercel twin. The module is edge-safe (no `node:` imports), so nothing blocks it.

**Owner:** @Backend Developer.

---

### D-2 — MINOR · The file-backed rate counter loses counts when two serverless functions share the file

**Where:** `api/lib/rate-limit.ts:135-152` (`createFileBackend.hit`)

The file backend is a read-modify-write with no lock: `readState()` → modify → `writeState()` (write-then-rename). Two processes writing the same file interleave, and the later write clobbers the earlier one.

**The module's own contract says the opposite** — *"Durable across restarts and **shared by every process on the same host**"* — and the file backend is explicitly offered for a multi-process host. But in production `api/portal/testimonials.ts` and `api/portal/auth.ts` are **two separate Vercel functions**: two processes, two module instances, one `PORTAL_RATE_LIMIT_FILE`.

**Reproduced (C2), with a control (C1):**

| Test | Result |
|---|---|
| C1 — **one** process, 25 keys | **25 / 25 buckets kept** ✅ (control: the loss is not caused by the harness) |
| C2 — **two** processes, 25 keys each, 4 rounds | **4 / 4 rounds lost buckets — 75 of 200 lost** ❌ |

**Impact:** the limit is silently *weaker* than it reads (counts are under-reported, so a client gets more slots than the limit allows). It is not an outage, and the **default backend is `memory`**, so this only bites when `PORTAL_RATE_LIMIT_FILE` is set — the documented multi-process / VPS mode. Severity: MINOR, but it should not ship with a comment that promises sharing.

**Fix options:** (1) one counter file **per function** (`PORTAL_RATE_LIMIT_FILE` suffixed per route) — cheapest and removes the sharing entirely; (2) a lock file around the read-modify-write; (3) take the durable counter to the same `store` seam that T4 reserves (the Backend already has the seam — the `store` backend is declared and unused).

**Owner:** @Backend Developer.

---

### F-1 — MAJOR (outside the wave-3 diff) · The launch target's route table has no entry for the sign-in door

This is the most important thing I found, so it gets stated plainly.

**What the front-end calls** (executed, `site/src`):
- `POST /api/portal/auth/request-link` — the sign-in link request
- `GET  /api/portal/auth/verify?token=…` — the sign-in link target

**What the handlers answer** (executed, against the real handler):
- `api/portal/auth.ts` answers **only** on those three exact sub-paths, and falls through to `404 {code:'not-found'}` for anything else. Executed: `POST /api/portal/auth` → **404**; `POST /api/portal/auth/request-link` → **200**. The handler is strictly path-sensitive.

**What the route table can serve** (executed, repo layout):
- Vercel serves a function **at its file path** — `api/portal/auth.ts` serves `/api/portal/auth` (Vercel docs: *"Vercel serves each function at its file path. For example, api/index.py serves /api, and api/users.py serves /api/users."*).
- There is **no** `api/portal/auth/` directory, **no** catch-all (`[...slug]`) file anywhere under `api/`, and `vercel.json` has **no** `rewrites` and **no** `redirects`.
- The Cloudflare tree has the same shape: `site/functions/api/portal/auth.ts` serves `/api/portal/auth`; the sub-paths would need `site/functions/api/portal/auth/request-link.ts`.

**Conclusion:** on Vercel, `/api/portal/auth/request-link` and `/api/portal/auth/verify` **cannot reach the handler** — the platform answers 404. **No client can sign in, so the portal cannot be used at all.** The same gap exists on the Cloudflare target.

**Why nobody noticed:** the local dev server (`site/scripts/dev-portal.js:100`) matches routes by **prefix**, so `/api/portal/auth/request-link` reaches the auth handler locally. Every QA and audit run in the last three waves went through that server. The gap is invisible in development and fatal in production.

**A second, related gap:** the repository root has **no `package.json`** and `vercel.json` carries only headers — no `outputDirectory`, no `builds`, no `rewrites`. The Astro project lives in `site/`, the Vercel functions live in `api/`. Whether the Vercel project's Root Directory is `site` (→ `api/` is not deployed at all) or the repo root (→ no buildable package), the current configuration does not make the API reachable. The CI's `deploy-vercel` job is deliberately not wired, so no deployment has ever exercised this.

**What was NOT executed, stated plainly:** the real Vercel router and the real Cloudflare router were **not booted** — `vercel build` refuses ("The specified token is not valid"; no valid token in this environment) and there is no `wrangler`/`workerd` on this machine. The routing conclusion therefore rests on (a) Vercel's documented file-path rule, (b) the repository layout, which I inspected, and (c) the handler's path sensitivity, which I executed. I am confident in the conclusion; I am not claiming to have booted the router.

**Fix options:** (1) split the handler into `api/portal/auth/request-link.ts`, `api/portal/auth/verify.ts`, `api/portal/auth/logout.ts` (and the CF twins) — the routing-correct shape; (2) add a `vercel.json` rewrite `/api/portal/auth/:sub` → the auth function; (3) make the handler answer on the bare path and read the sub-path from a query parameter.

**Owners:** @Backend Developer (handler shape) and @DevOps (the project configuration and Root Directory) — this needs both.

---

### F-2 — MINOR (outside the wave-3 diff) · The CI "static invariant check" step cannot pass

`.github/workflows/ci.yml` sets `defaults.run.working-directory: site`, and the step then asserts:

```
test -f api/contact.ts              # -> site/api/contact.ts          MISSING
test -f site/functions/api/contact.ts  # -> site/site/functions/...  MISSING
```

Both files exist at the **repository root** (`api/contact.ts`, `site/functions/api/contact.ts`) — the two checks were written for a working directory of the repo root, but the step runs in `site/`. Executed from `site/`: both checks fail; executed from the repo root: both pass. As written, the CI job is **red on `main`** for a reason that has nothing to do with the code.

**Owner:** @DevOps.

---

## 5. The two open items QA carried from wave 2 — status

| Open item (wave 2) | Status now | Evidence |
|---|---|---|
| "The Cloudflare runtime was never executed" | **Closed as far as it can be closed on this machine** | The CF tree is now executed in a Web-standard runtime: 9/9 in the Backend's `qa-cf-parity.mjs` and **16/16 endpoint paths** in my own B1, plus the cross-target link contract (B2/B3/B4) that nobody had executed before. **Still not executed:** `workerd` itself — there is no `wrangler`/`workerd` binary on this machine. The Cloudflare claims are about the CF **code path**, not Cloudflare's runtime. |
| "The rate limit is per instance" | **Closed by the Backend, with one caveat that is now a defect (D-2)** | The counters moved behind a pluggable backend (memory / file / kv / store). The *rule* is unchanged. The **file** backend is not multi-process safe → D-2. The `store` backend is declared but **not implemented** — it is a seam reserved for T4, so Turso/Neon is still not started. |

---

## 6. What stays unverified (stated, not assumed)

1. **workerd was never booted.** No `wrangler`/`workerd` on this machine. The Cloudflare findings are about the CF code path executed in Node's Web-standard runtime.
2. **The Vercel router was never booted.** No valid Vercel token. See F-1.
3. **The Cloudflare portal is a stub.** Every CF portal endpoint answers 501. M6 (the notification path) is closed *in code*; the notification sits behind the 501, and the launch target therefore stays the Vercel tree. The `store` backend for T4 is a seam, not an implementation.
4. **No browser run, no live Resend, no live Turnstile.** TTL and window paths were tested at their boundaries, not by waiting out the clock.
5. **The storage migration (T4) is still not started**, so every JSONL behaviour above is still live code.
6. **The rate limiter is still per instance on Vercel** until the file backend is used or T4 lands.
7. **`npm ci` was not re-run by me** (the Backend verified the lockfile is in sync).

---

## 7. Housekeeping

- `site/data/moderation/reviews.jsonl` — **still 0 bytes**, SHA-256 `E3B0C442…B855`, mtime unchanged. `site/data/portal/` — **still absent**.
- `git status` — **117 entries vs the 115-entry session baseline; the two new entries are my own files**. No tracked file was modified by this run.
- The dev server on 4321 — **still PID 19480**, untouched.
- All sandboxes (`%TEMP%\opencode\qa-*`) — **removed**, including the leftovers from the earlier runs.
- New files (the only additions to the repo):
  - `site/qa/qa-wave3-independent.mjs` — the independent suite (20 checks)
  - `site/qa/artifacts/qa-wave3-independent-results.json` — its results
  - this report
  - `site/qa/run-all-suites.ps1` — **one line changed**: my suite is now suite #8, so the runner exits 1 while D-1 and D-2 are open. That is the honest state of the tree.

## 8. Recommended fix order

1. **F-1** (the sign-in door is unreachable on the launch target) — @Backend Developer + @DevOps.
2. **D-1** (the CF moderation store still swallows corruption) — @Backend Developer.
3. **D-2** (the counter file loses counts across functions) — @Backend Developer.
4. **F-2** (the CI invariant step cannot pass) — @DevOps.

After 1-3, re-run `site/qa/run-all-suites.ps1` — it should be 178 checks and 0 failures.
