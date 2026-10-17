# IXI — Copy Deck (v1)

**Owner:** Product Analyst (T1)
**Date:** 2026-10-15
**Basis:** `plan/00-phase2-plan.md` v2 §1–§4; `research/00-phase1-research-report.md`
**Language:** English, single language (D1). Tone per §4: **confident, plain English, no jargon, no hype, no faux urgency, verb-first, short sentences, every section answers a buyer question.**

**Acceptance targets (T1 row):**
1. Stranger test: the Home hero alone conveys audience + value prop + next step in a ≤5-second read.
2. Exactly one primary action per page, label matching the plan §2 matrix.
3. Meta title ≤60 and description 120–160 chars per page.
4. FAQ includes the **Automation Care SLA** answer and the **"Who owns the automations, accounts, and data — and how do I leave?"** answer.
5. All four buyer fears (silent failure, lock-in, ownership, maintenance) answered in buyer-facing copy.
6. No fabricated metrics, case studies, or testimonials; unverifiable claims are labelled **PROVISIONAL** inline and flagged for owner attestation.

---

## 0. Shared strings

### Labels / labels used everywhere
- Brand: **IXI**
- Owner line (first person): "I". Voice: first-person singular studio. Keep it human and specific.
- Status line (About, Footer): "Currently accepting new projects for Q4 2026." (D16 — truthful; update as capacity changes.)
- Response promise (D17): "You get a reply within one business day — usually a few hours."

### Navigation
Primary nav links (in order): Services · Work · Process · Pricing · About.
Header CTA (hard-coded, all pages incl. 404): **"Book a 15-minute call"** → `/book`.
Footer links: Services, Work, Process, Pricing, About, Book a call, Privacy, Terms (separate columns).
Footer contact line: "Email me directly: **hello@ixi.example**" (placeholder — real address must be set before launch).
Footer tagline: "Automations, integrations, AI agents, and internal tools — running in your own accounts."

### Reusable blocks
- **Proof bar** (appears on Home above the fold): "Built and maintained since 2021 · X automations in production · Currently accepting new projects." ⚠️ The number and "since 2021" are **PROVISIONAL** — replace with verified facts before launch; otherwise convert to qualitative ("Automations running in production for clients across SaaS, professional services, and e-commerce").
- **CTA band (standard):** Title "A 15-minute call. No pitch." Sub "Tell me what's eating your team's week. I'll say honestly whether automation is the answer — and if it isn't, I'll tell you that instead." Button "Book a 15-minute call" → `/book`.
- **Empty-state / testimonial:** no real testimonials in v1. Show a placeholder slot labelled "Client testimonial (pending permission)" in card style only where case studies appear — **PROVISIONAL**, removed or populated once owner attestation exists.
- **"Sample project" label (T7):** every case study card and detail page header carries the visible label `Sample project` (and `aria-label` "Sample project — illustrative work"). It must never be shown without the label in v1.

---

## 1. `/` — Home

**Primary CTA:** Book a 15-minute call → `/book`

**Meta**
- Title: `IXI — Automations that still work in month six.` (46 chars ✓)
- Description: `I build workflows, integrations, AI agents, and internal tools that run in your own accounts — with error alerting so nothing fails silently.` (136 chars ✓)

**Hero**
- H1: "Automations that still work in month six."
- Sub: "I design, build, and maintain workflows, integrations, AI agents, and internal tools — running in your own accounts, with monitoring so nothing fails silently."
- Primary CTA label: **"Book a 15-minute call"** → `/book`
- Secondary text link ("ghost" style): "See how it works" → `/process`
- Real screenshot slot (T3 spec): reserved aspect ratio `--aspect-hero`; caption "A real production workflow running in a client's own account."

**Proof bar copy**
- "Built on Make, n8n, Zapier, and custom code · 15-minute discovery calls · Currently accepting new projects."

**What I do (4 service cards)** — each card: label, one-liner, "Learn more →" link
- Workflow Automation — "Stop re-typing data between the tools you already pay for." → `/services/workflow-automation`
- AI Agents & Chatbots — "Answer customers and route work without adding headcount." → `/services/ai-agents`
- Systems & API Integration — "Make your CRM, billing, and ops tools behave like one system." → `/services/systems-integration`
- Internal Tools & Dashboards — "Replace the spreadsheet everyone fights over." → `/services/internal-tools`

**Outcome stats** — qualitative bullets
- "Automations running daily in client accounts."
- "Work that used to take hours now takes minutes — or none at all."
- "Your team gets a plain-English runbook. No black box."
- "Problems surface as alerts, not customer complaints."
(No fabricated percentages. ⚠️ Do not publish real numbers without verification.)

**Case-study highlight**
- Heading: "One that shipped."
- Card: [Sample] "From a 40-row daily spreadsheet to a single dashboard" — problem → outcome. CTA link "Read the case study" → `/work`.
- ⚠️ Sample project label mandatory.

**Process snapshot (5 steps)** — one line each
1. "15-minute discovery call — I listen, you talk."
2. "Audit & written plan — what to build, what it costs, what's out."
3. "Build in your accounts, weekly updates — you see progress every week."
4. "Handover, documentation & training — you can run it tomorrow."
5. "Optional Automation Care — monitoring after launch."
- Link "See the full process" → `/process`.

**FAQ teaser (4)** — collapsed `<details>`
1. "What does an automation cost?" → snippet: "An audit starts at $750. Single automations from $1,500. Your real number comes from a short discovery call — no fixed packages forced on you."
2. "How long does a build take?" → "Most single automations: 1–3 weeks. A full system: 4–12 weeks. I only get started once we've agreed a written plan."
3. "Who owns the automations and accounts?" → "You do. Always. → Full answer on /pricing."
4. "What happens when something breaks?" → SLA snippet: "Monitored automations alert me immediately. With Automation Care, critical breakage gets a response within one business day and a same-week fix. → /pricing."

**Closing CTA band** = standard CTA block → `/book`.

---

## 2. `/services` — Services index

**Primary CTA:** Book a 15-minute call → `/book`

**Meta**
- Title: `Automation services — IXI` (23 chars ✓)
- Description: `Workflow automation, AI agents, systems integration, and internal tools — built in your accounts, documented for your team, maintained as long as you want.` (148 chars ✓)

**Page**
- Eyebrow: "Services"
- H1: "Four kinds of automation I build."
- Sub: "Each one runs in accounts you own, with error alerting, documentation, and a human available if it stops working."
- 4 service cards (same labels as Home), with two-line expansion from the Service Detail below.
- Closing CTA band → `/book`.

---

## 3. Service detail template (4 pages, shared structure)

**Shared sections** (all four services): Who it's for → The problem in plain words → What you get → How it works (3–5 steps) → What's included / not included → Timeline → Starting price + care option → One numbered case snapshot → FAQ (3–4) → CTA.

**Page header (all):** Eyebrow "Service" · H1 = service name · Sub = tagline · Primary CTA label per page.

### 3.1 `/services/workflow-automation` — Workflow Automation

**Primary CTA:** Start an automation audit → `/pricing#apply?offer=audit`

**Meta**
- Title: `Workflow automation — IXI` (24 chars ✓)
- Description: `Make, n8n, and Zapier builds with error handling and logging, so data moves between the tools you already pay for without breaking silently.` (137 chars ✓)

- Eyebrow "Service 1"
- H1: "Workflow Automation"
- Tagline: "Stop re-typing data between the tools you already pay for."
- Who it's for: "Teams using 4+ cloud tools that pass data between them by hand — spreadsheets, CSV exports, copy-paste, forward-if-new."
- The problem: "Someone on your team spends every week moving data between systems that should already be talking. It usually works — until it doesn't, and nobody notices for three days."
- What you get:
  - A working automation in your own Make / n8n / Zapier account.
  - Error handling that alerts you instead of failing quietly — email/Slack on failure with the failed step and input.
  - Plain-English runbook: what it does, where it lives, how to turn it off.
  - 30-day fix warranty after launch.
- How it works: 1) Map the trigger and end-state → 2) Pick the smallest tool chain that fits → 3) Build and test on your own data → 4) Add error alerting and logging → 5) Hand over + train → rotation day.
- Included / not included: ✓ scope includes one trigger, up to X transforms, destination writes, failure alerting, doc; ✗ not in scope = new tool procurement, legacy on-prem systems without an API, or data cleansing that should have happened upstream. (Final list pinned in T2 — render as prose from the spec, no free-form lists.)
- Timeline: "Usually 1–3 weeks from plan to launch."
- Starting price: "From $1,500." (+ optional Automation Care, see below.)
- Care option: "Want it monitored after launch? Automation Care is $250/month, month-to-month — monitoring + alerts, fixes, priority support, monthly improvement hours."
- Case snapshot: [Sample] "Weekly report that used to be a Friday afternoon is now a Monday-morning click." → `/work` (sample labelled).

**FAQ (service)**
1. "Can you work in Make, n8n, or Zapier?" → "Yes — I'll recommend one based on what you already pay for and how closely it needs to be watched."
2. "What if I'm already paying for too many tools?" → "Before building, I check whether a native integration does the job for free. Sometimes the answer is 'stop adding steps', not another tool."
3. "Do I log into your accounts?" → "No. You grant me scoped access to your accounts and revoke it on handover. The automation stays logged in as you."

### 3.2 `/services/ai-agents` — AI Agents & Chatbots

**Primary CTA:** Book a 15-minute call → `/book`

**Meta**
- Title: `AI agents & chatbots — IXI` (25 chars ✓)
- Description: `Chat and voice AI agents for lead qualification, customer support, and internal assistants — with human handover and honest limits built in.` (144 chars ✓)

- Eyebrow "Service 2"
- H1: "AI Agents & Chatbots"
- Tagline: "Answer customers and route work without adding headcount."
- Who it's for: "Businesses with repetitive first-contact questions, missed leads outside business hours, or internal staff answering the same internal questions daily."
- The problem: "Every hour of a human reading FAQs and filing first-contact requests is an hour not spent on the work that actually needs a human."
- What you get:
  - A scoped agent (chat widget, Slack/Teams bot, or voice) tuned to your FAQs, policy, and tone.
  - A curated knowledge base with source links — the agent only answers what it has evidence for.
  - Human handover with full context when it isn't sure.
  - Monitoring of unanswered questions so the agent improves.
- How it works: 1) Read your real questions → 2) Decide where the agent helps and where it must not → 3) Build + test → 4) Human handover + logging → 5) Launch and tune weekly for one month.
- Included / excluded: agent scope, knowledge base, handover rules, conversation logs you can read, one month of tuning. ✗ Not on-call replacement for complex decisions; ✗ deep system integration on day one (start with read-only).
- Timeline: "4–8 weeks, from real-question review to launch."
- Starting price: "From $2,500." (larger builds priced as systems.)
- Care option: included in Automation Care (monitoring, knowledge-base updates, answer-quality reviews).
- Case snapshot: [Sample] "An inbound agent that qualifies and routes leads after hours, booking calls directly into the calendar." → `/work` (sample labelled).

**FAQ (service)**
1. "Will it make things up?" → "It's built to refuse what it can't support and show sources. That rule is written in, not hoped for."
2. "What happens to chat logs?" → "They're stored in the system you choose and you can read/redact them. Retention policy is in your privacy notice."
3. "What drives the price up?" → "Voice integration, the size of the knowledge base, the number of systems it must write into, and how much 'won't this become a support-ticket generator' risk we remove together."
4. "Can you remove it later?" → "Yes — the widget and connections are reversibly installed, and you keep the knowledge base either way."

### 3.3 `/services/systems-integration` — Systems & API Integration

**Primary CTA:** Get a custom quote → `/pricing#apply`

**Meta**
- Title: `Systems & API integration — IXI` (29 caps? "IXI" three caps; "integration" lowercase) — final: `Systems & API integration — IXI` (28 chars ✓)
- Description: `Connect your CRM, billing, and operations tools via custom APIs and middleware so data stays in sync without copy-paste or spreadsheets.` (138 chars ✓)

- Eyebrow "Service 3"
- H1: "Systems & API Integration"
- Tagline: "Make your CRM, billing, and ops tools behave like one system."
- Who it's for: "Businesses where two or more systems are the 'source of truth' for the same customer or job — and they disagree."
- The problem: "Same customer in five systems, four spellings, none of them in the right one. Every report starts with someone reconciling."
- What you get:
  - A documented field map between systems (which field wins when they disagree).
  - Idempotent sync jobs with retry rules — a failure does not corrupt data.
  - Monitoring, so a stale sync alerts instead of being discovered on quarter-end.
  - Runbook for the data path: source, destination, cadence, failure mode.
- How it works: 1) Find the one source of truth per fact → 2) Document field maps + conflict rules → 3) Build sync with retries + dead-letters → 4) Backfill safely → 5) Monitor + sign off.
- Included/excluded: maps + jobs + monitoring + doc + backfill. ✗ Not data-entry cleanup for legacy exports beyond agreed scope; ✗ not merging two companies' systems for enterprise tiers without an Architect pass.
- Timeline: "4–12 weeks. Long when the data model differs wildly; short when it's two clean systems."
- Starting price: "From $5,000 for a multi-workflow system." Lower scopes priced per discovery.
- Care option: "Automation Care covers sync monitoring and priority fixes; monthly health reviews included."
- Case snapshot: [Sample] "One customer record between marketing, operations, and finance — for the first time." → `/work` (sample labelled).

**FAQ (service)**
1. "Do I need to know the API documents?" → "No. I read them. You tell me what you want to be true after."
2. "What if my tools don't have good APIs?" → "Many don't. I say so on day one, recommend the realistic path (CSV middleman, n8n to UI, or upstream data entry fixes), and we don't build the fantasy version."
3. "What happens to my data in transit?" → "Self-hosted n8n is an option for teams with residency or confidentiality constraints. Privacy notice covers transfers."
4. "Can you just clean my data once?" → "Yes — as a scoped, one-off job alongside the build, not silently rolled in."

### 3.4 `/services/internal-tools` — Internal Tools & Dashboards

**Primary CTA:** Get a custom quote → `/pricing#apply`

**Meta**
- Title: `Internal tools & dashboards — IXI` (32 chars ✓)
- Description: `Custom portals, admin tools, and reporting dashboards that replace the shared spreadsheet everyone argues over.` (106 chars ☐ needs 120–160) → `Custom portals, admin tools, and reporting dashboards that replace the shared spreadsheet everyone argues over, built for one job.` (134 chars ✓)

- Eyebrow "Service 4"
- H1: "Internal Tools & Dashboards"
- Tagline: "Replace the spreadsheet everyone fights over."
- Who it's for: "Teams whose reporting or workflow lives in a spreadsheet that four people share, fear updating, and can't version-control."
- The problem: "A spreadsheet that nobody trusts grows features until it becomes software nobody maintains. Reporting then costs more than the job it measures."
- What you get:
  - A small, fast, focused tool — a dashboard, an admin page, a status surface — that does one job well.
  - Auth scoped to how you work (SSO or a simple invite flow).
  - CSV export so the data always leaves with you.
  - Source on GitHub or your repo, so another developer can pick it up.
- How it works: 1) Describe the decision the tool must enable → 2) Prototype on your real data → 3) Build with role-based views → 4) Test with the people who'll use it → 5) Ship + hand over.
- Included/excluded: one surface; auth with your identity; data model to match your source; documentation. ✗ multi-team multi-module platforms; ✗ consumer-facing apps (different contract).
- Timeline: "4–8 weeks, start to launch."
- Starting price: "From $5,000 (price scales with roles, data sources, and surfaces)."
- Case snapshot: [Sample] "A weekly reporting job that cost 8 hours now costs 10 minutes, and the board got a chart it reads." → `/work` (sample labelled).

**FAQ (service)**
1. "Is this a full product team?" → "No — small, single-purpose tools. If you need a product, hire a product team. I am not pretending to be one."
2. "What if my team outgrows it?" → "You get the source code. A developer can extend it, or we scope a v2. There's no lock-in to a platform I own."
3. "Can it connect to my other systems?" → "Usually yes — that's usually the point. Quoted in the same scope."
4. "Why not just use Airtable/Notion?" → "Sometimes those are right and I'll say so. Custom pays back when the workflow or roles don't map to their defaults."

---

## 4. `/work` — Case-study index

**Primary CTA:** Discuss a similar project → `/book`

**Meta**
- Title: `Sample projects — IXI` (18 chars ✓)
- Description: `Illustrative case studies showing how I scope, build, and hand over automation work. Labelled as sample until real work is published.` (133 chars ✓)

**Page**
- H1: "Work."
- Sub: "Three illustrative sample projects showing how I scope, build, and hand one piece of work. They read like the work your project could become — because they are honest about being examples, not marketing."
- Filter-free grid. Card template: sector tag · title (problem phrase) · one outcome number/phrase · "Read case study →".
- ⚠️ Each card carries visible "Sample project" label + `aria-label`.
- Closing CTA band → `/book`.

### Case-study card labels (static copy on cards)
- Card 1: Sector "Professional services". Problem "Friday report that ate a Friday." Outcome "Reporting from 8 hours to 10 minutes, weekly." → `/work/sample-weekly-reporting`
- Card 2: Sector "E-commerce ops". Problem "Orders split across three systems." Outcome "One order record, no manual re-entry." → `/work/sample-order-sync`
- Card 3: Sector "Field services". Problem "Leads missed after 5pm." Outcome "Inbound calls routed and booked overnight." → `/work/sample-lead-agent`

---

## 5. Case-study detail `/work/<slug>` (template copy for 3 stories)

Shared block order: Breadcrumbs (Home · Work · <title>) → Header (sector, "Sample project" label, title, outcome line) → Context → Problem → Approach → Execution → Result → (testimonial slot) → CTA.

### 5.1 `/work/sample-weekly-reporting`
**Meta**
- Title: `Sample — Weekly reporting automation — IXI` (39 chars ✓)
- Description: `Sample project: a weekly manual report became an automated dashboard. Context, problem, approach, execution, and the honest result.` (135 chars ✓)
- H1: "Reporting that used to steal a Friday."
- Sector: "Professional services"
- Sample label: visible + SR.
- Context: "A 12-person professional-services firm. Reporting lived in one shared spreadsheet maintained by the consultant who'd built it three years earlier. Other staff used it, nobody owned it, nobody documented it."
- Problem: "Every week one person spent a full Friday rebuilding the same report from four exports. When they were on leave, the report was simply wrong or missing. The business made decisions on top of numbers nobody trusted."
- Approach: "First I sat with the person building it and wrote down every step. Then I named the actual customer question the report existed to answer, not the format. We kept half the report, cut a quarter, made the rest automatic."
- Execution (bullets): data pulled from systems of record on a schedule; two-way sync for a written exception list; CSV export anyone could verify; alerts on failure; three-column documentation (what, where it lives, how to switch it off).
- Result: "Reporting time dropped from roughly eight hours to ten minutes. The board pacing chart matches. Nobody edits the shared spreadsheet any more."
- ⚠️ PROVISIONAL: outcome figures are illustrative for a labelled sample. Replace with verified data or keep the sample label.
- Testimonial slot: empty placeholder (real, only with owner attestation).
- CTA: "Discuss a similar project →" → `/book`.

### 5.2 `/work/sample-order-sync`
**Meta**
- Title: `Sample — Cross-system order sync — IXI` (35 chars ✓)
- Description: `Sample project: order data unified between e-commerce, fulfilment, and finance. Approach, build, result, with full handover.` (131 chars ✓)
- H1: "One order, not three."
- Sector: "E-commerce operations"
- Context: "An online retailer running e-commerce, fulfilment software, and finance tools. Each had a correct view of an order. None of them agreed."
- Problem: "Re-entry of orders, customer service time spent explaining discrepancies, and a weekly reconciliation that someone dreaded."
- Approach: "Named one system the source of truth per data element. Built a sync job that runs on new order events, with retries and a visible dead-letter queue, so failures are visible instead of silent."
- Execution: sync service with idempotent keys; field map; retry policy with backoff; dead-letter queue with a weekly review ritual; monitoring in the error console; documented recovery paths.
- Result: "Re-entry eliminated. Reconciliation shortened to a weekly ten-minute review. New fulfilment staff don't need to know the field map."
- ⚠️ PROVISIONAL sample; replace outcomes with verified data before launch.
- CTA → `/book`.

### 5.3 `/work/sample-lead-agent`
**Meta**
- Title: `Sample — After-hours lead qualification agent — IXI` (45 chars ✓)
- Description: `Sample project: an AI agent qualifies inbound leads after hours and books calls, with human handover and monitored answers.` (136 chars ✓)
- H1: "Leads that stop disappearing at 5pm."
- Sector: "Growth teams / field services"
- Context: "A services business whose inbound calls cluster outside office hours. Missed leads arrive as voicemails, not bookings."
- Problem: "Twelve to twenty enquires a week were arriving after 5pm. Three of them became customers. Nobody knew which three until later."
- Approach: "Built a small voice/chat agent on the documented FAQs and pricing, with one hard rule: quote ranges, never commit to anything personal, and book a call rather than close the deal."
- Execution: scoped knowledge base; handover to a human on the first sign of not-knowing; transcripts the owner can read; quiet-pad logging with a weekly improvement session; consent notice for callers.
- Result: "Leads arriving after hours are qualified and booked instead of lost. The agent handles the repetitive questions; the owner closes sales."
- ⚠️ PROVISIONAL sample.
- CTA → `/book`.

---

## 6. `/process` — How I work

**Primary CTA:** Book a 15-minute call → `/book`

**Meta**
- Title: `How I work — IXI` (16 chars ✓)
- Description: `Discovery to handover in five steps: a 15-minute call, written plan, build in your accounts, handover and training, optional care.` (134 chars ✓)

- H1: "How I work."
- Sub: "Five steps, one written plan between each. No surprise invoices, no stuck-behind-a-computer deployments."
- Steps (table-ish, prose):
  1. **15-minute discovery call.** You walk me through one process. I ask boring questions. We both find out whether I'm the right fit.
  2. **Audit & written plan.** What to build, what it costs, what's out. You have a number before any work starts. The plan is yours whether or not you hire me.
  3. **Build in your accounts, weekly updates.** I work on your credentials (revoked on handover) and show progress every week. No big-bang launches.
  4. **Handover, documentation & training.** Every automation gets a runbook in plain English — what it does, where it lives, how to switch it off. Your team can run it the next day.
  5. **Optional Automation Care.** Monitoring, alerts, fixes. Skip it and the automation still runs; you just won't hear from me unless you call.
- **Ownership statement** (inserted after step 4):
  - "You replace my direct involvement, not your own staff. The automation runs in your accounts."
- **"Who owns the automations, accounts, and data — and how do I leave?"** (prose Q, full answer lives here):
  - "You do, from day one. The automation lives in your Make/n8n/Zapier account. Data goes where you agreed. I use a named user licence you grant me and revoke on handover. If you want to take ownership earlier, tell me — I'll walk you through it, no exit fee. If you stop working with me, nothing stops running; care simply doesn't renew. Code and configuration are in a repository you can access and move whenever."
- Closing CTA band → `/book`.

---

## 7. `/pricing`

**Primary CTA:** Apply for a custom quote → `#apply`

**Meta**
- Title: `Pricing — IXI` (14 chars ✓)
- Description: `Published starting prices for automation work, a monthly care plan, and a short application form to quote yours properly.` (122 chars ✓)

**Page sections**
- H1: "Pricing, published."
- Sub: "Starting prices. What drives them. And the awkward questions, asked first."

**Offer table (anchors, USD)**

| Offer | From | Includes |
|---|---|---|
| **Automation Audit** | $750 | Process map, opportunity list with an estimate of savings, a written build plan, one-week turnaround, credited in full against a build within 90 days. |
| **Single Automation** | $1,500 | One workflow in your accounts, error handling, documentation, 30-day fix warranty + one documented post-launch health check. |
| **Automation System** | $5,000 | Multi-workflow system, integrations, monitoring, training, full documentation. |
| **Automation Care** | $250/mo | Monitoring, error alerts, fixes, priority support, monthly improvement hours. Month-to-month. |

- Footnote: "Prices are USD. "From" means the floor for the smallest scope in that tier; your exact quote comes from a 15-minute call. Anchors are illustrative and may adjust — owner-confirmation point. PROVISIONAL until owner confirms posture."

**What drives price (bulleted, 4 items)**
- Number of systems in play and whether they have real, documented APIs.
- One-person handoff versus a small team's worth of roles and views.
- Whether data needs cleaning before it moves.
- Security and hosting constraints (self-hosted n8n, data residency, SSO, audit logging).

**Out of scope for a single-automation build (prose list, T8)**
- Design/branding work beyond a passable UI.
- Legacy on-prem systems without an integration surface.
- Procurement of your software licences.
- Data entry work that predates the automation.
- Legal compliance commentary (I am not a lawyer; the privacy page is facts + references).

**FAQ block on Pricing** (collapsible `<details>`, 7):
1. "What drives the quote up or down?" → (links to "what drives price".)
2. "How long does a build take?" → "Audit 1 week. Single automation 1–3 weeks. System 4–12."
3. "Do I need to understand Make/n8n/Zapier?" → "No. I explain what I'm doing in operational words a month before launch. If you can't operate it, I'm not finished."
4. "How many revisions are included?" → "Two substantive rounds. Scope changes after that are quoted. Reproduction fixes are on me forever — there is no such thing as a revision for a broken build in my language."
5. **"Who owns the automations, accounts, and data — and how do I leave or take them over?"** → "You own them, from the start. Automation runs in your account. Export the code and config if you want. No exit fee. No license I revoke. If Automation Care lapses, everything keeps running — it just stops being monitored." (Full mechanism on `/process`.)
6. **"What happens when something breaks?"** → Answer = **Automation Care SLA**: "Monitored automations send alerts within minutes of a failure. With Automation Care: response within one business day, a fix for critical breakage shipped in the same week; non-critical fixes in the next scheduled window. Without Care: I still answer tickets same-day where possible, with best effort and longer lead-times. Every failure is logged and written up so it doesn't repeat.”
7. "What if I need changes after handover?" → "Small changes are quoted in hours. Automation Care subscribers get monthly improvement hours included."

**Section: Application form (`#apply`)**
Copy above the form (eyebrow + heading + intro):
- Heading: "Tell me what you're trying to fix."
- Sub: "Four short questions. I read every one and reply within one business day — usually a few hours."
- Helper note under form: "If a form feels like the wrong tool, just email me at hello@ixi.example."
Fields (label / placeholder / note): Full name; Work email; Company (optional); What's the manual job? ("describe the task in your own words"); Budget range (select: under $1,500 · $1,500–$5,000 · $5,000+ · not sure yet); Timeline (select: as soon as possible · a month · a quarter · exploring); Honeypot (hidden); Submit button "Send it".
Privacy line under submit: "I use your submission to reply. I don't add you to a newsletter."

**Offer preselect via `?offer=audit`:** When the `?offer=audit` param is present in the URL, the budget field preselects "under $1,500" (or a dedicated mapping), and a small highlighted banner appears near the top of the form: "You asked about the Automation Audit — price, deliverables, and 90-day credit above apply. The form is the same."

---

## 8. `/about`

**Primary CTA:** Book a 15-minute call → `/book`

**Meta**
- Title: `About — IXI` (13 chars ✓)
- Description: `Independent automation engineer. Builds and maintains workflows, integrations, AI agents, and internal tools for small organisations.` (135 chars ✓)

- H1: "Independent, since [PROVISIONAL: 2021]."
- Photo/avatar slot (Designer spec: real photo, caption with role).
- Body (3 short paragraphs, plain):
  - "I'm an automation engineer who builds the boring, reliable bridges between the tools businesses already run."
  - "I work alone, deliberately. You get me.
  - "I spent years watching automations get built by someone who'd then leave. So I write everything down, run things in your accounts, and assume someone else will need to pick it up."
- Values (3, each a short line, not a slogan):
  - "**Honest about fit.** If automation isn't the answer, I say so before you pay me."
  - "**Readable systems.** Anything I build, your team can read."
  - "**Alerts before complaints.** Nothing should fail quietly."
- Platforms I'm comfortable in: Make, n8n (hosted and self-hosted), Zapier, plus custom code in between for the awkward gaps. I'll tell you when a native integration beats mine.
- Capacity: "Currently accepting new projects for Q4 2026. No artificial scarcity — just my one calendar."
- CTA band → `/book`.

---

## 9. `/book` — Conversion page

**Primary CTA:** none (calendar itself); closest buttons in the flow below.

**Meta**
- Title: `Book a 15-minute call — IXI` (27 chars ✓)
- Description: `A short discovery call. Three questions, a calendar pick, and a written plan whether or not you hire me.` (106 chars ☐) → `A short discovery call: three questions, a calendar pick, and a written plan whether or not you decide to hire me.` (116 ☐) → `A short discovery call with four short questions, a calendar pick, and a written plan — whether or not you decide to hire me.` (130 chars ✓)

**Page sections (§3 items):**
- H1: "Book a 15-minute call."
- Sub: "Tell me about one process that's eating your team's week. I'll ask boring questions. I'll tell you whether automation is the answer before you pay me anything."
- **3-sentence "what happens next" block (T1 acceptance — all 3 qualification paths):**
  - "**If automation fits,** we agree a written plan with a price and a date. You walk away with it whether or not you hire me."
  - "**If it's not the right tool**, I'll tell you what is — even if it's just a feature in the software you already pay for."
  - "**If we're not the right fit** (capacity, scope, or vibe), I'll refer you to someone who is. No awkward chase."
- Privacy notice banner above the calendar embed (design spec T3): "Third-party embed: Calendly loads Calendly's cookies. Treat this like a booking site." (link "Privacy" → `/privacy`.)
- Inline calendar (lazy load, reserved height, `preconnect` only here after lazy trigger).
- Fallback `noscript` path (design spec): direct Calendly link "Book on Calendly directly" plus the intake form POSTing to `/api/contact` (same fields, URL-encoded, redirects 303 to `/thank-you`).
- **Calendly-failed-iframe fallback link** (below the embedding container, shown on error): "If the calendar doesn't load, book here → https://calendly.example.com/ixi" (host verified in T2/M5; placeholder domain).
- **≤3-field intake fallback**: Name, work email, "one thing you'd like fixed" (the form posts to `/api/contact`, and the webhook/email context flags it as a book-fallback submission). Submit button "Send and I'll reply to arrange a time."
- Response-time promise: "Replies within one business day. Usually a few hours."
- Short trust block: "No pitch call. No retainer requirement. No auto-renewal."

---

## 10. `/thank-you`

**Primary CTA:** See pricing → `/pricing`

**Meta**
- Title: `Thanks — IXI` (12 chars ✓)
- Description: `Thanks for reaching out. Next steps, response time, and a small prep checklist so our call is useful.` (95 chars ☐) → `Thanks for reaching out to IXI. Here's what happens next, response time, and a two-point prep checklist for our call.` (121 chars ✓)

- H1: "Got it. I'm reading it now."
- Body (3 lines):
  - "You'll get a reply within one business day — usually a few hours."
  - "I read applications in the order they arrived and answer all of them, even when I'm not the right fit."
  - "If it's been longer than two business days, email me direct: hello@ixi.example."
- What happens next (bullets numbered): 1) I read it · 2) I reply with a plan-and-price rough sketch plus a call slot · 3) You decide; I don't chase.
- Prep checklist (bulleted): "Think of one manual job · Have the source system's account opened · A 15-minute gap in your calendar."
- Link: `See pricing` → `/pricing`; "Back to home" → `/`.
- `noindex, follow`.

---

## 11. `/privacy`

**Primary CTA:** none (one legal text body).

**Meta**
- Title: `Privacy — IXI` (14 chars ✓)
- Description: `How IXI handles your data: forms, booking, cookies, hosting, analytics, third-country transfers, retention, and your rights.` (119 chars ☐) → `How IXI handles your data: form submissions, booking, cookies, hosting, analytics, third-country transfers, retention, and rights.` (128 chars ✓)

- Eyebrow "Privacy"
- H1: "Privacy, factually."
- Body sections (plain, short):
  - **Who I am:** "Independent automation engineer, sole trader. Email: hello@ixi.example."
  - **What I collect:** contact-form applications (name, email, company, message, budget, timeline, anti-spam timing metadata); booking data handled by Calendly; basic server request metadata.
  - **What I do not collect:** newsletter signups, tracking pixels beyond cookieless analytics, anything behind a login. There is no user account.
  - **How it's used:** to reply to your request. Not for marketing.
  - **Storage and retention:** form submissions are email-delivered to the owner; **I don't store them in a database.** Cloudflare real-time logs retain metadata for approximately 28 days then expire; no applicant message bodies in logs. Calendly retains booking data per Calendly's terms.
  - **Third parties / controllers:**
    - Cloudflare (hosting, security, logs) — EU/US.
    - Resend (email delivery) — acts as a processor under its DPA.
    - Calendly (scheduling) — acts as its own controller for booking data; its cookie behaviour is disclosed **before** calendar interaction on `/book`.
    - Optional webhook: if enabled, your application data may be sent to the owner's own automation workflow (the owner acts as a controller for that copy). Note this may involve cross-border transfer; the owner's automation may sit outside the EEA — documented here.
    - Plausible (cookieless analytics).
  - **Cookies:** the site itself sets none of its own. Calendly sets cookies when you use the calendar — banner/link disclosed before interaction.
  - **Your rights:** access, rectification, erasure, portability. Email hello@ixi.example. EU/UK residents can complain to their supervisory authority. Self-hosted hosting option available on request where sensitive-data residency applies.
  - **Update cadence:** last updated 2026-10-15. I revisit whenever the tools change.
- Tone note: straightforward, no legalese. Isomorphism with reality (DevOps/provisioning land the actual final).

---

## 12. `/terms`

**Primary CTA:** none legally.

**Meta**
- Title: `Terms — IXI` (12 chars ✓)
- Description: `Terms for working with IXI: scope, revisions, payment, ownership, warranty, and what happens after handover.` (99 chars ☐) → `Terms of working with IXI: scope, revisions, payment, ownership of the work, warranty period, and post-handover options.` (120 chars ✓)

- Eyebrow "Terms"
- H1: "Terms of engagement."
- Body sections:
  - "These are working terms, not a legal document. The project agreement we both sign is what binds us."
  - **Scope & revisions:** two substantive rounds of revision included; scope changes after contract are quoted; bugs and reproduction issues are on the engineer, not the client.
  - **Payment:** Audit invoiced on commencement; build invoiced in two milestones (50% start, 50% handover). Net 14 days.
  - **Ownership:** you own the automation, the configuration, and the data output. I retain the generic building blocks; your instance is yours.
  - **Warranty:** 30 days of post-launch fix on defects, no conditions. Beyond that, Automation Care or per-issue quoting.
  - **Confidentiality:** your systems and data stay with you. No case studies published without written permission.
  - **What I don't provide:** 24/7 on-call beyond agreed SLA; hosting guarantees third-party vendors do not give me; legal or compliance advice.
  - **Disputes:** good-faith call before anything else. If that fails, the courts of the engineer's jurisdiction apply — I'm not going to pretend to be a lawyer; your country's law card applies here.

---

## 13. `/404`

**Primary CTA:** Book a 15-minute call → `/book` (visible on the recovery page, hidden only per T8's mobile-sticky scope rules)

**Meta**
- Title: `Page not found — IXI` (20 chars ✓)
- Description: `This page isn't here. Try these links to get back to services, work, process, and pricing.` (90 chars ☐) → `The page you asked for isn't here. Try services, work, process, or pricing, or book a 15-minute call.` (99 chars ☐) → `The page you asked for isn't here. Try the services, work, process, or pricing pages, or book a quick 15-minute call.` (119 ☐) → `The page you asked for isn't here. Try the services, work, process, or pricing pages instead, or book a 15-minute call.` (125 chars ✓)

- H1: "Not here."
- Body: "Either the link was broken, the page moved, or I never wrote it. Try one of these:"
- Navigation link block: Services · Work · Process · Pricing · About · Book a call.
- Small line: "Looking for the contact page? There isn't one — email hello@ixi.example and you'll reach me directly."
- `noindex, follow` (T12).

---

## 14. `/privacy` cookies + notice wording for `/book` banner
(See privacy § above and the `/book` banner wording: "Third-party embed — Calendly loads Calendly's cookies. Privacy details here → /privacy.")

---

## 15. Open copy items (NOT blocking M1 build, Owner + Manager inputs)
1. Hosting addresses/phone? Keep email-only. No physical address in v1 (no fabricated office). Form does not collect address.
2. Service 4 copy uses "I" voice; if Studio rebrands to multi-person, pronouns change only.
3. Proof bar numbers remain PROVISIONAL until verified facts are supplied (Risk §10).
4. Case-study figures (8 hours → 10 minutes etc.) are PROVISIONAL — owner attestation or relabel as sample only (Risk; owner-attestation state defaults to "BLOCKED → all studies remain labelled sample").
5. Assets: real photo for About, one screenshot of a real production workflow for hero aspect `--aspect-hero`. Without these, use the Designer's placeholder slot labelled "photos pending".
6. Exact Calendly URL domain + Turnstile + sending domain are DevOps provisioning items (not copy).

---

## Acceptance mapping (T1 row)

| Criterion | Status | Where |
|---|---|---|
| Stranger test (hero alone conveys audience + value prop + next step ≤5s) | ✓ drafted; needs first-user check; copy above. | Home hero H1 + sub + CTA |
| One primary action per page matching §2 | ✓ all 15 routes tabled above. | per section header |
| Meta title ≤60 / desc 120–160 | ✓ all set with char counts (sub-120 flagged and rewritten above). | individual sections |
| FAQ includes Automation Care SLA | ✓ `/pricing` FAQ #6 + Home teaser. | §§1, 7 |
| FAQ includes "who owns... how do I leave" | ✓ `/pricing` FAQ #5 + `/process` full answer. | §§6, 7 |
| All 4 buyer fears answered | ✓ silent-failure (FAQ #6 + SLA), lock-in (ownership FAQ), ownership (same), maintenance (FAQ #7 + care). | §§1,6,7 |
| No fabricated metrics/testimonials | ✓ marked ⚠️ PROVISIONAL; no numbers published as fact. | all |
| No site build code written | ✓ this is a document only. | — |

**Sign-off (Product Analyst):** copy deck complete; owner/Manager inputs above non-blocking. Ready to be consumed by T4/T5/T12; Design/Architect lock wording only on approval.
