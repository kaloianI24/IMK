// api/portal/invites.ts — Vercel serverless function.
//   POST /api/portal/invites — invite a client by email (owner only)
// Writes site/data/portal/invited.jsonl.
//
// UPSERT, not insert-only: re-submitting an existing email patches the client
// profile (name / company / role) on BOTH the invite record and the client
// record. That is what lets the owner add a company (or fix a name) after the
// client has already signed in — without it, a client record can never be
// edited, because nothing else writes to clients.jsonl.

import { IncomingMessage, ServerResponse } from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseJsonlStrict, guardStorage } from '../lib/jsonl.js';
import {
  resolveSession,
  expectedOrigin,
  baseUrlConfigured,
} from './session.js';

const PORTAL_DATA_DIR = path.resolve(process.cwd(), 'site/data/portal');
const INVITED_FILE = path.join(PORTAL_DATA_DIR, 'invited.jsonl');
const CLIENTS_FILE = path.join(PORTAL_DATA_DIR, 'clients.jsonl');

// Client-profile caps. These mirror the `testimonials` content collection
// schema (site/src/types/contracts.ts -> TESTIMONIAL_MAX) and the caps in
// api/portal/testimonials.ts (MAX_CLIENT_NAME / _COMPANY / _ROLE). The schema
// is the Frontend's; this is the server's half of the same contract. A value
// longer than the schema allows produces a published file that fails
// validation, and one invalid file fails the WHOLE build — so the cap has to
// exist here too, at the point the owner types the value.
const MAX_CLIENT_NAME = 80;
const MAX_CLIENT_COMPANY = 120;
const MAX_CLIENT_ROLE = 120;

/** The three owner-editable fields of a client record. */
type ProfileField = 'name' | 'company' | 'role';

const PROFILE_CAPS: Array<[ProfileField, number]> = [
  ['name', MAX_CLIENT_NAME],
  ['company', MAX_CLIENT_COMPANY],
  ['role', MAX_CLIENT_ROLE],
];

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

function isValidEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+$/.test(s) && !/[\r\n]/.test(s);
}

/**
 * Read a store file we are about to REWRITE. This refuses to turn a corrupt
 * file into an empty list: a rewrite of a parsed-as-empty file would delete
 * every record in it. A missing file is legitimately empty; an unparseable
 * line is an error the caller must surface, not swallow (audit M3).
 *
 * NOTE: the older `readJsonl()` here was dead code and was deleted — it
 * swallowed parse errors and would have been a trap for the next editor.
 */
function readJsonlForWrite(file: string): Array<Record<string, any>> {
  if (!fs.existsSync(file)) return [];
  return parseJsonlStrict(fs.readFileSync(file, 'utf8'), file);
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

/** Mirrors controlStrip() in api/portal/testimonials.ts. */
function controlStrip(s: string): string {
  return String(s ?? '')
    .replace(/[\r\n\t]/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();
}

/**
 * Parse the owner-supplied client profile.
 *
 * Semantics: an OMITTED field means "leave unchanged"; a field sent as an
 * empty string means "clear it". Sending a non-string or an over-long value
 * is a validation error — it is rejected rather than silently truncated, so
 * the owner finds out instead of publishing a mangled name.
 */
function parseProfile(body: Record<string, unknown>): {
  profile: Partial<Record<ProfileField, string>>;
  fields: string[];
} {
  const profile: Partial<Record<ProfileField, string>> = {};
  const fields: string[] = [];

  for (const [field, cap] of PROFILE_CAPS) {
    if (!(field in body)) continue; // omitted -> leave unchanged
    const raw = body[field];
    if (raw === null || raw === undefined) {
      profile[field] = ''; // explicit null -> clear
      continue;
    }
    if (typeof raw !== 'string') {
      fields.push(field);
      continue;
    }
    const value = controlStrip(raw);
    if (value.length > cap) {
      fields.push(field);
      continue;
    }
    profile[field] = value;
  }

  return { profile, fields };
}

/**
 * Keep the client record in step with the invite record.
 *
 * The client record is created on the client's first sign-in (auth.ts), so
 * before that there is nothing to patch. Afterwards this is the ONLY write
 * path to a client record — without it, a company could never be added to a
 * client who has already signed in.
 */
function syncClientProfile(
  clientId: string | undefined,
  profile: Partial<Record<ProfileField, string>>,
): boolean {
  if (!clientId) return false;
  const clients = readJsonlForWrite(CLIENTS_FILE);
  const idx = clients.findIndex((c) => c.id === clientId);
  if (idx === -1) return false;

  let changed = false;
  for (const [field, value] of Object.entries(profile)) {
    if (value === undefined) continue;
    if (clients[idx][field] !== value) {
      clients[idx][field] = value;
      changed = true;
    }
  }
  if (changed) rewriteJsonl(CLIENTS_FILE, clients);
  return changed;
}

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

  if (pathname !== '/api/portal/invites' || method !== 'POST') {
    json(res, { error: 'not found', code: 'not-found' }, 404);
    return;
  }

  // The owner-only endpoint prefers the admin cookie, so a stale client
  // cookie can never shadow it (audit m5).
  const session = resolveSession(req, 'admin');
  if (!session || session.role !== 'admin') {
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

  let body: Record<string, unknown>;
  try {
    const raw = await readBody(req);
    body = JSON.parse(raw || '{}');
  } catch {
    json(res, { error: 'invalid payload', code: 'validation' }, 400);
    return;
  }

  const email = String(body.email || '').trim().toLowerCase();
  if (!isValidEmail(email)) {
    json(res, { error: 'invalid email', code: 'validation', fields: ['email'] }, 400);
    return;
  }

  const { profile, fields } = parseProfile(body);
  if (fields.length) {
    json(res, { error: 'invalid client profile', code: 'validation', fields }, 400);
    return;
  }

  let invited: Array<Record<string, any>>;
  try {
    invited = readJsonlForWrite(INVITED_FILE);
  } catch {
    json(res, { error: 'store unreadable', code: 'storage' }, 500);
    return;
  }

  const existing = invited.find((r) => String(r.email).toLowerCase() === email);
  if (existing) {
    // Upsert: patch the profile the owner just submitted. The clientId (set
    // on first sign-in) and the invite metadata are preserved.
    let changed = false;
    for (const [field, value] of Object.entries(profile)) {
      if (value === undefined) continue;
      if (existing[field] !== value) {
        existing[field] = value;
        changed = true;
      }
    }

    let clientUpdated = false;
    if (changed) {
      rewriteJsonl(INVITED_FILE, invited);
      try {
        clientUpdated = syncClientProfile(existing.clientId, profile);
      } catch {
        json(res, { error: 'store unreadable', code: 'storage' }, 500);
        return;
      }
    }

    json(res, { ok: true, invited: existing, updated: changed, clientUpdated }, 200);
    return;
  }

  const record = {
    email,
    name: profile.name || email.split('@')[0],
    company: profile.company || '',
    role: profile.role || '',
    invitedBy: session.email,
    invitedAt: new Date().toISOString(),
    clientId: undefined,
  };

  appendJsonl(INVITED_FILE, record);

  console.log(
    JSON.stringify({
      ts: Date.now(),
      outcome: 'client_invited',
      email,
      invitedBy: session.email,
    }),
  );

  json(res, { ok: true, invited: record }, 200);
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
