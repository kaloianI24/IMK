# QA — wave-9 store wiring, independent coverage (2026-10-22)

**Author:** @QA Engineer — Testing and Verification
**Tree:** `C:\Users\Kalch\Documents\IXI`, branch `main`, no git remote, shared dirty tree
**Scope:** `site/qa/**` only. No application file was touched.
**Verdict:** **PASS** — 298 executable checks + 18 probe outcomes, 0 unexpected failures.
**Final transcript:** `site/qa/artifacts/qa-full-run-2026-10-22-020906.txt` (15/15 suites, exit 0)

---

## 1. What I was asked, and what I found when I read the tree

The brief asked for a new suite `site/qa/qa-wave9-store-independent.mjs`, wired as suite #13,
covering four areas the Backend's own harness does not, plus a re-pin check on two mutation
anchors the Backend moved.

Three things differed from the brief's premise. All three are recorded here rather than
papered over:

| The brief said | The tree says |
|---|---|
| "wire it as suite #13" | Suite #13 was already taken by `qa-wave9-store-queue.mjs` (my own wave-9 queue check, added earlier today). **The new suite is wired as suite #14.** The anchor prover is #15. Both run. |
| "`api/admin/reviews.ts` is still on the file store — do not depend on it" | Wave 9B landed while I was working: `api/admin/reviews.ts:49-55` now imports `getPortalStore` / `guardStore` / `assertStoreReachable` and has no `node:fs` import. It is on the store. I cover it (A9) but the suite does not **depend** on it — every other check stands without it. |
| "the Backend's harness reports 13/13" | Confirmed by the Backend's own report and by the runner: `backend-wave9-store-wiring-harness.mjs` is not in the QA runner, but `backend-wave9b-admin-inbox-store-harness.mjs` (16/16) and the other Backend harnesses are green. My suite does not reuse any of their code. |

I also found and fixed **one bug of my own** during the build: the recursion guard in the probe
runner skipped *every* check in the nested run instead of only the probe group, so all four
mutation probes reported `MISSING` instead of running. Fixed, and the failure is visible in my
own history (the first `--only M` run was 1 PASS / 4 FAIL with "expected PASS, got MISSING").

---

## 2. The new suite — `site/qa/qa-wave9-store-independent.mjs`

**25 checks + 1 housekeeping check, 6 seconds, no port bound by the suite.**

The convention the brief asked for is followed exactly:

* every handler is bundled **separately** (one esbuild bundle per file, as Vercel builds one
  function per file) and loaded in **its own child process**;
* the child speaks **JSON lines over stdin/stdout**, prefixed with the marker `@@QA@@` so the
  handlers' own `console.log` output can never be read as an answer;
* **no port is bound** by the suite or by any child.

One port *is* used, and it is not the suite's: the offline mock database
(`site/shared/portal-store/test/mock-pipeline-server.ts` — the project's own test double) binds
an **OS-assigned ephemeral** port on 127.0.0.1 and refuses 4321 explicitly. It speaks the real
libSQL HTTP v2 pipeline protocol to a real SQLite engine (Python's stdlib `sqlite3`). Port 4321
(the running dev server) is never touched.

### Area A — no JSONL fallback (9 checks)

The proof is **differential at runtime**, not a source scan. For every handler:

* the **database** holds a record marked `QA-DB-MARKER`;
* the **JSONL file** in the sandbox holds a *different* record marked `QA-FILE-MARKER`;
* the handler answers, and the answer must carry the **database** marker and must **not** carry
  the file marker;
* all **7 seeded JSONL files must be byte-identical** afterwards (SHA-256 compared) — the file
  adapter was not used for reading *or* writing.

| Check | Handler (own process) | Request | Proof |
|---|---|---|---|
| A1 | `api/portal/projects.ts` | `GET /api/portal/projects` | answer carries the DB marker; no file marker; 7 files untouched |
| A2 | `api/portal/plan-items.ts` | `GET /api/portal/plan-items?projectId=prj_qa_db` | same, client-scoped |
| A3 | `api/portal/updates.ts` | `GET /api/portal/updates?projectId=prj_qa_db` | same, client-scoped |
| A4 | `api/portal/comments.ts` | `GET /api/portal/comments?projectId=prj_qa_db` | same, client-scoped |
| A5 | `api/portal/testimonials.ts` | `GET /api/portal/testimonials?projectId=prj_qa_db` | same, client-scoped |
| A6 | `api/portal/auth.ts` | `POST /api/portal/auth/request-link` | the invite is found in the **DB** (a mail is sent). The FILE invite belongs to a *different* address, so a file fallback would have sent **no** mail — and the response is generic by design (no enumeration), so the captured mail is the observable. |
| A7 | `api/portal/invites.ts` | `POST /api/portal/invites` | the new invite is in the **database**; `invited.jsonl` byte-identical |
| A8 | `api/moderate/review.ts` | `POST /api/moderate/review` (QA's own HMAC over `ref\|decision\|revision\|ts`) | the decision landed in the **database** (`state: 'approved'`); `reviews.jsonl` byte-identical |
| A9 | `api/admin/reviews.ts` | `GET /api/admin/reviews` | the owner's inbox answers from the **database** (wave 9B) |

### Area B — the publisher (4 checks)

The Backend's harness proves the **exit code**. These prove the **consequence**, which is the
part that matters: a failed publish must never replace the published testimonials with an
empty page.

| Check | What it proves | Result |
|---|---|---|
| B1 | the publisher publishes the quote from the **DATABASE** — the JSONL file holds a *different* approved quote, and the published file carries the DB one | 1 file, the database quote, exit 0 |
| B2 | the store is unreachable → the publisher **exits 1**, the failure is explained on stderr, **and the already published quote survives** (the folder is not wiped) | exit 1, the published quote intact |
| B3 | the store is **misconfigured** (no `LIBSQL_URL`) → exit 1 and nothing published | exit 1, 0 files |
| B4 | **CONTROL** for B1: in file mode the publisher publishes the *file* quote — so the B1 differential is meaningful and not a coincidence | 1 file, the file quote, exit 0 |

### Area C — the rate counter (3 checks)

| Check | What it proves | Result |
|---|---|---|
| C1 | two **separate processes** on the SQL backend share one counter | process A counted 1, process B counted 2, `degraded: false` |
| C2 | in file mode the counter is **per process** (as documented) | 1 and 1 |
| C3 | the counter row lives in the **database** — `SELECT bucket FROM rate_counters` returns a row, and no counter file is written anywhere | 1 row in `rate_counters`, 0 files |

### Area D — loud store errors (5 checks)

| Check | Situation | Required answer | Result |
|---|---|---|---|
| D1 | portal route, database unreachable | `500 {code:'storage'}`, no empty list | 500 storage, no `"projects": []` |
| D2 | portal route, **corrupt** JSONL store | `500 {code:'storage'}`, no empty list | 500 storage, no `"projects": []` |
| D3 | moderation endpoint, **no store file** | `501 {code:'unimplemented'}`, nothing approved | 501 unimplemented, no `approved` in the body |
| D4 | owner's inbox, **no store file** | `501 {code:'unimplemented'}`, no empty queue | 501 unimplemented, no `pendingReviews` in the body |
| D5 | owner's inbox, database unreachable | `501 {code:'unimplemented'}`, no empty queue | 501 unimplemented, no `pendingReviews` in the body |

**Observation, not a defect:** D1 answers **500** and D5 answers **501** for the same
situation (a database that is down). That is the Backend's deliberate choice, and both are
loud — neither is an empty list or an empty queue. I have recorded it rather than "fixing" it,
because the asymmetry is documented in `backend-wave9b-admin-inbox-store-2026-10-22.md` and it
belongs to the Backend, not to QA.

### Area M — the mutation probes (4 checks)

Each probe injects the defect into a **copy** of the tree, runs the suite against the copy, and
asserts two things: the **control** (an unmodified copy) still passes, and the **mutant** goes
**RED**. The shipped tree is byte-compared (SHA-256 over `api/`, `site/shared/`,
`site/scripts/`, `site/functions/`) before and after the whole run — the housekeeping check
`tree-untouched` asserts it.

| Probe | Defect put back (in a copy) | Check | Control | Mutant |
|---|---|---|---|---|
| MP-A | `api/portal/projects.ts` falls back to the **file** store (`getPortalStore({...process.env, PORTAL_STORE:'file'})`) | A1-projects | PASS | **FAIL** |
| MP-B | the publisher treats an unreachable database as an **empty store** (the store error is swallowed in `main()`) | B2-publisher-unreachable | PASS | **FAIL** |
| MP-C | the libsql mode uses the **per-process in-memory** counter instead of the shared SQL one | C1-counter-shared | PASS | **FAIL** |
| MP-D | `guardStore()` swallows the store failure instead of answering `500 {code:'storage'}` | D1-portal-db-down | PASS | **FAIL** |

The patches are applied to a scratch copy under the OS temp directory; the repository is never
modified. The probe harness re-runs **this** suite as a child process against the copy
(`QA_W9I_API_DIR` / `QA_W9I_SHARED_DIR` / `QA_W9I_PUBLISH_SCRIPT`), with a recursion guard so a
nested run never probes itself.

---

## 3. The re-pin check (brief item 3)

The two anchors the Backend re-pinned in wave 9 are **confirmed non-vacuous**, by three proofs
each, not by "it still runs":

| Anchor | Intent | CONTROL | MUTANT (the defect is put back in a copy) | LIVENESS (the anchor drifts) |
|---|---|---|---|---|
| **P2** — `site/qa/qa-mutation-probe.mjs` → the publisher's malformed-line error text | the publisher must **refuse** to publish a malformed store, not skip the line | N1/N2/N3 = PASS | N1/N2/N3 = **FAIL** (the suite exits 1) | the probe **aborts loudly**: *"the patch anchor was not found … the publisher"* — a reworded publisher cannot be rubber-stamped |
| **D2** — `site/qa/qa-wave5-independent.mjs` → `guardStore()` in `site/shared/server/portal-store-access.ts` | a store failure must not escape the handler | B1/B1b/B2/B3/B4 = PASS | **B4 = FAIL** (the handler throws out of the store failure again) while the control **B1 stays GREEN** | the D2 check **FAILs loudly**: *"the patch anchor was not found … export async function guardStore<"* when the function is renamed |

Both anchors still test the **intent**, not a proxy: P2 still puts the *skip-the-broken-line*
defect back into the publisher's read path, and D2 still puts the *unguarded store failure*
back into the guard — the re-pin moved the anchor, it did not weaken the defect.

This proof is now **part of the runner** (suite #15, `qa-anchor-nonvacuity.mjs`, 9/9 proofs,
6 seconds), so a future anchor drift is caught by the next full run instead of by a human
remembering to look.

The same prober also re-proves the wave-9 queue check (W9-1): control PASS, mutant (the inbox
reads a different collection) → 9 of its 11 sub-assertions go RED.

---

## 4. The runner output (executed)

```
powershell -NoProfile -ExecutionPolicy Bypass -File site\qa\run-all-suites.ps1
```
(secret values for the run: local test values, 32+ characters, `PORTAL_MAGIC_LINK_SECRET`,
`PORTAL_SESSION_SECRET`, `FORM_WEBHOOK_SECRET`)

```
SUMMARY
qa-testimonials.mjs             exit 0     (102 checks)
qa-testimonials-build.mjs       exit 0     (14 build checks, 2 real astro builds)
qa-backend-hardening.mjs        exit 0     (21 checks)
qa-wave2-independent.mjs        exit 0     (29 checks)
qa-mutation-probe.mjs           exit 0     (5/5 mutation probes)
qa-rate-limit.mjs               exit 0     (8 checks)
qa-cf-parity.mjs                exit 0     (11 checks)
qa-wave3-independent.mjs        exit 0     (21 checks)
check:routes (npm run)          exit 0     (16 routes, 0 missing, both trees)
qa-wave4-independent.mjs        exit 0     (23 checks)
qa-wave5-independent.mjs        exit 0     (26 checks + 3 mutation probes)
qa-admin-independent.mjs        exit 0     (16 checks + 1 mutation probe)
qa-wave9-store-queue.mjs        exit 0     (1 check, 11 sub-assertions)
qa-wave9-store-independent.mjs  exit 0     (25 checks + 4 mutation probes)
qa-anchor-nonvacuity.mjs        exit 0     (9/9 anchor proofs)
finished: 2026-10-22 02:09:53 +03:00
transcript: site/qa/artifacts/qa-full-run-2026-10-22-020906.txt
```

* **302 PASS lines, 0 suite-level FAIL lines.** Every `FAIL` string inside the transcript is an
  *expected* red inside a mutation probe (`N1=FAIL`, `A1-projects=FAIL`, `W9-1=FAIL`, …).
* **Totals: 298 executable checks + 18 probe outcomes** (5 legacy probes + 4 new probes +
  9 anchor proofs), all as expected.
* `astro check` → **0 errors, 0 warnings, 11 hints** — the tree baseline, unchanged.
  I proved my new file is *inside* the check's scope (an unused variable injected into it
  produces a 12th hint) and that it contributes **0** hints.
* `site/data/` untouched: `site/data/moderation/reviews.jsonl` is **0 bytes**
  (SHA-256 `E3B0C442…B855`, the empty-string hash), and there is **no** `site/data/portal/`.
* The shipped tree is byte-identical after the run (`tree-untouched`).

---

## 5. What I could NOT verify (stated plainly)

1. **No real Turso database was ever contacted.** The libSQL half runs against the project's own
   offline mock: a **real SQLite engine** behind the **real libSQL HTTP v2 pipeline protocol**.
   That proves the wire format and the SQL semantics; it is **not** Turso's service, and no
   statement in this report is evidence about Turso itself.
2. **The Vercel router and workerd were never booted.** Nothing here is evidence about a
   deployed runtime. The Cloudflare tree (`site/functions/**`) is **not covered** by this suite —
   it is still a 501 stub by decision, and the CF parity question is `qa-cf-parity.mjs`'s.
3. **No live mail.** Every child's `fetch` is stubbed: only the mock database and one closed
   port are reachable, `api.resend.com` is captured, everything else throws.
4. **The `sessions` collection is not covered** — no handler in the tree reads it.
5. **The publisher's own plain-JS libSQL reader is a second implementation.** B1/B4 prove the
   two readers agree on the published-quote case; a full record-shape parity is the Backend's
   W6, not re-proved here.
6. **The brief's item (a) says "showing the JSONL stays empty".** I made the JSONL hold a
   *different, identifiable* record instead of an empty file — strictly stronger, because an
   empty file would make a file fallback look like an empty answer instead of a wrong one.
7. **The suite pins the current tree, not a commit.** The tree is shared and dirty; other bots
   changed `api/admin/reviews.ts` and `site/shared/portal-store/*` while I worked. The transcript
   is against the tree as it was at **2026-10-22 02:09:53**.

---

## 6. Files I changed (all inside `site/qa/**`)

| File | Change |
|---|---|
| `site/qa/qa-wave9-store-independent.mjs` | **new** — 25 checks + 4 mutation probes + the tree-untouched proof |
| `site/qa/run-all-suites.ps1` | suites **#14** (the new suite) and **#15** (the anchor prover) added to the run, the summary and the exit condition; the header comment now says `powershell` instead of `pwsh` (PowerShell 7 is **not installed** on this PC) |
| `site/qa/artifacts/qa-full-run-2026-10-22-020649.txt`, `…-020906.txt` | two full-run transcripts (one per RUN; a run never overwrites an earlier one) |
| `site/qa/artifacts/qa-wave9-store-independent-results.json`, `qa-anchor-nonvacuity-results.json`, `qa-anchor-nonvacuity-2026-10-22.json` | machine-readable results |

**No application file, no `spec/**`, no `DEPLOY.md`, no `site/data/` record, no git command
that writes.** `git status` shows my changes only under `site/qa/**`; the modifications to
`api/admin/reviews.ts` and `site/shared/portal-store/*` are the Backend's wave-9B work.

---

## 7. Report file

`C:\Users\Kalch\Documents\IXI\qa-wave9-store-independent-2026-10-22.md` (this file).
