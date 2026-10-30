# WAVE 10 — backend store integrity (5 audit findings + 2 consistency fixes)

Repo: `C:\Users\Kalch\Documents\IXI`. Read the tree from disk; do not trust any
report's line numbers — several have moved.

## YOU OWN (edit these)

- `site/scripts/publish-testimonials.mjs`
- `site/shared/portal-store/**` — `types.ts`, `file-adapter.ts`, `libsql-adapter.ts`,
  `libsql-transport.ts`, `libsql-schema.ts`, `durable-rate-counter.ts`,
  `test/contract.shared.ts`, `test/mock-pipeline-server.ts`
- `api/moderate/review.ts`, `api/portal/*.ts`, `api/lib/rate-limit.ts`, `api/lib/jsonl.ts`
- `site/functions/api/moderate/review.ts`, `site/functions/api/admin/reviews.ts`

## DO NOT TOUCH

- `site/qa/**` — QA owns it
- `DEPLOY.md`, `site/.env.example` — DevOps owns them
- `spec/**`, `audit-*.md`, `*-brief-*.md`, `backend-wave*.md` (reports)
- `site/data/**` (the real store), `site/src/content/testimonials/**` (published output)
- No git write command of any kind (no add / commit / checkout / reset / stash)

Each finding below was verified by the Manager against the tree.

---

## F-1 (launch-critical, data loss) — the publisher can delete published quotes and publish an empty set with exit 0

`site/scripts/publish-testimonials.mjs:346-353` deletes every `*.md` in
`src/content/testimonials` BEFORE writing the new set. `:181`
`if (!fs.existsSync(file)) return [];` turns a missing file into "empty store".
`:289` `if (/no such table/i.test(message)) return [];` turns a database whose
schema was never created into "empty store".

Manager reproduction (temp dir, `PORTAL_STORE=file`, empty data dir): exit **0**,
`"written":0`, and a previously published quote `.md` was **gone**.

Required outcome:

- A store that cannot be read, or a schema that does not exist, must **fail loudly**
  (exit 1). It must never publish an empty set.
- A missing schema is NOT an empty store: create it (idempotent `CREATE TABLE IF NOT
  EXISTS`, the same DDL as `site/shared/portal-store/libsql-schema.ts`) and then read.
  If that still fails → exit 1. Because the publisher is plain JS it cannot import the
  TS schema module: if you duplicate the DDL, add a check that the publisher's DDL
  text is IDENTICAL to `libsql-schema.ts`'s DDL, so the duplication cannot drift
  silently.
- The published directory must not be emptied before the replacement set is known:
  build the new set in a temp directory and swap it in. On a failure the published
  directory must be left EXACTLY as it was.
- A genuinely empty store (schema present, zero rows) still publishes zero files —
  that is correct and must not fail.

Gate: harness checks must prove (a) an unreadable/missing store exits non-zero and
leaves the previously published `.md` untouched, (b) a store with no schema exits
non-zero, (c) a reachable, schema-present but empty store exits 0 and publishes
nothing, (d) a revoked record's `.md` disappears on the next successful publish
(RP-6.5 must not regress).

## F-2 (launch-critical, wrong text approved) — a decision can land on a revision the owner never saw

`api/moderate/review.ts:255` reads the newest record, `:263` compares its revision
with the signed link's revision, and `:344` then calls
`store.decideReview(ref, ...)`, which RE-READS and flips the NEWEST record at write
time (`file-adapter.ts:214-226`; `libsql-adapter.ts:496`). A client that appends a
revision between the check and the write has its text approved under the owner's
signature.

The pre-wave-9 behaviour was correct: `git show a4b10a8:api/moderate/review.ts`
flipped the record it had already read.

Required outcome: the decision must apply to the revision that was verified. Make
the store's `decideReview` revision-scoped (an expected-revision parameter) so only
a record with that exact revision can be flipped, in BOTH adapters, and update the
CF twin `site/functions/api/moderate/review.ts` to match. If the record moved, the
handler answers the existing 409 stale-revision path — never approve, never report a
false success.

Gate: a harness check must prove that a concurrent append between the read and the
write yields 409 stale-revision and NO state change, and that a matching revision
still flips.

## F-3 (silent empty answers) — 8 of the 10 store call sites never probe reachability

`assertStoreReachable` is used in only `api/moderate/review.ts:235` and
`api/admin/reviews.ts:181`. The other eight (`api/portal/auth.ts`, `comments.ts`,
`invites.ts`, `plan-items.ts`, `projects.ts`, `testimonials.ts`, `updates.ts`,
`api/lib/rate-limit.ts`) read straight through `file-adapter.ts:68`, which returns
`[]` for a missing file — so a store that is simply not there answers **200** with
"not invited" / "no projects" / "no quote".

Required outcome: every handler that reads the store probes reachability first,
using the existing helper, and answers the documented storage error instead of an
empty success. Copy the pattern from `api/moderate/review.ts:235` and
`api/admin/reviews.ts:181`.

Gate: harness checks must prove that, with the store absent, each of the eight
answers the storage error and not 200-with-empty.

## F-4 (silent truncation) — the libSQL transport never follows the baton

`site/shared/portal-store/libsql-transport.ts:221` always sends `baton:null` and
never inspects a returned baton, so a paged result set is silently truncated. The
mock `site/shared/portal-store/test/mock-pipeline-server.ts:290` always returns
`baton:null`, so the contract run cannot catch it.

Required outcome: follow the baton to the end (v2 pipeline protocol), and make the
mock return a baton at least once so the contract run proves it.

Gate: the contract run must gain a new assertion that a paged result set is
assembled completely. Report the new test count honestly.

## F-5 (unbounded table, bypassable limit) — the durable rate counter

`site/shared/portal-store/durable-rate-counter.ts:78-79` claims "One row per
bucket, so the table cannot grow without bound". False: there is no DELETE for
`rate_counters` anywhere, and the bucket is a hash of a client-supplied header
(`api/portal/auth.ts:132` reads `x-forwarded-for`, which a client can set). Rows
therefore grow without bound and the limit can be bypassed by varying the header.

Required outcome: prune expired buckets (`DELETE ... WHERE reset_at <= now`) so the
table cannot grow without bound, and derive the key only from a header the platform
controls — never from a value the client can choose. If no trustworthy address is
available, fall back to a per-instance bucket rather than a client-chosen one.
Correct the false comment. State the rationale in the report.

## F-6 (parity) — the CF admin inbox still reads the moderation file

`site/functions/api/admin/reviews.ts:38` imports `parseJsonlStrict` from
`shared/portal-store/jsonl.js`, `:42` names `REVIEWS_FILE`, `:154` reads it. In a
real Worker there is no filesystem (`edgeFs()` returns null, `:61-63`), so the
endpoint answers 501 anyway — but the code still claims a file store while the
Vercel twin now answers real data, so the two trees disagree.

Required outcome: make the CF inbox answer exactly what it answers in production —
`501 {code:'unimplemented'}` — like the CF moderation twin
(`site/functions/api/moderate/review.ts:220-227`), and remove the JSONL read. Do
NOT wire the CF tree to the store; Vercel is the launch target and that is a later
wave.

## F-7 (housekeeping) — `api/lib/jsonl.ts` is dead code that still costs a Vercel function

It has zero importers now (the admin inbox was the last one). Vercel builds one
function per file under `api/`. Delete it. `api/lib/notifications.ts` and
`api/lib/rate-limit.ts` DO have importers — they stay.

If any script under `site/qa/**` names `api/lib/jsonl.ts` explicitly, do NOT edit
`site/qa/**`: report it in your report and leave the file in place until QA answers.

---

## Acceptance

- `npm run typecheck:api` → exit 0
- `npm run check:routes` → 16 routes, 0 missing
- `npm run test:store` → all green (report the count; it may change if F-2 changes
  the contract)
- NEW harness `backend-wave10-store-integrity-harness.mjs` at the repo root, with
  every F-* check proven NON-VACUOUS: a mutated copy must make the check fail
- the existing harnesses still green: `backend-wave6-harness.mjs`,
  `backend-f1-magic-token-harness.mjs`, `backend-wave8-harness.mjs`,
  `backend-wave8-session-endpoint-harness.mjs`, `backend-wave8-moderation-m1-harness.mjs`,
  `backend-wave9-store-wiring-harness.mjs`, `backend-wave9b-admin-inbox-store-harness.mjs`
- `site/data` untouched: `reviews.jsonl` 0 bytes, no `site/data/portal/`
- keep the tree typecheck-clean after EVERY step. If you run out of runway, stop at
  the last green step and report DONE-PARTIAL naming exactly what landed and what
  did not.

## Report

`C:\Users\Kalch\Documents\IXI\backend-wave10-store-integrity-2026-10-22.md` —
findings ranked by severity, each with the file:line changed and the harness check
id that proves it. List what stays UNVERIFIED.

Answer with **DONE / DONE-PARTIAL / BLOCKED**.
