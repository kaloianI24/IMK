# IXI — Client/Owner Portal MVP (T7b)

**Owner:** Architect — Technical Design  
**Task:** T7b (technical design consumed by Frontend T8, Backend T9, DevOps T10, QA T11)  
**Baseline:** [`spec/06-reviews-portal-requirements.md`](06-reviews-portal-requirements.md) (T6); [`spec/07-reviews-portal-design.md`](07-reviews-portal-design.md) (T7); [`spec/interface-spec.md`](interface-spec.md) v1 (T2); Phase 1 committed as `8303af9`.  
**Status:** Draft for M3 review. Documents only — no site build code, no file changes outside this deliverable.  
**Revision 2 (2026-10-20, Backend):** adds the testimonial endpoint `GET|POST /api/portal/testimonials` and the `testimonialStatus` field on Project (§3.1, §3.2, §4.1, §4.4, §5, §6, §7, §8). Requirements baseline for this feature: [`spec/research-client-profiles-testimonials.md`](research-client-profiles-testimonials.md) (RP-3, RP-6, RP-7, RP-8). Assumptions A-1 and A-4 are **retracted** — `api/contact.ts` no longer accepts `type=review` (see §8).

This design pulls the client/owner portal forward from Phase 3 into an MVP. It defines magic-link auth, the project status board, plan items with approve/request-change, comments, data model, routes, security, phasing, and a Backend/Frontend task breakdown. Anything not listed here is out of scope for v1 or must be raised as a numbered edit against this file, not improvised in code.

It references spec/07 for shared concerns (dual-channel notifications, admin inbox `/admin`, Telegram module, review moderation) — this file does not repeat them.

---

## 0. Plain-language rules that govern this design

1. **No new third-party form hosts.** All submission and webhook traffic goes through `/api/contact` (spec invariant I-7 / requirement R-1). Portal endpoints live under `/api/portal/*` and are owner-built.
2. **Static output preserved.** `output: 'static'` in `site/astro.config.mjs` holds. No SSR pages, no `@astrojs/cloudflare` adapter, no `prerender = false` inside `src/pages/`. Dynamic endpoints live only under `api/` (Vercel) and `site/functions/` (Cloudflare target, kept for later).
3. **No secrets in the client bundle.** Only `TURNSTILE_SITE_KEY` + analytics ID are public. Session signing secrets, Resend keys, Turnstile secrets are server-side only (invariant I-5 / requirement R-3).
4. **No database today.** MVP persists to append-only JSONL files under `site/data/portal/` + in-memory sessions. A real database is a Phase 3.2 decision (spec §14: v1 has no DB/storage).
5. **Clients see only their own project.** Every portal request checks ownership server-side; cross-client access returns 403 (requirement R-4).
6. **`/portal` and `/login` are hidden from search.** `noindex, nofollow`, excluded from sitemap (requirement R-5 extended to `/login`).
7. **No open public registration.** `/login` accepts an email, but a sign-in link is only issued to an invited/allow-listed email. Unknown emails get the same generic message — no enumeration.
8. **No passwords anywhere.** Magic-link email auth only. No password storage, no password-reset flow.

---

## 1. Invariants (build-time / runtime; enforced by CI or review)

| ID | Invariant | Where enforced |
|----|-----------|----------------|
| P-1 | `output: 'static'` in `site/astro.config.mjs`; no `@astrojs/cloudflare` in `site/package.json`. | CI (`.github/workflows/ci.yml`) |
| P-2 | No `export const prerender = false` anywhere under `site/src/pages/`. Only `api/` and `site/functions/` endpoints are dynamic. | CI grep |
| P-3 | Client bundle contains only `TURNSTILE_SITE_KEY` + `ANALYTICS_SITE_ID`. Session/resend/turnstile-secret never appear in `dist/`. | CI secrets scan over `dist/` |
| P-4 | `/portal`, `/login`, and `/admin` routes carry `noindex, nofollow` and are excluded from `sitemap.xml`. | CI + build check |
| P-5 | All portal writes go through server-side endpoints under `/api/portal/*`, never client-side email or third-party form host. | Code review |
| P-6 | Cloudflare target files (`site/functions/`, `site/public/_headers`) remain intact; Vercel is interim only. | Code review |
| P-7 | `/login` never reveals whether an email is registered/invited. | Code review + QA |

---

## 2. Auth — magic-link flow (no passwords)

### 2.1 Flow end-to-end

1. **Request link.** User (owner or client) opens `/login`, enters their email, submits POST to `/api/portal/auth/request-link`.
2. **Server checks allow-list.** The server looks up the email in the invited-client registry (`site/data/portal/invited.jsonl`) or the admin allow-list (`ADMIN_EMAILS` env). If not found, the server still returns a generic "check your inbox" response — never revealing whether the email is registered.
3. **Token issued.** Server generates a single-use, time-bound magic token: `HMAC-SHA256(PORTAL_MAGIC_LINK_SECRET, email|purpose|ts|nonce)`, base64url-encoded. Token TTL = 15 minutes. Token stored in-memory keyed by token hash (MVP; expires on redeploy, documented limitation).
4. **Email sent.** Server emails a magic link `<SITE_BASE_URL>/login/verify?token=<token>&purpose=portal` via Resend (existing pattern, `api/lib/notifications.ts`). `SITE_BASE_URL` defaults to `http://localhost:4321` for local development (matching the `astro dev` default port); switching to a real domain later is a one-line env-var change.
5. **Click → session.** User clicks the link. GET `/api/portal/auth/verify` validates the token (signature + expiry + single-use), resolves the user's role (`admin` if email in `ADMIN_EMAILS`, else `client`), sets a secure HttpOnly SameSite=Strict Secure session cookie (`imk_session` for clients, `imk_admin_session` for admin), and redirects to `/portal`.
6. **Portal access.** Every subsequent `/portal` request validates the cookie server-side. Role is resolved from the session (never trusted from client). Missing/invalid cookie → 401 or redirect to `/login`.
7. **Logout.** POST `/api/portal/auth/logout` clears the session cookie (server-side invalidation of the in-memory entry; cookie cleared client-side).

### 2.2 Secrets, expiry, lifetime, revocation

| Item | Value / behaviour | Notes |
|------|-------------------|-------|
| Token signing secret | `PORTAL_MAGIC_LINK_SECRET` env var (server-only) | Generate with `openssl rand -hex 32`; add to `site/.env.example` |
| Token TTL | 15 minutes | Short window; link expires before it can be reused |
| Token use | Single-use | Consumed on verify; cannot be replayed |
| Session cookie (client) | `imk_session`, HttpOnly, SameSite=Strict, path=/, TTL 24h; `Secure` only when `SITE_BASE_URL` is HTTPS (not set on plain `http://localhost`) | Refreshed on activity |
| Session cookie (admin) | `imk_admin_session`, same attributes, separate name | Admin routes gated by `isAdmin` flag |
| Session storage | In-memory `Map` keyed by session token (MVP) | Expires on redeploy — documented limitation |
| Revocation | Server-side deletion of the in-memory entry + cookie clear on logout | No token revocation list needed (single-use + short TTL) |

### 2.3 Roles

| Role | Who | Allow-list source | Capabilities |
|------|-----|-------------------|--------------|
| `admin` | Site owner (IXI) | `ADMIN_EMAILS` env var (comma-separated) | Full portal: update project state, plan item status, post updates/comments, resolve annotations, view all projects |
| `client` | Invited customer | `site/data/portal/invited.jsonl` (invited emails) | Own project only: view status, comment, approve/request-change plan items |

### 2.4 Rate limiting

`/api/portal/auth/request-link` is rate-limited per-IP using the same in-memory fallback as `api/contact.ts` (5 requests per hour per IP; `KV_COUNTER` on Cloudflare target). Prevents email bombing via magic-link requests.

### 2.5 Graceful degradation when Resend keys absent

If `RESEND_API_KEY` is not configured, the server still generates the token and returns success to the user, but instead of sending email it **prints the magic token to the server log** (`{ outcome: 'magic_link_dev', token, email, purpose }`) so the flow is testable locally. The user copies the token from the log and visits `/login/verify?token=...` manually. No request fails because email is unavailable.

**ASSUMPTION:** Dev-mode token printing is not yet implemented; it is specified here for Backend T9.

### 2.6 Unknown-email behaviour (no enumeration)

Whether or not the email is invited/registered, the HTTP response is identical: `200 { ok: true, message: 'If you have an invitation, a sign-in link has been sent.' }` and a redacted log line. No timing differences that leak registration status.

---

## 3. Data model (portal additions under site/data/portal/)

All JSONL stores live under `site/data/portal/`, consistent with `site/data/moderation/reviews.jsonl` (T6 §3.4, spec/07 §2.2). MVP: append-only writes, read-at-request-time. Phase 3.2: graduate to SQLite (Turso) or PostgreSQL (Neon).

### 3.1 Entities

**Invited client** (`site/data/portal/invited.jsonl` — the client allow-list)

| Field | Type | Notes |
|-------|------|-------|
| `email` | string | Unique; login identifier |
| `name` | string | Display name. Carried into the client record on first sign-in (§4.5) |
| `company` | string? | Carried into the client record on first sign-in (§4.5) |
| `role` | string? | Carried into the client record on first sign-in (§4.5) |
| `invitedBy` | string | Admin email who invited |
| `invitedAt` | ISO 8601 | |
| `clientId` | string? | UUID, set on first login (links invite to client record) |

**Invite paths (both supported in v1):** an invited email can enter `invited.jsonl` either by being pre-populated manually by the admin, or by the owner submitting the invite-client form in the portal UI (POST `/api/portal/invites`, appends to `invited.jsonl`). The file-only path fails the "invite directly if they haven't found the portal yet" need; the UI-only path fails pre-staging invites before the owner logs in. Both are kept.

**Client** (`site/data/portal/clients.jsonl`)

| Field | Type | Notes |
|-------|------|-------|
| `id` | string | UUID |
| `email` | string | Unique; login identifier |
| `name` | string | Display name |
| `company` | string? | Optional; shown with a published testimonial when the client consents (P2) |
| `role` | string? | Optional; the client's job title, shown with a published testimonial |
| `createdAt` | ISO 8601 | |

**Project** (`site/data/portal/projects.jsonl`)

| Field | Type | Notes |
|-------|------|-------|
| `id` | string | UUID |
| `clientId` | string | FK → Client.id |
| `title` | string | e.g. "Website redesign" |
| `status` | enum | `discovery\|in-progress\|review\|completed\|on-hold\|archived` |
| `testimonialStatus` | enum? | `requested\|snoozed\|declined` — absent = never asked. Set by the server when the client answers the testimonial prompt; the owner can set it back to `requested` to ask again. See §4.4. |
| `startedAt` | ISO 8601 | |
| `targetEndAt` | ISO 8601? | Optional |
| `createdAt` | ISO 8601 | |
| `updatedBy` | string? | Admin email who last changed status |
| `updatedAt` | ISO 8601? | |

**Plan item** (`site/data/portal/planItems.jsonl`)

| Field | Type | Notes |
|-------|------|-------|
| `id` | string | UUID |
| `projectId` | string | FK → Project.id |
| `title` | string | 1..120 chars |
| `description` | string? | 0..1000 chars |
| `status` | enum | `todo\|in-progress\|done\|blocked` |
| `order` | integer | Display order within project |
| `createdAt` | ISO 8601 | |
| `updatedAt` | ISO 8601? | |
| `approvedBy` | string? | Client email who approved (when status→done) |
| `requestChangeBy` | string? | Client email who requested change |
| `requestChangeAt` | ISO 8601? | |

**Update / changelog entry** (`site/data/portal/updates.jsonl`)

| Field | Type | Notes |
|-------|------|-------|
| `id` | string | UUID |
| `projectId` | string | FK → Project.id |
| `title` | string | 1..120 chars |
| `body` | string | 1..2000 chars |
| `createdBy` | string | `admin` or `client` email (resolved from session) |
| `createdAt` | ISO 8601 | |

**Comment** (`site/data/portal/comments.jsonl`)

| Field | Type | Notes |
|-------|------|-------|
| `id` | string | UUID |
| `planItemId` | string? | FK → PlanItem.id (optional; can be project-level) |
| `projectId` | string | FK → Project.id |
| `authorId` | string | FK → Client.id or admin |
| `authorRole` | enum | `admin\|client` |
| `authorName` | string | Display name |
| `body` | string | 1..2000 chars |
| `createdAt` | ISO 8601 | |

**Session** (in-memory `Map`, not persisted)

| Field | Type | Notes |
|-------|------|-------|
| `token` | string | Session token (cookie value) |
| `email` | string | Authenticated user email |
| `role` | enum | `admin\|client` |
| `clientId` | string? | Resolved for clients; null for admin |
| `expiresAt` | ISO 8601 | 24h TTL, refreshed on activity |

### 3.2 Write permissions (who can write what)

| Action | Owner (admin) | Client | Enforcement |
|--------|---------------|--------|-------------|
| Create project | ✅ | ❌ | Session role = admin |
| Invite client (append email to `invited.jsonl`) | ✅ | ❌ | Session role = admin; supports both UI-invite and pre-populated file fallback |
| Update project status | ✅ | ❌ | Session role = admin + project exists |
| Create plan item | ✅ | ❌ | Session role = admin |
| Update plan item status (todo↔in-progress↔done↔blocked) | ✅ | ✅ (own project only) | Server resolves projectId from session, never trusts client-supplied |
| Approve plan item (mark done) | ✅ | ✅ (own project) | Records `approvedBy` + timestamp |
| Request change on plan item | ❌ | ✅ (own project) | Records `requestChangeBy` + timestamp; status reverts to `in-progress`/`todo` |
| Post update (changelog) | ✅ | ✅ (own project) | `createdBy` resolved from session |
| Comment on plan item / project | ✅ | ✅ (own project) | `authorRole` from session |
| Resolve annotation | ✅ | ❌ | Session role = admin |
| Submit / snooze / decline a testimonial | ❌ | ✅ (own project, finished) | `POST /api/portal/testimonials` — session role = client; project ownership + eligibility checked server-side (§4.4) |
| Re-request a testimonial | ✅ | ❌ | `PATCH /api/portal/projects/:id` with `testimonialStatus: 'requested'` |
| View any project | ✅ | ❌ (own only) | Cross-client → 403 |

**No IDOR:** client-supplied `clientId`/`projectId` are ignored; ownership is always resolved from the authenticated session.

---

## 4. Routes and screens

### 4.1 Route inventory

| Route | Method | Auth | Audience | Indexing |
|-------|--------|------|----------|----------|
| `/login` | GET + POST | None (public entry) | Owner + invited clients | `noindex, nofollow`, no sitemap |
| `/login/verify` | GET | None (token-gated) | Owner + invited clients | `noindex, nofollow`, no sitemap |
| `/portal` | GET | Session required | Owner + clients | `noindex, nofollow`, no sitemap |
| `/portal/logout` | POST | Session required | Owner + clients | `noindex, nofollow`, no sitemap |
| `/api/portal/auth/*` | POST/GET | None (token-gated for verify) | Owner + clients | n/a (API) |
| `/api/portal/invites` | POST | Session + admin | Owner only (invite clients) | n/a |
| `/api/portal/projects/*` | GET/POST/PATCH | Session + role | Owner + clients | n/a |
| `/api/portal/plan-items/*` | GET/POST/PATCH | Session + role + ownership | Owner + clients | n/a |
| `/api/portal/updates/*` | GET/POST | Session + role + ownership | Owner + clients | n/a |
| `/api/portal/comments/*` | GET/POST | Session + role + ownership | Owner + clients | n/a |
| `/api/portal/testimonials` | GET/POST | Session + client + ownership | Clients (owner may read) | n/a |
| `/admin` | GET | Admin session | Owner only | `noindex, nofollow`, no sitemap (spec/07 §7.3) |

### 4.2 Route choice justification: `/portal` single view, role-switched

I recommend a **single `/portal` route that renders different UI based on session role** (`admin` vs `client`), rather than separate `/portal` and `/owner` routes.

**Justification:**
- Keeps the surface minimal: one route to guard, one set of noindex/sitemap rules, one session cookie family.
- Admin and client views share the same data (projects, plan items, updates, comments) — role-switched UI avoids duplicating endpoints.
- Separate `/admin` (spec/07 §7.3) remains the owner's *inbox* for pending reviews and open annotations — distinct from the project status board at `/portal`.
- No admin capability is embedded in the public client bundle; `/portal` server-renders the appropriate view after session validation.

### 4.3 Screen inventory (rough structure)

**Guest visibility (acceptance criterion):** The public site renders exactly one portal-related element: a "Log in" link (Header/nav). Portal navigation, project names, plan items, updates, comments, and any other `/portal` affordance render ONLY when a valid session cookie is present. No portal preview, no "client area" teasing, and no project data in guest mode. If the cookie is missing or invalid, the user sees only the login link; clicking it opens `/login`.

**`/login`** — single page:
- Heading "Sign in to your IXI portal"
- Email input + "Send sign-in link" button
- Helper text: "No password. We'll send a one-time link to your inbox."
- Generic message after submit (regardless of whether email is invited)
- Link: "Not yet invited? Contact IXI to request access."

**`/login/verify`** — thin server-rendered page:
- Validates token, sets session cookie, redirects to `/portal`
- On failure: "Link expired or invalid. Request a new one." → back to `/login`

**`/portal` (client view)** — status board:
- Header: project title + current status badge
- Plan items list: title, status badge (todo/in-progress/done/blocked), order
  - Client actions: "Approve" (when done), "Request change" (when done/blocked)
- Recent updates changelog (newest first): title, body, author, date
- Comments section per plan item / project: author, body, date; client can add comment
- Testimonial card — renders only when the server says the project is eligible (see §4.4). Quote text (1..1000 chars, required), optional rating 1..5, optional display name, three independent **default-off** consent boxes (P1 publish quote / P2 name + company / P3 case study), and "Maybe later" / "No thanks". The client never decides whether they are asked — that is the server's call.
- CTA: "Questions? Reply to this update or contact IXI."

**`/portal` (owner/admin view)** — same status board plus owner controls:
- Project status dropdown (discovery/in-progress/review/completed/on-hold/archived)
- Plan item status controls (todo/in-progress/done/blocked)
- "Post update" composer (title + body)
- Comment composer
- Switch: view all projects (admin can switch between client projects via server-side selector, never client-supplied)
- "Ask for a testimonial again" control — PATCHes `testimonialStatus: 'requested'` on the project. It re-opens a request the client snoozed or declined; it does not override a live quote.

**`/admin`** (spec/07 §7.3 — owner's inbox, not part of `/portal`):
- Counts header: pending reviews / open notes / resolved
- Reviews tab: approve/reject via `/api/moderate/review`
- Client notes tab: resolve/reply annotations

### 4.4 Testimonial endpoint (`/api/portal/testimonials`)

This is the **only** door for client testimonials (RP-3). The public review form was removed from the marketing site, and `POST /api/contact` now **refuses** `type=review` with `410 review-moved` — in **any** case/whitespace variant (`Review`, `REVIEW`, ` review` — the type is trimmed and lower-cased before the check), before Turnstile, before the rate limit and before any write. Hiding a form is not the same as closing the door, and an open endpoint lets anyone write into the moderation queue.

**Files:** `api/portal/testimonials.ts` (Vercel) · `site/functions/api/portal/testimonials.ts` (Cloudflare mirror) · `api/portal/projects.ts` (owner re-request) · `site/src/components/PortalTestimonialPrompt.astro` (card) · `site/scripts/publish-testimonials.mjs` (publish-time enforcement).

**Storage:** `site/data/moderation/reviews.jsonl` — the *same* append-only moderation log the owner's approve/reject links already read. No second moderation flow. A change of mind is **appended as a new line with a stable `ref`**; later lines win, which is the rule the publish script and `api/moderate/review.ts` both use.

**Request (POST)** — session required:

```jsonc
{
  "action": "submit" | "snooze" | "decline",
  "projectId": "<project id>",
  "rating": 1,          // optional, integer 1..5
  "review": "<quote>",  // required for submit, 1..1000 chars
  "displayName": "<name>", // optional, <= 80 chars
  "consent": { "p1": true, "p2": false, "p3": false }
}
```

**Response:** `200 { ok: true, testimonial }` on success; `testimonial` is the **client-safe view** (no email, no internal ids).

**GET** `?projectId=<id>` → `200 { ok: true, testimonial | null }`. A `404` from this endpoint means the feature is not deployed — the card hides itself rather than showing a dead form.

**What the server decides — never the client:**

| Field | Source | Rule |
|-------|--------|------|
| `verifiedClient` | the session | `true` only when the session resolves to a `clientId` that owns the target project. A body value of `verifiedClient: false` is ignored (RP-3.8). |
| `source` | the endpoint | Always `'portal'`. The body cannot set it. |
| `name` / `company` / `role` | the client record | Not from the form. The client record inherits them from the owner's invite (§4.5). With naming consent (`consent.p2`) but no profile name the stored name is **blank** — the e-mail local part is never published as a name (review finding B6, 2026-10-21). |
| `clientId` / `email` | the session | Never echoed back to the client in the response. |
| `projectId` | the body, then validated | Must belong to the session's client; otherwise `404` (not `403` — no project-id probing, RP-3.6). |
| `consent.p1` | the body | **Required.** Without it: `400 consent-required` and **nothing is stored, nothing is sent**. |

**Status codes:** `401` no session · `403` wrong/missing `Origin`, the owner trying to submit, **or a client session without a `clientId`** (`session has no client identity` — a client session always names its tenant; without this check `project.clientId !== session.clientId` passes against a project that itself has no `clientId`) · `404` unknown project or another client's project · `409` project not finished yet, or a prior decline that was not re-requested · `429` more than 5 submissions per client per hour · `400` validation failure — a body that does not parse, or that parses to anything but a plain object (`null`, `[]`, a bare number), answers `400 {error:'invalid payload', code:'validation'}` on **both** trees (it used to be an unhandled `500` on Vercel and a misleading `validation failed: fields:['action']` on Cloudflare) · `413` request body over the ~16 KB cap (`payload-too-large` — a quote endpoint does not need a bigger body; enforced from `content-length` **and** from the streamed bytes, so a chunked body cannot slip past it) · `405` other methods.

**Eligibility:** a project qualifies when `status === 'completed'` **or** `testimonialStatus === 'requested'` (the owner asked again). The client's answer sets `testimonialStatus` to `requested` / `snoozed` / `declined`.

**Decline is final.** A client who declined is not asked again unless the owner re-requests it — enforced **on the server** (`409 declined`), not only by hiding the card (RP-3.5).

**Consent is enforced twice:** once here (P1 must be true to store anything) and again at publish time in `site/scripts/publish-testimonials.mjs` (a record whose consent was revoked, or which was withdrawn, is never written to the site). A withdrawn quote disappears from the next build (RP-6.4 / RP-6.5).

**`PATCH /api/portal/projects/:id` — owner re-request:** accepts `testimonialStatus` ∈ `requested` | `snoozed` | `declined` | `null` (absent field = leave unchanged; `null` = clear it — the project returns to "never asked" and the client is eligible again on their next visit). Any other value — including the empty string, `true`, or an unknown status — → `400 invalid testimonialStatus` (`fields:['testimonialStatus']`); the request changes **nothing** in that case. Admin session required. The field sets the *ask*, never the quote: it cannot approve, reject or edit a stored review, and it is overwritten by the client's next answer (§4.4).

**Deviation from the research summary (§8.7 of the research spec):** the research doc sketched a separate `POST /api/portal/testimonials/dismiss` for "Maybe later" / "No thanks". The implementation uses **one endpoint with an `action` field** instead, so snooze/decline share the same auth, origin, eligibility and rate-limit path with submit. The card posts `{ action: 'snooze' }` / `{ action: 'decline' }` — the Frontend card and the Backend endpoint agree on this.

**Storage caveat:** the Cloudflare target has no writable filesystem, so the mirror answers `501 unimplemented` there and the card hides itself. Moving the portal store to a real database is tracked in [`spec/proposal-portal-storage.md`](proposal-portal-storage.md) and is a launch blocker for the portal as a whole, not for this feature.

**Length coupling to the published schema (build safety):** the published frontmatter is validated by the `testimonials` content collection (`site/src/content.config.ts`), and **one invalid file fails the whole build**, not just one quote. The client record's `name` / `company` / `role` are typed by the owner with no length limit, so the endpoint caps them at the schema's own limits before they enter the store — `name` ≤ 80, `company` ≤ 120, `role` ≤ 120 — cutting on a word boundary. Without that cap, a client whose registered name exceeds 80 characters produces a file that fails validation and **breaks the site build** (this was reproduced on 2026-10-20 and is now fixed). The publish script remains the second line of defence only in the sense that it refuses to publish revoked/unconsented records; it does not validate lengths, so the cap must stay in the handler.

### 4.5 Client profile — `/api/portal/invites` (owner)

**Files:** `api/portal/invites.ts` (Vercel) · `api/portal/auth.ts` (client-record creation) · `site/src/components/PortalInviteForm.astro` + `site/src/pages/portal.astro` (owner UI — Frontend).

**Why this endpoint carries the profile:** the client record's `name` / `company` / `role` are **the owner's data about their client** — the client never types them, and a published testimonial must show the name the owner knows them by. Until 2026-10-20 there was **no write path for `company` or `role` at all**, and the owner-typed `name` was silently discarded on the client's first sign-in (`name: email.split('@')[0]`), so a published testimonial showed `alice.longname` and no company. Reproduced on 2026-10-20 and fixed.

**Request (POST, admin session, same-origin):**

```jsonc
{
  "email": "client@acme.test",   // required — the login identifier
  "name": "Alice Longname",      // optional, <= 80 chars
  "company": "Acme Ltd",         // optional, <= 120 chars
  "role": "CTO"                  // optional, <= 120 chars
}
```

**Upsert, not insert-only.** A second POST for the same email patches the profile on the invite record **and** on the client record, so the owner can add a company *after* the client has signed in. This endpoint is deliberately the **only** write path to a client record — one owner surface, one set of auth rules, no second admin endpoint to keep in step.

**Field semantics:** omitted = leave unchanged · empty string or `null` = clear the field · a non-string or an over-cap value = `400 validation` naming the offending fields, and **nothing is written**.

**Caps:** `name` ≤ 80, `company` ≤ 120, `role` ≤ 120 — the same numbers as the published schema (`site/src/types/contracts.ts` → `TESTIMONIAL_MAX`) and as `api/portal/testimonials.ts`. An over-long value is **rejected, not truncated**: silently shortening a client's name would publish something the client did not approve. Control characters are stripped before the value is stored.

**Client record creation (`api/portal/auth.ts`):** on the client's first sign-in the record is created from the invite — `name` from the invite (falling back to the email local-part **only** when the owner gave no name), plus `company` and `role`. If the invite already carries a `clientId` but the client record is missing, it is re-created on the next sign-in (self-healing). The invite's `clientId` is written **before** the client record, so a crash in between leaves a repairable state rather than an orphan record nothing points at.

**Status codes:** `403` no admin session, or a wrong/missing `Origin` · `400` invalid email or invalid profile field · `404` other methods · `200` created or updated.

**Known limitation (deliberate, not a bug):** the profile is captured into the testimonial record **when the client submits**. A quote submitted before the owner added the company keeps the older value; the published frontmatter is not rewritten retroactively. Refreshing at approval time or at export time is the fix, and it belongs to the storage migration — the publish script reads a snapshot, not the live store.

**Cloudflare parity:** the mirror's invite endpoint is still a `501 unimplemented` stub and the CF auth handler does not create client records (it defers to the Vercel target). Client-record creation on the edge — including this name/company/role inheritance — is **T8** in [`spec/proposal-portal-storage.md`](proposal-portal-storage.md). Until then the portal is Vercel-only.

**Data hygiene:** `site/data/portal/` holds client emails, names, companies, invite records and sessions. It is **git-ignored** (added 2026-10-20) so `git add .` can never sweep live client PII into the repository. `site/data/moderation/` is *not* ignored — the build-time publisher reads it.

### 4.6 Moderation link, limits and configuration (fix wave 2 — Backend, 2026-10-20)

Added after the independent audit (`audit-reviews-testimonials-2026-10-20.md`, findings M5/M6 + m2–m8) and QA's re-run. Both handler trees behave identically.

**4.6.1 The one-click link is bound to a revision (M5).**

`GET /api/moderate/review?ref=…&decision=approve|reject&revision=<n>&sig=…&ts=…`

The signed message is `ref|decision|revision|ts` (HMAC-SHA256 with `FORM_WEBHOOK_SECRET`). The **revision is part of the signature** and travels in the URL, so a link can only ever approve the exact text the owner was shown. Before this change the link carried no revision and the endpoint flipped whatever the newest line for that ref happened to be — a client who edited their quote between the mail and the click had their *new* text approved by the owner (reproduced by the audit, and again by the Code Reviewer's sandbox).

| Situation | Answer |
|---|---|
| `revision` missing or not a positive integer | `400 validation` |
| signature does not match (incl. a `revision` that was tampered with) | `400 signature` |
| link older than 7 days / a timestamp > 60 s in the future | `400 expired` |
| unknown `ref` | `404 not-found` |
| the link names a revision that is **not** the newest one | `409 stale-revision` — **nothing is approved** |
| the link names the newest revision and the record is `pending` | the record is approved/rejected, confirmation mail sent, `200` |
| the record was already decided | `200` (idempotent, no new line) |

`409 stale-revision` is the "the client changed this quote" case. The endpoint then **mails the owner a fresh link for the current revision** (only when the newest revision is still a pending quote — a snoozed or declined quote mails nothing), so the owner can always finish the moderation without waiting for another client action.

**4.6.2 Rate limits (m6).** `submit` — 5 per client per hour; `snooze` / `decline` — 10 per client per hour. Two separate buckets (a submit never eats a snooze slot). The counter is consumed **only by a request that passed validation**, so five malformed posts no longer lock a client out for an hour. `429` + `Retry-After: 3600` when a bucket is full.

**4.6.3 The newest record for a project is client-scoped (m7).** The lookup filters on `projectId` **and** `clientId`, so a project that is ever reassigned cannot hand the new client the old client's quote, ref or revision counter.

**4.6.4 A production instance must have a base URL (m4).** `SITE_BASE_URL` (or the legacy `SITE_URL`) is required in production — `APP_ENV` unset means production. Without it every state-changing call answered `403 origin required` (which reads like a CSRF attack) and the session cookie was issued **without `Secure`**. Now: `500 { code: 'internal' }` before anything else happens, on `POST /api/portal/auth/request-link`, `GET /api/portal/auth/verify` and every state-changing portal endpoint. A development instance (`APP_ENV` explicitly not `production`) may run on `http://localhost:4321`.

**4.6.5 One session per cookie name (m5).** A browser can hold `imk_session` and `imk_admin_session` at once. Both are now read; the endpoint asks for the role it needs (owner-only endpoints prefer the admin cookie, client endpoints prefer the client cookie) and a cookie that does not resolve to a live session is **skipped** — a stale admin cookie can no longer shadow a valid client cookie. `POST /api/portal/auth/logout` destroys **both** sessions and clears **both** cookies.

**4.6.6 Titles, plan items, updates and comments are stored raw (m3).** The server stores the value as typed; escaping happens once, at the point of output (the portal page escapes on render). Storing an escaped value *and* escaping on render turned "Tom & Jerry Ltd" into "Tom &amp;amp; Jerry Ltd".

**4.6.7 The publish script refuses a lossy read (m2).** `site/scripts/publish-testimonials.mjs` used to skip a malformed line and publish the rest — an approved quote could simply vanish from the site with nothing in the build output to say so. It now **fails the build** (`exit 1`, with the file and the line number) and publishes nothing.

**4.6.8 Cloudflare parity (M6).** The CF tree has its own notification module (`site/functions/api/lib/notifications.ts`, edge-safe: `crypto.subtle`, no `node:` imports) and the CF testimonial endpoint now notifies the owner on submit. Before this the CF target accepted a testimonial and told nobody: the quote sat `pending` forever, with no mail and no one-click link.

**4.6.9 Dev/prod parity (m8).** `/api/moderate/review` is exported from `site/scripts/api-index.ts` and routed by `site/scripts/dev-portal.js`, so the one-click link works in local dev exactly as in production. `esbuild` is now a declared devDependency of `site/package.json` (the dev server imports it directly).

### 4.7 The rate limiter has a backend, and the Cloudflare target says "not implemented" — Backend, 2026-10-20

Added after QA's wave-2 re-run, which closed the feature but left two open items: the Cloudflare runtime was never executed, and the rate counters lived in a module-level `Map`, so on a serverless target every cold start reset them.

**4.7.1 The limiter owns a backend (`api/lib/rate-limit.ts`, edge twin `site/functions/api/lib/rate-limit.ts`).**

| Backend | Where the count lives | Durable? | When it is used |
|---|---|---|---|
| `memory` | the process | no | the default, everywhere |
| `file` | a JSON file next to the portal data | yes — across restarts, shared by every process on the host | opt-in: `PORTAL_RATE_LIMIT_FILE=<path>` (a self-hosted/VPS target) |
| `kv` | a Workers KV binding (`KV_COUNTER`) | yes — across cold starts | the Cloudflare tree, when the binding exists |

The rule is unchanged (5 submits and 10 snoozes/declines per client per hour, two buckets, a slot consumed only by a request that passed validation, `429` + `Retry-After: 3600`), but the **guarantee is now stated instead of implied**: on a serverless target with no shared store the limit is *per instance* — a best-effort speed bump, not a hard limit. A shared counter for the launch target arrives with the storage migration (T4): the seam exists so that adapter lands without touching a call site.

Safety rules, all enforced by `site/qa/qa-rate-limit.mjs`:

- a backend can never fail a request — if it throws, the limiter falls back to the in-memory counter and reports `degraded: true`;
- keys are **hashed** before they reach a durable backend, so no client id and no IP address is ever written to disk or to KV;
- the check and the consumption are one operation, so they cannot race;
- the in-memory map lives on `globalThis`, so the counter survives a re-evaluation of the module inside one process (the dev server rebuilds handlers per request).

**4.7.2 The Cloudflare target fails loudly, and its portal is a stub — this is the truth about M6.**

The Cloudflare tree has **no writable filesystem**, so the portal store cannot be read there. Every portal endpoint now answers `501 { code: 'unimplemented' }` — the write paths already did; the read paths (`projects`, `comments`, `plan-items`, `updates`, `testimonials`, and the sign-in door) used to answer **`200` with an empty list**, which reads as "no projects", "no comments", "not invited": a silent outage shaped like a normal answer (the same class of defect as M3/D3, still open in the CF tree).

Consequences, stated plainly:

- **M6 is closed in code, not in production.** The Cloudflare notification path exists and is edge-safe, but it sits behind the `501`. A testimonial submitted on the Cloudflare target still cannot reach it, because the portal cannot run there at all.
- **The launch target is the Vercel tree** (`api/`), where the portal, the notification and the one-click link are executed and verified. The Cloudflare tree remains a parity twin for a later move — which needs a real store (D1/KV) first, i.e. the same storage work as T4.
- The Cloudflare **sign-in limiter is live** and is now KV-backed, so it survives cold starts.

**4.7.3 The moderation link contract is the same on both targets — and is now executed, not assumed.**

`site/qa/qa-cf-parity.mjs` runs the Cloudflare modules in a Web-standard runtime (Node's `Request`/`Response`/`fetch`/`crypto.subtle` — the same globals workerd provides) and proves:

- a link signed by the Cloudflare tree verifies with the **Vercel** verifier, and a link signed by the Vercel tree verifies with the **Cloudflare** verifier;
- both trees build the same link shape (`ref`, `decision`, `revision`, `sig`, `ts`) from `SITE_BASE_URL`, and sign it identically;
- the Cloudflare moderation endpoint **accepts** a Vercel-signed link and **rejects** a forged one (`400 signature`);
- a link signed for revision 1 does not verify for revision 2, in either tree (M5 holds across targets).

*Not verified: the workerd runtime itself.* `wrangler` is not installed on this machine and no workerd binary is available, so the edge runtime was never booted. Every claim above is a claim about the Cloudflare **code path**, executed — not about Cloudflare's runtime. When the Cloudflare target becomes real, it needs a `wrangler pages dev` run and a D1/KV store.

### 4.8 The route table is a file contract, and the deploy target is the repo root — Backend, 2026-10-20

Added after QA's wave-3 re-run, which found the one defect that would have broken the launch: **the sign-in door was unreachable on the deployed target** (F-1). QA could not boot the Vercel router (no token), so the finding rested on the repo layout and Vercel's documented rule — the rule is now enforced by a machine check instead of by reading.

**4.8.1 Both targets route a function by its FILE PATH.**

| URL the client calls | Vercel file | Cloudflare file |
|---|---|---|
| `/api/portal/auth/request-link` | `api/portal/auth/request-link.ts` | `site/functions/api/portal/auth/request-link.ts` |
| `/api/portal/auth/verify` | `api/portal/auth/verify.ts` | `site/functions/api/portal/auth/verify.ts` |
| `/api/portal/auth/logout` | `api/portal/auth/logout.ts` | `site/functions/api/portal/auth/logout.ts` |
| `/api/portal/projects/<id>` | `api/portal/projects/[id].ts` | `site/functions/api/portal/projects/[id].ts` |
| `/api/portal/plan-items/<id>` | `api/portal/plan-items/[id].ts` | `site/functions/api/portal/plan-items/[id].ts` |

The route files re-export the handler that already implements the route (`api/portal/auth.ts`, `api/portal/projects.ts`, `api/portal/plan-items.ts`): one implementation, one behaviour, two trees. The by-id handlers accept the id from the path **or** from the route parameter (`req.query.id`), so they do not depend on which convention the host uses.

Why this was invisible: the local dev server (`site/scripts/dev-portal.js`) matches handlers by **prefix**, so `/api/portal/auth/request-link` reached the handler locally while the deployed target answered `404`. Three QA waves ran against that server.

The rule is now a **machine check**: `site/scripts/check-api-routes.mjs` (`npm run check:routes`) reads every `/api` path the client calls and every `/api` path the server names, and fails when a path has no function file in either tree. It runs in CI, and it is proven non-vacuous (removing one route file makes it fail and names the source file).

**4.8.2 The Vercel project root is the REPO ROOT.**

The `api/` tree lives at the repo root, outside `site/`. A Vercel project rooted at `site/` deploys **no functions at all**. The configuration now says so in the repo:

- `vercel.json` (repo root): `"framework": null`, `"installCommand": "cd site && npm ci"`, `"buildCommand": "cd site && npm run build"`, `"outputDirectory": "site/dist"`;
- a root `package.json` (+ lockfile) so the repo root is a valid project;
- the CI deploy job runs from the repo root;
- **the dashboard setting "Root Directory = the repository root" is required** and is owned by DevOps (it is a project setting, not a file).

**4.8.3 The file-backed limiter is safe under concurrency (D-2).**

The `file` backend is a read-modify-write, so two processes on one host lost each other's hits (QA measured 75 of 200 buckets lost, 4 rounds out of 4). The counter file is now guarded by an **exclusive lock file** (`open(..., 'wx')` is atomic on POSIX and Windows): one writer at a time, a lock left behind by a killed process is broken after 30s, and a lock that cannot be taken degrades to the in-memory counter — the limiter still never fails a request. Keys stay hashed before they reach the file.

**4.8.4 The Cloudflare moderation store fails closed (D-1).**

The edge twin had the last lenient JSONL reader in the repo: a malformed line was skipped, so the whole log read as "no such review" and the owner was told their pending quote was gone. Now:

- a store that cannot be **parsed** → `500 { code: 'storage' }` (the same answer the Vercel tree gives);
- a store that cannot be **reached** (the edge has no filesystem) → `501 { code: 'unimplemented' }`, never `404 review not found`;
- a write that fails → `500 { code: 'storage' }` — a decision that was not stored is never answered with "approved".

**4.8.5 What is still NOT deployable — stated, not implied.**

The portal store is a **file** (`site/data/portal/*.jsonl`, `site/data/moderation/reviews.jsonl`). A Vercel serverless function has a **read-only filesystem** (only `/tmp` is writable), so the portal cannot run on Vercel until the storage migration (T4, Turso/libSQL) lands and the `PortalStore` adapter replaces the file backend. F-1 was the route table; T4 is the store. Both are needed, in that order, and **the storage decision is still the one thing only the owner can make.**

### 4.9 The session is a signed token, one module for both trees — Backend, 2026-10-21

Added after the Code Reviewer's wave-4 audit (F-1/F-2) and QA's wave-4 re-run (D-3). §4.8 fixed the route table; **this fixes what the route table exposed**: one function per file means one module per function, so a session held in a module-scope `Map` was invisible to the next function. The reviewer proved it by bundling the real handlers separately — `request-link` 200, `verify` 400, and every authenticated call 401. **No client could sign in.**

**4.9.1 The session is a signed, stateless token.**

`site/shared/server/portal-session.ts` is the ONE session module, imported by both trees (`api/portal/session.ts` and `site/functions/api/portal/session.ts` are thin re-exports). It has **no `node:` imports**, so it loads in a Worker isolate and in a Vercel function unchanged.

| | Before | Now |
|---|---|---|
| Where the session lives | a module-scope `Map` (`api/portal/session.ts`) and a `globalThis` `Map` (the edge twin) | the cookie carries the session; the signature is the proof |
| Across functions | refused with `401` (the reviewer reproduced it) | accepted — the same token, any bundle, any instance, any cold start |
| Across targets | two copies of the logic | one module: a session minted on one target is accepted by the other |
| Missing signing secret | a per-process random fallback | **fail closed**: no session is minted, `500 { code: 'internal' }` |

The token is `v1.<base64url(payload)>.<hmac-sha256-hex>`, the payload carries the email, the role, the clientId and the expiry, and the signature is `HMAC-SHA256(secret, "v1." + payload)`.

**4.9.2 The secret is required, and it is named.**

`PORTAL_SESSION_SECRET` wins; `PORTAL_MAGIC_LINK_SECRET` is the fallback so a deployment can be configured with one secret. **In production a missing secret is a misconfiguration, not a per-process fallback** — a per-process secret is precisely the defect this section removes (a session only one instance can read). The sign-in door refuses to mint a session, and the verify route refuses **before** it consumes the magic token, so a misconfigured deployment does not burn the client's only link.

**4.9.3 Why the MAC is implemented in the module instead of with `crypto.subtle`.**

WebCrypto's only message-authentication primitive is `crypto.subtle.sign`, and it is **asynchronous**. The session API is synchronous by contract (`const session = resolveSession(req)` in seven Vercel handlers, seven Cloudflare handlers and a QA suite), and a synchronous signature check is what keeps the cookie validation inside a plain `if (!session)` guard — an async API would need an `await` at every call site, and a missed `await` turns that guard into a truthy `Promise`: a silent authentication bypass rather than a compile error. So the HMAC-SHA256 is implemented in plain TypeScript in the module. It is **not** trusted on the strength of that sentence: `backend-wave6-harness.mjs` compares it with `node:crypto`'s `createHmac` over hundreds of random inputs and every padding/length boundary, byte for byte.

**4.9.4 What the stateless session still costs — stated, not assumed.**

- Logout cannot revoke a token server-side: the cookie is cleared and the token expires on its own (24h). The revocation list is a best-effort, per-instance extra. Durable revocation belongs to the shared store (T4).
- The TTL is fixed at issue instead of sliding on activity.
- The payload is signed, **not** encrypted: it holds the session's own email, which the holder of the cookie already knows.

**4.9.5 The moderation endpoint never lies (F-3) and the counter never lies either (F-4).**

- `api/moderate/review.ts`: a store that cannot be **reached** (the file is not there) → `501 { code: 'unimplemented' }` — never `404 review not found`; a store that cannot be **parsed** → `500 { code: 'storage' }`; a **write that fails** → `500 { code: 'storage' }`, never "approved". The write was unguarded and threw out of the handler.
- `api/lib/rate-limit.ts`: the file lock classified only `EEXIST` as "busy", so a Windows delete-pending lock (`EPERM`) was mistaken for a broken backend, the limiter latched `backendFailed` for the life of the process and the durable counter was silently abandoned. `EEXIST`, `EPERM`, `EACCES` and `EBUSY` are now busy-and-retry, and the degradation is logged **once** with the underlying error code. The edge twin got the same once-only log.

---

## 5. Security

| Area | Control |
|------|---------|
| Secrets | `PORTAL_MAGIC_LINK_SECRET`, session signing secret, Resend keys, Turnstile secret, `FORM_WEBHOOK_SECRET` are server-side env vars only. Client bundle: `TURNSTILE_SITE_KEY` + analytics ID only (P-3). |
| Session | HttpOnly, SameSite=Strict, Secure cookie; server validates on every portal request; 24h TTL refreshed on activity; admin email allow-listed via `ADMIN_EMAILS`. |
| Authorization | Every `/api/portal/*` request resolves the user from the session; project ownership checked server-side; cross-client access → 403. No IDOR: client-supplied `clientId`/`projectId` are ignored. |
| Rate limiting | Per-client (5 submits / 10 snooze-declines per hour) and per-IP (5 sign-in links per hour). The counters live in a **pluggable backend** (§4.7.1): in-memory per instance by default, file-backed or KV-backed when a durable store is available. A backend failure degrades to the in-memory counter and never fails a request. |
| Magic-link tokens | HMAC-SHA256 with `PORTAL_MAGIC_LINK_SECRET` (server-only); single-use; 15-min TTL; consumed on verify. |
| CSRF | SameSite=Strict cookies + `Origin`/`Referer` check on state-changing POST/PATCH endpoints under `/api/portal/*`; expected origin derived from `SITE_BASE_URL` (defaults to `http://localhost:4321`). |
| Output escaping | All user-generated content (comments, update bodies, plan item titles) escaped on render (`escapeHtml` pattern from `api/contact.ts`). |
| PII in data files | Emails and names stored in JSONL under `site/data/portal/` (server-only, not in `dist/`). Logs are redacted (no raw IP/email, no bodies) per interface-spec §3.10 pattern. |
| Unknown-email login | Same generic response whether or not email is invited — no enumeration (P-7). |
| Headers | `/portal`, `/login`, `/admin` get `noindex, nofollow` via `vercel.json` (consistent with existing header approach). CSP `form-action 'self'` already covers POSTs to `/api/*` same-origin. |
| No secrets in bundle | CI secrets scan over `dist/` (P-3). |
| Testimonial provenance | `verifiedClient` and `source` are derived from the session, never from the request body. Name/company/role come from the client record. A client cannot mark their own quote as verified, nor claim it came from another door. |
| Testimonial ownership | The project must belong to the session's client; a foreign or unknown project returns `404` (not `403`), so the endpoint cannot be used to probe which project ids exist. |
| Testimonial CSRF | Same `Origin` check as the other portal writes — expected origin derived from `SITE_BASE_URL`; wrong or missing origin → `403`. |
| Testimonial rate limit | 5 submissions per client per hour (in-memory fallback, same pattern as §2.4). |
| Public review door | `POST /api/contact` answers `410 review-moved` for `type=review` — in any case/whitespace variant (trimmed + lower-cased before the compare), before Turnstile, before the rate limit, before any write. The only public write path left is the contact inquiry. |

---

## 6. Phasing inside the MVP

### v1 (this spec — build now)

| Item | Included? | Rationale |
|------|-----------|-----------|
| Magic-link login (`/login`, `/login/verify`) | ✅ | Required for per-client data isolation |
| Invited-client allow-list (`invited.jsonl` + `ADMIN_EMAILS`) | ✅ | No open registration; owner controls access; invites via pre-populated file AND owner invite form in portal UI (v1) |
| Session cookie (`imk_session` / `imk_admin_session`) | ✅ | Server-side auth, no passwords |
| Project status board (`/portal`) | ✅ | Owner updates state; client sees own project |
| Plan items (todo/in-progress/done/blocked) | ✅ | Core "state of the project" the user asked for |
| Owner: update project status, plan item status, post updates | ✅ | Owner-side write capabilities |
| Client: comment, approve plan item, request change | ✅ | Client-side "make updates on the plan" |
| Rate limiting on magic-link requests | ✅ | Abuse protection at launch scale |
| Dev-mode token logging when Resend absent | ✅ | Flow testable without email keys |
| `/login` + `/portal` noindex + sitemap exclusion | ✅ | Privacy for authenticated area |
| Testimonial prompt in the portal (client: quote, optional rating, optional display name, three default-off consents) | ✅ | RP-3 — the **only** door for testimonials |
| Owner: re-request a testimonial (`testimonialStatus: 'requested'`) | ✅ | RP-3.4 / RP-3.5 — a snoozed or declined request is re-opened explicitly, never silently |
| Publish-time consent enforcement in the build | ✅ | RP-6 — a revoked or withdrawn quote never reaches the site |
| Public review form + `type=review` intake on `/api/contact` | ❌ removed | Closed 2026-10-20 — the public door is gone from the UI *and* the endpoint (410) |
| Telegram/email notifications from portal events | ❌ v2 | Reuse `api/lib/notifications.ts` as v2 (spec/07 §7) |
| File uploads | ❌ deferred | Not needed for status board |
| Invoicing / payments | ❌ deferred | Out of scope |
| Multi-project dashboard for clients | ❌ deferred | MVP: one project per client |
| Real-time notifications | ❌ deferred | Visible on next login is enough |

### v2 (post-MVP)

- Telegram/email notifications on portal events (new comment, status change, approval) via `api/lib/notifications.ts` (already spec'd in spec/07 §7).
- File uploads (client shares briefs/files).
- Client email digests on progress changes.
- Graduate JSONL → SQLite (Turso) or PostgreSQL (Neon).
- Multi-project client dashboard.

---

## 7. Task breakdown

### Backend (T9 portal subset)

| Task | File(s) | Acceptance criteria |
|------|---------|---------------------|
| T9a Magic-link request endpoint | `api/portal/auth.ts` (`request-link`) | POST email → generic success; token generated + emailed via Resend (or logged in dev mode); magic-link base URL from `SITE_BASE_URL` (default `http://localhost:4321`); rate-limited 5/hr/IP; unknown email not enumerated |
| T9b Magic-link verify + session | `api/portal/auth.ts` (`verify`, `logout`) | GET verify validates HMAC + TTL + single-use → sets `imk_session`/`imk_admin_session` (`Secure` only when base URL is HTTPS) → redirects `/portal`; logout clears cookie |
| T9c Session validation middleware | `api/portal/session.ts` (shared) | Every `/api/portal/*` call resolves user from cookie; missing/invalid → 401; role resolved server-side |
| T9d Client/project JSONL stores | `site/data/portal/clients.jsonl`, `projects.jsonl` | Created on first write; append-only; read at request time |
| T9e Project CRUD + status update | `api/portal/projects.ts` | 200 on valid; 403 cross-client; owner-only status change |
| T9f Plan items API | `api/portal/plan-items.ts` | Create/read/patch status; approve → `approvedBy`; request-change → revert; 403 cross-client |
| T9g Updates + comments API | `api/portal/updates.ts`, `api/portal/comments.ts` | Create changelog entries and comments; `createdBy`/`authorRole` from session |
| T9h Invited-client allow-list | `site/data/portal/invited.jsonl` + lookup in `request-link` | Only invited emails + `ADMIN_EMAILS` receive magic links |
| T9j Invite-client endpoint | `api/portal/invites.ts` | POST (admin only) appends invited email to `site/data/portal/invited.jsonl`; idempotent for existing email; 403 for non-admin |
| T9i Env vars | `site/.env.example` | Adds `PORTAL_MAGIC_LINK_SECRET`, `ADMIN_EMAILS`, `SITE_BASE_URL` placeholders |
| T9k Testimonial endpoint | `api/portal/testimonials.ts` + `site/functions/api/portal/testimonials.ts` | `GET` returns the client's own record (404 for a foreign/unknown project); `POST` accepts `action: submit\|snooze\|decline`; `verifiedClient`/`source`/name are server-derived; `consent.p1` required; `404` cross-client, `409` not-eligible / prior decline, `429` over 5/hr, `403` bad origin or owner submit; writes to `site/data/moderation/reviews.jsonl` with a stable `ref`; the client record's name/company/role are capped at the published schema's limits (80/120/120) so no client record can produce a file that fails schema validation |
| T9l Owner re-request | `api/portal/projects.ts` | `PATCH /api/portal/projects/:id` accepts `testimonialStatus` ∈ `requested\|snoozed\|declined\|null` (null = clear → "never asked"); `400` on any other value, with `fields:['testimonialStatus']` and no change written; admin only; sets the ask, never the stored quote |
| T9m Close the public review door | `api/contact.ts` + `site/functions/api/contact.ts` | `type=review` → `410 review-moved` — matched after `trim().toLowerCase()`, so `Review` / `REVIEW` / `' review'` are refused too; answered before Turnstile, before the rate limit and before any write; nothing stored, nothing mailed |
| T9n Error-response framing | `api/contact.ts` | Every error response declares the byte length it actually sends — no hand-written `Content-Length`. A mismatch truncates the body and makes `fetch()` clients die with `TypeError: terminated`. |
| T9o Client profile | `api/portal/invites.ts`, `api/portal/auth.ts` | The invite endpoint accepts `name` / `company` / `role` and **upserts** them onto the invite record and the client record; caps 80/120/120 with a `400` (not a truncation) when exceeded; the client record created on first sign-in inherits the invite's profile instead of falling back to the email local-part; the invite's `clientId` is written before the client record, and a missing client record is re-created on the next sign-in. See §4.5. |

### Frontend (T8 portal subset)

| Task | File(s) | Acceptance criteria |
|------|---------|---------------------|
| T8a Login page | `site/src/pages/login.astro` | Email form; generic submit message; no password fields |
| T8b Verify page | `site/src/pages/login/verify.astro` (or server route) | Token validation UI; redirect to `/portal` on success; error on invalid/expired |
| T8c Portal shell + role-switched view | `site/src/pages/portal.astro` | Renders ONLY with valid session cookie; client view: status board, plan items, updates, comments; Owner view: same + status controls, update composer + invite-client form |
| T8d Plan item status controls | `site/src/components/PortalPlanItem.astro` | Approve / request-change buttons for client; status dropdown for owner |
| T8e Comment + update composer | `site/src/components/PortalComments.astro`, `PortalUpdateComposer.astro` | Client can comment; owner can post updates |
| T8f Guest login link | `site/src/components/Header.astro` | "Log in" link shown to guests only; no portal nav items or project data visible without a valid session cookie; does not reveal admin capability |
| T8g Noindex headers | `vercel.json` | Add `/portal/*`, `/login/*`, `/admin/*` noindex + sitemap exclusion |
| T8h Invite-client form | `site/src/components/PortalInviteForm.astro` | Owner-only form to invite a client by email; POSTs to `/api/portal/invites`; appends to `invited.jsonl` |
| T8i Conditional portal visibility | `site/src/components/Header.astro`, `site/src/pages/portal.astro` | Guest = login link only; logged-in = portal nav + project data; no portal affordances rendered in guest mode |
| T8j Testimonial prompt card | `site/src/components/PortalTestimonialPrompt.astro`, `site/src/data/testimonial-consent.ts` | Card renders only when the server says the project is eligible; quote required (1..1000), rating optional (1..5), display name optional; three consent boxes **default off**; "Maybe later" / "No thanks" post `action: 'snooze'` / `action: 'decline'`; hides itself on `404` (feature not deployed). Consent wording lives in one file so it can be revised without a code change (RP-7.1). |
| T8k Testimonials collection + home section | `site/src/content.config.ts`, `site/src/components/Testimonials.astro`, `site/src/pages/index.astro` | A `testimonials` content collection exists and is wired to the home page; the empty state renders only when there are genuinely zero published quotes; the "✓ Verified client" badge is rendered from the server-derived flag (RP-8.1–8.5) |
| T8l Client profile in the invite form | `site/src/components/PortalInviteForm.astro`, `site/src/pages/portal.astro` | The owner can type the client's **company** and **role** next to the existing name field, and both are sent in the `POST /api/portal/invites` body. The fields are optional and `maxlength="120"` (the server's cap). The endpoint is an upsert, so re-submitting an existing email updates that client's profile — the form must therefore send `company` / `role` on **every** submit, including an empty string (empty = clear the field, omitted = leave unchanged). See §4.5. |

### DevOps (T10 portal subset)

| Task | File(s) | Acceptance criteria |
|------|---------|---------------------|
| T10a vercel.json headers | `vercel.json` | `/portal/*`, `/login/*`, `/admin/*` get `noindex, nofollow`; CSP unchanged; `form-action 'self'` intact |
| T10b CI gates | `.github/workflows/ci.yml` | Secrets scan covers `dist/`; new `api/portal/*` files parse; build passes |

---

## 8. Assumptions (marked explicitly)

| # | Assumption | Basis |
|---|-----------|-------|
| A-1 | **RETRACTED 2026-10-20.** ~~`api/contact.ts` already handles `type=review` with Turnstile/honeypot/time-trap/rate-limit/Resend (Phase 1, verified).~~ The public review door is closed: `type=review` is refused with `410 review-moved` (in any case/whitespace variant — trimmed + lower-cased before the compare, closed 2026-10-21), before Turnstile, before the rate limit and before any write. Testimonials are collected only through `POST /api/portal/testimonials` (§4.4). | `api/contact.ts` §2b; `site/functions/api/contact.ts` line 126-129 |
| A-2 | `api/lib/notifications.ts` exports `notifyReviewSubmitted`, `notifyReviewDecided`, `moderationUrl`, `verifyModerationSignature` (verified). | `api/lib/notifications.ts` lines 1-158 |
| A-3 | `api/moderate/review.ts` (Vercel) + `site/functions/api/moderate/review.ts` (Cloudflare) exist and verify HMAC signatures (verified). | `api/moderate/review.ts` lines 1-167 |
| A-4 | **RETRACTED 2026-10-20.** ~~`site/data/moderation/reviews.jsonl` is created on first review by `api/contact.ts`; `site/data/` does not exist yet (glob confirmed).~~ The store now exists and is written by the **portal** endpoint, not by `api/contact.ts`: `site/data/moderation/reviews.jsonl` is created on the first portal testimonial. | `api/portal/testimonials.ts` `REVIEWS_FILE`; `site/scripts/publish-testimonials.mjs` |
| A-5 | No database exists today; MVP uses JSONL + in-memory sessions. | T6 §2 "What does NOT exist today"; spec §14 |
| A-6 | Static output preserved; portal/moderation endpoints are serverless under `api/`, not Astro SSR pages. | `site/astro.config.mjs` `output: 'static'`; invariant P-1/P-2 (per spec/07; file not re-read in this session) |
| A-7 | No `.env` exists; real values (`PORTAL_MAGIC_LINK_SECRET`, `ADMIN_EMAILS`, Resend keys) must be provided by the user before end-to-end testing. | Phase 1 Manager report; `site/.env.example` has placeholders only |
| A-8 | `ADMIN_EMAILS` env var is not yet in `site/.env.example` (not verified against file). | Proposed addition; not yet added |
| A-9 | `site/astro.config.mjs` contains `output: 'static'` and `trailingSlash: 'never'` (per spec/07 §11 files read; not re-read in this session). | spec/07 §11 files read list |
| A-10 | `site/src/components/Header.astro` exists and is the nav component to edit (Frontend already edited it for the `/automations` link; not re-read in this session). | Frontend Developer report on nav edit |
| A-11 | `SITE_BASE_URL` defaults to `http://localhost:4321` (Astro dev default port); `Secure` cookie flag is conditional on HTTPS. | `site/astro.config.mjs` line 6 uses `SITE_URL` default `https://www.ixi.example`; Astro dev default port 4321 |
| A-12 | The testimonial endpoint is **session-dependent**, so it inherits the session limitation in §2.2 (in-memory sessions, expire on redeploy, per-isolate on Cloudflare). Moving sessions into the store is part of the storage proposal, not of this feature. | §2.2; [`spec/proposal-portal-storage.md`](proposal-portal-storage.md) §7 |
| A-13 | The Cloudflare mirror of the testimonial endpoint answers `501 unimplemented` (no writable filesystem on that target) and the card hides itself on `404`. The portal store migration is a launch blocker for the portal as a whole — it is **not** a testimonial blocker. | `site/functions/api/portal/testimonials.ts`; `site/src/components/PortalTestimonialPrompt.astro` |
| A-14 | `clients.jsonl` has **no `company` or `role` field yet**. The endpoint reads both when present, so a published quote shows the name only until the client record carries them. | `api/portal/testimonials.ts` `clientCompany` / `clientRole`; research spec §8.6 |
| A-15 | The consent wording in `site/src/data/testimonial-consent.ts` is a **draft** pending owner approval (RP-7.3 / research Q3). It is in one file so it can be revised without touching components. | RP-7.1, RP-7.3 |
| A-16 | The public review door is closed **permanently**. A non-client quote (partner, referral) is collected as a personal link, not by re-opening a public form. | Owner decision, 2026-10-20 (room decision on option A) |
| A-17 | The `testimonials` content collection is the **schema of record** for the published frontmatter, and its limits are the contract the endpoint must respect: `name` ≤ 80, `company` ≤ 120, `role` ≤ 120, `quote` ≤ 2000 (the endpoint caps the quote at 1000). Raising a limit in the schema means raising it in the handler in the same change. | `site/src/content.config.ts`; `api/portal/testimonials.ts` |
| A-18 | There are **no published testimonials yet** — the moderation store is empty and the home page shows the empty state. The store must not contain pipeline test records: a test record with an over-long name was enough to break the whole build. | `site/data/moderation/reviews.jsonl` (empty); build verified green on 2026-10-20 |
| A-19 | **The shared store lives in `site/shared/portal-store/`, not in a repo-root `shared/`.** Cloudflare Pages requires the `functions/` directory at the *project root*; the functions tree is `site/functions/`, so the Pages build context is `site/` and a repo-root `shared/` is never uploaded there. Corrected import paths: Vercel `api/portal/x.ts` → `../../site/shared/portal-store/index.js`; Cloudflare `site/functions/api/x.ts` → `../../shared/portal-store/edge.js`; `site/functions/api/portal/x.ts` → `../../../shared/portal-store/edge.js`. (The proposal's §2.1 examples are mutually inconsistent — its Vercel path assumes a repo-root `shared/`, its Cloudflare path assumes a site-root `shared/`; only one of the two can be right.) | `site/shared/portal-store/`; proposal §2.1; Pages `functions/` root rule |
| A-20 | **The `PortalStore` interface has one method more than proposal §2.2: `remove(coll, key)`.** Session destroy and token revocation have no expression in §2.2 (`update` cannot express "delete this session"), and T7 moves sessions into the store. `remove` is refused on the `reviews` collection — the revision log is append-only. | `site/shared/portal-store/types.ts`; proposal §2.2 |
| A-21 | **The file adapter raises on a corrupt store instead of returning `[]`.** Today's `readJsonl` swallows a parse error and returns an empty collection, which is how the Cloudflare tree ends up serving an empty portal as if it were real data. A *missing* file is still an empty collection (not an error); only an unreadable or corrupt one raises, and the handler maps it to `503 storage-unavailable`. | `site/shared/portal-store/file-adapter.ts`; proposal T9; A-13 |

---

## 9. Open questions for the user (NEEDS INPUT)

| # | Question | Why it matters | Assumption if unanswered |
|---|----------|----------------|--------------------------|
| Q1 | Domain: `ixi.agency` / `ixiagency.com` or something else? | Drives `SITE_URL`, cookie domain, CSP, magic-link base URL. | **ANSWERED:** localhost for now; `SITE_BASE_URL` defaults to `http://localhost:4321`, one env-var swap to a real domain at deploy time |
| Q2 | How many clients/projects at launch? | Confirms JSONL/in-memory is sufficient vs. needing a DB sooner. | One project per client; handful of clients |
| Q3 | Should the owner be able to invite clients via the portal UI, or are invited emails pre-populated in `invited.jsonl` by the admin? | Affects whether an "invite client" screen is v1 or v2. | **ANSWERED:** both — owner invite form in portal UI (v1) AND pre-populated `invited.jsonl` fallback |
| Q4 | Database preference for post-launch: PostgreSQL (Neon), SQLite (Turso), or stay file-based longer? | Drives Phase 3.2 migration path. | **PROPOSED:** one Turso (libSQL) database behind a shared `PortalStore` interface, selected by env (`PORTAL_STORE=file\|libsql`) — see [`spec/proposal-portal-storage.md`](proposal-portal-storage.md). Turso vs Neon is still open (that doc §7 Q2). |
| Q5 | Approve the exact consent wording? | Consent text is the thing being relied on; it should be the owner's words. The draft lives in `site/src/data/testimonial-consent.ts` and must name the website, that the quote may be edited for length/grammar, that consent can be withdrawn, and how to withdraw. | Ship with the draft wording, marked as draft, and revise on instruction (RP-7.3). |
| Q6 | Should client records carry a company and role? | A published testimonial shows the name only until `clients.jsonl` has `company` / `role`. The endpoint already reads both when present. | Treat as optional — a quote can be published with the name alone. |

---

## 10. Files read for verification (no changes made)

> **Revision 2 note (Backend, 2026-10-20):** the list below is the *original* verification set for T7b. Revision 2 additionally read and changed the following. The original list is kept as written, except where a line is explicitly marked as retracted above (A-1, A-4).

- `spec/06-reviews-portal-requirements.md` — requirements baseline (T6); invariants R-1–R-6; portal user stories P1-1–P1-7; state models.
- `spec/07-reviews-portal-design.md` — auth approach (magic-link + session), roles, data model (§2.2), notification module (§7.2), admin inbox `/admin` (§7.3), phased plan (§10), assumptions A-8–A-10.
- `api/contact.ts` — Vercel contact API; `type=review` intake; JSONL append (`appendReviewRecord`); rate-limit pattern; Resend email pattern; redacted logging; `escapeHtml`; `refId`; `sha256`.
- `api/lib/notifications.ts` — `notifyReviewSubmitted`, `notifyReviewDecided`, `moderationUrl`, `verifyModerationSignature`, `sendResendEmail`, HMAC signing; graceful degradation when keys absent.
- `api/moderate/review.ts` — HMAC-signed approve/reject; 7-day TTL; idempotent; 400/404 never 500; JSONL state flip.
- `site/functions/api/moderate/review.ts` — Cloudflare mirror of moderation endpoint (exists; kept intact).
- `site/.env.example` — env placeholder inventory; `FORM_WEBHOOK_SECRET`, `RESEND_*`, `TURNSTILE_*`, `SITE_URL`, `ADMIN_EMAILS` not present.
- `vercel.json` — CSP/headers; `form-action 'self'`; no `/portal`/`/login`/`/admin` noindex rules yet.
- `site/astro.config.mjs` — `site:` from `SITE_URL` default `https://www.ixi.example`; `output: 'static'`; `trailingSlash: 'never'` (lines 5–9); Astro dev default port 4321 (used for `SITE_BASE_URL` default).
- `site/package.json` — `dev: "astro dev"` script confirms local dev on port 4321; `prebuild` runs `scripts/publish-testimonials.mjs`.
- `site/src/pages/*.astro` — existing page conventions (`about.astro`, `process.astro`, `automations.astro`, `book.astro`, `index.astro`); page structure to mirror for `/login` and `/portal`.

**No files were changed.** This document (`spec/08-portal-mvp.md`) is the only deliverable.

### 10.1 Revision 2 — files read and changed (Backend, 2026-10-20)

**Read (to document the endpoint, not to change it):**

- `api/portal/testimonials.ts` — the Vercel testimonial handler (GET/POST), server-derived provenance, consent, rate limit, decline-is-final rule.
- `site/functions/api/portal/testimonials.ts` — the Cloudflare mirror.
- `api/portal/projects.ts` — the `testimonialStatus` PATCH and `TESTIMONIAL_STATUSES`.
- `api/portal/session.ts` — `resolveSession` / `expectedOrigin`.
- `site/src/components/PortalTestimonialPrompt.astro`, `site/src/data/testimonial-consent.ts` — the card and the consent wording.
- `site/scripts/publish-testimonials.mjs` — publish-time consent enforcement.
- `spec/research-client-profiles-testimonials.md` — the requirements baseline (RP-3, RP-6, RP-7, RP-8) and its §8.6 data-model / §8.7 endpoint summary.
- `spec/proposal-portal-storage.md` — the storage proposal this feature inherits its blocker from.

**Changed:**

- `api/contact.ts` — error-response framing: every plain-text error response now declares the byte length it actually sends. `Content-Length` is no longer hand-written. See T9n and A-1 (the public review door is closed here).
- `api/portal/testimonials.ts` + `site/functions/api/portal/testimonials.ts` — the client record's `name` / `company` / `role` are capped at the published schema's limits, so an over-long client record can no longer produce a file that fails schema validation and breaks the whole build (§4.4, A-17).
- `site/data/moderation/reviews.jsonl` — emptied. It held eight pipeline test records (`rev_test*`) left over from earlier verification, not client quotes; one of them (an 88-character name) was failing schema validation and made `npm run build` exit 1. The published files they generated (`site/src/content/testimonials/rev_test*.md`) were removed with them, so the home page shows the honest empty state instead of a fake "Alice Longname / Acme Ltd" testimonial containing an XSS probe string. A copy of the removed records is kept outside the repo for reference.
- `spec/08-portal-mvp.md` - this document (§3.1, §3.2, §4.1, §4.3, §4.4, §5, §6, §7, §8, §9, §10, §12).

**Verification run (Backend, 2026-10-20):** 85 assertions against the real handlers in an isolated sandbox (real handlers, sandbox data stores, sandbox `astro build`), plus a pre-fix comparison that reproduces the truncation bug (`TypeError: terminated` on the 410), plus `astro check` (0 errors, 0 warnings, 9 hints) and `npm run build` (22 pages, exit 0) on the repo.

---

### 10.3 Revision 4 — client profile, typecheck gate, PII hygiene (Backend, 2026-10-20)

Closes the open item "client records don't have a `company` field" from the owner-facing status, and the queued cleanup "the `api/` tree has no typecheck config".

**Read:**

- `api/portal/invites.ts`, `api/portal/auth.ts` — where a client record is created and what was written into it.
- `api/portal/testimonials.ts` — where `client.company` / `client.role` / `client.name` are read from the client record (§4.4).
- `site/scripts/publish-testimonials.mjs` — the build-time publisher (it consumes `record.company` / `record.role`).
- `site/src/components/PortalInviteForm.astro`, `site/src/pages/portal.astro` — the owner-side invite form (Frontend's files; **not** changed here — handed over as T8l).
- `site/functions/api/portal/auth.ts`, `site/functions/api/portal/invites.ts` — the Cloudflare twins (invite = `501 unimplemented`; auth does not create client records).
- `site/tsconfig.json`, `site/scripts/api-index.ts` — why the `api/` tree was only partly type-checked.

**Changed:**

- `api/portal/invites.ts` — accepts `name` / `company` / `role`; upserts them onto the invite record **and** the client record; caps 80/120/120 with a `400` naming the offending field; control characters stripped; a corrupt store file now yields `500 store unreadable` instead of being silently rewritten as an empty list.
- `api/portal/auth.ts` — the client record created on first sign-in inherits `name` / `company` / `role` from the invite; the invite's `clientId` is written before the client record; a missing client record is re-created on the next sign-in.
- `api/portal/comments.ts`, `api/portal/plan-items.ts`, `api/portal/updates.ts` — **type-only** changes: `checkOwnership` becomes a `const` arrow (TypeScript does not carry the `session` null-narrowing into a hoisted function declaration), and `body.projectId` is coerced to a string. No behaviour change.
- `site/tsconfig.api.json` (new) — a typecheck config for the whole `api/` tree, including `api/contact.ts` and `api/moderate/review.ts`, which no check reached before.
- `site/package.json` — added `"typecheck:api": "tsc -p tsconfig.api.json --noEmit"`.
- `.gitignore` — `site/data/portal/` and `site/data/snapshot/` are ignored. That directory holds client emails, names, companies, invite records and sessions; it was untracked but **not** ignored, so a single `git add .` would have committed live client PII. `site/data/moderation/` stays tracked — the build-time publisher reads it.
- `spec/08-portal-mvp.md` - this document (§3.1, §4.4, §4.5, §7 T9o/T8l, §10.3, §12).

**Verification run (Backend, 2026-10-20):** 55 assertions against the **real** handlers in an isolated sandbox (own data stores, own port, repo `site/data/` untouched) covering invite → sign-in → upsert → validation → clear → end-to-end testimonial submission → spoofed-payload rejection → a second client with no profile. A **pre-fix comparison** (the same harness against the reverted `auth.ts`) shows the defect concretely: the client record was `{"name":"client","company":"","role":""}` — the email local-part and no company — where the fixed code produces `{"name":"Alice Longname","company":"Acme Ltd","role":"CTO"}`. `npm run typecheck:api` → exit 0 (6 type errors closed) · `npm run test:store` → 22/22 · `npm run check` → 0 errors, 0 warnings, 9 hints (baseline unchanged) · `npm run build` → 22 pages, exit 0.

---

### 10.2 Revision 3 — the storage layer, provider-agnostic half (Backend, 2026-10-20)

Implements task **T3** of [`spec/proposal-portal-storage.md`](proposal-portal-storage.md): the `PortalStore` interface and the `file` adapter, with a contract test suite. The backend choice (Turso vs Neon) and the Vercel-vs-Cloudflare question are still open, and **nothing here depends on either** — the interface and the `file` adapter are identical for every provider. The libSQL adapter is T4 and is not started.

**Read (to write the adapter against the current behaviour):**

- `api/portal/projects.ts`, `api/portal/comments.ts`, `api/portal/plan-items.ts`, `api/portal/updates.ts`, `api/portal/invites.ts`, `api/portal/auth.ts`, `api/portal/testimonials.ts`, `api/moderate/review.ts` — the `readJsonl` / `appendJsonl` / `rewriteJsonl` helpers, the collection → file mapping, the "later lines win" rule and the moderation flip.
- `site/functions/api/moderate/review.ts`, `site/functions/api/portal/testimonials.ts` — the Cloudflare twins, to confirm both trees share one semantics.
- `api/portal/session.ts` — the in-memory session map that T7 moves into the store.
- `site/scripts/dev-portal.js`, `site/scripts/api-index.ts` — the local bundler (`process.chdir(REPO_ROOT)`, one esbuild bundle for all handlers).
- `site/scripts/publish-testimonials.mjs` — the publisher that reads the same JSONL at build time; the adapter's output format must stay byte-compatible.

**Changed:**

- `site/shared/portal-store/types.ts` (new) — the `PortalStore` interface, the `Collection` union and the `Where` filter. Adds `remove()` to proposal §2.2 (A-20).
- `site/shared/portal-store/errors.ts` (new) — `StorageError` with a machine-readable `code` (`storage-unavailable`, `storage-corrupt`, `invalid-operation`, `invalid-config`, `not-implemented`), so a handler can map a store failure to `503 { code: 'storage-unavailable' }` without string matching.
- `site/shared/portal-store/file-adapter.ts` (new) — the `file` adapter. Byte-compatible with today's helpers; "later lines win" for the reviews revision log; `decideReview()` flips **only** the newest revision of a `ref`, is idempotent (a second call neither changes the record nor rewrites the file) and ignores non-review records that share the ref. `update()`/`remove()` are refused on `reviews`.
- `site/shared/portal-store/index.ts` (new) — the Node entry point (`getStore(env)`): `PORTAL_STORE=file|libsql`, `PORTAL_DATA_DIR` for the data root. `PORTAL_STORE=libsql` raises `not-implemented` until T4.
- `site/shared/portal-store/edge.ts` (new) — the Cloudflare entry point: it never pulls in `node:fs` (the edge has no writable disk) and refuses `PORTAL_STORE=file` with a clear error.
- `site/shared/portal-store/test/contract.test.ts` (new) — 22 contract tests: ordering, newest-wins, `decideReview` idempotency, error-throwing, byte-compatibility with the legacy format, store selection.
- `site/scripts/test-portal-store.mjs` (new) — bundles the tests with esbuild into the OS temp dir and runs them under `node --test`.
- `site/package.json` — added `"test:store": "node scripts/test-portal-store.mjs"`. No other script, dependency or lockfile change.
- `spec/08-portal-mvp.md` — this document (A-19, A-20, A-21, §10.2).

**Not changed (deliberately):** no handler was ported. Porting the handlers to `PortalStore` is **T7** and it depends on T1 (ratification), T4 (the libSQL adapter) and T5 (the importer). Until then the production behaviour is unchanged: the portal still runs on JSONL files and still cannot persist on Cloudflare.

**Verification run (Backend, 2026-10-20):** `npm run test:store` → **22/22 pass** (each test in its own throw-away temp directory; the repo's `site/data/` is never touched). `npx tsc --strict --module nodenext` over the six new files → **0 errors**. `npm run check` (`astro check`) → 0 errors, 0 warnings, 9 hints (baseline unchanged; the new files are inside the site's tsconfig scope, so they are type-checked from now on). `npm run build` → 22 pages, exit 0. `site/data/moderation/reviews.jsonl` and `site/src/content/testimonials/` are byte-identical to the baseline after the build.

**Revision 4 (2026-10-20, Backend):** the client profile is now **writable and reachable** — §4.5 documents the endpoint, the caps, the upsert semantics and the Cloudflare-parity gap. Two defects were found and closed: the owner-typed `name` was discarded on the client's first sign-in (the record got `email.split('@')[0]`), and `company` / `role` had **no write path at all**, so a published testimonial could never show a company. The `api/` tree also gained a typecheck gate (`npm run typecheck:api` → `site/tsconfig.api.json`), which closed 6 type errors and brought `api/contact.ts` and `api/moderate/review.ts` under the checker for the first time. `site/data/portal/` is now git-ignored so live client PII cannot be swept into the repo by `git add .`.

### 10.4 Revision 5 — the deploy route table, the deploy root, the concurrent counter (Backend, 2026-10-20)

Closes the three defects QA's wave-3 re-run left open: **D-1** (the Cloudflare moderation reader still swallowed a corrupt store), **D-2** (the file-backed counter lost counts with two writers) and **F-1** (the sign-in door and the by-id edits had no function file on the deployed target). **F-2** (the CI invariant check could never pass) is closed too. §4.8 is the contract.

**Read:**

- `api/portal/auth.ts`, `api/portal/projects.ts`, `api/portal/plan-items.ts` — the handlers behind the three routes that had no file (the sign-in door, the project edit, the plan-item edit).
- `site/functions/api/portal/auth.ts`, `site/functions/api/portal/projects.ts`, `site/functions/api/portal/plan-items.ts` — the Cloudflare twins.
- `site/functions/api/moderate/review.ts` — the last lenient JSONL reader in the repo.
- `api/lib/rate-limit.ts` — the file backend (the read-modify-write that lost hits).
- `site/scripts/dev-portal.js` — the local router that matches by PREFIX, which is why F-1 was invisible.
- `vercel.json`, `.github/workflows/ci.yml`, `site/package.json`, `site/tsconfig.api.json` — the deploy and CI configuration.

**Changed:**

- `api/portal/auth/request-link.ts`, `api/portal/auth/verify.ts`, `api/portal/auth/logout.ts` (new) and `api/portal/projects/[id].ts`, `api/portal/plan-items/[id].ts` (new) — the route files. Each re-exports the handler that already implements the route.
- `site/functions/api/portal/auth/{request-link,verify,logout}.ts` (new), `site/functions/api/portal/projects/[id].ts`, `site/functions/api/portal/plan-items/[id].ts` (new) — the same route files for the Cloudflare tree.
- `api/portal/projects.ts`, `api/portal/plan-items.ts` — the by-id handlers accept the id from the path **or** from the route parameter (`req.query.id`).
- `site/functions/api/moderate/review.ts` — the store is read through the shared strict parser (`parseJsonlStrict`): a corrupt store answers `500 { code: 'storage' }`, an unreachable store answers `501 { code: 'unimplemented' }`, and a failed write answers `500` instead of a false "approved".
- `api/lib/rate-limit.ts` — the file backend's read-modify-write runs under an exclusive lock file (atomic `open(..., 'wx')`), a stale lock is broken after 30s, and a lock that cannot be taken degrades to the in-memory counter.
- `site/scripts/check-api-routes.mjs` (new) + `site/package.json` (`"check:routes"`) — the route manifest check: every `/api` path the client calls and every `/api` path the server names must have a function file in **both** trees.
- `vercel.json` — `framework: null`, `installCommand`, `buildCommand`, `outputDirectory`, because the Vercel project root is the **repo root** (the `api/` tree lives outside `site/`).
- `package.json` + `package-lock.json` (new, repo root) — a dependency-free root package so the repo root is a valid project; `npm ci` works at the root.
- `.github/workflows/ci.yml` — the invariant check now uses paths relative to `site/` (`../api/contact.ts`, `functions/api/contact.ts`), the route manifest check and the API typecheck were added as steps, and the deploy job runs from the repo root.
- `site/qa/qa-backend-hardening.mjs` — group N (the route manifest check + the route files export real handlers).
- `site/qa/qa-cf-parity.mjs` — C4 now expects `501 unimplemented` for an unreachable store, and C5 proves the corrupt store answers `500 storage`.
- `spec/08-portal-mvp.md` — this document (§4.8, §10.4).

**Verification run (Backend, 2026-10-20):** `npm run check:routes` → 13 routes, 0 missing, both trees (and it fails, naming the source file, when a route file is removed — proven non-vacuous) · `npm run typecheck:api` → exit 0 (api + functions + shared) · `npm run test:store` → 22/22 · `npm run build` → 22 pages, exit 0 · `npm run check` → 0 errors, 0 warnings, 8 hints (baseline unchanged) · the eight QA suites → 178 checks, of which QA's own B5 (corrupt store → 500 storage on Cloudflare) and C2 (two writers lose no counts) now pass; QA's D2 fails because it asserts the **old** route table is still missing — that check has to be inverted by QA.

### 10.5 Revision 6 — the stateless session, the guarded moderation write, the busy lock (Backend, 2026-10-21)

Closes the three findings the wave-4 audit and re-run left open: **F-2** (the session lived in a module-scope `Map`, so no client could sign in on the deployed target), **F-3** (the moderation write was unguarded and threw out of the handler) and **F-4 / D-3** (the file lock mistook a busy Windows lock for a broken backend and silently abandoned the durable counter). §4.9 is the contract.

**Read:**

- `site/shared/server/portal-session.ts` — the signed session module that had **zero importers** (dead code).
- `api/portal/session.ts`, `site/functions/api/portal/session.ts` — the two session modules (a module-scope `Map` and a `globalThis` `Map`).
- `api/portal/auth.ts`, `site/functions/api/portal/auth.ts` — the sign-in door (mint, verify, logout).
- `api/moderate/review.ts`, `site/functions/api/moderate/review.ts` — the moderation endpoint and its edge twin.
- `api/lib/rate-limit.ts`, `site/functions/api/lib/rate-limit.ts` — the limiter and its edge twin.

**Changed:**

- `site/shared/server/portal-session.ts` — rewritten: edge-safe (no `node:` imports), synchronous, one module for both trees, a signed token instead of a `Map`, and a fail-closed secret (`createSession` returns `null` without one; the callers answer `500 { code: 'internal' }`).
- `api/portal/session.ts`, `site/functions/api/portal/session.ts` — thin re-exports of the shared module.
- `api/portal/auth.ts`, `site/functions/api/portal/auth.ts` — the sign-in door refuses to send a link and refuses to verify when no signing secret is configured (before the magic token is consumed), and refuses to issue a session it cannot sign.
- `site/functions/api/portal/{comments,invites,plan-items,projects,testimonials,updates}.ts` — the edge handlers pass the request's `env` to `resolveSession`, because a Worker has no `process.env`.
- `api/moderate/review.ts` — the store is read through the shared strict parser; an unreachable store answers `501 { code: 'unimplemented' }`, a corrupt store `500 { code: 'storage' }`, and a failed write `500 { code: 'storage' }` — never a false "approved".
- `api/lib/rate-limit.ts` — `EEXIST`, `EPERM`, `EACCES` and `EBUSY` are busy-and-retry; the degradation is logged once with the error code.
- `site/functions/api/lib/rate-limit.ts` — the same once-only degradation log (the same silent latch).
- `site/scripts/api-index.ts` — the comment that described the shared in-memory `sessions` `Map` (no longer true).
- `backend-f1-magic-token-harness.mjs` — check **G1** inverted: the session cookie from the verify function is now **accepted** by another function (`200`, was `401`). The harness exits 0.
- `backend-wave6-harness.mjs` (new) — 23 executed checks for F-2, F-3 and F-4, including two mutation probes (the old `Map` session and the old lock classification) that prove the checks are not vacuous.
- `spec/08-portal-mvp.md` — this document (§4.9, §10.5).

**Verification run (Backend, 2026-10-21):** `backend-wave6-harness.mjs` → 23/23 · `backend-f1-magic-token-harness.mjs` → 22/22 (G1 = 200) · `npm run typecheck:api` → exit 0 · `npm run test:store` → 22/22 · `npm run check:routes` → 13 routes, 0 missing · `npm run build` → 22 pages, exit 0 · `npm run check` → 0 errors, 0 warnings, 9 hints (none in the changed files) · QA's suites on this HEAD: `qa-testimonials` 81/81, `qa-testimonials-build` 14/14, `qa-backend-hardening` 20/20, `qa-rate-limit` 8/8, `qa-wave2-independent` 28/28, `qa-wave3-independent` 20/20, `qa-wave4-independent` 23/23 (E3 and E4 included), `qa-mutation-probe` 4/4 — `qa-cf-parity` C1 fails until QA adds a session secret to its harness env (the fail-closed rule is the reason; the scenario is proven by `backend-wave6-harness.mjs` W3d).

---

## 11. NOT BUILT — the explicit list (Architect, 2026-10-21)

**This section exists so that nothing in this document reads as finished when it is not.**
Every row names the file that proves the item is not built. The wave-8 contracts (the owner role,
the moderation POST, the production secret rule) are in
[`proposal-wave8-contract-2026-10-21.md`](proposal-wave8-contract-2026-10-21.md).

| # | What is NOT built | The file that proves it | Consequence |
|---|---|---|---|
| 1 | **The Cloudflare portal tree is a 501 stub.** Every portal read and write on the CF target answers `501 { "code": "unimplemented" }`. | `site/functions/api/portal/auth.ts:243,412` · `comments.ts:50,90` · `invites.ts:27` · `plan-items.ts:53,89,93` · `projects.ts:57,105,121` · `testimonials.ts:306,361` · `updates.ts:50,86` | CF can serve the sign-in door and the moderation endpoint, but **not** the portal. §4.9's "one module for both trees" is true for the *session*; the portal handlers themselves are still Vercel-only. |
| 2 | **The portal handlers are NOT wired to the `PortalStore`/libSQL adapter.** They still read and write JSONL directly. | `api/portal/*.ts` import `api/lib/jsonl.ts` (which re-exports `site/shared/portal-store/jsonl.ts` — `api/lib/jsonl.ts:13`) | The libSQL adapter is built and proven offline (`site/shared/portal-store/libsql-adapter.ts`), but **nothing calls it**. The portal still cannot persist on Vercel: the filesystem is read-only. |
| 3 | **The function-budget refactor is DESIGNED but NOT implemented.** `api/` holds **20** `.ts` files = 20 Vercel functions, above the Hobby cap of 12. | `api/` (20 files). Three of them have **no default export** — `api/lib/jsonl.ts`, `api/lib/notifications.ts`, `api/lib/rate-limit.ts` — so their URLs are dead functions: a runtime 500 ("Can't detect way to handle request"), not a build failure. | The design is wave-7 §2; the code is not written. **On the Hobby plan this still blocks the deploy.** `api/portal/session.ts` is no longer one of the dead ones — it became a real route in wave 8. |
| 4 | **There is no annotations / open-notes store anywhere in the project.** The owner's second inbox column has no data source. | `api/admin/reviews.ts:227-233` (`openNotes: null`, `notesAvailable: false`); the panel says so at `site/src/pages/admin.astro:193-197` | `/admin` shows the count of open client notes as **unknown (a dash)** — correctly, not as zero. |
| 5 | **The Cloudflare twin of `GET /api/portal/session` does not exist** (the file has no route handler). | `site/functions/api/portal/session.ts` — 23 lines, one `export *` statement | The owner-role endpoint (wave-8 contract A) works on Vercel only. `npm run check:routes` cannot see this: it checks **file existence**, not handler existence. |
| 6 | **The local dev server does not route `GET /api/portal/session`.** | `site/scripts/dev-portal.js:85-101` (the ROUTES table) · `site/scripts/api-index.ts:18-33` (the handler exports) | In local dev the endpoint 404s, so the browser proof of the owner role ran against a local fixture instead of the real endpoint. |
| 7 | **The portal's owner gates are not on the live allow-list** (the two-part gate), and the client-scoped reads are not client-cookie-first. | `api/portal/projects.ts:122,167` · `api/portal/invites.ts:188` · `api/portal/plan-items.ts:248` · `api/portal/comments.ts:82` · `api/portal/updates.ts:82` (and the CF twins) | Two audit findings (M-4, M-5) are **NOT** closed: removing an address from `ADMIN_EMAILS` does not yet revoke the portal's owner powers for up to 24 h, and a live admin cookie still widens a client's read scope. |
| 8 | **The durable rate counter is not on the SQL backend.** | `api/lib/rate-limit.ts` still selects the file backend; the SQL backend exists at `site/shared/portal-store/durable-rate-counter.ts:81-102` | The counter is still per-instance on Vercel and still fails on a read-only filesystem. |
| 9 | **The build-time publisher still reads the file store.** | `site/scripts/publish-testimonials.mjs` (the `prebuild` step) | After the cutover the build must read the database **and fail loudly** if the database is down — a build that silently publishes an empty testimonials page is a silent outage wearing the costume of a successful deploy (wave-7 §3.7). |
| 10 | **The moderation store is still a JSONL file**, not the `moderation_reviews` table. | `api/moderate/review.ts:114-143` | The moderation queue works on a writable filesystem (local dev) and cannot work on Vercel. |
| 11 | **No real Turso database has ever been contacted.** | the mock pipeline server (`site/shared/portal-store/test/mock-pipeline-server.ts`) and the SQLite engine behind it (`site/shared/portal-store/test/sqlite-worker.py`) | The store's proof is execution-grade against a real SQL engine over the real wire protocol — which is not the same as Turso's service. Level-3 acceptance still needs the owner's database. |

---

## 12. Sign-off

- [ ] Product Analyst: requirements basis (T6) is the foundation; this design implements the portal user stories.
- [ ] Architect: data model, auth, routes, security, phasing, task breakdown complete; consistent with serverless/JSONL architecture.
- [ ] Frontend: `/login`, `/portal`, role-switched UI, Header link feasible within static-site constraints.
- [ ] Backend: `/api/portal/auth/*`, `/api/portal/projects/*`, `/api/portal/plan-items/*`, `/api/portal/updates/*`, `/api/portal/comments/*` implementable on Vercel serverless; JSONL stores defined.
- [ ] DevOps: `vercel.json` noindex headers for `/portal`/`/login`/`/admin`; CI gates defined; no new infrastructure beyond Vercel env vars.
- [ ] QA: every authZ rule (403 cross-client), magic-link flow, single-use token, no-enumeration, rate limiting testable.
- [ ] Code Reviewer: threat model covers session isolation, magic-link token security, output escaping, PII in JSONL, no secrets in bundle.

**Status:** Draft (T7b). Next trigger: M3 passes → Backend T9a–T9i + Frontend T8a–T8g implementation begins.

**Revision 3 (2026-10-20, Backend):** the storage layer's provider-agnostic half is **implemented and tested** — the `PortalStore` interface plus the `file` adapter and its contract suite (`site/shared/portal-store/`, 22/22 pass). No handler was ported yet, so the portal still runs on JSONL and still cannot persist on Cloudflare: the libSQL adapter (T4), the importer (T5) and the handler ports (T7/T8) remain open, and they need the provider decision first. Two corrections to the storage proposal are recorded above: the shared module's placement (A-19) and the missing `remove()` in §2.2 (A-20).

**Revision 2 (2026-10-20, Backend):** the testimonial endpoint (T9k/T9l), the closed public review door (T9m) and the error-response framing fix (T9n) are **implemented and verified**; the matching Frontend work (T8j/T8k) is implemented. The portal still has no production store — see [`spec/proposal-portal-storage.md`](proposal-portal-storage.md) — and the consent wording (Q5) is still awaiting owner approval. One build-breaking defect was found and fixed while verifying (a client record with an over-long name produced frontmatter that failed the `testimonials` schema, failing the whole build); see §4.4 and A-17.

**Revision 5 (2026-10-20, Frontend):** **T8l is implemented and verified** — the owner can now type a client's **company** and **role** in the invite form, and both reach `POST /api/portal/invites` (§4.5). Two further defects were found while driving the real page, both of which made the invite form unusable or misleading:

- **The invite form never reached the DOM.** `portal.astro` is built once, so the build-time `role` is always `'client'`; `PortalInviteForm` branched on that role and rendered "Inviting clients is an owner-only action." instead of the form — for the owner too. Fixed the same way `admin-status-card` was fixed (§ page comment): the form is rendered unconditionally and `portal.astro` reveals the container only after the session check says the visitor is the owner. The API still enforces the rule (403 for any non-admin).
- **The "Post update" admin button had no handler at all** — a dead button. It now scrolls to the composer and focuses its title field.

**Form semantics (deliberate, and the one deviation from the T8l row):** `company` and `role` are sent on **every** submit, empty string included (empty = clear), exactly as §4.5 specifies. `name` is sent **only when it is not blank** — omitted means "leave unchanged". The old form sent `name: name || email.split('@')[0]`, which under the upsert semantics would **overwrite** a name the owner had already typed with the email local part (reproduced: `Alice Longname` → `alice.longname`). A brand-new invite is unaffected: the server falls back to the local part itself (`api/portal/invites.ts`, `api/portal/auth.ts`).

**Known limitation (not a defect, but worth stating):** the form does not pre-fill an existing client's profile, because no admin endpoint returns the invite list — so re-inviting a client to add a company sends an empty `company` only if the owner clears it. A `GET /api/portal/invites` for admins (returning `email` / `name` / `company` / `role`) would remove both that hazard and the need to trust the operator.

**Verification run (Frontend, 2026-10-20):** driven in a real browser against the **real** handlers on an isolated harness port (own port, own session map; the repo's `site/data/` backed up and restored — the portal data directory did not exist before the test and does not exist after it). `npm run build` → 22 pages, exit 0, no warnings · `npx astro check` → 0 errors, 0 warnings, 9 hints (baseline unchanged). Live checks: the form renders for the owner with the four fields and caps 80/120/120 from `CLIENT_PROFILE_MAX`; the POST body is `{email, company, role, name}`; a re-send with a blank name leaves the stored name untouched while company/role update; the client record inherits name/company/role on first sign-in and is patched by the owner's later update; an over-long company and an invalid email are both refused with the offending field named; an empty email sends no request; a client session gets 403 on the same endpoint (5/5 server-side guard checks).

**Revision 6 (2026-10-20, Backend) — the audit fix wave (M1–M4, m1).** The independent audit (`audit-reviews-testimonials-2026-10-20.md`, 6 MAJOR / 8 MINOR) and the QA re-verification (`qa-reviews-testimonials-2026-10-20.md`, 8 defects) independently reproduced the same defects. The four launch-blocking ones are closed; the contract changes are:

- **A-4.4.1 — the review record holds no client identity unless it was consented to.** `email` is never written to the record (M2) — the address goes straight to the owner's notification and nowhere else, because the moderation log is a file a `git add .` will commit. `name` / `company` / `role` are written **only** when `consent.p2 === true` (M1); otherwise they are empty strings and the quote publishes anonymously, exactly as RP-6.2 requires. The published identity is still resolved from the record + consent at build time by `site/scripts/publish-testimonials.mjs`. The client's own portal view still shows them their name (it falls back to the client record) — the client sees their own data, the store does not keep it.
- **A-4.4.2 — a corrupt store is an error, never an empty collection (M3).** One malformed JSONL line used to make a whole collection read as empty, which the API reported as "project not found", "0 projects", "not invited" or "review not found" — a silent outage wearing the costume of a normal answer. Both trees now read through one shared parser (`site/shared/portal-store/jsonl.ts`) and answer **`500 {code:'storage'}`**, naming the file and the line in the log. Affected: projects, invites, comments, plan items, updates, auth, testimonials, moderation.
- **A-2.2 — the sign-in token is never written to a production log (M4).** `APP_ENV` follows the `api/contact.ts` convention: **unset means production**. The token is printed only when `APP_ENV` is explicitly non-production (`site/scripts/dev-portal.js` sets `development` for local dev). A production instance without `RESEND_API_KEY` answers **`500 {code:'internal'}`** for every address — the same answer for an invited and an uninvited one, so the endpoint still cannot be used to enumerate clients.
- **A-5.1 — the moderation links use the portal's base URL (m1).** `SITE_BASE_URL` first, exactly like `api/portal/session.ts`; the approve/reject links can no longer point at the placeholder host.
- **Typecheck gate widened.** `site/tsconfig.api.json` now covers `functions/**` and `shared/**` as well as `../api/**`, so the Cloudflare tree and the shared module are checked by `npm run typecheck:api`.

**Still open (not touched here):** M5 (the approve link is not bound to a revision), M6 (the Cloudflare tree has no notification path), and the minor list m2–m8 (the publish path's lossy rewrite, HTML-escaped project titles, the `localhost:4321` origin fallback, the cookie-role shadowing, the rate-limit ordering, `latestRecordForProject` ignoring `clientId`, the missing moderation route in the dev entry point, `esbuild` not being a declared dependency).

**Verification run (Backend, 2026-10-20):** `npm run typecheck:api` → exit 0 (api + functions + shared) · `npm run test:store` → 22/22 · `npm run build` → 22 pages, exit 0 · `npx astro check` → 0 errors, 0 warnings, 8 hints · QA's API harness → **80/80** (G1–G4, G8, G9 inverted from "defect reproduced" to "defect fixed") · QA's build harness → **14/14** (BUILD-3 now looks the anonymous client's name up in the client records, because the record no longer holds it) · new `site/qa/qa-backend-hardening.mjs` → **6/6**. All runs used isolated sandboxes: the repo's `site/data/moderation/reviews.jsonl` is still 0 bytes and `site/data/portal/` still does not exist.

**Revision 7 (2026-10-20, Backend) - the audit fix wave 2 (M5, M6, m2-m8).** The remaining findings from the independent audit and from QA's re-run are closed in **both** handler trees. The contract changes are in **section 4.6** (new section).

- **A-4.6.1 - the approve link is bound to a revision (M5).** The signed message is now `ref|decision|revision|ts` and the URL carries `revision`. A link for an older revision is refused with **`409 stale-revision`** and approves nothing; the owner is mailed a fresh link for the current revision so the moderation can still be finished. Before this, the link approved whatever the newest line for that ref happened to be - the owner could approve a quote they were never shown.
- **A-4.6.2 - the rate limiter is charged only for valid requests (m6).** 5 submits/hour and 10 snoozes-or-declines/hour, per client, in two separate buckets; a malformed request consumes nothing.
- **A-4.6.3 - the newest record for a project is client-scoped (m7).**
- **A-4.6.4 - a production instance must have a base URL (m4).** A missing `SITE_BASE_URL`/`SITE_URL` in production answers `500 {code:'internal'}` instead of a misleading `403 origin required`, and the session cookie is never issued without `Secure`.
- **A-4.6.5 - one session per cookie name (m5).** Both cookies are read, a stale one is skipped, and logout clears both.
- **A-4.6.6 - titles, plan items, updates and comments are stored raw (m3)**; escaping happens once, at output.
- **A-4.6.7 - the publish script refuses a lossy read (m2):** a malformed line fails the build instead of silently dropping an approved quote from the site.
- **A-4.6.8 - the Cloudflare tree notifies the owner (M6):** `site/functions/api/lib/notifications.ts` (edge-safe) plus the CF testimonial endpoint now sends the owner mail with the one-click links.
- **A-4.6.9 - dev/prod parity (m8):** `/api/moderate/review` is exported and routed in the dev server; `esbuild` is a declared devDependency.

**Verification run (Backend, 2026-10-20):** `npm run typecheck:api` -> exit 0 - `npm run test:store` -> 22/22 - `npm run build` -> 22 pages, exit 0 - `npx astro check` -> 0 errors, 0 warnings, 8 hints (baseline) - QA's API harness -> **81/81** (G5/G6/G7/G10 inverted from "defect reproduced" to "defect fixed"; the moderation helper now signs the revision) - QA's build harness -> **14/14** - `site/qa/qa-backend-hardening.mjs` -> **15/15** (9 new checks, group L). Every run used an isolated sandbox: the repo's `site/data/moderation/reviews.jsonl` is still 0 bytes and `site/data/portal/` still does not exist. The dev server on 4321 was restarted so the team exercises the fixed code.

**Revision 8 (2026-10-21, Backend) — the code-review fix wave (B1–B8).** The independent code review of the testimonials/contact/moderation feature found nine findings (B1–B9); B9 is this document, the eight code findings are closed in **both** handler trees:

- **A-4.4.3 - a non-object body is a 400, never a 500 (B1).** `JSON.parse('null')` succeeds, and `null.action` threw an unhandled 500 on Vercel; the Cloudflare tree swallowed the same body into `{} → validation failed: fields:['action']`, which blames the wrong field. Both trees now parse, check "plain object" (`!Array.isArray`, non-null), and answer the same `400 {error:'invalid payload', code:'validation'}` for malformed JSON, `null`, arrays and bare scalars alike (§4.4 status codes).
- **A-4.4.4 - a client session without a `clientId` is refused (B3).** `project.clientId !== session.clientId` evaluates `undefined !== undefined` to `false` against a project that itself has no `clientId` — the one hole left in the cross-tenant gate. Both trees now answer `403 {code:'forbidden'}` for a client session with no `clientId`, on GET and POST, right after session resolution (§4.4 status codes).
- **A-4.4.5 - the testimonial body is capped at ~16 KB (B5).** The handler used to read the body unbounded. Both trees now refuse a body over `MAX_BODY = 16 * 1024` with `413 {code:'payload-too-large'}`, checking the `content-length` header **and** the streamed bytes (a chunked body without the header cannot slip past), and without destroying the body so the 413 is still deliverable.
- **A-4.4.6 - the published name never falls back to the e-mail local part (B6).** With naming consent but no profile name the stored name was the session e-mail's local part (`noname`) — an identity the client never consented to publish. Now `name`/`company`/`role` come from the client record **only**, and a missing name stays blank (the schema allows it); the owner's notification names the sender `Anonymous client` when no consented name exists (§4.4 table).
- **A-4.4.7 - a failed write is a 500, never `ok:true` (B7).** The Cloudflare tree's `appendJsonl` / `rewriteJsonl` / `setProjectTestimonialStatus` returned void, so a failed write still answered `200 {ok:true}` for a quote that was never stored — and notified the owner about it. The functions now return booleans; a failure logs `storage_write_failed` and answers `500 {code:'storage'}`, and the owner is not notified (same rule as `api/moderate/review.ts`).
- **A-4.6.10 - the Cloudflare stale-revision 409 re-mails the owner (B2).** The revision-bound link (A-4.6.1) mails a fresh link on Vercel but the Cloudflare tree only answered `409 stale-revision` — the owner clicked a link that did nothing and had no path to finish the moderation. The CF moderation endpoint now mirrors the Vercel behaviour: when the newest revision is still pending, the 409 is accompanied by a fresh, correctly signed link for the current revision; a snoozed or declined quote mails nothing (§4.6.1).
- **A-8.1 - contact parity: signed webhook, CONTACT_TO, linkedin (B8).** The Vercel contact handler delivers `FORM_WEBHOOK_URL` a **signed** payload (`X-Signature: sha256=<HMAC(body, FORM_WEBHOOK_SECRET)>`, 2 retries at 0/2/8 s) and honours `CONTACT_TO` as a fallback destination; the Cloudflare tree did neither, and neither parsed a form-encoded `linkedin` field. All three behaviours are now on both trees, so the two targets are byte-comparable on the contact path.
- **A-8.2 - the review refusal is case-insensitive (B4).** `type=review` was matched literally, so `Review` / `REVIEW` / `' review'` walked straight past the closed door into the contact queue. Both trees now trim + lower-case the type before the compare; every variant answers `410 review-moved` before Turnstile, before the rate limit, before any write (§4.4, T9m, A-1).

**Verification run (Backend, 2026-10-21):** `npm run typecheck:api` → exit 0 · new `backend-review-fixes-harness.mjs` (repo root; the real, unmodified handler files bundled with the repo's own esbuild and driven in child processes against sandbox stores) → **23/23** — the 400/410/413/403/500 shapes on both trees, the blank-name rule, the revision-bound fresh link with its HMAC verified by the harness, and the signed contact webhook with byte-level HMAC parity · `backend-f1-magic-token-harness.mjs` → 22/22 · `backend-wave6-harness.mjs` → 23/23 · `site/qa/qa-testimonials.mjs` → 81/81 · `site/qa/qa-backend-hardening.mjs` → 20/20 · `site/qa/qa-cf-parity.mjs` → 9/10 (the one failure — invites status expected 501, got 403 — **pre-dates this wave**, reproduced on the unmodified baseline) · `npx astro check` → 0 errors. The workerd runtime was not booted: the Cloudflare handlers were driven in Node with a filesystem shim, which is how every QA suite in this repo exercises them.

**Revision 9 (2026-10-21, Architect) — the spec is reconciled with what was built, and §11 says what is NOT built.** Design only: **no application file was changed** to produce this revision. Three documents:

- **[`proposal-wave8-contract-2026-10-21.md`](proposal-wave8-contract-2026-10-21.md)** (new) — the wave-8 contracts: (A) the owner role comes from the server, `GET /api/portal/session` → `{ ok, role, email, clientId?, expiresAt? }` / 401 / 500-misconfigured; (B) the moderation link — a GET shows a confirmation page and **never** decides, a POST decides; (C) the two-part owner gate (token claim **and** the live `ADMIN_EMAILS` list) applies to the portal too; (D) the client cookie is resolved first, so an admin cookie can never widen a client's read scope; (E) in production a missing, placeholder or <32-character secret fails loudly with `500 { code: 'internal' }` and there is **no** per-process random fallback. It also records which of the five are built and which are not.
- **`spec/proposal-wave7-design-2026-10-21.md` §3** — rewritten to the **as-built** DDL: the typed columns are nullable, there is no `UNIQUE` and there are no `DEFAULT`s (the deviation log is §3.2.1), the `Where` clause is a `CASE` over `json_type()` so SQLite's `true → 1` and `42.0 → '42.0'` match the file adapter's `String()` comparison (§3.2.2), the transport is the libSQL HTTP v2 pipeline over `global fetch` with **zero new dependencies** (§3.1), the store selection per target (§3.5), the offline verification levels as they now exist (§3.6), the importer (§3.7) and the durable rate counter (§3.8).
- **This document — §11 "NOT BUILT"**: eleven items, each naming the file that proves it is not built (the Cloudflare portal tree is a 501 stub; the portal handlers are not on `PortalStore`; the function-budget refactor is designed but not implemented; there is no notes store; the Cloudflare and local-dev twins of the session endpoint are missing; the two-part owner gate and the client-cookie-first rule are **not** in the portal handlers; the rate counter is not on SQL; the publisher still reads the file; the moderation store is still a file; no real Turso database has been contacted).

**Verification run (Architect, 2026-10-21):** the tree was **read**, not trusted from a report — `npm run check:routes` → **16 routes, 0 missing** (and the route check only proves a *file* exists in both trees, which is why §11 rows 5 and 6 are invisible to it) · `api/` → **20** `.ts` files, **3** without a default export (the dead functions) · `git status` → the wave-8 backend work in the tree (`api/portal/session.ts`, `api/moderate/review.ts`, `site/shared/server/{secret,moderation}.ts`, `site/shared/server/portal-session.ts`, `site/shared/server/magic-link.ts`) is present and is what §0 of the wave-8 contract describes. **No runtime was booted**: the Vercel router was never started and **workerd was never booted**, so every statement about Cloudflare is a reading of the code, not an observation.