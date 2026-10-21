// site/functions/api/portal/session.ts — Cloudflare Pages Function AND
// shared module.
//   GET /api/portal/session — "who am I?"
//
// THE CLOUDFLARE TWIN OF api/portal/session.ts (spec/07 §1, D-6: the two
// trees must answer the same way for the same input).
//
// THE IMPLEMENTATION IS SHARED (audit wave-6, F-2)
//   The session logic lives in site/shared/server/portal-session.ts and is
//   imported by the Vercel tree as well, so the two trees cannot drift
//   apart on a security contract — and so a session minted on one target is
//   accepted by the other.
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
//   This file is the shared module AND the route. The other Cloudflare
//   handlers import the session API from here ('./session.js'), so the
//   re-export below is what they use — and the route handlers below are
//   what Cloudflare Pages serves at /api/portal/session.
//
// THE CONTRACT (Architect §4.2, wave-8A)
//   200 {ok:true, authenticated:true, role:'admin'|'client', email, clientId?, expiresAt}
//   401 {error:'authentication required', code:'unauthorized'}   no session
//   405 {error:'method not allowed', code:'method'}              wrong method
//   500 {error:'misconfigured', code:'internal'}                 ADMIN_EMAILS unset
//
//   The role comes from TWO facts: the role CLAIM in the signed token AND
//   the LIVE ADMIN_EMAILS allow-list. The CLIENT cookie is resolved first
//   (M-5, Architect §4.3), so this answer and the read endpoints' scope can
//   never disagree.
//
//   It never exposes another client's data: it reports the REQUESTER's own
//   role.

import {
  readSessionCookies,
  parseSession,
  effectiveRole,
  adminEmailsConfigured,
  sessionSecretConfigured,
  sessionSecretProblem,
  type EnvLike,
  type Session,
} from '../../../shared/server/portal-session.js';

export * from '../../../shared/server/portal-session.js';

function json(body: any, status = 200, extra: Record<string, string> = {}): Response {
  const payload = JSON.stringify(body);
  return new Response(payload, {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extra,
    },
  });
}

/**
 * The session this request IS.
 *
 * The CLIENT cookie first, the admin cookie second (M-5, Architect §4.3).
 * An admin session whose address is no longer on the allow-list still
 * resolves — it is downgraded to `client` by `effectiveRole`, not refused.
 */
function resolveRequester(source: any, env: EnvLike): Session | null {
  const cookies = readSessionCookies(source);
  const client = cookies.client ? parseSession(cookies.client, env) : null;
  if (client) return client;
  const admin = cookies.admin ? parseSession(cookies.admin, env) : null;
  return admin;
}

/**
 * The shared body of the route.
 *
 * The signing secret comes from the request's `env` — a Worker has no
 * process.env.
 */
async function handle(ctx: any): Promise<Response> {
  const { request, env } = ctx;

  // An unset allow-list is a MISCONFIGURATION, not "nobody is the owner":
  // the two are told apart by the status code (500 here, 401 below).
  if (!adminEmailsConfigured(env)) {
    console.log(
      JSON.stringify({
        ts: Date.now(),
        outcome: 'admin_misconfigured',
        reason: 'ADMIN_EMAILS missing',
      }),
    );
    return json({ error: 'misconfigured', code: 'internal' }, 500);
  }

  // A deployment that cannot VERIFY a session must say so loudly (H-2).
  // The Vercel twin answers the same thing for the same reason: without a
  // usable PORTAL_SESSION_SECRET every cookie is unreadable, and a 401 would
  // be the silent "signed out" symptom instead of a loud misconfiguration.
  if (!sessionSecretConfigured(env)) {
    console.log(
      JSON.stringify({
        ts: Date.now(),
        outcome: 'session_misconfigured',
        // The precise reason (H-1): 'missing', 'placeholder' or 'too-short'.
        reason: `PORTAL_SESSION_SECRET ${sessionSecretProblem(env)}`,
      }),
    );
    return json({ error: 'misconfigured', code: 'internal' }, 500);
  }

  const session = resolveRequester(request.headers, env);
  if (!session) {
    return json({ error: 'authentication required', code: 'unauthorized' }, 401);
  }

  const role = effectiveRole(session, env);

  return json(
    {
      ok: true,
      authenticated: true,
      role,
      email: session.email,
      ...(session.clientId ? { clientId: session.clientId } : {}),
      ...(typeof session.expiresAt === 'number' ? { expiresAt: session.expiresAt } : {}),
    },
    200,
  );
}

/** GET — the server truth about this request. */
export const onRequestGet: any = async (ctx: any): Promise<Response> => handle(ctx);

/**
 * Every other method is refused with 405 — the DEPLOY.md convention, and the
 * same answer the Vercel twin gives.
 */
export const onRequest: any = async (ctx: any): Promise<Response> => {
  const method = String(ctx?.request?.method || 'GET').toUpperCase();
  if (method === 'GET') return handle(ctx);
  return json({ error: 'method not allowed', code: 'method' }, 405, { Allow: 'GET' });
};
