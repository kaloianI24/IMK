// site/shared/server/secret.ts — is this secret USABLE?
//
// WHY THIS FILE EXISTS (audit H-1, wave-8A)
//   Every secret guard in the project tested the PRESENCE of a secret, never
//   its VALUE. `site/.env.example` ships three secrets with the same
//   published placeholder ("your-32-byte-hex-hmac-secret-here"), and the
//   documented workflow is "copy the example file and replace the
//   placeholders". Miss one — on one secret or on all three — and the
//   deployment runs with a key that is published in the repository.
//
//   An empty HMAC key is a public key. A published one is the same thing
//   with extra steps: anybody who knows it can forge an admin session, a
//   sign-in link and a moderation link. The moderator's address is on the
//   public website.
//
//   So a secret is refused in production when it is
//     - MISSING    (empty),
//     - a PLACEHOLDER (the published example value), or
//     - TOO SHORT  (under 32 characters — not a 256-bit key).
//
// ONE MODULE FOR BOTH TREES
//   The Vercel tree (api/**) and the Cloudflare tree (site/functions/**)
//   both import this file, so the rule cannot drift between the targets.
//
// EDGE-SAFE BY DESIGN
//   No `node:` imports — plain TypeScript, no runtime dependency.

/**
 * The placeholder values that ship in `site/.env.example`.
 *
 * Lower-cased: the comparison is case-insensitive, because a copy-paste
 * that changed the case is still the published value.
 */
export const PUBLISHED_SECRET_PLACEHOLDERS = [
  'your-32-byte-hex-hmac-secret-here',
  'your-32-byte-hex-secret-here',
  'change-me',
  'changeme',
  'replace-me',
  'your-secret-here',
  'replace_me_form_webhook_secret_openssl_rand_hex_32',
  'replace_me_portal_magic_link_secret_openssl_rand_hex_32',
  'replace_me_portal_session_secret_openssl_rand_hex_32',
];

/** The shortest secret that is accepted in production (characters). */
export const MIN_SECRET_LENGTH = 32;

/** Why a secret cannot be used, or null when it is fine. */
export type SecretProblem = 'missing' | 'placeholder' | 'too-short' | null;

/**
 * Why is this secret unusable?
 *
 * The reason is what tells the operator whether to paste a new value or to
 * generate one — a bare "misconfigured" is a support ticket.
 */
export function secretProblem(value: string | null | undefined): SecretProblem {
  const raw = String(value || '').trim();
  if (!raw) return 'missing';
  if (PUBLISHED_SECRET_PLACEHOLDERS.includes(raw.toLowerCase())) return 'placeholder';
  if (raw.length < MIN_SECRET_LENGTH) return 'too-short';
  return null;
}

/** Is this secret usable in production? */
export function secretUsable(value: string | null | undefined): boolean {
  return secretProblem(value) === null;
}
