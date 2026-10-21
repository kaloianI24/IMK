# IXI — Reviews Acceptance + Client Portal Requirements (T6)

**Owner:** Product Analyst — Requirements Specialist  
**Task:** T6 (plan Phase 3) — requirements consumed by Architect (T7), Frontend (T8), Backend (T9), DevOps (T10), QA (T11).  
**Baseline:** [`spec/interface-spec.md`](interface-spec.md) v1 (T2, complete); [`plan/00-phase2-plan.md`](../plan/00-phase2-plan.md); Phase 1 deliverables committed as `8303af9`.  
**Status:** Draft for M3 review. Documents only — no site build code.

This spec exists so Architect, Frontend, Backend, DevOps, and QA can build review moderation and the client portal without guessing. Anything not listed here is out of scope for v1 or must be raised as a numbered edit against this file, not improvised in code.

---

## 0. Plain-language rules that govern this spec

1. **No new third-party form hosts.** All submission and webhook work goes through `/api/contact` (spec invariant I-7). No Formspree, no Typeform, no client-side email send.
2. **No database today.** The site is static Astro 5 with no persistence layer (spec §14: "no DB/storage; v1 has none"). Both features add persistence for the first time; this is a deliberate architectural step, not a tweak.
3. **No SSR.** `output: 'static'` holds; no `@astrojs/cloudflare` adapter; no `export const prerender = false` in `src/pages/` (invariants I-1, I-3). Dynamic endpoints live only under `api/` (Vercel serverless) and `site/functions/` (Cloudflare Pages Functions).
4. **No secrets in the bundle.** Client bundle contains only `TURNSTILE_SITE_KEY` + analytics ID (invariant I-5). Admin/session secrets are server-side only.
5. **No fabrication.** Testimonials are a labelled empty state until real, consented client quotes exist (Phase 1, Frontend deliverable). No invented client names or quotes anywhere.
6. **Documents are not code.** M3 stays documents-only; this file is not imported by anything yet. It becomes code in T7–T11.

---

## 1. Invariants (build-time / runtime; enforced by CI or review)

| ID | Invariant | Why it matters |
|---|---|---|
| R-1 | All form submission + webhook traffic goes through `/api/contact` only. No third-party form host. | Privacy-safety and abuse control live in one place (spec invariant I-7). |
| R-2 | Static output preserved: `output: 'static'`, no SSR pages, no Cloudflare adapter in dependency tree. | A single well-meant commit flips the whole site into SSR and breaks Pages + caching + CSP. |
| R-3 | Admin/session secrets never reach the client bundle. Only `TURNSTILE_SITE_KEY` + analytics ID are public. | CI secrets scan fails the PR otherwise (spec §11). |
| R-4 | Clients see only their own project data — no cross-client leakage. | Core trust boundary for the portal. |
| R-5 | `/portal` routes are `noindex, nofollow` and excluded from sitemap. | Portal is an authenticated staff/client area, not marketing content. |
| R-6 | No fabricated social proof anywhere. Testimonials render only from approved, consented content. | Protects brand integrity; legal exposure if a fake quote is attributed to a real person. |

---

## 2. Context: what exists today (verified facts)

| Item | Location | Notes |
|---|---|---|
| Review form component | `site/src/components/ReviewForm.astro` | POSTs JSON to `/api/contact` with hidden `type=review`. Turnstile widget client-side via `PUBLIC_TURNSTILE_SITE_KEY`; degrades gracefully when unset. Honeypot (`website`) + time-trap (`ts`) fields present. |
| Contact API (Vercel) | `api/contact.ts` (repo root) | Node serverless function. Turnstile verify (when secret configured), honeypot, time trap, per-IP in-memory rate limit, Resend send, redacted logging, JSON errors. Extended for `type=review` (rating 1–5 + review text). |
| Contact API (Cloudflare) | `site/functions/api/contact.ts` | Cloudflare Pages Function, unchanged from Phase 1. Keeps the Cloudflare target working. |
| Content layer | `site/src/content.config.ts` | Collections: `services`, `caseStudies`. No `testimonials`/`reviews` collection exists yet. |
| Testimonials placeholder | `site/src/components/Testimonials.astro` | Labelled empty state: "Sample content — no approved client quotes yet." |
| CSP headers | `site/public/_headers` | `form-action 'self'`; `connect-src 'self' https://analytics.plausible.io`; HSTS commented out (post-launch gate). |
| Env inventory | `site/.env.example` | Placeholders only: `SITE_URL`, `CALENDLY_URL`, `TURNSTILE_SECRET_KEY`, `PUBLIC_TURNSTILE_SITE_KEY`, `RESEND_API_KEY/FROM/TO`, `CONTACT_TO`, `KV_COUNTER`, `CF_PAGES_PROJECT`, `APP_ENV`, `DEV_STUB`. Real `.env` is gitignored and does not exist. |
| CI | `.github/workflows/ci.yml` (repo root) | Builds, typechecks, secrets scan, Lighthouse CI ≥90. Deploy job gated on `VERCEL_TOKEN` — deploys nothing today. |

**What does NOT exist today (confirmed by spec §14 + Phase 1 audit):**
- No database or persistence layer of any kind.
- No authentication, sessions, or roles.
- No admin dashboard or moderation UI.
- No notification path beyond the Resend email that `/api/contact` already sends on submission.
- No `testimonials` or `reviews` content collection.

---

## 3. Feature 1 — Review Acceptance

### 3.1 User stories

| ID | User story | Acceptance criteria |
|---|---|---|
| R1-1 | As a site visitor, I can submit a 1–5 star review with optional name/email/company/LinkedIn and a review text. | The `ReviewForm.astro` at `/leave-a-review` POSTs `type=review` to `/api/contact`. Server returns `200 { ok: true, ref }` for valid submissions; `400`/`403`/`429` for invalid/abusive ones. |
| R1-2 | As a site visitor, I receive confirmation that my review was submitted and will be moderated. | Success UI shows "Thanks, your review was submitted. We'll review it before publishing." No promise of publication timing. |
| R1-3 | As the site owner (admin), I receive a notification when a new review is submitted. | An email (Resend) goes to `RESEND_TO`/`CONTACT_TO` with subject "New IXI review (rating N)" containing name, email, company, rating, review text, ref, and a moderation decision link. |
| R1-4 | As the admin, I can approve or reject a submitted review without logging in. | The notification email contains one-click signed links: `/api/moderate/review?ref=<ref>&decision=approve` and `...&decision=reject`. Clicking updates review state and sends confirmation to the admin. |
| R1-5 | As the admin, I can see all pending reviews and their state. | A simple admin view (server-rendered, no DB in MVP — reads from an append-only moderation store, see §3.4) lists pending/approved/rejected reviews with ref, rating, date, and decision. |
| R1-6 | As a site visitor, I see approved reviews published on the site. | Approved reviews render in the testimonials section (replacing the empty state) on the next static rebuild. |

### 3.2 State model — review lifecycle

```
submitted (ingested by /api/contact, type=review)
    │
    ├─► pending  (default state on ingestion; awaiting moderation)
    │       │
    │       ├─► approved  (admin clicks approve link)  → published on next rebuild
    │       │
    │       └─► rejected  (admin clicks reject link)   → discarded, no publication
    │
    └─► honeypot / time-trap / rate-limit → silent discard, no review record created
```

| State | Meaning | Transition trigger | Who can trigger |
|---|---|---|---|
| `submitted` | Ingestion complete, validation passed, not yet moderated | Implicit on successful `/api/contact` POST with `type=review` | System |
| `pending` | Awaiting admin decision | Same as submitted (alias; `submitted` → `pending` is immediate) | System |
| `approved` | Admin approved for publication | One-click approve link in notification email | Admin only |
| `rejected` | Admin rejected; not published | One-click reject link in notification email | Admin only |
| `published` | Rendered in testimonials section on live site | Next static build after approval | Build (automatic) |

### 3.3 Notification expectations — Feature 1

| Trigger | Recipient | Channel | Content | MVP | Later |
|---|---|---|---|---|---|
| New review submitted | Admin (owner) | Email via Resend | Name, email, company, rating, review text, ref, approve/reject one-click links | ✅ | — |
| Review approved/rejected | Admin | Email via Resend | Confirmation of decision, ref | ✅ | — |
| Review published | (no direct recipient) | — | Appears on site at next build | ✅ | — |
| Review submitted | Submitter | — | Success UI message only; no auto-email to submitter in MVP | ✅ | Auto-ack email to submitter |

**Channel:** Email via Resend is already wired in `api/contact.ts`. No new provider needed for MVP. Telegram/Slack push is an open question (§9).

### 3.4 Moderation store (MVP — no database)

Since there is no database today, the MVP uses an **append-only moderation log** as the persistence layer:

- File: `site/data/moderation/reviews.jsonl` (one JSON line per review, append-only).
- Each record: `{ ref, type: 'review', state: 'pending'|'approved'|'rejected', name, email?, company?, rating, review, linkedIn?, receivedAt, decidedAt?, decidedBy?, source: 'json'|'urlencoded' }`.
- The admin moderation view reads this file at request time (serverless, read-only).
- Approve/reject links carry an HMAC-signed token (same pattern as spec §3.8 webhook signature) so only the admin can change state.
- Static rebuild: a prebuild script scans `reviews.jsonl` for `state === 'approved'` records and writes them into `site/src/content/testimonials/` as markdown files, which the existing `testimonialsSchema` renders.

**Why JSONL, not a DB, in MVP:** avoids adding a database dependency before launch. The Architect (T7) decides whether to graduate to SQLite/PostgreSQL in Phase 3.2.

**Consequence of skipping:** without any persistence, approved reviews cannot survive a redeploy and cannot be rendered on the static site.

---

## 4. Feature 2 — Client Portal

### 4.1 User stories

| ID | User story | Acceptance criteria |
|---|---|---|
| P1-1 | As the admin, I can create a client record and a project for that client. | Admin creates client (name, email) + project (title, status, start date, target end date). Each project belongs to exactly one client. |
| P1-2 | As the admin, I log progress entries on a project. | Admin adds a progress entry: date, title, description, status (e.g. "in progress", "done", "blocked"). Entry is tied to one project. |
| P1-3 | As a client, I log in and see only my own project(s) and their progress. | Client authenticates (email + magic link or password). Dashboard lists their projects with current status and recent progress entries. No other client's data is visible. |
| P1-4 | As a client, I can leave a note/annotation on a specific element or area of a page on the site. | Client selects an element (by `data-annotation-id` attribute or CSS selector) on a live page, types a note, submits. Annotation is stored with: page URL, element identity, client ID, project ID, comment text, state `open`, timestamp. |
| P1-5 | As the admin, I get notified when a client leaves a note. | Email (Resend) to admin with: client name, project, page URL, element identity, note text, annotation ID, and a link to view/respond in the portal. |
| P1-6 | As the admin, I can view, reply to, and resolve client notes. | Admin sees all open annotations across their projects, can reply, and can mark `resolved`. Client sees resolution. |
| P1-7 | As a client, I cannot see another client's project, progress, or notes. | AuthZ check on every portal request: project owner must match the authenticated client. Cross-client access returns 403. |

### 4.2 State model — portal entities

#### Client
| Field | Type | Notes |
|---|---|---|
| id | string | UUID |
| email | string | Unique; login identifier |
| name | string | Display name |
| createdAt | ISO 8601 | |

#### Project
| Field | Type | Notes |
|---|---|---|
| id | string | UUID |
| clientId | string | FK → Client.id |
| title | string | e.g. "Website redesign" |
| status | enum | `discovery`, `in-progress`, `review`, `completed`, `on-hold`, `archived` |
| startedAt | ISO 8601 | |
| targetEndAt | ISO 8601? | Optional |
| createdAt | ISO 8601 | |

#### ProgressEntry
| Field | Type | Notes |
|---|---|---|
| id | string | UUID |
| projectId | string | FK → Project.id |
| date | ISO 8601 (date only) | |
| title | string | 1..120 chars |
| description | string | 1..1000 chars |
| status | enum | `done`, `in-progress`, `blocked`, `planned` |
| createdBy | string | 'admin' |
| createdAt | ISO 8601 | |

#### Annotation (client note on a page)
| Field | Type | Notes |
|---|---|---|
| id | string | UUID |
| projectId | string | FK → Project.id (via authenticated client) |
| clientId | string | FK → Client.id (denormalised for fast lookup) |
| pageUrl | string | Absolute URL where the note was left |
| elementSelector | string | CSS selector or `data-annotation-id` value identifying the element |
| elementText? | string | Truncated text content of the element at time of annotation (for context) |
| comment | string | 1..2000 chars — the client's note |
| state | enum | `open`, `resolved`, `dismissed` |
| screenshotUrl? | string | Optional screenshot reference (object storage, not in MVP) |
| createdAt | ISO 8601 | |
| resolvedAt? | ISO 8601 | |
| resolvedBy? | string | Admin who resolved |

#### Notification
| Field | Type | Notes |
|---|---|---|
| id | string | UUID |
| type | enum | `review-submitted`, `annotation-created`, `annotation-resolved` |
| recipient | string | Admin email |
| ref | string | Related review ref or annotation ID |
| sentAt | ISO 8601 | |
| channel | enum | `email` (MVP), `webhook` (later) |
| status | enum | `sent`, `failed` |

### 4.3 Annotation specifics — what must be captured

When a client leaves a note on a live page, the following context is captured at submission time:

1. **Page URL** — absolute URL of the page where the annotation originated (e.g. `https://ixi.agency/services/ai-agents`).
2. **Element identity** — either a `data-annotation-id` attribute on the element (preferred, stable across edits) or a fallback CSS selector. The admin must be able to locate the element later.
3. **Comment text** — the client's note, 1–2000 chars.
4. **Client + project** — resolved from the authenticated session; never client-supplied.
5. **State** — `open` by default; transitions to `resolved` or `dismissed` by the admin.
6. **Timestamp** — server clock at submission.
7. **Optional screenshot** — deferred (later phase); not required for MVP.

The portal renders annotations against a page preview (or a screenshot if available) so the admin sees the note in context. In MVP, the admin view lists annotations with page URL, element selector, comment, and state — no visual overlay yet.

### 4.4 Notification expectations — Feature 2

| Trigger | Recipient | Channel | Content | MVP | Later |
|---|---|---|---|---|---|
| Client creates annotation | Admin | Email via Resend | Client name, project, page URL, element identity, note text, annotation ID, portal link | ✅ | — |
| Admin resolves annotation | Client | Email via Resend | "Your note on [project] has been resolved" + admin reply (if any) | ✅ (optional) | ✅ |
| New progress entry | Client | — | Visible on next portal login; no auto-email in MVP | ✅ | Auto-ack/digest email |

**Channel:** Email via Resend (same provider as review submissions). No new provider for MVP. Telegram/Slack push is an open question (§9).

---

## 5. Architecture & integration

### 5.1 Where each feature lives

| Component | Location | Runtime | Notes |
|---|---|---|---|
| Review submission (existing) | `site/src/components/ReviewForm.astro` → `POST /api/contact` | Static site (client) + Vercel serverless | Already built in Phase 1. |
| Review moderation store | `site/data/moderation/reviews.jsonl` | Serverless read at request time | MVP: append-only JSONL. Later: DB. |
| Moderate approve/reject endpoint | `api/moderate/review.ts` (new) | Vercel serverless | HMAC-signed query params; updates JSONL; logs decision. |
| Testimonials publish (prebuild) | `scripts/publish-testimonials.mjs` (new) | Build time | Scans JSONL for `approved`, writes `site/src/content/testimonials/*.md`. |
| Portal (auth + data) | `api/portal/*` or separate Vercel project | Vercel serverless (+ DB later) | Separate from marketing site; `noindex`. |
| Portal DB (MVP) | SQLite file or JSONL under `site/data/portal/` | Serverless read/write | MVP only; Architect decides graduation path. |
| Portal DB (later) | PostgreSQL / PlanetScale / Vercel KV | External | Phase 3.2 decision. |

### 5.2 Auth model for the portal (MVP)

- **Clients:** magic-link email auth (Resend sends a single-use token link). Client clicks → sets a secure, HttpOnly session cookie → portal validates cookie on each request. No passwords to manage.
- **Admin:** same magic-link flow, or a simple password-protected admin route (Architect decision). Admin session cookie is separate from client sessions.
- **Sessions:** stored server-side (in-memory map for MVP, or encrypted cookie). No database = in-memory session store; sessions expire on redeploy (acceptable for MVP, documented limitation).
- **Authorization:** every portal request checks that the authenticated client owns the requested project. Cross-client access → 403.

### 5.3 CSP / headers impact

- `form-action 'self'` already allows POSTs to `/api/contact` and `/api/moderate/review` (same origin). No CSP change needed for review submission or moderation.
- Portal routes under `/portal` need `noindex, nofollow` and exclusion from sitemap (invariant R-5).
- If the portal uses Calendly or Turnstile, their CSP hosts must be verified against a live page load (spec §8 note).

---

## 6. MVP vs later phasing

### MVP (launch with the site — Phase 3.1)

| Item | Included? | Rationale |
|---|---|---|
| Review submission via `/api/contact` (`type=review`) | ✅ | Already built (Phase 1). |
| Review notification email to admin | ✅ | Resend already wired. |
| One-click approve/reject links (no login) | ✅ | Zero-friction moderation; works from phone. |
| Moderation store (JSONL append-only) | ✅ | No DB needed yet. |
| Approved reviews published on static rebuild | ✅ | Fills the labelled empty testimonials state. |
| Client portal: client + project + progress entries | ✅ | Core value: client sees progress. |
| Client portal: client login (magic link) | ✅ | Required for per-client data isolation. |
| Client portal: annotation on page element | ✅ | Core "changed my mind" feature. |
| Admin notification email on annotation | ✅ | Resend already wired. |
| Admin view: list annotations, mark resolved | ✅ | Required to act on notes. |
| Database (PostgreSQL/etc.) | ❌ | JSONL + in-memory sessions for MVP. |
| Real-time notifications (Telegram/Slack) | ❌ | Email is sufficient at launch scale. |
| Visual annotation overlay / screenshot | ❌ | Deferred; text + URL + selector is enough context. |
| Client dashboard email digests | ❌ | Visible on login is enough for MVP. |

### Later (post-launch — Phase 3.2)

- Graduate moderation store + portal data from JSONL/in-memory to a real database (SQLite → PostgreSQL).
- Admin dashboard UI (currently a simple server-rendered list).
- Real-time notifications (Telegram/Slack via webhook).
- Visual annotation overlay (client clicks on a page element; admin sees it highlighted).
- Screenshot capture on annotation.
- Email digests to clients on progress changes.
- Rate-limit upgrade from in-memory to KV/Durable Objects if spam appears.

---

## 7. Non-goals (explicitly out of scope for v1)

1. **No third-party form hosts.** No Formspree, Typeform, Google Forms, etc. All submissions go through `/api/contact` (invariant R-1).
2. **No fabricated testimonials.** No invented client names, quotes, or ratings anywhere (spec plain-language rule 5).
3. **No database in MVP.** JSONL + in-memory only (spec §14: v1 has no DB/storage).
4. **No SSR.** Static output preserved; dynamic endpoints only under `api/` (invariants R-2, spec I-1/I-3).
5. **No multi-tenancy beyond per-client isolation.** Each client sees only their own projects; no agency-to-agency sharing.
6. **No real-time chat, video, or file upload.** Annotations are text only in MVP.
7. **No payment/subscription billing.** The portal is free for clients; no monetisation in v1.
8. **No i18n.** English only (spec D1).
9. **No SSO/SAML/OIDC.** Magic-link email auth only.
10. **No public annotation view.** Annotations are private between client and admin; never rendered on the marketing site.

---

## 8. Open questions for the user (NEEDS INPUT)

| # | Question | Why it matters | Assumption if unanswered |
|---|---|---|---|
| Q1 | **How should notifications reach you** when a client leaves a note — email only (Resend is already wired), or Telegram/Slack push? | Drives whether we add a webhook channel now or later. | Email only in MVP. |
| Q2 | **Admin auth:** magic-link email (same as clients) or a simple password-protected admin route? | Affects session design and UX for you. | Magic-link for both client and admin. |
| Q3 | **Do you want annotations to support screenshots?** (deferred to later either way) | Affects whether we provision object storage now. | No screenshots in MVP. |
| Q4 | **Database preference for post-launch:** PostgreSQL, PlanetScale, Supabase, or stay with file-based longer? | Drives Architect's (T7) data model decision. | Graduate to PostgreSQL in Phase 3.2. |
| Q5 | **Real domain:** `ixi.agency` / `ixiagency.com` (recommended) or something else? | Drives `SITE_URL`, canonical URLs, cookie domain, CSP. | `ixi.agency` (not yet purchased). |

---

## 9. Assumptions (marked explicitly)

| # | Assumption | Basis |
|---|---|---|
| A-1 | The review form already POSTs `type=review` to `/api/contact` with Turnstile + honeypot + time trap (Phase 1, verified). | `site/src/components/ReviewForm.astro` lines 22, 23, 73–82; `api/contact.ts` lines 41–52, 275–318. |
| A-2 | Resend is available for notification emails; `RESEND_API_KEY`, `RESEND_FROM`, `RESEND_TO`/`CONTACT_TO` are configured in Vercel project settings. | `api/contact.ts` lines 366–404; `site/.env.example`. |
| A-3 | Vercel serverless functions have no KV binding; rate limiting uses an in-memory fallback (acceptable at launch scale). | `api/contact.ts` lines 19–21, 130–147. |
| A-4 | The site remains static (`output: 'static'`); portal and moderation endpoints are serverless functions under `api/`, not Astro SSR pages. | Spec invariant I-1/I-3; Phase 1 CI relocation. |
| A-5 | No `.env` exists; all real values (Turnstile keys, Resend keys, session secrets) must be provided by the user before end-to-end testing. | Phase 1 Manager report: "keys — Turnstile + Resend placeholders are wired but untested end-to-end." |
| A-6 | HMAC-signed one-click links (same pattern as spec §3.8 webhook signature) are sufficient to authorize approve/reject without a login session. | Spec §3.8 defines `X-Signature: sha256=...` via HMAC-SHA256. |

---

## 10. Sign-off

- [ ] Product Analyst: user stories, acceptance criteria, state models, MVP phasing, non-goals complete.
- [ ] Architect: data model + auth model implementable; JSONL→DB upgrade path defined.
- [ ] Frontend: moderation links + testimonials render usable; portal UI feasible within static site constraints.
- [ ] Backend: `/api/moderate/review` + portal API endpoints implementable on Vercel serverless.
- [ ] DevOps: no new infrastructure beyond Vercel env vars + optional DB in Phase 3.2.
- [ ] QA: every state transition and authZ rule testable (403 cross-client, HMAC signature validation, time-trap + honeypot for reviews).
- [ ] Code Reviewer: threat model covers annotation context capture, session isolation, signed moderation links.

**Status:** Draft (T6). Next trigger: M3 passes → Architect (T7) produces target structure + data model + auth design.

---

**Files read for verification (no changes made):**
- `spec/interface-spec.md` — format/style baseline, invariants I-1–I-7, form contract §3, CSP §8, env inventory §12, non-goals §14.
- `site/src/components/ReviewForm.astro` — review form POST contract, Turnstile, honeypot, time-trap.
- `api/contact.ts` — Vercel contact API with `type=review` support, Resend email, rate limit, redacted logging.
- `site/functions/api/contact.ts` — Cloudflare Pages Function (unchanged, kept for later target).
- `site/src/content.config.ts` — content collections (`services`, `caseStudies`); no testimonials collection yet.
- `site/src/components/Testimonials.astro` — labelled empty state (Phase 1).
- `site/public/_headers` — CSP, HSTS commented out, form-action 'self'.
- `site/.env.example` — env variable placeholders.
- `.github/workflows/ci.yml` — CI relocated to root, deploy gated on `VERCEL_TOKEN`.

**No files were changed.** This document is the only deliverable.
