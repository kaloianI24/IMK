# IMK

Astro static marketing site. Cloudflare Pages + Pages Functions + Turnstile + Resend + KV rate limiter.

Spec baseline: `../spec/interface-spec.md` (T2). Copy: `../copy/copy-deck.md` (T1). Design: `../design/` (T3).

## Local dev

```bash
npm install
npm run dev
```

Build: `npm run build` → `dist/`. Pages Function: `functions/`. Deploy via Wrangler/CF Pages (DevOps T11). 
