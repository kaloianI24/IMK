// api/portal/comments.ts — Vercel serverless function.
//   GET  /api/portal/comments        — list comments (?projectId= or ?planItemId=)
//   POST /api/portal/comments        — create comment
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
const COMMENTS_FILE = path.join(PORTAL_DATA_DIR, 'comments.jsonl');

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
 * comments" — a silent outage wearing the costume of a normal answer.
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

  // A const arrow, not a hoisted `function`: TypeScript does not carry the
  // `session` null-narrowing into a hoisted function declaration (it could be
  // called before the narrowing), but it does carry it into an arrow assigned
  // to a const. Same behaviour, and the closure's session dependency is now
  // visible to the checker.
  const checkOwnership = (
    projectId: string,
  ): { project: Record<string, any> } | { error: any; status: number } => {
    const project = projects.find((p) => p.id === projectId);
    if (!project) return { error: { error: 'project not found', code: 'not-found' }, status: 404 };
    if (!projectAccessible(project, session)) {
      return { error: { error: 'forbidden', code: 'forbidden' }, status: 403 };
    }
    return { project };
  };

  // ---- GET /api/portal/comments ----
  if (pathname === '/api/portal/comments' && method === 'GET') {
    const projectId = url.searchParams.get('projectId');
    const planItemId = url.searchParams.get('planItemId');
    const all = readJsonl(COMMENTS_FILE);

    let filtered = all;
    if (projectId) {
      const ownership = checkOwnership(projectId);
      if ('error' in ownership) {
        json(res, ownership.error, ownership.status);
        return;
      }
      filtered = all.filter((c) => c.projectId === projectId);
    } else {
      const accessibleProjectIds = session.role === 'admin'
        ? projects.map((p) => p.id)
        : projects.filter((p) => projectAccessible(p, session)).map((p) => p.id);
      filtered = all.filter((c) => accessibleProjectIds.includes(c.projectId));
    }
    if (planItemId) {
      filtered = filtered.filter((c) => c.planItemId === planItemId);
    }

    filtered.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    json(res, { ok: true, comments: filtered }, 200);
    return;
  }

  // ---- POST /api/portal/comments ----
  if (pathname === '/api/portal/comments' && method === 'POST') {
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

    let body: { projectId?: string; planItemId?: string; body?: string };
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

    const bodyText = String(body.body || '').trim();
    if (bodyText.length < 1 || bodyText.length > 2000) {
      json(res, { error: 'invalid body', code: 'validation', fields: ['body'] }, 400);
      return;
    }

    const comment = {
      id: 'cmt_' + crypto.randomBytes(6).toString('hex'),
      planItemId: body.planItemId || undefined,
      projectId: body.projectId,
      authorId: session.clientId || session.email,
      authorRole: session.role,
      authorName: session.email,
      body: bodyText,
      createdAt: new Date().toISOString(),
    };

    appendJsonl(COMMENTS_FILE, comment);

    console.log(
      JSON.stringify({
        ts: Date.now(),
        outcome: 'comment_created',
        commentId: comment.id,
        projectId: body.projectId,
        authorRole: session.role,
      }),
    );

    json(res, { ok: true, comment }, 200);
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
