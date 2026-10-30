// site/shared/server/platform-address.ts
//
// THE ADDRESS OF THE CALLER — but ONLY a platform-controlled one.
//
// WHY THIS FILE EXISTS (wave 12, B-2)
//   A rate-limit bucket must not be something the CLIENT can choose. A client
//   that sends a different address on every request gets a fresh bucket every
//   time, so the limit is never reached and the counter table grows without
//   bound.
//
//   The wave-10 fix (F-5) read `cf-connecting-ip` FIRST. That header is set
//   by CLOUDFLARE, and only by Cloudflare: the launch target is Vercel, and
//   Vercel neither sets it nor strips it, so a client that rotates it got a
//   fresh bucket per request — measured 0/8 limited where a fixed address
//   gave 3/8 (audit MAJOR-2). The same header was also used for the
//   Turnstile `remoteip` and for the contact form's per-IP limit.
//
// THE ORDER (and why)
//   1. cf-connecting-ip  — ONLY when Cloudflare really is in front of this
//      deployment (TRUST_CF_CONNECTING_IP=1). Cloudflare overwrites it, so it
//      is the real client address; without Cloudflare it is whatever the
//      client sent.
//   2. x-real-ip         — Vercel's own single-value client address. Vercel
//      sets it and overwrites whatever came in.
//   3. x-vercel-forwarded-for — Vercel's chain; the LAST hop is the address
//      Vercel itself saw, so it is never the client's choice.
//   4. x-forwarded-for   — the generic chain. The platform APPENDS the
//      address it saw, so the LAST hop is the platform's view, never the
//      first (a client may put its own address in front).
//   5. nothing           — the caller gets the per-instance bucket instead:
//      the limit is still enforced, it is simply not shared between
//      instances.
//
// EDGE-SAFE BY DESIGN
//   No `node:` imports: both handler trees use this module.

/** A header getter that works for Node's IncomingHttpHeaders and Headers. */
export type HeaderGetter = (name: string) => string | null | undefined;

export interface PlatformAddressOptions {
  /**
   * Trust `cf-connecting-ip`.
   *
   * ONLY true when Cloudflare is actually in front of this deployment: the
   * header is then set and overwritten by Cloudflare, and it carries the real
   * client address. On a deployment that is NOT behind Cloudflare the header
   * is whatever the client sent, and trusting it would hand the client the
   * choice of its own rate-limit bucket.
   */
  trustCfConnectingIp?: boolean;
}

/** The last hop of a comma-separated header chain, or null. */
function lastHop(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const hops = value
    .split(',')
    .map((hop) => hop.trim())
    .filter(Boolean);
  if (hops.length === 0) return null;
  return hops[hops.length - 1];
}

/** A single-value header, trimmed, or null. */
function single(get: HeaderGetter, name: string): string | null {
  const value = get(name);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * The caller's address, when the platform controls it.
 *
 * Returns null when there is no trustworthy address — the caller then uses a
 * per-instance bucket (portal-handlers/portal-auth.ts: INSTANCE_BUCKET).
 */
export function platformAddress(
  get: HeaderGetter,
  options: PlatformAddressOptions = {},
): string | null {
  if (options.trustCfConnectingIp) {
    const cf = single(get, 'cf-connecting-ip');
    if (cf) return cf;
  }

  // Vercel's own single-value client address.
  const real = single(get, 'x-real-ip');
  if (real) return real;

  // Vercel's chain: the last hop is the address Vercel itself saw.
  const vercel = lastHop(get('x-vercel-forwarded-for'));
  if (vercel) return vercel;

  // The generic chain: the platform appends the address it saw, so the LAST
  // hop is the platform's view — never the client's choice.
  const forwarded = lastHop(get('x-forwarded-for'));
  if (forwarded) return forwarded;

  return null;
}

/**
 * Is `cf-connecting-ip` trusted on this deployment?
 *
 * The switch is explicit and OFF by default: a deployment that is not behind
 * Cloudflare must not believe a header the client can send. The Cloudflare
 * tree is behind Cloudflare by construction, so it turns it on (the runtime
 * always sets the header); the Vercel tree reads the environment.
 */
export function trustCfConnectingIp(env: Record<string, string | undefined>): boolean {
  const value = String(env.TRUST_CF_CONNECTING_IP || '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}
