// site/functions/api/portal/plan-items/[id].ts — Cloudflare Pages Function.
//
// WHY THIS FILE EXISTS (QA wave-3, F-1)
//   The portal edits a plan item by id: PATCH /api/portal/plan-items/<id>.
//   Cloudflare routes a function by its file path, so the by-id path needed
//   its own file. The handler itself is
//   site/functions/api/portal/plan-items.ts.

export { onRequestGet, onRequestPatch } from '../plan-items.js';
