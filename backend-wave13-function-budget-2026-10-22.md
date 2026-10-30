# Backend — wave 13: the function-budget refactor

- **Author:** Backend Developer (Senior Backend Engineer)
- **Date:** 2026-10-22
- **Repo:** `C:\Users\Kalch\Documents\IXI` (branch `main`, checkpoint `a882606`, shared dirty tree — no git write command was run)
- **Brief:** `spec/proposal-wave7-design-2026-10-21.md` §2 (the design), wave 13 item [1]
- **Verdict:** **DONE** — `api/` holds **7** `.ts` files (budget 12), all 16 public URLs intact, every gate green, **13 QA suites need a re-pin** (the list is below, with the exact strings).

---

## 1. What the wave was for

Vercel builds **one function per file under `api/`**, and the Hobby plan caps a deployment at
**twelve**. `api/` held **19** files (17 routes + 2 dead utilities), so the portal could not be
deployed at all. The design (Architect §2) folds the portal family into ONE entry point, the
owner family into another, and moves the handler bodies out of `api/` where they are modules
rather than functions.

### The result

```
api/  (7 files = 7 Vercel functions, budget 12)
  api/contact.ts                  -> /api/contact                  (own file, unchanged)
  api/moderate/review.ts          -> /api/moderate/review          (own file, unchanged)
  api/portal.ts                   -> the nine /api/portal/* URLs   (NEW entry point)
  api/admin.ts                    -> the two  /api/admin/*  URLs   (NEW entry point)
  api/portal/auth/request-link.ts -> /api/portal/auth/request-link (own file)
  api/portal/auth/verify.ts       -> /api/portal/auth/verify       (own file)
  api/portal/auth/logout.ts       -> /api/portal/auth/logout       (own file)
```

---

## 2. What landed (file:line)

### 2.1 The route table — one source of truth

| File | Lines | What it is |
|---|---|---|
| `site/shared/portal-routes.json` | 82 | The machine-readable table: two families (nine + two routes), five standalone URLs, the handler-module map. |
| `site/shared/portal-routes.ts` | 55 | The TypeScript view (a JSON import, so the table is **bundled at build time** — nothing is read from the read-only filesystem at runtime). |
| `site/shared/portal-router.ts` | 177 | The resolver: a **pure function over strings**, no `node:` imports, no platform. |

The resolver's rules, in order (`site/shared/portal-router.ts:112-146`):

1. the request **path** resolves in the table → serve it (the direct case: the dev server, `vercel dev`);
2. the **carrier** (`__imk_route`, or the `x-imk-route` header) resolves → serve it (the rewrite case);
3. the path **is** the entry prefix and nothing resolved → `route-resolution` → **500** (loud, never a silent 404);
4. anything else → `not-found` → 404.

### 2.2 The two entry points

| File | Lines | What it does |
|---|---|---|
| `api/portal.ts` | 160 | Resolves the route, rebuilds `req.url` (path **and** query), calls the handler. |
| `api/admin.ts` | 136 | The same for the owner family. The two tables are **disjoint**: a carrier cannot cross the family boundary (`api/portal.ts:118-127`). |

`rebuildRequestUrl` (`site/shared/portal-router.ts:154-176`) sets the path back to the original
public path, keeps the rest of the query string and drops the carrier.

### 2.3 The rewrites

`vercel.json:9-45` — eleven rules, one per family route:

```json
{ "source": "/api/portal/comments", "destination": "/api/portal?__imk_route=/api/portal/comments" }
```

**The sign-in door is not rewritten.** `/api/portal/auth/verify` carries a query string
(`?token=`) and is the most security-sensitive surface in the product, so it keeps a function file
of its own and no rewrite can touch it. `/api/moderate/review` is left alone for the same reason.

### 2.4 The moves (bodies moved byte-for-byte)

| From | To | Lines |
|---|---|---|
| `api/portal/auth.ts` | `site/shared/portal-handlers/portal-auth.ts` | 23 881 B |
| `api/portal/comments.ts` | `site/shared/portal-handlers/portal-comments.ts` | 8 463 B |
| `api/portal/invites.ts` | `site/shared/portal-handlers/portal-invites.ts` | 11 249 B |
| `api/portal/plan-items.ts` | `site/shared/portal-handlers/portal-plan-items.ts` | 13 891 B |
| `api/portal/projects.ts` | `site/shared/portal-handlers/portal-projects.ts` | 13 434 B |
| `api/portal/session.ts` | `site/shared/portal-handlers/portal-session.ts` | 7 500 B |
| `api/portal/testimonials.ts` | `site/shared/portal-handlers/portal-testimonials.ts` | 27 414 B |
| `api/portal/updates.ts` | `site/shared/portal-handlers/portal-updates.ts` | 8 404 B |
| `api/admin/session.ts` | `site/shared/portal-handlers/admin-session.ts` | 5 267 B |
| `api/admin/reviews.ts` | `site/shared/portal-handlers/admin-reviews.ts` | 11 596 B |
| `api/lib/notifications.ts` | `site/shared/server/notifications.ts` | 8 852 B |
| `api/lib/rate-limit.ts` | `site/shared/server/rate-limit.ts` | 18 132 B |

**Deleted** (superseded by the entry points): `api/portal/projects/[id].ts`,
`api/portal/plan-items/[id].ts`. The by-id routes are served by `api/portal.ts` through the
route table's `*` patterns.

The only behavioural edit inside a moved body: the unused `projectPath()` helper was removed from
`portal-projects.ts` (it was dead code; keeping it would have added a `ts(6133)` hint, because
`astro check` now scans `site/shared/**`).

### 2.5 The scripts

| File | What changed |
|---|---|
| `site/scripts/check-api-routes.mjs` (422 lines) | Reads the route table; a Vercel URL is served **either** by its own file **or** by a table entry (entry file + handler module must exist). Adds the **function-budget check** (≤ 12 files under `api/`) and the **rewrite/table agreement check** (every family route has a rewrite, every rewrite has a route, the carrier is carried). |
| `site/scripts/dev-portal.js` (247 lines) | Serves the **same table** instead of matching by prefix; a family URL goes to its entry point and the resolver decides. Added `DEV_PORT` (site/.env pins 4321, which is taken). |
| `site/scripts/api-index.ts` (30 lines) | Bundles the two entry points and the standalone handlers. |

### 2.6 The Cloudflare tree

**Not changed** (design §2.10): Cloudflare Pages Functions are not function-capped, so the CF tree
keeps one file per URL. Only comments that named a moved path were refreshed.

---

## 3. The gates (all executed by me)

| Gate | Result |
|---|---|
| `npm run typecheck:api` | **exit 0** |
| `npm run check:routes` | **exit 0** — 16 routes / 0 missing; `api/` holds **7** files; 11 rewrites agree with the table |
| `npm run test:store` | **72 / 72** (unchanged — the store contract did not change) |
| `npm run build` (site) | **exit 0** — 23 pages |
| `astro check` | **0 errors / 0 warnings / 11 hints** (the baseline) |
| `site/data` | **untouched** — `reviews.jsonl` 0 bytes, no `site/data/portal/` |
| no git write command | confirmed |

### 3.1 The repo-root harnesses (mine) — 10/10 green, **265 checks**

| Harness | Result |
|---|---|
| `backend-f1-magic-token-harness.mjs` | 22 / 22 |
| `backend-review-fixes-harness.mjs` | 23 / 23 |
| `backend-wave6-harness.mjs` | 24 / 24 |
| `backend-wave8-harness.mjs` | 35 / 35 |
| `backend-wave8-moderation-m1-harness.mjs` | 11 / 11 |
| `backend-wave8-session-endpoint-harness.mjs` | 57 / 57 |
| `backend-wave9-store-wiring-harness.mjs` | 13 / 13 |
| `backend-wave9b-admin-inbox-store-harness.mjs` | 16 / 16 |
| `backend-wave10-store-integrity-harness.mjs` | **42 / 42** (41 → 42: G1 re-pinned, G1m added) |
| `backend-wave13-function-budget-harness.mjs` | **22 / 22** (NEW) |

### 3.2 The new harness — `backend-wave13-function-budget-harness.mjs` (821 lines)

| Group | Checks | What it proves |
|---|---|---|
| **A** the budget | A1–A4 | `api/` holds 7 files and every one is a real function (a default export — a module without one is a **dead** function that still costs a slot); the dead utilities are gone from `api/`; the table and `vercel.json` agree rule for rule; every public URL is in the table. |
| **B** the resolver | B1–B7 | The direct path resolves; the carrier resolves; an unknown path is `not-found`; the bare entry point is `route-resolution`; **one** dynamic segment resolves and **two** do not; a carrier cannot name another family's route. |
| **C** the entry points | C1–C7 | The direct path and the carrier answer the **same** (the rewrite is invisible to the handler); the **query string survives** the rewrite (a spy handler saw `/api/portal/testimonials?projectId=prj_1`); the bare entry point is a loud 500; an unknown path is 404; a carrier cannot cross the family; the owner gate ran; a wrong method is answered by the **handler**, not the router. |
| **D** the mutation probes | D1–D4 | Each fix reverted **in a copy**: without the route-resolution branch the bare entry point answers 404 (not 500); without the carrier branch the rewrite case 500s (not 401); without the query rebuild the handler loses `?projectId=`; a dead module under `api/` in a copy is caught. The control stays green in every case. |

Every check runs in a **child process**, JSON over stdin/stdout, **no port bound**. The repository
is never modified: the mutants live in a temp sandbox.

### 3.3 The dev server (executed, port 4399 — 4321 was left alone)

| Request | Answer |
|---|---|
| `GET /api/portal/projects` | 401 `{code:'unauthorized'}` (the projects handler ran) |
| `GET /api/portal?__imk_route=%2Fapi%2Fportal%2Fprojects` | 401 (the same handler) |
| `GET /api/portal` | **500** `{code:'route-resolution'}` |
| `GET /api/portal/nope` | 404 `{code:'not-found'}` |
| `GET /api/admin?__imk_route=%2Fapi%2Fadmin%2Fsession` | 401 `{code:'unauthorized'}` (the owner gate ran) |
| `GET /api/contact` | 405 (a GET on the contact endpoint) |
| `GET /` | 200 (the static site still serves) |

### 3.4 The QA runner — `site/qa/artifacts/qa-full-run-2026-10-22-072005.txt`

**13 of 15 suites exit 1 — every one of them a path pin, plus one that my change caused.**
`check:routes` is the only green suite (exit 0). The full re-pin list is §5.

---

## 4. The ONE QA failure my change caused directly

**`site/qa/qa-wave9-store-queue.mjs:659`** — the legacy sandbox writes the frozen
`api/lib/jsonl.ts` and `api/lib/notifications.ts` copies into the scratch tree at
`<legacy>/api/lib/<file>`. Until wave 13 that directory existed (the two utilities were still
under `api/lib/`), so `writeFileSync` worked. `api/lib/` is now gone, so the write fails with
`ENOENT`.

**The fix is one line in QA's file** (I did not touch it):

```js
// qa-wave9-store-queue.mjs:657-659
const productCopy = path.join(legacyRoot, 'api', 'lib', lib.file);
if (fs.existsSync(productCopy)) fs.rmSync(productCopy, { force: true });
fs.mkdirSync(path.dirname(productCopy), { recursive: true });   // <-- ADD THIS
fs.writeFileSync(productCopy, frozen.source, 'utf8');
```

Everything else in that suite is unaffected: the frozen sources come from `git show
a4b10a8:api/lib/...`, which still resolves.

---

## 5. The QA re-pin list — the EXACT strings

**Rule for every suite:** the handler modules are no longer under `api/`. A suite that bundles
from `API_DIR` must bundle from the **repo root** (or add a second root for
`site/shared/portal-handlers/`).

### 5.1 The bundle entries (the cause of 9 of the 13 reds)

| Suite | Line | Old literal | New literal |
|---|---|---|---|
| `qa-testimonials.mjs` | 108 | `${REPO_FWD}/api/portal/auth.ts` | `${REPO_FWD}/site/shared/portal-handlers/portal-auth.ts` |
| | 109 | `${REPO_FWD}/api/portal/projects.ts` | `…/site/shared/portal-handlers/portal-projects.ts` |
| | 110 | `${REPO_FWD}/api/portal/invites.ts` | `…/site/shared/portal-handlers/portal-invites.ts` |
| | 111 | `${REPO_FWD}/api/portal/testimonials.ts` | `…/site/shared/portal-handlers/portal-testimonials.ts` |
| | 114 | `${REPO_FWD}/api/portal/session.ts` | `…/site/shared/portal-handlers/portal-session.ts` |
| | 112, 113 | `api/contact.ts`, `api/moderate/review.ts` | **unchanged** |
| `qa-backend-hardening.mjs` | 126–129 | `${REPO_FWD}/api/portal/{auth,projects,invites,testimonials}.ts` | `…/site/shared/portal-handlers/portal-{auth,projects,invites,testimonials}.ts` |
| | 130 | `api/moderate/review.ts` | **unchanged** |
| | 910–912 | `api/portal/auth/{request-link,verify,logout}.ts` | **unchanged** (the three shims still exist) |
| | 913–914 | `api/portal/projects/[id].ts`, `api/portal/plan-items/[id].ts` | **DELETED** — the by-id routes are served by `api/portal.ts` now. Re-pin the check to the route table: `/api/portal/projects/*` → `portal-projects` and `/api/portal/plan-items/*` → `portal-plan-items`. |
| `qa-wave2-independent.mjs` | 187–190 | `${API_FWD}/portal/{auth,invites,projects,testimonials}.ts` | `…/site/shared/portal-handlers/portal-{auth,invites,projects,testimonials}.ts` — **`API_FWD` must become the repo root**, the handlers are no longer under `api/` |
| | 191 | `${API_FWD}/moderate/review.ts` | **unchanged** |
| `qa-wave3-independent.mjs` | `entry-api` 1–4, 6 | `api/portal/{auth,invites,projects,testimonials}.ts`, `api/lib/rate-limit.ts` | `…/site/shared/portal-handlers/portal-*.ts`, `…/site/shared/server/rate-limit.ts` |
| `qa-wave4-independent.mjs` | 176–180, 181 | `${API_FWD}/portal/{auth,invites,projects,plan-items}.ts`, `${API_FWD}/lib/rate-limit.ts` | `…/site/shared/portal-handlers/portal-*.ts`, `…/site/shared/server/rate-limit.ts` — same `API_FWD` caveat |
| `qa-wave5-independent.mjs` | 571–573, 577–578, 584 | `./portal/{auth,projects,comments}.ts`, `./lib/rate-limit.ts` (relative to `API_DIR`) | `../shared/portal-handlers/portal-*.ts`, `../shared/server/rate-limit.ts` — **or point `dir` at the repo root** |
| `qa-admin-independent.mjs` | 606–609 | `./admin/{session,reviews}.ts`, `./portal/{auth,projects}.ts` | `../shared/portal-handlers/admin-{session,reviews}.ts`, `../shared/portal-handlers/portal-{auth,projects}.ts` |
| `qa-rate-limit.mjs` | 86 | `${REPO_FWD}/api/lib/rate-limit.ts` | `${REPO_FWD}/site/shared/server/rate-limit.ts` |
| `qa-cf-parity.mjs` | 109 | `${REPO_FWD}/api/lib/notifications.ts` | `${REPO_FWD}/site/shared/server/notifications.ts` |
| `qa-wave9-store-independent.mjs` | 1323 | `./lib/rate-limit.ts` (relative to `API_DIR`) | `../server/rate-limit.ts` (relative to `site/shared/`), or point the root at `site/shared` |

### 5.2 The path assertions (they will fail once the bundles build)

| Suite | Line | Old | New |
|---|---|---|---|
| `qa-wave4-independent.mjs` | 1224–1228 (check **G2**) | requires `api/portal/projects/[id].ts` and `api/portal/plan-items/[id].ts` to exist | **deleted** — the two by-id URLs are served through the route table. The three auth shims still exist. |
| `qa-wave3-independent.mjs` | 1018–1025 (check **D2**) | requires five route files in **both** trees | the three auth shims in both trees; the two by-id routes are now the route table's `*` patterns on the Vercel side. The "no catch-all" half of D2 **stays in force** — this design introduces none. |
| `qa-wave5-independent.mjs` | 983–985 (check **A8**) | reads `path.join(API_DIR, 'portal', 'session.ts')` and asserts it re-exports `shared/server/portal-session.js` | `path.join(REPO, 'site', 'shared', 'portal-handlers', 'portal-session.ts')`; the re-export text is now `from '../server/portal-session.js'`, so the regex must become `/\.\.\/server\/portal-session\.js/` (or `server/portal-session\.js`) |
| `qa-wave9-store-queue.mjs` | 657–659 | see §4 | one added `mkdirSync` |

### 5.3 The mutation anchors

| Suite | Anchor | Where it is now |
|---|---|---|
| `qa-mutation-probe.mjs:139` | `if (currentRevision !== revision) {` | **`api/moderate/review.ts:352`** — `if (currentRevision !== revision \|\| identityStale) {`. **This is the wave-12 change, not mine** — the probe was already red before wave 13. |
| `qa-mutation-probe.mjs` / `qa-anchor-nonvacuity.mjs` | the store's identity scope | `site/shared/portal-store/file-adapter.ts` + `libsql-adapter.ts`, the wave-12 anchor. Unchanged by wave 13. |
| `qa-anchor-nonvacuity.mjs` | the P2 publisher anchor | the publisher's malformed-line block — **byte-identical**, wave 11 did not touch it. |

### 5.4 The three reds that are NOT mine

The wave-12 report already named them: `qa-mutation-probe.mjs` (the P1 anchor above),
`qa-anchor-nonvacuity.mjs` (same anchor, through the prover) and — for the wave-12 record —
`qa-wave2-independent.mjs`. They were red **before** wave 13 started; wave 13 adds no new class
of failure beyond the path pins.

---

## 6. Behavioural differences (reported, not hidden)

1. **The query string is re-serialised by the platform.** The rewrite destination carries
   `__imk_route`, and the platform merges the destination's query with the original request's
   query. The original parameters are preserved and win on a name collision
   (Vercel's routing: `Object.assign(destQuery, reqQuery)` — the query of the original request is
   merged **over** the destination's). The only visible effect is the encoding: a value that
   arrived as `+` comes back as `%20`. Every parameter the product uses (`projectId`,
   `planItemId`) is alphanumeric, so nothing changes for the product.
2. **A path with an encoded slash in the id** (`/api/portal/projects/a%2Fb`) now answers
   `404 {code:'not-found'}` from the resolver instead of reaching the handler and answering
   `404 {code:'not-found'}` there. Same status, different body. Ids are server-generated hex, so
   this is not reachable in practice.
3. **`/api/portal` and `/api/admin` are now real URLs** (they are the entry points). They answer
   `500 {code:'route-resolution'}` — the loud answer the design asks for. Nothing links to them.
4. **The dev server answers the family's own 404** (`{code:'not-found'}`) where the deployed
   target answers Vercel's own 404 page for a path outside the rewrite table. Both are 404.
5. **The bare `/api/portal/auth` path** answers `404 {code:'not-found'}` from the entry point
   (there is no function file for it any more). It answered 404 before as well.

---

## 7. What DevOps must do (not my files)

1. **DEPLOY.md**: the function budget is now **7** files = 7 functions (7 routes + 0 dead
   utilities — every file under `api/` is a real function). The "3 shared utilities under api/"
   paragraph is **obsolete**: `api/lib/` does not exist any more. `api/lib/notifications.ts` and
   `api/lib/rate-limit.ts` are now `site/shared/server/notifications.ts` and
   `site/shared/server/rate-limit.ts` — modules, not functions.
2. **DEPLOY.md**: the new routing must be documented — two entry points, the route table
   (`site/shared/portal-routes.json`) and the eleven rewrites in `vercel.json`. The sign-in door
   (`/api/portal/auth/*`) and `/api/moderate/review` are **not** rewritten and keep their own
   function files.
3. **DEPLOY.md / site/.env.example**: `TRUST_CF_CONNECTING_IP` is still undocumented (wave 12
   asked for it); nothing in wave 13 changes it.
4. **The launch checklist**: the portal now fits the Hobby budget (7 ≤ 12), but the rewrite
   behaviour has **never been observed on Vercel** (see §8).

---

## 8. UNVERIFIED — plainly

- **No Vercel router was booted.** The rewrite's behaviour is taken from Vercel's own routing
  implementation (`vercel/vercel`, `packages/cli/src/util/dev/router.ts`: the destination's query
  is merged with the original request's, the original winning) and from Vercel's documentation —
  **not from an observation of a deployed preview**. The §2.7 "preview test" the Architect asked
  for is still outstanding; it needs one preview deployment.
- **No workerd / no Cloudflare runtime was booted.** The CF tree is unchanged, but its parity with
  the Vercel tree has not been re-executed (QA's `qa-cf-parity.mjs` is red on a path pin).
- **No real Turso was contacted.** The libSQL adapter is untouched by this wave; the store
  contract is green offline against a real SQLite engine over the real wire protocol.
- **Nothing was deployed.** No commit, no preview, no production deploy.
- **No live mail.** The moderation link and the magic link were not sent.
- **The QA suites are not green** — 13 of 15 exit 1 on the path pins of §5. The product gates
  (typecheck, routes, store, build, astro check) and all ten repo-root harnesses are green, and
  the new wave-13 harness proves the refactor by execution, but **the independent QA re-pin has
  not happened yet**.
- **The `astro check` hint baseline** is 11, unchanged. It was 12 for one build: the moved
  `projectPath()` helper became visible to `astro check` when it moved under `site/shared/`; the
  dead helper was removed (a comment-only change to the handler's behaviour — it was never
  called).
- The transcript of the QA run pins the tree as of **07:20:05**, not a commit.

---

## 9. One thing I got wrong on the way, and how it was caught

While moving the handler bodies I ran them through PowerShell's `Get-Content`/`Set-Content`
round trip, which re-encoded the files with the ANSI code page and added a BOM. I caught it with
a byte-level comparison against `git show`, **repaired the files with the exact inverse of the
transformation**, and **proved the repair was lossless** (the re-corrupted bytes are identical to
the corrupted ones; no undefined byte of the code page and no replacement character anywhere).
The ten moved files are byte-identical to their originals apart from the intended import-path
edits, LF, no BOM. The lesson is recorded here because the same trap is one `Get-Content` away
from the next agent.

---

## 10. Files changed in this wave

**New (13):** `api/portal.ts`, `api/admin.ts`, `site/shared/portal-router.ts`,
`site/shared/portal-routes.ts`, `site/shared/portal-routes.json`,
`site/shared/portal-handlers/{portal-auth,portal-comments,portal-invites,portal-plan-items,portal-projects,portal-session,portal-testimonials,portal-updates,admin-session,admin-reviews}.ts`,
`backend-wave13-function-budget-harness.mjs`.

**Moved (12):** the twelve handler/utility modules of §2.4.

**Deleted (2):** `api/portal/projects/[id].ts`, `api/portal/plan-items/[id].ts`.

**Rewritten (3):** `site/scripts/check-api-routes.mjs`, `site/scripts/dev-portal.js`,
`site/scripts/api-index.ts`.

**Edited:** `vercel.json` (the rewrites), `api/portal/auth/{request-link,verify,logout}.ts` (the
three shims now re-export `site/shared/portal-handlers/portal-auth.ts`),
`api/moderate/review.ts` (the notifications import),
`site/shared/server/{notifications,rate-limit}.ts` (the imports),
`site/functions/**` (comments only), the ten repo-root harnesses (the path pins + the wave-10
G-group re-pin).

**Untouched:** `site/qa/**` (QA's), `DEPLOY.md` and `site/.env.example` (DevOps's),
`site/src/**` (the Frontend's — two comments there still name the old handler paths),
`site/data/**`, `spec/**`.
