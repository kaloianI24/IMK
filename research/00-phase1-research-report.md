# IXI — Phase 1 Research Report (merged)

**Project:** IXI — website for an automation freelancer/studio
**Phase:** 1 — Research (complete)
**Compiled by:** @Manager (Orchestration · Task assignment · Delivery)
**Date:** 2026-10-15
**Status:** Phase 1 DONE — pending owner answers, then Phase 2 gate

This report merges the three specialist research files into one document:

| Section | Owner | Source file |
|---|---|---|
| Topics 1, 2, 6 — service-site structure, conversion UX, reference sites | @Product Analyst — Requirements Specialist | [`01-analyst-service-sites-conversion.md`](01-analyst-service-sites-conversion.md) |
| Topic 3 — ruby + milky-white palette, light/dark tokens, WCAG AA | @Designer — UI/UX | [`03-designer-color-theming.md`](03-designer-color-theming.md) |
| Topics 4, 5 — performance, SEO, WCAG 2.2, form security, tech stack | @Architect — Technical Design | [`04-architect-perf-seo-security-stack.md`](04-architect-perf-seo-security-stack.md) |

No code was written in Phase 1. Every claim below is traceable to the source files; source URLs are listed inside them.
Statistics quoted from third-party blogs are **directional, not guarantees** — the Analyst flagged each one in source.

---

## 1. Executive summary

1. **Structure:** a lean 6–7 page site, one consistent primary CTA ("Book a 15-minute call") on every page, one primary action per page. No 8-item service catch-all.
2. **Positioning:** lead with the client's problem and outcome, not the tool stack. Automation buyers' dominant fears are *silent failure after handover* and *vendor lock-in* — both are addressable with documented handover, credentials in the client's accounts, and a paid maintenance/monitoring offer.
3. **Trust:** two layers — verifiable third-party proof (partner directories, marketplace listings, named reviews) plus human proof (real photo, response-time promise, written scope).
4. **Pricing:** publish "starting at" anchors with written in/out-of-scope boundaries plus a monthly care retainer; keep a bespoke-quote path for complex work.
5. **Conversion:** dedicated `/book` page with an inline calendar and ≤3-field intake; progressive lead capture by intent; no competing exits.
6. **Brand:** ruby `#B01C3B` on milky `#F7F1E8` (light) and ruby `#E04B67` on near-black `#121012` (dark), all normal-text pairs verified ≥4.5:1 by calculation. Ruby stays an accent; errors use separate semantic reds.
7. **Stack:** Astro (SSG, TypeScript) on Cloudflare Pages, custom Pages Function for the form (honeypot + time trap + Cloudflare Turnstile + server-side validation + rate limiting), Calendly embed on `/book` only, self-hosted fonts, cookieless analytics.
8. **Quality gate:** Lighthouse ≥90 (mobile lab), CWV green (LCP ≤2.5s, INP ≤200ms, CLS ≤0.1), WCAG 2.2 AA, JSON-LD + sitemap/robots, security headers.

---

## 2. Topic 1 — Service-site structure & messaging (Analyst)

- **IA:** Home · Services index + one page per service (2–5 services) · Work/Case studies index + detail · Process · Pricing · About · Contact/Book. Route budget in Phase 2 plan.
- **Rule:** every core page has exactly **one primary action**; secondary actions live as text/footer links ("one exit path, not five").
- **Messaging formula:** *"I help [audience] achieve [outcome] with [service/method]"*, tightened by the **stranger test** — a first-time visitor must understand in one sentence who you serve and what problem you solve.
- Outcomes beat services; specificity beats cleverness ("save 14 hours/week on invoice processing" > "we build automations").
- Positioning around the freelancer's tool skill rather than the client's problem is a documented bounce driver.

## 3. Topic 2 — Conversion UX (Analyst)

- **CTAs:** verb-first, outcome-named, matched to buyer state. "Book a 15-minute call" / "Schedule an automation audit" / "Get a custom quote". Avoid "Contact us / Submit / Learn more". Minimum placement: persistent nav + hero + end of major sections + sticky mobile bar.
- **Destination must match the promise** — "Book a call" must open a calendar, not a generic form. Collapse funnels to 1–2 steps.
- **Forms:** TOFU 1–2 fields; service-page form 4–6 fields single-step; book-a-call ≤3–4 fields then calendar inline. Single column. Qualifiers as buttons/ranges, not free text. Inline validation, accessible errors, real success state + response-time promise.
- **Booking:** guest booking (no forced account), inline calendar (not popup), one 15-minute slot type, availability resolved on page, confirmation details, cancellation policy, responsive single column.
- **"What happens after you submit"** 3-sentence block and a substantive thank-you page are the highest-leverage additions.
- **Lead capture without trust damage:** progression by intent (magnet → qualifying form → calendar), genuinely useful magnet, cookie-based de-dupe on return visits, no popups over the booking button on mobile.
- **Conversion killers (QA red list):** buried/generic CTAs, hidden phone, promise≠destination, long booking forms, forced accounts, multi-column forms, five competing CTAs, no "what next", no proof near the CTA, wall-of-text case studies, heavy autoplay media.

## 4. Topic 6 — Reference sites (Analyst, all 7 fetched and inspected)

| Site | Strongest takeaway |
|---|---|
| GolmTech — golmtech.solutions | Third-party-verifiable proof (published marketplace apps) beats self-declared stats |
| Automation Ace — automationace.com | Trust dashboard built only from third-party-verifiable numbers; $25/wk monitoring offer |
| Nex Automations — nex-automations.com | Published ranges with fixed written scope + $99/mo maintenance retainer = 2026 benchmark |
| Frederik Daneels — frederikdaneels.com | "Automation as a service"; documented handover, month-to-month, no lock-in |
| IOA Digital — ioadigital.com/make-com-agency/ | "Credential, not identity" honesty + a "when NOT to use Tool X" section |
| FIMM Digital — fimmdigital.com | "Anyone can connect two apps. The hard part is month six" — survive-month-six positioning |
| Cortex — cortexautomatedsolutions.com | Productized pilot/retainer/custom price ladder as a qualifying device |

**Avoid across the board:** inconsistent self-published numbers, long tiered service lists, dense tool-logo walls without a client-benefit line, thin early-stage pages with placeholder bios.

## 5. Topic 3 — Colour & theming (Designer)

- **Light:** bg `#F7F1E8`, surface `#FFFCF7`, text `#171315`, primary ruby `#B01C3B` (hover `#911631`, active `#78112A`), on-primary `#FFFCF7`, border `#D8CEC0`, focus `#B01C3B`, error `#C62828`, success `#2E6F40`.
- **Dark:** bg `#121012`, surface `#1F1B1E`, text `#F6F1EA`, accent ruby `#E04B67` (hover `#EC6580`, active `#C93A56`), on-primary `#171315`, border `#3A3338`, focus `#F38CA2`, error `#FF6B6B`, success `#5FBF7A`.
- Dark ruby shifts lighter on purpose: `#B01C3B` on `#121012` is too weak to read as an accent.
- **Verified pairs** (calculated): body text 16.40:1 light / 16.86:1 dark; ruby on bg 6.08:1 light / 4.85:1 dark; on-primary pairs 6.61:1 / 4.71:1; focus rings 6.08:1 / 8.19:1. All normal-text pairs meet AA.
- **Flagged for re-verification at implementation:** dark `--color-text-subtle` `#9E9590` on its real parent surface (estimate ~6.3:1).
- **Pattern:** tokens on `:root`, dark override in `@media (prefers-color-scheme: dark)`, `color-scheme: light dark`, no hard-coded hex in components. No toggle at launch (OS preference only) unless the owner requests one; a later toggle needs a pre-paint blocking script to avoid FOUC.
- **Ruby pitfalls:** keep brand ruby separate from error red, use darker ruby for small inline text, never lighten hover in light mode, reserve ruby for primary CTAs / wordmark / active nav / one highlighted metric, never signal by colour alone.

## 6. Topics 4 & 5 — Performance, SEO, a11y, form security, stack (Architect)

- **Performance targets:** LCP ≤2.5s, INP ≤200ms, CLS ≤0.1, Lighthouse mobile ≥90. Static generation, AVIF/WebP with explicit dimensions, self-hosted subset fonts with `font-display: swap`, single purged stylesheet, near-zero JS, booking embed lazy-loaded only on `/book`.
- **SEO:** one H1 per page, title ~50–60 chars, meta ~120–160, OG/Twitter cards, canonical, sitemap + robots, `ProfessionalService`/`Service`/`FAQPage` JSON-LD (only markup visible content), single-language English for v1.
- **WCAG 2.2 AA:** contrast, visible focus (2.4.7 + 2.4.11), target size 2.5.8 (≥24px, aim 44px on touch), keyboard reachability + skip link, reduced motion, labelled fields with `aria-describedby` errors, semantic landmarks, no drag-only interactions, `aria-live` status messages.
- **Form security (layered):** honeypot → time trap → **Cloudflare Turnstile** (server-verified) → strict server-side validation → email-injection prevention → per-IP/per-email rate limiting → Origin/Content-Type checks instead of cookie sessions → security headers (CSP with Calendly/Turnstile allowlists, `frame-ancestors`, `Referrer-Policy`, `Permissions-Policy`, HSTS). No reCAPTCHA.
- **GDPR:** self-hosted fonts, cookieless analytics (no banner needed), privacy policy with lawful basis + minimisation + deletion contact, no pre-checked marketing consent, Calendly's own cookie notice documented in the policy.
- **Recommended stack:** **Astro (SSG, TypeScript) + Cloudflare Pages + Pages Function form endpoint + Turnstile + Calendly embed on `/book` + cookieless analytics (Plausible/Umami)**. Rejected for v1: Next.js (heavier, no DB/CMS need), Eleventy/plain HTML (acceptable fallback but weaker DX), Framer/Webflow (recurring cost, lock-in, weaker perf control for a dev-owned studio).

---

## 7. Consolidated actionable conclusions (merged, de-duplicated)

1. Lean 6–7 page IA; **one primary CTA "Book a 15-minute call"** everywhere; one primary action per page.
2. Outcome-led hero that passes the stranger test; tooling is secondary and shown as verified proof, not as identity.
3. Publish 4 focused services, each with its own page, deliverables, timeline, revision limits and in/out-of-scope boundaries.
4. Publish "starting at" anchors + a bespoke-quote path + a named monthly care retainer; state what drives price.
5. Ship 3 clearly-labelled case studies using Context → Problem → Approach → Execution → Result → Testimonial, plus short outcome cards; label sample work honestly.
6. Two-layer trust: third-party-verifiable badges/metrics above the fold + human proof (photo, response-time promise, documented handover, monitoring).
7. Dedicated `/book` page: inline calendar + ≤3-field intake + "what happens next" block + substantive thank-you page.
8. Progressive capture by intent; remove competing exits; `tel:` click-to-call on mobile.
9. Ruby is an accent, never the error colour; light/dark tokens exactly as specified; OS-preference theming at launch.
10. Astro + Cloudflare Pages; Layers of anti-spam; strict server-side validation; email injection prevention; rate limiting; security headers.
11. Lighthouse ≥90 mobile, CWV green, WCAG 2.2 AA in both themes, valid JSON-LD, sitemap/robots.
12. Self-hosted fonts, cookieless analytics, privacy policy, data minimisation, deletion path.

---

## 8. Open questions from Phase 1 + Manager's proposed defaults

The owner has not answered these yet. To keep the project moving, **Phase 2 planning proceeds on the defaults marked "Default"**; each is a one-line change if the owner overrides it. Defaults are documented again in the Phase 2 plan.

| # | Question (role) | Manager's proposed default |
|---|---|---|
| 1 | Case studies: real client results with permission, or labelled sample projects? (Analyst) | Ship 3 clearly-labelled **sample/representative projects**; swap in real client work the moment permission exists |
| 2 | Pricing posture and currency? (Analyst) | Publish "starting at" anchors in **USD ($)**, 3 offer levels + care retainer; note as changeable |
| 3 | Which 2–5 services / any vertical? (Analyst) | 4 services (workflow automation, AI agents/chatbots, systems/API integration, internal tools/dashboards); no single vertical, name 3 example sectors |
| 4 | Booking model + response-time target? (Analyst) | Inline calendar-first on `/book` with ≤3 fields; application-style form on `/pricing`; reply **within 1 business day, target <4 business hours** |
| 5 | One-off builds only or also a managed retainer? (Analyst) | Offer **both**; retainer named "Automation Care" |
| 6 | Platforms + data residency? (Analyst) | Showcase **Make, n8n, Zapier**; advertise self-hosted n8n / data-residency option |
| 7 | Brand assets, language, domain? (Analyst) | Designer creates the **IXI wordmark + favicon + OG template**; copy in **English**; domain TBD, deploy to a temporary Cloudflare Pages URL |
| 8 | Capacity signal? (Analyst) | Publish "currently accepting new projects" only — **no numeric scarcity** unless it is real |
| 9 | Explicit light/dark toggle? (Designer) | **Follow OS preference at launch**, no toggle |
| 10 | Accept `#B01C3B` ruby? (Designer) | **Yes**, `#B01C3B` light / `#E04B67` dark |
| 11 | Success colour? (Designer) | Keep green `#2E6F40` / `#5FBF7A` but always pair with an icon + text |
| 12 | Target market/language? (Architect) | **English, single-language v1** |
| 13 | Public address for LocalBusiness schema? (Architect) | **No public address** → use `ProfessionalService` + `areaServed: Worldwide`, no fabricated address |
| 14 | Route leads into the owner's own automations? (Architect) | **Yes** — email notification to the owner + optional webhook, behind a toggle |
| 15 | Calendly vs Cal.com? (Architect) | **Calendly** for v1; revisit Cal.com if EU/data residency becomes a requirement |

---

## 9. Phase 1 gate

- All three deliverables exist at the paths requested, with sources cited: `01-…` (35.8 KB), `03-…` (12.5 KB), `04-…` (14.5 KB).
- No code was written; research only, per project rules.
- Phase 2 planning is authorised to start on the defaults in §8; Phase 3 build still requires owner approval of the Phase 2 plan.
