# Wave 18a — Architect: the /contact "email us" page, technical design

REPO: C:\Users\Kalch\Documents\IXI (branchless, permanently dirty shared tree — never run a git write
command: no reset/clean/checkout/stash. Other agents work here.)

OWNER REQUEST (verbatim intent, 2026-10-25):
Remove the "book a 15-minute call" flow and Calendly entirely. Replace it with "send us an email":
clicking the CTA opens an on-site email page the visitor uses to send us an email directly from the
site. Fields: who they are, their company, their own email (so we can continue the conversation and
they receive our reply), a subject/header (example they gave: "email automation"), and a description
of what they want. They can attach images/videos. On send, a small notification says something like
"thanks for the email — we'll review and reply within 24 hours", phrased professionally.

## YOUR DELIVERABLE
`spec/wave18-contact-email-design-2026-10-25.md` — ONE page, decisions only, no code. Every decision
names the file it lands in and the check that proves it. This is the contract Backend and Frontend
build against, so be exact about request/response shapes.

## FACTS I VERIFIED MYSELF (do not re-derive)
- `api/contact.ts` is the only contact endpoint. It accepts `application/json`,
  `application/x-www-form-urlencoded` and — incorrectly — anything containing `multipart`, which it
  parses as `new URLSearchParams(rawBody)` (`api/contact.ts` parse block). There is no multipart
  parser and no attachment support anywhere in the tree.
- `MAX.body = 8192` bytes in both `api/contact.ts` and `site/functions/api/contact.ts`. The Vercel
  twin also has a Turnstile verify → validation → honeypot → time trap → per-IP rate limit → Resend
  → redacted log pipeline. `site/functions/api/contact.ts` is the Cloudflare twin with a KV counter.
- Resend is called with `fetch('https://api.resend.com/emails', ...)` — no SDK, no dependency.
  `RESEND_FROM` defaults to `IMK <2imk4support@gmail.com>`, `RESEND_TO`/`CONTACT_TO` is the owner inbox.
  When `RESEND_API_KEY` or a destination is missing the handler does NOT send and still answers ok
  (locally that must stay true — it is how QA tests offline).
- `site/src/pages/pricing.astro` posts JSON to `/api/contact` and redirects to `/thank-you`.
  `site/src/pages/book.astro` is the Calendly page (client-only embed, `CALENDLY_URL` with a hardcoded
  `https://calendly.com/imk/15-min` fallback, plus a noscript form that POSTs `budget=not-sure` /
  `timeline=exploring`).
- `CALENDLY_URL` is in `site/.env.example` only. `site/public/_headers` CSP allowlists
  `assets.calendly.com` and `calendly.com` in script-src/img-src/connect-src/frame-src.
- `astro.config.mjs` is `output: 'static'`, `trailingSlash: 'never'`. There are 16 API routes under
  `api/` served by 7 function files via `vercel.json` rewrites; `npm run check:routes` guards them.
  Adding a *page* does not touch that gate.
- 15 files reference `/book` or "Book a 15-minute call": Header (×2), Footer, 404 (×2), about,
  automations, index (×2), pricing (×1 anchor only), privacy, process (×2), thank-you (×2), book.astro.
- The brand red is already `#EA0000` (`site/src/styles/tokens.css` `--color-primary`, `--brand-red`).
  Dark theme currently uses `#EF7D7D` for `--color-primary` and `--brand-word`. One non-token red
  exists: `#b00020` at `site/src/pages/portal.astro:192` (`blocked:` toast colour).

## DECISIONS I NEED (answer each, one short paragraph)
1. **Route + redirect.** New page `/contact`. `/book` must not 404 for existing links/bookmarks.
   Choose the mechanism for BOTH targets (Vercel `redirects` in `vercel.json`; Cloudflare
   `site/public/_redirects`), state the exact entries and the status code. Say whether `book.astro`
   is deleted. Confirm the sitemap does not keep a dead `/book` entry.
2. **Attachment transport.** Vercel caps a serverless request body at 4.5 MB. Decide the cap and
   justify it: I am setting the PRODUCT limit at max 3 files, max 4 MB total per submission.
   Confirm that fits under the platform cap with multipart overhead, and name the exact server and
   client limits (bytes, count, per-file type/size) and what the client shows when exceeded.
3. **Parser.** Where does the multipart parser live so both `api/contact.ts` and
   `site/functions/api/contact.ts` use ONE implementation (the tree's habit is `site/shared/server/`)?
   Name the file, the exported API, and every guard: part count, header size, filename length,
   total bytes, missing boundary, truncated body, `Content-Length` lies. Zero new dependencies —
   say so explicitly and name the Node/Web APIs you rely on (the Vercel handler gets an
   `IncomingMessage`; the Cloudflare twin gets a `Request`).
4. **File safety.** MIME allowlist (images: png/jpeg/webp/gif; video: mp4/quicktime/webm), magic-byte
   sniffing vs trusting the client `Content-Type`, filename sanitisation, no path traversal, no
   executable/HTML/SVG, what happens to a file that fails. State whether SVG is allowed (I say NO —
   it is an XSS vector in an email attachment context).
5. **Resend payload.** Exact JSON: `from`, `to`, `reply_to` (the visitor's address, so a plain Reply
   continues the thread), `subject`, `html`/`text`, `attachments: [{filename, content}]` base64.
   State the total encoded-size guard and what happens if it exceeds it. State the header-injection
   defence for `subject` and `reply_to` (CR/LF stripping) and the HTML-escaping rule for every
   user-supplied value in the HTML body.
6. **Response contract.** Exact JSON for success and each failure with HTTP status and `code`:
   `ok`, `emailed` (false when no key in dev), `code` for `validation`, `payload-too-large`,
   `too-many-files`, `unsupported-file`, `rate-limited`, `turnstile`, `internal`. Frontend must be
   able to show a specific message per case. Confirm `type: 'contact'` stays the default so the
   pricing form is unaffected, and that `budget`/`timeline` stay required for `type=contact`
   (the new page will send `not-sure`/`exploring` exactly as `book.astro` does today).
7. **Abuse + logging.** Reuse the existing Turnstile, honeypot, time-trap and rate-limit path.
   State what is logged on a submission with attachments: counts and byte sizes only — never a
   filename, never a body, never the attachment bytes, never the visitor's address unredacted.
8. **CSP / env cleanup.** The exact new `site/public/_headers` CSP line with Calendly removed
   (`frame-src` should become `'none'` or drop to what is still needed — say which, and check
   `challenges.cloudflare.com` is still allowed). State that `CALENDLY_URL` is removed from
   `site/.env.example` and name anything else that must go.
9. **What you are NOT deciding.** Copy, layout and colour belong to the Designer; implementation
   belongs to Backend and Frontend. Say where your design stops.

## BOUNDARIES
- You write ONLY `spec/wave18-contact-email-design-2026-10-25.md`. No product, test, doc or harness
  file. No `npm run build`. No git write command.
- If a decision needs the owner (e.g. a paid storage service), say so and choose the zero-cost path.

## REPORT BACK
DONE or BLOCKED, the spec path, the 9 decisions in one line each, and every assumption that could
make Backend or Frontend stop.
