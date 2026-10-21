# WAVE-9b — DevOps brief: DEPLOY.md + .env.example accuracy

Owner-free. The owner reads `DEPLOY.md` to make three decisions, so a false sentence in it costs a
real decision.

**Repo:** `C:\Users\Kalch\Documents\IXI`
No git remote, and the working tree is permanently dirty.
**NEVER** run `git reset`, `git clean`, `git checkout` or `git stash`.

You already corrected §1.5 (17 real routes / 3 shared utilities / 20 total) and §7 row 3. Good.
But `DEPLOY.md` still contradicts itself in five places — each verified against the tree on
2026-10-22.

---

## 1. The five stale claims in `DEPLOY.md`

### 1. Line 62 — the adapter is "not built"

> "The libSQL adapter is **not built** — `getStore()` throws `not-implemented`
> (see `site/shared/portal-store/index.ts:37-41` and `edge.ts:31-35`)."

**FALSE.** `getStore()` exists at `index.ts:35` and `edge.ts:30`; `index.ts:38-41` returns
`createLibsqlStoreFromEnv(env)` for `PORTAL_STORE=libsql`, and `libsql-store.ts` fails closed only
on a missing/invalid `LIBSQL_URL` / `LIBSQL_TOKEN`. The adapter is **built and proven**:
`npm run test:store` = 60 pass / 0 fail, the same 22 contract assertions against the file adapter
and the libSQL adapter.

What is **not** built is the **wiring**: no portal handler calls `getStore()` yet. Rewrite the
bullet to say exactly that.

### 2. Line 63 — the work is "BLOCKED on an owner decision"

> "This work is **BLOCKED on an owner decision** (Turso vs Neon, and database creation)."

**FALSE and misleading.** `spec/proposal-wave7-design-2026-10-21.md` §3.10 states that the
Turso-vs-Neon choice does **not** block the code — the adapter speaks the libSQL HTTP protocol and
the `PortalStore` interface keeps a Postgres adapter possible later.

The owner needs exactly **two values** (`LIBSQL_URL`, `LIBSQL_TOKEN`) plus a database. Correct it
to that.

### 3. Line 91 — "4 dead functions"

> "**On Vercel Pro/Enterprise:** the deploy works, but 4 dead functions exist …"

→ **3** (`lib/jsonl.ts`, `lib/notifications.ts`, `lib/rate-limit.ts`). Your own §1.5 table already
says 3; this line still says 4.

### 4. Line 95 — "Move the 4 shared utilities" and the wrong 7-function breakdown

> "Move the 4 shared utilities out of `api/` … This brings the function count to **7**
> (5 route families + 2 auth files with query params that must not be rewritten) with 5 slots spare."

→ **3** shared utilities, not 4.

And the breakdown is wrong: spec §2.2 keeps **all three** `/api/portal/auth/*` files separate, and
§2.3's after-map gives 7 =
`api/portal.ts` + `api/admin.ts` + `api/contact.ts` + `api/moderate/review.ts` + the **3** auth files.
Fix both the numbers and the breakdown.

### 5. Lines 232-236 — the §8 storage rows

`PORTAL_STORE`, `LIBSQL_URL`, `LIBSQL_TOKEN` still say the adapter "throws `not-implemented` until
it lands", and the note at line 236 says "the portal will error with `not-implemented` until the
libSQL adapter (task T4) is merged".

**FALSE** — and it now contradicts your own corrected §7 row 3. Correct it to:
the adapter is **built and proven**; the portal handlers are being **wired** to it (in flight);
the owner creates the database and sets the three variables.

## 2. Keep §1.3's blocker honest

The portal still cannot persist on Vercel today — that stays true. The **reason** is the missing
wiring, not a missing adapter. Change the reason, keep the blocker.

## 3. `site/.env.example` (yours — the Backend left it to you)

- The Storage block says *"The libSQL adapter is NOT implemented yet (task T4) — it throws
  'not-implemented' until it lands"* and *"The portal will error with 501 until T4 is done."*
  → **False.** Rewrite to the true state.
- `APP_ENV=development` is shipped in the example and now **misleads**: wave-8A made production the
  **default** — production is detected when `APP_ENV` is unset/unknown **or** `NODE_ENV=production`
  **or** `VERCEL=1` **or** `SITE_BASE_URL` starts with `https://`, so `APP_ENV=development` alone
  no longer disables the guards. Replace the line with a comment saying the value is not what makes
  it production. Keep the other example values.
- `FORM_WEBHOOK_SECRET`, `PORTAL_MAGIC_LINK_SECRET` and `PORTAL_SESSION_SECRET` all ship the
  **same** placeholder (`your-32-byte-hex-hmac-secret-here`). Give each a **different** placeholder
  and add every new placeholder string to `PUBLISHED_SECRET_PLACEHOLDERS` in
  `site/shared/server/secret.ts`, so a copied example value is still refused.
  **Do NOT weaken the rule:** missing, published-placeholder, or `<32`-char secrets must still be
  refused in production (`500 { code: 'internal' }`).

## 4. Out of scope — do not touch

- §5 (the Vercel Root Directory click path) and §6 (the Turso steps + exact variable names).
- The `LIBSQL_TOKEN` warning (never commit, never log).
- The **function-budget refactor** (20 → 7). It moves the `api/portal/*.ts` handler bodies the
  Backend is rewriting **right now**. Deferred until the wiring lands and the owner states their
  Vercel plan (Hobby needs ≤ 12; Pro does not).

## 5. Verify and quote

- `node scripts/check-api-routes.mjs` (from `site/`) → still 16 routes, 0 missing.
- `npm run typecheck:api` → exit 0.
- `node backend-wave8-session-endpoint-harness.mjs` → 57/57. It pins the placeholder / short-secret
  rule; it must stay green after you touch `secret.ts`.
- Re-read `DEPLOY.md` end to end after editing; confirm no sentence still claims the adapter is
  unbuilt or the work is owner-blocked. **Quote the grep you ran.**

Report the before/after of each of the five `DEPLOY.md` items and the `.env.example` changes in your
reply. **Never write `LIBSQL_TOKEN` into a file or a report.**
