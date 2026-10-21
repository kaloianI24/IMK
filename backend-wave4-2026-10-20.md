# Backend wave 4 — the deploy route table, the deploy root, the concurrent counter

**Status: DONE** — the four items QA's wave-3 re-run left open (D-1, D-2, F-1, F-2) are
closed and verified. **F-1 was bigger than it was reported.**

Repo: `C:\Users\Kalch\Documents\IXI` · Site: `site/` · Vercel tree: `api/` · Cloudflare
tree: `site/functions/` · Date: 2026-10-20

---

## 1. What QA found, and what was actually true

| | QA's finding | My verdict after reading the code |
|---|---|---|
| **D-1** MAJOR | `site/functions/api/moderate/review.ts:47` swallows a corrupt store → `404 review not found` while the Vercel tree answers `500 storage` | **confirmed.** It was the last lenient JSONL reader in the repo. |
| **D-2** MINOR | the file-backed counter loses counts with two writers (75 of 200 buckets lost, 4/4 rounds) | **confirmed**, and the module's own comment promised the opposite ("shared by every process on the same host"). |
| **F-1** MAJOR | the sign-in door is unreachable on the launch target: Vercel serves a function at its file path | **confirmed — and wider than reported.** Not only `/api/portal/auth/*`, also **`/api/portal/projects/<id>`** and **`/api/portal/plan-items/<id>`**: the owner's project and plan-item edits answered 404 in production too. |
| **F-2** MINOR | the CI "static invariant check" can never pass (working directory `site`, repo-root paths) | **confirmed.** CI was red on `main` for a reason unrelated to the code. |

---

## 2. The fixes

### 2.1 F-1 — the route table is a file contract (both trees)

A function is served at its **file path** on both targets. Every path the client
calls now has a file behind it, in **both** trees. Each route file re-exports the
handler that already implements the route — one implementation, one behaviour:

| URL the client calls | Vercel | Cloudflare |
|---|---|---|
| `POST /api/portal/auth/request-link` | `api/portal/auth/request-link.ts` | `site/functions/api/portal/auth/request-link.ts` |
| `GET /api/portal/auth/verify` | `api/portal/auth/verify.ts` | `site/functions/api/portal/auth/verify.ts` |
| `POST /api/portal/auth/logout` | `api/portal/auth/logout.ts` | `site/functions/api/portal/auth/logout.ts` |
| `GET|PATCH /api/portal/projects/<id>` | `api/portal/projects/[id].ts` | `site/functions/api/portal/projects/[id].ts` |
| `GET|PATCH /api/portal/plan-items/<id>` | `api/portal/plan-items/[id].ts` | `site/functions/api/portal/plan-items/[id].ts` |

The by-id handlers accept the id from the path **or** from the route parameter
(`req.query.id`), so they do not depend on which convention the host uses.

**Why it was invisible for three QA waves:** the local dev server
(`site/scripts/dev-portal.js`) matches handlers by **prefix**, so
`/api/portal/auth/request-link` reached the handler locally while the deployed
target answered 404. That is now a machine check, not a habit:

```
site/scripts/check-api-routes.mjs        (npm run check:routes)
```

It reads every `/api` path the client calls and every `/api` path the server
names, and fails when a path has no function file in either tree — naming the
source file. It runs in CI. **Proven non-vacuous:** removing one route file makes
it fail (verified by moving `api/portal/auth/request-link.ts` away, re-running,
restoring).

### 2.2 F-1, part two — the Vercel project root

The `api/` tree lives at the **repository root**, outside `site/`. A Vercel project
rooted at `site/` deploys **no functions at all**. The repository now says so:

- `vercel.json` (repo root): `"framework": null`, `"installCommand": "cd site && npm ci"`,
  `"buildCommand": "cd site && npm run build"`, `"outputDirectory": "site/dist"`;
- a root `package.json` + `package-lock.json` (dependency-free) so the repo root is a
  valid project (`npm ci` at the root works);
- the CI deploy job runs from the repo root;
- **`DEPLOY.md`** (new) documents the project settings, the environment variables and
  the known blockers.

**One setting cannot be committed: "Root Directory = the repository root" in the
Vercel dashboard. That is DevOps's to set** — see the assignment below.

### 2.3 D-1 — the Cloudflare moderation store fails closed

`site/functions/api/moderate/review.ts` now reads through the **shared strict
parser** (`parseJsonlStrict`):

- a store that cannot be **parsed** → `500 { code: 'storage' }` (the same answer the
  Vercel tree gives), with the file and line in the log;
- a store that cannot be **reached** (the edge has no filesystem) →
  `501 { code: 'unimplemented' }` — never `404 review not found`, which would tell
  the owner their pending quote is gone;
- a write that fails → `500 { code: 'storage' }`. A decision that was **not stored**
  is never answered with "approved".

### 2.4 D-2 — the file-backed counter is safe under concurrency

The `file` backend's read-modify-write now runs under an **exclusive lock file**
(`open(..., 'wx')` is atomic on POSIX and Windows): one writer at a time, a lock
left behind by a killed process is broken after 30s, and a lock that cannot be
taken **degrades to the in-memory counter** — the limiter still never fails a
request. Keys stay SHA-256 hashed before they reach the file.

### 2.5 F-2 — CI

- the invariant check now uses paths relative to `site/` (`../api/contact.ts`,
  `functions/api/contact.ts`) and also asserts `../vercel.json` exists;
- two new steps: `npm run check:routes` and `npm run typecheck:api`.

---

## 3. Checks — executed, with real output

```
qa-testimonials.mjs           81/81   (QA)          qa-rate-limit.mjs            8/8   (Backend)
qa-testimonials-build.mjs     14/14   (QA)          qa-cf-parity.mjs            10/10   (Backend)
qa-backend-hardening.mjs      20/20   (Backend)     qa-wave2-independent.mjs    28/28   (QA)
qa-wave3-independent.mjs      19/20   (QA)          qa-mutation-probe.mjs    4/4 probes
```

**185 checks, 1 failing — and the one failure is QA's own D2**, which asserts the
F-1 defect is *still present* (`assert(!fs.existsSync(api/portal/auth/))`). The
defect is fixed, so the check must be inverted by QA. It is their file and their
call; I did not touch it.

The two checks that matter most here are **QA's own**, and they now pass:

- **B5** "a malformed moderation store must NOT read as 'review not found' on
  Cloudflare" → `status=500 code=storage` (before the fix: 404);
- **C2** "two serverless functions writing the SAME counter file do not lose counts"
  → 4 concurrent rounds, no lost bucket (before the fix: 75 of 200 lost).

Gates:

```
npm run check:routes    13 routes, 0 missing, both trees       exit 0
npm run typecheck:api   api + functions + shared               exit 0
npm run test:store      22/22                                  exit 0
npm run build           22 pages                               exit 0
npm run check           0 errors, 0 warnings, 13 hints
```

The hint count moved 8 → 13; **none of the 13 is in a file I touched** — 6 are in
QA's own suite files (`site/qa/qa-wave3-independent.mjs` ×5,
`site/qa/qa-testimonials-build.mjs` ×1) and 7 are pre-existing.

Housekeeping: `site/data/moderation/reviews.jsonl` is still **0 bytes**
(SHA-256 `E3B0C442…B855`, mtime unchanged), `site/data/portal/` still does not
exist, every run used an isolated sandbox on its own port. The dev server on 4321
was **restarted** (pid 29204) so the team exercises the current code — it answers
`200` on `/api/portal/auth/request-link` and `404` on the bare `/api/portal/auth`.

---

## 4. Files changed

**New (Vercel):** `api/portal/auth/request-link.ts`, `api/portal/auth/verify.ts`,
`api/portal/auth/logout.ts`, `api/portal/projects/[id].ts`,
`api/portal/plan-items/[id].ts`.
**New (Cloudflare):** the same five under `site/functions/api/portal/…`.
**New (repo):** `package.json`, `package-lock.json`, `DEPLOY.md`.
**New (site):** `site/scripts/check-api-routes.mjs`.

**Changed:** `api/lib/rate-limit.ts` (the lock), `api/portal/projects.ts`,
`api/portal/plan-items.ts` (the id fallback), `site/functions/api/moderate/review.ts`
(strict reader + fail-closed answers), `vercel.json`, `package.json`,
`.github/workflows/ci.yml`, `site/package.json`, `spec/08-portal-mvp.md` (§4.8 +
Revision 5), `site/qa/qa-backend-hardening.mjs` (group N),
`site/qa/qa-cf-parity.mjs` (C4/C5).

**Deliberately NOT changed:** `site/qa/qa-wave3-independent.mjs` (QA's file — its D2
must be inverted by QA, not by me), and every `site/src/**` file (Frontend's).

---

## 5. Not verified — stated, not assumed

1. **The Vercel router was never booted.** There is no token on this machine, so
   `vercel build` cannot run. The route shape rests on Vercel's documented rule
   (a function is served at its file path; `[param]` is a dynamic segment) and on
   the repo layout. The machine check enforces the layout; it cannot boot Vercel.
2. **The Cloudflare runtime was still never booted** (no wrangler/workerd here).
   The CF claims are about the CF **code path**, executed in Node's Web-standard
   runtime.
3. **The portal still cannot run on Vercel.** The store is a file and a Vercel
   function's filesystem is read-only (only `/tmp` is writable). F-1 was the route
   table; **T4 (Turso/libSQL) is the store**. Both are needed, and the storage
   decision is still the one thing only the owner can make.
4. The rate limit is per instance on Vercel until T4 gives it a shared backend.
5. No browser run, no live Resend/Turnstile, TTL paths at their boundaries only.

---

## 6. Spec

`spec/08-portal-mvp.md` §4.8 is the contract for this wave (the route table, the
deploy root, the lock, the fail-closed store) and §10.4 Revision 5 lists every file
read and changed. §4.8 is the diff for @Code Reviewer to re-audit.
