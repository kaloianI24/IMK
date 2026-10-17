# IXI — Wireframes (T3)
Designer — UI/UX. All templates per plan §2–§3. Component names map 1:1 to plan §5 “Components …”. Plain token CSS; both themes. Sticky mobile CTA appears on Home / Services (index + detail) / Work (index + detail) / Pricing only; **hidden on `/book` and 404**.

Conventions used below:
- `Skip link` → `#main` always.
- `Drawer` = mobile nav drawer component.
- `Reserved` = height must be reserved up front (no CLS) — figure/image/skeleton/embed slot.
- Layout: `header / nav` → `<main id="main">` → `footer`; sticky mobile CTA fixed bottom (safe-area-aware, ≥44px).

---

## Global shell (every route)

```
┌─ Skip link (sr-only until focus) ─┐
│ Header [wordmark IXI · nav links · lang-none] │
│ Mobile: header → hamburger → Drawer        │
├───────────────────────────────────┤
│ <main id="main">                   │
│   {page}                            │
├───────────────────────────────────┤
│ Footer: cols × 3 + legal line     │
└───────────────────────────────────┘
  [Sticky mobile CTA — present on: Home, Services Index+Detail, Work Index+Detail, Pricing only; hidden /book + 404]
```
Header nav: Home · Services · Work · Process · Pricing · About · Book a 15-minute call (primary, hard-coded).
Mobile drawer: same items vertically; close on Escape; tab-trapped only while open; no background scroll.

---

## Home `/`

1. Header/nav
2. Hero (grid: copy left · screenshot right, `--aspect-hero` reserved)
   - Eyebrow (optional, semantic accent)
   - H1 "Automations that still work in month six."
   - Sub (1–2 sentences) · inline `tel:`/`mailto:` n/a
   - Primary CTA `Book a 15-minute call` → /book
   - Text link `See how it works` → /process
   - `figure` + caption (real screenshot, `--aspect-hero`, `sizes`; **no stock**)
3. Proof bar (badges: rubish)
4. What I do — 4 × `ServiceCard` in `--container` grid (2×2 desktop, 1×4 mobile)
5. Outcome stats — 3 `stat block` (each one number with caption; provisional labels must be identifiable)
6. Case-study highlight — 1 `CaseCard` + link to /work
7. Process snapshot — 5 `process steps` numbered
8. FAQ teaser — 4 × `Faq` (`<details>`) + link to /pricing
9. Closing CTA band — title, one sentence, primary CTA
10. Footer

CLS reservations: hero `figure` has reserved `--aspect-hero` + explicit width/height; process screenshot slots same.

---

## Services index `/services`

1. Breadcrumbs: Home → Services
2. Page header (H1 + intro ≤2 sentences)
3. 4 × `ServiceCard` (tagline + starting-at + `Learn more`)
4. Proof bar / trust line
5. Closing CTA band
6. Footer

---

## Service detail `/services/{slug}` (×4)

1. Breadcrumbs: Home → Services → {name}
2. Page header (H1 brand-name of offer)
3. Who it’s for (list)
4. The problem in plain words (prose, 720 max)
5. What you get (feature list)
6. How it works (3–5 numbered steps)
7. What’s included / **not included** (in-scope vs out-of-scope two-col lists)
8. Timeline + starting-at price + `Automation Care` option (badge)
9. One numbered case snapshot (`CaseCard` mini)
10. FAQ (3–4 `Faq` items)
11. CTA band (`Start an automation audit` primary)
12. Footer

---

## Work index `/work`

1. Breadcrumbs: Home → Work
2. Page header
3. Filter-free grid of 3 × `CaseCard` (problem → one outcome number → sector tag)
4. **Empty-state slot** reserved: "No case studies yet — sample projects below." if collection is empty
5. Closing CTA band
6. Footer

---

## Case detail `/work/{slug}` (×3 sample)

1. Breadcrumbs: Home → Work → {sector?
2. Page header (H1) + sector tag + prominent `Sample project` badge (visible to sighted + SR, not colour-only)
3. `Sample project` disclaimer line
4. Context (prose, 720 max)
5. Problem
6. Approach (prose + screens/diagram `figure`, reserved `--aspect-card`)
7. Execution (list)
8. Result (one outcome number, large stat)
9. Testimonial card (only when verified & attested; otherwise rendered as empty-state copy slot)
10. CTA band
11. Footer

---

## Process `/process`

1. Breadcrumbs: Home → Process
2. Page header
3. 5 `process steps` (discovery → audit & plan → build in your accounts → handover & training → care/monitoring)
4. Ownership statement (prominent block) + the full "Who owns the automations, accounts, and data — and how do I leave?" answer (mechanism; pricing cross-link)
5. Communication/cadence (weekly updates, docs, training)
6. CTA band ("Book a 15-minute call")
7. Footer

---

## Pricing `/pricing`

1. Breadcrumbs: Home → Pricing
2. Page header
3. Anchor table — 3 offers + retainer (`PricingTable`)
4. "What drives price" (prose + list)
5. In-scope/out-of-scope lists (in-out)
6. Revision limits
7. FAQ block: revisions · scope · ownership/exit · **breakage + Automation Care SLA** · maintenance
8. Application form `#apply` (Budget select, Timeline radio group, name/email/company/project, honeypot hidden, `startedAt` hidden)
9. Trust/response-time promise line
10. Footer

CTA label unique to page: `Start an automation audit` (form submit). Persistent header/footer CTA still `Book a 15-minute call`.

---

## About `/about`

1. Breadcrumbs: Home → About
2. Page header
3. Story (prose, 720 max)
4. Values (3-up, icon optional)
5. Credentials (list)
6. Avatar/photo slot (`figure`, reserved, real photo — no stock; `avatar/photo` component)
7. Availability line
8. CTA band
9. Footer

---

## Book `/book`

1. Page header H1 + 3-sentence "what happens next" (all three qualification paths)
2. Trust block (response-time promise, monitoring)
3. Calendar embed wrapper (reserved height, lazy-loaded after trigger; `preconnect` Calendly only on this route)
4. `<noscript>` fallback: direct Calendly link + intake form → `/api/contact`
5. Calendly-failed-iframe fallback link (same fallback)
6. Third-party embeds privacy notice (Calendly cookies) **before** calendar interaction
7. Intake form (≤3 field fallback + budget + timeline) — see Pricing §3. CTA `Start an automation audit` (submit)
8. Trust block (security/privacy line)
9. Footer

Sticky mobile CTA **hidden** here. (Sticky CTA only Home/Services/Work/Pricing.)

---

## Thank-you `/thank-you` (`noindex, follow`)

1. Header (lighter or full; keep skip link)
2. Confirmation block (H1 + lead)
3. “What happens next” (numbered steps)
4. Response-time promise
5. Links to pricing/process (text links only; no primary CTA per plan? Plan §2 CTA matrix — use `Book a 15-minute call` persistent only)
6. Prep checklist
7. Footer

---

## Privacy `/privacy` & Terms `/terms` (shared LEGAL template)

1. Page header (H1)
2. Prose body (720 max), links, headings hierarchy
3. Footer

Legal template includes: effective date line, section anchors optional.

---

## 404 (hidden from sitemap; `noindex, follow`)

1. 404 block (large “404” + heading + one sentence)
2. Primary CTA: `Book a 15-minute call` (persistent CTA matrix: 404 has a destination)
3. Links to Home / Services / Work
4. Footer (minimal)

Sticky mobile CTA **hidden** here.

---

## Component inventory mapping (plan §5 → templates)

- skip link · header/nav (desktop + mobile drawer) · footer · button (primary/secondary/ghost, hover/active/focus/disabled) · text link · badge/pill · proof bar · stat block · service card · case-study card · testimonial card · process steps · pricing table/card · FAQ `<details>` · CTA band · form field/textarea/select/radio group · inline validation + error summary · success state · calendar embed wrapper (reserved) · breadcrumbs · 404 block · sticky mobile CTA (safe-area aware, ≥44px) · `figure`/captioned image · avatar/photo · empty-state copy slot · loading skeleton · prose/list styling (in-scope/out-of-scope blocks) · `Image` (Astro `<Image />`, aspect tokens, `sizes`).

Templates that **must** include each:
- Skeleton: any page with JS-injected blocks (Book calendar, form success swap, theme-less — actually all multi-step heavy).
- Empty-state slot: Work grid; Case detail testimonial; Home case highlight.
- Figure/caption: Home hero, service how-it-works, case approach/execution, About avatar, Book trust block image (optional).

---

## CLS reservation rules (T3 acceptance)

- Every `figure`/`Image` carries explicit aspect-ratio token (hero 16/9; card 4/3; avatar 1/1 or 4/5) + width/height attributes.
- Skeleton blocks reserve final dimensions; injected results keep placeholder box.
- Form error summary + inline errors: reserve space / appearance-only with no shift beyond announced region; sticky CTA safe-area-aware (no overlap with error summary at ≤375px: sticky CTA lives below, error summary scrolls above submit).
- Calendly wrapper: reserved height in CSS (`aspect-ratio` + min-height) holds even JS-off.
- Fonts: preloaded subset + `font-display: swap`; accept swap shift measured under CLS budget.

---

## Notes for QA

- Wireframes are structural, not pixel-perfect; spacing values use token scale.
- Mobile-first; desktop adds columns at ≥768.
- Dark mode verified against both OS `color-scheme` values × desktop + mobile (per §9 Themes).
