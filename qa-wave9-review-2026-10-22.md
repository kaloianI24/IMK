# QA review — wave 9 (PortalStore wiring) and the two re-pinned mutation anchors

**QA Engineer · 2026-10-22 · IMK / IXI repo `C:\Users\Kalch\Documents\IXI`**
Requested by @Manager (assignment `58f8a80e-abc7-4dfd-a126-57a562c44196`).

## Verdict

| # | Item | Verdict | Evidence |
|---|------|---------|----------|
| 1 | P2 anchor (`qa-mutation-probe.mjs`) — still non-vacuous | **PASS** | 3 proofs, `site/qa/qa-anchor-nonvacuity.mjs` |
| 1 | D2 anchor (`qa-wave5-independent.mjs`) — still non-vacuous | **PASS** | 3 proofs, same tool |
| 2 | Independent full re-run against the wave-9 tree | **PASS** | `site/qa/artifacts/qa-full-run-2026-10-22-015027.txt` — **12/12 exit 0** |
| 3 | New independent wave-9 queue-consistency check | **PASS** | `site/qa/qa-wave9-store-queue.mjs` — W9-1, 11/11 sub-assertions; proven non-vacuous |
| 3 | The new check inside the runner | **PASS** | `site/qa/artifacts/qa-full-run-2026-10-22-015143.txt` — **13/13 exit 0** |

**No CRITICAL finding.** Neither re-pinned probe is vacuous, and no check was weakened.

---

## 1. The two re-pinned mutation anchors

The Backend re-pinned two anchors while wiring the portal to the store. For each one I
proved, **without touching the shipped tree**, that (a) the unmodified copy still passes,
(b) the defect injected into a scratch copy turns the checks **RED**, and (c) if the product
text the anchor points at ever drifts again, the probe fails **loudly** instead of silently
passing.

Tool: `site/qa/qa-anchor-nonvacuity.mjs` (new, QA-owned).
Every break is injected into a **copy** under `%LOCALAPPDATA%\Temp\opencode\…`; the shipped
`api/`, `site/shared/`, `site/scripts/` and `site/functions/` trees were byte-compared before
and after the whole run (`tree-untouched: api/, site/shared/, site/scripts/ and
site/functions/ are unchanged`).

### 1a. P2 — `site/qa/qa-mutation-probe.mjs` (the publisher's malformed-line error text)

**Why the old anchor had to move.** The probe patches the publisher
`site/scripts/publish-testimonials.mjs`. Its anchor was the publisher's own error text, which
named **one hard-coded file**:

```
`data/moderation/reviews.jsonl line ${index + 1} is not valid JSON — `
```

Wave 9 changed the publisher to read **the store** instead of that one file
(`PORTAL_STORE=file|libsql`), so the message now interpolates the file it was reading:

```
`${file} line ${index + 1} is not valid JSON — `
```

The old literal no longer exists in the file. Left in place, `patch()` would have thrown
`the patch anchor was not found …` → `PROBE ERROR` → the probe aborts **loudly** (it cannot
pass silently), so the anchor had to follow the text. The **defect the probe puts back is
unchanged**: the publisher *skips* a malformed line instead of refusing to publish.

**Evidence that the new anchor is still non-vacuous** (all three ran; output verbatim):

| Proof | What was done | Result |
|---|---|---|
| `P2-control` | unmodified copy of the publisher, `QA_PUBLISH_SCRIPT` pointed at it | `N1=PASS N2=PASS N3=PASS` (suite exit 0) |
| `P2-mutant` | the skip-instead-of-throw injected into a scratch copy | `N1=FAIL N2=FAIL N3=FAIL` (suite exit 1) — *all failing checks: N1, N2, N3* |
| `P2-liveness` | a scratch copy with the message reworded (`JSON`→`JSONL`) | the probe **aborts loudly**: `the patch anchor was not found in …` |

The intent is unchanged: the probe still breaks *"the publish script skips a malformed line
instead of failing"* and still expects **N1/N2/N3** to go red. The runner's own copy of the
probe agrees: `PROBE PASS P2 … actual: N1=FAIL N2=FAIL N3=FAIL` in the transcript below.

### 1b. D2 — `site/qa/qa-wave5-independent.mjs` (`guardStore()`)

**Why the old anchor had to move.** The probe put the F-3 defect back by patching
`function writeReviews(` in `api/moderate/review.ts`. Wave 9 removed that function: the
moderation log is now written through the **PortalStore contract**, so `writeReviews()` no
longer exists and the anchor could not be found any more.

The defect itself is still there in a different shape — *a store failure that is NOT caught
escapes the handler and the request dies instead of answering `500 {code:'storage'}`* — but
the guard that prevents it moved to
`site/shared/server/portal-store-access.ts` → `guardStore()`. The probe therefore patches
that function instead, replacing its body with `return await fn();`.

**The intent is unchanged**: same defect class (an unguarded store failure), same check that
must go red (**B4 — "an UNWRITABLE store answers 500 {code:'storage'} and approves NOTHING"**).

**Evidence that the new anchor is still non-vacuous:**

| Proof | What was done | Result |
|---|---|---|
| `D2-control` | unmodified copy of the tree, wave-5 group B run against it | `B1=PASS B1b=PASS B2=PASS B3=PASS B4=PASS` (suite exit 0) |
| `D2-mutant` | `guardStore` made unguarded in a scratch copy | `B1=PASS B1b=PASS B2=PASS **B3=FAIL B4=FAIL**` (suite exit 1) — B4 said: *“the handler threw instead of answering: StorageError: cannot write …”* |
| `D2-liveness` | `guardStore` renamed in a scratch copy | the **D2 check itself goes RED**: `the patch anchor was not found in …/portal-store-access.ts: export async function guardStore<` |

Two notes on the mutant run, so the result is not over-read:

- The suite's own control **B1 stays GREEN** while B4 goes red — the failure is caused by the
  injected break, not by the copy.
- **B3 also goes red.** That is expected and *not* a weakening: the same guard covered the
  corrupt-store path as well, so an unguarded store failure breaks both checks. The D2 check
  asserts on B4 only, as before.

The runner's own copy of the check agrees: `PASS D2  F-3 reverted (an unguarded store
failure) -> the unwritable-store check goes RED -- mutated copy: B4=FAIL (the handler throws
out of the store failure again)`.

### 1c. Verdict on item 1

Both probes are **non-vacuous**: each one still turns the checks red when the product is
broken, each one still passes on an unmodified copy, and each one fails loudly if its anchor
drifts again. **No CRITICAL finding.** No check was weakened — nothing was changed in either
probe file.

---

## 2. Independent re-run of the full QA runner

**Exact command (run from `C:\Users\Kalch\Documents\IXI`):**

```powershell
$env:PORTAL_MAGIC_LINK_SECRET='qa-local-magic-link-secret-0123456789abcd'
$env:PORTAL_SESSION_SECRET='qa-local-session-secret-0123456789abcdef'
powershell -NoProfile -ExecutionPolicy Bypass -File site\qa\run-all-suites.ps1
```

`pwsh` (PowerShell 7) is **not installed** on this machine; Windows PowerShell 5.1 runs the
runner unchanged (the script is 5.1-compatible). The two secrets are **local test values,
32+ characters** — the suites simulate production and refuse a missing/placeholder/short
secret (H-1).

**Run 1 — the 12 suites as they stood, 12/12 exit 0:**

```
transcript: C:\Users\Kalch\Documents\IXI\site\qa\artifacts\qa-full-run-2026-10-22-015027.txt
started 01:50:27 +03:00 · finished 01:51:04 +03:00 · git HEAD a882606
qa-testimonials.mjs exit 0 · qa-testimonials-build.mjs exit 0 · qa-backend-hardening.mjs exit 0
qa-wave2-independent.mjs exit 0 · qa-mutation-probe.mjs exit 0 · qa-rate-limit.mjs exit 0
qa-cf-parity.mjs exit 0 · qa-wave3-independent.mjs exit 0 · check:routes exit 0
qa-wave4-independent.mjs exit 0 · qa-wave5-independent.mjs exit 0 · qa-admin-independent.mjs exit 0
```

**Run 2 — after the new wave-9 suite was wired in (item 3), 13/13 exit 0:**

```
transcript: C:\Users\Kalch\Documents\IXI\site\qa\artifacts\qa-full-run-2026-10-22-015143.txt
… qa-wave9-store-queue.mjs exit 0   (PASS W9-1, 11/11 sub-assertions)
```

Both are **new** paths. No earlier transcript was overwritten — the Manager's
`qa-full-run-2026-10-22-013307.txt` and the Backend's `…-013935.txt` / `…-014335.txt` are
untouched (mtimes unchanged).

**`site/data/` is at 0 bytes.** After both runs:
`site/data/moderation/reviews.jsonl — 0 bytes, mtime 2026-10-21 20:20:13` (1 file, 0 bytes
total). Every fixture of every suite lands in its own sandbox.

### Concurrency note (item 2's warning)

The Backend was editing `api/admin/reviews.ts` while I looked. **The first read of that file
at ~01:37 caught a half-written state**: it still called `fs.existsSync(REVIEWS_FILE)`,
`parseJsonlStrict(...)` and `guardStorage(...)` while its import block no longer had `fs`,
`path`, `REVIEWS_FILE`, `parseJsonlStrict` or `guardStorage`. That is an artefact of the
mid-edit window, **not** a product defect:

| Evidence | Result |
|---|---|
| mtime of `api/admin/reviews.ts` | `01:37:15` — the Backend saved it **after** my first read |
| the settled file | uses `assertStoreReachable('reviews')`, `getPortalStore()`, `store.list('reviews')`, `guardStore(...)` |
| `npm run typecheck:api` (tsc `-p site/tsconfig.api.json --noEmit`) | **exit 0**, no errors |
| both full runs (01:50, 01:51) | 12/12 and 13/13 exit 0 — no suite read a half-written file |

I did **not** report this as a failure and did **not** touch any product file. The last
product edits in the tree are `site/shared/portal-store/file-adapter.ts` (01:37:24) and
`libsql-adapter.ts` (01:37:20) — both are covered by the runs above.

---

## 3. The new independent wave-9 check

**File:** `site/qa/qa-wave9-store-queue.mjs` (new, QA-owned) — wired into
`site/qa/run-all-suites.ps1` as **suite 13**.
**Check:** `W9-1` — *the owner inbox and the moderation link are ONE queue, and file mode
still behaves like before wave 9* — **11/11 sub-assertions PASS**.

What it proves, in one run:

**(a) One queue.** Two handlers, two separate bundles in two separate child processes
(Vercel's one-function-per-file shape), one shared sandbox store:

| Sub | Assertion | Result |
|---|---|---|
| a1 | both inboxes answer the same fixture with 200 | ok |
| a2 | the answer shape is identical (same keys, same `counts`, same `notesAvailable`) | ok — keys `[counts,notesAvailable,ok,recent,reviews]` |
| a3 | the queue is identical item by item (`ref, revision, rating, name, company, quote, receivedAt, state`; same `recent` list) | ok — 2 pending + 1 recent, identical |
| a4 | the links have the same shape (path, parameter names, `ref`/`decision`/`revision`) and the signature verifies with **QA's own HMAC** over `ref\|decision\|revision\|ts` | ok |
| a5 | a **corrupt** store still answers `500 {code:'storage'}` in **both** — never an empty queue | ok — both 500 `{code:'storage'}` |
| a6 | both handlers reach the store through the **same accessor**: `getPortalStore()` (no argument) on the `'reviews'` collection, and neither parses or reads the moderation log itself | ok |
| b1 | the inbox lists the two pending quotes | ok |
| b2 | the link the inbox mints points at `/api/moderate/review` | ok |
| b3 | the **POST** of that link is accepted by `/api/moderate/review` → `200 {"ok":true,"ref":"inq_wave9_a","state":"approved"}` | ok |
| b4 | the inbox's **next read** sees the decision: `inq_wave9_a` is gone from pending and appears in `recent` with `state:'approved'` | ok — pending 1 |
| b5 | the decision landed in **the store**, not in a side file: the store file holds `state:'approved'`, `decidedAt`, `decidedBy:'one-click-link'`, and the store directory holds **only** `reviews.jsonl` | ok |

**(b) Parity with the pre-wave-9 implementation.** The "before" is **not** a copy of today's
file: it is the **frozen pre-wave-9 inbox** (`git a4b10a8:api/admin/reviews.ts`, SHA-256
`2211dc66da4ff2d8f88f700642e7583f415fb8db5e9e63ba10a13f23389d3e53`), kept as
`site/qa/fixtures/prewave9-admin-reviews.ts.txt` and copied into a scratch tree that keeps
the **current** shared helpers — so the only difference measured is *how the queue is
reached*. The suite verifies the snapshot against that hash and against git
(`git agrees`), so a stale fixture cannot pass silently.

### The new check is proven non-vacuous too

`qa-anchor-nonvacuity.mjs` also runs it, against copies:

| Proof | Result |
|---|---|
| `W9-1-control` (unmodified copy) | `W9-1=PASS` (suite exit 0) |
| `W9-1-mutant` (the inbox reads a **different collection**: `store.list('reviews')` → `store.list('projects')`) | `W9-1=FAIL` (suite exit 1) — failing sub-assertions: `W9-1.a2, a3, a4, a5, b1, b2, b3, b4, b5` |

So the check is not a rubber stamp: split the queue and it goes red.

---

## What stays UNVERIFIED / outstanding risks

1. **libSQL mode is not exercised by this check.** `W9-1` runs in `PORTAL_STORE=file` mode
   (the mode a fixture can run offline). The libSQL path is covered by the store contract's
   own suite (`npm run test:store`, 60/60, proven offline against a real SQLite engine over
   the real wire protocol), but **the two endpoints have not been executed end-to-end
   against a database** in this review. The static half of the check (a6) does show that
   both handlers obtain the store through the same accessor and the same collection, which
   is what libSQL mode would share — but that is a code-level argument, not an execution.
2. **The Cloudflare twin of the inbox is still the file-based implementation.**
   `site/functions/api/admin/reviews.ts` (mtime 2026-10-21 23:48:35) has not been moved to
   the store the way `api/admin/reviews.ts` has. The CF twin answers 501 on the real edge
   runtime (no filesystem), so the split-queue risk there is currently unreachable — but the
   two trees are **not** at parity for wave 9. **Backend-owned.**
3. **D-4 is still open** (from wave 6, unchanged): the Cloudflare moderation twin answers
   404 "review not found" where the Vercel tree answers 501 for a missing store, when a
   filesystem is bound. Not re-litigated here; the suites still report it as a known gap.
4. The tree was **actively edited during this review** (last product write 01:37:24). Both
   full runs (01:50, 01:51) are against the settled tree as of 01:37:24; any later Backend
   edit invalidates them and needs a re-run.

---

## Files I touched (QA-owned area only)

| File | Change |
|---|---|
| `site/qa/qa-wave9-store-queue.mjs` | **new** — the independent wave-9 queue check (suite 13) |
| `site/qa/qa-anchor-nonvacuity.mjs` | **new** — the non-vacuity prover for the two re-pinned anchors and for the new check |
| `site/qa/fixtures/prewave9-admin-reviews.ts.txt` | **new** — the frozen pre-wave-9 inbox (hash-verified) |
| `site/qa/run-all-suites.ps1` | **one suite added** (13) + its summary line + the exit condition |
| `site/qa/artifacts/qa-full-run-2026-10-22-015027.txt`, `…-015143.txt` | **new** — my two transcripts |
| `site/qa/artifacts/qa-wave9-store-queue-results.json` | **new** — machine-readable result of the new suite |

No file under `api/`, `site/shared/`, `site/functions/`, `site/src/` or `site/scripts/` was
changed by QA — proven by the byte-comparison of those trees before and after the proofs
(`tree-untouched`).
