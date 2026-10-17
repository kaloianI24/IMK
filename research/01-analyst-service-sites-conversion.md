# Phase 1 Research — Part A (Product Analyst)
## Topics 1 (service sites), 2 (conversion UX), 6 (reference sites)

- Project: IXI — automation services website ( IXI ≡ memorable wordmark )
- Owner: @Product Analyst — Requirements Specialist
- Date: 2026-10-15
- Scope: research only, no building.
- Companion research files (produced in parallel): `03-designer-color-theming.md` (Designer), `04-architect-perf-seo-security-stack.md` (Architect).

Roles in Phase 1 unchanged: Manager verifies, merges, and gates Phase 2.

---

## 0. Method

Web search (2025–2026) across freelancer/portfolio, service-agency, and conversion-optimization literature plus direct inspection of live automation-agency sites. Website advice varies by source confidence; bold claims (percentages) are attributed to their source and should be measured against our own traffic, not treated as guarantees. Sayings like “5-minute speed-to-lead” are explicitly flagged where the underlying primary source cannot be verified (see §5.3).

Sources cited inline by URL. Full list in §7.

---

## 1. Service-site structure & messaging for freelancers / automation agencies

### 1.1 Recommended information architecture (small site)

Consistent across sources (GitNexa, Koder.ai, webdesign agency automation articles): keep IA small, one primary action per page, 5–7 top-nav items.

Recommended sitemap for IXI:
1. **Home** — positioning, proof bar, services preview, one case-study highlight, process snapshot, FAQ teaser, primary CTA.
2. **Services** (index) + **one detail page per service** (2–5 services max, each own page and slug for SEO).
3. **Work / Case studies** (index) + **detail page per study**.
4. **Process** ("how I work") — reduces perceived risk; filters bad fits.
5. **Pricing / Investment** — ranges/packages + what affects price (pre-qualifies).
6. **About** — human, credibility, how you communicate, availability.
7. **Contact** (or `/book`) — conversion page (the most important page after home).

Optional later: Blog/Resources (buying-intent posts), FAQ dedicated page, Privacy/Terms.

URL slugs suggested (short, keyword-friendly): `/services`, `/services/workflow-automation`, `/work`, `/work/<project>`, `/process`, `/pricing`, `/about`, `/contact` (or `/book`).

Footer repeats nav + short bio, email, time zone, social links, privacy/terms, copyright.

**Rule:** each core page has ONE primary action. Secondary options live in footer/plain-text links only (7th Growth, Timescanner: "one exit path, not five").

### 1.2 Messaging patterns that perform

- Formula: **"I help [audience] achieve [outcome] with [service/method]"** (GitNexa, Koder.ai), tighten further (Timescanner): the stranger test — a new visitor must know in one sentence what client type you work with and what problem you solve. If not, rewrite the headline first.
- Outcomes > services, specificity > cleverness. "Save 14 hours/week on invoice processing" beats "we build automations".
- Avoid positioning around the freelancer/agency ("I am a Make.com expert") rather than the client's problem; agency sites that impress other agency owners don't sell (Payfunnels, Timescanner).
- Self-identification: name the situation ("you just closed a Series A and need the product launched"). One kind of client per section; separate language per audience.
- Three buyer questions answered predictably: What do you do? Can you prove it? How do I hire you? (Koder.ai)
- Proof element near the top (one testimonial with a named outcome, or a result snippet) to reduce skepticism before scrolling.

### 1.3 Page-level copy blocks (what each page must carry)

- **Home:** clear promise + next step; hero (headline, sub-headline with proof point/method, primary CTA, secondary "See case studies", visual = work sample not stock); social-proof bar (logos/quote); benefit bullets (outcomes not tools); process snapshot (3–5 steps); closing CTA.
- **Services (index + detail):** who it's for + situation, deliverables (tangible), timeline, what's included/revisions, requirements from client, pricing (range or starting-at), CTA.
- **Process:** how you work, communication cadence, milestones, handover & ownership, "what marks end of project" (written sign-off).
- **Work/Case studies:** standardized template (see §3).
- **About:** mission (change for clients), relevant story (not life story), values, credentials (only real), human photo + note, CTA.
- **Pricing/Investment:** tiers or ranges, what affects price, variables, encourages contact for tailored quote.
- **Contact:** short form, booking link, email, calendar, location, response-time promise.

### 1.4 Navigation & SEO hygiene

- Primary nav right-aligned distinct CTA button ("Book a call" / "Get a proposal").
- Clear non-jargon nav labels; 5–7 items; avoid deep dropdowns.
- One H1 per page, H2/H3 structure; meta title + description with keyword + benefit; descriptive alt text; internal linking Home→Services→Work→Contact; schema (Service, FAQ, Organization, Review).
- E-E-A-T signals: real names, testimonials with photos/titles, case studies.

Sources: https://www.payfunnels.com/how-to-build-an-agency-website/ , https://koder.ai/blog/build-freelancer-website-services-case-studies , https://www.timescanner.io/blog/freelance-website-generates-inquiries , https://www.gitnexa.com/blogs/how-to-create-a-portfolio-website-that-attracts-clients

---

## 2. Trust signals (ranked by source frequency)

1. **Client logos strip** near hero and footer (with permission) (GitNexa, Payfunnels).
2. **Testimonials with name, title, photo, and a specific, verifiable outcomes** ("Reduced API response time from 2.3s to 190ms") — ask the client the one question at project end: "What changed because of this?" (Timescanner).
3. **Case studies** with outcomes (most powerful at closing).
4. **Metrics/badges** — number of clients, apps built, automations, reviews; partner-tier badges (Zapier Platinum Solution Partner, Make Gold Partner, n8n). Automation-specific: 850+ clients, 825+ apps cite-style (Automation Ace).
5. **Certifications/press/speaking** (only if accurate).
6. **Real team/founder photo + human note** (personal touch).
7. **Process transparency** ("How I work") + communication cadence + time tracking → **invoice won't be a surprise** (Timescanner).
8. **Ownership/handover guarantees** (huge for automation buyers, burned by lock-in): credentials in client's name, domain/hosting staying theirs, documented workflows, exportable, "nothing held hostage" (TePublico, IOA Digital, FIMM Digital).
9. **Maintenance/monitoring offer** (monitoring, alerts, named response time; integrations fail silently — sell maintenance from start; honesty) (TePublico, FIMM, Frederik Daneels).
10. **Stack transparency** — which tools and why, and when a tool is the wrong choice (IOA Digital explicitly: "Make.com Gold Partner, which is a credential, not an identity").
11. **Privacy policy, ToS, cookie notice, SSL, GDPR consent** at any form (Payfunnels, Foundgrove).
12. **Response-time promise** on contact page (strongest post-CTA trust element, per Pravin Kumar's practitioner data).

Automation-specific trust themes to surface (synthesized from agency sites):
- "Document the process before automating it" (automating broken workflows fails).
- Data residency / self-hosted option when needed (n8n self-host).
- Reversibility: can change it themselves; documented; credentials theirs.
- Componentized: build, run, hand over; "you own everything, running in your own accounts" (Hackceleration).

---

## 3. Case-study format

Standard template (GitNexa, Koder.ai, Payfunnels, Foundgrove):
- **Context:** client, market, constraints ("They were spending $10K/mo on ads with no attribution model").
- **Problem / goal:** pain + stakes + why it mattered.
- **Role/scope:** what you were responsible for (and not).
- **Approach:** discovery, key decisions and trade-offs (brief).
- **Execution:** what you actually shipped (tools, workflows, screenshots, flow diagrams).
- **Results:** metrics OR qualitative outcome, with before→after, ideally one clear number (time saved, leads recovered, manual hours/week).
- **Artifacts:** 2–5 tangible screens, before/after comparisons, video walkthrough.
- **Testimonial:** a quote that feels real, from a decision maker, naming a result.
- **CTAs:** "Discuss a similar project" / book call.

Caveats (Timescanner, Collabas):
- 2,000-word case studies have low completion; for a solo studio, a **3-sentence problem/outcome summary** per project converts; reserve deep case studies for high-ticket.
- Buyers scan for outcomes, not internal terminology (Collabas: "case-study titles foreground the problem or transformation").
- If under NDA: anonymize company, describe process + outcome, label honestly; never present fabricated/synthetic proof as real (Collabas — required ethics).
- Anonymous allowed only for highly sensitive contexts (e.g., "lead gen operation under NDA" in IOA Digital) where you still give the number.

Recommended mix for IXI: 1–2 deep case studies (with numbers and testimonials) + a handful of short problem/outcome cards; add "sample project" (clearly labeled) if no real clients yet.

---

## 4. Pricing presentation

Options encountered:
- **Contact-only** ("let's talk"): forces calls, filters nothing; highest friction, lowest transparency; good for bespoke/high-ticket only.
- **Packages/tiers** ("Starter/Core/Growth", deliverable-named: "Launch Copy"): best for productized work; enables self-serve comparison (Koder.ai, Foundgrove).
- **Ranges / "starting at / typically $X–$Y"**: pre-qualifies, sets expectation; encouraged by Payfunnels, GitNexa.
- **"From $X"**: anchors (Cortex uses $750 pilot, $1,250/mo growth, custom).
- **Value-based/hourly/day-rate**: least predictable for buyers.
- **Recurring/maintenance model**: monthly automation-as-a-service (Daneels) + monthly retainer with monitoring; good for automation where things break.

Recommendation for IXI (consultative + some productizable deliverables):
- **Hybrid**: published "starting at" anchor + 3 named packages (Discovery/Audit, Single automation, System build) with deliverables, timeline, revision limits, in/out scope boundaries, then a bespoke/custom-quote path; add an explicit **retainer/maintenance** line ("monitoring + fixes + new automations").
- Always state what affects price: complexity, number of integrations, monthly volume, data residency, speed.
- Publish FAQ block at the pricing decision point (revisions, scope, ownership, handover, maintenance) (Foundgrove) — automation buyers' top 4 objections (TePublico FAQ set).
- Avoid faux scarcity ("only 2 spots"); if enforcing real capacity, say so plainly. Only real urgency (Foundgrove notes verb/outcome CTAs; urgency copy should be true).

Sources: https://koder.ai/blog/how-to-build-website-productized-service-offering , https://cortexautomatedsolutions.com/ , https://nex-automations.com/services , https://frederikdaneels.com/

---

## 5. Conversion-focused UX

### 5.1 CTAs — placement and wording

Evidence-driven (Latte 2026, 7th Growth, Foundgrove 2026, Pravin Kumar 2026):
- **Copy specificity beats generic by 10–30%**: "Book a 15-minute discovery call" vs "Contact us"; verb-first, outcome-named, matched to buyer state:
  - Home: low-commitment "Book a 15-min call"
  - Service page: "Book a paid assessment" / "Start an automation audit"
  - Pricing page: "Get a custom quote"
- Avoid "Click here / Submit / Learn more / Get in touch / Contact us" (tell the visitor nothing about next step; generic-to-specific lift 10–30%, per latte.dev).
- **Placement, minimum:** top nav on every page (persistent) + hero above fold + end of each major section (every ~600–800 words) + inline where reads naturally + sticky mobile bottom bar (phone number + primary CTA for service businesses, 70–85% mobile traffic).
- **One primary CTA site-wide** + contextual secondaries; avoid 5–6 competing CTAs (decision fatigue lowers all rates) — keep consistent label.
- **Phone as a first-class CTA:** `tel:` link in nav and sticky on mobile; track separately in analytics (Foundgrove; Latte).
- **Destination must match promise**: "Book a call" → inline calendar (not a generic form); "Get a quote" → quote form; "Call now" → `tel:`. Mismatch is "one of the most common mistakes" and depresses conversion; five-step funnel for one ask loses 30–60% per step → collapse to 1–2 steps max (Latte).
- Urgency/exclusivity in footer CTA ("spots filling") only if real (Payfunnels).

### 5.2 Contact form design (fields, progressive disclosure, validation)

Field-count guidance by intent (Foundgrove 2026):
- Top-of-funnel lead magnet capture: **1–2 fields** (email typically beats email+name on cold traffic).
- Services page contact form: **4–6 fields** single step, or 6–8 across two steps.
- Book-a-call page: **3–4 fields max**, then deliver calendar inline. Do not gate calendar behind a long form.
- Overall "sweet spot" for cold contact page = 4 fields (name, work email, project type, one open question) — less feels evasive, more causes abandons (Pravin Kumar: +19% lift renaming button "Send me your project" vs "Submit").

Other form best practices:
- **Single column** (multi-column forms complete 15.4s slower on mobile — CXL via TraffT).
- Qualifying fields as **button options/radio ranges**, not free text (budget as 5 buttons, timeline radio, revenue ranges).
- **Inline validation** with clear error messages; accessible labels; visible focus state (WCAG-adequate contrast).
- **Spam protection without friction**: honeypot + lightweight bot checks; avoid heavy CAPTCHA; consider Cloudflare Turnstile (Architect owns).
- **Friendly confirmation + email receipt**; show expected response time.
- **"What happens after submit" 3-sentence block** is the highest-leverage copy on a B2B contact page (Pravin Kumar: form-only pages convert 1.4%, form+trust+calendar converts 5.2% → 3.7x on same page).
- Conditional ("progressive") fields for deeper qualification once basic fields complete.
- Form in two-column Z-pattern layout (value statement + avatar + response time + 3 logos left; form right) tested by Pravin Kumar outperforming alternatives in his own A/B tests (n=his clients — directional, not peer-reviewed).

### 5.3 Booking flows

Key distinction (TraffT): **a booking page resolves availability and confirms a reservation; it is NOT a contact form nor a checkout.**

Best practices:
- **Allow guest booking** — forced account creation is cited at 24% abandonment (Baymard 2024).
- **Remove all fields not needed to confirm** the reservation (name, contact, date, service type usually enough); collect the rest post-booking by email.
- **Calendar embedded inline on the page beats popup by 23%** (Cal.com Jan 2026 data cited); Calendly/Acuity/TidyCal/Cal.com all viable; open-source/self-hosted (Cal.com) matters for data residency.
- **Single 15-minute slot type by default** to avoid choice paralysis; multi-option pages lose conversion.
- **Pre-fill calendar fields** from prior quiz/page data (name, email, preferred date).
- **Show pricing, cancellation policy, and confirmation details prominently** (date, time, service, reference number, calendar link, reschedule path).
- **Responsive**: single column, ≥15.4s faster completion; avoid tiny tap targets and bad date pickers (≈60% of reservations on mobile, Prostay 2024; mobile conversion still lags desktop).
- **Two valid structures** (Emberlyn Marketing / Emberlyn.co):
  1. **Lead form/application first → invite to calendar** (best when time is scarce or offers are high-ticket; qualifies upfront).
  2. **Embedded calendar + short intake** (most frictionless; becoming standard for service businesses).
  → IXI's choice depends on owner's time/capacity and average deal size; default = hybrid (calendar on `/book`, no long form) with an application-style form option on `/pricing` for bespoke work; recommend owner pick consciously (open question).
- **Thank-you page is an untapped asset**: set next-step expectations, walk-through video, general pricing so there are no surprises; build trust while attention is highest (Emberlyn).
- **Quiz-funnel variant** (ConvertFlow "service appointment booking quiz funnel"): 4 questions (service, frequency, location, preferred date) **then** contact gate **then** "match" page **then** calendar. Captures lead even if booking abandoned. Reported average 11.28% lead conversion on landing-page format; but this requires a scheduling tool + ESP/CRM and is overkill at launch — revisit after v1 data. Treat the reported numbers as one platform's benchmark, not a guarantee.
- **Speed-to-lead**: a 2011 MIT/InsideSales study is commonly cited showing ~7x qualification likelihood within an hour; the "5-minute rule" is apocryphal (original source no longer exists) — per Foundgrove. Recommend: acknowledge any inbound within 1 business day max, target <4 hours during working hours, and build a 6-email follow-up sequence with a fast-lane for high-intent signals. Rule of thumb only — measure on our own funnel.
- Click-to-call (`tel:`) on mobile especially on pricing page; can be faster to revenue than form fills (Foundgrove).

### 5.4 Lead capture without hurting trust (offer progression)

- Match the ask to commitment: TOFU lead magnet → MOFU qualifying form → BOFU calendar. Mixing (e.g., Calendly on hero for cold traffic) is "one of the most common conversion mistakes" (Foundgrove 2026).
- Lead magnets must be genuinely useful (niche checklists/mini-guides), 1–2 fields, email-only on cold traffic.
- **"One exit path, not five"** (Timescanner): every additional option (newsletter, download, chatbot, form, calendar) is a reason not to take the harder primary action. Remove competing exits.
- Personalization: on return visits don't re-show a downloaded magnet; cookie-based check swapping CTA (even simple version lifts capture by matching ask to where visitor is).
- TOFU popups: blog only, never cover booking button on mobile (7th Growth).

### 5.5 What typically kills conversions on service sites (red list for QA)

1. CTA buried in footer / single CTA at bottom; no CTA in nav or sticky mobile.
2. Generic CTA copy ("Contact us", "Submit", "Get in touch").
3. Hidden phone number.
4. Button promise ≠ destination (form instead of calendar).
5. 5-step funnel for one ask (each step loses 30–60%).
6. Long forms at the booking step (6–12 fields single step).
7. Forced account creation.
8. Multi-column forms on mobile.
9. Competing CTAs at equal visual weight.
10. No "what happens next" / no response-time promise after form.
11. No social proof adjacent to the CTA.
12. Positioning around the freelancer/studio rather than the client's problem/outcome (Timescanner) → bounces.
13. Long generic service list (8+ categories) → perceived lack of specialty; split into focused offerings.
14. Client logos with no context; awards/badges irrelevant to buyer problem.
15. Wall-of-text case studies prospects won't finish (use 3-sentence summaries + optional deep dive).
16. Performance killer: autoplay/heavy video; uncompressed images (Payfunnels, GitNexa) (Architect owns specifics).
17. Contact page only a bare form; no trust block, no calendar, no response time ("I treated the contact page as a chore" → fix is half a day; +3.7x) (Pravin Kumar).

Sources: https://latte.dev/guide/cta-button-design , https://7thgrowth.com/blog/why-your-service-business-website-needs-one-clear-path-to-appointment-booking/ , https://foundgrove.com/blog/conversion-optimized-lead-capture-2026 , https://tactstack.com/guides/build-a-booking-website-page , https://www.pravinkumar.co/blog/webflow-contact-page-design-book-calls-2026 , https://www.convertflow.com/playbooks/service-appointment-booking-quiz-funnel , https://trafft.com/booking-page-design/ , https://www.emberlyn.co/blog/booking-page-structure-for-service-providers , https://www.timescanner.io/blog/freelance-website-generates-inquiries

---

## 6. Reference sites (automation + dev agencies)

Selected for diversity of positioning, trust model, and pricing pattern. Seven automation-agency sites were fetched and inspected directly (GolmTech, Automation Ace, Nex Automations, Frederik Daneels, IOA Digital, FIMM Digital, Cortex). The Collabas list and template pages are meta-references, not agency sites. Each entry gives what it does well, what to avoid, and one concrete takeaway.

### Site 1 -- GolmTech -- https://golmtech.solutions/

- Does well: Hero line "Not demos. Systems that run in production"; ~100 published Zapier apps as externally verifiable proof (via the Zapier partner directory); Zapier Platinum partner badge; named specific services (AI voice and chat agents, custom AI agents, Make/n8n).
- Avoid: Heavy platform density (logos for Zapier/Make/n8n/AI) without a plain-English client-benefit line; risk of feeling like a tool shop rather than an outcome shop.
- Takeaway: Use publishable, third-party-verifiable proof (marketplace apps, partner directories) instead of self-declared stats; lead with outcomes, keep tooling as a secondary signal.

### Site 2 -- Automation Ace (Troy Tessalone) -- https://automationace.com/

- Does well: A "proof dashboard" of specific, verifiable numbers (850+ clients, 825+ apps/integrations, 10k+ automations, 550+ five-star reviews, #1 Zapier Community Contributor, Upwork Top 1%); partner-tier badges linking to third-party profiles; a dedicated subscription monitoring offer ("Automation Assurance -- $25/week").
- Avoid: Requires real volume to support the numbers -- padding destroys the effect; service list is dense (~6 categories with 10+ sub-offerings each).
- Takeaway: Build your trust dashboard only from metrics verifiable on third-party pages (partner directory, Upwork, Fiverr, Clutch), and offer a low-cost ongoing maintenance subscription alongside the build.

### Site 3 -- Nex Automations -- https://nex-automations.com/

- Does well: Scope and price stated before the build (single $300-$800, multi-workflow $1,500-$5,000, operational from $5,000/mo, maintenance from $99/mo); tool chosen per process with documented reasoning; quantitative case snapshots with the number that moved; extensive FAQ; verified third-party credentials linked (Make Level 5, Make/Zapier partner directories, 83 Fiverr reviews).
- Avoid: Long tiered service list (seven buyer pages plus many service cards) -- segment by audience to keep cognitive load down.
- Takeaway: Publish "starting at / range" prices with fixed written scope and a $99/mo maintenance retainer -- this is the 2026 benchmark to clear; quantify one metric per case rather than deep profiles.

### Site 4 -- Frederik Daneels -- https://frederikdaneels.com/

- Does well: Strong positioning ("Automation isn't your job. Running the business is."); automation framed as a "department" like accounting ("automation as a service"); monthly retainer with embedded monitoring, month-to-month, no lock-in; documented video library of all automations; hands-off handover; named testimonials with titles and numbers.
- Avoid: Strong opinion ("I prefer not to build with Zapier") only works if consistent with case studies; the offer is niche (long-term retainer) and not every buyer wants that commitment model.
- Takeaway: Sell the "silent-failure" fear reversal -- documented handover + credentials in client's own accounts + month-to-month + monitoring -- as the differentiator; automation buyers fear being locked in once the builder leaves.

### Site 5 -- IOA Digital -- https://ioadigital.com/make-com-agency/

- Does well: "Credential, not identity" honesty (explicit tool-agnostic stance across Make.com, n8n, and custom Node/Python); quantified recovery stories (781 silently-lost leads recovered; $17K/yr Zapier savings; $250K+ wages saved; 95% fewer lost orders); a "When Make.com is the wrong tool" section; a "six questions to ask any agency" block (reuse as buyer education); documented process of build/fix/operate.
- Avoid: Very long-dense page (compress to testable sections for a solo studio); SMB counts disagree across pages ("253+ SMBs" vs "453+ SMBs") -- publishing an inconsistent number anywhere kills trust.
- Takeaway: Publish honest "we don't always use Tool X" reasoning plus a "when NOT to use it" section -- this reads as engineering credibility and pre-empts a common buyer objection; keep self-published numbers internally consistent.

### Site 6 -- FIMM Digital -- https://fimmdigital.com/services/workflow-automation

- Does well: "Anyone can connect two apps in a demo. The hard part is month six" -- failure-as-value messaging; clean platform comparison FAQ (Zapier fastest/most expensive at volume, Make in the middle, n8n cheapest/most powerful at scale); E-E-A-T floor (named incorporation, team size, street address, phone); case studies with real numbers (Fresh Box, 75% of a bad batch still ships, 198 modules / 0 failures).
- Avoid: Heavy volume of services and industries dilutes the core automations message; numbers live on case-detail pages, so the landing service page carries less proof than it could.
- Takeaway: Use "what breaks is what matters" as a positioning niche (builds that survive month six) -- it pairs naturally with a documented handover plus a maintenance offer; put at least one numbered case snapshot on each service page.

### Site 7 -- Cortex Automated Solutions -- https://cortexautomatedsolutions.com/

- Does well: Clear productized price ladder ($750 pilot / $1,250/mo growth / custom scale) with concrete deliverables per tier -- a clean, repeatable anchoring device; FAQs pre-answering scope/tools/duration; "Book an audit" CTA leading to an inline qualifying form.
- Avoid: Clearly early-stage page (placeholder bio copy, small/unverifiable scale signals like "8+ active clients" next to "25 case studies") -- asymmetry reads oddly.
- Takeaway: Publish a productized "pilot / retainer / custom" price ladder as a qualifying-and-anchoring device, but only with real case studies and real bios behind it.

### Meta-reference -- Collabas editorial study (not an agency site) -- https://collabas.com/blog/ai-automation-agency-website-examples

- Synthesizes 7 agency site architectures (PhaseLink, AI Makers, HatchWorks, Neurons Lab, Master of Code, The Automators, Lumyniq, Automately template). Lesson: structure choices depend on audience (enterprise vs specialist vs niche/local); IXI (solo studio) should copy the lean specialist structures (PhaseLink/Lumyniq-style) at launch, not Master-of-Code depth. Also documents the ethics rule IXI should follow: clearly label sample/synthetic work, never fabricate proof.

### Module checklist (reference, not sites)

- Webflow agency templates (Automora, Clavion, Flowcraft) document the module set a modern agency site ships (hero metrics, services CMS, case studies CMS, process, pricing, testimonials, FAQ, contact) -- useful completeness checklist only; templates don't prove performance. (https://webflow.com/templates/html/automora-website-template, https://solofoundryhq.com/templates/flowcraft/)

**Cross-site synthesis (what the top performers consistently do):**

1. One strong, defensible positioning line in the hero; named niche; tooling is secondary.
2. Partner badges + specific, verifiable proof (marketplace listings, third-party reviews, client logos with context) above the fold.
3. Price is either published with written scope or accompanied by a named discovery step -- no vague "let's talk" as the only path.
4. Maintenance/monitoring is sold from day one; silent failure is named as the thing they prevent.
5. Handover/ownership guarantees ("running in your accounts, not mine") called out as a risk reducer.
6. Case studies foreground the number that moved and the buyer's problem, not internal terminology.

## 7. Sources (URLs consulted)

1. https://www.payfunnels.com/how-to-build-an-agency-website/
2. https://koder.ai/blog/build-freelancer-website-services-case-studies
3. https://www.gitnexa.com/blogs/how-to-create-a-portfolio-website-that-attracts-clients
4. https://www.timescanner.io/blog/freelance-website-generates-inquiries
5. https://www.we.inc/blog/portfolio-website-tips-for-freelancers
6. https://koder.ai/blog/how-to-build-website-productized-service-offering
7. https://tepublico.net/en/web-design-for/automation-agency/
8. https://onenine.com/best-service-websites-design/
9. https://tactstack.com/guides/build-a-booking-website-page
10. https://latte.dev/guide/cta-button-design
11. https://7thgrowth.com/blog/why-your-service-business-website-needs-one-clear-path-to-appointment-booking/
12. https://www.convertflow.com/playbooks/service-appointment-booking-quiz-funnel
13. https://trafft.com/booking-page-design/
14. https://foundgrove.com/blog/conversion-optimized-lead-capture-2026
15. https://www.emberlyn.co/blog/booking-page-structure-for-service-providers
16. https://www.pravinkumar.co/blog/webflow-contact-page-design-book-calls-2026
17. https://golmtech.solutions/
18. https://automationace.com/
19. https://nex-automations.com/services
20. https://frederikdaneels.com/
21. https://ioadigital.com/make-com-agency/
22. https://fimmdigital.com/services/workflow-automation
23. https://hackceleration.com/agency/automation
24. https://autom8.work/
25. https://cortexautomatedsolutions.com/
26. https://collabas.com/blog/ai-automation-agency-website-examples
27. https://www.codorai.com/
28. https://webflow.com/templates/html/automora-website-template
29. https://solofoundryhq.com/templates/flowcraft/
30. https://www.webestica.com/webflow-templates/ai-automation-agency-webflow-template
31. https://www.clickmaking.com/services/ai-automation

---

## 8. Actionable conclusions (for Phase 2 planning)

1. Adopt lean 6–7 page IA (Home, Services index + detail pages, Work/Case studies index + detail, Process, Pricing, About, Contact/Book) with **one consistent primary CTA labeled "Book a 15-minute call"** across every page; secondary actions as plain text/footer links only.
2. Lead with client-outcome positioning (headline names buyer's problem and result); self-identification within 5 seconds; apply the "stranger test" to the hero copy, prioritize outcomes over tooling.
3. Present **3–5 focused service offerings with their own pages** (not a 8+ item catch-all list); packages with deliverables, timeline, revision limits, in/out scope boundaries; published "starting at" anchors plus a bespoke-quote path for complex work.
4. Invest in **2–4 quantified, templated case studies** (Context → Problem → Approach → Execution (with screenshots/diagrams) → Results/number → testimonial) plus short 3-sentence problem/outcome cards for the rest; label anything synthetic as sample work.
5. Use a **two-layer trust build**: platform/partner badges + specific metrics above the fold plus human proof (real photo, response-time promise, documented handover/ownership, monitoring retainer) — automate buyers' biggest fear is silent failure after handover.
6. Build a **dedicated /book page** with an embedded (inline, not popup) calendar (Calendly/Cal.com) and a **≤3-field intake** if calendar-first chosen, OR application form-first for high-ticket bespoke work; include the "what happens after you submit" 3-sentence block and response time; ship a substantive thank-you page.
7. Use **progressive lead capture by intent** (TOFU 1–2 field magnet on content → MOFU 4–6 field qualifying form [qualifying fields as buttons/ranges] on service pages → BOFU calendar on /pricing and /book) — never a single generic CTA everywhere; remove competing exits; cookie-based swap to avoid re-showing a downloaded magnet.
8. Set **copy/tone standards**: verb-first, outcome-named, buyer-state-matched CTAs ("Book a 15-min call / schedule an automation audit / get a custom quote"); consistent label; no faux urgency. Specify response-time promise ("within 4 business hours").
9. Surface **automation-specific risk-reducer content**: named stack, who-maintains-when-it-breaks, data residency (self-hosted n8n option), reversibility/credentials in client's name, and a documented monthly maintenance retainer — these surface in buyers' questions and drive close rate.
10. Plan the site to **meet WCAG 2.2 AA in both themes** (mobile-first, single-column forms, thumb-zone CTAs, `tel:` click-to-call, alt text, heading structure, schema) with Lighthouse 90+ and GDPR-compliant forms (minimal fields, honeypot/turnstile, privacy+consent, email receipt) — to be confirmed with Architect (§04 file) and Designer (§03 file).

---

## 9. Open questions for the owner (needs decision before Phase 2)

1. Case-study capacity: do you have publishable client results/metrics and permission to name clients, or should IXI start with anonymized "sample projects" labeled as such?
2. Pricing posture: publish ranges/anchors ("starting at €X", "$750 pilot", tiers) or keep quotes on request? Any minimum project size or currency preference?
3. Service catalog: confirm 2–5 primary services you want emphasized, and any preferred industry vertical (agencies, ecommerce, SaaS, operations teams)?
4. Booking model: lead-form-first (filter, good for low capacity/high ticket) vs inline calendar (frictionless, good for high volume) vs pilot-first ($750 discovery)? Owner's available days/times + response-time target needed.
5. Engagement posture: one-off builds only, or also managed "automation as a service" retainer with monitoring? (Affects Pricing page and what we emphasize.)
6. Tech focus: primary platforms to showcase (Make, n8n, Zapier) and whether to advertise data-residency/self-hosted options.
7. "IXI" brand assets: any existing logo/wordmark, photo/headshot for About/Contact, preferred language(s) for the copy, and any domain constraints.
8. Availability & capacity signal: are you open to new clients now, and any capacity limits we should publish ("2 slots/month")? Only publish if real.

---

Status: DONE
File: C:\Users\Kalch\Documents\IXI\research\01-analyst-service-sites-conversion.md
5-line summary:
- IXI needs a lean, 6–7 page IA with one persistent, specific primary CTA ("Book a 15-minute call") rather than a generic contact form; messaging must lead with the client's problem and outcome, not the freelancer's skillset.
- 3–5 focused service offerings with their own pages outperform an 8-item generic list; publish "starting at" or range pricing plus in/out-scope boundaries and a maintenance retainer, since automation buyers fear lock-in and silent failure.
- 2–4 quantified case studies using a standard Context→Problem→Approach→Result→Testimonial template (anonymized/labeled honestly if NDA), backed by named metrics and partner-tier badges, are the strongest trust levers.
- Booking should resolve availability (inline calendar, ≤3 fields, guest checkout, no forced account) rather than a bare contact form; offer progression (TOFU magnet → MOFU qualifying form → BOFU booking) avoids low-quality leads, and competing CTAs must be removed.
- Owner decisions required on launch case studies, pricing posture, service scope, booking model (calendar vs application), retainer offering, tech focus, and brand assets before Phase 2 lock.
Questions for owner listed in §9; only the material ones need answers before planning.
