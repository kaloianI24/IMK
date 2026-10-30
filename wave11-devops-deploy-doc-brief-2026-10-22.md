# Wave 11 — DevOps brief: DEPLOY.md still carries five claims the tree does not support

Repo: `C:\Users\Kalch\Documents\IXI` (tree is permanently dirty, 62 changed paths — never reset/clean/checkout/stash, never run a mutating git command).

YOU OWN: `DEPLOY.md` and `site/.env.example` only.

DO NOT TOUCH: `api/**`, `site/shared/**`, `site/scripts/**`, `site/functions/**`, `site/qa/**`, `spec/**`, `site/data/**`, repo-root `*.mjs` harnesses.

Do **not** touch `site/shared/server/secret.ts` — the three published placeholders are already registered there (`:41-43`, verified) and another agent owns that file.

Your wave-10b pass fixed the eight items you were given. These five remain, each verified by the Manager against the tree today.

## Item 1 — `DEPLOY.md:65` and `:252` and `:256` say "60/60". It is now 66/66.

`npm run test:store` today: **66 pass / 0 fail** (was 60). The wave-10 revision scope added 6 contract assertions (both adapters). Three places carry the old number:
- `:65` — "The libSQL adapter **is built and proven**: `npm run test:store` = 60 pass / 0 fail (the same 22 contract assertions run against both the file adapter and the libSQL adapter)."
- `:252` — "(60/60 contract tests)"
- `:256` — "proven by `npm run test:store` (60/60)"

Update all three. Note the split measured today: **24** `file:` assertions, **31** `libsql:` assertions, **11** shared assertions. The "(the same 22 contract assertions run against both…)" clause at `:65` is no longer accurate either — the per-adapter counts now differ (24 vs 31), because the revision-scope assertions are not symmetric across the two adapters. State the real numbers.

## Item 2 — `DEPLOY.md:58` heading contradicts the two bullets under it.

```
58  **What does NOT work on Vercel today:**
59  - All portal endpoints (/api/portal/*) are now wired to the libSQL adapter via …
60  - Rate limiting is **per instance in file mode (default)**, and **shared and durable on the database …
```

Both bullets describe what now **works**. The heading was not updated with them. Rewrite the heading (and the section's flow at `:45-62`) so it reads correctly: what works with `PORTAL_STORE=file` on Vercel, and what requires `PORTAL_STORE=libsql`.

## Item 3 — `DEPLOY.md:43`, `:60` and `:251` cite `api/lib/rate-limit.ts:413-419` for the `PORTAL_RATE_LIMIT_FILE` precedence. The line numbers moved.

Verified today: the precedence is decided at `api/lib/rate-limit.ts:430-440` (`createPortalRateLimiter`, `const configured = options?.filePath ?? env.PORTAL_RATE_LIMIT_FILE;` at `:435`). The old `:413-419` now points at the tail of a different function.

Also update the **substantive** claim, which changed in wave 10 (F-5). The limiter's key is no longer a hash of the client-sent `x-forwarded-for`. It is now derived **only from a platform-controlled address** — `api/portal/auth.ts:159-170` `platformAddress()`: `cf-connecting-ip` first, otherwise the **last** hop of `x-forwarded-for` (the platform's own view), never the client's first entry. The same file states why (`:142-153`). A client that sends its own `x-forwarded-for` no longer gets a fresh bucket.

## Item 4 — `DEPLOY.md:73` describes the publisher's store access with stale line numbers, and omits the wave-10 behaviour change.

Current text cites `site/scripts/publish-testimonials.mjs:328-334` for `readReviewsFromStore()`. Verified today: `readReviewsFromStore()` is at **`site/scripts/publish-testimonials.mjs:585-591`**, `readReviewsFromFile()` at `:242-266`, `readReviewsFromDatabase()` at `:475-570`.

More important than the line numbers: the publisher's **failure behaviour** changed in wave 10 (F-1) and the runbook must say so, because it changes what the owner sees on a Vercel build:
- a **missing** store → the build **fails** (`exit 1`, "Refusing to publish a partial set of testimonials.") and the published quotes are left untouched;
- a store that **cannot be parsed** → the build fails;
- a database with **no schema** → the schema is created and the build then **fails**;
- the published set is now built in a **staging directory and swapped in** (`:621-657`), so a failed publish leaves the published directory exactly as it was.

State plainly what the owner should do if a Vercel build now fails on the publisher. This is the behaviour that protects the published client quotes.

## Item 5 — `DEPLOY.md:232` (the §7 launch-blocker table) and `:256` still say "no JSONL reader is left in `api/`". That is false today, and the refactor is planned but not applied.

Verified: `api/lib/jsonl.ts` still exists and **has no importer in the product** (wave-10 harness check G1) — but `api/lib/notifications.ts` **is** still imported by `api/admin/reviews.ts:45`, `api/moderate/review.ts:41`, `api/portal/testimonials.ts:27` and `site/functions/api/moderate/review.ts:25`, `site/functions/api/portal/testimonials.ts:17`; `api/lib/rate-limit.ts` is imported by `api/portal/auth.ts:31`, `api/portal/testimonials.ts:35` and the two Cloudflare twins.

So: the **handlers** read through the store (true), but three files under `api/` still exist as **shared utilities that Vercel builds as dead functions** — each one costs a slot against the 12-function cap. `api/lib/jsonl.ts` is dead in the product; the other two are live modules that simply live in the wrong directory.

## Also: the §1.5 function-budget numbers are still right, but say WHY they are still there

`:96-107` is accurate (20 files under `api/`, 17 with a default export, 3 utilities with none). Leave the numbers. But `:106-107` says the fix is "not yet applied — see `spec/proposal-wave7-design-2026-10-21.md` §2". Keep that pointer, and add one sentence naming **why** the refactor has not been applied yet: the Vercel plan is not settled (Hobby caps at 12 functions and blocks the deploy; Pro has no cap), and the refactor rewrites the handler bodies that wave 10 just changed, so it must not run concurrently with the wave-10 review.

## Gate (execute these, cite the output)

- `npm run check:routes` → 16 routes, 0 missing
- `npm run typecheck:api` → exit 0
- `node site/scripts/check-api-routes.mjs` → same 16
- a grep proving **no** remaining `60/60`, `rate-limit.ts:413-419`, `publish-testimonials.mjs:328-334`, `readJsonlFile`/`no JSONL reader is left` claims in `DEPLOY.md`
- `site/.env.example` still shows 3 distinct `REPLACE_ME_*` placeholders and the 3 published ones are registered in `site/shared/server/secret.ts` — read-only check, do not edit that file.

## Deliverable

Report at `C:\Users\Kalch\Documents\IXI\wave11-devops-deploy-doc-2026-10-22.md`: each of the 5 items with the old text, the new text, and the file:line evidence; the gate results; and an explicit **UNVERIFIED** list (no git commit made, no deploy, no Vercel/Cloudflare runtime booted, no real Turso database contacted).

Answer **DONE** or **BLOCKED** with findings ranked by severity. Do not claim a gate you did not execute.
