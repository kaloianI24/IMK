// IMK form/routing/SEO contracts — single source. Mirrors spec/interface-spec.md §2/§3/§5.
export const CTA_ROLES = ['book-15','audit','quote','discuss','see-pricing'] as const;
export type CtaRole = (typeof CTA_ROLES)[number];

export const BUDGET_ENUM = ['under-1k','1k-3k','3k-6k','6k-10k','10k+','not-sure'] as const;
export type Budget = (typeof BUDGET_ENUM)[number];
export const BUDGET_LABELS: Record<Budget, string> = {
  'under-1k': 'Under £1,000 (or local equivalent)',
  '1k-3k': '£1,000 – £3,000',
  '3k-6k': '£3,000 – £6,000',
  '6k-10k': '£6,000 – £10,000',
  '10k+': '£10,000+',
  'not-sure': 'Not sure yet',
};

export const TIMELINE_ENUM = ['asap','1-month','3-months','exploring'] as const;
export type Timeline = (typeof TIMELINE_ENUM)[number];
export const TIMELINE_LABELS: Record<Timeline, string> = {
  'asap': 'ASAP',
  '1-month': 'Within 1 month',
  '3-months': '1 – 3 months',
  'exploring': 'Exploring / no rush',
};

export const MAX = {
  name: 80, email: 254, company: 120, project: 500, bodyBytes: 4194304, honeypotMs: 3000, staleMs: 4 * 60 * 60 * 1000,
} as const;

// Client testimonial limits (spec RP-8.1).
//
// The published-quote content collection uses these as its schema caps, and
// the server writes client-record fields under the same caps — see
// api/portal/testimonials.ts (MAX_CLIENT_NAME / _COMPANY / _ROLE).
//
// The two trees cannot share one file (the API deploys independently of the
// site), so these numbers are duplicated on purpose: they must be kept in
// step. A schema cap that is TIGHTER than what the server can write breaks
// the build on a long client name — that is why the caps are equal, and why
// the quote cap is deliberately looser than the API's 1000 (a wider net never
// breaks the build, a narrower one can).
export const TESTIMONIAL_MAX = {
  name: 80, company: 120, role: 120, quote: 2000,
} as const;

// Owner-entered client-profile caps (spec/08 §4.5, task T8l).
//
// The invite form writes name / company / role into the client record; the API
// caps them again at the point of entry (api/portal/invites.ts) and the
// published schema validates them at build time. Same numbers, one source —
// derived from TESTIMONIAL_MAX rather than repeated, because a form limit that
// is looser than the server's is the one that lets a value through and get
// rejected, and a schema limit that is tighter is the one that breaks the
// build.
export const CLIENT_PROFILE_MAX = {
  name: TESTIMONIAL_MAX.name,
  company: TESTIMONIAL_MAX.company,
  role: TESTIMONIAL_MAX.role,
} as const;