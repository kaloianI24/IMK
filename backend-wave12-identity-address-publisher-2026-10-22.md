# Wave 12 — backend: the record identity, the platform address, the publisher guards

**Date:** 2026-10-22
**Scope:** `api/**`, `site/shared/**`, `site/functions/**`, `site/scripts/publish-testimonials.mjs`,
`backend-wave10-store-integrity-harness.mjs` (the only harness I own and changed).
**Verdict:** **DONE-PARTIAL** — B-1 … B-5 are all implemented and proven by execution; **three QA
suites need a re-pin** (the reason and the exact text are in §6) and **two doc items are DevOps'**
(§7).

---

## 1. The five items, one line each

| # | Item | Status | Where |
|---|---|---|---|
| B-1 | the owner's link can approve the WRONG quote (a revision number is not an identity) | **DONE** — the link now names the RECORD, signed | `site/shared/portal-store/record-id.ts` (new), `types.ts:103`, `file-adapter.ts:284`, `libsql-adapter.ts:558`, `api/lib/notifications.ts:137`, `api/moderate/review.ts:350` |
| B-2 | the rate-limit bucket is client-choosable on Vercel (`cf-connecting-ip`) | **DONE** — one shared rule for both trees | `site/shared/server/platform-address.ts` (new), `api/portal/auth.ts:171`, `api/contact.ts:301`, `site/functions/api/portal/auth.ts:206` |
| B-3 | `api/lib/jsonl.ts` is a dead Vercel function | **DONE** — deleted, 20 → **19** files | `api/lib/jsonl.ts` (deleted), harness G1/G2 re-pinned |
| B-4 | a store with records but NO review record empties the published set | **DONE** — the wave-11 rule, one step further | `site/scripts/publish-testimonials.mjs:293-296` |
| B-5 | the publisher's swap is crash-unsafe (the published dir is GONE between two renames) | **DONE** — the previous set is restored on the next run | `site/scripts/publish-testimonials.mjs:710-780`, `:917` |

---

## 2. B-1 — the record identity (LAUNCH-CRITICAL)

### The defect

`api/portal/testimonials.ts:633` computed `revision: (existing?.revision || 0) + 1` from a read that
is not atomic. Two concurrent submits for one project therefore produced **two records with the same
`(ref, revision)`** (audit MAJOR-1, reproduced by the Code Reviewer in P3a). The signed link carried
only `(ref, decision, revision, ts)`, and the store flipped the NEWEST record for that ref — so the
owner's link, which the mail had attached to QUOTE-A, approved **QUOTE-B**. The revision scope of
wave 10 (F-2) could not see it: `revision = N` does not identify a record.

### The fix

**A record in the `reviews` collection now carries an IDENTITY**, and the identity — not the
revision number — is what a moderation link names.

* `site/shared/portal-store/record-id.ts` (new, edge-safe, no `node:` imports):
  `newRecordId()` (:48) mints `rec_<uuid>`; `recordIdentity()` (:71) reads it.
  The **store** assigns it, so a caller cannot choose it and two records cannot share one.
* `site/shared/portal-store/types.ts:53-64` — `append()` now returns **the stored record** (the
  one that carries the identity); `:103` — `decideReview(..., expectedRecordId?)`.
* `site/shared/portal-store/file-adapter.ts:138` (`withRecordIdentity`), `:197` (append),
  `:284-285` (the identity scope).
* `site/shared/portal-store/libsql-adapter.ts:184`, `:410`, `:556-558` (the predicate lives INSIDE
  the single UPDATE statement: `AND json_extract(data, '$.recordId') = ?` — so the scope is
  atomic), `:610-611` (the fallback read).
* `site/shared/server/moderation.ts:55` (`ModerationParams.recordId`), `:64` (`RECORD_ID_PATTERN`),
  `:124-129` (parsed and validated), `:227` (the confirmation page carries it as a hidden input).
* `api/lib/notifications.ts:135-137` — the signed message is now
  `ref|decision|revision|recordId|ts`; `:150` — the link carries `&recordId=`.
  **The legacy form `ref|decision|revision|ts` is still accepted**, so a link that is already in an
  owner's inbox keeps working. There is **no downgrade**: a link WITH an identity is signed over
  the identity, so stripping it produces a signature that no longer matches (proved by H3).
* `api/moderate/review.ts:350` — the handler compares the identity as well
  (`identityStale`), `:413` — the identity goes into `decideReview`, `:431-433` — the same check on
  the re-read after a refused write, `:178` — a fresh link is mailed **with** the identity.
* `api/portal/testimonials.ts:699` — the mail carries `stored.recordId`.
* `api/admin/reviews.ts:252-263` — the owner's inbox mints identity-scoped links.
* The Cloudflare twins mirror it: `site/functions/api/lib/notifications.ts:106-108,150`,
  `site/functions/api/moderate/review.ts:266,386`,
  `site/functions/api/portal/testimonials.ts:591` (the edge handler writes the JSONL itself, so it
  mints the identity itself).

### The new contract

`npm run test:store` = **72/72** (was 66). Six new assertions, in
`site/shared/portal-store/test/contract.shared.ts` — they run against **both** adapters:

* a record in the `reviews` collection is given an identity, and the identity is IN the store;
* two records never share an identity (20 appends, 20 identities);
* `decideReview` with an expected identity flips ONLY the record it names — the **collision** case:
  two records with the same `(ref, revision)`, the link naming the older one is REFUSED and
  **neither** record is decided.

One file-specific check was re-pinned (not weakened):
`site/shared/portal-store/test/contract.test.ts` — "a file written by the adapter is
byte-identical to the legacy rewriteJsonl format" now builds the expected bytes from the records
the store RETURNED, and additionally asserts that the stored record carries a non-empty identity
and that two records do not share one. The byte-identity assertion itself is unchanged.

### What the owner sees

Nothing changes for a single quote. The link in the mail now also names the record, the
confirmation page carries it in its form, and the POST the form makes is scoped to that record. A
link for a quote that has since been replaced answers **409 stale-revision** and mails a fresh
link — as before.

---

## 3. B-2 — the platform address (LAUNCH-CRITICAL)

### The defect

`api/portal/auth.ts:160-161` read `cf-connecting-ip` **first**. That header is set by Cloudflare
and only by Cloudflare; the launch target is Vercel, which neither sets nor strips it, so a client
that rotated it got a **fresh bucket per request** — measured 0/8 limited where a fixed address gave
3/8 (audit MAJOR-2). The same header fed the Turnstile `remoteip` and the contact form's per-IP
limit (`api/contact.ts:289`).

### The fix

`site/shared/server/platform-address.ts` (new, edge-safe) — ONE rule for both trees, in this order:

1. `cf-connecting-ip` — **only** when Cloudflare really is in front (`TRUST_CF_CONNECTING_IP=1`).
2. `x-real-ip` — Vercel's own single-value client address.
3. `x-vercel-forwarded-for` — the last hop.
4. `x-forwarded-for` — the last hop (the platform appends the address it saw).
5. nothing → the per-instance bucket (`INSTANCE_BUCKET`), as before.

`trustCfConnectingIp(env)` (:111) reads the switch; it is **off by default**. The Cloudflare tree
turns it **on** (`site/functions/api/portal/auth.ts:206-208`) because that runtime IS Cloudflare and
always overwrites the header. The Vercel tree reads the environment
(`api/portal/auth.ts:171-178`) — so the default is "not trusted", which is correct for the launch
target. `api/contact.ts:301-306` now uses the same helper, so the Turnstile `remoteip` and the
contact form's limiter key are the same platform-controlled address.

**Action for DevOps (not mine to write):** `TRUST_CF_CONNECTING_IP` is a new, optional variable.
It must be documented in `DEPLOY.md` and `site/.env.example` — **leave it unset** unless Cloudflare
really is in front of the Vercel deployment (then set it to `1`, or every client shares one bucket
and the sign-in limiter becomes global).

---

## 4. B-3 — the dead function

`api/lib/jsonl.ts` is **deleted** (it had **zero** product importers; the only mentions left were
comments). `api/` now holds **19** `.ts` files (was 20): 17 routes + 2 shared utilities
(`lib/notifications.ts`, `lib/rate-limit.ts`, both imported by real handlers). That frees one of
the Hobby plan's 12 function slots.

The wave-10 harness G group is **re-pinned** (not deleted):

* **G1** — "the dead function is GONE": asserts the file does not exist, that `api/` holds exactly
  19 `.ts` files, and that the two remaining shared utilities each have a real importer (so they
  are functions that work, not functions that 500).
* **G2** — "QA's legacy sandbox is self-contained": asserts the frozen fixtures
  `site/qa/fixtures/prewave9-lib-jsonl.ts.txt` and `prewave9-lib-notifications.ts.txt` exist, that
  the QA suite uses them, and that it removes the product copy from the scratch tree before writing
  the frozen one in (`fs.rmSync(productCopy, { force: true })`). The old anchor ("the file is still
  there only because QA's fixture imports it") is gone — QA re-pinned that fixture.

---

## 5. B-4 and B-5 — the publisher

### B-4 — a store without review records

`site/scripts/publish-testimonials.mjs:293-296`: the wave-11 guard counted **records**; it now
counts **review records**:

```js
const reviews = records.filter((record) => record && record.type === 'review');
...
if (reviews.length > 0 || published.length === 0) return;
```

* zero review records + published quotes exist → **exit 1**, the published directory is not touched;
* zero review records + nothing published → **exit 0** (a fresh install still builds);
* review records exist → unchanged (a revoked / declined / withheld quote still legitimately
  shrinks the published set — A5 depends on this).

The malformed-line `try/catch` block is **byte-identical** (untouched) — QA's **P2** probe still
passes.

### B-5 — the crash-safe swap

`site/scripts/publish-testimonials.mjs`:

* `swapStamp()` (:710) — the millisecond stamp inside a `.testimonials-previous-<pid>-<ms>` name.
* `recoverInterruptedSwap()` (:736-780) — when the published directory is **missing** and a
  `.testimonials-previous-*` sibling exists, the newest sibling is renamed back into place and the
  crashed run's staging directories are removed. It says so in the log
  (`outcome: "testimonials_swap_recovered"`).
* The recovery runs **before the store is read** (:917, in the entry-point block, so that a build
  that then fails still leaves the published set exactly as it was).

The gap the Code Reviewer found (a process killed between the two renames leaves the published
directory GONE, with the quotes only in a sibling nobody restored) is closed: the next run restores
them.

---

## 6. The new probes, and the QA re-pins I need

### 6.1 New checks in `backend-wave10-store-integrity-harness.mjs` (28 → **41**, all green)

| id | what it proves | mutation |
|---|---|---|
| **H1** | the **collision** refuses the decision — the link naming the older of two records with the same `(ref, revision)` answers 409 and NEITHER record is decided, **in file mode AND libsql mode** (over the real wire protocol) | — |
| **H2** | the protection is not vacuous | removes the identity scope from **BOTH** layers (handler + store) → the mutated copy approves QUOTE-B, the quote the owner never saw → H1 reddens |
| **H3** | the identity is **signed**: a re-pointed link → 400 `signature`; the identity stripped from the URL → 400 (no downgrade); a link signed over another identity → 409 `stale-revision` | — |
| **H4** | a **rotating `cf-connecting-ip`** does not buy a fresh bucket (2/7 limited) | — |
| **H5** | | `cf-connecting-ip` trusted again → 0/7 limited → H4 reddens |
| **H6** | a store that holds records but **no review record** refuses to publish, the published quote survives | — |
| **H7** | | the guard counts records instead of review records → the published set is emptied → H6 reddens |
| **H8** | a crash between the two renames is **recoverable**: the previous set is restored, the build still refuses (empty store) and the quote is intact | — |
| **H9** | | the recovery removed → the published set is lost → H8 reddens |
| **H10** | the owner's whole path: the signed link → the confirmation page (which carries the identity) → the POST the form makes → the quote is approved | — |

Re-pinned (not weakened) in the same harness: **A4/A10** now accept the new wording
(`no (review|moderation) records` — the check's intent is "the failure must name the condition"),
and the two mutation anchors **A7/A12** now point at the new guard line
`if (reviews.length > 0 || published.length === 0) return;`.

### 6.2 The QA re-pins I need (QA owns `site/qa/**` — I did not touch it)

**Reason (all three failures have ONE root cause):** the moderation link now carries a `recordId`
parameter, and the QA helpers that copy a link's fields into the POST body drop it. The link's
signature is computed **over** the identity, so a POST without it no longer verifies → the endpoint
answers **400 `signature`** instead of 409/200. The product is right; the QA helpers must carry the
new field.

**(1) `site/qa/qa-wave2-independent.mjs:449`** — the cause of the three FAILs (M1, M4, M5):

```js
  for (const name of ['ref', 'decision', 'revision', 'ts', 'sig']) {
```
→
```js
  for (const name of ['ref', 'decision', 'revision', 'recordId', 'ts', 'sig']) {
```

(an empty `recordId` is harmless: `parseModerationParams` treats `''` as absent, so legacy links
keep working — `site/shared/server/moderation.ts:124`.)

**(2) `site/qa/qa-admin-independent.mjs:984-997`** — the inbox's link check and its form fields.
The seeded queue holds records **without** an identity, so the suite passes today — but it no
longer tests the real link shape. It must verify the identity form when the link carries one:

```js
    const recordId = approve.searchParams.get('recordId') || '';
    const expected = recordId
      ? qaSignModerationWithIdentity(ref, decision, revision, recordId, ts)
      : qaSignModeration(ref, decision, revision, ts);
    ...
    for (const name of ['ref', 'decision', 'revision', 'recordId', 'ts', 'sig']) {
```

**(3) `site/qa/qa-mutation-probe.mjs:139-149`** and
**`site/qa/qa-anchor-nonvacuity.mjs:241-246`** — the P1 anchors. The handler's guard text changed,
and the guard now has **three** layers, so removing the two old ones is no longer enough:

* the handler anchor `'if (currentRevision !== revision) {'` →
  `'if (currentRevision !== revision || identityStale) {'`
* the store anchor is UNCHANGED:
  `'if (expectedRevision !== undefined && revisionNumber(record) !== expectedRevision) {'`
* the probe must ALSO remove the identity scope, or M1/M2 stay green:

  * handler — `api/moderate/review.ts:350`
    `'const identityStale = recordId !== undefined && recordId !== \'\' && recordId !== currentRecordId;'`
    → `'const identityStale = false;'`
  * store — `site/shared/portal-store/file-adapter.ts:284-285`
    ```
      if (expectedRecordId !== undefined && expectedRecordId !== '') {
        if (recordIdentity(record) !== expectedRecordId) return null;
      }
    ```
    → `if (false) { return null; }`

  (the libSQL twin has the same scope at `libsql-adapter.ts:556-558` and `:610-611`; the file
  adapter is the one the probe patches.)

**The QA runner today: 15 suites, 12 exit 0, 3 exit 1** —
`qa-wave2-independent.mjs` (M1/M4/M5), `qa-mutation-probe.mjs` (the P1 probe),
`qa-anchor-nonvacuity.mjs` (the P1 proofs). **All three are the re-pins above and nothing else.**
Transcript: `site/qa/artifacts/qa-full-run-2026-10-22-055457.txt`.

---

## 7. For DevOps / the Manager (not my files)

* **`DEPLOY.md` + `site/.env.example`**: document `TRUST_CF_CONNECTING_IP` (optional, default off).
  I did not touch either file.
* **`DEPLOY.md`**: the function budget is now **19 files = 17 routes + 2 shared utilities**
  (`api/lib/jsonl.ts` is gone). The `api/lib/rate-limit.ts:430-440` and
  `publish-testimonials.mjs` line references are still valid, but the publisher's
  `readReviewsFromStore()` is now at **`site/scripts/publish-testimonials.mjs:669`** and the
  wave-12 rules (an empty store **and** a store without review records; the swap recovery) belong
  in the paragraph that documents the publisher's failure behaviour.
* The moderation link's signed message is now `ref|decision|revision|recordId|ts` — if DEPLOY.md
  documents the old shape, it needs the update.

---

## 8. The gates (all executed by me, on the current tree)

| Gate | Result |
|---|---|
| `npm run typecheck:api` | **exit 0** |
| `npm run check:routes` | **16 route(s), 0 missing** |
| `npm run test:store` | **72 pass / 0 fail** (was 66 — 6 new identity assertions) |
| `backend-wave10-store-integrity-harness.mjs` | **41/41** (was 28 — H1…H10 added) |
| `backend-wave6-harness.mjs` | 24/24 |
| `backend-f1-magic-token-harness.mjs` | 22/22 |
| `backend-wave8-harness.mjs` | 35/35 |
| `backend-wave8-session-endpoint-harness.mjs` | 57/57 |
| `backend-wave8-moderation-m1-harness.mjs` | 11/11 (its mutation anchor re-pinned for the new page text) |
| `backend-wave9-store-wiring-harness.mjs` | 13/13 (W2b re-pinned: the records are compared without the identity, and the identity is asserted) |
| `backend-wave9b-admin-inbox-store-harness.mjs` | 16/16 |
| QA runner (`powershell -NoProfile -ExecutionPolicy Bypass -File site\qa\run-all-suites.ps1`) | **15 suites, 12 exit 0, 3 exit 1 — the three QA re-pins of §6.2** (transcript `site/qa/artifacts/qa-full-run-2026-10-22-055457.txt`) |
| `astro check` | 0 errors / 0 warnings / **11 hints** (the baseline is unchanged) |
| `site/data` | untouched: `reviews.jsonl` **0 bytes**, no `site/data/portal/` |
| git | **no mutating git command** was run; the tree was already dirty and stays dirty |

The QA secrets were set in the shell before the runner, as the brief requires:
`PORTAL_MAGIC_LINK_SECRET`, `PORTAL_SESSION_SECRET` (both 32+ chars) and `FORM_WEBHOOK_SECRET`.
`pwsh` is **not installed** on this machine — the runner needs
`powershell -NoProfile -ExecutionPolicy Bypass -File site\qa\run-all-suites.ps1`.

---

## 9. UNVERIFIED — stated plainly

* **No real Turso database was contacted.** The libSQL half is proven against a real SQLite
  engine (Python's `sqlite3`) over the real v2 HTTP pipeline protocol — not against Turso's
  service. `json_extract` (the new identity predicate) is proven on that engine.
* **No Vercel router and no workerd were booted.** The CF twin is exercised in-process (a
  `Request`/`Response` bundle), not in a real Worker.
* **Nothing was deployed**, no live mail was sent, no real sign-in link was clicked.
* **The platform half of B-2 is documentation, not observation**: that Vercel overwrites
  `x-forwarded-for` and exposes `x-real-ip` is Vercel's published behaviour; no request was
  observed on Vercel. What IS proven by execution is the code behaviour: with the old order a
  rotating `cf-connecting-ip` is not limited at all (H5: 0/7), with the new order it is (H4: 2/7).
* **The publisher was never run against the repository's own published directory** — every
  publisher check runs in a temp sandbox.
* The dev server on **4321 still runs the pre-wave-12 bundle** (it bundles at start-up); it needs
  an in-place `npm run dev:portal` restart, which I did not touch.
* The QA transcript pins the tree as of **05:54:57**, not a commit.
* I did **not** re-audit QA's own fixtures for the identity field; the three re-pins in §6.2 are
  my reading of the failing suites, not a QA verdict.
