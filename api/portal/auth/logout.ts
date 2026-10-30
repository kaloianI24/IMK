// api/portal/auth/logout.ts — Vercel serverless function.
//
// WHY THIS FILE EXISTS (QA wave-3, F-1)
//   See api/portal/auth/request-link.ts: Vercel routes a function by its
//   file path, so /api/portal/auth/logout needed its own file to exist on
//   the deployed target. The handler itself is
//   site/shared/portal-handlers/portal-auth.ts.
//
// WHY THE SIGN-IN FAMILY KEEPS ITS OWN FILES (wave 13)
//   The sign-in door is never rewritten, so each of its three URLs keeps a
//   function file of its own.

export { default } from '../../../site/shared/portal-handlers/portal-auth.js';
