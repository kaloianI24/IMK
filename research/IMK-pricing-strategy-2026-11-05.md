# IMK — Pricing Strategy & Rate Card (v1, draft)

**Bot:** Echo (Creative & Copy Lead)
**Date:** 2026-11-05
**Brand:** IMK (formerly IXI) — automation + AI services consultancy
**Currency:** USD (per Phase 1 default D2; changeable)
**Status:** Draft for owner/Manager review. Benchmarks marked **PROVISIONAL** where not verified against primary sources; re-verify before publishing prices.

---

## 1. Executive summary

1. **Position IMK in the "senior independent / boutique" band**, not the cheapest freelancer and not the enterprise consultancy. Target effective rate: **$125–$150/hr**, project floors that pre-qualify serious buyers, retainers that make revenue predictable.
2. **Publish "starting at" anchors with written in/out-of-scope boundaries** (per existing Phase 1 recommendation) — transparency is the differentiator vs. agencies that hide pricing.
3. **Three revenue lines:** (a) fixed-scope project builds, (b) monthly AI/Automation Care retainers, (c) a **white-label reseller program** for digital agencies (new segment requested).
4. **Segment the price ladder** so SMBs, funded startups, and agencies each see a path that fits their budget and buying motion — do not force one ladder on all three.
5. **Anchor high, quote precisely after a 15-minute call.** Every published number is a floor for the smallest scope in that tier; exact price comes from discovery. Credit the audit fee against any build within 90 days.
6. **No fabricated urgency, no fake testimonials, no invented competitor weaknesses.** All competitor references below are either (a) published on their own sites and cited in `research/01-analyst-service-sites-conversion.md` (Nex Automations, Cortex, Automation Ace), or (b) general market ranges stated as directional.

---

## 2. Market context — what buyers actually pay

### 2.1 Competitive benchmarks (published, verifiable)

From `research/01-analyst-service-sites-conversion.md` §6 (sites fetched and inspected directly):

| Provider | Published pricing | Positioning |
|---|---|---|
| Nex Automations | Single $300–$800; multi-workflow $1,500–$5,000; operational from $5,000/mo; maintenance from $99/mo | Scope-and-price-stated-before-build; tool chosen per process |
| Cortex Automated Solutions | $750 pilot; $1,250/mo growth; custom scale | Productized pilot/retainer/custom ladder |
| Automation Ace | $25/wk monitoring subscription ("Automation Assurance") | Trust dashboard from verifiable third-party metrics |
| Frederik Daneels | Monthly retainer, month-to-month, no lock-in | "Automation as a service"; documented handover |
| IMK (current copy deck) | Audit $750; Single Automation $1,500; System $5,000; Care $250/mo | Published anchors, bespoke-quote path |

### 2.2 General market ranges (directional, 2026)

These are **PROVISIONAL** industry ranges for AI/automation development services, compiled from publicly discussed freelancer/agency pricing. They are not from a single audited source and must be re-verified before publishing.

| Service type | Freelancer band | Boutique agency band | Enterprise consultancy band |
|---|---|---|---|
| Hourly rate | $60–$120 | $125–$200 | $250–$450 |
| Day rate (8h) | $450–$900 | $1,000–$1,600 | $2,000–$3,600 |
| AI readiness / strategy audit | $1,000–$3,000 | $2,500–$7,500 | $10,000–$30,000 |
| Single AI agent (chat, scoped RAG) | $2,000–$6,000 | $5,000–$15,000 | $25,000–$75,000 |
| AI workflow integration (add AI to existing process) | $1,500–$5,000 | $4,000–$12,000 | $15,000–$50,000 |
| Voice AI agent | $3,000–$8,000 | $6,000–$20,000 | $30,000–$100,000+ |
| Multi-agent / system build | $8,000–$25,000 | $20,000–$75,000 | $100,000+ |
| Monthly care & monitoring | $150–$500/mo | $400–$2,000/mo | $3,000–$15,000/mo |
| White-label build (agency resale) | n/a | 20–30% below retail | n/a |

**Read:** IMK sits in the boutique band but with a solo-operator cost base, which is the margin opportunity. The published floors should sit at the **bottom of the boutique band** to pre-qualify without pricing out SMBs, with real quotes landing mid-band.

### 2.3 What actually drives the price (use on every quote)

1. Number of systems in play and whether they have real, documented APIs.
2. Whether data needs cleaning before it moves.
3. AI surface area: read-only vs. write actions, number of tools/functions the agent can call.
4. Knowledge-base size and source quality (RAG).
5. Voice vs. text; real-time vs. async.
6. Security/residency constraints (self-hosted n8n, SSO, audit logging, data residency).
7. One-person handoff vs. a team's worth of roles and views.
8. Timeline pressure (rush premium, see §5).

---

## 3. Target client profiles & budget ranges

### 3.1 Segment A — SMB (10–50 employees)

- **Who:** founder/owner-operated or COO-led businesses; operations-heavy (professional services, e-commerce ops, field services, agencies' own ops). Already pay for 4+ SaaS tools; manual glue work eating 5–20 hrs/week.
- **Pain:** missed leads after hours, manual reporting, data that disagrees across systems, a spreadsheet nobody trusts.
- **Budget reality:** $3,000–$25,000 per project is a discretionary-but-considered spend; needs a clear ROI story and a fixed price. Retainer tolerance $300–$1,500/mo.
- **Buying motion:** 2–6 week cycle; decision by founder + one ops person; wants "what happens next" clarity, ownership guarantees, no lock-in. Responds to published "starting at" prices and a short application form.
- **Price fit for IMK:** Audit $1,500; Single Automation / Single AI Agent from $3,500; System builds $10,000+. Care from $350/mo.
- **Do not:** sell enterprise scoping, multi-month discovery phases, or open-ended T&M. Keep scope tight and fixed.

### 3.2 Segment B — Funded startups (Seed–Series A)

- **Who:** CTO/Head of Product or founding engineer at a 15–80 person startup with a real product and a real backlog. Needs AI features shipped, not a strategy deck.
- **Pain:** can't hire fast enough; AI roadmap items stuck behind core product work; needs a senior pair of hands who ships.
- **Budget reality:** $8,000–$60,000 per project; retainer $500–$3,000/mo. Has budget but is price-sensitive on "is this worth a hire vs. a contractor".
- **Buying motion:** 3–8 week cycle; wants speed, clear scope, code in their repo, handover. Values embedded engineers over agencies. Will ask for references and code samples.
- **Price fit for IMK:** System builds from $10,000; AI feature sprints $8,000–$25,000 (2–4 weeks); embedded support retainer $1,500–$3,000/mo. Offer a "fixed-price sprint" format.
- **Do not:** long retainers with vague deliverables; vague "AI strategy" without shipping. Offer fixed-scope sprints with a defined output.

### 3.3 Segment C — Digital agencies (resell / white-label)

- **Who:** digital/marketing/tech agencies whose clients are asking for AI features (chatbots, lead qualification, content ops, reporting) and who don't have in-house AI capability.
- **Pain:** losing deals or margin to AI-capable competitors; can't hire/retain AI talent; need a reliable white-label delivery partner.
- **Budget reality:** buys at a discount to retail and resells at retail (or higher). Typical build cost to agency $2,000–$15,000; resale $4,000–$30,000. Retainer $1,500–$5,000/mo for "AI capability on call".
- **Buying motion:** 4–12 week cycle; wants reliability, NDA, white-label, their branding on deliverables, predictable turnaround, volume pricing. Decision by agency owner/MD.
- **Price fit for IMK:** White-label builds at 25% off retail (see §6); agency retainer $1,500/mo base + per-build fees; volume discounts at 3+ builds/quarter.
- **Do not:** compete with them on the end client; never contact their client directly without written consent.

---

## 4. Pricing model

**Hybrid (published anchors + productized tiers + bespoke path + retainer + reseller).**

- **Published "starting at" anchors** on the pricing page for pre-qualification (per Phase 1 §4).
- **Named offers** with deliverables, timeline, revision limits, in/out-of-scope boundaries.
- **Bespoke quote path** for complex work (application form on `/pricing`).
- **Monthly care retainer** sold from day one (silent failure is the buyer's #1 fear).
- **Audit credit:** audit fee credited in full against a build started within 90 days.
- **Payment terms:** Audit invoiced on commencement; builds in two milestones (50% start, 50% handover); Net 14 days. (Per existing terms.)
- **Warranty:** 30-day post-launch fix on defects, no conditions; beyond that, Care or per-issue quoting.

---

## 5. Rate card — retail (end clients)

### 5.1 Time-based

| Item | Rate | Notes |
|---|---|---|
| Standard engineering time | $125/hr | Default for automation + integration work |
| AI engineering time | $150/hr | Agents, RAG, prompt engineering, evals, voice |
| Care / monitoring time | $100/hr | Monitoring, tuning, small fixes under Care |
| Day rate (7.5h) | $900 | Standard; $1,125 for AI days |
| Rush premium | +25% | Delivery <2 weeks from signed scope; only if capacity allows |

### 5.2 Fixed-scope offers (retail, USD, "from" = floor for smallest scope)

| Offer | From | Typical range | Includes |
|---|---|---|---|
| **AI Readiness Audit** | $1,500 | $1,500–$3,000 | Process map, opportunity list with estimated savings, written build plan, one-week turnaround, credited in full against a build within 90 days |
| **Single AI Agent** (chat, scoped, RAG) | $3,500 | $3,500–$7,500 | Scoped agent, curated knowledge base with source links, human handover, conversation logs, one month of tuning |
| **AI Workflow Integration** | $2,500 | $2,500–$8,000 | Add AI to an existing workflow (classification, extraction, drafting, routing) with error handling + monitoring |
| **Voice AI Agent** | $6,000 | $6,000–$15,000 | Voice agent on documented FAQs/pricing, handover, transcripts, consent notice, tuning |
| **AI System Build** | $10,000 | $10,000–$40,000 | Multi-agent or multi-workflow system, integrations, monitoring, training, full documentation |
| **Custom AI Integration** (APIs/middleware) | $5,000 | $5,000–$20,000 | Documented field map, idempotent sync, retries, dead-letter queue, monitoring |
| **AI Feature Sprint** (startups) | $8,000 | $8,000–$25,000 | 2–4 week fixed-scope sprint shipping one defined AI feature into the client's repo |

### 5.3 Care & monitoring (retail)

| Offer | Rate | Includes |
|---|---|---|
| **Automation Care** (existing) | $250/mo | Monitoring, error alerts, fixes, priority support, monthly improvement hours (automation-only clients) |
| **AI Care** | $350/mo | Everything in Automation Care + prompt/knowledge-base updates, answer-quality reviews, monthly eval report |
| **AI Care Plus** (startups) | $750/mo | AI Care + 4 hrs/mo embedded engineering + priority queue + monthly roadmap call |

### 5.4 What drives the quote up or down (publish this list)

- Number of systems in play and whether they have real, documented APIs.
- One-person handoff vs. a team's worth of roles and views.
- Whether data needs cleaning before it moves.
- Security and hosting constraints (self-hosted n8n, data residency, SSO, audit logging).
- Voice vs. text; real-time vs. async.
- Knowledge-base size and source quality.
- Timeline pressure (rush premium).

### 5.5 Out of scope for a single-agent build (publish)

- Design/branding work beyond a passable UI.
- Legacy on-prem systems without an integration surface.
- Procurement of software licences / API keys.
- Data entry/cleaning work that predates the automation.
- Legal/compliance advice (privacy page is facts + references).
- 24/7 on-call beyond agreed SLA.
- Hosting guarantees third-party vendors do not give.

---

## 6. Agency / reseller program (white-label)

### 6.1 Structure

- **White-label builds** at **25% off retail** list price, billed to the agency, delivered under the agency's brand.
- **Agency retainer** $1,500/mo base: "AI capability on call" — 6 hrs/mo included, priority queue, monthly planning call, NDA on file.
- **Volume discount:** 3+ builds in a quarter → 30% off (instead of 25%).
- **Turnaround SLA:** 10 business days for Single AI Agent scope; 20 for System builds. Missed SLA → 10% credit.
- **White-label deliverables:** agency-branded runbook, agency-branded handover doc, no IMK watermark, IMK not named to end client unless agency opts in.
- **Rules:** IMK never contacts the end client without written agency consent; agency owns the client relationship; IMK may not resell the same build to others.

### 6.2 Reseller economics (illustrative)

| Build type | IMK cost to agency | Agency resale (typical) | Agency margin |
|---|---|---|---|
| Single AI Agent | $2,625 (25% off $3,500) | $5,000–$7,500 | ~45–65% |
| AI Workflow Integration | $1,875 (25% off $2,500) | $3,500–$6,000 | ~45–70% |
| Voice AI Agent | $4,500 (25% off $6,000) | $8,000–$12,000 | ~45–65% |
| AI System Build | $7,500 (25% off $10,000) | $15,000–$25,000 | ~50–70% |

**PROVISIONAL:** resale ranges are directional estimates of what agencies charge their clients; verify with 2–3 friendly agencies before committing to the discount depth.

### 6.3 Onboarding (agency)

1. NDA + reseller agreement signed.
2. Agency gets a "capabilities + pricing" one-pager and a scoping template.
3. First build is a paid pilot at 20% off (deeper discount) to prove the partnership; standard 25% from build #2.
4. Quarterly review: volume, turnaround, quality, expansion.

---

## 7. Packaging & scope boundaries (publish on /pricing)

### 7.1 In scope / out of scope (single-agent build)

- **In:** scoped agent, knowledge base, handover rules, conversation logs you can read, one month of tuning, documentation.
- **Out:** voice (unless Voice offer), deep system writes on day one (start read-only), on-call replacement for complex decisions, legal/compliance advice.

### 7.2 Revision policy

- Two substantive rounds included. Scope changes after that are quoted. Reproduction fixes are on IMK forever.

### 7.3 Payment & ownership

- Audit invoiced on commencement; builds invoiced 50% start / 50% handover; Net 14 days.
- Client owns the automation, configuration, and data output from day one. IMK retains generic building blocks; the client's instance is theirs.
- 30-day post-launch fix warranty on defects; beyond that, Care or per-issue quoting.
- No exit fee; no license IMK revokes. If Care lapses, everything keeps running — it just stops being monitored.

---

## 8. Objections & proof (copy-ready, for /pricing and sales)

| Objection | Answer |
|---|---|
| "Why not hire a freelancer cheaper?" | You can. IMK's value is documented handover, monitoring, and ownership guarantees — the things that fail in month six. Price the risk, not the hours. |
| "Can you guarantee ROI?" | No honest vendor can. IMK quotes a fixed scope and a price; ROI depends on the client's process and adoption. Audit includes an estimated-savings list so the client decides with numbers. |
| "What if it doesn't work?" | 30-day fix warranty on defects; read-only-first for write actions; human handover rule written in, not hoped for. |
| "Lock-in?" | Runs in the client's accounts; exportable code/config; no exit fee; month-to-month Care. |
| "We're too small." | Audit at $1,500 is the entry point; many clients stop there and self-implement. |
| "We're too big / need enterprise." | Honest answer: IMK is a senior independent, not an enterprise consultancy. Refer out or scope as a fixed sprint. |

**Proof needed before publishing (PROVISIONAL until verified):** at least 2 quantified case studies or labelled sample projects; partner badges (Make/n8n/Zapier) if held; response-time promise; real photo on About.

---

## 9. Assumptions & open questions

1. **Currency USD** (Phase 1 default). Confirm if EUR/GBP preferred for EU/UK buyers.
2. **Rush premium +25%** assumes capacity allows; if fully booked, say no rather than overpromise.
3. **Agency discount depth 25%** is a starting proposal; verify with 2–3 friendly agencies before committing.
4. **AI Care pricing** assumes monitoring + tuning time averages <3 hrs/mo at $350; re-check after first 5 clients.
5. **Startup sprint format** assumes client provides repo access and a named engineer contact; if not, add +20%.
6. **Owner decision needed:** minimum project size to accept; whether to publish the agency program publicly or keep it invite-only (recommend invite-only at launch).
7. **Owner decision needed:** whether IMK holds any partner-tier badges (Make/n8n/Zapier) to display as proof — do not claim without verification.

---

## 10. Next steps

1. Owner reviews and confirms/adjusts anchors (especially agency discount depth and minimum project size).
2. Update `copy/copy-deck.md` §7 pricing table and FAQ with the new AI offers (keep automation offers; add AI offers alongside, not replacing).
3. Add an "Agencies / partners" section to the site (or a separate one-pager) — invite-only, linked from footer.
4. Build the application form's budget range options to match §5.2 tiers.
5. After first 5 clients: re-run this doc with actual hours-per-project data to calibrate floors.

---

*Prepared by Echo (Creative & Copy Lead). Benchmarks: verified competitor prices from `research/01-analyst-service-sites-conversion.md` (Nex, Cortex, Automation Ace, Daneels); general market ranges are directional and marked PROVISIONAL. No fabricated metrics, testimonials, or competitor weaknesses included.*
