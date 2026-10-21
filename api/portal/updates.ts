// api/portal/updates.ts — Vercel serverless function.
//   GET  /api/portal/updates        — list changelog entries (?projectId=)
//   POST /api/portal/updates        — create changelog entry
//
// Session required. Ownership enforced server-side via project clientId.

import { IncomingMessage, ServerResponse } from 'node:http';
import * as crypto from 'node:crypto';
import {
  getPortalStore,
  guardStore,
  storageFailureLog,
} from '../../site/shared/server/portal-store-access.js';
import {
  resolveAccess,
  canReadClient,
  canWriteClient,
  expectedOrigin,
  baseUrlConfigured,
} from './session.js';

// THE STORE (wave 9)
//   The collections come from the PortalStore contract
//   (site/shared/portal-store/**), not from a JSONL file: with
//   PORTAL_STORE=libsql the portal persists on a read-only filesystem
//   (Vercel), and with PORTAL_STORE=file the very same records land in the
//   very same site/data/portal/*.jsonl files as before.

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
 * Read a store file. A malformed line is an ERROR (audit M3 / QA D3): it must
 * not turn the collection into an empty list, because "empty" reads as "no
 * updates" — a silent outage wearing the costume of a normal answer.
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

/**
 * The access of this request.
 *
 * The READ scope is the client's own project, even when an owner cookie is
 * present (M-5, Architect §4.3); the WRITE scope additionally lets the owner
 * act for every client (M-4, the two-part gate).
 */
async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;
  const method = req.method || 'GET';

  const access = resolveAccess(req);
  const session = access.session;
  if (!session) {
    json(res, { error: 'authentication required', code: 'unauthorized' }, 401);
    return;
  }

  const store = getPortalStore();
  const projects = await store.list('projects');

  // A const arrow, not a hoisted `function`: TypeScript does not carry the
  // `session` null-narrowing into a hoisted function declaration (it could be
  // called before the narrowing), but it does carry it into an arrow assigned
  // to a const. Same behaviour, and the closure's session dependency is now
  // visible to the checker.
  const checkOwnership = (
    projectId: string,
    write: boolean,
  ): { project: Record<string, any> } | { error: any; status: number } => {
    const project = projects.find((p) => p.id === projectId);
    if (!project) return { error: { error: 'project not found', code: 'not-found' }, status: 404 };
    const allowed = write
      ? canWriteClient(access, project.clientId)
      : canReadClient(access, project.clientId);
    if (!allowed) {
      return { error: { error: 'forbidden', code: 'forbidden' }, status: 403 };
    }
    return { project };
  };

  // ---- GET /api/portal/updates ----
  if (pathname === '/api/portal/updates' && method === 'GET') {
    const projectId = url.searchParams.get('projectId');
    const all = await store.list('updates');

    let filtered = all;
    if (projectId) {
      const ownership = checkOwnership(projectId, false);
      if ('error' in ownership) {
        json(res, ownership.error, ownership.status);
        return;
      }
      filtered = all.filter((u) => u.projectId === projectId);
    } else {
      const accessibleProjectIds = projects
        .filter((p) => canReadClient(access, p.clientId))
        .map((p) => p.id);
      filtered = all.filter((u) => accessibleProjectIds.includes(u.projectId));
    }

    filtered.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    json(res, { ok: true, updates: filtered }, 200);
    return;
  }

  // ---- POST /api/portal/updates ----
  if (pathname === '/api/portal/updates' && method === 'POST') {
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

    let body: { projectId?: string; title?: string; body?: string };
    try {
      const raw = await readBody(req);
      body = JSON.parse(raw || '{}');
    } catch {
      json(res, { error: 'invalid payload', code: 'validation' }, 400);
      return;
    }

    // body.projectId is optional in the payload. Coerced, not validated, so
    // the "project not found" behaviour for a missing id is unchanged.
    const ownership = checkOwnership(String(body.projectId ?? ''), true);
    if ('error' in ownership) {
      json(res, ownership.error, ownership.status);
      return;
    }

    const title = String(body.title || '').trim();
    if (title.length < 1 || title.length > 120) {
      json(res, { error: 'invalid title', code: 'validation', fields: ['title'] }, 400);
      return;
    }

    const bodyText = String(body.body || '').trim();
    if (bodyText.length < 1 || bodyText.length > 2000) {
      json(res, { error: 'invalid body', code: 'validation', fields: ['body'] }, 400);
      return;
    }

    const update = {
      id: 'upd_' + crypto.randomBytes(6).toString('hex'),
      projectId: body.projectId,
      title,
      body: bodyText,
      createdBy: session.email,
      createdAt: new Date().toISOString(),
    };

    await store.append('updates', update);

    console.log(
      JSON.stringify({
        ts: Date.now(),
        outcome: 'update_created',
        updateId: update.id,
        projectId: body.projectId,
        createdBy: session.email,
        role: session.role,
      }),
    );

    json(res, { ok: true, update }, 200);
    return;
  }

  json(res, { error: 'not found', code: 'not-found' }, 404);
}

// A corrupt store must never look like an empty one (audit M3 / QA D3).
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
