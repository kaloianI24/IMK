# Wave 18a — Architect design: the /contact "email us" page and the attachment transport

- **Type:** DESIGN ONLY. This file is the deliverable of the wave; no product, test, doc or harness file was changed.
- **Owner request (condensed):** remove "Book a 15-minute call" + Calendly entirely; the CTA opens an on-site email page the visitor fills (who they are, company, their email → Reply-To, subject e.g. "email automation", description, optional images/videos) and presses Send; small professional "thanks — we'll reply within 24h" notification.
- **Assigned by:** @Manager — wave 18a (Architect).

## Verified facts I was handed (not re-derived)

- Only contact endpoints exist: `api/contact.ts` (Vercel) and `site/functions/api/contact.ts` (Cloudflare). There is NO multipart parser; the `|| ct.includes('multipart')` branch feeds the raw body to `new URLSearchParams(raw)` (`api/contact.ts:235`, `site/functions/api/contact.ts:111`). `MAX.body` = 8192 in both (`api/contact.ts:58`, `site/functions/api/contact.ts:29`).
- Abuse chain and Resend: Turnstile (`api/contact.ts:130,308`), honeypot (`348`), time-trap (`358`), rate-limit (`147,148,370`), validation (`330`), Resend (`387,402`), redacted log (`446`). Resend already sends `reply_to` = visitor address (`api/contact.ts:407`, `site/functions/api/contact.ts:220`) — plain Reply continues the thread.
- `/book`: Calendly client-only embed + noscript intake posting `budget=not-sure` / `timeline=exploring` (`site/src/pages/book.astro:4,17-47,29-41,33-34`).
- `CALENDLY_URL`: `site/.env.example:25-26`; Calendly hosts allowlisted in CSP: `site/public/_headers:7`, `vercel.json:56`.
- Brand red already `#EA0000` (`--color-primary`, `--brand-red`) in `site/src/styles/tokens.css:30,46`; dark theme `#EF7D7D` (`tokens.css:138-140`); stray portal toast red `#b00020` (`site/src/pages/portal.astro:192`).

## The nine decisions

### D1 — Route + redirect (new page `/contact`, retire `/book`)

**Decision:** ship `GET /contact` as a new static page (`site/src/pages/contact.astro`); `/book` answers **308 → `/contact`**.
- Vercel: add top-level `redirects` array to `vercel.json` with `{source:"/book",destination:"/contact",statusCode:308}`. Rewrites (the `__imk_route` machinery) untouched.
- Cloudflare: create `site/public/_redirects` (absent today) containing `/book /contact 308`.
- `site/src/pages/book.astro`: **deleted** (dead after the redirect).
- CTA retarget `/book` → `/contact` in the 14 live references (Header `22,36`, Footer `28`, 404 `10`, about `24`, automations `43`, index `64`, process `13,47`, thank-you `8`, pricing `6` + sticky, work `10`, work/[slug] `16,35`, services/[slug] `18,26`).
- Sitemap: `site/astro.config.mjs:10-16` — exclude `/book`, include `/contact`.

**Proving check:** `npm run check:routes` → 16 routes / 0 missing (page + redirect changes do not touch that gate); vercel.json must stay valid JSON; later: preview deploy + `curl -i $PREVIEW/book` → `308 /contact` (launch-unverified).

### D2 — Attachment transport cap

**Decision:** max **3 files, max 4 MiB (4,194,304 B) total** per submission (manager-decided, do not reopen).
- Vercel serverless hard body cap is 4.5 MB → the 4 MiB product cap leaves headroom for multipart boundary/headers overhead under 3 files.
- Server limits: ≤3 files, per-file ≤4 MiB, total ≤4 MiB. Client mirrors the same numbers.
- Exceeded → `413 payload-too-large`; >3 files → `413 too-many-files`.

**Proving check:** cap arithmetic (3× overhead + 4 MiB < 4.5 MB); new Backend harness on both twins post-implementation.

### D3 — Multipart parser

**Decision:** new shared module **`site/shared/server/multipart.ts`** — ONE implementation for both `api/contact.ts` and `site/functions/api/contact.ts`.
- Export e.g. `parseMultipart(body, contentType)` → `{ok:true, fields, files:[{filename, contentType, data}]}` or error.
- Zero new dependencies; Web Platform APIs only (Headers, Uint8Array, boundary parsing). Vercel: existing `readBody` Buffer → parse; CF: `Request.text()` → parse.

**Proving check:** parser harness run against both handlers' input paths after implementation; `typecheck:api` green.

### D4 — File safety

**Decision:** allow `png|jpeg|webp|gif` + `mp4|quicktime|webm`; **refuse SVG** (XSS vector in an email-attachment context). Magic-byte sniffing + declared-MIME allowlist; mismatch → reject. Filename sanitised (no path/traversal, ≤120). Reject the whole submission (`415 unsupported-file`) atomically — no partial sends.

### D5 — Resend payload

**Decision:** `{from, to:[RESEND_TO/CONTACT_TO], reply_to:<visitor email>, subject:<trimmed subject>, html, text, attachments:[{filename, content:<base64>}]}`.
- Subject: CR/LF strip (`controlStrip`), ≤120 chars else `validation`.
- Encoded-size guard before send; over → `413 payload-too-large`, no send.
- HTML: `escapeHtml` on all user values, newline → `<br>`.

### D6 — Response contract

**Decision:** success `200 {ok:true, emailed:<bool>, ref}` (`emailed:false` when no Resend key/destination — dev). Errors `{ok:false, code}` + status: `validation` 400, `turnstile` 403, `time-trap` 400, `rate-limited` 429, `payload-too-large` 413, `too-many-files` 413, `unsupported-file` 415, `internal` 500, `method` 405, `review-moved` 410.
- `type` stays default `'contact'`; `budget` + `timeline` required for `type=contact`; new page sends `budget:'not-sure'`, `timeline:'exploring'`; description → `project` (≤500); new optional field `subject`.

**Proving check:** response-shape harness asserting the codes above on both twins.

### D7 — Abuse + logging

**Decision:** reuse Turnstile/honeypot/time-trap/rate-limit chain. Accepted log: `{ts, ref, outcome, ipHash, type, fileCount, byteSize}` — counts + byte sizes only; never filename, body, attachment bytes, or raw visitor address.

### D8 — CSP + env cleanup

**Decision:** new CSP line, identical in `site/public/_headers:7` and `vercel.json:56`:
`default-src 'self'; script-src 'self' https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' https://challenges.cloudflare.com; frame-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`
- `frame-src 'none'` (no frames remain after Calendly). Turnstile host retained.

**Decision:** remove `CALENDLY_URL` from `site/.env.example:25-26`; nothing else removed.

### D9 — What I am NOT deciding

Copy, layout, colour, exact success-toast wording, exact UX states, page copy → **@Designer**. Implementation (parser wiring, handler edits, frontend) → **Backend / Frontend**. Brand-red fixes (`#EF7D7D` dark, `#b00020` portal, token values) → **@Designer** (`npm run brand`).

## Assumptions that could stop Backend or Frontend (stop-ship risks)

1. Vercel 4.5 MB body cap holds on the owner plan; CF Pages function body behaviour to be verified at deploy.
2. Resend accepts base64 `content` in `attachments` and the encoded size stays within its limit (server-side guard added regardless).
3. Turnstile secret present in production (local degrade-to-off retained).
4. Owner verifies the Resend From identity before launch.
5. Redirect status locked at **308**.
6. Whether the visitor's `subject` needs a separate owner-facing field.

## Proof status (this wave)

Design-only wave. No code, no build, no git write. Nothing here was executed beyond reading; the proving checks above are assigned to Backend/Frontend and must be run post-implementation.
