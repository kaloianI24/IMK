import {
  resolveOwnerSession,
  isAdminEmail as isAdminEmailShared,
  adminEmailsConfigured as adminEmailsConfiguredShared,
  type Session,
  type SessionSource,
} from '../shared/server/portal-session.js';

function json(body: any, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...extra },
  });
}

export function isAdminEmail(email: string, env: any): boolean {
  return isAdminEmailShared(email, env as any);
}

export function adminEmailsConfigured(env: any): boolean {
  return adminEmailsConfiguredShared(env as any);
}

export function resolveAdmin(source: SessionSource, env: any, sessionEnv?: any): Session | null {
  return resolveOwnerSession(source, env as any, sessionEnv);
}

export const config = {
  runtime: 'edge',
};

export default async function handler(request: Request) {
  return onRequest({ request, env: process.env }, {});
}

export const onRequest: any = async (ctx: any): Promise<Response> => {
  const { request, env } = ctx;
  const url = new URL(request.url);
  const pathname = url.pathname;

  if (pathname === '/api/admin/session') {
    if (!adminEmailsConfigured(env)) return json({ error: 'misconfigured', code: 'internal' }, 500);
    const session = resolveAdmin(request.headers, env, env);
    if (!session) return json({ error: 'unauthorized', code: 'unauthorized' }, 401);
    return json({ ok: true, role: 'admin', email: session.email }, 200);
  }

  if (pathname === '/api/admin/reviews') {
    if (!adminEmailsConfigured(env)) return json({ error: 'misconfigured', code: 'internal' }, 500);
    const session = resolveAdmin(request.headers, env, env);
    if (!session) return json({ error: 'unauthorized', code: 'unauthorized' }, 401);
    return json({ error: 'moderation store unavailable on this target', code: 'unimplemented' }, 501);
  }

  return json({ error: 'not found', code: 'not-found' }, 404);
};
