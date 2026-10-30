// site/shared/portal-routes.ts — the TypeScript view of the route table.
//
// The table itself is site/shared/portal-routes.json: ONE file, read by three
// consumers (the entry points, the route-manifest check and the local dev
// server), so it can never disagree with itself.
//
// A JSON import is bundled at BUILD time (esbuild inlines it), so the
// function bundle carries the table with it — nothing is read from the
// filesystem at runtime, which matters because a Vercel function has a
// read-only filesystem.

import tableJson from './portal-routes.json';

export interface RouteFamily {
  /** The Vercel function file that serves this family. */
  entry: string;
  /** Public path pattern -> handler module name. */
  routes: { [publicPattern: string]: string };
}

export interface StandaloneRoute {
  /** The Vercel function file that serves this URL. */
  entry: string;
  /** The handler module name. */
  handler: string;
}

export interface RouteTable {
  version: number;
  families: { [prefix: string]: RouteFamily };
  standalone: { [publicPath: string]: StandaloneRoute };
  handlers: { [handlerName: string]: string };
}

export const PORTAL_ROUTE_TABLE: RouteTable = tableJson;

/** The entry point of the client-facing portal family. */
export const PORTAL_FAMILY_PREFIX = '/api/portal';

/** The entry point of the owner's inbox family. */
export const ADMIN_FAMILY_PREFIX = '/api/admin';

export const PORTAL_FAMILY: RouteFamily = PORTAL_ROUTE_TABLE.families[PORTAL_FAMILY_PREFIX];
export const ADMIN_FAMILY: RouteFamily = PORTAL_ROUTE_TABLE.families[ADMIN_FAMILY_PREFIX];

/** Every public path the table knows, families and standalone alike. */
export function everyPublicPath(): string[] {
  const paths: string[] = [];
  for (const family of Object.values(PORTAL_ROUTE_TABLE.families)) {
    paths.push(...Object.keys(family.routes));
  }
  paths.push(...Object.keys(PORTAL_ROUTE_TABLE.standalone));
  return paths.sort();
}
