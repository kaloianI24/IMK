# Wave 11 — Backend brief: the publisher still deletes published quotes when the store is empty

Repo: `C:\Users\Kalch\Documents\IXI` (working tree is permanently dirty, 62 changed paths — never reset/clean/checkout/stash, never run a mutating git command).

YOU OWN:
- `site/scripts/publish-testimonials.mjs`
- `backend-wave10-store-integrity-harness.mjs`

DO NOT TOUCH:
- `site/qa/**` (QA's — a QA re-pin is running in parallel)
- `api/**`, `site/functions/**`, `site/shared/**`, `site/src/**`, `DEPLOY.md`, `site/.env.example`

## The defect (measured by the Manager, reproduced by execution)

Wave 10 closed M-1 for a **missing** store. It did **not** close it for an **empty but present** store.

- `site/scripts/publish-testimonials.mjs:585-604` `readReviewsFromStore()`: the "store missing" escape hatch at `:593` only covers `err.storeMissing === true`. A store that is present and readable but yields **zero records** returns `[]` and flows straight into `main()`.
- `main()` (`:659-691`) then builds an empty file list and calls `swapIn(files)` at `:690`.
- `swapIn()` (`:621-657`) renames the published directory aside (`:643`) and deletes it (`:653`) — so every published quote is destroyed.

Reproduction (file mode, `PORTAL_STORE=file`), with one published `existing.md` and a **0-byte** `data/moderation/reviews.jsonl`:

```
outcome: testimonials_published, totalReviews 0, written 0, exit 0
RESULT: DELETED  <-- DATA LOSS
```

The database path has the same hole with a one-run offset. `site/scripts/publish-testimonials.mjs:535-567`: on the first run the schema is created and the run **refuses** (`:561-566`). On the **second** run the schema exists, the table is empty, zero rows are read, and the published quotes are deleted with exit 0. Same store state, opposite outcome, one run apart.

## The harness currently pins the bug as correct

`backend-wave10-store-integrity-harness.mjs:531-561`, check **A4** ("a reachable, schema-present but EMPTY store exits 0 and publishes nothing") asserts `publishedFiles(sandbox).length === 0` after writing `kept.md` — i.e. it asserts that the published quote IS deleted. A4 must be re-pinned, not deleted.

## Required outcome

The rule the product must satisfy:

1. The store yields **zero records** AND published quotes **exist** → **refuse**: exit 1, a precise message, and the published directory left exactly as it was.
2. The store yields **zero records** AND **nothing** is published → exit 0, publish nothing (a fresh install must still build — QA's BUILD-14 depends on it).
3. The store yields records → unchanged behaviour (approved + consented quotes published; revoked ones disappear — A5).

Keep rule 1 and rule 2 on the **file** path and the **libSQL** path, so the two modes agree.

## Hard constraint — do not break QA's mutation probe

QA's probe **P2** patches the publisher's malformed-line block by exact character match (`site/qa/qa-mutation-probe.mjs:143-158`). Keep the malformed-line `try { records.push(JSON.parse(line)); } catch { throw new Error( ... 'refusing to publish a partial set of testimonials. Fix or remove that line.' ); }` block **byte-identical**, including its indentation. Implement the new empty-store guard as a **separate, new** code path.

## Gate (all must be green, executed by you, cited by check id)

- `npm run typecheck:api` → exit 0
- `npm run check:routes` → 16 routes, 0 missing
- `npm run test:store` → 66 pass / 0 fail
- the seven existing harnesses unchanged and green: wave6 24/24, f1 22/22, wave8 35/35, wave8-session 57/57, wave8-m1 11/11, wave9 13/13, wave9b 16/16
- `backend-wave10-store-integrity-harness.mjs` → all existing checks green, plus new checks:
  - **A10** empty store + a published quote → exit 1, the published quote survives, the message names the condition
  - **A11** empty store + nothing published → exit 0, writes nothing (fresh install still builds)
  - **A12** MUTATION: with the empty store treated as "publish nothing" instead of fatal → **A10 goes RED**
- `site/data/` untouched (reviews.jsonl 0 bytes, no `site/data/portal/`)

## Deliverable

Report at `C:\Users\Kalch\Documents\IXI\backend-wave11-publisher-empty-store-2026-10-22.md`: what changed (file:line), every gate with its result, the new check ids, and an explicit **UNVERIFIED** list (no real Turso, no workerd, no deploy, no live mail).

Answer **DONE** or **BLOCKED** with findings ranked by severity. Do not claim a gate you did not execute.
