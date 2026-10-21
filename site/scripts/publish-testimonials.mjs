// scripts/publish-testimonials.mjs — prebuild script (T7.3)
//
// Runs from `site/` (npm prebuild). Reads data/moderation/reviews.jsonl,
// finds records with state === 'approved', and writes them into
// src/content/testimonials/{ref}.md so Astro's content layer can render them
// via Testimonials.astro.
//
// CONSENT IS ENFORCED HERE, AT PUBLISH TIME (spec RP-6) — not at approval time:
//   - a record without consent.p1 === true is never written (RP-6.1 / E15)
//   - consent.p2 === false publishes the quote anonymously: no name, no company,
//     and no badge that identifies them (RP-6.2 / RP-5.3)
//   - consent.p3 only unlocks a case study; it never affects the quote (RP-6.3)
//   - the CURRENT consent state is read on every build, so a withdrawal between
//     approval and build removes the item (RP-6.4)
//   - a revoked record is excluded and its published file disappears on the
//     next build (RP-6.5)
//
// The published `verified` flag is derived from the server-side
// `verifiedClient` field — never from anything the submitter sent (RP-5.1).
//
// Safe to run when the moderation log doesn't exist yet (writes nothing).
// Idempotent: clears the testimonials directory and rewrites all approved records,
// so rejected/removed reviews never linger as published content.
//
// Runs automatically before `astro build` via the `prebuild` script in package.json.

import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = process.cwd();
const REVIEWS_FILE = path.join(ROOT, 'data/moderation/reviews.jsonl');
const TESTIMONIALS_DIR = path.join(ROOT, 'src/content/testimonials');

/** JSON string literals are valid YAML double-quoted scalars — safest escape. */
function yamlString(value) {
  return JSON.stringify(String(value ?? '').replace(/[\r\n]+/g, ' ').trim());
}

function clampRating(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  const rounded = Math.round(n);
  return rounded >= 1 && rounded <= 5 ? rounded : undefined;
}

function consentOf(record) {
  const raw = record && typeof record.consent === 'object' && record.consent !== null ? record.consent : {};
  return {
    p1: raw.p1 === true,
    p2: raw.p2 === true,
    p3: raw.p3 === true,
    displayName: typeof raw.displayName === 'string' ? raw.displayName.trim() : '',
  };
}

function isRevoked(record) {
  return (
    record.state === 'revoked' ||
    record.revoked === true ||
    (record.consent && typeof record.consent === 'object' && record.consent.revoked === true)
  );
}

/** Later lines win — a record updated in place keeps its latest consent state. */
function latestByRef(records) {
  const byRef = new Map();
  let anon = 0;
  for (const record of records) {
    if (!record || record.type !== 'review') continue;
    const ref = typeof record.ref === 'string' && record.ref.trim() ? record.ref.trim() : `anonymous_${anon++}`;
    byRef.set(ref, record);
  }
  return [...byRef.values()];
}

function safeFileName(ref) {
  const cleaned = String(ref ?? '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || 'testimonial';
}

/**
 * Astro's content layer caches collection entries in a data store. When a
 * published testimonial is deleted — consent withdrawn, record revoked — the
 * cached entry survives and the quote keeps rendering on the site. That breaks
 * the promise that a withdrawal removes the quote on the next build
 * (spec RP-6.4 / RP-6.5).
 *
 * The store is a cache: dropping it costs one re-sync of the content
 * collections and guarantees the site shows exactly what is on disk.
 */
function clearAstroContentCache() {
  const candidates = [
    path.join(ROOT, 'node_modules', '.astro', 'data-store.json'),
    path.join(ROOT, '.astro', 'data-store.json'),
  ];
  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) fs.rmSync(file, { force: true });
    } catch {
      // A cache we cannot clear is not a reason to fail the build.
    }
  }
}

/**
 * Build the markdown file body for one approved record, or null when the
 * record must not be published.
 */
function toMarkdown(record) {
  const consent = consentOf(record);
  const quote = String(record.review ?? record.quote ?? '').trim();
  if (!quote) return null;

  // RP-6.2 / RP-5.3 — without P2 the quote publishes anonymously: no name, no
  // company, and no badge that identifies the client.
  const nameMe = consent.p2;
  const name = nameMe ? consent.displayName || String(record.name ?? '').trim() : '';
  const company = nameMe ? String(record.company ?? '').trim() : '';
  // RP-8.4 — `role` comes from its own record field; it is never copied from company.
  const role = nameMe ? String(record.role ?? '').trim() : '';
  const rating = clampRating(record.rating);
  // RP-5.1 — derived server-side, and only while the client is identified.
  const verified = record.verifiedClient === true && nameMe;
  const source = record.source === 'public' ? 'public' : 'portal';

  const lines = [
    '---',
    `quote: ${yamlString(quote)}`,
    `verified: ${verified}`,
    `source: ${yamlString(source)}`,
  ];
  if (name) lines.push(`name: ${yamlString(name)}`);
  if (company) lines.push(`company: ${yamlString(company)}`);
  if (role) lines.push(`role: ${yamlString(role)}`);
  if (rating !== undefined) lines.push(`rating: ${rating}`);
  lines.push('---', '', quote, '');

  return lines.join('\n');
}

/**
 * Read the moderation log.
 *
 * A malformed line is NOT skipped: it makes the whole publish refuse to run
 * (audit m2). Skipping it silently deleted the record from the published set
 * — a quote the owner had approved simply vanished from the site, with
 * nothing in the build output to say so. Refusing is the only safe answer:
 * the store is small, hand-edited sometimes, and a broken line is an operator
 * problem that must be seen.
 */
function readReviews() {
  if (!fs.existsSync(REVIEWS_FILE)) return [];
  // Strip a UTF-8 BOM — a hand-edited store (Notepad) would otherwise lose
  // its first record.
  const content = fs.readFileSync(REVIEWS_FILE, 'utf8').replace(/^\uFEFF/, '');
  const records = [];
  content.split('\n').forEach((line, index) => {
    if (line.trim() === '') return;
    try {
      records.push(JSON.parse(line));
    } catch {
      throw new Error(
        `data/moderation/reviews.jsonl line ${index + 1} is not valid JSON — ` +
          'refusing to publish a partial set of testimonials. Fix or remove that line.',
      );
    }
  });
  return records;
}

function main() {
  const reviews = readReviews();
  const current = latestByRef(reviews);

  let revoked = 0;
  let noConsent = 0;
  let noQuote = 0;
  let written = 0;

  // Ensure clean output directory
  if (fs.existsSync(TESTIMONIALS_DIR)) {
    for (const entry of fs.readdirSync(TESTIMONIALS_DIR)) {
      const fullPath = path.join(TESTIMONIALS_DIR, entry);
      if (entry.endsWith('.md')) fs.rmSync(fullPath, { force: true });
    }
  } else {
    fs.mkdirSync(TESTIMONIALS_DIR, { recursive: true });
  }

  for (const record of current) {
    if (record.state !== 'approved') continue;
    if (isRevoked(record)) {
      revoked++;
      continue;
    }
    // RP-6.1 — approval alone is not enough; the client must have consented.
    if (!consentOf(record).p1) {
      noConsent++;
      continue;
    }
    const markdown = toMarkdown(record);
    if (!markdown) {
      noQuote++;
      continue;
    }
    const fileName = `${safeFileName(record.ref)}.md`;
    fs.writeFileSync(path.join(TESTIMONIALS_DIR, fileName), markdown, 'utf8');
    written++;
  }

  console.log(
    JSON.stringify({
      ts: Date.now(),
      outcome: 'testimonials_published',
      totalReviews: reviews.length,
      currentRecords: current.length,
      approved: current.filter((r) => r.state === 'approved').length,
      written,
      skippedRevoked: revoked,
      skippedNoConsent: noConsent,
      skippedNoQuote: noQuote,
      dir: TESTIMONIALS_DIR,
    }),
  );

  // Run last: the cache must be dropped AFTER the files are written, so the
  // next build re-reads the testimonials from disk.
  clearAstroContentCache();
}

try {
  main();
} catch (err) {
  // A loud, clean failure: the build must not continue with a partial set of
  // testimonials.
  console.error(
    `[publish-testimonials] ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
}
