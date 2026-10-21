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
// This is a LOCAL-DEV convenience only. Production targets (Vercel /
// Cloudflare) build one function per file under api/; the route files under
// api/portal/ re-export the handlers below.

export { default as auth } from '../../api/portal/auth.ts';
export { default as projects } from '../../api/portal/projects.ts';
export { default as planItems } from '../../api/portal/plan-items.ts';
export { default as updates } from '../../api/portal/updates.ts';
export { default as comments } from '../../api/portal/comments.ts';
export { default as invites } from '../../api/portal/invites.ts';
export { default as testimonials } from '../../api/portal/testimonials.ts';
// The moderation endpoint belongs here too: without it the one-click approve
// link 404s in local dev, so the flow QA exercises in production could not be
// exercised at all locally (audit m8).
export { default as moderate } from '../../api/moderate/review.ts';
// The owner inbox (spec/07 §7.3, T7.14). Both are listed so the local dev
// server can serve /admin: the page is static, so without these two routes
// the inbox would show its "cannot reach the server" state on every machine.
export { default as adminSession } from '../../api/admin/session.ts';
export { default as adminReviews } from '../../api/admin/reviews.ts';
