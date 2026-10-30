// backend-wave18-contact-attachments-harness.mjs
//
// EXECUTED evidence for wave 18c: the new multipart attachment transport.
//
// In-process: bundles api/contact.ts (Vercel) and runs the REAL handler with a
// mocked global fetch (no real mail). Every guard is exercised and each is
// proven to bite by mutating the request and watching the response change.
//
// USAGE: node backend-wave18-contact-attachments-harness.mjs

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = fs.existsSync(path.join(HERE, 'api', 'contact.ts')) ? HERE : path.resolve(HERE, '..');
const SITE = path.join(REPO, 'site');

const { createRequire } = await import('node:module');
const siteRequire = createRequire(path.join(SITE, 'package.json'));
const { build } = siteRequire('esbuild');

const SANDBOX = path.join(os.tmpdir(), 'opencode', 'wave18', String(Date.now()));
fs.mkdirSync(SANDBOX, { recursive: true });
const BUNDLE = path.join(SANDBOX, 'contact.cjs');

await build({
  entryPoints: [path.join(REPO, 'api', 'contact.ts')],
  outfile: BUNDLE,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  absWorkingDir: REPO,
  external: ['node:http', 'node:crypto', 'node:fs', 'node:path', 'node:stream'],
  logLevel: 'silent',
});

const require = createRequire(import.meta.url);
const handler = require(BUNDLE).default;

const results = [];
function assert(cond, msg) { if (!cond) throw new Error(msg); }
async function t(id, name, fn) {
  try { const d = await fn(); results.push({id, status:'PASS', name}); console.log('  PASS  ' + id + '  ' + name + (d ? ' — ' + d : '')); }
  catch (e) { results.push({id, status:'FAIL', name, error: String(e && e.message ? e.message : e)}); console.log('  FAIL  ' + id + '  ' + name + '\n          ' + (e && e.message ? e.message : e)); }
}

const boundary = '----w18';
function mkField(n, v) { return Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="' + n + '"\r\n\r\n' + v + '\r\n'); }
const pngMagic = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,1,2,3]);

function makeReq(headers, bodyBuf) {
  const { Readable } = require('node:stream');
  const req = Readable.from(bodyBuf ? [bodyBuf] : []);
  req.method = 'POST'; req.url = '/api/contact'; req.headers = headers || {};
  return req;
}
function makeRes() {
  return { statusCode: 200, headers: {}, body: '', ended: false,
    writeHead(s, h) { this.statusCode = s; this.headers = h || {}; return this; },
    setHeader(n, v) { this.headers[n] = v; },
    end(p) { if (p) this.body += Buffer.isBuffer(p) ? p.toString('utf8') : String(p); this.ended = true; return this; },
  };
}
async function post(headers, bodyBuf) {
  const req = makeReq(headers, bodyBuf);
  const res = makeRes();
  await handler(req, res);
  let parsed = null; try { parsed = JSON.parse(res.body || 'null'); } catch {}
  return { status: res.statusCode, body: parsed, raw: res.body };
}

// env baseline
process.env.APP_ENV = 'development';
delete process.env.TURNSTILE_SECRET_KEY;
process.env.RESEND_API_KEY = 'rk_test';
process.env.CONTACT_TO = 'owner@imk.test';

function resetFetch(capture) {
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('resend.com')) {
      if (capture) capture.value = JSON.parse(opts.body);
      return { ok: true, json: async () => ({}) };
    }
    return { ok: true, json: async () => ({ success: true }) };
  };
}

console.log('[wave18] sandbox:', SANDBOX);

await t('A1', '1 image attachment is accepted (200, emailed true)', async () => {
  const capture = { value: null };
  resetFetch(capture);
  const parts = [];
  parts.push(mkField('name', 'Alice'));
  parts.push(mkField('email', 'a@b.com'));
  parts.push(mkField('project', 'desc'));
  parts.push(mkField('budget', 'not-sure'));
  parts.push(mkField('timeline', 'exploring'));
  parts.push(mkField('ts', String(Date.now() - 5000)));
  parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="pic.png"\r\nContent-Type: image/png\r\n\r\n'));
  parts.push(pngMagic);
  parts.push(Buffer.from('\r\n'));
  parts.push(Buffer.from('--' + boundary + '--\r\n'));
  const body = Buffer.concat(parts);
  const ct = 'multipart/form-data; boundary=' + boundary;
  const r = await post({ 'content-type': ct, 'content-length': String(body.length) }, body);
  assert(r.status === 200, 'status ' + r.status + ' ' + r.raw);
  assert(r.body && r.body.ok === true, 'ok');
  assert(r.body.emailed === true, 'emailed');
  assert(capture.value && capture.value.attachments && capture.value.attachments.length === 1, 'attachment sent');
  assert(capture.value.reply_to === 'a@b.com', 'reply_to');
  return '200, emailed=true, 1 attachment, reply_to set';
});

await t('A2', '3 mixed attachments are accepted', async () => {
  resetFetch(null);
  const parts = [];
  parts.push(mkField('name', 'Bob'));
  parts.push(mkField('email', 'b@c.com'));
  parts.push(mkField('project', 'p'));
  parts.push(mkField('budget', 'not-sure'));
  parts.push(mkField('timeline', 'exploring'));
  parts.push(mkField('ts', String(Date.now() - 5000)));
  for (let i = 0; i < 3; i++) {
    parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="f' + i + '.png"\r\nContent-Type: image/png\r\n\r\n'));
    parts.push(pngMagic);
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from('--' + boundary + '--\r\n'));
  const body = Buffer.concat(parts);
  const ct = 'multipart/form-data; boundary=' + boundary;
  const r = await post({ 'content-type': ct, 'content-length': String(body.length) }, body);
  assert(r.status === 200, 'status ' + r.status);
  return '200, 3 files';
});

await t('A3', '4 files -> too-many-files (413)', async () => {
  resetFetch(null);
  const parts = [];
  parts.push(mkField('name', 'C'));
  parts.push(mkField('email', 'c@d.com'));
  parts.push(mkField('project', 'p'));
  parts.push(mkField('budget', 'not-sure'));
  parts.push(mkField('timeline', 'exploring'));
  parts.push(mkField('ts', String(Date.now() - 5000)));
  for (let i = 0; i < 4; i++) {
    parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="f' + i + '.png"\r\nContent-Type: image/png\r\n\r\n'));
    parts.push(pngMagic);
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from('--' + boundary + '--\r\n'));
  const body = Buffer.concat(parts);
  const ct = 'multipart/form-data; boundary=' + boundary;
  const r = await post({ 'content-type': ct, 'content-length': String(body.length) }, body);
  assert(r.status === 413, 'status ' + r.status);
  assert(r.body && r.body.code === 'too-many-files', 'code ' + (r.body && r.body.code));
  return '413 too-many-files';
});

await t('A4', '>4 MiB -> payload-too-large (413)', async () => {
  // build a body just over 4 MiB
  const big = Buffer.alloc(4 * 1024 * 1024 + 100, 0x41);
  const ct = 'multipart/form-data; boundary=' + boundary;
  // send as raw with content-length claiming small? Instead send actual big bytes with multipart-ish content-type
  const r = await post({ 'content-type': ct, 'content-length': String(big.length) }, big);
  assert(r.status === 413, 'status ' + r.status);
  assert(r.body && r.body.code === 'payload-too-large', 'code ' + (r.body && r.body.code));
  return '413 payload-too-large';
});

await t('A5', 'SVG -> unsupported-file (415)', async () => {
  resetFetch(null);
  const parts = [];
  parts.push(mkField('name', 'D'));
  parts.push(mkField('email', 'd@e.com'));
  parts.push(mkField('project', 'p'));
  parts.push(mkField('budget', 'not-sure'));
  parts.push(mkField('timeline', 'exploring'));
  parts.push(mkField('ts', String(Date.now() - 5000)));
  const svgBuf = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="x.svg"\r\nContent-Type: image/svg+xml\r\n\r\n'));
  parts.push(svgBuf);
  parts.push(Buffer.from('\r\n'));
  parts.push(Buffer.from('--' + boundary + '--\r\n'));
  const body = Buffer.concat(parts);
  const ct = 'multipart/form-data; boundary=' + boundary;
  const r = await post({ 'content-type': ct, 'content-length': String(body.length) }, body);
  assert(r.status === 415, 'status ' + r.status);
  assert(r.body && r.body.code === 'unsupported-file', 'code ' + (r.body && r.body.code));
  return '415 unsupported-file';
});

await t('A6', 'PNG magic declared text/plain -> unsupported-file (415)', async () => {
  resetFetch(null);
  const parts = [];
  parts.push(mkField('name', 'E'));
  parts.push(mkField('email', 'e@f.com'));
  parts.push(mkField('project', 'p'));
  parts.push(mkField('budget', 'not-sure'));
  parts.push(mkField('timeline', 'exploring'));
  parts.push(mkField('ts', String(Date.now() - 5000)));
  parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="x.png"\r\nContent-Type: text/plain\r\n\r\n'));
  parts.push(pngMagic);
  parts.push(Buffer.from('\r\n'));
  parts.push(Buffer.from('--' + boundary + '--\r\n'));
  const body = Buffer.concat(parts);
  const ct = 'multipart/form-data; boundary=' + boundary;
  const r = await post({ 'content-type': ct, 'content-length': String(body.length) }, body);
  assert(r.status === 415, 'status ' + r.status);
  assert(r.body && r.body.code === 'unsupported-file', 'code ' + (r.body && r.body.code));
  return '415 unsupported-file';
});

await t('A7', 'traversal filename is sanitised before send', async () => {
  const capture = { value: null };
  resetFetch(capture);
  const parts = [];
  parts.push(mkField('name', 'F'));
  parts.push(mkField('email', 'f@g.com'));
  parts.push(mkField('project', 'p'));
  parts.push(mkField('budget', 'not-sure'));
  parts.push(mkField('timeline', 'exploring'));
  parts.push(mkField('ts', String(Date.now() - 5000)));
  parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="../../etc/passwd.png"\r\nContent-Type: image/png\r\n\r\n'));
  parts.push(pngMagic);
  parts.push(Buffer.from('\r\n'));
  parts.push(Buffer.from('--' + boundary + '--\r\n'));
  const body = Buffer.concat(parts);
  const ct = 'multipart/form-data; boundary=' + boundary;
  const r = await post({ 'content-type': ct, 'content-length': String(body.length) }, body);
  assert(r.status === 200, 'status ' + r.status);
  const fn = capture.value && capture.value.attachments && capture.value.attachments[0] && capture.value.attachments[0].filename;
  assert(fn && !fn.includes('/') && !fn.includes('..'), 'filename not sanitised: ' + fn);
  assert(fn === 'passwd.png' || fn === '______etc_passwd.png' || fn.indexOf('passwd') !== -1, 'unexpected filename: ' + fn);
  return 'sanitised filename: ' + fn;
});

await t('A8', 'CR/LF in subject cannot inject a header (single line)', async () => {
  const capture = { value: null };
  resetFetch(capture);
  const parts = [];
  parts.push(mkField('name', 'G'));
  parts.push(mkField('email', 'g@h.com'));
  parts.push(mkField('subject', 'foo\r\nBcc: evil@x.com'));
  parts.push(mkField('project', 'p'));
  parts.push(mkField('budget', 'not-sure'));
  parts.push(mkField('timeline', 'exploring'));
  parts.push(mkField('ts', String(Date.now() - 5000)));
  parts.push(Buffer.from('--' + boundary + '--\r\n'));
  const body = Buffer.concat(parts);
  const ct = 'multipart/form-data; boundary=' + boundary;
  const r = await post({ 'content-type': ct, 'content-length': String(body.length) }, body);
  assert(r.status === 200, 'status ' + r.status);
  const subj = capture.value && capture.value.subject;
  assert(typeof subj === 'string' && !/\r|\n/.test(subj), 'subject contains newline: ' + JSON.stringify(subj));
  return 'subject is single-line';
});

await t('A9', 'missing boundary -> clean 4xx, not a crash', async () => {
  const buf = Buffer.from('hello world');
  const r = await post({ 'content-type': 'multipart/form-data; boundary=' + boundary, 'content-length': String(buf.length) }, buf);
  assert(r.status >= 400 && r.status < 500, 'status ' + r.status);
  assert(r.body && typeof r.body.code === 'string', 'no code');
  return r.status + ' ' + r.body.code;
});

await t('A10', 'truncated body -> clean 4xx, not a crash', async () => {
  const parts = [];
  parts.push(mkField('name', 'H'));
  parts.push(mkField('email', 'h@i.com'));
  // no closing boundary
  const body = Buffer.concat(parts);
  const ct = 'multipart/form-data; boundary=' + boundary;
  const r = await post({ 'content-type': ct, 'content-length': String(body.length) }, body);
  assert(r.status >= 400 && r.status < 500, 'status ' + r.status);
  assert(r.body && typeof r.body.code === 'string', 'no code');
  return r.status + ' ' + r.body.code;
});

await t('A11', 'Content-Length lie -> clean 4xx, not a crash', async () => {
  const parts = [];
  parts.push(mkField('name', 'I'));
  parts.push(mkField('email', 'i@j.com'));
  parts.push(mkField('project', 'p'));
  parts.push(mkField('budget', 'not-sure'));
  parts.push(mkField('timeline', 'exploring'));
  parts.push(mkField('ts', String(Date.now() - 5000)));
  parts.push(Buffer.from('--' + boundary + '--\r\n'));
  const body = Buffer.concat(parts);
  const ct = 'multipart/form-data; boundary=' + boundary;
  const r = await post({ 'content-type': ct, 'content-length': '999999' }, body);
  assert(r.status >= 400 && r.status < 500, 'status ' + r.status);
  assert(r.body && typeof r.body.code === 'string', 'no code');
  return r.status + ' ' + r.body.code;
});

await t('A12', 'legacy urlencoded post still passes (303)', async () => {
  resetFetch(null);
  const params = new URLSearchParams();
  params.set('name', 'Legacy'); params.set('email', 'l@m.com'); params.set('project', 'proj');
  params.set('budget', 'not-sure'); params.set('timeline', 'exploring'); params.set('ts', String(Date.now() - 5000));
  const body = Buffer.from(params.toString());
  const r = await post({ 'content-type': 'application/x-www-form-urlencoded', 'content-length': String(body.length) }, body);
  assert(r.status === 303, 'status ' + r.status);
  return '303 redirect';
});

// mutation probe: remove the 3-file guard -> A3 must redden
await t('M1', 'mutation probe: removing the 3-file guard reddens A3', async () => {
  const src = fs.readFileSync(path.join(REPO, 'api', 'contact.ts'), 'utf8');
  const mutated = src.replace('      if (files.length > 3) {', '      if (false && files.length > 3) {');
  assert(mutated !== src, 'mutation must change the file');
  const mBundle = path.join(SANDBOX, 'contact-mut.cjs');
  const plugin = { name: 'mutate-contact', setup(b) { b.onLoad({ filter: /contact\.ts$/ }, () => ({ contents: mutated, loader: 'ts' })); } };
  await build({ entryPoints: [path.join(REPO, 'api', 'contact.ts')], outfile: mBundle, bundle: true, platform: 'node', format: 'cjs', absWorkingDir: REPO, external: ['node:http','node:crypto','node:fs','node:path','node:stream'], plugins: [plugin], logLevel: 'silent' });
  const mutHandler = require(mBundle).default;
  // send 4 files
  const parts = [];
  parts.push(mkField('name', 'Z'));
  parts.push(mkField('email', 'z@z.com'));
  parts.push(mkField('project', 'p'));
  parts.push(mkField('budget', 'not-sure'));
  parts.push(mkField('timeline', 'exploring'));
  parts.push(mkField('ts', String(Date.now() - 5000)));
  for (let i = 0; i < 4; i++) {
    parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="f' + i + '.png"\r\nContent-Type: image/png\r\n\r\n'));
    parts.push(pngMagic);
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from('--' + boundary + '--\r\n'));
  const body = Buffer.concat(parts);
  const ct = 'multipart/form-data; boundary=' + boundary;
  const req = makeReq({ 'content-type': ct, 'content-length': String(body.length) }, body);
  const res = makeRes();
  globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });
  await mutHandler(req, res);
  let parsed = null; try { parsed = JSON.parse(res.body); } catch {}
  assert(res.statusCode !== 413 || (parsed && parsed.code !== 'too-many-files'), 'mutant still rejects 4 files — probe would be vacuous');
  return 'mutant accepts 4 files (probe bites)';
});

const failed = results.filter(r => r.status === 'FAIL');
console.log('\n[wave18] ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed, ' + results.length + ' checks');
if (failed.length) console.log('[wave18] failing: ' + failed.map(f => f.id).join(', '));
try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch {}
process.exit(failed.length ? 1 : 0);