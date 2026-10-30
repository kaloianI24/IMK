// site/shared/portal-handlers/portal-auth.ts — the Vercel handler module.
//
// WHY IT MOVED (wave 13, function budget)
//   It used to be api/portal/auth.ts. A file under api/ is a Vercel
//   FUNCTION with a URL of its own, so the sign-in family cost three
//   function slots (the three auth/*.ts shims) plus this one. The module
//   body is unchanged; only its home is. The three shims under
//   api/portal/auth/ now re-export THIS module.
//   POST /api/portal/auth/request-link  — request magic-link sign-in
//   GET  /api/portal/auth/verify         — verify token, set session cookie
//   POST /api/portal/auth/logout        — clear session cookie
//
// Same-origin only; session cookie is HttpOnly SameSite=Strict.

import { IncomingMessage, ServerResponse } from 'node:http';
import * as crypto from 'node:crypto';
import {
  createSession,
  destroySession,
  readSessionCookies,
  sessionCookieString,
  clearSessionCookieString,
  sessionSecretConfigured,
  baseUrl,
  isSecureBaseUrl,
  expectedOrigin,
  baseUrlConfigured,
  isProductionEnv,
  sessionSecretProblem,
} from '../server/portal-session.js';
import {
  getPortalStore,
  guardStore,
  storageFailureLog,
  assertStoreReachable,
  StoreUnreachableError,
} from '../server/portal-store-access.js';
import { portalRateLimiter } from '../server/rate-limit.js';
import { secretProblem } from '../server/secret.js';
import {
  platformAddress as sharedPlatformAddress,
  trustCfConnectingIp,
} from '../server/platform-address.js';
import {
  createMagicToken,
  verifyMagicToken,
  consumeMagicToken,
  magicLinkMisconfigured,
  magicLinkUrl,
  PORTAL_MAGIC_PURPOSE,
} from '../server/magic-link.js';

const RATE_LIMIT = 5; // per hour per IP
const RATE_LIMIT_WINDOW_MS = 3600 * 1000;

// Production unless the environment says otherwise — the same convention as
// api/contact.ts. An unset APP_ENV must NOT be treated as development:
// a deployed instance with a missing RESEND_API_KEY would then print a live
// bearer token to its log (audit M4).
const isProd = isProductionEnv;

// THE STORE (wave 9)
//   The invite and client collections come from the PortalStore contract
//   (site/shared/portal-store/**), not from a JSONL file: with
//   PORTAL_STORE=libsql the portal persists on a read-only filesystem
//   (Vercel), and with PORTAL_STORE=file the very same records land in the
//   very same site/data/portal/*.jsonl files as before.

// NOTE: there is NO magic-token table here any more.
//
// The token used to live in a module-scope Map, which meant the token minted
// by the request-link function was invisible to the verify function: Vercel
// builds one function per file under api/, so each file got its own copy of
// the map. Every sign-in link died with 400 "link expired or invalid"
// (audit wave 4, F-1 — reproduced by execution).
//
// The token is now SELF-CONTAINED and signed with PORTAL_MAGIC_LINK_SECRET
// (site/shared/server/magic-link.ts): it carries the address, the purpose, the
// expiry and a nonce, and the verifier recomputes the signature. No table, no
// shared state, no process. See that file for what "single use" means now.

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

/**
 * Is this address invited?
 *
 * The invite list comes from the store. A corrupt store is an ERROR (audit
 * M3): it must not turn the invite list into an empty list, because "empty"
 * reads as "this client is not invited" — a silent sign-in outage for a real
 * client. The store raises in that case and the handler's guard answers
 * 500 {code:'storage'}.
 */
async function isInvited(
  store: { list: (coll: 'invites') => Promise<Array<Record<string, any>>> },
  email: string,
): Promise<boolean> {
  const invited = await store.list('invites');
  return invited.some((r) => String(r.email).toLowerCase() === email.toLowerCase());
}

function isAdmin(email: string): boolean {
  const admins = (process.env.ADMIN_EMAILS || '')
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
 * link after link is the thing being limited.
 */

/**
 * The bucket of THIS instance.
 *
 * Used when no platform-controlled address is available: a bucket per
 * instance, never one the client can choose (wave 10, F-5). It changes when
 * the instance recycles, and it is never derived from anything the client
 * sent.
 */
const INSTANCE_BUCKET = `instance:${crypto.randomUUID()}`;

/**
 * The address of the caller — but ONLY a platform-controlled one.
 *
 * The rate-limit bucket must not be something the CLIENT can choose: a client
 * that sends a different address on every request would get a fresh bucket
 * every time, so the limit would never be reached and the table of buckets
 * would grow without bound (wave 10, F-5).
 *
 * The rule lives in ONE module for both trees
 * (site/shared/server/platform-address.ts):
 *   - x-real-ip / x-vercel-forwarded-for: Vercel's own headers, set and
 *     overwritten by the platform.
 *   - x-forwarded-for: a CHAIN. The client may put its own address in front,
 *     but the platform APPENDS the address it saw — so the LAST hop is the
 *     platform's view, never the first.
 *   - cf-connecting-ip: set by CLOUDFLARE, and only by Cloudflare. The
 *     launch target is Vercel, which neither sets nor strips it, so a client
 *     that rotates it would get a fresh bucket per request — the limit would
 *     never be reached (audit MAJOR-2). It is therefore trusted ONLY when
 *     the deployment really is behind Cloudflare (TRUST_CF_CONNECTING_IP=1).
 *
 * When there is no trustworthy address (a local run, a target that sets
 * none) there is NO address, and the caller gets the per-instance bucket
 * instead: the limit is still enforced, it is simply not shared between
 * instances.
 */
function platformAddress(headers: IncomingMessage['headers']): string | null {
  return sharedPlatformAddress(
    (name) => {
      const value = headers[name];
      return typeof value === 'string' ? value : Array.isArray(value) ? value[0] : undefined;
    },
    { trustCfConnectingIp: trustCfConnectingIp(process.env) },
  );
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// The magic token itself lives in site/shared/server/magic-link.ts, shared
// with the Cloudflare twin. It is signed with PORTAL_MAGIC_LINK_SECRET and
// carries everything the verifier needs, so the verifier needs no state.

/**
 * Send the sign-in link.
 *
 *   'sent'          — Resend accepted the message
 *   'dev'           — no API key and NOT production: the link was logged for
 *                     the developer (local only)
 *   'misconfigured' — no API key in production: the caller answers 500 and
 *                     the token is NEVER written to the log (audit M4)
 *   'failed'        — Resend rejected the message (e.g. an unverified sender)
 */
async function sendMagicLinkEmail(
  email: string,
  token: string,
  purpose: string,
): Promise<'sent' | 'dev' | 'misconfigured' | 'failed'> {
  const apiKey = process.env.RESEND_API_KEY;
  const to = email;
  const base = baseUrl();
  const verifyUrl = magicLinkUrl(base, token, purpose);

  if (!apiKey) {
    if (isProd()) {
      // The token IS the client session's bearer credential. Logging it in
      // production would hand a live sign-in link to anyone with log access.
      // Fail loudly instead — the token stays out of the log.
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
        from: process.env.RESEND_FROM || 'IMK <2imk4support@gmail.com>',
        to: [to],
        subject: 'Your IMK portal sign-in link',
        html: `<p>Click to sign in to your IMK portal:</p><p><a href="${escapeHtml(verifyUrl)}">Sign in to portal</a></p><p style="color:#888;font-size:12px;">Link expires in 15 minutes.</p>`,
        text: `Click to sign in to your IMK portal:\n${verifyUrl}\nLink expires in 15 minutes.`,
      }),
    });
    if (!r.ok) {
      // A rejected message (unverified sender identity is the likely cause)
      // means the client never receives a link. Say so in the log.
      console.log(JSON.stringify({ ts: Date.now(), email, outcome: 'email_fail', status: r.status }));
      return 'failed';
    }
    return 'sent';
  } catch {
    console.log(JSON.stringify({ ts: Date.now(), email, outcome: 'email_error' }));
    return 'failed';
  }
}

async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;
  const method = req.method || 'GET';

  // THE STORE MUST BE THERE (wave 10, F-3).
  //
  // A store that is not there at all is NOT an empty store. Without this
  // check a deployment without a store answers 200 with "not invited" /
  // "no projects" / "no quote" — a silent outage wearing the costume of a
  // normal answer. The answer is 501 {code:'unimplemented'}: the same one
  // the moderation endpoint and the owner's inbox give for the same
  // situation (spec/07 §1, D-6 — the two trees must not disagree).
  try {
    assertStoreReachable();
  } catch (err) {
    if (err instanceof StoreUnreachableError) {
      console.log(JSON.stringify({ ts: Date.now(), outcome: 'portal_store_unreachable' }));
      json(res, { error: 'portal store unavailable on this target', code: 'unimplemented' }, 501);
      return;
    }
    throw err;
  }
  const ip = platformAddress(req.headers);

  // ---- POST /api/portal/auth/request-link ----
  if (pathname === '/api/portal/auth/request-link' && method === 'POST') {
    // A production instance without SITE_BASE_URL/SITE_URL cannot answer a
    // correct origin check and cannot build a usable sign-in link. Say so
    // instead of pretending the request was a CSRF attempt (audit m4).
    if (!baseUrlConfigured()) {
      json(res, { error: 'misconfigured', code: 'internal' }, 500);
      return;
    }

    const origin = (req.headers.origin as string | undefined) || '';
    if (origin !== expectedOrigin()) {
      json(res, { error: 'origin required', code: 'origin' }, 403);
      return;
    }

    const linkDecision = await portalRateLimiter.consume(
      ip ? `ip:${ip}` : INSTANCE_BUCKET,
      RATE_LIMIT,
      RATE_LIMIT_WINDOW_MS,
    );
    if (!linkDecision.allowed) {
      json(res, { error: 'too many requests', code: 'rate-limit' }, 429, { 'Retry-After': '3600' });
      return;
    }

    let body: { email?: string };
    try {
      const raw = await readBody(req);
      body = JSON.parse(raw || '{}');
    } catch {
      json(res, { error: 'invalid payload', code: 'validation' }, 400);
      return;
    }

    const email = String(body.email || '').trim().toLowerCase();
    if (!isValidEmail(email)) {
      json(res, { error: 'validation failed', code: 'validation', fields: ['email'] }, 400);
      return;
    }

    // Production without a mail provider is a misconfiguration, not a silent
    // no-op: without an e-mail the client can never sign in. The check runs
    // BEFORE the invite lookup, so every address gets the same answer and the
    // endpoint still cannot be used to discover who is invited (P-7).
    if (isProd() && !process.env.RESEND_API_KEY) {
      console.log(
        JSON.stringify({
          ts: Date.now(),
          outcome: 'magic_link_misconfigured',
          reason: 'RESEND_API_KEY missing',
        }),
      );
      json(res, { error: 'misconfigured', code: 'internal' }, 500);
      return;
    }

    // A production instance without PORTAL_MAGIC_LINK_SECRET cannot mint a
    // token anybody could verify: an empty HMAC key is a public key, so the
    // link would either be rejected or — worse — forgeable. Fail closed, for
    // EVERY address: the answer is identical for an invited and an uninvited
    // one, so this cannot be used to find out who is invited (P-7).
    //
    // The check runs BEFORE the invite lookup and before the limiter's slot
    // is spent on the attempt, so a misconfigured deployment answers 500 for
    // everybody instead of 429 after five tries.
    if (magicLinkMisconfigured(process.env)) {
      console.log(
        JSON.stringify({
          ts: Date.now(),
          outcome: 'magic_link_misconfigured',
          // The precise reason (H-1): 'missing', 'placeholder' or
          // 'too-short'. The operator needs to know whether to paste a new
          // value or to generate one.
          reason: `PORTAL_MAGIC_LINK_SECRET ${secretProblem(process.env.PORTAL_MAGIC_LINK_SECRET)}`,
        }),
      );
      json(res, { error: 'misconfigured', code: 'internal' }, 500);
      return;
    }

    // A deployment that cannot SIGN a session must not send a sign-in link:
    // the link would lead to a dead end (the client would verify it and get a
    // 500 instead of a session). The session is a signed token now
    // (audit wave-6, F-2), and signing it needs a secret — in production a
    // missing one is a misconfiguration, never a per-process fallback.
    if (!sessionSecretConfigured()) {
      console.log(
        JSON.stringify({
          ts: Date.now(),
          outcome: 'session_misconfigured',
          // The precise reason (H-1): 'missing', 'placeholder' or
          // 'too-short'.
          reason: `PORTAL_SESSION_SECRET ${sessionSecretProblem(process.env)}`,
        }),
      );
      json(res, { error: 'misconfigured', code: 'internal' }, 500);
      return;
    }

    // Generic response regardless of whether email is invited — no enumeration (P-7)
    const allowed = (await isInvited(getPortalStore(), email)) || isAdmin(email);

    if (allowed) {
      const token = await createMagicToken(email, PORTAL_MAGIC_PURPOSE, process.env);
      if (!token) {
        // No secret to sign with (production without the secret) — the same
        // answer as the check above, for the same reason.
        console.log(
          JSON.stringify({
            ts: Date.now(),
            outcome: 'magic_link_misconfigured',
            reason: 'PORTAL_MAGIC_LINK_SECRET missing',
          }),
        );
        json(res, { error: 'misconfigured', code: 'internal' }, 500);
        return;
      }
      const outcome = await sendMagicLinkEmail(email, token, PORTAL_MAGIC_PURPOSE);
      if (outcome === 'misconfigured') {
        json(res, { error: 'misconfigured', code: 'internal' }, 500);
        return;
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

    json(res, {
      ok: true,
      message: 'If you have an invitation, a sign-in link has been sent.',
    }, 200);
    return;
  }

  // ---- GET /api/portal/auth/verify ----
  if (pathname === '/api/portal/auth/verify' && method === 'GET') {
    // Without a configured base URL the session cookie would be issued
    // WITHOUT `Secure` and the sign-in link would point at localhost
    // (audit m4). Refuse instead of issuing a weak cookie.
    if (!baseUrlConfigured()) {
      json(res, { error: 'misconfigured', code: 'internal' }, 500);
      return;
    }

    const token = url.searchParams.get('token');
    const purpose = url.searchParams.get('purpose') || PORTAL_MAGIC_PURPOSE;

    if (!token) {
      json(res, { error: 'missing token', code: 'validation' }, 400);
      return;
    }

    // A production instance without PORTAL_MAGIC_LINK_SECRET must not verify
    // anything: with an empty key a forged token would validate. Fail closed.
    if (magicLinkMisconfigured(process.env)) {
      console.log(
        JSON.stringify({
          ts: Date.now(),
          outcome: 'magic_link_misconfigured',
          reason: 'PORTAL_MAGIC_LINK_SECRET missing',
        }),
      );
      json(res, { error: 'misconfigured', code: 'internal' }, 500);
      return;
    }

    // The same rule for the SESSION: the session is a signed token now
    // (audit wave-6, F-2), so without a signing secret no session can be
    // minted. The check runs BEFORE the magic token is consumed, so a
    // misconfigured deployment does not burn the client's only link.
    if (!sessionSecretConfigured()) {
      console.log(
        JSON.stringify({
          ts: Date.now(),
          outcome: 'session_misconfigured',
          reason: 'PORTAL_SESSION_SECRET missing',
        }),
      );
      json(res, { error: 'misconfigured', code: 'internal' }, 500);
      return;
    }

    // The token is self-contained: the signature is recomputed from the
    // secret, so this function needs no table and no state from the function
    // that minted the token (audit wave 4, F-1).
    const validation = await verifyMagicToken(token, purpose, process.env);
    if (!validation.valid) {
      if (validation.reason === 'misconfigured') {
        json(res, { error: 'misconfigured', code: 'internal' }, 500);
        return;
      }
      json(res, { error: 'link expired or invalid', code: 'invalid' }, 400);
      return;
    }

    // Single use — PER INSTANCE. The used-token register lives on globalThis,
    // so a second verification of the same link that lands on THIS instance is
    // refused; one that lands on another instance is not, and the register is
    // lost on a cold start. Durable single use arrives with the shared store
    // (T4). See site/shared/server/magic-link.ts.
    const consumed = await consumeMagicToken(token, validation.exp!);
    if (!consumed) {
      json(res, { error: 'link expired or invalid', code: 'invalid' }, 400);
      return;
    }

    const email = validation.email!;
    const role = isAdmin(email) ? 'admin' : 'client';

    // Resolve / create client record for clients
    let clientId: string | undefined;
    if (role === 'client') {
      const store = getPortalStore();
      const invites = await store.list('invites');
      const invited = invites.find(
        (r) => String(r.email).toLowerCase() === email.toLowerCase(),
      );
      clientId = invited?.clientId;

      // The client record is the OWNER's profile of this client — the name
      // they typed on the invite, the company, the role. It is created here,
      // on the client's first sign-in, because the owner never signs in.
      const profile = {
        // The owner's name for the client, from the invite record. Using the
        // email local-part here would silently replace "Alice Longname" with
        // "alice.longname" on the published quote.
        name: String(invited?.name || email.split('@')[0]),
        company: String(invited?.company || ''),
        role: String(invited?.role || ''),
      };

      const existingClient = clientId
        ? await store.get('clients', { field: 'id', value: clientId })
        : null;

      if (!existingClient) {
        if (!clientId) {
          clientId = 'cli_' + crypto.randomBytes(4).toString('hex');
          // Link clientId on the invite record BEFORE the client record
          // exists, so a crash in between leaves a state the next sign-in
          // repairs (invite -> clientId, client record missing) rather than
          // an orphan client record nothing points at.
          //
          // The invite has no id of its own: the e-mail address is its
          // identity, and the invitation time narrows it to one record.
          const inviteKey: Record<string, any> = { email: invited?.email ?? email };
          if (typeof invited?.invitedAt === 'string') {
            inviteKey.invitedAt = invited.invitedAt;
          }
          await store.update('invites', inviteKey, { clientId });
        }
        await store.append('clients', {
          id: clientId,
          email,
          name: profile.name,
          company: profile.company,
          role: profile.role,
          createdAt: new Date().toISOString(),
        });
      }
    }

    // The session is a SIGNED token (audit wave-6, F-2): it carries the
    // session and the signature is the proof, so no other function has to
    // share state with this one. createSession returns null when there is no
    // signing secret — that is a misconfiguration, and it must never fall
    // back to a session only this instance can read.
    const sessionToken = createSession(email, role, clientId);
    if (!sessionToken) {
      console.log(
        JSON.stringify({
          ts: Date.now(),
          outcome: 'session_misconfigured',
          reason: 'PORTAL_SESSION_SECRET missing',
        }),
      );
      json(res, { error: 'misconfigured', code: 'internal' }, 500);
      return;
    }
    const isSecure = isSecureBaseUrl();

    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': sessionCookieString(sessionToken, role, isSecure),
    });
    res.end(JSON.stringify({ ok: true, role, email }));
    return;
  }

  // ---- POST /api/portal/auth/logout ----
  if (pathname === '/api/portal/auth/logout' && method === 'POST') {
    // BOTH cookies are cleared and both sessions destroyed. Clearing only the
    // one that happened to match left the other session alive in the browser
    // (audit m5).
    const cookies = readSessionCookies(req);
    for (const token of [cookies.admin, cookies.client]) {
      if (token) destroySession(token);
    }

    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': [
        clearSessionCookieString('admin'),
        clearSessionCookieString('client'),
      ],
    });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  json(res, { error: 'not found', code: 'not-found' }, 404);
}

// A corrupt invite store must not look like "this client is not invited"
// (audit M3 / QA D3) — that locks a real client out while the owner sees a
// normal 200. Answer 500 {code:'storage'} and name the file and line.
export default function (
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  return guardStore(
    () => handler(req, res),
    (err) => {
      console.log(JSON.stringify(storageFailureLog(err)));
      json(res, { error: 'storage unavailable', code: 'storage' }, 500);
    },
  );
}
