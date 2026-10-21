# Independent re-audit — wave 4 (route table + deploy root)

**Auditor:** Code Reviewer — Independent Audit (Principal Code Reviewer)
**Date:** 2026-10-20
**Scope:** the wave-4 diff — `spec/08-portal-mvp.md` §4.8 + §10.4 (Revision 5)
**Requested by:** @Backend Developer
**Repo:** `C:\Users\Kalch\Documents\IXI` (site at `site/`, Vercel handlers in `api/`, Cloudflare twins in `site/functions/`)
**Method:** read-only inspection of the real files + **executed** evidence in a sandbox outside the repo
**Repo state on completion:** unmodified — `git status` 128 entries (unchanged), `site/data/portal/` still absent, `site/data/moderation/reviews.jsonl` still 0 bytes

---

## Verdict

**DONE — 3 MAJOR, 6 MINOR, 5 INFO. No CRITICAL.**

The route table now exists and is complete: `npm run check:routes` reports **13 routes, 0 missing function files, exit 0** in both trees (executed). The deploy-root configuration is coherent. **The `req.query.id` fallback does not bypass ownership** — cleared with evidence.

But **wave 4 did not close F-1. It changed the symptom.** The sign-in door was unreachable on the deployed target because no function file sat behind `/api/portal/auth/request-link`; the files now exist — and on the deployed target they still cannot succeed, because the auth handler keeps its magic-token table in **module scope**, and wave 4 split that handler into **separate per-route function files**. Vercel builds one function per file, so the token minted by `request-link` lives in a different JavaScript heap from the one `verify` reads. I reproduced this by execution against the real handlers.

Two other MAJORs: the same module-state defect breaks every authenticated call (sessions), and the Vercel moderation endpoint throws an unhandled exception when the store cannot be written — where the Cloudflare twin answers a clean `500 {code:'storage'}`.

**The one-line root cause of F-1 and F-2: the portal's state is in-process, and the deploy target is a multi-function, multi-instance, stateless platform.** T4 (the store) does not fix that by itself: it fixes the *data*, not the *session/token*. Both need to move, or the portal needs to be one function.

---

## Findings

### F-1 · MAJOR — the sign-in door still cannot succeed on the launch target (wave-4 scope)

**Where:** `api/portal/auth/request-link.ts`, `api/portal/auth/verify.ts` (new), `api/portal/auth.ts:57-63` (`magicTokens`), `api/portal/auth.ts:146-171` (`validateMagicToken`)

**What happens.** `api/portal/auth.ts` keeps the single-use magic-link table in module scope:

```ts
const magicTokens = new Map<string, { email; purpose; expiresAt; used }>();
```

`validateMagicToken()` verifies the HMAC and then looks the token up in that map; a token that is not in the map is rejected as invalid. Wave 4 made `request-link` and `verify` **separate source files**, each re-exporting the same handler:

```ts
// api/portal/auth/request-link.ts
export { default } from '../auth.js';
```

Vercel deploys **each file under `api/` as its own function**, and each function gets its own bundle — therefore its own copy of `magicTokens`. The token minted in the `request-link` function is invisible to the `verify` function. Every sign-in link the owner mails to a client fails with `400 {code:'invalid'}`.

**Evidence (executed).** I bundled the real handlers with the repo's own esbuild and ran them against a sandbox store:

```
A. ONE BUNDLE (local dev)      request-link=200 verify=200
B. SEPARATE BUNDLES (Vercel)   request-link=200 verify=400 invalid "link expired or invalid"
   token minted by request-link: yes (len 183)
```

The only difference between A and B is **how the handlers are bundled** — which is exactly the difference between `site/scripts/dev-portal.js` (one bundle) and a Vercel deployment (one bundle per file). The token was minted successfully; the verify function simply could not see it.

**The repo already documents this invariant**, in `site/scripts/api-index.ts`:

> "Bundling every handler from ONE entry point guarantees they share a single bundled `session.js` module — and therefore one in-memory `sessions` Map — which the magic-link flow relies on (verify creates a session, projects reads it). **Bundling each handler separately would give each its own `sessions` Map.**"

Wave 4 did exactly that, deliberately, to satisfy the file-path routing rule.

**Platform confirmation.** Vercel's Node.js runtime docs state: *"Vercel creates a separate function for each supported source file in the root `api/` directory. Avoid creating a separate function for each API endpoint. Keep related routes in a shared function so Fluid compute can reuse instances across routes and Vercel builds fewer functions."*

**Impact.** No client can sign in on the launch target. Before wave 4 the route did not exist (`404`); now it exists and always fails (`400 invalid`). Either way F-1 is open — and it is the exact defect class the wave was chartered to close ("works locally, 404 in production").

**Fix (pick one).**
1. **Serve the whole portal API from one function.** Add `api/[[...path]].ts` (or `api/index.ts` + `rewrites` in `vercel.json`) that routes by pathname — the pattern Vercel's own docs recommend for exactly this reason ("define a single `fetch` handler that receives requests for all HTTP methods and routes them by URL pathname … configure `rewrites` to send related API paths to the same function"). One function = one module instance = shared `magicTokens` **and** shared `sessions`, and it also closes F-2 and the instance-reuse problem.
2. **Make the magic link stateless**, the way the moderation link already is: `api/lib/notifications.ts` proves the pattern — the signature is recomputed from the secret and the parameters, no server-side state. For the magic link, keep the HMAC and move the single-use marker into the store T4 will provide.

Until one of those lands, the portal cannot authenticate a single client in production.

---

### F-2 · MAJOR — the session table is per-function too: every authenticated call 401s

**Where:** `api/portal/session.ts:20` (`const sessions = new Map<string, SessionEntry>()`), consumed by `resolveSession()`

**What happens.** Same root cause as F-1, different map. `createSession()` writes into the module-scope `sessions` map of whichever function handled `/api/portal/auth/verify`; every other function (`projects`, `plan-items`, `updates`, `comments`, `testimonials`) has its own copy and resolves the cookie to nothing → `401 {code:'unauthorized'}`.

**Evidence (executed).** Same harness, cookie minted by the auth bundle, presented to the projects bundle:

```
A2. cookie -> other bundle     GET /api/portal/projects = 401 unauthorized
```

This one is **pre-existing** (the split into `projects.ts` / `plan-items.ts` / … always existed) — but it is the same blocker, and it is invisible locally for the same reason: `api-index.ts` bundles everything into one module graph.

**Note.** The Cloudflare twin (`site/functions/api/portal/session.ts`) stores its maps on `globalThis`. That helps only **within one isolate**; separate Pages Functions are separate isolates, so the twin has the same defect. It is not a fix.

**Fix.** Same as F-1 option 1 (one function), or a session store with T4. Note that the header comment in `api/portal/session.ts` calls this a "documented limitation" — it is documented, but it is not a limitation that a portal can ship with on the launch target.

---

### F-3 · MAJOR — the Vercel moderation endpoint throws an unhandled error where the Cloudflare twin answers cleanly

**Where:** `api/moderate/review.ts` (`writeReviews()`, and its call site) vs `site/functions/api/moderate/review.ts` (`writeReviews()` → `false` → `500 {code:'storage'}`)

**What happens.** The edge twin was hardened in wave 4 (D-1): a store that cannot be written answers `500 {code:'storage'}`, never "approved". The Vercel tree was not:

```ts
// api/moderate/review.ts — no try/catch
function writeReviews(reviews) {
  fs.mkdirSync(REVIEWS_DIR, { recursive: true });
  fs.writeFileSync(REVIEWS_FILE, content, 'utf8');
}
```

`guardStorage()` only owns `StorageCorruptError`; anything else is re-thrown (`site/shared/portal-store/jsonl.ts`). So a failed write escapes the handler as an unhandled rejection.

**Evidence (executed).** Same input, same broken store, two trees — the read-only filesystem is fault-injected on the store path (`EROFS`), which is what a Vercel function filesystem actually is (DEPLOY.md §1.3):

```
VERCEL    -> THREW OUT OF THE HANDLER: EROFS …  responded? NO RESPONSE AT ALL
CLOUDFLARE-> 501 {"error":"moderation store unavailable on this target","code":"unimplemented"}
```

**Two separate divergences for the same input:**

| Input | Vercel tree | Cloudflare tree |
|---|---|---|
| store cannot be **written** | unhandled throw → no response / opaque 500 | `500 {code:'storage'}` |
| store cannot be **reached** (file missing) | `404 {code:'not-found'}` "review not found" | `501 {code:'unimplemented'}` |

The second row is the important one: §4.8.4 states as a general rule that *"a store that cannot be reached → 501 unimplemented, never 404 review not found"* — but that rule was implemented **only in the edge twin**. On the launch target, a missing store file is an empty store (`readJsonlFile` treats a missing file as a fresh install), so the owner's approve link answers **"review not found"** — the "my quote is gone" outcome that D-1 was raised to eliminate.

**Impact.** On the launch target the owner's one-click approval cannot succeed: the write throws (or the record is not found), the request dies with an opaque error, and the quote stays `pending`. Worse, the recovery path is asymmetric: a **stale revision** mails the owner a fresh link, a **failed write** does not — so the owner is stuck with a dead link.

**Fix.**
- Wrap the write: `try { writeReviews(reviews) } catch { … 500 {code:'storage'} }` — parity with the twin.
- Apply the same "store unreachable" rule to the Vercel tree (a missing store file in a deployed environment is an unreachable store, not an empty one) — or, better, make the store path explicit (`PORTAL_DATA_DIR`) instead of cwd-derived, and treat "configured path absent" as `501/500`, never as "not found".
- Mail a fresh link on a write failure too, so the owner is never left with a dead link.

---

### F-4 · MAJOR — the file counter is abandoned for the life of the process on any error other than `EEXIST`, silently

**Where:** `api/lib/rate-limit.ts` (`withFileLock()`, `RateLimiter.consume()`)

**What happens.**

```ts
try { fd = fs.openSync(lockPath, 'wx'); }
catch (err) {
  const code = err.code;
  if (code !== 'EEXIST') throw err;      // ← everything else is "the backend is broken"
  …
}
```

On Windows, a lock file whose handle was closed while the file is delete-pending makes the next `openSync(..., 'wx')` fail with **`EPERM`** — a transient, normal condition. It is re-thrown, and `RateLimiter.consume()` catches it:

```ts
} catch {
  this.backendFailed = true;     // ← permanent for the lifetime of the process
  count = await this.fallback.hit(key, windowMs);
  degraded = true;
}
```

From that moment the durable counter is abandoned; every later request is counted **in this process only**, so the cross-process limit stops being enforced — exactly the guarantee the file backend was added to provide.

Two aggravating details:

- **The degradation is invisible.** The `catch {}` has no logging, and `degraded: true` is returned to the caller but **no caller inspects it** (`api/portal/testimonials.ts`, `api/portal/auth.ts` and the twins all ignore the flag). The module's contract says *"reports `degraded: true`"* — in practice nothing reports it, and the counter file silently stops being written.
- This is **QA's D-3**, still open in this diff. I confirm the mechanism from the code; QA measured the loss (2 of 8 rounds, 80 of 1280 buckets).

**Edge twin — cleared.** `site/functions/api/lib/rate-limit.ts` uses KV, has no file lock and no `EEXIST` classification, so it does **not** carry this defect. Its `backendFailed` latch behaves the same way, but a KV failure is a genuine backend failure, and the degradation is at least visible in the code.

**Fix.** Treat `EEXIST`, `EPERM`, `EACCES` and `EBUSY` as *busy → retry*, not as *backend broken*; use a `mkdir` lock (atomic on every platform) instead of `open(O_EXCL)`; and **log the degradation once** with the underlying error code, so a silently-disabled counter is visible in the logs.

---

### F-5 · MINOR — the stale-lock break has a time-of-check/time-of-use hole

**Where:** `api/lib/rate-limit.ts` (`withFileLock()`)

A holder whose lock is older than 30 s is broken by another process (`unlinkSync` → `continue`). But the original holder's `finally` block unlinks the lock path **unconditionally** — so it deletes the *new* holder's lock, and a third writer can enter the critical section. Two writers then interleave their read-modify-write and counts are lost.

Related: `LOCK_STALE_MS` (30 s) is six times `LOCK_TIMEOUT_MS` (5 s), so a legitimate holder that runs longer than 30 s has its lock stolen. The critical section is a small file RMW, so this is not reachable today — but the two constants should be ordered so the stale age is comfortably above the timeout, and the break should be done by re-creating the lock rather than by unlinking someone else's file.

---

### F-6 · MINOR — the route manifest check proves *file existence*, not *behaviour* — which is why F-1 passed it

**Where:** `site/scripts/check-api-routes.mjs`

The check is a good idea and it works (13/13, exit 0, executed). But it answers one question only: "does a `.ts` file exist at this path in both trees?" It cannot see:

- **that the function can succeed.** Every wave-4 route file is a one-line re-export of a handler whose behaviour depends on in-process state; the check is happy with all of them. F-1 and F-2 are invisible to it.
- **that the two trees behave alike.** The Cloudflare portal is a stub that answers `501`; the manifest is satisfied by a stub.
- **that the handler's own pathname switch matches the deployed path.** The check verifies the file, never the route the file serves.

Other blind spots I found in the scanner:

- The quoted-string regex pairs an apostrophe in prose with the next quote. QA already flagged this for `login.astro` ("we'll send a one-time sign-in link"); a route named between two such quotes is swallowed. My own scan of `site/src` (10 `/api/...` call sites) did not hit it today, but it is a latent hole.
- A route that exists **only in an e-mail** is invisible unless the path literal happens to be in the source. The moderation link is covered today only because `api/lib/notifications.ts` builds the URL from a literal — that is luck, not design.
- The dynamic-segment matcher accepts **any** `[param].ts` in the directory and ignores the parameter name, so `[projectId].ts` would satisfy a call to `/projects/<id>` whose runtime parameter is `id`.

**Fix.** Keep the manifest check, and add an **executed** route-contract check: bundle every route file as its own entry (exactly as a deploy target would), issue one request per route, and assert that the request reaches the handler — not just that a file exists. That check would have caught F-1 on the day it was written.

---

### F-7 · MINOR (unverified risk) — the data paths depend on `process.cwd()` being the repo root in production

**Where:** `api/portal/*.ts`, `api/moderate/review.ts` (`path.resolve(process.cwd(), 'site/data/…')`), asserted in `site/scripts/dev-portal.js`:

> "The Vercel handlers resolve `site/data/portal` from `process.cwd()`, which **in production is the repo root**."

That is an assumption in a comment, not a verified fact. In Vercel's function runtime the working directory is the **function's task directory**, not the project root; and `site/data/portal/` is gitignored, so it is not deployed at all. If the assumption is wrong:

- a read finds no file → `readJsonlFile` treats a missing file as an **empty store** → `GET /api/portal/projects` answers `200` with an empty list ("no projects") — the M3/D3 silent-outage class re-entering through the deploy target;
- the moderation endpoint answers `404 "review not found"` (F-3, second row).

**I could not verify this** — no Vercel token, no `vercel dev`, no preview deploy (same wall QA hit). **Verification is cheap:** one preview deploy that logs `process.cwd()`, or `vercel dev` locally.

**Fix (do this regardless of the answer):** stop deriving the data path from `cwd`. Make it an explicit env var (`PORTAL_DATA_DIR`) with a documented default, so the deployed path is a configuration fact rather than an inference. T4 removes the dependency entirely.

---

### F-8 · MINOR — DEPLOY.md §1.3 describes the launch-target behaviour inaccurately

**Where:** `DEPLOY.md` §1.3 ("Known blocker — the portal cannot run on Vercel yet")

The document says the portal *"answers a storage error"* on Vercel. The code does not do that:

| Operation on Vercel | Actual answer |
|---|---|
| read (`projects`, `testimonials`, …) | `200` with an **empty collection** (missing file = empty store) |
| write (`PATCH`, `POST`, approve link) | **unhandled `EROFS`** → opaque 500 (F-3) |
| moderation approve | `404 "review not found"` (F-3) |

"Answers a storage error" is the behaviour we want, not the behaviour the code has. DEPLOY.md is the document the owner will read before launch — it should say what actually happens, in the same plain language it uses elsewhere.

**Also check** the environment-variable table: `RESEND_TO` is listed as required, and the code reads `RESEND_TO || CONTACT_TO` (`api/lib/notifications.ts`) — worth naming both, so nobody sets one and wonders.

---

### F-9 · MINOR — the Node version in DEPLOY.md comes from a file Vercel does not read

**Where:** `DEPLOY.md` §1.1 ("Node.js version | 20.19.5 (`site/.node-version`)") vs the repo root `package.json` (`"engines": { "node": ">=20.3.0" }`)

`site/.node-version` is a CI/nvm hint — it is read by `actions/setup-node` (`node-version-file: 'site/.node-version'`), not by Vercel. The file Vercel reads is the **root** `package.json`'s `engines.node`, which is a floating range. Two consequences: the documented version is not the deployed version, and `">=20.3.0"` lets the deploy's Node change without a commit. Pin it (`"20.19.5"`) and correct the table.

---

### INFO — cleared, and small things worth knowing

| # | Item | Status |
|---|---|---|
| I-1 | **Route-file coexistence** (`api/portal/auth.ts` + `api/portal/auth/`; `projects.ts` + `projects/[id].ts`) | **Layout is legal.** A file `auth.ts` and a directory `auth` are different names in the same parent; Vercel deploys each file under `api/` as its own function, `[id].ts` is Vercel's documented dynamic-segment syntax, and `req.query` (with `req.query.id`) is a documented Vercel helper — so the by-id fallback has a real platform mechanism behind it. **But the layout is only harmless while the handlers are stateless, and they are not** (F-1, F-2). |
| I-2 | **`req.query.id` fallback vs. ownership** | **CLEARED.** The id source never decides access. `projects.ts` GET-by-id calls `projectAccessible()` (`project.clientId === session.clientId`) and answers `403` otherwise; the PATCH branch requires `session.role === 'admin'` → `403`. `plan-items.ts` PATCH calls `checkOwnership(item.projectId)` → `403`/`404`. Defensive nit: `projectAccessible` compares `undefined === undefined` → `true` for a project with no `clientId` when the session has none; a client session always gets a `clientId` at verify, so it is not reachable today — but add `!!session.clientId` so it stays unreachable. |
| I-3 | **Keys are still hashed before they reach the file** | **CLEARED.** `hashKey()` (SHA-256) is applied inside `createFileBackend().hit()` before the bucket id is written. |
| I-4 | **Magic-token `purpose` is not enforced** | `validateMagicToken()` returns `purpose` but `verify` never compares it to `'portal'`. Only one purpose exists today and the magic-link secret is separate from the moderation secret, so the risk is latent, not live. Worth one line when the token is refactored for F-1. |
| I-5 | **`api/portal/auth.ts` is still deployed** | It stays as the `/api/portal/auth` function, answers `404 {code:'not-found'}`, and is bundled **four times** (once alone, once into each of the three route files) — four copies of the token table, none of them shared. |

---

## Answers to the seven questions asked

1. **Does the route-file approach hold on both platforms, with `auth.ts` and `auth/` coexisting?** — *As a file layout: yes* (I-1): no filesystem conflict, `[id].ts` and `req.query.id` are Vercel's documented mechanisms. *As a state model: no* (F-1, F-2): splitting one handler across files splits its state, and Vercel's own docs recommend against one-function-per-endpoint for exactly that reason.
2. **Can a client reach a project that is not theirs through the `req.query.id` fallback?** — **No.** Ownership is decided by the session on every path (I-2). The id source is irrelevant to access. Cleared.
3. **The file lock: deadlock, stale locks, degradation, hashing?** — **No deadlock** (bounded by the 5 s timeout → degrade). **Stale handling is flawed** (F-5: TOCTOU on the break; stale age 6× the timeout). **Degradation is real but silent and terminal** (F-4: any error ≠ `EEXIST` disables the durable counter for the process, with no log). **Hashing is intact** (I-3). The edge twin does not carry the lock defect.
4. **Does the CF moderation path leak information, lose a decision, or diverge from the Vercel tree?** — **No leak**: the signature is checked before the store is touched, and the `501` comes before any ref lookup, so no ref enumeration. **Yes, it diverges** — in two places, both pointing the wrong way (F-3: unhandled throw vs `500 {code:'storage'}`; `501 unimplemented` vs `404 "review not found"`). **A decision can be lost**: on a failed write the owner's link is dead and no fresh link is mailed (the fresh-link recovery exists only on the stale-revision path).
5. **Route-manifest blind spots?** — **Yes** (F-6): it is a file-existence check, so it cannot see F-1/F-2; plus the prose-apostrophe hole, the e-mail-only route, the ignored dynamic parameter name, and the absence of any cross-tree behaviour comparison.
6. **Is the Vercel root-directory change coherent across `vercel.json`, the root `package.json`, the CI workflow and the data paths?** — **Mostly.** `vercel.json` (`framework: null`, `cd site && npm ci`, `cd site && npm run build`, `site/dist`), the dependency-free root `package.json`, and the CI job's `working-directory: .` are consistent with a repo-rooted project; the CI invariant check's `../api/contact.ts` / `functions/api/contact.ts` paths are correct under `working-directory: site`; the commented `npx vercel --prod --token` recipe is consistent with a repo-rooted project. **Two caveats:** the data paths depend on an unverified `process.cwd()` assumption (F-7), and the Node version in DEPLOY.md comes from a file Vercel does not read (F-9).
7. **Anything else wrong, unsafe or unverified?** — F-3, F-4, F-7 and F-8 above, plus the INFO items. Beyond §5 of `backend-wave4-2026-10-20.md`: the wave did not close F-1, it relocated it (F-1); the module-state assumption the repo itself documents was broken by the route split (F-1); and the Vercel moderation tree did not receive the CF tree's D-1 hardening (F-3).

---

## Recommended order

1. **F-1 + F-2** — one function for the portal API (or a stateless magic link + a real session store). Without this the portal cannot authenticate a client in production, whatever the route table looks like. This is the same wave-4 objective, restated.
2. **F-3** — try/catch the write in `api/moderate/review.ts`; make "store unreachable" answer the same way in both trees; mail a fresh link on a write failure.
3. **F-4 + F-5** — retry on `EPERM`/`EACCES`/`EBUSY`, log the degradation once, close the stale-lock TOCTOU.
4. **F-7** — one preview deploy to settle `process.cwd()`; then make the data path explicit. Also closes the "where does the store live" question that T4 has to answer.
5. **F-6** — add the executed route-contract check (bundle per file, request per route). It is the check that would have caught F-1.
6. **F-8, F-9** — correct DEPLOY.md.

---

## Files read / checked (no file in the repo was modified)

**New route files (both trees):** `api/portal/auth/{request-link,verify,logout}.ts`, `api/portal/projects/[id].ts`, `api/portal/plan-items/[id].ts`, `site/functions/api/portal/auth/{request-link,verify,logout}.ts`, `site/functions/api/portal/{projects,plan-items}/[id].ts`
**Handlers:** `api/portal/auth.ts`, `api/portal/session.ts`, `api/portal/projects.ts`, `api/portal/plan-items.ts`, `api/moderate/review.ts`, `site/functions/api/moderate/review.ts`, `site/functions/api/portal/auth.ts`, `site/functions/api/portal/session.ts`
**Libraries:** `api/lib/rate-limit.ts`, `site/functions/api/lib/rate-limit.ts`, `api/lib/jsonl.ts`, `api/lib/notifications.ts`, `site/shared/portal-store/jsonl.ts`
**Tooling / config:** `site/scripts/check-api-routes.mjs`, `site/scripts/dev-portal.js`, `site/scripts/api-index.ts`, `vercel.json`, `package.json` (root), `.github/workflows/ci.yml`, `.gitignore`, `DEPLOY.md`, `site/.node-version`
**Spec:** `spec/08-portal-mvp.md` §4.8, §10.4
**Client contract:** `site/src/pages/login.astro`, `site/src/pages/login/verify.astro`, `site/src/pages/portal.astro`, `site/src/components/PortalTestimonialPrompt.astro`, `site/src/pages/pricing.astro`, `site/src/pages/book.astro`

**Checks executed (not re-run: the behavioural suites belong to QA):**
- `node site/scripts/check-api-routes.mjs` → **13 routes, 0 missing, exit 0**
- Bundling experiment A/B on the real auth + projects handlers → **F-1, F-2 evidence**
- Fault-injected write on the real moderation handlers, both trees → **F-3 evidence**
- Vercel platform behaviour (one function per file, `req.query`, `outputDirectory`, `installCommand`, `framework: null`) → checked against Vercel's live documentation, not from memory

**Harnesses** (outside the repo, in `%TEMP%\opencode\wave4-audit\`): `run.cjs`, `run2.cjs`. Both bundle the repo's real handlers with the repo's own esbuild and run them against a sandbox data directory. The repo was not written to; `site/data/portal/` is still absent and `reviews.jsonl` is still 0 bytes.

## What I could NOT verify

- **The Vercel router was never booted** (no token, no `vercel dev`, no preview deploy). The F-1/F-2 conclusion rests on (a) Vercel's documented one-function-per-file rule, (b) the repo's own documented bundle invariant, and (c) **executed** evidence that separately-bundled copies of these handlers do not share state. The *symptom* on a real deployment is an inference from those three; the *mechanism* is proven.
- **workerd was never booted** — the Cloudflare claims are about the CF code path executed in Node's Web-standard runtime.
- **`process.cwd()` on Vercel** (F-7) is unverified for the same reason.
- I did not re-run QA's behavioural suites, did not run the Astro build, and did not boot the dev server — this is a code and contract audit, not a test pass.
