---
order: 3
title: "Monthly reconciliation to nightly sync"
sector: "30-person company"
sample: true
context: "CRM and invoicing disagreed; finance reconciled manually once a month."
problem: "Discrepancies surfaced 30 days late, blocking payouts and creating chasing work."
approach: "We built a nightly idempotent sync with reconciliation reporting and mismatch alerts."
execution:
  - "Mapped fields and conflict rules with finance and ops"
  - "Implemented with retry, idempotency and per-row alerting"
  - "Ran a full reconciliation against the prior 3 months"
outcome: "Discrepancies surface the same night; finance reviews a short summary each morning."
result: "Sample project. All metrics shown are PROVISIONAL pending client attestation."
cta: discuss
---

## Reconciliation never sleeps

The reconciliation job kept the bad data where it belonged — visible on day one, not on day thirty.