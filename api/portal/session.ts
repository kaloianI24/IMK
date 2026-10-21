// api/portal/session.ts — Vercel serverless shared module.
// Session management for the IMK client/owner portal.
//
// THE IMPLEMENTATION IS SHARED (audit wave-6, F-2)
//   It lives in site/shared/server/portal-session.ts and is imported by the
//   Cloudflare twin as well, so the two trees cannot drift apart on a
//   security contract — and so a session minted on one target is accepted by
//   the other.
//
//   The session used to be a module-scope `Map` in THIS file. Vercel builds
//   one function per file under api/, so /api/portal/auth/verify and
//   /api/portal/projects each got their own copy of the Map: the cookie the
//   verify function issued was refused by the projects function with
//   401 {code:'unauthorized'}, and no client could sign in. The session is now
//   a SIGNED token — stateless, per instance, per cold start, per bundle.
//
//   The module has no `node:` imports, so it also loads in the edge runtime.
//
//   This file is a thin re-export: the Vercel tree calls the session API
//   without an explicit environment, which defaults to `process.env`.

export * from '../../site/shared/server/portal-session.js';
