# T4 — the libSQL/Turso store adapter

**Backend Developer · 2026-10-21 · repo `C:\Users\Kalch\Documents\IXI` (branch main, no git remote)**

## Status: DONE — the adapter exists, is selected by `PORTAL_STORE=libsql`, and passes the
## store contract offline against a real SQLite engine. What is still missing is not code:
## it is a database with two values in it.

The wave-6 blocker was: *a Vercel serverless function has a read-only filesystem, so the
JSONL files under `site/data/` cannot be written by a deployed function.* This wave builds the
other half of that answer — a store that lives in a database instead of on a disk — against the
`PortalStore` interface that already existed (`site/shared/portal-store/types.ts`).

---

## 1. What was built

| File | State | What it is |
|---|---|---|
| `site/shared/portal-store/libsql-transport.ts` | **new** | The transport: the libSQL HTTP v2 *pipeline* API over `global fetch`. |
| `site/shared/portal-store/libsql-schema.ts` | **new** | The DDL (9 tables + indexes) and `ensureSchema()`. |
| `site/shared/portal-store/libsql-adapter.ts` | **new** | The `PortalStore` implementation on top of the transport. |
| `site/shared/portal-store/libsql-store.ts` | **new** | `env → store` selection, shared by both handler trees. |
| `site/shared/portal-store/durable-rate-counter.ts` | **new** | The shared durable rate counter (one atomic statement). |
| `site/shared/portal-store/libsql-entry.ts` | **new** | The entry a Node script bundles (the importer). |
| `site/shared/portal-store/index.ts` | **edited** | `PORTAL_STORE=libsql` now selects the adapter instead of throwing `not-implemented`. |
| `site/shared/portal-store/edge.ts` | **edited** | The Cloudflare twin does the same — and it is the *same* adapter file. |
| `site/shared/portal-store/test/contract.shared.ts` | **new** | The store contract, factored into a body that runs against **any** adapter. |
| `site/shared/portal-store/test/contract.test.ts` | **edited** | Runs that body against the file adapter **and** the libSQL adapter; keeps the file-specific cases. |
| `site/shared/portal-store/test/mock-pipeline-server.ts` | **new** | A libSQL pipeline server for tests: the real wire protocol, a real SQLite engine behind it. |
| `site/shared/portal-store/test/sqlite-worker.py` | **new** | The SQLite engine (the Python standard library's `sqlite3`). |
| `site/scripts/import-portal-store.mjs` | **new** | The migration: file store → database, with a compare pass. |

**No dependency was added.** The root `package.json` and `package-lock.json` are untouched, and
`vercel.json` needs no change — the runtime is `fetch`.

---

## 2. The transport — the libSQL HTTP v2 pipeline API, and why

```
POST {LIBSQL_URL}/v2/pipeline
Authorization: Bearer {LIBSQL_TOKEN}
Content-Type: application/json

{ "baton": null,
  "requests": [ { "type": "execute",
                  "stmt": { "sql": "…", "args": [ { "type": "text", "value": "prj_1" } ] } } ] }
```

The format is taken from the two primary sources, not from memory:
<https://github.com/tursodatabase/libsql/blob/main/docs/HTTP_V2_SPEC.md> and
<https://docs.turso.tech/sdk/http/reference> (the value shape `{"type":"integer","value":"42"}`
— integers travel as strings so a 64-bit value does not lose precision — and the
`{baton, base_url, results[]}` answer).

**Why HTTP and not `@libsql/client`** — the same reason the Architect gave (design §3.1), and it
is still true: the root `package.json` has no dependencies and `vercel.json` installs only
`site/`, so a root-level driver would never be installed on Vercel. The HTTP API is plain HTTP:
it runs on Node **and** on workerd with the same file, needs no build step, adds no dependency,
and it is the first-class Turso interface, not a fallback.

**The trap the transport has to survive** (design §3.1): a failed statement comes back as
`{"type":"error","error":{…}}` **inside `results[]`** while the HTTP status is still **200**. A
client that only looks at the status code reports a successful write for a write that never
happened. `libsql-transport.ts` therefore inspects `results[]`, and the mock server reproduces
the trap exactly so the behaviour is tested, not assumed (test 47).

**The token is never echoed.** No error message, log line or thrown error in the module contains
the token, the `Authorization` header, or a URL with credentials (`redact()`).

---

## 3. The schema — and two deliberate deviations from the design draft

Nine tables: the eight `Collection` names plus the rate counter. Every record is stored **whole**
in a `data` JSON column (so the round trip is exact, key order included), and the typed columns
next to it are *derived* from the same record at write time, so they cannot drift.

`seq INTEGER PRIMARY KEY AUTOINCREMENT` reproduces "the order of the lines in the JSONL file" —
`ORDER BY seq` **is** the file order, which is what the contract asserts.

The design draft (§3.2) writes the typed columns as `NOT NULL … DEFAULT …` with `UNIQUE`
constraints. **I changed both, on purpose:**

1. **Nullable, and no `UNIQUE`.** The file adapter's `append()` never rejects a record: two
   projects with the same id, or a record with no id at all, are both accepted and both readable
   (`file-adapter.ts:154-156`). A `NOT NULL`/`UNIQUE` column would make the libSQL adapter
   *reject* writes the file adapter accepts — the two adapters would stop being interchangeable,
   which is the entire point of the `PortalStore` interface and of the rollback path.
2. **No `DEFAULT` values either.** `decideReview()` treats a record whose state is not exactly
   `'pending'` as already decided (`file-adapter.ts:224`). A `DEFAULT 'pending'` would make the
   database flip records the file adapter leaves alone — a real behavioural difference, not a
   cosmetic one.

So the typed columns hold exactly what the record holds, `NULL` for an absent field.

Indexes: the columns the filters actually use (`id`, `email`, `client_id`, `project_id`, `ref`,
`state`, `token`) — one per collection, plus the composite `(ref, seq DESC)` and
`(state, seq DESC)` for the moderation log.

---

## 4. `Where` → SQL: the part that had to be exact

The file adapter compares with `String(actual) !== String(expected)`
(`file-adapter.ts:52-63`). The SQL has to reproduce that *exactly*, and two cases break the
obvious translation:

* **Booleans.** SQLite's `json_extract` turns `true` into `1`, so `CAST(... AS TEXT)` yields
  `'1'` — but `String(true)` is `'true'`. A plain `CAST` would silently stop matching a boolean
  field.
* **Floats.** `CAST(42.0 AS TEXT)` is `'42.0'`, while `String(42)` is `'42'`.

So the predicate is a `CASE` over `json_type()`:

```sql
CASE json_type(data, ?)
  WHEN 'true'  THEN 'true'
  WHEN 'false' THEN 'false'
  WHEN 'real'  THEN CASE WHEN CAST(json_extract(data, ?) AS INTEGER) = json_extract(data, ?)
                         THEN CAST(CAST(json_extract(data, ?) AS INTEGER) AS TEXT)
                         ELSE CAST(json_extract(data, ?) AS TEXT) END
  ELSE CAST(json_extract(data, ?) AS TEXT)
END = ?
```

* a missing field → `json_type` is `NULL` → `NULL` → excluded, like `actual === undefined`;
* a field that is `null` → excluded, like `actual === null`;
* the JSON path is always **bound as a parameter**, never inlined: a field name is data, and data
  must never become SQL.

A field that has an index is compared through its typed column — but **only when the compared
value is a string**, so the indexed path can never disagree with the JSON path.

These three cases are asserted for *both* adapters (tests 19-21 and 41-43). That is the proof
that the SQL is faithful, not a claim that it is.

---

## 5. Atomicity

One statement per logical operation, so the database's own statement atomicity is the guarantee:

| Operation | Statement |
|---|---|
| `append` | `INSERT INTO … VALUES (…)` |
| `update` | `UPDATE … SET data = json_set(…), <typed columns> = ? WHERE <pred>` |
| `remove` | `DELETE FROM … WHERE <pred>` |
| `latest` | `SELECT data … ORDER BY seq DESC LIMIT 1` |
| `decideReview` | `UPDATE … WHERE seq = (SELECT seq … WHERE ref = ? AND type = 'review' ORDER BY seq DESC LIMIT 1) AND state = 'pending' RETURNING data` |

A moderation decision is **one** statement: the newest revision of that ref, only while it is
still pending. The `state = 'pending'` guard is what makes "never flip an already-decided
record, not even the other way" a property of the *statement*, not of the code around it. When
the statement updates 0 rows, a read-only `SELECT` tells "unknown ref" (`null`) from "already
decided" (the record, unchanged) — that is the idempotency the contract asserts.

A patch keeps the **type** of the value it writes: `json(?)` parses the JSON text back, so a
number stays a number and a boolean stays a boolean (test 44). A patch value of `undefined`
*removes* the key, exactly like `Object.assign` + `JSON.stringify` does.

One caveat, for an auditor: the typed columns are the source of truth for the `state = 'pending'`
guard, so a row inserted **by hand** into the database (bypassing the adapter) would have NULL
typed columns and would not be decided. Every write goes through the adapter, and the importer
writes through it too, so this is a "do not poke the table" rule rather than a live defect.

`update()` and `remove()` on `reviews` are refused with `invalid-operation`, identically to the
file adapter (`file-adapter.ts:159-166`, `:180-186`).

---

## 6. The shared durable rate counter

The file backend (`api/lib/rate-limit.ts:203-252`) keeps the counter in a JSON file under a lock
file. On Vercel that fails twice: the filesystem is read-only, and every instance keeps its own
copy — so the limit is per instance, not per site.

The counter now has a SQL backend on the same connection, **one statement**:

```sql
INSERT INTO rate_counters (bucket, reset_at, count) VALUES (?, ?, 1)
ON CONFLICT(bucket) DO UPDATE SET
  count    = CASE WHEN rate_counters.reset_at <= ? THEN 1 ELSE rate_counters.count + 1 END,
  reset_at = CASE WHEN rate_counters.reset_at <= ? THEN ? + ? ELSE rate_counters.reset_at END
RETURNING count
```

The `CASE` reproduces the file backend's rolling window exactly (`rate-limit.ts:236-240`); one
row per bucket means the table cannot grow without bound; and the statement is atomic in the
database, so two writers on two instances cannot lose each other's hits — there is no lock to
leak. The key is **SHA-256 hashed** before it reaches the database (WebCrypto, so no client id
and no IP address is ever stored), exactly like the file backend does.

**Proved, not asserted:** test 48 fires eight concurrent writers at one bucket through the real
HTTP transport. The returned counts are 1…8 in some order and sum to **36**; a lost update would
make the sum smaller. The next hit sees 9.

The limiter itself needs **no change** — the interface is one method
(`hit(key, windowMs) → Promise<number>`), and `RateLimiter` already falls back to the in-memory
counter and reports `degraded: true` when a backend throws.

---

## 7. The migration

`site/scripts/import-portal-store.mjs` reads every collection of a file store, in file order,
and writes one row per line — so `seq` reproduces the file order. It writes a manifest
(`{collection, file, lines, sha256}`) and, with `--verify`, reads **both** sides back and
compares them record for record, in order. The source directory is only ever read.

```bash
LIBSQL_URL=https://db.turso.io LIBSQL_TOKEN=… \
  node site/scripts/import-portal-store.mjs --from site/data --verify
```

---

## 8. Fail closed

| Situation | Answer |
|---|---|
| `PORTAL_STORE=libsql` without `LIBSQL_URL` | `StorageError('invalid-config')` |
| … without `LIBSQL_TOKEN` | `StorageError('invalid-config')` |
| … with a `turso://` URL | `StorageError('invalid-config')` (the endpoint is HTTP) |
| the database is unreachable | `StorageError('storage-unavailable')` |
| a statement fails | `StorageError('storage-unavailable')` — never a false success |
| a row is not a JSON object | `StorageError('storage-corrupt')` |

There is **no** silent fallback to the file adapter, and no token-less request to the database.
On the edge (`PORTAL_STORE=file`) is still refused: there is no writable disk there.

---

## 9. Executed evidence

Every command below was run in this session, on the current tree.

### 9.1 The store contract — the same assertions against both adapters

```
> npm run test:store
ok 1  - file: an empty collection is an empty list, not an error
...
ok 22 - file: a patch keeps the type of the value it writes
ok 23 - libsql: an empty collection is an empty list, not an error
...
ok 44 - libsql: a patch keeps the type of the value it writes
ok 45 - libsql: the contract is proven against a REAL SQLite engine over the REAL wire protocol
ok 46 - libsql: a wrong bearer token is refused by the database
ok 47 - libsql: a failing statement is an error, not a silent success
ok 48 - libsql: concurrent writers on one bucket never lose a hit
ok 49 - libsql: the durable rate counter counts across stores and never loses a hit
ok 50 - a missing file is an empty collection, not an error
...
ok 60 - the edge entry point fails closed without LIBSQL_URL and LIBSQL_TOKEN
# tests 60
# pass 60
# fail 0
# skipped 0
# duration_ms 500.9018
```

**60 tests, 60 pass, 0 fail.** The original file-adapter contract had 22 cases; all 22 still
exist (the file-specific ones stayed in `contract.test.ts`), and the **same** 22 now also run
against the libSQL adapter. The five cases marked *fidelity* (numbers, booleans, missing fields,
patch types, a record with no state) are new — they are the ones the SQL had to be written for.

### 9.2 How the libSQL adapter is proven offline

The libSQL half of the contract runs against a **real SQLite engine** (libSQL is a SQLite fork,
so the dialect is the same), reached through the **real wire protocol**:

* `test/mock-pipeline-server.ts` — a `node:http` server that speaks `POST /v2/pipeline`, checks
  the bearer token, and answers the exact `{baton, base_url, results[]}` shape, **including the
  `{type:'error'}` shape with HTTP 200**. It binds **port 0** (the OS picks a free port);
  port 4321 is never used, and the server refuses to run there even if the OS hands it out.
* `test/sqlite-worker.py` — the SQLite engine (the Python standard library's `sqlite3`), speaking
  the libSQL value format over stdin/stdout.

So the adapter is exercised through real `fetch`, real JSON, real headers, real SQL — with **no
cloud database and no npm dependency**. The Python worker is a *test fixture*: it is only used by
the contract test. If no python interpreter is found the test fails loudly rather than skipping
silently.

### 9.3 The other gates

| Gate | Result |
|---|---|
| `npm run typecheck:api` | **0 errors** (the new modules are inside `shared/**`, which the gate covers) |
| `npm run build` (in `site/`) | **exit 0 — 23 pages** |
| `npm run check:routes` | **OK: every called path has a function file in both trees** |
| `site/qa/run-all-suites.ps1` | **12/12 suites exit 0** (transcript kept out of the repo — see below) |
| edge bundle: `esbuild shared/portal-store/edge.ts --bundle --platform=browser` | **builds, 0 `node:` references** → the CF twin can load the same adapter |

The QA runner writes `site/qa/artifacts/qa-full-run-<date>.txt`, which would have overwritten
QA's own transcript. The whole `site/qa/artifacts/` directory was snapshotted before the run
(37 files) and restored afterwards: **0 files differ**, and `qa-full-run-2026-10-21.txt` is back
at SHA256 `4632B3316A02DCBB5763356E0D270A588C98121FF41F6DCA0B8453ECA0A660F3`. My run's
transcript was kept outside the repo.

### 9.4 The migration, end to end, offline

A real file store (2 projects, 2 clients, 2 review revisions) → the database → the compare pass:

```
read 8 collections from …\file-store
  projects         2 lines  portal/projects.jsonl
  clients          2 lines  portal/clients.jsonl
  …
  reviews          2 lines  moderation/reviews.jsonl
wrote 6 records into the database
manifest: …\manifest.json
verify: every collection matches, record for record, in the same order
importer exit code: 0
```

### 9.5 The tree

`site/data/` is untouched (`site/data/moderation/reviews.jsonl` is 0 bytes, no `site/data/portal/`
was created). `git status` shows 12 entries, all mine: 3 edited, 9 new. No file outside
`site/shared/portal-store/**` and the one new script was modified — `api/**`, `site/functions/**`,
`site/src/**`, `site/qa/**`, `DEPLOY.md`, `vercel.json`, `.gitignore` and both `package.json`
files are as they were.

---

## 10. What is NOT done, and what stays unverified

**Not done in this wave (by design, and it is the next wave's job):**

1. **The handlers do not use the store yet.** `api/portal/*.ts` still read and write the JSONL
   files directly (`readJsonlFile` / `appendJsonl`). The `PortalStore` interface exists and is
   now implemented by two adapters, but rewiring eight handler files to it is a separate change
   — and it must not happen while the Code Reviewer is auditing `api/**`. Until that happens,
   `PORTAL_STORE=libsql` changes what `getStore()` returns, not what the live handlers do.
2. **The rate limiter is not wired to the SQL backend yet.** It is one line in
   `api/lib/rate-limit.ts` (a `createPortalRateLimiter()` branch that uses
   `createLibsqlRateLimitBackend` when `PORTAL_STORE=libsql`), in a file this wave does not own.
   The backend itself is written and tested.
3. **The build-time publisher still reads the moderation file.**
   `site/scripts/publish-testimonials.mjs` runs as `prebuild`; after the cutover it must read the
   database, and it must **fail loudly** if the database is unreachable — a build that silently
   publishes an empty testimonials page is an outage wearing the costume of a successful deploy
   (design §3.7). Not touched here (it is in `site/scripts/`, and it belongs with the handler
   rewiring).

**Unverified — stated, not assumed:**

* **No real Turso database was ever contacted.** No SQL ran against a Turso server, so the
  adapter's behaviour against the *real* sqld (as opposed to SQLite) is unproven. The wire format
  comes from Turso's own documentation and the HTTP v2 spec, and the mock reproduces it exactly,
  but that is documentation-grade evidence, not a live one.
* **The Vercel router was never booted** and **workerd was never booted.** The edge bundle was
  proven to be free of `node:` imports (an esbuild browser-platform build), not to run on
  workerd.
* **No deployed function was exercised.** Nothing here proves that a Vercel function can reach
  Turso from its region, or that the latency is acceptable.
* **The `ensureSchema()` step runs on the first use of a store instance.** On a cold start that
  is one extra pipeline round trip (nine `CREATE TABLE IF NOT EXISTS` statements in one request).
  It was not measured against a real database.
* The float normalisation in the predicate reproduces `String()` for every value JavaScript can
  produce except numbers ≥ 1e21 (which JavaScript prints in exponential form). No record in this
  repo holds such a number.

---

## 11. What this unblocks, and what the next wave needs

**Owner-free, next wave:**

1. Rewire the eight `api/portal/*` handlers to the `PortalStore` interface (one adapter, both
   backends), and the Cloudflare twins with them.
2. Wire the durable rate counter into `api/lib/rate-limit.ts` (one line).
3. Make `publish-testimonials.mjs` read the store and fail loudly when it cannot.
4. **`site/.env.example` needs one line changed by DevOps** — it already lists `LIBSQL_URL`,
   `LIBSQL_TOKEN` and `PORTAL_STORE=file` as placeholders ✓, but its comment now reads *"The
   libSQL adapter is NOT implemented yet (task T4) — it throws"*, which is stale: the adapter
   exists and `PORTAL_STORE=libsql` selects it. That file is not this wave's, so it was not
   edited here.

**Needs the owner (values only — the code no longer waits for them):**

* `LIBSQL_URL` and `LIBSQL_TOKEN` for a Turso database, and `PORTAL_STORE=libsql` in production.
  The Turso-vs-Neon call does **not** block the code: the adapter speaks the libSQL HTTP
  protocol, and `PortalStore` keeps a Postgres adapter possible later.

**No new runtime dependency was added, and `vercel.json` does not need to change.**

---

## 12. Files changed

```
 M site/shared/portal-store/edge.ts
 M site/shared/portal-store/index.ts
 M site/shared/portal-store/test/contract.test.ts
?? site/scripts/import-portal-store.mjs
?? site/shared/portal-store/durable-rate-counter.ts
?? site/shared/portal-store/libsql-adapter.ts
?? site/shared/portal-store/libsql-entry.ts
?? site/shared/portal-store/libsql-schema.ts
?? site/shared/portal-store/libsql-store.ts
?? site/shared/portal-store/libsql-transport.ts
?? site/shared/portal-store/test/contract.shared.ts
?? site/shared/portal-store/test/mock-pipeline-server.ts
?? site/shared/portal-store/test/sqlite-worker.py
```
