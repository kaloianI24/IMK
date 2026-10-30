# Wave 17 — backend: the empty-carrier log line now carries the real HTTP method

**Status: DONE.** 2026-10-22 · Backend Developer · repo `C:\Users\Kalch\Documents\IXI`
(branchless, permanently dirty shared tree — **no git write command was run**).

The gap wave 16b flagged on itself is closed: the resolver's refusal log line
now says `GET` or `POST` instead of always `unknown`.

---

## 1. What changed

**Exactly two call sites. Nothing else.**

| File | Line | Change |
|---|---|---|
| `api/portal.ts` | 130-136 | `resolveRoute(rawUrl, carrierOf(req, url), PORTAL_FAMILY_PREFIX, PORTAL_FAMILY.routes, req.method)` — the request's method is now the 5th argument |
| `api/admin.ts` | 111-117 | `resolveRoute(rawUrl, carrierOf(req, url), ADMIN_FAMILY_PREFIX, ADMIN_FAMILY.routes, req.method)` — the same |

A four-line comment above each call explains why the method is passed and that
the parameter is optional.

The resolver was **not** touched. `site/shared/portal-router.ts:196-202` already
declared the optional 5th parameter with its `'unknown'` default, and
`site/shared/portal-router.ts:238-246` already logged it. Wave 16b built the
seam and stopped at its own file boundary; wave 17 wires it.

### What did NOT change (verified by execution, not by reading)

- the resolver's signature and its `'unknown'` default (`portal-router.ts:201`)
- the 404 body/status of the empty-carrier refusal
- the check order (path → carrier → header)
- the header fall-through (still consulted only when the query parameter is genuinely ABSENT)
- the family containment (`isInsideEntry`)
- the carrier STRIP from the URL the handler sees
- the loud `500 {code:'route-resolution'}` for a bare entry point
- `carrierOf` in both files
- the three repo-root harnesses that call `resolveRoute` with FOUR arguments
  (`backend-wave13-function-budget-harness.mjs:204`,
  `backend-wave14-carrier-containment-harness.mjs:220`,
  `backend-wave15-empty-carrier-harness.mjs:217`) — the 5th parameter stays
  optional, and all three still pass.

---

## 2. Proof by execution

The probe lives in TEMP so the repo-root harness count stays at 12 and the
check total at 306:

```
C:\Users\Kalch\AppData\Local\Temp\opencode\wave17\probe.mjs
```

It builds a sandbox copy of `api/` + `site/shared/`, bundles the entry points
with esbuild, drives them as real requests in a child process, and reads the
product's `console.log` output off the child's stdout.

**Result: 18 passed, 0 failed, 18 checks.**

| # | Check | Result |
|---|---|---|
| A1 | a **GET** with `?__imk_route=` → exactly one log line, `method:"GET"` | PASS — `1 line, method=GET, entry=/api/portal` |
| A2 | a **POST** with `?__imk_route=` → exactly one log line, `method:"POST"` | PASS — `1 line, method=POST` |
| A3 | the **admin** entry point, GET → `method:"GET"`, `entry:/api/admin` | PASS |
| A4 | the **admin** entry point, POST → `method:"POST"` | PASS |
| A5 | a **DELETE** → `method:"DELETE"` (not only GET/POST) | PASS |
| B1 | the **pre-wave-17 tree** (the 5th argument removed) logged `method:"unknown"` — the gap was real | PASS |
| B2 | the shipped tree logs the **same number of lines** — only the field changed: `1 line before, 1 line after; method unknown -> GET` | PASS |
| C1 | a **valid** carrier → 200 and **zero** log lines | PASS |
| C2 | an **absent** carrier → 500 `route-resolution` and **zero** refusal lines | PASS |
| C3 | a valid carrier through the **header** (query absent) → 200, zero refusal lines | PASS |
| D1 | the empty carrier still answers **404 `{code:'not-found'}`** on both entry points; the handler never ran | PASS |
| D2 | the bare entry point still answers a **LOUD 500 `{code:'route-resolution'}`** on both | PASS |
| E1 | the line carries **no** carrier value, header, cookie, token or body value | PASS — the line is exactly `{"ts":…,"outcome":"empty_route_carrier","reason":"empty_route_carrier","entry":"/api/portal","method":"POST"}` |
| E2 | the logged line has exactly the five intended fields | PASS — `entry,method,outcome,reason,ts` |
| F1 | removing the method at the **portal** call site → A1 goes RED | PASS — mutant logs `unknown`, control logs `GET` |
| F2 | removing the method at the **admin** call site → A3 goes RED | PASS — mutant logs `unknown` |
| F3 | **hard-coding** `'GET'` at the portal call site → A2 goes RED | PASS — the mutant answers `GET` for a POST, the control answers `POST` |
| G1 | **liveness**: a renamed anchor makes the mutation ABORT loudly instead of passing silently | PASS |

### The non-vacuity argument, explicitly

F1–F3 are the reason this is evidence and not a tautology:

- **F1** removes the 5th argument → the log line says `unknown` again → A1 fails.
- **F3** hard-codes `'GET'` → a POST is logged as `GET` → A2 fails. This is the
  check that would not bite if it only asserted "the method is not unknown".
- **G1** renames the anchor the mutations patch → `patchFile` throws
  `the mutation anchor was not found …`, so a future drift of the call site
  makes the probe abort loudly rather than silently stop mutating.

B1/B2 are the differential: the pre-wave-17 tree (the same tree with only the
5th argument removed) is built and run side by side with the shipped tree.
Both log **one** line on the empty carrier; the only difference is
`method:"unknown"` → `method:"GET"`. So wave 17 added no line, dropped no line,
and changed exactly one field.

### The E-check in detail

The request that produced the log line carried:

- `x-imk-route: SECRETHEADERVALUE`
- `cookie: imk_session=SECRETCOOKIEVALUE`
- `authorization: Bearer SECRETTOKENVALUE`
- body `SECRETBODYVALUE`

and the assertion scans the raw log output for **nine** strings —
`SECRETCOOKIEVALUE`, `SECRETHEADERVALUE`, `SECRETTOKENVALUE`, `SECRETBODYVALUE`,
`imk_session`, `x-imk-route`, `__imk_route`, `authorization`, `cookie` — and
requires **none** of them to appear. E2 separately pins the field set to
exactly five keys, so no extra field can hide in the line.

Note that the header value used here is deliberately **not** a valid route:
the refusal happens before the header is consulted, and using a distinctive
string is what makes the leak assertion meaningful. The header-not-consulted
property itself is proven separately by D1 (the session handler would answer
`401`, not `404`).

---

## 3. The gates (all executed on the final tree)

| Gate | Result |
|---|---|
| `npm run typecheck:api` | **exit 0** |
| `npm run check:routes` | **16 route(s), 0 missing** · api/ holds **7** .ts files · 11 rewrites agree · every table route served by its entry point's HANDLERS map |
| `npm run test:store` | **72/72** (`# pass 72`, `# fail 0`) |
| the 12 repo-root harnesses | **all exit 0 — 306 checks** |
| `powershell -NoProfile -ExecutionPolicy Bypass -File site\qa\run-all-suites.ps1` | **18 suites, every exit 0** |
| `backend-wave15-empty-carrier-harness.mjs` | **17 passed, 0 failed, 17 checks** |
| `site/qa/qa-wave13-routing.mjs` | **19 checks: 19 PASS, 0 FAIL** |
| `site/data` untouched | `site/data/moderation/reviews.jsonl` **0 bytes**, SHA-256 `E3B0C442…B855` (the empty string), **no `site/data/portal/`** |
| git write command | **none** |

### The 12 repo-root harnesses, one by one

```
backend-f1-magic-token-harness.mjs          exit 0   22 checks
backend-review-fixes-harness.mjs             exit 0   23 checks
backend-wave10-store-integrity-harness.mjs   exit 0   42 checks
backend-wave13-function-budget-harness.mjs   exit 0   22 checks
backend-wave14-carrier-containment-harness.mjs exit 0 24 checks
backend-wave15-empty-carrier-harness.mjs     exit 0   17 checks
backend-wave6-harness.mjs                    exit 0   24 checks
backend-wave8-harness.mjs                    exit 0   35 checks
backend-wave8-moderation-m1-harness.mjs      exit 0   11 checks
backend-wave8-session-endpoint-harness.mjs   exit 0   57 checks
backend-wave9b-admin-inbox-store-harness.mjs exit 0   16 checks
backend-wave9-store-wiring-harness.mjs       exit 0   13 checks
                                            total    306 checks
```

The count is still **12 files / 306 checks** — the new probe was NOT added to
the repo root, by instruction.

### The QA runner

Transcript: `site/qa/artifacts/qa-full-run-2026-10-22-170826.txt` (the runner's
own file). **18 suites, every exit 0**, 25/25 anchor proofs green. The
wave-13 routing suite's R11 (the empty carrier is a clean 404) and its
mutation probes MP-R6/MP-R7 are unchanged and green; the wave-14 and wave-15
suites are green.

### Encoding of the two edited files

Measured by bytes with Node (no PowerShell `Get-Content`/`Set-Content` round
trip):

| File | bytes | U+FFFD | em-dashes | BOM | CRLF | LF |
|---|---|---|---|---|---|---|
| `api/portal.ts` | 7288 | **0** | 2 | no | 0 | 190 |
| `api/admin.ts` | 5755 | **0** | 2 | no | 0 | 166 |
| `site/shared/portal-router.ts` (untouched) | 13303 | **0** | 4 | no | 0 | 304 |

The em-dash counts are unchanged from the wave-16b measurement (2 and 2) — my
comment is pure ASCII, so nothing was added or lost.

File hashes after the edit: `api/portal.ts` sha256 `5A3488CFD2292394…`,
`api/admin.ts` sha256 `87387B04B54CC761…`.

---

## 4. What the fix is worth

Before wave 17 the refusal line read:

```json
{"ts":…,"outcome":"empty_route_carrier","reason":"empty_route_carrier","entry":"/api/portal","method":"unknown"}
```

After:

```json
{"ts":…,"outcome":"empty_route_carrier","reason":"empty_route_carrier","entry":"/api/portal","method":"POST"}
```

The `method` field is the one thing that tells an operator **which kind of
request** produced the stray empty carrier. A `GET` with a stray empty carrier
is a misconfigured rewrite or a stale bookmark; a `POST` is a client or proxy
appending the parameter to a write. Before, both looked identical.

---

## 5. Unverified — stated, not hidden

- **No Vercel router has ever been booted.** Whether the `vercel.json` rewrites
  fire at all is still the open launch risk, and this wave does not touch it.
- No preview, deploy or production request was made.
- No `workerd` was booted; the Cloudflare tree was not exercised by this wave
  (it has no carrier surface — the CF entry points never call `resolveRoute`).
- No real Turso database was contacted; `test:store` proves the libSQL half
  against a local SQLite engine over the real wire protocol.
- No live mail was sent.
- The platform's query-merge order (client query vs. rewrite `__imk_route`) is
  still unobserved.
- The probe exercises the entry points as bundled Node handlers with a
  synthetic `IncomingMessage`; it is not a real HTTP request over a socket and
  it is not a platform request.
- The transcript pins a **tree**, not a commit — the shared tree is permanently
  dirty and no git write command was run.

---

## 6. Files changed

| File | Change |
|---|---|
| `api/portal.ts` | +1 argument at the `resolveRoute` call (line 135) and a 5-line comment |
| `api/admin.ts` | +1 argument at the `resolveRoute` call (line 116) and a 5-line comment |
| `backend-wave17-method-wiring-2026-10-22.md` | this report (new) |

Nothing else in the repository was edited. The probe and its sandboxes are in
`%TEMP%\opencode\wave17\`.
