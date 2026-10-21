// api/portal/projects/[id].ts — Vercel serverless function.
//
// WHY THIS FILE EXISTS (QA wave-3, F-1)
//   The portal edits a project by id: PATCH /api/portal/projects/<id>.
//   Vercel routes a function by its file path, so the by-id path needed its
//   own file — without it the owner's "update project status" call answered
//   404 on the deployed target (the local dev server matched by PREFIX and
//   hid it).
//
//   The handler itself is api/portal/projects.ts; it reads the id from the
//   request path.

export { default } from '../projects.js';
