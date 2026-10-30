# Wave 11 — Backend: the publisher no longer deletes published quotes when the store is empty

**Status: DONE.**
Repo `C:\Users\Kalch\Documents\IXI`, branch `main`, no git remote, permanently dirty tree.
Files changed (mine, and only mine): `site/scripts/publish-testimonials.mjs`, `backend-wave10-store-integrity-harness.mjs`.
No git write command of any kind was run. `site/qa/**`, `api/**`, `site/shared/**`, `DEPLOY.md`, `site/.env.example`, `site/data/**` were not touched.

---

## 1. The defect, and what it is now

**The rule the product must satisfy (both store modes):**

| The store yields | Published quotes exist | Outcome |
|---|---|---|
| zero records | yes | **exit 1**, precise message, the published directory is left EXACTLY as it was |
| zero records | no | **exit 0**, publish nothing (a fresh install still builds) |
| one or more records | any | unchanged (approved + consented quotes publish; a revoked quote disappears — A5) |

**What changed, with `file:line`:**

| `site/scripts/publish-testimonials.mjs` | What |
|---|---|
| `:236-242` | **NEW** `class EmptyStoreError` — a store that is THERE, readable and holds NOTHING is its own typed condition (next to `MissingStoreError`, which stays the "not there" case) |
| `:263-292` | **NEW** `assertStoreIsNotEmpty(records)` — the guard, as a **separate new code path**: zero records + published quotes exist → throw `EmptyStoreError`; otherwise return |
| `:657-690` (`readReviewsFromStore`) | the read result is now held in `records` and the guard is applied at `:686`, **after** the read and **after** the existing "missing store + nothing published" escape hatch (`:667`) — so the guard covers every path (file store, database, and the missing-store escape) with one rule |
| `:42-58`, `:73-75` | the header comment no longer claims "a store that is there and is EMPTY → exit 0, nothing published"; it states the new rule and the fresh-install exception |

**The message names the condition** (this is what the operator sees):

```
[publish-testimonials] the portal store holds NO moderation records, but 1 published
testimonial(s) exist. An empty store must never replace a published set — refusing to
publish an empty set of testimonials. Check that the build reads the right store
(PORTAL_STORE / PORTAL_DATA_DIR) before publishing again.
```

**The Manager's exact reproduction, re-run by me after the fix** (file mode, `PORTAL_STORE=file`, a 0-byte `data/moderation/reviews.jsonl`, one published `kept.md`):

```
EXITCODE=1
PUBLISHED=1        <- the published quote survived
```

Before the fix that same scenario was `exit 0`, `written: 0`, and the published quote was **gone**.

**The database path is closed too, including the one-run-apart offset.** The first run creates the schema and refuses; the second run finds the schema, reads zero rows — and now refuses as well. The store state and the verdict no longer change between run 1 and run 2 (A4 runs it three times).

### The hard constraint — QA's P2 anchor is untouched

The malformed-line block in `readReviewsFromFile` is **byte-identical** — I did not touch that function at all. It now sits at `:322-330`:

```js
    try {
      records.push(JSON.parse(line));
    } catch {
      throw new Error(
        `${file} line ${index + 1} is not valid JSON — ` +
          'refusing to publish a partial set of testimonials. Fix or remove that line.',
      );
    }
```

The anchor text `'refusing to publish a partial set of testimonials. Fix or remove that line.',` occurs **exactly once** in the file (verified). The new guard is a different function, called from a different place — it cannot move that anchor. `site/qa/qa-anchor-nonvacuity.mjs` (QA's liveness prover for that anchor) and `site/qa/qa-mutation-probe.mjs` (P2) were executed and are green (§5).

---

## 2. The harness — `backend-wave10-store-integrity-harness.mjs`

**28 checks → 31 checks, 31/31 green.**

| Check | What it proves |
|---|---|
| **A4** (re-pinned, not deleted) | a reachable, schema-present but **EMPTY** store now **REFUSES** (exit 1), the message names the condition, the published quote survives — and the **third** run refuses too (the one-run-apart trap) |
| **A10** (new) | an **EMPTY** store + a published quote refuses in **BOTH modes** — the file store (a 0-byte `reviews.jsonl`) and the database (schema present, empty table) — and the published quote survives in both |
| **A11** (new) | an **EMPTY** store + **nothing** published exits **0** and writes nothing, in both modes — the fresh-clone case still builds (QA's BUILD-14 depends on it) |
| **A12** (new, MUTATION) | with the empty store treated as "publish nothing" instead of fatal, **A10 goes RED**: the mutated copy exits 0 and deletes the published quote. Only the wave-11 guard is removed; the missing-store check stays, so the guard is the only thing standing between the empty store and the quotes |

**A7 was re-pinned too, and this one matters.** A7 was: *"with the missing store treated as an empty store, A1 goes RED"* — it patched the missing-store check to `return []` and asserted the mutated copy exits 0 and destroys the published quote. After wave 11 that single-layer mutation **no longer destroys anything**: the new guard refuses instead, so the mutation would have made A7 assert a lie (and A1 would have lost its non-vacuity proof). A7 now removes **both** layers — the missing-store check **and** the empty-store guard — which is the real wave-10+11 defect state. Its intent is unchanged and it still reddens: the mutated copy publishes an empty set and deletes the published quote.

*(This is the same situation QA hit in wave 11 with the P1 probe: one guard became two layers, so the mutation had to remove both.)*

---

## 3. Gates — every one executed by me, on the tree as it is now

| Gate | Result |
|---|---|
| `npm run typecheck:api` | **exit 0** |
| `npm run check:routes` | **16 route(s), 0 missing function file(s)** — "OK: every called path has a function file in both trees" |
| `npm run test:store` | **66 pass / 0 fail** (`1..66`, `# pass 66`, `# fail 0`) |
| `backend-wave10-store-integrity-harness.mjs` | **31/31 checks passed** (was 28/28; +A10, +A11, +A12) — exit 0 |
| `backend-wave6-harness.mjs` | **24 passed, 0 failed, 24 checks** — exit 0 |
| `backend-f1-magic-token-harness.mjs` | **22 passed, 0 failed, 22 checks** — exit 0 |
| `backend-wave8-harness.mjs` | **35 passed, 0 failed, 35 checks** — exit 0 |
| `backend-wave8-session-endpoint-harness.mjs` | **57/57 passed, 0 failed** — exit 0 |
| `backend-wave8-moderation-m1-harness.mjs` | **11/11 passed, 0 failed** — exit 0 |
| `backend-wave9-store-wiring-harness.mjs` | **13/13 checks passed** — exit 0 |
| `backend-wave9b-admin-inbox-store-harness.mjs` | **16/16 checks passed** — exit 0 |
| `site/data` untouched | `site/data/moderation/reviews.jsonl` = **0 bytes**, SHA-256 `E3B0C442…7852B855` (the empty-string hash); **no** `site/data/portal/` |

The seven older harnesses are unchanged as files — the counts are the same numbers as wave 10 (24 / 22 / 35 / 57 / 11 / 13 / 16), and they are green on the tree with my change in it.

**Extra (not a gate, but the suites that touch the publisher):** the six publisher-related QA suites were executed with 32+ char local test secrets — `qa-backend-hardening.mjs` (L8), `qa-wave2-independent.mjs` (N group), `qa-mutation-probe.mjs` (**P2 — the malformed-line anchor**), `qa-anchor-nonvacuity.mjs` (**the P2/D2 anchor liveness prover**), `qa-wave9-store-independent.mjs` (B group — the publisher) and `qa-testimonials-build.mjs` (**BUILD-14 — a site with no store still builds**). Results in §5. `site/qa/**` was not edited.

---

## 4. Findings, ranked by severity

| # | Severity | Finding | Where | Proof |
|---|---|---|---|---|
| 1 | **CRITICAL — closed** | a store that is present, readable and **empty** deleted every published quote and reported success (`"written": 0`) | `publish-testimonials.mjs:657-690` (was: `readReviewsFromStore` returned `[]` → `main()` → `swapIn([])` → the published directory renamed aside and deleted) | A4, A10, A12, and the Manager's reproduction re-run by me |
| 2 | **HIGH — closed** | the **database** path had the same hole **one run later**: run 1 created the schema and refused, run 2 found the schema, read zero rows and deleted the quotes. Same store state, opposite verdict | `publish-testimonials.mjs:628` (the no-schema `MissingStoreError`) and the empty read that followed it | A4 (three consecutive runs, all refusing) |
| 3 | **MEDIUM — closed** | the two store modes disagreed about the same condition | the guard is now one function, applied to both paths | A10 (file + database refuse identically), A11 (both build) |
| 4 | **MEDIUM — harness** | A7's single-layer mutation stopped proving anything once the second guard existed (the mutation would have "passed" for the wrong reason) | `backend-wave10-store-integrity-harness.mjs` A7 | A7 now removes both layers and still reddens |
| 5 | **LOW — left alone, reported** | a store that holds records but **none of them is a `type: 'review'`** record (or none approved) still publishes an empty set and removes the published quotes. That is rule 3 of the brief ("the store yields records → unchanged behaviour") and A5 (a revoked quote must disappear) depends on it, so I did **not** change it. If the owner wants "the published set may only be emptied by an explicit revoke", that is a separate decision | `publish-testimonials.mjs` `main()` / `latestByRef()` | not changed — reported, not silently altered |
| 6 | **LOW — reported, not mine** | `DEPLOY.md` describes the publisher's store read with a stale line range (`publish-testimonials.mjs:328-334`); the function is now at `:657`. DevOps owns that file and has a wave-11 brief of their own | `DEPLOY.md:73` | not edited — flagged for DevOps |

---

## 5. The QA suites I executed (extra evidence, not a gate)

The six publisher-related QA suites, executed with 32+ char local test secrets (`PORTAL_MAGIC_LINK_SECRET`, `PORTAL_SESSION_SECRET`). **`site/qa/**` was not edited.** Port 4321 was never used (the API suite binds 4399).

| Suite | Result |
|---|---|
| `qa-testimonials.mjs` (the API suite) | **102 passed, 0 failed, 102 checks** — exit 0 |
| `qa-testimonials-build.mjs` (a **real** `astro build`) | **14 passed, 0 failed, 14 build checks** — exit 0. **BUILD-14** ("a site with no moderation store at all still builds — exit 0, quiet, empty state") is the fresh-install case rule 2 protects; BUILD-10/11/12 (a withdrawn quote is gone) are rule 3 unchanged |
| `qa-backend-hardening.mjs` (L8 — the publisher refuses a malformed store) | **21 passed, 0 failed** — exit 0 |
| `qa-wave2-independent.mjs` (the N group — the publisher) | **29 passed, 0 failed** — exit 0 |
| `qa-wave9-store-independent.mjs` (the B group — the publisher) | **26 checks: 26 PASS, 0 FAIL** — exit 0 |
| `qa-anchor-nonvacuity.mjs` (QA's **P2/D2 anchor liveness prover**) | **exit 0** — the malformed-line anchor is still load-bearing and still breaks loudly if the text drifts |
| `qa-mutation-probe.mjs` | **exit 1 — `PROBE FAIL P1` only.** P2 (the publisher's malformed-line anchor) **PASSES**: N1, N2, N3 all redden when the defect is put back, so my change did not weaken it. P1 fails because it patches `api/moderate/review.ts` (the stale-revision guard) and expects M1/M2 to redden — with wave 10's second layer in the store they no longer do. That is the **pre-existing** failure the wave-11 QA brief already records ("`qa-mutation-probe.mjs` exit 1 — `PROBE FAIL P1`") and it is QA's re-pin to make. It patches a file I did not touch. |

*(The QA runner itself is QA's gate in this wave — QA is re-pinning two suites in parallel, so a full-run transcript from me would be a transcript of a tree in flux. The suites above are the part of the runner my change can reach.)*

---

## 6. UNVERIFIED — plainly

* **The working tree stays dirty.** No git write command was run (no add, commit, reset, clean, checkout or stash). `HEAD` is still `a882606` and the tree has ~100 changed paths from every wave. The publisher's `git diff` therefore shows waves 9 + 10 + 11 together, not only my change.
* **One generated file in QA's folder was rewritten by my run:** `site/qa/artifacts/qa-testimonials-results.json` (the API suite's `--json` output, which the runner writes on every run too). No QA **source** file was edited — `site/qa/run-all-suites.ps1` and the new `site/qa/*.mjs` files that `git status` shows are QA's own in-flight wave-11 work.
* **No real Turso database was ever contacted.** The database half is proven against a **real SQLite engine over the real libSQL HTTP v2 wire protocol** (the project's own mock pipeline server + `sqlite-worker.py`) — that is Turso's *protocol*, not Turso's *service*.
* **workerd was never booted.** The Cloudflare tree is still a 501 stub by decision and was not exercised.
* **Nothing was deployed.** The Vercel router was never booted, no preview deploy, no production runtime.
* **No live mail.** No Resend sender, no magic link, no moderation link was sent.
* **The published directory was never swapped on a real site.** The publisher was only ever run in sandboxes (`%TEMP%` copies), never against `site/src/content/testimonials` in the repo.
* **The dev server on 4321 still runs the pre-wave-11 bundle** — it bundles at startup, so it needs an in-place `npm run dev:portal` restart before the new code is live locally. I did not touch 4321.
* **A crash between the two renames in `swapIn()`** (the Code Reviewer's open question from the wave-11 audit brief) is untouched by this wave: the new guard fires *before* the swap, so it cannot make that window worse, but I did not change the rollback code.
* The 31/31 is against the tree **as it was at the time of the run**, not against a commit — this tree is permanently dirty and QA is editing `site/qa/**` in parallel.

---

## 7. Done-when

> "The publisher refuses (exit 1) when the store yields zero records while published quotes exist, leaves the published directory untouched, still builds a fresh install with nothing published, and the harness proves both rules non-vacuously via A10/A11/A12 plus a re-pinned A4."

**Met**, in both store modes, with the executed evidence above: exit 1 + the published directory untouched (A4, A10, A12), exit 0 on a fresh install (A8, A11, and QA's BUILD-14), the rules proven non-vacuously by mutation (A12 for the new guard, A7 for the missing-store check), and A4 re-pinned rather than deleted.
