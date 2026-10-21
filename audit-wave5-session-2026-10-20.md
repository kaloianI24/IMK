# Independent re-audit — wave 5 (signed session) + the concurrent wave-5/6 landing

**Auditor:** Code Reviewer — Independent Audit (Principal Code Reviewer)
**Date:** 2026-10-20
**Requested by:** @Manager (read-only independent audit of the wave-5 signed-session change)
**Scope:** `site/shared/server/portal-session.ts` (21:03) and its wiring into `api/portal/auth.ts` / `site/functions/api/portal/auth.ts`; plus the F-1/F-2 verdicts it was meant to produce
**Repo:** `C:\Users\Kalch\Documents\IXI` (site at `site/`, Vercel handlers in `api/`, Cloudflare twins in `site/functions/`)
**Method:** read-only inspection of the real files + **executed** evidence in a sandbox outside the repo
**Evidence snapshot:** 2026-10-20 **22:11:13** (file hashes in *Snapshot* below). The tree was being modified **while this audit ran** — see *Timeline*.
**Repo state on completion:** no repo file modified by this audit except this one report

---

## Verdict

**DONE — 2 MAJOR, 5 MINOR, 10 INFO. No CRITICAL.**

| Question the brief asked | Answer on the 22:11:13 snapshot |
|---|---|
| **F-1** — sign-in door dead on the deploy target | **CLOSED** (executed). The magic link is now a stateless signed token in `site/shared/server/magic-link.ts`, shared by both trees. `request-link` in one process → `verify` in another process now answers **200** (it answered 400 before 22:08). |
| **F-2** — every authenticated call 401s | **STILL OPEN** (executed). The session is still a per-bundle `Map`. The cookie minted by `/api/portal/auth/verify` is refused by `/api/portal/projects`: **401 `{code:'unauthorized'}`.** |
| Does the signed-session module close F-2? | **The design would. The tree does not.** `site/shared/server/portal-session.ts` has **zero importers** — it is dead code. `api/portal/session.ts` (mtime 19:01) and `site/functions/api/portal/session.ts` (mtime 19:06) are untouched and still hold a `Map`. |
| Does it open a new hole? | The **signature construction is sound** and it **fails closed** on a missing secret. Three real problems: the failure is **silent** (a misconfigured deployment mints cookies that never validate), **logout cannot revoke** across instances, and the module **cannot be used on the edge** (node builtins + `process.env` + a Node-shaped request). |

**The one-line cause is unchanged from wave 4: the portal's state is in-process, and the deploy target is multi-function, multi-instance and stateless.** The magic-link half has now been fixed properly; the **session** half has not.

---

## Timeline — the tree changed under this audit

The brief described a change that was **not** in the tree when the audit started, and the tree then moved twice during the audit. Recorded so the findings can be read against the right snapshot:

| Time (2026-10-20) | Event | Evidence |
|---|---|---|
| 21:03:12 | `site/shared/server/portal-session.ts` created (10 734 B, sha `F60502615A6B`) | file metadata |
| ~22:03 | **This audit reads the tree.** `api/portal/auth.ts` is still 16 666 B (mtime 19:38:17) and still imports `'./session.js'`; the CF twin is 15 821 B (19:42:27). The new module has **no importer**. The magic-link table is still `api/portal/auth.ts:41` (module scope). | first reads in this session |
| 22:05 | Baseline manifest hash + `git status` = **129** entries | harness baseline |
| **22:08:08** | **New file `site/shared/server/magic-link.ts`** (11 034 B, sha `8F4006889E0A`) — the stateless magic link, WebCrypto-only, shared by both trees | file metadata |
| **22:08:50** | **`api/portal/auth.ts` rewritten** (18 353 B, sha `29DA7D4326DB`) — the token table is gone; it now imports the shared magic-link module | file metadata |
| 22:08:54 | `DEPLOY.md` touched | file metadata |
| **22:09:42 / 22:09:52** | **`site/functions/api/portal/auth.ts` rewritten twice** (final 15 325 B, sha `AA1E7AF07899`) — same change for the edge tree | file metadata |
| 22:06–22:07 | The Backend Developer ran a build in the repo (`site/dist/`, `site/.astro/` regenerated) | file metadata |
| **22:09:46 → 22:12:19** | **The handler trees stopped changing** (last handler write 22:09:52). All executed evidence below was taken against the 22:11:13 snapshot. One non-handler file appeared afterwards (`backend-f1-magic-token-harness.mjs`, 22:11:36 — the Backend Developer's own harness, written into the repo root). | harness runs + repeated metadata scans |

**So the brief's claim — "one new file wired into `api/portal/auth.ts` and `site/functions/api/portal/auth.ts`" — was true only from 22:08:50 onwards, and it refers to the *magic-link* module, not to the signed-session module.** `site/shared/server/portal-session.ts` (21:03) has still never been imported by anything.

### Snapshot the evidence refers to (2026-10-20 22:11:13)

```
api\portal\auth.ts                          18353B 22:08:50 29DA7D4326DB
api\portal\session.ts                        5546B 19:01:25 CA829E44166C
site\functions\api\portal\auth.ts           15325B 22:09:52 AA1E7AF07899
site\functions\api\portal\session.ts         4961B 19:06:52 C64A953163CD
site\shared\server\magic-link.ts            11034B 22:08:08 8F4006889E0A
site\shared\server\portal-session.ts        10734B 21:03:12 F60502615A6B
api\portal\projects.ts                      11572B 20:15:46 FB0CDD3B1B97
```

---

## The four points, answered

### 1 · Does the signed-token session close F-2 (session lost per bundle / per instance / per cold start) on the Vercel tree?

**No. The module is not wired to anything, and the live session is still a `Map`.**

**Evidence A — nothing imports it (executed, 22:10:46).**

```
PS> grep "portal-session" over api/ + site/ (all .ts/.mjs/.js/.astro)
     site\shared\server\portal-session.ts:1: // site/shared/server/portal-session.ts - Node-side session module (Vercel tree).
```

That single hit is the file's own header comment. The live import edges are unchanged:

```
Vercel: api/portal/auth.ts:23  api/portal/comments.ts:16  api/portal/invites.ts:19
        api/portal/plan-items.ts:17  api/portal/projects.ts:20  api/portal/testimonials.ts:27
        api/portal/updates.ts:16  api/lib/notifications.ts:16        -> all "./session.js"
Edge  : site/functions/api/portal/auth.ts:16  comments.ts:5  invites.ts:4
        plan-items.ts:6  projects.ts:7  testimonials.ts:16  updates.ts:5  -> all "./session.js"
```

`api/portal/session.ts:18` is still `const sessions = new Map<string, SessionEntry>();` and `site/functions/api/portal/session.ts:19-24` is still the `globalThis` map.

**Evidence B — F-2 is still open on the deployed shape (executed).** The harness bundles the *real* handlers with the repo's own esbuild (`site/node_modules/esbuild`), **one bundle per file** — exactly how Vercel builds — and runs every step in a **separate OS process** (a faithful stand-in for "one function / one cold start"). The repo is never written to; the handlers' `process.cwd()` is a sandbox outside the repo.

```
S5.1 request-link (process A)              -> HTTP 200   token minted: YES (len 183)
S5.2 verify        (process B)              -> HTTP 200   {"ok":true,"role":"client","email":"client@example.com"}
S5.3 cookie issued: YES  imk_session=a7fdc919fbe03d2672f146929a4f93da792945c67d5309c0b727ee03cfaaf078
S5.4 that cookie -> projects bundle (proc C) -> HTTP 401   {"error":"authentication required","code":"unauthorized"}
```

S5.3 → S5.4 is F-2, live: the client signs in successfully and then every portal call answers **401**.

```
S2.1 legacy createSession (process A)      -> token len 64
S2.2 create+resolve in ONE process         -> {"email":"client@example.com","role":"client","clientId":"cli_test1"}
S2.3 same token, DIFFERENT process D       -> resolved: null
S2.4 cookie -> projects bundle (process E) -> HTTP 401   {"error":"authentication required","code":"unauthorized"}
```

The session is a random 64-hex token in a per-bundle `Map` (`api/portal/session.ts:93-106`) — invisible to every other function.

**Evidence C — the new module does solve it (executed).** Same harness, `site/shared/server/portal-session.ts` bundled on its own:

```
S3.1 createSession (process A)  -> token len 166  payload {"e":"client@example.com","r":"client","x":1792609820768,"c":"cli_test1"}
S3.2 parseSession (process B)   -> {"email":"client@example.com","role":"client","clientId":"cli_test1"}   secretConfigured=true
```

**Verdict on point 1:** the *design* closes F-2 (per bundle / per instance / per cold start); the *tree* does not, because nothing imports the module. It is one import line away from being real.

### 2 · Does it open a new hole? (signature construction, secret handling, TTL, logout)

**Signature construction — sound.** `sign()` = `HMAC-SHA256(secret, 'v1.' + payloadB64)` over the version-prefixed payload (`site/shared/server/portal-session.ts:126-131`); the version is inside the signed material, so a downgrade is rejected (`:190`); comparison is length-checked and timing-safe (`:133-138`); expiry is checked (`:200`); the role and the clientId travel inside the signed payload, so neither can be altered. **No new hole here.**

**Secret handling — fails closed, but silently (F-5-2).** `sessionSecret()` returns `''` in production when neither `PORTAL_SESSION_SECRET` nor `PORTAL_MAGIC_LINK_SECRET` is set (`:106-119`), and `parseSession()` refuses to parse when no secret is configured (`:186`) — so a forged token cannot be accepted with an empty key. Executed:

```
S3.5 production, NO secret configured (APP_ENV=production, no env vars):
     session-info   -> {"secretConfigured":false,"secretLength":0,"isProd":true}
     createSession  -> token minted: YES (len 166)      <-- the mint does NOT fail
     parseSession   -> null                            <-- the token is rejected
     forged token   -> forgedAccepted=null  secretLength=0
S3.6 production WITH a secret: forged with the real secret -> accepted
     forgedAccepted={"email":"admin@example.com","role":"admin","clientId":"cli_evil"}
```

So: an attacker with an empty-key HMAC cannot get in (good), but a **misconfigured deployment mints cookies that never validate, with no error and no log line** (bad) — F-5-2. The module's own header (`:30-32`) promises "a missing secret is a misconfiguration (500), not a silent fallback"; **nothing implements that 500** — `sessionSecretConfigured()` is never called by anything (executed grep: the only hits are inside the file itself).

**Note the contrast with the magic-link module, which landed 65 minutes later and got it right:** `magicLinkMisconfigured(env)` (`site/shared/server/magic-link.ts:79-81`) + `createMagicToken()` returning `null` (`:195`) + the callers answering `500 {code:'internal'}` (`api/portal/auth.ts:258-268`, `:372-382`). The session module should have the same three pieces.

**TTL — fixed at issue, not sliding (F-5-5).** Executed: `x - now = 1440 min` (exactly 24 h) at mint, and neither `parseSession` nor `resolveSession` refreshes it; the cookie's `Max-Age=86400` matches. The module it would replace slid the TTL on every request (`api/portal/session.ts:87`), so this is a behaviour change: an active client is signed out 24 h after signing in.

**Logout — cannot revoke anything across functions. CONFIRMED, not refuted (F-5-4).** The file's header says so (`:24-28`); executed:

```
S3.3 destroySession (process C)     -> revokedMapSize=1
S3.4 parseSession again (process D) -> {"email":"client@example.com","role":"client","clientId":"cli_test1"}   <-- still valid
S3.8 same process: parse BEFORE destroy = {...}   parse AFTER destroy = null
```

The revocation list is `globalThis.__imkRevokedSessions` (`:148-149`) → per Vercel function instance. On the deployed target `/api/portal/auth/logout` is its **own function** (`api/portal/auth/logout.ts`), so it can never revoke a token that `/api/portal/projects` would accept. Logout is cookie-clearing only; a stolen or replayed token stays valid for up to 24 h.

**Other checks on the new file (executed).**

| Check | Result |
|---|---|
| Cross-protocol forgery (session key == magic-link key) | **Not possible.** The session message is `v1.<base64url>` (base64url never contains `\|`); the magic message is `${email}\|${purpose}\|${exp}\|${nonce}` (always contains `\|`). HMAC outputs cannot be reused across the two schemes. |
| Cookie name vs. signed role | **No escalation.** An admin token in `imk_session` resolves as an *admin* session and a client token in `imk_admin_session` as a *client* session (S3.10) — the role travels signed, and every authorization decision reads `session.role` (`api/portal/invites.ts:189`, `api/portal/projects.ts:108,167,258`). No endpoint authorizes on the cookie name. |
| Dev fallback (no secret, non-production) | Per-process random secret on `globalThis` (`:114-118`): a token minted in dev process A does **not** verify in dev process B (S3.7 → `null`). Harmless for the one-process dev server; surprising if the dev tree is ever split. The magic-link module has the same property (`magic-link.ts:93-100`). |
| Key separation | One key for two protocols by design (`:101,108-110`). Not exploitable (row above), but `PORTAL_SESSION_SECRET` is undocumented in `site/.env.example` and `DEPLOY.md:33`. |

### 3 · Is the magic-link table still module scope on the Vercel tree while the CF twin uses globalThis? What is the exact consequence?

**No longer true — and that is the good news of this wave.** As of 22:08:50 (Vercel) and 22:09:52 (edge):

- `api/portal/auth.ts` — the `magicTokens` `Map` is **gone**; the file says so itself (`:47-58`) and imports the shared module instead (`:26-32`: `from '../../site/shared/server/magic-link.js'`).
- `site/functions/api/portal/auth.ts` — the `globalThis.__portalMagicTokens` map is **gone** (`:39-48`); it imports the same module (`:19-25`: `from '../../../shared/server/magic-link.js'`).

**The token is now stateless** (`site/shared/server/magic-link.ts`): `base64url(email|purpose|exp|nonce|sig)` with `sig = HMAC-SHA256(secret, 'email|purpose|exp|nonce')` (`:188-201`, `:114-124`). The verifier recomputes the signature and needs no state (`:210-246`).

**Executed consequence on the Vercel function-per-file shape:**

```
S1.1 request-link (process A)             -> HTTP 200   token minted: YES (len 183)
S1.2 verify        (process B)             -> HTTP 200   {"ok":true,"role":"client","email":"client@example.com"}
S1.3 CONTROL: link+verify in ONE bundle   -> link 200 verify 200
```

Compare the same harness at **22:03**, before the landing:

```
S1.1 request-link (process A)  -> HTTP 200   token minted: YES (len 183)
S1.2 verify        (process B)  -> HTTP 400   {"error":"link expired or invalid","code":"invalid"}
```

**F-1 is closed on the Vercel tree, by execution.**

**The Cloudflare twin's `globalThis` map was never a fix** — it only widened the scope from "one module instance" to "one isolate", and Cloudflare runs an isolate per colo. The same executed harness shows the session map behaves identically (S4.1/S4.2, below). The magic-link fix removes the problem for the edge too, because the edge now verifies a self-contained token.

**What remains of F-1 (F-5-7):** the *single-use* property is still per-instance. The used-token register is `globalThis.__imkUsedMagicTokens` (`magic-link.ts:260-262`), and the module's own header says so (`:27-43`). Executed:

```
replay window: consume the SAME token in three different processes
process A: {"firstConsume":true,"secondConsumeInSameProcess":false}
process B: {"firstConsume":true,"secondConsumeInSameProcess":false}
process C: {"firstConsume":true,"secondConsumeInSameProcess":false}
```

Each process accepted the token as unused. So a sign-in link that leaks (forwarded mail, a shared inbox, a browser history entry) is a **valid credential for its full 15-minute TTL** on any instance that has not seen it — the register only catches a replay that lands on the same instance. The module states this plainly; it needs the durable register (T4) to be a real one-time token.

### 4 · Is anything in `site/shared/server/portal-session.ts` Node-only in a way that breaks the Cloudflare edge bundle?

**Yes — and the edge twin does not use it at all.**

**What the CF twin imports (executed, read + bundle inspection):** `site/functions/api/portal/auth.ts:6-16` imports only its own `'./session.js'`, `'../../../shared/portal-store/jsonl.js'` and `'../lib/rate-limit.js'` (+ the shared magic-link module at `:19-25`). The built edge bundle contains **no** reference to the shared signed session:

```
=== the CF twin as an edge bundle ===
   BUILD: OK  (bytes: 19606)
   node builtin imports                 : none
   references the shared signed module  : false
   uses process.env                    : false
   uses WebCrypto (crypto.subtle)       : true
   keeps its own globalThis token map   : false      (the magic-token map is gone; the session map is not)
```

**Can the shared session module be bundled for the edge? (executed)**

```
=== EDGE BUNDLE TEST: site/shared/server/portal-session.ts ===
(a) workerd/edge conditions, node builtins NOT external
--- workerd ---
   BUILD: FAILED
   Could not resolve "node:http"  [site/shared/server/portal-session.ts]
   Could not resolve "node:crypto" [site/shared/server/portal-session.ts]

(b) neutral platform, node builtins external (the "it compiles" case)
--- neutral ---
   BUILD: OK
   node builtin imports left in the bundle : from "node:crypto"
   uses process.env                       : true
   uses Buffer                            : true

(d) the NEW shared magic-link module (site/shared/server/magic-link.ts) as an edge bundle
   BUILD: OK  (bytes: 4517)
   node builtin imports                 : none
   uses process.env                     : false
   uses Buffer                          : false
   uses WebCrypto (crypto.subtle)       : true
```

**What is Node-only in the module:** `import { IncomingMessage } from 'node:http'` (`:34`) — a *value* import, so it survives bundling (`require("node:http")` is present in the built bundle); `import * as crypto from 'node:crypto'` (`:35`) with `createHmac`/`timingSafeEqual`/`randomBytes`; `Buffer` (`:134-135, 173, 194`); and `process.env` (`:108-110, 276, 284`).

**Two further incompatibilities a bundle check alone does not show:**

1. **Wrong secret source.** The module reads `process.env`; the edge twin reads the `env` binding everywhere (`site/functions/api/portal/auth.ts:136,158,193` → now `env` passed into the shared magic-link module). Cloudflare's docs (fetched 2026-10-20): *"In the Workers implementation, there is no process-level environment, so by default `env` is an empty object"* — `process.env` is populated only with the `nodejs_compat_populate_process_env` flag (default for compatibility dates ≥ 2025-04-01). **The repo ships no wrangler config at all** (no `wrangler.toml` / `wrangler.json` / `wrangler.jsonc` anywhere — executed), so no compatibility date or flag is pinned and nothing guarantees `process.env` is populated. If the edge tree were pointed at this module, `sessionSecret()` would be `''` in production → `parseSession()` → `null` → **every session rejected** (the same silent outage as F-5-2, on the edge).
2. **Wrong request shape and sync-only crypto.** `readSessionCookies(req: IncomingMessage)` (`:74`) vs the edge twin's `readSessionCookies(headers: Headers)` (`site/functions/api/portal/session.ts:37`); and the module's HMAC is **synchronous** (`node:crypto`), whereas the edge needs **asynchronous WebCrypto**.

**The comparison that matters:** the magic-link module (d) is **edge-clean** — no node builtins, no `process.env`, no `Buffer`, WebCrypto only, and it takes an `EnvLike` bag of env values (`:46-48`) so both trees can call it unchanged. **The session module should be built the same way.** That is the cheapest path to closing F-2 on *both* targets with one module — and it is exactly what `site/shared/server/magic-link.ts` demonstrates.

---

## Findings

### F-5-1 · MAJOR — the signed-session module is wired to nothing: F-2 stays open and the deployed portal still 401s

**Where:** `site/shared/server/portal-session.ts` (the whole file, 313 lines) vs `api/portal/auth.ts:12-23`, `api/portal/comments.ts:12-16`, `api/portal/invites.ts:15-19`, `api/portal/plan-items.ts:13-17`, `api/portal/projects.ts:13-20`, `api/portal/testimonials.ts:27`, `api/portal/updates.ts:13-17`, `api/lib/notifications.ts:16` — all still `from './session.js'`.

**Evidence:** the greps and S2/S5 above (zero importers; 401 across bundles and processes).

**Impact.** Unchanged from wave 4 on this path: on the launch target a client can now sign in (F-1 fixed) but **every portal call answers 401** — the portal is reachable and empty. A green CI does not catch this: `site/tsconfig.api.json` includes `"shared/**/*.ts"`, so `npm run typecheck:api` type-checks the orphan file — CI is green on code nothing runs.

**Fix.** Make the live per-tree module a thin re-export of a **shared** session module, so there is one session implementation and one place to change. The API surface is compatible (executed check): every symbol the Vercel handlers import from `'./session.js'` — `createSession`, `destroySession`, `readSessionCookies`, `sessionCookieString`, `clearSessionCookieString`, `baseUrl`, `isSecureBaseUrl`, `expectedOrigin`, `baseUrlConfigured`, `isProductionEnv`, `resolveSession` — plus the `Role` type, is exported by the new module with a compatible shape (`resolveSession(req, preferRole)` → `{email, role, clientId} | null`); `api/lib/notifications.ts` needs only `baseUrl`.

Two options, in order of preference:

- **(a) Rewrite the session the way the magic link was rewritten** (recommended): one module at `site/shared/server/`, `EnvLike` env, **WebCrypto** (async), no node builtins, and an adapter that takes `Headers` instead of `IncomingMessage`. Then **both** trees import it and F-2 closes on Vercel *and* Cloudflare. `site/shared/server/magic-link.ts` is the template — it already does all of this.
- **(b) Minimal:** make `api/portal/session.ts` re-export the existing Node-only module (`export * from '../../site/shared/server/portal-session.js';`). One line, closes F-2 on the Vercel tree only, and leaves the edge tree broken (F-5-6).

Fix **F-5-2** before shipping either.

**Do not forget:** this only closes the *session* half. The magic-link half is now closed; the remaining stateful thing in the portal is the session itself.

### F-5-2 · MAJOR — a missing signing secret becomes a silent total-auth outage, not the 500 the module promises

**Where:** `site/shared/server/portal-session.ts:162-175` (`createSession` — no secret check), `:122-124` (`sessionSecretConfigured()` — **never called by anything**, executed grep), header claim at `:30-32`.

**What happens.** In production with no `PORTAL_SESSION_SECRET` and no `PORTAL_MAGIC_LINK_SECRET`: `sessionSecret()` returns `''` (`:113`), `createSession()` still mints a token (signed with an empty key — it does not throw, it does not log), the verify handler would answer **200 + `Set-Cookie`**, and from then on every authenticated call answers **401** because `parseSession()` returns `null` (`:186`). Executed: S3.5 — mint succeeds, parse fails, `secretConfigured=false`.

**Impact.** The client is told it signed in; the portal is empty; the logs say nothing. This is exactly the M3/D3 "silent outage" class this repo has already been hardened against twice.

**Fix (mirror what the magic-link module already does).**
1. `createSession()` refuses to mint when `!sessionSecretConfigured()` (throw or return `null`), so an unusable token cannot exist.
2. The verify handler checks `sessionSecretConfigured()` **before** issuing the cookie and answers `500 {error:'misconfigured', code:'internal'}` with a log line — the pattern already used for a missing `RESEND_API_KEY` (`api/portal/auth.ts:299-309`) and for a missing magic-link secret (`api/portal/auth.ts:258-268`).
3. Prefer failing the deployment: make the secret mandatory at startup.

### F-5-3 · MINOR (was MAJOR when this audit started — **closed** by the concurrent landing) — the magic-link path signed with an empty key in production

**Where (22:03 state):** `api/portal/auth.ts:134` and `:157` — `const secret = process.env.PORTAL_MAGIC_LINK_SECRET || '';` with no production guard.

**Status at 22:11:13: CLOSED.** The 22:08:50 rewrite removed both lines. `site/shared/server/magic-link.ts:79-81` (`magicLinkMisconfigured`) + `:93-100` (`magicLinkSecret` returns `null` in production) + `:195` (`createMagicToken` returns `null`) + the callers answering 500 (`api/portal/auth.ts:258-268`, `:372-382`; the CF twin likewise). **Verified by execution:**

```
S6.1 request-link (production, no secret) -> HTTP 500   {"error":"misconfigured","code":"internal"}
S6.2 verify       (production, no secret) -> HTTP 500   {"error":"misconfigured","code":"internal"}
S6.3 forged admin token, empty key        -> misconfigured=true   forgedAccepted={"valid":false,"reason":"misconfigured"}
```

The empty-key forgery is refused, and both routes fail closed with the same answer for invited and uninvited addresses (no enumeration). **No action needed — recorded because this was a live MAJOR at 22:03 and the fix landed during the audit.**

### F-5-4 · MINOR — logout revokes nothing outside the instance that processed it

**Where:** `site/shared/server/portal-session.ts:148-149` (`globalThis.__imkRevokedSessions`), `:235-245` (`destroySession`); the logout route is its own Vercel function (`api/portal/auth/logout.ts`).

**Evidence:** S3.3/S3.4 (destroyed in one process → still valid in another) and S3.8 (within one process it does revoke). The module's header states this honestly (`:24-28`); this finding confirms it and adds the consequence: **on the deployed target a logout never revokes the token**, because `/api/portal/auth/logout` and `/api/portal/projects` are different functions with different `globalThis`. A token stolen from a machine stays usable for up to 24 h after the user clicks "sign out".

Secondary: `destroySession` prunes only **expired** entries when the map exceeds 500 (`:239-244`), so the map can grow past 500 with unexpired tokens.

**Fix.** Durable revocation belongs in the shared store (T4). Until then: shorten the TTL, or put a `sessionVersion`/epoch claim in the payload so the server can invalidate a whole generation at once. Say plainly in the UI/docs that "sign out" clears the cookie only.

### F-5-5 · MINOR — the TTL becomes fixed at issue (a behaviour change from the sliding TTL the portal had)

**Where:** `site/shared/server/portal-session.ts:45` (`SESSION_TTL_MS`), `:170` (`x: Date.now() + SESSION_TTL_MS`), `:200` (expiry check only — no refresh); replaced `api/portal/session.ts:87` (`entry.expiresAt = Date.now() + SESSION_TTL_MS;` — refresh on activity).

**Evidence:** S3.9 — `x - now = 1440 min` at mint, and neither `parseSession` nor `resolveSession` ever moves `x`. The cookie's `Max-Age=86400` matches the token, so cookie and token expire together (consistent, no orphan cookie).

**Impact.** A client who signs in on Monday is signed out on Tuesday even if they were using the portal all day. The module documents the trade-off (`:29`), but the portal page may assume a rolling session.

**Fix.** Decide deliberately — if the portal is a "daily" tool, 24 h absolute is fine and should be stated in the UI; if it is a long engagement, issue a sliding token (re-mint on activity) or raise the TTL.

### F-5-6 · MINOR — the session module cannot be used on the edge (node builtins, `process.env`, Node-shaped request, sync-only crypto)

**Where:** `site/shared/server/portal-session.ts:34-35, 108-110, 134-135, 173, 194, 276, 284` vs `site/functions/api/portal/session.ts:37, 65-86` and the edge twin's env-binding style (`site/functions/api/portal/auth.ts:136,158,193`).

**Evidence:** the edge bundle test above — (a) BUILD FAILED on `node:http`/`node:crypto`; (b) with them external the bundle still needs `process.env` and `Buffer`; (d) by contrast the magic-link module bundles clean with **no** node builtins, **no** `process.env`, **no** `Buffer`; plus Cloudflare's documented `process.env` behaviour and the absence of any wrangler compatibility configuration in the repo.

**Impact.** None today (nothing imports the module). The moment someone points the edge tree at it — the obvious next step after F-5-1 — the edge silently rejects every session, because the secret would be empty in production.

**Fix.** Do not point the edge at the Node module. Build the edge version the way `magic-link.ts` was built (async WebCrypto, `EnvLike`, no node builtins) — ideally in the *same* file, so there is one session implementation for both trees.

### F-5-7 · MINOR — the magic link's one-time property is per-instance: a leaked sign-in link is valid for its full TTL

**Where:** `site/shared/server/magic-link.ts:260-262` (`globalThis.__imkUsedMagicTokens`), `:271-281` (`consumeMagicToken`); callers `api/portal/auth.ts:402-406`, CF twin likewise.

**Evidence:** the same token consumed successfully in three different processes (A, B, C all `firstConsume: true`). Within one process the second consume is refused (`secondConsumeInSameProcess: false`).

**Impact.** The one-time property holds only against a replay that lands on the same instance. A sign-in link that leaks (forwarded mail, a shared inbox, browser history, a proxy log) is a **valid credential for 15 minutes** on any instance that has not seen it. The module's header states this honestly (`:27-43`) — it is a designed limitation, not a defect — but it should be reflected in the spec and in the owner's expectations: "one link, one sign-in" is not yet true.

**Fix.** The durable register (T4) turns it into a real one-time token. Until then: shorten the TTL, bind the token to the client record (so a replay needs the same email to be invited *and* still valid), and log every successful verification so an owner can see replays.

### INFO — cleared, and small things worth knowing

| # | Item | Status |
|---|---|---|
| I-1 | **Signature construction** (`site/shared/server/portal-session.ts:126-138`) | **CLEARED.** HMAC-SHA256 over the version-prefixed payload; timing-safe compare with a length pre-check; the version is inside the signed material (`:129, 190`); expiry checked (`:200`). No way to alter the role, the clientId or the expiry without the secret. |
| I-2 | **Empty-key forgery — session path** | **CLEARED.** `parseSession()` refuses to parse when no secret is configured (`:186`) — executed S3.5: a forged token with an empty-key HMAC is rejected. (The magic-link path was F-5-3; closed at 22:08.) |
| I-3 | **Empty-key forgery — magic-link path** | **CLEARED (executed S6).** `magicLinkMisconfigured()` + `createMagicToken() → null` + `500 {code:'internal'}` on both routes; a forged admin token with an empty key is refused (`reason:'misconfigured'`). |
| I-4 | **Cross-protocol forgery** (session and magic link sharing one secret) | **CLEARED.** The two signed message formats are disjoint (the session message is `v1.<base64url>`, base64url never contains `\|`; the magic message always contains `\|` and a random nonce), so no HMAC output can be replayed from one scheme into the other. Still prefer a dedicated `PORTAL_SESSION_SECRET` (undocumented today: `site/.env.example`, `DEPLOY.md:33`). |
| I-5 | **Cookie name is not signed** | **CLEARED (no escalation).** S3.10: an admin token in `imk_session` resolves as an admin session; a client token in `imk_admin_session` as a client session. Every authorization decision reads `session.role` (`api/portal/invites.ts:189`, `api/portal/projects.ts:108,167,258`), and the role is signed. Cheap hardening if that ever changes: sign the cookie name into the payload. |
| I-6 | **Purpose enforcement** (wave-4 I-4) | **CLOSED by the magic-link landing.** `verifyMagicToken(token, expectedPurpose, env)` refuses a token whose purpose differs (`:241-243`); the sign-in door passes `PORTAL_MAGIC_PURPOSE` (`api/portal/auth.ts:363, 387`). |
| I-7 | **Magic-link module is edge-clean** | **CONFIRMED (executed).** No node builtins, no `process.env`, no `Buffer`, WebCrypto only; it takes an `EnvLike` bag (`:46-48`), so both trees call it unchanged. **Use it as the template for the session module.** |
| I-8 | **Duplicated URL builder** | `magicLinkUrl()` (`magic-link.ts:290-292`) is exported but the handlers build the URL inline (`api/portal/auth.ts:167`). One of the two should go. |
| I-9 | **Rate limiter is per instance on Vercel** | `PORTAL_RATE_LIMIT_FILE` is unset by default → in-memory backend (`api/lib/rate-limit.ts:282-288`), so the 5/hour sign-in-link limit resets on every cold start. Pre-existing, documented in `site/.env.example`; not a wave-5 change. |
| I-10 | **Dev fallback secrets are per process** | Both new modules generate a per-process random secret when none is configured (`portal-session.ts:114-118`, `magic-link.ts:93-100`): a token minted in dev process A does not verify in dev process B (executed S3.7). Fine for the one-process dev server; worth a comment in each file. |

---

## Answers to the four questions, condensed

1. **Does the signed-token session close F-2 on the Vercel tree?** — **No.** The module has zero importers (executed grep); `api/portal/session.ts` is still a per-bundle `Map` (unchanged since 19:01); the cookie from `verify` is refused by `projects` with **401 `{code:'unauthorized'}`** across bundles and across processes. The *design* works (a token minted in process A parses in process B, executed) — it is one import line away from closing F-2.
2. **Does it open a new hole?** — **The signature is sound and it fails closed**, but: a missing secret produces a **silent** outage instead of the promised 500 (F-5-2); **logout cannot revoke** across instances (F-5-4, confirmed, as the file's own header says); the TTL is **fixed at issue** (F-5-5); the module is **not edge-compatible** (F-5-6); the cookie name is not signed but that is not an escalation (I-5); one key serves two protocols, which is not exploitable (I-4).
3. **Is the magic-link table still module scope while the CF twin uses globalThis?** — **It was, at 22:03; it is not any more.** The 22:08:50 / 22:09:52 rewrites replaced both tables with one stateless signed token (`site/shared/server/magic-link.ts`), shared by both trees. **F-1 is closed, by execution** (`request-link` in one process → `verify` in another → 200). What remains is the per-instance single-use register (F-5-7).
4. **Is anything in the module Node-only in a way that breaks the edge bundle?** — **Yes:** `node:http` + `node:crypto` + `Buffer` + `process.env` (the edge bundle **fails to build**: "Could not resolve node:http" / "node:crypto"), a Node-shaped request (`IncomingMessage` vs `Headers`), a synchronous HMAC (the edge needs async WebCrypto), and a secret read from `process.env` (empty by default on Workers) instead of the `env` binding. The CF twin imports **nothing** from it, so the edge is unaffected today — but the edge has **no** signed session at all: `site/functions/api/portal/session.ts` is still a `globalThis` map (unchanged since 19:06), so **F-2 is open on Cloudflare too** (executed S4.1/S4.2).

---

## Recommended order

1. **F-5-1 + F-5-2** — build the session the way the magic link was built: one module in `site/shared/server/`, `EnvLike` env, WebCrypto, no node builtins; `createSession` refuses to mint without a secret; the sign-in route answers `500 {code:'internal'}` when the secret is missing. Then re-run the executed harness: S5.4 must become 200. This closes F-2 on **both** targets.
2. **F-5-7** — move the used-token register into the shared store (T4) so a sign-in link is really one-time; until then, shorten the TTL and log every verification.
3. **F-5-4 / F-5-5** — decide the revocation story and the TTL, and say both out loud in the UI and in `DEPLOY.md`.
4. **I-8 / I-10** — de-duplicate the URL builder; document the per-process dev secret in both new modules.
5. Keep `DEPLOY.md` §1.3 in step: it still describes the portal as blocked on storage, and now that the sign-in door works, the *session* is the last blocker on Vercel.

---

## Files read / checked (no file in the repo was modified by this audit)

**Wave-5 files:** `site/shared/server/portal-session.ts` (all 313 lines), `site/shared/server/magic-link.ts` (all 292 lines)

**Handlers:** `api/portal/auth.ts` (22:08:50 version), `site/functions/api/portal/auth.ts` (22:09:52 version), `api/portal/session.ts`, `site/functions/api/portal/session.ts`, `api/portal/{comments,invites,plan-items,projects,testimonials,updates}.ts`, `api/lib/{notifications,rate-limit,jsonl}.ts`, `site/shared/portal-store/jsonl.ts`

**Routes / tooling / config:** `api/portal/auth/{request-link,verify,logout}.ts`, `site/functions/api/portal/auth/{request-link,verify,logout}.ts`, `site/scripts/api-index.ts`, `site/scripts/dev-portal.js`, `site/tsconfig.api.json`, `site/package.json`, `.github/workflows/ci.yml`, `vercel.json`, `site/.env.example`, `DEPLOY.md`, `audit-wave4-routes-2026-10-20.md`

**Checks executed (not re-run: the behavioural suites belong to QA)**

- Import-graph scan of both trees → the signed-session module has **no** importer (three independent greps).
- esbuild bundling of the **real** handlers, one bundle per file (Vercel shape) + one bundle per session module; every request executed in a **separate OS process** → S1–S6 evidence above, re-run against the 22:11:13 snapshot.
- Edge bundling of `site/shared/server/portal-session.ts` (workerd conditions; neutral + externals), of `site/shared/server/magic-link.ts` and of the CF twin → the four edge-bundle results above.
- Same-process revocation / TTL / cookie-role probes (S3.8–S3.10) and the cross-process magic-link replay probe.
- Vercel's Node runtime docs (fetched 2026-10-20) — one function per file under `api/`; keep shared modules outside `api/`.
- Cloudflare's Node.js compatibility and `process` docs (fetched 2026-10-20) — `process.env` empty by default, populated only with `nodejs_compat_populate_process_env`; `node:crypto`/`Buffer`/`process` natively supported with `nodejs_compat`.

**Harness** (outside the repo, in `%TEMP%\opencode\wave5-audit\`): `build.cjs`, `invoke.cjs`, `drive.cjs`, `revoke.cjs`, `edge.cjs`. They bundle the repo's real handlers with the repo's own esbuild and run them against a sandbox data directory. **The repo was not written to**: `site/data/portal/` is still absent and `site/data/moderation/reviews.jsonl` is still 0 bytes.

## What I could NOT verify

- **The tree was moving while I audited** (22:08:08 → 22:09:52). Everything above refers to the 22:11:13 snapshot; if the Backend Developer lands more changes, the findings must be re-checked against the new state. I stopped chasing at 22:11:13, when two consecutive checks showed no further change.
- **The Vercel router was never booted** (no token, no `vercel dev`, no preview deploy). The F-2 conclusion rests on (a) Vercel's documented one-function-per-file rule, (b) the repo's own documented bundle invariant (`site/scripts/api-index.ts`), and (c) **executed** evidence that separately bundled/processed copies of these handlers do not share state. The mechanism is proven; the exact symptom on a real deployment is an inference from those three.
- **workerd was never booted** — the Cloudflare claims are about the CF code path executed in Node's Web-standard runtime, plus the edge bundle build results and Cloudflare's own documentation.
- I did not re-run QA's behavioural suites, did not run the Astro build, and did not boot the dev server — this is a code and contract audit, not a test pass.
- I did not review `site/shared/server/magic-link.ts` against `spec/08-portal-mvp.md` beyond the session/auth semantics above; the brief's four points were the scope.

## Repo integrity

- **This audit wrote exactly one file**: `C:\Users\Kalch\Documents\IXI\audit-wave5-session-2026-10-20.md` (this report). No repo file was edited, no build was run in the repo, nothing was deployed.
- `git status --porcelain=v1` entry count: **129** at 22:05 (baseline) → **131** at 22:12. The delta is **two** files: this report, and `backend-f1-magic-token-harness.mjs` (the Backend Developer's own harness, written at 22:11:36 — not this audit's).
- The **repo changed during the audit by someone else** (the Backend Developer landing wave 5/6): `site/shared/server/magic-link.ts` added (22:08:08), `api/portal/auth.ts` rewritten (22:08:50), `site/functions/api/portal/auth.ts` rewritten twice (22:09:42, 22:09:52), `DEPLOY.md` touched (22:08:54), a build run in `site/` (22:06–22:07), and the harness file above (22:11:36). Those are the Backend Developer's work, not this audit's; the handler hashes are recorded in *Snapshot* above.
- Manifest hash of the repo tree (file list + sizes + mtimes, excluding `node_modules/`, `.git/`, `.wrangler/`, `dist/`, `.astro/`): **22:05 baseline (270 files)** `614972832dbce58b5ef6d5cd7a5707f89b453cd6e450afebad8644a48f867d2c` → **22:11 (271 files)** `974f7e4f5d23663a012da7daebc42773a4beb69e32600cf54c5919f687e0f4bc` → **22:12 (272 files)** `839cc2e488b2ad7cbc9dd40c375a0fb0959523cad0d564596bbc2c563a171902` (this report excluded). The 22:11 → 22:12 delta is the Backend Developer's harness file alone.
- `site/data/portal/` is still absent and `site/data/moderation/reviews.jsonl` is still 0 bytes — my harness wrote only into `%TEMP%\opencode\wave5-audit\sandbox`.
