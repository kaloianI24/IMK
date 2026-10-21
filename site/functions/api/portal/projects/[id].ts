// site/functions/api/portal/projects/[id].ts — Cloudflare Pages Function.
//
// WHY THIS FILE EXISTS (QA wave-3, F-1)
//   The portal edits a project by id: PATCH /api/portal/projects/<id>.
//   Cloudflare routes a function by its file path, so the by-id path needed
//   its own file. The handler itself is
//   site/functions/api/portal/projects.ts.

export { onRequestGet, onRequestPatch } from '../projects.js';
