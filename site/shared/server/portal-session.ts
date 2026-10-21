// site/shared/server/portal-session.ts — the portal session, ONE module for
// BOTH handler trees.
//
// WHY THIS FILE LIVES OUTSIDE api/
//   Vercel docs, "Create a Node.js function in /api": "Vercel creates a
//   separate function for each supported source file in the root api/
//   directory ... Keep shared utilities and route modules outside api/ and
//   import them from your function entry point." A module inside api/ is not
//   a shared module — it is a FUNCTION with a URL of its own.
//
// WHY THE SESSION IS A SIGNED TOKEN AND NOT A ROW IN A MAP (audit wave-5 F-2)
//   The session used to live in a module-scope Map (api/portal/session.ts) or
//   on globalThis (the Cloudflare twin). Vercel builds one function per file
//   under api/, so /api/portal/auth/verify and /api/portal/projects got
//   DIFFERENT Maps: the cookie minted by one was refused by the other with
//   401 {code:'unauthorized'}, and no client could ever sign in. The same Map
//   is per instance and per cold start, so even ONE function file would lose
//   the session the moment Vercel scaled out. The Code Reviewer reproduced it
//   by execution (audit wave 4, F-1):
//       one bundle   -> request-link 200, verify 200
//       two bundles  -> request-link 200, verify 400 "link expired or invalid"
//   A signed token removes the shared state completely: the cookie carries the
//   session and the signature is the proof. It works on every instance, in
//   every bundle, after every cold start.
//
// ONE MODULE FOR BOTH TREES
//   Vercel    api/…                  -> ../../site/shared/server/portal-session.js
//   Cloudflare site/functions/api/…  -> ../../../shared/server/portal-session.js
//   The trees used to carry two copies of the session logic (a Map on one
//   side, a globalThis Map on the other). Two copies of a security contract
//   drift; one copy cannot. It also means a token minted on one target is
//   accepted by the other — the same property the magic-link token has.
//
// EDGE-SAFE BY DESIGN
//   No `node:` imports: the module must load in a Cloudflare Worker isolate
//   as well as in a Vercel function. Everything below is plain TypeScript plus
//   the Web Platform globals that both runtimes provide (TextEncoder,
//   TextDecoder, btoa, atob, crypto.getRandomValues).
//
// WHY THE MAC IS IMPLEMENTED HERE INSTEAD OF WITH crypto.subtle
//   WebCrypto's only message-authentication primitive is `crypto.subtle.sign`,
//   and it is ASYNCHRONOUS. The session API is synchronous by contract: it is
//   called as `resolveSession(req)` in seven Vercel handlers, seven Cloudflare
//   handlers and a QA suite, and a synchronous signature check is what lets
//   the cookie be validated inside a plain `if (!session)` guard. An async
//   API would have to be awaited at every one of those call sites, and a
//   missed `await` turns the guard into a truthy Promise — a silent
//   authentication bypass rather than a compile error.
//   So the HMAC-SHA256 is implemented here in plain TypeScript. It is NOT
//   trusted on the strength of this comment: backend-wave6-harness.mjs runs a
//   differential test of this implementation against `node:crypto`'s
//   createHmac over hundreds of random inputs and edge cases, and the two
//   must agree byte for byte.
//
// WHAT THIS COSTS — stated, not assumed
//   - Logout cannot revoke a token server-side: the cookie is cleared and the
//     token expires on its own (24h). The revocation list below is a
//     best-effort, per-instance extra, not a guarantee. A durable revocation
//     belongs to the shared store (T4).
//   - The TTL is fixed at issue instead of sliding on activity.
//   - A production instance MUST have a signing secret. Signing with an empty
//     key would make every token forgeable, so a missing secret is a
//     misconfiguration (500), not a silent fallback.
//   - The payload is signed, not encrypted. It holds the session's OWN email,
//     which the holder of the cookie already knows.

export type Role = 'admin' | 'client';

export interface Session {
  email: string;
  role: Role;
  clientId?: string;
  /**
   * Expiry of the signed token, epoch ms.
   *
   * It is the `x` field of the signed payload, so the browser can be told
   * when the session dies (Architect §4.2: `expiresAt`). It is NOT a
   * server-side decision — the signature is.
   */
  expiresAt?: number;
}

/**
 * The environment shape both trees hand over (process.env / Worker env).
 *
 * Only the keys this module reads are named. The type is deliberately NOT an
 * index signature: a Worker `env` (and the `Env` interface of the Cloudflare
 * notification module) is an interface, and interfaces do not get an implicit
 * index signature — so `{ [key: string]: string | undefined }` would reject
 * them at the call site even though they carry everything this module reads.
 */
export interface EnvLike {
  APP_ENV?: string;
  SITE_BASE_URL?: string;
  SITE_URL?: string;
  PORTAL_SESSION_SECRET?: string;
  PORTAL_MAGIC_LINK_SECRET?: string;
  /** The owner allow-list. Read on EVERY request (audit M-4). */
  ADMIN_EMAILS?: string;
  /** Vercel sets NODE_ENV=production; VERCEL=1 marks a deployed instance. */
  NODE_ENV?: string;
  VERCEL?: string;
}

/**
 * Where the cookie comes from.
 *
 * Duck-typed on purpose: the Vercel tree passes a Node `IncomingMessage`
 * (`req.headers.cookie`) and the Cloudflare tree passes a `Headers` object
 * (`headers.get('cookie')`). Both shapes are accepted, so one module serves
 * both trees without either of them changing how it calls the session.
 */
export interface SessionSource {
  headers?: any;
  get?: any;
}

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24h
/**
 * Clock skew allowance. A token may not claim to live longer than the TTL
 * plus this much (M-3) — the same rule the magic-link module applies.
 */
const CLOCK_SKEW_MS = 60 * 1000;
const COOKIE_CLIENT = 'imk_session';
const COOKIE_ADMIN = 'imk_admin_session';
const TOKEN_VERSION = 'v1';

interface SessionPayload {
  /** email */
  e: string;
  /** role */
  r: Role;
  /** clientId */
  c?: string;
  /** expiry, epoch ms */
  x: number;
}

// ---------------------------------------------------------------------------
// SHA-256 / HMAC — plain TypeScript, no imports, no runtime dependency
// ---------------------------------------------------------------------------

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

/** SHA-256 of a byte string (FIPS 180-4). */
export function sha256Bytes(message: Uint8Array): Uint8Array {
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);

  const bitLength = message.length * 8;
  const padded = new Uint8Array(((message.length + 9 + 63) & ~63) >>> 0);
  padded.set(message, 0);
  padded[message.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(padded.length - 4, bitLength >>> 0);

  const w = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = h[0];
    let b = h[1];
    let c = h[2];
    let d = h[3];
    let e = h[4];
    let f = h[5];
    let g = h[6];
    let hh = h[7];

    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hh + s1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) outView.setUint32(i * 4, h[i]);
  return out;
}

/** HMAC-SHA256 (RFC 2104) over raw bytes. */
export function hmacSha256Bytes(key: Uint8Array, message: Uint8Array): Uint8Array {
  const BLOCK = 64;
  const k = key.length > BLOCK ? sha256Bytes(key) : key;
  const ipad = new Uint8Array(BLOCK);
  const opad = new Uint8Array(BLOCK);
  for (let i = 0; i < BLOCK; i++) {
    const kb = i < k.length ? k[i] : 0;
    ipad[i] = kb ^ 0x36;
    opad[i] = kb ^ 0x5c;
  }
  return sha256Bytes(concatBytes(opad, sha256Bytes(concatBytes(ipad, message))));
}

/**
 * HMAC-SHA256 of a string, hex encoded.
 *
 * Exported so the differential test (backend-wave6-harness.mjs) can compare
 * this implementation against `node:crypto`'s createHmac directly, instead of
 * only comparing it through the session API.
 */
export function hmacSha256Hex(secret: string, message: string): string {
  const key = new TextEncoder().encode(secret);
  const msg = new TextEncoder().encode(message);
  return toHex(hmacSha256Bytes(key, msg));
}

/** SHA-256 of a string, hex encoded. */
export function sha256Hex(data: string): string {
  return toHex(sha256Bytes(new TextEncoder().encode(data)));
}

/**
 * Compare two hex digests without leaking where they differ.
 *
 * The comparison runs over the whole string even when the lengths differ, so
 * the time it takes does not depend on the position of the first difference.
 */
function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Encoding helpers (Web Platform globals — Node 16+ and Workers both have them)
// ---------------------------------------------------------------------------

function base64urlEncode(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(str: string): string {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) base64 += '=';
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

/**
 * The environment to use when the caller does not pass one.
 *
 * The Vercel tree has `process.env`; a Cloudflare Worker has no `process` at
 * all, so the default there is an empty environment — and an empty
 * environment means PRODUCTION (see isProductionEnv), which is the safe
 * default: no secret, no session.
 */
function defaultEnv(): EnvLike {
  const p = (globalThis as any).process;
  return p && p.env ? (p.env as EnvLike) : {};
}

/**
 * Production unless the environment says otherwise — the same convention as
 * api/contact.ts. An unset APP_ENV must NOT be read as development: a
 * deployed instance with a missing RESEND_API_KEY would then print a live
 * bearer token to its log (audit M4).
 *
 * H-2 (wave-8A): `APP_ENV=development` alone is NOT enough to switch the
 * fail-closed guards off. The shipped `site/.env.example` set exactly that
 * one variable, and with it every guard in the project was silently
 * disabled on a deployed instance:
 *   - the session secret fell back to a PER-PROCESS random value, which on
 *     Vercel restores the F-2 symptom (the cookie minted by one function is
 *     refused by the next) as a silent 401 instead of a loud 500;
 *   - a missing RESEND_API_KEY wrote the sign-in token to the log.
 *
 * So a deployment is PRODUCTION when ANY of these says so:
 *   - APP_ENV is unset (the default),
 *   - APP_ENV is anything other than 'development' (unknown -> fail closed),
 *   - NODE_ENV=production (Vercel, and most hosts),
 *   - VERCEL=1,
 *   - SITE_BASE_URL / SITE_URL is an https:// URL.
 * Only an explicit APP_ENV=development on a machine that is not deployed
 * (no NODE_ENV=production, no VERCEL, no https base URL) is DEVELOPMENT.
 */
export function isProductionEnv(env?: EnvLike): boolean {
  const e = env ?? defaultEnv();
  const appEnv = String(e.APP_ENV || '').trim().toLowerCase();
  if (appEnv !== 'development') return true; // unset, 'production' or unknown -> production
  if (String(e.NODE_ENV || '').trim().toLowerCase() === 'production') return true;
  if (String(e.VERCEL || '').trim() === '1') return true;
  const base = String(e.SITE_BASE_URL || e.SITE_URL || '').trim().toLowerCase();
  if (base.startsWith('https://')) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Secret quality — H-1 (wave-8A)
// ---------------------------------------------------------------------------

// The rule itself lives in site/shared/server/secret.ts, so the session
// module, the magic-link module, the moderation endpoint and the contact
// form all judge a secret the SAME way. It is re-exported here because the
// session module is the module every handler already imports.
export {
  PUBLISHED_SECRET_PLACEHOLDERS,
  MIN_SECRET_LENGTH,
  secretProblem,
  secretUsable,
  type SecretProblem,
} from './secret.js';

import {
  secretProblem as secretProblemOf,
  secretUsable as secretUsableOf,
  type SecretProblem,
} from './secret.js';

/**
 * The signing secret, or null when there is none.
 *
 * `PORTAL_SESSION_SECRET` wins; `PORTAL_MAGIC_LINK_SECRET` is the fallback so
 * a deployment can be configured with one secret. In production a missing
 * secret is a MISCONFIGURATION: an empty HMAC key is a public key, so the
 * token would be forgeable. In development a per-process secret is generated
 * so the portal works with no setup.
 *
 * H-1 (wave-8A): in production a secret that is PRESENT but UNUSABLE — the
 * published placeholder, or shorter than 32 characters — is refused exactly
 * like a missing one. The caller answers 500 {code:'internal'}; it never
 * signs with a value an attacker could guess.
 */
export function sessionSecret(env?: EnvLike): string | null {
  const e = env ?? defaultEnv();
  const raw = (e.PORTAL_SESSION_SECRET || e.PORTAL_MAGIC_LINK_SECRET || '').trim();
  if (raw) {
    if (isProductionEnv(e) && !secretUsableOf(raw)) return null;
    return raw;
  }
  if (isProductionEnv(e)) return null; // fail closed — never sign with ''
  const g = globalThis as any;
  if (!g.__imkDevSessionSecret) g.__imkDevSessionSecret = randomHex(32);
  return g.__imkDevSessionSecret;
}

/** Is a signing secret available? False in production without a usable one. */
export function sessionSecretConfigured(env?: EnvLike): boolean {
  return sessionSecret(env) !== null;
}

/**
 * WHY the session secret is unusable, for the log line.
 *
 * 'missing' | 'placeholder' | 'too-short' | null. The reason is what tells
 * the operator whether to paste a new value or to generate one — a bare
 * "misconfigured" is a support ticket.
 */
export function sessionSecretProblem(env?: EnvLike): SecretProblem {
  const e = env ?? defaultEnv();
  const raw = (e.PORTAL_SESSION_SECRET || e.PORTAL_MAGIC_LINK_SECRET || '').trim();
  if (!raw) return isProductionEnv(e) ? 'missing' : null;
  if (!isProductionEnv(e)) return null;
  return secretProblemOf(raw);
}

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------

export function sessionCookieName(role: Role): string {
  return role === 'admin' ? COOKIE_ADMIN : COOKIE_CLIENT;
}

/** The raw `cookie` header of a Node request or a Worker request. */
function cookieHeader(source: SessionSource | null | undefined): string {
  if (!source) return '';
  const getter = (source as any).get;
  if (typeof getter === 'function') {
    const value = getter.call(source, 'cookie');
    return typeof value === 'string' ? value : '';
  }
  const headers = (source as any).headers;
  if (headers && typeof headers.get === 'function') {
    const value = headers.get('cookie');
    return typeof value === 'string' ? value : '';
  }
  if (headers && typeof headers === 'object') {
    const value = headers.cookie;
    if (Array.isArray(value)) return value.join('; ');
    if (typeof value === 'string') return value;
  }
  return '';
}

/**
 * Read BOTH session cookies.
 *
 * A browser can hold one of each (an owner session and a client session, or a
 * stale one next to a live one). The old reader matched either name and let
 * the FIRST match win, so a stale admin cookie shadowed a valid client cookie
 * for every request — and logout cleared only the cookie that happened to
 * match (audit m5).
 */
export function readSessionCookies(source: SessionSource): {
  admin?: string;
  client?: string;
} {
  const raw = cookieHeader(source);
  const out: { admin?: string; client?: string } = {};
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!value) continue;
    if (name === COOKIE_CLIENT && out.client === undefined) out.client = value;
    if (name === COOKIE_ADMIN && out.admin === undefined) out.admin = value;
  }
  return out;
}

/** The client cookie, or the admin cookie when there is no client cookie. */
export function readSessionCookie(source: SessionSource): string | null {
  const cookies = readSessionCookies(source);
  return cookies.client || cookies.admin || null;
}

// ---------------------------------------------------------------------------
// The token
// ---------------------------------------------------------------------------

/**
 * Revoked tokens.
 *
 * Best-effort and per process: logout clears the cookie, and the token is
 * remembered here so a replay inside this process is refused. A token that
 * was revoked on another instance is only stopped by its expiry. Durable
 * revocation belongs to the shared store (T4).
 *
 * The key is the SHA-256 of the token, so no bearer credential is kept in
 * memory in a readable form.
 */
const revoked = (globalThis as any).__imkRevokedSessions ||
  ((globalThis as any).__imkRevokedSessions = new Map<string, number>());

function isRevoked(token: string): boolean {
  const key = sha256Hex(token);
  const until = revoked.get(key);
  if (until === undefined) return false;
  if (Date.now() > until) {
    revoked.delete(key);
    return false;
  }
  return true;
}

/** Best-effort revocation (see the note on `revoked` above). */
export function destroySession(token: string): void {
  if (!token) return;
  revoked.set(sha256Hex(token), Date.now() + SESSION_TTL_MS);
  // Keep the list from growing without bound.
  if (revoked.size > 500) {
    const now = Date.now();
    for (const [key, until] of revoked) {
      if (now > until) revoked.delete(key);
    }
  }
}

function sign(payloadB64: string, env?: EnvLike): string | null {
  const secret = sessionSecret(env);
  if (!secret) return null;
  return hmacSha256Hex(secret, `${TOKEN_VERSION}.${payloadB64}`);
}

/**
 * Mint a session token. The token carries the session and proves it.
 *
 * Returns NULL when there is no secret to sign with — a production instance
 * without PORTAL_SESSION_SECRET (or PORTAL_MAGIC_LINK_SECRET). The caller
 * must answer 500 {code:'internal'}; it must never fall back to an unsigned
 * or per-process-random session, because that is the exact defect this
 * module replaced (a session that only one instance can read).
 */
export function createSession(
  email: string,
  role: Role,
  clientId?: string,
  env?: EnvLike,
): string | null {
  const payload: SessionPayload = {
    e: email,
    r: role,
    x: Date.now() + SESSION_TTL_MS,
  };
  if (clientId) payload.c = clientId;
  const payloadB64 = base64urlEncode(JSON.stringify(payload));
  const sig = sign(payloadB64, env);
  if (!sig) return null;
  return `${TOKEN_VERSION}.${payloadB64}.${sig}`;
}

/**
 * Verify a session token.
 *
 * The signature, the version and the expiry are the authority — no server
 * state is consulted, so the token works on any instance. A forged, tampered
 * or expired token is null.
 */
export function parseSession(token: string, env?: EnvLike): Session | null {
  if (!token) return null;
  if (!sessionSecretConfigured(env)) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [version, payloadB64, sig] = parts;
  if (version !== TOKEN_VERSION) return null;
  const expected = sign(payloadB64, env);
  if (!expected) return null;
  if (!safeEqualHex(expected, sig)) return null;
  let payload: SessionPayload;
  try {
    payload = JSON.parse(base64urlDecode(payloadB64));
  } catch {
    return null;
  }
  if (!payload || typeof payload.e !== 'string') return null;
  if (payload.r !== 'admin' && payload.r !== 'client') return null;
  if (typeof payload.x !== 'number' || Date.now() > payload.x) return null;
  // M-3 (wave-8A): a token must not outlive the TTL. The magic-link module
  // has had this guard since it was written; the session module did not, so
  // a token claiming "valid until the year 3000" was accepted forever. Only
  // the holder of the signing secret can mint one — this is defence in depth
  // for the day the secret leaks, and a guard against a future bug that
  // mints with the wrong TTL.
  if (payload.x - Date.now() > SESSION_TTL_MS + CLOCK_SKEW_MS) return null;
  if (isRevoked(token)) return null;
  const session: Session = { email: payload.e, role: payload.r, expiresAt: payload.x };
  if (payload.c) session.clientId = payload.c;
  return session;
}

/**
 * Resolve the session for a request.
 *
 * `preferRole` lets an endpoint ask for the cookie that matches the role it
 * needs (owner-only endpoints prefer the admin cookie, client endpoints prefer
 * the client cookie). A cookie that does not resolve to a valid session is
 * SKIPPED, so a stale admin cookie can no longer shadow a valid client
 * cookie, and a forged cookie is simply not a session.
 *
 * WITHOUT `preferRole` the CLIENT cookie comes first (M-5, wave-8A). It used
 * to be the admin cookie, and that is what let a live admin cookie widen a
 * client's read scope: the Code Reviewer executed it — a client who owns ONE
 * project got 2 of 2 back, including a project of another client.
 *
 * This function is the LOW-LEVEL primitive: it does not consult the owner
 * allow-list. A client-scoped read must use `resolveAccess` (or
 * `resolveClientSession`), and an owner-only action must use
 * `resolveOwnerSession` — those two apply the M-4/M-5 rules.
 *
 * `env` is the deployment's environment — the Cloudflare tree passes the
 * request's `env`, the Vercel tree lets it default to `process.env`.
 */
export function resolveSession(
  source: SessionSource,
  preferRole?: Role,
  env?: EnvLike,
): Session | null {
  const cookies = readSessionCookies(source);
  const order: Role[] = preferRole
    ? [preferRole, preferRole === 'admin' ? 'client' : 'admin']
    : ['client', 'admin'];
  for (const role of order) {
    const token = cookies[role === 'admin' ? 'admin' : 'client'];
    if (!token) continue;
    const session = parseSession(token, env);
    if (!session) continue; // stale or forged cookie — try the other one
    return session;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The access of a request — M-4 and M-5 (wave-8A)
// ---------------------------------------------------------------------------

/**
 * What a request is allowed to SEE and to CHANGE.
 *
 * Two INDEPENDENT facts, both read from the request's cookies:
 *
 *   client — the `imk_session` cookie resolves to a session. That is ONE
 *            client's own session, and it is scoped to that client.
 *   owner  — the `imk_admin_session` cookie resolves to a session whose role
 *            claim is `admin` AND whose email is on the LIVE allow-list.
 *            That is the OWNER, and it may act for every client.
 *
 * They are independent because a browser can hold BOTH cookies at once: the
 * owner testing the client flow on their own machine, or a shared office
 * computer. The two rules below are what stop that from being a privilege
 * leak.
 *
 * THE READ RULE (M-5, Architect §4.3)
 *   A client session narrows the read to that client — EVEN IF an owner
 *   cookie is present. Only a request with no client session and a passing
 *   owner gate reads every client's data.
 *
 * THE WRITE RULE (M-4)
 *   An owner-only action needs the owner gate: the role claim AND the live
 *   allow-list. The allow-list is read on EVERY request, so taking an
 *   address off it revokes the owner's powers at once — not when the 24 h
 *   token expires. This is the same gate /api/admin/session uses, so /admin
 *   and /portal agree.
 */
export interface RequestAccess {
  /** The client session, when the `imk_session` cookie resolves. */
  client: Session | null;
  /** The owner session, when the two-part owner gate passes. */
  owner: Session | null;
  /** The session the read path uses: the client one, else the owner's. */
  session: Session | null;
  /**
   * ANY valid session, whatever its role or allow-list state.
   *
   * This is the answer to "is anybody signed in?". It separates the two
   * states an owner-only action has to tell apart:
   *   - nobody is signed in            -> 401 {code:'unauthorized'}
   *   - somebody is signed in, but is
   *     not the owner                   -> 403 {code:'forbidden'}
   * The client uses 403 to mean "you are not the owner" and must not read it
   * as "signed out" (Architect §4.2) — so a session whose address was just
   * taken off the allow-list answers 403, not 401.
   */
  any: Session | null;
}

/**
 * Work out what a request may see and change.
 *
 * One call, one reading of the cookies, one decision — so a handler cannot
 * resolve the session twice and get two different answers.
 */
export function resolveAccess(source: SessionSource, env?: EnvLike): RequestAccess {
  const e = env ?? defaultEnv();
  const cookies = readSessionCookies(source);

  // The client session: the `imk_session` cookie and nothing else. A cookie
  // that does not resolve (stale or forged) is simply not a session.
  const client = cookies.client ? parseSession(cookies.client, e) : null;

  // The owner gate: the ADMIN cookie only, the role claim, and the LIVE
  // allow-list. The client cookie is never consulted here — a client
  // session can never be an owner session.
  const admin = cookies.admin ? parseSession(cookies.admin, e) : null;
  let owner: Session | null = null;
  if (admin && admin.role === 'admin' && isAdminEmail(admin.email, e)) owner = admin;

  // The read session: the CLIENT wins, even when an owner cookie is present
  // (M-5). With no client session the owner reads everything.
  return {
    client,
    owner,
    session: client || owner,
    any: client || admin,
  };
}

/**
 * The session a client-scoped READ uses.
 *
 * The client cookie first, the owner second — see `resolveAccess`.
 */
export function resolveClientSession(source: SessionSource, env?: EnvLike): Session | null {
  return resolveAccess(source, env).session;
}

/**
 * May this request READ the data of this client?
 *
 * The READ rule (M-5): a client session narrows the read to that client,
 * even when an owner cookie is present — a live admin cookie must never
 * widen a client's read scope. Only a request with NO client session and a
 * passing owner gate reads every client's data.
 */
export function canReadClient(access: RequestAccess, clientId?: string): boolean {
  if (access.client) {
    if (!access.client.clientId) return false;
    return access.client.clientId === clientId;
  }
  return !!access.owner;
}

/**
 * May this request CHANGE the data of this client?
 *
 * The WRITE rule (M-4): the owner may act for any client (the two-part
 * gate), a client may act only for itself.
 */
export function canWriteClient(access: RequestAccess, clientId?: string): boolean {
  if (access.owner) return true;
  if (!access.client || !access.client.clientId) return false;
  return access.client.clientId === clientId;
}

// ---------------------------------------------------------------------------
// The owner — the two-part gate (audit M-4, Architect §4.2)
// ---------------------------------------------------------------------------

/**
 * The owner allow-list, parsed.
 *
 * An unset or empty list means NOBODY is the owner: the list is empty so
 * nothing matches. It never means "everyone" — an unset allow-list would
 * hand the inbox to whoever asks for it.
 *
 * Entries are trimmed, lower-cased and empty entries dropped, so
 * "A@x.com , , b@y.com" is two addresses.
 */
export function adminAllowList(env?: EnvLike): string[] {
  const e = env ?? defaultEnv();
  return String(e.ADMIN_EMAILS || '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Is this email on the owner allow-list?
 *
 * The list is read on EVERY request, so taking an address off it revokes
 * the owner's powers immediately — not when the 24 h token expires.
 */
export function isAdminEmail(email: string, env?: EnvLike): boolean {
  const list = adminAllowList(env);
  if (list.length === 0) return false;
  return list.includes(String(email || '').trim().toLowerCase());
}

/**
 * Is the owner allow-list configured at all?
 *
 * An unset list is a MISCONFIGURATION (the owner has no way in), not a
 * "nobody is allowed" state: the two are told apart by the status code —
 * 500 {code:'internal'} for the first, 401 for the second.
 *
 * A list that is set but EMPTY AFTER PARSING (" , ") counts as
 * misconfigured too: it is the same mistake written differently.
 */
export function adminEmailsConfigured(env?: EnvLike): boolean {
  return adminAllowList(env).length > 0;
}

/**
 * The role this session actually has RIGHT NOW.
 *
 * The signed token carries the role that was true at sign-in time. The
 * allow-list is the live truth. So:
 *
 *   role = (claim.role === 'admin' && isAdminEmail(claim.email)) ? 'admin' : 'client'
 *
 * An owner whose address was taken off the list is a client — the owner
 * powers are gone at once (audit M-4), which is what `/admin` already did
 * and what the portal did not.
 */
export function effectiveRole(session: Session | null, env?: EnvLike): Role | null {
  if (!session) return null;
  if (session.role !== 'admin') return 'client';
  return isAdminEmail(session.email, env) ? 'admin' : 'client';
}

/**
 * Resolve the OWNER session for a request.
 *
 * TWO checks, both required (the same gate /api/admin/session uses):
 *   1. the session's role claim is `admin`, and
 *   2. the session's email is on the live ADMIN_EMAILS allow-list.
 *
 * The ADMIN cookie is the only cookie consulted: an owner session is the one
 * that was minted for the owner, and a client cookie can never be promoted
 * to one (M-4).
 *
 * Returns null for every state that is not the owner, so a caller can
 * answer one status code for all of them.
 *
 * `env` carries the allow-list, `sessionEnv` the signing secret. They are
 * the same object in both trees, but they are kept apart so a caller can
 * pass a Worker `env` for one and a session env for the other.
 */
export function resolveOwnerSession(
  source: SessionSource,
  env?: EnvLike,
  sessionEnv?: EnvLike,
): Session | null {
  const e = env ?? defaultEnv();
  const cookies = readSessionCookies(source);
  if (!cookies.admin) return null;
  const session = parseSession(cookies.admin, sessionEnv ?? e);
  if (!session) return null;
  if (session.role !== 'admin') return null;
  if (!isAdminEmail(session.email, e)) return null;
  return session;
}

// ---------------------------------------------------------------------------
// Cookie writing
// ---------------------------------------------------------------------------

export function sessionCookieString(
  token: string,
  role: Role,
  isSecure: boolean,
): string {
  const name = sessionCookieName(role);
  const attrs = [
    `${name}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    isSecure ? 'Secure' : '',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ].filter(Boolean).join('; ');
  return attrs;
}

export function clearSessionCookieString(role: Role): string {
  const name = sessionCookieName(role);
  return `${name}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

// ---------------------------------------------------------------------------
// Base URL
// ---------------------------------------------------------------------------

/**
 * The base URL the portal is served from, or null when it is not configured.
 * SITE_BASE_URL wins; SITE_URL is the legacy fallback.
 */
export function configuredBaseUrl(env?: EnvLike): string | null {
  const e = env ?? defaultEnv();
  const raw = (e.SITE_BASE_URL || e.SITE_URL || '').trim();
  if (!raw) return null;
  return raw.replace(/\/$/, '');
}

export function baseUrl(env?: EnvLike): string {
  return configuredBaseUrl(env) || 'http://localhost:4321';
}

/**
 * Is the base URL usable?
 *
 * In production a missing SITE_BASE_URL/SITE_URL is a MISCONFIGURATION, not
 * something to paper over with a localhost fallback: every state-changing
 * portal call would answer "403 origin required" (which reads like a CSRF
 * attack) and the session cookie would be issued without `Secure`
 * (audit m4). A development instance may run on localhost.
 */
export function baseUrlConfigured(env?: EnvLike): boolean {
  if (configuredBaseUrl(env)) return true;
  return !isProductionEnv(env);
}

export function isSecureBaseUrl(env?: EnvLike): boolean {
  return baseUrl(env).startsWith('https://');
}

export function expectedOrigin(env?: EnvLike): string {
  return new URL(baseUrl(env)).origin;
}
