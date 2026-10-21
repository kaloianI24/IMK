// site/functions/api/admin/session.ts — Cloudflare Pages Function.
//   GET /api/admin/session — "is this request the owner?"
//
// THE CLOUDFLARE TWIN OF api/admin/session.ts (spec/07 §1, D-6: the two trees
// must answer the same way for the same input). The behaviour is identical:
//   - the owner session lives in `imk_admin_session`, not `imk_session`;
//   - the gate is TWO checks — an admin session AND an email on the
//     ADMIN_EMAILS allow-list, read on EVERY request, so removing an address
//     revokes access immediately;
//   - every non-owner gets the same answer: 401 {code:'unauthorized'}.
//
// WHAT IS DIFFERENT ON THE EDGE
//   The signing secret comes from the request's `env` — a Worker has no
//   process.env. It is the same stateless session module
//   (site/shared/server/portal-session.ts), so a session minted on either
//   target is accepted on both.
//
// THIS FILE ALSO HOLDS THE SHARED GATE
//   api/admin/reviews.ts imports the helpers below from './session.js'. On
//   Cloudflare every file under functions/ is a route, so the gate cannot live
//   in a separate module file without adding a route that does not exist;
//   here it rides along with the route that needs it, and the Vercel tree does
//   the same thing (api/admin/reviews.ts imports './session.js').

import {
  resolveSession,
  type EnvLike,
  type Session,
  type SessionSource,
} from '../portal/session.js';

/** The part of the environment the admin gate reads. */
export interface AdminEnv {
  ADMIN_EMAILS?: string;
}

/**
 * Is this email on the owner allow-list?
 *
 * An unset or empty ADMIN_EMAILS means NOBODY is the owner — never
 * "everyone". Same rule as the Vercel twin.
 */
export function isAdminEmail(email: string, env: AdminEnv): boolean {
  const list = String(env.ADMIN_EMAILS || '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  if (list.length === 0) return false;
  return list.includes(String(email || '').trim().toLowerCase());
}

/** Is the allow-list configured at all? */
export function adminEmailsConfigured(env: AdminEnv): boolean {
  return String(env.ADMIN_EMAILS || '').trim() !== '';
}

/**
 * Resolve the OWNER session for a request.
 *
 * `sessionEnv` is the Worker's env: the signing secret lives there, and the
 * Vercel twin leaves it undefined so the module falls back to process.env.
 */
export function resolveAdmin(
  source: SessionSource,
  env: AdminEnv,
  sessionEnv?: EnvLike,
): Session | null {
  const session = resolveSession(source, 'admin', sessionEnv);
  if (!session) return null;
  if (session.role !== 'admin') return null;
  if (!isAdminEmail(session.email, env)) return null;
  return session;
}

function json(body: any, status = 200, extra: Record<string, string> = {}): Response {
  const payload = JSON.stringify(body);
  return new Response(payload, {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...extra },
  });
}

export const onRequestGet: any = async (ctx: any): Promise<Response> => {
  const { request, env } = ctx;

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

  const session = resolveAdmin(request.headers, env, env);
  if (!session) {
    return json({ error: 'unauthorized', code: 'unauthorized' }, 401);
  }

  return json({ ok: true, role: 'admin', email: session.email }, 200);
};
