// site/functions/api/admin/reviews.ts — Cloudflare Pages Function.
//   GET /api/admin/reviews — the owner's moderation queue.
//
//   A SEPARATE COPY of the Vercel module
//   site/shared/portal-handlers/admin-reviews.ts. The two files are NOT the
//   same code: an edit to the Vercel module does NOT reach this file, and
//   this file does NOT import it. Change the Vercel module and change THIS
//   file too.
//
// THIS TARGET HAS NO QUEUE (wave 10, F-6).
//
//   The Vercel twin (site/shared/portal-handlers/admin-reviews.ts) reads the moderation log through
//   the portal store, so with PORTAL_STORE=libsql it answers a REAL queue.
//   The edge runtime has no filesystem: this tree used to read the JSONL
//   file directly, and a Worker isolate has no `node:fs` at all — so the
//   endpoint answered 501 {code:'unimplemented'} anyway.
//
//   The two trees therefore disagreed. The code claimed a file store that
//   cannot exist on this target, and the answer it gave in a Node simulation
//   (200 with a queue) was an answer no Worker could ever give.
//
//   Now the endpoint says what it really does: 501 {code:'unimplemented'}.
//   The JSONL read is GONE. This tree is deliberately NOT wired to the store
//   — Vercel is the launch target, and the Cloudflare portal tree is a
//   later wave (design §2, "one target first").
//
//   THE GATE IS UNCHANGED: a non-owner is 401, a deployment without
//   ADMIN_EMAILS is 500, and a deployment whose FORM_WEBHOOK_SECRET is
//   missing or unusable is 500. Only the queue itself is not served here —
//   and the answer is the same one the Cloudflare moderation twin gives for
//   the same situation (site/functions/api/moderate/review.ts).

import {
  adminEmailsConfigured,
  resolveAdmin,
} from '../../../shared/server/portal-session.js';
import { isProductionEnv } from '../../../shared/server/portal-session.js';
import { secretProblem } from '../../../shared/server/secret.js';

function json(body: any, status = 200, extra: Record<string, string> = {}): Response {
  const payload = JSON.stringify(body);
  return new Response(payload, {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...extra },
  });
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

  // Without the secret the approve/reject links could not be signed — an HMAC
  // with an EMPTY key is a public key, and anybody could mint an approve
  // link. The moderation endpoint refuses to verify anything without it.
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

  // There is no moderation store on this target: the edge runtime has no
  // filesystem, and this tree is not wired to the database. A queue that
  // cannot exist must never look like an empty one (the owner would believe
  // there is nothing to moderate).
  console.log(
    JSON.stringify({ ts: Date.now(), outcome: 'moderation_store_unreachable', target: 'cloudflare' }),
  );
  return json(
    { error: 'moderation store unavailable on this target', code: 'unimplemented' },
    501,
  );
};
