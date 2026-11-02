import { isProductionEnv } from '../shared/server/portal-session.js';
import { parseMultipart, sniffMime, ALLOWED_MIMES, toBase64 } from '../shared/server/multipart.js';

interface Env {
  TURNSTILE_SECRET_KEY?: string;
  TURNSTILE_SITE_KEY?: string; // not used server-side; present for parity
  RESEND_API_KEY?: string;
  RESEND_FROM?: string;
  RESEND_TO?: string;
  CONTACT_TO?: string; // fallback destination, same as the Vercel tree (B8)
  FORM_WEBHOOK_URL?: string;
  FORM_WEBHOOK_SECRET?: string;
  LOG_PEPPER?: string;
  APP_ENV?: string; // unset = production; 'development' only off-deployment
  DEV_STUB?: string; // must never be '1' in production
  KV_COUNTER?: any;
}
type Budget = 'under-1k'|'1k-5k'|'5k-15k'|'15k+'|'not-sure';
type Timeline = 'asap'|'1-month'|'3-months'|'exploring';
interface ContactReq {
  name: string; email: string; company?: string;
  project: string; subject?: string; budget: Budget; timeline: Timeline;
  website?: string; ts?: number;
  turnstileToken?: string;
  type?: string;
  linkedin?: string;
}
const BUDGETS = ['under-1k','1k-5k','5k-15k','15k+','not-sure'];
const TIMELINES = ['asap','1-month','3-months','exploring'];
const MAX = { name:80, email:254, company:120, project:500, body:4194304, recent:3000, stale:4*60*60*1000, skew:60000 };

function json(body: any, status = 200, extra: Record<string,string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...extra },
  });
}
function escapeHtml(s: string) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function controlStrip(s: string) { return s.replace(/[\r\n\t]/g, ' ').trim(); }
function isValidEmail(s: string) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && !/[\r\n]/.test(s); }
function refId() {
  const b = new Uint8Array(4); crypto.getRandomValues(b);
  return 'inq_' + Array.from(b).map(x=>x.toString(16).padStart(2,'0')).join('');
}
async function sha256(s: string) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map(x=>x.toString(16).padStart(2,'0')).join('');
}
function ipHash(ip: string, pepper: string, day: string) { return sha256(pepper + ':' + ip + ':' + day); }
async function turnstileVerify(secret: string, token: string, ip: string | null) {
  const form = new FormData();
  form.append('secret', secret);
  form.append('response', token);
  if (ip) form.append('remoteip', ip);
  const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
  if (!r.ok) return false;
  const j: any = await r.json().catch(() => ({}));
  return j && j.success === true;
}
async function rateLimit(env: Env, ip: string, hour: string): Promise<boolean> {
  const keyHash = await sha256(ip + ':' + hour);
  const key = `ip:${keyHash}:${hour}`;
  const LIMIT = 5;
  if (env.KV_COUNTER) {
    const cur = await env.KV_COUNTER.get(key);
    const n = (cur ? parseInt(cur,10) : 0) + 1;
    if (n > LIMIT) return false;
    await env.KV_COUNTER.put(key, String(n), { expirationTtl: 3600 });
    return true;
  }
  // in-memory fallback
  const g = (globalThis as any).__rl || ((globalThis as any).__rl = new Map());
  const prev = g.get(key) || 0;
  if (prev >= LIMIT) return false;
  g.set(key, prev + 1);
  return true;
}
const delay = (ms:number)=>new Promise(r=>setTimeout(r,ms));

export const config = {
  runtime: 'edge',
};

export default async function handler(request: Request) {
  return onRequestPost({ request, env: process.env }, {});
}

export const onRequestPost: any = async (ctx: any) => {
  const { request, env } = ctx;
  // DEV_STUB guard: never in production.
  //
  // H-2 (wave-8A): the production test used to be
  // `(env.APP_ENV || 'production') === 'production'`, so `APP_ENV=development`
  // alone switched every guard off — including this one. The shared rule is
  // used instead: a deployment is PRODUCTION when APP_ENV is unset or
  // unknown, or NODE_ENV=production, or VERCEL=1, or the base URL is https://.
  const isProd = isProductionEnv(env as any);
  if (isProd && env.DEV_STUB === '1') {
    return json({ error: 'misconfigured', code: 'internal' }, 500);
  }
  const ct = request.headers.get('content-type') || '';
  const wantsJson = ct.includes('application/json') || ct.includes('multipart');

  let files: { filename: string; contentType: string; data: Uint8Array }[] = [];

  // 1. body size
  const len = parseInt(request.headers.get('content-length') || '0', 10);
  if (len && len > MAX.body) {
    return wantsJson ? json({ error: 'request too large', code: 'payload-too-large' }, 413) : new Response('Request too large', { status: 413 });
  }
  const buf = await request.arrayBuffer();
  const rawBytes = new Uint8Array(buf);
  if (rawBytes.length > MAX.body) {
    return wantsJson ? json({ error: 'request too large', code: 'payload-too-large' }, 413) : new Response('Request too large', { status: 413 });
  }
  if (len && len !== rawBytes.length) {
    return wantsJson ? json({ error: 'invalid payload', code: 'validation' }, 400) : new Response('Bad request', { status: 400 });
  }

  // parse
  let input: ContactReq = { name:'', email:'', project:'', budget: null as any, timeline: null as any };
  let isUrlencoded = false;
  const raw = new TextDecoder('utf-8').decode(rawBytes);
  try {
    if (ct.includes('application/json')) {
      input = { ...input, ...JSON.parse(raw || '{}') };
    } else if (ct.includes('application/x-www-form-urlencoded')) {
      isUrlencoded = true;
      const params = new URLSearchParams(raw);
      input = {
        name: params.get('name') || '',
        email: params.get('email') || '',
        company: params.get('company') || '',
        linkedin: params.get('linkedin') || '',
        subject: params.get('subject') || '',
        project: params.get('project') || '',
        budget: params.get('budget') as any,
        timeline: params.get('timeline') as any,
        website: params.get('website') || '',
        ts: params.get('ts') ? Number(params.get('ts')) : undefined,
        type: params.get('type') || 'contact',
        turnstileToken: params.get('turnstileToken') || params.get('cf-turnstile-response') || undefined,
      };
    } else if (ct.includes('multipart')) {
      const parsed = parseMultipart(rawBytes, ct);
      if (parsed.ok === false) {
        const code = parsed.code;
        const status = code === 'payload-too-large' ? 413 : 400;
        return wantsJson ? json({ error: 'invalid payload', code }, status) : new Response('Bad request', { status });
      }
      const params = parsed.fields;
      input = {
        name: params['name'] || '',
        email: params['email'] || '',
        company: params['company'] || '',
        linkedin: params['linkedin'] || '',
        subject: params['subject'] || '',
        project: params['project'] || '',
        budget: (params['budget'] || '') as any,
        timeline: (params['timeline'] || '') as any,
        website: params['website'] || '',
        ts: params['ts'] ? Number(params['ts']) : undefined,
        type: params['type'] || 'contact',
      };
      if (!input.turnstileToken && params['turnstileToken']) input.turnstileToken = params['turnstileToken'];
      if (!input.turnstileToken && params['cf-turnstile-response']) input.turnstileToken = params['cf-turnstile-response'];
      files = parsed.files.map((f) => ({ filename: f.filename, contentType: f.contentType, data: f.data }));
      if (files.length > 3) {
        return wantsJson ? json({ error: 'too many files', code: 'too-many-files' }, 413) : new Response('Too many files', { status: 413 });
      }
      for (const f of files) {
        const sniffed = sniffMime(f.data);
        const declared = f.contentType.toLowerCase();
        if (!sniffed || !ALLOWED_MIMES.has(sniffed) || sniffed !== declared) {
          return wantsJson ? json({ error: 'unsupported file type', code: 'unsupported-file' }, 415) : new Response('Unsupported file', { status: 415 });
        }
      }
    } else {
      return wantsJson ? json({ error: 'unsupported content type', code: 'validation' }, 400) : new Response('Bad request', { status: 400 });
    }
  } catch {
    return wantsJson ? json({ error: 'invalid payload', code: 'validation' }, 400) : new Response('Bad request', { status: 400 });
  }

  // Review submissions are closed here — they belong in the portal
  // (POST /api/portal/testimonials). Mirrors api/contact.ts (Vercel): the
  // public review form was removed and the endpoint is closed too.
  // The comparison is case- and whitespace-insensitive: 'Review' / ' review'
  // used to fall through into the contact pipeline as a normal inquiry
  // (review finding B4), bypassing the refusal.
  if (String(input.type ?? '').trim().toLowerCase() === 'review') {
    console.log(JSON.stringify({ ts: Date.now(), outcome: 'review_refused', code: 'review-moved' }));
    return wantsJson
      ? json({ error: 'review submissions are not accepted here', code: 'review-moved', where: '/api/portal/testimonials' }, 410)
      : new Response('Review submissions are not accepted here', { status: 410 });
  }

  // 3. Turnstile (only if secret configured)
  const ip = request.headers.get('CF-Connecting-IP') || request.headers.get('x-forwarded-for') || null;
  if (env.TURNSTILE_SECRET_KEY && !(env.DEV_STUB === '1')) {
    const token = (input as any).turnstileToken || (input as any).cfTurnstileResponse || (input as any)['cf-turnstile-response'];
    if (!token || typeof token !== 'string') {
      return wantsJson ? json({ error: 'challenge required', code: 'challenge' }, 403) : new Response('Challenge required', { status: 403 });
    }
    const ok = await turnstileVerify(env.TURNSTILE_SECRET_KEY, token, ip);
    if (!ok) {
      return wantsJson ? json({ error: 'challenge failed', code: 'challenge' }, 403) : new Response('Challenge failed', { status: 403 });
    }
  }

  // 4. validation
  const errors: string[] = [];
  if (!input.name || typeof input.name !== 'string' || input.name.length < 1 || input.name.length > MAX.name) errors.push('name');
  if (!input.email || typeof input.email !== 'string' || input.email.length > MAX.email || !isValidEmail(input.email)) errors.push('email');
  if (input.company && (typeof input.company !== 'string' || input.company.length > MAX.company)) errors.push('company');
  if (!input.project || typeof input.project !== 'string' || input.project.length < 1 || input.project.length > MAX.project) errors.push('project');
  if (input.subject && (typeof input.subject !== 'string' || input.subject.length > 120)) errors.push('subject');
  if (!BUDGETS.includes(input.budget)) errors.push('budget');
  if (!TIMELINES.includes(input.timeline)) errors.push('timeline');
  if (errors.length) {
    return wantsJson ? json({ error: 'validation failed', code: 'validation', fields: errors }, 400) : new Response('Validation failed: ' + errors.join(', '), { status: 400 });
  }

  // 5. honeypot
  if (input.website && input.website.trim() !== '') {
    // silent 200
    const ref = refId();
    return wantsJson ? json({ ok: true, ref }, 200) : new Response(null, { status: 303, headers: { 'Location': '/thank-you' } });
  }

  // 6. time-trap
  const ts = typeof input.ts === 'number' ? input.ts : (input.ts ? Number(input.ts) : 0);
  const now = Date.now();
  if (!ts || (now - ts) < MAX.recent || (now - ts) > MAX.stale || ts - now > MAX.skew) {
    return wantsJson ? json({ error: 'submission too fast', code: 'time-trap' }, 400) : new Response('Submission too fast, please retry.', { status: 400 });
  }

  // 7. rate limit
  const hour = new Date(now).toISOString().slice(0,13);
  const allowed = await rateLimit(env, (ip || 'unknown'), hour);
  if (!allowed) {
    return wantsJson ? json({ error: 'too many requests', code: 'rate-limit' }, 429, { 'Retry-After': '3600' }) : new Response('Too many requests', { status: 429, headers: { 'Retry-After': '3600' } });
  }

  // normalize
  const name = controlStrip(input.name);
  const email = controlStrip(input.email);
  const company = input.company ? controlStrip(input.company) : '';
  const project = input.project.trim();
  const ref = refId();
  const day = new Date(now).toISOString().slice(0,10);

  // 8. Resend email
  const from = env.RESEND_FROM || 'IMK <onboarding@resend.dev>';
  const to = env.RESEND_TO || env.CONTACT_TO || '';
  const rawSubject = input.subject ? String(input.subject) : '';
  const cleanSubject = rawSubject.replace(/[\r\n\t\x00-\x1f\x7f]/g, ' ').trim().slice(0, 120);
  const subject = ('IMK enquiry - ' + (cleanSubject || 'New message')).slice(0, 150);
  const ipHashVal = ip ? await ipHash(ip, env.LOG_PEPPER || 'dev', day) : 'no-ip';
  const attachmentNames = files.map((f) => f.filename).join(', ');
  const htmlBody = `<h2>New inquiry (${ref})</h2>
<p><b>Name:</b> ${escapeHtml(name)}</p>
<p><b>Email:</b> ${escapeHtml(email)}</p>
<p><b>Company:</b> ${escapeHtml(company || '—')}</p>
<p><b>Subject:</b> ${escapeHtml(cleanSubject || 'New message')}</p>
<p><b>Budget:</b> ${escapeHtml(input.budget)}</p>
<p><b>Timeline:</b> ${escapeHtml(input.timeline)}</p>
<p><b>Project:</b></p><p>${escapeHtml(project).replace(/\n/g,'<br>')}</p>
${attachmentNames ? `<p><b>Attachments:</b> ${escapeHtml(attachmentNames)}</p>` : ''}
<hr><p style="color:#888;font-size:12px;">ref ${ref} · ${new Date(now).toISOString()} · ip ${escapeHtml(ipHashVal)} · env ${escapeHtml(env.APP_ENV || 'production')}</p>`;
  const textBody = `New inquiry (${ref})\n\nName: ${name}\nEmail: ${email}\nCompany: ${company || '—'}\nSubject: ${cleanSubject || 'New message'}\nBudget: ${input.budget}\nTimeline: ${input.timeline}\nProject: ${project}\n${attachmentNames ? 'Attachments: ' + attachmentNames + '\n' : ''}\nref ${ref} env ${env.APP_ENV || 'production'}`;

  const attachments = files.map((f) => ({ filename: f.filename, content: toBase64(f.data) }));
  let encodedSize = 0;
  for (const a of attachments) encodedSize += a.content.length;
  if (encodedSize > 5872025) {
    return wantsJson ? json({ error: 'request too large', code: 'payload-too-large' }, 413) : new Response('Request too large', { status: 413 });
  }

  let emailed = false;
  if (env.RESEND_API_KEY && to) {
    try {
      const resendBody: any = { from, to: [to], subject, html: htmlBody, text: textBody, reply_to: email };
      if (attachments.length) resendBody.attachments = attachments;
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(resendBody),
      });
      if (r.ok) {
        emailed = true;
      } else {
        console.log(JSON.stringify({ ts: now, ref, outcome: 'email_fail', ipHash: ipHashVal }));
      }
    } catch (e) {
      console.log(JSON.stringify({ ts: now, ref, outcome: 'email_error', ipHash: ipHashVal }));
    }
  }

  // 9. webhook (optional)
  if (env.FORM_WEBHOOK_URL) {
    const payload = JSON.stringify({
      ref, name, email, company, project, budget: input.budget, timeline: input.timeline, submittedAt: new Date(now).toISOString(), ipHash: ipHashVal,
    });
    const headers: Record<string,string> = { 'Content-Type': 'application/json' };
    if (env.FORM_WEBHOOK_SECRET) {
      const sigBuf = await crypto.subtle.sign('HMAC', await crypto.subtle.importKey('raw', new TextEncoder().encode(env.FORM_WEBHOOK_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']), new TextEncoder().encode(payload));
      const sig = Array.from(new Uint8Array(sigBuf)).map(x=>x.toString(16).padStart(2,'0')).join('');
      headers['X-Signature'] = `sha256=${sig}`;
    }
    const attempts = [0, 2000, 8000];
    let ok = false;
    for (const wait of attempts) {
      if (wait) await delay(wait);
      try {
        const r = await fetch(env.FORM_WEBHOOK_URL, { method: 'POST', headers, body: payload });
        if (r.ok) { ok = true; break; }
      } catch {}
    }
    if (!ok) console.log(JSON.stringify({ ts: now, ref, outcome: 'webhook_fail', ipHash: ipHashVal }));
  }

  // 10. redacted log (no bodies)
  console.log(JSON.stringify({ ts: now, ref, outcome: 'accepted', ipHash: ipHashVal, hasCompany: !!company, budget: input.budget, timeline: input.timeline, fileCount: files.length, fileBytes: files.reduce((n, f) => n + f.data.length, 0) }));

  // DEV_STUB shortcut: if DEV_STUB=1 and no Resend, still return ok
  // response
  if (isUrlencoded) {
    const status = 303;
    return new Response(null, { status, headers: { 'Location': '/thank-you' } });
  }
  return json({ ok: true, emailed, ref }, 200);
};