# IXI Phase 1 — Color & Theming Research
### Ruby Red + Milky White palette, light/dark tokens, WCAG AA verification

**Project:** IXI automation studio marketing site  
**Owner (this section):** Designer — UI/UX  
**Phase:** 1 — Research only; no implementation yet.  
**Related sections:** `01-analyst-service-sites-conversion.md`, `04-architect-perf-seo-security-stack.md`.

---

## 1. Brand color direction

- **Primary brand hue:** ruby red, selected at **`#B01C3B`** in light mode and shifted to **`#E04B67`** in dark mode.
- **Milky white / light canvas:** warm off-white **`#F7F1E8`** (not `#FFFFFF`). Pure white is reserved for small raised surfaces (`#FFFCF7`) to keep the site from feeling sterile.
- **Dark canvas:** warm near-black **`#121012`**, with surface steps `#1F1B1E` and `#2A2428`.
- **Dark-mode text:** milky off-white **`#F6F1EA`**, not pure `#FFFFFF`.
- Ruby is a **brand/accent** color. Error and form validation states use separate semantic reds so users do not read every error as "brand."

Rationale for the dark-mode ruby shift: `#B01C3B` is too dark to read as an accent on a near-black background (it falls to roughly 4.85:1 on `#121012` even at large sizes). The dark-mode accent `#E04B67` keeps the same ruby family (hue ~13–17° in OKLCH), but raises lightness so links, icons, focus rings, and buttons clear WCAG AA.

---

## 2. Light theme tokens (`prefers-color-scheme: light`)

| Token | Hex | OKLCH (approx.) | Use |
|---|---|---|---|
| `--color-bg` | `#F7F1E8` | `oklch(96.0% 0.014 78.3)` | Page background |
| `--color-surface` | `#FFFCF7` | `oklch(99.2% 0.007 80.7)` | Cards, sections, raised panels |
| `--color-surface-2` | `#FFFDF9` | `oklch(99.6% 0.004 82)` | Inputs, chips |
| `--color-text` | `#171315` | `oklch(19.2% 0.008 346.1)` | Body and headings |
| `--color-text-muted` | `#4F474A` | — | Secondary/supporting text |
| `--color-text-subtle` | `#6B6367` | — | Captions, metadata |
| `--color-primary` | `#B01C3B` | `oklch(49.3% 0.180 16.7)` | Primary buttons, logo accent, key emphasis |
| `--color-primary-hover` | `#911631` | `oklch(42.8% 0.156 15.8)` | Hover state |
| `--color-primary-active` | `#78112A` | — | Pressed state |
| `--color-on-primary` | `#FFFCF7` | — | Text/icons on ruby fills |
| `--color-link` | `#911631` | `oklch(42.8% 0.156 15.8)` | Inline links in body text |
| `--color-border` | `#D8CEC0` | — | Default borders |
| `--color-border-strong` | `#BFB3A3` | — | Input outlines, dividers |
| `--color-focus` | `#B01C3B` | `oklch(49.3% 0.180 16.7)` | Focus ring (3px) |
| `--color-success` | `#2E6F40` | — | Success state |
| `--color-warning` | `#8A4F00` | — | Warning text/state |
| `--color-error` | `#C62828` | — | Form errors and destructive actions |
| `--color-neutral-soft` | `#E8E0D4` | — | Disabled surfaces |

---

## 3. Dark theme tokens (`prefers-color-scheme: dark`)

| Token | Hex | OKLCH (approx.) | Use |
|---|---|---|---|
| `--color-bg` | `#121012` | `oklch(17.6% 0.005 325.8)` | Page background |
| `--color-surface` | `#1F1B1E` | — | Cards, sections, raised panels |
| `--color-surface-2` | `#2A2428` | — | Inputs, chips, code surfaces |
| `--color-text` | `#F6F1EA` | `oklch(96.0% 0.011 76.6)` | Body and headings |
| `--color-text-muted` | `#B7AEA7` | — | Secondary/supporting text |
| `--color-text-subtle` | `#9E9590` | — | Captions, metadata |
| `--color-primary` | `#E04B67` | `oklch(62.6% 0.185 13.2)` | Accent links, icons, focus, emphasis |
| `--color-primary-hover` | `#EC6580` | — | Hover/focus emphasis |
| `--color-primary-active` | `#C93A56` | — | Pressed state |
| `--color-on-primary` | `#171315` | — | Text/icons on bright ruby fills |
| `--color-link` | `#E04B67` | `oklch(62.6% 0.185 13.2)` | Inline links in body text |
| `--color-border` | `#3A3338` | — | Default borders |
| `--color-border-strong` | `#5A5058` | — | Input outlines, dividers |
| `--color-focus` | `#F38CA2` | — | Focus ring (3px) |
| `--color-success` | `#5FBF7A` | — | Success state |
| `--color-warning` | `#FFC266` | — | Warning text/state |
| `--color-error` | `#FF6B6B` | — | Form errors and destructive actions |
| `--color-neutral-soft` | `#2F292D` | — | Disabled surfaces |

---

## 4. Contrast verification (WCAG 2.2, calculated)

Contrast formula used: WCAG relative luminance + `C = (L1 + .05)/(L2 + .05)`.  
Thresholds: body text **≥ 4.5:1**, large text/UI non-text **≥ 3:1**, focus indication **≥ 3:1** against adjacent colors where possible.

### Light theme

| Pair | Ratio | Result |
|---|---:|---|
| Text `#171315` on background `#F7F1E8` | 16.40:1 | AA/AAA |
| Muted `#4F474A` on background `#F7F1E8` | 8.02:1 | AA |
| Subtle `#6B6367` on surface `#FFFCF7` | 5.69:1 | AA |
| Primary ruby `#B01C3B` on background `#F7F1E8` | 6.08:1 | AA |
| On-primary `#FFFCF7` on primary `#B01C3B` | 6.61:1 | AA |
| Link `#911631` on background `#F7F1E8` | 7.91:1 | AA |
| Success `#2E6F40` on background `#F7F1E8` | 5.40:1 | AA |
| Warning `#8A4F00` on background `#F7F1E8` | 5.85:1 | AA |
| Error `#C62828` on background `#F7F1E8` | 5.01:1 | AA |
| Focus ring `#B01C3B` vs background `#F7F1E8` | 6.08:1 | AA |

### Dark theme

| Pair | Ratio | Result |
|---|---:|---|
| Text `#F6F1EA` on background `#121012` | 16.86:1 | AA/AAA |
| Muted `#B7AEA7` on background `#121012` | 8.68:1 | AA |
| Muted `#B7AEA7` on surface `#1F1B1E` | 7.80:1 | AA |
| Subtle `#9E9590` on surface `#1F1B1E` | ~6.3:1 (estimate) | AA — verify in implementation |
| Primary accent `#E04B67` on background `#121012` | 4.85:1 | AA for normal text, strong for large/UI |
| On-primary `#171315` on primary `#E04B67` | 4.71:1 | AA for normal button text |
| Link `#E04B67` on background `#121012` | 4.85:1 | AA for links at 16px+; use underline + weight, not color alone |
| Hover `#EC6580` with on-primary `#171315` | 5.91:1 | AA |
| Focus ring `#F38CA2` on background `#121012` | 8.19:1 | AA |
| Border `#3A3338` with text `#F6F1EA` | 10.93:1 | AA |
| Success `#5FBF7A` on background `#121012` | 8.32:1 | AA |
| Warning `#FFC266` on background `#121012` | 11.87:1 | AA |
| Error `#FF6B6B` on background `#121012` | 6.83:1 | AA |

Notes for QA/implementers:
- In dark mode, helper captions below `#9E9590` should be tested against their actual parent surface before release.
- Do not use primary ruby as the only signal for links; keep underline or font-weight differences.
- Buttons should use `--color-on-primary`, not arbitrary white, so contrast is deliberate.

---

## 5. `prefers-color-scheme` implementation pattern

### Token-first CSS (recommended)

```css
:root {
  color-scheme: light dark;

  /* Light theme tokens */
  --color-bg: #F7F1E8;
  --color-surface: #FFFCF7;
  --color-text: #171315;
  /* ...all light tokens... */
  --color-primary: #B01C3B;
}

@media (prefers-color-scheme: dark) {
  :root {
    /* Dark theme override */
    --color-bg: #121012;
    --color-surface: #1F1B1E;
    --color-text: #F6F1EA;
    /* ...all dark tokens... */
    --color-primary: #E04B67;
  }
}

html {
  background-color: var(--color-bg);
  color: var(--color-text);
}

@media (prefers-color-scheme: dark) {
  html { color-scheme: dark; }
}
@media (prefers-color-scheme: light) {
  html { color-scheme: light; }
}
```

Important details:
- Put `color-scheme: light dark` on `:root` so native form controls, scrollbars, and browser UI match the OS theme.
- Prefer OS-driven theming first. An optional `[data-theme="..."]` toggle can be added later, but only after the system-preference default is verified.
- Use tokens everywhere; avoid hard-coded hex in components.
- Avoid FOUC by ensuring the initial HTML has the default background color and no theme flash. If a manual toggle is later added, store the choice in `localStorage` and inject a tiny blocking script before first paint to set `data-theme`. Until then, do not ship a toggle; follow `prefers-color-scheme`.
- Test `prefers-reduced-motion`, `prefers-contrast`, and forced-colors separately; red focus rings may need `outline` adjustments in forced-colors mode.

---

## 6. Ruby red pitfalls and rules

1. **Red-as-error confusion:** Keep brand ruby for marketing emphasis/buttons; use separate semantic reds (`#C62828` light / `#FF6B6B` dark) for validation errors. Error messages should also include icons/text, not color alone.
2. **Red text on white:** Saturated ruby often fails small-text contrast. Use darker ruby (`#911631`) for inline links and body-size brand text; use bright ruby for large UI, buttons, and marks.
3. **Hover/active states:** Do not lighten hover; for light theme darken to `#911631`, then `#78112A`. For dark theme start lighter at `#E04B67`, hover at `#EC6580`, active at `#C93A56`.
4. **Button contrast:** Text on ruby fills must be chosen per theme: milky white on dark ruby in light mode, dark text on bright ruby in dark mode.
5. **Focus visibility:** Red on red can disappear for colorblind users; use a 3px ring plus offset and do not rely on color alone.
6. **Overuse:** If ruby is everywhere, it stops signaling action. Reserve it for primary CTAs, logo/wordmark, active navigation, and one highlighted proof metric.
7. **Colorblind accessibility:** Red/green pairs are not sufficient. Use shape, label, or icon differences for success/error states.

---

## 7. Supporting tools and validation methods

- OKLCH for palette generation and hue/chroma consistency (`oklch()` in CSS Color Module Level 4/5).
- WebAIM Contrast Checker or direct WCAG luminance calculation for every text/UI pair.
- Figma color styles / design tokens; export to CSS custom properties.
- Browser DevTools Accessibility panel and ` forced-colors` emulation.
- Lighthouse/axe/Playwright accessibility checks in Phase 4.
- Optional: OKLCH palette generators, Polypane/Tailwind token export, style-dictionary for token management.

---

## 8. Actionable conclusions

1. Use `#F7F1E8` as the default light background and `#121012` as the default dark background; avoid pure `#FFFFFF`/`#000000`.
2. Use `#B01C3B` as the light-mode brand ruby and `#E04B67` as the dark-mode accent ruby; keep hue within the same ruby family.
3. Treat ruby as a brand/accent color; use separate semantic reds for errors.
4. Implement theme switching first through `prefers-color-scheme`, with token-only CSS and `color-scheme: light dark` on `:root`.
5. Do not ship a theme toggle until the OS-preference default is verified; if added later, prevent FOUC with a blocking pre-paint script.
6. Require 4.5:1 for body text and 3:1 for large/UI; all proposed normal-text pairs in this report meet AA.
7. Inline links should use darker ruby in light mode and the brighter ruby in dark mode, always with underline/weight cues.
8. Focus rings must be 3px, offset, and high contrast on both backgrounds.
9. For dark-mode primary buttons, use bright ruby fills with dark text to maintain contrast.
10. Phase 2 design system should adopt these custom property names as the canonical token API.

### Final recommended palette (ready for Phase 2)

**Light theme**

| Token | Value |
|---|---|
| `--color-bg` | `#F7F1E8` |
| `--color-surface` | `#FFFCF7` |
| `--color-text` | `#171315` |
| `--color-text-muted` | `#4F474A` |
| `--color-primary` | `#B01C3B` |
| `--color-primary-hover` | `#911631` |
| `--color-primary-active` | `#78112A` |
| `--color-on-primary` | `#FFFCF7` |
| `--color-border` | `#D8CEC0` |
| `--color-focus` | `#B01C3B` |
| `--color-error` | `#C62828` |

**Dark theme**

| Token | Value |
|---|---|
| `--color-bg` | `#121012` |
| `--color-surface` | `#1F1B1E` |
| `--color-text` | `#F6F1EA` |
| `--color-text-muted` | `#B7AEA7` |
| `--color-primary` | `#E04B67` |
| `--color-primary-hover` | `#EC6580` |
| `--color-primary-active` | `#C93A56` |
| `--color-on-primary` | `#171315` |
| `--color-border` | `#3A3338` |
| `--color-focus` | `#F38CA2` |
| `--color-error` | `#FF6B6B` |

---

**Open questions for the owner (none blocking if defaults are accepted):**
1. Should the site support an explicit light/dark theme toggle in addition to `prefers-color-scheme`, or should it strictly follow OS preference at launch?
2. Is `#B01C3B` (warm ruby) acceptable, or should the brand use a slightly cooler/deeper ruby such as `#9E1B32`?
3. Should success states use green as proposed, or a neutral checkmark/badge to reduce red/green colorblind friction?

*Reported by Designer — UI/UX as DONE for Phase 1 Topic 3. File: `C:\Users\Kalch\Documents\IXI\research\03-designer-color-theming.md`.*
