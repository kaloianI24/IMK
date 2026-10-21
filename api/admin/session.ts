// api/admin/session.ts — Vercel serverless function.
//   GET /api/admin/session — "is this request the owner?"
//
// WHY A SEPARATE ENDPOINT (spec/07 §7.3, task T7.14)
//   /admin is the OWNER's inbox: the pending quotes to approve or reject, and
//   the client notes to resolve. It is a route of its own, separate from
//   /portal, so no admin capability can leak into the client-facing code path
//   (spec/07 §7.3: "Mixing admin routes under /portal risks leaking admin UI
//   into client code paths").
//
// THE ADMIN GATE IS TWO CHECKS, NOT ONE
//   1. the session cookie resolves to a session whose role is `admin`, and
//   2. the session's email is on the ADMIN_EMAILS allow-list.
//
//   Both are required. The session is a SIGNED token
//   (site/shared/server/portal-session.ts) that stays valid for 24 hours, so
//   the allow-list has to be read on EVERY request: taking an address off
//   ADMIN_EMAILS revokes access immediately, not at the next token expiry.
//
// EVERY NON-OWNER GETS THE SAME ANSWER
//   Not signed in, a client session, a forged cookie and an address that is no
//   longer allow-listed all answer 401 {code:'unauthorized'}. One answer for
//   every state, so the endpoint cannot be used to tell them apart.
//
// THE COOKIE IS A SEPARATE ONE
//   The owner session lives in `imk_admin_session`, the client session in
//   `imk_session` (spec/07 §7.3, A-9). resolveSession(req, 'admin') prefers
//   the admin cookie; a client cookie can never satisfy this gate, because
//   the role is checked as well.

import { IncomingMessage, ServerResponse } from 'node:http';
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
 * An unset or empty ADMIN_EMAILS means NOBODY is the owner: the list is empty
 * so nothing matches. It never means "everyone" — an unset allow-list would
 * hand the inbox to whoever asks for it.
 */
export function isAdminEmail(email: string, env: AdminEnv): boolean {
  const list = String(env.ADMIN_EMAILS || '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  if (list.length === 0) return false;
  return list.includes(String(email || '').trim().toLowerCase());
}

/**
 * Is the allow-list configured at all?
 *
 * An unset list is a MISCONFIGURATION (the owner has no way in), not a
 * "nobody is allowed" state: the two are told apart by the status code —
 * 500 {code:'internal'} for the first, 401 for the second.
 */
export function adminEmailsConfigured(env: AdminEnv): boolean {
  return String(env.ADMIN_EMAILS || '').trim() !== '';
}

/**
 * Resolve the OWNER session for a request.
 *
 * Returns null for every state that is not the owner. The allow-list is
 * consulted here, on every call, so a session that was minted while the
 * address was still on the list stops working the moment it is removed.
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

function json(
  res: ServerResponse,
  body: any,
  status = 200,
  extra: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    ...extra,
  });
  res.end(payload);
}

async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;
  const method = req.method || 'GET';

  if (pathname !== '/api/admin/session') {
    json(res, { error: 'not found', code: 'not-found' }, 404);
    return;
  }

  if (method !== 'GET') {
    json(res, { error: 'method not allowed', code: 'method' }, 405, { Allow: 'GET' });
    return;
  }

  if (!adminEmailsConfigured(process.env)) {
    console.log(
      JSON.stringify({
        ts: Date.now(),
        outcome: 'admin_misconfigured',
        reason: 'ADMIN_EMAILS missing',
      }),
    );
    json(res, { error: 'misconfigured', code: 'internal' }, 500);
    return;
  }

  const session = resolveAdmin(req, process.env);
  if (!session) {
    json(res, { error: 'unauthorized', code: 'unauthorized' }, 401);
    return;
  }

  json(res, { ok: true, role: 'admin', email: session.email }, 200);
}

export default function (
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  return handler(req, res);
}
