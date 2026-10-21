# IXI — Reviews Acceptance + Client Portal Design (T7)

**Owner:** Architect — Technical Design  
**Task:** T7 (technical design consumed by Frontend T8, Backend T9, DevOps T10, QA T11)  
**Baseline:** [`spec/06-reviews-portal-requirements.md`](06-reviews-portal-requirements.md) (T6, draft); [`spec/interface-spec.md`](interface-spec.md) v1 (T2); Phase 1 committed as `8303af9`.  
**Status:** Draft for M3 review. Documents only — no site build code, no file changes outside this deliverable.

This design turns the T6 requirements into an implementable target structure, data model, auth design, moderation mechanism, annotation mechanism, security posture, and phased plan. Anything not listed here is out of scope for v1 or must be raised as a numbered edit against this file, not improvised in code.

---

## 0. Plain-language rules that govern this design

1. **No new third-party form hosts.** All submission and webhook traffic goes through `/api/contact` (spec invariant I-7 / requirement R-1). The portal's own endpoints live under `/api/portal/*` and are owner-built, not a third-party form host.
2. **Static output preserved.** `output: 'static'` in `site/astro.config.mjs` holds. No SSR pages, no `@astrojs/cloudflare` adapter, no `prerender = false` inside `src/pages/`. Dynamic endpoints live only under `api/` (Vercel) and `site/functions/` (Cloudflare target, kept for later).
3. **No secrets in the client bundle.** Only `TURNSTILE_SITE_KEY` + analytics ID are public. Session signing secrets, Resend keys, Turnstile secrets are server-side only (invariant I-5 / requirement R-3).
4. **No database today.** MVP persists to append-only JSONL files + in-memory sessions. A real database is a Phase 3.2 decision, not v1 (spec §14: v1 has no DB/storage).
5. **Clients see only their own project.** Every portal request checks ownership; cross-client access returns 403 (requirement R-4).
6. **`/portal` is hidden from search.** `noindex, nofollow`, excluded from sitemap (requirement R-5).
7. **No fabricated social proof.** Testimonials render only from approved, consented content (requirement R-6).

---

## 1. Invariants (build-time / runtime; enforced by CI or review)

| ID | Invariant | Where enforced |
|----|-----------|----------------|
| D-1 | `output: 'static'` in `site/astro.config.mjs`; no `@astrojs/cloudflare` in `site/package.json`. CI grep fails the PR otherwise. | CI (`.github/workflows/ci.yml`) |
| D-2 | No `export const prerender = false` anywhere under `site/src/pages/`. Only `api/` and `site/functions/` endpoints are dynamic. | CI grep |
| D-3 | Client bundle contains only `TURNSTILE_SITE_KEY` + `ANALYTICS_SITE_ID`. Session/resend/turnstile-secret never appear in `dist/`. | CI secrets scan over `dist/` |
| D-4 | `/portal` and `/admin` routes carry `noindex, nofollow` and are excluded from `sitemap.xml`. | CI + build check |
| D-5 | All moderation + portal writes go through server-side endpoints (`/api/moderate/review`, `/api/portal/*`), never client-side email or third-party form host. | Code review |
| D-6 | Cloudflare target files (`site/functions/api/contact.ts`, `site/public/_headers`) remain intact and working; Vercel is interim only. | Code review |

**Note on target duality:** The repo targets Vercel now (`api/`, `vercel.json`) and Cloudflare Pages later (`site/functions/`, `site/public/_headers`). Both contact implementations exist and are kept in sync by design. New portal/moderation endpoints should be added to *both* targets where feasible, or at minimum to the Vercel target with a clear note that the Cloudflare port is a follow-up (see §10).

---

## 2. Data model

### 2.1 Review lifecycle (Feature 1)

States and transitions (from T6 §3.2, unchanged):

```
submitted (ingested by /api/contact, type=review)
    │
    ├─► pending   (default on ingestion; awaiting moderation)
    │       ├─► approved   (admin clicks one-click approve link) → published on next static rebuild
    │       └─► rejected   (admin clicks one-click reject link)  → discarded, not published
    │
    └─► honeypot / time-trap / rate-limit → silent discard, no review record created
```

Review record (appended to `site/data/moderation/reviews.jsonl`, one JSON line per review):

| Field | Type | Notes |
|-------|------|-------|
| `ref` | string | `inq_<8 hex>` — same format as contact refs (spec §3.4) |
| `type` | string | literal `"review"` |
| `state` | enum | `pending` \| `approved` \| `rejected` |
| `name` | string | 1..80 |
| `email` | string? | optional, validated shape |
| `company` | string? | optional, 0..120 |
| `linkedin` | string? | optional, 0..200 |
| `rating` | string | `"1"`..`"5"` |
| `review` | string | 1..2000 chars |
| `receivedAt` | ISO 8601 | server clock at ingestion |
| `decidedAt` | ISO 8601? | set on approve/reject |
| `decidedBy` | string? | admin ref / "one-click-link" |
| `decisionIpHash` | string? | peppered hash of admin IP (not raw IP) |

### 2.2 Portal entities (Feature 2)

| Entity | Key fields | Notes |
|--------|-----------|-------|
| **Client** | `id` (UUID), `email` (unique, login id), `name`, `createdAt` | One client = one login identity |
| **Project** | `id` (UUID), `clientId` (FK), `title`, `status` (`discovery\|in-progress\|review\|completed\|on-hold\|archived`), `startedAt`, `targetEndAt?`, `createdAt` | Belongs to exactly one client |
| **ProgressEntry** | `id` (UUID), `projectId` (FK), `date` (ISO date), `title` (1..120), `description` (1..1000), `status` (`done\|in-progress\|blocked\|planned`), `createdBy` (`admin`), `createdAt` | Admin logs progress; client reads |
| **Annotation** | `id` (UUID), `projectId` (FK), `clientId` (denormalised), `pageUrl`, `elementSelector` (or `data-annotation-id`), `elementText?` (truncated), `comment` (1..2000), `state` (`open\|resolved\|dismissed`), `createdAt`, `resolvedAt?`, `resolvedBy?` | Client's note pinned to a page element |
| **Notification** | `id` (UUID), `type` (`review-submitted\|annotation-created\|annotation-resolved`), `recipient`, `ref`, `sentAt`, `channel` (`email` MVP), `status` (`sent\|failed`) | Email via Resend; server-side only |

All JSONL stores live under `site/data/`:
- `site/data/moderation/reviews.jsonl` — review moderation log
- `site/data/portal/clients.jsonl`, `projects.jsonl`, `progress.jsonl`, `annotations.jsonl`, `notifications.jsonl` — portal store (MVP)

Sessions: in-memory `Map` keyed by session token (MVP), expiry on redeploy (documented limitation). Alternative: encrypted HTTP-only cookie carrying a signed payload, no server storage at all (see §3).

---

## 3. Auth approach — shortlist and recommendation

### Option A — Email magic link + server-side session (RECOMMENDED)
- Client (or admin) enters email → server generates a single-use, time-bound token → Resend emails a magic link → click sets a secure, HttpOnly, SameSite=strict session cookie → portal validates the cookie on each request.
- Sessions: in-memory map for MVP (expire on redeploy), or encrypted self-contained cookie (no server storage, portable across redeploys).
- Pros: no passwords to manage, no password-reset flow, Resend already wired (T6 A-2), works on Vercel now and Cloudflare Pages later (cookie-based auth is target-agnostic), free-tier friendly, no vendor lock-in.
- Cons: email deliverability is the auth dependency (mitigated by Resend + verified domain); sessions expire on redeploy with in-memory store (acceptable MVP limitation, documented).

### Option B — Password-based auth (self-rolled)
- Client registers with email + password; server hashes (bcrypt/argon2) and stores in JSONL/DB; cookie session on login.
- Pros: familiar UX, no email dependency per login.
- Cons: password-reset flow, credential storage risk, more code to audit, self-rolled auth is a security surface the Code Reviewer will scrutinize heavily. Not recommended for MVP.

### Option C — Managed service (Clerk / Auth.js / Auth0 / Supabase Auth)
- Outsource auth to a third-party provider.
- Pros: off-the-shelf UI, MFA, social login.
- Cons: new vendor, cost at scale, client SDK in the bundle (conflicts with D-3 / keep bundle lean), portability friction when moving Vercel → Cloudflare, over-engineered for "owner + a handful of clients".

### Recommendation
**Option A (email magic link + server-side session cookie)** for MVP. Reasons: Resend is already integrated (no new provider), zero password complexity, portable across Vercel and Cloudflare, free-tier friendly, minimal code surface to audit. Passwords and managed auth are deferred to Phase 3.2 if the client base grows.

### Roles and session handling
- `admin` = the site owner (you). Same magic-link flow as clients, but admin routes are gated by an `isAdmin` flag resolved from the session (admin email allow-listed via env `ADMIN_EMAILS` or a small admin registry JSONL). Admin session cookie is separate in name from client cookies.
- `client` = authenticated customer; sees only own projects (server resolves `clientId` from session, never trusts client-supplied IDs).
- Session cookie: `imk_session`, `HttpOnly`, `SameSite=Strict`, `Secure` (on HTTPS), `path=/`, short TTL (e.g. 24h), refreshed on activity. Cookie value is a signed token; validation is server-side only.
- Portal routes (`/portal/*`) are server-rendered (or static shell + API) and never embed admin capabilities in the client bundle. The annotation overlay script (see §6) loads conditionally only when a valid client session cookie is present.

---

## 4. Data store comparison and recommendation

| Option | Fit for MVP | Free tier | Vercel → Cloudflare path | Verdict |
|--------|------------|-----------|--------------------------|---------|
| JSONL + in-memory (files under `site/data/`) | ✅ No new infra, matches T6 §3.4/§5.2 | N/A (files) | Trivial — files move with repo; later import into SQL | **Recommended for MVP** |
| SQLite / Turso | ✅ Simple, file-based or remote | ✅ Turso free tier | SQLite file portable; Turso works on both targets | Phase 3.2 candidate |
| PostgreSQL / Neon | ✅ Robust | ✅ Neon free tier | Connection-string based; works on both but adds operational load | Phase 3.2 candidate |
| Vercel KV / Upstash (Redis) | ⚠️ Good for rate limits/counters, weaker for relational portal data | ✅ Vercel KV free tier | Locked to Vercel; must re-platform on Cloudflare switch | Avoid for portal data; OK later for rate-limit counters only |
| Cloudflare D1 / KV | ❌ Not available on Vercel interim | ✅ CF free tier | Native on Cloudflare target, useless on Vercel now | Defer until Cloudflare switch |

### Recommendation
MVP: **JSONL append-only files under `site/data/` + in-memory sessions** (zero new infrastructure, consistent with T6 §3.4 and §5.2). Phase 3.2: graduate to **SQLite (Turso) or PostgreSQL (Neon)** — relational fit for client/project/progress/annotation, portable across Vercel and Cloudflare, free-tier friendly. When switching to Cloudflare Pages, re-evaluate D1/KV only if it simplifies ops; SQL remains the portable default.

**Migration path:** JSONL → SQL is a one-time import script (each JSONL line becomes a row). Schema is stable by design (entities defined in §2.2), so migration is low-risk.

---

## 5. Review moderation mechanism — options and recommendation

### (a) Signed approve/reject links in the notification email (RECOMMENDED for MVP)
- `/api/contact` ingests `type=review`, appends `pending` record to `site/data/moderation/reviews.jsonl`, sends Resend email to admin with two HMAC-signed links:
  - `/api/moderate/review?ref=&decision=approve&sig=<hmac>`
  - `/api/moderate/review?ref=&decision=reject&sig=<hmac>`
- Signature: `HMAC-SHA256(FORM_WEBHOOK_SECRET, ref + decision + timestamp)` (same pattern as interface-spec §3.8 webhook signature). `FORM_WEBHOOK_SECRET` is server-side only.
- `api/moderate/review.ts` (new Vercel function; Cloudflare port `site/functions/api/moderate/review.ts` later) verifies the HMAC, flips `state` in the JSONL, logs the decision, emails admin confirmation.
- Prebuild script `scripts/publish-testimonials.mjs` (new) runs before `astro build`, scans JSONL for `state === 'approved'`, writes `site/src/content/testimonials/{ref}.md` frontmatter-only markdown files. The existing `Testimonials.astro` (accepts `items` prop, renders empty state when empty) renders them on the next build.
- Pros: zero login for admin, works from phone, no dashboard code, no new UI, instant moderation. Cons: no admin "inbox" UI beyond email; a simple server-rendered list view (`/admin/moderation`, admin-gated) can be added in Phase 3.2 reading the same JSONL.

### (b) Admin dashboard UI
- Server-rendered list of pending reviews with approve/reject buttons. Better for volume, more code. Deferred to Phase 3.2.

### (c) Manual content commit
- Admin edits markdown files in `site/src/content/testimonials/` and pushes. Fragile, error-prone, no audit trail. Explicitly not recommended.

### Recommendation
**(a) signed one-click links** for MVP, plus a minimal server-rendered admin list view reading `reviews.jsonl` (Phase 3.1.5). This matches T6 §3.1 story R1-4 ("approve or reject without logging in") and keeps MVP surface minimal.

---

## 6. Annotation mechanism on a static Astro site

The marketing site is static, so annotations cannot be stored client-side only. The mechanism:

1. **Stable element identity.** Elements that can be annotated carry a `data-annotation-id` attribute (e.g. `<section data-annotation-id="hero-value-prop">`). A fallback CSS selector is accepted but `data-annotation-id` is preferred because it survives copy edits and reordering. The admin can locate the element later via page URL + `elementSelector`.
2. **Conditional overlay script.** A small annotation script (`site/src/components/AnnotationOverlay.astro` + `site/src/scripts/annotation-client.mjs`) is included on pages *only* when the visitor has a valid client session cookie. It is **not** in the public bundle for unauthenticated visitors (preserves D-3 and page speed). Gate: a tiny inline script checks for the `imk_session` cookie; if present and valid (verified via `/api/portal/session`), it injects the overlay.
3. **Client flow:** authenticated client clicks an annotated element → inline UI opens → client types comment (1–2000 chars) → POST to `/api/portal/annotations` with `{ pageUrl, elementSelector, elementText?, comment }`. Server resolves `clientId`/`projectId` from the session (never client-supplied), inserts record with `state='open'` and server timestamp into `site/data/portal/annotations.jsonl`.
4. **Admin flow:** admin views all open annotations (server-rendered `/portal/annotations` or `/admin/annotations`), sees page URL, element selector, truncated element text, comment, state. Admin can reply and mark `resolved`/`dismissed`. Client sees resolution on next portal login (and optionally via email, §7).
5. **Captured context** (T6 §4.3): page URL (absolute), element identity (`data-annotation-id` or selector), comment text, client + project (from session), state `open`, server timestamp. Screenshot deferred (T6 Q3 / later phase).

**What is NOT in MVP:** visual overlay highlighting on the admin preview page, screenshot capture, real-time push. These are Phase 3.2.

---

## 7. Notification delivery

All notifications originate server-side only. Two channels are dispatched in parallel: **email via the existing Resend integration** (`api/contact.ts`) and **Telegram via the Bot API** (new server-side module `api/lib/notifications.ts`). Neither channel blocks the other, and neither blocks the underlying request (review submission, annotation creation). Email is the system of record; Telegram is fast attention.

### 7.1 Dual-channel dispatch

| Trigger | Recipient | Channel | Content | MVP |
|---------|-----------|---------|---------|-----|
| New review submitted | Admin (owner) | Email via Resend + Telegram | Name, email, company, rating, review text, ref, approve/reject one-click links (email); short alert + ref + direct approve/reject links (Telegram) | ✅ |
| Review approved/rejected | Admin | Email via Resend + Telegram | Confirmation of decision + ref | ✅ |
| Client creates annotation | Admin | Email via Resend + Telegram | Client name, project, page URL, element identity, note text, annotation ID, portal link | ✅ |
| Admin resolves annotation | Client | Email via Resend | "Your note on [project] resolved" + optional reply | ✅ (optional) |
| New progress entry | Client | — | Visible on next portal login; no auto-email | ✅ (no email) |

**Dispatch rule:** every notifiable event triggers both an email and a Telegram message. If Telegram is down or misconfigured, email still arrives — no request fails because of Telegram, and no notification failure changes the HTTP response to the user.

**Telegram message contents:**

*New review submitted:*
```
🔔 New IXI review (rating N/5)
Name: ...
Email: ...
Company: ...
Rating: N / 5
Review: ... (truncated)
Ref: ref_xxxx
Admin: approve/reject links (email) or open /admin
```

*New client annotation:*
```
📝 New client note
Client: ...
Project: ...
Page: <absolute URL>
Element: <data-annotation-id or selector>
Note: ... (truncated)
Annotation ID: ...
Portal: /portal/annotations#<id>
```

### 7.2 Telegram module (server-side only)

Path: `api/lib/notifications.ts` (Vercel) with Cloudflare port `site/functions/api/lib/notifications.ts` later. Exports `notifyReviewSubmitted(review)` and `notifyAnnotationCreated(annotation)`. Each function:

1. Sends email via Resend (existing pattern, `api/contact.ts` lines 391-404).
2. Attempts Telegram `sendMessage` to `https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/sendMessage` with `chat_id=<TELEGRAM_CHAT_ID>` and markdown text.
3. Wraps Telegram in try/catch; on failure logs `{ outcome: 'telegram_fail', ref }` and continues — never throws, never returns an error to the client.
4. Skips entirely if `TELEGRAM_BOT_TOKEN` or `TELEGRAM_CHAT_ID` is unset (log `telegram_skipped`, continue).

**Env vars (server-side only):** `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`. Neither is ever in the client bundle (D-3). Telegram is optional: the system works with email alone when the vars are absent.

### 7.3 Admin inbox screen (proper screen, alongside email)

Route: **`/admin`** — the owner's inbox, separate from `/portal` (client-facing).

**Justification for `/admin` over `/portal/admin`:** The admin inbox is the *owner's* tool — pending reviews to approve/reject, open client notes to resolve. `/portal` stays strictly client-facing (clients log in to see only their own project). Mixing admin routes under `/portal` risks leaking admin UI into client code paths. Both `/admin` and `/portal` are `noindex, nofollow` and excluded from sitemap (invariant D-4). Admin uses a separate session cookie name (`imk_admin_session` vs `imk_session`) gated by an admin email allow-list (`ADMIN_EMAILS` env).

**Page structure:**
- **Header counts:** "N pending reviews · M open notes · K resolved today"
- **Reviews tab:** pending reviews list (ref, rating, name, date) with "Approve" / "Reject" buttons. Each action calls `/api/moderate/review` (HMAC-signed, server-side).
- **Client notes tab:** open annotations list (client, project, page URL, element, note text, state) with "View on page", "Reply", "Mark resolved".
- **Quick actions:** mark all reviewed (later).

**Auth:** same magic-link flow as clients (§3). Admin routes require the `isAdmin` flag from the session (admin email allow-listed). No admin capability is embedded in the public client bundle — `/admin` is a separate server-rendered route.

### 7.4 Rate and error handling

- Telegram `sendMessage` is one attempt, 5s timeout, fire-and-forget from the request's perspective — no retries, so a Telegram outage never delays review submission or annotation creation.
- Email failures follow the existing `api/contact.ts` pattern (log `email_fail`, continue) — same for the Telegram module.
- Notification failures never change the user-facing response: review submission still returns `200 { ok: true, ref }`; annotation creation still returns `200`.

### 7.5 Deferred (not in MVP)

- Telegram inline approve/reject buttons (v2 — requires a Telegram webhook + callback handler; v1 uses email one-click links plus the `/admin` screen).
- Client portal itself stays Phase 3 per existing phasing (§10); this section defines the notification and admin-inbox shape so Backend T9 can stub the notification layer now.

QA trial sends go to a QA mailbox alias, never the owner's real address (mirrors interface-spec §3.7).

---

## 8. Security

| Area | Control |
|------|---------|
| Secrets | Resend API key, session signing secret, Turnstile secret, `FORM_WEBHOOK_SECRET`, `LOG_PEPPER` are server-side env vars only. Client bundle: `TURNSTILE_SITE_KEY` + analytics ID only (D-3). |
| Session | HttpOnly, SameSite=Strict, Secure cookie; server validates on every portal request; short TTL; admin email allow-listed. |
| Authorization | Every `/api/portal/*` request resolves client from session; `projectId` ownership checked server-side; cross-client access → 403. No IDOR: client-supplied `clientId`/`projectId` are ignored. |
| Rate limiting | Per-IP in-memory fallback (Vercel) / `KV_COUNTER` (Cloudflare) on portal write endpoints, same pattern as `api/contact.ts`. |
| Turnstile | Reused on review submission (existing). Optional on portal write endpoints if spam appears (Phase 3.2). |
| Signed links | HMAC-SHA256 with `FORM_WEBHOOK_SECRET` (server-only); single-use-ish via timestamp + state guard (a rejected/approved review can't be re-decided). |
| CSP | `form-action 'self'` already covers POSTs to `/api/*` same-origin. Portal routes get `noindex, nofollow`. Annotation script is same-origin, loaded conditionally. `api.resend.com` is server-only and removed from client `connect-src` (already done in Phase 1 `vercel.json`). |
| Logs | Redacted JSON lines only (interface-spec §3.10 pattern). No raw IP/email, no bodies. |
| No secrets in bundle | CI secrets scan over `dist/` (D-3). |

---

## 9. Performance

- Marketing pages remain **statically prerendered** (`output: 'static'`). No SSR, no adapter (D-1, D-2).
- Portal endpoints are serverless functions under `api/` (Vercel) / `site/functions/` (Cloudflare), called only by authenticated users.
- Annotation overlay script is loaded **conditionally** (only with a valid session) and is small; it does not bloat the public bundle or affect Lighthouse scores on public routes.
- JSONL reads are small files at launch scale; no database connection overhead on the static site.
- Lighthouse CI ≥ 90 mobile is unchanged (public routes untouched by portal code).

---

## 10. Phased implementation plan

### Phase 3.1 — MVP (build with the site launch)

| Task | Owner | File(s) | Verification |
|------|-------|---------|--------------|
| T7.1 Design sign-off (this doc) | Architect | `spec/07-reviews-portal-design.md` | M3 review passes |
| T7.2 Add `testimonials` content collection | Frontend | `site/src/content.config.ts` (new `testimonials` collection, `testimonialSchema`) | `npm run check` passes; collection validates |
| T7.3 Prebuild script: publish approved reviews | Backend | `scripts/publish-testimonials.mjs` (scans `site/data/moderation/reviews.jsonl` for `approved`, writes `site/src/content/testimonials/*.md`) | Build produces testimonial MD files; `Testimonials.astro` renders them |
| T7.4 Moderation endpoint `api/moderate/review.ts` | Backend | `api/moderate/review.ts` (Vercel) + HMAC verify + JSONL state flip + Resend confirmation | Returns 400 on bad sig, 200 on valid; JSONL state flips; Cloudflare port noted as follow-up |
| T7.5 JSONL moderation store | Backend | `site/data/moderation/reviews.jsonl` (created on first review) | Append-only; read by moderation view + prebuild |
| T7.6 Portal auth (magic link + session cookie) | Backend | `api/portal/auth.ts` (login link, verify, set cookie) + session validation middleware | Magic link email arrives; cookie set; unauthenticated → 401/redirect |
| T7.7 Client + project + progress API | Backend | `api/portal/clients.ts`, `api/portal/projects.ts`, `api/portal/progress.ts` (JSONL stores under `site/data/portal/`) | CRUD returns 200/403; cross-client → 403 |
| T7.8 Annotation API + capture | Backend | `api/portal/annotations.ts` (POST captures URL, selector, comment, session-resolved client/project) | 200 on valid; 400 on bad payload; 403 cross-client |
| T7.9 Annotation overlay script (conditional load) | Frontend | `site/src/components/AnnotationOverlay.astro` + client script; gated by session cookie | Script absent for anonymous; present + functional for authenticated client |
| T7.10 Admin annotation list + resolve | Frontend/Backend | `/portal/annotations` server view (admin-gated) | Lists open annotations; resolve flips state; client sees resolved |
| T7.11 Notification wiring (Resend + Telegram) | Backend | `api/lib/notifications.ts`: email via Resend (`api/contact.ts` pattern) + Telegram `sendMessage`; graceful degradation when `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` unset | Emails send when keys configured; Telegram skips silently if env vars absent; no request fails due to Telegram |
| T7.12 `vercel.json` + headers for portal/admin routes | DevOps | `vercel.json` (add `/portal/*` and `/admin/*` noindex headers if needed) | CSP unchanged; no HSTS; `form-action 'self'` intact |
| T7.13 CI gates for new endpoints | DevOps | `.github/workflows/ci.yml` (add secrets scan over `dist/`, check new `api/` files parse) | CI passes; no new hint lines |
| T7.14 Admin inbox screen routes + UI | Frontend/Backend | `/admin` server-rendered route: pending reviews (approve/reject), open annotations (resolve), counts header; admin allow-list via `ADMIN_EMAILS` | `/admin` returns 401 for non-admin; lists render; approve/reject flip JSONL state |

**MVP acceptance:** a review submitted via `/leave-a-review` → email to admin → one-click approve → next `npm run build` renders the testimonial. A client logs in via magic link → sees own project progress → leaves annotation on a page → admin gets email → admin resolves → client sees resolution.

### Phase 3.2 — Post-launch (optional, after launch)

- Graduate JSONL + in-memory sessions to SQLite (Turso) or PostgreSQL (Neon).
- Admin dashboard UI for moderation (currently email links + minimal list).
- Real-time notifications (Telegram/Slack webhook).
- Visual annotation overlay (admin sees note highlighted on page preview).
- Screenshot capture on annotation.
- Client email digests on progress changes.
- Re-evaluate Cloudflare D1/KV when switching to Cloudflare Pages target.

---

## 11. Conflicts with requirements and assumptions

### Conflicts / drifts flagged
1. **Content collection naming drift:** `spec/interface-spec.md` §2 names the case-studies collection `caseStudies`, but the actual `site/src/content.config.ts` (read, lines 32-48) uses `cases`. The Architect's audit flagged this. For the new `testimonials` collection, use the key `testimonials` and directory `src/content/testimonials/` to avoid compounding the drift. A separate spec edit should align `cases` → `caseStudies` (out of scope for T7).
2. **Dual target (Vercel now, Cloudflare later):** interface-spec §1-3 are written for Cloudflare Pages Workers runtime (`functions/`, `env` binding, `crypto.subtle`). The Vercel `api/contact.ts` uses Node runtime. New endpoints under `api/` should be written to work on both where possible, or clearly marked Vercel-only with a Cloudflare port task. This design assumes Vercel-first implementation with Cloudflare port noted (T7.4).
3. **Interface-spec §14 says v1 has no persistence beyond Resend email.** T6 and this design deliberately add JSONL persistence as the first storage layer — this is the deliberate architectural step T6 plain-language rule 2 calls out.

### Assumptions (marked)
| # | Assumption | Basis |
|---|-----------|-------|
| A-1 | `api/contact.ts` already handles `type=review` with Turnstile/honeypot/time-trap/rate-limit/Resend (Phase 1, verified). | `api/contact.ts` lines 41-52, 275-318 |
| A-2 | Resend available for notifications; `RESEND_API_KEY`, `RESEND_FROM`, `RESEND_TO`/`CONTACT_TO` configured in Vercel project settings. | `api/contact.ts` lines 366-404; `site/.env.example` |
| A-3 | No database exists today; MVP uses JSONL + in-memory sessions. | T6 §2 "What does NOT exist today"; spec §14 |
| A-4 | Static output preserved; portal/moderation endpoints are serverless under `api/`, not Astro SSR pages. | `site/astro.config.mjs` `output: 'static'`; invariant D-1/D-2 |
| A-5 | No `.env` exists; real keys (Turnstile, Resend, session secret) must be provided by the user before end-to-end testing. | Phase 1 Manager report |
| A-6 | HMAC-signed one-click links (interface-spec §3.8 pattern) are sufficient to authorize approve/reject without a login session. | `spec/interface-spec.md` §3.8; T6 A-6 |
| A-7 | The Cloudflare port of new portal/moderation endpoints is a follow-up task, not required for Vercel MVP. | Phase 1 decision to keep Cloudflare files intact |
| A-8 | Telegram notification module lives at `api/lib/notifications.ts` (Vercel) with Cloudflare port `site/functions/api/lib/notifications.ts` later. `api/lib/` does not exist yet — it is a new shared lib folder under `api/`. | Proposed path; not verified against the repo |
| A-9 | Admin inbox route is `/admin` (separate from `/portal` client-facing route). Admin session cookie name `imk_admin_session`, admin allow-list via `ADMIN_EMAILS` env var. | Architect decision; `ADMIN_EMAILS` not yet in `site/.env.example` |
| A-10 | Telegram `sendMessage` is one attempt, no retries; failure is logged and swallowed so a Telegram outage never blocks review submission or annotation creation. | Design decision; not yet implemented |

---

## 12. Open questions for the user (NEEDS INPUT)

| # | Question | Why it matters |
|---|----------|----------------|
| Q1 | How should notifications reach you when a client leaves a note — email only (Resend already wired), or Telegram/Slack push? | Drives whether a webhook channel is added now or deferred (T6 Q1). **ANSWERED: Telegram + email (dual-channel).** User confirmed Telegram as a second channel alongside email; email remains the system of record. |
| Q2 | Admin auth: magic-link email (same as clients) or a simple password-protected admin route? | Affects session design and your UX. |
| Q3 | Do you want annotations to support screenshots? (deferred to later either way) | Affects whether object storage is provisioned now. |
| Q4 | Database preference for post-launch: PostgreSQL (Neon), SQLite (Turso), or stay file-based longer? | Drives Phase 3.2 data model decision. |
| Q5 | Real domain: `ixi.agency` / `ixiagency.com` (recommended) or something else? | Drives `SITE_URL`, cookie domain, CSP. |

---

## 13. Sign-off

- [ ] Product Analyst: requirements (T6) are the basis; this design implements them.
- [ ] Architect: data model, auth, moderation, annotation, security, performance, phased plan complete.
- [ ] Frontend: testimonials collection + publish script + annotation overlay + admin views feasible within static-site constraints.
- [ ] Backend: `/api/moderate/review` + `/api/portal/*` endpoints implementable on Vercel serverless; JSONL stores defined.
- [ ] DevOps: no new infrastructure beyond Vercel env vars + optional DB in Phase 3.2; CI gates defined.
- [ ] QA: every state transition, authZ rule (403 cross-client), HMAC validation, and time-trap/honeypot behavior testable.
- [ ] Code Reviewer: threat model covers annotation context capture, session isolation, signed moderation links, no-secrets-in-bundle.

**Status:** Draft (T7). Next trigger: M3 passes → Frontend T8 / Backend T9 implementation begins.

**Files read for verification (no changes made):**
- `spec/06-reviews-portal-requirements.md` — requirements baseline (T6)
- `spec/interface-spec.md` — invariants I-1–I-7, form contract §3, CSP §8, logging §3.10, webhook signature §3.8
- `site/src/content.config.ts` — collections `services`, `cases`; schema pattern
- `site/src/types/contracts.ts` — `CTA_ROLES`, `BUDGET_ENUM`, `MAX` constants
- `site/astro.config.mjs` — `output: 'static'`, `trailingSlash: 'never'`, `SITE_URL`
- `api/contact.ts` — Vercel contact API with `type=review`, Resend, rate limit, redacted logging
- `site/functions/api/contact.ts` — Cloudflare target (kept intact)
- `site/src/components/ReviewForm.astro` — POSTs `type=review` to `/api/contact`
- `site/src/components/Testimonials.astro` — accepts `items` prop, empty state when empty
- `vercel.json` — CSP/headers; HSTS dropped; `api.resend.com` removed from client `connect-src`
- `site/public/_headers` — Cloudflare headers; `form-action 'self'`; HSTS commented out
- `site/.env.example` — env variable placeholders
- `.github/workflows/ci.yml` — CI relocated to root; deploy gated on `VERCEL_TOKEN`

**No files were changed.** This document is the only deliverable.