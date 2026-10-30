# Wave 11 — QA brief: two suites are RED on the current tree, and one fixture blocks the dead-file cleanup

Repo: `C:\Users\Kalch\Documents\IXI` (tree is permanently dirty, 62 changed paths — never reset/clean/checkout/stash, never run a mutating git command).

YOU OWN: `site/qa/**` only.

DO NOT TOUCH: `api/**`, `site/shared/**`, `site/scripts/**`, `site/functions/**`, `spec/**`, `DEPLOY.md`, `site/.env.example`, repo-root `*.mjs` harnesses, `site/data/**`.

## Context (measured by the Manager on the current tree)

`powershell -NoProfile -ExecutionPolicy Bypass -File site\qa\run-all-suites.ps1` → **14 suites, 12 exit 0, 2 exit 1** (the runner also runs the `check:routes` npm gate, which passes):

- `qa-mutation-probe.mjs` exit 1 — `PROBE FAIL P1`
- `qa-admin-independent.mjs` exit 1 — `FAILED E14`

Both are **stale anchors**, not new product defects: wave 10 changed the product on purpose and these two checks still pin the old behaviour. Your job is to re-pin them so they keep biting — and to prove the re-pin is non-vacuous.

## Finding 1 — P1 (the stale-revision guard) is now two layers

`site/qa/qa-mutation-probe.mjs:108-136` patches **one** guard:

```
path.join(apiCopy, 'moderate', 'review.ts'),
'if (currentRevision !== revision) {',
'if (false) {',
```

and expects `M1`, `M2` to FAIL. Measured now: `expected: M1, M2 must FAIL / actual: M1=PASS M2=PASS (29 passed / 0 failed)`.

Wave 10 added a **second** layer (F-2): the store refuses a stale revision itself —
- `site/shared/portal-store/file-adapter.ts:250` — `if (expectedRevision !== undefined && revisionNumber(record) !== expectedRevision) { return null; }`
- `site/shared/portal-store/libsql-adapter.ts:516,527-528` — `AND revision = ?`
- the contract: `site/shared/portal-store/types.ts` `decideReview(ref, decision, at, decidedBy?, expectedRevision?)`
- the handler passes it: `api/moderate/review.ts:377`

So removing only the handler guard no longer reddens M1/M2 — the store still refuses.

**Required outcome:** the P1 probe must remove **both** layers so the end-to-end protection is proved non-vacuous. The sandbox already copies the store: `site/qa/qa-mutation-probe.mjs:64-67` copies `api/` **and** `site/shared/` under one root — so the store adapter is patchable there. Patch the handler guard **and** the store's revision scope, then `M1` and `M2` must FAIL.

Keep the probe's current strengths:
- it must FAIL LOUDLY when a patch anchor is not found (`patch()` at `:69-75`) — never a silent pass;
- add the same **liveness** proof the P2/D2/W9-1 probes have (rename the anchor → the check itself goes RED) — `site/qa/qa-anchor-nonvacuity.mjs` already exists for this; reuse it.

## Finding 2 — E14 pins the CF inbox's OLD behaviour

`site/qa/qa-admin-independent.mjs:1120-1157` asserts two things about the Cloudflare twin of `GET /api/admin/reviews`:

1. edge runtime (no filesystem) → **501** `{code:'unimplemented'}` — **still true**, keep it;
2. **with a filesystem** (`QA_ADMIN_EDGE_FS=1`, `:1112`) → **200**, with the same `pendingReviews` count, the same queue length and the same `openNotes` as the Vercel tree — **now false by design**.

Wave 10 (F-6) deliberately rewrote `site/functions/api/admin/reviews.ts`: the JSONL read is **gone** and the endpoint answers 501 unconditionally (`:83-93` — "There is no moderation store on this target… A queue that cannot exist must never look like an empty one"). Measured: `FAILED E14: the CF twin with a filesystem should be 200 (got 501: {"error":"moderation store unavailable on this target","code":"unimplemented"})`.

**Required outcome — re-pin E14 to the new contract, and do not weaken it:**
- the CF inbox answers **501 `{code:'unimplemented'}`** in **both** modes (edge and `QA_ADMIN_EDGE_FS=1`);
- the gates **before** the store are unchanged and must still be asserted: **401** for a non-owner (`site/functions/api/admin/reviews.ts:56-59`) and **500** when `ADMIN_EMAILS` is unset (`:45-54`) or `FORM_WEBHOOK_SECRET` is unusable (`:68-81`);
- the Vercel tree still answers **200** with a real queue in libsql mode — the comparison against the Vercel tree moves from the queue **body** to the **gate**, because the CF tree deliberately serves no queue any more;
- **non-vacuity proof:** a mutation that puts a JSONL read back into the CF inbox must make E14 go RED.

Also confirm `site/qa/qa-cf-parity.mjs` still passes (it does today).

## Finding 3 — the wave-9b legacy fixture blocks the dead-file cleanup (F-7)

`api/lib/jsonl.ts` has **zero** importers in the product (wave-10 harness check G1) — it is a **dead Vercel function** that still costs one of the 12 Hobby slots. It can be deleted, but one of your files depends on it:

`site/qa/qa-wave9-store-queue.mjs:542-545` builds a "legacy" tree = a copy of the current `api/` with `admin/reviews.ts` replaced by the frozen pre-wave-9 fixture `site/qa/fixtures/prewave9-admin-reviews.ts.txt`. That fixture's line 62 imports `../lib/jsonl.js` and line 63 imports `../lib/notifications.js` — both resolved against the **copied current** `api/` tree.

**Required outcome:** make the legacy sandbox **self-contained**, so it no longer depends on the current product file. After the `copyDir(API_DIR, …)` at `:543`, overwrite the legacy tree's `api/lib/jsonl.ts` (and `api/lib/notifications.ts`) with the frozen pre-wave-9 sources from git checkpoint `a4b10a8` (`git show a4b10a8:api/lib/jsonl.ts` — verified to exist and to export the same names). Keep the legacy comparison **byte-for-byte faithful to pre-wave-9**: do not change the fixture file itself, and keep the `git agrees` provenance check (`:530-541`) intact.

Then `api/lib/jsonl.ts` can be deleted by the Backend with no QA suite breaking. **Do not delete it yourself** — it is not your file; report the fixture is self-contained when it is.

## Gate (all executed by you, cited by check id)

- `powershell -NoProfile -ExecutionPolicy Bypass -File site\qa\run-all-suites.ps1` → **every suite exits 0 (14/14)**, with `PORTAL_MAGIC_LINK_SECRET` and `PORTAL_SESSION_SECRET` set to ≥32-char values (`pwsh` is **not** installed on this machine; use `powershell -NoProfile -ExecutionPolicy Bypass`).
- a **fresh** transcript under `site/qa/artifacts/qa-full-run-<new>.txt` — cite the path, and do not cite an older transcript.
- every re-pinned check proven **non-vacuous** (control → mutant → liveness), reusing `site/qa/qa-anchor-nonvacuity.mjs`.
- `site/data/` untouched: `site/data/moderation/reviews.jsonl` 0 bytes, no `site/data/portal/`.

**Timing note:** the Backend is changing `site/scripts/publish-testimonials.mjs` in this same wave (a publisher bug fix). If a publisher-related suite fails, re-read that file and re-run the suite before reporting a failure — a failure caused by a half-written publisher is not a QA finding.

## Deliverable

Report at `C:\Users\Kalch\Documents\IXI\qa-wave11-repin-2026-10-22.md`: every check you changed with `file:line`, the before/after anchor, the non-vacuity proof per re-pin, the runner result and the transcript path, and an explicit **UNVERIFIED** list (no real Turso, no workerd, no deploy, no live mail).

Answer **DONE** or **BLOCKED** with findings ranked by severity. Do not claim a gate you did not execute, and do not weaken a check to make it pass — re-pin it so it still bites.
