// site/functions/api/admin/reviews.ts — Cloudflare Pages Function.
//   GET /api/admin/reviews — the owner's moderation queue.
//
// THE CLOUDFLARE TWIN OF api/admin/reviews.ts (spec/07 §1, D-6: the two trees
// must answer the same way for the same input). Same gate, same payload, same
// failure answers.
//
// THE DECISION IS NOT MADE HERE ON EITHER TARGET
//   Approve and reject go through `/api/moderate/review` — the one
//   implementation of the moderation contract. This endpoint only MINTS the
//   signed link that endpoint verifies; the signature is generated
//   server-side from FORM_WEBHOOK_SECRET.
//
//   On the edge the signature is computed with crypto.subtle
//   (site/functions/api/lib/notifications.ts), which is async — so the link is
//   built with `await`. The signed MESSAGE is identical on both targets
//   (`ref|decision|revision|ts`), so a link works on whichever target served
//   the site.
//
// THE STORE
//   The moderation log, `site/data/moderation/reviews.jsonl`. The edge runtime
//   has no filesystem, so the store is normally NOT reachable here and the
//   answer is 501 {code:'unimplemented'} — exactly what the Cloudflare
//   moderation twin answers. A store that cannot be reached must never look
//   like an empty queue (the owner would believe there is nothing to
//   moderate).
//
//   The fs access goes through `globalThis.require`, the same trick the
//   Cloudflare moderation twin uses (site/functions/api/moderate/review.ts):
//   the bundler never sees a static `node:fs` import, so the edge bundle
//   stays clean.

import {
  adminEmailsConfigured,
  resolveAdmin,
} from './session.js';
import { buildModerationUrl } from '../lib/notifications.js';
import { parseJsonlStrict, isStorageCorrupt } from '../../../shared/portal-store/jsonl.js';
import { isProductionEnv } from '../../../shared/server/portal-session.js';
import { secretProblem } from '../../../shared/server/secret.js';

const REVIEWS_FILE = 'site/data/moderation/reviews.jsonl';

/** How many decided reviews the inbox keeps in its "recently decided" list. */
const RECENT_LIMIT = 5;

function json(body: any, status = 200, extra: Record<string, string> = {}): Response {
  const payload = JSON.stringify(body);
  return new Response(payload, {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...extra },
  });
}

/**
 * The edge filesystem, when the runtime has one.
 *
 * A real Worker isolate has none — the store is then unreachable and the
 * endpoint answers 501, the same as the moderation twin.
 */
function edgeFs(): any {
  return (globalThis as any).require ? (globalThis as any).require('node:fs') : null;
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

export const onRequestGet: any = async (ctx: any): Promise<Response> => {
  const { request, env } = ctx;

  if (!adminEmailsConfigured(env)) {
    console.log(
      JSON.stringify({
        ts: Date.now(),
        outcome: 'admin_misconfigured',
        reason: 'ADMIN_EMAILS missing',
      }),
    );
    return json({ error: 'misconfigured', code: 'internal' }, 500);
  }

  const session = resolveAdmin(request.headers, env, env);
  if (!session) {
    return json({ error: 'unauthorized', code: 'unauthorized' }, 401);
  }

  // Without the secret the signature would be an HMAC with an EMPTY key —
  // a public key, and anyone could mint an approve link. The moderation
  // endpoint refuses to verify anything without it.
  //
  // H-1 (wave-8A): the secret must not only EXIST, it must be USABLE — the
  // published example placeholder is in the repository, and a published HMAC
  // key is a public key.
  const webhookSecretProblem = secretProblem(env.FORM_WEBHOOK_SECRET);
  if (!env.FORM_WEBHOOK_SECRET || (isProductionEnv(env) && webhookSecretProblem !== null)) {
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
    return json({ error: 'misconfigured', code: 'internal' }, 500);
  }

  const fs = edgeFs();
  if (!fs || !fs.existsSync(REVIEWS_FILE)) {
    console.log(
      JSON.stringify({ ts: Date.now(), outcome: 'moderation_store_unreachable' }),
    );
    return json(
      { error: 'moderation store unavailable on this target', code: 'unimplemented' },
      501,
    );
  }

  let records: Array<Record<string, any>>;
  try {
    records = parseJsonlStrict(fs.readFileSync(REVIEWS_FILE, 'utf8'), REVIEWS_FILE);
  } catch (err) {
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

  pending.sort((a, b) => timeOf(a.receivedAt) - timeOf(b.receivedAt));
  decided.sort((a, b) => timeOf(b.decidedAt) - timeOf(a.decidedAt));

  const ts = Math.floor(Date.now() / 1000);

  const reviews = [];
  for (const record of pending) {
    const ref = String(record.ref);
    const revision = Number(record.revision || 1);
    reviews.push({
      ref,
      revision,
      rating: String(record.rating || ''),
      name: String(record.name || ''),
      company: String(record.company || ''),
      quote: String(record.review || ''),
      receivedAt: String(record.receivedAt || record.updatedAt || ''),
      state: String(record.state || 'pending'),
      approvePath: pathOf(await buildModerationUrl(env, ref, 'approve', revision, ts)),
      rejectPath: pathOf(await buildModerationUrl(env, ref, 'reject', revision, ts)),
    });
  }

  const recent = decided.slice(0, RECENT_LIMIT).map((record) => ({
    ref: String(record.ref || ''),
    state: String(record.state || ''),
    decidedAt: String(record.decidedAt || ''),
    rating: String(record.rating || ''),
    name: String(record.name || ''),
  }));

  return json(
    {
      ok: true,
      counts: {
        pendingReviews: reviews.length,
        decidedToday: decided.filter((record) => isToday(record.decidedAt)).length,
        // There is no annotation store in this project yet — the count of open
        // client notes is unknown, not zero.
        openNotes: null,
      },
      notesAvailable: false,
      reviews,
      recent,
    },
    200,
  );
};
