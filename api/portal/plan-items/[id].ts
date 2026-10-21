// api/portal/plan-items/[id].ts — Vercel serverless function.
//
// WHY THIS FILE EXISTS (QA wave-3, F-1)
//   The portal edits a plan item by id: PATCH /api/portal/plan-items/<id>.
//   Vercel routes a function by its file path, so the by-id path needed its
//   own file — without it the owner's plan-item edits answered 404 on the
//   deployed target (the local dev server matched by PREFIX and hid it).
//
//   The handler itself is api/portal/plan-items.ts; it reads the id from the
//   request path.

export { default } from '../plan-items.js';
