// site/shared/server/magic-link.ts — the portal magic-link token.
//
// SHARED BY BOTH HANDLER TREES ON PURPOSE
//   The Vercel tree (api/) and the Cloudflare tree (site/functions/) deploy
//   as SEPARATE functions. Vercel builds one function per file under api/,
//   each with its own bundle AND its own process; Cloudflare Pages compiles
//   functions/ into one Worker, but every colo runs its own isolate. A token
//   that is only known to the process that minted it therefore cannot be
//   verified by the function that checks it. The Code Reviewer reproduced it
//   by execution (audit wave 4, F-1):
//       one bundle   -> request-link 200, verify 200
//       two bundles  -> request-link 200, verify 400 "link expired or invalid"
//
//   So the token is SELF-CONTAINED: it carries the address, the purpose, the
//   expiry and a nonce, signed with PORTAL_MAGIC_LINK_SECRET. Verification
//   recomputes the signature from the secret — no table, no shared state, no
//   process, no cold start. It works on every instance of every function.
//
//   ONE module for both trees, so the two can never drift apart the way
//   duplicated signing code did for the moderation link.
//
// RUNTIME
//   Web Crypto only (crypto.subtle, crypto.getRandomValues) — the same API in
//   Node 20 and in the edge runtime. No node: imports, so the Cloudflare tree
//   can import this module unchanged.
//
// WHAT "SINGLE USE" MEANS HERE — stated, not assumed
//   The one-time property comes from the used-token register below, which
//   lives on `globalThis`:
//     - PER INSTANCE. It is process-local (Vercel) / isolate-local (the
//       edge). A second verification of the same link that lands on the SAME
//       instance is refused; one that lands on a DIFFERENT instance is not,
//       because that instance has never heard of the token.
//     - NOT DURABLE. It is lost on a cold start, on a redeploy and on every
//       scale-out, so a link can be replayed after a restart.
//   So today the replay window is "the token's TTL (15 minutes), minus
//   whatever the used-register happens to catch". After the shared store
//   (T4, libSQL/Turso) lands, the register becomes a durable row and the
//   property becomes global: one verification per token, everywhere, forever.
//
//   The alternative — a purely stateless token — would mean the replay window
//   is exactly the TTL on every instance. The register is strictly better
//   than that, and it costs one map per instance.

/** The environment shape both trees hand over (process.env / Worker env). */
export interface EnvLike {
  [key: string]: string | undefined;
}

/** How long a sign-in link is valid. */
export const MAGIC_TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Clock skew allowance. A token may not claim to live longer than the TTL
 * plus this much, so a token minted far in the future (or one that escaped
 * the minting path) is refused instead of being honoured for years.
 */
const CLOCK_SKEW_MS = 60 * 1000;

/** The only purpose that exists today. */
export const PORTAL_MAGIC_PURPOSE = 'portal';

/**
 * Production unless the environment says otherwise — the same convention as
 * api/contact.ts. An unset APP_ENV is PRODUCTION.
 */
export function isProductionEnv(env: EnvLike): boolean {
  return (env.APP_ENV || 'production') === 'production';
}

/**
 * Is the deployment missing its signing secret?
 *
 * An empty HMAC key is a public key: with one, anybody could mint a token
 * for any address. So a production instance without
 * PORTAL_MAGIC_LINK_SECRET is MISCONFIGURED, and the callers answer 500 —
 * they never fall back to an empty key.
 */
export function magicLinkMisconfigured(env: EnvLike): boolean {
  return isProductionEnv(env) && !(env.PORTAL_MAGIC_LINK_SECRET || '').trim();
}

/**
 * The signing secret.
 *
 * Production: the configured secret, or null when it is missing (fail closed).
 * Development: a per-process random secret, so the portal runs with no setup
 * and a forgotten secret can never make tokens forgeable. The cost is that a
 * token minted by one process cannot be verified by another — in development
 * that is the local dev server (one process), and in production the secret
 * is mandatory anyway.
 */
export function magicLinkSecret(env: EnvLike): string | null {
  const raw = (env.PORTAL_MAGIC_LINK_SECRET || '').trim();
  if (raw) return raw;
  if (isProductionEnv(env)) return null; // fail closed — never sign with ''
  const g = globalThis as any;
  if (!g.__imkDevMagicSecret) g.__imkDevMagicSecret = randomHex(32);
  return g.__imkDevMagicSecret;
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return toHex(new Uint8Array(sig));
}

async function sha256Hex(data: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
  return toHex(new Uint8Array(buf));
}

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

/**
 * Compare two hex digests without leaking where they differ.
 *
 * `crypto.subtle` has no timing-safe compare, and the edge runtime has no
 * node:crypto — so the comparison is done here, in constant time.
 */
function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Why a token was refused. `misconfigured` is the only 500; the rest are 400. */
export type MagicTokenFailure =
  | 'misconfigured'
  | 'malformed'
  | 'expired'
  | 'signature'
  | 'purpose';

export interface MagicTokenResult {
  valid: boolean;
  email?: string;
  purpose?: string;
  /** Expiry, epoch ms. */
  exp?: number;
  reason?: MagicTokenFailure;
}

/**
 * Mint a magic-link token.
 *
 * The token is `base64url(email|purpose|exp|nonce|sig)` — everything the
 * verifier needs, and the signature over it. The verifier needs the secret
 * and nothing else, so any instance can verify any token.
 *
 * Returns null when there is no secret to sign with (a production instance
 * without PORTAL_MAGIC_LINK_SECRET): the caller must answer 500, never mint
 * a token that nobody could verify.
 */
export async function createMagicToken(
  email: string,
  purpose: string,
  env: EnvLike,
  now: number = Date.now(),
): Promise<string | null> {
  const secret = magicLinkSecret(env);
  if (!secret) return null;
  const exp = now + MAGIC_TOKEN_TTL_MS;
  const nonce = randomHex(16);
  const message = `${email}|${purpose}|${exp}|${nonce}`;
  const sig = await hmacSha256Hex(secret, message);
  return base64urlEncode(`${message}|${sig}`);
}

/**
 * Verify a magic-link token.
 *
 * Stateless: the signature is recomputed from the secret. `expectedPurpose`
 * must match the purpose inside the token — the sign-in door only accepts a
 * 'portal' token.
 */
export async function verifyMagicToken(
  token: string,
  expectedPurpose: string,
  env: EnvLike,
  now: number = Date.now(),
): Promise<MagicTokenResult> {
  const secret = magicLinkSecret(env);
  if (!secret) return { valid: false, reason: 'misconfigured' };

  let decoded: string;
  try {
    decoded = base64urlDecode(token);
  } catch {
    return { valid: false, reason: 'malformed' };
  }

  const parts = decoded.split('|');
  if (parts.length !== 5) return { valid: false, reason: 'malformed' };
  const [email, purpose, expStr, nonce, sig] = parts;
  if (!email || !purpose || !nonce || !sig) return { valid: false, reason: 'malformed' };

  const exp = Number(expStr);
  if (!Number.isFinite(exp)) return { valid: false, reason: 'malformed' };
  if (now > exp) return { valid: false, reason: 'expired' };
  if (exp - now > MAGIC_TOKEN_TTL_MS + CLOCK_SKEW_MS) {
    return { valid: false, reason: 'expired' };
  }

  const expected = await hmacSha256Hex(secret, `${email}|${purpose}|${exp}|${nonce}`);
  if (!safeEqualHex(expected, sig)) return { valid: false, reason: 'signature' };

  if (expectedPurpose && purpose !== expectedPurpose) {
    return { valid: false, reason: 'purpose' };
  }

  return { valid: true, email, purpose, exp };
}

/**
 * The used-token register — the one-time property, per instance.
 *
 * PER INSTANCE and NOT DURABLE (see the header): it lives on globalThis, so
 * it is shared by every function in ONE process (the local dev server) or in
 * ONE isolate (the edge), and it is lost on a cold start, a redeploy and a
 * scale-out. On Vercel, where each function file is its own process, it
 * covers the verify function's own instance only.
 *
 * The key is the SHA-256 of the token, so no bearer credential is kept in
 * memory in a readable form.
 */
const usedTokens: Map<string, number> =
  (globalThis as any).__imkUsedMagicTokens ||
  ((globalThis as any).__imkUsedMagicTokens = new Map<string, number>());

/**
 * Spend a token.
 *
 * Returns true when this call consumed it, false when it was ALREADY spent
 * on this instance. The check and the marking are one operation, so two
 * concurrent verifications cannot both win.
 */
export async function consumeMagicToken(token: string, exp: number): Promise<boolean> {
  const hash = await sha256Hex(token);
  const now = Date.now();
  // Drop what has expired, so the register cannot grow without bound.
  for (const [key, until] of usedTokens) {
    if (now > until) usedTokens.delete(key);
  }
  if (usedTokens.has(hash)) return false;
  usedTokens.set(hash, exp);
  return true;
}

/**
 * The magic link a client receives.
 *
 * The token is the credential: it travels in the URL of the sign-in link and
 * in the same place the client gets it from. It is never written to a log
 * in production.
 */
export function magicLinkUrl(base: string, token: string, purpose: string): string {
  return `${base}/login/verify?token=${encodeURIComponent(token)}&purpose=${encodeURIComponent(purpose)}`;
}
