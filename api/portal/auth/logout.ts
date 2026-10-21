// api/portal/auth/logout.ts — Vercel serverless function.
//
// WHY THIS FILE EXISTS (QA wave-3, F-1)
//   See api/portal/auth/request-link.ts: Vercel routes a function by its
//   file path, so /api/portal/auth/logout needed its own file to exist on
//   the deployed target. The handler itself is api/portal/auth.ts.

export { default } from '../auth.js';
