// site/functions/api/moderate/review.ts — Cloudflare Pages Function, GET /api/moderate/review
//
// Mirrors api/moderate/review.ts (Vercel) so both targets share the same
// HMAC-signed approve/reject behavior. Kept in sync by design (spec/07 §1, D-6).
//
// Query params: ref, decision, revision, sig, ts — see api/moderate/review.ts
//
// The signature and the link shape are shared with the Vercel tree through
// site/functions/api/lib/notifications.ts, so a link works on either target.

import {
  notifyReviewDecided,
  notifyReviewSubmitted,
  verifyModerationSignature,
} from '../lib/notifications.js';
import type { Env } from '../lib/notifications.js';
import { parseJsonlStrict, isStorageCorrupt } from '../../../shared/portal-store/jsonl.js';

const LINK_TTL_SECONDS = 7 * 24 * 60 * 60;

function json(body: any, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...extra },
  });
}

/**
 * Thrown when the moderation store cannot be reached AT ALL.
 *
 * The edge runtime has no filesystem, so the moderation log simply does not
 * exist there. That is NOT "the quote does not exist" — it is a missing
 * store. A store that cannot be reached must never look like an empty one
 * (audit M3 / QA D3).
 */
class StoreUnreachableError extends Error {
  constructor() {
    super('moderation store unreachable');
    this.name = 'StoreUnreachableError';
  }
}

const REVIEWS_FILE = 'site/data/moderation/reviews.jsonl';
const CLIENTS_FILE = 'site/data/portal/clients.jsonl';

function edgeFs(): any {
  return (globalThis as any).require ? (globalThis as any).require('node:fs') : null;
}

/**
 * The e-mail of the client behind a review record. The review record itself
 * holds NO address (audit M2) — it is looked up in the client store, and only
 * for the owner's own notification channel. Mirrors the Vercel twin's
 * `clientEmailFor` (review finding B2).
 */
function clientEmailFor(clientId: string): string | undefined {
  if (!clientId) return undefined;
  const fs = edgeFs();
  if (!fs) return undefined;
  if (!fs.existsSync(CLIENTS_FILE)) return undefined;
  const clients = parseJsonlStrict(fs.readFileSync(CLIENTS_FILE, 'utf8'), CLIENTS_FILE);
  const client = clients.find((c: Record<string, any>) => c.id === clientId);
  return client && client.email ? String(client.email) : undefined;
}

/**
 * Read the moderation log through the SAME strict parser the Vercel tree
 * uses (`site/shared/portal-store/jsonl.ts`).
 *
 * A malformed line throws StorageCorruptError (file + line). It is never
 * skipped: skipping it made the whole log read as "no such review", so a
 * pending quote looked gone (audit M3 / QA D3, QA wave-3 D-1).
 */
function readReviews(): Array<Record<string, any>> {
  const fs = edgeFs();
  if (!fs) throw new StoreUnreachableError();
  // A MISSING file is not an empty log (parity with api/moderate/review.ts):
  // it is a store this target cannot serve. Answering "review not found"
  // (404) here would tell the owner their quote is gone — the exact silent
  // outage the strict parser was introduced to kill (audit M3 / QA D3).
  // The Vercel twin throws StoreUnreachableError for the same situation and
  // answers 501 {code:'unimplemented'}; the two trees must not disagree
  // (spec/07 §1, D-6 — QA wave-5 defect D-4).
  if (!fs.existsSync(REVIEWS_FILE)) throw new StoreUnreachableError();
  const content = fs.readFileSync(REVIEWS_FILE, 'utf8');
  return parseJsonlStrict(content, REVIEWS_FILE);
}

/**
 * Persist the moderation log.
 *
 * Returns false when the write could not happen. The caller must NOT answer
 * "approved" for a decision that was never stored.
 */
function writeReviews(reviews: Array<Record<string, any>>): boolean {
  const fs = edgeFs();
  if (!fs) return false;
  try {
    fs.mkdirSync('site/data/moderation', { recursive: true });
    const content = reviews.map((r) => JSON.stringify(r)).join('\n') + (reviews.length ? '\n' : '');
    fs.writeFileSync(REVIEWS_FILE, content, 'utf8');
    return true;
  } catch {
    return false;
  }
}

export const onRequestGet: any = async (ctx: any) => {
  const { request, env } = ctx;
  const url = new URL(request.url);
  const ref = url.searchParams.get('ref');
  const decision = url.searchParams.get('decision');
  const revisionParam = url.searchParams.get('revision');
  const sig = url.searchParams.get('sig');
  const tsParam = url.searchParams.get('ts');

  if (!ref || !decision || !revisionParam || !sig || !tsParam) {
    return json({ error: 'missing parameters', code: 'validation' }, 400);
  }
  if (decision !== 'approve' && decision !== 'reject') {
    return json({ error: 'invalid decision', code: 'validation' }, 400);
  }
  // The revision is signed into the link: it may only approve the exact text
  // the owner was shown (audit M5).
  const revision = Number(revisionParam);
  if (!Number.isInteger(revision) || revision < 1) {
    return json({ error: 'invalid revision', code: 'validation' }, 400);
  }
  const ts = Number(tsParam);
  if (!Number.isFinite(ts) || ts <= 0) {
    return json({ error: 'invalid timestamp', code: 'validation' }, 400);
  }
  const now = Math.floor(Date.now() / 1000);
  if (now - ts > LINK_TTL_SECONDS || ts - now > 60) {
    return json({ error: 'link expired', code: 'expired' }, 400);
  }
  if (!env.FORM_WEBHOOK_SECRET) {
    return json({ error: 'misconfigured', code: 'internal' }, 500);
  }

  const ok = await verifyModerationSignature(
    env as Env,
    ref,
    decision,
    revision,
    ts,
    sig,
  );
  if (!ok) {
    return json({ error: 'invalid signature', code: 'signature' }, 400);
  }

  let reviews: Array<Record<string, any>>;
  try {
    reviews = readReviews();
  } catch (err) {
    if (err instanceof StoreUnreachableError) {
      // The edge runtime has no filesystem: there is no moderation store here.
      // "review not found" would tell the owner their quote is gone.
      return json(
        { error: 'moderation store unavailable on this target', code: 'unimplemented' },
        501,
      );
    }
    if (isStorageCorrupt(err)) {
      console.log(
        JSON.stringify({
          ts: Date.now(),
          outcome: 'storage_corrupt',
          file: err.file,
          line: err.line,
        }),
      );
      return json({ error: 'storage unavailable', code: 'storage' }, 500);
    }
    throw err;
  }
  // Later lines win (same rule as the publisher): a client who edits or
  // withdraws a quote appends a new line with the same ref.
  let idx = -1;
  for (let i = 0; i < reviews.length; i++) {
    if (reviews[i].ref === ref && reviews[i].type === 'review') idx = i;
  }
  if (idx === -1) {
    return json({ error: 'review not found', code: 'not-found' }, 404);
  }

  const record = reviews[idx];
  const currentRevision = Number(record.revision || 0);
  if (currentRevision !== revision) {
    // The client changed the quote after this link was mailed: approving it
    // would publish text the owner never saw.
    console.log(
      JSON.stringify({
        ts: Date.now(),
        ref,
        outcome: 'review_revision_stale',
        linkRevision: revision,
        currentRevision,
        state: record.state,
      }),
    );

    // ...and the owner gets a FRESH link for the current revision, so the
    // moderation can still be finished without waiting for another client
    // action (review finding B2 — parity with api/moderate/review.ts:219-249;
    // only when the newest revision is still a pending quote — a snoozed or
    // declined quote mails nothing).
    if (record.state === 'pending' && String(record.review || '').trim()) {
      try {
        await notifyReviewSubmitted(env as Env, {
          ref: record.ref,
          name: record.name || 'Anonymous client',
          email: clientEmailFor(String(record.clientId || '')),
          company: record.company || '',
          rating: record.rating || '—',
          review: record.review || '',
          revision: currentRevision,
          updated: true,
        });
      } catch {
        console.log(JSON.stringify({ ts: Date.now(), ref, outcome: 'notify_fail' }));
      }
    }

    return json(
      {
        error: 'this review was changed after the link was sent',
        code: 'stale-revision',
        ref,
        revision: currentRevision,
      },
      409,
    );
  }

  if (record.state !== 'pending') {
    return json({ ok: true, ref, state: record.state, decidedAt: record.decidedAt }, 200);
  }

  record.state = decision === 'approve' ? 'approved' : 'rejected';
  record.decidedAt = new Date().toISOString();
  record.decidedBy = 'one-click-link';
  // The decision is only real once it is stored. A write that fails must not
  // be answered with "approved": the owner would believe the quote is
  // published while the store still says pending.
  if (!writeReviews(reviews)) {
    console.log(JSON.stringify({ ts: Date.now(), ref, outcome: 'storage_write_failed' }));
    return json({ error: 'storage unavailable', code: 'storage' }, 500);
  }

  try {
    await notifyReviewDecided(env as Env, {
      ref,
      name: record.name || '—',
      decision: record.state,
    });
  } catch {
    // notification failures never fail the request
  }

  return json({ ok: true, ref, state: record.state }, 200);
};
