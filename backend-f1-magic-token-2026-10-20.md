# Backend wave 5, F-1 — the one-time magic-link token works across separate Vercel functions

**Status: DONE — F-1 is closed, with executed evidence.** The token is now
self-contained and signed, so no function needs any state from another
function. **F-2 (the session half) is still open** — see section 8; the brief
said it was already fixed, and it is not.

**Independent confirmation.** The Code Reviewer's own read-only audit of the
same wave (`audit-wave5-session-2026-10-20.md`, snapshot 22:11:13) reached the
same two verdicts **by its own execution**: "F-1 — sign-in door dead on the
deploy target: **CLOSED** (executed)" and "F-2 — every authenticated call
401s: **STILL OPEN** (executed) … the cookie minted by `/api/portal/auth/verify`
is refused by `/api/portal/projects`: **401**". Its INFO I-8 (a duplicated
magic-link URL builder) was fixed here: both trees now build the link with the
shared `magicLinkUrl()`.

Repo: `C:\Users\Kalch\Documents\IXI` - Site: `site/` - Vercel tree: `api/` -
Cloudflare tree: `site/functions/` - Date: 2026-10-20
Brief: @Manager, 2026-10-20 22:02 (audit wave 4, F-1)

---

## 1. The defect

`api/portal/auth.ts` kept the one-time magic-link table in **module scope**:

```ts
const magicTokens = new Map<string, { email; purpose; expiresAt; used }>();
```

`validateMagicToken()` verified the HMAC and then looked the token up in that
map; a token that was not in the map was rejected. Vercel builds **one function
per file** under `api/`, so `api/portal/auth/request-link.ts` and
`api/portal/auth/verify.ts` each got their own bundle and their own copy of
the map. The token minted by `request-link` was invisible to `verify`: every
sign-in link the owner mails died with `400 {code:'invalid'}`.

The Code Reviewer reproduced this by execution (audit-wave4-routes-2026-10-20,
F-1): one bundle -> request-link 200 / verify 200; two bundles -> request-link
200 / verify 400.

The Cloudflare twin had the same class of defect in a different shape: its
table lived on `globalThis.__portalMagicTokens`, which is per **isolate**. One
isolate per colo means a link verified in another colo was rejected too.

---

## 2. The fix

### 2.1 The token carries its own proof

**New file: `site/shared/server/magic-link.ts`** — one module for both trees.

| field | value |
|---|---|
| payload | `email \| purpose \| exp \| nonce` |
| signature | `HMAC-SHA256(PORTAL_MAGIC_LINK_SECRET, payload)`, hex |
| token | `base64url(payload \| signature)` |

Verification recomputes the signature from the secret: **no table, no shared
state, no process, no cold start**. Any instance of any function can verify any
token.

The module uses **Web Crypto only** (`crypto.subtle`, `crypto.getRandomValues`)
and no `node:` import, so the Cloudflare tree imports it unchanged. It also
replaces the two duplicated signing implementations with one, so the trees
cannot drift apart the way the moderation link did (the audit's D1/D2 exist
because that code was duplicated).

### 2.2 The two handlers

- `api/portal/auth.ts` — the module-scope `Map`, `generateMagicToken`,
  `validateMagicToken` and `consumeMagicToken` are **gone**; the handler calls
  the shared module.
- `site/functions/api/portal/auth.ts` — the `globalThis` table and the local
  `sha256Hmac` / `sha256Hash` / `base64url*` helpers are **gone**; the handler
  calls the same shared module.

The token format changed: the third field is now an **expiry** (epoch ms)
instead of a mint timestamp. Old tokens are invalid — they were unusable
anyway (that was the defect).

### 2.3 What else changed, and why

- **The purpose is enforced now.** `verify` requires the token's purpose to
  match the one in the request (`portal`). The audit's INFO I-4 noted the
  purpose was never compared; it is now.
- **The signature comparison is constant-time.** The old code compared hex
  strings with `!==`. The shared module compares in constant time (Web Crypto
  has no `timingSafeEqual`, and the edge has no `node:crypto`).
- **The invitation list is unchanged.** The portal stays invite-only: an
  uninvited address gets the same generic 200 and **no token** (verified, R4).
- **One link builder.** Both trees build the sign-in link with the shared
  `magicLinkUrl()`; the inline copy in each handler is gone (the Code
  Reviewer's INFO I-8).

---

## 3. What "single use" means now — stated, not assumed

There is no shared store yet (T4, libSQL/Turso, is the next task), so the
one-time property comes from a **used-token register on `globalThis`**
(`__imkUsedMagicTokens`, keyed by the SHA-256 of the token, so no bearer
credential sits in memory in a readable form).

| | now | after T4 lands |
|---|---|---|
| scope | **per instance** (a Vercel function instance, an edge isolate) | global |
| durability | **none** — lost on a cold start, a redeploy and a scale-out | durable |
| effect | a second verification of the same link that lands on the **same** instance is refused (`400 invalid`); one that lands on **another** instance is accepted | one verification per token, everywhere, forever |
| replay window | the token's TTL (15 minutes), minus whatever the register happens to catch | the TTL, and no more |

Both halves of that are **executed**, not asserted (checks S1 and S2): the same
token verified twice in one process answers `200` then `400 invalid`; the same
token verified in two processes answers `200` then `200` — that second one is
the limitation, measured.

The alternative was a purely stateless token, whose replay window is exactly the
TTL on every instance. The register is strictly better than that, and it costs
one map per instance.

**It is labelled per-instance and not durable.** A reviewer must not read
"one-time" in the current code as a global guarantee.

---

## 4. Fail closed on a missing secret

`PORTAL_MAGIC_LINK_SECRET` is **required in production**:

- a production instance without it answers **`500 {code:'internal'}`** on
  `request-link` and on `verify`, for **every** address (invited and
  uninvited answer identically, so the endpoint still cannot be used to
  enumerate clients);
- the token is never minted, never logged, and never verified;
- the old behaviour — signing with an empty key — is **gone**: an empty HMAC
  key is a public key, so a token forged with an empty key is refused (`400
  invalid`, check F4).

In **development** the module falls back to a **random per-process** secret (never
an empty key), so the local dev server works with no setup. The cost is stated:
a token minted by one process cannot be verified by another — in development
that is the single-process dev server, and in production the secret is mandatory
anyway.

The check order is identical in both trees, except for the edge's store check:

| step | Vercel | Cloudflare |
|---|---|---|
| base URL configured | 500 | 500 |
| origin | 403 | 403 |
| rate limiter | 429 | 429 |
| body / e-mail | 400 | 400 |
| production without `RESEND_API_KEY` | 500 | 500 |
| store reachable (edge only) | - | **501 unimplemented** |
| **`PORTAL_MAGIC_LINK_SECRET` missing** | **500** | **500** |
| invite lookup | generic 200 | generic 200 |

The secret check sits **after** the rate limiter and **before** the invite
lookup: the limiter's contract (the 6th attempt is 429) and the edge's 501
contract stay intact, and the answer is still the same for every address.

---

## 5. Executed evidence

### 5.1 The harness

`backend-f1-magic-token-harness.mjs` (repo root, Backend-owned). It bundles
**each route file as its own entry point** with the repo's own esbuild and runs
**every request in a child process**, so no module state and no `globalThis`
can be shared between the `request-link` function and the `verify` function —
the Vercel situation. The children run with `cwd` = a sandbox that holds its
own `site/data/portal/invited.jsonl`; the repository's data directory is never
touched.

```
node backend-f1-magic-token-harness.mjs
```

**22 checks, 22 passed, exit 0.**

| check | what it proves | result |
|---|---|---|
| V1a | `request-link` (own bundle, own process) | 200, token minted |
| V1b | **`verify` (a DIFFERENT bundle, a DIFFERENT process)** | **200 + session cookie** |
| V1c | the combined `api/portal/auth.ts` bundle (the local dev path) | 200 then 200 |
| V1d | the token is self-contained (address, purpose, expiry, 64-hex signature, TTL <= 15 min) | payload as designed |
| C1 | the Cloudflare `request-link` | 200, token minted |
| C2 | the Cloudflare `verify` in a **separate process** (no shared isolate) | 200 |
| C3 | the Cloudflare `verify` with **no filesystem at all** (the real edge path, admin) | 200 |
| X1 | a Vercel-minted token verifies with the **Cloudflare** verifier | 200 |
| X2 | a Cloudflare-minted token verifies with the **Vercel** verifier | 200 |
| S1 | a second verification **on the same instance** | 200 then **400 invalid** |
| S2 | a verification **on another instance** | 200 then 200 (the stated limit) |
| F1 | production without the secret, `request-link` | 500 `{code:'internal'}` |
| F2 | the same 500 for an invited **and** an uninvited address, byte-identical | identical |
| F3 | production without the secret, `verify` | 500 `{code:'internal'}` |
| F4 | a token signed with an **empty key** (the old forgeable shape) | 400 invalid |
| F5 | the Cloudflare twin fails closed the same way | 500 `{code:'internal'}` |
| R1 | a token signed with the wrong secret | 400 invalid |
| R2 | an expired token | 400 invalid |
| R3 | a token presented with the wrong purpose | 400 invalid |
| R4 | an uninvited address | 200, **no token minted** |
| G1 | the session cookie from `verify` on the next function | **401 — F-2 is still open (measured)** |
| N1 | **the negative control** (see 5.2) | the old code still fails this harness |

### 5.2 The negative control

A harness that cannot fail is not evidence. So the harness also copies the tree
into the sandbox, puts the **old module-scope `Map`** back into the copy, and
runs the same flow:

> **N1 — the old code: `request-link` 200, `verify` 400 invalid.** The defect,
> reproduced by the same harness that now passes. The repository is never
> modified by the control.

### 5.3 The four required checks

```
npm run typecheck:api   -> exit 0
npm run check:routes    -> exit 0   (13 routes, 0 missing function files)
npm run build           -> exit 0   (22 pages built)
npm run check           -> exit 0   (0 errors, 0 warnings, 13 hints — the same 13 hints as before the change)
```

---

## 6. Impact on the existing QA suites — one line each, and it is QA's file

Four QA harnesses simulate a **production** instance (they set
`APP_ENV='production'`) and never configured `PORTAL_MAGIC_LINK_SECRET`. Under
the old code they were signing with an **empty HMAC key** — the very thing the
brief forbids — so they passed. Under the fail-closed rule they now get
`500 {code:'internal'}` from `request-link` and stop.

| suite | before | after | cause |
|---|---|---|---|
| `qa-testimonials.mjs` | exit 0 (81 checks) | **exit 0 (81 checks)** | it sets the secret |
| `qa-backend-hardening.mjs` | exit 0 (20 checks) | **exit 0 (20 checks)** | it sets the secret |
| `qa-rate-limit.mjs` | exit 0 (8 checks) | **exit 0 (8 checks)** | does not sign in |
| `qa-cf-parity.mjs` | exit 0 (10 checks) | **exit 0 (10 checks)** | the edge contract is unchanged |
| `qa-wave2-independent.mjs` | exit 0 (28 checks) | **exit 1** | no secret -> `request-link` 500 |
| `qa-wave3-independent.mjs` | exit 0 (20 checks) | **exit 1** | no secret -> `request-link` 500 |
| `qa-wave4-independent.mjs` | exit 1 (E3/E4, pre-existing) | exit 1 (E3/E4, pre-existing) | unchanged |
| `qa-mutation-probe.mjs` | exit 0 (4 probes) | **exit 1** | it runs the suites above |

**Proof that the secret is the only cause** — the same suites with the secret
in the environment:

```
$env:PORTAL_MAGIC_LINK_SECRET='qa-suite-secret'
node site/qa/qa-wave2-independent.mjs    -> exit 0, 28 passed, 0 failed
node site/qa/qa-wave3-independent.mjs    -> exit 0, 20 passed, 0 failed
node site/qa/qa-mutation-probe.mjs       -> exit 0, 4/4 probes behaved as expected
node site/qa/qa-wave4-independent.mjs    -> exit 1, 21 passed, 2 failed (E3/E4 — the pre-existing rate-limiter lock failures, unchanged from the baseline)
```

**The fix is one line per harness** (QA owns `site/qa/**`, so I did not apply
it):

```js
// site/qa/qa-wave2-independent.mjs, site/qa/qa-wave3-independent.mjs,
// site/qa/qa-wave4-independent.mjs — next to `process.env.APP_ENV = 'production';`
process.env.PORTAL_MAGIC_LINK_SECRET = 'qa-wave-secret';
```

`site/qa/qa-cf-parity.mjs` builds the Worker env itself, so it needs the
secret in `cfEnv()` instead:

```js
PORTAL_MAGIC_LINK_SECRET: SECRET,   // in cfEnv(), site/qa/qa-cf-parity.mjs
```

`site/qa/qa-mutation-probe.mjs` needs nothing of its own once the suites above
are fixed.

This is a **test-fixture gap, not a product regression**: those harnesses were
relying on an empty-key HMAC. A production instance that does not configure the
secret now says so loudly instead of issuing forgeable links.

`site/.env.example` now states that the secret is required in production.

---

## 7. Files changed

| file | change |
|---|---|
| `site/shared/server/magic-link.ts` | **new** — the token, the secret policy, the used-token register (both trees) |
| `api/portal/auth.ts` | the module-scope `Map` and the three token functions removed; the fail-closed check and the purpose check added |
| `site/functions/api/portal/auth.ts` | the `globalThis` table and the local crypto helpers removed; the same checks added |
| `backend-f1-magic-token-harness.mjs` | **new** — the executed evidence (22 checks + the negative control) |
| `site/.env.example` | the secret is documented as required in production |

Not touched: `site/src/**`, `site/qa/**`, `DEPLOY.md`,
`site/shared/server/portal-session.ts`, and no deployment.

---

## 8. What is still open (measured, not assumed)

1. **F-2 — the session half is NOT wired.** `site/shared/server/portal-session.ts`
   (created 2026-10-20 21:03) holds a signed, stateless session, but **nothing
   imports it**: a recursive grep over `api/`, `site/` finds only the file's own
   header. The handlers still import `api/portal/session.ts`, whose
   `const sessions = new Map(...)` (line 18) is a module-scope table, and the
   Cloudflare twin still uses a `globalThis` table. Consequence, measured by
   check **G1**: the cookie the `verify` function issues is refused by the next
   function (`401`). **The sign-in step now succeeds; the portal behind it does
   not yet work on Vercel.** The fix is to make `api/portal/session.ts` (and the
   CF twin) re-export the signed module — a small change I did not make because
   the brief put F-2 out of scope and told me not to modify that file's design.
2. **The Cloudflare target is still a stub.** The edge has no filesystem, so
   every portal read/write answers `501 {code:'unimplemented'}` (unchanged).
   The token verification itself was exercised on the edge path (check C3) and
   works; the CF sign-in flow in the harness runs with a store present.
3. **workerd was never booted.** `wrangler` is not installed on this machine.
   Every Cloudflare claim here is a claim about the CF **code path**, executed
   in Node's Web-standard runtime — the same limitation QA recorded.
4. **T4 (the shared store) is the next task** and is not started. When it
   lands, the used-token register becomes a durable row and "single use"
   becomes global (section 3).
5. **Not verified on a real Vercel deployment.** No token, no `vercel dev`, no
   preview deploy: the conclusion rests on (a) Vercel's documented
   one-function-per-file rule, (b) the executed evidence that separately
   bundled copies of these handlers share nothing, and (c) the negative
   control that reproduces the defect with the same harness. The mechanism is
   proven; the symptom on a live deployment is an inference.

---

## 9. Honest summary

- **F-1 is closed** on the launch target and on the Cloudflare twin, with
  executed evidence against the real handlers, bundled the way the deploy
  target bundles them, each request in its own process: `request-link` 200 ->
  `verify` **200**, not 400.
- **The same harness fails on the old code** (400 invalid), so the result is
  meaningful.
- **"Single use" is per instance and not durable** until T4. The replay window
  is the token's TTL (15 minutes) minus what the register catches.
- **A missing secret now fails closed** in production (500, uniform for every
  address) instead of signing with a public key.
- **Four QA harnesses need one line each** (they simulate production without
  configuring the secret). With the secret set they pass, as measured above.
- **F-2 is still open**: the sign-in step works, the session behind it does
  not, and that is measured, not guessed.
