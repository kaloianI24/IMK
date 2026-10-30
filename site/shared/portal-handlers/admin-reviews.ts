// site/shared/portal-handlers/admin-reviews.ts — the Vercel handler module.
//
// WHY IT MOVED (wave 13, function budget)
//   It used to be api/admin/reviews.ts, which was a Vercel FUNCTION of its
//   own. The owner family now has ONE entry point (api/admin.ts) and the
//   route table decides which handler serves a request. The module body is
//   unchanged; only its home is.
//   GET /api/admin/reviews — the owner's moderation queue.
//
// WHAT IT IS
//   The list behind the /admin inbox (spec/07 §7.3, task T7.14): the pending
//   client quotes, with the signed approve/reject action for each of them.
//
// THE DECISION ITSELF IS NOT MADE HERE
//   Approve and reject go through the moderation endpoint
//   (`/api/moderate/review`), which is the one implementation of the
//   moderation contract: it verifies the HMAC signature, refuses a link that
//   points at an older revision of the quote, is idempotent for an
//   already-decided quote, and fails CLOSED when the store cannot be read or
//   written (spec/08 §4.9.5). This endpoint only MINTS the signed link that
//   endpoint verifies — the signature is generated here, server-side, from
//   FORM_WEBHOOK_SECRET, and the owner never sees a secret.
//
//   The links are returned as PATH + QUERY, not as absolute URLs, so the page
//   always calls its own origin. The signature covers
//   `ref|decision|revision|recordId|ts` (and `ref|decision|revision|ts` for
//   a record written before wave 12, which carries no identity) — it does not
//   cover the origin, so dropping the origin changes nothing about what the
//   link is allowed to do.
//
// THE GATE
//   The same two checks as /api/admin/session: an admin session AND an email
//   on the ADMIN_EMAILS allow-list. Anything else is 401.
//
// THE STORE IS THE MODERATION LOG — THE ONE THE DECISION USES (wave 9B)
//   The queue is read through the PortalStore contract
//   (site/shared/portal-store/**), so the inbox and the moderation endpoint
//   are looking at ONE store: with PORTAL_STORE=libsql the quote the owner
//   approves is the quote the inbox shows, and with PORTAL_STORE=file it is
//   the very same `site/data/moderation/reviews.jsonl` as before.
//
//   "Later lines win": a client who edits or withdraws a quote appends a new
//   record with the same ref, and the newest record is the current state.
//
// WHAT THIS ENDPOINT DOES NOT PROMISE
//   A store that cannot be reached is NOT an empty queue: the answer is
//   501 {code:'unimplemented'} ("this target cannot serve the queue"), and a
//   store that is there but whose records cannot be parsed is
//   500 {code:'storage'}. Never a 200 with an empty list — the owner would
//   believe there is nothing to moderate (audit M3 / QA D3).

import { IncomingMessage, ServerResponse } from 'node:http';
import { moderationUrl } from '../server/notifications.js';
import { adminEmailsConfigured, resolveAdmin } from './admin-session.js';
import { isProductionEnv } from '../server/portal-session.js';
import { secretProblem } from '../server/secret.js';
import {
  getPortalStore,
  guardStore,
  storageFailureLog,
  assertStoreReachable,
  StoreUnreachableError,
} from '../server/portal-store-access.js';
import { StorageError } from '../portal-store/errors.js';

/** How many decided reviews the inbox keeps in its "recently decided" list. */
const RECENT_LIMIT = 5;

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

/** The path + query of an absolute URL — the origin is dropped on purpose. */
function pathOf(absoluteUrl: string): string {
  const url = new URL(absoluteUrl);
  return `${url.pathname}${url.search}`;
}

/** The newest line per ref: the current state of every quote. */
function latestByRef(
  records: Array<Record<string, any>>,
): Map<string, Record<string, any>> {
  const latest = new Map<string, Record<string, any>>();
  for (const record of records) {
    if (!record || record.type !== 'review') continue;
    const ref = String(record.ref || '').trim();
    if (!ref) continue;
    latest.set(ref, record);
  }
  return latest;
}

/** Milliseconds since the epoch, or 0 when the field is missing/unparseable. */
function timeOf(value: unknown): number {
  if (!value) return 0;
  const t = new Date(String(value)).getTime();
  return Number.isFinite(t) ? t : 0;
}

/** Is this timestamp on today (UTC day) of the server? */
function isToday(value: unknown): boolean {
  const t = timeOf(value);
  if (!t) return false;
  const day = new Date(t).toISOString().slice(0, 10);
  return day === new Date().toISOString().slice(0, 10);
}

async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;
  const method = req.method || 'GET';

  if (pathname !== '/api/admin/reviews') {
    json(res, { error: 'not found', code: 'not-found' }, 404);
    return;
  }

  if (method !== 'GET') {
    json(res, { error: 'method not allowed', code: 'method' }, 405, { Allow: 'GET' });
    return;
  }

  if (!adminEmailsConfigured(process.env)) {
    console.log(
      JSON.stringify({
        ts: Date.now(),
        outcome: 'admin_misconfigured',
        reason: 'ADMIN_EMAILS missing',
      }),
    );
    json(res, { error: 'misconfigured', code: 'internal' }, 500);
    return;
  }

  const session = resolveAdmin(req, process.env);
  if (!session) {
    json(res, { error: 'unauthorized', code: 'unauthorized' }, 401);
    return;
  }

  // The signed links are produced with FORM_WEBHOOK_SECRET. Without it the
  // signature would be an HMAC with an EMPTY key — i.e. a public key, and
  // anyone could mint an approve link. The moderation endpoint refuses to
  // verify anything without the secret; this endpoint refuses to offer an
  // action it knows cannot work.
  //
  // H-1 (wave-8A): the secret must not only EXIST, it must be USABLE. The
  // published example placeholder is in the repository, and a published HMAC
  // key is a public key. In production such a secret is refused exactly like
  // a missing one.
  const webhookSecretProblem = secretProblem(process.env.FORM_WEBHOOK_SECRET);
  if (
    !process.env.FORM_WEBHOOK_SECRET ||
    (isProductionEnv(process.env) && webhookSecretProblem !== null)
  ) {
    console.log(
      JSON.stringify({
        ts: Date.now(),
        outcome: 'admin_misconfigured',
        reason:
          webhookSecretProblem === 'missing'
            ? 'FORM_WEBHOOK_SECRET missing'
            : `FORM_WEBHOOK_SECRET ${webhookSecretProblem}`,
      }),
    );
    json(res, { error: 'misconfigured', code: 'internal' }, 500);
    return;
  }

  // A store that is not there is not an empty queue. The moderation endpoint
  // answers 501 {code:'unimplemented'} for the same situation, and the inbox
  // must not tell the owner "no pending reviews" when it simply cannot see
  // the queue.
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

  // THE SAME STORE THE DECISION IS MADE IN (wave 9B)
  //   The queue comes from the PortalStore contract, so the inbox and
  //   /api/moderate/review read and write ONE store: with PORTAL_STORE=libsql
  //   the owner sees the quotes that live in the DATABASE, and with
  //   PORTAL_STORE=file the very same records the file store held before.
  const store = getPortalStore();

  let records: Array<Record<string, any>>;
  try {
    records = await store.list('reviews');
  } catch (err) {
    // The store is there but it cannot be READ: the file cannot be opened
    // (file mode) or the database cannot be reached (libSQL mode). Either way
    // this target cannot serve the queue — 501, never an empty list.
    if (err instanceof StorageError && err.code === 'storage-unavailable') {
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

  const current = latestByRef(records);

  const pending: Array<Record<string, any>> = [];
  const decided: Array<Record<string, any>> = [];
  for (const record of current.values()) {
    if (record.state === 'pending' && record.revoked !== true) {
      pending.push(record);
    } else if (record.decidedAt) {
      decided.push(record);
    }
  }

  // Oldest first: the queue is worked in the order the quotes arrived.
  pending.sort((a, b) => timeOf(a.receivedAt) - timeOf(b.receivedAt));
  decided.sort((a, b) => timeOf(b.decidedAt) - timeOf(a.decidedAt));

  const ts = Math.floor(Date.now() / 1000);

  const reviews = pending.map((record) => {
    const ref = String(record.ref);
    const revision = Number(record.revision || 1);
    // The identity of the record (wave 12, B-1). It travels SIGNED with the
    // link, so the owner's click can only ever land on the exact record the
    // queue is showing. A record written before wave 12 has no identity and
    // keeps the revision-only scope.
    const recordId = String(record.recordId || '');
    return {
      ref,
      revision,
      rating: String(record.rating || ''),
      name: String(record.name || ''),
      company: String(record.company || ''),
      quote: String(record.review || ''),
      receivedAt: String(record.receivedAt || record.updatedAt || ''),
      state: String(record.state || 'pending'),
      approvePath: pathOf(moderationUrl(ref, 'approve', revision, ts, recordId || undefined)),
      rejectPath: pathOf(moderationUrl(ref, 'reject', revision, ts, recordId || undefined)),
    };
  });

  const recent = decided.slice(0, RECENT_LIMIT).map((record) => ({
    ref: String(record.ref || ''),
    state: String(record.state || ''),
    decidedAt: String(record.decidedAt || ''),
    rating: String(record.rating || ''),
    name: String(record.name || ''),
  }));

  json(
    res,
    {
      ok: true,
      counts: {
        pendingReviews: reviews.length,
        decidedToday: decided.filter((record) => isToday(record.decidedAt)).length,
        // There is NO annotation store in this project yet (spec/07 T7.8/T7.10
        // were never built), so the count of open client notes is not zero —
        // it is unknown. It is reported as null and the panel says so, rather
        // than showing a made-up number.
        openNotes: null,
      },
      notesAvailable: false,
      reviews,
      recent,
    },
    200,
  );
}

// A corrupt moderation log must never look like an empty queue (audit M3 /
// QA D3): the owner would believe there is nothing to moderate.
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
