// api/portal/projects.ts — Vercel serverless function.
//   GET    /api/portal/projects        — list projects (client: own; admin: all)
//   GET    /api/portal/projects/:id    — get single project
//   PATCH  /api/portal/projects/:id    — update project status (owner only)
//
// Session required. Ownership enforced server-side; client-supplied IDs ignored.

import { IncomingMessage, ServerResponse } from 'node:http';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readJsonlFile, guardStorage } from '../lib/jsonl.js';
import {
  resolveSession,
  baseUrl,
  expectedOrigin,
  isSecureBaseUrl,
  sessionCookieString,
  baseUrlConfigured,
} from './session.js';

const PORTAL_DATA_DIR = path.resolve(process.cwd(), 'site/data/portal');
const PROJECTS_FILE = path.join(PORTAL_DATA_DIR, 'projects.jsonl');
const CLIENTS_FILE = path.join(PORTAL_DATA_DIR, 'clients.jsonl');

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

function projectPath(id: string): string {
  // /api/portal/projects/:id
  const segments = id.split('/');
  return segments[segments.length - 1];
}

function clientIdOf(session: { email: string; role: 'admin' | 'client'; clientId?: string }): string | undefined {
  return session.role === 'client' ? session.clientId : undefined;
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

  // The owner-only endpoints prefer the admin cookie, so a stale client
  // cookie can never shadow it (audit m5).
  const session = resolveSession(req, method === 'GET' ? undefined : 'admin');
  if (!session) {
    json(res, { error: 'authentication required', code: 'unauthorized' }, 401);
    return;
  }

  // ---- GET /api/portal/projects ----
  if (pathname === '/api/portal/projects' && method === 'GET') {
    const projects = readJsonl(PROJECTS_FILE);
    const visible = session.role === 'admin'
      ? projects
      : projects.filter((p) => projectAccessible(p, session));
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
    const projects = readJsonl(PROJECTS_FILE);
    const project = projects.find((p) => p.id === projectId);
    if (!project) {
      json(res, { error: 'project not found', code: 'not-found' }, 404);
      return;
    }
    if (!projectAccessible(project, session)) {
      json(res, { error: 'forbidden', code: 'forbidden' }, 403);
      return;
    }
    json(res, { ok: true, project }, 200);
    return;
  }

  // ---- PATCH /api/portal/projects/:id ----
  if (projectId && method === 'PATCH') {
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

    let body: { status?: string; title?: string; testimonialStatus?: string | null };
    try {
      const raw = await readBody(req);
      body = JSON.parse(raw || '{}');
    } catch {
      json(res, { error: 'invalid payload', code: 'validation' }, 400);
      return;
    }

    const projects = readJsonl(PROJECTS_FILE);
    const idx = projects.findIndex((p) => p.id === projectId);
    if (idx === -1) {
      json(res, { error: 'project not found', code: 'not-found' }, 404);
      return;
    }

    const project = projects[idx];
    if (body.status !== undefined) {
      if (!PROJECT_STATUSES.includes(body.status)) {
        json(res, { error: 'invalid status', code: 'validation', fields: ['status'] }, 400);
        return;
      }
      project.status = body.status;
      project.updatedBy = session.email;
      project.updatedAt = new Date().toISOString();
    }
    if (body.title !== undefined) {
      const title = String(body.title).trim();
      if (title.length < 1 || title.length > 120) {
        json(res, { error: 'invalid title', code: 'validation', fields: ['title'] }, 400);
        return;
      }
      project.title = title;
    }
    if (body.testimonialStatus !== undefined) {
      // The owner can ask again ('requested') or close the request. A client
      // who snoozed or declined gets the card back when the owner re-requests.
      const value = body.testimonialStatus;
      if (value === null) {
        delete project.testimonialStatus;
      } else if (typeof value === 'string' && TESTIMONIAL_STATUSES.includes(value)) {
        project.testimonialStatus = value;
      } else {
        json(res, {
          error: 'invalid testimonialStatus',
          code: 'validation',
          fields: ['testimonialStatus'],
        }, 400);
        return;
      }
      project.updatedBy = session.email;
      project.updatedAt = new Date().toISOString();
    }

    projects[idx] = project;
    rewriteJsonl(PROJECTS_FILE, projects);

    console.log(
      JSON.stringify({
        ts: Date.now(),
        outcome: 'project_updated',
        projectId,
        status: project.status,
        updatedBy: session.email,
      }),
    );

    json(res, { ok: true, project }, 200);
    return;
  }

  // ---- POST /api/portal/projects ----
  if (pathname === '/api/portal/projects' && method === 'POST') {
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

    // Resolve client: admin-supplied clientId must exist in clients.jsonl
    let targetClientId: string | undefined;
    if (body.clientId) {
      const clients = readJsonl(CLIENTS_FILE);
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
      updatedBy: session.email,
    };

    appendJsonl(PROJECTS_FILE, project);

    console.log(
      JSON.stringify({
        ts: Date.now(),
        outcome: 'project_created',
        projectId: project.id,
        clientId: targetClientId,
        createdBy: session.email,
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
