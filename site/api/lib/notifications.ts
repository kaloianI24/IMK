// site/functions/api/lib/notifications.ts — Cloudflare Pages Function module.
//
//   A SEPARATE COPY of the Vercel module site/shared/server/notifications.ts:
//   the two files are NOT the same code, and an edit to the Vercel module
//   does NOT reach this file. Change the Vercel module and change THIS file
//   too.
//
// The edge twin of site/shared/server/notifications.ts (Vercel). Before this file the CF
// tree had NO notification path at all: a testimonial submitted on the CF
// target produced no mail, no one-click approve/reject link and no owner
// notification — the quote sat `pending` forever and nobody knew it existed
// (audit M6).
//
// EDGE-SAFE BY DESIGN: no node: imports. The HMAC is computed with
// crypto.subtle, not node:crypto.
//
// The signed message and the link shape are IDENTICAL to the Vercel tree
// (`ref|decision|revision|recordId|ts`, and the legacy
// `ref|decision|revision|ts` for a link minted before wave 12), so a link
// works on whichever target served the site, and the revision binding that
// stops the owner from approving a quote they were never shown (audit M5) is
// in force here too.

import { baseUrl } from '../../shared/server/portal-session.js';

export interface Env {
  FORM_WEBHOOK_SECRET?: string;
  RESEND_API_KEY?: string;
  RESEND_FROM?: string;
  RESEND_TO?: string;
  CONTACT_TO?: string;
  SITE_BASE_URL?: string;
  SITE_URL?: string;
  APP_ENV?: string;
}

export interface ReviewSubmission {
  ref: string;
  name: string;
  email?: string;
  company?: string;
  rating: string;
  review: string;
  /** The revision this mail (and its links) is about. */
  revision: number;
  /**
   * THE IDENTITY OF THE RECORD THIS MAIL IS ABOUT (wave 12, B-1).
   *
   * A revision number is NOT an identity: two concurrent submissions compute
   * the same revision from the same read, so two records can share
   * (ref, revision) — and a link carrying only the number then approves the
   * wrong one (audit MAJOR-1). The identity names the exact record.
   */
  recordId?: string;
  /** True when the client changed the quote after an earlier message. */
  updated?: boolean;
}

export interface ReviewDecision {
  ref: string;
  name: string;
  decision: 'approved' | 'rejected';
}

function notificationTo(env: Env): string | undefined {
  return env.RESEND_TO || env.CONTACT_TO;
}

function fromHeader(env: Env): string {
  return env.RESEND_FROM || 'IMK <2imk4support@gmail.com>';
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function sha256Hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const buf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(buf)).map((x) => x.toString(16).padStart(2, '0')).join('');
}

/**
 * Sign a moderation link.
 *
 * The signed message is `ref|decision|revision|recordId|ts` when the link
 * names a record (wave 12, B-1) and the legacy `ref|decision|revision|ts`
 * when it does not. The legacy form is still accepted, so a link that is
 * already in an owner's inbox keeps working; there is no downgrade, because
 * a link WITH an identity is signed over the identity.
 */
async function signModerationLink(
  secret: string,
  ref: string,
  decision: string,
  revision: number,
  ts: number,
  recordId?: string,
): Promise<string> {
  const message =
    recordId === undefined || recordId === ''
      ? `${ref}|${decision}|${revision}|${ts}`
      : `${ref}|${decision}|${revision}|${recordId}|${ts}`;
  return sha256Hmac(secret, message);
}

export async function verifyModerationSignature(
  env: Env,
  ref: string,
  decision: string,
  revision: number,
  ts: number,
  sig: string,
  recordId?: string,
): Promise<boolean> {
  const secret = env.FORM_WEBHOOK_SECRET || '';
  const expected = await signModerationLink(secret, ref, decision, revision, ts, recordId);
  if (expected.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Build a signed one-click link.
 *
 * The signature is computed with crypto.subtle, which is async on the edge —
 * so unlike the Vercel twin this helper returns a Promise. There is
 * deliberately NO synchronous variant: a link without a real signature is a
 * link that cannot work.
 */
export async function buildModerationUrl(
  env: Env,
  ref: string,
  decision: string,
  revision: number,
  ts: number,
  recordId?: string,
): Promise<string> {
  const secret = env.FORM_WEBHOOK_SECRET || '';
  const sig = await signModerationLink(secret, ref, decision, revision, ts, recordId);
  const base = baseUrl(env);
  const identity = recordId ? `&recordId=${encodeURIComponent(recordId)}` : '';
  return `${base}/api/moderate/review?ref=${encodeURIComponent(ref)}&decision=${encodeURIComponent(decision)}&revision=${encodeURIComponent(String(revision))}${identity}&sig=${encodeURIComponent(sig)}&ts=${ts}`;
}

async function sendResendEmail(
  env: Env,
  to: string,
  subject: string,
  html: string,
  text: string,
): Promise<boolean> {
  const apiKey = env.RESEND_API_KEY;
  if (!apiKey || !to) {
    console.log(JSON.stringify({ ts: Date.now(), outcome: 'email_skipped', reason: 'keys-not-configured' }));
    return false;
  }
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: fromHeader(env), to: [to], subject, html, text }),
    });
    if (!r.ok) {
      console.log(JSON.stringify({ ts: Date.now(), outcome: 'email_fail', status: r.status }));
      return false;
    }
    return true;
  } catch {
    console.log(JSON.stringify({ ts: Date.now(), outcome: 'email_error' }));
    return false;
  }
}

export async function notifyReviewSubmitted(env: Env, data: ReviewSubmission): Promise<void> {
  const to = notificationTo(env);
  if (!to) return;

  const ts = Math.floor(Date.now() / 1000);
  const approveUrl = await buildModerationUrl(env, data.ref, 'approve', data.revision, ts, data.recordId);
  const rejectUrl = await buildModerationUrl(env, data.ref, 'reject', data.revision, ts, data.recordId);

  const heading = data.updated ? 'Updated review' : 'New review';
  const subject = data.updated
    ? `Updated IMK review (rating ${data.rating})`
    : `New IMK review (rating ${data.rating})`;
  const changed = data.updated
    ? '<p><b>The client changed this quote</b> after the previous message — the text below is the current version.</p>'
    : '';

  const html = `
<h2>${heading} (${data.ref})</h2>
${changed}
<p><b>Name:</b> ${escapeHtml(data.name || '—')}</p>
<p><b>Email:</b> ${escapeHtml(data.email || '—')}</p>
<p><b>Company:</b> ${escapeHtml(data.company || '—')}</p>
<p><b>Rating:</b> ${escapeHtml(data.rating)} / 5</p>
<p><b>Review:</b></p><p>${escapeHtml(data.review).replace(/\n/g, '<br>')}</p>
<hr>
<p><a href="${escapeHtml(approveUrl)}">Approve</a> | <a href="${escapeHtml(rejectUrl)}">Reject</a></p>
<p style="color:#888;font-size:12px;">ref ${data.ref} · revision ${data.revision} · ${new Date(ts * 1000).toISOString()} · links expire in 7 days</p>
`;
  const text = `
${heading} (${data.ref})
${data.updated ? 'The client changed this quote after the previous message — the text below is the current version.\n' : ''}
Name: ${data.name || '—'}
Email: ${data.email || '—'}
Company: ${data.company || '—'}
Rating: ${data.rating} / 5
Review: ${data.review}

Approve: ${approveUrl}
Reject: ${rejectUrl}

ref ${data.ref} · revision ${data.revision} · links expire in 7 days
`;

  await sendResendEmail(env, to, subject, html, text.trim());
}

export async function notifyReviewDecided(env: Env, data: ReviewDecision): Promise<void> {
  const to = notificationTo(env);
  if (!to) return;

  const subject = `IMK review ${data.decision} (${data.ref})`;
  const html = `
<h2>Review ${data.decision} (${data.ref})</h2>
<p><b>Name:</b> ${escapeHtml(data.name)}</p>
<p><b>Decision:</b> ${data.decision}</p>
<p style="color:#888;font-size:12px;">ref ${data.ref} · ${new Date().toISOString()}</p>
`;
  const text = `Review ${data.decision} (${data.ref})\nName: ${data.name}\nref ${data.ref}`;

  await sendResendEmail(env, to, subject, html, text);
}
