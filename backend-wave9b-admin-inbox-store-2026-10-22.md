# Backend — wave 9B: the owner's inbox reads the store, and the schema promise is no longer cached

**Date:** 2026-10-22
**Owner:** Backend Developer
**Assignment:** wave 9B (Manager) — two owner-free closes that the wave-9 report flagged and asked the Manager to place.
**Status:** DONE — both items closed, every gate green, with executed evidence and two mutation probes.

---

## 1. What was wrong, and what it looked like in production

### 1.1 The owner's inbox was on the file store while the decision moved to the database

`api/admin/reviews.ts:44` (before) read the moderation log itself:

```ts
import { parseJsonlStrict, guardStorage } from '../lib/jsonl.js';
…
const REVIEWS_FILE = path.resolve(process.cwd(), 'site/data/moderation/reviews.jsonl');
…
if (!fs.existsSync(REVIEWS_FILE)) { … 501 {code:'unimplemented'} … }
const records = parseJsonlStrict(fs.readFileSync(REVIEWS_FILE, 'utf8'), REVIEWS_FILE);
```

Wave 9 moved every OTHER moderation path onto the PortalStore
(`api/moderate/review.ts`, `api/portal/*.ts`, `api/lib/rate-limit.ts`,
`site/scripts/publish-testimonials.mjs`). The inbox was not in the wave-9 file
list, so it was left behind.

The consequence with `PORTAL_STORE=libsql` (the launch target):

| | moderation endpoint (`/api/moderate/review`) | the owner's inbox (`/api/admin/reviews`) |
|---|---|---|
| where the quote lives | the **database** | the **JSONL file** |
| what the owner sees | the quote is approved | **an empty queue** |

Two writers, two stores, two truths — and the visible symptom was the worst
one: the owner opens `/admin`, sees "nothing to moderate", while the pending
quotes sit in the database. The endpoint did not fail loudly; it answered
**200 with an empty queue**. That is exactly the silent outage the strict
JSONL parser was introduced to kill (audit M3 / QA D3), re-introduced through
the storage layer.

### 1.2 A rejected schema promise killed the instance for life

`site/shared/portal-store/libsql-adapter.ts` (before):

```ts
let schemaReady: Promise<void> | null = null;
function ready(): Promise<void> {
  if (!autoSchema) return Promise.resolve();
  if (!schemaReady) schemaReady = ensureSchema(transport);
  return schemaReady;
}
```

The promise is cached — **including its rejection**. A database that was
briefly unreachable at the very first request (a cold start during a database
restart, a failover, a network blip) left that serverless instance dead for
its whole life: every later call rejected with the very same error, and the
instance only recovered when it recycled. A function instance that lives for
minutes must be able to recover on its own.

---

## 2. What changed (3 files)

| File | Change |
|---|---|
| `api/admin/reviews.ts` | The queue is read through the **PortalStore** (`getPortalStore().list('reviews')`). The `jsonl` import, the `node:fs`/`node:path` imports, the hardcoded `site/data/...` path and the file read are **gone**. |
| `site/shared/portal-store/libsql-adapter.ts` | A **rejected** schema promise is evicted from the cache, so the next call retries the schema step. |
| `site/shared/portal-store/file-adapter.ts` | One line: a UTF-8 **BOM** is stripped before parsing, so this adapter agrees with the shared parser (`portal-store/jsonl.ts`) and with the publisher. Without it the inbox conversion would have turned a hand-edited BOM file from "200, queue shown" into "500 storage" — a regression I would have introduced. |

Nothing else was touched: no `site/src/**`, no `site/qa/**`, no `spec/**`, no
`DEPLOY.md`, no `site/.env.example`, no `vercel.json`, no `site/functions/**`.
No git command that writes; no deploy; no network to Vercel or Cloudflare.

### 2.1 The new inbox, in detail

```ts
import {
  getPortalStore, guardStore, storageFailureLog,
  assertStoreReachable, StoreUnreachableError,
} from '../../site/shared/server/portal-store-access.js';
…
try { assertStoreReachable('reviews'); }
catch (err) { if (err instanceof StoreUnreachableError) { … 501 {code:'unimplemented'} … } throw err; }

const store = getPortalStore();
let records: Array<Record<string, any>>;
try { records = await store.list('reviews'); }
catch (err) {
  // The store is there but it cannot be READ: the file cannot be opened
  // (file mode) or the database cannot be reached (libSQL mode).
  if (err instanceof StorageError && err.code === 'storage-unavailable') { … 501 … }
  throw err;
}
```

The failure taxonomy, unchanged from the moderation endpoint and from the QA
pins (qa-wave5 B2/B3, qa-cf-parity C5):

| situation | answer |
|---|---|
| the store is **not there** (file mode) | `501 {code:'unimplemented'}` — "this target cannot serve the queue" |
| the store is there but **cannot be reached** (a database that is down) | `501 {code:'unimplemented'}` |
| the store is there but its **records cannot be parsed** | `500 {code:'storage'}` — a corrupt log is never "nothing to moderate" |
| the gate fails (client, no cookie, revoked address) | `401 {code:'unauthorized'}` |
| `ADMIN_EMAILS` unset / `FORM_WEBHOOK_SECRET` missing | `500 {code:'internal'}` |

The **response shape is byte-identical** to what `site/src/pages/admin.astro`
consumes and what QA's suite #12 pins:
`{ok:true, counts:{pendingReviews, decidedToday, openNotes:null}, notesAvailable:false, reviews:[…], recent:[…]}`.

### 2.2 The schema promise, in detail

```ts
const attempt = ensureSchema(transport);
schemaReady = attempt;
// A REJECTED schema promise must NOT stay cached (wave 9B).
attempt.catch(() => {
  if (schemaReady === attempt) schemaReady = null;
});
```

The eviction runs in a microtask after the rejection, which is always **before
the next request**: the catch handler is registered at creation time, so it is
queued before any awaiting continuation. A **successful** schema step is still
cached (the DDL runs once per instance, as before). The PortalStore
interface, the DDL and the adapter's behaviour against a healthy database are
untouched.

---

## 3. Executed evidence

### 3.1 The new harness — `backend-wave9b-admin-inbox-store-harness.mjs` (14/14 on the first pass; 16/16 after the differential checks of §7)

```
$ node backend-wave9b-admin-inbox-store-harness.mjs
[wave9b] sandbox: C:\Users\Kalch\AppData\Local\Temp\opencode\wave9b-admin-inbox\2026-10-21T22-38-49-932Z

[wave9b] B1 — the inbox reads the store, not the JSONL file
  PASS  B1  a source scan proves the inbox has no JSONL reader left — no JSONL helper, no site/data path, no direct fs import

[wave9b] B2 — FILE MODE: the inbox and the decision share one store
  PASS  B2a  a quote written THROUGH THE STORE shows up in the inbox — pending=1, ref=inq_wave9b_1
  PASS  B2b  the response shape is the one admin.astro consumes — ok, counts{pendingReviews,decidedToday,openNotes}, notesAvailable, reviews, recent
  PASS  B2c  a decision through /api/moderate/review shows up in the inbox — the decision made by the moderation endpoint is in the inbox
  PASS  B2d  the store itself holds the decision (one store, one truth) — the store and the inbox agree: the quote is approved

[wave9b] B3 — a store that cannot serve the queue is never an empty queue
  PASS  B3a  a store that is NOT THERE answers 501 {code:unimplemented} — never a 200 with an empty list
  PASS  B3b  a store that cannot be PARSED answers 500 {code:storage} — a corrupt log is never "nothing to moderate"

[wave9b] B4 — the gate is unchanged
  PASS  B4a  a client session is 401, no cookie is 401 — client 401, no cookie 401
  PASS  B4b  an unset ADMIN_EMAILS is 500, a missing secret is 500 — unset allow-list 500, missing FORM_WEBHOOK_SECRET 500
  PASS  B4c  a wrong method is 405 and a wrong path is 404 — POST 405, wrong path 404

[wave9b] B5 — LIBSQL MODE: the queue comes from the DATABASE
  PASS  B5a  the queue and the decision live in the database, not in a file — the database holds the quote and the decision; no JSONL file was written

[wave9b] B6 — the rejected schema promise is not cached
  PASS  B6a  a store whose schema step failed ONCE recovers on the next call — the first failure was not cached: the second call retried the schema

[wave9b] B7 — the mutation probes
  PASS  B7a  MUTATION: with the inbox reading the FILE again, the libSQL queue is empty — the mutated copy shows 0 pending — the empty-queue defect is back
  PASS  B7b  MUTATION: with the rejected schema promise cached, the store never recovers — the mutated copy stays dead: StorageError: libsql: the database is unreachable

[wave9b] 14/14 checks passed
```

What each block proves, in the Manager's words:

* **"the inbox and the moderation endpoint provably share one store"** — B2a/B2c/B2d:
  a quote is written **through the store** (not through a file write) and
  appears in the inbox (200, `pendingReviews: 1`); a decision made through
  `/api/moderate/review` appears in the inbox's `recent` list
  (`state: 'approved'`); and the store itself holds that decision. One store,
  one truth.
* **"with the store unreachable the inbox answers 501 {code:'unimplemented'},
  never a silent empty queue"** — B3a: the store file is removed and the
  answer is 501 `{code:'unimplemented'}`, with **no** `pendingReviews` field
  anywhere in the body. B3b: a corrupt log is 500 `{code:'storage'}`.
* **"the rejected schema promise is no longer cached"** — B6a: a store whose
  schema step fails once recovers on the very next call (`schemaCalls: 2`).

The libSQL half of the harness (B5a) runs against the **real wire protocol**:
a real SQLite engine (the Python standard library's `sqlite3`) behind the mock
libSQL v2 pipeline server — `http://127.0.0.1:<free port>/v2/pipeline`, never
4321. The assertions include that the database was really asked
(`moderation_reviews` appears in the recorded statements, and an `UPDATE`
among them) and that **no JSONL file was written** in libSQL mode.

### 3.2 The mutation probes (both redden)

Both probes work on a **copy** of the tree; the repository is never modified.

| Probe | The defect put back in the copy | Result |
|---|---|---|
| B7a | the inbox reads the **file** again instead of the store (`records = await store.list('reviews')` → the file adapter) | the libSQL queue comes back **0 pending** — the empty-queue defect is back, so the check is not vacuous |
| B7b | the rejected schema promise stays cached (`if (schemaReady === attempt) schemaReady = null;` → a no-op) | the store **never recovers**: the second call rejects with `StorageError: libsql: the database is unreachable` |

### 3.3 The gates

```
$ npm run typecheck:api
> tsc -p tsconfig.api.json --noEmit
exit=0

$ npm run check:routes
[check-api-routes] 16 route(s), 0 missing function file(s)
[check-api-routes] OK: every called path has a function file in both trees.

$ npm run test:store
# tests 60
# pass 60
# fail 0
```

```
$ node backend-wave9-store-wiring-harness.mjs     # the wave-9 harness must stay green
[wave9] 13/13 checks passed

$ node backend-wave8-harness.mjs                   [wave8] 35 passed, 0 failed, 35 checks
$ node backend-wave8-session-endpoint-harness.mjs  [wave8-session] 57/57 passed, 0 failed
$ node backend-wave8-moderation-m1-harness.mjs      [wave8-m1] 11/11 passed, 0 failed
$ node backend-wave6-harness.mjs                   [wave6] 24 passed, 0 failed, 24 checks
$ node backend-f1-magic-token-harness.mjs          [f1] 22 passed, 0 failed, 22 checks

$ npm run build        → 23 page(s) built, exit 0
$ npm run check        → 0 errors, 0 warnings, 11 hints (the tree baseline — unchanged)
```

### 3.4 The QA runner — 12/12 suites, exit 0

```
$ powershell -ExecutionPolicy Bypass -File site/qa/run-all-suites.ps1
qa-testimonials.mjs           exit 0     (102 checks)
qa-testimonials-build.mjs     exit 0     (14 build checks)
qa-backend-hardening.mjs      exit 0     (21 checks)
qa-wave2-independent.mjs      exit 0     (29 checks)
qa-mutation-probe.mjs         exit 0     (5/5 mutation probes)
qa-rate-limit.mjs             exit 0     (8 checks)
qa-cf-parity.mjs              exit 0     (11 checks)
qa-wave3-independent.mjs      exit 0     (21 checks)
check:routes (npm run)        exit 0     (16 routes)
qa-wave4-independent.mjs      exit 0     (23 checks)
qa-wave5-independent.mjs      exit 0     (26 checks)
qa-admin-independent.mjs      exit 0     (16 checks)
finished: 2026-10-22 01:40:13 +03:00
```

Transcript: **`site/qa/artifacts/qa-full-run-2026-10-22-013935.txt`**

The two checks that pin the inbox most tightly both passed unchanged:

* **E9** — `GET /api/admin/reviews`: a non-owner is 401, the owner sees the
  queue — `pending=1, openNotes=null` (the response shape is the pinned one).
* **E10** — the approve link the inbox mints is HMAC-valid and
  `/api/moderate/review` accepts it: *"the GET approved nothing, the POST made
  the quote approved"*.
* **E14** — the Cloudflare twin answers like the Vercel tree: edge runtime
  `501 {code:'unimplemented'}`; with a filesystem **the same queue as the
  Vercel tree**.
* **E15** — QA's own mutation probe still reddens (the allow-list rule is
  still in `site/shared/server/portal-session.ts`).

### 3.5 `site/data` untouched

```
$ git status --short -- site/data      → (nothing)
$ (Get-Item site/data/moderation/reviews.jsonl).Length   → 0
$ Test-Path site/data/portal                             → False
```

Every harness ran in a sandbox under `%TEMP%`; the repository's
`site/data/**` is byte-identical to HEAD.

---

## 4. The one deliberate difference I introduced, and one I did not

**Deliberate:** a store that is *there but cannot be read* (a database that is
down, a file that cannot be opened) now answers `501 {code:'unimplemented'}`
from the inbox. The moderation endpoint answers `500 {code:'storage'}` for the
same situation. I chose 501 because the project's own vocabulary already uses
it for exactly this case (`qa-cf-parity` C5: *"an unreachable store must answer
501 … the unreachable-store code"*). The two answers are both loud and neither
is an empty queue, but they are not identical — **flagged for the next wave**,
where the moderation endpoint's taxonomy can be aligned in one line.

**Not changed:** the Cloudflare twin (`site/functions/api/admin/reviews.ts`)
still reads the JSONL file directly, and so does the Cloudflare moderation
twin (`site/functions/api/moderate/review.ts`). That tree was explicitly out
of scope ("the CF tree stays a 501 stub by decision"), and it is internally
consistent — both CF twins read the same file. It does **not** follow
`PORTAL_STORE=libsql`, which only matters if Cloudflare ever becomes a
deployment target. The Vercel tree is the one that has to persist on the
launch target, and it now does.

---

## 5. What stays UNVERIFIED — stated plainly

1. **No real Turso database was ever contacted.** The libSQL half of the
   harness runs against a real SQLite engine (Python's `sqlite3`) behind the
   mock v2 pipeline server — the real wire protocol, but not Turso's service.
2. **The Vercel router was never booted and workerd was never booted.** Every
   Cloudflare statement is a reading of the code, and the QA suites execute the
   CF tree in a Node simulation.
3. **No deployed runtime and no live mail.** No preview deploy, no Resend.
4. **The local dev server on 4321 still runs the pre-wave-9B bundle.** It
   bundles the handlers at startup, so it needs an in-place restart
   (`npm run dev:portal`) before the new code is live locally. The route is
   already wired (`site/scripts/dev-portal.js:104` → `adminReviews`,
   `site/scripts/api-index.ts:37`), so a restart is all it takes.
5. **`api/lib/jsonl.ts` is now dead code** — the inbox was its last importer.
   I did **not** delete it: the file count under `api/` is the function budget,
   and that refactor is deferred by the Manager's instruction. Removing it
   would take the count from 20 to 19 files and one dead function fewer, but
   it belongs to the ≤12-function wave, not to this one.
6. **The BOM strip in the file adapter** is a behaviour change for one input
   (a hand-edited file with a UTF-8 BOM): it now parses instead of reporting
   corruption — in the inbox **and** in the moderation endpoint, which already
   used the adapter. `npm run test:store` stays 60/60.

---

## 6. Files changed / created

| Path | Change |
|---|---|
| `api/admin/reviews.ts` | the inbox reads through the PortalStore (M) |
| `site/shared/portal-store/libsql-adapter.ts` | a rejected schema promise is evicted (M) |
| `site/shared/portal-store/file-adapter.ts` | BOM strip, one line (M) |
| `backend-wave9b-admin-inbox-store-harness.mjs` | **new** — 16 checks + 2 mutation probes |
| `backend-wave9b-admin-inbox-store-2026-10-22.md` | **new** — this report |

Not touched: `site/src/**`, `site/qa/**`, `site/functions/**`, `spec/**`,
`DEPLOY.md`, `site/.env.example`, `vercel.json`, `site/data/**`. No git
command that writes. No deploy. No network to Vercel or Cloudflare.

---

# 7. RE-VERIFICATION PASS — 2026-10-22 01:44 (the Manager re-queued wave 9B)

The brief was re-issued as "wave 9B — two items, both owner-free", on the
premise that the work was undone by the run that died on a provider fault. **I
read the tree before writing anything**, and the premise did not hold:

| The brief says | The tree says |
|---|---|
| `api/admin/reviews.ts:44` imports `parseJsonlStrict, guardStorage` from `'../lib/jsonl.js'` | it does not — the file imports `getPortalStore`/`guardStore`/`assertStoreReachable` from `site/shared/server/portal-store-access.js` (lines 49-55) and reads `store.list('reviews')` (line 206). No `node:fs`, no `node:path`, no `site/data` path |
| the schema promise caches its rejection | it does not — `libsql-adapter.ts:329-344` evicts a rejected promise (`if (schemaReady === attempt) schemaReady = null;`) |

Both were already implemented and already uncommitted in the dirty tree from
the standing thread's 01:38 pass. **So this pass was verification, not
implementation** — with one real gap I found and closed.

## 7.1 The one gap the brief found that the evidence did NOT cover

The brief asks for *"a differential check for the admin inbox: file mode and
libsql mode must agree on the same fixture"*. The harness asserted the two
modes **separately** (B2 = file, B5 = libSQL) and never **compared** them —
two independent green checks are not a differential proof. I added the
comparison as two new checks (**14 → 16**):

* **B8a** — FILE MODE and LIBSQL MODE answer the inbox **identically** on the
  same fixture. The projection drops the two fields that *cannot* be equal
  between two runs (the signed action links carry a timestamp and an HMAC),
  and compares everything else: `ok`, `notesAvailable`,
  `counts.openNotes` (still `null` — the dash, never a fake zero),
  `counts.pendingReviews`, every review field, and the `recent` list.
* **B8b** — the **decided** queue is identical in both modes too (`pending: 0`,
  `recent: [{state:'approved'}]`). `decidedToday` is compared with a tolerance
  for a UTC midnight rollover between the two runs, and a mismatch on the
  same day is a failure.

## 7.2 Fresh executed output (this pass, on the current tree)

```
$ npm run typecheck:api
> tsc -p tsconfig.api.json --noEmit
typecheck exit=0

$ npm run check:routes
[check-api-routes] 16 route(s), 0 missing function file(s)
[check-api-routes] OK: every called path has a function file in both trees.
routes exit=0

$ npm run test:store
1..60
# tests 60
# pass 60
# fail 0
store exit=0

$ node backend-wave9b-admin-inbox-store-harness.mjs
[wave9b] B8 — the DIFFERENTIAL check: the two backends agree on one fixture
  PASS  B8a  FILE MODE and LIBSQL MODE answer the inbox identically — identical projection: pending=1, openNotes=null
  PASS  B8b  the decided queue is identical in both modes too — both modes: pending=0, recent=[approved]
[wave9b] 16/16 checks passed
wave9b exit=0

$ node backend-wave9-store-wiring-harness.mjs
[wave9] 13/13 checks passed
wave9 exit=0
```

The QA runner — **new transcript, the one to cite**:

```
$ powershell -NoProfile -ExecutionPolicy Bypass -File site/qa/run-all-suites.ps1
qa-testimonials.mjs           exit 0
qa-testimonials-build.mjs     exit 0
qa-backend-hardening.mjs      exit 0
qa-wave2-independent.mjs      exit 0
qa-mutation-probe.mjs         exit 0
qa-rate-limit.mjs             exit 0
qa-cf-parity.mjs              exit 0
qa-wave3-independent.mjs      exit 0
check:routes (npm run)        exit 0
qa-wave4-independent.mjs      exit 0
qa-wave5-independent.mjs      exit 0
qa-admin-independent.mjs      exit 0
finished: 2026-10-22 01:44:12 +03:00
transcript: C:\Users\Kalch\Documents\IXI\site\qa\artifacts\qa-full-run-2026-10-22-014335.txt
qa-runner exit=0
```

**Transcript:** `site/qa/artifacts/qa-full-run-2026-10-22-014335.txt` —
12/12 suites exit 0, 253 `PASS` lines, **0** `FAIL` lines, 6 mutation-probe
lines. (The runner filters the transcript down to the lines carrying
`[qa]`/`PASS`/`FAIL`, so that number is the filtered line count, not the
suites' internal check count.)

`site/data` — untouched, byte for byte:

```
reviews.jsonl bytes = 0
reviews.jsonl sha256 = E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855
site/data/portal exists = False
```

(The SHA-256 above is the hash of the empty string, i.e. the file is empty.)

## 7.3 What changed in THIS pass

Only one file: `backend-wave9b-admin-inbox-store-harness.mjs` (the two B8
checks + the header line). **No application file was edited in this pass** —
`api/admin/reviews.ts`, `libsql-adapter.ts` and `file-adapter.ts` carry the
implementation from the earlier pass and are unchanged since. No git command
that writes. `site/data` untouched.

## 7.4 Two things the team should know

1. **`pwsh` is NOT installed on this machine** — only Windows PowerShell 5.1
   (`C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe`). The brief
   says `pwsh -File site/qa/run-all-suites.ps1`; that command fails with
   *"The term 'pwsh' is not recognized"*. The working invocation is
   `powershell -NoProfile -ExecutionPolicy Bypass -File site/qa/run-all-suites.ps1`,
   and the script itself runs identically under 5.1 (it uses `$PSScriptRoot`,
   `Push-Location` and `*>`, all present in 5.1).
2. **QA was editing `site/qa/**` while my run executed** (their new
   `qa-anchor-nonvacuity.mjs` and `site/qa/fixtures/` are in the working tree
   as untracked files, and five `qa-*-results.json` artifacts changed during
   my run). The 12/12 result is therefore a run against the tree **as it was
   at 01:43:35**, not a pinned commit. QA should re-run the runner after
   their own edits land if they want a transcript that matches their final
   tree.

## 7.5 Still UNVERIFIED (unchanged from §5, plus the two above)

1. **No real Turso database was ever contacted.** The libSQL half runs against
   a real SQLite engine (Python's `sqlite3`) behind the mock v2 pipeline
   server — the real wire protocol, not Turso's service.
2. **The Vercel router was never booted and workerd was never booted.** Every
   Cloudflare statement is a reading of the code.
3. **No deployed runtime, no live mail, no preview deploy.**
4. **The dev server on 4321 still runs the pre-wave-9B bundle** — it bundles
   the handlers at startup, so it needs an in-place restart (`npm run dev:portal`)
   before the new code is live locally. I did **not** restart it: port 4321 is
   explicitly out of bounds for me, and a server is already running there.
5. **The Cloudflare twin is still a 501 stub by decision** — the CF tree
   (`site/functions/api/admin/reviews.ts`) still reads the JSONL file directly.
6. **`api/lib/jsonl.ts` is now dead code** (the inbox was its last importer);
   not deleted, because the file count under `api/` is the Vercel function
   budget and that refactor is deferred.
