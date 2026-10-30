// site/shared/portal-router.ts — THE ROUTE RESOLVER.
//
// A function over strings: no node: imports, no platform-specific API, no
// server. It has exactly ONE side effect: it writes ONE log line when it
// refuses an empty route carrier (wave 16b, F-2). Only the two Vercel
// entry points bundle this module, and console.log exists in the Node
// runtime they run on. Everything else is pure, which is what makes it
// testable offline.
//
// WHY IT EXISTS (wave 13, function budget)
//   Vercel builds ONE FUNCTION per file under api/. Nineteen files meant
//   nineteen functions, and the Hobby plan caps a deployment at twelve — so
//   the portal could not be deployed at all. The fix is one entry point per
//   route family plus a rewrite: the platform sends /api/portal/comments to
//   the single function api/portal.ts and names the original path in the
//   reserved query parameter __imk_route.
//
//   The resolver turns "a request arrived" into "this handler serves it", and
//   it FAILS CLOSED: a path it does not know is a 404, and an entry point
//   reached without a route is a loud 500. It never guesses.
//
// THE RULES, IN ORDER
//
//   1. The request PATH resolves in the table -> serve it.
//      This is the direct case: the local dev server, `vercel dev` without
//      the rewrites applied, or a platform that did not rewrite.
//
//   2. The CARRIER resolves in the table -> serve it.
//      The carrier is the reserved query parameter __imk_route (or the
//      x-imk-route header, the documented contingency if a platform ever
//      drops the query). It names the ORIGINAL public path.
//
//      A carrier that is PRESENT but EMPTY is an INVALID carrier, not an
//      absent one (wave 15, B-1): it names no route, so it is a 404
//      {code:'not-found'}. It is never a fall-through to the other channel,
//      and an entry point reads the header only when the query parameter is
//      genuinely absent.
//
//   3. The path IS the entry prefix and nothing resolved -> 'route-resolution'
//      -> 500 {code:'route-resolution'}.
//      This is the "the platform ate the path" case. It must be LOUD: a
//      silent 404 here would look like a deleted route.
//
//   4. Anything else -> 'not-found' -> 404 {code:'not-found'}.
//
// WHY THE PATH IS CHECKED FIRST
//   The Architect's draft put the carrier first. The path is checked first
//   here, so a request whose path IS in the table is always served by the
//   handler for THAT path. The carrier is only read when the path alone does
//   not resolve, which is exactly the rewrite case.
//
// WHAT A FORGED CARRIER CAN DO, AND WHAT IT CANNOT
//
//   On the deployed target the rewrite REPLACES the path with the entry
//   prefix, so the path no longer identifies the route and the carrier
//   decides it. WHICH SIDE WINS when the platform merges the client's query
//   over the rewrite's own query is NOT OBSERVED: no Vercel router has been
//   booted for this project, so the merge order is taken from the platform's
//   routing implementation and its documentation - not from an observed
//   production request.
//
//   Nothing below depends on that answer. These invariants hold EITHER WAY:
//
//     1. FAMILY CONTAINMENT. An entry point resolves against ONE table - its
//        own family's - and the portal and admin tables are DISJOINT. A
//        carrier can therefore only ever name a route of the entry point's
//        own family. Rule 2 checks the carrier against the entry prefix
//        explicitly, so the containment is a property of the CODE and not
//        only of the shape of the table.
//
//     2. THE STANDALONE URLS ARE OUT OF REACH. api/contact.ts,
//        api/moderate/review.ts and the three api/portal/auth/* files are
//        in NO family table: each keeps its own function file and its own
//        URL. No carrier can name them, because the resolver matches a
//        carrier against a family table only.
//
//     3. THE HANDLER AUTHORIZES ITSELF. Whatever route the resolver names,
//        the handler behind it applies its OWN gate - resolveAccess /
//        canReadClient / canWriteClient for the client routes, the owner
//        session (the role claim AND the live ADMIN_EMAILS allow-list) for
//        the owner routes, the sign-in flow for the auth URLs. A forged
//        carrier cannot grant a capability the handler would not have
//        granted anyway.
//
//   So the blast radius of a forged carrier is bounded by the TABLE and by
//   the HANDLER's own gate, never by the merge order. What it CAN do is
//   select another handler OF THE SAME FAMILY - the containment stops it at
//   the family boundary, not at the route boundary. That is a routing
//   surprise, not an escalation: the selected handler still asks the same
//   question it asks every other time, and answers the same way.
//
//   WAVE 14 changed THIS COMMENT rather than the behaviour, because the
//   behaviour it described - that a forged carrier could not select another
//   handler - was a claim about the path-first rule that was never observed
//   on the deployed target. The claim that is left standing is the one that
//   is true either way: family containment, the standalone URLs being out of
//   reach, and the handler's own authorisation.

/** The reserved query parameter that carries the original public path. */
export const ROUTE_CARRIER_PARAM = '__imk_route';

/** The header form of the same carrier (the documented contingency). */
export const ROUTE_CARRIER_HEADER = 'x-imk-route';

/** A route table: public path pattern -> handler module name. */
export interface RouteTable {
  [publicPattern: string]: string;
}

export interface RouteMatch {
  /** The table key that matched (e.g. '/api/portal/projects/*'). */
  pattern: string;
  /** The handler module name behind it. */
  handler: string;
}

export type RouteResolution =
  | {
      ok: true;
      /** The concrete public path the handler must see (e.g. '/api/portal/projects/prj_1'). */
      path: string;
      /** The table key that matched. */
      pattern: string;
      /** The handler module name. */
      handler: string;
    }
  | { ok: false; reason: 'not-found' | 'route-resolution' };

/**
 * Does this path match a pattern of the table?
 *
 * An exact pattern matches exactly. A '*' pattern matches exactly ONE
 * dynamic segment — the same shape as the platform's [id].ts route. There is
 * no catch-all: a path with two extra segments matches nothing.
 */
export function matchRoutePattern(pathname: string, table: RouteTable): RouteMatch | null {
  if (!pathname || !pathname.startsWith('/')) return null;

  if (Object.prototype.hasOwnProperty.call(table, pathname)) {
    return { pattern: pathname, handler: table[pathname] };
  }

  for (const pattern of Object.keys(table)) {
    if (!pattern.endsWith('/*')) continue;
    const prefix = pattern.slice(0, -2);
    if (!pathname.startsWith(prefix + '/')) continue;
    const rest = pathname.slice(prefix.length + 1);
    if (!rest || rest.includes('/')) continue; // exactly one segment
    return { pattern, handler: table[pattern] };
  }

  return null;
}

/** The pathname of a raw request URL, or '/' when it cannot be parsed. */
export function pathnameOf(rawUrl: string): string {
  try {
    return new URL(rawUrl, 'http://internal.invalid').pathname || '/';
  } catch {
    return '/';
  }
}

/**
 * Is this path inside the entry point's own prefix?
 *
 *   '/api/portal/projects/prj_1'  -> inside '/api/portal'
 *   '/api/admin/reviews'          -> NOT inside '/api/portal'
 *   '/api/portalx/anything'       -> NOT inside '/api/portal'
 *
 * The comparison is on the prefix AND the separator, so a family whose name
 * is a prefix of another family's name cannot swallow it.
 */
export function isInsideEntry(pathname: string, entryPrefix: string): boolean {
  if (!pathname || !pathname.startsWith('/')) return false;
  const prefix = entryPrefix.endsWith('/') ? entryPrefix.slice(0, -1) : entryPrefix;
  if (!prefix) return false;
  return pathname.startsWith(prefix + '/');
}

/**
 * Resolve a request to a route.
 *
 * @param rawUrl      the request URL as the runtime sees it
 * @param carrier     the original public path, null when there is NO carrier
 *                     at all, and '' when a carrier is PRESENT but empty
 *                     (wave 15, B-1: an empty carrier is invalid, not absent)
 * @param entryPrefix the entry point's own path ('/api/portal')
 * @param table       the family table
 * @param method      the HTTP method of the request. OPTIONAL: the resolver
 *                     is a function over strings and never sees the request
 *                     object, so a caller that does not pass it logs
 *                     'unknown'. It is logged on the empty-carrier refusal
 *                     only, and it is not sensitive.
 */
export function resolveRoute(
  rawUrl: string,
  carrier: string | null,
  entryPrefix: string,
  table: RouteTable,
  method: string = 'unknown',
): RouteResolution {
  const pathname = pathnameOf(rawUrl);

  // Rule 1: the path itself resolves.
  const direct = matchRoutePattern(pathname, table);
  if (direct) {
    return { ok: true, path: pathname, pattern: direct.pattern, handler: direct.handler };
  }

  // Rule 2: the carrier resolves.
  //
  //   A carrier that is PRESENT but EMPTY names no route: it is an INVALID
  //   carrier, not an absent one (wave 15, B-1). The test is therefore
  //   `carrier !== null`, NOT a truthiness test - `if (carrier)` would treat
  //   '' as absent, drop through to rule 3 and answer a loud 500 for a
  //   request that named a route and named it wrong.
  if (carrier !== null) {
    // An empty carrier names nothing, so it is refused here - before the
    // table is consulted. 404 {code:'not-found'}, never a guess.
    //
    // The refusal is LOGGED (wave 16b, F-2). It used to be silent, so a
    // client that sent ?__imk_route= (present but empty) looked exactly
    // like a client that asked for a URL that does not exist - and the
    // only trace of the misconfiguration was a 404 with no explanation.
    // This is the signal that a platform, proxy or rewrite rule appended
    // an empty carrier.
    //
    // What is logged: the timestamp, the outcome, the reason, the entry
    // point and the HTTP method. What is NOT logged: the carrier value
    // itself, any header, any cookie and any token - none of them is
    // needed to diagnose the refusal, and the reason alone identifies it.
    if (carrier === '') {
      // The token is in BOTH fields on purpose: the wave-16b brief
      // attaches 'empty_route_carrier' to `reason` in its requirement
      // list and to `outcome` in its acceptance list, so a log query on
      // either field finds this refusal.
      console.log(
        JSON.stringify({
          ts: Date.now(),
          outcome: 'empty_route_carrier',
          reason: 'empty_route_carrier',
          entry: entryPrefix,
          method,
        }),
      );
      return { ok: false, reason: 'not-found' };
    }
    // FAMILY CONTAINMENT, checked explicitly (wave 14).
    //
    // The table already keeps the two families apart, so for the table as
    // it stands this check is a NO-OP: every key of the portal table starts
    // with '/api/portal/' and every key of the admin table with
    // '/api/admin/'. It is here so the containment is a property of the
    // CODE and not only of the shape of the table - a cross-family route
    // added to a table later could not be reached with a carrier, and the
    // deploy gate (site/scripts/check-api-routes.mjs) names the entry
    // point that cannot serve it.
    //
    // It holds under EITHER merge order, which is the point: the merge
    // order on the deployed target is not observed.
    if (!isInsideEntry(carrier, entryPrefix)) {
      return { ok: false, reason: 'not-found' };
    }
    const carried = matchRoutePattern(carrier, table);
    if (carried) {
      return { ok: true, path: carrier, pattern: carried.pattern, handler: carried.handler };
    }
    // A carrier that names nothing in this family is not a route of this
    // family: 404, never a guess.
    return { ok: false, reason: 'not-found' };
  }

  // Rule 3: the entry point was reached with no route at all.
  if (pathname === entryPrefix) {
    return { ok: false, reason: 'route-resolution' };
  }

  // Rule 4.
  return { ok: false, reason: 'not-found' };
}

/**
 * Rebuild the URL the handler sees.
 *
 * The handler modules keep their own `url.pathname` match, so the runtime
 * must hand them the ORIGINAL public path — and the ORIGINAL query string,
 * because four of the portal URLs read ?projectId= / ?planItemId= from it.
 *
 * The carrier parameter is removed: it is the platform's routing note, not
 * something the handler ever asked for.
 */
export function rebuildRequestUrl(rawUrl: string, resolvedPath: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl, 'http://internal.invalid');
  } catch {
    return resolvedPath;
  }
  url.pathname = resolvedPath;
  url.searchParams.delete(ROUTE_CARRIER_PARAM);
  const search = url.searchParams.toString();
  return search ? `${resolvedPath}?${search}` : resolvedPath;
}
