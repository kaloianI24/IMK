# Wave 11 — QA re-pin report

**Date:** 2026-10-22 · **Author:** QA Engineer (Chief QA Engineer) · **Scope:** `site/qa/**` only
**Brief:** `C:\Users\Kalch\Documents\IXI\wave11-qa-repin-brief-2026-10-22.md`

**Verdict: DONE.** The tree was red with two stale anchors. Both are re-pinned to the
wave-10 contracts, each re-pin is proven non-vacuous (control → mutant → liveness), and
the wave-9b legacy sandbox no longer depends on `api/lib/jsonl.ts`.

---

## 0. Baseline I measured myself (before touching anything)

| Suite | Before | After |
|---|---|---|
| `qa-mutation-probe.mjs` | **exit 1** — `PROBE FAIL P1: expected M1, M2 must FAIL / actual: M1=PASS M2=PASS (29 passed / 0 failed)` | exit 0 — 5/5 probes |
| `qa-admin-independent.mjs` | **exit 1** — `FAILED E14: the CF twin with a filesystem should be 200 (got 501: {"error":"moderation store unavailable on this target","code":"unimplemented"})` | exit 0 — 17/17 checks |

Both were stale anchors, not new product defects. Wave 10 (F-2, F-6) changed the product
on purpose and these two checks still pinned the old behaviour.

---

## 1. Finding 1 — P1: the stale-revision guard is now TWO layers

### The measurement that produced the failure

Removing the handler guard alone no longer reddens M1/M2, because the **store** refuses
the stale revision on its own (wave 10, F-2). I measured all four combinations by
execution before re-pinning anything:

| Defect put back | M1 | M2 | Why |
|---|---|---|---|
| nothing (control) | PASS | PASS | the guard is in place |
| **handler layer only** | PASS | PASS | the store's revision scope still refuses |
| **store layer only** | PASS | PASS | the handler's 409 still refuses |
| **both layers** | **FAIL** | **FAIL** | the end-to-end protection is gone |

So the honest defect for a mutation probe is *"a stale link can approve a quote the owner
never saw"*, and that defect needs **both** layers removed.

### The re-pin

`site/qa/qa-mutation-probe.mjs:115-152` — PROBE 1 now removes both layers in the sandbox
copy (the repo is never touched):

| Layer | File | Anchor (before → after) |
|---|---|---|
| 1 — the handler | `api/moderate/review.ts:328` | `if (currentRevision !== revision) {` → `if (false) {` |
| 2 — the store | `site/shared/portal-store/file-adapter.ts:250` | `if (expectedRevision !== undefined && revisionNumber(record) !== expectedRevision) {` → `if (false) {` |

The sandbox already carried `site/shared/**` (`qa-mutation-probe.mjs:70-73`), so the store
adapter was patchable there; the copy of that tree is now documented as such.
`PORTAL_STORE=file` is now set explicitly for the probe so it always measures the file
adapter (the layer it patches) and never a database that happens to be configured.

`patch()` (`:75-81`) still throws when an anchor is not found — a drifted anchor aborts
the probe loudly instead of rubber-stamping it.

### Non-vacuity proof (executed, `site/qa/qa-anchor-nonvacuity.mjs`)

New proofs (the file now carries 18 proofs, 18/18 pass):

| Proof | What it shows | Result |
|---|---|---|
| `P1-control` (`:585`) | the unmodified copy still passes M1/M2 | `M1=PASS M2=PASS` |
| `P1-mutant` (`:618`) | **both** layers removed → M1/M2 go RED | `M1=FAIL M2=FAIL` (also M4, M4b, M5) |
| `P1-half-handler` (`:656`) | only the handler layer removed → M1/M2 stay GREEN ⇒ the **store** layer is load-bearing | `M1=PASS M2=PASS` |
| `P1-half-store` (`:687`) | only the store layer removed → M1/M2 stay GREEN ⇒ the **handler** layer is load-bearing | `M1=PASS M2=PASS` |
| `P1-liveness-handler` (`:719`) | a reworded handler guard makes the probe abort loudly | *"the patch anchor was not found …"* |
| `P1-liveness-store` (`:755`) | a reworded store scope makes the probe abort loudly | *"the patch anchor was not found …"* |

The two "half" proofs are new: they are the evidence that the guard really has two
load-bearing layers, which is exactly what the Backend's wave-10 note said.

---

## 2. Finding 2 — E14: the Cloudflare inbox serves no queue any more

### The measurement that produced the failure

Wave 10 (F-6) deliberately rewrote `site/functions/api/admin/reviews.ts`: the JSONL read
is gone and the endpoint answers `501 {code:'unimplemented'}` unconditionally (`:83-93`).
The old E14 demanded a **200 with a queue** from this target in the Node simulation of
the edge tree — an answer no Worker could ever give.

### The re-pin — `site/qa/qa-admin-independent.mjs:1100-1269`

E14 is now *"the Cloudflare inbox serves NO queue on either runtime — 501, and the gate
still comes first"*. It asserts, in order:

| # | Assertion | Answer |
|---|---|---|
| 1 | edge runtime (no filesystem), owner | `501 {code:'unimplemented'}` — and the body carries **no** `reviews`/`counts` |
| 2 | edge runtime, a client session | `401 {code:'unauthorized'}` — the gate comes **before** the store |
| 3 | edge runtime, no cookie | `401 {code:'unauthorized'}` |
| 4 | `ADMIN_EMAILS` unset | `500 {code:'internal'}` |
| 5 | `FORM_WEBHOOK_SECRET` = the published placeholder | `500 {code:'internal'}` (H-1) |
| 6 | **with a filesystem** (`QA_ADMIN_EDGE_FS=1`), owner | `501 {code:'unimplemented'}` — the new contract, no queue either way |
| 7 | with a filesystem, a client session | `401 {code:'unauthorized'}` |
| 8 | the Vercel tree | `200` with a **real** queue and `counts.openNotes === null`; a client is `401` there too |

The comparison with the Vercel tree moved from the queue **body** to the **gate**, exactly
as the brief required: the two targets differ by design now, so the owner gate is the
only thing they must agree on.

### Non-vacuity proof

Two independent executions, because "the check is red for the right reason" matters:

| Proof | Where | Result |
|---|---|---|
| `E16` — the mutation probe inside the suite | `qa-admin-independent.mjs:1348` | a JSONL read put back into the CF inbox → the nested run reports **E9=PASS, E14=FAIL**; the control (E9, the Vercel tree) stays green, so the harness itself is fine |
| `E14-mutant` | `qa-anchor-nonvacuity.mjs:818` | same mutation, run independently: **E9=PASS E14=FAIL**, *"the CF twin with a filesystem must still answer 501 … (got 200: {"ok":true,"counts":{"pendingReviews":1 …}})"* |
| `E14-control` | `qa-anchor-nonvacuity.mjs:791` | the unmodified tree: **E9=PASS E14=PASS** |
| `E14-liveness` | `qa-anchor-nonvacuity.mjs:861` | a reworded CF inbox makes the probe abort loudly — *"the patch anchor was not found …"* |

The mutation is surgical: only the **queue** is put back, the gate above it is untouched,
so the re-pin fails for the reason it exists.

### Numbering

E16 is the new mutation probe and E17 is the byte-identical check (it was E16 before);
the file now has **17 checks**.

---

## 3. Finding 3 — the wave-9b legacy sandbox is now self-contained (F-7 unblocked)

### The problem

`site/qa/qa-wave9-store-queue.mjs` builds a "legacy" tree = a copy of the current `api/`
with `api/admin/reviews.ts` replaced by the frozen pre-wave-9 fixture. That fixture
imports `../lib/jsonl.js` and `../lib/notifications.js`, resolved against the **copied
current** `api/` tree — so the legacy bundle only built because the product still carries
`api/lib/jsonl.ts`, a file with **zero** product importers (a dead Vercel function the
Backend wants to delete, wave 10 F-7).

### The change

| What | Where |
|---|---|
| two new frozen fixtures, taken byte-exact from `git show a4b10a8:` | `site/qa/fixtures/prewave9-lib-jsonl.ts.txt` (sha256 `31b5d1be7a8c…`) and `site/qa/fixtures/prewave9-lib-notifications.ts.txt` (sha256 `def777b3a1b7…`) |
| the frozen-source loader: fixture → hash check → git cross-check → export check | `qa-wave9-store-queue.mjs:519-585` (`LEGACY_LIBS`, `frozenSource()`) |
| the legacy tree now gets its **own** copies; the **product** copies are deleted from the scratch tree first | `qa-wave9-store-queue.mjs:638-666` |
| the new sub-assertion | `qa-wave9-store-queue.mjs:723` — `W9-1.a0` *"the legacy tree is SELF-CONTAINED (it does not need the product api/lib/jsonl.ts)"* |

The existing "git agrees" provenance check for the inbox fixture (`:619-630`) is untouched,
and the inbox fixture file itself is untouched. The frozen bodies are verified against
their recorded SHA-256 **and** against `git show a4b10a8:<path>` when git is available, so
a stale snapshot cannot pass silently.

### The proof that F-7 is unblocked (executed, not argued)

I copied `api/` + `site/shared/` to a temp directory, **deleted `api/lib/jsonl.ts` from
the copy** (simulating the Backend's deletion), and ran the suite against that copy via
its own `QA_W9_API_DIR` / `QA_W9_SHARED_DIR` hooks:

```
QA_W9_API_DIR=<copy>\api   QA_W9_SHARED_DIR=<copy>\site\shared
→ W9-1 PASS (12/12 sub-assertions), including W9-1.a0 (self-contained)
```

The product tree was never modified for this proof. **`api/lib/jsonl.ts` can now be
deleted by the Backend with no QA suite breaking** — one line of their wave-10 note is
unblocked. I did **not** delete it: it is not my file.

One cleanup inside my own tree: a leftover `site/qa/fixtures/.tmp-prewave9.txt` (a
mangled, unreferenced temp copy of the old fixture) was removed — nothing referenced it.

---

## 4. The gate (executed by me, with real output)

- `powershell -NoProfile -ExecutionPolicy Bypass -File site\qa\run-all-suites.ps1` →
  **15 suites, 15 exit 0, 0 failures** (the summary block of the transcript ends
  `finished: 2026-10-22 04:49:48 +03:00`)
- fresh transcript: **`C:\Users\Kalch\Documents\IXI\site\qa\artifacts\qa-full-run-2026-10-22-044854.txt`**
  (a new file — no earlier transcript is overwritten)
- **299 checks + 5 mutation probes + 18 anchor proofs, 0 unexpected failures**:
  102 (api) · 14 (build) · 21 (backend-hardening) · 29 (wave2) · 5/5 probes ·
  8 (rate-limit) · 11 (cf-parity) · 21 (wave3) · 23 (wave4) · 26 (wave5) ·
  17 (admin) · 1 (wave9 queue, 12/12 sub-assertions) · 26 (wave9 store) ·
  18/18 proofs
- `astro check` → **0 errors, 0 warnings, 11 hints** — the baseline is unchanged (my new
  fixture files are `.txt` and are not in `astro check`'s scope; the four `.mjs` files I
  edited add no hints)
- `site/data/` untouched: `site/data/moderation/reviews.jsonl` is **0 bytes**
  (sha256 `e3b0c442…b855`, the empty-string hash) and there is **no** `site/data/portal/`
- no git write command of any kind was run; the only files I touched are under `site/qa/**`
  (plus this report at the repo root)

### Suites (15, all exit 0)

| # | Suite | Exit |
|---|---|---|
| 1 | `qa-testimonials.mjs` (API, real handlers) | 0 |
| 2 | `qa-testimonials-build.mjs` (real astro build) | 0 |
| 3 | `qa-backend-hardening.mjs` | 0 |
| 4 | `qa-wave2-independent.mjs` | 0 |
| 5 | `qa-mutation-probe.mjs` | 0 |
| 6 | `qa-rate-limit.mjs` | 0 |
| 7 | `qa-cf-parity.mjs` | 0 |
| 8 | `qa-wave3-independent.mjs` | 0 |
| 9 | `check:routes` (npm run) | 0 |
| 10 | `qa-wave4-independent.mjs` | 0 |
| 11 | `qa-wave5-independent.mjs` | 0 |
| 12 | `qa-admin-independent.mjs` | 0 |
| 13 | `qa-wave9-store-queue.mjs` | 0 |
| 14 | `qa-wave9-store-independent.mjs` | 0 |
| 15 | `qa-anchor-nonvacuity.mjs` | 0 |

---

## 5. Files I changed

| File | Change |
|---|---|
| `site/qa/qa-mutation-probe.mjs` | PROBE 1 removes **both** layers of the stale-revision guard; the header documents the two layers; `PORTAL_STORE=file` is pinned for the probe |
| `site/qa/qa-admin-independent.mjs` | **E14 re-pinned** to the wave-10 contract (501 in both runtimes, the gate first, the comparison with the Vercel tree is the gate); **E16** is the new mutation probe (a JSONL read put back → E14 RED); the file header records the re-pin |
| `site/qa/qa-anchor-nonvacuity.mjs` | 10 new proofs: `P1-control/mutant/half-handler/half-store/liveness-handler/liveness-store` and `E14-control/mutant/liveness` (18 proofs in total) |
| `site/qa/qa-wave9-store-queue.mjs` | the legacy tree is **self-contained**: two frozen helpers (hash- and git-verified) are written into the scratch tree and the product copies are deleted from it; new sub-assertion `W9-1.a0` |
| `site/qa/fixtures/prewave9-lib-jsonl.ts.txt` | **new** — frozen `api/lib/jsonl.ts` from `a4b10a8` |
| `site/qa/fixtures/prewave9-lib-notifications.ts.txt` | **new** — frozen `api/lib/notifications.ts` from `a4b10a8` |
| `site/qa/fixtures/.tmp-prewave9.txt` | **deleted** — an unreferenced leftover temp file from an earlier session |

No product file was touched: `api/**`, `site/functions/**`, `site/shared/**`,
`site/scripts/**`, `site/src/**`, `spec/**`, `DEPLOY.md`, `site/.env.example` and
`site/data/**` are all as I found them.

---

## 6. Findings for the Manager, ranked

1. **MEDIUM — the stale-revision protection is two layers, and only the combination was
   ever tested.** Until now no probe removed both layers, so the end-to-end property was
   unproven; and a one-layer regression in either file would have been invisible to the
   suite. Both layers are now proven load-bearing (`P1-half-handler`, `P1-half-store`).
   *Owner: Backend — no action needed, the protection is intact and now pinned.*
2. **LOW — `api/lib/jsonl.ts` is now deletable.** F-7 was blocked on one QA line; that
   line is closed and proven (the suite passes against a tree without the file). It is
   still on the Vercel function-budget list. *Owner: Backend.*
3. **LOW — `api/lib/jsonl.ts`'s own comment is now stale** (it says the file "stays until
   QA re-pins that fixture"). QA has re-pinned it. *Owner: Backend — their file; I did
   not edit it.*
4. **INFO — the two targets now differ by design.** The Cloudflare inbox answers 501
   while the Vercel inbox answers 200 with a queue. E14 pins both answers and the shared
   gate. Anyone who expected the CF tree to serve a queue will read 501 — that is
   wave 10's decision, not a defect, but it is now a pinned contract.

---

## 7. UNVERIFIED (plainly)

- **No real Turso database was ever contacted.** The store's proof is a real SQLite engine
  over the real libSQL HTTP v2 wire protocol — not Turso's service. Nothing in this wave
  changed that.
- **The Vercel router and workerd were never booted.** The CF twin is executed as a
  bundled Node module, not inside a Worker isolate; the "no filesystem" case is simulated
  by not exposing `require` to the bundle.
- **Nothing was deployed and there is no git remote.** The dev server on 4321 still runs
  the pre-wave-11 bundle; it was not touched (it is out of my bounds).
- **No live mail was sent.** The Resend call is stubbed in every suite.
- **The transcript pins the tree as it was at the moment of the run, not a commit** — the
  tree is permanently dirty and other bots keep working in it.
- **The publisher was not re-audited in this wave** (the Backend changed
  `site/scripts/publish-testimonials.mjs` in parallel). The publisher-facing suites ran
  green, but the wave-11 publisher change itself was not reviewed by me.
