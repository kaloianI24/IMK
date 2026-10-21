// api/moderate/review.ts — Vercel serverless function, /api/moderate/review
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
// THE METHOD IS THE POINT (audit M-1, wave-8A)
//   GET  → shows a CONFIRMATION PAGE. It NEVER changes the state.
//   POST → applies the decision.
//   The link in the owner's mail is a GET, so the owner clicks it and
//   confirms. A mail scanner that prefetches the link sees the page and
//   decides nothing. Before this change the prefetch WAS the approval:
//   every corporate link scanner published the owner's quotes.
//
// Behavior:
//   - Invalid/missing params → 400
//   - Bad/expired signature → 400
//   - Unknown ref → 404
//   - The link points at an OLD revision (the client changed the quote after
//     the mail went out) → 409 stale-revision; the owner is sent a fresh
//     link for the current revision so the quote can still be moderated
//   - Already decided → 200 (idempotent, no change)
//   - Valid POST → flips the state in the 'reviews' collection of the portal
//     store, sends confirmation email via Resend, returns 200
//
// Environment (server-side only):
//   FORM_WEBHOOK_SECRET — HMAC signing secret
//   RESEND_API_KEY, RESEND_FROM, RESEND_TO / CONTACT_TO — confirmation email

import { IncomingMessage, ServerResponse } from 'node:http';
import {
  notifyReviewDecided,
  notifyReviewSubmitted,
  verifyModerationSignature,
} from '../lib/notifications.js';
import {
  getPortalStore,
  guardStore,
  storageFailureLog,
  assertStoreReachable,
  StoreUnreachableError,
} from '../../site/shared/server/portal-store-access.js';
import {
  MODERATION_PATH,
  parseModerationParams,
  renderConfirmationPage,
  type ModerationParams,
} from '../../site/shared/server/moderation.js';
import { isProductionEnv } from '../../site/shared/server/portal-session.js';
import { secretProblem } from '../../site/shared/server/secret.js';

// THE STORE (wave 9)
//   The moderation log comes from the PortalStore contract
//   (site/shared/portal-store/**), not from a JSONL file: with
//   PORTAL_STORE=libsql the decision is stored in the DATABASE, atomically,
//   and with PORTAL_STORE=file the very same records land in the very same
//   site/data/moderation/reviews.jsonl as before.
//
//   The decision itself is ONE statement (decideReview): the newest revision
//   of the ref flips from 'pending' to the decision, in the store, with no
//   read-modify-write window and no temp-file rename. The atomicity the old
//   tmp-file + rename gave is now the database's.

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
 * The confirmation page.
 *
 * It is a page, not an action: no state changes while it is served. It is
 * never indexed and never cached — it carries a signed URL.
 */
function html(res: ServerResponse, body: string, status = 200): void {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'X-Robots-Tag': 'noindex, nofollow',
    'Cache-Control': 'no-store',
  });
  res.end(body);
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

/**
 * The e-mail of the client behind a review record. The review record itself
 * holds NO address (audit M2) — it is looked up in the client store, and only
 * for the owner's own notification channel.
 */
async function clientEmailFor(
  store: { get: (coll: 'clients', key: { field: string; value: string }) => Promise<Record<string, any> | null> },
  clientId: string,
): Promise<string | undefined> {
  if (!clientId) return undefined;
  const client = await store.get('clients', { field: 'id', value: clientId });
  return client && client.email ? String(client.email) : undefined;
}

function readBodyText(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * The signed parameters of the request.
 *
 * They may arrive in the query string (a link) or in the body (the
 * confirmation form). The query wins when it carries them, so a POST to the
 * link URL works as well as a POST of the form.
 */
async function readModerationParams(
  req: IncomingMessage,
  url: URL,
): Promise<
  | { ok: true; params: ModerationParams }
  | { ok: false; status: number; body: { error: string; code: string } }
> {
  const fromQuery = parseModerationParams((name) => url.searchParams.get(name));
  if (fromQuery.ok) return fromQuery;

  const method = (req.method || 'GET').toUpperCase();
  if (method !== 'POST') return fromQuery;

  // The query was incomplete: the parameters may be in the body.
  const raw = await readBodyText(req);
  let body: Record<string, unknown> = {};
  const contentType = String(req.headers['content-type'] || '');
  if (raw) {
    if (contentType.includes('application/json')) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') body = parsed as Record<string, unknown>;
      } catch {
        body = {};
      }
    } else {
      const form = new URLSearchParams(raw);
      for (const [key, value] of form.entries()) body[key] = value;
    }
  }
  const fromBody = parseModerationParams((name) => {
    const value = body[name];
    return typeof value === 'string' && value !== '' ? value : null;
  });
  if (fromBody.ok) return fromBody;

  // Neither source carried a complete set: report the QUERY answer, which
  // is the one the caller can act on (the body may simply have been empty).
  return fromQuery;
}

async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
  const method = (req.method || 'GET').toUpperCase();

  if (method !== 'GET' && method !== 'POST') {
    json(res, { error: 'method not allowed', code: 'method' }, 405, { Allow: 'GET, POST' });
    return;
  }

  // --- parameter validation ---
  const parsed = await readModerationParams(req, url);
  if (!parsed.ok) {
    json(res, parsed.body, parsed.status);
    return;
  }
  const { ref, decision, revision, ts, sig } = parsed.params;

  // --- signature verification ---
  //
  // The secret must not only EXIST, it must be USABLE (audit H-1): the
  // shipped example placeholder is published in the repository, and a
  // published HMAC key is a public key. In production such a secret is
  // refused exactly like a missing one.
  const secret = process.env.FORM_WEBHOOK_SECRET;
  const secretProblemHere = secretProblem(secret);
  if (!secret || (isProductionEnv() && secretProblemHere !== null)) {
    console.log(
      JSON.stringify({
        ts: Date.now(),
        outcome: 'moderation_misconfigured',
        reason: secretProblemHere === 'missing' ? 'FORM_WEBHOOK_SECRET missing' : `FORM_WEBHOOK_SECRET ${secretProblemHere}`,
      }),
    );
    json(res, { error: 'misconfigured', code: 'internal' }, 500);
    return;
  }

  if (!verifyModerationSignature(ref, decision, revision, ts, sig)) {
    json(res, { error: 'invalid signature', code: 'signature' }, 400);
    return;
  }

  // --- the moderation store ---
  const store = getPortalStore();

  // The store must be there AT ALL. A MISSING store is not an empty log: it
  // is a store this target cannot serve (the function filesystem is read-only
  // in production, and a deployment that does not carry site/data/ has no log
  // at all). That is 501, not 404.
  try {
    assertStoreReachable('reviews');
  } catch (err) {
    if (err instanceof StoreUnreachableError) {
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
    throw err;
  }

  // Later lines win: when a client edits or withdraws a quote the portal
  // appends a new record with the same ref, and the publisher applies the
  // same rule. Deciding the newest record keeps approval and publication in
  // step.
  const record = await store.latest('reviews', { ref, type: 'review' });
  if (!record) {
    json(res, { error: 'review not found', code: 'not-found' }, 404);
    return;
  }

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
          email: await clientEmailFor(store, String(record.clientId || '')),
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

  // --- GET: show the confirmation page. NOTHING IS DECIDED HERE ---
  //
  // This is the whole point of the change (audit M-1): a GET is what every
  // mail scanner does by itself. The state is only ever changed by the
  // POST that the confirmation form issues.
  if (method === 'GET') {
    html(
      res,
      renderConfirmationPage({
        ref,
        decision,
        revision,
        ts,
        sig,
        ...(record.state !== 'pending'
          ? { alreadyDecided: String(record.state) }
          : {}),
      }),
      200,
    );
    return;
  }

  if (record.state !== 'pending') {
    // idempotent: already decided, no change
    json(res, { ok: true, ref, state: record.state, decidedAt: record.decidedAt }, 200);
    return;
  }

  const now = new Date().toISOString();
  const decidedState = decision === 'approve' ? 'approved' : 'rejected';

  // The decision is stored in ONE statement: the newest revision of this ref
  // flips from 'pending' to the decision, and the statement only matches a
  // record that is still pending. A decision that cannot be stored is never
  // answered with "approved" (audit wave-6, F-3).
  const decided = await store.decideReview(ref, decidedState, now, 'one-click-link');
  if (!decided) {
    console.log(JSON.stringify({ ts: Date.now(), ref, outcome: 'storage_write_failed' }));
    json(res, { error: 'storage unavailable', code: 'storage' }, 500);
    return;
  }
  if (decided.state !== decidedState) {
    // Somebody else decided it in the meantime: the answer is the idempotent
    // one, never a false claim about this decision.
    json(res, { ok: true, ref, state: decided.state, decidedAt: decided.decidedAt }, 200);
    return;
  }

  // --- confirmation email ---
  try {
    await notifyReviewDecided({ ref, name: record.name || '—', decision: decided.state });
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
      decision: decided.state,
      decidedBy: 'one-click-link',
    }),
  );

  json(res, { ok: true, ref, state: decided.state }, 200);
}

// A corrupt moderation log must never look like "review not found"
// (audit M3 / QA D3): the owner could never approve a quote.
export default function (
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  return guardStore(
    () => handler(req, res),
    (err) => {
      console.log(JSON.stringify(storageFailureLog(err)));
      json(res, { error: 'storage unavailable', code: 'storage' }, 500);
    },
  );
}
