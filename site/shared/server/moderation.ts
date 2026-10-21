// site/shared/server/moderation.ts — the moderation LINK contract, ONE module
// for both handler trees.
//
// WHY THIS FILE EXISTS (audit M-1, wave-8A)
//   The approve/reject link is a signed GET URL, and a signed GET URL is
//   fetched AUTOMATICALLY by everything that touches mail: corporate link
//   scanners, Gmail's URL handling, chat-preview bots, antivirus gateways.
//   Before this change, one such prefetch flipped the quote to "approved" —
//   the quote was published with nobody's consent, which is the exact thing
//   the owner inbox exists to prevent. The HMAC protected the link against
//   FORGERY; it did nothing about a legitimate prefetch of a legitimate link.
//
//   The fix: the link stays a GET (so the owner can click it in a mail), but
//   a GET only shows a CONFIRMATION PAGE. The state is flipped by a POST
//   that the confirmation form issues. A prefetch that only reads the page
//   cannot approve anything.
//
// ONE MODULE FOR BOTH TREES
//   Vercel    api/moderate/review.ts              -> ../../site/shared/server/moderation.js
//   Cloudflare site/functions/api/moderate/review.ts -> ../../../shared/server/moderation.js
//   The parsing, the expiry rule and the confirmation page therefore cannot
//   drift apart between the two targets (spec/07 §1, D-6).
//
// EDGE-SAFE BY DESIGN
//   No `node:` imports: plain TypeScript plus the Web Platform globals both
//   runtimes provide. The module is loaded by the Vercel (Node) handler and
//   by the Cloudflare Worker handler unchanged.

/** The path both trees serve the moderation endpoint on. */
export const MODERATION_PATH = '/api/moderate/review';

/** How long a moderation link stays valid. */
export const MODERATION_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

/** A future-dated link is refused after this many seconds (clock skew). */
export const MODERATION_FUTURE_SKEW_SECONDS = 60;

export interface ModerationParams {
  ref: string;
  decision: 'approve' | 'reject';
  revision: number;
  /** unix timestamp, seconds */
  ts: number;
  /** hex HMAC-SHA256 of `ref|decision|revision|ts` */
  sig: string;
}

export type ModerationParamResult =
  | { ok: true; params: ModerationParams }
  | { ok: false; status: number; body: { error: string; code: string } };

/**
 * Read and validate the signed parameters.
 *
 * `get` returns the raw value of one parameter or null. The order of the
 * checks is the contract: a missing parameter, an unknown decision, a
 * non-integer revision, an impossible timestamp and an expired link are
 * five different answers, and both trees answer them identically.
 *
 * The SIGNATURE IS NOT CHECKED HERE — the secret is per tree and lives
 * behind `verifyModerationSignature`. What is checked here is everything
 * that can be checked without the secret.
 */
export function parseModerationParams(
  get: (name: string) => string | null,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): ModerationParamResult {
  const ref = get('ref');
  const decision = get('decision');
  const revisionParam = get('revision');
  const sig = get('sig');
  const tsParam = get('ts');

  if (!ref || !decision || !revisionParam || !sig || !tsParam) {
    return {
      ok: false,
      status: 400,
      body: { error: 'missing parameters', code: 'validation' },
    };
  }

  if (decision !== 'approve' && decision !== 'reject') {
    return {
      ok: false,
      status: 400,
      body: { error: 'invalid decision', code: 'validation' },
    };
  }

  // The revision is part of the signed message: the link may only approve
  // the exact text the owner was shown (audit M5).
  const revision = Number(revisionParam);
  if (!Number.isInteger(revision) || revision < 1) {
    return {
      ok: false,
      status: 400,
      body: { error: 'invalid revision', code: 'validation' },
    };
  }

  const ts = Number(tsParam);
  if (!Number.isFinite(ts) || ts <= 0) {
    return {
      ok: false,
      status: 400,
      body: { error: 'invalid timestamp', code: 'validation' },
    };
  }

  if (isLinkExpired(ts, nowSeconds)) {
    return { ok: false, status: 400, body: { error: 'link expired', code: 'expired' } };
  }

  return {
    ok: true,
    params: { ref, decision, revision, ts, sig },
  };
}

/**
 * Is the link outside its window?
 *
 * Two directions: a link older than the TTL is refused, and a link dated
 * more than a minute into the future is refused (that would be a link
 * minted with a broken clock, and it would live longer than the TTL).
 */
export function isLinkExpired(ts: number, nowSeconds: number = Math.floor(Date.now() / 1000)): boolean {
  return (
    nowSeconds - ts > MODERATION_TTL_SECONDS ||
    ts - nowSeconds > MODERATION_FUTURE_SKEW_SECONDS
  );
}

/** Escape a value for HTML text and for a double-quoted attribute. */
export function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The confirmation page.
 *
 * The owner clicks the link in the mail and lands here. The page states
 * what the decision is and offers ONE button. The button is a plain form
 * POST — no JavaScript, no auto-submit — so a mail scanner that only
 * fetches the URL stops at this page, and a scanner that parses forms
 * would still have to press a button.
 *
 * The signed parameters travel in the form body. The signature covers
 * `ref|decision|revision|ts` and nothing else, so the same values verify
 * exactly as they did in the query string.
 *
 * `alreadyDecided` is set when the quote has already been decided: the
 * page says so and shows no button.
 */
export function renderConfirmationPage(options: {
  ref: string;
  decision: 'approve' | 'reject';
  revision: number;
  /** unix timestamp, seconds — travels in the form body */
  ts: number;
  /** the hex signature — travels in the form body */
  sig: string;
  alreadyDecided?: string;
}): string {
  const { ref, decision, revision } = options;
  const already = options.alreadyDecided;
  const verb = decision === 'approve' ? 'Approve' : 'Reject';
  const title = already
    ? 'Already decided'
    : `${verb} this quote?`;

  const body = already
    ? `<p class="lead">This quote was already <strong>${escapeHtml(already)}</strong>. Nothing was changed.</p>`
    : `<p class="lead">${verb} the quote <strong>${escapeHtml(ref)}</strong> (revision ${escapeHtml(
        String(revision),
      )})?</p>
       <p class="note">${verb === 'Approve' ? 'Approving publishes the quote as a testimonial.' : 'Rejecting closes the quote without publishing it.'} This link is valid for 7 days.</p>
       <form method="POST" action="${escapeHtml(MODERATION_PATH)}">
         <input type="hidden" name="ref" value="${escapeHtml(ref)}" />
         <input type="hidden" name="decision" value="${escapeHtml(decision)}" />
         <input type="hidden" name="revision" value="${escapeHtml(String(revision))}" />
         <input type="hidden" name="ts" value="${escapeHtml(String(options.ts ?? ''))}" />
         <input type="hidden" name="sig" value="${escapeHtml(options.sig ?? '')}" />
         <button type="submit" class="btn ${decision === 'approve' ? 'btn-primary' : 'btn-secondary'}">${verb} this quote</button>
       </form>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>${escapeHtml(title)} — IMK</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0;
         display: flex; min-height: 100vh; align-items: center; justify-content: center;
         background: #fdfaf5; color: #1b1b1b; }
  main { max-width: 34rem; padding: 2rem; background: #fff; border-radius: 12px;
         border: 1px solid #e6ded2; box-shadow: 0 1px 3px rgba(0,0,0,.06); }
  h1 { font-size: 1.35rem; margin: 0 0 .75rem; }
  .lead { margin: 0 0 .5rem; }
  .note { color: #6b6b6b; font-size: .9rem; margin: 0 0 1.25rem; }
  button { font: inherit; cursor: pointer; padding: .6rem 1.1rem; border-radius: 8px;
           border: 1px solid transparent; background: #EA0000; color: #fff; }
  button.btn-secondary { background: #fff; color: #1b1b1b; border-color: #c9c2b6; }
  button:focus-visible { outline: 3px solid #1b5fd0; outline-offset: 2px; }
  @media (prefers-color-scheme: dark) {
    body { background: #14110d; color: #f2ede4; }
    main { background: #1d1913; border-color: #332d24; }
    .note { color: #a79f93; }
    button.btn-secondary { background: #1d1913; color: #f2ede4; border-color: #4a4238; }
  }
</style>
</head>
<body>
<main>
  <h1>${escapeHtml(title)}</h1>
  ${body}
</main>
</body>
</html>
`;
}
