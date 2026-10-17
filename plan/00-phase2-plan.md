# IXI — Phase 2 Plan (v2 — all role reviews folded, M0 approved)

**Project:** IXI — website for an automation freelancer/studio
**Phase:** 2 → 3 (v2 plan is the build baseline)
**Author / owner:** @Manager (Orchestration · Task assignment · Delivery)
**Date:** 2026-10-15
**Basis:** [`research/00-phase1-research-report.md`](../research/00-phase1-research-report.md) + the three source research files.
**Status:** **v2 — APPROVED FOR BUILD.** Reviewed by all eight roles (Analyst, Architect, Designer, Frontend, Backend, Code Reviewer, QA, DevOps); every review returned CHANGES (no blockers) and all accepted edits are folded in below. Owner instruction "continue until 100% finished" = M0 approval. Defaults D1–D17 stand until the owner overrides any of them.

**v2 change log (folded from reviews):** CTA rule resolved (page-matched + fixed header/footer label) · /pricing CTA collapsed · audit CTA destination mapped · FAQ SLA + ownership questions added · threat-model/trust-boundary table required · form request/response contracts, enums, time-trap windows, side-effect order, email-injection rules pinned · KV rate limiter chosen · Workers-runtime (no Node) invariant · `output:'static'` invariant + CI guard · plain token CSS locked at T4 · component list gap-filled (drawer, sticky CTA, figure, skeleton, avatar, empty-state, prose lists) · image/CLS policy · no-JS fallback contract · secrets gate + env inventory · CI provider, gated promotion, rollback runbook, LHCI deliverable · QA evidence artifacts (axe, screenshots, traces, CSP captures, cookie audit) · INP→TBT lab substitution · severity definitions for T13 · owner-attestation states for honesty checks · new §10 risk rows.

---

## 1. Decisions locked (D1–D17, unchanged in scope)

| # | Decision | Value |
|---|---|---|
| D1 | Site language | English, single language (hreflang omitted, documented) |
| D2 | Services | 4 service pages (see §4) |
| D3 | Pricing | Published "starting at" anchors, USD, + care retainer; bespoke-quote path |
| D4 | Currency | USD ($) — changeable |
| D5 | Booking | Inline calendar on `/book` (Calendly) + ≤3-field intake; application form on `/pricing` |
| D6 | Retainer | Yes — "Automation Care" monitoring/maintenance plan (price $250/mo default; Analyst flagged $150–250 as owner-confirmable) |
| D7 | Case studies | 3 clearly-labelled sample projects for v1; real work swapped in when permission exists |
| D8 | Platforms shown | Make, n8n, Zapier (+ self-hosted n8n / data residency) |
| D9 | Theming | `prefers-color-scheme` only; no toggle at launch |
| D10 | Palette | Ruby `#B01C3B` light / `#E04B67` dark; milky `#F7F1E8` / near-black `#121012` |
| D11 | Success/error colour | Separate semantic reds; success always paired with icon+text |
| D12 | Schema | `ProfessionalService` + `Service` + `FAQPage`; no fabricated address |
| D13 | Lead routing | Email to owner + optional webhook (third-country/third-party transfer — documented in privacy policy) |
| D14 | Stack | Astro (SSG, TS) on Cloudflare Pages; Pages Function for the form; Turnstile; Plausible Cloud |
| D15 | Brand assets | Designer creates IXI wordmark, favicon set, OG image template; English copy |
| D16 | Capacity | "Currently accepting new projects" only; no fake scarcity |
| D17 | Response promise | Reply within 1 business day, target <4 business hours (manual QA sample over first 14 days post-launch) |

**Open owner questions (defaults hold until answered):** case-study permission (Q1) · pricing posture/currency · services/vertical (Q3) · booking model + retainer price · platforms to showcase (Q6) · brand assets/headshot (Q7) · capacity line (Q8) · Cloudflare account + domain · Turnstile keys · Resend key + sending-domain DNS · webhook in v1? · CI provider if not GitHub · apex vs www canonical.

---

## 2. Sitemap & routes

Primary CTA rule: **one primary action per page, label chosen per page (matrix below); the persistent header/footer CTA is hard-coded to "Book a 15-minute call" → `/book`.** Each page carries frontmatter `primaryCTA: { label, href }` from a shared enum; default `{ "Book a 15-minute call", "/book" }`.

| Route | Purpose | Primary CTA (label → destination) |
|---|---|---|
| `/` | Positioning, proof, services preview, 1 case highlight, process snapshot, FAQ teaser | Book a 15-minute call → `/book` |
| `/services` | Index of the 4 services | Book a 15-minute call → `/book` |
| `/services/workflow-automation` | Make/n8n/Zapier workflows | Start an automation audit → `/pricing#apply?offer=audit` (form preselects the $750 audit; fallback `/book` if pricing anchor ever dropped — mapping documented in T2) |
| `/services/ai-agents` | AI agents & chatbots | Book a 15-minute call → `/book` |
| `/services/systems-integration` | APIs, CRM/ERP, data sync | Get a custom quote → `/pricing#apply` |
| `/services/internal-tools` | Internal tools & dashboards | Get a custom quote → `/pricing#apply` |
| `/work` | Case-study index (3 deep + short outcome cards) | Discuss a similar project → `/book` |
| `/work/<slug>` | Case-study detail (template) | Discuss a similar project → `/book` |
| `/process` | How I work, cadence, handover, monitoring, ownership | Book a 15-minute call → `/book` |
| `/pricing` | Anchors, what drives price, care retainer, FAQ, application form | **Apply for a custom quote** → `#apply` (single label, no double CTA) |
| `/about` | Human credibility, availability | Book a 15-minute call → `/book` |
| `/book` | **Conversion page** — inline calendar + ≤3-field intake + "what happens next" | (the calendar itself) |
| `/thank-you` | Post-submit next steps, no dead end | See pricing → `/pricing` |
| `/privacy`, `/terms` | Legal | — |
| `/404` | Recovery page with nav + CTA | Book a 15-minute call → `/book` |

**Deliberate omissions:** no `/contact` page (email in footer) and no blog/resources in v1 — competing exits. Revisit after launch data.

**Promise→destination matrix artifact:** `qa/artifacts/cta-matrix.md`, audited in T12 and re-checked in M6 — must cover every route including 404.

---

## 3. Page sections

- **Home:** header/nav → hero (H1, sub, primary CTA, "see case studies" text link, **real screenshot** of a working automation — spec in T3: what to capture, aspect ratio, no stock) → proof bar → what I do (4 service cards) → outcome stats → case-study highlight → process snapshot (5 steps) → FAQ teaser (4) → closing CTA band → footer.
- **Service detail:** who it's for → the problem in plain words → what you get → how it works (3–5 steps) → what's included / not included → timeline → starting-at price + care option → one numbered case snapshot → FAQ (3–4) → CTA.
- **Work index / detail:** filter-free grid of cards; card = problem → one outcome number → sector tag. Detail = Context → Problem → Approach → Execution (screens/diagram) → Result → testimonial (if real) → CTA.
- **Process:** discovery → audit & plan → build in your accounts → handover & training → care/monitoring. Explicit ownership statement + the **"Who owns the automations, accounts, and data — and how do I leave?"** answer (mechanism here, details on `/pricing`).
- **Pricing:** anchor table (3 offers + retainer), "what drives price", written in/out-of-scope, revision limits, FAQ block (revisions, scope, **ownership/exit**, **breakage + Automation Care SLA**, maintenance), application form `#apply` (with `?offer=audit` preselect).
- **About:** story, values, credentials, real photo/avatar, availability line, CTA.
- **Book:** H1, 3-sentence "what happens next", inline calendar (lazy, reserved height), ≤3-field fallback intake, response-time promise, **"Third-party embeds" privacy notice shown before calendar interaction** (Calendly cookies), short trust block.
- **Thank-you:** confirmation, what happens next, response-time promise, links to pricing/process, prep checklist.

---

## 4. Content outline

**Tone:** confident, plain English, no jargon, no hype, no faux urgency. Verb-first. Short sentences. Every section answers a buyer question.

**Services (4):**
1. **Workflow Automation** — "Stop re-typing data between the tools you already pay for." Make/n8n/Zapier builds, error handling, logging.
2. **AI Agents & Chatbots** — "Answer customers and route work without adding headcount." Voice/chat agents, lead qualification, internal assistants.
3. **Systems & API Integration** — "Make your CRM, billing, and ops tools behave like one system." Custom APIs, middleware, data sync.
4. **Internal Tools & Dashboards** — "Replace the spreadsheet everyone fights over." Portals, admin tools, reporting dashboards.

**Pricing anchors (USD, changeable):**

| Offer | From | Includes |
|---|---|---|
| Automation Audit | $750 | Process map, opportunity list with ROI estimate, build plan, 1-week delivery, credited toward a build |
| Single Automation | $1,500 | One workflow in your accounts, error handling, documentation, 30-day fix warranty **+ one documented post-launch health check** |
| Automation System | $5,000 | Multi-workflow system, integrations, monitoring, training, full documentation |
| Automation Care (retainer) | $250/mo | Monitoring + alerts, fixes, priority support, monthly improvement hours, month-to-month |

Always published: what drives price, revision limits, out-of-scope list.

**Process (5 steps):** 1) 15-minute discovery call → 2) Audit & written plan → 3) Build in your accounts with weekly updates → 4) Handover, documentation & training → 5) Optional Automation Care.

**FAQ (site-wide set):** What does an automation cost? How long does a build take? Do I need to understand Make/n8n/Zapier? Who owns the automations and accounts? **Who owns the automations, accounts, and data — and how do I leave or take them over?** **What happens when something breaks?** (answer = Automation Care SLA: monitored automations alert immediately; Care tickets get a 1-business-day response and same-week fix for critical breakage) Which tools do you use — and when would you not use them? Is my data safe / can it be self-hosted? What if I need changes after handover?

**T1 acceptance (replaces the subjective tone check):** a first-time reader can state **audience + value proposition + next step in one sentence from the hero alone (≤5-second read)**, and `/book` carries a 3-sentence "what happens next" block covering all three qualification paths. Plus: every page has exactly one primary action matching §2, and a measurable meta title (≤60) + description (120–160) per page.

**Draft hero copy (Analyst refines in T1):**
- H1: "Automations that still work in month six."
- Sub: "I design, build, and maintain workflows, integrations, AI agents, and internal tools — running in your own accounts, with monitoring so nothing fails silently."
- CTA: "Book a 15-minute call" · secondary text link: "See how it works".

---

## 5. Design system (Designer's verified tokens)

**Colour tokens** — `--color-bg`, `--color-surface`, `--color-surface-2`, `--color-text`, `--color-text-muted`, `--color-text-subtle`, `--color-primary`, `--color-primary-hover`, `--color-primary-active`, `--color-on-primary`, `--color-link`, `--color-border`, `--color-border-strong`, `--color-focus`, `--color-success`, `--color-warning`, `--color-error`, `--color-neutral-soft`. Values exactly as in `research/03-designer-color-theming.md`; dark values via `@media (prefers-color-scheme: dark)`; `color-scheme: light dark` on `:root`.

**Typography:**
- Wordmark: custom **IXI SVG** (light + dark variants) — no webfont cost.
- UI/body: **Inter Variable**, self-hosted, woff2, subset latin + latin-ext, `font-display: swap`, preloaded.
- Scale: 12 / 14 / 16 / 18 / 20 / 24 / 30 / 36 / 48 / 60 (fluid `clamp()` on 36–60). Body 16px min. Headings 1.15, body 1.6.

**Spacing & layout:** 4px base — 4/8/12/16/24/32/48/64/96/128; section padding 64px mobile → 96px desktop; container 1200px, prose 720px; radius 4/8/12/full; two shadow levels; 1px token borders. Aspect-ratio tokens `--aspect-card`, `--aspect-hero`.

**Motion tokens:** duration/easing tokens with `prefers-reduced-motion` overrides (Designer defines values in T3).

**Components (both themes, all states):** skip link · header/nav (desktop + **mobile nav drawer as an explicit component**) · footer · button (primary/secondary/ghost, hover/active/focus/disabled) · text link · badge/pill · proof bar · stat block · service card · case-study card · testimonial card · process steps · pricing table/card · FAQ (`<details>`) · CTA band · form field / textarea / select / radio-button group · inline validation + error summary · success state · calendar embed wrapper (reserved height) · breadcrumbs · 404 block · **sticky mobile CTA (safe-area-aware, ≥44px)** · **`figure`/captioned image** · **avatar/photo** · **empty-state copy slot** · **loading skeleton** · **prose/list styling for in-scope/out-of-scope blocks** · **`Image` component (Astro `<Image />`, aspect tokens, `sizes`)**.

**Accessibility built in:** 3px offset focus ring, no colour-only meaning, ≥24px targets (44px touch CTAs), reduced motion, labelled fields + associated errors, `aria-live` for form status.

---

## 6. Tech stack & architecture

- **Framework:** Astro (SSG) + TypeScript. **Invariant: `output: 'static'`; no `@astrojs/cloudflare` adapter in v1.** Pages Function lives at repo-root `functions/api/contact.ts`, outside `dist`. CI asserts this (T11).
- **Runtime for the function:** **Cloudflare Workers (edge) runtime — no Node APIs, no `fs`/`vm`.** Resend via Workers-compatible SDK or raw `fetch`; Turnstile verify = `fetch` to `https://challenges.cloudflare.com/turnstile/v0/siteverify`; crypto via `crypto.subtle`.
- **Styling:** **plain token CSS** (Designer's tokens are the single source of truth) — decided at T4. Tailwind v4 only if M2 review shows excessive hand-written responsive utilities.
- **Hosting:** Cloudflare Pages free tier; preview deploys per PR; **production promotion gated** via GitHub `production` environment (required reviewer), not silent auto-deploy; one-click rollback = previous Pages deployment (runbook `docs/ops/rollback.md`).
- **Contact form:** `POST /api/contact` Pages Function.
  - **Pipeline order:** body-size check (≤8 KB, before JSON parse) → Content-Type allow-list (`application/json` + `application/x-www-form-urlencoded` for no-JS; else 415) → Turnstile `siteverify` (first, incl. Origin/Referer check) → schema validation (zod-equivalent, server-side) → enum allow-lists → rate limit → Resend email → optional signed webhook.
  - **Request contract (JSON):** `{ name ≤80, email ≤254, company? ≤120, project ≤500, budget (enum), timeline (enum), _hp (must be empty), startedAt (ISO 8601), turnstileToken }`. Enums pinned in T2 (budget: `under-1k / 1k-5k / 5k-15k / 15k+ / not-sure`; timeline: `asap / 1-month / 3-months / exploring`).
  - **Response contract:** `200 { ok: true, ref: "inq_<8-char uuid>" }` · `4xx { error, fields? }` with codes `validation | challenge | honeypot | time-trap | rate-limit | payload-too-large | internal`. Honeypot → silent `200 {ok:true}`. Rate limit → generic `429 { error: "rate-limit" }` (never which dimension). No-JS urlencoded success → `303 See Other` → `/thank-you`.
  - **Time trap:** reject `receivedAt − startedAt ≤ 3s`; reject `startedAt` older than 4h or newer than server clock +1min (skew allowance); missing `startedAt` → reject.
  - **Email injection rules:** constant subject `"New IXI inquiry"` (no user data in headers, ever); `reply_to` = submitter; `\r \n \t`/control chars in email → 400; HTML-escape `name/company/project` before rendering; text body plain.
  - **Side effects:** email failure → 500 + structured log, **webhook not fired**. Webhook (optional; missing URL = disabled, not failure) → HMAC-SHA256 over canonical JSON with `FORM_WEBHOOK_SECRET` in `X-Signature`, up to 3 attempts, 2s initial, ≤20s backoff; webhook failure logs `webhook-failed` but submission still returns `ok:true`.
  - **Rate limiting:** Cloudflare **KV counter** keyed `ip:<YYYY-MM-DD-HH>:<sha256(ip+LOG_PEPPER)>`, 1h TTL; 3/IP/h, 3/email/h + 10/email/24h; in-memory fallback when KV binding absent; upgrade path = WAF rule (paid) documented in T11.
  - **Logging:** one redacted JSON line per request: `{ ref, ok, reason, status, ipHash, startedAt?, receivedMs, totalMs, hasWebhook }`. **Never name/email/project/body.** ~28-day Cloudflare retention documented; Logpush only if an audit trail is later required.
  - **Threat-model / trust-boundary table** (browser → Turnstile verify → schema validation → enum allow-list → outbound email rendering) is a required T2 artifact and the basis for T13's security review.
- **no-JS fallback:** `/book` gets `<noscript>` with direct Calendly link + the same intake form posting to `/api/contact`; no Turnstile on the no-JS path (honeypot + time-trap + validation still gate — documented decision); calendar wrapper reserves height with JS off.
- **Booking:** Calendly inline embed, lazy on `/book` only; `preconnect` to Calendly only on `/book` after the lazy trigger, never in the global head.
- **Analytics:** **Plausible Cloud** (cookieless; no banner only if a full cookie audit shows zero other non-essential cookies). Calendly cookies disclosed **on `/book` before calendar interaction** + in the privacy policy.
- **SEO:** `@astrojs/sitemap`, `robots.txt`, canonical (absolute; **one global trailing-slash rule with 301 redirect — decided in T2**), OG/Twitter, JSON-LD `ProfessionalService` + `Service` + `FAQPage` on visible content only. `noindex,follow` on `/thank-you` + `/404`; `/404` excluded from sitemap; OG image 1200×630 generated at build from tokens (no text overflow).
- **Security headers:** `public/_headers` (Cloudflare syntax): CSP (allowlist source-of-truth file in T2, incl. `frame-src https://calendly.com https://challenges.cloudflare.com`; verify exact hosts against a live page in M5), `frame-ancestors`, Referrer-Policy, Permissions-Policy, HSTS (**preload only post-launch**), `X-Content-Type-Options`, `X-Frame-Options`; immutable `Cache-Control` on `/assets/*`, short-lived HTML.
- **Repo/CI:** **GitHub Actions** (confirm if repo isn't GitHub). PR → build + typecheck + lint + schema-validation + unit subset; push to `main` → gated production promotion. Node pinned via `.node-version` + `NODE_VERSION` on Pages; pnpm + committed lockfile; `engines` in `package.json`. **Lighthouse CI:** committed `.lighthouserc.cjs`, mobile, median of 5 runs, ≥90 all four categories on Home / a service page / `/book`, fails the PR, evidence to `qa/artifacts/lighthouse/<route>.json`. Preview URL exported as a step output for LHCI + `lychee` link scan; secrets scan over `dist/` (**only `TURNSTILE_SITE_KEY` public**) is a fail-fast gate; CI also asserts `output:'static'` + no `@astrojs/cloudflare` in the tree.
- **Secrets/env inventory (per environment: preview vs production):** public build-time `TURNSTILE_SITE_KEY`, `ANALYTICS_SITE_ID`; server-only `TURNSTILE_SECRET_KEY`, `RESEND_API_KEY`, `FORM_WEBHOOK_URL`, `FORM_WEBHOOK_SECRET`, `LOG_PEPPER`, `APP_ENV`. `.env.example` committed, `.env*` ignored. **Preview deploys use Turnstile test keys** (real key refuses localhost). Resend: verify sending domain SPF/DKIM/DMARC before T10 relies on `from:`; trial sends go to a **QA mailbox alias, never the owner's real address**.

**GDPR/privacy:** privacy policy documents Resend DPA, the optional webhook's third-country/third-party transfer (owner is controller for his own automation), Calendly cookies, form-data retention (none stored — email only), self-hosted fonts, cookieless analytics.

---

## 7. Task breakdown (v2)

| ID | Owner | Deliverable | Depends on | Acceptance criteria |
|---|---|---|---|---|
| T1 | @Product Analyst | Final copy deck for every page + per-page acceptance criteria | M0 | Stranger test (audience+value+next step from hero ≤5s); one primary action per page matching §2; meta title ≤60 / desc 120–160 per page; FAQ includes Automation Care SLA + ownership/exit questions; all §4 buyer fears answered; numeric claims traceable or labelled provisional |
| T2 | @Architect | Interface spec: content-collection schemas (`Service`, `CaseStudy` w/ `sample: true`), full form API contract (req/res/enums/time-trap/side-effect order), webhook HMAC spec, headers/CSP allowlist source file, trailing-slash + CTA-enum + promise→destination mapping, threat-model table, static-build invariant | M0 | Frontend + Backend + DevOps can build without guessing; every contract item in §6 present; stub contract for T9 documented |
| T3 | @Designer | Wireframes (all templates) + hi-fi key pages (Home, Service, Book) + `tokens.css` + wordmark/favicon/OG template + motion tokens + hero-screenshot spec + sticky CTA + mobile drawer specs | M0 | Tokens match Phase 1 exactly; dark `--color-text-subtle` re-measured on `#1F1B1E` (saved screenshot); CLS reservations (figure/skeleton/injected blocks) specified; wordmark + favicon + OG covered |
| T4 | @Frontend | Astro scaffold, base layout, tokens, header/nav/footer/drawer, skip link, sticky mobile CTA, both themes | T2, T3 | `output:'static'`, no adapter, `functions/` outside `dist`; no FOUC (no-JS hard-refresh check, inline `:root` bg before paint, `color-scheme` set); plain token CSS; keyboard nav incl. drawer + skip link; shell Lighthouse ≥90 |
| T5 | @Frontend | Home page | T1, T3, T4 | Sections per §3; real screenshot w/ reserved dimensions; both themes; CWV budget held |
| T6 | @Frontend | Services index + 4 detail pages | T1, T4 | Copy + pricing anchors render; one case snapshot per page; CTA labels match §2 |
| T7 | @Frontend | Work index + case-study template (3 sample studies) | T1, T4 | "Sample project" label visible to sighted **and** SR users; no fabricated metrics |
| T8 | @Frontend | Process, Pricing, About, Book, Thank-you, 404 | T1, T4 | Calendly lazy `/book` only, reserved height even JS-off; `<noscript>` Calendly link + intake form → `/api/contact`; Calendly-failed-iframe fallback link; `preconnect` only on `/book` after lazy trigger; sticky CTA hidden on `/book` + 404 |
| T9 | @Frontend | Forms UI: fields, inline validation, error summary, success/`aria-live` | **T4, T2 (stub allowed — ship against T2's stub `/api/contact`, remove when T10 lands)** | zod-equivalent client validation with server parity; field + form-level errors; `aria-live` = `role=status, polite`, success + server-error **only** (not per keystroke); `autocomplete` name/email/tel + `inputmode` |
| T10 | @Backend | `/api/contact` function per §6 pipeline; redacted logging; KV rate limiter; Resend; optional webhook; stub removal | T2, T4, T11(env) | Full abuse matrix passes (honeypot silent-200, ≤3s→400, >8KB→413, wrong CT→415, missing/reused token→403, per-IP/email→429 generic, concurrent dup→exactly one email, urlencoded→303, newline email→400); valid submission delivered; zero message bodies in logs; `DEV_STUB=1` path removed; test URL + stub-removal criteria recorded |
| T11 | @DevOps | Repo + GitHub Actions CI, LHCI config, Cloudflare Pages project, gated promotion, env/secrets inventory + bundle scan gate, `public/_headers`, DNS/TLS, Resend DNS, analytics, rollback runbook, static-invariant CI check | **T2, T4** | CI green (build+typecheck+lint) with preview URL ≤3min; LHCI ≥90 all routes; security-header scan zero critical; secrets scan passes (only site key in bundle); env inventory recorded in `ops/`; headers verified with scanner + screenshot |
| T12 | @Frontend | SEO layer: titles/meta/OG, sitemap, robots, JSON-LD, canonicals, 404, `cta-matrix.md`, broken-link scan | T5–T8 | Rich Results Test passes per template (saved); unique title/desc; one H1; `noindex,follow` on `/thank-you`+`/404`; `/404` out of sitemap; canonical absolute w/ trailing-slash rule; OG 1200×630 no overflow; JSON-LD visible content only; LHCI cross-ref |
| T13 | @Code Reviewer | Independent code + security review against the T2 threat model | T5–T12 | Findings with severity (**Critical/High/Medium/Low; High = any unauthenticated security or data issue**); PR-by-PR review records or diff ranges; no open Critical/High before QA sign-off |
| T14 | @QA Engineer | Codified test plan + executed tests + defect reports + sign-off | T11, T12, T13 | §9 executed with evidence artifacts (axe JSON per template, keyboard table, screenshot index + Playwright traces, CSP captures, cookie audit, abuse-matrix results); owner-attestation states for honesty checks; sign-off or blocking defect list |

---

## 8. Milestones

| Milestone | Content | Gate |
|---|---|---|
| **M0 — Plan approved** ✅ | v2 plan reviewed by all 8 roles; owner said "continue until 100%" | Owner + all roles — **met 2026-10-15** |
| **M1 — Design ready** | T1, T2, T3 done. **Also includes test-environment definition:** preview URL plan, Turnstile test-key matrix, QA mailbox alias, stub webhook, dark-subtle screenshot artifact | Manager verifies files |
| **M2 — Skeleton live** | T4 + T5: scaffold, layout, Home on a preview URL | Manager + Designer review preview |
| **M3 — Content complete** | T6, T7, T8: all pages rendered with real copy | Manager review |
| **M4 — Conversion works** | T9 + T10: forms and booking functional end to end | **Manager verifies a real submission through the QA mailbox (not the owner's address); owner-side clean-up noted** |
| **M5 — Hardening** | T11 + T12: CI, headers, SEO, perf/a11y budgets; **live prod-key Turnstile run + Calendly/Turnstile CSP verification on real pages** | Lighthouse + headers evidence |
| **M6 — Review & QA** | T13 + T14: independent review, full test pass, fixes, re-test | QA sign-off with **artifact bundle (naming convention + index)** or defect list |
| **M7 — Launch** | Production deploy + **post-deploy smoke gate (DNS/headers/analytics/sitemap/live booking)** + final report | Owner authorisation; named rollback owner |

---

## 9. QA checklist & acceptance criteria (v2 — evidence required for every item)

**Functional**
- [ ] All nav links resolve; no 404s except the 404 page; one H1 per page.
- [ ] CTA rule: primary action unique per page and matches §2; persistent header/footer CTA fixed to "Book a 15-minute call"; promise→destination matrix verified on every template incl. 404 → evidence `qa/artifacts/cta-matrix.md`.
- [ ] `/book` calendar inline, lazy, no layout shift; guest booking works; 3-sentence "what happens next" present for all three qualification paths.
- [ ] Form abuse matrix (black-box, exact statuses): honeypot filled → silent `200 {ok}` · ≤3s submit → `400 time-trap` · body >8KB → `413` · malformed/wrong Content-Type → `415` · missing Turnstile token → `403 challenge` · **reused** token → `403 challenge` · per-IP 3/1h and per-email 3/1h → `429` with **no dimension enumerated** · concurrent duplicate → exactly one email delivery · newline in email → sanitized/`400` · no-JS urlencoded POST → `303` to `/thank-you` (or error page).
- [ ] no-JS path: `/book` shows direct Calendly link + intake form posting to `/api/contact`; calendar reserved height holds with JS off.
- [ ] `tel:` / `mailto:` links work on iOS Safari + Android Chrome; empty/disabled form states; resubmission after network error restarts cleanly; offline/3G-throttled sanity check.
- [ ] Sticky mobile CTA: present on Home, Services (index+detail), Work (index+detail), Pricing; **hidden on `/book` and 404**; never overlaps the form error summary at ≤375px.

**Themes** (both OS `color-scheme` values × desktop + mobile)
- [ ] No flash of wrong theme incl. no-JS hard refresh; inline `<style>` sets `:root` bg/color before first paint; native controls follow `color-scheme`.
- [ ] Every text/UI pair re-measured — dark `--color-text-subtle` on its real `#1F1B1E` parent with saved screenshot pair; contrast pass runnable as a CI check (T11).
- [ ] No meaning conveyed by colour alone — per-template evidenced bullet.

**Responsive & browsers**
- [ ] Widths 320 / 360 / 375 / 390 / 414 / 768 / 1024 / 1280 / 1440 incl. landscape on mobile/tablet; no horizontal scroll or overlap.
- [ ] Latest two versions of Chrome/Firefox/Safari/Edge + latest iOS Safari (device) + latest Android Chrome. **Calendly + Turnstile verified on each** (asset CDNs change quarterly).
- [ ] Evidence: committed screenshot index + Playwright trace files under `qa/artifacts/`. Real-device gaps → BrowserStack or owner-supplied captures (see §10).
- [ ] Forms single-column on mobile; thumb-reachable CTAs.

**Accessibility (WCAG 2.2 AA)** — evidence per item
- [ ] axe-core JSON per template → `qa/artifacts/axe/`; 0 critical/serious.
- [ ] Keyboard pass/fail notes table per route (Tab/Enter/Space, focus order comments); visible 3px focus ring on every template in both themes; skip link targets `#main`; **Calendly iframe focus-exit (Tab in, Tab out, no reload)**.
- [ ] Labels / `aria-describedby` errors / `aria-required`; `aria-live` (`role=status`, polite) announces **success and server error only**; `autocomplete` name/email/tel + `inputmode`.
- [ ] Target size ≥24px, touch CTAs 44px with spacing; `prefers-reduced-motion` disables non-essential motion.
- [ ] Screen-reader smoke (NVDA or VoiceOver): documented route path + announcement quotes.

**Performance**
- [ ] Lighthouse mobile ≥90 on Performance/Accessibility/Best Practices/SEO for Home, a service page, `/book` (LHCI, median of 5 runs, in CI; evidence JSON committed).
- [ ] **Lab: TBT ≤200ms** (INP is a field metric — collected via cookieless RUM and tracked into M7), LCP ≤2.5s, CLS ≤0.1.
- [ ] Budgets: JS ≤25KB, CSS ≤50KB; images AVIF/WebP with explicit dimensions (no image CLS); self-hosted subset Inter preloaded; zero render-blocking third parties; `preconnect` to Calendly only on `/book` after lazy trigger.
- [ ] CLS on dynamic injections verified by frame comparison: sticky CTA mount, lazy Calendly load, error-summary appearance, success-state swap.

**SEO**
- [ ] Unique title ≤60 + description 120–160 per page; canonical absolute; one global trailing-slash rule (301).
- [ ] `noindex, follow` on `/thank-you` and `/404`; `/404` excluded from `sitemap.xml`; `sitemap.xml` + `robots.txt` reachable.
- [ ] OG image 1200×630 build-generated, text overflow-safe, canonical absolute URL; JSON-LD limited to visible content; Rich Results Test result saved per template; hreflang omitted (documented, single-language).

**Security & privacy**
- [ ] CSP **zero violations** captured on `/`, a service page, `/book` (**with both embeds fully interacted**), `/thank-you`, 404 — debug-panel + network capture saved.
- [ ] Server-side validation, email-injection prevention and rate limiting verified by the abuse matrix above; Turnstile replay rejected; Origin/Referer checked server-side. **Live prod-key Turnstile run happens in M5 (test-key artifacts reported BLOCKED until then).**
- [ ] Secrets gate: bundle scan shows only `TURNSTILE_SITE_KEY`; env inventory per environment recorded; no server vars in CI logs or repo.
- [ ] Cookie audit: zero first-party non-essential cookies; Calendly cookie behaviour documented and disclosed **before calendar interaction on `/book`**; analytics cookieless; fonts self-hosted (no `fonts.googleapis` requests); privacy policy matches actual handling (Resend DPA, webhook transfer).

**Honesty**
- [ ] All numeric/pricing/testimonial claims scraped from rendered pages must trace to the §4 anchor tables, a verified reference, or **owner attestation**; anything else stays labelled provisional.
- [ ] "Sample project" labels visible to sighted **and** screen-reader users (both tested).
- [ ] Owner-attestation states: `PASS (owner attestation received)` / `BLOCKED (attestation missing → all studies remain sample-labelled)` — M6 gate.
- [ ] Pricing consistent across pages; capacity claims truthful; D17 response promise sampled by manual QA over the first 14 days post-launch.

---

## 10. Risks & assumptions

| Risk | Mitigation |
|---|---|
| No real client case studies / testimonials yet | Labelled sample projects; structure ready to swap in real work; owner-attestation gate in M6 |
| Currency/pricing may be wrong for the owner's market | Anchors are one edit away; flagged as open question ($250 vs $150/mo retainer) |
| Calendly cookie notice complicates "no banner" GDPR story | On-page disclosure before calendar interaction + privacy policy; Cal.com fallback |
| Turnstile/Calendly CSP misconfiguration blocks form/calendar | Allowlist source file in T2; live verification on a real page in M5; QA tests live form |
| **Turnstile test-vs-prod key mismatch blocks real submissions in M4/M5** | Key inventory per environment in T11 |
| Token drift (CSS vs Designer's tokens) | Tokens single source; CI contrast check; no utility drift (plain token CSS locked) |
| Dark-mode subtle-text contrast estimate | Explicitly re-measured in T3/M5 with saved screenshot |
| **Browser/device matrix evidence is best-effort** | Playwright traces for desktop; BrowserStack or owner-supplied captures for real devices; disclosed in report if incomplete |
| **WAF rate-limiting is paid-tier** | KV counter + in-memory fallback (free); upgrade path documented; cost threshold in §6 |
| DNS/preview cutover downtime | Pre-flight DNS switch; keep `*.pages.dev` fallback for first 24h; noindexed until domain lands |
| Log retention/rotation | 28-day default documented; Logpush only if audit trail required |
| OG image / LHCI not yet in code | No perf evidence exists until M2/M5 — every perf bullet is evidence-to-be |

**Assumptions:** the owner is available to approve copy and pricing; there is no existing logo/domain/headshot (Designer creates placeholders); one developer covers frontend and backend at this scale; GitHub is the CI host (confirm); free-tier quotas suffice at expected volume.

---

## 11. Execution status

v2 is the build baseline. Reviews are **closed** — further review rounds only at M6 (T13/T14) or if a gate fails. Owner answers to the §1 open questions can be applied any time as one-line changes; work proceeds on defaults so nothing stalls.
