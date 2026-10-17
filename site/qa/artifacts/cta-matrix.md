# IXI — CTA matrix (QA artifact)

Generated per `plan\00-phase2-plan.md` v2 §5 §9 and §8 M4.
Policy: each page exposes exactly one primary action; the header and footer always carry the hard-coded "Book a 15-minute call" secondary-ish primary for the whole site; a sticky mobile CTA appears on the four pages listed and nowhere else.

## Sticky mobile CTA rules
Present only on: Home, Services (index + every service detail), Work (index + every case detail), Pricing. Hidden on /book, 404 and 404-only /thank-you, /about, /process, /privacy, /terms.

## Per-route matrix

| Route | Sticky CTA | Primary action (label → destination) | Notes |
|---|---|---|---|
| `/` | Yes (Start an automation audit → /pricing#apply?offer=audit) | Start an automation audit → /pricing#apply?offer=audit | hero + proof bar; secondary "Book a 15-minute call" |
| `/services` | Yes (Book a 15-minute call → /book) | Book a 15-minute call → /book | index lists 4 services |
| `/services/audit` | Yes (Book a 15-minute call) | Book a 15-minute call → /book | in-scope/out-of-scope lists |
| `/services/workflow-automation` | Yes | Book a 15-minute call → /book | — |
| `/services/b2b-ai-agent` | Yes | Book a 15-minute call → /book | — |
| `/services/integration` | Yes | Book a 15-minute call → /book | — |
| `/work` | Yes (Book a 15-minute call) | Book a 15-minute call → /book | all labelled "sample" |
| `/work/*` | Yes | Book a 15-minute call → /book | sample label present |
| `/process` | No | Book a 15-minute call → /book | system ownership / handover |
| `/pricing` | Yes (Book a 15-minute call) | Start an audit → #apply (anchor on page) | quote form primary on page |
| `/about` | No | Book a 15-minute call → /book | — |
| `/book` | No (hard-coded header CTA hidden landing) | Pick a slot → Calendly | page-matched |
| `/thank-you` | No | Book a 15-minute call → /book | noindex |
| `/privacy` | No | (none beyond header) | no primary CTA (legal) |
| `/terms` | No | (none beyond header) | no primary CTA (legal) |
| `/404` | No | Home → / | noindex |

## Hard-coded site CTA
- Header: "Book a 15-minute call" → /book (always rendered)
- Footer: "Book a 15-minute call" → /book (always rendered)

## Verification
Run Lighthouse + axe on these routes; confirm no page ships two `.btn-primary` CTAs in the main column. Check done by Frontend + QA in M6.