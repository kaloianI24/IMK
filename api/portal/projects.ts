// api/portal/projects.ts — Vercel serverless function.
//   GET    /api/portal/projects        — list projects (client: own; admin: all)
//   GET    /api/portal/projects/:id    — get single project
//   PATCH  /api/portal/projects/:id    — update project status (owner only)
//
// Session required. Ownership enforced server-side; client-supplied IDs ignored.

import { IncomingMessage, ServerResponse } from 'node:http';
import * as crypto from 'node:crypto';
import {
  getPortalStore,
  guardStore,
  storageFailureLog,
} from '../../site/shared/server/portal-store-access.js';
import {
  resolveAccess,
  resolveOwnerSession,
  canReadClient,
  expectedOrigin,
  baseUrlConfigured,
} from './session.js';

// THE STORE (wave 9)
//   The collections come from the PortalStore contract
//   (site/shared/portal-store/**), not from a JSONL file: with
//   PORTAL_STORE=libsql the portal persists on a read-only filesystem
//   (Vercel), and with PORTAL_STORE=file the very same records land in the
//   very same site/data/portal/*.jsonl files as before.

const PROJECT_STATUSES = [
  'discovery',
  'in-progress',
  'review',
  'completed',
  'on-hold',
  'archived',
];

// Whether the client is currently being asked for a testimonial:
//   'requested' — the owner asked (or the client answered); the card shows
//   'snoozed'   — the client said "maybe later"
//   'declined'  — the client said no; the card stays hidden
const TESTIMONIAL_STATUSES = ['requested', 'snoozed', 'declined'];

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
 * Project titles are stored RAW.
 *
 * They used to be HTML-escaped at write time AND escaped again by the portal
 * when it rendered them, so "Tom & Jerry Ltd" was shown as
 * "Tom &amp;amp; Jerry Ltd" (audit m3). Escaping belongs at the point of
 * output — every consumer (site/src/pages/portal.astro) escapes already.
 */

/**
 * Read a store file. A malformed line is an ERROR (audit M3 / QA D3): it must
 * not turn the collection into an empty list, because "empty" reads as "no
 * project" — a silent outage wearing the costume of a normal answer.
 *
 * The store itself enforces that rule (a corrupt store raises, it never
 * returns an empty list), so the handler only has to let the error through
 * to guardStore(), which answers 500 {code:'storage'}.
 */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function projectPath(id: string): string {
  // /api/portal/projects/:id
  const segments = id.split('/');
  return segments[segments.length - 1];
}

async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;
  const method = req.method || 'GET';

  // ONE reading of the cookies, TWO decisions (M-4, M-5).
  //
  //   access.session — the READ session: the client cookie first, so a live
  //                   admin cookie can never widen a client's read scope
  //                   (Architect §4.3). The owner (no client cookie) reads
  //                   every project.
  //   access.owner  — the WRITE gate: the admin cookie, the role claim AND
  //                   the live allow-list. An owner-only action needs it,
  //                   so taking an address off ADMIN_EMAILS revokes the
  //                   owner's powers at once (M-4).
  const access = resolveAccess(req);
  const session = access.session;

  // Nobody is signed in at all -> 401, on every path.
  if (!access.any) {
    json(res, { error: 'authentication required', code: 'unauthorized' }, 401);
    return;
  }

  // The READ scope: a client session, or the owner gate. A session that is
  // neither — an owner whose address was just taken off the allow-list — has
  // no read scope at all (Architect §4.3).
  if (method === 'GET' && !session) {
    json(res, { error: 'authentication required', code: 'unauthorized' }, 401);
    return;
  }

  // ---- GET /api/portal/projects ----
  if (pathname === '/api/portal/projects' && method === 'GET') {
    const store = getPortalStore();
    const projects = await store.list('projects');
    const visible = projects.filter((p) => canReadClient(access, p.clientId));
    json(res, { ok: true, projects: visible }, 200);
    return;
  }

  // ---- GET /api/portal/projects/:id ----
  // The id can arrive in the path (/api/portal/projects/:id) or, on a
  // runtime that resolves the dynamic route before the function runs, as the
  // route parameter (req.query.id). Both are accepted: the handler must not
  // depend on which convention the host uses (QA wave-3 F-1).
  const projectIdMatch = pathname.match(/^\/api\/portal\/projects\/([^\/]+)$/);
  const projectIdParam =
    (req as any).query && typeof (req as any).query.id === 'string'
      ? (req as any).query.id
      : null;
  const projectId = projectIdMatch ? projectIdMatch[1] : projectIdParam;

  if (projectId && method === 'GET') {
    const store = getPortalStore();
    const project = await store.get('projects', { field: 'id', value: projectId });
    if (!project) {
      json(res, { error: 'project not found', code: 'not-found' }, 404);
      return;
    }
    if (!canReadClient(access, project.clientId)) {
      json(res, { error: 'forbidden', code: 'forbidden' }, 403);
      return;
    }
    json(res, { ok: true, project }, 200);
    return;
  }

  // ---- PATCH /api/portal/projects/:id ----
  if (projectId && method === 'PATCH') {
    // The OWNER gate: the role claim AND the live allow-list (M-4). A
    // session that was minted while the address was still on the list stops
    // working the moment it is removed — not at the next token expiry.
    const owner = resolveOwnerSession(req, process.env);
    if (!owner) {
      json(res, { error: 'forbidden', code: 'forbidden' }, 403);
      return;
    }

    // A production instance without SITE_BASE_URL/SITE_URL cannot verify the
    // origin — that is a missing setting, not a CSRF attempt (audit m4).
    if (!baseUrlConfigured()) {
      json(res, { error: 'misconfigured', code: 'internal' }, 500);
      return;
    }

    const origin = (req.headers.origin as string | undefined) || '';
    if (origin !== expectedOrigin()) {
      json(res, { error: 'origin required', code: 'origin' }, 403);
      return;
    }

    let body: { status?: string; title?: string; testimonialStatus?: string | null };
    try {
      const raw = await readBody(req);
      body = JSON.parse(raw || '{}');
    } catch {
      json(res, { error: 'invalid payload', code: 'validation' }, 400);
      return;
    }

    const store = getPortalStore();
    const project = await store.get('projects', { field: 'id', value: projectId });
    if (!project) {
      json(res, { error: 'project not found', code: 'not-found' }, 404);
      return;
    }

    // The patch holds ONLY the fields this request changes: the store writes
    // exactly these (an undefined value REMOVES the field, the way the old
    // `delete project.testimonialStatus` did).
    const patch: Record<string, any> = {};

    if (body.status !== undefined) {
      if (!PROJECT_STATUSES.includes(body.status)) {
        json(res, { error: 'invalid status', code: 'validation', fields: ['status'] }, 400);
        return;
      }
      patch.status = body.status;
      patch.updatedBy = owner.email;
      patch.updatedAt = new Date().toISOString();
    }
    if (body.title !== undefined) {
      const title = String(body.title).trim();
      if (title.length < 1 || title.length > 120) {
        json(res, { error: 'invalid title', code: 'validation', fields: ['title'] }, 400);
        return;
      }
      patch.title = title;
    }
    if (body.testimonialStatus !== undefined) {
      // The owner can ask again ('requested') or close the request. A client
      // who snoozed or declined gets the card back when the owner re-requests.
      const value = body.testimonialStatus;
      if (value === null) {
        patch.testimonialStatus = undefined; // the field is removed
      } else if (typeof value === 'string' && TESTIMONIAL_STATUSES.includes(value)) {
        patch.testimonialStatus = value;
      } else {
        json(res, {
          error: 'invalid testimonialStatus',
          code: 'validation',
          fields: ['testimonialStatus'],
        }, 400);
        return;
      }
      patch.updatedBy = owner.email;
      patch.updatedAt = new Date().toISOString();
    }

    await store.update('projects', { id: projectId }, patch);

    const updated = { ...project, ...patch };

    console.log(
      JSON.stringify({
        ts: Date.now(),
        outcome: 'project_updated',
        projectId,
        status: updated.status,
        updatedBy: owner.email,
      }),
    );

    json(res, { ok: true, project: updated }, 200);
    return;
  }

  // ---- POST /api/portal/projects ----
  if (pathname === '/api/portal/projects' && method === 'POST') {
    // The OWNER gate (M-4): the role claim AND the live allow-list.
    const owner = resolveOwnerSession(req, process.env);
    if (!owner) {
      json(res, { error: 'forbidden', code: 'forbidden' }, 403);
      return;
    }

    // A production instance without SITE_BASE_URL/SITE_URL cannot verify the
    // origin — that is a missing setting, not a CSRF attempt (audit m4).
    if (!baseUrlConfigured()) {
      json(res, { error: 'misconfigured', code: 'internal' }, 500);
      return;
    }

    const origin = (req.headers.origin as string | undefined) || '';
    if (origin !== expectedOrigin()) {
      json(res, { error: 'origin required', code: 'origin' }, 403);
      return;
    }

    let body: { title?: string; clientId?: string; status?: string };
    try {
      const raw = await readBody(req);
      body = JSON.parse(raw || '{}');
    } catch {
      json(res, { error: 'invalid payload', code: 'validation' }, 400);
      return;
    }

    const title = String(body.title || '').trim();
    if (title.length < 1 || title.length > 120) {
      json(res, { error: 'invalid title', code: 'validation', fields: ['title'] }, 400);
      return;
    }

    // Resolve client: admin-supplied clientId must exist in the client store
    let targetClientId: string | undefined;
    if (body.clientId) {
      const store = getPortalStore();
      const clients = await store.list('clients');
      const client = clients.find((c) => c.id === body.clientId || c.email === body.clientId);
      if (!client) {
        json(res, { error: 'client not found', code: 'not-found' }, 404);
        return;
      }
      targetClientId = client.id;
    }

    const project = {
      id: 'prj_' + crypto.randomBytes(6).toString('hex'),
      clientId: targetClientId,
      title,
      status: body.status && PROJECT_STATUSES.includes(body.status) ? body.status : 'discovery',
      startedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedBy: owner.email,
    };

    const store = getPortalStore();
    await store.append('projects', project);

    console.log(
      JSON.stringify({
        ts: Date.now(),
        outcome: 'project_created',
        projectId: project.id,
        clientId: targetClientId,
        createdBy: owner.email,
      }),
    );

    json(res, { ok: true, project }, 200);
    return;
  }

  json(res, { error: 'not found', code: 'not-found' }, 404);
}

// A corrupt store must never look like an empty one (audit M3 / QA D3):
// "no projects" is a normal answer, a broken store file is not.
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
