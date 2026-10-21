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
  APP_ENV?: string;
  DEV_STUB?: string; // must never be '1' in production
  KV_COUNTER?: any;
}
type Budget = 'under-1k'|'1k-5k'|'5k-15k'|'15k+'|'not-sure';
type Timeline = 'asap'|'1-month'|'3-months'|'exploring';
interface ContactReq {
  name: string; email: string; company?: string;
  project: string; budget: Budget; timeline: Timeline;
  website?: string; ts?: number;
  turnstileToken?: string;
  type?: string;
  linkedin?: string;
}
const BUDGETS = ['under-1k','1k-5k','5k-15k','15k+','not-sure'];
const TIMELINES = ['asap','1-month','3-months','exploring'];
const MAX = { name:80, email:254, company:120, project:500, body:8192, recent:3000, stale:4*60*60*1000, skew:60000 };

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

export const onRequestPost: any = async (ctx: any) => {
  const { request, env } = ctx;
  // DEV_STUB guard: never in production
  const isProd = (env.APP_ENV || 'production') === 'production';
  if (isProd && env.DEV_STUB === '1') {
    return json({ error: 'misconfigured', code: 'internal' }, 500);
  }
  const wantsJson = (request.headers.get('content-type') || '').includes('application/json');

  // 1. body size
  const len = parseInt(request.headers.get('content-length') || '0', 10);
  if (len && len > MAX.body) {
    return wantsJson ? json({ error: 'request too large', code: 'payload-too-large' }, 413) : new Response('Request too large', { status: 413 });
  }
  const raw = await request.text();
  if (raw.length > MAX.body) {
    return wantsJson ? json({ error: 'request too large', code: 'payload-too-large' }, 413) : new Response('Request too large', { status: 413 });
  }

  // parse
  let input: ContactReq = { name:'', email:'', project:'', budget: null as any, timeline: null as any };
  let isUrlencoded = false;
  const ct = request.headers.get('content-type') || '';
  try {
    if (ct.includes('application/json')) {
      input = { ...input, ...JSON.parse(raw || '{}') };
    } else if (ct.includes('application/x-www-form-urlencoded') || ct.includes('multipart')) {
      isUrlencoded = true;
      const params = new URLSearchParams(raw);
      input = {
        name: params.get('name') || '',
        email: params.get('email') || '',
        company: params.get('company') || '',
        linkedin: params.get('linkedin') || '',
        project: params.get('project') || '',
        budget: params.get('budget') as any,
        timeline: params.get('timeline') as any,
        website: params.get('website') || '',
        ts: params.get('ts') ? Number(params.get('ts')) : undefined,
        type: params.get('type') || 'contact',
      };
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
  const from = env.RESEND_FROM || 'IMK <2imk4support@gmail.com>';
  const to = env.RESEND_TO || env.CONTACT_TO || '';
  const subject = 'New IMK inquiry';
  const ipHashVal = ip ? await ipHash(ip, env.LOG_PEPPER || 'dev', day) : 'no-ip';
  const htmlBody = `<h2>New inquiry (${ref})</h2>
<p><b>Name:</b> ${escapeHtml(name)}</p>
<p><b>Email:</b> ${escapeHtml(email)}</p>
<p><b>Company:</b> ${escapeHtml(company || '—')}</p>
<p><b>Budget:</b> ${escapeHtml(input.budget)}</p>
<p><b>Timeline:</b> ${escapeHtml(input.timeline)}</p>
<p><b>Project:</b></p><p>${escapeHtml(project).replace(/\n/g,'<br>')}</p>
<hr><p style="color:#888;font-size:12px;">ref ${ref} · ${new Date(now).toISOString()} · ip ${escapeHtml(ipHashVal)} · env ${escapeHtml(env.APP_ENV || 'production')}</p>`;
  const textBody = `New inquiry (${ref})\n\nName: ${name}\nEmail: ${email}\nCompany: ${company || '—'}\nBudget: ${input.budget}\nTimeline: ${input.timeline}\nProject: ${project}\n\nref ${ref} env ${env.APP_ENV || 'production'}`;

  if (env.RESEND_API_KEY && to) {
    try {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to: [to], subject, html: htmlBody, text: textBody, reply_to: email }),
      });
      if (!r.ok) {
        // log redacted failure
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
  console.log(JSON.stringify({ ts: now, ref, outcome: 'accepted', ipHash: ipHashVal, hasCompany: !!company, budget: input.budget, timeline: input.timeline }));

  // DEV_STUB shortcut: if DEV_STUB=1 and no Resend, still return ok
  // response
  if (isUrlencoded) {
    const status = 303;
    return new Response(null, { status, headers: { 'Location': '/thank-you' } });
  }
  return json({ ok: true, ref }, 200);
};