// site/functions/api/moderate/review.ts — Cloudflare Pages Function,
//   /api/moderate/review
//
// Mirrors api/moderate/review.ts (Vercel) so both targets share the same
// HMAC-signed approve/reject behavior. Kept in sync by design (spec/07 §1, D-6).
//
// Query params: ref, decision, revision, recordId, sig, ts — see
// api/moderate/review.ts. `recordId` is the identity of the record the link
// is about (wave 12, B-1); it is optional, and a link minted before wave 12
// carries none.
//
// THE METHOD IS THE POINT (audit M-1, wave-8A)
//   GET  → shows a CONFIRMATION PAGE. It NEVER changes the state.
//   POST → applies the decision.
//   A mail scanner that prefetches the owner's link must not approve a
//   quote, so the state is only ever changed by the POST the confirmation
//   form issues.
//
// The signature and the link shape are shared with the Vercel tree through
// site/functions/api/lib/notifications.ts, so a link works on either target.
// The parsing, the expiry rule and the confirmation page are shared through
// site/shared/server/moderation.ts, so the two trees cannot drift.

import {
  notifyReviewDecided,
  notifyReviewSubmitted,
  verifyModerationSignature,
} from '../lib/notifications.js';
import type { Env } from '../lib/notifications.js';
import { parseJsonlStrict, isStorageCorrupt } from '../../../shared/portal-store/jsonl.js';
import {
  MODERATION_PATH,
  parseModerationParams,
  renderConfirmationPage,
  type ModerationParams,
} from '../../../shared/server/moderation.js';
import { isProductionEnv } from '../../../shared/server/portal-session.js';
import { secretProblem } from '../../../shared/server/secret.js';

function json(body: any, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...extra },
  });
}

/** The confirmation page. It is a page, not an action. */
function html(body: string, status = 200) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'X-Robots-Tag': 'noindex, nofollow',
      'Cache-Control': 'no-store',
    },
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
 *
 * The write is ATOMIC (audit M-6): the content goes to a temporary file and
 * is then RENAMED over the target, so an interrupted write cannot leave a
 * half-written store behind.
 */
function writeReviews(reviews: Array<Record<string, any>>): boolean {
  const fs = edgeFs();
  if (!fs) return false;
  try {
    fs.mkdirSync('site/data/moderation', { recursive: true });
    const content = reviews.map((r) => JSON.stringify(r)).join('\n') + (reviews.length ? '\n' : '');
    const tmp = `${REVIEWS_FILE}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, REVIEWS_FILE);
    return true;
  } catch {
    return false;
  }
}

/**
 * The signed parameters, from the query string or — for a POST — from the
 * body (the confirmation form posts them as form fields).
 */
async function readModerationParams(request: Request):
  Promise<
    | { ok: true; params: ModerationParams }
    | { ok: false; status: number; body: { error: string; code: string } }
  > {
  const url = new URL(request.url);
  const fromQuery = parseModerationParams((name) => url.searchParams.get(name));
  if (fromQuery.ok) return fromQuery;
  if (request.method !== 'POST') return fromQuery;

  let body: Record<string, unknown> = {};
  try {
    const contentType = String(request.headers.get('content-type') || '');
    if (contentType.includes('application/json')) {
      const parsed = await request.json();
      if (parsed && typeof parsed === 'object') body = parsed as Record<string, unknown>;
    } else {
      const form = await request.formData();
      form.forEach((value, key) => {
        body[key] = typeof value === 'string' ? value : String(value);
      });
    }
  } catch {
    body = {};
  }
  const fromBody = parseModerationParams((name) => {
    const value = body[name];
    return typeof value === 'string' && value !== '' ? value : null;
  });
  return fromBody.ok ? fromBody : fromQuery;
}

/**
 * The shared body of both methods.
 *
 * `commit` is false for a GET: every check runs (a missing store is still
 * 501, a forged link is still 400) but the state is never written.
 */
async function handle(ctx: any, commit: boolean): Promise<Response> {
  const { request, env } = ctx;
  const parsed = await readModerationParams(request);
  if (!parsed.ok) {
    return json(parsed.body, parsed.status);
  }
  const { ref, decision, revision, ts, sig, recordId } = parsed.params;

  // The secret must not only EXIST, it must be USABLE (audit H-1): the
  // shipped example placeholder is published in the repository, and a
  // published HMAC key is a public key.
  const secret = env.FORM_WEBHOOK_SECRET;
  const secretProblemHere = secretProblem(secret);
  if (!secret || (isProductionEnv(env) && secretProblemHere !== null)) {
    console.log(
      JSON.stringify({
        ts: Date.now(),
        outcome: 'moderation_misconfigured',
        reason:
          secretProblemHere === 'missing'
            ? 'FORM_WEBHOOK_SECRET missing'
            : `FORM_WEBHOOK_SECRET ${secretProblemHere}`,
      }),
    );
    return json({ error: 'misconfigured', code: 'internal' }, 500);
  }

  const ok = await verifyModerationSignature(env as Env, ref, decision, revision, ts, sig, recordId);
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
  const currentRecordId = String(record.recordId || '');

  // THE TWO SCOPES (wave 10 F-2, wave 12 B-1).
  //
  //   revision — WHICH VERSION of the quote the link is about.
  //   identity — WHICH RECORD the link is about. A revision NUMBER is not an
  //              identity: two concurrent submissions compute the same
  //              revision from the same read, so two records can share
  //              (ref, revision) — and the number alone cannot say which of
  //              them the owner was shown (audit MAJOR-1).
  const identityStale = recordId !== undefined && recordId !== '' && recordId !== currentRecordId;

  if (currentRevision !== revision || identityStale) {
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
    // action (review finding B2 — parity with api/moderate/review.ts;
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
          // The fresh link names the CURRENT record (wave 12, B-1).
          recordId: currentRecordId,
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

  // --- GET: the confirmation page. NOTHING IS DECIDED HERE ---
  if (!commit) {
    return html(
      renderConfirmationPage({
        ref,
        decision,
        revision,
        ts,
        sig,
        ...(recordId ? { recordId } : {}),
        ...(record.state !== 'pending' ? { alreadyDecided: String(record.state) } : {}),
      }),
      200,
    );
  }

  if (record.state !== 'pending') {
    return json({ ok: true, ref, state: record.state, decidedAt: record.decidedAt }, 200);
  }

  // THE REVISION SCOPE (wave 10, F-2) AND THE IDENTITY SCOPE (wave 12, B-1).
  //
  // The decision must land on the revision that was VERIFIED. The log above
  // was read at the start of this request; if the client appended a newer
  // revision in the meantime, flipping that older record would approve text
  // the owner never saw. So the log is read AGAIN, the newest revision of
  // this ref is compared with the link's revision, and only a record that
  // still carries that revision is written.
  //
  // The identity is the second scope: a revision NUMBER is not an identity
  // (two concurrent submissions produce two records with the same
  // (ref, revision)), so the record the link names must also be the record
  // that is written.
  let fresh: Array<Record<string, any>>;
  try {
    fresh = readReviews();
  } catch (err) {
    if (err instanceof StoreUnreachableError) {
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

  let freshIdx = -1;
  for (let i = 0; i < fresh.length; i++) {
    if (fresh[i].ref === ref && fresh[i].type === 'review') freshIdx = i;
  }
  if (freshIdx === -1) {
    return json({ error: 'review not found', code: 'not-found' }, 404);
  }

  const freshRecord = fresh[freshIdx];
  const freshRevision = Number(freshRecord.revision || 0);
  const freshRecordId = String(freshRecord.recordId || '');
  const freshIdentityStale =
    recordId !== undefined && recordId !== '' && recordId !== freshRecordId;
  if (freshRevision !== revision || freshIdentityStale) {
    // The record MOVED between the check and the write: the same answer as
    // the stale revision above, and nothing is written.
    console.log(
      JSON.stringify({
        ts: Date.now(),
        ref,
        outcome: 'review_revision_moved_at_write',
        linkRevision: revision,
        currentRevision: freshRevision,
        state: freshRecord.state,
      }),
    );
    return json(
      {
        error: 'this review was changed after the link was sent',
        code: 'stale-revision',
        ref,
        revision: freshRevision,
      },
      409,
    );
  }

  if (freshRecord.state !== 'pending') {
    return json({ ok: true, ref, state: freshRecord.state, decidedAt: freshRecord.decidedAt }, 200);
  }

  freshRecord.state = decision === 'approve' ? 'approved' : 'rejected';
  freshRecord.decidedAt = new Date().toISOString();
  freshRecord.decidedBy = 'one-click-link';
  // The decision is only real once it is stored. A write that fails must not
  // be answered with "approved": the owner would believe the quote is
  // published while the store still says pending.
  if (!writeReviews(fresh)) {
    console.log(JSON.stringify({ ts: Date.now(), ref, outcome: 'storage_write_failed' }));
    return json({ error: 'storage unavailable', code: 'storage' }, 500);
  }

  try {
    await notifyReviewDecided(env as Env, {
      ref,
      name: freshRecord.name || '—',
      decision: freshRecord.state,
    });
  } catch {
    // notification failures never fail the request
  }

  return json({ ok: true, ref, state: freshRecord.state }, 200);
}

/** GET — the confirmation page. The state is never changed here. */
export const onRequestGet: any = async (ctx: any) => handle(ctx, false);

/** POST — the decision. This is what actually changes the state. */
export const onRequestPost: any = async (ctx: any) => handle(ctx, true);

/** Every other method is refused. */
export const onRequest: any = async (ctx: any) => {
  const method = String(ctx?.request?.method || 'GET').toUpperCase();
  if (method === 'GET') return handle(ctx, false);
  if (method === 'POST') return handle(ctx, true);
  return json({ error: 'method not allowed', code: 'method' }, 405, { Allow: 'GET, POST' });
};

/** The path this function serves — the same one as the Vercel twin. */
export const MODERATION_ENDPOINT = MODERATION_PATH;
