# IXI — Interface Spec (T2)

**Owner:** Architect (Chief Software Architect)
**Task:** T2 (plan §7) — interface spec consumed by Frontend (T4–T10), Backend (T10), DevOps (T11), Code Reviewer (T13), QA (T14).
**Baseline:** [`plan/00-phase2-plan.md`](../plan/00-phase2-plan.md) v2, §6 "Tech stack & architecture" + §1/D1–D17 + the merged Phase 1 research.
**Basis copy:** [`copy/copy-deck.md`](../copy/copy-deck.md) v1 (T1, complete). Wording/labels declared there; canonical values are defined **here** (T2 is the single source of truth for types and enums — Frontend and Backend import these, never redefine them; CI validates drift, see §11).
**Status:** Draft for M1 review. Documents only — no site build code. Defaults D1–D17 hold.

This spec exists so Frontend, Backend, and DevOps can build without guessing. **Anything not listed here is out of scope for v1 or must be raised as a numbered edit against this file**, not improvised in code.

---

## 0. Plain-language rules that govern this spec

1. **One source of truth.** `src/content.config.ts` (content schemas) and `src/types/contracts.ts` (form/routing/SEO contracts) are owned by T2. Frontend imports types from them. Backend imports types via a relative import. DevOps checks them. If a field is needed that isn't here, the PR that needs it adds it **here first**.
2. **No invention.** Enums, field caps, status codes, and enum strings are the exact values in §2, §3 and §4. Code may not introduce new ones without a spec edit; copying a string from the copy-deck's free text (e.g. "$1,500–$5,000") into a value is a defect.
3. **Documents are not code.** M1 stays documents-only; this file is not imported by anything yet. It becomes code in T4/T10.
4. **Owner inputs still open** (§13). Until answered, v1 builds on defaults; behaviour does not change with answers except the named owner-facing assets (domain, keys).

---

## 1. Invariants (build-time; enforced by DevOps CI in T11)

| ID | Invariant | Why it matters |
|---|---|---|
| I-1 | `output: 'static'` in `astro.config.mjs`. No `@astrojs/cloudflare` adapter in the dependency tree. | A single well-meant commit flips the whole site into SSR and breaks Pages deployment + caching + CSP. |
| I-2 | Pages Function lives at repo-root `functions/api/contact.ts` **outside** `dist/`. Cloudflare Pages mounts `functions/` automatically. | `dist/` is what is served as static assets; `functions/` is what is mounted as HTTP endpoints. Do not ship `functions/` into `dist/`. |
| I-3 | **All `src/pages/*.astro` stay statically prerendered** (Astro default, `prerender` not disabled). Only `functions/api/*` are dynamic endpoints. | Any server endpoint added inside Astro requires an adapter, violating I-1. |
| I-4 | Node runtime is **not** available in `functions/`. Cloudflare Workers (edge) runtime only: no `fs`, `vm`, `process`, Buffer, Node crypto libs, no `require` of Node modules. | Common stack-trace bug source; all crypto via `crypto.subtle`, HTTP via global `fetch`. |
| I-5 | Secrets exist only in the Workers `env` binding (server) and the Cloudflare dashboard (build env). The client bundle contains **only** `TURNSTILE_SITE_KEY` + `ANALYTICS_SITE_ID`. | Automated secrets scan in CI fails the PR otherwise (T11). |
| I-6 | Plain token CSS is the styling mechanism (Designer's tokens are the sole source of truth). No Tailwind or component library in v1 unless the M2 review finds a real gap. | The v2 plan folded this as a non-change; switching later is a retro, not a task. |
| I-7 | All form submission and webhook work goes through `/api/contact`. No client-side email send, no third-party form host. | Privacy-safety and abuse control live in one place. |

CI checks (T11) assert I-1..I-5 by greps; I-6/I-7 by review.

---

## 2. Content schemas (single source: `src/content.config.ts`)

Astro 5 Content Layer API, glob loader. Copy T1 is the wording source; T2 is the *type* source.

```ts
// src/content.config.ts
import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const ctaSchema = z.enum([
  'book-15',
  'audit',
  'quote',
  'discuss',
  'see-pricing',
]);
// Full promise→destination mapping: §5 of this spec.

const faqSchema = z.object({
  q: z.string().min(1).max(240),
  a: z.string().min(1).max(1200),
});

const howStepSchema = z.object({
  title: z.string().min(1).max(80),
  body:  z.string().min(1).max(400),
});

const testimonialSchema = z.object({
  quote: z.string().min(1).max(600),
  name:  z.string().min(1).max(80),
  role:  z.string().min(1).max(120),
}).nullable();

const serviceSchema = z.object({
  order:            z.number().int().min(1).max(4),
  title:            z.string().min(1).max(60),
  tagline:          z.string().min(1).max(140),
  summary:          z.string().min(1).max(260),
  whoFor:           z.string().min(1).max(400),
  problem:          z.string().min(1).max(600),
  deliverables:     z.array(z.string().min(1).max(200)).min(3).max(8),
  howItWorks:       z.array(howStepSchema).min(3).max(5),
  inScope:          z.array(z.string().min(1).max(160)).min(3).max(8),
  outOfScope:       z.array(z.string().min(1).max(160)).min(3).max(8),
  timeline:         z.string().min(1).max(120),
  startingAt:       z.string().regex(/^From \$[\d,]+\.?$/),
  careOption:       z.string().min(1).max(400),
  caseSnapshot:     z.object({
    label:      z.string().min(1).max(120),
    outcome:    z.string().min(1).max(200),
    href:       z.string().startsWith('/work/'),
  }),
  faq:              z.array(faqSchema).min(3).max(4),
  primaryCTA:       ctaSchema,
  metaTitle:        z.string().min(1).max(60),
  metaDescription:  z.string().min(120).max(160),
  // Designer's T3 decides the slot; T8 fills src. Kept mandatory so a missing slot fails the build.
  heroImageSlot:    z.string().min(1).max(200),
});

const caseStudySchema = z.object({
  order:            z.number().int().min(1).max(3),
  slug:             z.string().regex(/^[a-z0-9-]+$/).min(1).max(60),
  sector:           z.enum([
                      'professional-services',
                      'ecommerce-ops',
                      'field-services',
                      'growth-teams',
                    ]),
  title:            z.string().min(1).max(80),
  outcome:          z.string().min(1).max(220),
  context:          z.string().min(1).max(800),
  problem:          z.string().min(1).max(800),
  approach:         z.string().min(1).max(1000),
  execution:        z.array(z.string().min(1).max(280)).min(3).max(8),
  result:           z.string().min(1).max(600),
  testimonial:      testimonialSchema,
  primaryCTA:       z.literal('discuss'),
  metaTitle:        z.string().min(1).max(60),
  metaDescription:  z.string().min(120).max(160),
  sample:           z.literal(true),   // D7: v1 case studies are always labelled sample.
});

export const collections = {
  services:    defineCollection({ loader: glob({ pattern: '**/*.md', base: './src/content/services' }),    schema: serviceSchema }),
  caseStudies: defineCollection({ loader: glob({ pattern: '**/*.md', base: './src/content/case-studies' }), schema: caseStudySchema }),
};
```

Rules:
- `sample` is a **literal `true`**. A case study can never be shipped without the label. Removing the literal is a spec edit requiring a review round (T13).
- Meta fields are validated at **build time** by the schema; T12 cannot weaken them.
- Per-page body (markdown) renders as the long-form copy; frontmatter is what T12's SEO layer reads (title, desc, title tag).
- `primaryCTA` for services accepts the 5 enum values but the **matrix in §5 fixes the value per page**; CI (T11/T12) asserts the matrix, not just schema validity.

Files:
- `src/content/services/{workflow-automation,ai-agents,systems-integration,internal-tools}.md`
- `src/content/case-studies/{sample-weekly-reporting,sample-order-sync,sample-lead-agent}.md`
- Frontmatter copies the plan §4 + copy-deck §3/§5 verbatim with cap-enforcement edits (copy-deck's preflight char counts already satisfy the caps).

---

## 3. Form contract — `src/types/contracts.ts`

### 3.1 Request (JSON path)

```ts
// POST /api/contact
// Content-Type: application/json

export type Budget =
  | 'under-1k'
  | '1k-5k'
  | '5k-15k'
  | '15k+'
  | 'not-sure';

export type Timeline =
  | 'asap'
  | '1-month'
  | '3-months'
  | 'exploring';

export interface ContactRequestJson {
  name:            string;   // required, 1..80
  email:           string;   // required, format + 1..254; no control chars
  company?:        string;   // optional, 0..120
  project:         string;    // required, 1..500
  budget:          Budget;   // required, allow-listed (enum)
  timeline:        Timeline; // required, allow-listed (enum)
  _hp:             string;   // honeypot; MUST be ""
  startedAt:       string;   // ISO 8601 with timezone offset
  turnstileToken:  string;   // required on JSON path (widget is JS-rendered)
}
```

Caps encheap: `total body ≤ 8192 bytes` measured **before** parse (request bytes, not chars).

### 3.2 Request (no-JS fallback, urlencoded)

```
POST /api/contact
Content-Type: application/x-www-form-urlencoded
```

Fields are the same name/value pairs as 3.1, with `_hp`, `startedAt`, `budget`, `timeline`. `turnstileToken` **is not required** on this path — the no-JS path is gated by honeypot + time-trap + validation (plan §6 no-JS (CSP) — ⚠️ stated decision: no Turnstile without JS; the embed is JS-only). `startedAt` is emitted by the server-rendered form as a hidden ISO field read at page render.

Client may use `_hp` etc. — same caps. Budget/timeline **values** are the canonical enum strings from 3.1, rendered by the server with `value="<canonical>"` and a human label.

Display labels (single source for the UI; style in T3/T8):

| Canonical value | UI label |
|---|---|
| `under-1k` | Under $1,500 |
| `1k-5k` | $1,500–$5,000 |
| `5k-15k` | $5,000–$15,000 |
| `15k+` | Above $15,000 |
| `not-sure` | Not sure yet |
| `asap` | As soon as possible |
| `1-month` | Within a month |
| `3-months` | Within a quarter |
| `exploring` | Exploring, no fixed date |

Copy-deck §7 lists a looser set of labels; **T8 must map the dropdown to these canonical values exactly.** If you want a different label, change it here, not in FormData.

### 3.3 Content-Type allow-list

Allowed (case-insensitive, parameters after `;` tolerated):
- `application/json`
- `application/x-www-form-urlencoded`

Anything else (including `multipart/form-data`, `text/plain`, no header): `415 { error: 'payload-too-large' ? no. }`. Actually wrong CT is `415 { error: 'unsupported-media-type' }`? Plan's error codes list does NOT include a media-type code; it specifies `validation | challenge | honeypot | time-trap | rate-limit | payload-too-large | internal`.

Decision (T2 pins): wrong Content-Type returns **`415` with `{ error: 'validation', fields: { _ct: 'unsupported content type' } }`** so it stays inside the documented code list. (Plan's `validation` envelope covers input-shape errors.) Frontend's no-JS fallback never hits this because it posts urlencoded. Reviewer may challenge in M6; documented here.

### 3.4 Response

```ts
export interface ContactResponseOk { ok: true; ref: string } // ref = "inq_<8 hex>"
export type ErrorCode =
  | 'validation'
  | 'challenge'
  | 'honeypot'
  | 'time-trap'
  | 'rate-limit'
  | 'payload-too-large'
  | 'internal';

export interface ContactResponseErr {
  error: ErrorCode;
  fields?: Record<string, string>; // present only for 'validation'; keys are field names
}

// HTTP statuses:
// 200  { ok:true, ref }       (also the silent honeypot success shape)
// 400  { error:'validation' | 'time-trap', fields? }
// 403  { error:'challenge' }
// 413  { error:'payload-too-large' }
// 415  handled as 400 validation (see §3.3)  -- keep client simple
// 429  { error:'rate-limit' }  (no fields, no dimension reveal)
// 500  { error:'internal' }
//
// No-JS urlencoded success: 303 See Other -> /thank-you
// No-JS validation errors:   400 with an HTML error page (Frontend T8 designs the no-JS error view, or echoes back to /book)
```

- **Honeypot → `200 { ok: true }`** (no ref generated, no side effects). Do not distinguish in body from a real success except via ref. Frontend redirects `/thank-you` for both.
- Rate limit → **generic `429 { error: 'rate-limit' }`**; never reveal whether IP or email tripped.
- `ref` format: `"inq_" + crypto.randomUUID().replace(/-/g,'').slice(0,8)` (lowercase hex). Example `inq_a1b2c3d4`.

### 3.5 Time trap windows

`startedAt` is a client-rendered hidden field carrying page render time. Server uses `receivedAt = new Date()` (server clock) in ms since epoch.

| Check | Rule | On failure |
|---|---|---|
| presence | `startedAt` required and parses as a date | `400 validation { fields: { startedAt } }` |
| too fast | `receivedAt - startedAtMs ≤ 3000ms` | `400 time-trap` |
| too old | `receivedAt - startedAtMs > 4h (14_400_000ms)` | `400 time-trap` |
| future skew | `startedAtMs > receivedAt + 60_000ms` (1 minute) | `400 time-trap` |

Rationale: blocks headless replay, stops stale forms from silently re-submitting, allows normal humans and forward clock skew. Values are constants in the function (`TIME_TRAP_MS = 3000`, `MAX_AGE_MS = 14_400_000`, `SKEW_MS = 60_000`), not env.

### 3.6 Pipeline order (authoritative; do not reorder)

```
0. Read raw request.
1. Body size check  (≤ 8192 bytes measured BEFORE JSON parse, on the raw bytes).
   - If Content-Length present and > 8192 → 413 without reading body.
   - Otherwise read up to 8193 bytes; if more remain → 413 and discard.
   - Only now is the body a string.
2. Content-Type allow-list (§3.3). Otherwise → 400 validation { _ct }.
3. Parse: JSON or urlencoded per the detected type (malformed → 400 validation).
4. Turnstile verification:
   - JSON path: turnstileToken must be present & non-empty.
        POST siteverify with secret + token + remoteip (optional).
        On failure or non-OK → 403 challenge.
   - urlencoded (no-JS) path: turnstileToken is NOT required; if present, verify (best effort,
        failure still 403 — but form is normally rendered without token).
5. Schema validation (zod-equivalent, server-side) on the parsed object: required, caps,
   email shape, enums. Bad → 400 validation { fields }.
   - Email control-character rule: \r \n \t or any codepoint < 0x20 in email → 400 validation
     { fields: { email: 'invalid characters' } }. (Prevents header injection even though
     we never use email in a header.)
6. Honeypot gate: if _hp !== "" → 200 { ok: true } silent, log reason 'honeypot',
   NO email, NO webhook, NO rate-limit increment, NO side effects.
   (Place after validation so a non-bot form with empty _hp proceeds normally; bots that
   fill _hp are caught and short-circuited before rate-limit/email.)
7. Time trap (§3.5): 400 time-trap on failure.
8. Rate limit check (§3.9): 429 rate-limit on breach.
9. Email (Resend) — §3.7.
   - On failure: 500 internal, log reason 'email-send-failed', NO webhook. Submission not ok.
10. ref = generate before returning; return in response + include in webhook payload.
11. Optional webhook (§3.8) — best effort; never changes the response for the user.
12. Log one line (§3.10). Return 200 { ok: true, ref } (JSON path) or 303 → /thank-you (urlencoded path).
```

Notes on ordering:
- Siteverify is called **before** validation and **before** rate-limit increments — a rejected challenge does not consume a rate-limit slot.
- Honeypot is checked **after** validation but before the time trap and rate limit.
- Email failure blocks the webhook and the `ok:true` response. Webhook failure does **not** block `ok:true`.

### 3.7 Email (Resend) — exact outbound contract

```
transport: Resend (raw fetch to https://api.resend.com/emails OR the Workers-compatible
           'resend' SDK — pin in T10 after testing)
from:      RESEND_FROM  (e.g. "IXI Contact <contact@ixi.example>")
to:        [RESEND_TO]
reply_to:  submitter email (safe: this is a field, not interpolation into a header name)
subject:   "New IXI inquiry"   (CONSTANT — no user data, ever, in any header)
text:      plain text rendering (safe: no markup)
html:      HTML rendering with name/company/project HTML-escaped
```

- `name`, `company`, `project` are **HTML-escaped** before rendering (`&`, `<`, `>`, `"`, `'` → entities). `email` is escaped too when rendered.
- `\r \n \t` control chars: already rejected at schema (§3.6 step 5) for `email`. For `name`/`company`/`project`, control characters strip/normalize (remove `\r \n \t`) before rendering — do not reject, since a crafted project description might legitimately contain whitespace. Implementation: replace the regex `/[\r\n\t]/g` with a space in those three fields before render.
- `subject` is a constant literal. If a future field must appear in the subject, that's a spec edit requiring threat-model update.
- Trial/preview sends go to a **QA mailbox alias, never the owner's real address** (DevOps, T11). M4 verifies a real submission via QA mailbox only (plan §8 M4).

### 3.8 Webhook (optional)

Enabled iff `FORM_WEBHOOK_URL` is present and non-empty. Missing URL = disabled, **not a failure**.

- Method `POST`, `Content-Type: application/json`.
- Headers: `X-Signature: sha256=<hexdigest>`, `X-IXI-Event: contact.submitted`, `User-Agent: IXI-Contact/1`.
- Computed as `HMAC-SHA256(FORM_WEBHOOK_SECRET, canonicalJsonPayload)` hex-encoded (via `crypto.subtle.sign`).
- Canonical payload (keys in this fixed order, no extra whitespace):
  ```json
  {
    "ref": "inq_a1b2c3d4",
    "receivedAt": "2026-10-15T14:41:00.000Z",
    "startedAt": "2026-10-15T14:38:00.000Z",
    "name": "...",
    "email": "...",
    "company": null,
    "project": "...",
    "budget": "under-1k",
    "timeline": "asap",
    "channel": "json" | "form-urlencoded",
    "source": "ixi-contact/1"
  }
  ```
  Canonicalization: `JSON.stringify` of an object built with the keys above in that exact insertion order; default separators (no spaces inside arrays/objects are added by `JSON.stringify` anyway). Do **not** sort keys by any other rule.
- `source` is a constant version string, bump on schema changes.
- Retry: 3 total attempts (`1 + 2`), gaps `2s` then `4s` (max total ~6s + request time, hard cap 20s per DevOps). Retry on: network error, 5xx, 429. Do **not** retry on 2xx (success) or other 4xx (mark `webhook-rejected`, stop).
- On terminal failure: log `reason: 'webhook-failed'` (or `webhook-rejected`) with attempt count and last status; **submission still `ok: true`** because the email already succeeded.
- Only one webhook URL for v1 (owner's automation, single destination). Multiple destinations = future spec.

### 3.9 Rate limiting (Cloudflare KV)

Free tier: no managed per-IP rate limit on Pages Functions, so we implement it.

- Binding name: **`KV_COUNTER`**. Create the namespace in the Cloudflare dashboard (DevOps T11). In-memory `Map` fallback when the binding is absent (local dev, preview without KV).
- Keys:
  - `ip:<YYYY-MM-DD-HH>:<sha256(ip + LOG_PEPPER)>` — TTL 3600s (1h). Counter. Limit **3 / IP / hour**.
  - `em:<YYYY-MM-DD-HH>:<sha256(lower(email) + LOG_PEPPER)>` — TTL 3600s. Limit **3 / email / hour**.
  - `emday:<YYYY-MM-DD>:<sha256(lower(email) + LOG_PEPPER)>` — TTL 86400s. Limit **10 / email / 24h**.
- Increment procedure (per key): `GET` → if `null` treat 0. If count `>=` limit → breach (429). Else `PUT (count+1, { expirationTtl })`.
- Race-condition note: KV is not atomic; two concurrent increments may both read `n-1` and write `n` (undercount). Accepted for v1 at this scale; document as a known limitation in T13 and T14. Upgrade path to Durable Objects if abuse appears.
- Key hashing: IP and email are **never stored raw**; always SHA-256 with the `LOG_PEPPER` (per-env).
- Dimension never enumerated in the response or in logs beyond the bucket's counter state.

### 3.10 Privacy-safe logging

One JSON line per request (Workers `console.log` only channel; Cloudflare ~28-day retention):

```json
{ "ref":"inq_a1b2c3d4", "ok":true, "reason":"ok", "status":200,
  "emailHash":"sha256...",
  "startedAt":"2026-...",
  "receivedMs":1729..., "totalMs":312, "hasWebhook":true,
  "channel":"json" }
```

- `reason` ∈ `ok | honeypot | challenge | validation | time-trap | rate-limit | payload-too-large | email-send-failed | webhook-failed | webhook-rejected | internal`.
- `ipHash` = `sha256(ip + LOG_PEPPER)` hex. Email is hashed (lower-cased) in `emailHash`; raw IP/email are **never** logged. Store only hashes in logs.
- **Never** log `name`, `email`, `company`, `project`, `body`, `startedAt`-plus-content. The line above is the complete schema — fields not in it are forbidden. If a debug build needs more, it must go behind a feature flag that is off in production env (`APP_ENV=prod`).
- CORS/log format: structured single-line JSON (no multi-line). If Cloudflare Logpush is wired later (paid), same schema. Keep `console.log` as the default.

### 3.11 Client-side validation parity (T9)

- Client validation mirrors the server schema (caps + enums + required + email shape) for UX, but the server is authoritative.
- Duplicate the enum lists in `src/lib/contact.ts` by importing from `src/types/contracts.ts` (same file, imported by T4 frontend as `import type { ... } from '../types/contracts'`).
- `aria-live="polite"` announces success and server-error only (never per-keystroke validation); per QA §9 accessibility.
- `autocomplete`: `name`, `email`, `organization` (company); `inputmode`: `email` on email; `tel` where phone not collected (N/A in v1 — document the absence).

---

## 4. Stub contract for T9 (Frontend needs `/api/contact` working before T10)

Frontend builds against a stub while Backend implements T10.

- The stub is **gated by env var `DEV_STUB=1`** (any environment). When active, `/api/contact`:
  - Accepts any body (but still enforces §3 body-size + Content-Type so the UI's error paths are testable).
  - Returns `200 { ok: true, ref: "inq_stub" }` for the JSON path;
  - Returns `303 → /thank-you` for urlencoded requests.
  - Does **not** call Turnstile, email, or webhook; does not write KV; logs one line `{ ref:'inq_stub', ok:true, reason:'stub', status:200 }`.
- The stub branch is in `functions/api/contact.ts` from the start, behind `if (env.DEV_STUB === '1') { ... }`, so removal is a deletion of the branch (not a rewrite).
- Removal criteria (T10 acceptance): delete the stub branch; CI raises a hard error if `DEV_STUB === '1'` appears in the production environment's variables; the preview environment's `DEV_STUB` is set to `0` during M5 so the real path is exercised before M6.
- Test URL used by T9/T14: `POST http://localhost:8788/api/contact` (`wrangler pages dev dist --compatibility-date=2025-01-01` with preview env).

---

## 5. CTA enum + promise→destination matrix (authoritative)

Source of truth for the right label per page. Frontmatter `primaryCTA` holds one of:

```ts
export type CtaRole =
  | 'book-15'
  | 'audit'
  | 'quote'
  | 'discuss'
  | 'see-pricing';
```

| CtaRole | Label | Destination |
|---|---|---|
| `book-15` | Book a 15-minute call | `/book` |
| `audit` | Start an automation audit | `/pricing#apply?offer=audit` |
| `quote` | Get a custom quote | `/pricing#apply` |
| `discuss` | Discuss a similar project | `/book` |
| `see-pricing` | See pricing | `/pricing` |

Fixed matrix (matches plan §2 + copy-deck):

| Route | primaryCTA | Notes |
|---|---|---|
| `/` | `book-15` | persistent header/footer CTA is *always* `book-15` regardless |
| `/services` | `book-15` |  |
| `/services/workflow-automation` | `audit` | fallback route documented: if the pricing anchor is ever dropped, relabel to `book-15` → `/book` (§13) |
| `/services/ai-agents` | `book-15` |  |
| `/services/systems-integration` | `quote` |  |
| `/services/internal-tools` | `quote` |  |
| `/work` | `discuss` |  |
| `/work/<slug>` | `discuss` |  |
| `/process` | `book-15` |  |
| `/pricing` | `quote` label becomes "Apply for a custom quote" → `#apply` | Apply maps to `quote` with label override stored as a separate `primaryCTALabel?` frontmatter string; default label only used when absent. Reviewer note: one label per page is still met (label override replaces, not adds). |
| `/about` | `book-15` |  |
| `/book` | none (the calendar is the action) | sticky mobile CTA hidden here too |
| `/thank-you` | `see-pricing` |  |
| `/privacy` | `book-15` (optional, footer CTA anyway) | page-level CTA may be `none` in frontmatter |
| `/terms` | `book-15` (optional) |  |
| `/404` | `book-15` | sticky mobile CTA hidden (§9 T8) |

Additionally, the **persistent header/footer CTA is hard-coded** to `{ label: 'Book a 15-minute call', href: '/book' }` in the layout — it does not read frontmatter, by design.

CTA enum set is closed; adding a role is a spec edit. The promise→destination mapping artifact for QA is `qa/artifacts/cta-matrix.md` (generated in T12 from this table).

`/pricing` special label override:

```ts
// Optional frontmatter on a page that wants a different wording
// (only /pricing in v1 uses this).
primaryCTALabel?: string; // max 40; used when present, else label from CtaRole
```

---

## 6. Routing, canonical & trailing-slash rule

- **Single trailing-slash rule globally (decided in T2): no trailing slash.** All canonical URLs in meta, in the sitemap, in internal links, in JSON-LD, and in 301 targets are **slashless**.
- Astro config: `trailingSlash: 'never'`. Astro emits clean URLs by default (a page at `/services/ai-agents`).
- Inbound requests with a trailing slash redirect `301` to the slashless URL (host-level / `_redirects` rule on the Pages project — DevOps T11). Do not rely on client-side redirection.
- All `<link rel="canonical">` emissions use the slashless absolute URL ( SEO layer T12).
- `hreflang` is **omitted** (single language D1); document the omission in `/sitemap.xml` generation — do not emit `hreflang`.

Sitemap:
- Exclude `/404` and all URLs are canonical absolute `https://<domain>/<path>`.
- `/thank-you` included? Plan: `noindex, follow` on `/thank-you` and `/404`. Keep `/thank-you` *in* the sitemap with `noindex`? XML sitemaps should omit noindex pages. T12 decision: **omit both from sitemap** (simpler; noindex + sitemap inclusion is contradictory). Flag this for the Code Reviewer at T13; the plan text says `/404` excluded; I'm adding `/thank-you` to that set on consistency grounds.
- `robots.txt`: standard, points to `sitemap-index.xml` (Astro's `@astrojs/sitemap`).

---

## 7. SEO contracts

- One `<h1>` per page (build-checked by T14/QA).
- `<title>` ≤ 60, `<meta name="description">` 120–160 — enforced by the content schema (services/cases) and by per-route frontmatter / page data for non-collection routes. T12 manually fills non-collection routes.
- Canonical: `<link rel="canonical" href="https://<domain>/<path>" />`, no trailing slash, absolute.
- OG/Twitter tags for every route: `og:title`, `og:description`, `og:type` (`website` generally), `og:url`, `og:image` (1200×630 from `public/og.png` generated at build in T12 — generation mechanism is a Frontend task; the contract here is **1200×630, PNG, no text overflow**).
- JSON-LD (render as `<script type="application/ld+json">`, only facts visible on the page):
  - Home: `ProfessionalService` (single Business? IXI is sole-trader: use `ProfessionalService`, `name`, `url`, `email`; no address — explicitly no fabricated address per D12; `areaServed` optional).
  - Each service page: `Service` (name, description, provider, offers with `priceSpecification` "from $X").
  - `/pricing`/FAQs where applicable: `FAQPage`.
- `noindex, follow` on `/thank-you` and `/404` (write tag on both).
- `/404` HTTP status 404 (set via `astro.config` 404 page; Cloudflare Pages serves it with 404 status automatically — DevOps T11 confirms with a smoke test).

---

## 8. Security headers (`public/_headers`, Cloudflare syntax)

Authoritative header set. DevOps ships them in `public/_headers`; QA asserts zero violations.

```
/*
  Content-Security-Policy: default-src 'self'; \
    script-src 'self' https://challenges.cloudflare.com https://assets.calendly.com https://www.googletagmanager.com; \
    style-src 'self' 'unsafe-inline'; \
    img-src 'self' data: https:; \
    font-src 'self'; \
    connect-src 'self' https://analytics.plausible.io; \
    frame-src https://calendly.com https://challenges.cloudflare.com; \
    base-uri 'self'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  # HSTS added only post-launch:  (post-launch gate)
  # Strict-Transport-Security: max-age=31536000; includeSubDomains; preload   (DO NOT enable before domain stabilises)
  Link: </fonts/inter-variable.woff2>; rel=preload; as=font; type=font/woff2; crossorigin

/assets/*
  Cache-Control: public, max-age=31536000, immutable

/*.html
  Cache-Control: public, max-age=0, must-revalidate
```

Notes:
- `style-src ... 'unsafe-inline'`: Astro emits inline critical CSS in some configurations; keeping it tight is preferred. Decision: `'unsafe-inline'` added because Astro and a few component scoped styles rely on it; T13 verdict may tighten by moving inline styles into the external bundle. Flagged, not blocking.
- `script-src` includes `www.googletagmanager.com` only if the owner opts into Plausible-via-GTM; default analytics is Plausible (no GTM needed) and that entry should be removed otherwise. Default = Plausible script served from `https://plausible.io`, no third-party GTM.
- `connect-src` for Plausible Cloud is `https://plausible.io` (+ api host). Update the host when DevOps provisions the analytics site.
- **Hosts for Calendly/Turnstile must be verified against a live page load in M5** (plan §6 + reviewer edit #6). A simplified allow-list written without live verification is not acceptable evidence for M6.
- OG/Twitter meta uses the page's own URL only.

Analytics: **Plausible Cloud** (cookieless, no consent banner). Opt-out via env `ANALYTICS_ID` and `ANALYTICS_HOST`. Consent banner omitted only if the cookie audit (T11) shows zero other non-essential cookies (§9).

---

## 9. Threat model / trust boundaries

<|end|> Boundary | Untrusted input | Controls | Owner-doc |
|---|---|---|---|
| Browser → static site | none user-controlled in HTML beyond URL | CSP, no inline attacker input | §8 |
| Browser → `/api/contact` | entire body, headers, Origin/Referer | body size before parse, Content-Type allow-list, Origin/Referer check, Turnstile siteverify, schema + caps + enums, honeypot, time trap | §3 |
| Browser → Turnstile widget | widget iframe (third party) | CSP `frame-src` allow-list | §8 |
| `/api/contact` → Resend (email) | user text | constant subject, no user data in headers, HTML escape, control-char strips | §3.7 |
| `/api/contact` → optional webhook | same | HMAC-SHA256, canonical JSON, retry caps | §3.8 |
| TURNSTILE_SECRET_KEY → siteverify | challenge token | single-use server-side; replayed tokens return false | plan §6 |
| Logs | request metadata | redacted schema, peppered hashes, no bodies | §3.10 |
| Client bundle | build env | only `TURNSTILE_SITE_KEY` + analytics ID; secrets scan | I-5 |
| Calendly embed | cookies, loaded after lazy trigger | disclosure before interaction, no global preconnect | plan §6 |
| Third parties (Resend/Cloudflare/Plausible) | contract/DPA | documented in privacy policy | D13 + privacy copy |

Threat categories:
- **Injection (email header):** prevented by const subject, no user data in headers, and input rules in §3.7.
- **Spam/abuse:** honeypot, time trap, Turnstile, rate limits, body caps.
- **SSRF:** webhook URL is env-set by the owner; reject if placed by any request. Do not allow the client to influence the webhook destination.
- **Replay:** Turnstile single-use tokens; CAPTCHA on JSON path.
- **Secret leak:** I-5 + CI scan.
- **CLS/XSS:** HTML escape on outbound; no `set:html` on user strings.
- **Privacy:** redacted logs, no message bodies, DPA documented.

---

## 10. SEO / indexing contracts (reminder for §6, §7)

- Trailing slash: §6.
- `noindex, follow` tags on `/thank-you` and `/404`.
- `/404` excluded from sitemap (omit `/thank-you` too, see §6).
- OG image 1200×630, no overflow, generated at build (T12 mechanism: Astro Image API or `sharp` in a prebuild script; pixel exact; if the generator can't hit 1200×630 the build breaks).
- Canonical absolute URLs, one global rule.
- JSON-LD only on visible content (matched strings/spec).

---

## 11. CI invariants & checks (DevOps T11, Reviewer T13)

A CI check must fail the PR on any:

| Check | Tool / grep |
|---|---|
| `output: 'static'` present in `astro.config.mjs` | grep |
| `@astrojs/cloudflare` absent from `package.json` + lockfile | grep / npm ls |
| No SSR from Astro: `grep -R "export const prerender = false" src/` empty | grep |
| `functions/` is not nested under `src/` or `dist/` | tree check |
| Secrets scan: only `TURNSTILE_SITE_KEY`, `ANALYTICS_SITE_ID` may appear in `dist/` | grep over built assets |
| No `DEV_STUB=1` in production env vars | env check |
| Type-check `astro check` passes | build step |
| Lighthouse CI ≥ 90 (perf/a11y/best-practices/SEO) on `/`, a service page, `/book` | LHCI |
| Content schema validation passes at build (`astro build` itself errors on invalid frontmatter) | build step |
| CSP violation check on live preview routes captured as artifacts (T14) | manual/QA |

T9's `DEV_STUB` is allowed in preview env only (value `1`) and in production must be `0`/unset.

---

## 12. Environment inventory & secrets handling

Per environment (Production vs Preview) in the Cloudflare dashboard. Encrypted, never in the repo. `.env.example` committed; `.env*` gitignored.

| Var | Where | Client bundle? | Notes |
|---|---|---|---|
| `TURNSTILE_SITE_KEY` | build + client | ✅ public | Test (public) key on preview; real key in production |
| `ANALYTICS_SITE_ID` (Plausible domain) | build + client | ✅ public | harmless if leaked |
| `TURNSTILE_SECRET_KEY` | server env | ❌ never | live prod pair for production; test secret for preview |
| `RESEND_API_KEY` | server env | ❌ never |  |
| `RESEND_FROM` | server env | ❌ never | e.g. `IXI Contact <contact@ixi.example>` — verified sending domain required |
| `RESEND_TO` | server env | ❌ never | owner destination (QA mailbox alias in trial runs) |
| `FORM_WEBHOOK_URL` | server env | ❌ never | optional; unset = disabled |
| `FORM_WEBHOOK_SECRET` | server env | ❌ never | 32+ bytes, owner-generated at deploy |
| `LOG_PEPPER` | server env | ❌ never | 32+ bytes for hashing; per-env |
| `APP_ENV` | server env | ❌ never | `dev` / `preview` / `prod` |
| `DEV_STUB` | server env | ❌ never | `1` in preview for T9, `0`/unset in production |
| `KV_COUNTER` | binding (not env var) | — | namespace binding name in Pages project |

Rules:
- Preview deploys use **Turnstile test keys** (the real site key refuses localhost — plan §6).
- Sending domain (IXI) needs SPF/DKIM/DMARC set by the owner in DNS before `from` is trusted (DevOps T11).
- Signing secrets are **agent-generated at deploy** if not supplied by the owner (recommend agent-generated `FORM_WEBHOOK_SECRET` + `LOG_PEPPER`); report the values once via the secure channel, then they live in the dashboard.

---

## 13. Open owner items that affect this spec (non-blocking — defaults hold; behaviours noted)

1. Public contact email domain & from-address (placeholder `hello@ixi.example`) — update in T8 copy (env-driven is safer).
2. Whether the optional webhook ships in v1 (defaults **disabled**; schema is defined regardless, so enabling later is one env-var change + a destination URL, no code).
3. Trailing-slash + apex-vs-www canonical host on the deployed zone (DevOps to set consistently with §6).
4. Pricing posture (cost / retainer wording) is **copy**, not a spec value — T2's caps still apply.
5. If the audit CTA anchor (`/pricing#apply?offer=audit`) is ever dropped, `workflow-automation` switches to `book-15` → `/book` (matrix row in §5).
6. Cap values (`max 80`, `500`, etc.) are firm; raising them is a spec edit and forces a T10 + T9 re-test.

---

## 14. What this spec deliberately does NOT define

- Wording/copy (T1 owns). Labels must align with §2 display labels.
- Visual tokens, layouts, motion, image sizing (T3).
- DB/storage (v1 has none; no persistence of submissions beyond Resend email — D13).
- Localisation/i18n beyond en-GB/en-Latn-only English (D1).
- Multi-tenant / multi-site; Cal.com fallback; WAF upgrade economics (deferred).
- Route-level data fetching beyond content collections.

---

## 15. Sign-off

- [ ] Product Analyst: copy-cap compliance + meta/title coverage confirmed.
- [ ] Frontend: schemas + CTA enum + form contract usable for T4–T9.
- [ ] Backend: form contract + email + webhook + rate limit implementable on Workers.
- [ ] DevOps: headers, env inventory, CI checks feasible.
- [ ] QA: every contract field testable (abuse matrix statuses in plan §9 match §3.4).
- [ ] Code Reviewer: threat-model complete enough to audit against in T13.

**Status:** Draft (T2). Next trigger: M1 passes → M2 (T4 scaffold + T5 Home) opens. No build code written for T2. No secrets touched.
```

Let me verify line count and that file exists. Also I should double-check the writing saved correctly. Let me count lines with shell.<|end|><|start|>asset to=shell<|channel|>analysis <|constrain|>xml<|message|><rfl:parameter name="command">
wc -l "C:\Users\Kalch\Documents\IXI\spec\interface-spec.md" 2>/dev/null || powershell -Command "(Get-Content 'C:\Users\Kalch\Documents\IXI\spec\interface-spec.md').Count"