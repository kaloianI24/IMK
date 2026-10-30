# Wave 10 — backend store integrity (Backend Developer)

**Date:** 2026-10-22 · **Repo:** `C:\Users\Kalch\Documents\IXI` · **Branch:** main, no remote
**Brief:** `wave10-backend-store-integrity-brief-2026-10-22.md`
**Harness:** `backend-wave10-store-integrity-harness.mjs` (new, 28/28)

**Status: DONE-PARTIAL.** Six of the seven findings are closed and proven by
execution. F-7 is **not** done, and it is not mine to finish: deleting
`api/lib/jsonl.ts` breaks a QA suite, and the brief's own rule for that case
is "leave the file in place until QA answers". Two QA checks also have to be
re-pinned (details in §5) — both are direct, unavoidable consequences of F-2
and F-6, which the brief requires.

No git write command was run. `site/data/` is untouched (`reviews.jsonl`
0 bytes, no `site/data/portal/`).

---

## 1. The gates (executed on the tree as it is now)

| Gate | Result |
|---|---|
| `npm run typecheck:api` | **exit 0** |
| `npm run check:routes` | **16 routes, 0 missing** (both trees) |
| `npm run test:store` | **66/66** (was 60 — four new contract assertions, ×2 adapters, +2 libsql-only) |
| `backend-wave10-store-integrity-harness.mjs` | **28/28** (new; 7 mutation probes) |
| `backend-wave6-harness.mjs` | 24/24 |
| `backend-f1-magic-token-harness.mjs` | 22/22 |
| `backend-wave8-harness.mjs` | 35/35 |
| `backend-wave8-session-endpoint-harness.mjs` | 57/57 |
| `backend-wave8-moderation-m1-harness.mjs` | 11/11 |
| `backend-wave9-store-wiring-harness.mjs` | 13/13 |
| `backend-wave9b-admin-inbox-store-harness.mjs` | 16/16 |
| QA runner (`powershell -File site/qa/run-all-suites.ps1`) | **13 of 15 suites exit 0** — see §5 |
| `site/data` | untouched (`reviews.jsonl` 0 bytes, no `site/data/portal/`) |

Harness total: **206 checks** in the eight backend harnesses, of which the new
one is 28 (21 checks + 7 mutation probes).

QA transcript to cite: `site/qa/artifacts/qa-full-run-2026-10-22-032002.txt`.

---

## 2. The findings, by severity

### F-1 — CRITICAL (data loss): the publisher could delete the published quotes and exit 0

**Changed**

| File:line | What |
|---|---|
| `site/scripts/publish-testimonials.mjs:200` | `MissingStoreError` — a store that is *absent* is now a distinct, typed condition (a store that cannot be *read* stays a plain error) |
| `site/scripts/publish-testimonials.mjs:246` | a missing `reviews.jsonl` is an **error**, not `[]` |
| `site/scripts/publish-testimonials.mjs:562` | a database whose schema is missing is an **error** (the schema is created first — see below) |
| `site/scripts/publish-testimonials.mjs:280` | `SCHEMA_STATEMENTS` — the publisher's own copy of the DDL, exported so it can be compared |
| `site/scripts/publish-testimonials.mjs:374` | the publisher's plain-JS pipeline **follows the baton** (F-4) |
| `site/scripts/publish-testimonials.mjs:621` | `swapIn()` — the new set is built in a staging directory and **swapped in**; the published directory is not touched until the new set is known |
| `site/scripts/publish-testimonials.mjs:597` | a store that is absent while **nothing is published yet** publishes nothing and exits 0 (the fresh-clone case) |
| `site/scripts/publish-testimonials.mjs:721` | the module can be imported without publishing (the DDL check needs that) |

**Proven by:** `A1` (a missing store exits 1, the published quote survives),
`A2` (a store that cannot be parsed exits 1, the published quote survives),
`A3` (a database with **no schema** exits 1, the schema is created, the
published quote survives), `A4` (a reachable, schema-present but **empty**
store exits 0 and publishes nothing), `A5` (a revoked quote **disappears** on
the next successful publish — RP-6.5 did not regress), `A6` (the publisher's
DDL is **byte-identical** to `libsql-schema.ts`'s — 25 statements), `A8` (a
fresh install still builds), `A7`/`A9` (the mutation probes).

**The reproduction from the brief now fails as it should:** the old code
answered `[]` for a missing store, deleted every published `.md` and exited 0.
The mutation probe `A7` puts that back and the published quote is destroyed
again — so the check is not vacuous.

**One deliberate deviation, and why.** The brief says "a store that cannot be
read, or a schema that does not exist, must fail loudly (exit 1)". Taken
literally that also breaks a *fresh install* (no moderation log yet), which
QA pins as a working case (`site/qa/qa-testimonials-build.mjs:400`,
BUILD-14: "a site with no moderation store at all still builds"). The rule
implemented is:

> a store that is **absent** is fatal **when there is something to lose** —
> when the published set is not empty. A store that is **unreadable**
> (corrupt file, database down, missing `LIBSQL_URL`) is always fatal.

All four gates of the brief are still met in the scenarios the brief
describes (they all have a previously published `.md`): (a) a missing store
exits non-zero and leaves the published `.md` untouched, (b) a store with no
schema exits non-zero, (c) an empty store exits 0 and publishes nothing,
(d) a revoked record's `.md` disappears on the next successful publish.

**Also in the publisher:** the missing-schema case now *creates* the schema
(the same idempotent DDL) before it refuses, so the database is usable from
then on; the DDL duplication cannot drift because `A6` compares the two texts
statement by statement.

### F-2 — CRITICAL (wrong text approved): a decision could land on a revision the owner never saw

**Changed**

| File:line | What |
|---|---|
| `site/shared/portal-store/types.ts:85` | `decideReview(..., expectedRevision?)` — the flip is **revision-scoped** |
| `site/shared/portal-store/file-adapter.ts:250` | the file adapter refuses to flip a record whose revision is not the expected one (nothing is written) |
| `site/shared/portal-store/libsql-adapter.ts:516` | the SQL carries `AND revision = ?` — only a record with that exact revision can be flipped; the fallback `SELECT` reads the typed `revision` column so "moved" can be told from "already decided" |
| `api/moderate/review.ts:377` | the handler passes the revision it **verified** |
| `api/moderate/review.ts:137` | `answerStaleRevision()` — one place that answers 409 and mails the owner a fresh link |
| `api/moderate/review.ts:404` | the write-time race is logged as `review_revision_moved_at_write` and answered **409 stale-revision**, never a false success |
| `site/functions/api/moderate/review.ts:359` | the Cloudflare twin **re-reads** the log before the write and compares the revision — it flips the revision it verified |

**Proven by:** `B1` (a store that appends a newer revision between the
handler's read and its write — the race, injected at the seam — yields
**409 stale-revision** and **no state change** on either record), `B2` (a
matching revision still flips: 200 approved, the store carries the decision),
`B3` (both adapters refuse a decision for another revision — file **and**
libsql over the real wire protocol), `B4` (the mutation probe: with the
revision scope removed from the file adapter, the stale revision is decided
again).

The contract grew with it: `site/shared/portal-store/test/contract.shared.ts`
now asserts the revision scope against **both** adapters (`test:store`
60 → 66).

### F-3 — HIGH (silent empty answers): a store that is not there answered "no projects"

**Changed**

| File:line | What |
|---|---|
| `site/shared/server/portal-store-access.ts:221` | `canHoldStore()` — can this deployment hold a store at all? |
| `site/shared/server/portal-store-access.ts:270` | `assertStoreReachable()` now also answers for the **store itself** (no collection): it is reachable when the data root is there, or when this deployment can put it there |
| `api/portal/{auth,comments,invites,plan-items,projects,testimonials,updates}.ts:272/79/194/76/103/331/79` | every portal handler probes the store before it reads it and answers **501 {code:'unimplemented'}** when it is not reachable |
| `api/lib/rate-limit.ts:236` | a **damaged** rate-limit counter file is a configuration error, not an empty counter: it raises `invalid-config` → **500 {code:'storage'}** instead of silently resetting the counter to zero (which was a silent limit bypass) |

**Proven by:** `C1` (all seven portal handlers answer 501
`{code:'unimplemented'}` when the deployment cannot hold a store — never a
200 with an empty list), `C2` (a damaged counter file → 500 `{code:'storage'}`),
`C3` (the moderation endpoint and the inbox keep their 501 for a missing
*collection* file — the behaviour QA pins), `C4` (the mutation probe).

**The granularity, and why it is not the one in the brief.** The brief asks
for the *existing helper* — `assertStoreReachable('reviews')`, a per-collection
file probe. Applied to the portal handlers that probe breaks two things that
are real product behaviour:

* the owner's **first** request on a fresh install (the invite file does not
  exist yet) — `site/qa/qa-wave2-independent.mjs` signs in before any store
  file exists, and the whole suite died with `request-link ... should be 200
  -- expected 200, got 501`;
* a client who simply has **no projects yet** — `site/qa/qa-wave5-independent.mjs`
  A2/A3/A5 expect 200 with an empty list, and the data root there holds
  `invited.jsonl` but not `projects.jsonl`.

Both suites are QA's and may not be edited. The store contract itself says
the same thing: *"a missing file is still an empty collection, not an error"*
(`site/shared/portal-store/file-adapter.ts:16`). So the probe asks the
question that has exactly two answers — **can this deployment serve a store
at all?** — and answers 501 when it cannot (a read-only function filesystem
with no store: the serverless shape). The per-collection probe stays exactly
where it was, for the two endpoints that serve one collection.

### F-4 — MEDIUM (silent truncation): the libSQL transport never followed the baton

**Changed**

| File:line | What |
|---|---|
| `site/shared/portal-store/libsql-transport.ts:273-320` | the pipeline follows the **baton** to the end: the continuation request carries the baton and an **empty** requests array (the v2 protocol), and a `base_url` the server sends is honoured |
| `site/shared/portal-store/libsql-transport.ts:223` | the number of pages is bounded (100) — a server that keeps handing out a baton is an error, never a truncated answer that looks complete |
| `site/shared/portal-store/test/mock-pipeline-server.ts:201-235` | the mock can **page** its answers (`pageSize`), so the contract run can prove it |

**Proven by:** `D1` (against a server that hands out one result per page: a
three-statement pipeline comes back **complete**, the schema step works, the
rows are all there, and the continuation request carries the baton and no
statements), `D2` (the mutation probe: with the baton ignored, only 1 of the
3 results comes back).

The contract grew with it: `site/shared/portal-store/test/contract.test.ts`
now has *"libsql: a PAGED answer is assembled completely"* and *"the durable
rate counter PRUNES the expired buckets"* (the count went 60 → 66).

### F-5 — HIGH (unbounded table, bypassable limit): the durable rate counter

**Changed**

| File:line | What |
|---|---|
| `site/shared/portal-store/durable-rate-counter.ts:74` | `RATE_COUNTER_PRUNE_SQL` — `DELETE FROM rate_counters WHERE reset_at <= ?` |
| `site/shared/portal-store/durable-rate-counter.ts:120-129` | the prune and the hit run in **one pipeline round trip**, the prune first; the false comment ("one row per bucket, so the table cannot grow without bound") is replaced by the truth |
| `api/portal/auth.ts:159` | `platformAddress()` — only a **platform-controlled** address: `cf-connecting-ip` (Cloudflare overwrites it), otherwise the **last** hop of `x-forwarded-for` (the platform appends the address it saw; the client can only put hops in front) |
| `api/portal/auth.ts:139` | `INSTANCE_BUCKET` — when no trustworthy address exists, the bucket is **per instance**, never a client-chosen value |
| `api/portal/auth.ts:309` | the limiter key is `ip:<platform address>` or the instance bucket |

**Proven by:** `E1` (an expired bucket is pruned; the table holds only the
live buckets), `E2` (the harness plays the platform and appends its address to
the chain the client sent: varying the client's own prefix does **not** create
a new bucket — the limit is reached), `E3` (with no platform header at all the
requests share the per-instance bucket), `E4` (the mutation probe: with the
prune removed the table keeps growing).

**The rationale, stated for the record.** The old key was the whole
`x-forwarded-for` header, which a client can vary per request: every request
landed in a fresh bucket, the limit was never reached, and every request added
a row. The new key is the last hop — the platform's own view — and the
fallback is a per-instance bucket, which is weaker than a shared per-address
limit but can never be bypassed by a header. The trade-off: on a target that
sets neither header the limit is per instance rather than global.

**Not changed, and reported:** the Cloudflare twin has the same pattern
(`site/functions/api/portal/auth.ts:199` and `:215` — the whole
`x-forwarded-for` header as the bucket key). That file is **not** in this
wave's ownership list, so I did not touch it. The CF portal tree answers 501
before the limiter is reached (`site/functions/api/portal/auth.ts:255`), so
the path is not live there, but the defect is identical and should be closed
in a later wave.

### F-6 — MEDIUM (parity): the Cloudflare inbox claimed a file store

**Changed:** `site/functions/api/admin/reviews.ts` (rewritten) — the JSONL
read is **gone** (no `parseJsonlStrict`, no `REVIEWS_FILE`, no `readFileSync`,
no `node:fs`), and the endpoint answers **501 {code:'unimplemented'}** — what
it really does on the edge, and exactly what the Cloudflare moderation twin
answers for the same situation. The **gate is unchanged**: a non-owner is 401,
a missing/unusable `ADMIN_EMAILS` or `FORM_WEBHOOK_SECRET` is 500. The CF
tree is deliberately **not** wired to the store (Vercel is the launch target).

**Proven by:** `F1` (the CF inbox answers 501 for the owner), `F2` (a source
scan: no JSONL reader, no file path, no filesystem import), `F3` (the mutation
probe: with the queue back, the check reddens).

### F-7 — LOW (housekeeping): NOT DONE, and why

`api/lib/jsonl.ts` has **no importer** in the product (`G1` proves it by a
source scan over `api/`, `site/src`, `site/scripts`, `site/shared`,
`site/functions/`), and it still costs a Vercel function: a file under
`api/` with no default export becomes a dead function (a URL that answers
500).

**I tried the deletion on 2026-10-22 and it breaks a QA suite**, exactly the
case the brief's own rule covers (*"If any script under `site/qa/**` names
`api/lib/jsonl.ts` explicitly, do NOT edit `site/qa/**`: report it in your
report and leave the file in place until QA answers"*):

```
site/qa/qa-wave9-store-queue.mjs:521-545
  -> copies the current api/ tree, replaces api/admin/reviews.ts with the
     pre-wave-9 fixture site/qa/fixtures/prewave9-admin-reviews.ts.txt
  -> that fixture (line 62) imports '../lib/jsonl.js'
  -> with the file deleted:
     ERROR: Could not resolve "../lib/jsonl.js"
     [qa] SUITE ERROR Error: Build failed with 1 error  -> exit 1
```

`site/qa/**` is QA's, so the file **stays**; the reason is written into the
file itself (`api/lib/jsonl.ts:11-30`) so the next reader sees it, and `G2`
pins that note. **One line from QA** (re-pin the fixture to
`site/shared/server/jsonl.ts`, or drop the legacy comparison) unblocks the
deletion. Until then the function budget stays at 20 files / 3 dead utilities
— DevOps owns `DEPLOY.md`, which counts them.

---

## 3. The new harness

`backend-wave10-store-integrity-harness.mjs` — 28 checks, 7 of them mutation
probes. Every probe works on a **copy** of the tree under the OS temp
folder, and the repository is never modified.

| Group | What it proves |
|---|---|
| A | F-1: the publisher (missing / corrupt / schema-less / empty / revoked / the DDL / the fresh install) + 2 probes |
| B | F-2: the revision-scoped decision (the race, the normal path, both adapters) + 1 probe |
| C | F-3: the reachability (7 handlers, the damaged counter, the QA-pinned 501s) + 1 probe |
| D | F-4: the baton (a paged server, the continuation request) + 1 probe |
| E | F-5: the prune, the platform-controlled key, the per-instance bucket + 1 probe |
| F | F-6: the CF inbox (the answer, the source, the mutant) + 1 probe |
| G | F-7: the dead function (no importer, and the QA reason it is still there) |

Usage: `node backend-wave10-store-integrity-harness.mjs` (exit 1 if anything
fails).

---

## 4. What stays UNVERIFIED

* **No real Turso database was ever contacted.** The libSQL half of every
  proof runs against the SQLite engine of the Python standard library over
  the **real** libSQL HTTP v2 wire protocol (the mock pipeline server) — that
  is Turso's protocol, not Turso's service.
* **The Vercel router and workerd were never booted.** No deployment, no
  preview, no live mail, no Resend call. The QA suites and the harnesses
  execute the real handler code in-process.
* **The F-3 "the deployment cannot hold a store" case is simulated** with a
  file in the way of the data root (ENOTDIR), not with a read-only function
  filesystem. The rule itself (`canHoldStore`) walks up to the nearest
  existing ancestor and asks whether it is a writable directory; on a
  serverless target that ancestor is read-only, but that was not observed —
  it was reasoned.
* **The rate-limit key derivation is proven against a simulated platform.**
  The harness appends the platform's address to the chain the client sent,
  the way Vercel and Cloudflare do. That the platform really appends (and that
  a client cannot append at the end) is a property of the platforms, read
  from their documentation — not observed here.
* **The Cloudflare tree was not booted in workerd.** The CF twins were
  executed as bundled modules with the `Request`/`Response` API, not in a
  Worker isolate.
* **The publisher's second, plain-JS libSQL reader is still a second
  implementation** (Node cannot import the TypeScript store in the prebuild
  step). The DDL duplication is now proven identical (`A6`), but the reader
  itself is not shared code — a drift is still possible in the SQL, and the
  wave-9 harness proves the two agree on one fixture.
* **The 12-function budget is unchanged**: `api/` still holds 20 `.ts` files.
  F-7 would make it 19; the ≤12-function refactor is a separate wave.
* **The dev server on port 4321 still runs the pre-wave-10 bundle** (it
  bundles at startup). It needs an in-place `npm run dev:portal` restart
  before the new code is live locally. I did not restart it — 4321 is out of
  my bounds.

---

## 5. What QA has to re-pin (two checks, both caused by the brief)

I did not touch `site/qa/**`. Both checks below encode the behaviour the
brief removes, and both are one-line re-pins for QA:

1. **`site/qa/qa-admin-independent.mjs:1090-1157` — E14** *"the Cloudflare
   queue twin answers like the Vercel tree (edge runtime and with a
   filesystem)"*. The second half expects the CF inbox to answer **200 with
   the queue** when a filesystem is present. F-6 makes that answer impossible
   (the edge has no store) — the CF inbox now answers **501
   `{code:'unimplemented'}`** in both cases. The first half of E14 (the edge
   runtime → 501) still passes. *Suggested re-pin:* expect 501 in both halves
   and drop the "the CF twin and the Vercel tree show the same queue"
   comparison for the CF tree.

2. **`site/qa/qa-mutation-probe.mjs:108-135` — P1** *"M5 - the stale-revision
   guard is removed"*. The probe removes the guard in
   `api/moderate/review.ts` and expects the wave-2 checks M1/M2 to go red.
   They do not any more, because **F-2 moved the same rule into the store**:
   with the handler's guard gone, the store's revision scope still refuses
   the stale decision and the handler still answers 409. *This is defence in
   depth, not a hole* — but the probe can only red the wave-2 checks if it
   removes **both** layers (the handler's guard *and*
   `site/shared/portal-store/file-adapter.ts:250`). My own probe `B4` removes
   the store layer and shows the defect returning.

Two things in the QA tree were already re-pinned by me in earlier waves and
are green again (the publisher's `main()` shape was kept
`const reviews = await readReviewsFromStore();` so that
`site/qa/qa-wave9-store-independent.mjs:1647`'s MP-B mutation anchor still
applies — the probe is green again).

---

## 6. The files I changed

```
api/lib/jsonl.ts                                  (F-7 note only)
api/lib/rate-limit.ts                             (F-3, F-5)
api/moderate/review.ts                            (F-2)
api/portal/auth.ts                                (F-3, F-5)
api/portal/comments.ts                            (F-3)
api/portal/invites.ts                             (F-3)
api/portal/plan-items.ts                          (F-3)
api/portal/projects.ts                            (F-3)
api/portal/testimonials.ts                        (F-3)
api/portal/updates.ts                             (F-3)
site/functions/api/admin/reviews.ts                (F-6, rewritten)
site/functions/api/moderate/review.ts             (F-2)
site/scripts/publish-testimonials.mjs             (F-1, F-4)
site/shared/portal-store/types.ts                 (F-2)
site/shared/portal-store/file-adapter.ts          (F-2)
site/shared/portal-store/libsql-adapter.ts        (F-2)
site/shared/portal-store/libsql-transport.ts      (F-4)
site/shared/portal-store/durable-rate-counter.ts  (F-5)
site/shared/portal-store/test/contract.shared.ts  (F-2)
site/shared/portal-store/test/contract.test.ts    (F-4, F-5)
site/shared/portal-store/test/mock-pipeline-server.ts (F-4)
site/shared/server/portal-store-access.ts         (F-3)
backend-wave10-store-integrity-harness.mjs        (new)
backend-wave10-store-integrity-2026-10-22.md      (this report)
```

Not touched: `site/qa/**`, `DEPLOY.md`, `site/.env.example`, `spec/**`,
`site/data/**`, `site/src/content/testimonials/**`, any `*-brief-*.md` /
`*-wave*-*.md` report, and no git write command of any kind.
