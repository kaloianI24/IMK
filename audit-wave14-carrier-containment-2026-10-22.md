# Independent audit — wave 14 (carrier containment, wave 12/13 regression, DEPLOY.md)

**Auditor:** Code Reviewer — Independent Audit
**Date:** 2026-10-22
**Tree audited:** `C:\Users\Kalch\Documents\IXI` (read from disk; no report in the tree was trusted)
**Report file:** this file — the ONLY file I created. No product, test, doc or harness file was edited;
no git write command was run. All probes live in `%TEMP%\opencode\wave14-audit\`.

---

## 1. VERDICT: **SHIP** — with 6 MINOR findings, none of which blocks the launch

| Question I was asked | Verdict |
|---|---|
| MAJOR-1 (wave 13): is the shipped router comment true under **either** query-merge order? | **YES — the comment is now true.** The three invariants it claims hold under both orders, and I proved each by execution. The false claim is gone. |
| Does the wave-14 containment harness prove the invariant? | **YES.** It is non-vacuous (its 4 probes redden). I reproduced the same properties independently, with my own mutations, in a temp tree. |
| F2: does the deploy gate now NAME a miss instead of crashing? | **YES, and the fix is load-bearing** (my mutation reverts it → the original `TypeError` returns). |
| F3: does the deploy gate FAIL on a table route the entry point cannot serve? | **YES, and the check is load-bearing** (my mutation reverts it → the gate passes the broken route). |
| Waves 10–13 regression (identity scope, address rule, publisher guards, 16 URLs, 7 functions) | **CLEAN** — every item re-verified by execution. |
| DEPLOY.md vs the tree | **3 MINOR inaccuracies** (§6.2). No wrong count, no unnamed URL, no false "deployable" claim. |
| Two trees (Vercel `api/` vs Cloudflare `site/functions/`) disagreeing on a security contract | **No divergence found** in the contracts I compared; **1 MINOR drift risk** (§6.3). |
| Preview deploy + curl before launch? | **Not a security requirement. It IS a launch requirement** — for a different reason than the merge order (§5). |

**No CRITICAL. No MAJOR.** The two MEDIUM findings I raised in wave 13 (`check-api-routes.mjs` crash,
unservable-route hole) are **closed** — wave 14 F2/F3 fixed both, and I proved the fixes bite.

---

## 2. The gates I ran myself (this wave, on the current tree)

| Gate | Command | Result |
|---|---|---|
| Types | `npm run typecheck:api` | **exit 0** |
| Route manifest | `npm run check:routes` | **exit 0** — `16 route(s), 0 missing function file(s)`; `api/ holds 7 .ts file(s)`; `11 rewrite(s) agree with the route table (2 families)`; `every route of the table is served by its entry point's HANDLERS map` |
| Store contract | `npm run test:store` | **72 pass / 0 fail** (27 file · 34 libsql · 11 shared) |
| Repo-root harnesses | `node backend-*.mjs` (11 files) | **11/11 exit 0 — 289 checks**: f1-magic-token 22 · review-fixes 23 · wave10-store-integrity 42 · wave13-function-budget 22 · **wave14-carrier-containment 24** · wave6 24 · wave8 35 · wave8-moderation-m1 11 · wave8-session-endpoint 57 · wave9b-admin-inbox 16 · wave9-store-wiring 13 |
| QA runner | `powershell -NoProfile -ExecutionPolicy Bypass -File site\qa\run-all-suites.ps1` | **17 suites, 17 exit 0** — transcript `site/qa/artifacts/qa-full-run-2026-10-22-102303.txt`, **0 FAIL lines**, **20/20 anchor proofs**; 357 `PASS` lines in the transcript (that count includes the wave-14 harness's own 24 PASS lines, which the runner inlines — QA's own suite count is 322) |
| My own probes (temp only) | `gate-probe.mjs` 12 · `routing-probe.mjs` 23 · `publisher-probe.mjs` 18 | **53/53 pass** (§4) |

`site/data` untouched: `site/data/moderation/reviews.jsonl` = **0 bytes**, **no** `site/data/portal/`.
Encoding: 0 U+FFFD replacement characters in `DEPLOY.md`, `site/.env.example`, `portal-router.ts`,
`api/portal.ts`, `check-api-routes.mjs` (the mojibake in my console output is the terminal's code page,
not the files).

---

## 3. MAJOR-1 — the router comment (wave-13 finding, wave-14 F1)

### 3.1 The claim as it now stands

`site/shared/portal-router.ts:42-87` no longer claims that a forged carrier cannot select a handler.
It states, and labels the merge order as **NOT OBSERVED** (`:46-50`), three invariants that hold either way:

1. **Family containment** — `portal-router.ts:208` (`isInsideEntry(carrier, entryPrefix)`),
   tables disjoint (`site/shared/portal-routes.json:28-50`).
2. **Standalone URLs out of reach** — `api/contact.ts`, `api/moderate/review.ts`, `api/portal/auth/*`
   are in no family table (`portal-routes.json:51-66`).
3. **The handler authorizes itself** — every family handler gates itself.

and states the honest remainder (`:75-80`): a forged carrier **can** select another handler *of the same
family* — "a routing surprise, not an escalation".

**That is true, and I proved it by execution.** The comment is honest about both the risk and the
bound. It is no longer a claim about behaviour nobody has observed.

### 3.2 My own proof (temp tree, `routing-probe.mjs`, 23/23)

Requests are built the way the platform builds them after the rewrite: **entry-prefix path + the
original public path in `__imk_route`** (I bundled `api/portal.ts` / `api/admin.ts` with esbuild and
drove the default export with a fake `req`/`res`).

| # | Probe | Observed |
|---|---|---|
| B1 | cross-family carrier `__imk_route=/api/admin/reviews` on the portal entry | **404 `{code:'not-found'}`** — the admin handler never ran |
| B2–B6 | carrier naming each standalone URL (`/api/contact`, `/api/moderate/review`, `/api/portal/auth/{verify,request-link,logout}`) | **404 each** |
| B7 | same-family carrier `__imk_route=/api/portal/session`, no session | **401 `{code:'unauthorized'}`** — the session handler ran and refused |
| B7b | same-family carrier → `/api/portal/projects` | **401** |
| B7c | POST same-family carrier → `/api/portal/invites` (owner-only) | **403 `{code:'forbidden'}`** — `portal-invites.ts:227-231` still demands the owner session |
| B8 | bare `/api/portal`, no carrier | **500 `{code:'route-resolution'}`** — loud, never a silent 404 |
| B9 | handler URL after the rebuild | `/api/portal/projects?projectId=prj_x` — **carrier stripped, client query kept** (spied inside the entry point) |
| B10 | admin entry: portal-family carrier → 404; admin-family carrier → **401**; bare `/api/admin` → 500 | as stated |
| M1 | **mutation**: `if (!isInsideEntry(...))` → `if (false)` in a copy | the cross-family carrier **escapes** (`{ok:true, handler:'admin-reviews'}`) → the check is load-bearing |
| M2 | shipped code + a deliberately BROKEN table (an admin route inside the portal table) | still **refused** — the containment is a property of the code, not only of the table's shape |
| M3/M4 | the two family tables are disjoint; no standalone URL is in a family table | confirmed |

### 3.3 Why the same-family forgery is not an escalation (my reasoning, with the code)

Every one of the nine portal routes and both admin routes is **directly reachable** (each has its own
`vercel.json` rewrite, `vercel.json:35-47`). A forged carrier can therefore only pick a route the
caller could have called anyway — it grants **no capability** the handler would not have granted
(`portal-router.ts:67-73` says exactly this, and it is true). The blast radius is the caller's own
request, answered by a different handler of the same family: confusing, not a privilege boundary.

### 3.4 Residual I did NOT find (recorded so it is not re-litigated)

The **code-level** containment (`isInsideEntry`) protects the **family** boundary only. The three auth
standalone URLs live *under* `/api/portal/`, so `isInsideEntry` does not exclude them — they are kept
out of reach by the **table** alone. `portal-router.ts:61-65` says this honestly ("because the resolver
matches a carrier against a family table only"), so it is not a false claim. If a future edit put
`/api/portal/auth/verify` into the portal family table **and** added `portal-auth` to the entry
point's `HANDLERS` map, the deploy gate would pass and the auth handler would become reachable
through the portal entry — harmless (it is the same handler the standalone file runs), but the
"standalone URLs are out of reach" claim would have become false. **Observation, not a defect.**

---

## 4. F2 / F3 — the deploy gate (`site/scripts/check-api-routes.mjs`)

Both wave-13 MEDIUMs are closed. My `gate-probe.mjs` copies the repo to a temp directory and mutates
**only the copy**.

| # | Probe | Observed |
|---|---|---|
| A1 | control: the gate on the real tree | **exit 0** |
| A2 | `api/portal.ts` deleted in the copy | **exit 1**, message **`the entry point api/portal.ts is missing`**, **no `TypeError`**, no stack trace |
| A3 | the table gains `/api/portal/ghost` **and** a matching rewrite (so only the HANDLERS check can fire) | **exit 1**, message **`/api/portal/ghost: api/portal.ts cannot serve it — its HANDLERS map has no 'portal-ghost'`** |
| M1 | **mutation**: the F3 block (`check-api-routes.mjs:487-500`) reverted in the copy | the unservable route now **passes** (exit 0) → the F3 check is load-bearing |
| M2 | **mutation**: the F2 fix reverted (the row pushed without `files`, `:378/:384`) | the missing-entry-point case crashes again with **`TypeError: Cannot read properties of undefined (reading 'vercel')`** → the F2 fix is load-bearing |
| A4 | the restored copy | **exit 0** again |

The gate is now **fail-closed and legible**: it names the miss instead of crashing, and it catches the
unservable route. Both wave-13 MEDIUMs are **CLOSED**.

---

## 5. The preview-deploy + curl question (reframed)

**What it would prove.** One `curl` against a preview deployment with a forged
`?__imk_route=/api/portal/session` on a path that is otherwise a different route shows **which side
wins the merge**:

- if the **platform's** carrier wins → the forged-carrier channel **does not exist** on the deployed
  target, and `DEPLOY.md:115` ("a client-supplied `__imk_route` can select another route of the same
  family") is **false in the pessimistic direction** and should be corrected;
- if the **client's** carrier wins → the documented trade-off is **live**, exactly as `DEPLOY.md:115/:123`
  says.

(For the record: Vercel's own router implementation merges with
`Object.assign(destQuery, reqQuery)` — the **client's** query wins on a key collision — so the
pessimistic case is the likely one. That is documentation, not an observation.)

**What it would cost.** One preview deployment of the owner's own Vercel project + 1–3 `curl` calls.
No code change, no new secret, no production risk; the portal endpoints answer 401/404 without a
session. Minutes of build time.

**Is it still required before launch? — Two different answers, and the second one matters more.**

- **For the security question: NO.** Under *either* merge order there is no privilege escalation
  (§3.2): the families are disjoint, the standalone URLs are unreachable through the carrier, and every
  handler authorizes itself (401/403 observed). The wave-14 fix makes the merge-order observation
  **optional for safety** — the worst case is a routing surprise on the caller's own request.
- **For the launch itself: YES, and it is not about the merge order at all.** **No Vercel router has
  ever been booted for this project, so it is unverified that the `vercel.json` rewrites fire at all.**
  If they do not (a config typo, a project setting that ignores `rewrites`, a source pattern that does
  not match), then `/api/portal/projects` has **no function file behind it** (the per-route files were
  deleted in wave 13) → the **whole portal answers 404** and `/api/portal` answers 500
  `route-resolution`. Every offline gate passes in that world: the route table agrees with
  `vercel.json`, the resolver resolves, the handlers gate themselves. **One `curl` of
  `/api/portal/projects` on a preview settles it.** I recommend one preview deploy + two curls before
  launch, for that reason, and the merge-order question is a free rider on the same deploy.

---

## 6. Findings

### 6.1 Nothing CRITICAL, nothing MAJOR

I looked hard for an escalation and did not find one. The carrier forgery is real but bounded; the
publisher's data-loss class is closed in all four states I could construct; the identity scope is
atomic and enforced in both adapters.

### 6.2 DEPLOY.md vs the tree — 3 MINOR

**MINOR-1 — `DEPLOY.md:43` cites a file that does not exist.**
`… (`api/lib/rate-limit.ts:430-440`)`. `api/lib/` was deleted in wave 13; the module now lives at
`site/shared/server/rate-limit.ts` (the same paragraph at `DEPLOY.md:297` cites it correctly, and
`site/shared/server/rate-limit.ts:425-440` is indeed the `createPortalRateLimiter` doc block, so only
the **path** is wrong).
*Impact:* the owner greps for a file that is not there and concludes the limit is undocumented.
*Fix:* `site/shared/server/rate-limit.ts:425-440`.

**MINOR-2 — `DEPLOY.md:112-113` documents a wildcard rewrite that does not exist.**
The table shows `/api/portal/* → /api/portal.ts?__imk_route=/api/portal/:path*` (and the admin twin).
`vercel.json:35-47` has **11 explicit per-route rewrites** with exact sources
(`/api/portal/projects/:id` → `/api/portal?__imk_route=/api/portal/projects/:id`) and **no `:path*`
wildcard anywhere**. The prose at `:108` is right ("11 rewrites"); the table is a fiction that
suggests a catch-all the file does not have.
*Impact:* a reader greps `vercel.json` for `:path*`, finds nothing, and cannot tell whether the
carrier is per-route or wildcard — the exact question the routing section is meant to answer.
*Fix:* replace the two rows with the real 11 sources (or say "11 explicit rewrites, one per route —
see `vercel.json:35-47`").

**MINOR-3 — `DEPLOY.md:68` quotes a publisher error message that the code does not produce, and
describes the guard one wave out of date.**
It says a store that "yields **ZERO records**" fails with the message *"Refusing to publish an empty
set — published quotes exist."* The shipped rule (`publish-testimonials.mjs:293-304`, wave 12 B-4)
counts **REVIEW** records, and the literal message is *"the portal store holds NO review records, but
N published testimonial(s) exist. An empty store must never replace a published set — refusing to
publish an empty set of testimonials. Check that the build reads the right store…"*.
*Impact:* the owner's build log says "holds NO review records"; the doc's list of reasons says "empty
store" and quotes a string that never appears → the owner does not recognise their own error.
*Fix:* quote the literal message and add the wave-12 refinement ("zero **review** records") to the
list of reasons at the end of the same paragraph.

### 6.3 MINOR-4 — the Cloudflare twins' header comments now name a file that is not them

Wave 14 F4 fixed the six corrupt `site/functions/site/shared/…` comments — good. But the replacement
text names the **Vercel** module:

- `site/functions/api/portal/testimonials.ts:1` → `// site/shared/portal-handlers/portal-testimonials.ts — Cloudflare Pages Function.`
- `site/functions/api/admin/reviews.ts:1`, `site/functions/api/admin/session.ts:1` → the same pattern
- `site/functions/api/lib/notifications.ts:1`, `site/functions/api/lib/rate-limit.ts:1` → the shared-module path

Only `site/functions/api/portal/session.ts:1` is accurate ("Cloudflare Pages Function **AND** shared
module" — that file really does re-export `shared/server/portal-session.ts`). The other five are
**separate implementations** (610 / 87 / 100 / 221 / 181 lines) that import shared *helpers* only.
*Impact:* the comment says "this file IS the shared handler", which hides the fact that the two trees
hold **two copies** of four handler bodies. The deploy gate checks **paths, not bodies**, so a future
fix applied to only one tree passes every gate and the parity suites.
*Fix:* name the file itself and say it is a twin: *"site/functions/api/portal/testimonials.ts — the
Cloudflare twin of site/shared/portal-handlers/portal-testimonials.ts; two copies, kept in step by
site/qa/qa-cf-parity.mjs."*

### 6.4 MINOR-5 — an empty carrier falls through to the client-controlled **header** carrier

`api/portal.ts:78-85` (`carrierOf`) and `site/shared/portal-router.ts:194`:

```ts
const fromQuery = url.searchParams.get(ROUTE_CARRIER_PARAM);
if (fromQuery) return fromQuery;      // ← an EMPTY value is treated as ABSENT
const header = req.headers[ROUTE_CARRIER_HEADER];   // ← also client-controlled
```

Observed (my `routing-probe.mjs` B11/B12):

- `GET /api/portal?__imk_route=` (empty, no header) → **500 `{code:'route-resolution'}`**, not 404 —
  an empty carrier is "absent", so the request looks like a platform-ate-the-path case;
- `GET /api/portal?__imk_route=` **+ header `x-imk-route: /api/portal/session`** → the **session
  handler runs** (401 — it still gates itself).

*Impact:* **no escalation** — the handler authorizes itself and the containment holds. But it is a
second client-controlled channel that the wave-14 comment does not mention, and it is reachable under
a query-merge behaviour that **concatenates** rather than overrides (the empty client value would sit
first in the merged query, `searchParams.get` returns the first occurrence, and the header takes over
even though the platform's carrier is present). Under Vercel's documented merge (the client's query
wins outright) it adds nothing — the client could simply write the forged value in the query.
*Fix (two lines):* treat a **present but empty** `__imk_route` as **invalid** (→ 404 `not-found`,
never "absent"), and either drop the header carrier or document it as a second client-controlled
channel in `portal-router.ts:24-27`.

### 6.5 MINOR-6 — the Cloudflare tree is not wired to the database (a documented, not a new, gap)

`site/functions/api/admin/reviews.ts:83-89` answers **501** because the CF tree has no moderation
store, while the Vercel tree reads and writes the libSQL store. `DEPLOY.md` describes the CF target as
"the parity twin — not the launch target" and §4.1 documents the 501, so this is **documented
behaviour, not a defect**; it is recorded here because a CF deployment would show the owner an empty
inbox (a 501, not a silent empty queue) and because it is the one place where the two trees
*deliberately* differ.

---

## 7. Regression check — waves 10 → 13 (each item re-verified)

| Item | How I verified | Result |
|---|---|---|
| **Record-identity scope, file adapter** | `site/shared/portal-store/file-adapter.ts:284-286`; **executed**: two records sharing `(ref, revision)`, a decision naming the older record → **refused** (`null`, nothing decided); a decision naming the newest → **flips exactly that record**; **mutation** removing `:285` → the **wrong record is flipped** → the scope is load-bearing | ✅ |
| **Record-identity scope, libSQL adapter** | `site/shared/portal-store/libsql-adapter.ts:554-586` — **one** `UPDATE` with `revision = ?` **and** `json_extract(data,'$.recordId') = ?` **inside the statement** (atomic), plus the fallback identity check at `:610-612`; the repo's own contract test (a real SQLite engine over the real wire protocol) covers it — I ran it (`test:store` 72/72) | ✅ |
| **Identity assignment** | `site/shared/portal-store/record-id.ts:48-62` (store-assigned, `rec_` + uuid); `file-adapter.ts:197` assigns on `append`; the Vercel handler uses `stored.recordId` (`portal-testimonials.ts:661,705`); the CF twin assigns it itself (`site/functions/api/portal/testimonials.ts:591`) and carries it into the mail (`:655`) | ✅ |
| **No downgrade of the signed link** | `site/shared/server/moderation.ts:124-131` (a malformed id is refused), `site/shared/server/notifications.ts:135-148` (`ref\|decision\|revision\|recordId\|ts` vs the legacy 4-field form — a link **with** an identity cannot be replayed without it); the CF twin signs the same message (`site/functions/api/lib/notifications.ts:97-110`) | ✅ |
| **Platform-address rule** | `site/shared/server/platform-address.ts:78-101` — `cf-connecting-ip` **only** with `TRUST_CF_CONNECTING_IP` (`:111-114`), then `x-real-ip`, then the last hop of `x-vercel-forwarded-for`, then the last hop of `x-forwarded-for`, then the per-instance bucket; used by the portal auth handler (`portal-auth.ts:178-186,303`), the contact form + Turnstile `remoteip` (`api/contact.ts:301-306`) and the CF twin (`site/functions/api/portal/auth.ts:206-209`, `trustCfConnectingIp: true` — correct, Cloudflare is in front there) | ✅ |
| **Publisher guard state 1** — missing store + published quotes | **executed**: `exit 1`, the published `.md` **survives** | ✅ |
| **Publisher guard state 2** — missing store + nothing published | **executed**: `exit 0`, nothing published | ✅ |
| **Publisher guard state 3** — empty store + published quotes | **executed**: `exit 1` (`EmptyStoreError`), the published `.md` **survives** | ✅ |
| **Publisher guard state 4** — records but **no review record** + published quotes | **executed**: `exit 1`, the published `.md` **survives** | ✅ |
| **Publisher guard state 5** — a real approved review | **executed**: `exit 0`, the quote is written | ✅ |
| **Crash-safe swap (wave 12 B-5)** | **executed**: the published directory removed, the previous set left only in the sibling `.testimonials-previous-<pid>-<ts>` → the run restores it **before** the store is read (`publish-testimonials.mjs:736-780`) and then fails loudly on the missing store → **exit 1 with the previous set back in place** | ✅ |
| **16 public URLs** | `check:routes` → `16 route(s), 0 missing`; every one named in `DEPLOY.md:178-195` with its Vercel file and its Cloudflare twin | ✅ |
| **Function count ≤ 12 (Hobby)** | `api/` holds **7** `.ts` files (`api/admin.ts`, `api/contact.ts`, `api/moderate/review.ts`, `api/portal.ts`, `api/portal/auth/{logout,request-link,verify}.ts`); `api/lib/` is gone (0 importers) | ✅ |
| **Route table ↔ `vercel.json` ↔ `HANDLERS` maps** | the gate itself checks all three (`:437-458`, `:487-513`) and my A3/M1 prove the third one bites | ✅ |

---

## 8. What stays UNVERIFIED (read this before shipping)

1. **No Vercel router was booted.** The rewrite's *firing* and the query-merge order are **unobserved**.
   The merge behaviour I cite is Vercel's own routing implementation executed offline in wave 13 —
   **documentation and source, not a production observation**. Everything in §3 is proven against the
   code, not against the platform.
2. **No deploy, no preview, no production request.** The "the rewrite fires" question in §5 is open.
3. **No workerd / no Cloudflare runtime booted.** The CF twin's parity was established by reading and by
   the repo's own parity suites, not by running Workers.
4. **No real Turso database was contacted.** The libSQL adapter is proven against a **real SQLite engine
   over the real wire protocol** through the repo's mock pipeline server (`test:store` 55-61), which is
   strong but is not Turso.
5. **libSQL was not exercised concurrently at the HTTP level.** The atomicity argument rests on the
   single-statement SQL (`libsql-adapter.ts:576-586`) plus the contract tests, not on an observed race.
6. **No live mail.** No Resend message was sent; the one-click link was never exercised against a real
   mailbox.
7. **`npm run build` (the Astro production build) was not re-run by me.** The QA build suite ran
   (`qa-testimonials-build.mjs`); that is not the Astro build. `astro check` was not re-run by me
   either (QA reports 0 errors / 0 warnings / 13 hints).
8. **The wave-13 move was not re-verified byte-for-byte.** I verified behaviour (routes, gates,
   handlers), not bytes.
9. **The transcript pins the tree at 10:23:03 +03:00, not a commit.** The working tree is permanently
   dirty (153 changed entries); I ran no mutating git command and read `git status` only.
10. **Two of my own probe expectations were wrong on the first run** and were corrected in the probe,
    not in the product: the store's decision values are `approved`/`rejected`
    (`site/shared/portal-store/types.ts:43`, `api/moderate/review.ts:391`), and the interrupted-swap
    case must have **no** published directory for the recovery to engage
    (`publish-testimonials.mjs:738`).

---

## 9. Recommendations, in order

1. **Before launch: one preview deploy + two `curl`s** (§5). One `curl` of `/api/portal/projects`
   proves the rewrites fire — if they do not, the portal is dead on arrival and every offline gate
   still passes. The second `curl` (a forged `__imk_route`) settles the merge order for the record.
   *This is the single highest-value unblocked check left.*
2. **MINOR-4** — treat a present-but-empty `__imk_route` as invalid (404), not as absent, and decide
   the fate of the client-controlled `x-imk-route` header. (`portal-router.ts:194`,
   `api/portal.ts:78-85`.)
3. **MINOR-1 / 2 / 3** — three one-line DEPLOY.md corrections (the deleted path, the wildcard rewrite
   that does not exist, the publisher message that is not literal).
4. **MINOR-6** — five CF header comments should name their own file and say they are twins.
5. Optional hardening for the next wave, if the owner wants the routing surprise gone rather than
   documented: serve the original path from a **platform-set** header (e.g. `x-matched-path`) instead of
   a client-visible query parameter, or reject a request whose `__imk_route` is not the one the
   platform's rewrite injected. Both need a booted Vercel router to verify — which is why it is
   listed here and not as a wave-15 action.

---

*Nothing in this report was taken from another bot's report without re-deriving it from the tree or
from execution. Every claim marked "executed" was run by me in this session; the rest is marked as
read-only inspection.*
