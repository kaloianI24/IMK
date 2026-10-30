// api/portal/auth/request-link.ts — Vercel serverless function.
//
// WHY THIS FILE EXISTS (QA wave-3, F-1)
//   Vercel serves a function at its FILE PATH. The auth handler used to
//   live in api/portal/auth.ts, which answered /api/portal/auth and nothing
//   else, so the sign-in door the front-end calls —
//   /api/portal/auth/request-link — had NO function behind it on the
//   deployed target: the request answered 404 and no client could sign in.
//   The local dev server matched by PREFIX, which is why three QA waves
//   never saw it.
//
//   This file makes the path real. The handler that implements the route
//   lives in site/shared/portal-handlers/portal-auth.ts and switches on the
//   request path, so the behaviour here is exactly the behaviour the local
//   server showed.
//
//   The route manifest check (site/scripts/check-api-routes.mjs) keeps every
//   /api URL the front-end uses backed by a real function file, in BOTH
//   trees. Without it, this class of bug is invisible until deploy.
//
// WHY THE SIGN-IN FAMILY KEEPS ITS OWN FILES (wave 13)
//   The other nine portal URLs were consolidated into ONE function
//   (api/portal.ts) to fit the Vercel Hobby function budget. The sign-in
//   door did not: /api/portal/auth/verify carries a query string (?token=)
//   and is the most security-sensitive surface in the product, so it keeps a
//   function file of its own and is never rewritten. The cost is three
//   function slots; the benefit is that no rewrite can touch the sign-in
//   door.

export { default } from '../../../site/shared/portal-handlers/portal-auth.js';
