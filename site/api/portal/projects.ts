// site/functions/api/portal/projects.ts — Cloudflare Pages Function.
//   GET    /api/portal/projects        — list projects
//   GET    /api/portal/projects/:id    — get single project
//   POST   /api/portal/projects        — create project (owner only, deferred)
//   PATCH  /api/portal/projects/:id    — update project status (owner only, deferred)

import { resolveAccess, resolveOwnerSession, canReadClient, expectedOrigin } from '../../../shared/server/portal-session.js';
import { parseJsonlStrict, guardStorage } from '../../../shared/portal-store/jsonl.js';

const PROJECTS_FILE = 'site/data/portal/projects.jsonl';



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
 * project" — a silent outage wearing the costume of a normal answer.
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
  const pathname = url.pathname;

  // No writable filesystem on the edge target. "The store is empty" and
  // "the store is unreachable" are different answers: the second one used
  // to be reported as an empty project list, which reads as a normal answer
  // (audit M3 / QA D3). The write paths already say 501; the read path now
  // says the same.
  if (!fsModule()) {
    return json({ error: 'not implemented on CF target', code: 'unimplemented' }, 501);
  }

  // The signing secret comes from the request's env — a Worker has no
  // process.env (audit wave-6, F-2: one shared, stateless session module).
  //
  // The READ scope is the client's own, even when an owner cookie is
  // present (M-5, Architect §4.3); the owner (no client cookie) reads every
  // project.
  const access = resolveAccess(request.headers, env);
  const session = access.session;

  // Nobody is signed in at all -> 401, on every path.
  if (!access.any) {
    return json({ error: 'authentication required', code: 'unauthorized' }, 401);
  }

  // The READ scope: a client session, or the owner gate (Architect §4.3).
  if (!session) {
    return json({ error: 'authentication required', code: 'unauthorized' }, 401);
  }

  const projects = await readJsonl(PROJECTS_FILE);

  if (pathname === '/api/portal/projects') {
    const visible = projects.filter((p) => canReadClient(access, p.clientId));
    return json({ ok: true, projects: visible }, 200);
  }

  const projectIdMatch = pathname.match(/^\/api\/portal\/projects\/([^\/]+)$/);
  if (projectIdMatch) {
    const projectId = projectIdMatch[1];
    const project = projects.find((p) => p.id === projectId);
    if (!project) {
      return json({ error: 'project not found', code: 'not-found' }, 404);
    }
    if (!canReadClient(access, project.clientId)) {
      return json({ error: 'forbidden', code: 'forbidden' }, 403);
    }
    return json({ ok: true, project }, 200);
  }

  return json({ error: 'not found', code: 'not-found' }, 404);
};

export const onRequestPost: any = async (ctx: any): Promise<Response> => {
  const { request, env } = ctx;
  // The OWNER gate (M-4): the role claim AND the live allow-list. The
  // signing secret comes from the request's env — a Worker has no
  // process.env (audit wave-6, F-2: one shared, stateless session module).
  const owner = resolveOwnerSession(request.headers, env, env);
  if (!owner) {
    return json({ error: 'forbidden', code: 'forbidden' }, 403);
  }
  const origin = request.headers.get('origin') || '';
  if (origin !== expectedOrigin(env)) {
    return json({ error: 'origin required', code: 'origin' }, 403);
  }
  // Write not yet implemented on CF target (spec/08 §6: Vercel is interim).
  return json({ error: 'not implemented on CF target', code: 'unimplemented' }, 501);
};

export const onRequestPatch: any = async (ctx: any): Promise<Response> => {
  const { request, env } = ctx;
  // The OWNER gate (M-4): the role claim AND the live allow-list. The
  // signing secret comes from the request's env — a Worker has no
  // process.env (audit wave-6, F-2: one shared, stateless session module).
  const owner = resolveOwnerSession(request.headers, env, env);
  if (!owner) {
    return json({ error: 'forbidden', code: 'forbidden' }, 403);
  }
  const origin = request.headers.get('origin') || '';
  if (origin !== expectedOrigin(env)) {
    return json({ error: 'origin required', code: 'origin' }, 403);
  }
  // Write not yet implemented on CF target (spec/08 §6: Vercel is interim).
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
