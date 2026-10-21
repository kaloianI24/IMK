// site/functions/api/portal/session.ts — Cloudflare Pages Function shared module.
// Session management for the IMK client/owner portal.
//
// THE IMPLEMENTATION IS SHARED (audit wave-6, F-2)
//   It lives in site/shared/server/portal-session.ts and is imported by the
//   Vercel tree as well, so the two trees cannot drift apart on a security
//   contract — and so a session minted on one target is accepted by the
//   other.
//
//   The Cloudflare twin used to keep its own in-memory Map on globalThis.
//   That map is gone: a Worker runs one isolate per colo, so a session minted
//   in one colo was invisible in the next one. The session is now a SIGNED
//   token — stateless, so it survives a cold start, a colo change and a
//   scale-out.
//
//   The module has no `node:` imports, so it loads in a Worker isolate
//   unchanged.
//
//   This file is a thin re-export. The Cloudflare tree passes the request's
//   `env` explicitly (a Worker has no process.env), which is where the
//   signing secret comes from.

export * from '../../../shared/server/portal-session.js';
