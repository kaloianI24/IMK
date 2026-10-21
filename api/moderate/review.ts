// api/moderate/review.ts — Vercel serverless function, GET /api/moderate/review
//
// HMAC-signed one-click approve/reject for pending reviews.
// Called from the notification email links (api/lib/notifications.ts).
//
// Query params:
//   ref   — review ref (e.g. inq_a1b2c3d4)
//   decision — "approve" | "reject"
//   revision — the revision of the quote this link was built for
//   sig   — HMAC-SHA256(FORM_WEBHOOK_SECRET, ref|decision|revision|ts)
//   ts    — unix timestamp (seconds), links expire after 7 days
//
// Behavior:
//   - Invalid/missing params → 400
//   - Bad/expired signature → 400
//   - Unknown ref → 404
//   - The link points at an OLD revision (the client changed the quote after
//     the mail went out) → 409 stale-revision; the owner is sent a fresh
//     link for the current revision so the quote can still be moderated
//   - Already decided → 200 (idempotent, no change)
//   - Valid → flips state in site/data/moderation/reviews.jsonl,
//     sends confirmation email via Resend, returns 200
//
// Environment (server-side only):
//   FORM_WEBHOOK_SECRET — HMAC signing secret
//   RESEND_API_KEY, RESEND_FROM, RESEND_TO / CONTACT_TO — confirmation email

import { IncomingMessage, ServerResponse } from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  notifyReviewDecided,
  notifyReviewSubmitted,
  verifyModerationSignature,
} from '../lib/notifications.js';
import { readJsonlFile, guardStorage } from '../lib/jsonl.js';

const REVIEWS_DIR = path.resolve(process.cwd(), 'site/data/moderation');
const REVIEWS_FILE = path.join(REVIEWS_DIR, 'reviews.jsonl');
const CLIENTS_FILE = path.resolve(process.cwd(), 'site/data/portal/clients.jsonl');

const LINK_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

function json(
  res: ServerResponse,
  body: any,
  status = 200,
  extra: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    ...extra,
  });
  res.end(payload);
}

/**
 * Thrown when the moderation store cannot be reached AT ALL.
 *
 * A store that cannot be read must never look like a store that is empty:
 * "review not found" tells the owner their quote is gone, which is the exact
 * silent outage the strict parser was introduced to kill (audit M3 / QA D3).
 * The Cloudflare twin answers 501 for the same situation; this tree must
 * answer the same thing when the store file is not there at all.
 */
class StoreUnreachableError extends Error {
  constructor() {
    super('moderation store unreachable');
    this.name = 'StoreUnreachableError';
  }
}

/**
 * Read the moderation log. A malformed line is an ERROR (audit M3 / QA D3):
 * it must not read as "this review does not exist" — the owner would be told
 * the quote is gone while the client still sees it waiting for approval.
 *
 * A MISSING file is not an empty log: it is a store this target cannot
 * serve (the function filesystem is read-only in production, and a deployment
 * that does not carry site/data/ has no log at all). That is 501, not 404.
 */
function readReviews(): Array<Record<string, any>> {
  if (!fs.existsSync(REVIEWS_FILE)) throw new StoreUnreachableError();
  return readJsonlFile(REVIEWS_FILE);
}

/**
 * Persist the moderation log.
 *
 * Returns false when the write could not happen. The caller must NOT answer
 * "approved" for a decision that was never stored — the owner would believe
 * the quote is published while the store still says pending.
 */
function writeReviews(reviews: Array<Record<string, any>>): boolean {
  try {
    fs.mkdirSync(REVIEWS_DIR, { recursive: true });
    const content = reviews.map((r) => JSON.stringify(r)).join('\n') + (reviews.length ? '\n' : '');
    fs.writeFileSync(REVIEWS_FILE, content, 'utf8');
    return true;
  } catch {
    return false;
  }
}

function isLinkExpired(ts: number): boolean {
  const now = Math.floor(Date.now() / 1000);
  return now - ts > LINK_TTL_SECONDS || ts - now > 60; // also reject future timestamps > 1 min
}

/**
 * The e-mail of the client behind a review record. The review record itself
 * holds NO address (audit M2) — it is looked up in the client store, and only
 * for the owner's own notification channel.
 */
function clientEmailFor(clientId: string): string | undefined {
  if (!clientId) return undefined;
  const clients = readJsonlFile(CLIENTS_FILE);
  const client = clients.find((c) => c.id === clientId);
  return client && client.email ? String(client.email) : undefined;
}

async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method !== 'GET') {
    json(res, { error: 'method not allowed', code: 'method' }, 405, { Allow: 'GET' });
    return;
  }

  const url = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
  const ref = url.searchParams.get('ref');
  const decision = url.searchParams.get('decision');
  const revisionParam = url.searchParams.get('revision');
  const sig = url.searchParams.get('sig');
  const tsParam = url.searchParams.get('ts');

  // --- parameter validation ---
  if (!ref || !decision || !revisionParam || !sig || !tsParam) {
    json(res, { error: 'missing parameters', code: 'validation' }, 400);
    return;
  }

  if (decision !== 'approve' && decision !== 'reject') {
    json(res, { error: 'invalid decision', code: 'validation' }, 400);
    return;
  }

  // The revision is part of the signed message: the link may only approve the
  // exact text the owner was shown (audit M5).
  const revision = Number(revisionParam);
  if (!Number.isInteger(revision) || revision < 1) {
    json(res, { error: 'invalid revision', code: 'validation' }, 400);
    return;
  }

  const ts = Number(tsParam);
  if (!Number.isFinite(ts) || ts <= 0) {
    json(res, { error: 'invalid timestamp', code: 'validation' }, 400);
    return;
  }

  if (isLinkExpired(ts)) {
    json(res, { error: 'link expired', code: 'expired' }, 400);
    return;
  }

  const secret = process.env.FORM_WEBHOOK_SECRET;
  if (!secret) {
    json(res, { error: 'misconfigured', code: 'internal' }, 500);
    return;
  }

  // --- signature verification ---
  if (!verifyModerationSignature(ref, decision, revision, ts, sig)) {
    json(res, { error: 'invalid signature', code: 'signature' }, 400);
    return;
  }

  // --- state flip in JSONL ---
  let reviews: Array<Record<string, any>>;
  try {
    reviews = readReviews();
  } catch (err) {
    if (err instanceof StoreUnreachableError) {
      // The store is not there at all: this target cannot moderate. Never
      // answer "review not found" — that reads as "your quote is gone".
      console.log(
        JSON.stringify({ ts: Date.now(), outcome: 'moderation_store_unreachable' }),
      );
      json(
        res,
        { error: 'moderation store unavailable on this target', code: 'unimplemented' },
        501,
      );
      return;
    }
    // A corrupt store is caught by guardStorage below (500 {code:'storage'}).
    throw err;
  }

  // Later lines win: when a client edits or withdraws a quote the portal
  // appends a new line with the same ref, and the publisher applies the same
  // rule. Deciding the newest line keeps approval and publication in step.
  let idx = -1;
  for (let i = 0; i < reviews.length; i++) {
    if (reviews[i].ref === ref && reviews[i].type === 'review') idx = i;
  }
  if (idx === -1) {
    json(res, { error: 'review not found', code: 'not-found' }, 404);
    return;
  }

  const record = reviews[idx];
  const currentRevision = Number(record.revision || 0);

  if (currentRevision !== revision) {
    // The client changed the quote after this link was mailed. Approving it
    // would publish text the owner never saw — so refuse, and send a fresh
    // link for the current revision so the quote can still be moderated.
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

    if (record.state === 'pending' && String(record.review || '').trim()) {
      try {
        await notifyReviewSubmitted({
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

    json(
      res,
      {
        error: 'this review was changed after the link was sent',
        code: 'stale-revision',
        ref,
        revision: currentRevision,
      },
      409,
    );
    return;
  }

  if (record.state !== 'pending') {
    // idempotent: already decided, no change
    json(res, { ok: true, ref, state: record.state, decidedAt: record.decidedAt }, 200);
    return;
  }

  const now = new Date().toISOString();
  record.state = decision === 'approve' ? 'approved' : 'rejected';
  record.decidedAt = now;
  record.decidedBy = 'one-click-link';

  // The decision is only real once it is stored. A write that fails must not
  // be answered with "approved": the owner would believe the quote is
  // published while the store still says pending (audit wave-6, F-3).
  if (!writeReviews(reviews)) {
    console.log(JSON.stringify({ ts: Date.now(), ref, outcome: 'storage_write_failed' }));
    json(res, { error: 'storage unavailable', code: 'storage' }, 500);
    return;
  }

  // --- confirmation email ---
  try {
    await notifyReviewDecided({ ref, name: record.name || '—', decision: record.state });
  } catch {
    // notification failures never fail the request
    console.log(JSON.stringify({ ts: Date.now(), ref, outcome: 'notify_fail' }));
  }

  // --- redacted log ---
  console.log(
    JSON.stringify({
      ts: Date.now(),
      ref,
      outcome: 'review_decided',
      decision: record.state,
      decidedBy: 'one-click-link',
    }),
  );

  json(res, { ok: true, ref, state: record.state }, 200);
}

// A corrupt moderation log must never look like "review not found"
// (audit M3 / QA D3): the owner could never approve a quote.
export default function (
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  return guardStorage(
    () => handler(req, res),
    (err) => {
      console.log(
        JSON.stringify({
          ts: Date.now(),
          outcome: 'storage_corrupt',
          file: err.file,
          line: err.line,
        }),
      );
      json(res, { error: 'storage unavailable', code: 'storage' }, 500);
    },
  );
}
