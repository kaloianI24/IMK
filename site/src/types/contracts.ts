// IXI form/routing/SEO contracts — single source. Mirrors spec/interface-spec.md §2/§3/§5.
export const CTA_ROLES = ['book-15','audit','quote','discuss','see-pricing'] as const;
export type CtaRole = (typeof CTA_ROLES)[number];

export const BUDGET_ENUM = ['under-1k','1k-5k','5k-15k','15k+','not-sure'] as const;
export type Budget = (typeof BUDGET_ENUM)[number];
export const BUDGET_LABELS: Record<Budget, string> = {
  'under-1k': 'Under £1,000 (or local equivalent)',
  '1k-5k': '£1,000 – £5,000',
  '5k-15k': '£5,000 – £15,000',
  '15k+': '£15,000+',
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
  name: 80, email: 254, company: 120, project: 500, bodyBytes: 8192, honeypotMs: 3000, staleMs: 4 * 60 * 60 * 1000,
} as const;