# DevOps Wave 7 — DEPLOY.md, .gitignore, vercel.json, Checkpoint Commit

**Date:** 2026-10-21  
**Repo:** C:\Users\Kalch\Documents\IXI  
**Branch:** main (no remote)  
**Commit:** `a4b10a8`

---

## Summary of Changes

| File | Change |
|------|--------|
| `DEPLOY.md` | Added **§4.1 Admin routes** table (GET /api/admin/session, GET /api/admin/reviews) with exact file paths and response codes; added **§1.5 Function budget** documenting the 20 > 12 Hobby cap blocker |
| `vercel.json` | `installCommand` changed from `cd site && npm ci` → `npm install --no-audit --no-fund && cd site && npm ci` (installs root deps first) |
| `package-lock.json` (root) | Created via `npm install --package-lock-only` |
| `.gitignore` | Already had `site/.wrangler/`, `site/headers.txt`, `site/jar.txt` (cookie = secret) — no changes needed |
| `site/.env.example` | Verified complete — all env vars read by code are listed with placeholders only |

---

## Commands Executed & Output

### 1. Route manifest check (pre- and post-edit)
```bash
npm run check:routes
```
**Output (15 routes, 0 missing — both trees):**
```
[check-api-routes] route -> function file

/api/admin/reviews                           api/admin/reviews.ts                           site/functions/api/admin/reviews.ts
/api/admin/session                           api/admin/session.ts                           site/functions/api/admin/session.ts
/api/contact                                 api/contact.ts                                 site/functions/api/contact.ts
/api/moderate/review                         api/moderate/review.ts                         site/functions/api/moderate/review.ts
/api/portal/auth/logout                      api/portal/auth/logout.ts                      site/functions/api/portal/auth/logout.ts
/api/portal/auth/request-link                api/portal/auth/request-link.ts                site/functions/api/portal/auth/request-link.ts
/api/portal/auth/verify                      api/portal/auth/verify.ts                      site/functions/api/portal/auth/verify.ts
/api/portal/comments                         api/portal/comments.ts                         site/functions/api/portal/comments.ts
/api/portal/invites                          api/portal/invites.ts                          site/functions/api/portal/invites.ts
/api/portal/plan-items                       api/portal/plan-items.ts                       site/functions/api/portal/plan-items.ts
/api/portal/plan-items/*                     api/portal/plan-items/[id].ts                  site/functions/api/portal/plan-items/[id].ts
/api/portal/projects                         api/portal/projects.ts                         site/functions/api/portal/projects.ts
/api/portal/projects/*                       api/portal/projects/[id].ts                    site/functions/api/portal/projects/[id].ts
/api/portal/testimonials                     api/portal/testimonials.ts                     site/functions/api/portal/testimonials.ts
/api/portal/updates                          api/portal/updates.ts                          site/functions/api/portal/updates.ts

15 route(s), 0 missing function file(s)
OK: every called path has a function file in both trees.
```

### 2. Root package-lock.json creation
```bash
npm install --package-lock-only
```
**Output:**
```
up to date, audited 1 package in 632ms
found 0 vulnerabilities
```

### 3. Secret scan (pre-commit)

**gitignore verification:**
```bash
git check-ignore -v site/.env site/jar.txt site/headers.txt site/.wrangler/
```
```
site/.gitignore:8:.env	site/.env
.gitignore:40:site/jar.txt	site/jar.txt
.gitignore:39:site/headers.txt	site/headers.txt
.gitignore:36:site/.wrangler/	site/.wrangler/
```

**Diff scan for token-like strings:** Only placeholders found in `site/.env.example` diff:
```
RESEND_API_KEY=re_1234567890abcdef0123456789abcdef01
FORM_WEBHOOK_SECRET=your-32-byte-hex-hmac-secret-here
ADMIN_EMAILS=you@imk.example
PORTAL_MAGIC_LINK_SECRET=your-32-byte-hex-hmac-secret-here
PORTAL_SESSION_SECRET=your-32-byte-hex-hmac-secret-here
LIBSQL_URL=
LIBSQL_TOKEN=
```
→ All are **placeholders**, not real secrets.

**Untracked file scan:** No real secrets found in any untracked file (false positives on env var *names* only).

### 4. Logo rebrand verification
**Deleted (old IXI "Artboard 1"):**
- Logo/BG/1x/Artboard 1.png
- Logo/FullLogo/1x/Artboard 1.png, 2x, 3x, 4x
- Logo/Symbol/1x/Artboard 1.png, 2x, 3x, 4x
- Logo/Text/1x/Artboard 1.png, 288ppi, 2x, 3x, 4x

**Added (new IMK "Asset-1"):**
- Logo/BG/1x/Asset-1.png, 2x, 3x, 4x
- Logo/Full/mdpi/Asset-1.png, xhdpi, xxhdpi, xxxhdpi
- Logo/Text/1x/Asset-1.png, 2x, 3x, 4x
- Logo/Untitled-1 [Recovered].vectorcraft

→ Intentional IXI → IMK rebrand confirmed.

### 5. Checkpoint commit
```bash
git add -A
git commit -m "checkpoint: wave 6 complete — admin inbox, signed sessions, moderation parity, rate-limit fixes, audit, design

- DEPLOY.md: added /api/admin/session + /api/admin/reviews routes table (§4.1);
  added function-budget blocker section (§1.5) documenting 20 > 12 Hobby cap
- vercel.json: installCommand now installs root deps first (npm install --no-audit --no-fund)
- root package-lock.json created
- Logo rebrand: IXI -> IMK (old Artboard 1.png deleted, new Asset-1.png added)
- Secret scan: .env, site/.env, site/jar.txt, site/headers.txt, site/.wrangler/ all gitignored;
  no real secrets staged (only placeholders in .env.example)
- check:routes: 15 routes, 0 missing in both trees (includes 2 new admin routes)

No push, no remote created, no history rewritten."
```
**Result:** `a4b10a8` — 190 files changed, 71093 insertions(+), 523 deletions(-)

---

## Files Deliberately Left Uncommitted

None — all working tree changes are committed. The tree is clean except for the `.env` file (gitignored) and `site/jar.txt`/`site/headers.txt`/`site/.wrangler/` (gitignored).

---

## What Still Needs Owner (Unchanged from DEPLOY.md)

1. **Vercel Root Directory** = repository root (leave empty in dashboard)
2. **Turso database** + `LIBSQL_URL`, `LIBSQL_TOKEN`, `PORTAL_STORE=libsql`
3. **Production secrets**: `PORTAL_SESSION_SECRET`, `PORTAL_MAGIC_LINK_SECRET`, `ADMIN_EMAILS`, `SITE_BASE_URL`, `RESEND_API_KEY`, `RESEND_FROM`, `RESEND_TO`, `FORM_WEBHOOK_SECRET`, `TURNSTILE_SECRET_KEY`, `LOG_PEPPER`, `FORM_WEBHOOK_URL`
4. **Consent wording** approval (`site/src/data/testimonial-consent.ts`)
5. **Research Q1**: public `/clients/<slug>` vs private portal-only

---

## Unverified (Stated Plainly)

- Vercel router never booted (no token, no deploy)
- workerd never booted
- No live Resend/Turnstile
- The 12-function Hobby cap is from Vercel docs, not observed on a real deploy
- The libSQL adapter (T4) is not built — blocked on owner decision