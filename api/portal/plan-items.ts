// api/portal/plan-items.ts — Vercel serverless function.
//   GET     /api/portal/plan-items        — list plan items (?projectId=)
//   POST    /api/portal/plan-items        — create plan item (owner only)
//   PATCH   /api/portal/plan-items/:id    — update status / approve / request-change
//
// Session required. Ownership enforced server-side via project clientId.

import { IncomingMessage, ServerResponse } from 'node:http';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readJsonlFile, guardStorage } from '../lib/jsonl.js';
import {
  resolveSession,
  expectedOrigin,
  baseUrlConfigured,
} from './session.js';

const PORTAL_DATA_DIR = path.resolve(process.cwd(), 'site/data/portal');
const PROJECTS_FILE = path.join(PORTAL_DATA_DIR, 'projects.jsonl');
const PLAN_ITEMS_FILE = path.join(PORTAL_DATA_DIR, 'planItems.jsonl');

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
 */
function readJsonl(file: string): Array<Record<string, any>> {
  return readJsonlFile(file);
}

function appendJsonl(file: string, record: Record<string, any>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8');
}

function rewriteJsonl(file: string, records: Array<Record<string, any>>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const content = records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : '');
  fs.writeFileSync(file, content, 'utf8');
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function projectAccessible(
  project: Record<string, any>,
  session: { email: string; role: 'admin' | 'client'; clientId?: string },
): boolean {
  if (session.role === 'admin') return true;
  return project.clientId === session.clientId;
}

async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;
  const method = req.method || 'GET';

  const session = resolveSession(req);
  if (!session) {
    json(res, { error: 'authentication required', code: 'unauthorized' }, 401);
    return;
  }

  const projects = readJsonl(PROJECTS_FILE);

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
  ): { project: Record<string, any> } | { error: any; status: number } => {
    const project = findProject(projectId);
    if (!project) return { error: { error: 'project not found', code: 'not-found' }, status: 404 };
    if (!projectAccessible(project, session)) {
      return { error: { error: 'forbidden', code: 'forbidden' }, status: 403 };
    }
    return { project };
  };

  // ---- GET /api/portal/plan-items ----
  if (pathname === '/api/portal/plan-items' && method === 'GET') {
    const projectId = url.searchParams.get('projectId');
    const all = readJsonl(PLAN_ITEMS_FILE);

    let filtered = all;
    if (projectId) {
      const ownership = checkOwnership(projectId);
      if ('error' in ownership) {
        json(res, ownership.error, ownership.status);
        return;
      }
      filtered = all.filter((i) => i.projectId === projectId);
    } else {
      // No projectId: client sees own projects only; admin sees all
      const accessibleProjectIds = session.role === 'admin'
        ? projects.map((p) => p.id)
        : projects.filter((p) => projectAccessible(p, session)).map((p) => p.id);
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

    const items = readJsonl(PLAN_ITEMS_FILE);
    const idx = items.findIndex((i) => i.id === planItemId);
    if (idx === -1) {
      json(res, { error: 'plan item not found', code: 'not-found' }, 404);
      return;
    }

    const item = items[idx];
    const ownership = checkOwnership(item.projectId);
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

    if (body.status !== undefined) {
      if (!PLAN_ITEM_STATUSES.includes(body.status)) {
        json(res, { error: 'invalid status', code: 'validation', fields: ['status'] }, 400);
        return;
      }
      item.status = body.status;
      item.updatedAt = new Date().toISOString();

      // Client approve / request-change tracking
      if (session.role === 'client') {
        if (body.status === 'done') {
          item.approvedBy = session.email;
          item.approvedAt = new Date().toISOString();
          item.requestChangeBy = undefined;
          item.requestChangeAt = undefined;
        } else if (body.status === 'in-progress' || body.status === 'todo') {
          // Client requesting change: revert from done
          item.requestChangeBy = session.email;
          item.requestChangeAt = new Date().toISOString();
          item.approvedBy = undefined;
          item.approvedAt = undefined;
        }
      }
    }

    if (body.title !== undefined) {
      const title = String(body.title).trim();
      if (title.length < 1 || title.length > 120) {
        json(res, { error: 'invalid title', code: 'validation', fields: ['title'] }, 400);
        return;
      }
      item.title = title;
    }
    if (body.description !== undefined) {
      const desc = String(body.description).trim();
      if (desc.length > 1000) {
        json(res, { error: 'description too long', code: 'validation', fields: ['description'] }, 400);
        return;
      }
      item.description = desc ? desc : undefined;
    }

    items[idx] = item;
    rewriteJsonl(PLAN_ITEMS_FILE, items);

    console.log(
      JSON.stringify({
        ts: Date.now(),
        outcome: 'plan_item_updated',
        planItemId,
        status: item.status,
        updatedBy: session.email,
        role: session.role,
      }),
    );

    json(res, { ok: true, planItem: item }, 200);
    return;
  }

  // ---- POST /api/portal/plan-items ----
  if (pathname === '/api/portal/plan-items' && method === 'POST') {
    if (session.role !== 'admin') {
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
    const ownership = checkOwnership(String(body.projectId ?? ''));
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

    const allItems = readJsonl(PLAN_ITEMS_FILE);
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

    appendJsonl(PLAN_ITEMS_FILE, planItem);

    console.log(
      JSON.stringify({
        ts: Date.now(),
        outcome: 'plan_item_created',
        planItemId: planItem.id,
        projectId: body.projectId,
        createdBy: session.email,
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
  return guardStorage(
    () => handler(req, res),
    (err) => {
      console.log(
        JSON.stringify({
          ts: Date.now(),
          outcome: 'storage_corrupt',
          file: err.file,
          line: err.line,
        }),
      );
      json(res, { error: 'storage unavailable', code: 'storage' }, 500);
    },
  );
}
