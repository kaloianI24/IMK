// api/contact.ts — Vercel serverless function (Node runtime), POST /api/contact
//
// Mirrors site/functions/api/contact.ts (Cloudflare Pages Function) so both
// targets run the same abuse pipeline:
//   Turnstile verify → field validation → honeypot → time trap → per-IP rate
//   limit → Resend e-mail → redacted logging → JSON response.
//
// Review submissions (`type=review`) are REFUSED with 410 'review-moved'.
// Testimonials are only collected from signed-in clients, in the portal
// (POST /api/portal/testimonials). The public review form was removed, and
// the endpoint is closed too — hiding a form is not the same as closing the
// door, and an open endpoint lets anyone write into the moderation queue.
//
// Environment (Vercel project settings or .env in local dev):
//   TURNSTILE_SECRET_KEY  — when set, Turnstile challenge is required (unset locally degrades gracefully)
//   TURNSTILE_SITE_KEY    — parity only; the client reads PUBLIC_TURNSTILE_SITE_KEY
//   RESEND_API_KEY        — when set + a destination exists, submission is e-mailed
//   RESEND_FROM / RESEND_TO / CONTACT_TO  — e-mail envelope (CONTACT_TO is the fallback destination)
//   APP_ENV               — 'production' turns on strict guards
//   DEV_STUB              — must never be '1' in production (500 if it is)
//
// Rate limiting: Cloudflare Pages KV_COUNTER binding is not available here, so
// a documented per-instance in-memory fallback is used (fine at launch scale;
// revisit if spam volume grows).

import { IncomingMessage, ServerResponse } from 'node:http';

type Kind = 'contact' | 'review';

interface ContactReq {
  name: string;
  email: string;
  company?: string;
  project: string;
  budget: string;
  timeline: string;
  website?: string;
  ts?: number;
  turnstileToken?: string;
  type?: Kind;
  linkedin?: string;
}

const BUDGETS = ['under-1k', '1k-5k', '5k-15k', '15k+', 'not-sure'];
const TIMELINES = ['asap', '1-month', '3-months', 'exploring'];
const MAX = {
  name: 80,
  email: 254,
  company: 120,
  project: 500,
  body: 8192,
  recent: 3000,
  stale: 4 * 60 * 60 * 1000,
  skew: 60000,
};

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
 * Plain-text response. The Content-Length is computed from the exact bytes we
 * are about to send — never hand-written. A mismatch here (declaring 42 while
 * sending 40) truncates the response and makes every fetch() client die with
 * `TypeError: terminated` instead of reading the error body.
 */
function text(
  res: ServerResponse,
  body: string,
  status = 200,
  extra: Record<string, string> = {},
): void {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...extra,
  });
  res.end(body);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function controlStrip(s: string): string {
  return s.replace(/[\r\n\t]/g, ' ').trim();
}

function isValidEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && !/[\r\n]/.test(s);
}

function refId(): string {
  const b = new Uint8Array(4);
  crypto.getRandomValues(b);
  return 'inq_' + Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
}

async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((x) => x.toString(16).padStart(2, '0')).join('');
}

function ipHash(ip: string, pepper: string, day: string): Promise<string> {
  return sha256(pepper + ':' + ip + ':' + day);
}

async function turnstileVerify(secret: string, token: string, ip: string | null): Promise<boolean> {
  const form = new FormData();
  form.append('secret', secret);
  form.append('response', token);
  if (ip) form.append('remoteip', ip);
  const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    body: form,
  });
  if (!r.ok) return false;
  const j: any = await r.json().catch(() => ({}));
  return j && j.success === true;
}

// Per-instance in-memory rate limit fallback (Vercel has no KV binding).
// Key: hashed IP + hour. Limit: 5 submissions per hour per IP.
// On Cloudflare Pages, env.KV_COUNTER is used instead (see site/functions/api/contact.ts).
const rateLimitMap = new Map<string, { count: number; reset: number }>();
async function rateLimit(ip: string, hour: string): Promise<boolean> {
  const LIMIT = 5;
  const keyHash = await sha256(ip + ':' + hour);
  const key = `ip:${keyHash}:${hour}`;
  const now = Date.now();
  const entry = rateLimitMap.get(key);
  if (entry && now < entry.reset) {
    if (entry.count >= LIMIT) return false;
    entry.count += 1;
    return true;
  }
  rateLimitMap.set(key, { count: 1, reset: now + 3600 * 1000 });
  return true;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers || {})) {
    headers[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v ?? '');
  }

  if (req.method !== 'POST') {
    json(res, { error: 'method not allowed', code: 'method' }, 405, { Allow: 'POST' });
    return;
  }

  const isProd = (process.env.APP_ENV || 'production') === 'production';
  if (isProd && process.env.DEV_STUB === '1') {
    json(res, { error: 'misconfigured', code: 'internal' }, 500);
    return;
  }

  const wantsJson = (headers['content-type'] || '').includes('application/json');

  // 1. body size
  const len = parseInt(headers['content-length'] || '0', 10);
  if (len && len > MAX.body) {
    return wantsJson
      ? json(res, { error: 'request too large', code: 'payload-too-large' }, 413)
      : (() => {
          text(res, 'Request too large', 413);
        })();
  }
  const raw = await readBody(req);
  if (raw.length > MAX.body) {
    return wantsJson
      ? json(res, { error: 'request too large', code: 'payload-too-large' }, 413)
      : (() => {
          text(res, 'Request too large', 413);
        })();
  }

  // 2. parse
  let input: ContactReq = {
    name: '',
    email: '',
    project: '',
    budget: null as any,
    timeline: null as any,
    type: 'contact',
  };
  let isUrlencoded = false;
  const ct = headers['content-type'] || '';
  try {
    if (ct.includes('application/json')) {
      input = { ...input, ...JSON.parse(raw || '{}') };
    } else if (ct.includes('application/x-www-form-urlencoded') || ct.includes('multipart')) {
      isUrlencoded = true;
      const params = new URLSearchParams(raw);
      input = {
        ...input,
        name: params.get('name') || '',
        email: params.get('email') || '',
        company: params.get('company') || '',
        linkedin: params.get('linkedin') || '',
        project: params.get('project') || '',
        budget: params.get('budget') as any,
        timeline: params.get('timeline') as any,
        type: (params.get('type') || 'contact') as Kind,
        website: params.get('website') || '',
        ts: params.get('ts') ? Number(params.get('ts')) : undefined,
        turnstileToken: params.get('turnstileToken') || params.get('cf-turnstile-response') || undefined,
      };
    } else {
      return wantsJson
        ? json(res, { error: 'unsupported content type', code: 'validation' }, 400)
        : (() => {
            text(res, 'Bad request', 400);
          })();
    }
  } catch {
    return wantsJson
      ? json(res, { error: 'invalid payload', code: 'validation' }, 400)
      : (() => {
          text(res, 'Bad request', 400);
        })();
  }

  // 2b. review submissions are closed here — they belong in the portal.
  // Answered before Turnstile, before the rate limit and before any write:
  // nothing is stored, nothing is mailed, nothing is logged as accepted.
  // The comparison is case- and whitespace-insensitive: 'Review' / ' review'
  // used to fall through into the contact pipeline as a normal inquiry
  // (review finding B4), bypassing the refusal.
  if (String(input.type ?? '').trim().toLowerCase() === 'review') {
    console.log(
      JSON.stringify({ ts: Date.now(), outcome: 'review_refused', code: 'review-moved' }),
    );
    return wantsJson
      ? json(
          res,
          {
            error: 'review submissions are not accepted here',
            code: 'review-moved',
            where: '/api/portal/testimonials',
          },
          410,
        )
      : (() => {
          text(res, 'Review submissions are not accepted here', 410);
        })();
  }

  // 3. Turnstile (only when the secret is configured — unset locally degrades gracefully)
  const ip = (headers['cf-connecting-ip'] || headers['x-forwarded-for'] || null) as string | null;
  if (process.env.TURNSTILE_SECRET_KEY && process.env.DEV_STUB !== '1') {
    const token = (input as any).turnstileToken || (input as any).cfTurnstileResponse || (input as any)['cf-turnstile-response'];
    if (!token || typeof token !== 'string') {
      return wantsJson
        ? json(res, { error: 'challenge required', code: 'challenge' }, 403)
        : (() => {
            text(res, 'Challenge required', 403);
          })();
    }
    const ok = await turnstileVerify(process.env.TURNSTILE_SECRET_KEY, token, ip);
    if (!ok) {
      return wantsJson
        ? json(res, { error: 'challenge failed', code: 'challenge' }, 403)
        : (() => {
            text(res, 'Challenge failed', 403);
          })();
    }
  } else if (process.env.TURNSTILE_SECRET_KEY === undefined) {
    console.log(JSON.stringify({ ts: Date.now(), ref: refId(), outcome: 'turnstile_skipped', reason: 'secret-not-configured' }));
  }

  // 4. validation
  const errors: string[] = [];

  if (!input.name || typeof input.name !== 'string' || input.name.length < 1 || input.name.length > MAX.name) errors.push('name');
  if (!input.email || typeof input.email !== 'string' || input.email.length < 1 || input.email.length > MAX.email || !isValidEmail(input.email)) errors.push('email');
  if (input.company && (typeof input.company !== 'string' || input.company.length > MAX.company)) errors.push('company');
  if (!input.project || typeof input.project !== 'string' || input.project.length < 1 || input.project.length > MAX.project) errors.push('project');
  if (!BUDGETS.includes(input.budget)) errors.push('budget');
  if (!TIMELINES.includes(input.timeline)) errors.push('timeline');

  if (errors.length) {
    return wantsJson
      ? json(res, { error: 'validation failed', code: 'validation', fields: errors }, 400)
      : (() => {
          text(res, 'Validation failed: ' + errors.join(', '), 400);
        })();
  }

  // 5. honeypot (silent accept)
  if ((input as any).website && String((input as any).website).trim() !== '') {
    const ref = refId();
    console.log(JSON.stringify({ ts: Date.now(), ref, outcome: 'honeypot', ipHash: ip ? 'hashed' : 'no-ip' }));
    return wantsJson ? json(res, { ok: true, ref }, 200) : (() => {
      res.writeHead(303, { Location: '/thank-you', 'Content-Length': '0' });
      res.end();
    })();
  }

  // 6. time-trap
  const ts = typeof input.ts === 'number' ? input.ts : (input.ts ? Number(input.ts) : 0);
  const now = Date.now();
  if (!ts || (now - ts) < MAX.recent || (now - ts) > MAX.stale || ts - now > MAX.skew) {
    return wantsJson
      ? json(res, { error: 'submission too fast', code: 'time-trap' }, 400)
      : (() => {
          text(res, 'Submission too fast, please retry.', 400);
        })();
  }

  // 7. rate limit
  const hour = new Date(now).toISOString().slice(0, 13);
  const allowed = await rateLimit(ip || 'unknown', hour);
  if (!allowed) {
    return wantsJson
      ? json(res, { error: 'too many requests', code: 'rate-limit' }, 429, { 'Retry-After': '3600' })
      : (() => {
          text(res, 'Too many requests', 429, { 'Retry-After': '3600' });
        })();
  }

  // 8. normalize
  const name = controlStrip((input as any).name || '');
  const email = controlStrip((input as any).email || '');
  const company = (input as any).company ? controlStrip((input as any).company) : '';
  const project = (input as any).project ? String((input as any).project).trim() : '';
  const ref = refId();
  const day = new Date(now).toISOString().slice(0, 10);

  // 9. Resend e-mail
  const from = process.env.RESEND_FROM || 'IMK <2imk4support@gmail.com>';
  const to = process.env.RESEND_TO || process.env.CONTACT_TO || '';
  const subject = 'New IMK inquiry';
  const ipHashVal = ip ? await ipHash(ip, process.env.LOG_PEPPER || 'dev', day) : 'no-ip';
  const htmlBody = `<h2>New inquiry (${ref})</h2>
<p><b>Name:</b> ${escapeHtml(name)}</p>
<p><b>Email:</b> ${escapeHtml(email)}</p>
<p><b>Company:</b> ${escapeHtml(company || '—')}</p>
<p><b>Budget:</b> ${escapeHtml(input.budget)}</p>
<p><b>Timeline:</b> ${escapeHtml(input.timeline)}</p>
<p><b>Project:</b></p><p>${escapeHtml(project).replace(/\n/g, '<br>')}</p>
<hr><p style="color:#888;font-size:12px;">ref ${ref} · ${new Date(now).toISOString()} · ip ${escapeHtml(ipHashVal)} · env ${escapeHtml(process.env.APP_ENV || 'production')}</p>`;
  const textBody = `New inquiry (${ref})\n\nName: ${name}\nEmail: ${email}\nCompany: ${company || '—'}\nBudget: ${input.budget}\nTimeline: ${input.timeline}\nProject: ${project}\n\nref ${ref} env ${process.env.APP_ENV || 'production'}`;

  if (process.env.RESEND_API_KEY && to) {
    try {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to: [to], subject, html: htmlBody, text: textBody, reply_to: email || undefined }),
      });
      if (!r.ok) {
        console.log(JSON.stringify({ ts: now, ref, outcome: 'email_fail', ipHash: ipHashVal }));
      }
    } catch {
      console.log(JSON.stringify({ ts: now, ref, outcome: 'email_error', ipHash: ipHashVal }));
    }
  }

  // 9b. webhook (optional) — signed, with retries. Mirrors the CF twin
  // (site/functions/api/contact.ts §9): the same payload, the same
  // `X-Signature = sha256=HMAC(FORM_WEBHOOK_SECRET, payload)` and the same
  // 0s/2s/8s retry ladder, so an inquiry reaches the webhook identically on
  // both targets (review finding B8). Runs only when FORM_WEBHOOK_URL is
  // configured; the retries add latency only when the webhook is DOWN.
  if (process.env.FORM_WEBHOOK_URL) {
    const payload = JSON.stringify({
      ref, name, email, company, project, budget: input.budget, timeline: input.timeline, submittedAt: new Date(now).toISOString(), ipHash: ipHashVal,
    });
    const webhookHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
    if (process.env.FORM_WEBHOOK_SECRET) {
      const sigBuf = await crypto.subtle.sign('HMAC', await crypto.subtle.importKey('raw', new TextEncoder().encode(process.env.FORM_WEBHOOK_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']), new TextEncoder().encode(payload));
      const sig = Array.from(new Uint8Array(sigBuf)).map(x=>x.toString(16).padStart(2,'0')).join('');
      webhookHeaders['X-Signature'] = `sha256=${sig}`;
    }
    const attempts = [0, 2000, 8000];
    let ok = false;
    for (const wait of attempts) {
      if (wait) await delay(wait);
      try {
        const r = await fetch(process.env.FORM_WEBHOOK_URL, { method: 'POST', headers: webhookHeaders, body: payload });
        if (r.ok) { ok = true; break; }
      } catch {}
    }
    if (!ok) console.log(JSON.stringify({ ts: now, ref, outcome: 'webhook_fail', ipHash: ipHashVal }));
  }

  // 10. redacted log (no bodies)
  console.log(
    JSON.stringify({
      ts: now,
      ref,
      outcome: 'accepted',
      ipHash: ipHashVal,
      type: 'contact',
      hasCompany: !!company,
    }),
  );

  // response
  if (isUrlencoded) {
    res.writeHead(303, { Location: '/thank-you', 'Content-Length': '0' });
    res.end();
    return;
  }
  json(res, { ok: true, ref }, 200);
}
