# QA report — the `/admin` owner inbox, independent verification (wave 6, T7.14)

**Date:** 2026-10-21
**QA Engineer — Testing and Verification**
**Repo:** `C:\Users\Kalch\Documents\IXI` (branch `main`, shared dirty tree, no remote)
**Assignment:** @Manager — "wave-6 QA" (owner-free work), plus the Frontend Developer's request to
independently test the new admin endpoints.
**Under test:** `api/admin/session.ts`, `api/admin/reviews.ts`, the Cloudflare twins under
`site/functions/api/admin/`, and the two of them together with `api/moderate/review.ts`.
**Author's own claim under test:** `frontend-admin-inbox-2026-10-21.md` (31 checks, reported DONE).

---

## 1. Status

**DONE — 16 of 16 QA-owned checks pass. No defect found in the admin inbox.**

| | |
|---|---|
| New suite | `site/qa/qa-admin-independent.mjs` — **16 QA-owned checks** |
| Wired in | `site/qa/run-all-suites.ps1` as **suite #12** |
| Suite result | **16 PASS, 0 FAIL** — exit **0** |
| Full runner | 12 suites: **11 exit 0**, suite **#11 exits 1** (that red is **D-4**, a pre-existing Backend defect — see §5) |
| Repo | **byte-for-byte unchanged** (SHA-256 per file over `api/`, `site/shared/`, `site/functions/`) |
| Real records | `site/data/moderation/reviews.jsonl` still **0 bytes**, `site/data/portal/` still **absent** |
| Ports | **none bound** — 4321 (the running dev server) was never touched |

Why a new suite: the Frontend's 31-check harness lives **outside the repository**, so nothing about
the admin endpoints is covered by the runner or by CI. This file is QA's own evidence and it is
now part of the repeatable suite set.

---

## 2. The design (why these checks are honest)

Each handler file is bundled **separately** with esbuild and loaded in its **own child process**.
That is what Vercel does (one function per file under `api/`), and it is the condition in which a
session breaks — the owner cookie is minted in one process and presented to another. The child
speaks JSON lines over stdin/stdout, so **no port is bound at all**.

* The Cloudflare twins are called the way a Worker calls them: `onRequestGet({ request, env })`
  with a real Web `Request`, and **no `globalThis.require`** — that is exactly a real isolate,
  where the edge tree cannot reach a filesystem.
* The owner signs in through the **real** magic-link flow (`/api/portal/auth/request-link` →
  `/api/portal/auth/verify`); QA never fabricates the owner session.
* The moderation link the inbox mints is verified with **QA's own HMAC** (`node:crypto`, over
  `ref|decision|revision|ts` with `FORM_WEBHOOK_SECRET`), not with the project's helper.

---

## 3. The evidence

### 3.1 The gate (E1 – E8)

| Check | Result | Evidence |
|---|---|---|
| E1 CONTROL — the owner signs in through the real flow | PASS | role `admin`, the cookie is `imk_admin_session`; `/api/admin/session` → **200** `{ok:true,role:'admin',email:'owner@imk.test'}` |
| E2 — no cookie at all | PASS | **401** `{code:'unauthorized'}` |
| E3 — a **client** session | PASS | **401** — a client cookie can never satisfy the gate |
| E4 — a forged admin cookie | PASS | **401** |
| E5 — a **client-role token under the admin cookie name** | PASS | **401** — the **role** is checked, not the cookie name |
| E6 — an **admin-role token for an address that is not allow-listed** | PASS | **401** — a valid, correctly signed token is still refused |
| E7 — the allow-list is read **on every request** | PASS | the same still-valid owner token, in a process started with a different `ADMIN_EMAILS` → **401** — removal revokes access **at once**, not at token expiry |
| E8 — `ADMIN_EMAILS` unset | PASS | **500** `{code:'internal'}` — a misconfiguration is not "everybody is the owner" |

Every non-owner gets the **same** answer (401), so the endpoint cannot be used to tell the states
apart. That is the contract in spec/07 §7.3, verified by execution.

### 3.2 The queue and the decision (E9, E10, E12, E13)

| Check | Result | Evidence |
|---|---|---|
| E9 — `GET /api/admin/reviews` | PASS | a client → **401**; the owner → **200**, `counts.pendingReviews = 1`, **`counts.openNotes = null`** and `notesAvailable: false` — the missing annotation store is reported as *unknown*, not as a made-up `0` |
| E10 — the approve link the inbox mints | PASS | the link points at `/api/moderate/review`; its signature **matches QA's own HMAC** byte-for-byte; the moderation endpoint accepts it → the quote is **`approved`** in the store. The decision is real, not a UI state |
| E12 — an owner-only client route with a client session | PASS | `PATCH /api/portal/projects/:id` → **403** `{code:'forbidden'}` |
| E13 — a **stale admin cookie next to a valid client cookie** | PASS | the stale cookie is skipped, the client session wins: the client sees **1 of 2** projects — the foreign project stays hidden |

### 3.3 Tree parity (E11, E14)

| Check | Result | Evidence |
|---|---|---|
| E11 — the Cloudflare session twin | PASS | owner → **200**, client → **401**, no cookie → **401** — the same codes as the Vercel tree |
| E14 — the Cloudflare queue twin | PASS | in a **real edge runtime** (no filesystem) → **501** `{code:'unimplemented'}` (an unreachable store is not an empty queue); **with** a filesystem it answers **exactly what the Vercel tree answers at that moment** (same pending count, same queue length, same notes count) and still refuses a client with **401** |

### 3.4 Non-vacuity (E15, E16)

| Check | Result | Evidence |
|---|---|---|
| E15 — MUTATION PROBE | PASS | the allow-list check is put back **in a copy** of the tree (`isAdminEmail` → always `true`) and this same suite is re-run against the copy: **E1 = PASS** (the owner still gets in) · **E6 = FAIL** (the allow-list no longer decides) · **E7 = FAIL** (removing an address no longer revokes). The gate checks are provably not vacuous |
| E16 — the repository is untouched | PASS | `api/`, `site/shared/` and `site/functions/` are **byte-for-byte unchanged** (SHA-256 per file) |

The probe re-runs this file as a child process against the copy (`QA_ADMIN_API_DIR` /
`QA_ADMIN_SHARED_DIR` / `QA_ADMIN_CF_DIR`), with a recursion guard (`QA_ADMIN_PROBE_CHILD=1`) so
the nested run does not probe itself. The repository is never modified.

---

## 4. My own harness failed twice — stated, not hidden

1. **First run:** the child never wrote the captured e-mail to its file, so `signIn()` found no
   mail. My bug (a dropped `mailFile` write in the child source), fixed and re-run.
2. **Second run:** the mutation probe reported `E6 = MISSING` instead of `FAIL`. Two causes, both
   mine: `--only` filtered by **group letter** while the probe passed **check ids**, and the nested
   probe run probed itself. Both fixed (id-aware `--only`, plus the recursion guard).

A third failure was **not** a harness bug and I want it on the record: the first version of E14
asserted `pendingReviews = 1`, but **E10 had already approved the quote earlier in the same run**,
so the queue legitimately showed 0 pending and 1 decided today. The product was right and my
expectation was stale. E14 now compares the two trees **live** instead of against a hard-coded
number — a stronger assertion anyway.

---

## 5. What is still open (not mine)

**D-4 · MINOR · Backend-owned.** The Cloudflare moderation twin answers **404 "review not found"**
where the Vercel tree answers **501 {code:'unimplemented'}` for a *missing* store
(`site/functions/api/moderate/review.ts:77` returns `[]` instead of throwing
`StoreUnreachableError`). It is the only red in the runner (suite #11, check **B6**). On the real
edge runtime there is no `globalThis.require`, so the CF twin answers 501 there — the 404 only
appears where a filesystem exists but the file does not. Tree parity (spec/07 §1, D-6) is still
broken.

**Not a defect, but for the record:** the admin session gives the owner sight of **all** projects
in `/portal` (`api/portal/projects.ts` — `session.role === 'admin'` sees everything). That is the
owner's documented power, not a leak: the cookie is only issued to an allow-listed address.

---

## 6. Stated, not assumed — unverified

* **The Vercel router was never booted** (no token, no preview deploy). Every Vercel claim here is
  about the code path executed in an isolated child process.
* **workerd was never booted.** Every Cloudflare claim is about the CF **code path** executed in a
  Node runtime with a Web `Request`; the "real edge runtime" is simulated by leaving
  `globalThis.require` undefined, which is what the tree actually relies on.
* The file store does not persist on a read-only filesystem, so the **approve action on Vercel
  answers 500 `{code:'storage'}`** — the durable answer is the libSQL adapter (T4), which is
  blocked on the owner's decision and is **not built**.
* No browser run, no live Resend, no live Turnstile, no deployed target.
* The annotation ("client notes") panel has **no store in the repo**; the API reports the count as
  `null` and the screen says so — QA verified the *API shape*, not the screen.

---

## 7. Files

**New (QA-owned):** `site/qa/qa-admin-independent.mjs`
**New artefacts:** `site/qa/artifacts/qa-admin-independent-results.json`,
`site/qa/artifacts/qa-full-run-2026-10-21.txt` (the 12-suite transcript)
**Changed (QA-owned):** `site/qa/run-all-suites.ps1` — suite **#12** added, plus its line in the
summary and in the exit-code rule
**Reports:** this file, and `qa-wave5-independent-2026-10-21.md` (the wave-5/6 report)

**No application file was touched** — `api/`, `site/functions/`, `site/shared/` and `site/src/` are
unchanged.
