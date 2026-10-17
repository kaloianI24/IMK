# IXI — Consolidated Good-Practice Audit (2026-10-18)

Reconciles three specialist audits into one prioritised plan:

- Code Reviewer → `site\docs\audit-2026-10-18.md` (complete)
- Architect → `site\docs\audit-architect-2026-10-18.md` (complete)
- DevOps → **failed** (provider error: configured model `qwen3:14b` not found; 0 tool calls). Its hosting/CI scope was re-verified personally by the Manager — findings below marked ✅(Manager).

Where the audits and the Manager's verification disagree, the Manager's on-disk verification wins and the correction is noted.

---

## BLOCKER

### B1 — No version control, and CI is in the wrong folder to ever run
- No `.git` in `C:\Users\Kalch\Documents\IXI` nor `...\IXI\site` (✅ Manager, both audits).
- The workflow exists at `site\.github\workflows\ci.yml` (✅ Manager) — but GitHub only reads `.github/` **from the repository root**. Where `git init` runs therefore determines whether CI works at all.
- **Decision (Manager):** init the repo at `C:\Users\Kalch\Documents\IXI` (spec/plan/design/research/audits are part of the product and belong in history). Then **move** `.github\` to `IXI\.github\` and add to both jobs:
  ```yaml
  defaults:
    run:
      working-directory: site
  ```
  (plus `cache-dependency-path: site/package-lock.json` on the two `setup-node` steps).
- Root `.gitignore` must exclude: `.env`, `node_modules/`, `dist/`, `.astro/`, `.lighthouseci/`, `qa/artifacts/`, `scratchpad/`, `.obsidian/`.
- Consequence if skipped: no history, no diffs, no rollback, no reviews, and the CI quality gate can never execute.

---

## HIGH

### H1 — Review form bypasses the project's own abuse pipeline
- `src\components\ReviewForm.astro:6` posts to `https://formspree.io/f/YOUR_FORM_ID` (placeholder — submissions go nowhere today).
- CSP `form-action 'self'` (`public\_headers:7`, ✅ Manager) would **block** that POST in any browser with the header applied, so even a real Formspree ID would fail.
- Violates spec §6 invariant I-7 (no third-party form hosts).
- Existing `functions\api\contact.ts` already provides: Turnstile, rate limiting, honeypot, time-trap, Resend, redacted logging.
- **Fix:** extend `/api/contact` with a `type=review` discriminator; point the form at it; approved reviews then land as content and rebuild with the static site.

### H2 — Placeholder identity would ship
Every occurrence (✅ Manager, on disk):

| File:line | Placeholder |
|---|---|
| `astro.config.mjs:6` | `SITE_URL` fallback `https://www.ixi.example` |
| `src\layouts\BaseLayout.astro:19` | **second, separate** `SITE_URL` fallback `https://www.ixi.example` (drift risk — two defaults to keep in sync) |
| `public\robots.txt:3` | hardcoded `Sitemap: https://www.ixi.example/sitemap-index.xml` (also baked into `dist\robots.txt`) |
| `.env.example:4,11,12,14,20` | `PLAUSIBLE_DOMAIN`, `RESEND_FROM` (`hello@ixi.example`), `RESEND_TO` (`inquiries@ixi.example`), `SITE_URL`, `CALENDLY_URL` (`calendly.com/ixi/15-min`) |
| `src\components\ReviewForm.astro:6` | Formspree `YOUR_FORM_ID` (see H1) |
| `src\pages\book.astro:4` | Calendly fallback URL |

Canonical URLs, sitemap, OG tags and the contact email all point at nothing until these are replaced. Requires the domain decision (see open questions).

### H3 — HSTS enabled pre-launch
- `public\_headers:6`: `Strict-Transport-Security: max-age=31536000; includeSubDomains` (✅ Manager confirmed).
- Spec §8 says HSTS is post-launch only. On an unlaunched/placeholder domain this pre-commits every future subdomain. **Remove now, re-add at launch.**

### H4 — Fabricated testimonials are live social proof
- `Testimonials.astro` hardcodes invented quotes ("Alex R.", "Morgan T.", "Jordan K.") (both audits).
- **Fix:** label visibly as sample (like the case studies) or remove until real client consent exists.

---

## MEDIUM

### M1 — Brand/token duplication (two sources of truth)
- `design\tokens.css` ≡ `site\src\styles\tokens.css` (byte-identical today, drift tomorrow) (both audits + ✅ Manager).
- **Decision (Manager):** runtime source of truth = `site\src\` (styles + `brand\logo.ts`); `design\` = source artwork/reference only, with a README pointing at the generated path. A CI check comparing the two files is a cheap guard.

### M2 — Naming inconsistencies vs spec
- Collection key `cases` vs spec `caseStudies`; dir `src\content\cases\` vs `case-studies/`; frontmatter `cta` vs `primaryCTA`; service filenames differ; GBP `£` used where plan says USD `$` (both audits).
- CSS: mixed BEM/flat classes; `hero-section__logo-wrapper` (`index.astro`) now holds a single symbol mark; `Footer.astro` uses `variant="lockup"` while `Header.astro` uses `variant="wordmark"`.
- **Rule:** either update the spec or the code — not both live. (Currency needs a user decision: the copy is entirely £.)

### M3 — ~16 debug scripts pollute the tree and the quality gate
- `site\scripts\_debug-*`, `_contrast*`, `_audit`, `_verify-*`, `_qa-sweep.mjs` (hardcodes an absolute Windows path).
- They are the **only** remaining `astro check` hints. **Fix:** delete obsolete ones, move the few useful ones to `scripts\dev\` (or drop from the repo entirely).

### M4 — CI never releases
Verified by Manager (`site\.github\workflows\ci.yml`, 47 lines):
- ✅ Present: build + `astro check` + static invariants + secrets-in-bundle grep + Lighthouse ≥90 gate + artifact upload + **npm cache (`cache: 'npm'`)** + Node pinned via `.node-version`.
- ❌ Missing: **no deploy job at all** (CI validates but never publishes); no PR preview deploys; no `permissions:` or `concurrency:` hardening blocks; rollback exists only as a doc (`docs\ops\rollback.md`); Lighthouse evidence kept only as CI artifacts.
- **Correction of an earlier Manager claim:** "no npm cache" was wrong — both jobs use `cache: 'npm'`.

### M5 — CSP mismatch
- `public\_headers:7` lists `api.resend.com` in client `connect-src` though it is server-only, and omits the Plausible origin (real value pending the domain decision). Spec §8 M5 requires verification against a live page.

### M6 — Review form polish
- Star-rating keyboard focus not visible; non-`lang="ts"` script with `as` casts (Code Reviewer L4).

---

## LOW

- **L1** — Inline `style=` on the hero wrapper (`index.astro`) is a stale-dev-CSS workaround; move into scoped CSS once the dev-server cache glitch is confirmed gone.
- **L2** — **Correction to Code Reviewer L3:** `.env.example` **does exist** (`site\.env.example`, 20 lines, ✅ Manager read it). The real gap is that nothing at all is in version control (B1).
- **L3** — No `_redirects` in `public\` — acceptable for a fresh static launch with `trailingSlash: 'never'` (Cloudflare Pages serves pretty URLs). The www→apex redirect becomes relevant only once a real domain is attached, and belongs at the zone level.

---

## Reproducibility (verified by Manager)
- `package-lock.json` present ✅; `engines: node >=20.3.0` and `.node-version: 20.19.5` are consistent ✅; CI pins Node via `node-version-file` ✅.
- Action: set `NODE_VERSION=20.19.5` explicitly in the Cloudflare Pages dashboard rather than relying on file auto-detection (unverified whether Pages reads `.node-version`; explicit beats implicit).
- Secrets (`TURNSTILE_SECRET_KEY`, `RESEND_API_KEY`, `FORM_WEBHOOK_SECRET`, `LOG_PEPPER`) belong in Pages **encrypted environment variables**, separate Preview vs Production; `KV_COUNTER` as a KV binding for the rate-limit store.

## Still unverified
- Whether CSP `form-action 'self'` blocks the Formspree POST in a live browser (header read, not load-tested — moot once H1 is fixed).
- Live CSP host verification against a real page load (spec §8 M5).
- No second opinion on the hosting/CI section (DevOps audit failed; Manager covered its scope personally).

## Sequencing
- **Phase 1 (no decisions needed):** B1 git init + workflow relocation; H1 review form → `/api/contact`; H3 remove HSTS; H4 label/remove testimonials; M1 token dedupe rule; M3 debug-script cleanup; M2 CSS/footer naming cleanups; L1 inline-style removal.
- **Phase 2 (blocked on user answers):** H2 real domain → `SITE_URL`, robots.txt, CSP, env values, Calendly URL; M4 deploy job + preview deploys + secrets in Pages; M5 CSP verification.
