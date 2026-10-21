# QA report — wave 8A contract (H-1 secret rule, M-1 the method is the point, the role endpoint)

**QA Engineer · 2026-10-22 · repo `C:\Users\Kalch\Documents\IXI`**

Scope: re-verify the QA suites against the wave-8A backend changes, update them to
the new contract, and report the result with evidence. No product code was touched:
every file below lives in `site/qa/**`.

---

## 1. Verdict

| Item | Result |
|---|---|
| 12-suite runner | **GREEN** — every suite exit 0 |
| Checks executed | **271** checks + **5** mutation probes, 0 unexpected failures |
| Transcript | `site/qa/artifacts/qa-full-run-2026-10-22-002306.txt` (last run; four green runs of mine: 001951, 002108, 002306) |
| Defects against the new contract | **0 open** (one parity gap found during the work and closed by the Backend mid-run) |
| Regression risk | covered: the new M-1 and H-1 checks are proven **non-vacuous** by mutation probe P5 and by the short-secret checks |

Run it again yourself:

```
cd C:\Users\Kalch\Documents\IXI
powershell -NoProfile -ExecutionPolicy Bypass -File site\qa\run-all-suites.ps1
```

Three transcripts from today are in `site/qa/artifacts/`: `...-2026-10-22.txt` (the
Backend's run from 00:06, the failing baseline — preserved as
`qa-full-run-2026-10-22-backend.txt`), plus four green runs of mine
(`...-001951.txt`, `...-002108.txt`, `...-002306.txt`). A fifth, `...-002146.txt`, was
started by someone else in the same tree and is green with the same numbers; it is not
mine.

---

## 2. The two causes (both confirmed by execution, not by reading)

### H-1 — a secret that is present but shorter than 32 characters is now refused

`site/shared/server/secret.ts` refuses a secret in production when it is missing,
when it is a published placeholder, or when it is **shorter than `MIN_SECRET_LENGTH`
= 32**. It applies to `PORTAL_SESSION_SECRET`, `PORTAL_MAGIC_LINK_SECRET` and
`FORM_WEBHOOK_SECRET`, in both trees. Every production-mode fixture in the suites was
shorter than 32 characters, so the handlers answered `500 {code:'internal'}` where they
used to work.

**Fix (fixtures only, still distinguishable):** every fixture secret is now 32+
characters (`qa-wave2-session-secret-0123456789` and so on). The secret values are
test fixtures, not credentials.

Two knock-on effects that were *not* in the brief and would have broken the suites
again later:

* `qa-testimonials.mjs` runs in development, where a short secret is legal — but its
  check **G4** flips the instance into production to prove that no sign-in token is
  written to the log. With a short magic-link secret G4 answered 500 for the *wrong
  reason* (a refused secret instead of a missing `RESEND_API_KEY`). The fixture is
  32+ characters now, so G4 proves what it claims.
* `qa-backend-hardening.mjs` check **L4** (production without `SITE_BASE_URL` → 500)
  answered **401** instead of 500, because the auth check ran before the
  base-URL check and the session secret was refused. With a usable secret it answers
  500 for the right reason.

### M-1 — a plain GET on the signed moderation link no longer decides anything

`GET /api/moderate/review` now serves a confirmation page (`text/html`) and changes
**nothing**; the **POST** is the decision (`{ok:true, ref, state:'approved'}`). This is
the point of the change: every mail scanner prefetches the link, and the prefetch used
to be the approval.

**Fix:** every check that approves or rejects now POSTs. The signed parameters travel
in the form body, the way the confirmation page's own form sends them.

| Suite | Checks changed to POST |
|---|---|
| `qa-testimonials.mjs` | C9, E8, E9, E10, F1, F3, G5 |
| `qa-backend-hardening.mjs` | L1 |
| `qa-cf-parity.mjs` | C4 |
| `qa-wave2-independent.mjs` | M1, M4, M5 |
| `qa-wave3-independent.mjs` | B2, B3, B4 (Cloudflare tree: `onRequestPost`) |
| `qa-wave5-independent.mjs` | B1, B4 |
| `qa-admin-independent.mjs` | E10 |

Checks that only assert an **error** code (400 signature, 400 validation, 409
stale-revision, 500 storage, 501 unreachable) keep using the GET: the method does not
change those answers, and the GET is what a scanner does.

---

## 3. New coverage added (the contract changed, so the contract is now guarded)

**M-1 — the GET must not decide (new checks):**

* `qa-testimonials.mjs` **E11** — a plain GET on a signed link serves the
  confirmation page (`text/html`, a POST form carrying `ref`/`decision`/`revision`/
  `ts`/`sig`) and the quote stays `pending`: no `decidedAt`, no approved line.
* `qa-testimonials.mjs` **E12** — the page's **own hidden inputs**, posted back,
  decide the quote. This is the end-to-end proof that the page carries a working
  signature.
* `qa-testimonials.mjs` **E13** — a GET on an already-decided quote says so, offers
  no button and appends no line.
* `qa-backend-hardening.mjs` **L1b**, `qa-wave2-independent.mjs` **M4b**,
  `qa-wave5-independent.mjs` **B1b** — the same property on the Vercel tree, in three
  independently written harnesses.
* `qa-wave3-independent.mjs` **B2b** — the same property on the **Cloudflare** tree
  (with a filesystem bound), then the POST decides.
* `qa-admin-independent.mjs` **E10** — the owner's inbox link: the GET approves
  nothing, the POST approves.

**H-1 — the secret rule (new checks, `qa-testimonials.mjs` I1–I4):**

* a 17-character secret in production → `500 {code:'internal'}` (reason logged:
  `FORM_WEBHOOK_SECRET too-short`);
* the published placeholder from `site/.env.example` → the same 500 (reason:
  `placeholder`);
* **control:** a 33-character secret signs a link and approves a quote in production;
* a 16-character signing secret → no session can be minted: `500 {code:'internal'}`,
  no `Set-Cookie`.

**The new role endpoint (`GET /api/portal/session`), optional in the brief — covered
anyway:**

* `qa-testimonials.mjs` **J1–J7** (Vercel tree): 401 without a cookie, 200
  `{role:'admin'}` for the owner, 200 `{role:'client', clientId}` for a client, 405
  `{code:'method'}` for a POST, 500 `{code:'internal'}` when `ADMIN_EMAILS` is unset,
  the live allow-list downgrades an owner to `client` at once, and an unusable signing
  secret is a loud 500 rather than a silent 401.
* `qa-cf-parity.mjs` **C6** (Cloudflare twin): the same six answers.

**Vacuity proof (the new checks must be able to fail):**

* mutation probe **P5** (new) puts the old behaviour back in a copy — the GET decides
  again — and asserts that the "a GET decides NOTHING" check goes **RED**. It does.
* The five probes in `qa-mutation-probe.mjs` (P1–P5) all behave as expected.

---

## 4. Two gaps found in the QA harness itself (mine — fixed)

1. **The Cloudflare write path was never executed.** The edge `node:fs` mock had no
   `renameSync`, and the moderation log is written atomically (temp file + rename).
   Because a GET never wrote, the gap stayed invisible; the first POST against the
   Cloudflare tree answered `500 {code:'storage'}`. The mock now implements
   `renameSync` (wave-3, wave-5, cf-parity).
2. **The mutation probes no longer built.** wave-8A moved `resolveAccess`,
   `canReadClient`, `canWriteClient`, `resolveOwnerSession` and `sessionSecretProblem`
   into `api/portal/session.ts`, so the fake Map-based session module had missing
   exports ("No matching export") and the probe proved nothing. The fake now provides
   them (plus a default export, because the file is a route now). The allow-list probe
   follows the rule to its new home in `site/shared/server/portal-session.ts`.

Also fixed in my own tools: `qa-testimonials-build.mjs` crashed with
`Cannot read properties of undefined (reading 'clientId')` when the store held no
anonymous quote; it now fails with a message that says which precondition is missing.
`run-all-suites.ps1` wrote one transcript **per day**, so a second run on the same day
**overwrote the first** — it now writes one transcript **per run**
(`qa-full-run-<date>-<HHmmss>.txt`). The Backend's evidence from 00:06 is preserved
as `qa-full-run-2026-10-22-backend.txt`.

---

## 5. Finding for the Backend — one parity gap, closed during the work

While writing the H-1 checks I found that the two trees answered **differently** for
the same input on the new endpoint: with an unusable `PORTAL_SESSION_SECRET`,
`site/functions/api/portal/session.ts` answered `500 {code:'internal'}` ("a deployment
that cannot VERIFY a session must say so loudly") while `api/portal/session.ts`
answered **401** — the silent "signed out" symptom the CF twin's own comment says to
avoid. That breaks the tree-parity rule (spec/07 §1, D-6).

I encoded the CF behaviour in `qa-testimonials.mjs` **J7**; the Backend added the
`sessionSecretConfigured` guard to the Vercel tree at 00:12 and **J7 passes**. The
guard now exists in both trees. No action needed — noted so the change is not
accidentally reverted.

---

## 6. What is NOT verified by this run (honest limits)

* **No real deployment was exercised.** Every suite runs the real handlers on Node
  against a sandbox. The Cloudflare tree is executed in a Web-standard runtime with a
  faked `node:fs` — the workerd runtime itself was never booted (no workerd binary is
  available on this machine).
* **No real mail scanner was involved.** The M-1 property is verified at the contract
  level (the GET serves a page and changes nothing, the POST decides). That is the
  contract the scanner hits; it is not a scan of a real inbox.
* **The `astro build` half** is a real build of the real publish script, but only of
  the sandbox copy of the site.
* The Backend is working in the same tree during this run: `api/portal/session.ts`
  changed at 00:12 and the runner was executed again afterwards (00:19:51 and 00:21:08
  — both green), so the results reflect the tree as of 00:21.
