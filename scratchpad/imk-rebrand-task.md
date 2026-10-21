# TASK: Rebrand IXI → IMK, new red #EA0000, new support email

Owner: Frontend Developer · Coordinator: Manager · Date: 2026-10-19
Working folder: `C:\Users\Kalch\Documents\IXI` · site: `C:\Users\Kalch\Documents\IXI\site`

## Owner's exact words
> EA0000 this is the new red color please change any red with it and i changed the text on
> the logo is not IXI no more it is IMK make sure to change any IXI to IMK i made a email
> for support or contact overall it is 2imk4support@gmail.com

## 1. New logo artwork (owner replaced `../Logo` tonight — OLD PATHS ARE GONE)

New layout (verified by pixel sampling):

| Asset | Path | Content |
|---|---|---|
| Wordmark | `Logo/Text/4x/Asset-1@4x.png` (137×75) | spells **IMK**, fill **#EA0000** (234,0,0) |
| Plate | `Logo/BG/4x/Asset-1@4x.png` (640×640) | solid **#222222** charcoal |
| Full lockup | `Logo/Full/xxxhdpi/Asset-1.png` | charcoal plate + grey symbol #CCCCCC + red wordmark |

- There is **no `Logo/Symbol/` folder** any more, and files are named `Asset-1*.png`, not `Artboard 1@4x.png`.
- `scripts/gen-brand.mjs` lines 47–48 read the two old paths and will now crash. Fix the paths.
- The symbol mark is unchanged (same grey #CCCCCC artwork) → **keep the existing traced `SYMBOL` path** in `src/brand/logo.ts`; do not invent one. Cross-check it visually against `Logo/Full/xxxhdpi`.
- Run `npm run brand` so `src/brand/logo.ts` is regenerated from the new IMK wordmark.
- Update the `IXI` / `#720606` comments and the web-manifest `name`/`short_name` in `gen-brand.mjs`.
- `BrandMark.astro` hardcodes the wordmark at 62% of symbol height for a 2.0 ratio; the new ratio is **1.83** (137/75) — adjust if the lockup looks off and check it in the browser.

## 2. Red = #EA0000

Edit `site/src/styles/tokens.css` (light theme):

```
--brand-red          : #EA0000
--brand-mark         : #EA0000
--brand-word         : #EA0000
--color-primary      : #EA0000
--color-focus        : #EA0000
--color-primary-hover: #C00000
--color-primary-active:#A80000
--color-link         : #C00000     (hover #A80000)
--color-accent-text  : #C00000     (NEW token)
```

**Evidence / why.** Measured contrast:

| #EA0000 on | ratio | verdict |
|---|---|---|
| `--color-bg` #F7F1E8 | 4.16 | ✗ below AA 4.5 for text |
| `--color-neutral-soft` #E8E0D4 | 3.57 | ✗ below AA 4.5 for text |
| `--color-surface` #FFFCF7 | 4.56 | ✓ |
| cream label on #EA0000 (button bg) | 4.56 | ✓ |
| as a graphic / focus ring (≥3:1) | 4.16 | ✓ |

So: use **#EA0000** for brand surfaces, graphics, buttons and focus; use **#C00000** (darker tint of the *same* hue: 5.77 on bg, 6.33 on surface, 4.95 on neutral-soft) wherever the accent is rendered **as text**.

Swap these *text* usages from `--color-primary` → `--color-accent-text`:
`src/styles/global.css` (`.btn-ghost` color, `.nav a:hover`, `.breadcrumbs a:hover`), `src/components/CaseCard.astro` ("Read more →"), `src/components/ServiceCard.astro`, `src/components/ReviewForm.astro` (3 spots), `src/components/Testimonials.astro`, `src/pages/portal.astro` ('done' status).

Update the accessibility gate in `scripts/gen-brand.mjs`: check the **text** pairs (`--color-accent-text`, `--color-link` on bg/surface/surface-2/neutral-soft) at **4.5**, and `--color-primary` + `--brand-*` at **≥3:1** (graphic/background use). Keep `npm run brand` **green** — do **not** lower the 4.5 text bar.

Dark theme: do **not** use #EA0000 (3.65–4.06 on dark = fails). Keep the existing dark tints (#EF7D7D / #F79A9A, 6.4–9.06) — same red family.
Leave the semantic status colours (`--color-success`, `--color-warning`, `--color-error`) alone.

`site/public/og.svg` and `site/scripts/gen-og.mjs` use #E04B67 and the text "IXI" → change the red to **#EA0000**, the word to **IMK**, then regenerate `site/public/og.png`.

## 3. Rename IXI → IMK (user-visible text, titles, aria-labels, manifest, OG)

~40 inventoried hits. Every page's `BaseLayout` `title`/`description`; `index.astro` structured-data `name` + hero/lockup `aria-label`; `Header.astro` `aria-label`; `Footer.astro` `sr-only` + copyright; `login.astro` (h1, title, description); `login/verify.astro`; `portal.astro` (title, description, copy); `about` / `privacy` / `terms` / `404` / `thank-you` / `automations` / `services` / `work` / `pricing` / `process`; `site/public/site.webmanifest` (`name`, `short_name`).

Keep class names (e.g. `.brand-wordmark`) and the repo folder name `C:\...\IXI` unchanged.

Internal identifiers — change consistently (pre-launch):
`sessionStorage` keys `ixi_portal_role` / `ixi_portal_email` (`src/pages/login/verify.astro` + `src/pages/portal.astro`), form id `ixi-contact` (`src/pages/pricing.astro` + its inline script), temp-dir name in `scripts/dev-portal.js`. Note the logout effect in the report.

Placeholder URLs → `imk`, still placeholders: `src/layouts/BaseLayout.astro:19` and `astro.config.mjs:6` `https://www.ixi.example` → `https://www.imk.example`; `src/pages/book.astro` CALENDLY default `https://calendly.com/ixi/15-min` → `https://calendly.com/imk/15-min`. Flag both; do **not** invent a real domain or a real booking link.

## 4. Contact email → 2imk4support@gmail.com

Replace the placeholder `hello@ixi.example` in `src/pages/login.astro:23` and `src/pages/portal.astro:167`; render it as a `mailto:` link. Do not guess any other address.

## Constraints
Do **not** edit `api/`, `site/functions/` (Backend Developer owns those), `site/.env*`, or `spec/`.

## Verification (real, with evidence)
1. `npm run brand` → green, all contrast checks pass.
2. `npx astro check` → 0 errors.
3. `npm run build` → succeeds.
4. Serve and check real HTTP: `/` 200, `/login` 200, `/register` 404, `/portal` 200.
5. `grep -ri "ixi"` over `site/src`, `site/public`, `site/dist` → justify every remaining hit.
6. Real browser: header/footer logo reads **IMK**, the red is the new one, home loads first.
7. Stop any server you start; say which ports you left free.

## Report
Status DONE/BLOCKED · files changed · exact commands + observed output · leftover placeholder URLs.
