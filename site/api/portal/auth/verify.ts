// site/functions/api/portal/auth/verify.ts — Cloudflare Pages Function.
//
// WHY THIS FILE EXISTS (QA wave-3, F-1)
//   See site/functions/api/portal/auth/request-link.ts: Cloudflare routes a
//   function by its file path, so /api/portal/auth/verify needed its own
//   file. The handler itself is site/functions/api/portal/auth.ts.

export { onRequestGet } from '../auth.js';
