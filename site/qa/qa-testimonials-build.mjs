// site/qa/qa-testimonials-build.mjs
//
// QA harness — build half of the reviews / testimonials verification.
//
// WHAT THIS DOES
//   Takes the moderation store produced by the REAL handlers
//   (site/qa/qa-testimonials.mjs -> <sandbox>/site/data/moderation/reviews.jsonl)
//   and drives the REAL publish script (site/scripts/publish-testimonials.mjs)
//   and a REAL `astro build` over it, then checks what actually reaches the
//   rendered homepage.
//
//   It proves the two publish-time rules that cannot be checked with HTTP:
//     - RP-6.1 / RP-6.2  consent gates what is published (quote, name, badge)
//     - RP-6.4 / RP-6.5  a withdrawal removes the quote from a FRESH build
//
// ISOLATION
//   - the site source is COPIED into a sandbox; the repo is only read
//   - node_modules is a junction to the repo's (read-only use)
//   - the build output, the published markdown and the fixtures live in the
//     sandbox and are deleted afterwards
//
// USAGE
//   node site/qa/qa-testimonials-build.mjs --sandbox <api-sandbox-dir> [--keep]

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.resolve(__dirname, '..');
const REPO = path.resolve(SITE, '..');

const argv = process.argv.slice(2);
const KEEP = argv.includes('--keep');
const sandboxIndex = argv.indexOf('--sandbox');
if (sandboxIndex === -1 || !argv[sandboxIndex + 1]) {
  console.error('usage: node qa/qa-testimonials-build.mjs --sandbox <dir> [--keep]');
  process.exit(2);
}
const API_SANDBOX = path.resolve(argv[sandboxIndex + 1]);
const SRC_REVIEWS = path.join(API_SANDBOX, 'site', 'data', 'moderation', 'reviews.jsonl');

const BUILD_SANDBOX = path.join(
  os.tmpdir(),
  'opencode',
  `qa-testimonials-build-${new Date().toISOString().replace(/[:.]/g, '-')}`,
);
const SITE_COPY = path.join(BUILD_SANDBOX, 'site');

const results = [];
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
async function t(id, name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    results.push({ id, name, status: 'PASS', ms: Date.now() - started, detail: detail || null });
    console.log(`  PASS  ${id}  ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (err) {
    results.push({
      id,
      name,
      status: 'FAIL',
      ms: Date.now() - started,
      error: err && err.message ? err.message : String(err),
    });
    console.log(`  FAIL  ${id}  ${name}\n          ${err && err.message ? err.message : err}`);
  }
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function rmrf(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

/** Copy the site source into the sandbox (no node_modules, no build output). */
function copySite() {
  const skipTop = new Set(['node_modules', 'dist', '.astro', '.lighthouseci', '.wrangler']);
  const copyRecursive = (src, dest, rel) => {
    const stat = fs.statSync(src);
    if (stat.isDirectory()) {
      fs.mkdirSync(dest, { recursive: true });
      for (const entry of fs.readdirSync(src)) {
        const childRel = rel ? path.join(rel, entry) : entry;
        if (!rel && skipTop.has(entry)) continue;
        if (childRel.startsWith(`qa${path.sep}artifacts`)) continue;
        if (childRel === path.join('src', 'content', 'testimonials')) continue;
        if (childRel === path.join('data', 'moderation')) continue;
        if (childRel === path.join('data', 'portal')) continue;
        copyRecursive(path.join(src, entry), path.join(dest, entry), childRel);
      }
    } else {
      fs.copyFileSync(src, dest);
    }
  };
  copyRecursive(SITE, SITE_COPY, '');
  // node_modules as a junction to the repo's install (read-only use)
  const link = path.join(SITE_COPY, 'node_modules');
  rmrf(link);
  fs.symlinkSync(path.join(SITE, 'node_modules'), link, 'junction');
  fs.mkdirSync(path.join(SITE_COPY, 'data', 'moderation'), { recursive: true });
}

function writeReviews(records) {
  const dir = path.join(SITE_COPY, 'data', 'moderation');
  fs.mkdirSync(dir, { recursive: true });
  const content = records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : '');
  fs.writeFileSync(path.join(dir, 'reviews.jsonl'), content, 'utf8');
}

function cacheState() {
  const candidates = [
    path.join(SITE_COPY, 'node_modules', '.astro', 'data-store.json'),
    path.join(SITE_COPY, '.astro', 'data-store.json'),
  ];
  return candidates.map((f) => {
    try {
      const st = fs.statSync(f);
      return `${f} — ${st.size} bytes, mtime ${st.mtime.toISOString()}`;
    } catch {
      return `${f} — absent`;
    }
  });
}

function runBuild() {
  const started = Date.now();
  const cacheBefore = cacheState();
  const res = spawnSync('npm run build', {
    cwd: SITE_COPY,
    shell: true,
    encoding: 'utf8',
    timeout: 600000,
    env: { ...process.env, CI: '1' },
  });
  const output = `${res.stdout || ''}\n${res.stderr || ''}`;
  return {
    status: res.status,
    output,
    ms: Date.now() - started,
    cacheBefore,
    cacheAfter: cacheState(),
    emptyCollectionWarnings: (output.match(/does not exist or is empty/gi) || []).length,
  };
}

function homePage() {
  const file = path.join(SITE_COPY, 'dist', 'index.html');
  assert(fs.existsSync(file), 'dist/index.html was not produced');
  return fs.readFileSync(file, 'utf8');
}

function publishedFiles() {
  const dir = path.join(SITE_COPY, 'src', 'content', 'testimonials');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
}

function publishedFile(ref) {
  const cleaned = String(ref).replace(/[^A-Za-z0-9._-]+/g, '-');
  const file = path.join(SITE_COPY, 'src', 'content', 'testimonials', `${cleaned}.md`);
  assert(fs.existsSync(file), `the published file for ${ref} must exist`);
  return file;
}

/** The publish rules of site/scripts/publish-testimonials.mjs, re-derived. */
function publishable(records) {
  const byRef = new Map();
  for (const r of records) {
    if (!r || r.type !== 'review') continue;
    byRef.set(r.ref, r); // later lines win
  }
  return [...byRef.values()].filter(
    (r) =>
      r.state === 'approved' &&
      r.revoked !== true &&
      r.consent &&
      r.consent.p1 === true &&
      String(r.review || '').trim() !== '',
  );
}

async function main() {
  console.log(`[qa] api sandbox  : ${API_SANDBOX}`);
  console.log(`[qa] build sandbox: ${BUILD_SANDBOX}`);

  const store = readJsonl(SRC_REVIEWS);
  assert(store.length > 0, 'the API sandbox must contain a moderation store');

  copySite();

  // The store as it was BEFORE the withdrawal: the revocation is appended as
  // a new line, so dropping it rebuilds the pre-withdrawal state exactly.
  const revokedRefs = new Set(
    store.filter((r) => r && r.type === 'review' && r.revoked === true).map((r) => r.ref),
  );
  const beforeWithdrawal = store.filter(
    (r) => !(r && r.type === 'review' && r.revoked === true),
  );

  const expected1 = publishable(beforeWithdrawal);
  const expected2 = publishable(store);

  const revokedRef = [...revokedRefs][0];
  const revokedLines = store.filter((r) => r && r.ref === revokedRef);
  // the withdrawal line itself carries no quote — the quote text lives on the
  // earlier submission line of the same ref.
  const revokedQuote = String(
    (revokedLines.find((r) => String(r.review || '').trim() !== '') || {}).review || '',
  );

  const namedRec = expected1.find((r) => r.consent.p2 === true);
  const anonRec = expected1.find((r) => r.consent.p2 === false);
  // Preconditions, checked BEFORE anything dereferences them: the API suite
  // has to have produced an approved named quote AND an approved anonymous
  // one. Without this the harness crashed with "Cannot read properties of
  // undefined (reading 'clientId')" and said nothing about WHY.
  assert(
    namedRec,
    'the moderation store must hold an approved, NAMED quote (consent.p2 = true) -- ' +
      'the API suite must have approved one before this build harness runs',
  );
  assert(
    anonRec,
    'the moderation store must hold an approved, ANONYMOUS quote (consent.p2 = false) -- ' +
      'the API suite must have approved one before this build harness runs',
  );
  // the publisher prefers the client's own display name over the owner's record
  const publishedName = (r) => String((r.consent && r.consent.displayName) || r.name || '').trim();

  // The REAL identity of the anonymous client. Since audit M1 the review
  // record no longer carries any identity for a client who withheld naming
  // consent — the name lives in the client record (the owner's profile). The
  // "must not be named" check therefore has to look the name up THERE; reading
  // it from the review record would compare the page against an empty string,
  // and an empty needle always matches.
  const clientRecords = readJsonl(
    path.join(API_SANDBOX, 'site', 'data', 'portal', 'clients.jsonl'),
  );
  const anonClient =
    clientRecords.find((c) => c && c.id === anonRec.clientId) || null;
  const anonRealName = String((anonClient && anonClient.name) || '').trim();
  const anonRealCompany = String((anonClient && anonClient.company) || '').trim();

  const withheld = (records, expected) =>
    records.filter(
      (r) =>
        r &&
        r.type === 'review' &&
        !expected.some((e) => e.ref === r.ref) &&
        String(r.review || '').trim() !== '',
    );

  let build1 = null;
  let html1 = '';
  let buildOk = false;

  await t('BUILD-1', 'the pre-withdrawal store builds the site (exit 0)', () => {
    writeReviews(beforeWithdrawal);
    build1 = runBuild();
    assertEqual(build1.status, 0, 'npm run build exit code');
    assert(build1.output.includes('Complete!'), 'the build must report completion');
    buildOk = true;
    return `${build1.ms} ms`;
  });

  if (buildOk) {
    await t('BUILD-2', 'the approved, named quote is rendered with the client name and the verified badge', () => {
      html1 = homePage();
      assert(html1.includes(String(namedRec.review)), 'the approved quote must be rendered');
      assert(html1.includes(publishedName(namedRec)), `the client name must be rendered (${publishedName(namedRec)})`);
      assert(html1.includes('Verified client'), 'the verified badge must be rendered');
      return `${publishedName(namedRec)}`;
    });

    await t('BUILD-3', 'a quote with consent.p2=false is rendered WITHOUT a name and WITHOUT a badge', () => {
      assert(html1.includes(String(anonRec.review)), 'the anonymous quote must be rendered');
      assert(anonRealName, 'the anonymous client must exist in the client records');
      assert(!html1.includes(anonRealName), 'the anonymous client must NOT be named');
      if (anonRealCompany) {
        assert(!html1.includes(anonRealCompany), 'the anonymous company must NOT be shown');
      }
      // the review record itself must not carry the identity either (audit M1)
      assert(!anonRec.name, 'the stored record must not carry the name');
      assert(!anonRec.company, 'the stored record must not carry the company');
      const badges = (html1.match(/Verified client/g) || []).length;
      const expectedBadges = expected1.filter((r) => r.consent.p2 === true).length;
      assertEqual(badges, expectedBadges, 'the number of verified badges on the page');
      return `anonymous quote rendered, ${badges} badge(s) == ${expectedBadges} named quote(s)`;
    });

    await t('BUILD-4', 'the set of rendered quotes is exactly the publishable set', () => {
      for (const r of expected1) {
        assert(html1.includes(String(r.review)), `the publishable quote must be rendered: ${r.ref}`);
      }
      const withheldQuotes = withheld(beforeWithdrawal, expected1);
      for (const r of withheldQuotes) {
        assert(!html1.includes(String(r.review).trim()), `a non-publishable quote must NOT be rendered: ${String(r.review).slice(0, 40)}`);
      }
      return `${expected1.length} published, ${withheldQuotes.length} withheld`;
    });

    await t('BUILD-5', 'the empty-state copy is absent while quotes exist', () => {
      assert(!html1.includes('no approved client quotes yet'), 'the empty-state note must not be shown');
      return 'ok';
    });

    await t('BUILD-6', 'the build emits no "collection does not exist or is empty" warning', () => {
      assertEqual(build1.emptyCollectionWarnings, 0, 'empty-collection warnings in the build output');
      return '0 warnings';
    });

    await t('BUILD-7', 'CONTROL: the not-yet-withdrawn quote IS published before the withdrawal', () => {
      assert(html1.includes(revokedQuote), 'the approved-but-not-yet-withdrawn quote must be rendered');
      return 'control ok';
    });

    await t('BUILD-8', 'the published frontmatter honours p1/p2 (name and verified flag)', () => {
      const anonBody = fs.readFileSync(publishedFile(anonRec.ref), 'utf8');
      assert(/verified:\s*false/.test(anonBody), 'an anonymous quote must publish verified: false');
      assert(!/^name:/m.test(anonBody), 'an anonymous quote must publish no name');
      assert(!/^company:/m.test(anonBody), 'an anonymous quote must publish no company');
      const namedBody = fs.readFileSync(publishedFile(namedRec.ref), 'utf8');
      assert(/verified:\s*true/.test(namedBody), 'a named quote must publish verified: true');
      assert(/^name: /m.test(namedBody), 'a named quote must publish the name');
      return 'frontmatter honours the consent flags';
    });
  }

  // ---- build 2: the store WITH the withdrawal ------------------------------
  let build2 = null;
  await t('BUILD-9', 'the store with the withdrawal builds the site (exit 0)', () => {
    writeReviews(store);
    build2 = runBuild();
    assertEqual(build2.status, 0, 'npm run build exit code');
    return `${build2.ms} ms | cache before: ${build2.cacheBefore.join(' ; ')} | after: ${build2.cacheAfter.join(' ; ')}`;
  });

  await t('BUILD-10', 'the withdrawn quote is GONE from the fresh build (RP-6.4 / RP-6.5)', () => {
    const html2 = homePage();
    assert(!html2.includes(revokedQuote), 'the withdrawn quote must not be rendered');
    const files = publishedFiles();
    const cleaned = String(revokedRef).replace(/[^A-Za-z0-9._-]+/g, '-');
    assert(!files.includes(`${cleaned}.md`), 'the published markdown for the withdrawn ref must be gone');
    return `revoked ref ${revokedRef} is absent`;
  });

  await t('BUILD-11', 'the set of rendered quotes after the withdrawal is exactly the publishable set', () => {
    const html2 = homePage();
    fs.writeFileSync(path.join(BUILD_SANDBOX, 'home-build2.html'), html2, 'utf8');
    for (const r of expected2) {
      assert(html2.includes(String(r.review)), `the publishable quote must be rendered: ${r.ref}`);
    }
    // The inlined CSS also contains the class name, so count the rendered
    // class attribute only.
    const quotes = (html2.match(/class="testimonial-card__quote"/g) || []).length;
    assertEqual(quotes, expected2.length, 'the number of testimonial cards on the page');
    return `${expected2.length} card(s)`;
  });

  await t('BUILD-12', 'the published markdown files match the publishable refs', () => {
    const files = publishedFiles();
    assertEqual(files.length, expected2.length, 'the number of published markdown files');
    return `${files.length} file(s)`;
  });

  await t('BUILD-13', 'the build output contains no warning about the empty collection', () => {
    assertEqual(build2.emptyCollectionWarnings, 0, 'empty-collection warnings in the build output');
    return '0 warnings';
  });

  // ---- build 3: no store at all (the fresh-clone case) ---------------------
  await t('BUILD-14', 'a site with no moderation store at all still builds (exit 0, quiet, empty state)', () => {
    rmrf(path.join(SITE_COPY, 'data', 'moderation'));
    rmrf(path.join(SITE_COPY, 'src', 'content', 'testimonials'));
    const b = runBuild();
    assertEqual(b.status, 0, 'npm run build exit code');
    assertEqual(b.emptyCollectionWarnings, 0, 'empty-collection warnings in the build output');
    const html = homePage();
    assert(html.includes('no approved client quotes yet'), 'the empty-state copy must be shown');
    return `${b.ms} ms`;
  });

  const passed = results.filter((r) => r.status === 'PASS').length;
  const failed = results.filter((r) => r.status === 'FAIL').length;
  console.log('');
  console.log(`[qa] ${passed} passed, ${failed} failed, ${results.length} build checks`);
  console.log(`[qa] build sandbox: ${BUILD_SANDBOX}`);

  const outPath = path.join(BUILD_SANDBOX, 'qa-build-results.json');
  fs.writeFileSync(
    outPath,
    JSON.stringify({ generatedAt: new Date().toISOString(), summary: { passed, failed, total: results.length }, results }, null, 2),
    'utf8',
  );
  console.log(`[qa] results: ${outPath}`);

  if (!KEEP) {
    rmrf(BUILD_SANDBOX);
    console.log('[qa] build sandbox removed');
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('[qa] build harness crashed:', err);
  process.exit(2);
});
