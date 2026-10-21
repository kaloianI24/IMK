// site/qa/qa-mutation-probe.mjs
//
// QA MUTATION PROBE -- proves that the wave-2 checks are not vacuous.
//
// A green suite only means something if a broken build would make it red.
// This script copies the api/ tree and the publish script into a TEMP
// DIRECTORY, puts a known defect back, and re-runs the independent suite
// against the patched copy. The expected result is a FAILURE in the checks
// that cover the defect.
//
// The repo is NEVER modified: the patch is applied to a copy under the
// system temp directory, and the copy is removed afterwards.
//
// PROBES
//   P1  M5  the stale-revision guard is removed from the moderation handler
//           -> M1/M2/M3 (a stale link must not approve) must FAIL
//   P2  m2  the publish script skips a malformed line instead of failing
//           -> N1/N2/N3 (a malformed store must refuse to publish) must FAIL
//   P3  m6  the rate-limit slot is consumed BEFORE validation
//           -> O3 (an invalid request must burn no slot) must FAIL
//   P4  4.7.1 the rate limiter never blocks
//           -> O4 (the 6th valid submission must be rate-limited) must FAIL
//   P5  M-1  the GET decides again (the confirmation page is gone)
//           -> M4b (a GET must decide NOTHING) must FAIL
//
// USAGE
//   node site/qa/qa-mutation-probe.mjs

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.resolve(__dirname, '..');
const REPO = path.resolve(SITE, '..');

const WORK = path.join(os.tmpdir(), 'opencode', `qa-mutation-${Date.now()}`);

function rmrf(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dst);
    else fs.copyFileSync(src, dst);
  }
}

/**
 * Copy the handler tree in a way that keeps the RELATIVE layout intact.
 * api/lib/jsonl.ts imports ../../site/shared/portal-store/jsonl.js, so the
 * shared tree has to travel with it under the same root.
 */
function copyApiTree(root) {
  copyDir(path.join(REPO, 'api'), path.join(root, 'api'));
  copyDir(path.join(REPO, 'site', 'shared'), path.join(root, 'site', 'shared'));
}

function patch(file, from, to) {
  const raw = fs.readFileSync(file, 'utf8');
  if (!raw.includes(from)) {
    throw new Error(`the patch anchor was not found in ${file}: ${from.slice(0, 60)}`);
  }
  fs.writeFileSync(file, raw.replace(from, to), 'utf8');
}

/** Run the independent suite and return its results. */
function runSuite(env) {
  const out = path.join(WORK, `results-${Object.keys(env).join('-')}.json`);
  let code = 0;
  try {
    execFileSync(
      process.execPath,
      [path.join(SITE, 'qa', 'qa-wave2-independent.mjs'), '--json', out],
      {
        cwd: SITE,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...env },
      },
    );
  } catch (err) {
    code = typeof err.status === 'number' ? err.status : 1;
  }
  const results = JSON.parse(fs.readFileSync(out, 'utf8'));
  return { code, results };
}

function statusOf(results, id) {
  const r = results.results.find((x) => x.id === id);
  return r ? r.status : 'MISSING';
}

const probes = [];
let allGood = true;

try {
  // =====================================================================
  // PROBE 1 -- M5: remove the stale-revision guard
  // =====================================================================
  const p1Root = path.join(WORK, 'p1');
  copyApiTree(p1Root);
  const apiCopy = path.join(p1Root, 'api');
  patch(
    path.join(apiCopy, 'moderate', 'review.ts'),
    'if (currentRevision !== revision) {',
    'if (false) {',
  );
  const p1 = runSuite({ QA_API_DIR: apiCopy, QA_PORT: '4431' });
  const p1ExpectFail = ['M1', 'M2'];
  const p1Ok = p1ExpectFail.every((id) => statusOf(p1.results, id) === 'FAIL');
  const p1AllFailed = p1.results.results
    .filter((r) => r.status === 'FAIL')
    .map((r) => r.id)
    .join(', ');
  probes.push({
    probe: 'P1',
    defect: 'M5 - the stale-revision guard is removed',
    expect: `${p1ExpectFail.join(', ')} must FAIL`,
    actual: p1ExpectFail.map((id) => `${id}=${statusOf(p1.results, id)}`).join(' '),
    allFailed: p1AllFailed,
    total: `${p1.results.passed} passed / ${p1.results.failed} failed`,
    ok: p1Ok,
  });
  if (!p1Ok) allGood = false;

  // =====================================================================
  // PROBE 2 -- m2: the publish script skips a malformed line
  // =====================================================================
  const pubCopy = path.join(WORK, 'p2', 'publish-testimonials.mjs');
  fs.mkdirSync(path.dirname(pubCopy), { recursive: true });
  fs.copyFileSync(path.join(SITE, 'scripts', 'publish-testimonials.mjs'), pubCopy);
  patch(
    pubCopy,
    `    try {
      records.push(JSON.parse(line));
    } catch {
      throw new Error(
        \`\${file} line \${index + 1} is not valid JSON — \` +
          'refusing to publish a partial set of testimonials. Fix or remove that line.',
      );
    }`,
    `    try {
      records.push(JSON.parse(line));
    } catch {
      // MUTATION: the pre-fix behaviour -- skip the broken line.
    }`,
  );
  const p2 = runSuite({ QA_PUBLISH_SCRIPT: pubCopy, QA_PORT: '4432' });
  const p2ExpectFail = ['N1', 'N2', 'N3'];
  const p2Ok = p2ExpectFail.every((id) => statusOf(p2.results, id) === 'FAIL');
  probes.push({
    probe: 'P2',
    defect: 'm2 - the publish script skips a malformed line instead of failing',
    expect: `${p2ExpectFail.join(', ')} must FAIL`,
    actual: p2ExpectFail.map((id) => `${id}=${statusOf(p2.results, id)}`).join(' '),
    allFailed: p2.results.results
      .filter((r) => r.status === 'FAIL')
      .map((r) => r.id)
      .join(', '),
    total: `${p2.results.passed} passed / ${p2.results.failed} failed`,
    ok: p2Ok,
  });
  if (!p2Ok) allGood = false;

  // =====================================================================
  // PROBE 3 -- m6: the rate-limit slot is consumed before validation
  // =====================================================================
  const p3Root = path.join(WORK, 'p3');
  copyApiTree(p3Root);
  const tsFile = path.join(p3Root, 'api', 'portal', 'testimonials.ts');
  patch(
    tsFile,
    `      if (!consent.p1) {
        // No consent to publish the quote — nothing is stored, nothing is sent.
        json(res, { error: 'consent required', code: 'consent-required' }, 400);
        return;
      }`,
    `      // MUTATION: the pre-fix behaviour -- the slot is charged before the
      // request is validated.
      await rateLimiter.consume(
        rateKey('submit', session.clientId || session.email),
        SUBMIT_RATE_LIMIT,
        SUBMIT_RATE_WINDOW_MS,
      );
      if (!consent.p1) {
        json(res, { error: 'consent required', code: 'consent-required' }, 400);
        return;
      }`,
  );
  const p3 = runSuite({ QA_API_DIR: path.join(p3Root, 'api'), QA_PORT: '4433' });
  const p3ExpectFail = ['O3'];
  const p3Ok = p3ExpectFail.every((id) => statusOf(p3.results, id) === 'FAIL');
  probes.push({
    probe: 'P3',
    defect: 'm6 - the rate-limit slot is consumed before validation',
    expect: `${p3ExpectFail.join(', ')} must FAIL`,
    actual: p3ExpectFail.map((id) => `${id}=${statusOf(p3.results, id)}`).join(' '),
    allFailed: p3.results.results
      .filter((r) => r.status === 'FAIL')
      .map((r) => r.id)
      .join(', '),
    total: `${p3.results.passed} passed / ${p3.results.failed} failed`,
    ok: p3Ok,
  });
  if (!p3Ok) allGood = false;

  // =====================================================================
  // PROBE 4 -- the rate limiter never blocks (spec/08 4.7.1)
  // =====================================================================
  const p4Root = path.join(WORK, 'p4');
  copyApiTree(p4Root);
  patch(
    path.join(p4Root, 'api', 'lib', 'rate-limit.ts'),
    `    return {
      allowed: count <= limit,`,
    `    return {
      // MUTATION: the limiter never blocks.
      allowed: true,`,
  );
  const p4 = runSuite({ QA_API_DIR: path.join(p4Root, 'api'), QA_PORT: '4434' });
  const p4ExpectFail = ['O4'];
  const p4Ok = p4ExpectFail.every((id) => statusOf(p4.results, id) === 'FAIL');
  probes.push({
    probe: 'P4',
    defect: 'the rate limiter never blocks',
    expect: `${p4ExpectFail.join(', ')} must FAIL`,
    actual: p4ExpectFail.map((id) => `${id}=${statusOf(p4.results, id)}`).join(' '),
    allFailed: p4.results.results
      .filter((r) => r.status === 'FAIL')
      .map((r) => r.id)
      .join(', '),
    total: `${p4.results.passed} passed / ${p4.results.failed} failed`,
    ok: p4Ok,
  });
  if (!p4Ok) allGood = false;

  // =====================================================================
  // PROBE 5 -- M-1: the GET decides again
  // =====================================================================
  // Before wave-8A a plain GET on the signed link WAS the approval, so every
  // mail scanner published the owner's quotes. The GET now only shows the
  // confirmation page. If that guard is removed, the check that says "a GET
  // decides NOTHING" must go red -- otherwise the check proves nothing.
  const p5Root = path.join(WORK, 'p5');
  copyApiTree(p5Root);
  patch(
    path.join(p5Root, 'api', 'moderate', 'review.ts'),
    `  if (method === 'GET') {`,
    `  if (false) { // MUTATION: the GET decides again`,
  );
  const p5 = runSuite({ QA_API_DIR: path.join(p5Root, 'api'), QA_PORT: '4435' });
  const p5ExpectFail = ['M4b'];
  const p5Ok = p5ExpectFail.every((id) => statusOf(p5.results, id) === 'FAIL');
  probes.push({
    probe: 'P5',
    defect: 'M-1 - the confirmation page is gone and a GET decides again',
    expect: `${p5ExpectFail.join(', ')} must FAIL`,
    actual: p5ExpectFail.map((id) => `${id}=${statusOf(p5.results, id)}`).join(' '),
    allFailed: p5.results.results
      .filter((r) => r.status === 'FAIL')
      .map((r) => r.id)
      .join(', '),
    total: `${p5.results.passed} passed / ${p5.results.failed} failed`,
    ok: p5Ok,
  });
  if (!p5Ok) allGood = false;
} catch (err) {
  console.error('[qa] PROBE ERROR', err && err.stack ? err.stack : err);
  allGood = false;
} finally {
  rmrf(WORK);
}

console.log('');
for (const p of probes) {
  console.log(
    `[qa] ${p.ok ? 'PROBE PASS' : 'PROBE FAIL'} ${p.probe}  ${p.defect}\n` +
      `         expected: ${p.expect}\n` +
      `         actual:   ${p.actual}   (${p.total})\n` +
      `         all failing checks: ${p.allFailed || 'none'}`,
  );
}
console.log(
  `\n[qa] ${probes.filter((p) => p.ok).length}/${probes.length} mutation probes behaved as expected`,
);

process.exit(allGood ? 0 : 1);
