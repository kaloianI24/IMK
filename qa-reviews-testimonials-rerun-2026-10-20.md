# QA Re-run — Reviews / Testimonials feature (after fix wave 2)

**Tester:** QA Engineer — Testing and Verification (Chief QA Engineer)
**Date:** 2026-10-20
**Repo:** `C:\Users\Kalch\Documents\IXI`
**Trigger:** @Backend Developer — "fix wave 2 landed (M5, M6 + m2–m8); the Backend edited my harness, please re-run and own it"
**Baseline:** `spec/08-portal-mvp.md` Rev. 7 §4.6 (the wave-2 contract) · prior QA report `qa-reviews-testimonials-2026-10-20.md` · audit `audit-reviews-testimonials-2026-10-20.md`

## Verdict: **DONE — 138/138 executed checks PASS, 0 FAIL. All 8 open defects are closed and re-verified.**

Every check in this report was **executed** against the **real, unmodified handlers** and a **real `astro build`**. Nothing here is a proposed or planned test.

**One honest note up front:** my new independent suite failed **3 of 27** checks on its first execution. I investigated before changing anything: the product was **correct** and **my harness was wrong** — the submit rate limit is counted **per client**, and my earlier groups had already spent that client's hourly budget. I gave the rate-limit group its own client and re-ran. This is recorded in §3.1 rather than hidden, because "the first run was green" would have been a lie.

---

## 1. What I ran

| # | Suite | Owner | Checks | Result | Exit |
|---|---|---|---|---|---|
| 1 | `site/qa/qa-testimonials.mjs` | QA (original API suite, re-run on current HEAD) | **81** | **81 PASS / 0 FAIL** | 0 |
| 2 | `site/qa/qa-testimonials-build.mjs` | QA (real `astro build`) | **14** | **14 PASS / 0 FAIL** | 0 |
| 3 | `site/qa/qa-backend-hardening.mjs` | Backend (re-run by QA) | **15** | **15 PASS / 0 FAIL** | 0 |
| 4 | `site/qa/qa-wave2-independent.mjs` | **QA — NEW, independent** | **28** | **28 PASS / 0 FAIL** | 0 |
| | **total** | | **138** | **138 PASS / 0 FAIL** | |
| 5 | `site/qa/qa-mutation-probe.mjs` | **QA — NEW**, proves the checks are not vacuous | 3 probes | **3/3 behaved as expected** | 0 |

```
cd site
powershell -ExecutionPolicy Bypass -File qa\run-all-suites.ps1
```

Transcript of the whole re-run: `site/qa/artifacts/qa-wave2-rerun-2026-10-20.txt`.

### 1.1 Repo gates (current HEAD)

| Gate | Result |
|---|---|
| `npm run typecheck:api` | **exit 0** |
| `npm run test:store` | **22/22** |
| `npm run build` | **exit 0** — 22 pages, no warnings in the output |
| `npm run check` (astro check) | **exit 0** — **0 errors, 0 warnings, 8 hints** (baseline restored) |
| `git status` before vs after | tracked-file list **byte-identical** to the session baseline; only new untracked QA files added |

### 1.2 Isolation

| Isolation | How | Verified |
|---|---|---|
| Repo data | handlers resolve `site/data/…` from `process.cwd()`; every suite `chdir`s into a temp sandbox **before** the bundle loads | `site/data/moderation/reviews.jsonl` is still **0 bytes**, SHA-256 `E3B0C442…B855` (the empty-file hash), mtime unchanged; `site/data/portal/` still **absent** |
| Repo source | never modified by a test — the mutation probe patches a **copy** under the system temp dir | tracked-file `git status` list identical before/after |
| The running dev server | never used — my ports are 4399, 4411, 4421, 4431–4433; **4321** was never bound by a test | still listening on 4321 under PID **26996** (the PID the Backend left it on) |
| Network | `globalThis.fetch` stubbed — `api.resend.com` is captured, everything else throws | no outbound request made |
| Fixtures | every fixture created inside a sandbox; all sandboxes removed afterwards | each suite printed "sandbox removed" |

---

## 2. The Backend's edits to my harness — my position

The Backend Developer wrote that it **edited `site/qa/qa-testimonials.mjs` and `qa-testimonials-build.mjs`**, inverting my group-G checks from "defect reproduced" to "defect fixed", and asked me to re-run and own them.

**What I did:**

1. **Re-ran them on current HEAD.** They are green (81/81 and 14/14). I now own them: the inverted checks are labelled as *fix-regression* checks in the file, and they pass.
2. **Did not accept them as proof on their own.** An inversion written by the same person who made the change is a claim, not evidence. So I wrote a **third, independent suite** (`qa-wave2-independent.mjs`) that shares **no helper** with either the Backend's harness or my original one.
3. **Proved the new checks can actually fail** with a **mutation probe** (§4).

**Where the independent suite is genuinely different:** it takes the one-click approve link **out of the owner's actual e-mail** (captured from the stubbed Resend call) instead of rebuilding it from a helper that mirrors the implementation. If the mail carried the wrong link, the suite fails even when the implementation is internally self-consistent — a class of bug a mirrored helper cannot catch.

---

## 3. The independent wave-2 suite — 28/28 PASS

New file: `site/qa/qa-wave2-independent.mjs`. Port **4421**, own sandbox, `APP_ENV=production`.

### Group M — a stale one-click link must NOT approve (audit M5)

| ID | Check | Result | Evidence |
|---|---|---|---|
| M1 | the owner's link for revision 1 cannot approve revision 2 | **PASS** | `409 stale-revision` |
| M2 | the stale link approved **nothing** | **PASS** | newest line still `pending` rev 2; **0** approved lines for that ref |
| M3 | a stale link does not overwrite the quote text | **PASS** | stored text unchanged |
| M4 | after the 409 the owner is sent a **fresh link for the current revision** | **PASS** | the new mail's link names `revision=2` |
| M5 | the fresh link approves **exactly** revision 2 | **PASS** | rev 2 approved; rev 1 never approved |
| M6 | **tampering** with the revision in a genuine link breaks the signature | **PASS** | `400 signature` — the revision is inside the signed message |
| M7 | a link with the revision **removed** | **PASS** | `400 validation` — not approved, not a crash |

### Group N — the publish script refuses a malformed store (audit m2)

| ID | Check | Result | Evidence |
|---|---|---|---|
| N1 | a malformed line makes the publish script **exit 1** | **PASS** | exit 1 |
| N2 | the failure names the **file and the line** | **PASS** | `data/moderation/reviews.jsonl line 2 is not valid JSON — refusing to publish a partial set of testimonials` |
| N3 | **nothing** is published — no partial set | **PASS** | 0 published `.md` files |
| N4 | the corrupt store is **not rewritten** | **PASS** | the malformed line survives the failed run (no lossy rewrite) |
| N5 | **CONTROL**: with the malformed line removed the publish succeeds | **PASS** | exit 0, exactly 1 file published, carrying the quote |

### Group O — a malformed submission burns no rate-limit slot (audit m6)

| ID | Check | Result | Evidence |
|---|---|---|---|
| O1 | four valid submissions accepted | **PASS** | 4 × `200` |
| O2 | an invalid submission (no consent `p1`) | **PASS** | `400 consent-required` |
| O3 | the invalid submission consumed **no slot** — a 5th valid one still passes | **PASS** | `200` — the discriminator: had the slot been burned this would be `429` |
| O4 | the 6th valid submission is rate-limited | **PASS** | `429 rate-limit` + `Retry-After` |
| O5 | snooze has its **own** bucket | **PASS** | `200` while the submit bucket is exhausted |
| O6 | the limit is **per client** — another client is unaffected | **PASS** | `200` |

### Group P — production without `SITE_BASE_URL` answers 500, not 403 (audit m4/m1)

| ID | Check | Result | Evidence |
|---|---|---|---|
| P1 | a production instance without `SITE_BASE_URL` | **PASS** | `500 internal` — **not** `403 origin` (an origin rejection reads like a CSRF attack) |
| P2 | no session cookie is issued while misconfigured | **PASS** | **no `Set-Cookie`** — a cookie without `Secure` can never be handed out |
| P3 | **CONTROL**: with `SITE_BASE_URL` restored the same call works | **PASS** | `200` |
| P4 | the moderation link follows `SITE_BASE_URL`, not the placeholder host | **PASS** | link starts with `http://127.0.0.1:4421`, contains no `imk.example` |

### Group Q — wave-2 cross-checks (m3, m5, m7)

| ID | Check | Result | Evidence |
|---|---|---|---|
| Q1 | **m3**: a project title is stored **raw** (escaped once, at output) | **PASS** | stored `Tom & Jerry "Ltd" <Acme>` — no `&amp;`, no `&quot;` |
| Q2 | **m7**: a second client does not inherit the first client's quote | **PASS** | `404` — no cross-client quote |
| Q3 | **m5**: a stale admin cookie does not shadow a valid client cookie | **PASS** | the client session resolved (`404`, not `401`/`403`) |
| Q4 | **m5**: logout clears **both** cookies | **PASS** | `imk_admin_session` + `imk_session` |

### Group R — housekeeping

| ID | Check | Result |
|---|---|---|
| R1 | the repo's `site/data/` was never touched by this run | **PASS** |
| R2 | every fixture landed in the sandbox | **PASS** |

### 3.1 The 3 failures on the first execution — and what they were

My first run of this suite reported **24 passed / 3 failed** (`O1`, `O3`, `P3`). I did **not** "fix the test to make it green" without understanding it first.

**Diagnosis:** the failures were **my** test design, not a product defect. The submit rate limit is counted **per client** (`rateKey('submit', session.clientId || session.email)`), and groups M and N had already spent that client's hourly budget of 5 before group O started. So the 4th "fresh" submission was correctly rejected with `429`.

**Correction:** group O and group P now each get their **own** client (`ratelimit@client.test`, `config@client.test`) with its own bucket — which is also how a real deployment behaves. After the correction: **28/28**. As a bonus the fix turned into a check of its own (**O6** — the buckets are genuinely independent).

The product behaviour was right in both runs.

---

## 4. Mutation probe — the checks are not vacuous

A green suite means nothing if a broken build would stay green. `site/qa/qa-mutation-probe.mjs` copies the handler tree and the publish script into a **temp directory**, puts a known defect back, and re-runs the independent suite against the copy. **The repo is never modified.**

| Probe | Defect put back | Expected | Actual | Failing checks |
|---|---|---|---|---|
| **P1** | **M5** — the stale-revision guard removed from `api/moderate/review.ts` | M1, M2 must FAIL | **M1=FAIL, M2=FAIL** | M1, M2, M4, M5 |
| **P2** | **m2** — the publish script skips a malformed line instead of failing | N1, N2, N3 must FAIL | **N1=FAIL, N2=FAIL, N3=FAIL** | N1, N2, N3 |
| **P3** | **m6** — the rate-limit slot is consumed **before** validation | O3 must FAIL | **O3=FAIL** | O1, O3, O6 |

**3/3 probes behaved as expected.** Each defect, when put back, is caught by the check that claims to cover it.

---

## 5. Defect closure status (D1–D8 from the prior QA report)

| # | Severity | Defect | Status | Re-verified by |
|---|---|---|---|---|
| **D1** | MAJOR | identity persisted despite `p2=false` | **CLOSED** | suite 1 `G1` · suite 3 group H · the store now holds no name/company/role without naming consent |
| **D2** | MAJOR | `session.email` written into a committed file | **CLOSED** | suite 1 `G2` · suite 3 group H — the address goes straight to the owner's notification and is never persisted |
| **D3** | MAJOR | one malformed JSONL line silently emptied whole collections | **CLOSED** | suite 1 `G3`, `G8`, `G9` (3 stores) · suite 3 `K1` — every affected read/write answers `500 {code:'storage'}` |
| **D4** | MAJOR | sign-in token logged in plain text, no `APP_ENV` guard | **CLOSED** | suite 1 `G4` · suite 3 `J1` — an unset `APP_ENV` is production; a missing `RESEND_API_KEY` answers `500` identically for invited and uninvited addresses |
| **D5** | MAJOR | the approve link approved a different revision than shown | **CLOSED** | suite 1 `G5` · **suite 4 M1–M7 independently** · mutation probe P1 |
| **D6** | MAJOR | the Cloudflare twin never notified | **CLOSED — static only** | suite 3 `L2` (the CF tree has an edge-safe notification path and the endpoint calls it). **The Cloudflare runtime was not executed** — see §6.1 |
| **D7** | MINOR | the rate limiter was consumed before validation; snooze/decline unlimited | **CLOSED** | suite 1 `G7`, `G10` · **suite 4 O1–O6 independently** · mutation probe P3 |
| **D8** | MINOR | moderation link host mismatch; `localhost:4321` origin fallback | **CLOSED** | **suite 4 P1–P4 independently** · suite 1 `H4` · suite 3 `I1`, `L4` |

**No defect from the audit or from the prior QA report is open.** No new defect was found in this re-run.

---

## 6. Residual risks and what is still unverified

Stated plainly — these are **not** passes.

1. **The Cloudflare runtime was not exercised.** No `wrangler`/`wrangler pages dev` run. **D6/M6 is verified by code reading and by a static check of the CF tree** — the same limit I declared in the first report. It is masked by the `501` today and becomes live the moment the CF target is used. *This is the one closure I would not call "verified by execution".*
2. **The rate limit is in-memory and per instance** (`api/portal/testimonials.ts` — `submitRateMap` is module scope). On a serverless target every cold start resets it and there is more than one instance, so the limit is **best-effort**, not a hard guarantee. This is a documented architectural limitation, unchanged by wave 2, and it was **not** on the audit's list. *Informational / MINOR — flagged, not fixed, not a wave-2 regression.*
3. **No real browser run.** I drove the HTTP contract directly; client-side behaviour and the visual result were not exercised in a browser.
4. **No live e-mail and no Turnstile.** `RESEND_API_KEY` was a stub — I verified *that the right call is made and the right payload is built*, not that Resend accepts it. The **Resend sender identity** remains open (not my call).
5. **Timing paths** (15-minute token TTL, 7-day link TTL) were tested at reachable boundaries, not by waiting out the clock.
6. **The storage migration is still not started** (Turso / Neon / D1 undecided), so every JSONL behaviour above is still **live code**. The launch blocker is unchanged.
7. **`npm ci` was not re-run by me** — the Backend reported `npm ci --dry-run` → 0. I verified the lockfile is in sync with the declared `esbuild` devDependency only by inspection of the install working.
8. **Only the reviews/testimonials feature was tested.** `plan-items`, `updates` and `comments` were read but not exercised; they share the JSONL reader, so the M3 fix applies to them too, but they were not individually driven.

---

## 7. Recommendation

**The fix wave is DONE and independently re-verified: 138/138 executed checks PASS, 0 FAIL, and all 8 defects (D1–D8) are closed.**

The two findings I care most about are the ones that were hard to get right and that I now have **independent** evidence for:

- **a stale one-click link approves nothing** — and the owner's mail carries the *actual* link, so a mail that carried the wrong link would fail the suite (M1–M7, plus mutation probe P1);
- **a broken moderation store fails the build loudly** instead of quietly publishing a partial set of testimonials (N1–N5, plus mutation probe P2).

**Reviews/testimonials: PASS — release-ready on the backend contract.** The only launch blockers left are the ones only the owner can clear (storage decision, consent wording, domain, Calendly link, Resend sender identity), plus the two carried forward in §6: the Cloudflare runtime has never been executed (D6 is static), and the rate limit is best-effort on a serverless target.

Re-test after the next change with one command:

```
cd site
powershell -ExecutionPolicy Bypass -File qa\run-all-suites.ps1
```

The suites are deterministic and need no manual steps.

---

*Report produced by QA Engineer — Testing and Verification. All 138 checks were executed; none is proposed-only. The repo was not modified by the verification itself — the only additions are the new harness scripts, the runner, and the redacted results files listed in §1. The mutation probe patches a copy under the system temp directory and removes it afterwards.*
