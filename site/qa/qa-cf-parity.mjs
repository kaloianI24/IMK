// site/qa/qa-cf-parity.mjs
//
// Backend-owned suite for the Cloudflare twin of the portal.
//
// WHY THIS EXISTS
//   After the wave-2 re-run QA said: "The Cloudflare runtime was never
//   executed. M6/D6 is static only." That was honest, and this suite is the
//   answer: it EXECUTES the Cloudflare handlers.
//
// HOW IT EXECUTES THEM
//   The Cloudflare Pages runtime gives a handler the Web platform
//   (Request/Response/fetch/crypto.subtle/TextEncoder) and NO `require`.
//   Node gives us the same Web globals, so the Cloudflare modules run here
//   unmodified — and with `globalThis.require` absent they take exactly the
//   path they take on the edge (fsModule() === null).
//   What this is NOT: workerd. The edge runtime itself was never booted
//   (wrangler is not installed and no workerd binary is available here).
//   Every claim below is a claim about the Cloudflare CODE PATH, not about
//   Cloudflare's runtime.
//
// What it proves:
//   C1  the Cloudflare portal endpoints answer 501 {code:'unimplemented'} on
//       the edge — the Cloudflare target cannot serve the portal today, and
//       the notification fix (M6) sits behind that stub
//   C2  that 501 is about the MISSING STORE, not a broken handler: with a
//       filesystem present the same endpoint runs and reaches its auth check
//   C3  the Cloudflare auth handler is live on the edge, and its sign-in
//       limiter is KV-backed: the 6th request from one IP is 429, and the
//       counter lives in KV (durable across cold starts)
//   C4  the Cloudflare moderation endpoint ACCEPTS a link signed by the
//       Vercel tree and rejects a forged one. The DECISION is the POST
//       (M-1, wave-8A): a GET only shows the confirmation page, so a mail
//       scanner that prefetches the link decides nothing
//   C5  a corrupt moderation store answers 500 {code:'storage'} on the
//       Cloudflare tree too - the same answer the Vercel tree gives (the
//       last lenient reader in the repo, QA wave-3 D-1), and a store that
//       cannot be reached answers 501, never "review not found"
//   C6  the Cloudflare session endpoint (GET /api/portal/session, wave-8A)
//       answers the same codes as the Vercel tree
//   D1  a link signed by the Cloudflare tree verifies with the Vercel verifier
//   D2  a link signed by the Vercel tree verifies with the Cloudflare verifier
//   D3  both trees build the SAME link shape, from SITE_BASE_URL
//   D4  the Cloudflare notification mail carries the revision, and the link
//       in it verifies
//   D5  a link signed for revision 1 does not verify for revision 2 (the
//       M5 binding holds across both trees)
//
// USAGE
//   node site/qa/qa-cf-parity.mjs

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.resolve(HERE, '..');
const REPO = path.resolve(SITE, '..');

const results = [];
let currentGroup = '';
const origLog = console.log;

function group(name) {
  currentGroup = name;
  origLog(`\n[qa] ${name}`);
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function t(id, name, fn) {
  try {
    const detail = await fn();
    results.push({ id, group: currentGroup, name, status: 'PASS', detail: detail ?? null });
    origLog(`  PASS  ${id}  ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (err) {
    results.push({ id, group: currentGroup, name, status: 'FAIL', error: String(err && err.message ? err.message : err) });
    origLog(`  FAIL  ${id}  ${name}\n          ${err && err.message ? err.message : err}`);
  }
}

const SANDBOX = path.join(
  os.tmpdir(),
  `qa-cf-parity-${new Date().toISOString().replace(/[:.]/g, '-')}`,
);

const REPO_FWD = REPO.replace(/\\/g, '/');
const ENTRY = `export { onRequestGet as cfTestimonialsGet, onRequestPost as cfTestimonialsPost } from '${REPO_FWD}/site/functions/api/portal/testimonials.ts';
export { onRequestGet as cfProjectsGet, onRequestPost as cfProjectsPost } from '${REPO_FWD}/site/functions/api/portal/projects.ts';
export { onRequestGet as cfCommentsGet } from '${REPO_FWD}/site/functions/api/portal/comments.ts';
export { onRequestGet as cfPlanItemsGet } from '${REPO_FWD}/site/functions/api/portal/plan-items.ts';
export { onRequestGet as cfUpdatesGet } from '${REPO_FWD}/site/functions/api/portal/updates.ts';
export { onRequestPost as cfInvitesPost } from '${REPO_FWD}/site/functions/api/portal/invites.ts';
export { onRequestPost as cfAuthPost } from '${REPO_FWD}/site/functions/api/portal/auth.ts';
export { onRequestGet as cfModerateGet, onRequestPost as cfModeratePost } from '${REPO_FWD}/site/functions/api/moderate/review.ts';
export * as cfNotifications from '${REPO_FWD}/site/functions/api/lib/notifications.ts';
export * as cfSession from '${REPO_FWD}/site/functions/api/portal/session.ts';
export * as vercelNotifications from '${REPO_FWD}/api/lib/notifications.ts';
`;

let cf = null;
const resendCalls = [];

async function load() {
  const entryFile = path.join(SANDBOX, 'entry.ts');
  const outFile = path.join(SANDBOX, 'bundle', 'cf.cjs');
  fs.mkdirSync(path.dirname(entryFile), { recursive: true });
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(entryFile, ENTRY, 'utf8');
  await build({
    entryPoints: [entryFile],
    outfile: outFile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    absWorkingDir: REPO,
    external: ['node:http', 'node:crypto', 'node:fs', 'node:path'],
    logLevel: 'silent',
  });
  cf = require(outFile);
}

function fakeKv() {
  const store = new Map();
  return {
    store,
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value) {
      store.set(key, value);
    },
  };
}

// H-1 (wave-8A): in production a secret that is PRESENT but UNUSABLE -- the
// published placeholder, or shorter than MIN_SECRET_LENGTH (32) -- is refused
// exactly like a missing one, so every fixture below is 32+ characters long.
const SECRET = 'qa-cf-parity-form-webhook-secret-0123456789';
const BASE = 'https://imk.test';
// The session is a SIGNED token (audit wave-6, F-2), so a session can only
// be minted when a signing secret is configured. This suite runs with
// APP_ENV=production, where a missing secret is a hard misconfiguration —
// so the secret has to be here, in BOTH the Worker's env and process.env:
// cfEnv() is what the handlers verify against, and the mint below calls
// createSession() without an env, which falls back to process.env.
const SESSION_SECRET = 'qa-cf-parity-session-secret-0123456789';

function cfEnv(extra = {}) {
  return {
    SITE_BASE_URL: BASE,
    FORM_WEBHOOK_SECRET: SECRET,
    RESEND_API_KEY: 'cf-parity-resend-key',
    RESEND_TO: 'owner@imk.test',
    CONTACT_TO: 'owner@imk.test',
    APP_ENV: 'production',
    PORTAL_SESSION_SECRET: SESSION_SECRET,
    // The owner allow-list is part of a working deployment (M-4): without it
    // the owner gate refuses EVERYONE, and the checks below would prove the
    // gate works instead of what they are about.
    ADMIN_EMAILS: 'owner@imk.test',
    ...extra,
  };
}

async function main() {
  origLog(`[qa] sandbox: ${SANDBOX}`);
  fs.mkdirSync(SANDBOX, { recursive: true });

  // The edge has no `require`. Node has a module-scoped one, but
  // `globalThis.require` is undefined — which is exactly what the Cloudflare
  // code checks for. Assert it, so the suite cannot silently drift into
  // testing the wrong path.
  assertEqual(typeof globalThis.require, 'undefined', 'the edge runtime has no global require');

  await load();

  process.env.SITE_BASE_URL = BASE;
  process.env.FORM_WEBHOOK_SECRET = SECRET;
  process.env.RESEND_API_KEY = 'cf-parity-resend-key';
  process.env.RESEND_TO = 'owner@imk.test';
  process.env.PORTAL_SESSION_SECRET = SESSION_SECRET;
  delete process.env.SITE_URL;

  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const href = typeof url === 'string' ? url : url.url;
    if (String(href).includes('api.resend.com')) {
      resendCalls.push({ href: String(href), init });
      return { ok: true, status: 200, json: async () => ({ id: 'stub' }) };
    }
    throw new Error(`[qa] unexpected outbound request: ${href}`);
  };

  group('C — the Cloudflare tree, executed');

  await t('C1', 'the Cloudflare portal endpoints answer 501 on the edge', async () => {
    const req = new Request('https://imk.test/api/portal/testimonials?projectId=p1', {
      headers: { origin: BASE, cookie: 'imk_session=nope' },
    });
    const get = await cf.cfTestimonialsGet({ request: req, env: cfEnv() });
    assertEqual(get.status, 501, 'the GET status');
    const getBody = await get.json();
    assertEqual(getBody.code, 'unimplemented', 'the GET code');

    const post = await cf.cfTestimonialsPost({
      request: new Request('https://imk.test/api/portal/testimonials', {
        method: 'POST',
        headers: { origin: BASE, cookie: 'imk_session=nope', 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'submit', projectId: 'p1', review: 'x', rating: 5, consent: { p1: true, p2: true } }),
      }),
      env: cfEnv(),
    });
    assertEqual(post.status, 501, 'the POST status');

    // The invite door is owner-only: an owner session must reach the 501.
    const ownerToken = cf.cfSession.createSession('owner@imk.test', 'admin');
    const invites = await cf.cfInvitesPost({
      request: new Request('https://imk.test/api/portal/invites', {
        method: 'POST',
        headers: {
          origin: BASE,
          cookie: `imk_admin_session=${ownerToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ email: 'someone@client.test' }),
      }),
      env: cfEnv(),
    });
    assertEqual(invites.status, 501, 'the invites status for an owner');
    const invitesBody = await invites.json();
    assertEqual(invitesBody.code, 'unimplemented', 'the invites code');

    // And a client session may not invite at all.
    const clientToken = cf.cfSession.createSession('client@client.test', 'client', 'cli_1');
    const forbidden = await cf.cfInvitesPost({
      request: new Request('https://imk.test/api/portal/invites', {
        method: 'POST',
        headers: {
          origin: BASE,
          cookie: `imk_session=${clientToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ email: 'someone@client.test' }),
      }),
      env: cfEnv(),
    });
    assertEqual(forbidden.status, 403, 'a client may not invite');

    const projects = await cf.cfProjectsGet({
      request: new Request('https://imk.test/api/portal/projects', {
        headers: { origin: BASE, cookie: `imk_admin_session=${ownerToken}` },
      }),
      env: cfEnv(),
    });
    assertEqual(projects.status, 501, 'the projects status');
    const projectsBody = await projects.json();
    assertEqual(projectsBody.code, 'unimplemented', 'the projects code');

    // EVERY read path must say 501 as well. An unreachable store that
    // answers 200 with an empty list is a silent outage (audit M3 / QA D3).
    const reads = [
      ['comments', cf.cfCommentsGet, 'https://imk.test/api/portal/comments?projectId=p1'],
      ['plan-items', cf.cfPlanItemsGet, 'https://imk.test/api/portal/plan-items?projectId=p1'],
      ['updates', cf.cfUpdatesGet, 'https://imk.test/api/portal/updates?projectId=p1'],
    ];
    for (const [name, handler, url] of reads) {
      const res = await handler({
        request: new Request(url, { headers: { origin: BASE, cookie: `imk_admin_session=${ownerToken}` } }),
        env: cfEnv(),
      });
      assertEqual(res.status, 501, `the ${name} status`);
      const body = await res.json();
      assertEqual(body.code, 'unimplemented', `the ${name} code`);
    }

    // The sign-in door too: "nobody is invited" must not be the answer when
    // the invite list simply cannot be read.
    const signIn = await cf.cfAuthPost({
      request: new Request('https://imk.test/api/portal/auth/request-link', {
        method: 'POST',
        headers: { origin: BASE, 'content-type': 'application/json', 'CF-Connecting-IP': '198.51.100.5' },
        body: JSON.stringify({ email: 'someone@client.test' }),
      }),
      env: cfEnv(),
    });
    assertEqual(signIn.status, 501, 'the sign-in status');
    const signInBody = await signIn.json();
    assertEqual(signInBody.code, 'unimplemented', 'the sign-in code');

    return 'every portal read/write path answers 501 {code:unimplemented}';
  });

  await t('C2', 'the 501 is the missing store, not a broken handler', async () => {
    // Give the Cloudflare code the filesystem it does not have on the edge.
    globalThis.require = (id) => require(id);
    try {
      const res = await cf.cfTestimonialsGet({
        request: new Request('https://imk.test/api/portal/testimonials?projectId=p1', {
          headers: { origin: BASE },
        }),
        env: cfEnv(),
      });
      assertEqual(res.status, 401, 'with a filesystem the handler runs and reaches its auth check');
      const body = await res.json();
      assertEqual(body.code, 'unauthorized', 'the auth check answered');
    } finally {
      delete globalThis.require;
    }
    assertEqual(typeof globalThis.require, 'undefined', 'the edge state must be restored');
    return 'runs, reaches the auth check (401) once a store exists';
  });

  await t('C3', 'the Cloudflare sign-in limiter is KV-backed and survives a cold start', async () => {
    const kv = fakeKv();
    const env = cfEnv({ KV_COUNTER: kv });
    const statuses = [];
    for (let i = 0; i < 6; i += 1) {
      const res = await cf.cfAuthPost({
        request: new Request('https://imk.test/api/portal/auth/request-link', {
          method: 'POST',
          headers: {
            origin: BASE,
            'content-type': 'application/json',
            'CF-Connecting-IP': '203.0.113.42',
            'x-forwarded-for': '203.0.113.42',
          },
          body: JSON.stringify({ email: `client${i}@client.test` }),
        }),
        env,
      });
      statuses.push(res.status);
    }
    assertEqual(statuses[5], 429, 'the 6th request from one IP must be rate-limited');
    const body = await cf.cfAuthPost({
      request: new Request('https://imk.test/api/portal/auth/request-link', {
        method: 'POST',
        headers: {
          origin: BASE,
          'content-type': 'application/json',
          'CF-Connecting-IP': '203.0.113.42',
        },
        body: JSON.stringify({ email: 'client6@client.test' }),
      }),
      env,
    });
    assertEqual((await body.clone().json()).code, 'rate-limit', 'the 429 must carry the rate-limit code');
    assert(kv.store.size >= 1, 'the counter must live in the KV binding');
    for (const key of kv.store.keys()) {
      assert(!key.includes('203.0.113.42'), `the raw IP must not be in KV: ${key}`);
    }
    return `statuses=${statuses.join(',')}, kv keys=${kv.store.size}`;
  });

  await t('C4', 'the Cloudflare moderation endpoint accepts a Vercel-signed link and rejects a forged one', async () => {
    const ts = Math.floor(Date.now() / 1000);
    const ref = 'rev_cfparity';
    const vercelUrl = cf.vercelNotifications.moderationUrl(ref, 'approve', 1, ts);
    assert(new URL(vercelUrl).searchParams.get('sig'), 'the Vercel link must carry a signature');

    // The DECISION is the POST (M-1, wave-8A): a GET only shows the
    // confirmation page. The edge has no moderation store, so the POST fails
    // at the STORE, never at the signature.
    const accepted = await cf.cfModeratePost({
      request: new Request(vercelUrl, { method: 'POST' }),
      env: cfEnv(),
    });
    // The signature passed, so the handler got past the signature check and
    // failed later on the store. On the edge there is NO store (no
    // filesystem): that is 501 {code:'unimplemented'}, never "review not
    // found" - the owner must never be told their pending quote is gone.
    assert(accepted.status !== 400, `a Vercel-signed link must not be rejected: ${accepted.status}`);
    const acceptedBody = await accepted.json();
    assertEqual(accepted.status, 501, 'the edge has no moderation store');
    assertEqual(acceptedBody.code, 'unimplemented', 'the missing-store code');

    // The same link as a GET: the confirmation page path. On the edge it
    // fails at the store as well -- but it must never be a DECISION.
    const scanned = await cf.cfModerateGet({
      request: new Request(vercelUrl),
      env: cfEnv(),
    });
    assert(scanned.status !== 400, `a prefetched link must not be rejected: ${scanned.status}`);
    assertEqual(scanned.status, 501, 'the GET must fail at the store, exactly like the POST');

    const forged = await cf.cfModeratePost({
      request: new Request(
        `https://imk.test/api/moderate/review?ref=${ref}&decision=approve&revision=1&sig=${'0'.repeat(64)}&ts=${ts}`,
        { method: 'POST' },
      ),
      env: cfEnv(),
    });
    assertEqual(forged.status, 400, 'a forged signature must be rejected');
    const forgedBody = await forged.json();
    assertEqual(forgedBody.code, 'signature', 'the forged link must fail on the signature');
    return 'vercel link accepted by the POST, prefetched GET decides nothing, forged link rejected';
  });

  await t('C6', 'the Cloudflare session endpoint answers the same codes as the Vercel tree', async () => {
    // GET /api/portal/session (wave-8A): the server truth about the requester.
    const ownerToken = cf.cfSession.createSession('owner@imk.test', 'admin');
    const clientToken = cf.cfSession.createSession('client@client.test', 'client', 'cli_1');

    const owner = await cf.cfSession.onRequestGet({
      request: new Request('https://imk.test/api/portal/session', {
        headers: { cookie: `imk_admin_session=${ownerToken}` },
      }),
      env: cfEnv(),
    });
    assertEqual(owner.status, 200, 'the owner must get 200');
    const ownerBody = await owner.json();
    assertEqual(ownerBody.role, 'admin', 'the role');
    assertEqual(ownerBody.email, 'owner@imk.test', 'the e-mail');
    assertEqual(ownerBody.authenticated, true, 'authenticated');

    const client = await cf.cfSession.onRequestGet({
      request: new Request('https://imk.test/api/portal/session', {
        headers: { cookie: `imk_session=${clientToken}` },
      }),
      env: cfEnv(),
    });
    assertEqual(client.status, 200, 'a client must get 200');
    const clientBody = await client.json();
    assertEqual(clientBody.role, 'client', 'the role');
    assertEqual(clientBody.clientId, 'cli_1', 'the clientId');

    const none = await cf.cfSession.onRequestGet({
      request: new Request('https://imk.test/api/portal/session'),
      env: cfEnv(),
    });
    assertEqual(none.status, 401, 'no session must get 401');
    assertEqual((await none.json()).code, 'unauthorized', 'the code');

    const wrongMethod = await cf.cfSession.onRequest({
      request: new Request('https://imk.test/api/portal/session', { method: 'POST' }),
      env: cfEnv(),
    });
    assertEqual(wrongMethod.status, 405, 'a wrong method must get 405');
    assertEqual((await wrongMethod.json()).code, 'method', 'the code');

    const misconfigured = await cf.cfSession.onRequestGet({
      request: new Request('https://imk.test/api/portal/session', {
        headers: { cookie: `imk_admin_session=${ownerToken}` },
      }),
      env: cfEnv({ ADMIN_EMAILS: '' }),
    });
    assertEqual(misconfigured.status, 500, 'an unset allow-list must get 500');
    assertEqual((await misconfigured.json()).code, 'internal', 'the code');

    // H-1: an unusable signing secret is a misconfiguration too, not a
    // silent "signed out".
    const shortSecret = await cf.cfSession.onRequestGet({
      request: new Request('https://imk.test/api/portal/session', {
        headers: { cookie: `imk_admin_session=${ownerToken}` },
      }),
      env: cfEnv({ PORTAL_SESSION_SECRET: 'too-short-session' }),
    });
    assertEqual(shortSecret.status, 500, 'a short signing secret must get 500');
    assertEqual((await shortSecret.json()).code, 'internal', 'the code');

    return 'owner 200, client 200, no cookie 401, wrong method 405, unset allow-list 500, short secret 500';
  });

  await t('C5', 'a corrupt Cloudflare moderation store answers 500 storage, never "review not found"', async () => {
    const ts = Math.floor(Date.now() / 1000);
    const ref = 'rev_corrupt1';
    const vercelUrl = cf.vercelNotifications.moderationUrl(ref, 'approve', 1, ts);

    // The edge has no filesystem at all: the store cannot be reached. That
    // is 501 (missing store), not 404 (no such quote).
    const unreachable = await cf.cfModerateGet({ request: new Request(vercelUrl), env: cfEnv() });
    assertEqual(unreachable.status, 501, 'an unreachable store must answer 501');
    const unreachableBody = await unreachable.json();
    assertEqual(unreachableBody.code, 'unimplemented', 'the unreachable-store code');

    // With a store that cannot be PARSED: 500 storage, the same answer the
    // Vercel tree gives. This was the last lenient JSONL reader in the repo
    // (QA wave-3 D-1): it swallowed the bad line and answered 404, so a
    // pending quote looked gone.
    globalThis.require = (id) => {
      if (id === 'node:fs') {
        return {
          existsSync: () => true,
          readFileSync: () => '{ this line is not json\n',
          writeFileSync: () => {},
          mkdirSync: () => {},
          renameSync: () => {},
        };
      }
      return require(id);
    };
    try {
      const corrupt = await cf.cfModerateGet({ request: new Request(vercelUrl), env: cfEnv() });
      const body = await corrupt.json();
      assertEqual(corrupt.status, 500, `a corrupt store must answer 500, got ${corrupt.status}`);
      assertEqual(body.code, 'storage', 'the corrupt-store code');
    } finally {
      delete globalThis.require;
    }
    return 'unreachable store -> 501, corrupt store -> 500 storage';
  });

  group('D — the moderation link contract, across both targets');

  await t('D1', 'a Cloudflare-signed link verifies with the Vercel verifier', async () => {
    const ts = Math.floor(Date.now() / 1000);
    const ref = 'rev_cross1';
    const url = await cf.cfNotifications.buildModerationUrl(cfEnv(), ref, 'approve', 3, ts);
    const sig = new URL(url).searchParams.get('sig');
    const ok = cf.vercelNotifications.verifyModerationSignature(ref, 'approve', 3, ts, sig);
    assertEqual(ok, true, 'the Vercel verifier must accept the Cloudflare signature');
    return `sig=${String(sig).slice(0, 12)}…`;
  });

  await t('D2', 'a Vercel-signed link verifies with the Cloudflare verifier', async () => {
    const ts = Math.floor(Date.now() / 1000);
    const ref = 'rev_cross2';
    const url = cf.vercelNotifications.moderationUrl(ref, 'approve', 4, ts);
    const sig = new URL(url).searchParams.get('sig');
    const ok = await cf.cfNotifications.verifyModerationSignature(cfEnv(), ref, 'approve', 4, ts, sig);
    assertEqual(ok, true, 'the Cloudflare verifier must accept the Vercel signature');
    return `sig=${String(sig).slice(0, 12)}…`;
  });

  await t('D3', 'both trees build the same link shape, from SITE_BASE_URL', async () => {
    const ts = Math.floor(Date.now() / 1000);
    const ref = 'rev_cross3';
    const vercelUrl = new URL(cf.vercelNotifications.moderationUrl(ref, 'reject', 2, ts));
    const cfUrl = new URL(await cf.cfNotifications.buildModerationUrl(cfEnv(), ref, 'reject', 2, ts));
    const vercelParams = [...vercelUrl.searchParams.keys()].sort();
    const cfParams = [...cfUrl.searchParams.keys()].sort();
    assertEqual(cfParams.join(','), vercelParams.join(','), 'the query parameters must match');
    assertEqual(cfParams.join(','), 'decision,ref,revision,sig,ts', 'the expected parameter set');
    assertEqual(vercelUrl.origin + vercelUrl.pathname, cfUrl.origin + cfUrl.pathname, 'the link target must match');
    assertEqual(cfUrl.origin, 'https://imk.test', 'the link must follow SITE_BASE_URL');
    assertEqual(vercelUrl.searchParams.get('sig'), cfUrl.searchParams.get('sig'), 'both trees must sign identically');
    return `params=${cfParams.join(',')}`;
  });

  await t('D4', 'the Cloudflare notification mail carries the revision and a link that verifies', async () => {
    resendCalls.length = 0;
    await cf.cfNotifications.notifyReviewSubmitted(cfEnv(), {
      ref: 'rev_mail1',
      name: 'Nora Named',
      rating: '5',
      review: 'A quote that reached the owner.',
      revision: 2,
    });
    const call = resendCalls.find((c) => String(c.href).includes('api.resend.com'));
    assert(call, 'the owner must be notified');
    const body = JSON.parse(call.init.body);
    const text = String(body.text || '');
    const html = String(body.html || '');
    assert(text.includes('revision 2'), 'the mail must say which revision the links are about');
    const url = (html.match(/href="([^"]*\/api\/moderate\/review[^"]*)"/) || [])[1] || '';
    assert(url, 'the mail must carry the one-click link');
    const parsed = new URL(url.replace(/&amp;/g, '&'));
    assertEqual(parsed.searchParams.get('revision'), '2', 'the link must be bound to the revision');
    const ok = await cf.cfNotifications.verifyModerationSignature(
      cfEnv(),
      'rev_mail1',
      'approve',
      2,
      Number(parsed.searchParams.get('ts')),
      parsed.searchParams.get('sig'),
    );
    assertEqual(ok, true, 'the link in the mail must verify');
    return 'revision carried and link verifies';
  });

  await t('D5', 'a link signed for revision 1 does not verify for revision 2', async () => {
    const ts = Math.floor(Date.now() / 1000);
    const ref = 'rev_cross4';
    const url = new URL(cf.vercelNotifications.moderationUrl(ref, 'approve', 1, ts));
    const sig = url.searchParams.get('sig');
    const sameRevision = cf.vercelNotifications.verifyModerationSignature(ref, 'approve', 1, ts, sig);
    const otherRevision = cf.vercelNotifications.verifyModerationSignature(ref, 'approve', 2, ts, sig);
    const otherDecision = cf.vercelNotifications.verifyModerationSignature(ref, 'reject', 1, ts, sig);
    const cfOtherRevision = await cf.cfNotifications.verifyModerationSignature(cfEnv(), ref, 'approve', 2, ts, sig);
    assertEqual(sameRevision, true, 'the link must verify for its own revision');
    assertEqual(otherRevision, false, 'it must not verify for another revision');
    assertEqual(otherDecision, false, 'it must not verify for another decision');
    assertEqual(cfOtherRevision, false, 'the edge verifier must refuse it too');
    return 'revision and decision are both covered by the signature';
  });

  globalThis.fetch = realFetch;

  const failed = results.filter((r) => r.status === 'FAIL');
  origLog(`\n[qa] ${results.length - failed.length} passed, ${failed.length} failed, ${results.length} checks`);
  if (failed.length) {
    origLog('[qa] failing checks: ' + failed.map((f) => f.id).join(', '));
  }
  try {
    fs.rmSync(SANDBOX, { recursive: true, force: true });
    origLog('[qa] sandbox removed');
  } catch {
    origLog('[qa] sandbox left behind: ' + SANDBOX);
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  origLog('[qa] harness error', err);
  process.exit(1);
});
