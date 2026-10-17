# Phase 1 — Topic 4 & 5 Research: Performance/SEO/Accessibility/Form Security + Tech Stack
**Project:** IXI — marketing/service site for an automation freelancer/studio
**Owner:** Architect — Technical Design
**Date:** 2026-10-15
**Scope:** Research only (no building).

---

## 1. Performance

### Targets
- **Core Web Vitals (field, p75):** LCP ≤ 2.5s, INP ≤ 200ms, CLS ≤ 0.1. These are Google ranking signals and UX floor.
- **Lighthouse Performance (mobile lab): ≥ 90.** Lab is stricter than field; treat 90 as the shipping gate per project rules.
- For a small static marketing site, 90+ is achievable without heroic effort if we avoid client-side bloat.

### Strategy for a small marketing site
1. **Static generation by default.** No server render on request; pre-rendered HTML.
2. **Images:** modern formats (AVIF → WebP fallback), responsive `srcset`/`sizes`, explicit width+height to prevent CLS, lazy-load below-the-fold, hero image `loading="eager"` + `fetchpriority="high"`, max 1–2 hero; compress (Sharp / Squoosh).
3. **Fonts:** self-host (see §1.3). Subset to used glyphs (Latin/Latin-ext) + `font-display: swap`. Preload woff2. Variable font if more than two weights.
4. **CSS:** single minified stylesheet, inline critical CSS for above-the-fold if needed, purge unused. Target < 50KB total CSS.
5. **JS:** ship as little as possible. Island/hydration model (Astro) or none. No animation libraries on the critical path; respect `prefers-reduced-motion`. Avoid tag managers, chat widgets, and marketing scripts that block LCP.
6. **Third parties:** Calendly/booking embed loads only on the contact booking route, not globally; analytics (Plausible or Fathom) single async script, no cookie banner needed. No reCAPTCHA (heavy + privacy).
7. **Caching/CDN:** immutable hashed asset filenames + long max-age; HTML short cache. Serve from edge (Cloudflare Pages/Vercel/Netlify all do this).
8. **Avoid layout shift:** reserved dimensions for images/ads/embeds, `font-display`, no late-injected banners.

### Self-hosted fonts & GDPR
- Self-hosting keeps font requests first-party, removes a third party (Google) and is the GDPR-safe default for EU-facing sites (no IP leakage to Google's servers). Use `@font-face` with `woff2` files in `/fonts`.
- Sources: Monotype "best practices for self-hosting web fonts"; corewebvitals.io; WP-Rocket guide. (monotype.com, corewebvitals.io)

---

## 2. SEO

### On-page essentials
- One H1 per page with the page topic; logical H2/H3 outline matching content.
- `<title>`: brand + key phrase, ~50–60 chars; meta description ~120–160 chars with value prop + CTA.
- Open Graph + Twitter Card tags on every page; canonical URLs; `robots.txt`, XML sitemap (auto-generated).
- `<html lang>` set; fast redirects; no orphan pages.

### Structured data
- Home/About: `ProfessionalService` or `Organization` + `WebSite` with `SearchAction` (optional).
- Local targeting (only if the owner targets a region): `LocalBusiness` subtype with `areaServed`, address (if public), openingHours, telephone, and sameAs social links. Don't fabricate a physical address if there isn't one.
- Service pages: `Service` with `provider`, `serviceType`, `areaServed`.
- FAQ section: `FAQPage` JSON-LD (liftable for AI/SGE answers).
- Keep schema valid; validate with Google Rich Results Test + schema.org validator. Only mark up content visible on the page.
- Reference: Google Search Central Local Business structured data docs; schema.org/LocalBusiness.

### Internationalisation/localisation note
- The brief does not specify a target market. **Default recommendation: single-language English site** with `lang="en"`; if the owner later targets a region, add `hreflang` and a region-specific copy pass rather than auto-translate. Defer localisation decision to the owner (open question).

---

## 3. Accessibility (WCAG 2.2 AA)

Checklist for a marketing site:
- **Contrast:** body text ≥ 4.5:1, large text (≥18pt / 14pt bold) and UI components ≥ 3:1. (Designer's palette already verifies this.)
- **Focus visible:** 2.4.7 (AA) + 2.4.11 Focus Appearance; visible focus ring with ≥3:1 contrast and min 2px outline. Never remove outline without a replacement.
- **Target size:** 2.5.8 ≥ 24×24 CSS px (AA) — spacing or size; AAA is 44×44 (aim 44 for touch CTAs).
- **Keyboard:** tab order matches visual order; no keyboard traps; skip-to-content link; all interactive elements reachable via Tab/Enter/Space.
- **Motion:** `prefers-reduced-motion: reduce` disables non-essential animation/parallax/video autoplay; no seizure-risking flashes.
- **Forms:** each field labelled (`<label for>` or `aria-labelledby`); errors associated via `aria-describedby`; required marked both visually and `aria-required`; autocomplete attributes (name, email, tel); error text not color-only; time-trap/honeypot visually hidden but screen-reader-safe.
- **Structure:** semantic landmarks (header/nav/main/footer), headings in order, alt text on informative images (empty alt for decorative), SVG with `title`/`role`.
- **Drag-free:** no drag-only interactions (2.5.7).
- **Status messages:** `aria-live` for success/error.
- Screen-reader smoke test + automated (axe-core / Lighthouse a11y). Manual keyboard pass required.

### Contrast verification for ruby/milky palette
Defer to Designer's `03-designer-color-theming.md`, which already computes primary pairs. Architect confirms: buttons = white text on ruby brand primary; verify chosen brand ruby (`#B01C3B`) ≥ 4.5:1 against milky white (`#F7F1E8`) when used as small text → likely needs darkening for text use (recommend ruby reserved for accents/large text/buttons per Designer's guidance).

---

## 4. Contact-form security

### Layered defenses (all cheap, stack them)
1. **Honeypot field** (hidden input, e.g. `_hp`): reject if filled; silent accept to not tip off bots. Zero friction.
2. **Time trap** (form-rendered-at timestamp + `action` delay): reject submissions faster than ~3 seconds.
3. **Bot challenge:** **Cloudflare Turnstile** recommended over reCAPTCHA (lighter, more privacy-friendly, invisible/managed widget, no Google cookies). hCaptcha acceptable; reCAPTCHA v3 has privacy/GDPR cost and known UX issues. Verify token server-side.
4. **Server-side validation:** strict allow-list validation of types/length/max size; escape output; normalize email/phone; never trust client.
5. **Email injection prevention:** sanitize newlines and headers; use a mail library with structured fields (to/from/subject/body), not concatenated raw mail. Consider sending via transactional provider (Resend/SendGrid/Postmark) instead of raw SMTP.
6. **Rate limiting:** per-IP and per-email, e.g. 5/15min on endpoint + WAF rule on hosting edge; return generic 429.
7. **CSRF:** if using cookies/sessions → CSRF token + SameSite. For a stateless POST endpoint, rely on Origin/Referer check + content-type + Turnstile + rate limits; no cookie session needed.
8. **Data handling/GDPR:** privacy policy mandatory; lawful basis for contact form = legitimate interest or consent (document choice); data minimization (only needed fields); store submission only as long as needed; disclose in policy; allow deletion request. Don't pre-check marketing consent. If analytics with cookies → consent banner; avoid cookies by using Plausible/Fathom cookieless. Cookie banner required only if non-essential cookies exist.
9. **Google Fonts** → self-host (already recommended) to avoid third-party IP transfer.
10. **HTTPS only**, HSTS, and security headers: `Content-Security-Policy`, `X-Frame-Options`/`frame-ancestors` (Calendly embed domain allow-listed), `Referrer-Policy`, `Permissions-Policy`.

### Form UX (field count)
- Max 4–6 fields; name, email, (company/industry optional), project description (textarea), preferred channel; budget range (optional dropdown) can improve lead quality but raises friction — make it optional or move to second step. Progressive disclosure: optional fields behind "Add details".
- Inline validation on blur; clear, specific error messages; success state with what-happens-next ("We reply within 1 business day").

### Booking flow
- Calendly embed for the booking route only (`/book`), inline or popup. Calendly shows its own cookie banner by default; if using cookieless analytics, you can still keep the Calendly banner — document it in privacy policy. Alternative GDPR-friendly schedulers: Cal.com (self-hostable), meetergo, TidyCal — evaluate if EU audience is primary. Default: Calendly for simplicity, embed lazily.

---

## 5. Tech stack

### Comparison

| Stack | Pros | Cons | Fit for IXI |
|---|---|---|---|
| **Astro** | Zero JS by default, island hydration for interactive bits, Markdown/MDX content, image/font integrations, fast, great Lighthouse, multiple framework support | Smaller ecosystem than Next, needs Node toolchain, overkill if 3 pages only | **Best fit:** content/marketing site with contact form + booking embed |
| **Next.js (App Router)** | Largest ecosystem, SSR/SSG, Vercel deploy, good DX, CMS-friendly | Ships more JS, heavier, App Router complexity, auth/DB mindset overkill for a static site | Fine but heavier; justified only if we need a DB/CMS or member area now |
| **Static HTML/CSS/JS or Eleventy** | Simplest, zero tooling, cheapest, great perf | Hand-rolled components, manual image optimization, less DX, templating less ergonomic | Acceptable if keeping strictly simple; Eleventy still good SSG |
| **Hosted builder (Framer/Webflow)** | Fast to launch, visual editing, decent SEO/hosting | Recurring cost, vendor lock-in, less control over performance/form backend, theming to ruby/milky needs custom code | Good for non-dev owners, but owner is a dev studio; less aligned |

### Form/backend options
- **Formspree / Web3Forms / Getform:** fastest, no backend; spam filtering + email forwarding; free tiers ~25–250 submissions/mo; cost scales with volume; fine for a freelancer inquiry form.
- **Netlify Forms:** only if hosting on Netlify (form detection at build).
- **Custom endpoint / serverless function:** max control (validation, DB storage, CRM integration, custom email via Resend), but more code and ops; recommended when inquiries need routing/automation (fitting for an automation studio) — ironic upside: can route leads into the owner's own automation pipeline.
- **Booking:** Calendly embed (above) or Cal.com.

### Hosting targets
- **Cloudflare Pages:** best free tier, global edge, fastest, supports Pages Functions for the custom endpoint; WAF/rate limiting built-in. **Recommended.**
- **Vercel:** excellent DX, strong image optimization, serverless; free tier generous; good choice if team prefers Next.
- **Netlify:** good, built-in forms; slower edge than Cloudflare.
- **Static VPS:** unnecessary ops; skip unless already owned.

---

## Recommended stack (for Phase 2)

**Astro (SSG, TypeScript) + Tailwind v4 (or CSS variables) + Cloudflare Pages + a custom serverless endpoint (Cloudflare Pages Function) for the contact form with Turnstile, plus Calendly embed for booking, cookieless analytics (Plausible or Umami self-hosted).**

Justification for a solo owner / agency marketing site:
1. Astro ships near-zero JS by default → Lighthouse 90+ by construction, only islands where needed (form, booking).
2. Content is mostly static copy + case studies → fits Astro content collections (MDX) with typed frontmatter; no CMS needed initially.
3. Custom form endpoint on Pages Functions gives control (validation, anti-spam, routing lead into the owner's automations — on-brand) without a backend to run; Turnstile runs at the edge.
4. Cloudflare Pages: free, fast global edge, WAF/rate limits, Pages Functions co-located; supports preview deploys per PR.
5. Tailwind + CSS custom properties maps cleanly onto the Designer's token set (light/dark via `prefers-color-scheme` + `data-theme` override).
6. Alt fallback: Eleventy or plain HTML if the team wants zero tooling; Next.js only if a CMS/DB is added later.

---

## Actionable conclusions (max 10)
1. Ship a **static Astro site on Cloudflare Pages**, target Lighthouse Performance ≥ 90, vitals green (LCP ≤ 2.5, INP ≤ 200, CLS ≤ 0.1).
2. Self-host fonts and images; AVIF/WebP, explicit dims, lazy images; cookieless analytics script only.
3. Reserve ruby for accents/large text/buttons; verify small-text combos with 4.5:1; buttons white-on-ruby.
4. WCAG 2.2 AA checklist: focus ring (≥3:1, 2px), 24px targets (aim 44 for touch), reduced-motion, labelled forms, skip link, semantic landmarks.
5. SEO: one H1/page, meta + OG, sitemap/robots, JSON-LD (ProfessionalService + Service + FAQPage); single-language English v1.
6. Contact form: ≤ 6 fields, inline validation, success "what's next"; optional budget field.
7. Spam stack: honeypot + time trap + **Cloudflare Turnstile** (server-verified) + strict server-side validation + rate limiting + security headers; no reCAPTCHA.
8. GDPR: self-host fonts, cookieless analytics (no banner), privacy policy with lawful basis + data minimization + deletion contact; cookie banner only if non-essential cookies (Calendly banner counts — document it).
9. Booking: lazy-load **Calendly** only on `/book`; evaluate Cal.com if EU/CMS control becomes a requirement.
10. **Open questions for owner:** target market/language; explicit light/dark toggle vs OS-only; public physical address for LocalBusiness schema; whether to store/route leads into the owner's automations; Calendly vs Cal.com.

---

## Sources (selected)
- Core Web Vitals & Lighthouse: developer.chrome.com/docs/lighthouse/performance/performance-scoring; rumvision.com.
- SEO/structured data: developers.google.com/search/docs/appearance/structured-data/local-business; schema.org/LocalBusiness.
- Accessibility: w3.org/WAI/WCAG22/quickref; accessible.org/wcag; deque.com.
- Fonts: monotype.com (self-hosting best practices); corewebvitals.io (self-host Google fonts).
- Form security/GDPR: developers.cloudflare.com (Turnstile; rate limiting); formester.com (2026 techniques); friendlycaptcha.com (Turnstile GDPR); calendly.com (cookie management).
- Tech stack: cosmicjs.com (Astro vs Next); tech-insider.org (2026 comparison); cloudcannon.com (11ty vs Astro); index.dev (framework comparison); netlify.com (Formspree), splitforms.com (form backend alternatives); calendly.com (embed options).

**Status:** DONE. Blockers: none. Implementation not performed (research only).