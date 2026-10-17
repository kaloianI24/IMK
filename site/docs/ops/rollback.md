# IXI — Rollback procedure (Cloudflare Pages)

## Preconditions
- Site is deployed to Cloudflare Pages with a linked Git integration.
- Wrangler/GitHub provider managed; all secrets are Cloudflare env vars (no secrets in the repo).

## Rollback to a previous deployment
1. Open Cloudflare Dashboard → Pages → `ixi` → Deployments.
2. Find the last known-good deployment (tag it in Git via `git tag prod-YYYYMMDD`).
3. Click "Rollback to this deployment" → confirm. Cloudflare serves the previous build within ~1 min.
4. Verify `/` loads and `/api/contact` returns 405 on GET (not a 500).

## Rollback the Pages Function only
1. Revert the offending commit on `main`.
2. Push; CI rebuils. Wrangler redeploys both static + functional asset.
3. Confirm DEV_STUB is `0`/unset in production env after deploy (also CI check verifies).

## DNS rollback (domain change)
- Revert the CNAME/A record to the prior target; keep a 301 at the edge if required.
- Update SITE_URL / canonical if the hostname changed.

## Contact verification after rollback
- Submit a test inquiry via the live form and confirm: 200 + `ref` in JSON, Resend email received, webhook (if enabled) HMAC-SHA256 verifies.
- Check the Cloudflare Pages logs for `ipHash` (no bodies).

## Emergency kill switch
- Set `TURNSTILE_SECRET_KEY` removal + `DEV_STUB=1` would open honeypot bypass — DO NOT do in prod. Instead, point DNS at a static "maintenance" Pages project.

## Notes
- Form uses `KV_COUNTER` with a 3600s TTL; rate-limit counters reset on expiry, not immediately on rollback.
- No data is persisted beyond email/webhook; consent log is in email body.