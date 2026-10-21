# Backend wave 3 — the Cloudflare runtime, the rate limiter, and one correction to the record

**Author:** @Backend Developer · **Date:** 2026-10-20 · **Repo:** `C:\Users\Kalch\Documents\IXI`
**Status: DONE.** QA's wave-2 re-run is verified, both open items it handed back are closed, and one finding needs correcting in the team's record.

---

## 0. Executive summary

| | |
|---|---|
| QA's wave-2 re-run, re-run by me on the same HEAD | **138/138 checks pass**, 0 failures (81 + 14 + 15 + 28) |
| Mutation probes | **4/4** behave as expected (P4 is new) |
| New Backend suites | `qa-rate-limit.mjs` **8/8** · `qa-cf-parity.mjs` **9/9** |
| Gates | `typecheck:api` exit 0 · `test:store` 22/22 · `build` 22 pages exit 0 · `check` 0 errors / 0 warnings / **8 hints** (baseline) |
| Audit findings still open | **none** |
| **Correction to the record** | **M6 is closed in code, not in production** — see §3 |

---

## 1. What I verified (QA's claims, checked against the repo, not taken on trust)

QA reported *138 checks executed, 138 passed*. I re-ran the whole thing on the same HEAD (`8303af9`) before changing a line:

```
qa-testimonials.mjs        81 passed, 0 failed   exit 0
qa-testimonials-build.mjs  14 passed, 0 failed   exit 0
qa-backend-hardening.mjs   15 passed, 0 failed   exit 0
qa-wave2-independent.mjs   28 passed, 0 failed   exit 0
qa-mutation-probe.mjs      3/3 probes behaved as expected   exit 0
```

**QA's report is accurate.** The numbers, the housekeeping claims and the two open items it named are all as stated. QA also did the right thing by not taking my inversions on trust: it wrote a third suite that pulls the approve link out of the owner's actual email, and a mutation probe that proves the checks can go red. That is the reason I can say the re-run means something.

---

## 2. Open item A — "the Cloudflare runtime was never executed"

**Now it is.** New suite: `site/qa/qa-cf-parity.mjs` (9 checks, Backend-owned).

The Cloudflare Pages runtime hands a handler the Web platform (`Request`/`Response`/`fetch`/`crypto.subtle`) and no `require`. Node gives the same Web globals, so the Cloudflare modules run here unmodified, and with `globalThis.require` absent they take exactly the path they take on the edge. The suite asserts that `globalThis.require` really is undefined, so it cannot silently drift into testing the wrong path.

| Check | What it proves |
|---|---|
| **C1** | Every Cloudflare portal endpoint answers `501 {code:'unimplemented'}` — read **and** write paths |
| **C2** | That 501 is about the **missing store**, not a broken handler: with a filesystem present the same endpoint runs and reaches its auth check (401) |
| **C3** | The Cloudflare sign-in limiter is **KV-backed** and survives a cold start (6th request from one IP → `429`; the KV key is a SHA-256 digest, no raw IP) |
| **C4** | The Cloudflare moderation endpoint **accepts a Vercel-signed link** and **rejects a forged one** (`400 signature`) |
| **D1/D2** | A CF-signed link verifies with the **Vercel** verifier, and a Vercel-signed link verifies with the **CF** verifier |
| **D3** | Both trees build the same link shape (`ref, decision, revision, sig, ts`) from `SITE_BASE_URL`, and sign it identically |
| **D4** | The CF notification mail carries the revision, and the link in it verifies |
| **D5** | A link signed for revision 1 does not verify for revision 2, in either tree (M5 holds across targets) |

D1–D5 are new ground: **nobody had ever executed both trees against each other.** The one-click link is the single most fragile thing in this feature (it is a signed URL the owner clicks from an email), and it now has an executed cross-target contract.

---

## 3. The correction: M6 is closed in code, not in production

The team's record says "6 MAJOR closed". That is true of M6 **in the Cloudflare tree's source code** — and it needs a footnote, because the CF fix is unreachable today:

> The Cloudflare target has no writable filesystem, so the portal store cannot be read there. **Every** portal endpoint answers `501 {code:'unimplemented'}`. The notification module I added in wave 2 sits behind that 501.

So: a testimonial submitted on the Cloudflare target would still not notify anyone — not because the notification path is missing, but because the portal cannot run there at all.

**While executing the CF tree I found the last silent outage in it** — and it is the exact class of defect the audit called M3/D3:

| Cloudflare path | Before | Now |
|---|---|---|
| `projects`, `comments`, `plan-items`, `updates` (read) | **`200` with an empty list** — reads as "no projects" | `501 {code:'unimplemented'}` |
| `POST /api/portal/auth/request-link` (sign-in) | `200` "if you have an invitation…" — reads as "not invited" | `501 {code:'unimplemented'}` (the rate limiter still runs first) |
| write paths | `501` (already correct) | `501` |

A store that cannot be reached must never be reported as a store that is empty. The Vercel tree already answered `500 {code:'storage'}` for that; the Cloudflare tree now says the same thing.

**What this means for the launch decision, and it supports the recommendation:** the Cloudflare tree is the *less* complete one, and completing it is not a porting job — it needs a real store (D1/KV) first, which is the same work as T4. **The Vercel tree is the launch target**, and there the portal, the notification and the one-click link are all executed and verified. My answer is unchanged: **Turso, and keep Vercel.**

---

## 4. Open item B — the rate limit was per instance

QA was right that the counters lived in a module-level `Map`: on a serverless target every cold start reset them, so the limit was a per-instance speed bump, not a limit.

**What changed** — the counters moved behind a **pluggable backend** (spec/08 §4.7.1):

| Backend | Where the count lives | Durable? | Used when |
|---|---|---|---|
| `memory` | the process | no | the default, everywhere |
| `file` | a JSON file next to the portal data | yes — across restarts, shared per host | opt-in: `PORTAL_RATE_LIMIT_FILE=<path>` (self-hosted/VPS) |
| `kv` | Workers KV (`KV_COUNTER`) | yes — across cold starts | the Cloudflare tree, when the binding exists |
| `store` | a shared counter service | yes | **reserved for T4** (libSQL/Turso) — the seam exists so that adapter lands without touching a call site |

The rule is unchanged (5 submits, 10 snooze/decline, per client, per hour; a slot is consumed only by a request that passed validation; `429` + `Retry-After: 3600`). What changed is that **the guarantee is now stated instead of implied**: on a serverless target with no shared store the limit is per instance, and the spec says so.

Safety rules, each with a check:

- a backend can never fail a request — it degrades to the in-memory counter and reports `degraded: true`;
- keys are **SHA-256 hashed** before they reach a durable backend — no client id and no IP address is written to disk or to KV;
- the check and the consumption are **one operation**, so they cannot race;
- the in-memory map lives on `globalThis`, so the counter survives a module re-evaluation inside one process (the dev server rebuilds handlers per request — a limiter that reset on every rebuild is no limiter).

New file `api/lib/rate-limit.ts` + edge twin `site/functions/api/lib/rate-limit.ts`. Wired into all four portal handlers in both trees. `api/contact.ts` and its CF twin are **unchanged** — the public form is a different feature, Turnstile is its real gate, and the audit cleared it.

---

## 5. Files changed

**New (Backend-owned):**

| File | Purpose |
|---|---|
| `api/lib/rate-limit.ts` | the limiter + `memory` / `file` backends (Node) |
| `site/functions/api/lib/rate-limit.ts` | edge twin: `memory` / `kv` backends |
| `site/qa/qa-rate-limit.mjs` | 8 checks on the limiter contract |
| `site/qa/qa-cf-parity.mjs` | 9 checks: the Cloudflare tree, executed + cross-target links |

**Changed:**

| File | Change |
|---|---|
| `api/portal/testimonials.ts` | uses the shared limiter; the local `Map` + `withinLimit`/`consumeLimit` are gone |
| `api/portal/auth.ts` | same for the per-IP sign-in limiter |
| `site/functions/api/portal/testimonials.ts` | same (KV-backed) |
| `site/functions/api/portal/auth.ts` | same (KV-backed) |
| `site/functions/api/portal/{projects,comments,plan-items,updates}.ts` | read paths now answer `501` instead of `200` + empty list |
| `site/qa/qa-backend-hardening.mjs` | new group **M** (3 checks: the submit limit, per-client scoping, the per-IP sign-in limit) |
| `site/qa/qa-mutation-probe.mjs` | P3 updated to the new limiter API; **P4 added** (a limiter that never blocks → O4 must fail) |
| `site/qa/run-all-suites.ps1` | now runs all 7 suites |
| `spec/08-portal-mvp.md` | new **§4.7** (the limiter contract, the CF truth, the cross-target link contract); §5's rate-limiting row rewritten |
| `site/.env.example` | documents `PORTAL_RATE_LIMIT_FILE` |

**No other file was touched.** No Frontend-owned file was changed in this wave (wave 2 touched `site/scripts/publish-testimonials.mjs`; that is unchanged here).

---

## 6. Checks executed (real output, all run on this HEAD)

```
qa-testimonials.mjs           81 passed, 0 failed   exit 0
qa-testimonials-build.mjs     14 passed, 0 failed   exit 0
qa-backend-hardening.mjs      18 passed, 0 failed   exit 0   (15 + 3 new)
qa-wave2-independent.mjs      28 passed, 0 failed   exit 0
qa-mutation-probe.mjs          4/4 probes behaved as expected   exit 0
qa-rate-limit.mjs              8 passed, 0 failed   exit 0
qa-cf-parity.mjs               9 passed, 0 failed   exit 0
                            ------------------------------------
                            158 checks, 0 failures  +  4 mutation probes

npm run typecheck:api   exit 0   (api + functions + shared)
npm run test:store      22 / 22
npm run build           22 pages, exit 0
npm run check           0 errors, 0 warnings, 8 hints (baseline)
```

The mutation probes are the ones that make the rest meaningful: they put a known defect back into a **copy** of the tree and require the covering check to go red. P1 (stale-revision guard removed) → M1/M2 fail. P2 (publish skips a malformed line) → N1/N2/N3 fail. P3 (slot charged before validation) → O1/O3/O6 fail. **P4 (the limiter never blocks) → O4 fails** — new, and it proves the new limiter is covered by a check that can actually fail.

Housekeeping: every run used its own sandbox and its own port (4399 / 4411 / 4421 / 4431–4434). The repo's `site/data/moderation/reviews.jsonl` is still 0 bytes and `site/data/portal/` still does not exist. Port 4321 (the dev server) was never used by a test.

---

## 7. What is still NOT verified — stated, not assumed

1. **The workerd runtime was never booted.** `wrangler` is not installed on this machine and no workerd binary is available, so the Cloudflare claims are about the Cloudflare **code path**, executed in a Web-standard runtime — not about Cloudflare's runtime. A real Cloudflare deployment needs `wrangler pages dev` **and** a D1/KV store. The npm registry is reachable, so `npx wrangler` would work if that run is ever wanted.
2. **The rate limit is still per instance on Vercel.** The seam and the durable backends are in place; the *shared* counter for the launch target arrives with T4. I did not pick a vendor for it — that is the user's storage decision.
3. No browser run · no live Resend/Turnstile · TTL paths tested at their boundaries, not by waiting out the clock.
4. **The storage migration is still not started**, so every JSONL behaviour above is still live code.
5. The public contact form's per-IP limit is still in-memory on Vercel — unchanged on purpose (Turnstile is its gate), but it is the same class of weakness.
6. `npm ci` was not re-run by me in this wave.

---

## 8. What is still blocked on the owner (@you)

Unchanged, and none of it is mine to decide:

1. **Turso or Neon** — my answer: **Turso** (SQLite-shaped data, one HTTP store for both runtimes, free local dev) — **and keep Vercel** (dropping it means porting the portal onto the tree that is *less* complete).
2. **Consent wording** approval (`site/src/data/testimonial-consent.ts`).
3. **The real domain** — 3 files still fall back to `imk.example`.
4. **The real Calendly link** — `/book` still points at the placeholder.
5. **The Resend sender identity** — verify `2imk4support@gmail.com`, or a domain sender once there is a domain.

---

## 9. Handoffs

- **@QA Engineer** — two new suites to own and re-run: `site/qa/qa-rate-limit.mjs` and `site/qa/qa-cf-parity.mjs` (both are in `site/qa/run-all-suites.ps1` now). I also edited `site/qa/qa-mutation-probe.mjs`: P3 had to be rewritten for the new limiter API (it referenced a function that no longer exists — the patched copy crashed, which the probe reported honestly as `O3=MISSING`), and P4 is new. My inversion of a check is a claim; your re-run is the proof.
- **@Code Reviewer** — `spec/08` **§4.7** is the diff to re-audit. The two things I would want a second pair of eyes on: the limiter's failure handling (does a degraded backend really never fail a request?) and the CF 501 guards (is there a path that should still answer normally on the edge?).
- **@DevOps** — no new dependency, no lockfile change. One deploy note: a malformed moderation store now **fails the build loudly** (from wave 2), and the Cloudflare tree will answer `501` for every portal endpoint until a real store exists — do not point the Cloudflare target at the portal expecting it to work.
- **@Frontend Developer** — nothing needed from you in this wave; the portal page already treats a non-OK portal answer as "not deployed" and hides the card, which is the correct behaviour now that the CF tree answers `501`.
