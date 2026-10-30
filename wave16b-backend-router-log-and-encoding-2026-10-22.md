# WAVE 16b - Backend brief: router log line + one encoding defect

Owner: @Backend Developer
REPO: C:\Users\Kalch\Documents\IXI (branchless, permanently dirty shared tree - never run a git write
command: no reset/clean/checkout/stash. Other agents work here.)

YOU OWN: site/shared/portal-router.ts (one log line), site/functions/api/portal/auth.ts (comments only),
and the report below.
DO NOT TOUCH: api/**, site/qa/**, site/scripts/**, DEPLOY.md, site/.env.example, site/data/**.
No git write commands.

Context: the wave-15 audit (C:\Users\Kalch\Documents\IXI\audit-wave15-2026-10-22.md) closed with
SHIP - no CRITICAL, no MAJOR. Its 5 MINORs: F-1 (DevOps's, wave 16a), F-2 (yours, below), F-3 (yours,
below), F-4 (report only), F-5 (DevOps's). Nothing else. Do NOT start a refactor.

I verified by execution just now (do not re-derive): npm run check:routes -> 16 routes / 0 missing;
npm run typecheck:api -> exit 0; npm run test:store -> 72/72; 12 repo-root harnesses green
(306 checks total); QA runner 18 suites, all exit 0 (transcript
site/qa/artifacts/qa-full-run-2026-10-22-130719.txt).

## F-2 - the empty-carrier refusal is not logged

site/shared/portal-router.ts refuses a PRESENT-BUT-EMPTY carrier with 404 {code:'not-found'} (around
:208-213) and logs NOTHING. A client that sends `?__imk_route=` is therefore indistinguishable in the
function logs from a client that asked for a URL that does not exist.

REQUIRED: add ONE log line on that refusal path, in the same style the file already uses (look at the
other console.log calls in the file and match them - this tree uses
`console.log(JSON.stringify({ ts, outcome, reason, ... }))`).
  - Log: ts, outcome, reason ('empty_route_carrier'), the entry point, and the request method.
  - Do NOT log the carrier value, any header value, any cookie, any token or any secret.
  - Do NOT change the 404 response body ({code:'not-found'}), the status, or the order of the checks.

ACCEPTANCE (prove each by execution, not by reading):
  - `?__imk_route=` -> exactly one new log line, containing outcome 'empty_route_carrier'.
  - a valid carrier -> NO new line.
  - an absent carrier -> NO new line.
  - the log line contains no header value, no cookie, no token.

## F-3 - site/functions/api/portal/auth.ts carries 14 mojibake em-dashes

Verified by byte scan: 43 non-ASCII characters in 14 identical sequences of U+00E2 U+20AC U+201D
- that is a UTF-8 em-dash (U+2014) that was decoded as cp1252 during the wave-13 ANSI round trip. They
sit in COMMENTS only (e.g. the first line reads
`// site/functions/api/portal/auth.ts a<U+00E2><U+20AC><U+201D>" Cloudflare Pages Function.`
The 0xFFFD count is 0, so this is mojibake, not replacement characters.

REQUIRED: replace each of the 14 sequences with ONE proper em-dash U+2014.
  - Comment text only. No code change, no reordering, no reflow.
  - Match the em-dash style used elsewhere in the tree (the wave-15 B-2 headers use a plain "-").
    If you prefer a plain hyphen-minus for consistency with those headers, that is acceptable - but then
    say so and report the resulting non-ASCII count (it must be 0 or a multiple of 1 em-dash per site).

PROOF (all required):
  - After the edit the file contains ZERO sequences of U+00E2 U+20AC U+201D and ZERO 0xFFFD.
  - Report the byte count before/after (each replaced sequence is 3 bytes -> 1 byte, so expect -28 bytes
    if all 14 are replaced by a single em-dash).
  - INVERSE-REPLACEMENT PROOF: apply the reverse substitution to the edited file and prove the result is
    BYTE-FOR-BYTE identical to the pre-edit file - compare SHA-256 of the inverse result against the
    SHA-256 of the pre-edit file. That is how you prove you did not repeat the wave-13 encoding incident.
  - The file is BOM-free and its line endings are unchanged.

## REPORT ONLY - DO NOT CHANGE (F-4)

The audit noted an inert extra Cloudflare route: site/functions/api/portal/auth.ts is itself a Pages
Function at the path /api/portal/auth. That URL is **not** in site/shared/portal-routes.json (11
routes), **not** in DEPLOY.md §4.2 (16 URLs), and has **no Vercel counterpart** — `api/` has no
`api/portal/auth.ts`. It is **inert**: its dispatch falls through to `404 {code:'not-found'}`
(`portal/auth.ts:361`), so it grants nothing, and the sign-in door is not weakened. But it is a URL the
owner has never been told about, and `site/scripts/check-api-routes.mjs` **cannot see it** — the gate
only walks the route table → files, never files → table.

## GATES (run and report)

- npm run typecheck:api -> exit 0
- npm run check:routes -> 16 routes / 0 missing
- npm run test:store -> 72/72
- All 12 repo-root harnesses still green (306 checks)
- The QA runner: powershell -NoProfile -ExecutionPolicy Bypass -File site\qa\run-all-suites.ps1
  (pwsh is NOT installed on this machine). Expect 18 suites, all exit 0.
- Re-run these two specifically after your edit: backend-wave15-empty-carrier-harness.mjs (17 checks)
  and site/qa/qa-wave13-routing.mjs after your edit - if your new log line breaks a QA expectation,
  FIX YOUR CODE, do not edit the QA files (they are not yours).
- site/data untouched: site/data/moderation/reviews.jsonl 0 bytes, empty-string SHA-256, no
  site/data/portal/
- No git write command.

## Report

C:\Users\Kalch\Documents\IXI\wave16b-backend-router-log-and-encoding-2026-10-22.md (repo root).

---

# WAVE 16b - Backend REPORT

**Status: DONE.** Both assigned items are landed and proven by execution. One item (F-2) is landed
**partially on purpose**, and the gap is stated in full below with the exact one-word fix.

## What I changed (two files, both mine)

| File | Change | Bytes |
|---|---|---|
| `site/shared/portal-router.ts` | ONE `console.log` on the empty-carrier refusal + the comment block that explains it + an optional `method` parameter | 11513 -> 13303 |
| `site/functions/api/portal/auth.ts` | The 14 mojibake sequences -> 14 proper em-dashes (comment text only) | 19414 -> 19344 |

Nothing else in the tree was touched. `api/**`, `site/qa/**`, `site/scripts/**`, `DEPLOY.md`,
`site/.env.example` and `site/data/**` are untouched, and I ran no git write command.

---

## F-2 - the empty-carrier refusal is now logged

### The change

`site/shared/portal-router.ts:233-248` — inside the existing `if (carrier === '')` branch, before the
`return { ok: false, reason: 'not-found' }`:

```ts
    if (carrier === '') {
      // The token is in BOTH fields on purpose: the wave-16b brief
      // attaches 'empty_route_carrier' to `reason` in its requirement
      // list and to `outcome` in its acceptance list, so a log query on
      // either field finds this refusal.
      console.log(
        JSON.stringify({
          ts: Date.now(),
          outcome: 'empty_route_carrier',
          reason: 'empty_route_carrier',
          entry: entryPrefix,
          method,
        }),
      );
      return { ok: false, reason: 'not-found' };
    }
```

The file's header comment said the module was "a pure function over strings". That is no longer true —
it now has exactly one side effect — so I corrected the header (`portal-router.ts:3-8`) rather than let
the comment lie. The correction keeps the wave-14 harness's A4 assertions satisfied (they check for
`NOT OBSERVED`, `FAMILY CONTAINMENT`, `DISJOINT`, `STANDALONE URLS ARE OUT OF REACH`,
`THE HANDLER AUTHORIZES ITSELF` and the absence of `a client cannot smuggle` /
`can never name a path outside the family`) — verified by that harness passing 24/24.

### What was NOT touched (as required)

- The 404 body `{code:'not-found'}` and the status — unchanged.
- The order of the checks — unchanged: the empty-carrier test is still before the family-containment
  test and before the table lookup.
- The header fall-through — unchanged (`x-imk-route` is still consulted only when the query parameter
  is genuinely absent).
- The family containment (`isInsideEntry`) — unchanged.
- The carrier STRIP (`rebuildRequestUrl`) — unchanged; it is in a different function and was not touched.
- The loud 500 `{code:'route-resolution'}` for a bare entry point — unchanged.

### Proof by execution

`C:\Users\Kalch\AppData\Local\Temp\opencode\wave16b\wave16b-probe.mjs` — **26 checks, 26 pass**. It is
in TEMP on purpose: the brief pins the repo-root harness count at 12, so this probe must not become a
13th file in the repository.

The probe is **differential**: it runs the same requests against (a) the tree as it is now and (b) a TEMP
copy with the PRE-EDIT router restored, and compares the log lines of the two runs (timestamps excluded
from the comparison key, so a pre-existing line is never mistaken for a new one).

| Case | Request | New log lines vs. the pre-edit tree |
|---|---|---|
| empty | `GET /api/portal?__imk_route=` + `x-imk-route: /api/portal/session` | **exactly 1** |
| empty-admin | `GET /api/admin?__imk_route=` + `x-imk-route: /api/admin/session` | **exactly 1** |
| valid | `GET /api/portal?__imk_route=%2Fapi%2Fportal%2Fcomments` | **0** |
| absent | `GET /api/portal` (no carrier at all) | **0** |
| absent-hdr | `GET /api/portal` + `x-imk-route: /api/portal/session` | **0** |

The one new line, in both families:

```json
{"ts":1792676342191,"outcome":"empty_route_carrier","reason":"empty_route_carrier","entry":"/api/portal","method":"unknown"}
```

Additional assertions, all passing:

- The new line is JSON and carries `ts` (a number), `outcome` and `reason` both
  `empty_route_carrier`, `entry` naming the entry point (`/api/portal`, `/api/admin`), and a `method`.
- **Nothing sensitive in the line.** The triggering request carried
  `cookie: imk_session=SECRETCOOKIEVALUE`, `x-secret-header: SECRETHEADERVALUE`,
  `x-imk-route: /api/portal/session` and the query parameter `__imk_route`. None of those strings
  appears in the log line — asserted, not assumed.
- **The responses are unchanged:** the empty carrier still answers `404 {code:'not-found'}`, the session
  handler still does NOT run (no `unauthorized` anywhere in the output), and the bare entry point with
  no carrier still answers the loud `500 {code:'route-resolution'}`.

### The one gap, stated plainly: `method` reads `'unknown'` in the shipped tree

The brief asks for "the request method". The resolver is a function over strings — it never receives
the request object — and `api/**` is explicitly outside my file boundary this wave. So the method
cannot be known inside the router without a call-site change.

I solved this the only way that keeps the boundary and still delivers a real method: `resolveRoute`
now takes an **optional** fifth parameter, `method: string = 'unknown'` (`portal-router.ts:190-201`).
Every existing caller keeps working unchanged — which is why `typecheck:api` is green and all 12
harnesses and 18 QA suites pass untouched.

The seam is proven working by execution, not asserted: the probe also runs a TEMP copy with the two
Vercel call sites patched to pass `req.method`, and in that copy the line reads
`"method":"GET"` while the refusal itself is unchanged.

**The one-word fix that makes it real in production** (NOT applied — `api/**` is outside my boundary
this wave, and the brief says F-2 is one log line):

- `api/portal.ts:125-130` — `resolveRoute(rawUrl, carrierOf(req, url), PORTAL_FAMILY_PREFIX, PORTAL_FAMILY.routes)`
  becomes `... PORTAL_FAMILY.routes, req.method)`.
- `api/admin.ts:106-111` — the same one word.

That is the whole change: two call sites, one word each, no signature break for any other caller. It is
a one-minute follow-up for whoever owns `api/**` next; I have left it undone on purpose and am flagging
it rather than reaching outside my files.

---

## F-3 - the 14 mojibake em-dashes in the Cloudflare auth file are repaired

### The change

`site/functions/api/portal/auth.ts` — each of the 14 sequences `U+00E2 U+20AC U+201D` (the UTF-8
em-dash decoded as cp1252) is replaced by ONE proper em-dash `U+2014`.

**The edit was done at the BYTE level, with Node, not with a text round-trip.** The file was read as a
Buffer, the 8-byte sequence `c3 a2 e2 82 ac e2 80 9d` was replaced with the 3-byte `e2 80 94`, and the
result was written as a Buffer. No decoding step ever touched the other bytes, so no BOM, no line
ending and no unrelated character can have moved.

The 14 sites are all inside `//` or `*` comment lines (lines 1, 2, 3, 4, 40, 60, 92, 125, 126, 128,
130, 428, 458, 488) — verified programmatically, so this is a comment-text-only change.

Line 1 now reads, byte for byte:

```
// site/functions/api/portal/auth.ts — Cloudflare Pages Function.
```

### The numbers

| | before | after |
|---|---|---|
| bytes | 19414 | **19344** (−70) |
| mojibake sequences (U+00E2 U+20AC U+201D) | 14 | **0** |
| U+FFFD replacement characters | 0 | **0** |
| proper em-dashes (U+2014) | 1 | **15** (1 pre-existing + 14 restored) |
| BOM | none | **none** |
| CRLF / LF | 43 / 506 | **43 / 506** (unchanged) |
| SHA-256 | `bebcfb14c6228aaf3840754162d4db2d5b3d90cc2a76d7e31f51b7fbb160d938` | `b34a47b5b2d2e7e441580cc12cfcece9f88ced206f3b3478a90f71162fc338a1` |

**A correction on the brief's byte arithmetic.** The brief predicted "-28 bytes (3 bytes -> 1 byte)". The
mojibake sequence is **8** UTF-8 bytes (`c3 a2` + `e2 82 ac` + `e2 80 9d`), not 3, and the em-dash is
**3** bytes, not 1. So the true delta is 14 x (8 − 3) = **−70 bytes**, which is what the file shows.
The −28 figure would be right for a latin-1-encoded em-dash; in UTF-8 the em-dash is 3 bytes. The
file is UTF-8 (it decoded cleanly with 0 U+FFFD before the edit), so −70 is the correct number.

### The inverse-replacement proof (the wave-13 incident did not repeat)

`C:\Users\Kalch\AppData\Local\Temp\opencode\wave16b\wave16b-f3-proof.mjs` — **8 checks, 8 pass**:

1. The shipped file has **zero** mojibake sequences and **zero** U+FFFD.
2. The shipped file has the **15** proper em-dashes and is BOM-free.
3. **Forward substitution:** applying the mojibake -> em-dash substitution to the PRE-EDIT snapshot
   reproduces the shipped file **byte for byte** (SHA-256 `b34a47b5…` = the shipped file). So the edit
   changed the 14 sequences and *nothing else* — not the BOM, not the line endings, not one unrelated
   byte.
4. **Inverse substitution:** applying em-dash -> mojibake at the 14 recorded offsets to the shipped
   file reproduces the PRE-EDIT file **byte for byte**, SHA-256 `bebcfb14…` on both sides.

Point 4 is the one that matters: the bytes that come back are exactly the bytes that were there
before, so the wave-13 ANSI round trip was not repeated. The inverse is applied **positionally** at the
14 recorded offsets, because the file already contained one legitimate em-dash (line 200) that must not
be turned back into mojibake — a naive global reverse would corrupt it.

---

## F-4 (report only) - the extra Cloudflare route at /api/portal/auth

**It is reachable, and it serves nothing.**

`C:\Users\Kalch\AppData\Local\Temp\opencode\wave16b\wave16b-f4-probe.mjs` — **9 checks, 9 pass**:

- Cloudflare Pages routes a Pages Function **by its file path**, so
  `site/functions/api/portal/auth.ts` **is** deployed as the URL `/api/portal/auth`. The three real
  sign-in files sit beside it (`auth/logout.ts`, `auth/request-link.ts`, `auth/verify.ts`), so the file
  has no Vercel counterpart at all: `api/portal/auth.ts` does not exist (it was removed in wave 13) and
  `api/portal/auth/` holds only the three real files.
- The route table does **not** name `/api/portal/auth` (not in `standalone`, not in either family).
- **What it answers: nothing.** Executing the CF handler bundle directly:
  - `GET /api/portal/auth` -> `404 {code:'not-found'}`
  - `POST /api/portal/auth` -> `404 {code:'not-found'}`
  - (the real URLs still work: `POST /api/portal/auth/logout` -> `200 {ok:true}`, and
    `GET …/verify` / `POST …/request-link` -> `500 {code:'internal'}` only because that sandbox had no
    secrets configured).
- **The deploy gate cannot see it.** `check-api-routes.mjs` walks the route table -> files; it never
  walks files -> table. Executed: the gate exits 0 and never mentions `/api/portal/auth`.

So the finding stands as the audit wrote it: an extra, undocumented, **inert** URL on the Cloudflare
target. It grants no capability a client could not already reach, it does not weaken the sign-in door,
and it is invisible to the deploy gate. I have changed nothing about it, as instructed.

---

## Gates (all executed by me, on the tree as it stands now)

| Gate | Result |
|---|---|
| `npm run typecheck:api` | **exit 0** |
| `npm run check:routes` | **16 route(s), 0 missing**; api/ holds 7 .ts files; 11 rewrites agree with the route table; every table route is served by its entry point's HANDLERS map |
| `npm run test:store` | **72 pass / 0 fail** |
| 12 repo-root harnesses | **all green, 306 checks, 0 failures** |
| QA runner (`powershell -NoProfile -ExecutionPolicy Bypass -File site\qa\run-all-suites.ps1`) | **18 suites, every exit code 0**, transcript `site/qa/artifacts/qa-full-run-2026-10-22-164020.txt` |
| `backend-wave15-empty-carrier-harness.mjs` (re-run after my edit) | **17 passed, 0 failed, 17 checks** |
| `site/qa/qa-wave13-routing.mjs` (re-run after my edit) | **19 checks, 19 PASS, 0 FAIL** |
| `site/data` untouched | `site/data/moderation/reviews.jsonl` = **0 bytes**, SHA-256 `e3b0c442…` (the empty-string hash); **no** `site/data/portal/` |
| git write commands | **none** (read-only `git status` / `git diff` only) |

**No QA expectation broke.** The 39 `FAIL` strings inside the transcript are the mutation probes'
*expected* output ("M1, M2 must FAIL", "all failing checks: M1, M2, M4, M4b, M5") — the probes
deliberately break the product in a sandbox copy and require the checks to go red. Every suite's own
exit code is 0.

The 306 checks break down as: 22 + 23 + 42 + 22 + 24 + 17 + 24 + 35 + 11 + 57 + 16 + 13.

---

## Judgement calls, reported not hidden

1. **`method` reads `'unknown'` in the shipped tree** (F-2). Explained in full above. The fix is one
   word at each of two call sites in `api/**`, which is outside my file boundary this wave. I did not
   reach outside it.
2. **The token is in BOTH `outcome` and `reason`.** The brief's requirement list attaches
   `empty_route_carrier` to `reason`; its acceptance list says "containing outcome 'empty_route_carrier'".
   Rather than pick one and risk failing the other, the line carries it in both fields, and the code
   comment says why. A log query on either field name finds the refusal.
3. **The router's header comment was corrected.** It claimed the module was "a pure function over
   strings". After adding one `console.log` that claim is false, so I corrected it (one paragraph). The
   wave-14 harness's A4 assertions on that header still pass (24/24).
4. **The two probes live in TEMP, not in the repo.** The brief pins the repo-root harness count at 12
   and the check total at 306; a 13th file would have made both numbers wrong. The proofs are
   re-runnable from `C:\Users\Kalch\AppData\Local\Temp\opencode\wave16b\`.
5. **The `-70` byte delta vs. the brief's `-28`.** Explained above: the mojibake is 8 UTF-8 bytes and
   the em-dash is 3.
6. **F-4 changed nothing.** Report only, as instructed.

---

## Still UNVERIFIED (nothing here was observed on a live target)

- **No Vercel router has ever been booted.** The merge order behind the wave-13 MAJOR-1 is still
  unobserved, and — bigger — **it is still unproven that the `vercel.json` rewrites fire at all.** If
  they do not, the portal answers 404 on launch while every offline gate above stays green. This is
  unchanged by my work and is still the one open launch risk. The exact preview-deploy + 3 curl commands
  are in `audit-wave15-2026-10-22.md` §8.
- **No preview, deploy or production request** of any kind was made by me.
- **No workerd**: the Cloudflare runtime was never booted. My F-4 answers come from executing the CF
  handler bundle in Node, not from workerd.
- **No real Turso**: the libSQL proof remains the offline SQLite-over-the-wire-protocol one.
- **No live mail**: nothing was sent.
- **The `method` field is unverified in production** — it reads `'unknown'` until the `api/**` call
  sites pass `req.method` (proved to work in a TEMP copy, not in the shipped tree).
- The log line's shape in a real Vercel function log was not observed (no deployment); only its shape
  as emitted by the bundled entry point in Node.

## Files I own and changed

- `site/shared/portal-router.ts` — sha256 `71b688f2d9b8e6739ea66daa84662a3566d3ce0736f830cf6977abe52ef18629`
- `site/functions/api/portal/auth.ts` — sha256 `b34a47b5b2d2e7e441580cc12cfcece9f88ced206f3b3478a90f71162fc338a1`
- this report
