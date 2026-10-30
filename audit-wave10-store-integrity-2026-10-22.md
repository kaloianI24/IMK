# Wave 10 — independent audit (Code Reviewer, Independent Audit)

**Repo:** `C:\Users\Kalch\Documents\IXI` · branch `main` · no git remote · tree permanently dirty (72 changed paths at the start and at the end of this audit — **I changed nothing**)
**Audit date:** 2026-10-22 · **Author:** @Code Reviewer — Independent Audit
**Scope:** the six wave-10 claims F-1…F-6, read from the tree, plus the publisher-empty-store defect the Manager had already found.

---

## 0. Method, and what "confirmed" means here

Every claim below was re-derived from the code on disk. Where a check runs offline I **executed** it; the rest I state as reading-only and label it.

| How I checked | What |
|---|---|
| **Execution** | My own probe harness, `C:\Users\Kalch\AppData\Local\Temp\opencode\audit-wave10\probe.mjs` (14/14 probes green). It bundles the real handlers with esbuild exactly like the repo harnesses do and runs entirely in a temp sandbox — `…\audit-wave10\2026-10-22T02-03-37-678Z\`. **Nothing was written into the repository.** |
| **Execution (repo harness, unmodified)** | `node backend-wave10-store-integrity-harness.mjs` → **31/31 checks passed** (the tree has grown past wave 10: A4 was re-pinned and A10–A12 were added by wave 11). |
| **Reading only** | Anything I could not run offline — every platform-level behaviour, the Astro build, workerd. |

Probes: **P1a/P1b/P1c** rate-limit key · **P2a/P2b/P2c** revision scope in both adapters · **P3a** the revision race end-to-end through the HTTP handlers · **P4a–P4d** the publisher · **P5a** the baton · **P6a** the reachability probe · **P7** the publisher's dedup rule.

**Timeline note:** `site/scripts/publish-testimonials.mjs` was last written at **04:33:44** — the wave-11 fix — i.e. **before** this audit started (SHA-256 `EF5E69A4…84AFEA`, unchanged when I finished). So I audited wave 10's publisher *as wave 11 left it*, and reproduced wave 10's defective publisher from a **temp copy** with the wave-11 guard removed (P4b/P4c). The wave-11 fix itself was not re-reviewed by me.

---

## 1. Verdict per finding

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| **F-1** | The publisher refuses to publish a partial/empty set | **CONFIRMED (and closed by wave 11)** | A1–A12 green in the repo harness; my P4a: current file → **exit 1, the published quote survives**. P4b/P4c: wave-10 copy → **exit 0, `"written": 0`, the published quote GONE** — the defect reproduced exactly as the Manager described. |
| **F-2** | A decision can no longer land on a revision the owner never saw | **NOT CONFIRMED — the guard works, the SCOPE does not identify a record.** The write *is* atomic; the hole is elsewhere. | P3a (end-to-end), P2a/P2b (both adapters). **See MAJOR-1.** |
| **F-3** | A missing store no longer answers "not invited" / "no projects" / "no quote" | **PARTLY CONFIRMED** | C1–C4 green (7 handlers → 501; mutation reds). But the probe checks *existence*, not *writability*, once the data dir exists → **MINOR-2**. |
| **F-4** | The libSQL transport follows the baton | **CONFIRMED** | D1/D2 green; my P5a: the publisher read **5 records over 5 pages** (page size 1) — its own reader follows the baton too. Duplication drift → **MINOR-4**. |
| **F-5** | The rate-limit key is a platform-controlled address only, and the counter is pruned | **NOT CONFIRMED on the launch target** — the prune is confirmed, the key is not | E1–E4 green; my P1a/P1b: **a rotating `cf-connecting-ip` is not limited at all (0/8)**. **See MAJOR-2.** |
| **F-6** | The Cloudflare inbox answers 501 and no longer claims a file store | **CONFIRMED** | F1/F2/F3 green; the file (`site/functions/api/admin/reviews.ts`, 94 lines) has no `fs` import, no path, no JSONL reader; the 401 (`:56-59`) and both 500 gates (`:45-54`, `:68-81`) come before the 501 (`:83-93`). |

---

## 2. New findings, ranked

### MAJOR-1 — The F-2 revision scope does not identify a record: a decision still lands on text the owner never saw

**Where:** `api/portal/testimonials.ts:503` (read the current record) → `api/portal/testimonials.ts:633` (`revision: (existing?.revision || 0) + 1`) → `api/portal/testimonials.ts:648` (append) · `site/shared/portal-store/file-adapter.ts:232-238` + `:250-252` · `site/shared/portal-store/libsql-adapter.ts:535-538` · `site/shared/portal-store/libsql-schema.ts:95-106` (no UNIQUE constraint on `(ref, revision)`).

**Observed behaviour (executed, P3a):** two concurrent submits of the same project, after the client already had one quote on file:

```
[probe] store order: "the original"#1/pending/rev_2b9b77d5e62b | "QUOTE-A the "#2/pending/rev_2b9b77d5e62b | "QUOTE-B a se"#2/pending/rev_2b9b77d5e62b
{"ref":"rev_2b9b77d5e62b","outcome":"review_decided","decision":"approved","decidedBy":"one-click-link"}
PASS  P3a  both records carry revision 2 and the same ref; the owner's link (revision 2) approved "QUOTE-B a second submit"
```

Both requests read the same `existing` record, so both computed **revision 2 on the same ref**. The owner's one-click link is signed with `(ref, revision)` — it carries **no record identity**. The store's `decideReview` flips the **newest** record for that ref (`file-adapter.ts:232-238`; the libSQL statement's subquery `ORDER BY seq DESC LIMIT 1` at `libsql-adapter.ts:535-537`). So the owner's link — which the notification had attached to **QUOTE-A** — approved **QUOTE-B**. QUOTE-A stayed `pending`.

P2a/P2b prove the same at the store level, in **both** adapters, over the real wire protocol against a real SQLite engine: two records with `ref = X, revision = 5` → `decideReview(X, 'approved', …, 5)` flips the **newest** one and leaves the older `pending`.

**Answer to the Manager's question — is the F-2 revision check atomic?**
**Yes, the write is atomic, and no, atomicity is not the hole.** The libSQL decision is a **single statement** (`libsql-adapter.ts:531-541`) whose `revision = ?` predicate lives *inside* the statement, so a concurrent append either lands before it (the subquery picks the new row, the revision predicate fails → nothing is updated → the handler answers 409 `stale-revision`) or after it (the flip already happened). That part of wave 10 is correct, and the file adapter's equivalent check (`file-adapter.ts:250-252`) agrees.
The defect is that the predicate `revision = N` **does not identify a record**: the revision counter is computed client-side-of-the-read from a value read in a *separate* statement (`testimonials.ts:503` → `:633`), with no lock, no unique constraint and no compare-and-swap. Two concurrent requests therefore produce two records that share `(ref, revision)`, and the scope silently becomes ambiguous. F-2 fixed *"the decision landed on a revision with a different number"*; it did not fix *"the decision landed on a different record with the same number"*, which is the same harm.

**Impact on the owner's launch:** the owner's one-click approve — the whole moderation loop — can publish a quote the owner never read. It needs two submits of the same project inside one request round trip (double-click, two tabs, a client retry, a double-submitted form). The submit rate limit is **5 per client per hour** (`testimonials.ts:60`), so this is not a rare shape. With `PORTAL_STORE=libsql` the read is a network round trip, which *widens* the window rather than narrowing it.

**Recommended fix (pick one):**
1. **Make the revision unique per ref, in the store.** Append the revision inside the store as a counter (`UPDATE … SET revision = revision + 1 RETURNING revision`) so the number is allocated by the same statement that writes the record, and add `CREATE UNIQUE INDEX … ON moderation_reviews(ref, revision)`. A colliding append then fails loudly instead of creating an ambiguous pair.
2. **Put the record identity in the link.** Sign `(seq | ref | revision | decision)` and have `decideReview` match the **seq** (the file's line number, the database's primary key) instead of the revision number. `seq` is unique by construction in both adapters.
3. Minimum viable: make `decideReview` refuse when **more than one** pending record shares `(ref, revision)` — a duplicate is a state the owner must see, not one to resolve silently.

Option 2 is the smallest change with the largest effect; option 1 removes the root cause.

---

### MAJOR-2 — The rate-limit key is client-chosen on the launch target: `cf-connecting-ip` is not set by Vercel

**Where:** `api/portal/auth.ts:159-173` (`platformAddress()` — `cf-connecting-ip` is consulted **first**, `:160-161`), used at `api/portal/auth.ts:290` and `:308-312` (`ip ? \`ip:${ip}\` : INSTANCE_BUCKET`).

**Observed behaviour (executed):**

```
PASS  P1a  CONTROL: a fixed cf-connecting-ip IS limited — 3/8 limited
PASS  P1b  PROBE: a ROTATING cf-connecting-ip is NOT limited — 0/8 limited (statuses 200,200,200,200,200,200,200,200)
```

The code's own justification (`auth.ts:149-150`) is *"cf-connecting-ip: Cloudflare sets it and overwrites whatever the client sent."* That is true **on Cloudflare** and false **on Vercel**, which is the launch target. Vercel overwrites `x-forwarded-for` (documented: *"Vercel populates the X-Forwarded-For header itself … and overwrites any incoming value to prevent IP spoofing"*), and exposes the client IP as `x-real-ip` / `x-vercel-forwarded-for`. It knows nothing about `cf-connecting-ip` — a Cloudflare-specific header that Vercel does not set and does not strip. A client sending `cf-connecting-ip: 198.51.100.7` reaches the handler verbatim, and because it is read **first**, it wins over the platform's own header.

**Why nobody noticed:** the repo's own E2 check (`backend-wave10-store-integrity-harness.mjs:1224-1255`) plays the platform by sending `x-forwarded-for: 203.0.113.${i}, 198.51.100.7` — a chain with a constant last hop. It never sends `cf-connecting-ip`. The check is therefore true for the header it tests and blind to the header the code prefers.

**Honest limits of this finding:** the *code* behaviour is proven (P1b); the *platform* half is documented, not observed here — no deploy was made (§5). The second branch (`x-forwarded-for`, last hop) **is** safe on Vercel, because Vercel replaces the header wholesale; P1c shows that a target which passes a client-supplied `x-forwarded-for` through unchanged would be bypassable, so that branch is only as safe as the platform in front of it. The claim in the wave-10 report and in `DEPLOY.md` — *"derived only from a platform-controlled address"* — is **false for the launch target as written**.

**Impact on the owner's launch:** `POST /api/portal/auth/request-link` is the only door into the portal, it is limited per IP, and it sends an e-mail for **any syntactically valid address** (no invite check at that point). Rotating `cf-connecting-ip` makes the limit unreachable → unlimited sign-in links per hour → **Resend quota burn** and **mail-bombing a client's inbox with sign-in links**, from anyone who can reach the endpoint. The durable counter's prune keeps the *table* bounded (F-5's prune is genuinely fine), but the *limit* is not enforced.

**Recommended fix:** on Vercel use Vercel's own header — `x-real-ip` or `x-vercel-forwarded-for` — and **treat `cf-connecting-ip` as trustworthy only when the deployment really is behind Cloudflare** (an explicit env flag such as `TRUST_CF_CONNECTING_IP=1`, or a Cloudflare-only deployment). Cheapest safe version: prefer `x-real-ip`/`x-vercel-forwarded-for` → `cf-connecting-ip` → last hop of `x-forwarded-for` → per-instance bucket, and **never** trust a header the platform does not set. Then add the rotating-`cf-connecting-ip` case to the E2 check so the gap cannot reopen.

---

### MINOR-1 — The staging swap is not crash-safe between the two renames

**Where:** `site/scripts/publish-testimonials.mjs:726-740`.

**Observed behaviour (executed, P4d):** the rollback only covers a **thrown** rename error (`:730-736`). A process **kill** between `renameSync(TESTIMONIALS_DIR, previous)` (`:727`) and `renameSync(staging, TESTIMONIALS_DIR)` (`:729`) leaves the published directory **missing** — the quotes survive only inside `.testimonials-previous-<pid>-<ts>`, which nothing ever restores:

```
PASS  P4d  exit 9; the published directory is GONE, left behind: .testimonials-previous-26908-1792634621240, .testimonials-publish-26908-1792634621240
```

**Impact:** a Vercel build killed in that microsecond window builds the site with **no testimonials** and publishes it. Mitigation: the next publish restores the quotes from the store (they are still there), and the leftover directories are *not* picked up by the content loader (`site/src/loaders/testimonials.ts:26-27` globs `./src/content/testimonials/**/*.md`, and the leftovers are siblings in `site/src/content/`). So the blast radius is one build, not permanent loss — but that build is the one that goes live.

**Fix:** at start-up, if `TESTIMONIALS_DIR` does not exist and a `.testimonials-previous-*` sibling does, restore the newest one before doing anything else (and say so in the log).

---

### MINOR-2 — The reachability probe checks existence, not writability, once the data dir exists

**Where:** `site/shared/server/portal-store-access.ts:284` (`if (fs.existsSync(root)) return;`) and `:221-237` (`canHoldStore` is only consulted when the root does **not** exist).

**Observed behaviour (executed, P6a):** file mode, the data directory exists but is empty → the probe passes → `GET /api/portal/projects` answers **200 with an empty list**. A deployment that carries `site/data/` but cannot **write** it (a read-only serverless filesystem) is therefore "reachable" by this probe and answers empty successes — the exact class F-3 claims to have closed.

**Impact:** limited, because the launch target is `PORTAL_STORE=libsql`, where the probe is a no-op (`:274`) and the store itself throws loudly (500 `code:'storage'`). This is the file adapter's dev/rollback path.

**Fix:** in `assertStoreReachable()` (no collection), also require `fs.accessSync(root, W_OK)` when the root exists.

---

### MINOR-3 — Two concurrent *first* submits publish the same client twice

**Where:** `api/portal/testimonials.ts:614` (`ref: existing?.ref || refId()`) and `site/scripts/publish-testimonials.mjs:137-146` (`latestByRef` de-duplicates **by ref only**).

**Observed behaviour (executed, P7):** two concurrent first submits each mint their own `ref` → two records → the publisher mirrors **both**:

```
PASS  P7  two refs, two published quotes for ONE client and project: rev_a99aa9a82122.md, rev_b97f5094dab2.md
```

**Impact:** the site can show two testimonials from the same client for the same project, and the owner moderates two separate entries. Low severity, but it is user-visible on the homepage.

**Fix:** de-duplicate the published set by `projectId`/`clientId` as well as by `ref` (`latestByRef`), or make the ref deterministic per project.

---

### MINOR-4 — The publisher's libSQL reader is a second implementation of the pipeline protocol, and it has already drifted

**Where:** `site/scripts/publish-testimonials.mjs:441-495` vs `site/shared/portal-store/libsql-transport.ts:226-320`.

Both follow the baton (that part is in step — P5a: 5 records over 5 pages, `written: 5`), but the publisher's copy has **no request timeout** (the transport has one, `libsql-transport.ts:230-232`) and **does not follow `base_url`** (the transport does, `:314-315`). A database that accepts the connection and never answers hangs the build instead of failing it.

**Fix:** give the publisher's `fetch` an `AbortSignal.timeout(...)` and handle `base_url` the way the transport does; or extract the pipeline client into a plain-JS module both can import (the publisher is plain JS on purpose — it runs in `prebuild`).

---

### MINOR-5 — The Turnstile `remoteip` comes from the same client-controlled header

**Where:** `api/contact.ts:289` — `headers['cf-connecting-ip'] || headers['x-forwarded-for']`.

On Vercel the `cf-connecting-ip` half is client-controlled, so the Turnstile siteverify call can carry a spoofed `remoteip`. Turnstile uses `remoteip` only as a hint (the challenge token is the decision), so the impact is low — but it is the same class as MAJOR-2 and should be fixed together with it.

---

### Observation (not a defect) — the Cloudflare moderation twin is file-based and can therefore never moderate

`site/functions/api/moderate/review.ts:102-112` reads the JSONL through `node:fs`; a Worker isolate has no `fs`, so `readReviews()` always throws `StoreUnreachableError` → the CF moderation endpoint answers **501 on workerd, always**. The CF tree is a stub by decision (per the team's own notes), but this belongs in the open question *"is Cloudflare still a target?"*: if it is, the owner cannot moderate a single quote from that tree.

---

## 3. The publisher-empty-store defect — confirmed, with siblings

**Confirmed by execution (P4b, wave-10 behaviour reconstructed in a temp copy):** a store that is **readable but empty**, with one published quote present:

```
PASS  P4b  exit 0, "written": 0, the published quote is GONE
PASS  P4c  exit 0, the published quote is GONE        (a MISSING store, wave-10 behaviour)
PASS  P4a  exit 1, the published quote survived       (the CURRENT file — wave 11 closed it)
```

So wave 10 as shipped let the build **delete every published client quote and report success**. Wave 11 has closed it: the current file refuses with exit 1 and leaves the published directory untouched (`assertStoreIsNotEmpty`, `publish-testimonials.mjs:282-292`, applied at `:686`), and a fresh install with nothing published still builds (harness A8/A11).

**Siblings of the same class** — "an empty, absent or partially-readable state is allowed to overwrite a non-empty one":

1. **The publisher's crash window** (MINOR-1) — the same published set is destroyed by a kill between the two renames, with no error at all.
2. **The publisher mirrors a *partial* set.** The store holds records, but **none of them is a `type:'review'` record** → `latestByRef` (`:137-146`) drops every one → the published set is emptied and the build succeeds. The Backend flagged this and left it alone (it is "rule 3: records → unchanged"). It is the same class and it is still open: the correct rule is *"the published set may only shrink when a specific record was revoked or withdrawn"*, not *"the store holds something"*.
3. **Two concurrent first submits** (MINOR-3) — the mirror is no longer one-quote-per-client.
4. **The store-level reachability probe** (MINOR-2) — the "store" state that the mirror trusts can be "present but unwritable", which the publisher's file path cannot detect either.

**The rule the publisher should enforce (as the brief states, and as wave 11 now implements):**
*zero records + published quotes present → FATAL (exit 1, the published directory untouched); zero records + nothing published → exit 0 (a fresh install must build); and — the gap that is still open — a published set may only shrink when a **specific** record was revoked or withdrawn, not because the store looks empty or partial.*

---

## 4. What the wave-10 report got right

Stated plainly, because the report was the only evidence and most of it holds:

- **F-1** is genuinely fixed for missing, unparsable and schema-less stores, on **both** the file path and the libSQL path (A1–A3) — and the publisher's DDL is byte-identical to `libsql-schema.ts` (A6), so the duplication cannot drift silently there.
- **F-2**'s store-side guard is real and works in both adapters (B3), and the mutation probes are non-vacuous (B4, A7, A12, C4, D2, E4, F3) — I re-ran the harness and **31/31** are green.
- **F-4** is real: the baton is followed to the end (D1), with a bounded page count (`MAX_PAGES = 100`, `libsql-transport.ts:223`) — **no infinite loop** — and the publisher's own reader follows it too.
- **F-5**'s prune is real and bounded: it runs inside the same round trip as the counter (`durable-rate-counter.ts:120-130`) and deletes **every** expired bucket, so the table holds only live buckets (E1/E4). The table cannot grow without bound.
- **F-6** is complete: the JSONL read is gone and both gates precede the 501.
- **F-3**'s *scope* is right: asking "can this deployment hold a store?" (rather than "does each collection file exist?") is the correct question — the per-collection reading broke the owner's first sign-in and the empty-project case, and the deviation is documented in the code.

---

## 5. UNVERIFIED — plainly, and without softening

- **No real Turso database was contacted.** The libSQL half of every check ran against a **real SQLite engine** (Python's `sqlite3`) behind the repo's mock pipeline server, speaking the real HTTP v2 wire protocol. That proves the SQL and the protocol handling; it does **not** prove Turso's service behaves the same, and nothing here says it does.
- **No Vercel router was booted and no workerd was booted.** No deployment, no preview, no production. Every platform-level statement — Vercel's `x-forwarded-for` overwrite, its ignorance of `cf-connecting-ip`, the read-only function filesystem, the 12-function Hobby cap — remains unproven *in this repo*. Where I relied on Vercel's documented behaviour (MAJOR-2) I cited the documentation and labelled it as such.
- **No live mail was sent.** The magic-link path was exercised with no mail provider configured; the notification code path was never executed against Resend.
- **The Astro build was not re-run by me.** The publisher's effect on the *rendered* site (the content loader, the cache clear, the homepage testimonials) is not verified here.
- **The dev server on port 4321 was not touched** and was not restarted, so anything running there serves a pre-wave-10 bundle.
- **My probes exercise the file adapter for the endpoint-level race (P3a) and both adapters at the store level (P2a/P2b).** The end-to-end race was **not** reproduced over a real libSQL round trip — the collision is adapter-independent (P2b proves the libSQL store behaves the same), but the full HTTP path on libSQL was not executed concurrently.
- **The wave-11 publisher fix itself was not re-reviewed.** It landed before this audit started; I verified it refuses an empty store (P4a) and that the malformed-line block QA's probe anchors on is untouched, but I did not audit wave 11 as a whole.
- **No git command that mutates state was run.** No reset, clean, checkout, stash, add or commit. The tree was 72 changed paths before and after; `git log` still shows `a882606` as HEAD.

---

## 6. Recommended order of work

1. **MAJOR-1** — the moderation link must identify a *record*, not a revision number. Without this, the one-click approve can publish text the owner never saw, and no amount of extra testing around F-2 will catch it.
2. **MAJOR-2** — the rate-limit key must come from a header the platform actually sets (`x-real-ip` on Vercel), and the rotating-`cf-connecting-ip` case must be added to the E2 check so the gap cannot reopen silently.
3. **MINOR-2** and **MINOR-5** — small, same area as MAJOR-2.
4. **MINOR-1** — one start-up restore in the publisher.
5. **MINOR-3 / MINOR-4** and the publisher's *"records → unchanged"* rule (sibling 2 in §3) — product decisions for the owner, not defects to guess at.

**Files I created:** this report only. `C:\Users\Kalch\Documents\IXI\audit-wave10-store-integrity-2026-10-22.md`
**Probe harness (disposable, outside the repo):** `C:\Users\Kalch\AppData\Local\Temp\opencode\audit-wave10\probe.mjs` — `node probe.mjs`; sandbox and per-probe JSON at `…\audit-wave10\2026-10-22T02-03-37-678Z\`.
