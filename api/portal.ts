// api/portal.ts — Vercel serverless function: the entry point of the portal
//   route family.
//
// WHAT IT IS
//   ONE function for nine public URLs:
//     /api/portal/comments      /api/portal/plan-items     /api/portal/projects
//     /api/portal/invites       /api/portal/plan-items/<id> /api/portal/projects/<id>
//     /api/portal/session       /api/portal/testimonials   /api/portal/updates
//
// WHY IT EXISTS (wave 13, function budget)
//   Vercel builds one FUNCTION per file under api/. The portal had nine of
//   them, and the Hobby plan caps a deployment at twelve functions, so the
//   portal could not be deployed at all. One entry point per family plus a
//   rewrite (vercel.json) brings api/ down to seven files.
//
// HOW THE ROUTE IS FOUND
//   The platform rewrites /api/portal/comments to
//   /api/portal?__imk_route=/api/portal/comments, so the function sees the
//   entry point's own path plus the ORIGINAL public path in the reserved
//   query parameter. The resolver (site/shared/portal-router.ts) turns that
//   into a handler, and the request URL is rebuilt so the handler sees the
//   path AND the query string it expects.
//
//   The resolver is fail-closed: an unknown path is a 404, and the entry
//   point reached with no route at all is a loud 500
//   {code:'route-resolution'} — never a silent 404.
//
// THE HANDLERS ARE UNCHANGED
//   They live in site/shared/portal-handlers/ and their bodies were moved
//   byte-for-byte. Each one still matches its own pathname, so the routing
//   change is invisible to the handler code.

import { IncomingMessage, ServerResponse } from 'node:http';
import {
  resolveRoute,
  rebuildRequestUrl,
  ROUTE_CARRIER_HEADER,
  ROUTE_CARRIER_PARAM,
} from '../site/shared/portal-router.js';
import { PORTAL_FAMILY, PORTAL_FAMILY_PREFIX } from '../site/shared/portal-routes.js';
import portalComments from '../site/shared/portal-handlers/portal-comments.js';
import portalInvites from '../site/shared/portal-handlers/portal-invites.js';
import portalPlanItems from '../site/shared/portal-handlers/portal-plan-items.js';
import portalProjects from '../site/shared/portal-handlers/portal-projects.js';
import portalSession from '../site/shared/portal-handlers/portal-session.js';
import portalTestimonials from '../site/shared/portal-handlers/portal-testimonials.js';
import portalUpdates from '../site/shared/portal-handlers/portal-updates.js';

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;

/** Handler module name (the route table's key) -> the module. */
const HANDLERS: Record<string, Handler> = {
  'portal-comments': portalComments,
  'portal-invites': portalInvites,
  'portal-plan-items': portalPlanItems,
  'portal-projects': portalProjects,
  'portal-session': portalSession,
  'portal-testimonials': portalTestimonials,
  'portal-updates': portalUpdates,
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

export default async function portalEntry(
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
    PORTAL_FAMILY_PREFIX,
    PORTAL_FAMILY.routes,
    req.method,
  );

  if (!resolution.ok) {
    if (resolution.reason === 'route-resolution') {
      // The platform ate the path. It must be LOUD: a silent 404 here reads
      // as "the route was deleted".
      console.log(
        JSON.stringify({
          ts: Date.now(),
          outcome: 'route_resolution_failed',
          entry: PORTAL_FAMILY_PREFIX,
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
    // The table names a handler this bundle does not have. That is a build
    // error, and it must not be answered as an empty result.
    console.log(
      JSON.stringify({
        ts: Date.now(),
        outcome: 'route_handler_missing',
        entry: PORTAL_FAMILY_PREFIX,
        handler: resolution.handler,
      }),
    );
    json(res, { error: 'internal server error', code: 'internal' }, 500);
    return;
  }

  // The handler must see the ORIGINAL public path and the ORIGINAL query.
  req.url = rebuildRequestUrl(rawUrl, resolution.path);

  try {
    await handler(req, res);
  } catch (err) {
    console.log(
      JSON.stringify({
        ts: Date.now(),
        outcome: 'portal_handler_error',
        route: resolution.path,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    if (!res.writableEnded) {
      json(res, { error: 'internal server error', code: 'internal' }, 500);
    }
  }
}
