// api/portal/invites.ts — Vercel serverless function.
//   POST /api/portal/invites — invite a client by email (owner only)
// Writes the 'invites' collection of the portal store (the 'clients'
// collection is patched with it).
//
// UPSERT, not insert-only: re-submitting an existing email patches the client
// profile (name / company / role) on BOTH the invite record and the client
// record. That is what lets the owner add a company (or fix a name) after the
// client has already signed in — without it, a client record can never be
// edited, because nothing else writes to the client collection.

import { IncomingMessage, ServerResponse } from 'node:http';
import {
  getPortalStore,
  guardStore,
  storageFailureLog,
} from '../../site/shared/server/portal-store-access.js';
import type { PortalStore } from '../../site/shared/portal-store/types.js';
import {
  resolveOwnerSession,
  expectedOrigin,
  baseUrlConfigured,
} from './session.js';

// THE STORE (wave 9)
//   The collections come from the PortalStore contract
//   (site/shared/portal-store/**), not from a JSONL file: with
//   PORTAL_STORE=libsql the portal persists on a read-only filesystem
//   (Vercel), and with PORTAL_STORE=file the very same records land in the
//   very same site/data/portal/*.jsonl files as before.
//
//   An invite record has no id of its own — the e-mail address IS its
//   identity — so a patch names the record by its e-mail AND its invitation
//   time. Both together match exactly one record.

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
 * The store enforces that rule itself (a corrupt store raises, it never
 * returns an empty list), so the handler only has to let the error through
 * to guardStore(), which answers 500 {code:'storage'}.
 */

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
async function syncClientProfile(
  store: PortalStore,
  clientId: string | undefined,
  profile: Partial<Record<ProfileField, string>>,
): Promise<boolean> {
  if (!clientId) return false;
  const client = await store.get('clients', { field: 'id', value: clientId });
  if (!client) return false;

  const patch: Record<string, any> = {};
  let changed = false;
  for (const [field, value] of Object.entries(profile)) {
    if (value === undefined) continue;
    if (client[field] !== value) {
      patch[field] = value;
      changed = true;
    }
  }
  if (changed) await store.update('clients', { id: clientId }, patch);
  return changed;
}

/**
 * The key that names ONE invite record.
 *
 * An invite has no id of its own: the e-mail address is its identity. The
 * invitation time is added so the key matches exactly one record even if the
 * same address was invited twice.
 */
function inviteKey(invite: Record<string, any>): Record<string, any> {
  const key: Record<string, any> = { email: invite.email };
  if (typeof invite.invitedAt === 'string') key.invitedAt = invite.invitedAt;
  return key;
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

  // The OWNER gate (M-4): the role claim AND the live allow-list. Reading
  // the allow-list on every request is what makes removing an address
  // revoke the owner's powers at once, not at the next token expiry.
  const session = resolveOwnerSession(req, process.env);
  if (!session) {
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

  const store = getPortalStore();
  const invited = await store.list('invites');

  const existing = invited.find((r) => String(r.email).toLowerCase() === email);
  if (existing) {
    // Upsert: patch the profile the owner just submitted. The clientId (set
    // on first sign-in) and the invite metadata are preserved.
    const patch: Record<string, any> = {};
    let changed = false;
    for (const [field, value] of Object.entries(profile)) {
      if (value === undefined) continue;
      if (existing[field] !== value) {
        patch[field] = value;
        changed = true;
      }
    }

    let clientUpdated = false;
    if (changed) {
      await store.update('invites', inviteKey(existing), patch);
      clientUpdated = await syncClientProfile(store, existing.clientId, profile);
    }

    json(
      res,
      { ok: true, invited: { ...existing, ...patch }, updated: changed, clientUpdated },
      200,
    );
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

  await store.append('invites', record);

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
  return guardStore(
    () => handler(req, res),
    (err) => {
      console.log(JSON.stringify(storageFailureLog(err)));
      json(res, { error: 'storage unavailable', code: 'storage' }, 500);
    },
  );
}
