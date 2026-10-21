// api/portal/auth/request-link.ts — Vercel serverless function.
//
// WHY THIS FILE EXISTS (QA wave-3, F-1)
//   Vercel serves a function at its FILE PATH. `api/portal/auth.ts` answers
//   /api/portal/auth and nothing else, so the sign-in door the front-end
//   calls — /api/portal/auth/request-link — had NO function behind it on the
//   deployed target: the request answered 404 and no client could sign in.
//   The local dev server matched by PREFIX, which is why three QA waves
//   never saw it.
//
//   This file makes the path real. The handler that implements the route
//   lives in api/portal/auth.ts and switches on the request path, so the
//   behaviour here is exactly the behaviour the local server showed.
//
//   The route manifest check (site/scripts/check-api-routes.mjs) keeps every
//   /api URL the front-end uses backed by a real function file, in BOTH
//   trees. Without it, this class of bug is invisible until deploy.

export { default } from '../auth.js';
