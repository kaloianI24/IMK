# Wave 9 — independent code review: the portal store wiring

**Subject:** `site/shared/server/portal-store-access.ts` (new) + the 9 api handlers that import it
(`api/lib/rate-limit.ts`, `api/moderate/review.ts`, `api/portal/{auth,comments,invites,plan-items,projects,testimonials,updates}.ts`)
+ `site/scripts/publish-testimonials.mjs`.
**Repo:** `C:\Users\Kalch\Documents\IXI` · commit `a882606` + the working-tree changes that landed during this review.
**Reviewer:** Code Reviewer — Independent Audit. **Read-only:** no file in the repo was edited; this report is the only file created.
**Date:** 2026-10-22.

---

## 0. Verdict

**The change is sound in its core and materially better than what it replaces, but it is not ready to carry real client quotes until M-1, M-2 and M-3 are fixed or explicitly accepted.**

What I verified as **correct** (details in §4): the hand-rolled JSONL path is gone from all nine
handlers; every `StorageError` surfaces as `500 {code:'storage'}` with no stack and no secret in the
body; the data-root resolution is **not** a production path bug; the publisher's *unreachable* /
*misconfigured* paths really do exit 1; the author's harness reproduces at 13/13 (I ran it myself);
the typecheck is clean.

Five MAJOR findings follow. None of them is a design flaw in the `PortalStore` contract — they are
edge cases the contract does not cover: an *empty* store, a *missing* store, a *racing* decision, an
*unbounded* counter and a *paginated* result set.

| # | Severity | One line |
|---|---|---|
| M-1 | MAJOR | The publisher can silently publish an **empty** queue — and it **deletes the published quotes** while exiting 0. |
| M-2 | MAJOR | Eight of the ten store call sites have **no reachability probe**: a missing store answers `200` with empty data ("not invited", "no projects"). |
| M-3 | MAJOR | A moderation decision can land on a **revision the owner never saw** (the decision target moved from "the record I read" to "the newest record at write time"). |
| M-4 | MAJOR | The shared rate counter is **unbounded** and its key is **client-influenceable** — the limit can be bypassed and the table can be filled with junk. |
| M-5 | MAJOR | The libSQL client **never follows the `baton`** → a large result set is silently truncated (and the publisher then deletes the truncated tail). |
| m-1…m-11 | MINOR | 11 smaller items (§2). |

---

## 1. MAJOR findings

### M-1 — The publisher silently publishes an empty queue, and it **deletes** the published quotes

**Where**
- `site/scripts/publish-testimonials.mjs:179-198` — `readReviewsFromFile()`: a missing file → `return []`.
- `site/scripts/publish-testimonials.mjs:53-60` — `resolveDataDir()`: `PORTAL_DATA_DIR` is used even when
  it does not exist; otherwise the first *existing* candidate wins, and when none exists it returns
  `candidates[0]` — a path that does not exist.
- `site/scripts/publish-testimonials.mjs:289` — libsql mode: `if (/no such table/i.test(message)) return [];`
  → "the schema was never created" is treated as "the queue is empty".
- `site/scripts/publish-testimonials.mjs:346-353` — **the output directory is cleared before anything is written.**
- `site/scripts/publish-testimonials.mjs:336-394` / `:396-405` — `main()` writes what it has and exits 0; only a
  *thrown* error exits 1.

**Evidence — I executed it** (publisher run in a temp directory, nothing in the repo touched):

```
$ PORTAL_STORE=file PORTAL_DATA_DIR=<temp>/no-such-data-dir node site/scripts/publish-testimonials.mjs
{"outcome":"testimonials_published","totalReviews":0,"currentRecords":0,"approved":0,"written":0, ...}
EXIT CODE: 0
--- remaining files in the testimonials dir:      <-- the previously published OLD-QUOTE.md is GONE
```

So a build whose store is reachable-but-empty (or whose data root/env points somewhere else)
**exits 0, publishes nothing, and removes every previously published testimonial from the build
output**. The owner's quotes disappear from the live site and the build is green.

**Why this matters for the brief's question 5.** The brief asks: *the publisher exits 1 when the
store is unreachable — confirm a build cannot silently publish a stale or empty queue.*
- "unreachable" → **verified**: exit 1 (`publish-testimonials.mjs:251-261`, and the author's W4b/W4c, which I
  reproduced). "misconfigured" (no `LIBSQL_URL`/`LIBSQL_TOKEN`) → exit 1 (`:219-230`).
- "an **empty** queue" → **not covered**. The loud-failure rule stops at the network edge; a store that
  answers with zero records is indistinguishable from a wrong store, and the publisher treats it as
  "there is nothing to publish" — destructively.

**Fix (concrete)**
1. File mode: a missing data root or a missing `moderation/reviews.jsonl` must be an **error**
   (`exit 1`), not an empty store — unless an explicit escape hatch (`PUBLISH_ALLOW_EMPTY=1`) is set.
2. libsql mode: treat `no such table` as an error too (same escape hatch). "The schema does not exist"
   is a *configuration* state, not "the queue is empty".
3. **Do not clear the output directory before the read has succeeded.** Move the clear to after a
   successful read, and skip it entirely when the read yielded zero records and the previous build had
   published something.
4. Harness: add two checks — "the publisher exits non-zero when the store is EMPTY" and "the
   publisher does not delete previously published files when the store is empty".

---

### M-2 — Eight of the ten store call sites have no reachability probe: a missing store answers `200` with empty data

**Where**
- `site/shared/server/portal-store-access.ts:220-230` — `assertStoreReachable(coll, env)`: in file mode it
  checks that the collection file exists and throws `StoreUnreachableError`.
- It is called in **two** places only: `api/moderate/review.ts:235` and `api/admin/reviews.ts:181`
  (the latter landed in flight during this review).
- The eight portal handlers never call it: `api/portal/auth.ts`, `comments.ts`, `invites.ts`,
  `plan-items.ts`, `projects.ts`, `testimonials.ts`, `updates.ts`.
- `site/shared/portal-store/file-adapter.ts:68` — `if (!fs.existsSync(file)) return [];` → a **missing file is
  an empty collection**, not an error (the adapter's own header says so).
- `site/shared/server/portal-store-access.ts:158` — the default backend is `'file'`
  (`(bag.PORTAL_STORE || 'file')`). `PORTAL_STORE` unset ⇒ file mode.

**Consequence.** On a target where the file store is not there — Vercel's read-only filesystem, a wrong
`PORTAL_DATA_DIR`, a deployment that does not carry `site/data/`, a process started from `site/`
(⇒ `site/site/data`) — the portal answers *normally* with empty data:

| call site | answer the client/owner gets |
|---|---|
| `api/portal/auth.ts:336` `isInvited(...)` → `false` | "If you have an invitation, a sign-in link has been sent." — **every client is locked out, silently** |
| `api/portal/projects.ts:131` GET | `{projects: []}` (`:133`) — "no projects" |
| `api/portal/testimonials.ts` GET (`:386`) | `{testimonial: null}` — "no quote" |
| `api/portal/comments.ts` / `updates.ts` GET | empty lists |

Meanwhile the write paths fail loudly (a read-only FS → `StorageError` → `500 {code:'storage'}`), so
the owner sees a confusing mix of "no data" and 500s. This is exactly the silent-outage class that
audit M3 / QA D3 were written to kill, and the module that ships the fix (`assertStoreReachable`)
is used in 2 of 10 places.

**Honesty note.** This is **not a regression**: the pre-wave-9 code had the same behaviour
(`api/lib/jsonl.ts:22-24` — `readJsonlFile` returned `[]` for a missing file). But wave 9 is the wave
that made the store the single choke point and that already ships the probe; the eight handlers are
the ones that need it.

**Fix**
1. Call `assertStoreReachable(<collection>)` at the top of every store-reading handler and answer
   `501 {code:'unimplemented'}` exactly like `api/moderate/review.ts:241-245` does — or, better, put the
   probe inside `getPortalStore()`/a `getReachableStore(coll)` helper so no call site can forget it.
2. Make the **default fail closed on a serverless target**: `PORTAL_STORE` unset in production should
   be a `500 {code:'internal'}` misconfiguration, not a silent fall back to a file store that cannot
   work there. DEPLOY.md already documents `libsql` as required in production; nothing enforces it.

---

### M-3 — A moderation decision can land on a revision the owner never saw

**Where**
- `api/moderate/review.ts:255` — `const record = await store.latest('reviews', { ref, type: 'review' })`
  (the newest revision **now**).
- `api/moderate/review.ts:261-263` — `if (currentRevision !== revision) → 409 stale-revision`.
- `api/moderate/review.ts:344` — `const decided = await store.decideReview(ref, decidedState, now, 'one-click-link')`
  — and `decideReview` decides **the newest record for that ref at write time**:
  `site/shared/portal-store/file-adapter.ts:214-220` and
  `site/shared/portal-store/libsql-adapter.ts:490-496`
  (`WHERE seq = (SELECT seq … WHERE ref = ? AND type = 'review' ORDER BY seq DESC LIMIT 1)`).
- The client appends a new revision at `api/portal/testimonials.ts:627` (`store.append('reviews', record)`).
- The publisher publishes the newest record per ref (`site/scripts/publish-testimonials.mjs:93-102`).

**The race.** Between the read at `:255` and the write at `:344`, the client can submit revision N+1.
The handler has already validated revision N, but `decideReview` flips **N+1**. The publisher then
publishes N+1, because it takes the newest record per ref. Net effect: **the owner approves text they
never saw** — the exact harm the revision mechanism exists to prevent (audit M5: "the one-click approve
may only approve the exact text the owner was shown").

**This is a wave-9 behaviour change, not a pre-existing bug.** The pre-wave-9 code flipped the record it
had *read* (`git show a4b10a8:api/moderate/review.ts` — `const record = reviews[idx]; record.state = …;
writeReviews(reviews)`), so the decision always landed on the revision the owner was shown.

**The window is not theoretical in production.** In file mode it is a sub-millisecond local read/write.
In libsql mode it is **one HTTP round trip** (`latest`) plus another (`decideReview`) — tens to hundreds
of milliseconds on a real database. That is a window a client can hit.

**Fix (concrete)**
1. Make the decision target the row the handler validated. The `revision` column already exists in the
   schema (`site/shared/portal-store/libsql-schema.ts:96`), so extend the contract with an optional
   `expectedRevision`:
   - libsql: add `AND revision = ?` to the `UPDATE` in `libsql-adapter.ts:491-498` → a mismatch updates
     0 rows → `decideReview` returns `null`.
   - file adapter: compare the revision of the record it selected before flipping
     (`file-adapter.ts:223-233`).
2. In `api/moderate/review.ts:344-349`, a `null` result must be classified, not reported as
   `500 {code:'storage'}`: re-read `latest()` and answer `404` (unknown ref), `409 stale-revision`
   (revision moved) or `500` (a real write failure).
3. The wave-9 report's §1.4 wording — *"The `state = 'pending'` guard is what makes 'never flip an
   already-decided record' a property of the statement"* — is true **only for the libsql adapter**; in
   file mode it is a check-then-write (see m-1).

---

### M-4 — The shared rate counter is unbounded, and its key is client-influenceable

**Where**
- `site/shared/portal-store/durable-rate-counter.ts:53-58` — `RATE_COUNTER_SQL`: one row per bucket
  (`bucket TEXT PRIMARY KEY`), `INSERT … ON CONFLICT … RETURNING count`.
- `site/shared/portal-store/libsql-schema.ts:117-121` — the `rate_counters` table.
- **No eviction exists anywhere.** A repo-wide grep for `rate_counters` returns only the INSERT, the DDL
  and two comments — no `DELETE`. The file backend *does* prune (`api/lib/rate-limit.ts:255-257`:
  `if (now >= bucket.reset) delete state.buckets[bucketId]`); the SQL backend does not.
- `site/shared/portal-store/durable-rate-counter.ts:78-79` — the comment claims *"One row per bucket, so
  the table cannot grow without bound: the file backend's bucket cleanup … is unnecessary."* **That
  claim is wrong**: one row per bucket means the table grows by one row per *distinct key*, forever.
- The key for the sign-in limiter is the client IP: `api/portal/auth.ts:251-255` (`ip:${ip}`) and
  `api/portal/auth.ts:129-135` `ipFromHeaders()` — which reads `x-forwarded-for` **as the client sent it**
  (the first entry of the list).

**Consequences**
1. **Unbounded growth.** Every distinct key leaves a row forever. The keys are SHA-256 hashes
   (`durable-rate-counter.ts:61-73`), so no IP is stored — but the row count is attacker-controlled.
2. **The shared limit can be bypassed.** A caller who varies `x-forwarded-for` per request gets a fresh
   bucket per request → `allowed` is always true → the "shared" 5-per-hour limit on the sign-in endpoint
   is not enforced at all. (On Vercel the platform normally rewrites/appends `x-forwarded-for`; the
   handler takes the **first** entry, which is the client-controlled one. I did not test this against a
   live Vercel deployment — see §5.)
3. The comment at `durable-rate-counter.ts:78-79` documents a guarantee the code does not provide.

**Fix**
1. Evict: `DELETE FROM rate_counters WHERE reset_at < :now` — e.g. on 1 hit in N, or from a daily job.
2. Trust a platform header, not the client's: use `x-vercel-forwarded-for` / `x-real-ip` on Vercel and
   take the **last** entry of `x-forwarded-for` (the one the proxy appended), never the first.
3. Cap the number of buckets, or fail the counter closed when the table is over its cap.

---

### M-5 — The libSQL client never follows the `baton`, so a large result set is silently truncated

**Where**
- `site/shared/portal-store/libsql-transport.ts:215-253` — `pipeline()` always sends
  `body: JSON.stringify({ baton: null, requests })` (`:221`) and **never reads `body.baton`**.
- `site/shared/portal-store/test/mock-pipeline-server.ts:290` — the mock always answers
  `{ baton: null, base_url: null, results }`. **The mock cannot reproduce the truncation**, so the 60/60
  contract test cannot catch it.
- `site/scripts/publish-testimonials.mjs:239-249` — the publisher's own reader has the same gap, and its
  query has no `LIMIT`: `SELECT data FROM moderation_reviews ORDER BY seq ASC` (`:244`).
- `site/shared/portal-store/libsql-adapter.ts:330-338` — `rowsOf()` (used by every `list()`) is the same path.

**Consequence.** The libSQL HTTP v2 protocol returns a `baton` when a result set does not fit in one
response; the client must send it back to fetch the rest. If that happens:
- the publisher publishes only the first page — **and, because it clears the output directory first
  (`publish-testimonials.mjs:346-353`), it deletes the published files of every record that was cut off**;
- `api/admin/reviews.ts` (the owner's queue) shows only the first page of reviews;
- `store.list('reviews')` truncates for every other caller.

**Unverified trigger.** I did not contact a real Turso, so I do **not** know the page size that would
trigger this. The protocol gap itself is certain; the probability is not.

**Fix**
1. Loop on the baton in `createHttpTransport.pipeline()`: when the response carries a baton, send
   `{ baton, requests: [{ type: 'close' }] }` and append the rows.
2. Same in the publisher's reader — or, better, give the publisher's query a `LIMIT`/keyset pagination
   and assert that the number of rows read equals the number expected.
3. Extend the mock pipeline server to return a baton for a large result, so the contract test can prove
   the transport follows it.

---

## 2. MINOR findings

**m-1 — File mode's decision is still a read-modify-write with no lock.**
`site/shared/portal-store/file-adapter.ts:203-234`: read the whole file → mutate → rewrite the whole
file, no lock. Two concurrent decisions can interleave (the later write wins — a *rejected* quote can end
up *approved*), and a client revision appended between the read and the rewrite is **lost**. The
`state='pending'` guard at `:224` is a check-then-write, not a statement-level guard.
*Correction to the wave-9 report §1.4:* the pre-wave-9 code did **not** use a tmp-file+rename — it was a
plain `fs.writeFileSync` (`git show a4b10a8:api/moderate/review.ts`, `writeReviews`). **No atomicity was
lost**; the file mode is byte-for-byte what it was. The report's "the tmp-file + rename atomicity of the
old code is replaced by the database's atomicity" mis-describes the old code and glosses over the fact
that file mode has no atomicity at all. *Fix:* serialise the file write with the same lock-file technique
the rate limiter's file backend already uses (`api/lib/rate-limit.ts:155-206`), or state the limitation
honestly in the contract.

**m-2 — `api/lib/jsonl.ts` is now dead code and still costs a Vercel function.**
Nothing imports it any more (repo-wide grep: only its own header and comments in other files). It is one
of the **20** `.ts` files under `api/` and it has no default export, so Vercel builds it as a dead
function that 500s on its URL. *Fix:* delete it → 19 files, which also helps the ≤12 budget (deferred
wave 7b). Same check for the CF twin `site/functions/api/lib/jsonl.ts`.

**m-3 — The transport validation is duplicated in two files and can drift.**
`site/shared/server/portal-store-access.ts:115-141` repeats the three fail-closed rules of
`site/shared/portal-store/libsql-store.ts:31-57` (I compared them: same order, same messages **today**).
Two copies of a fail-closed check will diverge. Also `getStore()`
(`site/shared/portal-store/index.ts:35-51`) is now a second, unused selector for the Vercel tree, and it
resolves the data dir **per call** while the access module resolves it **at module load** — two different
semantics for the same thing. *Fix:* export the check from `libsql-store.ts` and call it from both;
have `getPortalBackend` use `createLibsqlStoreFromEnv` for the store and keep the transport only for the
rate counter.

**m-4 — `guardStore`'s error path assumes the response has not been sent.**
`site/shared/server/portal-store-access.ts:242-254` and the ten `onError` callbacks call `json(res, …)`
unconditionally. A `StorageError` raised **after** the response was written makes Node throw
`ERR_HTTP_HEADERS_SENT` out of the catch block → the client gets a reset connection instead of
`500 {code:'storage'}`. I found **no live path** for it (every store call in the nine handlers precedes
its response), so this is a latent trap, not a defect today. *Fix:* `if (res.headersSent) return;` at the
top of each `onError`.

**m-5 — `logDegradation` prints the opposite of what happened for a configuration error.**
`api/lib/rate-limit.ts:352-355`: the `invalid-config` path calls `this.logDegradation(err)`, whose text is
*"the durable counter is unavailable; the in-memory counter is used instead"* — but the in-memory counter
is **not** used: the request fails with `500 {code:'storage'}`. *Fix:* a separate
`outcome:'rate_limit_misconfigured'` line.

**m-6 — One transient database error permanently downgrades the shared limit on that instance.**
`api/lib/rate-limit.ts:358` — `this.backendFailed = true` latches on any non-config error, so the instance
falls back to the per-process counter for its whole life, and the degradation is logged **once**
(`:329-330`, `:377-390`). On Vercel an instance lives for minutes. The "shared limit" quietly becomes
per-instance again — the exact weakness the durable counter was added to remove — with one line in a wall
of JSON. *Fix:* latch for a short cooldown (e.g. 30 s) and retry afterwards; log the recovery too.

**m-7 — The store and the publisher resolve the data root differently.**
The publisher probes `ROOT/data` then `ROOT/site/data` and takes the first that exists
(`site/scripts/publish-testimonials.mjs:53-60`); the store always uses `path.resolve(process.cwd(), 'site/data')`
(`site/shared/server/portal-store-access.ts:54`). In the normal cases they agree (the build runs from
`site/`, the handlers from the repo root — `site/scripts/dev-portal.js:41` does
`process.chdir(REPO_ROOT)` for exactly this reason), but they can diverge: a process started from `site/`
makes the store look for `site/site/data`, and a build run from a directory that contains a `data/`
folder makes the publisher look there. *Fix:* one shared resolver, or require `PORTAL_DATA_DIR` in
production. **This is the answer to the brief's question 6 — the module-load-time resolution is *not* a
new production path bug** (the pre-wave-9 handlers used the identical module-level
`path.resolve(process.cwd(), 'site/data/portal')`; verified in `git show a4b10a8:api/portal/*.ts`), but
the two readers of the same store should not disagree about where it is.

**m-8 — `DEPLOY.md` is factually wrong about wave 9 in three places (the file was being edited during
this review).**
- *"`site/scripts/publish-testimonials.mjs` still reads `data/moderation/reviews.jsonl` at build time"* —
  **false since wave 9**: the publisher reads the store (file mode: the same file; libsql mode: the
  database over the v2 pipeline).
- *"Rate limiting is per-instance only (no durable counter) until the storage migration lands"* —
  **false**: with `PORTAL_STORE=libsql` the counter is the shared SQL counter
  (`api/lib/rate-limit.ts:420-422`).
- *"`api/portal/session.ts` … use `getPortalStore()`"* — **false**: `api/portal/session.ts` has **no**
  store usage at all (no `getPortalStore`, no `guardStore`, no store call).
- The heading *"**What does NOT work on Vercel today:**"* now sits above a bullet describing what *does*
  work.
The DevOps doc-accuracy brief should cover these; they are the same class of claim the wave-9 report
makes about the publisher.

**m-9 — The publisher is a hand-rolled second storage path (the report acknowledges it in §6.3) and it
already diverges in three places.** `site/scripts/publish-testimonials.mjs:179-198` re-implements the file
adapter's parsing but does **not** enforce "a record must be a JSON object" (the file adapter throws
`storage-corrupt`, `file-adapter.ts:93-98`) → a non-object line is silently skipped by the publisher and
fatal to the store; `:289` treats "no such table" as empty while the store would have *created* the
schema (`libsql-adapter.ts:323-348`); and it does not follow the baton (m-5). *Fix:* build the publisher
on the contract (a small compiled CLI under `site/shared/`) so there is one reader.

**m-10 — The schema-promise fix landed during this review and is correct; the report's §6.2 is now
stale.** `site/shared/portal-store/libsql-adapter.ts:323-348` (working tree, uncommitted): a rejected
`ensureSchema` promise is evicted, and the eviction is guarded by `schemaReady === attempt` so an older
rejection cannot evict a newer attempt; the `catch` is registered at creation time, so it is queued
before any awaiting continuation and the next request retries the schema. I verified it compiles:
`npx tsc -p site/tsconfig.api.json --noEmit` → **exit 0** (that tsconfig includes `shared/**/*.ts`, so the
contract tree *is* type-checked). The wave-9 report §6.2 still describes the bug as open — it should be
updated to "fixed, wave 9B".

**m-11 — The `sessions` collection is created but never used.**
`site/shared/portal-store/libsql-schema.ts:108-114` creates `portal_sessions` (with a `token` column) in the
owner's database; nothing writes to it (the session is a signed stateless token). Harmless, but it is an
unused table with a token-shaped column. *Fix:* drop it from the schema or document why it is there.

---

## 3. In-flight work observed during the review (not counted as findings)

- **`api/admin/reviews.ts` (wave 9B) landed mid-review** (mtime 01:37, uncommitted). It is now correct:
  the queue is read through the contract (`store.list('reviews')`, `:206`), it probes reachability
  (`:180-195`), it answers `501 {code:'unimplemented'}` for an unreachable store and
  `500 {code:'storage'}` for a corrupt one, and the old `parseJsonlStrict` import and `REVIEWS_FILE`
  constant are gone. **This closes the "one remaining JSONL reader" gap** that the wave-9 report listed
  as §6.1 — the report is now out of date on that point too.
- **`site/shared/portal-store/file-adapter.ts:70-74`** gained a BOM strip, so the file adapter now agrees
  with `portal-store/jsonl.ts:56` and the publisher on a hand-edited (Notepad) file. Good fix; it closes a
  real "corrupt here, readable there" divergence.
- `DEPLOY.md` was being edited at the same time (see m-8) — the claims above are from the version on disk
  when I read it.

---

## 4. What I checked and found **correct** (so it is not re-litigated)

- **No hand-rolled storage path remains in the nine handlers.** A source scan of `api/**` for
  `readJsonlFile|appendJsonl|rewriteJsonl|parseJsonlStrict|site/data|jsonl` returns **comments only**
  in the nine files; the only real hits are in `api/lib/jsonl.ts` (now dead, m-2) and the rewritten
  `api/admin/reviews.ts`.
- **Error handling is uniform.** All ten store call sites use `guardStore` and answer exactly
  `{ error: 'storage unavailable', code: 'storage' }` with status 500
  (`api/portal/auth.ts:562-568`, `comments.ts:209-215`, `invites.ts:300-306`, `plan-items.ts:355-361`,
  `projects.ts:350-356`, `testimonials.ts:689-695`, `updates.ts:210-216`, `api/moderate/review.ts:385-391`,
  `api/admin/reviews.ts:295-301`). `guardStore` catches `StorageError` **and** `StorageCorruptError`
  (`portal-store-access.ts:249`, `isStorageCorrupt` at `portal-store/jsonl.ts:42-44`).
- **No secret, token or stack reaches the client.** The response bodies are fixed strings; the libSQL
  transport redacts userinfo and `Bearer …` before any message
  (`libsql-transport.ts:186-188`, `:227`, `:260`); the token is only ever a header
  (`libsql-transport.ts:217`). `storageFailureLog` puts the message in the **log**, not the response.
- **The data-root resolution is not a new production path bug** — see m-7. The pre-wave-9 handlers used
  the identical module-load constant, and the dev server explicitly `chdir`s to the repo root
  (`site/scripts/dev-portal.js:41`).
- **The publisher fails loudly when the store is unreachable or misconfigured** — `exit 1`
  (`publish-testimonials.mjs:219-230`, `:251-261`, `:396-405`); the empty-store case is the hole (M-1).
- **The rate limiter is per-process in file mode and shared in libsql mode**, as documented
  (`api/lib/rate-limit.ts:420-423`; the author's W5a/W5b, which I reproduced). The config-error path
  re-throws instead of silently degrading to a per-process counter — the right call.
- **`decideReview` is idempotent in both backends**: libsql falls back to a second `SELECT` and returns
  the already-decided record (`libsql-adapter.ts:511-526`); the file adapter returns the record unchanged
  when it is not pending (`file-adapter.ts:224-227`). The handler's `decided.state !== decidedState`
  branch (`api/moderate/review.ts:350-355`) answers `200` in both cases.
- **The approved/snoozed/declined revision semantics are preserved.** The client appends a new record
  with `revision = (existing?.revision || 0) + 1` (`api/portal/testimonials.ts:612`) and the newest record
  wins everywhere: `store.latest()` (`file-adapter.ts:194-201` scans from the end; `libsql-adapter.ts:464-475`
  uses `ORDER BY seq DESC LIMIT 1`), the publisher (`publish-testimonials.mjs:93-102`) and the moderation
  endpoint. The old rule was `records[records.length - 1]` after the same filter
  (`git show a4b10a8:api/portal/testimonials.ts:242-249`) — equivalent.
- **The patch semantics are preserved.** `undefined` removes a field: `Object.assign` + `JSON.stringify`
  drops it in file mode (`file-adapter.ts:172`), `json_remove` removes it in libsql mode
  (`libsql-adapter.ts:410-427`). This is what `delete project.testimonialStatus` used to do.
- **The author's harness reproduces.** I ran `backend-wave9-store-wiring-harness.mjs` myself:
  **13/13 checks passed** (against the working tree, which by then also contained the wave-9B changes).
  `npx tsc -p site/tsconfig.api.json --noEmit` → **exit 0**.
- **The function budget did not move:** 20 `.ts` files under `api/` (verified), the same as before wave 9.
- **The `PortalStore` contract was not changed** by wave 9 — the only contract-file edits I saw are the
  BOM strip and the schema-promise fix, both of which are additive fixes, not contract changes.

---

## 5. What stays UNVERIFIED (do not read this audit as more than it is)

- **No real Turso was ever contacted.** The libSQL half of every proof is a real SQLite engine (Python)
  behind the mock pipeline server. Concretely unverified: the **baton behaviour of a real Turso** and
  its page size (M-5); the real error shapes; the real latency of the `latest` → `decideReview` window
  (M-3); the real growth of `rate_counters` (M-4).
- **The Vercel router was never booted.** The "20 functions" figure is a static count of the files under
  `api/`, not a Vercel build. Whether Vercel builds 20 functions here, and whether the Hobby
  12-function cap actually bites, was not tested. The claim that `process.cwd()` is the repo root on
  Vercel is read from the code and DEPLOY.md (`Vercel Root Directory = repository root`), not observed.
- **workerd was never booted.** The Cloudflare tree was not in scope beyond confirming it does not
  import the Node-only access module.
- **No live mail.** The notification path was not exercised.
- **The concurrency findings (M-3, m-1) are from code reading.** I did not reproduce a racing decision
  or a racing append.
- **The rate-limit key spoofing (M-4) was not tested against a live proxy.** Whether Vercel rewrites
  `x-forwarded-for` completely or appends to it was not observed.
- **The publisher was executed by me only in file mode against a synthetic empty data root** (in a temp
  directory). I did not run it against a real Turso, and I did **not** run the site build (that would
  write to `site/src/content/testimonials`).
- **The differential fixture is the author's.** `backend-wave9-store-wiring-fixture.json` was captured by
  the Backend Developer from the pre-wave-9 code; I verified that the harness *passes*, not that the
  fixture was captured honestly. (I did read the pre-wave-9 sources directly for the semantics
  comparisons in §4.)
- **I did not audit `site/functions/**`** (the Cloudflare tree) beyond the import check.

---

## 6. Suggested order of work

1. **M-1** (publisher) — it can silently delete the owner's published quotes; it is a small, local fix.
2. **M-2** (reachability probe) — one helper call per handler; it is the difference between "the portal
   is empty" and "the portal cannot work here".
3. **M-3** (decision race) — before the portal carries real quotes; the contract change is small
   (`expectedRevision`).
4. **M-4** + **M-5** — hardening of the shared counter and the pipeline client; both need a real Turso
   to validate, so schedule them with the owner's database.
5. The MINORs, in the order listed, plus the two report corrections (m-1's tmp-file/rename claim and
   §6.2's schema-promise claim) and the DEPLOY.md corrections (m-8).

*This report was produced by an independent read of the code and of the git history, plus the two
executions named above. No file in the repository was modified by this review.*
