// site/functions/api/portal/plan-items.ts — Cloudflare Pages Function.
//   GET     /api/portal/plan-items        — list plan items
//   POST    /api/portal/plan-items        — create plan item (owner only, deferred)
//   PATCH   /api/portal/plan-items/:id    — update plan item status (deferred)

import { resolveAccess, resolveOwnerSession, canReadClient } from '../../../shared/server/portal-session.js';
import { parseJsonlStrict, guardStorage } from '../../../shared/portal-store/jsonl.js';

const PROJECTS_FILE = 'site/data/portal/projects.jsonl';
const PLAN_ITEMS_FILE = 'site/data/portal/planItems.jsonl';



function json(body: any, status = 200, extra: Record<string, string> = {}): Response {
  const payload = JSON.stringify(body);
  return new Response(payload, {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...extra },
  });
}

function fsModule(): any {
  return (globalThis as any).require ? (globalThis as any).require('node:fs') : null;
}

/**
 * Read a store file. A malformed line is an ERROR (audit M3 / QA D3): it must
 * not turn the collection into an empty list, because "empty" reads as "no
 * plan items" — a silent outage wearing the costume of a normal answer.
 */
async function readJsonl(file: string): Promise<Array<Record<string, any>>> {
  const fs = fsModule();
  if (!fs) return [];
  if (!fs.existsSync(file)) return [];
  return parseJsonlStrict(fs.readFileSync(file, 'utf8'), file);
}

const handleGet: any = async (ctx: any): Promise<Response> => {
  const { request, env } = ctx;
  const url = new URL(request.url);

  // No writable filesystem on the edge target: an unreachable store must
  // not look like an empty plan (audit M3 / QA D3).
  if (!fsModule()) {
    return json({ error: 'not implemented on CF target', code: 'unimplemented' }, 501);
  }

  // The signing secret comes from the request's env — a Worker has no
  // process.env (audit wave-6, F-2: one shared, stateless session module).
  //
  // The READ scope is the client's own, even when an owner cookie is
  // present (M-5, Architect §4.3); the owner (no client cookie) reads every
  // plan item.
  const access = resolveAccess(request.headers, env);
  const session = access.session;
  if (!session) {
    return json({ error: 'authentication required', code: 'unauthorized' }, 401);
  }

  const projects = await readJsonl(PROJECTS_FILE);
  const items = await readJsonl(PLAN_ITEMS_FILE);

  const projectId = url.searchParams.get('projectId');
  let filtered = items;
  if (projectId) {
    const project = projects.find((p) => p.id === projectId);
    if (!project) {
      return json({ error: 'project not found', code: 'not-found' }, 404);
    }
    if (!canReadClient(access, project.clientId)) {
      return json({ error: 'forbidden', code: 'forbidden' }, 403);
    }
    filtered = items.filter((i) => i.projectId === projectId);
  } else {
    const accessibleProjectIds = projects
      .filter((p) => canReadClient(access, p.clientId))
      .map((p) => p.id);
    filtered = items.filter((i) => accessibleProjectIds.includes(i.projectId));
  }

  filtered.sort((a, b) => (a.order || 0) - (b.order || 0));
  return json({ ok: true, planItems: filtered }, 200);
};

export const onRequestPost: any = async (ctx: any): Promise<Response> => {
  // The OWNER gate (M-4) before the "not implemented" answer, so the edge
  // twin answers the same way as the Vercel tree for a non-owner.
  const owner = resolveOwnerSession(ctx?.request?.headers, ctx?.env, ctx?.env);
  if (!owner) {
    return json({ error: 'forbidden', code: 'forbidden' }, 403);
  }
  return json({ error: 'not implemented on CF target', code: 'unimplemented' }, 501);
};

export const onRequestPatch: any = async (ctx: any): Promise<Response> => {
  // The OWNER gate (M-4) before the "not implemented" answer, so the edge
  // twin answers the same way as the Vercel tree for a non-owner.
  const owner = resolveOwnerSession(ctx?.request?.headers, ctx?.env, ctx?.env);
  if (!owner) {
    return json({ error: 'forbidden', code: 'forbidden' }, 403);
  }
  return json({ error: 'not implemented on CF target', code: 'unimplemented' }, 501);
};

// A corrupt store must never look like an empty one (audit M3 / QA D3).
export const onRequestGet: any = async (ctx: any): Promise<Response> =>
  guardStorage(
    () => handleGet(ctx),
    (err) => {
      console.log(
        JSON.stringify({
          ts: Date.now(),
          outcome: 'storage_corrupt',
          file: err.file,
          line: err.line,
        }),
      );
      return json({ error: 'storage unavailable', code: 'storage' }, 500);
    },
  );
