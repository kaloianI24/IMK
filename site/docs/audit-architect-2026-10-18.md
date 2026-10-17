# IXI — Architect deep-dive audit (2026-10-18)

**Owner:** Architect — Technical Design
**Scope:** Repo layout, `src/` structure, naming conventions, CSS/token strategy, hosting/CI posture, and fit of recently added work against `spec/interface-spec.md` and `plan/00-phase2-plan.md`.
**Status:** Read-only audit. No files changed.
**Evidence base:** Verified against actual files in `C:\Users\Kalch\Documents\IXI` and `C:\Users\Kalch\Documents\IXI\site`. `npm run check` → 0 errors, 0 warnings (3 pre-existing hints in `site/scripts/_contrast.mjs` / `_debug-trace.mjs`). `npm run build` → 18 pages. No `.git` anywhere (root or `site/`), confirmed via filesystem check.

---

## Executive summary

The site builds cleanly and the recent UI work (hero logo, review form, testimonials) is functional, but there are **structural problems that will compound** once more than one person touches the code:

1. **No version control.** There is no `.git` in the root or in `site/`, yet `.github/workflows/ci.yml` triggers on push/PR to `main`. CI cannot run, there is no history/diff/rollback, and nothing is safely reviewable or shippable. This is the single biggest gap.
2. **Two parallel sources of truth.** `design/tokens.css` (root) and `site/src/styles/tokens.css` are byte-identical; both claim to be "single source of truth." Brand artwork exists in `design/` (`wordmark-light.svg`, `wordmark-dark.svg`, `favicon.svg`) and as generated path data in `site/src/brand/logo.ts`. Drift is guaranteed.
3. **Review form bypasses the project's own abuse pipeline.** `ReviewForm.astro` posts to a Formspree placeholder (`https://formspree.io/f/YOUR_FORM_ID`) instead of `/api/contact`, violating spec invariant I-7 ("No third-party form host"). CSP `form-action 'self'` would block the POST anyway.
4. **Hardcoded placeholder testimonials.** `Testimonials.astro` renders invented client quotes ("Alex R.", "Morgan T.", "Jordan K.") as if real. Violates the honesty principle and plan D7 (sample work must be labelled). The spec defines a `testimonialSchema` in the content layer that should be used instead.
5. **Multiple naming deviations from the spec.** Collection key `cases` vs spec `caseStudies`; directory `cases/` vs spec `case-studies/`; frontmatter `cta` vs spec `primaryCTA`; service file names don't match spec (`b2b-ai-agent.md` vs `ai-agents.md`, etc.).
6. **Debug scripts pollute the quality gate.** `site/scripts/` holds ~16 underscore-prefixed one-off scripts; `_contrast.mjs` and `_debug-trace.mjs` are the only remaining `astro check` hints (unused vars). `_qa-sweep.mjs` hardcodes an absolute Windows path.
7. **Pre-launch hazards.** HSTS `max-age=31536000` is enabled in `public/_headers` though spec §8 says post-launch only. `SITE_URL` defaults to `https://www.ixi.example` (canonical URLs, sitemap, OG would point at nothing). CSP lists `api.resend.com` (server-only) in client `connect-src` and omits Plausible.

---

## Prioritized findings

### Blocker — must fix before anything ships

**B1 — No version control.**
- Path: repo root `C:\Users\Kalch\Documents\IXI` and `site/`
- Evidence: `.git` absent at both levels; `.github/` absent at root (ci.yml only exists inside `site/.github/workflows/`)
- Why it matters: The CI workflow references `push`/`pull_request` to `main` but there is no git history, no remotes, no diffs, no rollback, and no way to review changes. CI can never run.
- Fix: `git init` at repo root; add a thorough `.gitignore` (`.env`, `.env.*`, `node_modules/`, `dist/`, `.astro/`, `.lighthouseci/`, `scratchpad/`, `.obsidian/`, `*.log`); review what belongs in version control (plan/spec/research/design/copy yes; `site/node_modules`, `site/dist`, `site/.astro`, `site/.lighthouseci` no); create the remote and push.
- Consequence of skipping: No safe collaboration, no CI, no rollback, no audit trail.

---

### High — must fix before launch

**H1 — Review form bypasses `/api/contact` (spec invariant I-7 violation).**
- Path: `site/src/components/ReviewForm.astro:6` (`formAction = 'https://formspree.io/f/YOUR_FORM_ID'`)
- Why it matters: Spec §I-7: "All form submission and webhook work goes through `/api/contact`. No third-party form host." The site already ships `functions/api/contact.ts` with Turnstile, rate limiting, honeypot, time trap, Resend, and redacted logging. Bypassing it means an unprotected third-party processor holds customer data, there is no spam protection, and CSP `form-action 'self'` (`public/_headers:7`) would block the POST in production anyway.
- Fix: Rewire `ReviewForm` to POST to `/api/contact` with a `type=review` discriminator (extend the contact function to accept it), or gate the review behind the same abuse pipeline. Remove the Formspree placeholder entirely.
- Consequence of skipping: Unprotected public form, third-party data processor, CSP breakage, spec violation.

**H2 — Placeholder `SITE_URL` ships in canonical URLs, sitemap, OG tags.**
- Path: `site/astro.config.mjs:6` (`'https://www.ixi.example'`); `site/src/layouts/BaseLayout.astro:19` (same default)
- Why it matters: Every canonical link, sitemap entry, and OG image URL would resolve to a non-existent domain. SEO and social sharing are broken on deploy.
- Fix: Replace the fallback with the real production domain (must come from the user — see NEEDS INPUT below). Commit `.env.example` with the real domain; never ship `ixi.example`.

**H3 — HSTS enabled pre-launch.**
- Path: `site/public/_headers:6` (`Strict-Transport-Security: max-age=31536000; includeSubDomains`)
- Why it matters: Spec §8 explicitly gates HSTS to post-launch only. Enabling a one-year HSTS policy before the domain stabilises risks locking visitors out if the domain or hosting moves.
- Fix: Comment out HSTS until post-launch (as the spec's commented block already indicates). Add it back only after the domain is stable.

**H4 — Hardcoded placeholder testimonials presented as real client quotes.**
- Path: `site/src/components/Testimonials.astro:14-39` (`defaultItems` with invented names "Alex R.", "Morgan T.", "Jordan K.", companies "IXI Client", "Service Business", "B2B Team")
- Why it matters: Violates the honesty principle — these are fabricated social proof presented as genuine. Plan D7 requires sample work to be explicitly labelled. The spec defines `testimonialSchema` (quote, name, role) in the content layer; the component should consume real/labelled testimonials from collections, not hardcoded fiction.
- Fix: Either label every placeholder as "Sample testimonial" pending real client consent, or remove the section until real testimonials exist. Drive content from `src/content/` via `getCollection('testimonials')` (add collection to `content.config.ts` if needed).
- Consequence of skipping: Fake trust signals; credibility risk if a visitor recognises invented names/companies.

---

### Medium — must fix before M1/M2 quality gate

**M1 — Duplicate token source of truth.**
- Path: `design/tokens.css` (root) ≡ `site/src/styles/tokens.css` (byte-identical, verified). Both headers claim "single source of truth."
- Why it matters: Any edit to one must be mirrored to the other or the site and design docs drift. The spec (`src/content.config.ts`, `src/types/contracts.ts`) is owned by T2/Architect; Designer's tokens are the styling source. Two locations = guaranteed divergence.
- Fix: Declare `site/src/styles/tokens.css` as the authoritative runtime token file (it's imported by `BaseLayout.astro`). Move `design/tokens.css` to a reference/archive role or generate it from the site file. Add a CI check that fails if they diverge.

**M2 — Brand artwork duplicated across two locations.**
- Path: `design/wordmark-light.svg`, `design/wordmark-dark.svg`, `design/favicon.svg` vs `site/src/brand/logo.ts` (generated from `../Logo` artwork by `scripts/gen-brand.mjs`)
- Why it matters: `logo.ts` is the single source of truth for rendered SVG (per its header comment and `BrandMark.astro`'s import). The `design/` SVGs are reference exports that can drift from the traced paths used on the site.
- Fix: Declare `site/src/brand/logo.ts` (+ `scripts/gen-brand.mjs`) as authoritative for all rendered brand marks; `design/*.svg` are design-time references only. Document this in `design/brand.md`.

**M3 — Content collection naming deviates from spec.**
- Path: `site/src/content.config.ts:32` (`cases` collection, base `./src/content/cases`); `site/src/pages/index.astro:14` (`getCollection('cases')`)
- Spec reference: `spec/interface-spec.md:124` (`caseStudies` collection, base `./src/content/case-studies/`); frontmatter field `primaryCTA` (§2) vs actual `cta` (`content.config.ts:28`)
- Why it matters: A new contributor reading the spec cannot map it to code. Collection names, directory names, and frontmatter fields are inconsistent with the authoritative spec.
- Fix: Rename collection to `caseStudies`, directory to `case-studies/`, frontmatter field to `primaryCTA`. Update `index.astro` and all case-study frontmatter. Add a CI drift check between spec and code.

**M4 — Service file names deviate from spec.**
- Path: `site/src/content/services/` contains `b2b-ai-agent.md`, `integration.md`, `audit.md`
- Spec reference: `spec/interface-spec.md:135` lists `workflow-automation.md`, `ai-agents.md`, `systems-integration.md`, `internal-tools.md`
- Why it matters: Spec-defined file names don't exist; actual names are different. Routing (`/services/${s.id}`) works but doesn't match the planned URL structure.
- Fix: Rename files to match spec (`ai-agents.md`, `systems-integration.md`, `internal-tools.md`) or update the spec. Keep routing in sync either way.

**M5 — Currency/price mismatch with plan.**
- Path: `site/src/content/services/workflow-automation.md:33` (`startingAt: "from £1,500"`); `site/src/types/contracts.ts:8-12` (£ labels); `index.astro:28` (`£600`); `index.astro:123` (`£600`)
- Spec/plan reference: `plan/00-phase2-plan.md` D4 (USD `$`), D6 (Automation Care `$250/mo`), §4 pricing anchors (`$750`, `$1,500`, `$5,000`, `$250/mo`)
- Why it matters: Plan and spec declare USD; the site renders GBP (`£`). Copy and config disagree on the money the business charges.
- Fix: Align on one currency (owner decision — default USD per plan D4). Update service frontmatter, contracts labels, and homepage copy consistently.

**M6 — Debug scripts pollute `site/scripts/` and the quality gate.**
- Path: `site/scripts/_audit.mjs`, `_contrast.mjs`, `_contrast2.mjs`, `_contrast3.mjs`, `_debug-rule.mjs`, `_debug-side.mjs`, `_debug-sym.mjs`, `_debug-sym2.mjs`, `_debug-trace.mjs`, `_debug-trim.mjs`, `_debug-tune.mjs`, `_qa-sweep.mjs`, `_verify-trace.mjs`, `_verify-wordmark.mjs`, `trace.mjs` (14 debug/one-off scripts) vs legitimate generators `gen-brand.mjs`, `gen-og.mjs`
- Evidence: `_contrast.mjs` and `_debug-trace.mjs` are the only `astro check` hints (unused variables). `_qa-sweep.mjs:5` hardcodes `C:/Users/Kalch/Documents/IXI/site/dist` — breaks on any other machine or CI.
- Why it matters: One-off debugging tools live in the committed project tree, fail `astro check`, and hardcode local paths. CI quality gate is noisy.
- Fix: Move all `_debug-*`, `_verify-*`, `_contrast*`, `_qa-sweep.mjs`, `trace.mjs`, `_audit.mjs` out of the committed tree (to `scratchpad/` or delete after use). Keep `gen-brand.mjs` and `gen-og.mjs` as committed build generators. Add `scripts/` to `.gitignore` or a `scripts/archive/` folder.

**M7 — Form layer deviates from spec contract.**
- Path: `site/functions/api/contact.ts`
- Deviations vs `spec/interface-spec.md §3`:
  - Honeypot field is `website`; spec says `_hp`
  - Time-trap field is `ts` (epoch ms number); spec says `startedAt` (ISO 8601 string)
  - Rate limit is `LIMIT = 5` per IP hour only; spec says 3/IP/h + 3/email/h + 10/email/24h with hashed keys
  - Log line includes `budget` and `timeline` in plain text; spec §3.10 forbids content fields in logs
- Why it matters: The function is functional but drifts from the pinned contract. Frontend (T8/T9) and QA (T14) build against the spec; mismatches cause integration defects.
- Fix: Align `contact.ts` with spec §3 (`_hp`, `startedAt`, email dimension keys, redacted log schema). Treat spec as the source of truth; any deviation is a spec edit first.

**M8 — Inconsistent brand variant between header and footer.**
- Path: `site/src/components/Header.astro:8` (`variant="wordmark"`); `site/src/components/Footer.astro:7` (`variant="lockup"`)
- Why it matters: Header shows just "IXI"; footer shows symbol + wordmark side-by-side. Inconsistent brand treatment across the same page.
- Fix: Make footer match header (`variant="wordmark"`) or deliberately distinguish them with a documented reason.

**M9 — Inline `style=` workaround on hero wrapper.**
- Path: `site/src/pages/index.astro:51-56` (`style="display:flex;flex-direction:column;..."`)
- Why it matters: The inline style is a workaround for a stale dev-server stylesheet (verified this session). It should not be needed — scoped CSS in the `<style>` block already declares the same layout. Inline styles bypass the token system and are harder to maintain.
- Fix: Remove the inline `style=` attribute; rely on the scoped `.hero-section__logo-wrapper` CSS (already correct). Investigate why the dev server served stale CSS (Vite cache) and document a restart step.

**M10 — Misleading class name.**
- Path: `site/src/pages/index.astro:51` (`hero-section__logo-wrapper`) now wraps only the symbol mark (`BrandMark variant="symbol"`), no wordmark.
- Why it matters: The class name implies a lockup (logo + wordmark) but holds a single mark. Confusing for contributors.
- Fix: Rename to `hero-section__mark` or `hero-section__symbol`, or keep the wrapper generic (`hero-section__brand`). Update scoped CSS accordingly.

**M11 — CSP mismatches.**
- Path: `site/public/_headers:7`
- Issues: `connect-src` lists `https://api.resend.com` (server-only domain; never called from the browser); omits Plausible (`https://analytics.plausible.io`) which spec §8 requires; `script-src` lacks Plausible/GTM hosts though analytics is planned.
- Why it matters: CSP is either too permissive (resend.com client-side) or too restrictive (analytics blocked). Spec §8 M5 requires live verification against actual page loads.
- Fix: Remove `api.resend.com` from client `connect-src`; add Plausible hosts; verify against a live page in M5.

**M12 — Empty `src/data/` directory.**
- Path: `site/src/data/` (0 entries)
- Why it matters: An empty directory signals unfinished structure or a missing data layer. Either populate it or remove it to avoid confusion.

---

### Low — nice to have, polish

**L1 — `.env.example` placeholder values.**
- Path: `site/.env.example` (all values are `ixi.example`, `hello@ixi.example`, `calendly.com/ixi`, `pk_xxx`, `sk_xxx`)
- Why it matters: `.env.example` is committed and should show the *shape* of config, not look like real credentials. Placeholder domains will be copied by whoever sets up deployment.
- Fix: Keep the structure but make placeholders unmistakable (`YOUR_DOMAIN`, `YOUR_KEY`). Add a comment that production values go in Cloudflare dashboard only.

**L2 — Review form a11y/TS polish.**
- Path: `site/src/components/ReviewForm.astro:189-239` (client `<script>` uses `as HTMLFormElement` casts; star-rating labels have no visible keyboard focus ring beyond the radio's)
- Why it matters: The star rating uses visually-hidden radio inputs; keyboard users can tab but focus indication on labels is weak. The `as` casts are fine in client-side JS but not type-checked.
- Fix: Add `focus-visible` styling to star labels; consider `aria-valuenow`/`aria-valuetext` on the radiogroup.

**L3 — Currency label drift in contracts.**
- Path: `site/src/types/contracts.ts:8-12` (£ labels: "Under £1,000")
- Why it matters: Contract labels should match the plan's USD pricing.
- Fix: Align with M5 decision.

---

## Recommended target structure

Below is the target repo layout I recommend. The `site/` folder is the Astro application; everything else at root is project documentation/assets that supports it.

```
IXI/                              (git root — INITIALISE THIS)
├── .gitignore                    (env, node_modules, dist, .astro, .lighthouseci, scratchpad, .obsidian)
├── plan/                         (phase plans — version controlled)
├── spec/                         (interface spec — version controlled, source of truth for types)
├── research/                     (Phase 1 research reports)
├── design/                       (Design-system source: brand.md, wireframes.md, tokens.css reference)
│   ├── tokens.css                (DESIGN-TIME reference only; runtime lives in site/src/styles/tokens.css)
│   ├── wordmark-light.svg        (design-time reference)
│   ├── wordmark-dark.svg         (design-time reference)
│   ├── favicon.svg               (design-time reference)
│   └── brand.md
├── copy/                         (copy deck — version controlled)
├── Logo/                         (owner artwork exports — version controlled, do not edit)
├── scratchpad/                   (temporary notes, one-off debug scripts — NOT version controlled, or gitignored)
├── .obsidian/                    (personal notes — gitignored)
├── site/                         (Astro application — version controlled)
│   ├── .github/workflows/ci.yml  (CI — moves to root .github/ after git init)
│   ├── .env.example              (shape only, no real secrets)
│   ├── .gitignore
│   ├── astro.config.mjs          (real SITE_URL, no ixi.example fallback)
│   ├── package.json
│   ├── package-lock.json
│   ├── .node-version
│   ├── .lighthouserc.cjs
│   ├── public/                   (built brand assets: favicon.svg, og.png, etc.)
│   ├── functions/
│   │   └── api/contact.ts        (align with spec §3: _hp, startedAt, email keys, redacted log)
│   ├── scripts/
│   │   ├── gen-brand.mjs         (KEEP — generates logo.ts + favicons)
│   │   ├── gen-og.mjs            (KEEP — generates OG image)
│   │   └── archive/              (MOVE all _debug-* / _verify-* / _contrast* / _qa-sweep.mjs / trace.mjs here)
│   ├── src/
│   │   ├── brand/logo.ts         (AUTHORITATIVE — generated path data, do not edit by hand)
│   │   ├── content/
│   │   │   ├── services/         (workflow-automation.md, ai-agents.md, systems-integration.md, internal-tools.md)
│   │   │   └── case-studies/     (RENAMED from cases/ — 3 sample .md files)
│   │   ├── content.config.ts     (collections: services, caseStudies; field primaryCTA)
│   │   ├── styles/tokens.css     (AUTHORITATIVE runtime tokens)
│   │   ├── styles/global.css
│   │   ├── types/contracts.ts    (USD labels, align with plan D4)
│   │   ├── components/
│   │   │   ├── Header.astro      (BrandMark variant="wordmark")
│   │   │   ├── Footer.astro      (BrandMark variant="wordmark" — match header)
│   │   │   ├── BrandMark.astro
│   │   │   ├── ReviewForm.astro  (POST /api/contact, type=review — NO Formspree)
│   │   │   ├── Testimonials.astro (consume from content layer, label samples)
│   │   │   ├── ServiceCard.astro
│   │   │   ├── CaseCard.astro
│   │   │   ├── Seo.astro
│   │   │   ├── Breadcrumbs.astro
│   │   │   ├── StickyCta.astro
│   │   │   └── CtaBand.astro
│   │   ├── layouts/BaseLayout.astro
│   │   ├── pages/index.astro     (no inline style=; hero-section__mark class)
│   │   └── ...
│   └── docs/
│       ├── ops/rollback.md
│       └── audit-2026-10-18.md   (this report + Code Reviewer + DevOps consolidated)
```

## Naming standard (one house convention)

| Element | Convention | Examples |
|---|---|---|
| Content collection keys | kebab-case, plural, noun | `services`, `caseStudies` |
| Content directories | kebab-case, plural | `services/`, `case-studies/` |
| Frontmatter fields | camelCase | `primaryCTA`, `caseSnapshot`, `heroImageSlot` |
| CSS classes | BEM-ish: `block__element--modifier` | `hero-section__mark`, `review-form__card` |
| Components | PascalCase `.astro` | `BrandMark.astro`, `ReviewForm.astro` |
| Pages | kebab-case `.astro` | `index.astro`, `pricing.astro` |
| Scripts | descriptive, no underscore prefix unless internal/archive | `gen-brand.mjs`, `gen-og.mjs` |
| Type/enum exports | PascalCase types, UPPER_SNAKE constants | `CtaRole`, `CTA_ROLES` |
| Env vars | UPPER_SNAKE | `TURNSTILE_SECRET_KEY`, `SITE_URL` |

Rule: **Spec is the source of truth for types/enums/field names.** Code imports from `src/content.config.ts` and `src/types/contracts.ts`; never redefines them. Any new field is added to the spec first.

---

## Fit of recent work against intent (spec + plan)

| Recent addition | Intent (spec/plan) | Fit | Conflict |
|---|---|---|---|
| `ReviewForm.astro` | Form submissions via `/api/contact` with Turnstile + rate limiting (spec I-7, §3) | Poor | Posts to Formspree placeholder; bypasses entire abuse pipeline; CSP `form-action 'self'` blocks it |
| `Testimonials.astro` | Testimonials from content layer (`testimonialSchema` in spec §2); sample work labelled (plan D7) | Poor | Hardcoded invented client quotes presented as real; no "sample" label; bypasses content collections |
| Hero `BrandMark symbol` | Inline vector logo, theme-aware, no `` (spec D15, plan §5) | Good | Inline `style=` workaround should be scoped CSS only |
| Header `variant="wordmark"` | Sticky header shows name only (plan §2 persistent CTA) | Good | Footer still uses `lockup` — inconsistent |
| `src/data/` (empty) | Reserved for data layer | Neutral | Empty directory — populate or remove |

---

## What must be fixed vs nice-to-have

**Must fix (blocker + high + medium):**
1. `git init` + remote (B1)
2. Rewire ReviewForm to `/api/contact`; remove Formspree (H1)
3. Real `SITE_URL` / domain (H2)
4. Remove HSTS pre-launch (H3)
5. Label or remove hardcoded testimonials; use content layer (H4)
6. Declare one authoritative tokens file (M1)
7. Declare `logo.ts`/`gen-brand.mjs` as brand source of truth (M2)
8. Align collection/directory/field names with spec (M3, M4)
9. Align currency with plan (M5)
10. Move debug scripts out of committed tree (M6)
11. Align `contact.ts` with spec §3 contract (M7)
12. Match footer brand variant to header (M8)
13. Remove inline `style=` from hero wrapper (M9)
14. Rename `hero-section__logo-wrapper` (M10)
15. Fix CSP (M11)

**Nice to have:**
- `.env.example` placeholder hygiene (L1)
- Review form a11y/TS polish (L2)

---

## One thing I need from you

Before I can finalize the hosting section (and before any real deploy), I need two facts:

1. **What's the real production domain?** Is `ixi.example` a stand-in for a domain you own, or is the domain not bought yet? This determines `SITE_URL`, canonical URLs, CSP, cookie domain, and Cloudflare custom-domain setup.
2. **Where do you intend to host?** The repo is clearly built for Cloudflare Pages + Pages Functions (`functions/`, `public/_headers`, `CF_PAGES_PROJECT`). Is that still the plan, or are you open to Netlify/Vercel?

Once you answer, I can complete the hosting/CI portion of this audit with exact commands and config snippets. Everything else above is verified against actual files and ready to act on.

Report artifact: `C:\Users\Kalch\Documents\IXI\site\docs\audit-architect-2026-10-18.md`