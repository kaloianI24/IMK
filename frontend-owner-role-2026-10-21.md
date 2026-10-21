# Wave 8C — the server is the source of truth for the owner role

**Owner:** Frontend Developer · **First pass:** 2026-10-21 · **Re-verified against the live endpoint:** 2026-10-22
**Repo:** `C:\Users\Kalch\Documents\IXI` (branch `main`, no git remote, shared dirty tree)

**Status: DONE, now proven against the real handler.** `GET /api/portal/session` has landed
(`api/portal/session.ts` + the Cloudflare twin `site/functions/api/portal/session.ts`), so the
server-truth path was re-run in the browser against the **Backend's actual code** — no fixture.
One new frontend change came out of that round: a **misconfigured deployment (500) is no longer
relabelled as "your session has expired"** (§3.2, §5).

---

## 1. The defect, and what replaced it

`site/src/pages/portal.astro` (before this wave):

```ts
let role: Role = (sessionStorage.getItem('imk_portal_role') as Role | null) ?? 'client';
```

The role that decides whether the owner sees the owner UI lived in **`sessionStorage`** — per
tab, never written by the server. A new tab therefore showed the client view while the cookie
said `admin`, and the API (correctly) answered 403 to the owner's clicks. The screen lied; the
API was right.

Now the role comes from **one server endpoint** and from nowhere else:

| | Before | Now |
|---|---|---|
| Source of the role | `sessionStorage` (per tab) | `GET /api/portal/session` (server truth) |
| New tab, owner cookie | client view (the defect) | owner view |
| Stale `imk_portal_role` in storage | trusted for the whole session | overwritten by the server on every load |
| Endpoint missing (404/405/501) | n/a | role **UNKNOWN** → client view, no owner controls, no crash |
| Deployment broken (500) | *"your session has expired"* | *"this portal is not configured correctly on this server"* |
| Server says `client`, admin cookie present | owner view (wrong) | client view |

`sessionStorage` survives as a **write-through cache hint**: it is written from the server's
answer and is never read back as an authority.

### 1.1 The static proof that the hint is never an authority

```
$ grep -n "sessionStorage.getItem" site/src/pages/portal.astro \
      site/src/pages/admin.astro site/src/components/PortalTestimonialPrompt.astro
(no output)
```

**Zero** reads. The only `sessionStorage` calls in my three files are
`portal.astro:304` (`setItem` — the write-through) and `portal.astro:875-876` (`removeItem` on
sign-out). The role therefore *cannot* come from storage: the code that would read it does not
exist. This is stronger than any runtime observation.

---

## 2. Files changed (3, all inside my ownership)

| File | Change |
|---|---|
| `site/src/pages/portal.astro` | Role state machine (`admin` / `client` / `unknown` / `signed-out` / `misconfigured`), `fetchRoleState()`, `applyRole()`, owner-UI reveal moved into `applyRole()`, role resolved **before** the project data is rendered, 403 re-sync, role announcement, owner-aware empty state, and the new `misconfigured` branch |
| `site/src/components/PortalTestimonialPrompt.astro` | The card's role now comes from the page's `imk:portal-role` event (server truth) instead of `sessionStorage`; it waits for the role before deciding, so the owner is never asked to answer their own ask |
| `site/src/pages/admin.astro` | No role change needed (it already used `GET /api/admin/session`); added the role announcement and a distinct message for the `ADMIN_EMAILS`-not-configured answer (500) |

**Not touched:** `api/**`, `site/functions/**`, `site/shared/**`, `site/qa/**`, `spec/**`,
`DEPLOY.md`, `site/.env.example`, `site/data/**`.

### 2.1 `portal.astro` in detail (line numbers are of the final file)

* **`fetchRoleState()`** (`portal.astro:249`) — `GET /api/portal/session` with
  `credentials: 'include'`, an 8 s `AbortController` timeout (a hanging endpoint can never hold
  the portal hostage).
  * `401` → `signed-out`
  * `500` + body `code === 'internal'` → **`misconfigured`** (`:259-271`)
  * `200` + `role:'admin'` → `admin`; `200` + `role:'client'` → `client`
  * **anything else** (`404`, `405`, `501`, a network error, a timeout, a body without a usable
    role) → `unknown`. Unknown is **not** admin.
* **`applyRole(state)`** (`:298`) — the only place owner UI is revealed. It writes the hint
  (`:304`, the server's answer, never a guess) and shows/hides the owner controls
  (`#portal-admin-controls`, `#admin-status-card`, `#invite-form-container`).
* **`announceRole(state)`** (`:224`) — a visually hidden `role="status" aria-live="polite"`
  region (`#portal-role-status`). It costs no space and moves nothing on the page.
* **`init()`** (`:417`) — the role is resolved **first** (no flash of owner UI), then the
  projects are loaded.
* **`ownerRefused(res)`** (`:332`) — a `403` from an owner-only action re-reads the role from the
  server and hides the owner tools, so the screen never keeps offering buttons the server
  refuses.

### 2.2 The contract my client expects — matched against the landed handler

`api/portal/session.ts` and `site/functions/api/portal/session.ts` now answer:

```
GET /api/portal/session
  200 { ok:true, authenticated:true, role:'admin'|'client', email, clientId?, expiresAt }
  401 { error:'authentication required', code:'unauthorized' }   no session
  405 { error:'method not allowed', code:'method' }              wrong method (Allow: GET)
  500 { error:'misconfigured', code:'internal' }                 ADMIN_EMAILS unset, or
                                                                 PORTAL_SESSION_SECRET
                                                                 missing / placeholder / <32 chars
```

The client reads **only** `body.role`. `ok` / `authenticated` / `email` / `clientId` /
`expiresAt` are ignored if present, so the client is compatible with the Architect's contract
(§4.2) and with the Manager's summary (`{authenticated, role, expiresAt}`). A `200` with any
other body → `unknown` → client view.

The role is computed by the server from **two** facts — the claim in the signed token **and** the
live `ADMIN_EMAILS` allow-list (`effectiveRole()` in `site/shared/server/portal-session.ts`), and
the **client cookie is resolved first** for the portal scope. My UI never decides any of this; it
only renders what the server answered.

---

## 3. Gates — all executed on the final tree (2026-10-22, after the last edit)

| Gate | Command | Result |
|---|---|---|
| Build | `npm run build` (in `site/`) | **exit 0 — 23 page(s) built** (page count unchanged) |
| Route manifest | `npm run check:routes` (repo root) | **16 route(s), 0 missing function file(s)** — exit 0 |
| Type check | `npm run check` (astro check, in `site/`) | **0 errors, 0 warnings, 11 hints** — exit 0 |
| `site/data` untouched | SHA-256 of every file before and after | `data/moderation/reviews.jsonl` — 0 bytes, `e3b0c442…` **unchanged**; no `site/data/portal/` created |
| Git | `git status --porcelain` | only my 3 source files modified; **no git command that writes** was run |

**On the 11 hints:** the tree baseline was 9 before the Backend's wave-7 libSQL adapter landed
(`site/scripts/import-portal-store.mjs` and `site/shared/portal-store/test/contract.test.ts`
each added one). **My files add 0 hints**; the count is the tree's, not mine.

---

## 4. Browser proof — OpenMausBot Browser tab (Computer panel), against the live dev server

**No fixture this time.** The proof ran against the Backend's real handler through the running
dev server on `localhost:4321` (the dev server bundles the API handlers at startup; it had been
restarted onto the current code).

Signed in with the **real magic-link flow**: `POST /api/portal/auth/request-link` → the link the
dev server logged → the browser opened `/login/verify?token=…` → the `imk_admin_session` cookie
(`HttpOnly`, `SameSite=Strict`, `Max-Age=86400`) was set → `/portal` loaded.

| # | Scenario | Observed |
|---|---|---|
| A | No cookie | `GET /api/portal/session` → **401** `{"code":"unauthorized"}` → the sign-in state (*"Your session has expired or you're not signed in. Sign in to continue."*); announcement *"Signed out."*; 0 owner buttons |
| B | Client session (a token minted with the real `createSession()` + the real dev secret — signing in as a client through the UI would have written a client record into `site/data`, which I was told not to do) | **200** `{"role":"client","email":"client@example.test"}` → **client view** (*"No project is linked to this email address."*), announcement *"Client view."*, `#portal-admin-controls` `display:none`, invite form hidden, **0 owner buttons visible** |
| C | Owner session (real magic-link sign-in) | **200** `{"role":"admin","email":"admin@gmail.com"}` → owner controls **visible**: *Invite client*, *Post update*; status card + invite form shown; announcement *"Owner view. The owner tools are available."*; status *"No client projects yet."* |
| D | **NEW TAB** (fresh `sessionStorage`, owner cookie present) | **200** `{"role":"admin"}` → owner controls **visible**. This is the original defect: the old code read the empty `sessionStorage` here and showed the client view |
| E | **`sessionStorage` cleared (0 keys) → page reloaded** — the exact new-tab condition, measured | **200** `{"role":"admin"}` → owner controls **visible** (`display:flex`), invite form visible, status card visible. The role came from the server |
| F | Stale hint says `client`, the server says `admin` | owner controls **visible**; the hint was rewritten to `admin`. The hint is not the authority |
| G | Stale hint says `admin`, the server says `client` (owner cookie + client cookie present) | **client view, 0 owner buttons visible**; the hint was rewritten to `client`. The server wins, and the client cookie is resolved first (M-5) |
| H | `/admin` with the owner cookie | `GET /api/admin/session` → **200** `{"ok":true,"role":"admin","email":"admin@gmail.com"}`; the owner inbox opens (*"Owner inbox opened. 0 quotes are waiting for a decision."*), no error box |
| I | **Misconfigured deployment** (500 `{"error":"misconfigured","code":"internal"}` — the exact body the real handler returns) | the **error box** with *"This portal is not configured correctly on this server, so it cannot be loaded. Nothing was changed. Please contact IMK at 2imk4support@gmail.com."*; the **sign-in card stays hidden**; owner controls hidden; announcement *"The portal could not be loaded because this server is misconfigured."*; the *Try again* button is there, so a fixed deployment recovers on its own |

Screenshot of state I: `frontend-owner-role-misconfigured-2026-10-22.png` (this folder).

### 4.1 No flash of owner UI — from the shipped HTML, not from the screen

`site/dist/portal/index.html` (the built page, before any JavaScript runs):

```html
<div id="portal-admin-controls" style="display:none; gap:var(--space-3);">
<div id="admin-status-card" class="card" style="margin-bottom:var(--space-6);" hidden>
<div id="invite-form-container" hidden; margin-top:var(--space-8);max-width:40ch;">
<p id="portal-role-status" class="sr-only" role="status" aria-live="polite"></p>
```

The owner controls are not rendered before JS runs, and `applyRole()` is the only thing that
reveals them — so the owner UI cannot flash, and the reveal happens together with the shell
reveal (one layout change at load, not a jump).

---

## 5. The one new change this round: a broken deployment is not "signed out"

**Why it is needed.** The Backend's wave-8A work made the session endpoint answer
**500 `{code:'internal'}`** when the deployment cannot verify a session (H-1/H-2), instead of the
old silent `401`. Before that change the portal page could not tell the two apart: a `500` fell
into the same bucket as a missing endpoint, the page carried on, the next call (`/projects`)
answered `401`, and the owner was told **"Your session has expired or you're not signed in."** —
the exact silent symptom H-2 closed on the server, re-opened by the screen.

**What I changed** (`portal.astro`, all inside my ownership):

* `portal.astro:145` — the state machine gained `misconfigured`.
* `portal.astro:259-271` — a `500` whose body is `code:'internal'` is `misconfigured`; every
  other non-`ok` answer stays `unknown`.
* `portal.astro:229` — the announcement for that state.
* `portal.astro:429-437` — `init()` shows the error box with the reason and **returns**: no
  projects call, no sign-in card, no owner controls.

### 5.1 Mutation probe — the fix is what makes the difference

The **same built bundle** was served twice: once as built, once with the `500` branch removed by a
string mutation of the shipped JavaScript (no source file was touched, no rebuild).

| Served bundle | What the page shows |
|---|---|
| **as built** (mock on `:4399`) | error box: *"This portal is not configured correctly on this server…"*; sign-in card **hidden**; announcement *"…this server is misconfigured."* |
| **mutated** — the `500` branch deleted from the bundle (mock on `:4398`) | sign-in card **visible**: *"Your session has expired or you're not signed in."*; error box hidden; announcement *"Signed out."* |

The probe reddens: without the branch the page relabels a broken deployment as an expired
session, which is the failure mode the Backend just fixed server-side.

**How the mock worked.** A throwaway node server (in the OS temp folder, **not** in the repo)
served the built `site/dist` and answered `GET /api/portal/session` with the exact body the real
handler returns for a misconfiguration (`500 {"error":"misconfigured","code":"internal"}`) and
`GET /api/portal/projects` with `401` — which is what a broken deployment makes the read
endpoints answer. Both mocks ran on free ports (`:4398`, `:4399`), **never** on 4321, and were
killed afterwards; the temp files that were copied into the gitignored `site/dist` were deleted
afterwards (verified gone).

**Honest scope:** the *server's* 500 was proven by the Backend's harness
(`backend-wave8-session-endpoint-harness.mjs`, 57/57). My probe covers the **UI reaction** to
that body, not the server's decision to send it.

---

## 6. Accessibility

| Requirement | How |
|---|---|
| The role change is announced | `#portal-role-status` — `class="sr-only" role="status" aria-live="polite"`, one sentence per state (*"Owner view. The owner tools are available."* / *"Client view."* / *"Signed out."* / *"…this server is misconfigured."*) |
| No layout jump | the live region is visually hidden (`.sr-only`), so it is heard and moves nothing |
| The failure is announced too | `#portal-error` is `role="alert"`; the misconfiguration message is inside it |
| The owner controls are not announced when hidden | they are `display:none` / `hidden` until the server confirms the role, so a screen reader does not read them either |
| No owner UI before the answer | the owner controls are in the markup hidden and revealed only by `applyRole()` |

---

## 7. What I could **NOT** verify — stated, not assumed

1. **No deployed runtime.** The Vercel router and workerd were never booted; there is no preview
   deploy. Everything above is a local dev server plus the OpenMausBot browser.
2. **A real client sign-in through the UI was not exercised.** Signing in as a client writes a
   client record into `site/data/portal/` (the real flow), and I was told not to write `site/data`
   records. The client session in scenario B was minted with the **real** `createSession()` and
   the **real** dev secret, so the server verified it exactly as it verifies a UI-made session —
   but it did not come from the invite flow.
3. **The owner's real address is still not configured.** `site/.env` has
   `ADMIN_EMAILS=admin@gmail.com` (a local dev placeholder); `2imk4support@gmail.com` is not on
   any allow-list yet — DevOps/owner work, not mine.
4. **The owner-only 403 re-sync** (`ownerRefused`) is code-reviewed, not executed: it needs a
   live session whose allow-list entry is removed under it.
5. **No live Resend/Turnstile.** The dev-mode magic link was printed to the dev server's log
   instead of being mailed.
6. **The misconfiguration proof used a local mock**, not a live broken deployment (§5.1) — the
   body is byte-identical to the real one, but no Vercel instance with a placeholder secret was
   actually deployed and called.

---

## 8. Requests that need someone else's file

**@Backend Developer — wave 8A: done, thank you.** The handler, the Cloudflare twin, the
`api-index.ts` export and the `dev-portal.js` route are all in the tree, and the live proof above
runs against your code. **The only thing my client needed from you was the `500` distinction**
(§5) — and that is now implemented on my side, so there is nothing outstanding from me.

Two notes for the record, both observed, neither a defect in your code:

* `GET /api/portal/session` with **both** cookies present answers `role:'client'` (the client
  cookie is resolved first — M-5), while `GET /api/admin/session` answers `role:'admin'` (the
  admin cookie). The two endpoints answer two different questions — the portal is client-scoped,
  the inbox is owner-scoped — and the screens follow them.
* The `500` reason is in the body as `code:'internal'` (the message differs per cause:
  `ADMIN_EMAILS` unset vs. the signing secret). My client keys on `code`, not on the message, so
  it stays correct if you add more causes.

**@Architect — no action needed.** The UI implements §4.1–§4.5 as written. One consequence worth
restating: under §4.3 (the read path resolves the **client** cookie first), an owner who is also
a client sees only their own project in `/portal`; the owner's project-management actions stay
in that view and the inbox stays in `/admin`. The UI reflects that split.

**@DevOps — no action needed** by this wave (no deploy config touched).

**@QA — one thing to know** (not mine to change): the moderation link now needs a **POST**
(wave-8A M-1), and `qa-wave5-independent` (B1, B4, D1, D2) and `qa-admin-independent` (E10) still
`GET` it; they will get the confirmation page instead of a decision. That is the Backend's
report, not my measurement — I did not run those suites.

---

## 9. Spec clauses satisfied

| Clause | How |
|---|---|
| Architect §4.1 (the defect) | `sessionStorage` is no longer read as an authority — there is no `getItem` left in my files (§1.1) |
| Architect §4.2 (one server-truth endpoint) | the role comes from `GET /api/portal/session` only |
| Architect §4.3 (read-scope) | not a UI concern; the UI shows what the server returns and never widens it |
| Architect §4.4 (what the UI does) | 1–4 implemented: server answer first; `sessionStorage` is a hint that is overwritten; `401` → sign-in, `403` → owner UI hidden and role re-read; owner controls only when the server said `admin` |
| Architect §4.5 (what it does not do) | no cookie/TTL/flag change, no client→client access change, no role field added to any existing response |
| spec/08 T8c (role-switched view) | client view and owner view are both driven by the server's role; the owner view shows status controls, update composer and invite form |
| spec/08 T8j (testimonial card) | the card decides on the server's role, not on storage |

---

## 10. Evidence index (commands run)

```
npm run build            (site/)            -> 23 page(s) built, exit 0
npm run check            (site/)            -> 0 errors, 0 warnings, 11 hints, exit 0
npm run check:routes     (repo root)        -> 16 route(s), 0 missing, exit 0
Get-FileHash site/data/**                   -> reviews.jsonl 0 bytes, e3b0c442… (before = after)
git status --porcelain                      -> 3 modified source files, nothing else of mine
grep -n "sessionStorage.getItem" (3 files)  -> no output
Invoke-WebRequest /api/portal/session       -> 401 no cookie · 405 POST (Allow: GET)
```

Browser (OpenMausBot Browser tab, Computer panel): scenarios A–I in §4, each recorded as the
live `fetch` answer plus the DOM state of `#portal-admin-controls`, `#invite-form-container`,
`#admin-status-card`, `#portal-not-auth`, `#portal-error` and `#portal-role-status`.
