// check-mail.mjs — diagnose and test the contact-form e-mail pipeline.
//
//   node scripts/check-mail.mjs          config diagnosis (no network)
//   node scripts/check-mail.mjs --test   run api/contact.ts against a stubbed
//                                        Resend, asserting the exact request
//   node scripts/check-mail.mjs --send   send ONE real test e-mail (needs a
//                                        working RESEND_API_KEY)
//
// Secrets are never printed: only set/missing and lengths.

import { readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import * as esbuild from 'esbuild';

const SITE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = resolve(SITE, '..');
const mode = process.argv[2] || '';

function loadEnv() {
  const env = {};
  const p = join(SITE, '.env');
  if (!existsSync(p)) return env;
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    env[m[1]] = v;
  }
  return env;
}

const fileEnv = loadEnv();
const pick = (k) => process.env[k] ?? fileEnv[k] ?? '';
const apiKey = pick('RESEND_API_KEY');
const from = pick('RESEND_FROM') || 'IMK <2imk4support@gmail.com>';
const to = pick('CONTACT_TO') || pick('RESEND_TO');

let failures = 0;
const ok = (msg) => console.log(`  PASS  ${msg}`);
const bad = (msg) => { failures++; console.log(`  FAIL  ${msg}`); };
const info = (msg) => console.log(`  ..    ${msg}`);

console.log(`[check-mail] mode: ${mode || 'config'}`);
console.log('[check-mail] configuration');
info(`RESEND_API_KEY: ${apiKey ? `set (${apiKey.length} chars, ${apiKey.startsWith('re_') ? 're_ prefix' : 'NO re_ prefix'})` : 'MISSING'}`);
info(`RESEND_FROM: ${from}`);
info(`destination (CONTACT_TO || RESEND_TO): ${to || 'MISSING'}`);
if (!apiKey) bad('no RESEND_API_KEY — api/contact.ts answers ok:true with emailed:false and sends nothing');
else if (!apiKey.startsWith('re_')) bad('RESEND_API_KEY does not look like a Resend key');
else ok('RESEND_API_KEY present');
if (!to) bad('no destination address — nothing is sent even with a key');
else ok('destination present');
if (/(@gmail\.com|@yahoo\.|@hotmail\.|@outlook\.)/i.test(from) && !/onboarding@resend\.dev/i.test(from)) {
  info('from is a free-mail address: Resend only accepts it if that exact address is a verified sending identity');
  info('for a first test, "IMK <onboarding@resend.dev>" only delivers to the Resend account owner address');
}
if (mode === '') {
  console.log('[check-mail] next: add the key to site/.env, then run  node scripts/check-mail.mjs --test');
  process.exit(failures ? 1 : 0);
}

// ---------------------------------------------------------------- pipeline
if (mode === '--test' || mode === '--send') {
  Object.assign(process.env, {
    APP_ENV: 'development',
    DEV_STUB: '',
    RESEND_API_KEY: apiKey || 're_stub_only_for_the_pipeline_test',
    RESEND_FROM: from,
    CONTACT_TO: to || 'owner@example.com',
    TURNSTILE_SECRET_KEY: '',
  });
  delete process.env.DEV_STUB;
  delete process.env.TURNSTILE_SECRET_KEY;

  const out = join(mkdtempSync(join(tmpdir(), 'imk-mail-')), 'contact.mjs');
  await esbuild.build({
    entryPoints: [join(REPO, 'api', 'contact.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: out,
    logLevel: 'silent',
  });
  const { default: handler } = await import('file://' + out.replace(/\\/g, '/'));

  const calls = [];
  const realFetch = globalThis.fetch;
  const stub = async (url, init) => {
    const u = String(url?.url ?? url);
    if (u.startsWith('https://api.resend.com/')) {
      calls.push({ url: u, init });
      return new Response(JSON.stringify({ id: 'stub-' + calls.length }), { status: 200 });
    }
    return realFetch(url, init);
  };

  async function submit(fields) {
    globalThis.fetch = stub;
    const body = JSON.stringify(fields);
    const req = Readable.from([Buffer.from(body, 'utf8')]);
    req.method = 'POST';
    req.headers = { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) };
    let status = 0, payload = '';
    const res = {
      writeHead(s) { status = s; return this; },
      end(p) { payload = p ? String(p) : ''; },
      setHeader() {},
    };
    await handler(req, res);
    globalThis.fetch = realFetch;
    return { status, body: payload ? JSON.parse(payload) : null };
  }

  const base = {
    name: 'Ada Lovelace',
    email: 'ada@client.example',
    company: 'Analytical Engines',
    project: 'Sync orders <b>nightly</b> & flag mismatches.',
    budget: '1k-5k',
    timeline: '1-month',
    subject: 'Order sync',
    ts: Date.now() - 5000,
  };

  console.log('[check-mail] pipeline (stubbed Resend, no real e-mail)');
  calls.length = 0;
  const r1 = await submit(base);
  if (r1.status === 200 && r1.body?.ok === true) ok(`valid submission -> 200 ok (ref ${r1.body.ref})`);
  else bad(`valid submission -> ${r1.status} ${JSON.stringify(r1.body)}`);
  if (r1.body?.emailed === true) ok('emailed=true');
  else bad(`emailed=${r1.body?.emailed}`);

  if (calls.length === 1) ok('exactly one Resend call');
  else bad(`expected 1 Resend call, saw ${calls.length}`);
  if (calls.length) {
    const { url, init } = calls[0];
    const sent = JSON.parse(init.body);
    if (url === 'https://api.resend.com/emails') ok('posts to https://api.resend.com/emails');
    else bad(`wrong URL ${url}`);
    if (init.headers?.Authorization === `Bearer ${process.env.RESEND_API_KEY}`) ok('Authorization: Bearer <key>');
    else bad('Authorization header missing or wrong');
    if (Array.isArray(sent.to) && sent.to[0] === (to || 'owner@example.com')) ok(`to[0] = ${sent.to[0]}`);
    else bad(`to = ${JSON.stringify(sent.to)}`);
    if (sent.from === from) ok(`from = ${sent.from}`);
    else bad(`from = ${sent.from}`);
    if (sent.reply_to === base.email) ok('reply_to = submitter');
    else bad(`reply_to = ${sent.reply_to}`);
    if (String(sent.subject).startsWith('IMK enquiry - ')) ok(`subject = "${sent.subject}"`);
    else bad(`subject = ${sent.subject}`);
    if (JSON.parse(init.body).text.includes('Ada Lovelace') && JSON.parse(init.body).text.includes('ada@client.example')) ok('text body carries name + email');
    else bad('text body is missing the submission');
    if (sent.html.includes('&lt;b&gt;nightly&lt;/b&gt;') && !sent.html.includes('<b>nightly</b>')) ok('project text is HTML-escaped');
    else bad('project text is not escaped');
  }

  calls.length = 0;
  const r2 = await submit({ ...base, website: 'http://spam.example' });
  if (r2.status === 200 && r2.body?.ok === true && calls.length === 0) ok('honeypot: silent 200, no e-mail');
  else bad(`honeypot: ${r2.status}, ${calls.length} call(s)`);

  calls.length = 0;
  const r3 = await submit({ ...base, ts: Date.now() });
  if (r3.status === 400 && r3.body?.code === 'time-trap' && calls.length === 0) ok('time trap: 400, no e-mail');
  else bad(`time trap: ${r3.status} ${JSON.stringify(r3.body)}`);

  calls.length = 0;
  const r4 = await submit({ ...base, type: 'review' });
  if (r4.status === 410 && calls.length === 0) ok('review type refused with 410, no e-mail');
  else bad(`review type: ${r4.status} ${JSON.stringify(r4.body)}`);

  calls.length = 0;
  const r5 = await submit({ ...base, email: 'not-an-email' });
  if (r5.status === 400 && r5.body?.fields?.includes('email') && calls.length === 0) ok('bad email: 400 validation, no e-mail');
  else bad(`bad email: ${r5.status} ${JSON.stringify(r5.body)}`);

  if (mode === '--send') {
    console.log('[check-mail] real send');
    if (!apiKey || !to) {
      bad('cannot send: key or destination missing');
    } else {
      const r = await realFetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from,
          to: [to],
          subject: 'IMK contact form test',
          text: 'This is a test sent by site/scripts/check-mail.mjs. If you can read it, contact-form e-mail works.',
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok) ok(`Resend accepted the message (id ${j.id || 'unknown'})`);
      else bad(`Resend refused: ${r.status} ${JSON.stringify(j)}`);
    }
  }
}

console.log(`[check-mail] ${failures === 0 ? 'OK' : failures + ' FAILURE(S)'}`);
process.exit(failures ? 1 : 0);
