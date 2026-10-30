// site/qa/qa-anchor-nonvacuity.mjs
//
// QA INDEPENDENT PROOF that the mutation anchors still BITE.
//
// A mutation probe only earns its run if a BROKEN product makes the check
// RED. For EACH anchor this tool proves three things, and it NEVER touches
// the shipped tree -- every break is injected into a scratch copy under the
// system temp directory:
//
//   1. CONTROL  the UNMODIFIED copy still passes the checks (so a failure
//               later is caused by the break, not by the copy)
//   2. MUTANT   the break, injected into a scratch copy, makes the checks
//               RED (this is the non-vacuity proof)
//   3. LIVENESS the anchor is load-bearing: when the product text it
//               points at drifts away, the probe FAILS LOUDLY instead of
//               silently passing (a stale anchor must never be a rubber
//               stamp)
//
// THE ANCHORS UNDER TEST
//   P2  site/qa/qa-mutation-probe.mjs
//       The patch anchor is the PUBLISHER'S ERROR TEXT: the throw it makes
//       when a line of the moderation store is not valid JSON. It used to
//       name one hard-coded file ("data/moderation/reviews.jsonl"); the
//       publisher now reads the store, so the message interpolates the file
//       it was reading. The DEFECT the probe puts back is unchanged: the
//       publisher SKIPS a malformed line instead of refusing to publish.
//
//   D2  site/qa/qa-wave5-independent.mjs
//       The patch anchor used to be `writeReviews()` in
//       api/moderate/review.ts. Wave 9 moved the write into the store, so
//       that function is gone; the DEFECT (F-3: a store failure that escapes
//       the handler) now lives in `guardStore()` in
//       site/shared/server/portal-store-access.ts. The probe puts the
//       unguarded store failure back and expects the unwritable-store check
//       (B4) to go RED.
//
//   P1  site/qa/qa-mutation-probe.mjs (re-pinned in wave 11)
//       The stale-revision guard has TWO layers since wave 10, F-2: the
//       HANDLER (api/moderate/review.ts refuses a link for another
//       revision) and the STORE (site/shared/portal-store/file-adapter.ts
//       scopes the flip to the revision that was verified). Removing one
//       layer is not enough to make the checks red -- the other one still
//       refuses -- so the probe removes BOTH. This tool proves that BOTH
//       layers are load-bearing (each one alone keeps M1/M2 green) and that
//       the two anchors fail LOUDLY when the product text drifts.
//
//   E14 site/qa/qa-admin-independent.mjs (re-pinned in wave 11)
//       Wave 10, F-6 rewrote the Cloudflare twin of the owner's inbox: the
//       JSONL read is GONE and that target answers 501 {code:'unimplemented'}
//       instead of a queue. E14 was re-pinned to that contract, and this
//       tool proves the re-pin still bites: a JSONL read put back into the
//       CF inbox turns E14 RED.
//
//   R11 site/qa/qa-wave13-routing.mjs (wave 15, B-1)
//       The EMPTY carrier rule has TWO halves: the ENTRY POINT tests the
//       query carrier for PRESENCE (`!== null`), and the RESOLVER refuses
//       the empty one with a clean 404. Reverting EITHER half must turn
//       R11 RED, and both anchors must fail LOUDLY when the product text
//       drifts.
//
// The repository is byte-compared before and after the run.
//
// USAGE
//   node site/qa/qa-anchor-nonvacuity.mjs [--json <ABSOLUTE path>]

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.resolve(__dirname, '..');
const REPO = path.resolve(SITE, '..');

const argv = process.argv.slice(2);
const JSON_OUT = argv.includes('--json')
  ? path.resolve(argv[argv.indexOf('--json') + 1])
  : null;

const WORK = path.join(os.tmpdir(), 'opencode', `qa-anchor-nonvacuity-${Date.now()}`);

// ---------------------------------------------------------------------------
// helpers (QA's own; deliberately independent of the two probe files)
// ---------------------------------------------------------------------------

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

/** A digest of every file under a root -- used to prove the repo is untouched. */
function treeDigest(root) {
  const parts = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        parts.push(
          `${path.relative(root, full)}:${crypto
            .createHash('sha256')
            .update(fs.readFileSync(full))
            .digest('hex')}`,
        );
      }
    }
  };
  walk(root);
  return parts.join('\n');
}

const REPO_TREES = [
  path.join(REPO, 'api'),
  path.join(SITE, 'shared'),
  path.join(SITE, 'scripts'),
  path.join(SITE, 'functions'),
];

function repoDigest() {
  return REPO_TREES.map((tree) => `== ${tree}\n${treeDigest(tree)}`).join('\n');
}

/**
 * The probe's own patch(): it throws when the anchor is NOT found.
 * That is the loud-failure property this tool measures.
 */
function patch(file, from, to) {
  const raw = fs.readFileSync(file, 'utf8');
  if (!raw.includes(from)) {
    throw new Error(`the patch anchor was not found in ${file}: ${from.slice(0, 60)}`);
  }
  fs.writeFileSync(file, raw.replace(from, to), 'utf8');
}

/** The wave-5 suite's own replaceFunction(): brace-matched body replacement. */
function replaceFunction(file, signature, replacement) {
  const raw = fs.readFileSync(file, 'utf8');
  const at = raw.indexOf(signature);
  if (at === -1) throw new Error(`the patch anchor was not found in ${file}: ${signature}`);
  const open = raw.indexOf('{', at);
  let depth = 0;
  let end = -1;
  for (let i = open; i < raw.length; i++) {
    if (raw[i] === '{') depth++;
    else if (raw[i] === '}') {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end === -1) throw new Error(`the function body was not closed in ${file}`);
  fs.writeFileSync(file, raw.slice(0, at) + replacement + raw.slice(end), 'utf8');
}

/** Run a QA suite and return its parsed report. */
function runSuite(script, args, env) {
  const out = path.join(WORK, `report-${crypto.randomBytes(4).toString('hex')}.json`);
  let code = 0;
  let stdout = '';
  try {
    stdout = execFileSync(process.execPath, [script, '--json', out, ...args], {
      cwd: SITE,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
  } catch (err) {
    code = typeof err.status === 'number' ? err.status : 1;
    stdout = `${stdout || ''}${err.stdout || ''}${err.stderr || ''}`;
  }
  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(out, 'utf8'));
  } catch (err) {
    throw new Error(
      `the suite produced no report (${err.message}). Its output was:\n${stdout.slice(0, 4000)}`,
    );
  }
  return { code, results: parsed.results, stdout };
}

function statusOf(results, id) {
  const r = results.find((x) => x.id === id);
  return r ? r.status : 'MISSING';
}

function errorOf(results, id) {
  const r = results.find((x) => x.id === id);
  return r && r.error ? r.error : '';
}

// ---------------------------------------------------------------------------
// the anchors, copied VERBATIM from the two probe files
// ---------------------------------------------------------------------------

/** qa-mutation-probe.mjs -- PROBE 2 (P2). */
const P2_ANCHOR = `    try {
      records.push(JSON.parse(line));
    } catch {
      throw new Error(
        \`\${file} line \${index + 1} is not valid JSON — \` +
          'refusing to publish a partial set of testimonials. Fix or remove that line.',
      );
    }`;

const P2_BREAK = `    try {
      records.push(JSON.parse(line));
    } catch {
      // QA MUTATION (m2): the publisher SKIPS the malformed line instead of
      // refusing to publish -- the defect P2 puts back.
    }`;

/** qa-wave5-independent.mjs -- check D2. */
const D2_ANCHOR = 'export async function guardStore<T>(';

const D2_BREAK = [
  'export async function guardStore<T>(',
  '  fn: () => Promise<T> | T,',
  '  onError: (err: StorageError | StorageCorruptError) => T,',
  '): Promise<T> {',
  '  // QA MUTATION (F-3): the store failure is NOT guarded — it throws',
  '  // out of the handler, exactly as the old unguarded write did.',
  '  return await fn();',
  '}',
].join('\n');

/**
 * qa-mutation-probe.mjs -- PROBE 1 (P1).
 *
 * THE GUARD HAS THREE LAYERS (wave 10 F-2, wave 12 B-1):
 *   layer 1 -- the HANDLER: api/moderate/review.ts refuses when the revision
 *              OR the record identity in the signed link is not the one in
 *              the store (409 stale-revision).
 *   layer 2 -- the STORE's revision scope: the file adapter flips only the
 *              revision that was verified.
 *   layer 3 -- the STORE's identity scope: the file adapter flips only the
 *              RECORD the link names.
 *
 * Removing ONE layer is not enough to make the checks red -- the others still
 * refuse -- so the probe removes all three, and the half proofs below show
 * that each of them is load-bearing on its own.
 */
const P1_HANDLER_ANCHOR = 'if (currentRevision !== revision || identityStale) {';
const P1_HANDLER_BREAK = 'if (false) {';

/** qa-mutation-probe.mjs -- PROBE 1 (P1), layer 2: the store's revision scope. */
const P1_STORE_ANCHOR =
  'if (expectedRevision !== undefined && revisionNumber(record) !== expectedRevision) {';
const P1_STORE_BREAK = 'if (false) {';

/** qa-mutation-probe.mjs -- PROBE 1 (P1), layer 3: the store's identity scope. */
const P1_IDENTITY_ANCHOR = `      if (expectedRecordId !== undefined && expectedRecordId !== '') {
        if (recordIdentity(record) !== expectedRecordId) return null;
      }`;
const P1_IDENTITY_BREAK = `      if (false) {
        return null;
      }`;

/**
 * qa-admin-independent.mjs -- the E14 mutation anchor: the Cloudflare
 * inbox's 501 answer (wave 10, F-6 removed the JSONL read on purpose).
 *
 * The BREAK is the defect the mutation probe puts back: a JSONL read in the
 * CF inbox, answering 200 with a queue. It is VERBATIM the same text the
 * probe in qa-admin-independent.mjs uses -- the two files must agree.
 */
const E14_ANCHOR = `  return json(
    { error: 'moderation store unavailable on this target', code: 'unimplemented' },
    501,
  );`;

const E14_BREAK = `  // QA MUTATION (wave 10, F-6): the JSONL read is back.
  const edgeRequire = (globalThis as any).require;
  const edgeFs: any = edgeRequire ? edgeRequire('node:fs') : null;
  const reviewsFile = 'site/data/moderation/reviews.jsonl';
  if (!edgeFs || !edgeFs.existsSync(reviewsFile)) {
    return json(
      { error: 'moderation store unavailable on this target', code: 'unimplemented' },
      501,
    );
  }
  const records: Array<Record<string, any>> = edgeFs
    .readFileSync(reviewsFile, 'utf8')
    .split(/\\r?\\n/)
    .filter((line: string) => line.trim())
    .map((line: string) => JSON.parse(line));
  const pending = records.filter(
    (r: any) => r && r.type === 'review' && r.state === 'pending',
  );
  return json(
    {
      ok: true,
      counts: { pendingReviews: pending.length, decidedToday: 0, openNotes: null },
      notesAvailable: false,
      reviews: pending,
      recent: [],
    },
    200,
  );`;

// ---------------------------------------------------------------------------

const findings = [];
let allGood = true;

function record(finding) {
  findings.push(finding);
  if (!finding.ok) allGood = false;
  console.log(
    `[qa] ${finding.ok ? 'PROOF PASS' : 'PROOF FAIL'}  ${finding.id}  ${finding.what}\n` +
      `         ${finding.detail}`,
  );
}

try {
  fs.mkdirSync(WORK, { recursive: true });
  const digestBefore = repoDigest();

  // =====================================================================
  // ANCHOR P2 -- the publisher's malformed-line error text
  // =====================================================================
  const publisher = path.join(SITE, 'scripts', 'publish-testimonials.mjs');
  const wave2 = path.join(SITE, 'qa', 'qa-wave2-independent.mjs');

  // --- 1. CONTROL: the unmodified copy still passes N1/N2/N3 ---
  const p2Control = path.join(WORK, 'p2-control.mjs');
  fs.copyFileSync(publisher, p2Control);
  const p2ControlRun = runSuite(wave2, [], { QA_PUBLISH_SCRIPT: p2Control });
  const controlIds = ['N1', 'N2', 'N3'];
  const controlOk = controlIds.every((id) => statusOf(p2ControlRun.results, id) === 'PASS');
  record({
    id: 'P2-control',
    what: 'the publisher copy (unmodified) still passes N1/N2/N3',
    ok: controlOk,
    detail:
      controlIds.map((id) => `${id}=${statusOf(p2ControlRun.results, id)}`).join(' ') +
      `   (suite exit ${p2ControlRun.code})`,
  });

  // --- 2. MUTANT: the defect, injected into a scratch copy ---
  const p2Mutant = path.join(WORK, 'p2-mutant.mjs');
  fs.copyFileSync(publisher, p2Mutant);
  let p2Patched = true;
  let p2PatchError = '';
  try {
    patch(p2Mutant, P2_ANCHOR, P2_BREAK);
  } catch (err) {
    p2Patched = false;
    p2PatchError = err.message;
  }
  const p2MutantRun = p2Patched
    ? runSuite(wave2, [], { QA_PUBLISH_SCRIPT: p2Mutant })
    : { code: 1, results: [], stdout: '' };
  const mutantOk =
    p2Patched && controlIds.every((id) => statusOf(p2MutantRun.results, id) === 'FAIL');
  record({
    id: 'P2-mutant',
    what: 'the publisher SKIPS a malformed line -> N1/N2/N3 go RED (non-vacuity proof)',
    ok: mutantOk,
    detail:
      (p2Patched
        ? controlIds.map((id) => `${id}=${statusOf(p2MutantRun.results, id)}`).join(' ')
        : `the patch did not apply: ${p2PatchError}`) +
      `   (suite exit ${p2MutantRun.code})` +
      `   all failing checks: ${
        (p2MutantRun.results || [])
          .filter((r) => r.status === 'FAIL')
          .map((r) => r.id)
          .join(', ') || 'none'
      }`,
  });

  // --- 3. LIVENESS: a reworded publisher must break the anchor LOUDLY ---
  const p2Drift = path.join(WORK, 'p2-drift.mjs');
  fs.copyFileSync(publisher, p2Drift);
  const rawPublisher = fs.readFileSync(p2Drift, 'utf8');
  fs.writeFileSync(
    p2Drift,
    rawPublisher.replace('is not valid JSON', 'is not valid JSONL'),
    'utf8',
  );
  let p2Loud = false;
  let p2LoudDetail = '';
  try {
    patch(p2Drift, P2_ANCHOR, P2_BREAK);
    p2LoudDetail = 'the anchor still matched a reworded publisher -- the anchor is NOT load-bearing';
  } catch (err) {
    p2Loud = true;
    p2LoudDetail = `the probe would abort loudly: ${err.message}`;
  }
  record({
    id: 'P2-liveness',
    what: 'if the publisher text drifts, the P2 probe FAILS LOUDLY (no silent pass)',
    ok: p2Loud,
    detail: p2LoudDetail,
  });

  // =====================================================================
  // ANCHOR D2 -- guardStore() in site/shared/server/portal-store-access.ts
  // =====================================================================
  const wave5 = path.join(SITE, 'qa', 'qa-wave5-independent.mjs');

  function copyTree(name) {
    const root = path.join(WORK, name);
    rmrf(root);
    copyDir(path.join(REPO, 'api'), path.join(root, 'api'));
    copyDir(path.join(SITE, 'shared'), path.join(root, 'site', 'shared'));
    return root;
  }

  // --- 1. CONTROL: the unmodified copy still passes the group B checks ---
  const d2ControlTree = copyTree('d2-control');
  const d2ControlRun = runSuite(
    wave5,
    ['--only', 'B'],
    {
      QA_W5_API_DIR: path.join(d2ControlTree, 'api'),
      QA_W5_SHARED_DIR: path.join(d2ControlTree, 'site', 'shared'),
    },
  );
  const d2Ids = ['B1', 'B1b', 'B2', 'B3', 'B4'];
  const d2ControlOk = d2Ids.every((id) => statusOf(d2ControlRun.results, id) === 'PASS');
  record({
    id: 'D2-control',
    what: 'the tree copy (unmodified) still passes B1/B1b/B2/B3/B4',
    ok: d2ControlOk,
    detail:
      d2Ids.map((id) => `${id}=${statusOf(d2ControlRun.results, id)}`).join(' ') +
      `   (suite exit ${d2ControlRun.code})`,
  });

  // --- 2. MUTANT: the store failure is unguarded again ---
  const d2MutantTree = copyTree('d2-mutant');
  const accessFile = path.join(
    d2MutantTree,
    'site',
    'shared',
    'server',
    'portal-store-access.ts',
  );
  let d2Patched = true;
  let d2PatchError = '';
  try {
    replaceFunction(accessFile, D2_ANCHOR, D2_BREAK);
  } catch (err) {
    d2Patched = false;
    d2PatchError = err.message;
  }
  const d2MutantRun = d2Patched
    ? runSuite(
        wave5,
        ['--only', 'B'],
        {
          QA_W5_API_DIR: path.join(d2MutantTree, 'api'),
          QA_W5_SHARED_DIR: path.join(d2MutantTree, 'site', 'shared'),
        },
      )
    : { code: 1, results: [], stdout: '' };
  const d2MutantOk =
    d2Patched &&
    statusOf(d2MutantRun.results, 'B4') === 'FAIL' &&
    statusOf(d2MutantRun.results, 'B1') === 'PASS';
  record({
    id: 'D2-mutant',
    what:
      'the store failure is unguarded again -> B4 goes RED while the control B1 stays GREEN (non-vacuity proof)',
    ok: d2MutantOk,
    detail:
      (d2Patched
        ? d2Ids.map((id) => `${id}=${statusOf(d2MutantRun.results, id)}`).join(' ')
        : `the patch did not apply: ${d2PatchError}`) +
      `   (suite exit ${d2MutantRun.code})` +
      `   B4 said: ${errorOf(d2MutantRun.results || [], 'B4').slice(0, 160)}`,
  });

  // --- 3. LIVENESS: if guardStore disappears, the D2 check must FAIL loudly ---
  const d2DriftTree = copyTree('d2-drift');
  const driftFile = path.join(
    d2DriftTree,
    'site',
    'shared',
    'server',
    'portal-store-access.ts',
  );
  fs.writeFileSync(
    driftFile,
    fs.readFileSync(driftFile, 'utf8').replace(D2_ANCHOR, 'export async function guardStoreRenamed<T>('),
    'utf8',
  );
  const d2DriftRun = runSuite(
    wave5,
    ['--only', 'D'],
    {
      QA_W5_API_DIR: path.join(d2DriftTree, 'api'),
      QA_W5_SHARED_DIR: path.join(d2DriftTree, 'site', 'shared'),
    },
  );
  const d2Loud = statusOf(d2DriftRun.results, 'D2') === 'FAIL';
  record({
    id: 'D2-liveness',
    what: 'if guardStore disappears, the D2 check FAILS loudly (no silent pass)',
    ok: d2Loud,
    detail:
      `D2=${statusOf(d2DriftRun.results, 'D2')}   ` +
      `the D2 check said: ${errorOf(d2DriftRun.results, 'D2').slice(0, 200)}`,
  });

  // --- 4. the NEW wave-9 queue check must not be vacuous either ---
  const wave9 = path.join(SITE, 'qa', 'qa-wave9-store-queue.mjs');

  const w9ControlTree = copyTree('w9-control');
  const w9ControlRun = runSuite(wave9, [], {
    QA_W9_API_DIR: path.join(w9ControlTree, 'api'),
    QA_W9_SHARED_DIR: path.join(w9ControlTree, 'site', 'shared'),
  });
  const w9ControlOk =
    w9ControlRun.code === 0 && statusOf(w9ControlRun.results, 'W9-1') === 'PASS';
  record({
    id: 'W9-1-control',
    what: 'the wave-9 queue check passes against an unmodified copy of the tree',
    ok: w9ControlOk,
    detail: `W9-1=${statusOf(w9ControlRun.results, 'W9-1')}   (suite exit ${w9ControlRun.code})`,
  });

  const w9MutantTree = copyTree('w9-mutant');
  // WAVE 13: the inbox handler moved out of api/ into
  // site/shared/portal-handlers/ -- the pin follows the file.
  const w9Inbox = path.join(
    w9MutantTree,
    'site',
    'shared',
    'portal-handlers',
    'admin-reviews.ts',
  );
  let w9Patched = true;
  let w9PatchError = '';
  try {
    patch(
      w9Inbox,
      `records = await store.list('reviews');`,
      `records = await store.list('projects');`,
    );
  } catch (err) {
    w9Patched = false;
    w9PatchError = err.message;
  }
  const w9MutantRun = w9Patched
    ? runSuite(wave9, [], {
        QA_W9_API_DIR: path.join(w9MutantTree, 'api'),
        QA_W9_SHARED_DIR: path.join(w9MutantTree, 'site', 'shared'),
      })
    : { code: 1, results: [], stdout: '' };
  const w9MutantOk =
    w9Patched &&
    w9MutantRun.code !== 0 &&
    statusOf(w9MutantRun.results, 'W9-1') === 'FAIL';
  record({
    id: 'W9-1-mutant',
    what:
      'the inbox reads a DIFFERENT collection -> the wave-9 queue check goes RED (non-vacuity proof)',
    ok: w9MutantOk,
    detail:
      (w9Patched
        ? `W9-1=${statusOf(w9MutantRun.results, 'W9-1')}`
        : `the patch did not apply: ${w9PatchError}`) +
      `   (suite exit ${w9MutantRun.code})` +
      `   failing sub-assertions: ${
        ((w9MutantRun.results || [])[0] || {}).sub
          ? ((w9MutantRun.results || [])[0].sub || [])
              .filter((s) => !s.ok)
              .map((s) => s.id)
              .join(', ')
          : 'n/a'
      }`,
  });

  // =====================================================================
  // ANCHOR P1 -- the stale-revision guard (TWO layers since wave 10, F-2)
  // =====================================================================
  const P1_IDS = ['M1', 'M2'];

  function p1Tree(name) {
    const root = path.join(WORK, name);
    rmrf(root);
    copyDir(path.join(REPO, 'api'), path.join(root, 'api'));
    copyDir(path.join(SITE, 'shared'), path.join(root, 'site', 'shared'));
    return root;
  }

  function runWave2(root, port) {
    return runSuite(wave2, [], {
      QA_API_DIR: path.join(root, 'api'),
      // WAVE 13: the handler bodies moved into site/shared/portal-handlers/,
      // so the copy of the shared tree has to be measured too -- otherwise the
      // probe would measure the REPO's handlers and prove nothing.
      QA_SHARED_DIR: path.join(root, 'site', 'shared'),
      QA_PORT: String(port),
      PORTAL_STORE: 'file',
    });
  }

  // --- 1. CONTROL: the unmodified copy still passes M1/M2 ---
  const p1ControlTree = p1Tree('p1-control');
  const p1ControlRun = runWave2(p1ControlTree, 4451);
  const p1ControlOk = P1_IDS.every((id) => statusOf(p1ControlRun.results, id) === 'PASS');
  record({
    id: 'P1-control',
    what: 'the tree copy (unmodified) still passes M1/M2',
    ok: p1ControlOk,
    detail:
      P1_IDS.map((id) => `${id}=${statusOf(p1ControlRun.results, id)}`).join(' ') +
      `   (suite exit ${p1ControlRun.code})`,
  });

  // --- 2. MUTANT: ALL THREE layers removed -> M1/M2 go RED ---
  const p1MutantTree = p1Tree('p1-mutant');
  let p1Patched = true;
  let p1PatchError = '';
  try {
    patch(
      path.join(p1MutantTree, 'api', 'moderate', 'review.ts'),
      P1_HANDLER_ANCHOR,
      P1_HANDLER_BREAK,
    );
    patch(
      path.join(p1MutantTree, 'site', 'shared', 'portal-store', 'file-adapter.ts'),
      P1_STORE_ANCHOR,
      P1_STORE_BREAK,
    );
    patch(
      path.join(p1MutantTree, 'site', 'shared', 'portal-store', 'file-adapter.ts'),
      P1_IDENTITY_ANCHOR,
      P1_IDENTITY_BREAK,
    );
  } catch (err) {
    p1Patched = false;
    p1PatchError = err.message;
  }
  const p1MutantRun = p1Patched
    ? runWave2(p1MutantTree, 4452)
    : { code: 1, results: [], stdout: '' };
  const p1MutantOk =
    p1Patched && P1_IDS.every((id) => statusOf(p1MutantRun.results, id) === 'FAIL');
  record({
    id: 'P1-mutant',
    what:
      'ALL THREE layers of the stale-revision guard are removed -> M1/M2 go RED (non-vacuity proof)',
    ok: p1MutantOk,
    detail:
      (p1Patched
        ? P1_IDS.map((id) => `${id}=${statusOf(p1MutantRun.results, id)}`).join(' ')
        : `the patch did not apply: ${p1PatchError}`) +
      `   (suite exit ${p1MutantRun.code})` +
      `   all failing checks: ${
        (p1MutantRun.results || [])
          .filter((r) => r.status === 'FAIL')
          .map((r) => r.id)
          .join(', ') || 'none'
      }`,
  });

  // --- 3. only the HANDLER layer removed -> the STORE still refuses ---
  const p1HalfHandlerTree = p1Tree('p1-half-handler');
  let p1HalfHandlerPatched = true;
  let p1HalfHandlerError = '';
  try {
    patch(
      path.join(p1HalfHandlerTree, 'api', 'moderate', 'review.ts'),
      P1_HANDLER_ANCHOR,
      P1_HANDLER_BREAK,
    );
  } catch (err) {
    p1HalfHandlerPatched = false;
    p1HalfHandlerError = err.message;
  }
  const p1HalfHandlerRun = p1HalfHandlerPatched
    ? runWave2(p1HalfHandlerTree, 4453)
    : { code: 1, results: [], stdout: '' };
  const p1HalfHandlerOk =
    p1HalfHandlerPatched &&
    P1_IDS.every((id) => statusOf(p1HalfHandlerRun.results, id) === 'PASS');
  record({
    id: 'P1-half-handler',
    what:
      'only the HANDLER layer is removed -> M1/M2 stay GREEN (the STORE still refuses: the second layer is load-bearing)',
    ok: p1HalfHandlerOk,
    detail:
      (p1HalfHandlerPatched
        ? P1_IDS.map((id) => `${id}=${statusOf(p1HalfHandlerRun.results, id)}`).join(' ')
        : `the patch did not apply: ${p1HalfHandlerError}`) +
      `   (suite exit ${p1HalfHandlerRun.code})`,
  });

  // --- 4. only the STORE layer removed -> the HANDLER still refuses ---
  const p1HalfStoreTree = p1Tree('p1-half-store');
  let p1HalfStorePatched = true;
  let p1HalfStoreError = '';
  try {
    patch(
      path.join(p1HalfStoreTree, 'site', 'shared', 'portal-store', 'file-adapter.ts'),
      P1_STORE_ANCHOR,
      P1_STORE_BREAK,
    );
  } catch (err) {
    p1HalfStorePatched = false;
    p1HalfStoreError = err.message;
  }
  const p1HalfStoreRun = p1HalfStorePatched
    ? runWave2(p1HalfStoreTree, 4454)
    : { code: 1, results: [], stdout: '' };
  const p1HalfStoreOk =
    p1HalfStorePatched && P1_IDS.every((id) => statusOf(p1HalfStoreRun.results, id) === 'PASS');
  record({
    id: 'P1-half-store',
    what:
      'only the STORE layer is removed -> M1/M2 stay GREEN (the HANDLER still refuses: the first layer is load-bearing)',
    ok: p1HalfStoreOk,
    detail:
      (p1HalfStorePatched
        ? P1_IDS.map((id) => `${id}=${statusOf(p1HalfStoreRun.results, id)}`).join(' ')
        : `the patch did not apply: ${p1HalfStoreError}`) +
      `   (suite exit ${p1HalfStoreRun.code})`,
  });

  // --- 4b. only the STORE's IDENTITY scope removed -> the other two still refuse ---
  const p1HalfIdentityTree = p1Tree('p1-half-identity');
  let p1HalfIdentityPatched = true;
  let p1HalfIdentityError = '';
  try {
    patch(
      path.join(p1HalfIdentityTree, 'site', 'shared', 'portal-store', 'file-adapter.ts'),
      P1_IDENTITY_ANCHOR,
      P1_IDENTITY_BREAK,
    );
  } catch (err) {
    p1HalfIdentityPatched = false;
    p1HalfIdentityError = err.message;
  }
  const p1HalfIdentityRun = p1HalfIdentityPatched
    ? runWave2(p1HalfIdentityTree, 4455)
    : { code: 1, results: [], stdout: '' };
  const p1HalfIdentityOk =
    p1HalfIdentityPatched &&
    P1_IDS.every((id) => statusOf(p1HalfIdentityRun.results, id) === 'PASS');
  record({
    id: 'P1-half-identity',
    what:
      'only the STORE IDENTITY scope is removed -> M1/M2 stay GREEN (the HANDLER and the revision scope still refuse: the third layer is load-bearing)',
    ok: p1HalfIdentityOk,
    detail:
      (p1HalfIdentityPatched
        ? P1_IDS.map((id) => `${id}=${statusOf(p1HalfIdentityRun.results, id)}`).join(' ')
        : `the patch did not apply: ${p1HalfIdentityError}`) +
      `   (suite exit ${p1HalfIdentityRun.code})`,
  });

  // --- 5. LIVENESS: a reworded handler guard must break the anchor LOUDLY ---
  const p1HandlerDriftTree = p1Tree('p1-drift-handler');
  const p1HandlerDriftFile = path.join(p1HandlerDriftTree, 'api', 'moderate', 'review.ts');
  fs.writeFileSync(
    p1HandlerDriftFile,
    fs
      .readFileSync(p1HandlerDriftFile, 'utf8')
      .replace(P1_HANDLER_ANCHOR, 'if (currentRevision !== Number(revision)) {'),
    'utf8',
  );
  let p1HandlerLoud = false;
  let p1HandlerLoudDetail = '';
  try {
    patch(p1HandlerDriftFile, P1_HANDLER_ANCHOR, P1_HANDLER_BREAK);
    p1HandlerLoudDetail =
      'the anchor still matched a reworded handler -- the anchor is NOT load-bearing';
  } catch (err) {
    p1HandlerLoud = true;
    p1HandlerLoudDetail = `the probe would abort loudly: ${err.message}`;
  }
  record({
    id: 'P1-liveness-handler',
    what: 'if the handler guard text drifts, the P1 probe FAILS LOUDLY (no silent pass)',
    ok: p1HandlerLoud,
    detail: p1HandlerLoudDetail,
  });

  // --- 6. LIVENESS: a reworded store scope must break the anchor LOUDLY ---
  const p1StoreDriftTree = p1Tree('p1-drift-store');
  const p1StoreDriftFile = path.join(
    p1StoreDriftTree,
    'site',
    'shared',
    'portal-store',
    'file-adapter.ts',
  );
  fs.writeFileSync(
    p1StoreDriftFile,
    fs
      .readFileSync(p1StoreDriftFile, 'utf8')
      .replace(
        P1_STORE_ANCHOR,
        'if (expectedRevision !== undefined && revisionNumber(record) !== Number(expectedRevision)) {',
      ),
    'utf8',
  );
  let p1StoreLoud = false;
  let p1StoreLoudDetail = '';
  try {
    patch(p1StoreDriftFile, P1_STORE_ANCHOR, P1_STORE_BREAK);
    p1StoreLoudDetail =
      'the anchor still matched a reworded store -- the anchor is NOT load-bearing';
  } catch (err) {
    p1StoreLoud = true;
    p1StoreLoudDetail = `the probe would abort loudly: ${err.message}`;
  }
  record({
    id: 'P1-liveness-store',
    what: 'if the store scope text drifts, the P1 probe FAILS LOUDLY (no silent pass)',
    ok: p1StoreLoud,
    detail: p1StoreLoudDetail,
  });

  // --- 6b. LIVENESS: a reworded identity scope must break the anchor LOUDLY ---
  const p1IdentityDriftTree = p1Tree('p1-drift-identity');
  const p1IdentityDriftFile = path.join(
    p1IdentityDriftTree,
    'site',
    'shared',
    'portal-store',
    'file-adapter.ts',
  );
  fs.writeFileSync(
    p1IdentityDriftFile,
    fs
      .readFileSync(p1IdentityDriftFile, 'utf8')
      .replace(
        'if (recordIdentity(record) !== expectedRecordId) return null;',
        'if (recordIdentity(record) !== String(expectedRecordId)) return null;',
      ),
    'utf8',
  );
  let p1IdentityLoud = false;
  let p1IdentityLoudDetail = '';
  try {
    patch(p1IdentityDriftFile, P1_IDENTITY_ANCHOR, P1_IDENTITY_BREAK);
    p1IdentityLoudDetail =
      'the anchor still matched a reworded identity scope -- the anchor is NOT load-bearing';
  } catch (err) {
    p1IdentityLoud = true;
    p1IdentityLoudDetail = `the probe would abort loudly: ${err.message}`;
  }
  record({
    id: 'P1-liveness-identity',
    what: 'if the identity scope text drifts, the P1 probe FAILS LOUDLY (no silent pass)',
    ok: p1IdentityLoud,
    detail: p1IdentityLoudDetail,
  });

  // =====================================================================
  // ANCHOR E14 -- the Cloudflare inbox contract (re-pinned in wave 11)
  // =====================================================================
  const adminSuite = path.join(SITE, 'qa', 'qa-admin-independent.mjs');

  function cfTree(name) {
    const root = path.join(WORK, name);
    rmrf(root);
    copyDir(path.join(REPO, 'api'), path.join(root, 'api'));
    copyDir(path.join(SITE, 'shared'), path.join(root, 'site', 'shared'));
    copyDir(path.join(SITE, 'functions'), path.join(root, 'site', 'functions'));
    return root;
  }

  function runAdmin(root) {
    const env = {};
    if (root) {
      env.QA_ADMIN_API_DIR = path.join(root, 'api');
      env.QA_ADMIN_SHARED_DIR = path.join(root, 'site', 'shared');
      env.QA_ADMIN_CF_DIR = path.join(root, 'site', 'functions');
    }
    return runSuite(adminSuite, ['--only', 'E9,E14'], env);
  }

  // --- 1. CONTROL: the unmodified tree still passes E14 ---
  const e14ControlRun = runAdmin(null);
  const e14ControlOk =
    statusOf(e14ControlRun.results, 'E14') === 'PASS' &&
    statusOf(e14ControlRun.results, 'E9') === 'PASS';
  record({
    id: 'E14-control',
    what: 'the tree (unmodified) still passes E9 and E14',
    ok: e14ControlOk,
    detail:
      `E9=${statusOf(e14ControlRun.results, 'E9')} E14=${statusOf(e14ControlRun.results, 'E14')}` +
      `   (suite exit ${e14ControlRun.code})`,
  });

  // --- 2. MUTANT: a JSONL read put back into the CF inbox -> E14 goes RED ---
  const e14MutantTree = cfTree('e14-mutant');
  const e14Inbox = path.join(e14MutantTree, 'site', 'functions', 'api', 'admin', 'reviews.ts');
  let e14Patched = true;
  let e14PatchError = '';
  try {
    patch(e14Inbox, E14_ANCHOR, E14_BREAK);
  } catch (err) {
    e14Patched = false;
    e14PatchError = err.message;
  }
  const e14MutantRun = e14Patched
    ? runAdmin(e14MutantTree)
    : { code: 1, results: [], stdout: '' };
  const e14MutantOk =
    e14Patched &&
    statusOf(e14MutantRun.results, 'E14') === 'FAIL' &&
    statusOf(e14MutantRun.results, 'E9') === 'PASS';
  record({
    id: 'E14-mutant',
    what:
      'the CF inbox reads the moderation log again -> E14 goes RED while the Vercel tree (E9) stays GREEN (non-vacuity proof)',
    ok: e14MutantOk,
    detail:
      (e14Patched
        ? `E9=${statusOf(e14MutantRun.results, 'E9')} E14=${statusOf(e14MutantRun.results, 'E14')}`
        : `the patch did not apply: ${e14PatchError}`) +
      `   (suite exit ${e14MutantRun.code})` +
      `   E14 said: ${errorOf(e14MutantRun.results || [], 'E14').slice(0, 160)}`,
  });

  // --- 3. LIVENESS: a reworded CF inbox must break the anchor LOUDLY ---
  const e14DriftTree = cfTree('e14-drift');
  const e14DriftFile = path.join(
    e14DriftTree,
    'site',
    'functions',
    'api',
    'admin',
    'reviews.ts',
  );
  fs.writeFileSync(
    e14DriftFile,
    fs
      .readFileSync(e14DriftFile, 'utf8')
      .replace(
        'moderation store unavailable on this target',
        'moderation store unavailable on this platform',
      ),
    'utf8',
  );
  let e14Loud = false;
  let e14LoudDetail = '';
  try {
    patch(e14DriftFile, E14_ANCHOR, E14_BREAK);
    e14LoudDetail =
      'the anchor still matched a reworded CF inbox -- the anchor is NOT load-bearing';
  } catch (err) {
    e14Loud = true;
    e14LoudDetail = `the probe would abort loudly: ${err.message}`;
  }
  record({
    id: 'E14-liveness',
    what: 'if the CF inbox text drifts, the E16 probe FAILS LOUDLY (no silent pass)',
    ok: e14Loud,
    detail: e14LoudDetail,
  });

  // =====================================================================
  // ANCHOR R11 -- the EMPTY carrier rule (wave 15, B-1)
  // =====================================================================
  //
  // The rule has TWO halves, and the wave-15 probe pins both:
  //
  //   1. the ENTRY POINT (api/portal.ts and api/admin.ts) tests the query
  //      carrier for PRESENCE (`!== null`), so a PRESENT but EMPTY carrier
  //      is passed on as an empty string instead of falling through to the
  //      client-controlled x-imk-route header;
  //   2. the RESOLVER (site/shared/portal-router.ts, rule 2) tests the
  //      carrier for PRESENCE too, and refuses the empty one with a clean
  //      404 {code:'not-found'}.
  //
  // Each half is proved load-bearing on its own: reverting EITHER one must
  // turn R11 RED. And each anchor must FAIL LOUDLY when the product text
  // drifts, so a renamed line can never be a silent rubber stamp.
  const wave13 = path.join(SITE, 'qa', 'qa-wave13-routing.mjs');
  const R11_ENTRY_ANCHOR = '  if (fromQuery !== null) return fromQuery;';
  const R11_RESOLVER_ANCHOR = '  if (carrier !== null) {';

  function r11Tree(name) {
    const root = path.join(WORK, name);
    rmrf(root);
    copyDir(path.join(REPO, 'api'), path.join(root, 'api'));
    copyDir(path.join(SITE, 'shared'), path.join(root, 'site', 'shared'));
    return root;
  }

  function runR11(root) {
    return runSuite(wave13, ['--only', 'R11'], {
      QA_W13_API_DIR: path.join(root, 'api'),
      QA_W13_SHARED_DIR: path.join(root, 'site', 'shared'),
      // the suite's own probes are proved by the wave-13 suite itself; this
      // tool only needs the ONE check.
      QA_W13_PROBE_CHILD: '1',
      PORTAL_STORE: 'file',
    });
  }

  // --- 1. CONTROL: the unmodified copy still passes R11 ---
  const r11ControlTree = r11Tree('r11-control');
  const r11ControlRun = runR11(r11ControlTree);
  record({
    id: 'R11-control',
    what: 'the tree copy (unmodified) still passes R11 (the empty carrier is a clean 404)',
    ok: statusOf(r11ControlRun.results, 'R11') === 'PASS',
    detail:
      `R11=${statusOf(r11ControlRun.results, 'R11')}` +
      `   (suite exit ${r11ControlRun.code})` +
      `   R11 said: ${errorOf(r11ControlRun.results || [], 'R11').slice(0, 160)}`,
  });

  // --- 2. MUTANT: the ENTRY POINT falls through again -> R11 goes RED ---
  const r11EntryMutantTree = r11Tree('r11-mutant-entry');
  const r11EntryMutantFile = path.join(r11EntryMutantTree, 'api', 'portal.ts');
  let r11EntryPatched = true;
  let r11EntryPatchError = '';
  try {
    patch(r11EntryMutantFile, R11_ENTRY_ANCHOR, '  if (fromQuery) return fromQuery;');
  } catch (err) {
    r11EntryPatched = false;
    r11EntryPatchError = err.message;
  }
  const r11EntryMutantRun = r11EntryPatched
    ? runR11(r11EntryMutantTree)
    : { code: 1, results: [], stdout: '' };
  record({
    id: 'R11-mutant-entry',
    what: 'the ENTRY POINT falls through to the header again -> R11 goes RED (non-vacuity proof)',
    ok: r11EntryPatched && statusOf(r11EntryMutantRun.results, 'R11') === 'FAIL',
    detail:
      (r11EntryPatched
        ? `R11=${statusOf(r11EntryMutantRun.results, 'R11')}`
        : `the patch did not apply: ${r11EntryPatchError}`) +
      `   (suite exit ${r11EntryMutantRun.code})` +
      `   R11 said: ${errorOf(r11EntryMutantRun.results || [], 'R11').slice(0, 160)}`,
  });

  // --- 3. MUTANT: the RESOLVER treats the empty carrier as absent -> R11 goes RED ---
  const r11ResolverMutantTree = r11Tree('r11-mutant-resolver');
  const r11ResolverMutantFile = path.join(
    r11ResolverMutantTree,
    'site',
    'shared',
    'portal-router.ts',
  );
  let r11ResolverPatched = true;
  let r11ResolverPatchError = '';
  try {
    patch(r11ResolverMutantFile, R11_RESOLVER_ANCHOR, '  if (carrier) {');
  } catch (err) {
    r11ResolverPatched = false;
    r11ResolverPatchError = err.message;
  }
  const r11ResolverMutantRun = r11ResolverPatched
    ? runR11(r11ResolverMutantTree)
    : { code: 1, results: [], stdout: '' };
  record({
    id: 'R11-mutant-resolver',
    what: 'the RESOLVER treats an empty carrier as ABSENT again -> R11 goes RED (non-vacuity proof)',
    ok: r11ResolverPatched && statusOf(r11ResolverMutantRun.results, 'R11') === 'FAIL',
    detail:
      (r11ResolverPatched
        ? `R11=${statusOf(r11ResolverMutantRun.results, 'R11')}`
        : `the patch did not apply: ${r11ResolverPatchError}`) +
      `   (suite exit ${r11ResolverMutantRun.code})` +
      `   R11 said: ${errorOf(r11ResolverMutantRun.results || [], 'R11').slice(0, 160)}`,
  });

  // --- 4. LIVENESS: a reworded ENTRY POINT must break the anchor LOUDLY ---
  const r11EntryDriftTree = r11Tree('r11-drift-entry');
  const r11EntryDriftFile = path.join(r11EntryDriftTree, 'api', 'portal.ts');
  fs.writeFileSync(
    r11EntryDriftFile,
    fs
      .readFileSync(r11EntryDriftFile, 'utf8')
      .replace(R11_ENTRY_ANCHOR, '  if (fromQuery != null) return fromQuery;'),
    'utf8',
  );
  let r11EntryLoud = false;
  let r11EntryLoudDetail = '';
  try {
    patch(r11EntryDriftFile, R11_ENTRY_ANCHOR, '  if (fromQuery) return fromQuery;');
    r11EntryLoudDetail =
      'the anchor still matched a reworded entry point -- the anchor is NOT load-bearing';
  } catch (err) {
    r11EntryLoud = true;
    r11EntryLoudDetail = `the probe would abort loudly: ${err.message}`;
  }
  record({
    id: 'R11-liveness-entry',
    what: 'if the entry point text drifts, the R11 probe FAILS LOUDLY (no silent pass)',
    ok: r11EntryLoud,
    detail: r11EntryLoudDetail,
  });

  // --- 5. LIVENESS: a reworded RESOLVER must break the anchor LOUDLY ---
  const r11ResolverDriftTree = r11Tree('r11-drift-resolver');
  const r11ResolverDriftFile = path.join(
    r11ResolverDriftTree,
    'site',
    'shared',
    'portal-router.ts',
  );
  fs.writeFileSync(
    r11ResolverDriftFile,
    fs
      .readFileSync(r11ResolverDriftFile, 'utf8')
      .replace(R11_RESOLVER_ANCHOR, '  if (carrier != null) {'),
    'utf8',
  );
  let r11ResolverLoud = false;
  let r11ResolverLoudDetail = '';
  try {
    patch(r11ResolverDriftFile, R11_RESOLVER_ANCHOR, '  if (carrier) {');
    r11ResolverLoudDetail =
      'the anchor still matched a reworded resolver -- the anchor is NOT load-bearing';
  } catch (err) {
    r11ResolverLoud = true;
    r11ResolverLoudDetail = `the probe would abort loudly: ${err.message}`;
  }
  record({
    id: 'R11-liveness-resolver',
    what: 'if the resolver text drifts, the R11 probe FAILS LOUDLY (no silent pass)',
    ok: r11ResolverLoud,
    detail: r11ResolverLoudDetail,
  });

  // --- 7. the shipped tree must be byte-identical after all of this ---
  const digestAfter = repoDigest();
  record({
    id: 'tree-untouched',
    what: 'the shipped tree is byte-identical after the proofs',
    ok: digestAfter === digestBefore,
    detail:
      digestAfter === digestBefore
        ? 'api/, site/shared/, site/scripts/ and site/functions/ are unchanged'
        : 'THE SHIPPED TREE CHANGED DURING THE PROOF -- inspect before trusting the run',
  });
} catch (err) {
  console.error('[qa] PROOF ERROR', err && err.stack ? err.stack : err);
  allGood = false;
} finally {
  rmrf(WORK);
}

console.log(
  `\n[qa] ${findings.filter((f) => f.ok).length}/${findings.length} anchor proofs behaved as expected`,
);

if (JSON_OUT) {
  fs.mkdirSync(path.dirname(JSON_OUT), { recursive: true });
  fs.writeFileSync(
    JSON_OUT,
    JSON.stringify(
      { suite: 'qa-anchor-nonvacuity', startedAt: new Date().toISOString(), findings },
      null,
      2,
    ),
    'utf8',
  );
}

process.exit(allGood ? 0 : 1);
