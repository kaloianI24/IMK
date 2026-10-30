// api/admin.ts — Vercel serverless function: the entry point of the owner's
//   route family.
//
// WHAT IT IS
//   ONE function for two public URLs:
//     /api/admin/session   /api/admin/reviews
//
// WHY IT EXISTS (wave 13, function budget)
//   Vercel builds one FUNCTION per file under api/. The owner family had two
//   of them, and the Hobby plan caps a deployment at twelve functions, so the
//   portal could not be deployed at all. One entry point per family plus a
//   rewrite (vercel.json) brings api/ down to seven files.
//
// THE FAMILY IS SEPARATE ON PURPOSE
//   The owner's inbox is a route family of its own (spec/07 §7.3): no admin
//   capability can leak into the client-facing code path, and the carrier
//   that names a route can never name one of the owner's routes from the
//   portal entry point — the two tables are disjoint.
//
// THE HANDLERS ARE UNCHANGED
//   They live in site/shared/portal-handlers/ and their bodies were moved
//   byte-for-byte.

import { IncomingMessage, ServerResponse } from 'node:http';
import {
  resolveRoute,
  rebuildRequestUrl,
  ROUTE_CARRIER_HEADER,
  ROUTE_CARRIER_PARAM,
} from '../site/shared/portal-router.js';
import { ADMIN_FAMILY, ADMIN_FAMILY_PREFIX } from '../site/shared/portal-routes.js';
import adminReviews from '../site/shared/portal-handlers/admin-reviews.js';
import adminSession from '../site/shared/portal-handlers/admin-session.js';

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;

/** Handler module name (the route table's key) -> the module. */
const HANDLERS: Record<string, Handler> = {
  'admin-reviews': adminReviews,
  'admin-session': adminSession,
};

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
 * The carrier: the reserved query parameter, or the header form of it.
 *
 * THE QUERY CARRIER IS AUTHORITATIVE WHEN IT IS PRESENT (wave 15, B-1).
 *
 *   `searchParams.get` returns null ONLY when the parameter is ABSENT, so
 *   the test here is `!== null` and NOT a truthiness test. A parameter that
 *   is PRESENT but EMPTY (?__imk_route=) names no route: it is an INVALID
 *   carrier, and it must never fall through to the header channel.
 *
 *   The fall-through was the defect the wave-14 audit found (MINOR): an
 *   empty __imk_route was treated as ABSENT, so the client-controlled
 *   x-imk-route header was consulted instead - a second client-controlled
 *   way into the resolution path, and an ambiguous rule. It granted no
 *   extra capability (the header channel is client-controlled anyway), but
 *   the rule is now one rule: the query carrier, when present, decides.
 *
 *   So the header is read ONLY when the query parameter is genuinely
 *   absent - the documented contingency (site/shared/portal-router.ts). An
 *   empty query carrier is passed on as an empty string, and the resolver
 *   refuses it with 404 {code:'not-found'}.
 *
 *   An empty HEADER value is still treated as no header at all (unchanged):
 *   that channel has no fallback behind it, so there is nothing to fall
 *   through to.
 */
function carrierOf(req: IncomingMessage, url: URL): string | null {
  const fromQuery = url.searchParams.get(ROUTE_CARRIER_PARAM);
  if (fromQuery !== null) return fromQuery;
  const header = req.headers[ROUTE_CARRIER_HEADER];
  if (typeof header === 'string' && header) return header;
  if (Array.isArray(header) && header.length && header[0]) return header[0];
  return null;
}

export default async function adminEntry(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const rawUrl = req.url || '/';
  let url: URL;
  try {
    url = new URL(rawUrl, `http://${req.headers.host || 'localhost'}`);
  } catch {
    json(res, { error: 'not found', code: 'not-found' }, 404);
    return;
  }

  // The request's HTTP method is passed on so the resolver's refusal log
  // (wave 16b, F-2) can say whether the stray empty carrier came from a
  // GET or a POST. It is the resolver's OPTIONAL 5th parameter and keeps
  // its 'unknown' default, so the callers that do not pass it are
  // unaffected.
  const resolution = resolveRoute(
    rawUrl,
    carrierOf(req, url),
    ADMIN_FAMILY_PREFIX,
    ADMIN_FAMILY.routes,
    req.method,
  );

  if (!resolution.ok) {
    if (resolution.reason === 'route-resolution') {
      console.log(
        JSON.stringify({
          ts: Date.now(),
          outcome: 'route_resolution_failed',
          entry: ADMIN_FAMILY_PREFIX,
        }),
      );
      json(res, { error: 'route resolution failed', code: 'route-resolution' }, 500);
      return;
    }
    json(res, { error: 'not found', code: 'not-found' }, 404);
    return;
  }

  const handler = HANDLERS[resolution.handler];
  if (!handler) {
    console.log(
      JSON.stringify({
        ts: Date.now(),
        outcome: 'route_handler_missing',
        entry: ADMIN_FAMILY_PREFIX,
        handler: resolution.handler,
      }),
    );
    json(res, { error: 'internal server error', code: 'internal' }, 500);
    return;
  }

  req.url = rebuildRequestUrl(rawUrl, resolution.path);

  try {
    await handler(req, res);
  } catch (err) {
    console.log(
      JSON.stringify({
        ts: Date.now(),
        outcome: 'admin_handler_error',
        route: resolution.path,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    if (!res.writableEnded) {
      json(res, { error: 'internal server error', code: 'internal' }, 500);
    }
  }
}
