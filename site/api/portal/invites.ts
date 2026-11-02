// site/functions/api/portal/invites.ts — Cloudflare Pages Function.
//   POST /api/portal/invites — invite a client by email (owner only, deferred)

import { resolveOwnerSession, expectedOrigin } from './session.js';

function json(body: any, status = 200, extra: Record<string, string> = {}): Response {
  const payload = JSON.stringify(body);
  return new Response(payload, {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...extra },
  });
}

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
