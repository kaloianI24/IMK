// Consent copy for the client testimonial card — SINGLE SOURCE (spec RP-7.1).
//
// The owner revises these strings here; no component hard-codes consent text.
// RP-7.3: the wording must name the website, say the quote may be edited for
// length/grammar, say consent can be withdrawn, and say how to withdraw it.
//
// DRAFT: the exact wording is still pending owner approval (spec Q3 / RP-7.3).
// Nothing here ships to a client until the owner signs the wording off.

export const SITE_NAME = 'IMK';
export const SITE_LABEL = 'the IMK website';
export const SUPPORT_EMAIL = '2imk4support@gmail.com';

export const TESTIMONIAL_CONSENT = {
  p1: `Yes — ${SITE_NAME} may publish this quote on ${SITE_LABEL}.`,
  p2: `Yes — ${SITE_NAME} may publish my name and company next to the quote.`,
  p3: `Yes — ${SITE_NAME} may publish this project as a named case study on ${SITE_LABEL}.`,
} as const;

export const TESTIMONIAL_NOTE =
  `We may shorten your quote for length or grammar, but we will not change what it means. ` +
  `You can withdraw this consent at any time by emailing ${SUPPORT_EMAIL} — the quote is then removed from the site.`;

export const TESTIMONIAL_INTRO =
  `You have worked with us, so you are the only person who really knows how it went. ` +
  `Two minutes is enough — and nothing is published without your say-so.`;
