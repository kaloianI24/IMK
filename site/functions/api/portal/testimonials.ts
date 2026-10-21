// site/functions/api/portal/testimonials.ts — Cloudflare Pages Function.
//   GET  /api/portal/testimonials?projectId=<id>
//   POST /api/portal/testimonials
//
// Mirrors api/portal/testimonials.ts (Vercel) so both targets share the same
// contract, the same validation and the same server-derived provenance
// (verifiedClient + source are never taken from the request body).
//
// Storage note: the Cloudflare target has no writable filesystem, so when the
// node:fs shim is unavailable (the real edge runtime) the endpoint answers
// 501 'unimplemented'. The portal card treats any non-OK answer as "not
// deployed" and hides itself, so no dead form is ever shown. Moving the whole
// portal store onto a real database (CF KV/D1) is a separate, sized piece of
// work — spec/08 §6 / Phase 3.2.

import { resolveSession, expectedOrigin, baseUrlConfigured } from './session.js';
import { notifyReviewSubmitted } from '../lib/notifications.js';
import { parseJsonlStrict, guardStorage } from '../../../shared/portal-store/jsonl.js';
import { createPortalRateLimiter } from '../lib/rate-limit.js';

const PROJECTS_FILE = 'site/data/portal/projects.jsonl';
const CLIENTS_FILE = 'site/data/portal/clients.jsonl';
const REVIEWS_FILE = 'site/data/moderation/reviews.jsonl';

const MAX_QUOTE = 1000;
const MAX_DISPLAY_NAME = 80;
// The published frontmatter is validated by the `testimonials` content
// collection (site/src/content.config.ts). A name/company/role longer than
// the schema allows produces a file that fails validation — and a failing
// file fails the WHOLE BUILD, not just one quote. Client records are typed by
// the owner with no length limit, so the cap has to live here, at the point
// the data enters the store. These three numbers mirror the schema exactly.
const MAX_CLIENT_NAME = 80;
const MAX_CLIENT_COMPANY = 120;
const MAX_CLIENT_ROLE = 120;
const SUBMIT_RATE_LIMIT = 5;
// Snooze and decline are limited too: they append to the same append-only
// log, and an unbounded stream of them would grow it without limit (audit m6).
const ACTION_RATE_LIMIT = 10;
const SUBMIT_RATE_WINDOW_MS = 60 * 60 * 1000;

const ACTIONS = ['submit', 'snooze', 'decline'];

type Action = (typeof ACTIONS)[number];
type TestimonialState = 'pending' | 'approved' | 'rejected' | 'snoozed' | 'declined';

interface Consent {
  p1: boolean;
  p2: boolean;
  p3: boolean;
  displayName: string;
}

interface TestimonialRecord {
  ref: string;
  type: 'review';
  state: TestimonialState;
  source: 'portal';
  verifiedClient: true;
  clientId: string;
  projectId: string;
  // Identity is written ONLY with naming consent (consent.p2) — a client who
  // withheld it has no name, company or role in the store (audit M1).
  // The e-mail address is never written to the store at all (audit M2).
  name: string;
  company: string;
  role: string;
  rating: string;
  review: string;
  consent: Consent;
  revision: number;
  receivedAt: string;
  updatedAt: string;
  revoked?: boolean;
  withdrawnAt?: string;
}

function json(body: any, status = 200, extra: Record<string, string> = {}): Response {
  const payload = JSON.stringify(body);
  return new Response(payload, {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...extra },
  });
}

function fsModule(): any {
  return (globalThis as any).require ? (globalThis as any).require('node:fs') : null;
}

function pathModule(): any {
  return (globalThis as any).require ? (globalThis as any).require('node:path') : null;
}

/**
 * Read a store file. A malformed line is an ERROR (audit M3 / QA D3): it must
 * not turn the collection into an empty list — "empty" reads as "no quote",
 * "no project", "not allowed", which is a silent outage.
 */
function readJsonl(file: string): Array<Record<string, any>> {
  const fs = fsModule();
  if (!fs) return [];
  if (!fs.existsSync(file)) return [];
  return parseJsonlStrict(fs.readFileSync(file, 'utf8'), file);
}

/**
 * Append one record. Returns false when the write could not happen: the
 * caller must NOT answer ok:true for a record that was never persisted —
 * the quote would look saved while the store never saw it (review finding
 * B7; same rule as moderate/review.ts).
 */
function appendJsonl(file: string, record: Record<string, any>): boolean {
  const fs = fsModule();
  const path = pathModule();
  if (!fs || !path) return false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** Rewrite a collection. Returns false when the write could not happen. */
function rewriteJsonl(file: string, records: Array<Record<string, any>>): boolean {
  const fs = fsModule();
  const path = pathModule();
  if (!fs || !path) return false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const content =
      records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : '');
    fs.writeFileSync(file, content, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * The payload is a quote, an action and a project id — nothing larger. The
 * contact endpoint caps its body at 8192; this handler used to read
 * unbounded, so it gets its own ~16 KB cap (review finding B5).
 */
const MAX_BODY = 16 * 1024;

/** Thrown by readBody when the request body exceeds MAX_BODY. */
class BodyTooLargeError extends Error {
  constructor() {
    super('request body too large');
    this.name = 'BodyTooLargeError';
  }
}

/**
 * The parsed body must be a plain JSON object before it is read as one.
 * `JSON.parse('null')` succeeds, and `null.action` threw — an unhandled 500
 * for a body the client controls (review finding B1).
 */
function isPlainObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read the body with the same ~16 KB cap as the Vercel twin (B5). */
async function readBody(request: Request): Promise<string> {
  const declared = Number(request.headers.get('content-length') || 0);
  if (Number.isFinite(declared) && declared > MAX_BODY) {
    throw new BodyTooLargeError();
  }
  const raw = await request.text();
  if (new TextEncoder().encode(raw).length > MAX_BODY) {
    throw new BodyTooLargeError();
  }
  return raw;
}

function controlStrip(s: string): string {
  return String(s ?? '')
    .replace(/[\r\n\t]/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();
}

/**
 * Trim a value to the length the published schema allows. Cut on a word
 * boundary when there is one, so a truncated name does not end mid-word.
 */
function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  const cut = value.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return (space > max * 0.6 ? cut.slice(0, space) : cut).trim();
}

function refId(): string {
  const b = new Uint8Array(6);
  crypto.getRandomValues(b);
  return 'rev_' + Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
}

/**
 * Per-client rate limits. The counter is only consumed by a REQUEST THAT
 * PASSED VALIDATION — five malformed submissions used to lock a client out
 * for an hour (audit m6).
 *
 * WHERE the count lives is the limiter's business, not the handler's
 * (site/functions/api/lib/rate-limit.ts): KV-backed when the KV_COUNTER
 * binding exists (durable across cold starts), in-memory otherwise.
 */
function rateKey(action: Action, clientKey: string): string {
  return action === 'submit' ? `submit:${clientKey}` : `action:${clientKey}`;
}

/**
 * The newest record for a project (later lines win — same rule as the
 * publisher). The filter includes the CLIENT, so a reassigned project can
 * never hand the new client the old client's quote (audit m7).
 */
function latestRecordForProject(
  projectId: string,
  clientId?: string,
): TestimonialRecord | null {
  const records = readJsonl(REVIEWS_FILE).filter(
    (r) =>
      r.type === 'review' &&
      r.projectId === projectId &&
      (clientId === undefined || r.clientId === clientId),
  );
  if (!records.length) return null;
  return records[records.length - 1] as TestimonialRecord;
}

/**
 * The record shape the client is allowed to see — no email, no internal ids.
 * `identity` is the client's own profile, used only to fill a blank field for
 * the client's own eyes (a client who withheld naming consent has no identity
 * in the store — audit M1).
 */
function clientView(
  record: TestimonialRecord,
  identity?: { name?: string; company?: string; role?: string } | null,
): Record<string, any> {
  return {
    ref: record.ref,
    state: record.state,
    source: record.source,
    verifiedClient: record.verifiedClient,
    rating: record.rating,
    review: record.review,
    name: record.name || identity?.name || '',
    company: record.company || identity?.company || '',
    role: record.role || identity?.role || '',
    consent: {
      p1: record.consent.p1,
      p2: record.consent.p2,
      p3: record.consent.p3,
      displayName: record.consent.displayName,
    },
    testimonialStatus:
      record.state === 'snoozed'
        ? 'snoozed'
        : record.state === 'declined'
          ? 'declined'
          : 'requested',
    receivedAt: record.receivedAt,
    updatedAt: record.updatedAt,
  };
}

function findProject(projectId: string): Record<string, any> | null {
  const projects = readJsonl(PROJECTS_FILE);
  return projects.find((p) => p.id === projectId) || null;
}

function clientRecord(clientId: string): Record<string, any> | null {
  const clients = readJsonl(CLIENTS_FILE);
  return clients.find((c) => c.id === clientId) || null;
}

function isEligible(project: Record<string, any>): boolean {
  return project.status === 'completed' || project.testimonialStatus === 'requested';
}

function setProjectTestimonialStatus(
  project: Record<string, any>,
  status: 'requested' | 'snoozed' | 'declined',
  actor: string,
): boolean {
  const projects = readJsonl(PROJECTS_FILE);
  const idx = projects.findIndex((p) => p.id === project.id);
  if (idx === -1) return true; // nothing to update — not a write failure
  projects[idx].testimonialStatus = status;
  projects[idx].updatedAt = new Date().toISOString();
  projects[idx].updatedBy = actor;
  return rewriteJsonl(PROJECTS_FILE, projects);
}

const handleGet: any = async (ctx: any): Promise<Response> => {
  const { request, env } = ctx;

  // No writable filesystem on the edge target — the portal store moves to a
  // real database later. Say so plainly instead of serving a half-working card.
  if (!fsModule()) {
    return json({ error: 'not implemented on CF target', code: 'unimplemented' }, 501);
  }

  // The signing secret comes from the request's env — a Worker has no
  // process.env (audit wave-6, F-2: one shared, stateless session module).
  const session = resolveSession(request.headers, 'client', env);
  if (!session) {
    return json({ error: 'authentication required', code: 'unauthorized' }, 401);
  }

  // A client session always carries the clientId that names the tenant it may
  // touch. Without it, `project.clientId !== session.clientId` passes against
  // a project that itself has no clientId — the one hole left in the
  // cross-tenant gate (review finding B3). Mirrors the Vercel twin.
  if (session.role === 'client' && !session.clientId) {
    return json({ error: 'session has no client identity', code: 'forbidden' }, 403);
  }

  const url = new URL(request.url);
  const projectId = url.searchParams.get('projectId') || '';
  if (!projectId) {
    return json({ error: 'missing projectId', code: 'validation', fields: ['projectId'] }, 400);
  }

  const project = findProject(projectId);
  if (!project) {
    return json({ error: 'project not found', code: 'not-found' }, 404);
  }
  if (session.role === 'client' && project.clientId !== session.clientId) {
    return json({ error: 'project not found', code: 'not-found' }, 404);
  }

  const record = latestRecordForProject(
    projectId,
    session.role === 'client' ? session.clientId : undefined,
  );
  if (!record) {
    return json({ ok: true, testimonial: null }, 200);
  }

  if (
    (record.state === 'snoozed' || record.state === 'declined') &&
    project.testimonialStatus === 'requested'
  ) {
    return json({ ok: true, testimonial: null }, 200);
  }

  const client = session.clientId ? clientRecord(session.clientId) : null;
  return json({ ok: true, testimonial: clientView(record, client) }, 200);
};

const handlePost: any = async (ctx: any): Promise<Response> => {
  const { request, env } = ctx;

  if (!fsModule()) {
    return json({ error: 'not implemented on CF target', code: 'unimplemented' }, 501);
  }

  // The signing secret comes from the request's env — a Worker has no
  // process.env (audit wave-6, F-2: one shared, stateless session module).
  const session = resolveSession(request.headers, 'client', env);
  if (!session) {
    return json({ error: 'authentication required', code: 'unauthorized' }, 401);
  }

  // See handleGet: a client session without a clientId is refused outright
  // (review finding B3).
  if (session.role === 'client' && !session.clientId) {
    return json({ error: 'session has no client identity', code: 'forbidden' }, 403);
  }

  if (session.role !== 'client') {
    return json({ error: 'forbidden', code: 'forbidden' }, 403);
  }

  // A production instance without SITE_BASE_URL/SITE_URL cannot verify the
  // origin — that is a missing setting, not a CSRF attempt (audit m4).
  if (!baseUrlConfigured(env)) {
    return json({ error: 'misconfigured', code: 'internal' }, 500);
  }

  const origin = request.headers.get('origin') || '';
  if (origin !== expectedOrigin(env)) {
    return json({ error: 'origin required', code: 'origin' }, 403);
  }

  let body: {
    action?: string;
    projectId?: string;
    rating?: number | string;
    review?: string;
    displayName?: string;
    consent?: { p1?: boolean; p2?: boolean; p3?: boolean };
  };
  let parsed: unknown;
  try {
    const raw = await readBody(request);
    parsed = JSON.parse(raw || '{}');
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      return json({ error: 'request too large', code: 'payload-too-large' }, 413);
    }
    return json({ error: 'invalid payload', code: 'validation' }, 400);
  }
  // A body that PARSES but is not a plain object (`null`, `[]`, a bare
  // string) used to crash the handler on `body.action` with an unhandled
  // 500 (review finding B1). Both targets now answer the same 400 shape.
  if (!isPlainObject(parsed)) {
    return json({ error: 'invalid payload', code: 'validation' }, 400);
  }
  body = parsed;

  const action = String(body.action || '') as Action;
  if (!ACTIONS.includes(action)) {
    return json({ error: 'validation failed', code: 'validation', fields: ['action'] }, 400);
  }

  const projectId = controlStrip(body.projectId || '');
  if (!projectId) {
    return json({ error: 'validation failed', code: 'validation', fields: ['projectId'] }, 400);
  }

  const project = findProject(projectId);
  if (!project) {
    return json({ error: 'project not found', code: 'not-found' }, 404);
  }
  if (session.role === 'client' && project.clientId !== session.clientId) {
    return json({ error: 'project not found', code: 'not-found' }, 404);
  }

  if (!isEligible(project)) {
    return json({ error: 'project is not finished yet', code: 'not-eligible' }, 409);
  }

  const existing = latestRecordForProject(
    projectId,
    session.role === 'client' ? session.clientId : undefined,
  );

  // Declining is final (RP-3.5): the client is not asked again unless the
  // owner re-requests it.
  if (existing?.state === 'declined' && project.testimonialStatus !== 'requested') {
    return json({ error: 'you declined to leave feedback', code: 'declined' }, 409);
  }

  const now = new Date().toISOString();
  const client = session.clientId ? clientRecord(session.clientId) : null;
  // The published name comes from the CLIENT RECORD ONLY (review finding
  // B6). With naming consent but no profile name the stored name stays
  // blank: the email local-part is not a name the client consented to
  // publish, and the schema allows an optional name.
  const clientName = clip(controlStrip(client?.name || ''), MAX_CLIENT_NAME);
  const clientCompany = clip(controlStrip(client?.company || ''), MAX_CLIENT_COMPANY);
  const clientRole = clip(controlStrip(client?.role || ''), MAX_CLIENT_ROLE);

  let state: TestimonialState;
  let quote = '';
  let rating = '';
  let consent: Consent = { p1: false, p2: false, p3: false, displayName: '' };

  if (action === 'submit') {
    const errors: string[] = [];

    quote = controlStrip(body.review || '');
    if (quote.length < 1 || quote.length > MAX_QUOTE) errors.push('review');

    if (body.rating !== undefined && body.rating !== null && body.rating !== '') {
      const n = Number(body.rating);
      if (!Number.isInteger(n) || n < 1 || n > 5) {
        errors.push('rating');
      } else {
        rating = String(n);
      }
    }

    let displayName = '';
    if (body.displayName !== undefined && body.displayName !== null) {
      displayName = controlStrip(body.displayName);
      if (displayName.length > MAX_DISPLAY_NAME) errors.push('displayName');
    }

    const rawConsent = body.consent && typeof body.consent === 'object' ? body.consent : {};
    consent = {
      p1: rawConsent.p1 === true,
      p2: rawConsent.p2 === true,
      p3: rawConsent.p3 === true,
      displayName,
    };

    if (!consent.p1) {
      return json({ error: 'consent required', code: 'consent-required' }, 400);
    }

    if (errors.length) {
      return json({ error: 'validation failed', code: 'validation', fields: errors }, 400);
    }

    // The rate limit is checked AFTER the request proved it is valid, and only
    // then is a slot consumed (audit m6).
    const key = rateKey('submit', session.clientId || session.email);
    const rateLimiter = createPortalRateLimiter(env);
    const submitDecision = await rateLimiter.consume(
      key,
      SUBMIT_RATE_LIMIT,
      SUBMIT_RATE_WINDOW_MS,
    );
    if (!submitDecision.allowed) {
      return json(
        { error: 'too many requests', code: 'rate-limit' },
        429,
        { 'Retry-After': '3600' },
      );
    }

    state = 'pending';
  } else if (action === 'snooze') {
    state = 'snoozed';
  } else {
    state = 'declined';
  }

  // Snooze and decline are limited as well (audit m6).
  if (action !== 'submit') {
    const key = rateKey(action, session.clientId || session.email);
    const rateLimiter = createPortalRateLimiter(env);
    const actionDecision = await rateLimiter.consume(
      key,
      ACTION_RATE_LIMIT,
      SUBMIT_RATE_WINDOW_MS,
    );
    if (!actionDecision.allowed) {
      return json(
        { error: 'too many requests', code: 'rate-limit' },
        429,
        { 'Retry-After': '3600' },
      );
    }
  }

  // Naming consent (p2) decides whether the identity is written at all.
  const nameAllowed = consent.p2 === true;

  const record: TestimonialRecord = {
    ref: existing?.ref || refId(),
    type: 'review',
    state,
    source: 'portal',
    verifiedClient: true,
    clientId: session.clientId || '',
    projectId,
    // Identity is written to the store ONLY with naming consent (audit M1).
    // The e-mail is never written to the store (audit M2) — the moderation
    // file is committed to git, and nothing ever read the address back.
    name: nameAllowed ? clientName : '',
    company: nameAllowed ? clientCompany : '',
    role: nameAllowed ? clientRole : '',
    rating,
    review: quote,
    consent,
    revision: (existing?.revision || 0) + 1,
    receivedAt: existing?.receivedAt || now,
    updatedAt: now,
  };

  if (action === 'decline' && existing?.state === 'approved') {
    record.revoked = true;
    record.withdrawnAt = now;
  }

  // The answer is only real once it is stored (review finding B7; same rule
  // as moderate/review.ts): a failed write answers 500 {code:'storage'},
  // never ok:true — and the owner is not notified for a quote that never
  // reached the store.
  if (!appendJsonl(REVIEWS_FILE, record)) {
    console.log(
      JSON.stringify({ ts: Date.now(), outcome: 'storage_write_failed', file: REVIEWS_FILE }),
    );
    return json({ error: 'storage unavailable', code: 'storage' }, 500);
  }
  const statusUpdated = setProjectTestimonialStatus(
    project,
    action === 'submit' ? 'requested' : action === 'snooze' ? 'snoozed' : 'declined',
    session.email,
  );
  if (!statusUpdated) {
    console.log(
      JSON.stringify({ ts: Date.now(), outcome: 'storage_write_failed', file: PROJECTS_FILE }),
    );
    return json({ error: 'storage unavailable', code: 'storage' }, 500);
  }

  console.log(
    JSON.stringify({
      ts: Date.now(),
      outcome: 'testimonial_' + action,
      projectId,
      state,
      rating: rating || undefined,
      revision: record.revision,
      verifiedClient: true,
      source: 'portal',
    }),
  );

  if (action === 'submit') {
    // The owner still moderates: the notification carries the one-click links.
    // Without this call the CF target accepted a testimonial and told nobody
    // about it — the quote sat `pending` forever (audit M6).
    //
    // The client's e-mail goes straight to the notification and is NOT written
    // to the store (audit M2); the name/company/role travel only with naming
    // consent (audit M1).
    try {
      await notifyReviewSubmitted(env, {
        ref: record.ref,
        name: nameAllowed && clientName ? clientName : 'Anonymous client',
        email: session.email,
        company: nameAllowed ? clientCompany : '',
        rating: rating || '—',
        review: quote,
        // The revision travels with the link: the one-click approve may only
        // approve the exact text the owner was shown (audit M5).
        revision: record.revision,
      });
    } catch {
      console.log(JSON.stringify({ ts: Date.now(), ref: record.ref, outcome: 'notify_fail' }));
    }
  }

  return json({ ok: true, testimonial: clientView(record, client) }, 200);
};

// A corrupt store must never look like an empty one (audit M3 / QA D3).
const storageError = (err: { file: string; line: number }): Response => {
  console.log(
    JSON.stringify({
      ts: Date.now(),
      outcome: 'storage_corrupt',
      file: err.file,
      line: err.line,
    }),
  );
  return json({ error: 'storage unavailable', code: 'storage' }, 500);
};

export const onRequestGet: any = async (ctx: any): Promise<Response> =>
  guardStorage(() => handleGet(ctx), storageError);

export const onRequestPost: any = async (ctx: any): Promise<Response> =>
  guardStorage(() => handlePost(ctx), storageError);
