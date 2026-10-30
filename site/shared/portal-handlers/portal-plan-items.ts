// site/shared/portal-handlers/portal-plan-items.ts — the Vercel handler module.
//
// WHY IT MOVED (wave 13, function budget)
//   It used to be api/portal/plan-items.ts, which was a Vercel FUNCTION of
//   its own. The portal family now has ONE entry point (api/portal.ts) and
//   the route table decides which handler serves a request. The module body
//   is unchanged; only its home is.
//   GET     /api/portal/plan-items        — list plan items (?projectId=)
//   POST    /api/portal/plan-items        — create plan item (owner only)
//   PATCH   /api/portal/plan-items/:id    — update status / approve / request-change
//
// Session required. Ownership enforced server-side via project clientId.

import { IncomingMessage, ServerResponse } from 'node:http';
import * as crypto from 'node:crypto';
import {
  getPortalStore,
  guardStore,
  storageFailureLog,
  assertStoreReachable,
  StoreUnreachableError,
} from '../server/portal-store-access.js';
import {
  resolveAccess,
  resolveOwnerSession,
  canReadClient,
  canWriteClient,
  expectedOrigin,
  baseUrlConfigured,
} from '../server/portal-session.js';

// THE STORE (wave 9)
//   The collections come from the PortalStore contract
//   (site/shared/portal-store/**), not from a JSONL file: with
//   PORTAL_STORE=libsql the portal persists on a read-only filesystem
//   (Vercel), and with PORTAL_STORE=file the very same records land in the
//   very same site/data/portal/*.jsonl files as before.

const PLAN_ITEM_STATUSES = ['todo', 'in-progress', 'done', 'blocked'];

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
 * plan items" — a silent outage wearing the costume of a normal answer.
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

async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;
  const method = req.method || 'GET';

  // THE STORE MUST BE THERE (wave 10, F-3).
  //
  // A store that is not there at all is NOT an empty store. Without this
  // check a deployment without a store answers 200 with "not invited" /
  // "no projects" / "no quote" — a silent outage wearing the costume of a
  // normal answer. The answer is 501 {code:'unimplemented'}: the same one
  // the moderation endpoint and the owner's inbox give for the same
  // situation (spec/07 §1, D-6 — the two trees must not disagree).
  try {
    assertStoreReachable();
  } catch (err) {
    if (err instanceof StoreUnreachableError) {
      console.log(JSON.stringify({ ts: Date.now(), outcome: 'portal_store_unreachable' }));
      json(res, { error: 'portal store unavailable on this target', code: 'unimplemented' }, 501);
      return;
    }
    throw err;
  }

  // ONE reading of the cookies, TWO decisions (M-4, M-5): the READ scope is
  // the client's own, the WRITE gate is the owner's (role claim AND the live
  // allow-list).
  const access = resolveAccess(req);
  const session = access.session;

  // Nobody is signed in at all -> 401, on every path.
  if (!access.any) {
    json(res, { error: 'authentication required', code: 'unauthorized' }, 401);
    return;
  }

  const store = getPortalStore();
  const projects = await store.list('projects');

  function findProject(id: string): Record<string, any> | undefined {
    return projects.find((p) => p.id === id);
  }

  // A const arrow, not a hoisted `function`: TypeScript does not carry the
  // `session` null-narrowing into a hoisted function declaration (it could be
  // called before the narrowing), but it does carry it into an arrow assigned
  // to a const. Same behaviour, and the closure's session dependency is now
  // visible to the checker.
  const checkOwnership = (
    projectId: string,
    write: boolean,
  ): { project: Record<string, any> } | { error: any; status: number } => {
    const project = findProject(projectId);
    if (!project) return { error: { error: 'project not found', code: 'not-found' }, status: 404 };
    const allowed = write
      ? canWriteClient(access, project.clientId)
      : canReadClient(access, project.clientId);
    if (!allowed) {
      return { error: { error: 'forbidden', code: 'forbidden' }, status: 403 };
    }
    return { project };
  };

  // ---- GET /api/portal/plan-items ----
  if (pathname === '/api/portal/plan-items' && method === 'GET') {
    // The READ scope: a client session, or the owner gate (Architect §4.3).
    if (!session) {
      json(res, { error: 'authentication required', code: 'unauthorized' }, 401);
      return;
    }
    const projectId = url.searchParams.get('projectId');
    const all = await store.list('planItems');

    let filtered = all;
    if (projectId) {
      const ownership = checkOwnership(projectId, false);
      if ('error' in ownership) {
        json(res, ownership.error, ownership.status);
        return;
      }
      filtered = all.filter((i) => i.projectId === projectId);
    } else {
      // No projectId: the client sees own projects only; the owner sees all
      const accessibleProjectIds = projects
        .filter((p) => canReadClient(access, p.clientId))
        .map((p) => p.id);
      filtered = all.filter((i) => accessibleProjectIds.includes(i.projectId));
    }

    filtered.sort((a, b) => (a.order || 0) - (b.order || 0));
    json(res, { ok: true, planItems: filtered }, 200);
    return;
  }

  // ---- PATCH /api/portal/plan-items/:id ----
  // The id can arrive in the path (/api/portal/plan-items/:id) or, on a
  // runtime that resolves the dynamic route before the function runs, as the
  // route parameter (req.query.id). Both are accepted (QA wave-3 F-1).
  const patchMatch = pathname.match(/^\/api\/portal\/plan-items\/([^\/]+)$/);
  const planItemIdParam =
    (req as any).query && typeof (req as any).query.id === 'string'
      ? (req as any).query.id
      : null;
  const planItemId = patchMatch ? patchMatch[1] : planItemIdParam;
  if (planItemId && method === 'PATCH') {
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

    const item = await store.get('planItems', { field: 'id', value: planItemId });
    if (!item) {
      json(res, { error: 'plan item not found', code: 'not-found' }, 404);
      return;
    }

    const ownership = checkOwnership(item.projectId, true);
    if ('error' in ownership) {
      json(res, ownership.error, ownership.status);
      return;
    }

    let body: { status?: string; title?: string; description?: string };
    try {
      const raw = await readBody(req);
      body = JSON.parse(raw || '{}');
    } catch {
      json(res, { error: 'invalid payload', code: 'validation' }, 400);
      return;
    }

    // The patch holds ONLY the fields this request changes.
    const patch: Record<string, any> = {};

    if (body.status !== undefined) {
      if (!PLAN_ITEM_STATUSES.includes(body.status)) {
        json(res, { error: 'invalid status', code: 'validation', fields: ['status'] }, 400);
        return;
      }
      patch.status = body.status;
      patch.updatedAt = new Date().toISOString();

      // Client approve / request-change tracking.
      //
      // Only a CLIENT's own change counts as an approval. The owner editing
      // a status is not a client approval, so the tracking is bound to the
      // client session and NOT to the owner gate: a request that passes the
      // owner gate is the owner's action, whoever else is signed in.
      if (!access.owner && access.client) {
        if (body.status === 'done') {
          patch.approvedBy = access.client.email;
          patch.approvedAt = new Date().toISOString();
          patch.requestChangeBy = undefined;
          patch.requestChangeAt = undefined;
        } else if (body.status === 'in-progress' || body.status === 'todo') {
          // Client requesting change: revert from done
          patch.requestChangeBy = access.client.email;
          patch.requestChangeAt = new Date().toISOString();
          patch.approvedBy = undefined;
          patch.approvedAt = undefined;
        }
      }
    }

    if (body.title !== undefined) {
      const title = String(body.title).trim();
      if (title.length < 1 || title.length > 120) {
        json(res, { error: 'invalid title', code: 'validation', fields: ['title'] }, 400);
        return;
      }
      patch.title = title;
    }
    if (body.description !== undefined) {
      const desc = String(body.description).trim();
      if (desc.length > 1000) {
        json(res, { error: 'description too long', code: 'validation', fields: ['description'] }, 400);
        return;
      }
      patch.description = desc ? desc : undefined;
    }

    await store.update('planItems', { id: planItemId }, patch);

    const updated = { ...item, ...patch };

    // The actor is the owner when the owner gate passed, the client
    // otherwise — the same decision the scope above was made with.
    const actor = access.owner || access.client;
    if (!actor) {
      json(res, { error: 'forbidden', code: 'forbidden' }, 403);
      return;
    }

    console.log(
      JSON.stringify({
        ts: Date.now(),
        outcome: 'plan_item_updated',
        planItemId,
        status: updated.status,
        updatedBy: actor.email,
        role: actor.role,
      }),
    );

    json(res, { ok: true, planItem: updated }, 200);
    return;
  }

  // ---- POST /api/portal/plan-items ----
  if (pathname === '/api/portal/plan-items' && method === 'POST') {
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

    let body: { projectId?: string; title?: string; description?: string; order?: number };
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

    const description = body.description ? String(body.description).trim() : '';
    if (description.length > 1000) {
      json(res, { error: 'description too long', code: 'validation', fields: ['description'] }, 400);
      return;
    }

    const allItems = await store.list('planItems');
    const projectItems = allItems.filter((i) => i.projectId === body.projectId);
    const order = body.order ?? (projectItems.length > 0 ? Math.max(...projectItems.map((i) => i.order || 0)) + 1 : 1);

    const planItem = {
      id: 'pli_' + crypto.randomBytes(6).toString('hex'),
      projectId: body.projectId,
      title,
      description: description ? description : undefined,
      status: 'todo',
      order,
      createdAt: new Date().toISOString(),
    };

    await store.append('planItems', planItem);

    console.log(
      JSON.stringify({
        ts: Date.now(),
        outcome: 'plan_item_created',
        planItemId: planItem.id,
        projectId: body.projectId,
        createdBy: owner.email,
      }),
    );

    json(res, { ok: true, planItem }, 200);
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
