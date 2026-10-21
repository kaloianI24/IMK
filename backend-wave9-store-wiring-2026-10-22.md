# Wave 9 — Backend: the portal handlers now read and write through the PortalStore

**Repo:** `C:\Users\Kalch\Documents\IXI` · branch `main` · no git remote · shared dirty tree
**Brief:** `wave9-backend-store-wiring-brief-2026-10-22.md`
**Date:** 2026-10-22
**Status:** **DONE** — every gate in §6 of the brief is green, and the store-wiring harness is 13/13.

The portal could not run on Vercel because every endpoint read and wrote JSONL
files under `site/data/`, and a Vercel function has a read-only filesystem.
Every portal endpoint answered `500 {code:'storage'}`. The `PortalStore`
contract (`site/shared/portal-store/**`) already existed and was proven; this
wave binds the handlers to it, so `PORTAL_STORE=libsql` actually persists.

---

## 1. What changed, file by file

### 1.1 NEW — `site/shared/server/portal-store-access.ts` (290 lines)

The one place where the Vercel handler tree reaches the store. It is **Node
only** (it uses `node:fs` for one thing — the "is the store there at all?"
probe); the Cloudflare tree uses `site/shared/portal-store/edge.ts` and its
own 501 stub and never imports it.

| Export | What it does |
|---|---|
| `getPortalStore(env)` | The store for this environment. One instance per configuration, cached on `globalThis`, so the libSQL schema step happens once and not once per request. |
| `getPortalBackend(env)` | The store + the backend name + the libSQL transport (the rate counter shares that transport — one database, one client). |
| `createPortalTransport(env)` | The libSQL HTTP v2 transport, failing closed on a missing `LIBSQL_URL` / `LIBSQL_TOKEN` / a non-http URL. The same three rules as `libsql-store.ts`. |
| `assertStoreReachable(coll, env)` | **File mode**: a missing file means this target cannot serve the collection → `StoreUnreachableError`. **libsql mode**: reachable by definition (an empty table is a normal answer). |
| `guardStore(fn, onError)` | A `StorageError` of any kind → `500 {code:'storage'}` — the answer the product already used for a broken store (audit M3 / QA D3). Every other error is re-thrown. |
| `storageFailureLog(err)` | The log line: `{outcome:'storage_error', code, message}`. Never a secret. |

**The data root is resolved at MODULE LOAD**, exactly like the handlers did
(`path.resolve(process.cwd(), 'site/data')` as a module constant). The QA
suites `chdir` into their sandbox *before* the bundle is required; a
load-time path is what they expect, and a per-request `process.cwd()` would
be a behaviour change.

**No contract change.** `site/shared/portal-store/**` is untouched: the
interface, the file adapter, the libSQL adapter, the transport, the schema
and the contract test are exactly as wave 8A left them.

### 1.2 The twelve files the brief lists

| # | File | Old path | New store call |
|---|---|---|---|
| 1 | `api/portal/auth.ts` | `readJsonlFile(INVITED_FILE)` / `readJsonlFile(CLIENTS_FILE)` / `rewriteJsonl(INVITED_FILE, invites)` / `appendJsonl(CLIENTS_FILE, …)` | `store.list('invites')`, `store.get('clients', {field:'id'})`, `store.update('invites', inviteKey, {clientId})`, `store.append('clients', …)` |
| 2 | `api/portal/comments.ts` | `readJsonl(PROJECTS_FILE)` / `readJsonl(COMMENTS_FILE)` / `appendJsonl(COMMENTS_FILE, comment)` | `store.list('projects')`, `store.list('comments')`, `store.append('comments', comment)` |
| 3 | `api/portal/invites.ts` | `readJsonlForWrite(INVITED_FILE)` / `readJsonlForWrite(CLIENTS_FILE)` / `rewriteJsonl(…)` / `appendJsonl(…)` | `store.list('invites')`, `store.update('invites', inviteKey, patch)`, `store.get('clients', …)` + `store.update('clients', …)`, `store.append('invites', record)` |
| 4 | `api/portal/plan-items.ts` | `readJsonl(PROJECTS_FILE)` / `readJsonl(PLAN_ITEMS_FILE)` / `rewriteJsonl(PLAN_ITEMS_FILE, items)` / `appendJsonl(…)` | `store.list('projects')`, `store.get('planItems', {field:'id'})`, `store.update('planItems', {id}, patch)`, `store.append('planItems', planItem)` |
| 5 | `api/portal/projects.ts` | `readJsonl(PROJECTS_FILE)` / `readJsonl(CLIENTS_FILE)` / `rewriteJsonl(PROJECTS_FILE, projects)` / `appendJsonl(…)` | `store.list('projects')`, `store.get('projects', {field:'id'})`, `store.update('projects', {id}, patch)`, `store.list('clients')`, `store.append('projects', project)` |
| 6 | `api/portal/testimonials.ts` | `readJsonl(PROJECTS_FILE)` / `readJsonl(CLIENTS_FILE)` / `readJsonl(REVIEWS_FILE)` / `rewriteJsonl(PROJECTS_FILE, projects)` / `appendJsonl(REVIEWS_FILE, record)` | `store.get('projects', …)`, `store.get('clients', …)`, `store.latest('reviews', {type,projectId,clientId})`, `store.update('projects', {id}, …)`, `store.append('reviews', record)` |
| 7 | `api/portal/updates.ts` | `readJsonl(PROJECTS_FILE)` / `readJsonl(UPDATES_FILE)` / `appendJsonl(…)` | `store.list('projects')`, `store.list('updates')`, `store.append('updates', update)` |
| 8 | `api/portal/projects/[id].ts` | — | a one-line re-export of `projects.ts`; nothing to convert |
| 9 | `api/portal/plan-items/[id].ts` | — | a one-line re-export of `plan-items.ts`; nothing to convert |
| 10 | `api/moderate/review.ts` | `readReviews()` (fs) / `writeReviews()` (tmp file + rename) / `readJsonlFile(CLIENTS_FILE)` | `assertStoreReachable('reviews')`, `store.latest('reviews', {ref, type:'review'})`, **`store.decideReview(ref, decision, at, decidedBy)`**, `store.get('clients', …)` |
| 11 | `api/lib/rate-limit.ts` | the `file` backend (a lock file under `site/data`) and the `memory` backend | a new `store` backend: `createLibsqlRateLimitBackend(transport)` on the **same** libSQL connection as the store (`ensureSchema` first) |
| 12 | `site/scripts/publish-testimonials.mjs` | `fs.readFileSync('data/moderation/reviews.jsonl')` | `readReviewsFromStore()` — the file store in file mode, the **database** over the libSQL v2 pipeline in libsql mode |

### 1.3 The three write paths that had no store equivalent

The brief says `rewriteJsonl()` has no store equivalent. Each call site was
converted to `update()` / `append()` semantics, and the records are
**byte-identical** to the old behaviour (proved in §3, W2b):

* **`projects.ts` PATCH** — the old code mutated the record in place and
  rewrote the file. The new code builds a patch that holds **only** the
  fields the request changes, and `update()` writes exactly those. A patch
  value of `undefined` **removes** the field, which is what
  `delete project.testimonialStatus` did.
* **`plan-items.ts` PATCH** — the same, plus the client approve /
  request-change tracking (`approvedBy`, `approvedAt`, `requestChangeBy`,
  `requestChangeAt`; `undefined` removes them).
* **`invites.ts` upsert** — the invite record has no id of its own (the
  e-mail address is its identity), so the patch names the record by
  `email` **and** `invitedAt`; together they match exactly one record.

### 1.4 The moderation decision

`api/moderate/review.ts` no longer writes a file. The decision is **one
statement**:

```
UPDATE moderation_reviews SET state = ?, data = json_set(…)
 WHERE seq = (SELECT seq … WHERE ref = ? AND type = 'review' ORDER BY seq DESC LIMIT 1)
   AND state = 'pending'
RETURNING data
```

The `state = 'pending'` guard is what makes "never flip an already-decided
record, not even the other way" a property of the statement. The tmp-file +
rename atomicity of the old code is replaced by the database's atomicity —
and the file adapter keeps its own atomic rewrite, so the file mode is
unchanged.

### 1.5 The durable rate counter

`api/lib/rate-limit.ts` gained a third backend:

* `PORTAL_STORE=libsql` → the shared counter on the same libSQL connection as
  the store (one atomic `INSERT … ON CONFLICT … RETURNING`), keys hashed
  with SHA-256, so no client id and no IP reaches the database.
* `PORTAL_RATE_LIMIT_FILE` still wins if it is set (an operator who names a
  counter file wants that file).
* Otherwise: the in-memory counter, per instance, as before.

**A configuration error is not a transient failure.** A missing
`LIBSQL_URL` / `LIBSQL_TOKEN` is re-thrown instead of degrading to the
in-memory counter, because degrading would silently turn a shared limit into
a per-process one — the exact weakness the durable backend exists to remove.
The handler turns it into `500 {code:'storage'}` (the closest existing code;
a dedicated `internal` code would be nicer).

---

## 2. The greps the brief asked for

```
$ # the portal tree and the moderation endpoint
$ grep -rn "readJsonlFile\|appendJsonl\|rewriteJsonl\|parseJsonlStrict\|site/data\|lib/jsonl" \
      api/portal/*.ts api/moderate/review.ts
```

Every hit is a **comment**; no code reads or writes a JSONL file any more.
(The harness check W1 strips the comments before scanning and reports
`9 files scanned, 0 JSONL readers left`.)

```
$ # every remaining JSONL reader in api/
$ grep -rn "readJsonlFile\|appendJsonl\|rewriteJsonl\|parseJsonlStrict\|site/data" api/
api/admin/reviews.ts:44   import { parseJsonlStrict, guardStorage } from '../lib/jsonl.js';
api/admin/reviews.ts:50   const REVIEWS_FILE = path.resolve(process.cwd(), 'site/data/moderation/reviews.jsonl');
api/admin/reviews.ts:186  const records = parseJsonlStrict(fs.readFileSync(REVIEWS_FILE, 'utf8'), REVIEWS_FILE);
api/lib/jsonl.ts:22      export function readJsonlFile(file: string) …
```

**`api/admin/reviews.ts` is the ONE file that still reads JSONL — and it was
not in the brief's file list.** See §6.1; it is a real gap and it is reported,
not hidden.

---

## 3. Executed evidence

### 3.1 The new harness — `backend-wave9-store-wiring-harness.mjs` (repo root)

**13/13 checks passed.** It runs the REAL handlers (esbuild bundle, fake
`node:http` req/res) against a sandbox, and the libSQL half runs against
the offline mock pipeline server — a **real SQLite engine** (Python's
`sqlite3`) behind the **real libSQL HTTP v2 wire protocol**.

```
[wave9] W1 — the handlers do not touch the portal JSONL any more
  PASS  W1  a source scan proves no handler reads or writes portal JSONL — 9 files scanned, 0 JSONL readers left
[wave9] W2 — FILE MODE: the same files, the same records
  PASS  W2a  the file-mode answers are the pre-wave-9 answers — 15 answers, identical
  PASS  W2b  the file-mode records are the pre-wave-9 records — 10 records across 7 files, identical
[wave9] W3 — LIBSQL MODE: the store, not the files
  PASS  W3a  the same scenario writes to the database and to no file — the database holds the same records; no JSONL file was written
  PASS  W3b  the answers are the same in both backends — 15 answers, identical
[wave9] W4 — the publisher reads the store and fails loudly
  PASS  W4a  the publisher publishes the approved quote from the DATABASE — 1 published file(s), exit 0
  PASS  W4e  the publisher follows the same "newest revision wins" rule — exit 0 and nothing published — the newest revision wins
  PASS  W4b  the publisher exits NON-ZERO when the store is unreachable — exit 1
  PASS  W4c  the publisher exits NON-ZERO when the store is MISCONFIGURED — exit 1
  PASS  W4d  the publisher publishes from the FILE store exactly as before — exit 0, the quote was published from the file store
[wave9] W5 — the rate counter
  PASS  W5a  the SQL counter is durable across two PROCESSES — process A counted 1, process B counted 2 — one shared counter
  PASS  W5b  in FILE mode the counter is per process — each process counts on its own — per instance, as documented
[wave9] W6 — the publisher and the store read the same records
  PASS  W6  the publisher's own database read matches the store's — 2 review records, identical
[wave9] 13/13 checks passed
```

**W2 is a DIFFERENTIAL proof, not a restatement.** The expectation is
`backend-wave9-store-wiring-fixture.json`, captured by running the
**pre-wave-9** code through the same 13-step scenario (create a project,
patch a project, add and approve a plan item, post an update, post a
comment, invite twice and upsert, submit a quote, approve it with the signed
link, three read paths, change their mind). The fixture holds the normalised
records and answers; the harness compares the new code against it. Both the
records (10 across 7 files) and the answers (15) are identical.

**W3 runs the same scenario against the database.** The seed goes in through
the store (the store creates the schema on the first call — the handlers
never touch DDL), and the database ends up holding the same records the files
held, with no JSONL file written at all.

### 3.2 The gates from §6 of the brief — every count

| Gate | Result |
|---|---|
| `npm run typecheck:api` | **exit 0**, 0 errors |
| `npm run check:routes` | **16 route(s), 0 missing function file(s)** — OK in both trees |
| `npm run test:store` | **60 pass / 0 fail** (unchanged — the contract is untouched) |
| `npm run build` | **exit 0 — 23 page(s) built** |
| `npm run check` (astro check) | **0 errors, 0 warnings, 11 hints** (the tree baseline) |
| the 12-suite QA runner | **12/12 exit 0 — 271 checks + 5 mutation probes**, transcript `site/qa/artifacts/qa-full-run-2026-10-22-011952.txt` |
| `backend-wave6-harness.mjs` | **24 passed, 0 failed, 24 checks** |
| `backend-f1-magic-token-harness.mjs` | **22 passed, 0 failed, 22 checks** |
| `backend-wave8-harness.mjs` | **35 passed, 0 failed, 35 checks** |
| `backend-wave8-session-endpoint-harness.mjs` | **57/57 passed, 0 failed** |
| `backend-wave8-moderation-m1-harness.mjs` | **11/11 passed, 0 failed** |
| `backend-wave9-store-wiring-harness.mjs` (new) | **13/13 checks passed** |

Total: **289 checks + 5 mutation probes**, all green.

`site/data/` is byte-identical (`reviews.jsonl` 0 bytes, no `site/data/portal/`).
`api/` still holds **20** `.ts` files — this wave added **no** file under
`api/`, so the Vercel function budget did not move.

### 3.3 The mutation probes that had to be re-pinned

Three probes pointed at code this wave removed. Each was re-pinned to the
**same defect**, in the new shape — the intent of every probe is unchanged:

| Probe | Before | After |
|---|---|---|
| `backend-wave8-moderation-m1-harness.mjs` D1 | the mutated GET used `writeReviews(reviews)` | the mutated GET uses `store.decideReview(...)` — the same atomic statement the POST uses. **11/11, and the probe still reddens.** |
| `site/qa/qa-wave5-independent.mjs` D2 | the mutated `writeReviews()` was unguarded → the handler threw out | the mutated `guardStore()` does not catch → the store failure throws out of the handler. Same defect, same red. **26/26.** |
| `site/qa/qa-mutation-probe.mjs` P2 | the anchor was the publisher's old error text | the anchor is the publisher's new error text (the file name is now a variable). **5/5 probes behave as expected.** |

And one harness fix: `backend-wave6-harness.mjs` W5e copies
`api/lib/rate-limit.ts` into a sandbox and rebuilds it. The rate limiter now
imports the shared modules, so the copy keeps its **relative layout** and the
shared tree is copied next to it — the same rule the session probe in that
file already follows ("the module has to sit next to it or the bundle cannot
be built"). **24/24.**

---

## 4. What the brief asked, answered

| Brief | Answer |
|---|---|
| §3.1 the adapter implements the exact `PortalStore` interface, `getStore(env)` selects it on `PORTAL_STORE=libsql` | The contract is **unchanged**; `getStore` already did the selection. The handlers now go through `getPortalStore(env)` in `site/shared/server/portal-store-access.ts`, which calls `getStore` (file mode) or `createLibsqlStore` with a shared transport (libsql mode). |
| §3.2 the CF twin must keep working — decide and state its behaviour | **The Cloudflare tree is untouched.** `site/functions/api/portal/*` still answers `501 {code:'unimplemented'}` on every read and write, and `site/functions/api/moderate/review.ts` still answers `501` for a missing store. The CF tree does not import the new access module (it is Node-only). The QA parity suite proves the CF codes are unchanged: `qa-cf-parity` **11/11**. |
| §4 the `reviews` revision log: use `decideReview` / `append` / `latest`; drop the file-rename path | Done. `decideReview` in the moderation endpoint, `append` for a new revision, `latest` for newest-wins. **The tmp-file + rename path is gone**; the file adapter's own atomic rewrite keeps file mode identical. |
| §4 `rewriteJsonl` has no store equivalent — convert and **prove** the records are equal | Converted to `update()` / `append()`. Proved by W2b: 10 records across 7 files, **identical** to the pre-wave-9 fixture. |
| §4 a `StorageError` must still answer `500 {code:'storage'}` | `guardStore` maps **every** `StorageError` to `500 {code:'storage'}`. The QA suites that assert the code still pass (`qa-backend-hardening` K1, `qa-testimonials` G3/G8/G9, `qa-wave5` B3/B4, `qa-wave4` E2). |
| §4 how does the SQL path surface malformed JSON? | **It cannot.** A record is stored as one JSON text in a `data` column; a record that is not a JSON object is rejected at write time by `JSON.stringify` and, if it somehow reached the table, `parseRecord` raises `StorageError('storage-corrupt')` → `500 {code:'storage'}`. The strict rule is preserved: a corrupt store is never an empty store. The **file** mode keeps the exact strict parser (`parseJsonlStrict`) through the file adapter. |
| §5 no server-side session store | The session is still a signed stateless token; the `'sessions'` collection is not used by anything. |
| §7.1 the greps | §2 above. |
| §7.2 with `PORTAL_STORE=file` the same files, the same records | W2a + W2b (differential against the pre-wave-9 fixture). |
| §7.3 the publisher exits non-zero when the store is unreachable | W4b (exit 1, unreachable), W4c (exit 1, misconfigured), W4a (exit 0, the right quotes), W4d (exit 0 in file mode, unchanged), W4e (nothing published when the newest revision is not approved). |
| §7.4 the counter is durable across two instances on SQL, per instance in file mode | W5a (**two separate processes**: A counted 1, B counted 2 — one shared counter) and W5b (two processes, each counted 1 — per instance). |
| §7.5 every gate in §6 | §3.2 above. |

---

## 5. What stays UNVERIFIED

* **No real Turso database was ever contacted.** The libSQL half of the
  proof is a **real SQLite engine** (Python's `sqlite3`) behind the **real
  libSQL HTTP v2 wire protocol** — a real SQLite engine over the real wire
  protocol is not the same as Turso's service, and Turso was never called.
* **The Vercel router was never booted.** No function was deployed, no
  request was served by Vercel. Every platform statement is a reading of the
  code.
* **workerd was never booted.** The Cloudflare tree is unchanged and its 501
  answers are proved by executing the code in a Web-standard runtime
  (`qa-cf-parity`), not by Cloudflare's runtime.
* **No live mail.** The harness and the QA suites run without a
  `RESEND_API_KEY`, so the notification path logs `email_skipped` and never
  touches the network.
* **The migration script (`site/scripts/import-portal-store.mjs`) was not
  re-run against a live file store in this wave** — it is untouched and was
  proven in wave 8A's T4 work.
* **The local dev server on port 4321 still runs the pre-wave-9 bundle.** It
  bundles the handlers at startup, so it must be restarted in place before
  the new code is live locally. I did not touch it (the brief forbids using
  4321).

---

## 6. Findings, gaps and flags

### 6.1 `api/admin/reviews.ts` still reads the JSONL — the owner's inbox is NOT wired (out of the brief's file list)

`GET /api/admin/reviews` (the owner's moderation queue) still reads
`site/data/moderation/reviews.jsonl` directly
(`api/admin/reviews.ts:50,186`). It was **not** in the brief's list of twelve
files, so I did not convert it.

**What that means on Vercel with `PORTAL_STORE=libsql`:** the file does not
exist there, so the endpoint answers **`501 {code:'unimplemented'}`** — the
same loud "this target cannot moderate" answer the moderation endpoint gives
(`api/admin/reviews.ts:174-184`). That is loud, not a silent empty queue,
which is why it was left alone rather than rushed.

**But the owner would see no queue at all while the database holds pending
quotes.** That is a functional hole in "the portal persists on Vercel" and it
should be closed. The conversion is the same pattern as the moderation
endpoint (one `store.latest`/`store.list('reviews')` call plus the same
reachability probe) — roughly 20 lines. **I need the Manager to say whether
it belongs in this wave or the next one**; it was outside my brief and
`api/**` is under audit.

### 6.2 The store's schema promise is cached — including a FAILURE (pre-existing, in the contract file)

`site/shared/portal-store/libsql-adapter.ts:323-328`:

```ts
let schemaReady: Promise<void> | null = null;
function ready(): Promise<void> {
  if (!autoSchema) return Promise.resolve();
  if (!schemaReady) schemaReady = ensureSchema(transport);
  return schemaReady;
}
```

If `ensureSchema` **rejects** (the database was unreachable at the first
request), the rejected promise is cached and every later request in that
process fails with the same error until the instance is recycled. On Vercel
that means one instance stays dead for the portal after a brief outage at
start-up.

I did **not** change it: the contract file is not mine to redesign, and the
brief says to say so in the report instead. **The fix is one line** — reset
the promise when it rejects (the rate counter's backend does exactly this in
`api/lib/rate-limit.ts`, `createStoreBackend`). It should go into the next
wave with the contract test.

### 6.3 The publisher has its own libSQL reader (plain JavaScript)

`site/scripts/publish-testimonials.mjs` cannot import the TypeScript store
(it is the `prebuild` step and Node 20 cannot run TypeScript), so it speaks
the v2 pipeline protocol itself — about 60 lines, mirroring
`site/shared/portal-store/libsql-transport.ts`. Two consequences:

* The two readers must stay in step. **W6 proves they agree**: the
  publisher's read and the store's `list('reviews')` return the same records
  for the same database.
* The publisher does **not** create the schema. A database whose tables were
  never created holds no quotes, so "no such table" is treated as an empty
  store (exit 0, nothing published); every other database error is a loud
  exit 1. If the publisher created the schema with its own DDL, the two
  definitions could drift and the store's `CREATE TABLE IF NOT EXISTS` would
  never add a missing column.

### 6.4 `store.update()` patches **every** record that matches the key

The legacy code patched the **first** matching record (`findIndex`); the
store's `update()` patches **all** of them. For every id-keyed collection the
ids are unique by construction (`crypto.randomBytes`), so the two agree. The
one case where they could differ is a hand-edited store with two projects
sharing an id — a data-integrity bug in its own right. The invite collection
has no id at all, so its patch names the record by `email` **and**
`invitedAt`.

### 6.5 The rate limiter's configuration error answers `500 {code:'storage'}`

A missing `LIBSQL_URL` / `LIBSQL_TOKEN` re-throws (no silent degradation),
and `guardStore` turns it into `500 {code:'storage'}`. "storage" is the
closest existing code; a dedicated `internal` would be more precise. Flagging
it, not changing the contract.

### 6.6 Files I touched that are not in the brief's list

| File | Why | Risk |
|---|---|---|
| `backend-wave6-harness.mjs` | the W5e mutation sandbox could no longer build the rate limiter (it imports the shared modules) | the probe still reddens; 24/24 |
| `backend-wave8-moderation-m1-harness.mjs` | the D1 mutation used `writeReviews()`, which no longer exists | the probe still reddens; 11/11 |
| `site/qa/qa-mutation-probe.mjs` | the P2 anchor was the publisher's old error text | the probe still reddens; 5/5 |
| `site/qa/qa-wave5-independent.mjs` | the D2 mutation put an unguarded `writeReviews()` back | the probe still reddens; 26/26 |

`site/qa/**` is QA's territory in the standing brief. I touched **two** files
in it, mechanically (the anchors), because the brief's §6 makes the 12-suite
runner a gate and my change had broken two of its probes. **QA should look at
those two edits** — the intent of every probe is unchanged, but the anchors
are mine to justify.

---

## 7. Files changed

**New**
- `site/shared/server/portal-store-access.ts`
- `backend-wave9-store-wiring-harness.mjs`
- `backend-wave9-store-wiring-fixture.json` (the captured pre-wave-9 behaviour)

**Edited (the brief's twelve)**
- `api/portal/auth.ts`, `api/portal/comments.ts`, `api/portal/invites.ts`,
  `api/portal/plan-items.ts`, `api/portal/projects.ts`,
  `api/portal/testimonials.ts`, `api/portal/updates.ts`
- `api/moderate/review.ts`
- `api/lib/rate-limit.ts`
- `site/scripts/publish-testimonials.mjs`

**Edited (the probes — see §6.6)**
- `backend-wave6-harness.mjs`, `backend-wave8-moderation-m1-harness.mjs`,
  `site/qa/qa-mutation-probe.mjs`, `site/qa/qa-wave5-independent.mjs`

**Not touched**
`site/functions/**` (the CF tree stays a 501 stub), `site/shared/portal-store/**`
(the contract), `spec/**`, `DEPLOY.md`, `site/.env.example`, `vercel.json`,
`site/src/**`, `site/data/**` (byte-identical), the root `package.json`
(**no new dependency** — the transport is the libSQL HTTP v2 API over
`global fetch`, exactly as wave 8A built it).

**No git command that writes was run.** No commit, no add, no checkout, no
reset, no clean, no stash. `site/data/` was never written: every run used a
sandbox under the OS temp folder.

---

## 8. The state of the launch, honestly

* `PORTAL_STORE=libsql` now **persists the portal** on a read-only
  filesystem — proven offline against a real SQLite engine over the real
  wire protocol, never against Turso.
* The **rate limit is now shared** across instances on the SQL backend, and
  still per instance in file mode.
* The **publisher reads the store** and fails the build loudly when the
  store cannot be reached.
* The **admin inbox is still on the file store** (§6.1) — one short wave
  away.
* The **function budget is unchanged** (20 files under `api/`): this wave
  added no file there, and the ≤12 refactor is still the deferred 7b.
* Nothing was deployed. The Vercel router was never booted.
