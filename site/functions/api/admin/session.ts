// site/functions/api/admin/session.ts — Cloudflare Pages Function.
//   GET /api/admin/session — "is this request the owner?"
//
//   A SEPARATE COPY of the Vercel module
//   site/shared/portal-handlers/admin-session.ts. The two files are NOT the
//   same code: an edit to the Vercel module does NOT reach this file, and
//   this file does NOT import it. Change the Vercel module and change THIS
//   file too.
//
// THE CLOUDFLARE TWIN OF site/shared/portal-handlers/admin-session.ts (spec/07 §1, D-6: the two trees
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
//   site/shared/portal-handlers/admin-reviews.ts imports the helpers below from './session.js'. On
//   Cloudflare every file under functions/ is a route, so the gate cannot live
//   in a separate module file without adding a route that does not exist;
//   here it rides along with the route that needs it, and the Vercel tree does
//   the same thing (site/shared/portal-handlers/admin-reviews.ts imports './session.js').

import {
  resolveOwnerSession,
  isAdminEmail as isAdminEmailShared,
  adminEmailsConfigured as adminEmailsConfiguredShared,
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
 *
 * The rule lives in the SHARED module (site/shared/server/portal-session.ts)
 * so /admin and /portal cannot drift apart on it — that is the whole point
 * of the M-4 fix: the two halves of the owner story have to agree.
 */
export function isAdminEmail(email: string, env: AdminEnv): boolean {
  return isAdminEmailShared(email, env as any);
}

/**
 * Is the allow-list configured at all?
 *
 * A list that is set but EMPTY AFTER PARSING (" , ") counts as
 * misconfigured too: it is the same mistake written differently. The owner
 * has no way in either way, and the two are told apart by the status code —
 * 500 {code:'internal'} for the first, 401 for the second.
 */
export function adminEmailsConfigured(env: AdminEnv): boolean {
  return adminEmailsConfiguredShared(env as any);
}

/**
 * Resolve the OWNER session for a request.
 *
 * `sessionEnv` is the Worker's env: the signing secret lives there, and the
 * Vercel twin leaves it undefined so the module falls back to process.env.
 *
 * This is the SHARED two-part gate (site/shared/server/portal-session.ts) —
 * the same one the portal's owner-only actions use (M-4), so /admin and
 * /portal answer the same way for the same request.
 */
export function resolveAdmin(
  source: SessionSource,
  env: AdminEnv,
  sessionEnv?: any,
): Session | null {
  return resolveOwnerSession(source, env as any, sessionEnv);
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
