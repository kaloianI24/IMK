// site/functions/api/portal/auth.ts — Cloudflare Pages Function.
//   POST /api/portal/auth/request-link  — request magic-link sign-in
//   GET  /api/portal/auth/verify         — verify token, set session cookie
//   POST /api/portal/auth/logout        — clear session cookie

import {
  sessionCookieString,
  clearSessionCookieString,
  createSession,
  destroySession,
  readSessionCookies,
  sessionSecretConfigured,
  baseUrl,
  isSecureBaseUrl,
  expectedOrigin,
  baseUrlConfigured,
  isProductionEnv,
  sessionSecretProblem,
} from '../../shared/server/portal-session.js';
import { secretProblem } from '../../shared/server/secret.js';
import { platformAddress } from '../../shared/server/platform-address.js';
import { parseJsonlStrict, guardStorage } from '../../shared/portal-store/jsonl.js';
import { createPortalRateLimiter } from '../lib/rate-limit.js';
import {
  createMagicToken,
  verifyMagicToken,
  consumeMagicToken,
  magicLinkMisconfigured,
  magicLinkUrl,
  PORTAL_MAGIC_PURPOSE,
} from '../../shared/server/magic-link.js';

const RATE_LIMIT = 5; // per hour per IP
const RATE_LIMIT_WINDOW_MS = 3600 * 1000;

// Production unless the environment says otherwise.
//
// H-2 (wave-8A): the rule used to be `(env.APP_ENV || 'production') === 'production'`,
// which meant `APP_ENV=development` alone switched EVERY fail-closed guard
// off — including the one that keeps a live sign-in token out of the log. The
// shipped example file set exactly that one variable, so a deployed instance
// printed sign-in links to its log.
//
// The shared rule (site/shared/server/portal-session.ts) is used instead, and
// it is ONE definition for the whole project: a deployment is PRODUCTION when
// APP_ENV is unset or unknown, or when NODE_ENV=production, or VERCEL=1, or
// the base URL is an https:// URL. Only an explicit APP_ENV=development on a
// machine that is not deployed is DEVELOPMENT.
const isProd = (env: { [key: string]: string | undefined }): boolean =>
  isProductionEnv(env as any);

const INVITED_FILE = 'site/data/portal/invited.jsonl';

// NOTE: there is NO magic-token table here any more.
//
// The token used to live in a `globalThis` map that the request-link route
// filled and the verify route read. That works only inside ONE isolate; the
// Cloudflare edge runs one isolate per colo, so a link verified in another
// colo was rejected. The token is now SELF-CONTAINED and signed with
// PORTAL_MAGIC_LINK_SECRET (site/shared/server/magic-link.ts — the SAME
// module the Vercel tree uses): it carries the address, the purpose, the
// expiry and a nonce, and the verifier recomputes the signature. No table, no
// shared state, no isolate. See that file for what "single use" means now.

function json(body: any, status = 200, extra: Record<string, string> = {}): Response {
  const payload = JSON.stringify(body);
  return new Response(payload, {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...extra },
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function isValidEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+$/.test(s) && !/[\r\n]/.test(s);
}

function fsModule(): any {
  return (globalThis as any).require ? (globalThis as any).require('node:fs') : null;
}

/**
 * Read a store file. A malformed line is an ERROR (audit M3 / QA D3): it must
 * not turn the invite list into an empty list, because "empty" reads as "this
 * client is not invited" — a silent sign-in outage for a real client.
 */
async function readJsonl(file: string): Promise<Array<Record<string, any>>> {
  const fs = fsModule();
  if (!fs) return [];
  if (!fs.existsSync(file)) return [];
  return parseJsonlStrict(fs.readFileSync(file, 'utf8'), file);
}

function isInvited(email: string, invited: Array<Record<string, any>>): boolean {
  return invited.some((r) => String(r.email).toLowerCase() === email.toLowerCase());
}

function isAdmin(email: string, env: { [key: string]: string | undefined }): boolean {
  const admins = (env.ADMIN_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return admins.includes(email.toLowerCase());
}

/**
 * Per-IP limiter for the sign-in link request.
 *
 * The slot is consumed by the ATTEMPT, not by a successful sign-in: this
 * endpoint is the only door into the portal, so an address that asks for
 * link after link is the thing being limited. KV-backed when the
 * KV_COUNTER binding exists, in-memory otherwise.
 */

/**
 * Send the sign-in link.
 *
 *   'sent'          — Resend accepted the message
 *   'dev'           — no API key and NOT production: the link was logged for
 *                     the developer (local only)
 *   'misconfigured' — no API key in production: the caller answers 500 and
 *                     the token is NEVER written to the log (audit M4)
 *   'failed'        — Resend rejected the message (e.g. unverified sender)
 */
async function sendMagicLinkEmail(
  email: string,
  token: string,
  purpose: string,
  env: { [key: string]: string | undefined },
): Promise<'sent' | 'dev' | 'misconfigured' | 'failed'> {
  const apiKey = env.RESEND_API_KEY;
  const to = email;
  const base = baseUrl(env);
  const verifyUrl = magicLinkUrl(base, token, purpose);

  if (!apiKey) {
    if (isProd(env)) {
      // The token IS the client session's bearer credential. Logging it in
      // production would hand a live sign-in link to anyone with log access.
      console.log(
        JSON.stringify({
          ts: Date.now(),
          outcome: 'magic_link_misconfigured',
          reason: 'RESEND_API_KEY missing',
          email: email.replace(/^(.{2}).*(@.*)$/, '$1***$2'),
        }),
      );
      return 'misconfigured';
    }
    console.log(
      JSON.stringify({
        ts: Date.now(),
        outcome: 'magic_link_dev',
        email,
        purpose,
        token,
        verifyUrl,
      }),
    );
    return 'dev';
  }

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: env.RESEND_FROM || 'IMK <2imk4support@gmail.com>',
        to: [to],
        subject: 'Your IMK portal sign-in link',
        html: `<p>Click to sign in to your IMK portal:</p><p><a href="${escapeHtml(verifyUrl)}">Sign in to portal</a></p><p style="color:#888;font-size:12px;">Link expires in 15 minutes.</p>`,
        text: `Click to sign in to your IMK portal:\n${verifyUrl}\nLink expires in 15 minutes.`,
      }),
    });
    if (!r.ok) {
      console.log(JSON.stringify({ ts: Date.now(), email, outcome: 'email_fail', status: r.status }));
      return 'failed';
    }
    return 'sent';
  } catch {
    console.log(JSON.stringify({ ts: Date.now(), email, outcome: 'email_error' }));
    return 'failed';
  }
}

const handlePost: any = async (ctx: any): Promise<Response> => {
  const { request, env } = ctx;
  const url = new URL(request.url);
  const pathname = url.pathname;
  // THE ADDRESS OF THE CALLER — the same rule as the Vercel tree
  // (site/shared/server/platform-address.ts). This runtime IS Cloudflare, so
  // `CF-Connecting-IP` is set and overwritten by the platform and is safe to
  // trust here; the old expression used the WHOLE `x-forwarded-for` chain as
  // the bucket key, which starts with whatever the client sent.
  const ip =
    platformAddress(
      (name) => request.headers.get(name),
      { trustCfConnectingIp: true },
    ) || 'unknown';

  // ---- POST /api/portal/auth/request-link ----
  if (pathname === '/api/portal/auth/request-link') {
    // A production instance without SITE_BASE_URL/SITE_URL cannot answer a
    // correct origin check and cannot build a usable sign-in link (audit m4).
    if (!baseUrlConfigured(env)) {
      return json({ error: 'misconfigured', code: 'internal' }, 500);
    }

    const origin = request.headers.get('origin') || '';
    if (origin !== expectedOrigin(env)) {
      return json({ error: 'origin required', code: 'origin' }, 403);
    }

    const linkDecision = await createPortalRateLimiter(env).consume(
      `ip:${ip}`,
      RATE_LIMIT,
      RATE_LIMIT_WINDOW_MS,
    );
    if (!linkDecision.allowed) {
      return json({ error: 'too many requests', code: 'rate-limit' }, 429, { 'Retry-After': '3600' });
    }

    let body: { email?: string };
    try {
      body = await request.json().catch(() => ({}));
    } catch {
      return json({ error: 'invalid payload', code: 'validation' }, 400);
    }

    const email = String(body.email || '').trim().toLowerCase();
    if (!isValidEmail(email)) {
      return json({ error: 'validation failed', code: 'validation', fields: ['email'] }, 400);
    }

    // Production without a mail provider is a misconfiguration, not a silent
    // no-op: without an e-mail the client can never sign in. The check runs
    // BEFORE the invite lookup, so every address gets the same answer and the
    // endpoint still cannot be used to discover who is invited (P-7).
    if (isProd(env) && !env.RESEND_API_KEY) {
      console.log(
        JSON.stringify({
          ts: Date.now(),
          outcome: 'magic_link_misconfigured',
          reason: 'RESEND_API_KEY missing',
        }),
      );
      return json({ error: 'misconfigured', code: 'internal' }, 500);
    }

    // The invite list decides whether a link may be sent. On the edge
    // target the store cannot be read, and "nobody is invited" must not be
    // reported as a normal answer (audit M3 / QA D3). The rate limiter
    // above still runs, so the door stays protected.
    if (!fsModule()) {
      return json({ error: 'not implemented on CF target', code: 'unimplemented' }, 501);
    }

    // A production instance without PORTAL_MAGIC_LINK_SECRET cannot mint a
    // token anybody could verify: an empty HMAC key is a public key. Fail
    // closed, for EVERY address, so the answer cannot be used to find out who
    // is invited (P-7).
    //
    // It runs AFTER the store check: on the edge there is no store, so no
    // token can be minted there at all and 501 (the target cannot serve the
    // portal) stays the honest answer.
    if (magicLinkMisconfigured(env)) {
      console.log(
        JSON.stringify({
          ts: Date.now(),
          outcome: 'magic_link_misconfigured',
          // The precise reason (H-1): 'missing', 'placeholder' or
          // 'too-short'. The operator needs to know whether to paste a new
          // value or to generate one.
          reason: `PORTAL_MAGIC_LINK_SECRET ${secretProblem(env.PORTAL_MAGIC_LINK_SECRET)}`,
        }),
      );
      return json({ error: 'misconfigured', code: 'internal' }, 500);
    }

    // A deployment that cannot SIGN a session must not send a sign-in link:
    // the link would lead to a dead end. The session is a signed token now
    // (audit wave-6, F-2), and a missing secret in production is a
    // misconfiguration, never a per-isolate fallback.
    if (!sessionSecretConfigured(env)) {
      console.log(
        JSON.stringify({
          ts: Date.now(),
          outcome: 'session_misconfigured',
          // The precise reason (H-1): 'missing', 'placeholder' or
          // 'too-short'.
          reason: `PORTAL_SESSION_SECRET ${sessionSecretProblem(env)}`,
        }),
      );
      return json({ error: 'misconfigured', code: 'internal' }, 500);
    }

    const invited = await readJsonl(INVITED_FILE);
    const allowed = isInvited(email, invited) || isAdmin(email, env);

    if (allowed) {
      const token = await createMagicToken(email, PORTAL_MAGIC_PURPOSE, env);
      if (!token) {
        console.log(
          JSON.stringify({
            ts: Date.now(),
            outcome: 'magic_link_misconfigured',
            // The precise reason (H-1): 'missing', 'placeholder' or
            // 'too-short'.
            reason: `PORTAL_MAGIC_LINK_SECRET ${secretProblem(env.PORTAL_MAGIC_LINK_SECRET)}`,
          }),
        );
        return json({ error: 'misconfigured', code: 'internal' }, 500);
      }
      const outcome = await sendMagicLinkEmail(email, token, PORTAL_MAGIC_PURPOSE, env);
      if (outcome === 'misconfigured') {
        return json({ error: 'misconfigured', code: 'internal' }, 500);
      }
    }

    console.log(
      JSON.stringify({
        ts: Date.now(),
        outcome: 'magic_link_requested',
        ipHash: 'hashed',
        allowed,
      }),
    );

    return json({
      ok: true,
      message: 'If you have an invitation, a sign-in link has been sent.',
    }, 200);
  }

  // ---- POST /api/portal/auth/logout ----
  if (pathname === '/api/portal/auth/logout') {
    // BOTH cookies are cleared and both sessions destroyed (audit m5).
    const cookies = readSessionCookies(request.headers);
    for (const token of [cookies.admin, cookies.client]) {
      if (token) destroySession(token);
    }

    const headers = new Headers({
      'Content-Type': 'application/json; charset=utf-8',
    });
    headers.append('Set-Cookie', clearSessionCookieString('admin'));
    headers.append('Set-Cookie', clearSessionCookieString('client'));
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
  }

  return json({ error: 'not found', code: 'not-found' }, 404);
};

const handleGet: any = async (ctx: any): Promise<Response> => {
  const { request, env } = ctx;
  const url = new URL(request.url);
  const pathname = url.pathname;

  // ---- GET /api/portal/auth/verify ----
  if (pathname === '/api/portal/auth/verify') {
    // Without a configured base URL the session cookie would be issued
    // WITHOUT `Secure` (audit m4).
    if (!baseUrlConfigured(env)) {
      return json({ error: 'misconfigured', code: 'internal' }, 500);
    }

    const token = url.searchParams.get('token');
    const purpose = url.searchParams.get('purpose') || PORTAL_MAGIC_PURPOSE;

    if (!token) {
      return json({ error: 'missing token', code: 'validation' }, 400);
    }

    // A production instance without PORTAL_MAGIC_LINK_SECRET must not verify
    // anything: with an empty key a forged token would validate. Fail closed.
    if (magicLinkMisconfigured(env)) {
      console.log(
        JSON.stringify({
          ts: Date.now(),
          outcome: 'magic_link_misconfigured',
          // The precise reason (H-1): 'missing', 'placeholder' or
          // 'too-short'. The operator needs to know whether to paste a new
          // value or to generate one.
          reason: `PORTAL_MAGIC_LINK_SECRET ${secretProblem(env.PORTAL_MAGIC_LINK_SECRET)}`,
        }),
      );
      return json({ error: 'misconfigured', code: 'internal' }, 500);
    }

    // The same rule for the SESSION: it is a signed token now (audit wave-6,
    // F-2), so without a signing secret no session can be minted. The check
    // runs BEFORE the magic token is consumed, so a misconfigured deployment
    // does not burn the client's only link.
    if (!sessionSecretConfigured(env)) {
      console.log(
        JSON.stringify({
          ts: Date.now(),
          outcome: 'session_misconfigured',
          // The precise reason (H-1): 'missing', 'placeholder' or
          // 'too-short'.
          reason: `PORTAL_SESSION_SECRET ${sessionSecretProblem(env)}`,
        }),
      );
      return json({ error: 'misconfigured', code: 'internal' }, 500);
    }

    // The token is self-contained: the signature is recomputed from the
    // secret, so this route needs no table and no state from the route that
    // minted the token.
    const validation = await verifyMagicToken(token, purpose, env);
    if (!validation.valid) {
      if (validation.reason === 'misconfigured') {
        return json({ error: 'misconfigured', code: 'internal' }, 500);
      }
      return json({ error: 'link expired or invalid', code: 'invalid' }, 400);
    }

    // Single use — PER INSTANCE (per isolate here). The used-token register
    // lives on globalThis, so a second verification of the same link that
    // lands on THIS isolate is refused; one that lands in another colo is
    // not, and the register is lost on a cold start. Durable single use
    // arrives with the shared store (T4).
    const consumed = await consumeMagicToken(token, validation.exp!);
    if (!consumed) {
      return json({ error: 'link expired or invalid', code: 'invalid' }, 400);
    }

    const email = validation.email!;
    const role = isAdmin(email, env) ? 'admin' : 'client';

    let clientId: string | undefined;
    if (role === 'client') {
      // Same rule as the request-link path: an unreachable store is not an
      // empty invite list (audit M3 / QA D3).
      if (!fsModule()) {
        return json({ error: 'not implemented on CF target', code: 'unimplemented' }, 501);
      }
      const invited = await readJsonl(INVITED_FILE);
      const inviteRecord = invited.find((r) => String(r.email).toLowerCase() === email.toLowerCase());
      clientId = inviteRecord?.clientId;
      // Note: creating client records on first login requires filesystem write;
      // CF mirror defers client record creation to the Vercel target.
    }

    // The session is a SIGNED token (audit wave-6, F-2): it carries the
    // session and the signature is the proof, so no other function and no
    // other isolate has to share state with this one. createSession returns
    // null when there is no signing secret — a misconfiguration, never a
    // session only this isolate can read.
    const sessionToken = createSession(email, role, clientId, env);
    if (!sessionToken) {
      console.log(
        JSON.stringify({
          ts: Date.now(),
          outcome: 'session_misconfigured',
          // The precise reason (H-1): 'missing', 'placeholder' or
          // 'too-short'.
          reason: `PORTAL_SESSION_SECRET ${sessionSecretProblem(env)}`,
        }),
      );
      return json({ error: 'misconfigured', code: 'internal' }, 500);
    }
    const isSecure = isSecureBaseUrl(env);

    return new Response(JSON.stringify({ ok: true, role, email }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Set-Cookie': sessionCookieString(sessionToken, role, isSecure),
      },
    });
  }

  return json({ error: 'not found', code: 'not-found' }, 404);
};

// A corrupt invite store must not look like "this client is not invited"
// (audit M3 / QA D3) — that locks a real client out while the owner sees a
// normal 200. Answer 500 {code:'storage'} and name the file and line.
const storageError = (err: { file: string; line: number }): Response => {
  console.log(
    JSON.stringify({
      ts: Date.now(),
      outcome: 'storage_corrupt',
      file: err.file,
      line: err.line,
    }),
  );
  return json({ error: 'storage unavailable', code: 'storage' }, 500);
};

export const onRequestPost: any = async (ctx: any): Promise<Response> =>
  guardStorage(() => handlePost(ctx), storageError);

export const onRequestGet: any = async (ctx: any): Promise<Response> =>
  guardStorage(() => handleGet(ctx), storageError);
