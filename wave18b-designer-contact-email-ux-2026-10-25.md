# Wave 18b — Designer: the /contact email page (UX, copy, brand red)

REPO: C:\Users\Kalch\Documents\IXI (branchless, permanently dirty shared tree — never run a git write
command: no reset/clean/checkout/stash. Other agents work here.)

## OWNER REQUEST (2026-10-25, verbatim intent)
Remove "book a 15-minute call" and Calendly. Replace with "send us an email": clicking the CTA opens an
on-site page that works like an email composer, so the visitor writes to us directly from the site.
Fields: who they are (name), or which company; their own email, so we can continue the conversation and
they receive our reply; a subject/header for the email — the owner's example is "email automation"; and
a description of what they want. They can attach images and videos. When ready they press Send and a
small notification appears saying something like "thanks for the email, we'll review it and reply
within the next 24 hours" — phrased professionally.
Separately, and importantly: the brand red must be #EA0000 — the colour of the IMK wordmark.

## YOUR DELIVERABLE
`spec/wave18-contact-email-ux-2026-10-25.md` — a build-ready page spec. Exact copy, exact states,
exact labels, exact classes. Frontend builds from it without guessing and without coming back to ask.

## PRODUCT LIMITS ALREADY DECIDED BY ME (do not change; write the UI around them)
- Max **3 attachments**, max **4 MB total** per submission, images (PNG/JPEG/WebP/GIF) and short video
  (MP4/MOV/WebM). SVG is refused. This is the Vercel request-body ceiling, not a preference.
- Fields: name (required), company (optional), email (required, becomes Reply-To), subject (required,
  preset choices + "Something else" free text), message (required).
- `budget=not-sure` and `timeline=exploring` are sent hidden — the visitor never sees them.
- Turnstile renders only when `PUBLIC_TURNSTILE_SITE_KEY` is set (same conditional as `pricing.astro`).
- Success is an **inline toast, no navigation** — the visitor stays on the page with a "Send another
  email" action. This is what the owner asked for; do not redirect to `/thank-you`.

## WHAT I VERIFIED MYSELF (do not re-derive)
- Design system: `site/src/styles/tokens.css` (spacing `--space-*`, type `--text-*`, radius, shadows)
  and `site/src/styles/global.css` (`.btn`, `.btn-primary`, `.btn-sm`, `.card`, `.banner`, `.callout`,
  `.form-group`, `.muted`, `.container`, `.section`). Read both before writing the spec.
- There is **no toast component** in the tree. `pricing.astro` uses a `.banner` div with
  `role="status" aria-live="polite"`. Your spec must define a small, non-blocking notification that
  reuses `.banner` semantics if that is the honest fit — say which, with the exact markup.
- Brand red: `--color-primary: #EA0000` is ALREADY the light-theme value, and `--brand-red: #EA0000`.
  Dark theme uses `#EF7D7D` for `--color-primary`, `--color-link`, `--brand-word`; `--color-accent-text`
  is `#C00000` on light (an AA-safe text tint of the same hue). `site/scripts/gen-brand.mjs`
  (`npm run brand`) gates measured contrast pairs — it must still pass after any token change.
- One non-token red exists: `#b00020` at `site/src/pages/portal.astro:192` (`blocked:` toast).
  `--color-error: #C62828` (light) / `#FF6B6B` (dark) is the semantic error colour.
- `site/src/pages/book.astro` is being deleted; its CTA copy ("Book a 15-minute call") appears in
  Header (×2), Footer, 404, about, automations, index, process, thank-you.

## PART A — BRAND RED AUDIT (this is the owner's explicit, emphatic ask)
1. Build a table of EVERY place a red is used: token, hex, light/dark value, and what it paints
   (button fill, logo wordmark, logo symbol, link text, focus ring, error, toast). Cover
   `tokens.css`, `global.css`, every `.astro` under `site/src`, `site/public/*.svg`,
   `site/public/site.webmanifest`, and `site/src/brand/logo.ts`.
2. State plainly whether the tree already ships #EA0000 as the brand red or whether something
   visibly different is being painted. Do not invent work: if it already matches, say so with
   evidence, and fix only what genuinely deviates.
3. Decide and justify the dark theme. The owner says the branding must be #EA0000. If a pink tint is
   kept for small text on dark, justify it by measured contrast and keep it out of the logo/wordmark
   and out of button fills. If you change `tokens.css`, change it and run `npm run brand` — it must
   exit 0 — and record the before/after contrast numbers.
4. `#b00020` at `portal.astro:192` is not a token. Decide: map it to `var(--color-error)` or to a
   brand token, and justify.
5. Name the exact assertion QA should use in the browser: e.g. the computed
   `background-color` of `.btn-primary` must be `rgb(234, 0, 0)` in the light theme.
6. Check the packaged assets too: `site/public/favicon.svg` shows only `#222222` and `#CCCCCC` in my
   read — say whether the icon is missing the brand red and whether that is a defect worth fixing.

## PART B — PAGE SPEC for `/contact`
1. Page intent + H1 + subhead. It must read like writing an email, not like filling in a quote form.
   The owner's phrase "send us an email" is the identity of the page.
2. Field order and exact labels/placeholders/help text, with the email-composer framing (visible
   "To: IMK — 2imk4support@gmail.com" row if that helps it read as an email, then your subject line,
   then the message). Justify if you reject the To: row.
3. Subject presets. The owner's example is "email automation" — propose 5–6 presets that match what
   the business actually sells (workflow automation, AI agent, integration, audit, something else)
   plus the free-text override, with exact strings and a sensible default.
4. Attachment control: button label, accepted types, the "up to 3 files, 4 MB total" helper text,
   per-file chips with remove buttons, the over-limit message (exact words), keyboard-only path,
   and what happens with no JS (the form must still POST — say how).
5. Button label + what happens while sending (disabled state, spinner or text, double-submit guard).
6. SUCCESS TOAST — exact professional copy, the owner's "within 24 hours" promise. Give the exact
   string, the element, its role/aria-live, where it appears (top of form vs fixed), how long it
   stays, and the "Send another email" reset. It must not shift the layout.
7. ERROR states, one string each: validation, file too large, too many files, unsupported type,
   Turnstile failure, rate limited, server error. Each must name what the visitor should do next,
   and none may lose the text they typed.
8. Accessibility: label-for on every control, error association (`aria-describedby`), focus move on
   success and on failure, the file input's screen-reader name, 44×44 targets, reduced motion,
   colour-independent error cues.
9. Mobile: how the composer collapses, and where the toast sits so it is not under the sticky CTA.
10. A short "copy deck" section listing every user-visible string as a table, so Frontend and QA use
    the same words. The FAQ/CTA band elsewhere on the site must say "Email us" — give the exact
    replacement for the string "Book a 15-minute call" and for the footer's "Book a call".
11. Privacy line: the current Calendly cookie warning is obsolete. Give the one-sentence replacement
    about what happens to the email and its attachments.

## BOUNDARIES / FILES
- You write `spec/wave18-contact-email-ux-2026-10-25.md`.
- You MAY edit `site/src/styles/tokens.css` only, and only if Part A proves a real deviation; if you
  do, `npm run brand` must exit 0 and you must report the exact diff.
- Do NOT touch any other source file, any page, any test, DEPLOY.md or site/.env.example.
- No `npm run build`, no git write command.
- Keep every file valid UTF-8. This repo had an ANSI round-trip incident (wave 13) that turned
  em-dashes into mojibake — do not use PowerShell Get-Content/Set-Content pipelines on source files.

## REPORT BACK
DONE or BLOCKED; the spec path; the ONE-LINE verdict on whether #EA0000 is already correct, with the
evidence; any token change and the `npm run brand` result; and the success-toast string verbatim.
