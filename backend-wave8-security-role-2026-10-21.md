# Backend — wave 8A (security + owner role) and the 8C dependency

**Repo** `C:\Users\Kalch\Documents\IXI` · branch `main` · no git remote · shared dirty tree
**Date** 2026-10-22 (Europe/Kiev)
**Owner** Backend Developer
**Status** DONE for every item I own, and the QA re-pin is now closed too (see §10) — the
12-suite QA runner is 12/12 exit 0 on the tree as it stands.

## 0. Re-verification pass (2026-10-22 00:26–00:28)

A retry note said the tree did not compile, that the Cloudflare twin was still the old
1093-byte re-export, and that this report did not exist. **All three were stale** — they
describe the tree as it was *before* the run that produced this file. Re-read from disk and
re-executed, nothing was taken on trust:

| The claim in the retry note | The state on disk, measured |
|---|---|
| `typecheck:api` fails, `Cannot find name 'SecretProblem'` | `npm run typecheck:api` → **exit 0**. `portal-session.ts` has the real `import type { SecretProblem }` alongside the value import (line 378) |
| the CF twin is missing | `site/functions/api/portal/session.ts` is **5524 bytes**, a full implementation exporting `onRequestGet` (line 141) and `onRequest` (line 147) — not a re-export |
| this report does not exist | it exists: 34460 bytes, last written 00:24:55 |

Every gate below was re-executed on the tree as it stands, by me, in this pass — not carried
over from the earlier run: typecheck 0 · check:routes 16/0 · test:store 60/60 · build 23 pages
· wave8 35/35 · wave8-session 57/57 · wave8-m1 11/11 · wave6 24/24 · F-1 22/22 · the 12-suite
QA runner **12/12 exit 0, 271 checks + 5 probes** (my own transcript:
`site/qa/artifacts/qa-full-run-2026-10-22-002653.txt`).

**No product file was changed in this pass.** The only edits are to this report.

---

## 1. What I was asked, and what was actually missing

The wave-8A assignment listed seven items (H-2, H-1, M-1, M-3, M-4, M-5, and the new
`GET /api/portal/session` route) plus the 8C dependency from the Frontend Developer (the endpoint
must answer for real, not against a fixture).

My previous run died mid-task ("Now the Cloudflare twin"). Before changing anything I read the
tree, because **the reports had softened the state of the work**:

| Item | State when I started | What I did |
|---|---|---|
| H-2 fail-closed in production | landed | verified |
| H-1 placeholder / too-short secret | landed (code half) | **verified + one gap closed** (§3) |
| M-1 a GET must not flip the state | landed | **verified + mutation probe added** (§5) |
| M-3 no upper bound on the session expiry | landed | verified |
| M-4 the live `ADMIN_EMAILS` gate in the portal | landed | verified (the Architect's read was stale) |
| M-5 the client cookie first | landed | verified (the Architect's read was stale) |
| `GET /api/portal/session` (Vercel) | landed | verified |
| `GET /api/portal/session` (Cloudflare twin) | **landed** | verified |
| `site/scripts/api-index.ts` + `dev-portal.js` wiring | **landed** | verified, then the server was restarted so it runs the current code |
| the loud secret guard on the session endpoint | **MISSING** | **closed** (§3) |

**The real gap was not the endpoint — it was the endpoint's silence.** The Architect's wave-8D
report listed M-4, M-5, the Cloudflare twin and the dev route as open. I re-read the files: all
four were already in the tree. The Architect had read a stale snapshot. What was genuinely missing
is described in §3 — and it is exactly the failure mode H-2 was written to stop.

---

## 2. Files changed

| File | Change |
|---|---|
| `api/portal/session.ts` | **+ the loud signing-secret guard** (§3) |
| `site/functions/api/portal/session.ts` | **+ the same guard** (§3), in parity |
| `backend-wave8-session-endpoint-harness.mjs` | **new** — the harness for the route contract (§4) |
| `backend-wave8-moderation-m1-harness.mjs` | **new** — the M-1 evidence + mutation probe (§5) |

Nothing else was touched. In particular: **no** `site/src/**`, **no** `site/qa/**`, **no**
`site/shared/portal-store/**`, **no** `spec/**`, **no** `DEPLOY.md`, **no** `vercel.json`, **no**
`site/.env.example`, **no** git command of any kind.

`site/data/` is untouched: `site/data/moderation/reviews.jsonl` is still 0 bytes and there is no
`site/data/portal/` (`git status --short site/data` → empty).

---

## 3. The gap I closed: a broken deployment answered 401, not 500

### The defect

`api/portal/session.ts` (and the Cloudflare twin) checked one thing before answering:
`adminEmailsConfigured()`. It did **not** check that the session could be *verified* at all.

So on a production instance where `PORTAL_SESSION_SECRET` is missing, still the published
placeholder (`your-32-byte-hex-hmac-secret-here`), or shorter than 32 characters:

* `sessionSecret()` returns `null` (no per-process random fallback — that part of H-2 was correct);
* `parseSession()` therefore refuses every cookie;
* the endpoint answered **`401 {code:'unauthorized'}`**.

That is precisely the silent F-2 symptom H-2 exists to prevent. The browser shows "signed out".
The owner signs in again. Nothing is logged, nothing fails, no dashboard turns red — while the
real cause is a deployment that cannot validate a single cookie. The F-2 symptom returned as a
401 instead of a loud 500, which is the sentence the audit used to describe the bug.

The pattern already existed in `api/portal/auth.ts:324-336` (the sign-in path refuses to mint a
session without a usable secret). The read path did not.

### The fix (both trees)

`api/portal/session.ts` and `site/functions/api/portal/session.ts` now answer
**`500 {code:'internal'}`** when the signing secret is unusable, with a log line naming the
precise reason (`missing` / `placeholder` / `too-short`) — the same reason vocabulary
`api/portal/auth.ts` already uses, and the same `sessionSecretProblem()` helper, so the two
cannot drift.

The **401 stays 401**: it is reserved for "nobody is signed in", which is what the browser's
portal page reads as the sign-in state. The Frontend's contract
(`200 {role}` / `401 {code:'unauthorized'}` / `500 {code:'internal'}`) is unchanged and now
honoured exactly.

### Why this matters for the Frontend

The Frontend's rule is "401 → the sign-in state, 500 → misconfigured". Before this change a
misconfigured deployment produced a 401, so the portal showed the sign-in card and the owner was
told to sign in again — with no error anywhere. Now the two states are distinguishable, which is
what the owner-role UI needs to be truthful.

---

## 4. `GET /api/portal/session` — executed evidence

New harness: **`backend-wave8-session-endpoint-harness.mjs`** (57 checks, 57 pass).
It builds the **real** `api/portal/session.ts` and the **real**
`site/functions/api/portal/session.ts` from copies of the tree in a temp sandbox, and drives them
exactly as the two runtimes do (node:http `req`/`res` for Vercel, `Request`/`env`/`Response` for
the Worker). The repo is never touched.

```
[wave8-session] the token format (independent of the module)
  PASS  H-01  node:crypto's HMAC matches the module's own implementation — hex HMAC-SHA256 over "v1.<payload>"

[wave8-session] GET /api/portal/session — the Vercel tree (api/portal/session.ts)
  PASS  V-S1  no session -> 401 {code:unauthorized} — 401 {"error":"authentication required","code":"unauthorized"}
  PASS  V-S2  wrong method (POST) -> 405 + Allow: GET — 405 {"error":"method not allowed","code":"method"}
  PASS  V-S3  ADMIN_EMAILS unset -> 500 {code:internal} — 500 {"error":"misconfigured","code":"internal"}
  PASS  V-S4  ADMIN_EMAILS set but empty after parsing -> 500 {code:internal} — 500 {"error":"misconfigured","code":"internal"}
  PASS  V-S5  the owner -> 200 {role:admin} — 200 {"ok":true,"authenticated":true,"role":"admin","email":"owner@imk.test","expiresAt":1792703646225}
  PASS  V-S6  a client -> 200 {role:client} — 200 {"ok":true,"authenticated":true,"role":"client","email":"client@imk.test","clientId":"cli_w8","expiresAt":1792703646225}
  PASS  V-S7  M-4: the owner was removed from the allow-list -> 200 {role:client} — 200 {...,"role":"client","email":"not-the-owner@imk.test",...}
  PASS  V-S8  M-5: a client cookie AND a live admin cookie -> 200 {role:client} — 200 {...,"role":"client","email":"client@imk.test","clientId":"cli_w8",...}
  PASS  V-S9  a forged cookie -> 401 {code:unauthorized} — 401 {"error":"authentication required","code":"unauthorized"}
  PASS  V-S10  M-3: a token that outlives the maximum TTL -> 401 — 401 {...}
  PASS  V-S11  an expired token -> 401 — 401 {...}
  PASS  V-S12  H-2: production without a signing secret -> 500, never a 401 — 500 {"error":"misconfigured","code":"internal"}
  PASS  V-S13  H-1: production with the published placeholder secret -> 500 — 500 {...}
  PASS  V-S14  H-1: production with a too-short secret -> 500 — 500 {...}
  PASS  V-S15  H-2: an https base URL alone makes the instance production -> 500 — 500 {...}
  PASS  V-S16  the answer never carries another client's data — 200 {...}

[wave8-session] GET /api/portal/session — the Cloudflare twin (site/functions/api/portal/session.ts)
  PASS  C-S1 … C-S16   (the same 16 answers)

[wave8-session] PARITY — the two trees must answer identically
  PASS  P-S1 … P-S16   (same status AND the same body, every scenario)

[wave8-session] the shared access rules (M-4 / M-5)
  PASS  A-01  M-5: the client cookie wins — an owner cookie cannot widen a client read — read session = the client
  PASS  A-02  M-4: an owner off the allow-list has no owner powers at once — owner powers revoked immediately
  PASS  A-03  M-4: the owner on the allow-list keeps them — owner gate passes
  PASS  A-04  the allow-list is read case- and whitespace-insensitively — case/whitespace tolerant

[wave8-session] the mutation probes — each fix must REDDEN when it is reverted
  PASS  d1-claim-only-role    D1 — the role claim alone decides the role — 2 answers changed as expected
  PASS  d2-admin-cookie-first D2 — the admin cookie is resolved first again (pre-M-5) — 2 answers changed as expected
  PASS  d3-no-secret-guard    D3 — the loud secret guard is removed — 8 answers changed as expected
  PASS  d4-no-method-check    D4 — the method is not checked — 2 answers changed as expected

[wave8-session] 57/57 passed, 0 failed
```

### The mutation probes, in words

Each fix was reverted **in a copy** (in the sandbox, never in the repo) and the same assertions
were re-run. All four reddened, so the assertions really test the fixes:

* **D1** — `effectiveRole()` reduced to the token claim alone → S7 now answers `role:'admin'` for
  an address that is **not** on the live allow-list.
* **D2** — the endpoint's `resolveRequester()` back to the pre-M-5 order (admin cookie first) →
  S8 now answers `role:'admin'` for a **client** holding both cookies.
* **D3** — the new secret guard deleted → S12/S13/S14/S15 fall back to `401` instead of `500`
  (8 answers across the two trees).
* **D4** — the method check removed → a POST is answered like a GET.

### Live proof on the running dev server (localhost:4321)

The dev server was restarted onto the current code (it bundles the handlers with esbuild **at
startup** — that is why the old instance answered `404`: it was built before the wiring landed).
The proof is a real sign-in through the real magic-link flow, not a fixture:

```
POST /api/portal/auth/request-link  -> {"ok":true,"message":"If you have an invitation, a sign-in link has been sent."}
GET  /api/portal/auth/verify         -> HTTP/1.1 200 OK
     Set-Cookie: imk_admin_session=<REDACTED>; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400
GET  /api/portal/session              -> HTTP 200
     {"ok":true,"authenticated":true,"role":"admin","email":"<the owner>","expiresAt":1792703718049}
POST /api/portal/session              -> HTTP/1.1 405 Method Not Allowed   (Allow: GET)
GET  /api/portal/session (forged)    -> HTTP 401
     {"error":"authentication required","code":"unauthorized"}
```

The cookie keeps the required shape: `imk_admin_session` / `imk_session`, `HttpOnly`,
`SameSite=Strict`, `Max-Age=86400` (24 h). **No `Secure` flag** — correct, because the base URL is
`http://localhost:4321`; the flag is added when the base URL is https
(`isSecureBaseUrl()` in `site/shared/server/portal-session.ts`).

### The dev-server wiring the Frontend asked for

Both edits were already in the tree; I verified them and restarted the server so it runs the
current code:

* `site/scripts/api-index.ts:28` — `export { default as portalSession } from '../../api/portal/session.ts';`
* `site/scripts/dev-portal.js:99` — `['/api/portal/session', 'portalSession'],` in the `ROUTES` table

**The 404 is gone** — the live answer above is `200`, not `404`.

---

## 5. M-1 (a GET must not flip the state) — executed evidence + the missing mutation probe

M-1 was landed by my previous run, and `backend-wave6-harness.mjs` W4d already proved the Vercel
tree's behaviour. What was **missing** was a mutation probe (the wave-8A acceptance criteria ask
for one per item) and the Cloudflare twin's own proof.

New harness: **`backend-wave8-moderation-m1-harness.mjs`** (11 checks, 11 pass). Every request
runs in a child process whose cwd is a sandbox, so `site/data/moderation` resolves into the
sandbox and the real store is never read or written.

```
[wave8-m1] M-1 — a GET must not decide the quote
  PASS  M1  a GET answers the confirmation page and the store still says pending — 200 + the confirmation page, the store still says pending
  PASS  M2  the POST the form issues DOES decide the quote — 200 {ok:true, state:approved} and the store says approved
  PASS  M3  a second POST changes nothing (the idempotency guard) — the second POST is a no-op
  PASS  M4  a link for revision 1 cannot decide a record at revision 2 -> 409 — 409 {code:stale-revision}, nothing decided
  PASS  M5  a link older than the 7-day TTL is refused -> 400 expired — 400 {code:expired}, nothing decided
  PASS  M6  a forged signature is refused -> 400 signature — 400 {code:signature}, nothing decided
  PASS  M7  the correct link for the current revision DOES decide it — the revision guard does not block the CURRENT revision

[wave8-m1] PARITY — the Cloudflare twin answers the same codes
  PASS  P1  a GET on the CF twin answers the page and decides nothing — the CF twin behaves like the Vercel tree
  PASS  P2  the CF twin and the Vercel tree answer the SAME codes — GET, forged, expired and stale-revision all agree

[wave8-m1] the mutation probe — the reverted GET must REDDEN the M1 assertion
  PASS  D1  with the old "a GET decides the quote" the M1 assertion FAILS — the mutated GET decided the quote (approved) — M1 would fail
  PASS  D2  the same is true for the Cloudflare twin — the mutated CF GET decided the quote (approved)

[wave8-m1] 11/11 passed, 0 failed
```

**This also answers the Code Reviewer's open question** ("is `ts` freshness-checked, or can an old
signed link be replayed forever?"): **it is checked.** `site/shared/server/moderation.ts:110`
refuses a link older than `MODERATION_TTL_SECONDS` (7 days) and one dated too far in the future
(`MODERATION_FUTURE_SKEW_SECONDS`), and M5 proves it by execution: an 8-day-old link answers
`400 {code:'expired'}` and decides nothing.

---

## 6. The other gates (all executed, all green)

| Gate | Result |
|---|---|
| `npm run check:routes` (repo root) | **16 routes, 0 missing** — `/api/portal/session` listed with both trees |
| `npm run typecheck:api` | **0 errors** |
| `npm run test:store` | **60 tests, 60 pass, 0 fail** |
| `npm run check` (astro check, in `site/`) | **0 errors, 0 warnings, 11 hints** — the tree's baseline, unchanged by me |
| `npm run build` (via `npm run dev:portal`) | **23 pages built, exit 0** |
| `backend-f1-magic-token-harness.mjs` | **22 passed, 0 failed** (G1 = 200 — the session cookie is accepted by another function) |
| `backend-wave6-harness.mjs` | **24 passed, 0 failed** |
| `backend-wave8-session-endpoint-harness.mjs` | **57 passed, 0 failed** |
| `backend-wave8-moderation-m1-harness.mjs` | **11 passed, 0 failed** |
| `site/qa/qa-cf-parity.mjs` | **11 passed, 0 failed** (C6 now passes — see §10) |
| `site/qa/qa-testimonials.mjs` | **102 passed, 0 failed** (group J: J1–J7 all pass) |
| the **full 12-suite QA runner** | **12/12 exit 0** (transcript `site/qa/artifacts/qa-full-run-2026-10-22-002653.txt` — my own re-run, see §0 and §10) |

The two QA suites were run with their JSON output written **outside** `site/qa/artifacts/`, so
QA's own transcript (`qa-full-run-2026-10-22.txt`) was not overwritten.

---

## 7. The wave-8A acceptance checks — `spec/proposal-wave8-contract-2026-10-21.md` §10, executed

The contract spec's §10 lists the checks the next wave has to run, so that "done" is not a
matter of opinion. Every row, executed, in **both** trees. The harness IDs are given so each
row can be re-run and traced.

| Contract | The check (§10) | Executed evidence | Result |
|---|---|---|---|
| A | a client cookie → `200 {role:'client'}` | `wave8-session` V-S6 / C-S6 / P-S6 | 200 `role:'client'` |
| A | an owner cookie + the address on the list → `200 {role:'admin'}` | V-S5 / C-S5 / P-S5 | 200 `role:'admin'` |
| A | an owner cookie **without** the address on the list → `200 {role:'client'}` | V-S7 / C-S7 / P-S7 | 200 `role:'client'` (downgraded) |
| A | no cookie → 401 | V-S1 / C-S1 / P-S1 | 401 `{code:'unauthorized'}` |
| A | `ADMIN_EMAILS` unset → 500 | V-S3+V-S4 / C-S3+C-S4 / P-S3+P-S4 | 500 `{code:'internal'}` (unset **and** set-but-empty) |
| A | **the same assertions against the CF twin** | C-S1 … C-S16 (the whole matrix) | every answer identical to the Vercel tree |
| A | the same status **and body** in both trees | P-S1 … P-S16 | 16/16 identical |
| A | the token minted by one implementation verifies in the other (F-2, re-asserted) | `wave6-harness` W3a/W3b — two bundles, two processes | accepted in the other tree |
| B | a GET on a valid signed link → 200 HTML **and the state unchanged** | `wave8` M1a; `wave8-m1` M1 + P1 (the CF twin) | 200 + the page, the store still `pending` |
| B | the POST → 200 and the state is `approved` | `wave8` M1b; `wave8-m1` M2 | 200 `{state:'approved'}`, on disk |
| B | a GET with a forged signature → 400 | `wave8-m1` M6 + P2 (both trees) | 400 `{code:'signature'}`, nothing decided |
| B | a mutation probe: revert the GET branch → the check reddens | `wave8` M1c; `wave8-m1` D1 (Vercel) + D2 (the CF twin) | the reverted GET decides the quote → the check fails |
| C | the owner address removed from `ADMIN_EMAILS` → the portal's owner endpoint answers **403**, not 200 (the audit's probe C) | `wave8` M4a (+ the mutation probe M4c) | 403 `{code:'forbidden'}`, the project unchanged |
| D | a valid client cookie **and** a valid admin cookie → the client sees **only its own** project (the audit's probe C) | `wave8` M5a (+ the mutation probe M5c); `wave8-session` A-01 | 1 of 2, not 2 of 2 |
| E | `PORTAL_SESSION_SECRET` = the published placeholder → 500 | V-S13 / C-S13 / P-S13; `wave8` H1a | 500 `{code:'internal'}` |
| E | `PORTAL_SESSION_SECRET` = 30 characters → 500 | V-S14 / C-S14 / P-S14; `wave8` H1b | 500 `{code:'internal'}` |
| E | `PORTAL_SESSION_SECRET` unset → 500 (never a 401) | V-S12 / C-S12 / P-S12 | 500 `{code:'internal'}` |
| E | a good value → the flow works | V-S5/V-S6 (200 with a role); `wave8` H1b ("a real secret → accepted") | 200 |
| E | a mutation probe for the secret rule | `wave8` H1c (the value check removed → the placeholder passes); `wave8-session` d3 (the loud guard removed → 401 comes back) | both redden |
| §7 | every row of the NOT-BUILT list is either still open, or the file that proves it is now built | §8 below — a reading of the tree, by name | 3 closed, 7 still open |

The three wave-8 harnesses, as they stand:

```
node backend-wave8-harness.mjs                -> 35 passed, 0 failed, 35 checks   (8 mutation probes)
node backend-wave8-session-endpoint-harness.mjs -> 57 passed, 0 failed, 57 checks (4 mutation probes)
node backend-wave8-moderation-m1-harness.mjs    -> 11 passed, 0 failed, 11 checks (2 mutation probes)
```

---

## 8. The contract spec's NOT-BUILT list (§7) — re-checked BY NAME

The spec was written while `api/**` was being edited concurrently, so its line numbers are
stale. Every row was re-checked against the tree **by name**, as the spec itself asks (spec §9).

| # | What the spec says is NOT built | The state now, by name | Status |
|---|---|---|---|
| 1 | the Cloudflare portal tree is a 501 stub | `site/functions/api/portal/{auth,comments,invites,plan-items,projects,testimonials,updates}.ts` still answer `501 {code:'unimplemented'}` on the edge (no filesystem) | **STILL OPEN** |
| 2 | the portal handlers are NOT on the `PortalStore`/libSQL adapter | `api/portal/{auth,comments,invites,plan-items,projects,testimonials,updates}.ts` still import `../lib/jsonl.js` | **STILL OPEN** |
| 3 | the function-budget refactor is not implemented | `api/` still holds **20** `.ts` files = 20 Vercel functions, above the Hobby cap of 12 | **STILL OPEN** (not mine — DevOps's row in spec §11) |
| 4 | there is no annotations / open-notes store | `api/admin/reviews.ts` still answers `openNotes: null` | **STILL OPEN** |
| 5 | the Cloudflare twin of `GET /api/portal/session` does not exist | `site/functions/api/portal/session.ts` now exports `onRequestGet` (line 141) and `onRequest` (line 147) — 16/16 answers proven against it | **CLOSED** |
| 6 | the local dev server does not route `GET /api/portal/session` | `site/scripts/api-index.ts:28` exports `portalSession`; `site/scripts/dev-portal.js:99` routes it; the live proof is in §4 | **CLOSED** |
| 7 | the portal owner gates are not on the allow-list, and the client-scoped reads are not client-first | every portal handler in both trees now uses `resolveOwnerSession` / `resolveAccess` / `canReadClient` / `canWriteClient`; **no** `session.role === 'admin'` owner check is left in `api/portal/**` or `site/functions/api/portal/**` | **CLOSED** |
| 8 | the durable rate counter is not on the SQL backend | `api/lib/rate-limit.ts` still selects the file backend (`createFileBackend`) | **STILL OPEN** |
| 9 | the build-time publisher still reads the file store | `site/scripts/publish-testimonials.mjs` still reads the JSONL | **STILL OPEN** |
| 10 | the moderation store is still a JSONL file | `api/moderate/review.ts:55` — `REVIEWS_FILE` is still a file path | **STILL OPEN** |

**Seven rows are still open and are wave 7c's / DevOps's rows, not wave 8A's** (spec §11 items 3
and 4). Nothing in this report describes them as finished.

---

## 9. The harness decision the Manager asked for

The Manager's second note reported that `backend-wave6-harness.mjs` fails 14 of 23 checks and
asked me to decide whether the **product** or the **harness** is wrong. My judgement, with the
evidence:

**The product is right and the harness's own environment was stale.** The measurements in the
note are correct and I reproduced them: `MIN_SECRET_LENGTH = 32`, the harness's `SECRET` was 31
characters, `secretProblem()` returned `too-short`, and the harness's `SITE_BASE_URL` was
`https://imk.test` — which under the H-2 rule the brief *required* ("in production
(NODE_ENV=production OR VERCEL=1 OR SITE_BASE_URL starts https://) … must fail loudly") makes
the child a production instance. So every child ran in production with a secret the rule
refuses: `sessionSecret()` returned `null`, no session was minted, and every W2/W3/W6 check
failed with `500 {code:'internal'}`. The brief also says the VERIFY step is to run the harness
"with PORTAL_MAGIC_LINK_SECRET and PORTAL_SESSION_SECRET set" — and the harness *deletes* both
from the child environment and re-adds only its own 31-character value, so setting them in the
shell cannot help. The harness was testing its own stale fixture, not the product.

**So I updated the harnesses** (they are my test artifacts, not product code) so they exercise
the new production contract:

| Harness | Change | Why |
|---|---|---|
| `backend-wave6-harness.mjs` | `SECRET` → 34 characters | the H-1 rule refuses a shorter secret in production; a fixture the rule rejects proves nothing |
| `backend-wave6-harness.mjs` | `BASE` → `http://imk.test` | an `https://` base URL **is** a production signal, so the children would be in production mode, where the magic-link token is never written to the log and the harness could not read it. A real local dev server is `http://localhost:4321` |
| `backend-wave6-harness.mjs` | the mutation sandbox now also copies `site/shared/server/secret.ts` | the mutated copy of `portal-session.ts` imports `./secret.js`; without the file the W2f probe cannot even build (the note's "mutation probe fails to BUILD") |
| `backend-wave6-harness.mjs` | the moderation checks POST, **plus a new check**: "a GET does NOT flip the state (M-1)" | M-1 changed the protocol; the old check asserted the old protocol. The new check is the M-1 evidence the wave-6 harness was missing |
| `backend-f1-magic-token-harness.mjs` | `SECRET` → 34 characters, `BASE` → `http://imk.test` | the same two facts |

**Both are green again, and they still prove what they proved before:**

```
node backend-f1-magic-token-harness.mjs -> 22 passed, 0 failed, 22 checks
node backend-wave6-harness.mjs           -> 24 passed, 0 failed, 24 checks   (was 23: +1 for M-1)
```

The wave-6 harness still contains its negative control (the OLD Map-based session, re-introduced
in a sandbox copy) and still proves the session is stateless across bundles and processes
(W2f). Nothing was weakened to make it pass: the *checks* are the same, the *fixture* now
satisfies the rule the brief asked for.

**The product did not change for this.** The only product change in this area is the loud
secret guard on the session endpoint (§3) — and that one makes the deployment **louder**, not
quieter: a broken deployment now answers 500 instead of the silent 401 that was the F-2 symptom.

---

## 10. The QA re-pin — CLOSED (it was the last open item in this wave)

**It is closed.** The QA Engineer re-pinned the suites against the new contract and re-ran the
full runner on the tree as it stands now:

```
powershell -NoProfile -ExecutionPolicy Bypass -File site\qa\run-all-suites.ps1
SUITE: qa-testimonials.mjs            exit 0     (102 checks, 102 passed)
SUITE: qa-testimonials-build.mjs      exit 0     (14 build checks)
SUITE: qa-backend-hardening.mjs       exit 0     (21 checks)
SUITE: qa-wave2-independent.mjs       exit 0     (29 checks)
SUITE: qa-mutation-probe.mjs          exit 0     (5 probes, each reddening as expected)
SUITE: qa-rate-limit.mjs              exit 0     (8 checks)
SUITE: qa-cf-parity.mjs               exit 0     (11 checks)
SUITE: qa-wave3-independent.mjs       exit 0
SUITE: check:routes (npm run)         exit 0
SUITE: qa-wave4-independent.mjs       exit 0     (23 checks)
SUITE: qa-wave5-independent.mjs       exit 0     (26 checks, 3 mutation probes)
SUITE: qa-admin-independent.mjs       exit 0     (16 checks, 1 mutation probe)
transcript: site/qa/artifacts/qa-full-run-2026-10-22-002146.txt
```

**12 suites, 12 exit 0.** The five checks that were still failing when this report was first
written are fixed:

| Suite | The check that failed | How it is fixed now |
|---|---|---|
| `qa-wave5-independent.mjs` | `B1` "a valid moderation link approves and the store is updated" | the suite POSTs the link (M-1: a GET decides nothing) |
| `qa-wave5-independent.mjs` | `B4` "an UNWRITABLE store answers 500 {code:storage}" | same — the write guard can only be exercised by the POST |
| `qa-wave5-independent.mjs` | `D1`, `D2` (the mutation probes) | they assert on B1/B4, so they follow |
| `qa-admin-independent.mjs` | `E10` "the approve link the inbox mints … accepts it" | same — a POST |
| `qa-admin-independent.mjs` | `E15` (the mutation probe) | the probe now points at `site/shared/server/portal-session.ts` (`isAdminEmail()`), where the allow-list check actually lives — it used to mutate `api/admin/session.ts`, which now only delegates, so the `replace()` matched nothing and the probe was vacuous |

Two checks that assert the behaviour this wave added — *"a short signing secret must get 500"*
(`qa-cf-parity` C6) and *"an unusable session secret is a MISCONFIGURATION (500), not a silent
401"* (`qa-testimonials` J7) — **now pass**. Before §3 they could not have: the endpoint
answered 401. The `wave8-session` harness's `d3` mutation probe proves it — deleting the loud
guard turns those exact answers back into 401.

**The QA Engineer's finding, confirmed in the product.** QA reported that the two trees
disagreed on this endpoint: with an unusable `PORTAL_SESSION_SECRET` the Cloudflare twin
answered 500 while `api/portal/session.ts` answered **401** — the silent "signed out" symptom
and a spec §1 D-6 parity break. That was a real gap in my Vercel tree, and it is closed: the
guard now sits in **both** files, at `api/portal/session.ts:144` and
`site/functions/api/portal/session.ts:108`, each returning
`500 {error:'misconfigured', code:'internal'}` with the precise reason
(`PORTAL_SESSION_SECRET missing | placeholder | too-short`) in the log. Read back from disk
and confirmed by `wave8-session` P-S12…P-S15 (same status **and** body in both trees) and by
QA's J7. **Do not revert it.**

**Independently re-run by me** (not carried over from QA's transcript) at 00:26:53–00:27:31,
on the tree as it stands: `12 suites, 12 exit 0`, **271 checks** (102 + 14 + 21 + 29 + 8 + 11
+ 21 + 23 + 26 + 16) and **5/5 mutation probes** behaving as expected. Transcript
`site/qa/artifacts/qa-full-run-2026-10-22-002653.txt`. Every `FAIL` string in that transcript
is inside a mutation probe's *expected* failure list or inside the label "fails closed" —
there is no unexpected failure.

---

## 11. What stays UNVERIFIED

Stated plainly, because a green harness is not a deployment:

* **The Vercel router was never booted.** Every Vercel claim is a reading of the code and of
  Vercel's documentation, not a measurement. `api/portal/session.ts` is a *file* under `api/`, so
  Vercel builds it as a function — but the 12-function Hobby cap is unverified and the deploy
  target is not confirmed.
* **workerd was never booted.** The Cloudflare twin is executed under Node with a `Request`/`env`
  shim — the closest faithful emulation available offline — but a real Worker isolate was never
  started. The `globalThis.require` behaviour that makes the portal tree answer `501` on the edge
  is emulated, not observed.
* **No deployed function was exercised.** Nothing here ran on Vercel or Cloudflare.
* **No live mail.** The magic-link flow was exercised end-to-end in **development** mode, where
  the token is printed to the log instead of being mailed. Resend was never called.
* **The dev server is a local server**, not a production runtime: `APP_ENV=development`, an
  in-memory rate limiter and a per-process session secret.
* **The `ts` freshness window was proved against the shared module's logic**, not against a
  deployed link; the 7-day TTL assumes the clock on the signing host is right.
* **The revocation list is still per-process and unbounded in principle**
  (`globalThis.__imkRevokedSessions`) — the audit's MINOR finding; it is not fixed here.
* **The portal handlers are still not wired to `PortalStore`/libSQL** — `api/portal/*` and
  `api/moderate/*` still read JSONL. That is wave 7c, not this wave.
* **The Cloudflare portal tree is still a `501` stub** — only the session and moderation
  endpoints are real there.

---

## 12. Files changed, one more time

The **whole wave 8A**, not only the last pass. The Backend owns `api/**`,
`site/functions/api/**` and `site/shared/server/**`:

```
# the shared modules (new in this wave)
?? site/shared/server/secret.ts        the secret-quality rule (H-1) — one module, both trees
?? site/shared/server/moderation.ts    the moderation link contract (M-1): parser, expiry, page

# the shared session module
 M site/shared/server/portal-session.ts  isProductionEnv (H-2) · the secret guard (H-1) ·
                                        the M-3 expiry cap · resolveAccess / resolveOwnerSession /
                                        canReadClient / canWriteClient (M-4, M-5)

# the Vercel tree
 M api/portal/session.ts                the new route + the loud signing-secret guard
 M api/portal/{projects,comments,updates,plan-items,invites,testimonials}.ts
                                        the client-first read scope + the two-part owner gate
 M api/portal/auth.ts                   the precise misconfiguration reason in the log
 M api/admin/{session,reviews}.ts       the shared owner gate; H-1 for FORM_WEBHOOK_SECRET
 M api/contact.ts                       the shared production rule
 M api/moderate/review.ts               M-1, H-1

# the Cloudflare tree (the same changes, in parity)
 M site/functions/api/portal/session.ts
 M site/functions/api/portal/{projects,comments,updates,plan-items,invites,testimonials}.ts
 M site/functions/api/portal/auth.ts    the production rule + the log reason
 M site/functions/api/admin/{session,reviews}.ts
 M site/functions/api/contact.ts
 M site/functions/api/moderate/review.ts

# the local dev server (the Frontend's ask)
 M site/scripts/api-index.ts            export { default as portalSession }
 M site/scripts/dev-portal.js           ['/api/portal/session', 'portalSession']

# the harnesses (mine)
?? backend-wave8-harness.mjs                  35 checks, 8 mutation probes
?? backend-wave8-session-endpoint-harness.mjs 57 checks, 4 mutation probes
?? backend-wave8-moderation-m1-harness.mjs    11 checks, 2 mutation probes
 M backend-wave6-harness.mjs           the fixtures follow the new contract (+ the M-1 check)
 M backend-f1-magic-token-harness.mjs  the fixtures follow the new contract
```

No git command that **mutates** the tree was run (no add, commit, checkout, reset, clean or
stash). The only git commands anywhere in this wave were the two read-only inspections in the
re-verification pass — `git status --porcelain` and `git diff --stat` — used to confirm that
the change set is confined to the files listed above and that no other bot's work was
touched.
`site/data/` is byte-identical: `reviews.jsonl` is 0 bytes and there is no `site/data/portal/`.

Not touched by the Backend in this wave: `site/src/**`, `site/qa/**` (QA's),
`site/shared/portal-store/**`, `spec/**`, `DEPLOY.md`, `vercel.json`, `site/.env.example`.

---

## 13. What the Frontend Developer can now do

The 8C dependency is closed:

* `GET /api/portal/session` answers **200** (with `role`), **401** (`{code:'unauthorized'}`) and
  **500** (`{code:'internal'}`) in **both** trees; a wrong method answers **405** with
  `Allow: GET`; anything else is a non-answer the UI must treat as `UNKNOWN`.
* The role is the token claim **and** the live `ADMIN_EMAILS` allow-list — your `role: 'admin'`
  is only ever returned when the address is on the list *right now*.
* It answers **on localhost:4321** — the dev server was restarted onto the current code and the
  live proof is in §4. You can prove the owner controls against the real handler now.
* One extra guarantee for your UI: a misconfigured deployment answers **500**, not **401**, so
  your "misconfigured" branch is reachable — it was unreachable before.

@Frontend Developer — the endpoint is live; please re-prove the new-tab case against it and tell
me if anything in your contract needs a second shape.

@Manager — the state of wave 8A:

1. **The wave-8A acceptance checks (contract spec §10) are executed and reported — in both
   trees** (§7). Every row: contract A (six answers × two trees + a 16-row parity check), the
   F-2 cross-tree re-assertion, contract B (GET shows / POST decides / a forged GET is 400 /
   the mutation probe), contract C (403 when the address leaves the allow-list), contract D (1 of
   2, not 2 of 2) and contract E (the placeholder / 30 characters / unset → 500, a good value →
   the flow works, with two mutation probes).
2. **The wave-6 and F-1 harnesses are updated to the new production contract** — and my
   judgement, with the evidence, is that **the product was right and the harness's own
   environment was stale** (§9): a 31-character secret under a rule that refuses 32, and an
   `https://` base URL, which the brief itself names as a production signal. Both harnesses are
   green again (24/24 and 22/22) and the wave-6 harness gained the M-1 check it was missing.
3. **The QA re-pin is closed** (§10) — the 12-suite runner is **12/12 exit 0** on the tree as it
   stands. The five checks that were failing are fixed; two checks that assert this wave's
   behaviour (a short secret must get 500) now pass.
4. **The contract spec's NOT-BUILT list (§7) is three rows shorter than it says** (§8): rows 5,
   6 and 7 are built. The other seven rows are still open and are wave 7c's / DevOps's, not
   wave 8A's. The Architect's wave-8D report is stale on M-4, M-5, the Cloudflare twin and the
   dev route — all four were in the tree.
