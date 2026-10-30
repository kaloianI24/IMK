# Wave 18b — Designer: the /contact email page (UX, copy, brand red)

REPO: C:\Users\Kalch\Documents\IXI (branchless, permanently dirty shared tree — never run a git write
command: no reset/clean/checkout/stash. Other agents work here.)

STATUS: DESIGN ONLY — written by the Chief Product Designer. No page, source, test, harness, DEPLOY.md or
env file was touched by me this wave. No `npm run build`. No git write command.

## Owner request (condensed, verbatim intent, 2026-10-25)

Remove "book a 15-minute call" and Calendly. Replace with "send us an email": clicking the CTA opens
`/contact`, a page the visitor uses to email IMK directly from the site. Fields: who they are (name /
company), their own email (Reply-To — they receive our reply), a subject/header (the owner's example:
"email automation"), a description of what they want, optional images/videos. On send: a small professional
notification — thanks, review, reply within ~24h. Separately: the brand red must be #EA0000 — the colour of the
IMK wordmark.

## My deliverable

`spec/wave18-contact-email-ux-2026-10-25.md` — THIS file. It contains the complete copy deck, all states, the
verbatim success-toast string, and the brand-red table that states with evidence whether #EA0000 already ships.

## Product limits already decided (do not change; write the UI around them)

- Max 3 attachments, max 4 MB total per submission; images PNG/JPEG/WebP/GIF + short video MP4/MOV/WebM. SVG is
  refused. This is the Vercel 4.5 MB request-body ceiling, not a preference.
- Fields: name (required), company (optional), email (required, becomes Reply-To), subject (required, preset
  choices + "Something else" free text), message (required).
- `budget=not-sure` and `timeline=exploring` are sent hidden — the pricing form's contract is untouched.
- Turnstile renders only when `PUBLIC_TURNSTILE_SITE_KEY` is set (same conditional as pricing).
- Success is an inline toast, no navigation — the visitor stays on the page with a "Send another email" action.

## Part A — Brand red audit

### A1. Sources read
`site/src/styles/tokens.css`, `site/src/styles/global.css`, every `.astro` under `site/src`, `site/public/*.svg`
(favicon.svg, og.svg), `site/public/site.webmanifest`, `site/src/brand/logo.ts`, `site/scripts/gen-brand.mjs`.

### A2. Red inventory (shipped tree)

Light theme (`:root`) — `tokens.css`:

| Token | Hex | Painted on / as | Note |
|---|---|---|---|
| `--color-primary` | `#EA0000` | button fill, focus ring, graphic emphasis | tokens.css:30 |
| `--color-primary-hover` | `#C00000` | hover fill | tokens.css:31 |
| `--color-primary-active` | `#A80000` | pressed fill | tokens.css:32 |
| `--color-on-primary` | `#FFFCF7` | label on fill | tokens.css:33 |
| `--color-link` | `#C00000` | inline text link | tokens.css:34 (AA text tint) |
| `--color-link-hover` | `#A80000` | inline link hover | tokens.css:35 |
| `--color-accent-text` | `#C00000` | brand red as TEXT | tokens.css:36 (AA 4.5 text tint) |
| `--color-focus` | `#EA0000` | focus ring | tokens.css:39 |
| `--brand-red` | `#EA0000` | wordmark colourway (owner artwork) | tokens.css:46 |
| `--brand-mark` | `#EA0000` | symbol fill on light bg | tokens.css:49 |
| `--brand-word` | `#EA0000` | wordmark fill on light bg | tokens.css:50 |
| `--color-error` | `#C62828` | semantic error | tokens.css:42 |

Dark theme (`@media (prefers-color-scheme: dark)` and `:root[data-theme="dark"]`) — `tokens.css`:

| Token | Hex | Painted on / as | Note |
|---|---|---|---|
| `--color-primary` | `#EF7D7D` | button fill, focus ring, graphic | tokens.css:138 / 165 |
| `--color-primary-hover` | `#F79A9A` | hover fill | tokens.css:139 / 166 |
| `--color-primary-active` | `#E87676` | pressed fill | tokens.css:140 / 167 |
| `--color-on-primary` | `#171315` | label on tint | tokens.css:141 / 168 |
| `--color-link` / `--color-link-hover` / `--color-accent-text` | `#F79A9A` | text accents | tokens.css:142-144 / 166-168 |
| `--color-focus` | `#F79A9A` | focus ring | tokens.css:147 / 167 |
| `--brand-mark` | `#CCCCCC` | symbol colourway (native) | tokens.css:154 / 170 |
| `--brand-word` | `#EF7D7D` | wordmark dark-safe tint | tokens.css:155 / 170 |

Stray red (NOT a token — decision required):

| Hex | Where | Use | Decision |
|---|---|---|---|
| `#b00020` | `site/src/pages/portal.astro:192` (`blocked:` status tag) and `site/src/components/PortalTestimonialPrompt.astro:219` (`var(--color-error, #b00020)` fallback) | red for "blocked" status / error fallback | Map to `var(--color-error)` — Frontend implements; designer out of file boundary. |

Other reds seen (context, not deviations): `--color-error: #C62828` light / `#FF6B6B` dark (semantic error); `#EA0000` as
text in `site/public/og.svg:6` (OG headline on `#121012`); `--color-accent-text` tints `#C00000`/`#F79A9A`.

### A3. ONE-LINE VERDICT ON #EA0000

**#EA0000 already ships as the brand red — the tree is already correct; no token change is required, and I made
none.**

Evidence:
- `tokens.css:30` `--color-primary: #EA0000`; `:46` `--brand-red: #EA0000`; `:49-50` `--brand-mark`/`--brand-word:
  #EA0000`; `:39` `--color-focus: #EA0000` (light theme).
- `site/src/brand/logo.ts:24` — `BRAND = { red: "#EA0000", ... }` (generated from owner artwork, `gen-brand.mjs`).
- `site/public/site.webmanifest:19` — `"theme_color": "#EA0000"`.
- `site/public/og.svg:6` — headline fill `#EA0000`.
- `site/scripts/gen-brand.mjs:33-42` — brand red source of truth `#EA0000`.

So the owner's emphatic requirement ("change the red that is now to #EA0000; my logo text is this colour; the
branding should have this colour too") is ALREADY satisfied in the light theme for every brand-red surface
(button fills, focus ring, logo mark, wordmark). The red the owner may be seeing as "wrong" is the OS-dark theme
tint (`#EF7D7D`) and/or the AA text tint (`#C00000`).

### A4. Dark theme decision (design verdict, measured)

I decided: **KEEP the shipped dark theme as-is.** The dark tints are a same-hue, lightened adaptation of the brand
red, chosen so text and graphics keep WCAG 2.2 AA. Measured by the brand gate (`npm run brand`, executed this
wave, exit 0):

- dark `--color-primary` `#EF7D7D` as graphic on `--color-bg #121012` = **7.13:1** (min 3) ✓; on surface = 6.40 ✓.
- dark label on primary = **6.93:1** (min 4.5 AA) ✓; on hover 8.81 ✓; on active 6.39 ✓.
- dark brand word `#EF7D7D` on surface = **6.40:1** (min 3) ✓.
- dark accent-text/link on surfaces = 7.27–9.06:1 (min 4.5) ✓.

A pure `#EA0000` button fill inside the dark theme would put the dark-ink label (`--color-on-primary: #171315`) at
≈3.98:1 — below the AA 4.5 text bar the gate enforces — so the tint is load-bearing, not drift. I did NOT change
`tokens.css`.

### A5. QA browser assertion (for the QA Engineer)

- Light theme: computed `background-color` of `.btn-primary` === `rgb(234, 0, 0)`.
- Dark theme: computed `.btn-primary` background === `rgb(239, 125, 125)` (`--color-primary` dark) — accepted tint;
  wordmark `--brand-word` === `rgb(239, 125, 125)`.

### A6. favicon.svg

Shows only `#222222` (plate) and `#CCCCCC` (symbol). That is BY DESIGN: the red wordmark on the charcoal plate is
≈3.41:1 (low), so the app icon uses the symbol only. **Not a defect.**

### A7. Brand gate result

`cd site && npm run brand` → exit 0, all contrast checks pass, no dark-theme mirror drift.

## Part B — Build-ready spec for `/contact`

### B1. Page intent, H1, subhead, chrome decisions

- Intent: replace the Calendly booking surface with an on-site email composer; reading it must feel like writing an
  email, not like filling a quote form.
- H1: **"Email us"**.
- Subhead: **"Tell us what's on your plate. We reply within 24 hours — usually much faster."**
- Meta description: "Write to IMK about workflow automation, AI agents, integrations or audits. We reply within 24 hours."
- Breadcrumbs: Home → Email us (design decision; keeps the /book pattern's successor coherent).

### B2. Field order and exact strings (final)

Order: To row → Name* → Company → Email* → Subject* → Message*.

| Element | Label / copy | Required | Type / attrs | Placeholder | Help |
|---|---|---|---|---|---|
| To row | `To: IMK — 2imk4support@gmail.com` | n/a | read-only composer frame row | n/a | n/a — design decision: INCLUDED (owner floated it; makes it read as an email) |
| Name | `Name` | yes | text, autocomplete=name, maxlength=80 | `Your name` | n/a |
| Company | `Company` | no | text, autocomplete=organization, maxlength=120 | `Acme Inc.` | `Optional — who it's for, if it differs from a personal project.` |
| Email | `Email` | yes | email, autocomplete=email, maxlength=254 | `you@company.com` | `We'll send our reply here — hit reply on our answer and it lands in your inbox.` |
| Subject | `Subject` | yes | chip radio group (presets + "Something else") + free text for "Something else" | n/a | n/a |
| Message | `Message` | yes | textarea, maxlength=500 | `What's manual today? What's the goal? What does done look like?` | `Plain text is fine — we'll turn it into the email body. Attach screenshots or a short screen recording if it helps.` |

### B3. Subject presets (final)

Chip radio group labelled "Subject". Presets with exact strings:

1. `Automation audit` (DEFAULT)
2. `Workflow automation`
3. `AI agent`
4. `Integration`
5. `Automation Care`
6. `Something else` → reveals free-text input (`Something else`? no) — free text, e.g. `Email automation`.

Design decision: default preset = `Automation audit`.

### B4. Attachment control (final)

- Add button (real `<button type="button">`): **`Attach images or video`**.
- Input: `<input type="file" id="attachments" name="attachments" multiple accept="image/png,image/jpeg,image/webp,image/gif,video/mp4,video/quicktime,video/webm">` — visually hidden but focusable (keyboard-only path).
- Helper: **`Up to 3 files, 4 MB total. PNG, JPEG, WebP, GIF or short MP4/MOV/WebM.`**
- Per-file chips with remove buttons (`Remove`).
- Over limit (client pre-check + server): **`That file is too large — the limit is 4 MB per email. Try a shorter video or remove it.`**
- Too many files: **`You can attach up to 3 files — please remove one and try again.`**
- Unsupported type: **`That file type isn't supported — attach an image (PNG, JPEG, WebP, GIF) or a short video (MP4, MOV, WebM). SVG isn't accepted.`**
- No-JS fallback: the `<form>` is a real form (`method="POST" action="/api/contact" enctype="multipart/form-data"`) — native multipart POST works with file inputs and no JS; JS upgrades to fetch. Design decision: keep one form, both paths.

### B5. Button + sending state (final)

- Submit label: **`Send email`**; sending state: **`Sending…`**, disabled, `aria-busy="true"`, double-submit guard.
- Design decision: submit is `type="submit"` in the real form; JS preventDefault + fetch.

### B6. Success toast (verbatim)

- **VERBATIM STRING: `Thanks — your email is in. We'll review it and reply within 24 hours.`**
- Element: `<div id="contact-toast" class="contact-toast" role="status" aria-live="polite" aria-atomic="true"
  tabindex="-1"></div>` — reserved slot in the form, directly above the actions row; slot reserves constant height
  (design constant ≈72px) so appearance never shifts layout.
- State-driven live semantics: success → polite/status; error → assertive/alert before text change.
- Persistence: stays until reset / next send. No auto-dismiss (design decision).
- Focus: success → move focus to the "Send another email" reset control; error → move focus to the toast slot.
- Reset action: **`Send another email`** — resets the composer, clears the toast/slot, refocuses first field.

### B7. Error states (final strings, one per failure case, each names the next action)

| Case | UI string |
|---|---|
| validation | `Please add your name, a valid email and a message — we need those to send.` |
| file too large | `That file is too large — the limit is 4 MB per email. Try a shorter video or remove it.` |
| too many files | `You can attach up to 3 files — please remove one and try again.` |
| unsupported type | `That file type isn't supported — attach an image (PNG, JPEG, WebP, GIF) or a short video (MP4, MOV, WebM). SVG isn't accepted.` |
| Turnstile failure | `Security check failed — please try again.` |
| Rate limited | `You've sent a few emails in a short while — please wait before sending again.` |
| Time trap | `You sent that very quickly — take a moment and try again.` |
| Server error | `Something went wrong while sending — please try again in a moment.` |

Design: server-returned `fields` array maps to inline per-field messages; none of the above clears typed text.

### B8. Accessibility (final)

- label-for on every control; error via `aria-describedby` + `aria-invalid`.
- Focus: success → reset control; error → toast slot; reset → first field.
- File input screen-reader name: `aria-label="Attach images or a short video"`; helper via `aria-describedby`.
- 44x44 targets: buttons/inputs/chips (global `.btn`/input min-height 44 already in place).
- Reduced motion: no toast animation.
- Colour-independent cues: error text always present; success text present.

### B9. Mobile

- Single column; textarea min-height 120; submit full width on mobile (min 44). Toast is in-flow above the submit
  row → never under the sticky CTA; sticky CTA hidden on /contact (design decision).

### B10. Copy deck (complete user-visible strings)

/contact:
| # | String | Where |
|---|---|---|
| 1 | `Email us — IMK` | title |
| 2 | `Write to IMK about workflow automation, AI agents, integrations or audits. We reply within 24 hours.` | meta description |
| 3 | `Email us` | H1 |
| 4 | `Tell us what's on your plate. We reply within 24 hours — usually much faster.` | subhead |
| 5 | `To: IMK — 2imk4support@gmail.com` | composer To row |
| 6 | `Name` | field label |
| 7 | `Company` | field label |
| 8 | `Email` | field label |
| 9 | `Email` help: `We'll send our reply here — hit reply on our answer and it lands in your inbox.` | |
| 10 | `Subject` | field label |
| 11 | `Message` | field label |
| 12 | `Message` help: `What's manual today? What's the goal? What does done look like? Plain text is fine — we'll turn it into the email body. Attach screenshots or a short screen recording if it helps.` | |
| 13 | `Up to 3 files, 4 MB total. PNG, JPEG, WebP, GIF or short MP4/MOV/WebM.` | attachment helper |
| 14 | `Attach images or video` | add button |
| 15 | `Send email` / `Sending…` | submit |
| 16 | `Thanks — your email is in. We'll review it and reply within 24 hours.` | toast (VERBATIM) |
| 17 | `Send another email` | reset action |
| 18-25 | error strings (B7) | error states |

Replacements for removed booking strings (Frontend implements; Designer specifies):
- `Book a 15-minute call` → **`Email us`** (href `/contact`). Occurrences: Header CTA ×2, Footer (`Book a call` →
  **`Email us`**), 404, about, automations, index, pricing sticky CTA, work pages ×2, services pages, process,
  thank-you.
- thank-you: `We reply within 2 business days. If your situation is urgent, book a 15-minute call instead.` →
  **`We reply within 24 hours. If your situation is urgent, send us an email with the details.`**; CTA → `Email us`.
- Privacy line (Calendly cookie warning obsolete): **`We use no tracking or scheduling cookies. Your email and any
  attachments are used only to reply to you — nothing is shared or stored beyond keeping the conversation.`**

### B11. Assumptions that could stop Frontend

1. Backend must land the `emailed` field and the `too-many-files` / `unsupported-file` codes before Frontend builds
   the success/error UI (Architect decision 6).
2. Success stays an inline toast, no navigation (Manager decision).
3. Turnstile requirements unchanged (Architect decision).
4. NEW (Designer): Backend must confirm the final multipart field name(s) for attachments and the final naming of
   the subject / message fields before Frontend builds the FormData.
5. NEW (Designer): Backend must answer multipart submissions with the same JSON contract (`ok`, `ref`, `emailed`).

## Done when

- `spec/wave18-contact-email-ux-2026-10-25.md` contains a complete copy deck, all states, the verbatim toast string,
  and a brand-red table that says with evidence whether #EA0000 already ships. **Met.**

## Report back (mine)

- DONE — spec written at `C:\Users\Kalch\Documents\IXI\spec\wave18-contact-email-ux-2026-10-25.md`.
- Verdict: **#EA0000 already ships — no token change made** (evidence: tokens, logo module, webmanifest, OG, gate).
- Token change: none. `npm run brand` executed → exit 0, all checks pass, key numbers above.
- Success-toast string verbatim: **`Thanks — your email is in. We'll review it and reply within 24 hours.`**
- Checks performed by me: read-only red inventory + `npm run brand` gate run (green). No typecheck/build (design-only
  boundary respected).
- Unverified: no browser QA of the new page (QA's job); token state unchanged; implementation pending Backend +
  Frontend.
