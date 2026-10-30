// api/portal/auth/verify.ts — Vercel serverless function.
//
// WHY THIS FILE EXISTS (QA wave-3, F-1)
//   See api/portal/auth/request-link.ts: Vercel routes a function by its
//   file path, so /api/portal/auth/verify needed its own file to exist on
//   the deployed target. The handler itself is
//   site/shared/portal-handlers/portal-auth.ts.
//
// WHY THE SIGN-IN FAMILY KEEPS ITS OWN FILES (wave 13)
//   /api/portal/auth/verify carries a query string (?token=) and is the most
//   security-sensitive surface in the product, so it is never rewritten and
//   keeps a function file of its own.

export { default } from '../../../site/shared/portal-handlers/portal-auth.js';
