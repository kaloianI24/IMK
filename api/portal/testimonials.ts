// api/portal/testimonials.ts — Vercel serverless function.
//   GET  /api/portal/testimonials?projectId=<id> — the signed-in client's own quote
//   POST /api/portal/testimonials                — submit / snooze / decline
//
// This is the ONLY door for client testimonials (spec RP-3). The public review
// form was removed and POST /api/contact refuses `type=review`, so every record
// in the moderation store now comes from a signed-in client.
//
// What the SERVER decides — never the client:
//   - verifiedClient: true  — derived from the session, never from the body (RP-3.8)
//   - source: 'portal'      — the door the quote came through
//   - name / company / role — taken from the client record, not from the request
//   - which project        — must belong to the session's client and be eligible
//
// Consent (three default-off permissions) is captured with the quote and is
// enforced AGAIN at publish time by site/scripts/publish-testimonials.mjs.
//
// Storage: site/data/moderation/reviews.jsonl — the same append-only moderation
// log the owner works with, so the existing approve/reject links keep working.
// A change of mind is appended as a new line with a stable ref: later lines
// win, which is the rule the publish script and the moderation endpoint use.

import { IncomingMessage, ServerResponse } from 'node:http';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveSession, expectedOrigin, baseUrlConfigured } from './session.js';
import { notifyReviewSubmitted } from '../lib/notifications.js';
import { readJsonlFile, guardStorage } from '../lib/jsonl.js';
import { portalRateLimiter } from '../lib/rate-limit.js';

const PORTAL_DATA_DIR = path.resolve(process.cwd(), 'site/data/portal');
const PROJECTS_FILE = path.join(PORTAL_DATA_DIR, 'projects.jsonl');
const CLIENTS_FILE = path.join(PORTAL_DATA_DIR, 'clients.jsonl');
const REVIEWS_DIR = path.resolve(process.cwd(), 'site/data/moderation');
const REVIEWS_FILE = path.join(REVIEWS_DIR, 'reviews.jsonl');

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
const SUBMIT_RATE_LIMIT = 5; // per client, per hour
// Snooze and decline are limited too: they append to the same append-only
// log, and an unbounded stream of them would grow it without limit (audit m6).
const ACTION_RATE_LIMIT = 10; // per client, per hour
const SUBMIT_RATE_WINDOW_MS = 60 * 60 * 1000;

const ACTIONS = ['submit', 'snooze', 'decline'];

type Action = (typeof ACTIONS)[number];
type TestimonialState = 'pending' | 'approved' | 'rejected' | 'snoozed' | 'declined';

interface Consent {
  p1: boolean; // publish the quote
  p2: boolean; // publish my name / company
  p3: boolean; // use it as a case study
  displayName: string; // the name to show (opt-in)
}

interface TestimonialRecord {
  ref: string;
  type: 'review';
  state: TestimonialState;
  source: 'portal';
  verifiedClient: true;
  clientId: string;
  projectId: string;
  // Identity. Written ONLY when the client gave naming consent (consent.p2).
  // A client who withheld it leaves these empty — the record never holds their
  // name, company or role (audit M1). The publisher resolves the published
  // identity from this record + consent at build time (spec RP-6.2).
  name: string;
  company: string;
  role: string;
  rating: string; // '' when the client did not rate
  review: string; // the quote
  consent: Consent;
  revision: number;
  receivedAt: string;
  updatedAt: string;
  revoked?: boolean;
  withdrawnAt?: string;
}

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
 * Read a store file. A malformed line is an ERROR (audit M3): it must not
 * turn the whole collection into an empty list, because "empty" reads as
 * "no project", "no quote", "not allowed" — a silent outage.
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

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] || 0);
    if (Number.isFinite(declared) && declared > MAX_BODY) {
      // Discard the body instead of buffering it, then answer 413.
      req.resume();
      reject(new BodyTooLargeError());
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    req.on('data', (c: Buffer) => {
      if (settled) return;
      size += c.length;
      if (size > MAX_BODY) {
        // Stop buffering; the rest of the body is drained, never stored.
        settled = true;
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

/** Strip control characters and collapse whitespace — no markup, no newlines. */
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
  return 'rev_' + crypto.randomBytes(6).toString('hex');
}

/**
 * Per-client rate limits.
 *
 * The counter is only consumed by a REQUEST THAT PASSED VALIDATION: five
 * malformed submissions used to lock a client out for an hour (audit m6).
 *
 * WHERE the count lives is the limiter's business, not the handler's
 * (api/lib/rate-limit.ts): in-memory per instance by default, durable when
 * PORTAL_RATE_LIMIT_FILE points at a writable file. The handler only asks
 * "may this request proceed?".
 */
const rateLimiter = portalRateLimiter;

/** The key a client's rate limits are counted under. */
function rateKey(action: Action, clientKey: string): string {
  return action === 'submit' ? `submit:${clientKey}` : `action:${clientKey}`;
}

/**
 * The newest record for a project (later lines win — same rule as the
 * publisher).
 *
 * The filter includes the CLIENT, not just the project: if a project is ever
 * reassigned, the new client must not inherit the old client's quote, ref and
 * revision counter (audit m7). An owner session (no clientId) sees the
 * project's newest record regardless of who wrote it.
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
 *
 * `identity` is the client's OWN profile (from the client record). It is used
 * only to fill in a blank field for the client's own eyes: a client who
 * withheld naming consent has no identity in the store (audit M1), but the
 * portal still shows them their own name.
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

/** A client may only be asked about a finished project (or one re-requested). */
function isEligible(project: Record<string, any>): boolean {
  return project.status === 'completed' || project.testimonialStatus === 'requested';
}

function setProjectTestimonialStatus(
  project: Record<string, any>,
  status: 'requested' | 'snoozed' | 'declined',
  actor: string,
): void {
  const projects = readJsonl(PROJECTS_FILE);
  const idx = projects.findIndex((p) => p.id === project.id);
  if (idx === -1) return;
  projects[idx].testimonialStatus = status;
  projects[idx].updatedAt = new Date().toISOString();
  projects[idx].updatedBy = actor;
  rewriteJsonl(PROJECTS_FILE, projects);
}

async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;
  const method = req.method || 'GET';

  if (pathname !== '/api/portal/testimonials') {
    json(res, { error: 'not found', code: 'not-found' }, 404);
    return;
  }

  const session = resolveSession(req, 'client');
  if (!session) {
    json(res, { error: 'authentication required', code: 'unauthorized' }, 401);
    return;
  }

  // A client session always carries the clientId that names the tenant it may
  // touch. Without it, `project.clientId !== session.clientId` passes against
  // a project that itself has no clientId — the one hole left in the
  // cross-tenant gate (review finding B3). Unreachable with today's sign-in
  // flow (the verify function always links a clientId); refused explicitly so
  // it stays unreachable by construction.
  if (session.role === 'client' && !session.clientId) {
    json(res, { error: 'session has no client identity', code: 'forbidden' }, 403);
    return;
  }

  // ---------------------------------------------------------------- GET ----
  if (method === 'GET') {
    const projectId = url.searchParams.get('projectId') || '';
    if (!projectId) {
      json(res, { error: 'missing projectId', code: 'validation', fields: ['projectId'] }, 400);
      return;
    }

    const project = findProject(projectId);
    // A project that does not exist and a project that belongs to somebody else
    // look identical from the outside — no project-id probing (RP-3.6).
    if (!project) {
      json(res, { error: 'project not found', code: 'not-found' }, 404);
      return;
    }
    if (session.role === 'client' && project.clientId !== session.clientId) {
      json(res, { error: 'project not found', code: 'not-found' }, 404);
      return;
    }

    const record = latestRecordForProject(
      projectId,
      session.role === 'client' ? session.clientId : undefined,
    );
    if (!record) {
      json(res, { ok: true, testimonial: null }, 200);
      return;
    }

    // The owner re-opened a request the client had snoozed or declined: the
    // client gets the form again, not the old answer.
    if (
      (record.state === 'snoozed' || record.state === 'declined') &&
      project.testimonialStatus === 'requested'
    ) {
      json(res, { ok: true, testimonial: null }, 200);
      return;
    }

    const client = session.clientId ? clientRecord(session.clientId) : null;
    json(res, { ok: true, testimonial: clientView(record, client) }, 200);
    return;
  }

  // --------------------------------------------------------------- POST ----
  if (method === 'POST') {
    // Only a client writes a testimonial — the owner moderates, never submits.
    if (session.role !== 'client') {
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
      const raw = await readBody(req);
      parsed = JSON.parse(raw || '{}');
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        json(res, { error: 'request too large', code: 'payload-too-large' }, 413);
        return;
      }
      json(res, { error: 'invalid payload', code: 'validation' }, 400);
      return;
    }
    // A body that PARSES but is not a plain object (`null`, `[]`, a bare
    // string) used to crash the handler on `body.action` with an unhandled
    // 500 (review finding B1). Both targets now answer the same 400 shape.
    if (!isPlainObject(parsed)) {
      json(res, { error: 'invalid payload', code: 'validation' }, 400);
      return;
    }
    body = parsed;

    const action = String(body.action || '') as Action;
    if (!ACTIONS.includes(action)) {
      json(res, { error: 'validation failed', code: 'validation', fields: ['action'] }, 400);
      return;
    }

    const projectId = controlStrip(body.projectId || '');
    if (!projectId) {
      json(res, { error: 'validation failed', code: 'validation', fields: ['projectId'] }, 400);
      return;
    }

    const project = findProject(projectId);
    if (!project) {
      json(res, { error: 'project not found', code: 'not-found' }, 404);
      return;
    }
    if (session.role === 'client' && project.clientId !== session.clientId) {
      json(res, { error: 'project not found', code: 'not-found' }, 404);
      return;
    }

    if (!isEligible(project)) {
      json(res, { error: 'project is not finished yet', code: 'not-eligible' }, 409);
      return;
    }

    const existing = latestRecordForProject(
      projectId,
      session.role === 'client' ? session.clientId : undefined,
    );

    // Declining is final (RP-3.5): the client is not asked again unless the
    // owner re-requests it. The card hides itself after a decline, but the
    // rule belongs on the server too — otherwise the endpoint would accept a
    // quote the client already refused.
    if (existing?.state === 'declined' && project.testimonialStatus !== 'requested') {
      json(res, { error: 'you declined to leave feedback', code: 'declined' }, 409);
      return;
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
        if (displayName.length > MAX_DISPLAY_NAME) {
          errors.push('displayName');
        }
      }

      const rawConsent = body.consent && typeof body.consent === 'object' ? body.consent : {};
      consent = {
        p1: rawConsent.p1 === true,
        p2: rawConsent.p2 === true,
        p3: rawConsent.p3 === true,
        displayName,
      };

      if (!consent.p1) {
        // No consent to publish the quote — nothing is stored, nothing is sent.
        json(res, { error: 'consent required', code: 'consent-required' }, 400);
        return;
      }

      if (errors.length) {
        json(res, { error: 'validation failed', code: 'validation', fields: errors }, 400);
        return;
      }

      // The rate limit is checked AFTER the request has proved it is a valid
      // submission, and only then is a slot consumed (audit m6).
      const key = rateKey('submit', session.clientId || session.email);
      const submitDecision = await rateLimiter.consume(
        key,
        SUBMIT_RATE_LIMIT,
        SUBMIT_RATE_WINDOW_MS,
      );
      if (!submitDecision.allowed) {
        json(res, { error: 'too many requests', code: 'rate-limit' }, 429, { 'Retry-After': '3600' });
        return;
      }

      state = 'pending';
    } else if (action === 'snooze') {
      state = 'snoozed';
    } else {
      state = 'declined';
    }

    // Snooze and decline are limited as well: they append to the same
    // append-only moderation log (audit m6).
    if (action !== 'submit') {
      const key = rateKey(action, session.clientId || session.email);
      const actionDecision = await rateLimiter.consume(
        key,
        ACTION_RATE_LIMIT,
        SUBMIT_RATE_WINDOW_MS,
      );
      if (!actionDecision.allowed) {
        json(res, { error: 'too many requests', code: 'rate-limit' }, 429, { 'Retry-After': '3600' });
        return;
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
      // A client who withheld it has no name, no company and no role in the
      // record — the moderation file is committed to git, so it is not the
      // place to keep the identity of someone who asked not to be named.
      // The publisher resolves the published identity from this record and the
      // consent state at build time (spec RP-6.2).
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

    // A client who changes their mind after the quote was published withdraws
    // it: the published file disappears on the next build (RP-6.4 / RP-6.5).
    if (action === 'decline' && existing?.state === 'approved') {
      record.revoked = true;
      record.withdrawnAt = now;
    }

    appendJsonl(REVIEWS_FILE, record);
    setProjectTestimonialStatus(
      project,
      action === 'submit' ? 'requested' : action === 'snooze' ? 'snoozed' : 'declined',
      session.email,
    );

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
      //
      // The client's e-mail is passed straight to the notification and is NOT
      // written to the store (audit M2) — nothing ever read it back, and the
      // store is a file a `git add .` would commit. The owner still needs to
      // know WHICH client submitted, so the address travels with the
      // notification (the owner's own channel) while the name/company/role
      // travel only with naming consent (audit M1).
      try {
        await notifyReviewSubmitted({
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

    json(res, { ok: true, testimonial: clientView(record, client) }, 200);
    return;
  }

  json(res, { error: 'method not allowed', code: 'method' }, 405, { Allow: 'GET, POST' });
}

// A store that cannot be parsed must never look like an EMPTY store
// (audit M3 / QA D3): "the collection is empty" reads as "no quote", "no
// project", "not allowed" — a silent outage. Answer 500 {code:'storage'} and
// let the operator see the file and line in the log.
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
