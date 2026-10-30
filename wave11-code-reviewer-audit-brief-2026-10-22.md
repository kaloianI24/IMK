# Wave 11 — Code Reviewer brief: independent audit of wave 10 (F-1…F-6)

Repo: `C:\Users\Kalch\Documents\IXI` (tree is permanently dirty, 62 changed paths — never reset/clean/checkout/stash, never run a mutating git command).

YOU OWN: one new file, your audit report. **Read-only on everything else** — do not edit any product, test, doc or harness file.

DO NOT TOUCH: `api/**`, `site/**`, `spec/**`, `DEPLOY.md`, `site/.env.example`, `site/data/**`, repo-root `*.mjs` harnesses, `site/qa/**`.

## Why this audit exists

Wave 10 changed the moderation store's write path, the store reachability checks, the rate limiter's key derivation, the libSQL transport's paging, the Cloudflare inbox and the publisher. Its only evidence is **the author's own report** (`C:\Users\Kalch\Documents\IXI\backend-wave10-store-integrity-2026-10-22.md`). Nobody outside the author has checked it. The QA Engineer is concurrently re-pinning two suites that wave 10 invalidated, and the Backend is concurrently fixing a publisher bug this audit is likely to find (below), so **do not report the publisher's empty-store behaviour as an unknown** — it is already known and being fixed; see the last section.

The Manager has already verified these by execution, and they hold: `typecheck:api` exit 0 · `check:routes` 16 routes / 0 missing · `test:store` 66/66 · the wave-10 harness 28/28 · the seven older harnesses 24/24, 22/22, 35/35, 57/57, 11/11, 13/13, 16/16. Your job is the parts nobody checked.

## Scope — audit each of the six claims independently

Read the code, then **re-derive** each claim. For each finding, give `file:line`, the observed behaviour, and — where it can be run offline — the exact command or the harness check id that demonstrates it.

1. **F-1 — the publisher refuses to publish a partial set** (`site/scripts/publish-testimonials.mjs`). Claim: a missing store, an unparsable store and a schema-less database each make the build fail, and the published quotes survive. Check the **file** path and the **libSQL** path separately — the two are separate code (`readReviewsFromFile` `:242-266`, `readReviewsFromDatabase` `:475-570`) and only one of them was reported as proven. Verify the staging-directory swap (`:621-657`) cannot leave the published directory half-written: read the rename/rollback order and say what a crash between the two renames would leave on disk.
2. **F-2 — a decision can no longer land on a revision the owner never saw.** Claim: `decideReview` takes `expectedRevision` and the store refuses a mismatch. Check **both** adapters (`site/shared/portal-store/file-adapter.ts:250-252`, `libsql-adapter.ts:516,527-528`) and the handler (`api/moderate/review.ts:328,377`) and the Cloudflare twin (`site/functions/api/moderate/review.ts:252-292`). Then ask the question the report does not: **is the check atomic?** Read the libSQL write path around `libsql-adapter.ts:501-570` and say whether a concurrent append between the read and the write can still flip the wrong revision. If it can, that is a MAJOR finding — say so plainly.
3. **F-3 — a missing store no longer answers "not invited" / "no projects" / "no quote".** Claim: `assertStoreReachable` guards the store call sites. Check the claim the report makes about the probe's scope: is the probe asking "can this deployment hold a store?" rather than "does each collection file exist?", and does that distinction hold on a **fresh install** (a new deployment with no data yet)? Report whether any call site can still return an empty-but-successful answer.
4. **F-4 — the libSQL transport now follows the baton.** Claim: `site/shared/portal-store/libsql-transport.ts:273-320` pages until the baton is null. Read it and say whether it can loop forever, whether the page size is honoured, and whether the **publisher's** separate plain-JS libSQL reader agrees with it (the report admits it is a second implementation to keep in step — check whether it is, in fact, a second implementation).
5. **F-5 — the rate limiter's key and its counter.** Claim: the key is now a platform-controlled address only (`api/portal/auth.ts:159-170`), and the counter is pruned. Check: does any other limiter path still derive a key from a client-supplied header? Is the prune bounded (does it prune on a schedule, or only when a bucket is touched)? Can a client still get an unbounded number of buckets by rotating addresses?
6. **F-6 — the Cloudflare inbox now answers 501.** Claim: `site/functions/api/admin/reviews.ts:83-93` answers 501 {code:'unimplemented'} and the JSONL read is gone. Verify the JSONL read is **gone**, that the owner gate (401) and the misconfiguration gate (500) are still checked **before** the 501, and that nothing else in that file still reads the filesystem.

## The one finding the Manager already confirmed — verify it, do not rediscover it

The publisher still deletes the published quotes when the store is **readable but empty**. Reproduced by execution: with one published quote and an empty store, the publisher exits **0**, writes 0 files and the published quote is **gone**.

The code path: `readReviewsFromStore` (`site/scripts/publish-testimonials.mjs:585-604`) only treats a *missing* store as fatal (`:593`); an empty-but-readable store returns `[]`, `main()` (`:659-691`) builds an empty file list, and `swapIn` (`:621-657`) renames the published directory aside and deletes it.

**Your job on this one:** confirm it by execution, then look for the **same class of defect elsewhere** — any other place where an empty, absent or partially-readable state is allowed to overwrite or clear a non-empty one. Then say what the correct rule is: an empty store with published quotes present must be **fatal**, while an empty store with nothing published must still build (a fresh install must not break).

The Backend is fixing this now in `site/scripts/publish-testimonials.mjs` — so **read the file as it is when you start** and note if it changed under you. Do not edit it.

## Method

- Prefer **execution** over reading wherever a check can run offline. The repo-root harnesses and `site/qa/**` are the tools; run them, do not modify them.
- Any mutation probe you write goes in a **temp directory**, never in the repo.
- State clearly which claims you confirmed by execution and which you confirmed by reading only.
- Do not report a finding you cannot locate to a `file:line`.

## Deliverable

Report at `C:\Users\Kalch\Documents\IXI\audit-wave10-store-integrity-2026-10-22.md`:
- a verdict per finding F-1…F-6: **CONFIRMED** / **PARTLY** / **NOT CONFIRMED**, each with the evidence;
- new findings ranked **CRITICAL / MAJOR / MINOR**, each with `file:line`, the observed behaviour, the impact on the owner's launch, and a recommended fix;
- the publisher-empty-store finding confirmed, plus any sibling defect of the same class;
- an explicit **UNVERIFIED** list — say plainly that no real Turso database was contacted, no Vercel router or workerd was booted, no deploy was made and no live mail was sent, so every platform-level claim in the wave-10 report remains unproven outside this repo.

Answer **DONE** or **BLOCKED**. Do not soften a finding to make the wave look finished.
