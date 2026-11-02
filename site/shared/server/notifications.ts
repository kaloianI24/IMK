// site/shared/server/notifications.ts — server-side notification dispatch.
//
// MVP: email via Resend only. A Telegram channel can be added here later
// (spec/07 §7.1-7.2) without touching the callers in api/contact.ts or
// api/moderate/review.ts.
//
// WHY IT MOVED (wave 13, function budget)
//   It used to live in api/lib/notifications.ts. A module under api/ is not a
//   shared module — Vercel builds ONE FUNCTION per file there, so a utility
//   with no default export is a dead function that still costs one of the
//   twelve Hobby slots. The module body is unchanged; only its home is.
//
// Environment (server-side only):
//   RESEND_API_KEY, RESEND_FROM, RESEND_TO, CONTACT_TO — existing Resend config
//   FORM_WEBHOOK_SECRET — HMAC secret for signed moderation links
//   SITE_URL — base URL for moderation links (fallback: https://www.imk.example)

import { createHmac } from 'node:crypto';
// The moderation links must resolve their base URL exactly like the portal
// does (audit m1): the operator changes ONE env var (SITE_BASE_URL), and a
// link pointing at the placeholder host is a 404 for the owner.
//
// The base URL comes from the SHARED session module — the one module both
// deployment trees read — so the link cannot drift from the portal's origin.
import { baseUrl } from './portal-session.js';

interface ReviewSubmission {
  ref: string;
  name: string;
  email?: string;
  company?: string;
  rating: string;
  review: string;
  /**
   * The revision of the quote this notification is about. It is SIGNED into
   * the one-click link, so the owner can only ever approve the exact text
   * they were shown (audit M5).
   */
  revision: number;
  /**
   * THE IDENTITY OF THE RECORD THIS NOTIFICATION IS ABOUT (wave 12, B-1).
   *
   * A revision number is NOT an identity: two concurrent submissions read the
   * same current record and both compute the same next revision, so two
   * records can share (ref, revision) — and a link carrying only the number
   * then approves the wrong one (audit MAJOR-1). The identity names the exact
   * record the text below came from.
   *
   * It travels SIGNED, next to the revision: the signature covers
   * `ref|decision|revision|recordId|ts`.
   */
  recordId?: string;
  /**
   * True when this mail is a REFRESH: the owner clicked a link for an older
   * revision and the client has since changed the quote. The wording says so,
   * because the quote below is not the one the first mail carried.
   */
  updated?: boolean;
}

interface ReviewDecision {
  ref: string;
  name: string;
  decision: 'approved' | 'rejected';
}

function notificationTo(): string | undefined {
  return process.env.RESEND_TO || process.env.CONTACT_TO;
}

function fromHeader(): string {
  return process.env.RESEND_FROM || 'IMK <onboarding@resend.dev>';
}

async function sendResendEmail(params: {
  to: string;
  subject: string;
  html: string;
  text: string;
}): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;
  const to = params.to;
  if (!apiKey || !to) {
    console.log(JSON.stringify({ ts: Date.now(), outcome: 'email_skipped', reason: 'keys-not-configured' }));
    return false;
  }
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: fromHeader(),
        to: [to],
        subject: params.subject,
        html: params.html,
        text: params.text,
      }),
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

/**
 * Sign a moderation link.
 *
 * The signed message is `ref|decision|revision|recordId|ts` when the link
 * names a record (wave 12, B-1) and the legacy `ref|decision|revision|ts`
 * when it does not.
 *
 * The REVISION is part of the signature (audit M5): without it the link
 * approved whatever the newest line for that ref happened to be, so the owner
 * could approve a quote they were never shown — the client may have edited it
 * after the mail went out.
 *
 * The RECORD IDENTITY is part of it too, and for the same reason: a revision
 * NUMBER is not an identity. Two concurrent submissions produce two records
 * with the same (ref, revision), and the number alone cannot say which of
 * them the owner was shown (audit MAJOR-1).
 *
 * The legacy form is still accepted, so a link that is already in an owner's
 * inbox keeps working. There is no downgrade: a link WITH an identity is
 * signed over the identity, so stripping it does not produce a valid legacy
 * signature.
 */
function signModerationLink(
  ref: string,
  decision: string,
  revision: number,
  ts: number,
  recordId?: string,
): string {
  const secret = process.env.FORM_WEBHOOK_SECRET || '';
  const message =
    recordId === undefined || recordId === ''
      ? `${ref}|${decision}|${revision}|${ts}`
      : `${ref}|${decision}|${revision}|${recordId}|${ts}`;
  return createHmac('sha256', secret).update(message).digest('hex');
}

export function moderationUrl(
  ref: string,
  decision: string,
  revision: number,
  ts: number,
  recordId?: string,
): string {
  const sig = signModerationLink(ref, decision, revision, ts, recordId);
  const base = baseUrl();
  const identity = recordId ? `&recordId=${encodeURIComponent(recordId)}` : '';
  return `${base}/api/moderate/review?ref=${encodeURIComponent(ref)}&decision=${encodeURIComponent(decision)}&revision=${encodeURIComponent(String(revision))}${identity}&sig=${encodeURIComponent(sig)}&ts=${ts}`;
}

export function verifyModerationSignature(
  ref: string,
  decision: string,
  revision: number,
  ts: number,
  sig: string,
  recordId?: string,
): boolean {
  const expected = signModerationLink(ref, decision, revision, ts, recordId);
  if (expected.length !== sig.length) return false;
  // timing-safe comparison
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  }
  return diff === 0;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export async function notifyReviewSubmitted(data: ReviewSubmission): Promise<void> {
  const to = notificationTo();
  if (!to) return;

  const ts = Math.floor(Date.now() / 1000);
  const approveUrl = moderationUrl(data.ref, 'approve', data.revision, ts, data.recordId);
  const rejectUrl = moderationUrl(data.ref, 'reject', data.revision, ts, data.recordId);

  const subject = data.updated
    ? `Updated IMK review (rating ${data.rating})`
    : `New IMK review (rating ${data.rating})`;
  const html = `
<h2>${data.updated ? 'Updated review' : 'New review'} (${data.ref})</h2>
${data.updated ? '<p><b>The client changed this quote</b> after the previous message — the text below is the current version.</p>' : ''}
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
${data.updated ? 'Updated review' : 'New review'} (${data.ref})
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

  await sendResendEmail({ to, subject, html, text: text.trim() });
}

export async function notifyReviewDecided(data: ReviewDecision): Promise<void> {
  const to = notificationTo();
  if (!to) return;

  const subject = `IMK review ${data.decision} (${data.ref})`;
  const html = `
<h2>Review ${data.decision} (${data.ref})</h2>
<p><b>Name:</b> ${escapeHtml(data.name)}</p>
<p><b>Decision:</b> ${data.decision}</p>
<p style="color:#888;font-size:12px;">ref ${data.ref} · ${new Date().toISOString()}</p>
`;
  const text = `Review ${data.decision} (${data.ref})\nName: ${data.name}\nref ${data.ref}`;

  await sendResendEmail({ to, subject, html, text });
}
