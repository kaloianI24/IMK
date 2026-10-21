# Wave-6 Independent Code Audit — review-wave6-audit-2026-10-21

**Auditor:** Code Reviewer — Independent Audit (Principal Code Reviewer)
**Repo:** `C:\Users\Kalch\Documents\IXI`, branch `main`, shared dirty tree, **no git remote**
**Date:** 2026-10-21
**Scope:** the wave-6 code (session module, moderation contract, rate limiter, admin inbox, tree parity, repo-wide smells)
**Posture:** read-only on application code. The only file this audit writes is this report. No deploy, no network call to Vercel/Cloudflare, nothing written under `site/data/`.

---

## 0. Method — what I actually did

I did not trust the four wave-6 reports. I read the current files on disk and **executed** the code myself.

**Executed evidence** (my own probe, outside the repo, in
`C:\Users\Kalch\AppData\Local\Temp\opencode\cr-wave6\`, 5 scripts, 62 executed assertions):

| # | Probe | What it ran |
|---|---|---|
| A | `probe.mjs` | the real `site/shared/server/portal-session.ts` + `api/admin/session.ts`, bundled with esbuild from the working tree |
| B | `probe.mjs` | the real `api/moderate/review.ts` against a **temp** store (`process.cwd()` redirected) |
| C | `probe.mjs` | the real `api/portal/projects.ts` against a temp store |
| D | `probe.mjs` | the real `api/lib/rate-limit.ts` (file backend, real lock file) |
| E | `probe.mjs` + `worker.mjs` | the real moderation handler in **two separate processes** (the Vercel model) |

`site/data/` was never touched: every probe redirected `process.cwd()` into the temp dir, so the handlers' `path.resolve(process.cwd(), 'site/data/...')` constants resolved there. `git status` is unchanged by this audit (the report file is the only addition).

**Read-only reasoning** is labelled as such throughout. Where I could not execute (the Vercel router, workerd, a real deploy), the finding says so.

---

## 1. Verdict

**Wave 6 is a real improvement and the three fixes hold.** The session module is one module for both trees, stateless, edge-safe; the moderation contract refuses what it should refuse; the rate limiter no longer misclassifies a busy lock. My probes found **no exploitable authentication bypass, no signature weakness, no XSS, and no PII leak to a non-admin**.

What I did find are **eight defects that the wave-6 reports did not mention**, two of them HIGH and conditional on a very plausible deployment mistake (the shipped `.env.example`), and six MEDIUM/MINOR items where the *guarantee* is weaker than the *comment* claims it is.

| Severity | Count | IDs |
|---|---|---|
| CRITICAL | 0 | — |
| HIGH | 2 | H-1, H-2 |
| MEDIUM | 6 | M-1 … M-6 |
| MINOR | 12 | m-1 … m-12 |

---

## 2. HIGH findings

### H-1 — The three production secrets ship as identical, publicly-known placeholders, and nothing rejects them

**Where:** `site/.env.example` — `FORM_WEBHOOK_SECRET`, `PORTAL_MAGIC_LINK_SECRET`, `PORTAL_SESSION_SECRET` are all set to the same value `your-32-byte-hex-hmac-secret-here`.

**Why it is exploitable:** every secret check in the codebase tests *presence*, never *value*:

- `site/shared/server/portal-session.ts:326-334` — `sessionSecret()` returns the configured string as-is
- `site/shared/server/magic-link.ts:93-100` — `magicLinkSecret()` likewise
- `api/moderate/review.ts:170-174` — only `if (!secret) → 500`
- `api/admin/reviews.ts:144` — only `if (!process.env.FORM_WEBHOOK_SECRET) → 500`

The documented workflow is "copy `site/.env.example` to `.env` and replace the placeholders" (`site/.env.example:2`). If that replacement is missed — on one of three secrets, or on all three — the deployment runs with a secret that is **published in the repository** and identical for the session signer, the magic-link signer and the moderation signer. The moderator's address (`2imk4support@gmail.com`) is on the public website, so an attacker who knows the placeholder can forge:

- an **admin session** for that address (`v1.<payload>.<hmac>` with `r:"admin"`) → the whole portal and `/admin` inbox (the session token is minted and verified by `site/shared/server/portal-session.ts`, the role lives in the signed payload);
- a **magic-link token** for any address → sign in as any client;
- a **moderation link** for any `ref` → approve or reject any quote.

The code already has the pattern for exactly this class of mistake: `api/contact.ts:181-185` refuses to start when `DEV_STUB === '1'` in production.

**Executed evidence:** probe F — production with no secret → `null` (fail closed); but a *present* secret is accepted verbatim, with no value check anywhere in the three modules above.

**Fix (concrete):**
1. In `sessionSecret()` / `magicLinkSecret()`, and in the `FORM_WEBHOOK_SECRET` guards of `api/moderate/review.ts` + `api/admin/reviews.ts`, add a production-time guard that refuses a secret equal to the published placeholder (and refuse the three secrets being equal to each other):
   ```ts
   const PLACEHOLDER_SECRETS = new Set(['your-32-byte-hex-hmac-secret-here']);
   export function secretIsPlaceholder(v: string): boolean {
     return PLACEHOLDER_SECRETS.has(v.trim()) || v.trim().length < 16;
   }
   ```
   → treat it exactly like a missing secret: `500 {code:'internal'}`.
2. Give the three secrets **different** placeholder values in `site/.env.example`, so a copy-paste that forgets to change one of them is still visible in the diff.

---

### H-2 — `APP_ENV=development` in the shipped example silently switches off every fail-closed guard

**Where:** `site/.env.example` → `APP_ENV=development`.

**Why it is exploitable / breaks the product:** `isProductionEnv()` (`site/shared/server/portal-session.ts:312-315`, `site/shared/server/magic-link.ts:67-70`) treats anything that is not exactly `production` as development. With `APP_ENV=development`:

- `sessionSecret()` (`:326-334`) no longer fails closed — it returns a **per-process random** secret. On Vercel every route file is its own process, so the session minted by `/api/portal/auth/verify` is refused by `/api/portal/projects` with `401 {code:'unauthorized'}`. **That is exactly the F-2 symptom, silently restored** — and unlike a missing secret, nothing logs or errors.
- `sendMagicLinkEmail()` (`api/portal/auth.ts:171-197`) stops failing closed on a missing `RESEND_API_KEY` and instead **writes the sign-in token and the full sign-in URL to the log** (`api/portal/auth.ts:186-197`).
- The QA suites deliberately set `APP_ENV=production`, so no suite in the repo would ever catch this.

**Executed evidence:** probe F — `sessionSecret({APP_ENV:'production'})` → `null`; `sessionSecret({})` → `null` (unset means production); `sessionSecret({APP_ENV:'development'})` → a random per-process value.

**Fix (concrete):**
1. Delete `APP_ENV` from `site/.env.example` — the code already defaults to production when it is unset (`portal-session.ts:314`). Leave a comment: *"unset = production; set to `development` only for a local machine."*
2. If the variable must stay, ship `APP_ENV=production` in the example and document the local override in the README.
3. Independently of the env file: log a loud warning at boot whenever `isProductionEnv()` is false on a host that is not localhost (the current code has no such signal).

---

## 3. MEDIUM findings

### M-1 — The moderation state is flipped by a plain GET, so any mail scanner approves the owner's quotes

**Where:** `api/moderate/review.ts:128` (the route answers **GET** only) and `:270-282` (the state flip and the write). The Cloudflare twin is identical: `site/functions/api/moderate/review.ts:108` (`onRequestGet`) and `:241-250`.

**Why it matters:** the approve/reject links that are mailed to the owner are GET URLs (`api/lib/notifications.ts:110-119`, `site/functions/api/lib/notifications.ts:113-124`). Corporate mail gateways, Gmail's link handling and chat-preview bots **fetch links in incoming mail automatically**. The HMAC protects the link against forgery; it does nothing about a legitimate prefetch by the owner's own mail provider. The outcome is that a quote gets published with nobody's consent — the exact thing the owner inbox exists to prevent.

**Executed evidence:** probe B — one `GET /api/moderate/review?ref=…&sig=…` with a valid signature flipped the stored record `pending → approved` and answered `200 {"ok":true,"state":"approved"}`.

**Fix (concrete):** make the decision a `POST` that carries the signed parameters in the **body**, and make the e-mailed link open a small confirmation page ("Approve this quote?") whose button issues the POST. The admin screen (`site/src/pages/admin.astro`) already fetches with `credentials:'include'` and can switch to `method:'POST'` in one line. If a GET must stay, add a one-time nonce that is only consumed on a second, user-initiated request.

---

### M-2 — A five-second lock contention permanently abandons the durable rate-limit counter for the life of the process

**Where:** `api/lib/rate-limit.ts:171-173` throws `new Error('rate-limit: could not take the counter lock')` when the 5 s budget is exhausted → `RateLimiter.consume()` catches it at `:283-291` and sets **`this.backendFailed = true` permanently**. The edge twin has the same latch on any KV error: `site/functions/api/lib/rate-limit.ts:145-156`.

**Why it matters:** F-4 fixed the *classification* of the busy error codes (`LOCK_BUSY_CODES`, `api/lib/rate-limit.ts:137`), but the *latch* is unchanged. The busy timeout is transient by nature — the lock is released a moment later — yet it is treated as a permanent backend failure: from that point on the durable counter is never consulted again, so the cross-process limit the code documents ("the read-modify-write runs under an exclusive lock file, so two writers cannot lose each other's hits") silently stops being enforced for the whole life of the process. The operator sees one log line, and that line carries `code: null` (`api/lib/rate-limit.ts:308`) because the thrown `Error` has no `.code` — so a timeout is indistinguishable from a broken backend in the logs.

**Executed evidence:** probe D —
```
PASS  the busy retry waited for the 5 s budget :: 5013 ms
PASS  the NEXT request is still degraded (the latch is permanent) :: degraded=true
PASS  the durable counter file was NOT updated after the lock was released
PASS  a fresh process (new limiter) uses the durable backend again :: degraded=false
```
(the lock file *is* released on the success path — that part is correct.)

**Fix (concrete):**
1. Give the timeout a code: `const e = new Error('rate-limit: could not take the counter lock'); (e as any).code = 'ELOCKTIMEOUT'; throw e;` → the once-only log then names the cause.
2. Do **not** latch on a transient timeout. Latch only on a non-busy backend error; for `ELOCKTIMEOUT` fall back to the in-memory counter for this request and **re-probe the durable backend on the next request** (or after a cooldown, e.g. 30 s).
3. Same change on the edge twin (`site/functions/api/lib/rate-limit.ts:147`).
4. Secondary: `EACCES` is in `LOCK_BUSY_CODES`, but `EACCES`/`EROFS` is also what a **read-only directory** returns. On such a target every request would burn 5 s in the retry loop before degrading. Treat a read-only-filesystem error as a hard failure (degrade immediately), not as contention.

---

### M-3 — The session module accepts an arbitrarily long-lived token (the magic-link module has this guard, the session module does not)

**Where:** `site/shared/server/portal-session.ts:503`:
```ts
if (typeof payload.x !== 'number' || Date.now() > payload.x) return null;
```
There is **no upper bound** on `payload.x`. Compare `site/shared/server/magic-link.ts:234-236`:
```ts
if (exp - now > MAGIC_TOKEN_TTL_MS + CLOCK_SKEW_MS) return { valid: false, reason: 'expired' };
```

**Why it matters:** only a holder of the signing secret can mint such a token, so this is not a direct attack path — it is a missing defence-in-depth that the sibling module already implements, and it becomes live the moment the secret leaks (H-1) or a future bug mints with the wrong TTL: a token claiming "valid until the year 3000" is accepted forever.

**Executed evidence:** probe A — a token whose payload was signed with the secret and claims `x = now + 3e11` was **accepted** (`{"email":"a@b.c","role":"client"}`); the same probe shows every other malformed shape (empty, 2 parts, 4 parts, bad base64, non-JSON payload, `role:"superuser"`, `x` in the past, non-string `e`) is refused with `null` and **nothing throws** (a 200 KB token is refused in 1.5 ms).

**Fix (concrete):** mirror the magic-link rule —
```ts
const now = Date.now();
if (typeof payload.x !== 'number' || now > payload.x) return null;
if (payload.x - now > SESSION_TTL_MS + 60_000) return null;   // never honour a token that outlives the TTL
```

---

### M-4 — Removing an address from `ADMIN_EMAILS` does **not** revoke the owner's portal powers (it does revoke `/admin`)

**Where:** the owner-only branches of `api/portal/projects.ts:167` and `:258`, `api/portal/plan-items.ts:248`, `api/portal/invites.ts:189`, and the CF twins, all gate on `session.role === 'admin'` **only**. The role is baked into the 24 h signed token at sign-in time (`api/portal/auth.ts:445`: `const role = isAdmin(email) ? 'admin' : 'client'`). The `/api/admin/*` endpoints do the right thing and re-read the live list (`api/admin/session.ts:78-88` → `isAdminEmail(session.email, env)`), so the two halves of the owner story disagree.

**Why it matters:** `site/.env.example` promises the opposite —
> *"The list is read on EVERY admin request, so removing an address here revokes access immediately - not when the 24h session token expires."*

For `/admin` that is true. For the portal's owner endpoints (change any client's project status, create projects, manage invites, edit plan items) it is **false for up to 24 hours** after the address is removed.

**Executed evidence:** probe C — with `ADMIN_EMAILS` set to an address that does **not** include the session's owner, `PATCH /api/portal/projects/<id>` still answered **200** and the stored project status changed `discovery → in-progress`.

**Fix (concrete):** put the owner check in one shared place and use it everywhere:
```ts
// site/shared/server/portal-session.ts
export function resolveOwnerSession(source, env): Session | null {
  const s = resolveSession(source, 'admin', env);
  if (!s || s.role !== 'admin') return null;
  return s;   // + the live allow-list check, via the shared isAdminEmail helper
```
then replace every `session.role === 'admin'` in the portal handlers with it (the allow-list helper already exists twice: `api/admin/session.ts:51-58` and `site/functions/api/admin/session.ts`; move it into `site/shared/server/` so both trees share it).

---

### M-5 — A valid admin cookie in the browser widens the **client's** read scope to every client

**Where:** `resolveSession()` with no `preferRole` returns the **admin** cookie first — `site/shared/server/portal-session.ts:528-537`:
```ts
const order: Role[] = preferRole ? [preferRole, …] : ['admin', 'client'];
```
and the client-facing read endpoints call it exactly that way: `api/portal/comments.ts:82`, `api/portal/plan-items.ts:85`, `api/portal/updates.ts:82` (and the CF twins, e.g. `site/functions/api/portal/projects.ts:62`).

**Why it matters:** the audit-m5 fix handled the **stale** admin cookie (a cookie that does not resolve is skipped — verified working, probe A). The **live** admin cookie is still preferred. In a browser that holds both `imk_session` (client) and `imk_admin_session` (owner) — the owner testing the client flow on their own machine, or a shared office computer — every client-facing GET is answered with the **owner's** scope: `session.role === 'admin'` → `projectAccessible()` returns true for everything (`api/portal/projects.ts:108`) and the response contains every client's projects, comments and updates.

**Executed evidence:** probe C — `GET /api/portal/projects` with a valid **client** cookie *and* a valid **admin** cookie returned **2 of 2** projects, including `prj_other` (a different client). The same request with the client cookie alone returned only the client's own project.

**Fix (concrete):** client-facing endpoints must ask for the client cookie first and only accept an admin session where owner access is intended:
```ts
const session = resolveSession(req, 'client');   // api/portal/comments.ts:82, plan-items.ts:85, updates.ts:82
```
and where owner access is genuinely wanted, use the owner check from M-4 (so it is allow-list backed).

---

### M-6 — The moderation store is written with a plain `writeFileSync` — no lock, no atomic rename; an interrupted write takes the whole queue offline

**Where:** `api/moderate/review.ts:96-105`:
```ts
fs.writeFileSync(REVIEWS_FILE, content, 'utf8');   // truncate + write, in place
```
and the Cloudflare twin `site/functions/api/moderate/review.ts:95-106`. Compare the rate-limit counter, which does it properly: write to a temp file and rename (`api/lib/rate-limit.ts:220-227`) plus an exclusive lock (`api/lib/rate-limit.ts:143-194`).

**Why it matters:** `writeFileSync` truncates the file first. If the process dies between the truncate and the end of the write (kill, OOM, container restart, disk full), the store is left half-written. Because the shared parser is deliberately strict (`site/shared/portal-store/jsonl.ts:50-77` — one bad line is an error, never an empty list), **one interrupted write makes every moderation request answer `500 {code:'storage'}`** — and the owner inbox reads the same file with the same parser (`api/admin/reviews.ts:172-175`), so the inbox is down too. The queue is unrecoverable until a human repairs the file by hand.

**Executed evidence:** probe E — a store truncated to 60 % of its bytes made the endpoint answer `500 {"error":"storage unavailable","code":"storage"}` for a ref that was perfectly valid before the truncation. (The admin inbox path is the same parser and the same file — read-only reasoning.)

**Not reproduced:** a cross-process **lost update** (two processes approving two different quotes, each writing the whole file) is possible by the same read-modify-write shape — there is no lock — but I did **not** reproduce it in 12 concurrent two-process runs (probe E: `0/12` runs lost a decision, `12/12` landed). I report it as reasoning, not as a reproduced defect.

**Fix (concrete):**
```ts
const tmp = `${REVIEWS_FILE}.${process.pid}.${Date.now()}.tmp`;
fs.writeFileSync(tmp, content, 'utf8');
fs.renameSync(tmp, REVIEWS_FILE);      // atomic on POSIX and on Windows
```
and take the same exclusive lock the rate limiter uses around the read-modify-write (or move the decision into the shared store, which is T4).

---

## 4. MINOR findings

| ID | Where | Finding | Fix |
|---|---|---|---|
| m-1 | `site/shared/server/portal-session.ts:418-443` | The revocation list grows without bound and its prune is quadratic. `destroySession` stores **any** string it is handed (no validation that the token ever parsed), and the prune above 500 entries only removes **expired** entries, so fresh ones are never dropped. **Executed:** 2000 calls grew the map `0 → 2000` and it stayed there; each call above 500 scans the whole map (35 ms for 2000 calls). Bounded in practice by "logouts in the last 24 h" per instance, so this is hygiene, not an attack path. | Only record tokens that `parseSession` accepted; cap the map (drop the oldest when over the cap) instead of relying on expiry. |
| m-2 | `site/shared/server/portal-session.ts:595-602`, `api/portal/auth.ts:515-519` | The cookie's `Secure` flag depends on the operator typing `https://` in `SITE_BASE_URL`. `baseUrlConfigured()` only checks that a URL is *set*, not its scheme → `SITE_BASE_URL=http://imk.example` mints the session cookie **without `Secure`**. | In production, refuse to mint a session when the configured base URL is not `https://` (same shape as `baseUrlConfigured`). |
| m-3 | `site/shared/server/portal-session.ts:562-565` | `clearSessionCookieString()` omits `Secure` while the set-cookie adds it (`Max-Age=0` without `Secure`). Harmless (cookies match on name/path/domain) but asymmetric. | Emit the same attribute set as the set-cookie. |
| m-4 | `site/shared/server/portal-session.ts:326-334` | `PORTAL_MAGIC_LINK_SECRET` doubles as the **session** signing key. One key, two protocols. The message formats differ so there is no forgery path, but a leak in one protocol compromises the other — and `.env.example` sets all three secrets to the same placeholder (H-1). | Keep the two values distinct (the module already prefers `PORTAL_SESSION_SECRET`) and domain-separate the HMAC input (`'session:' + payloadB64` / `'magic:' + message`). |
| m-5 | `vercel.json` (`"/admin/(.*)"`, `"/portal/(.*)"`, `"/login/(.*)"`) | The `(.*)` group needs a literal `/` before it, and the pages are served at the **bare** paths `/admin`, `/portal`, `/login` (`site/astro.config.mjs:8` — `trailingSlash: 'never'`), so these header sources probably do not match the pages themselves. The HTML meta tag is correct (`site/src/layouts/BaseLayout.astro:47` → `noindex, nofollow`; the sitemap filter excludes `/admin` — `site/astro.config.mjs:14`), so the page itself is safe; only the header defence-in-depth is in doubt. **I could not verify against Vercel's router** (no token, no deploy) and the `path-to-regexp` copy in `site/node_modules` is v0.1.13, which is not the version Vercel uses, so a local test would prove nothing. | Add the exact paths next to the patterns: `{"source": "/admin", …}`, `{"source": "/portal", …}`, `{"source": "/login", …}`. Then check on the first preview deploy: `curl -I https://<preview>/admin` and look for `X-Robots-Tag`. |
| m-6 | `api/lib/jsonl.ts`, `api/lib/notifications.ts`, `api/lib/rate-limit.ts`, `api/portal/session.ts` | **Confirmed by execution** (file-by-file export check): these four files under `api/` have **no default export** → Vercel builds a function per file → those URLs answer 500 ("Can't detect way to handle request"). `api/` holds **20** `.ts` files = 16 routes + 4 dead — above the Hobby cap of 12. (`api/portal/auth.ts` is a 17th route that answers 404 for its own path.) | Move the four modules to `site/shared/server/` (the session module has already proven the pattern and the imports are mechanical) and re-point the callers. |
| m-7 | `api/admin/session.ts:67-69` | `adminEmailsConfigured()` treats a comma-only `ADMIN_EMAILS` as *configured* → every request answers 401 forever instead of 500 misconfigured. Fail-closed, so safe — but it hides the misconfiguration from the operator. **Executed.** | Parse the list once and treat "configured but empty after parsing" as misconfigured. |
| m-8 | `api/portal/auth.ts:526-544` | The logout endpoint has **no Origin check**, while every other state-changing endpoint has one (`api/portal/projects.ts:180-186`). `SameSite=Strict` covers the cross-site case, so the real risk is low — but the protection then rests on the cookie attribute alone. | Add the same `expectedOrigin()` check as the other mutating routes. |
| m-9 | `api/portal/projects.ts:103-105` | `clientIdOf()` is defined and never used (dead code). | Delete it. |
| m-10 | `api/portal/auth.ts:217` and `:222` | The Resend **failure** path logs the client's full email address (`{ email, outcome:'email_fail' }`), while the misconfigured path redacts it (`:181`). | Redact the address the same way in both paths. |
| m-11 | `api/lib/notifications.ts:138-143`, `site/functions/api/lib/notifications.ts:57-63` | `escapeHtml()` does not escape the single quote. Every current interpolation is text content or a double-quoted attribute, so there is **no live XSS** — but it is one `'` away from one. (The admin page is clean: `site/src/pages/admin.astro` renders every client-supplied value with `textContent`, never `innerHTML` — so a hostile quote text cannot inject script into the owner's inbox.) | Add `'` → `&#39;` to the escaper. |
| m-12 | `site/shared/portal-store/jsonl.ts:87-96` | `guardStorage()` re-throws any non-corrupt error → an `ENOENT` race between `fs.existsSync()` and `readFileSync()` (e.g. `api/moderate/review.ts:85-86`) escapes as an unhandled rejection → Vercel answers a bare 500 with no JSON body. | Catch `ENOENT` in `readReviews()` and map it to the same `StoreUnreachableError` → 501. |

---

## 5. The six areas, answered

**1 — `site/shared/server/portal-session.ts` (the signed stateless session module).**
- **HMAC timing-safe?** Yes. `safeEqualHex()` (`:256-261`) checks the length, then XOR-accumulates over the whole digest — no early exit on the first differing byte. Same pattern in `site/shared/server/magic-link.ts:153-158`, `api/lib/notifications.ts:129-135` and the edge twin `:97-102`. The length check leaks only the length, and an HMAC-SHA256 hex digest is always 64 chars.
- **HMAC correct?** **Executed:** my own differential test against `node:crypto`'s `createHmac` over **67 inputs** (empty, 1/63/64/65-byte keys, 100 KB message, unicode/emoji, 60 random inputs) — **67/67 byte-identical**. I did not take the Backend's harness for it.
- **Payload decode safe?** Yes. The signature is verified **before** the payload is decoded (`:492-497`), the decode is inside a `try`, and the role/expiry/type checks follow. **Executed:** 11 hostile token shapes (empty, 2/4 parts, invalid base64, non-JSON payload, `role:"superuser"`, expired, non-string `e`) all returned `null`; **nothing threw**; a 200 KB token was refused in 1.5 ms. One gap: no upper bound on the expiry → **M-3**.
- **Expiry / role / secret?** Expiry and role are enforced; the secret fails closed in production (**executed**: production → `null`, unset `APP_ENV` → `null`) with no per-process random fallback in production. The gap is the *value* of the secret, not its presence → **H-1**, and the `APP_ENV` trap → **H-2**.
- **Revocation list bound?** Per instance, best-effort, bounded by "logouts in the last 24 h" — and it is pruned only by expiry, with a quadratic scan above 500 entries → **m-1**. `destroySession` still works (executed: a revoked token is refused on the same instance).

**2 — `api/portal/session.ts` / `site/functions/api/portal/session.ts` (thin re-exports).**
Both are one-line re-exports of the shared module (`export * from …`), so the public API cannot drift. The 8 handlers' expectations hold: `imk_session` / `imk_admin_session`, 24 h TTL, `HttpOnly`, `SameSite=Strict` — **executed**: `imk_session=tok; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=86400`. Two gaps: `Secure` depends on the configured URL scheme (**m-2**) and the clear-cookie string is asymmetric (**m-3**). Both files are, however, among the four dead Vercel functions (**m-6**).

**3 — `api/moderate/review.ts` and the CF twin.**
- **Signature check timing-safe?** Yes (`api/lib/notifications.ts:121-136`), and the CF twin uses the identical message format (`ref|decision|revision|ts`) with `crypto.subtle` — so a link minted on one target verifies on the other.
- **Is `ts` freshness-checked?** **Yes — the replay window is 7 days**, and the check is on a *signed* value: `api/moderate/review.ts:107-110` rejects `now - ts > 7 days` and `ts - now > 60 s` (a future-dated link). **Executed:** a link back-dated by 8 days → `400 {"code":"expired"}`. Within the window the link is replayable, but the decision is idempotent — **executed**: replaying the same signed GET → `200` with the state unchanged.
- **Revision guard / idempotency?** Correct. **Executed:** a link for revision 1 against a record at revision 2 → `409 stale-revision` (and it mails a fresh link for the current revision, as designed); an already-decided record → `200` idempotent.
- **D-4 parity:** **verified.** Both trees now throw `StoreUnreachableError` for a missing store and answer `501 {code:'unimplemented'}` (`api/moderate/review.ts:85` + `:187-199`; `site/functions/api/moderate/review.ts:84` + `:157-164`). **Executed** on the Vercel twin: `501`, not `404`. The admin inbox twins match (`api/admin/reviews.ts:160-170`, `site/functions/api/admin/reviews.ts:132-140`).
- **New in this wave:** the GET mutates state (**M-1**) and the write is neither locked nor atomic (**M-6**).

**4 — `api/lib/rate-limit.ts` and the edge twin.**
- **Lock released on every path?** **Yes.** The `finally` closes the descriptor and unlinks the lock file; a busy retry never deletes a lock it does not own. **Executed:** after a normal hit, no `.lock` file remained; while another holder's lock was in place, it was neither deleted nor stolen.
- **Once-only degradation log?** **Yes** — `degradationLogged` (`api/lib/rate-limit.ts:267`, `:305-318`) fires once per limiter instance. But the *content* is weak for this failure mode: the timeout error carries no `.code`, so the line says `code: null` (**M-2**).
- **Can a busy lock be held past the 5 s budget?** The *wait* is bounded at 5 s (executed: 5013 ms). But the **consequence** is unbounded — the timeout latches the durable backend off permanently (**M-2**). The edge twin has no file lock at all (KV), and it latches on any KV error (`site/functions/api/lib/rate-limit.ts:145-156`); its KV read-modify-write is also not atomic, so concurrent writers can lose hits there (documented as eventually consistent).

**5 — `api/admin/**`, `site/functions/api/admin/**`, `site/src/pages/admin.astro`.**
- **Allow-list parsing:** safe. **Executed:** exact match, case-insensitivity on both sides, whitespace trimmed, empty entries filtered, empty list ⇒ nobody, `a@x.com,b@y.com` ⇒ both, non-member ⇒ no. Unset `ADMIN_EMAILS` ⇒ **500 misconfigured**, not "everyone is the owner" (**executed**). One blemish: a comma-only list counts as configured (**m-7**).
- **Is the moderation signature verified server-side?** Yes — the admin API **mints** the link (`api/admin/reviews.ts:207-208`) and the existing moderation endpoint verifies it; `api/moderate/review.ts` was not touched, and there is no second moderation path. The secret's absence is refused with `500` before any link is minted (`api/admin/reviews.ts:144-154`).
- **Can a non-admin reach client PII?** Not through the admin API: it answers `401` for no cookie, a client session, a forged cookie and an address that is off the live list (**executed**, all four), and the payload carries `name` / `company` / `quote` — **no email address** (`api/admin/reviews.ts:195-210`). The moderation record itself holds no address (the address is looked up in the client store only for the owner's own mail, `api/moderate/review.ts:117-122`). `testimonials.ts` explicitly refuses a client session without a client identity (`api/portal/testimonials.ts:345-346`) and its client view excludes the email (`:253`).
  **The one leak is M-5:** a live admin cookie in a client browser widens the client's read scope to every client.
- **noindex/nofollow + X-Robots-Tag:** the page is correct — `noindex={true} nofollow={true}` (`site/src/pages/admin.astro:30-35`) → `<meta name="robots" content="noindex, nofollow">` (`site/src/layouts/BaseLayout.astro:47`), and the sitemap filter excludes `/admin` (`site/astro.config.mjs:14`). The matching `X-Robots-Tag` is present in `vercel.json` but the path pattern is doubtful → **m-5**.

**6 — Repo-wide smells.**
- **Two copies of `jsonl.ts`?** **No — the hypothesis is false, and this is good news.** There is exactly one strict parser, `site/shared/portal-store/jsonl.ts`, and `api/lib/jsonl.ts:13-15` is a thin Node-filesystem wrapper that re-exports it; the CF tree imports the shared module directly (`site/functions/api/moderate/review.ts:17`). There is no duplication and no drift risk here.
- **Four files with no default export** → dead Vercel functions: **confirmed by execution** (file-by-file export check) — `api/lib/{jsonl,notifications,rate-limit}.ts` and `api/portal/session.ts`. With `api/` at **20** `.ts` files, the Hobby cap of 12 is exceeded → **m-6**.
- **Secrets committed or left in the tree?** No tracked secret: `git ls-files` shows no `.env`, no `jar.txt`, no `headers.txt`, no key/pem. `.gitignore` covers `.env*`, `site/data/portal/`, `site/data/snapshot/`, `site/.wrangler/`, `site/headers.txt`, `site/jar.txt`. A real `site/.env` exists **on disk** (untracked, gitignored) and carries a generated `FORM_WEBHOOK_SECRET` — acceptable, but it is a live secret on a shared machine. `site/jar.txt` no longer exists on disk (the ignore rule is harmless). **The real secret risk is H-1/H-2**: the *example* file ships three identical placeholders and `APP_ENV=development`.
- **Cookie `Secure` in production:** conditional on the configured scheme → **m-2**.
- **Magic-link token entropy / expiry / replay:** entropy is good (`crypto.getRandomValues`, 16 random bytes for the nonce, `site/shared/server/magic-link.ts:197`); the expiry is 15 min with a clock-skew clamp (`:234-236`); the single-use register is per instance and documented as such (`:248-281`). Replay across instances remains possible — documented, and T4 is the fix.
- **`ADMIN_EMAILS` case sensitivity:** case-insensitive on both sides in both trees (**executed**).

---

## 6. What I could NOT verify (no runtime was booted)

- **The Vercel router was never booted** (no token, no deploy, no network call). Every "Vercel" statement above is about a code path executed in isolation with Node/esbuild — *not* about a deployed function. In particular the `.js`-extension cross-tree imports (`api/portal/session.ts` → `../../site/shared/server/portal-session.js`) rely on the TypeScript-style `.js` → `.ts` resolution of the builder; that is standard esbuild behaviour but it was **not** observed on Vercel.
- **workerd was never booted.** The edge twins were read, not run. "Edge-safe" means "no `node:` imports and no `node:fs` at module scope" — verified by reading, not by loading the bundle in a Worker.
- **No deployed function, no live Resend, no live Turnstile, no browser session, no preview deploy** — so `X-Robots-Tag` (m-5), the 12-function Hobby cap, and the `installCommand`/Root-Directory behaviour are all unconfirmed against a real deployment.
- **The Vercel `path-to-regexp` version is unknown**, so m-5 is reasoning, not a measurement.
- **Cross-process lost update on the moderation store** (M-6) was **not** reproduced (0/12 runs); the truncation blast radius **was**.
- **The Cloudflare twin of the moderation endpoint was not executed** — only the Vercel one was (probe B). Their parity was established by reading both files side by side.
- I did **not** boot the dev server (port 4321 untouched), did not run the QA suites (they write into `site/qa/artifacts/`, which would dirty a shared tree I was told not to dirty), and did not run `git add/commit/checkout/stash/clean`.

---

## 7. Recommended order of work

| # | Finding | Owner | Effort |
|---|---|---|---|
| 1 | **H-1 / H-2** — reject placeholder secrets in production; drop `APP_ENV=development` from the example | Backend + DevOps | ~1 h |
| 2 | **M-4 / M-5** — one shared owner check (role **and** live allow-list) used by every owner-only route; client-facing routes prefer the client cookie | Backend | ~2 h |
| 3 | **M-1** — the moderation decision becomes a POST (or a confirmation page) | Backend + Frontend | ~2 h |
| 4 | **M-2** — do not latch the durable backend off on a transient lock timeout; name the error code | Backend | ~1 h |
| 5 | **M-3 / m-1 / m-2** — clamp the session expiry; bound the revocation map; require `https` for the base URL | Backend | ~1 h |
| 6 | **M-6** — temp-file + rename for the moderation store, and the same lock the rate limiter uses | Backend | ~1 h |
| 7 | **m-6** — move the 4 dead modules out of `api/` (also brings the function count down for the Hobby cap) | Backend (Architect's ≤12 layout) | ~3 h |
| 8 | **m-5** — add the exact `/admin`, `/portal`, `/login` header sources, then verify on the first preview deploy | DevOps | 15 min |

Everything above is owner-free except the plan-dependent parts of m-6.

---

*Audit produced by the Code Reviewer — Independent Audit. Application code was not modified; the only file written by this audit is this report.*
