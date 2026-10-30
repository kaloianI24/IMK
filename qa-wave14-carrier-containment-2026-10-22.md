# QA wave 14 — the carrier containment re-pin

**Report:** `C:\Users\Kalch\Documents\IXI\qa-wave14-carrier-containment-2026-10-22.md`
**Date:** 2026-10-22 · **Author:** QA Engineer — Testing and Verification
**Tree:** `C:\Users\Kalch\Documents\IXI` (read from disk, not from any report)
**Files I changed:** `site/qa/qa-wave13-routing.mjs`, `site/qa/qa-wave4-independent.mjs`,
`site/qa/run-all-suites.ps1` — **nothing else**. No git write command was run.

**Verdict: DONE.** The QA runner is **17/17 exit 0**. Every item of the brief is PASS.

---

## 0. The baseline I started from

The brief said the tree was red. It was — and the two reds were **exactly** the two the
wave-14 Backend report predicted, both stale anchors and not new defects. Baseline run
(transcript `site/qa/artifacts/qa-full-run-2026-10-22-095844.txt`, 16 suites, 2 exit 1):

| suite | exit | what was red |
|---|---|---|
| `qa-wave4-independent.mjs` | 1 | `B2b` — the F2 tripwire fired: the Backend fixed the crash, so the check that asserted the crash went red |
| `qa-wave13-routing.mjs` | 1 | `MP-R3` — "the mutant run did not go RED (R8 = PASS)": wave 14's new prefix check made the table-only mutation vacuous |

Everything else was green in the baseline, including `qa-mutation-probe.mjs` (5/5) and
`qa-anchor-nonvacuity.mjs` (20/20) — which is the first hard evidence for **F3** below.

---

## 1. F1 — R9 re-pinned to the deployed invariant — **PASS**

**File:** `site/qa/qa-wave13-routing.mjs:548` (R9), `:602` (R9b, new)

**The old anchor (what it pinned):**

> `R9  the PATH wins over the carrier (a valid path is never hijacked)` — a request to
> `GET /api/portal/projects?__imk_route=/api/portal/comments` must be served by the
> projects handler.

**Why that was a fiction:** it is the **local** shape (the dev server, or a platform that
did not rewrite). On the deployed target `vercel.json` replaces the path with the entry
prefix, so the path does not identify the route and `__imk_route` does. The check said
nothing about production.

**The new anchor (what it pins now):**

> `R9  DEPLOYED SHAPE: the CARRIER decides the route (the path does NOT identify it)`

The observable is stronger and honest: **the same path (`/api/portal`, the entry prefix)
with two different carriers produces two different handlers.** If the path still identified
the route, the two answers would be identical; the path alone resolves to nothing at all
(R6: a loud 500 `route-resolution`). A 200 there can only have come from the carrier.

- Request A: `GET /api/portal?__imk_route=/api/portal/comments&projectId=prj_qa_routing`
  → 200, body has `comments`, body has **no** `projects`.
- Request B: `GET /api/portal?__imk_route=/api/portal/projects`
  → 200, body has `projects`, body has **no** `comments`.

**Nothing was lost.** The old R9's coverage — the resolver's rule 1 (path before carrier) —
is a true property and protects the local dev server, so it is kept as its own check:

> `R9b  LOCAL SHAPE (a platform that did not rewrite): the PATH still wins over the carrier`
> (`site/qa/qa-wave13-routing.mjs:602`) — the same request and the same two assertions as
> the old R9, relabelled so nobody can read it as a production claim.

The old R9 is **re-pinned, not deleted**, and the new R9 is *more* informative than the old
one, not less: the old check exercised one shape, the new one exercises the shape production
has and proves the carrier is what decides it.

---

## 2. F2 — the deployed-shape containment check — **PASS**

**File:** `site/qa/qa-wave13-routing.mjs:625` (R10, new)

The request is built **the way the platform builds it**: the path is the entry prefix and
the original public path arrives in `__imk_route`. A client can put any value there, so the
check asks what a forged carrier can actually reach. It asserts the three invariants the
shipped router now claims (wave 14, F1) **by execution against the real entry points**:

| # | assertion | the observable |
|---|---|---|
| 1 | **family containment** | the portal entry point + a carrier naming `/api/admin/reviews` → a clean **404 `{code:'not-found'}`**, and the body carries **no** `counts` (the owner's queue). The admin entry point + a carrier naming `/api/portal/projects` → 404. |
| 2 | **the standalone URLs are out of reach** | a carrier naming `/api/contact`, `/api/moderate/review`, `/api/portal/auth/verify`, `/api/portal/auth/request-link`, `/api/portal/auth/logout` → 404 `{code:'not-found'}` from the portal entry point. Those five URLs are in **no** family table, so no carrier can name them. |
| 3 | **the handler authorises itself** | no cookie + a carrier naming `/api/portal/session` → **401 `{code:'unauthorized'}`**; a **client** cookie + a carrier naming `/api/admin/reviews` at the admin entry point → **401 `{code:'unauthorized'}`. |

The 401 (not a 404) is deliberate and is the load-bearing part of assertion 3: a 401 proves
the **handler ran and applied its own gate**; a 404 would only mean the router refused the
carrier, and the check would then be measuring the router twice.

### The non-vacuity proof — two mutants, both redden

Both mutants run against a **copy** of the tree in the system temp directory; the
repository is never modified.

**MP-R4** (`site/qa/qa-wave13-routing.mjs:908`) — *the family containment is gone.*
The mutation is the same one the Backend used in its own D2 probe, and it needs **three**
sites, because the containment has three:

1. `site/shared/portal-routes.json` — the portal family gains `/api/admin/reviews`;
2. `api/portal.ts` — the portal entry point's `HANDLERS` map gains `admin-reviews`;
3. `site/shared/portal-router.ts` — `if (!isInsideEntry(carrier, entryPrefix)) {` → `if (false) {`.

With only (1) the mutant is **vacuous** — wave 14's prefix check refuses the cross-family
carrier before the table is consulted, which is exactly why the old MP-R3 went green. With
all three, the forged carrier **really reaches the owner's handler**. I executed the mutant
by hand to confirm the red is for the right reason:

```
FAIL  R8   the portal entry point served an admin route:
      {"ok":true,"counts":{"pendingReviews":0,...},"reviews":[],"recent":[]} -- expected 404, got 200
FAIL  R10  the portal entry point answered 200 for a cross-family carrier
```

**MP-R5** (`site/qa/qa-wave13-routing.mjs:920`) — *the handler stops authorising itself.*
`site/shared/portal-handlers/portal-session.ts`: the `if (!session) { … 401 … }` block
answers **200 `{authenticated:true, role:'admin'}`** instead. Executed by hand:

```
FAIL  R10  the carrier-selected session route answered 200 without a session:
      {"ok":true,"authenticated":true,"role":"admin","email":"mutant@imk.test"} -- expected 401, got 200
```

Probe results in the transcript: `MP-R4 … control R10=PASS, mutant R10=FAIL` and
`MP-R5 … control R10=PASS, mutant R10=FAIL`.

---

## 3. F3 — the P1 mutation anchors — **PASS, no re-pin needed (verified by execution)**

The brief asked me to re-pin the P1 anchors *if the Backend's router edit moved the text
they patch*. **It did not.** Wave 14 changed `site/shared/portal-router.ts` (a comment
block plus the new `isInsideEntry()`); it did not touch `api/moderate/review.ts` or
`site/shared/portal-store/file-adapter.ts`, where the P1 anchors live.

This is not a reading — it is measured, in the fresh transcript:

| proof | result |
|---|---|
| `qa-mutation-probe.mjs` **P1** | `PROBE PASS P1 … M1=FAIL M2=FAIL (24 passed / 5 failed)` — all three layers still removed, still red |
| `qa-anchor-nonvacuity.mjs` **P1-control** | `M1=PASS M2=PASS` |
| `qa-anchor-nonvacuity.mjs` **P1-mutant** | `M1=FAIL M2=FAIL` |
| **P1-half-handler** (only the handler layer removed) | `M1=PASS M2=PASS` — the store still refuses |
| **P1-half-store** (only the store layer removed) | `M1=PASS M2=PASS` — the handler still refuses |
| **P1-half-identity** (only the identity scope removed) | `M1=PASS M2=PASS` — the other two still refuse |
| **P1-liveness-handler / -store / -identity** | the probes still abort loudly if the anchor text drifts |

**20/20 anchor proofs, 0 failures.** Every layer of the stale-revision guard is still
individually load-bearing and every probe still bites. **No edit was required, so none was
made** — re-pinning a text that has not moved would be churn.

---

## 4. F4 — the wave-14 harness in the runner, and the wave-9b legacy sandbox — **PASS**

**The harness is now suite #17** of the runner (`site/qa/run-all-suites.ps1`): the
Backend's `backend-wave14-carrier-containment-harness.mjs` was **not** covered before — it
lived in the repo root and the runner only walked `site/qa/`. It is now run on every QA
pass, and it is green: **24 passed, 0 failed, 24 checks** (A1–A4 the invariants read from
the tree, B1–B4 the resolver as a pure function, C1–C8 the entry points executed, D1–D5
five mutation probes, E1–E3 the deploy gate in a throwaway tree). Its four probes
(D2, D3, D4, D5) redden.

**The wave-9b legacy sandbox still works.** `site/qa/qa-wave9-store-queue.mjs` is green
(`W9-1 … 13/13 sub-assertions`) after the Backend's `site/shared/**` edits, and it is
self-contained: the legacy tree carries its own frozen `api/lib/jsonl.ts` and
`api/lib/notifications.ts` (the `fs.mkdirSync(path.join(legacyRoot, 'api', 'lib'), …)` the
Backend flagged is already present at `qa-wave9-store-queue.mjs:674`, so the wave-14
`api/lib/` removal did not break it — the Backend's "one failure my change caused" note
did not materialise). The suite is unchanged by me.

---

## 5. The other red suite: `qa-wave4` B2b re-pinned to the FIXED behaviour — **PASS**

Not in the brief's list, but it was one of the two reds, so it is mine to close.

**File:** `site/qa/qa-wave4-independent.mjs:1002` (B2b), `:951` (`copyTree(root)`)

**The old anchor (a tripwire asserting the DEFECT):**

> `B2b  KNOWN DEFECT (check-api-routes.mjs): a missing Vercel route file CRASHES the check
> instead of naming it` — it asserted that the output does **NOT** contain
> `/api/portal/auth/request-link`, and its own note said: *"When the Backend fixes the
> script, this check goes RED — that is the signal to re-pin it to the fixed behaviour and
> to delete this note."*

The Backend fixed it in wave 14 (F2): `site/scripts/check-api-routes.mjs:378` now pushes
the row **with** `files`, so the printer at `:402` no longer raises
`TypeError: Cannot read properties of undefined (reading 'vercel')`. The tripwire fired.

**The new anchor (the FIXED behaviour, and it is STRONGER than the tripwire):**

> `B2b  the route check NAMES the missing route instead of crashing (wave 14, F2 FIXED)`

It now asserts three things on a copy with `api/portal/auth/request-link.ts` deleted:

1. the gate still **fails closed** (exit ≠ 0);
2. the output **names** the missing route (`/api/portal/auth/request-link`);
3. the output is **not a stack trace** (no `TypeError`, no
   `Cannot read properties of undefined`);
4. the repository is untouched.

**Non-vacuity proof, inside the same check:** a **second** copy has the F2 fix reverted
(the row is pushed without `files` again — the exact one-line change) and the same route
file deleted. The check then asserts that the mutated gate **crashes again** and **does not
name the route**. The anchor string the mutation patches is asserted to be present, so if
the Backend's fix is reshaped the check aborts loudly instead of passing silently.

Executed: `PASS B2b … exit != 0, the missing route is NAMED, no stack trace; the mutant
crashes again`.

---

## 6. The gate — **PASS**

```
powershell -NoProfile -ExecutionPolicy Bypass -File site\qa\run-all-suites.ps1
```

with `PORTAL_MAGIC_LINK_SECRET` and `PORTAL_SESSION_SECRET` set to 40-character values
(`pwsh` is not installed on this PC; `powershell` 5.1 was used).

**Fresh transcript:** `site/qa/artifacts/qa-full-run-2026-10-22-100848.txt`

| # | suite | exit | result |
|---|---|---|---|
| 1 | `qa-testimonials.mjs` | 0 | 102 checks |
| 2 | `qa-testimonials-build.mjs` | 0 | 14 build checks (real `astro build`) |
| 3 | `qa-backend-hardening.mjs` | 0 | 21 checks |
| 4 | `qa-wave2-independent.mjs` | 0 | 29 checks |
| 5 | `qa-mutation-probe.mjs` | 0 | **5/5 probes** |
| 6 | `qa-rate-limit.mjs` | 0 | 8 checks |
| 7 | `qa-cf-parity.mjs` | 0 | 11 checks |
| 8 | `qa-wave3-independent.mjs` | 0 | 21 checks |
| 9 | `npm run check:routes` | 0 | 16 routes / 0 missing, 7 files, 11 rewrites agree |
| 10 | `qa-wave4-independent.mjs` | 0 | 24 checks (B2b re-pinned) |
| 11 | `qa-wave5-independent.mjs` | 0 | 26 checks (3 probes) |
| 12 | `qa-admin-independent.mjs` | 0 | 17 checks (2 probes) |
| 13 | `qa-wave9-store-queue.mjs` | 0 | W9-1, 13/13 sub-assertions |
| 14 | `qa-wave9-store-independent.mjs` | 0 | 26 checks (4 probes) |
| 15 | `qa-anchor-nonvacuity.mjs` | 0 | **20/20 anchor proofs** |
| 16 | `qa-wave13-routing.mjs` | 0 | **16 checks** (R9, R9b, R10 + 5 probes) |
| 17 | `backend-wave14-carrier-containment-harness.mjs` | 0 | 24 checks (4 probes) — **new in the runner** |

**17 suites, 17 × exit 0.** The transcript holds **322 PASS lines and 0 FAIL lines**, plus
**20/20 anchor proofs** and **5/5 probes** in the dedicated probe suite, **5/5** routing
probes, **4/4** wave-9-store probes, **3/3** wave-5 probes, **2/2** admin probes.

**`site/data` untouched:** `site/data/moderation/reviews.jsonl` is **0 bytes**, SHA-256
`E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855` (the empty string),
and there is **no `site/data/portal/`** directory. Checked before and after the run.

**`astro check`: 0 errors, 0 warnings, 13 hints.** The brief says "11 hints". **11 is the
pre-wave-13 baseline**; the wave-13 tree is 13, and my wave-13 report already documented
that (`qa-wave13-qa-repin-2026-10-22.md` §5.3). The two extra hints are in the wave-13
dev server, **not** in my files: `site/scripts/dev-portal.js:106` (`matchPattern` unused)
and `:134` (`family` unused). **My three files contribute 0 hints.** So the baseline is
unchanged *relative to wave 13*; the brief's number is one wave stale.

---

## 7. What I changed — the complete list

| file | line | what |
|---|---|---|
| `site/qa/qa-wave13-routing.mjs` | 34–44 | header: R9/R9b/R10 and the five probes described |
| `site/qa/qa-wave13-routing.mjs` | 548 | **R9 re-pinned** — the deployed invariant (the carrier decides) |
| `site/qa/qa-wave13-routing.mjs` | 602 | **R9b new** — the local shape, the old R9's coverage kept |
| `site/qa/qa-wave13-routing.mjs` | 625 | **R10 new** — the deployed-shape containment check |
| `site/qa/qa-wave13-routing.mjs` | 832 | `removeFamilyContainment()` — the three-site mutation, shared by MP-R3 and MP-R4 |
| `site/qa/qa-wave13-routing.mjs` | 884 | **MP-R3 re-pinned** — the table patch alone was vacuous; now table + entry point + code |
| `site/qa/qa-wave13-routing.mjs` | 908 | **MP-R4 new** — the family containment removed → R10 red |
| `site/qa/qa-wave13-routing.mjs` | 920 | **MP-R5 new** — the handler's own authorisation removed → R10 red |
| `site/qa/qa-wave4-independent.mjs` | 951 | `copyTree(root = COPY_ROOT)` — a second copy for the mutant |
| `site/qa/qa-wave4-independent.mjs` | 1002 | **B2b re-pinned** to the fixed behaviour + the in-check mutant |
| `site/qa/run-all-suites.ps1` | 152–156 | suite #17 — the wave-14 harness |
| `site/qa/run-all-suites.ps1` | 177, 184 | the summary line and the exit condition for suite 17 |

No product file, no doc, no `site/shared/**`, no `api/**`, no `site/scripts/**`, no
`site/data/**`, no repo-root harness was edited. The repo-root wave-14 harness is the
Backend's file and I only **ran** it.

---

## 8. UNVERIFIED — plainly

1. **No Vercel router was booted.** The merge order between the client's query and the
   rewrite's own query — the question MAJOR-1 turns on — is still **unobserved**. Everything
   above holds **either way** (family containment, the standalone URLs being out of reach,
   the handler's own authorisation), which is exactly what wave 14's comment now claims and
   what I have executed. But the *observation* that would settle the merge order, and would
   tell us whether a forged carrier can select another handler **of the same family**, still
   needs one preview deploy and one `curl`. I did not do it; it is not authorised and it is
   not mine.
2. **No deploy, no preview, no workerd, no Cloudflare runtime booted.** The Cloudflare tree
   was exercised by QA's CF suites (offline simulation), not by a Worker.
3. **No real Turso.** The libSQL path is proven against a real SQLite engine over the real
   wire protocol (the project's own offline mock server), not against Turso.
4. **No live mail.** Every mail path is stubbed.
5. **The transcript pins the tree at 10:08:48, not a commit** — the working tree is
   permanently dirty and shared; other bots may change it under me.
6. **`astro check` was not run by the Code Reviewer in wave 13**, and I did not re-run the
   Astro *build* against the published directory — the publisher never ran against the
   repo's own published directory.
7. **I did not re-audit the wave-12 product changes** (the recordId identity scope, the
   platform-address order, the publisher guards) — the wave-14 Backend harness and my own
   suites cover the routing layer, not those.
8. **The wave-14 Backend's F1 comment rewrite is verified as text and as behaviour, not as
   a platform claim.** `site/shared/portal-router.ts:52-87` now says the merge order is
   NOT OBSERVED, and my R9/R9b/R10 pin the behaviour that is true either way — but only a
   real router can confirm the comment's own caveat.

---

## 9. One thing for the Manager

**F3 turned out to be a non-item and I want it on the record as such:** the brief expected
the wave-14 router edit to have moved the P1 anchors. It did not — wave 14 changed the
router's comment and added `isInsideEntry()`, and the P1 anchors live in
`api/moderate/review.ts` and `site/shared/portal-store/file-adapter.ts`. I verified that
by execution (20/20 anchor proofs, 5/5 probes) and changed nothing, because re-pinning
text that has not moved would be churn dressed up as work.

**And the one open link that is not QA's to close:** MAJOR-1's core. If the client's query
wins the merge on the deployed target, a forged carrier can still pick another handler
**of the same family** — bounded by each handler's own gate, so a routing surprise rather
than an escalation, but a surprise nonetheless. One preview deploy plus one `curl` settles
it. That is an owner decision and I did not take it.
