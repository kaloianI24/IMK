# Wave 15 audit brief (from @Manager) — read this file first

REPO: `C:\Users\Kalch\Documents\IXI` (branchless, permanently dirty shared tree — never run a git write command: no reset/clean/checkout/stash. READ-ONLY: your report is the only file you create; every probe stays in TEMP).

## 0. Your previous run was cut off before the report

Your wave-15 turn ended at *"Now I'll write my own independent probe (in temp, never in the repo) to re-prove every defence."* and `C:\Users\Kalch\Documents\IXI\audit-wave15-2026-10-22.md` **does not exist on disk** (I checked). Your probe work **is** on disk:

```
C:\Users\Kalch\AppData\Local\Temp\opencode\wave15-audit\
  audit-probe.mjs (22454 B)  auth-mojibake.mjs  cf-header-reconstruct.mjs
  gates.txt  harness.txt  qa.txt
  sb-m1 … sb-m10  bundle-sb-*.cjs  entry-sb-*.ts  shipped\  probe\  data\
```

**Reuse that work — do not restart from zero.** The user answered your offer with *"write it then"*, so this wave also owes the owner the **exact preview-deploy + curl commands** you offered to prepare.

## 1. What I verified by execution just now (do not re-derive)

| Gate | Result |
|---|---|
| `api/` file count | **7** `.ts` files |
| `npm run check:routes` | **16 routes / 0 missing**, 11 rewrites agree, "every route of the table is served by its entry point's HANDLERS map", exit 0 |
| `npm run typecheck:api` | **exit 0** |
| `npm run test:store` | **72 pass / 0 fail** |
| QA transcript | `site/qa/artifacts/qa-full-run-2026-10-22-113339.txt` — every suite exit 0; wave-15 line `[wave15] 17 passed, 0 failed, 17 checks` |

## 2. The three wave-15 edits, as I read them from disk

**B-1 (Backend) — landed as briefed.** `api/portal.ts:104-105`:

```ts
const fromQuery = url.searchParams.get(ROUTE_CARRIER_PARAM);
if (fromQuery !== null) return fromQuery;
```

`api/admin.ts` carries the same shape. `site/shared/portal-router.ts:208-213` refuses a **present-but-empty** carrier with `404 {code:'not-found'}` *before* the table is consulted; the `x-imk-route` header is now consulted **only** when the query parameter is genuinely absent.

**B-2 (Backend) — landed in SIX CF twins** (the brief named five; `site/functions/api/lib/notifications.ts` had the identical misleading first line, so it was included). Each now says *"A SEPARATE COPY of the Vercel module …"*, and `site/functions/api/portal/session.ts` correctly says *"PARTLY SHARED: the session logic itself is the shared module `site/shared/server/portal-session.ts`, which this file imports"*.

**Encoding — clean, I checked the bytes myself:**

| File | bytes | 0xFFFD | em-dashes | BOM |
|---|---|---|---|---|
| `DEPLOY.md` | 28287 | 0 | 33 | no |
| `site/.env.example` | 6182 | 0 | 5 | no |
| `site/shared/portal-router.ts` | 11513 | 0 | 4 | no |
| `api/portal.ts` | 6967 | 0 | 2 | no |
| `api/admin.ts` | 5434 | 0 | 2 | no |

## 3. What to audit (A-1 … A-5)

**A-1 — did B-1 close the fall-through, and did it weaken anything?** Re-prove by execution, in the **deployed shape** (entry-prefix path + client query), and mutate each layer so it **reddens**:

- family containment (`isInsideEntry`) still holds;
- the five standalone URLs (`/api/contact`, `/api/moderate/review`, `/api/portal/auth/{request-link,verify,logout}`) still unreachable via a carrier;
- every handler still authorises itself;
- the bare entry point still answers a **LOUD** `500 {code:'route-resolution'}`;
- the carrier is still **STRIPPED** from the URL the handler sees;
- B-1 itself: empty carrier → `404 {code:'not-found'}`, **never** the session handler; an **absent** query param + `x-imk-route` header → resolves exactly as before.

**A-2 — regression hunt.** Find any input that used to work and now 404s. Especially the deployed shape, where the rewrite replaces the path with the entry prefix and carries the original path in `__imk_route`. If a platform or proxy ever sends an **empty** `?__imk_route=` for a legitimate route, does B-1 break it? State plainly what you could and could not rule out.

**A-3 — the CF twin headers.** Do they now say what each file *is* (separate copy vs the `portal/session.ts` case that genuinely re-exports `site/shared/server/portal-session.js`)? Is the code in them byte-identical apart from comments? Still valid UTF-8, zero `0xFFFD`, every em-dash intact (wave 13 had an ANSI round-trip incident — prove it did not repeat).

**A-4 — DEPLOY.md against the tree.** ⚠️ **DevOps is CONCURRENTLY fixing three lines QA found still false.** Re-read `DEPLOY.md` and `site/.env.example` **right before you write A-4**, audit the content you actually read, and record its mtime/SHA-256 so your findings are not stale. The three items DevOps is fixing:

1. `DEPLOY.md:68` — still quotes the wave-11 message *"Refusing to publish an empty set - published quotes exist."* the code never prints (wave 12 replaced that guard).
2. `site/.env.example:61` — still names `api/lib/notifications.ts`, which does not exist (wave 13 moved it to `site/shared/server/notifications.ts`).
3. `DEPLOY.md:134` — describes the resolver order as path → carrier → header; that now reads **wrong**, because a present-but-empty carrier is refused and the header is **not** consulted.

Report anything **still false after their edit**. Also count the store-test split *"27 file, 34 libsql, 11 shared = 72"* yourself.

**A-5 — verdict:** ship / do-not-ship, findings ranked CRITICAL / MAJOR / MINOR, each with `file:line`.

## 4. Extra deliverable — the exact owner commands (this is the "write it then")

Write into the report the **exact commands the owner runs** to settle the launch-critical unknowns on a Vercel **PREVIEW**:

1. the preview deploy command (and the project-link step if needed);
2. **2–3 curls**, each with expected output, failing output and what it proves:
   - one proving the **11 `vercel.json` rewrites FIRE** (e.g. `GET /api/portal/projects` on the preview URL) — if they do not fire, the portal is dead on arrival while every offline gate stays green;
   - one revealing the **query-merge order** — same path, two different `__imk_route` values;
   - one with an **empty** carrier (`?__imk_route=`) → expect `404 not-found`.

Mark clearly that this needs the **owner's** Vercel project + credentials, is **preview only**, and must never be run against production.

## 5. Gates you run yourself (report the numbers)

`typecheck:api` · `check:routes` (16/0) · `test:store` (72/72) · the repo-root harnesses · the QA runner (18 suites + the `check:routes` entry; expect all exit 0) · your own probes.

## 6. UNVERIFIED — state it, do not hide it

No Vercel router booted · no preview/deploy/production request · no workerd · no real Turso · no live mail. In particular it remains **UNOBSERVED whether the `vercel.json` rewrites fire at all**, and the platform's query-merge order is unobserved.

## 7. Deliverable

`C:\Users\Kalch\Documents\IXI\audit-wave15-2026-10-22.md` — the only file you create in the repo.
