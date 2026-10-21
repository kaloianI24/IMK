# Backend wave 6 — F-2, F-3, F-4 (2026-10-21)

**Status: DONE** — all three findings are closed in code, in **both** handler trees, with executed evidence.
**One coordination item is open for QA** (`qa-cf-parity` check C1 needs a session secret in its harness env — one line, spelled out below).

Repo: `C:\Users\Kalch\Documents\IXI` · branch `main` (shared dirty tree) · no deploy, no production action, no git add/commit/stash.

---

## 1. What was wrong, and what it is now

### F-2 — the session was a `Map` in a module that only one function could see

`site/shared/server/portal-session.ts` (313 lines, a signed stateless session) had **zero importers**. The live session lived in `api/portal/session.ts` (a module-scope `Map`) and, on the edge, in `site/functions/api/portal/session.ts` (a `globalThis` `Map`).

Vercel builds **one function per file** under `api/`. The Code Reviewer reproduced the consequence by execution: `request-link` 200, `verify` 400 "link expired or invalid", and **every authenticated call 401**. No client could sign in on the deployed target.

**Now:** one module, shared by both trees, edge-safe, and the session is a **signed stateless token**.

| | Before | Now |
|---|---|---|
| Where the session lives | a `Map` in one function's module scope | the cookie carries it; the signature is the proof |
| Another function / bundle / instance | `401` | accepted |
| The edge (a Worker isolate per colo) | a `Map` per isolate | the same token, any isolate |
| Missing signing secret | silent per-process fallback | **fail closed**: `500 {code:'internal'}`, no session |

The token is `v1.<base64url(payload)>.<hmac-sha256-hex>`; the payload carries the email, the role, the clientId and the expiry; the signature is `HMAC-SHA256(secret, "v1." + payload)`.

### F-3 — the moderation write was unguarded and threw out of the handler

`api/moderate/review.ts:68` `writeReviews()` had no `try/catch` and line 222 called it unguarded, so an unwritable store threw instead of answering the documented `500 {code:'storage'}` / `501`. A **missing** store still answered `404 "review not found"` — the exact "my quote is gone" outcome §4.8.4 claimed to have killed (it had only been killed in the edge tree).

**Now** (Vercel tree, matching the edge twin):

| Situation | Answer |
|---|---|
| the store cannot be **reached** (no file) | `501 {code:'unimplemented'}` |
| the store cannot be **parsed** (a malformed line) | `500 {code:'storage'}` |
| the **write fails** | `500 {code:'storage'}` — never "approved" |
| the store is fine | `200 {ok:true, state:'approved'}` and the decision is on disk |

### F-4 — the rate-limit lock mistook a busy lock for a broken backend

`api/lib/rate-limit.ts` treated only `EEXIST` as "somebody holds the lock" and rethrew everything else. On Windows a lock file in the **delete-pending** state fails with `EPERM`, not `EEXIST` — a transient, normal condition. The error escaped `hit()`, `RateLimiter.consume()` caught it and latched `backendFailed = true` **for the life of the process**: every later hit went to the per-process in-memory counter, the durable counts were lost, the cross-process limit stopped being enforced, and **nothing was logged**.

**Now:** `EEXIST`, `EPERM`, `EACCES` and `EBUSY` are busy-and-retry (a busy lock produces the module's own diagnosable error, `rate-limit: could not take the counter lock`), and the degradation is logged **once** with the underlying error code. The edge twin had the same silent latch and got the same once-only log.

---

## 2. Why the MAC is implemented in the module and not with `crypto.subtle`

WebCrypto's only message-authentication primitive is `crypto.subtle.sign`, and it is **asynchronous**.

The session API is **synchronous by contract**: `const session = resolveSession(req)` in seven Vercel handlers, seven Cloudflare handlers and a QA suite. A synchronous signature check is what keeps the cookie validation inside a plain `if (!session)` guard. An async API would need an `await` at every one of those call sites, and **a missed `await` turns that guard into a truthy `Promise`** — a silent authentication bypass, not a compile error. A synchronous API needs a synchronous MAC, so the HMAC-SHA256 is implemented in plain TypeScript in `site/shared/server/portal-session.ts` (no `node:` imports → it loads in a Worker isolate unchanged).

That implementation is **not trusted on the strength of the comment**: `backend-wave6-harness.mjs` W1 compares it with `node:crypto`'s `createHmac` over **318 inputs** — every padding/length boundary (0, 1, 55, 56, 63, 64, 65, 119, 120, 127, 128, 129 bytes), empty secret, empty message, unicode, 100 KB message, plus 300 random pairs — and requires byte-for-byte equality.

---

## 3. Files changed

| File | Change |
|---|---|
| `site/shared/server/portal-session.ts` | **rewritten** — edge-safe (no `node:` imports), synchronous, one module for both trees, signed token instead of a `Map`, fail-closed secret, revocation list keyed by the token's SHA-256 |
| `api/portal/session.ts` | thin re-export of the shared module |
| `site/functions/api/portal/session.ts` | thin re-export of the shared module |
| `api/portal/auth.ts` | the sign-in door refuses to send a link / to verify / to issue a session when no signing secret is configured; `createSession` returning `null` → `500 {code:'internal'}` |
| `site/functions/api/portal/auth.ts` | the same, with the request's `env` |
| `site/functions/api/portal/{comments,invites,plan-items,projects,testimonials,updates}.ts` | the edge handlers pass the request's `env` to `resolveSession` (a Worker has no `process.env`) |
| `api/moderate/review.ts` | strict read + guarded write + `501` for an unreachable store (F-3) |
| `api/lib/rate-limit.ts` | busy-and-retry classification + once-only degradation log (F-4) |
| `site/functions/api/lib/rate-limit.ts` | the same once-only degradation log (the same silent latch) |
| `site/scripts/api-index.ts` | the comment that described the shared in-memory `sessions` `Map` (no longer true) |
| `backend-f1-magic-token-harness.mjs` | check **G1 inverted**: the session cookie from the verify function is now **accepted** by another function (`200`, was `401`) |
| `backend-wave6-harness.mjs` | **new** — 23 executed checks for F-2/F-3/F-4, incl. two mutation probes |
| `spec/08-portal-mvp.md` | §4.9 (the contract) and §10.5 (Revision 6) |

**Not touched:** `site/src/**` (Frontend), `site/qa/**` (QA), `site/data/**` (real records), `DEPLOY.md`, `.gitignore`, `site/.env.example`, `site/shared/portal-store/**` (T4). No deploy, no production action, no `git add/commit/checkout/stash/clean`.

---

## 4. Checks — executed, with the real output

### My own harness — `node backend-wave6-harness.mjs` → **23 passed, 0 failed**

| Group | Check | Result |
|---|---|---|
| W1 | the HMAC equals `node:crypto`'s, over 318 inputs | byte-for-byte identical |
| W2 | the session cookie minted by `verify` is accepted by **another function, another bundle, another process** | **200** (was 401) |
| W2 | a forged cookie / a cookie signed with another secret | 401 / 401 |
| W2 | **mutation probe**: the OLD `Map` session, rebuilt from a copy | 401 → the probe detects the defect |
| W3 | a Cloudflare-minted session is accepted by the Vercel tree, and the other way round | both accepted, same email/role/clientId |
| W3 | the edge routes on the session it can verify (the QA C1 scenario) | owner → 501, client → 403 |
| W4 | missing store / corrupt store / unwritable store / writable store | 501 / 500 storage / 500 storage (never "approved") / 200 approved |
| W5 | 4 writers × 20 keys × 5 rounds into one counter file | **every bucket holds 20 — nothing lost** |
| W5 | a broken durable backend | degrades, **one** log line with the error code, the requests still succeed |
| W5 | a busy (delete-pending) lock | the module's own error, **not** a raw `EPERM` |
| W5 | **mutation probe**: the OLD lock classification | leaks the raw `EPERM` → the probe detects the defect |
| W6 | no secret, production, both trees | 500 `{code:'internal'}`, no session cookie |

### The F-1 harness — `node backend-f1-magic-token-harness.mjs` → **22 passed, 0 failed, exit 0**

```
PASS  G1  the session cookie from verify IS accepted by another function
          — 200 on the next function — the session is stateless, F-2 is closed
```

### The gates

```
npm run typecheck:api   exit 0   (api + functions + shared)
npm run test:store      22/22
npm run check:routes    13 route(s), 0 missing function file(s)
npm run build           22 page(s) built, exit 0
npm run check           0 errors, 0 warnings, 9 hints  (none in the changed files)
```

### QA's own suites, re-run by me on this HEAD

| Suite | Result |
|---|---|
| `qa-testimonials.mjs` | **81/81** |
| `qa-testimonials-build.mjs` | **14/14** |
| `qa-backend-hardening.mjs` | **20/20** |
| `qa-rate-limit.mjs` | **8/8** |
| `qa-wave2-independent.mjs` | **28/28** |
| `qa-wave3-independent.mjs` | **20/20** |
| `qa-wave4-independent.mjs` | **23/23** — including **E3** (`busy lock -> rate-limit: could not take the counter lock`) and **E4** (`8 rounds x 4 writers x 40 keys, nothing lost`) |
| `qa-mutation-probe.mjs` | **4/4 probes behaved as expected** |
| `qa-cf-parity.mjs` | **9/10 — C1 fails** (see §6) |

> Note for whoever re-runs these: `qa-wave2/3/4-independent.mjs` set `APP_ENV=production` but do **not** set `PORTAL_MAGIC_LINK_SECRET` themselves — they need it in the environment (`$env:PORTAL_MAGIC_LINK_SECRET='...'`), otherwise the sign-in door answers `500` (the misconfiguration rule) and the suite stops at its first check. `qa-testimonials.mjs` sets its own secret and needs nothing.

---

## 5. The honest limits — stated, not assumed

1. **The Vercel router was never booted** (no token, no preview deploy). The cross-bundle proof is *mechanism* evidence: the real handlers, bundled one file per function, run in separate processes. The deployed symptom is inferred from that mechanism plus Vercel's documented rule.
2. **workerd was never booted** (no wrangler on this machine). The Cloudflare claims are about the CF **code path** executed in Node's Web-standard runtime.
3. **The Cloudflare portal is still a stub** (501) — the store cannot be read there. The session module now works on that target, but nothing else does yet.
4. **The portal still cannot run on Vercel**: a function's filesystem is read-only, so the JSONL store cannot persist there. **T4 (Turso/libSQL) is still the gate** — my answer is unchanged: Turso, keep Vercel.
5. **Logout cannot revoke a token server-side** (the cookie is cleared; the token expires on its own in 24h). The revocation list is a per-instance extra. Durable revocation belongs to the shared store.
6. **The session secret is a new production requirement** (or the existing `PORTAL_MAGIC_LINK_SECRET` as a fallback). DevOps: `PORTAL_SESSION_SECRET` must be in the env list, and the deployment must have it — without it the portal answers `500` on every sign-in.
7. The HMAC is a hand-written primitive (no `node:` imports, sync API — §2). It is proven against the platform by execution, but it is not the platform's own implementation; a future review may still prefer an async API over it.
8. **No browser run.** The dev server on 4321 (pid 13908, restarted 20:12:57) already runs this code — `GET /api/portal/projects` without a cookie answers `401` from it — but no browser sign-in was driven.

---

## 6. The one thing I need from QA

`site/qa/qa-cf-parity.mjs` **C1** fails: *"the Cloudflare portal endpoints answer 501 on the edge"* → `the invites status for an owner — expected 501, got 403`.

**Why:** the suite mints a session with `cf.cfSession.createSession('owner@imk.test', 'admin')` and its `cfEnv()` has `APP_ENV: 'production'` with **no signing secret**. With the fail-closed rule a session cannot be minted there — that is the rule doing its job (a session signed with an ephemeral per-process secret is exactly the defect F-2 removed).

**The fix is two lines in `site/qa/qa-cf-parity.mjs`** (it is QA's file — I did not touch it):

```js
// in cfEnv():
PORTAL_SESSION_SECRET: 'cf-parity-secret',

// next to the other process.env assignments (the mint is called WITHOUT an env):
process.env.PORTAL_SESSION_SECRET = 'cf-parity-secret';
```

**Proof it is enough:** `backend-wave6-harness.mjs` **W3d** runs exactly that scenario (an admin session and a client session minted with a secret in the Worker env, then the owner-only invites route) and gets **owner → 501, client → 403** — the behaviour C1 asserts.

---

## 7. One thing the room should know (not mine, but I triggered the visible part)

During my window, `site/data/` was seeded with **fixture** data by someone else (reviews `fixture-*-2026-10-21`, `inv_fixture01` / `prj_fixture01`; `clients.jsonl` removed) — the timestamps are 20:11:58 and 20:12:43, during my runs. My `npm run build` then ran the `prebuild` publish script, which published the two fixture quotes into `site/src/content/testimonials/`:

- `site/src/content/testimonials/fixture-rated-2026-10-21.md`
- `site/src/content/testimonials/fixture-unrated-2026-10-21.md`

I did **not** write the fixtures and I did **not** touch `site/data/` — but the publish script turns anything in `site/data/moderation/reviews.jsonl` into published content, so **fake testimonials are currently in the build output**. The publish script wipes and regenerates that directory on every build, so removing the fixture records from the store and rebuilding clears it. @Frontend Developer / @QA Engineer — whoever seeded them owns the cleanup.

---

## 8. One deploy risk I did not touch (pre-existing, flagging it)

Vercel creates **a function for every file under `api/`**, and a function file must export a default function. Four files under `api/` are shared utilities with **no default export**:

```
api/lib/jsonl.ts
api/lib/notifications.ts
api/lib/rate-limit.ts
api/portal/session.ts
```

Vercel's own rule is "keep shared utilities and route modules **outside** `api/`" — these four are exactly that. This is **pre-existing** (all four had no default export before this wave; `api/portal/session.ts` is still only a re-export) and it is **outside this wave's scope**, so I did not move them — moving `api/lib/*` would touch every handler's import paths. It is also **unverified**: I have no Vercel token here, so I could not boot the router or see whether the builder errors on them. It should be checked on the first preview deploy (@DevOps), and the fix is to relocate them under `site/shared/` (which is what the Architect's interface should own anyway).

## 9. What is still open (unchanged)

- **Turso vs Neon, and does Vercel stay** (T4–T12 are not started). My answer: **Turso, keep Vercel**.
- Consent wording (`site/src/data/testimonial-consent.ts`), the real domain, the real Calendly link, the Resend sender identity.
- The Vercel **Root Directory** dashboard setting (DevOps).
- The production secrets — now including `PORTAL_SESSION_SECRET`.
