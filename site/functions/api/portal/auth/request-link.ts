// site/functions/api/portal/auth/request-link.ts — Cloudflare Pages Function.
//
// WHY THIS FILE EXISTS (QA wave-3, F-1)
//   Cloudflare routes a Pages Function by its FILE PATH, exactly like
//   Vercel: functions/api/portal/auth.ts answers /api/portal/auth and
//   nothing else. The front-end calls /api/portal/auth/request-link, so on
//   Cloudflare that URL had no function behind it either.
//
//   The handler that implements the route lives in
//   site/functions/api/portal/auth.ts and switches on the request path.

export { onRequestPost } from '../auth.js';
