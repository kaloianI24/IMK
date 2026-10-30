// site/scripts/api-index.ts
//
// Single entry point for the portal API handlers.
//
// Bundling every handler from ONE entry point keeps ONE copy of every shared
// module in the bundle. It USED to matter for the session: the handlers
// shared one in-memory `sessions` Map and the magic-link flow relied on it
// (verify creates a session, projects reads it). It no longer does - the
// session is a SIGNED, STATELESS token
// (site/shared/server/portal-session.ts, audit wave-6 F-2), so every handler
// resolves the cookie on its own: in this bundle, in a separate Vercel
// function bundle, or in a Worker isolate.
//
// This is a LOCAL-DEV convenience only.
//
// WAVE 13 (function budget)
//   The Vercel tree now has TWO entry points (api/portal.ts, api/admin.ts)
//   plus the files that keep their own URL (/api/contact,
//   /api/moderate/review and the three sign-in URLs). The dev server serves
//   the SAME route table the deployed target serves
//   (site/shared/portal-routes.json), so it calls the entry points with the
//   ORIGINAL request URL and lets the resolver do the routing - exactly what
//   production does after the rewrite.

export { default as portal } from '../../api/portal.ts';
export { default as admin } from '../../api/admin.ts';
export { default as auth } from '../../site/shared/portal-handlers/portal-auth.ts';
export { default as contact } from '../../api/contact.ts';
export { default as moderate } from '../../api/moderate/review.ts';
