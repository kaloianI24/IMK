// api/portal/session.ts — Vercel serverless function AND shared module.
//
//   GET /api/portal/session — "who am I?"
//
// THE IMPLEMENTATION IS SHARED (audit wave-6, F-2)
//   The session logic lives in site/shared/server/portal-session.ts and is
//   imported by the Cloudflare twin as well, so the two trees cannot drift
//   apart on a security contract — and so a session minted on one target is
//   accepted by the other.
//
//   The session used to be a module-scope `Map` in THIS file. Vercel builds
//   one function per file under api/, so /api/portal/auth/verify and
//   /api/portal/projects each got their own copy of the Map: the cookie the
//   verify function issued was refused by the projects function with
//   401 {code:'unauthorized'}, and no client could ever sign in. The session
//   is now a SIGNED token — stateless, per instance, per cold start, per
//   bundle.
//
//   The module has no `node:` imports, so it also loads in the edge runtime.
//
//   This file is a thin re-export: the Vercel tree calls the session API
//   without an explicit environment, which defaults to `process.env`.
//
// WHY A ROUTE LIVES HERE (Architect §4.2, wave-8A)
//   The portal's owner UI used to be driven by `sessionStorage`, so a new tab
//   showed the CLIENT view while the cookie said admin — and the API
//   correctly answered 403. The screen lied; the API was right.
//
//   This endpoint is the server truth. It answers
//     200 {ok:true, authenticated:true, role:'admin'|'client', email, clientId?, expiresAt}
//   and nothing else about the session. It never exposes another client's
//   data: it reports the REQUESTER's own role.
//
//   The role is computed from TWO facts (the audit's M-4 and the Architect's
//   §4.2):
//     1. the role CLAIM inside the signed token, and
//     2. the LIVE `ADMIN_EMAILS` allow-list.
//   An owner whose address was taken off the list is answered `client` — the
//   owner powers are gone at once, exactly as they are for /admin.
//
//   The CLIENT cookie is resolved first (M-5, Architect §4.3): a browser that
//   holds both cookies is a client here, so this answer and the read
//   endpoints' scope can never disagree.
//
//   Other answers:
//     401 {error:'authentication required', code:'unauthorized'}  no session
//     405 {error:'method not allowed', code:'method'}             wrong method
//     500 {error:'misconfigured', code:'internal'}                ADMIN_EMAILS unset
//
//   It also makes this file a REAL Vercel function instead of one of the
//   four dead ones (a module under api/ with no default export is built as
//   a function whose URL answers 500).

import { IncomingMessage, ServerResponse } from 'node:http';
import {
  readSessionCookies,
  parseSession,
  effectiveRole,
  adminEmailsConfigured,
  sessionSecretConfigured,
  sessionSecretProblem,
  type EnvLike,
  type Session,
} from '../../site/shared/server/portal-session.js';

export * from '../../site/shared/server/portal-session.js';

/**
 * The session this request IS.
 *
 * The CLIENT cookie first, the admin cookie second (M-5, Architect §4.3):
 * a browser that holds both is a client here, so the answer the UI paints
 * and the answer the read endpoints return cannot disagree.
 *
 * An admin session whose address is no longer on the allow-list still
 * resolves — it is a valid session, only the owner powers are gone — so it
 * is downgraded to `client` by `effectiveRole` below, not refused.
 */
function resolveRequester(source: any, env: EnvLike): Session | null {
  const cookies = readSessionCookies(source);
  const client = cookies.client ? parseSession(cookies.client, env) : null;
  if (client) return client;
  const admin = cookies.admin ? parseSession(cookies.admin, env) : null;
  return admin;
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
    'Cache-Control': 'no-store',
    ...extra,
  });
  res.end(payload);
}

async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
  const method = (req.method || 'GET').toUpperCase();

  if (url.pathname !== '/api/portal/session') {
    json(res, { error: 'not found', code: 'not-found' }, 404);
    return;
  }

  if (method !== 'GET') {
    json(res, { error: 'method not allowed', code: 'method' }, 405, { Allow: 'GET' });
    return;
  }

  // An unset allow-list is a MISCONFIGURATION, not "nobody is the owner":
  // the two are told apart by the status code (500 here, 401 below).
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

  // A deployment that cannot VERIFY a session must say so loudly (H-2).
  //
  // Without a usable PORTAL_SESSION_SECRET the session cannot be validated at
  // all: in production the shared module refuses the published placeholder and
  // anything shorter than 32 characters, and there is no per-process random
  // fallback — so every cookie is simply unreadable. Answering 401 here would
  // be the EXACT silent symptom H-2 was about: the browser would show
  // "signed out" while the real cause is a broken deployment, and the owner
  // would sign in again and again with no error anywhere.
  //
  // 500 {code:'internal'} is the loud answer; 401 {code:'unauthorized'} is
  // reserved for "nobody is signed in" (below), which the browser's portal
  // page reads as the sign-in state.
  if (!sessionSecretConfigured(process.env)) {
    console.log(
      JSON.stringify({
        ts: Date.now(),
        outcome: 'session_misconfigured',
        // The precise reason (H-1): 'missing', 'placeholder' or 'too-short'.
        reason: `PORTAL_SESSION_SECRET ${sessionSecretProblem(process.env)}`,
      }),
    );
    json(res, { error: 'misconfigured', code: 'internal' }, 500);
    return;
  }

  const session = resolveRequester(req, process.env);
  if (!session) {
    json(res, { error: 'authentication required', code: 'unauthorized' }, 401);
    return;
  }

  // The role is computed from TWO facts (M-4, Architect §4.2): the role
  // claim inside the signed token AND the live ADMIN_EMAILS allow-list. An
  // owner whose address was taken off the list is answered `client` — the
  // owner powers are gone at once, exactly as they are for /admin.
  const role = effectiveRole(session, process.env);

  json(
    res,
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

export default function (
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  return handler(req, res);
}
