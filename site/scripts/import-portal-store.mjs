#!/usr/bin/env node
// site/scripts/import-portal-store.mjs
//
// MIGRATE THE FILE STORE INTO libSQL/Turso (task T4, design §3.7).
//
// The live portal data lives in JSONL files under site/data/. After the
// cutover (PORTAL_STORE=libsql) the data has to be in the database, because
// a Vercel function cannot write to a read-only filesystem.
//
// WHAT IT DOES
//   1. Reads every collection of a file store (site/data/portal/*.jsonl and
//      site/data/moderation/reviews.jsonl), in file order.
//   2. Writes one row per line into the database, in the same order, so
//      `seq` reproduces the file order exactly.
//   3. Writes a manifest: { collection, file, lines, sha256 } per collection.
//   4. With --verify, reads BOTH sides back and compares them record by
//      record: the same number of records and the same JSON for every
//      record, in the same order. This is the part that matters — an import
//      that silently reorders or drops records is worse than no import.
//
// IT NEVER WRITES TO THE SOURCE
//   The source directory is only ever read. The manifest goes to --manifest.
//
// THE TOKEN IS NEVER LOGGED
//   LIBSQL_TOKEN / --token are used for the request and nothing else.
//
// USAGE
//   LIBSQL_URL=https://db.turso.io LIBSQL_TOKEN=… \
//     node site/scripts/import-portal-store.mjs --from site/data --verify
//
// OPTIONS
//   --from <dir>     the file store to read (default: site/data)
//   --manifest <f>   where to write the manifest (default: a temp file)
//   --verify         compare the file store and the database afterwards
//   --dry-run        read and count only, write nothing
//   --url <url>      the database URL (overrides LIBSQL_URL)
//   --token <token>  the database token (overrides LIBSQL_TOKEN)

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const HERE = dirname(fileURLToPath(import.meta.url));
const SITE = resolve(HERE, '..');
const REPO = resolve(SITE, '..');
const ENTRY = resolve(SITE, 'shared/portal-store/libsql-entry.ts');

function parseArgs(argv) {
  const args = { from: resolve(SITE, 'data'), manifest: null, verify: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--from') args.from = resolve(process.cwd(), argv[++i]);
    else if (arg === '--manifest') args.manifest = resolve(process.cwd(), argv[++i]);
    else if (arg === '--verify') args.verify = true;
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--url') args.url = argv[++i];
    else if (arg === '--token') args.token = argv[++i];
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!args.manifest) {
    args.manifest = join(tmpdir(), 'imk-libsql-import-manifest.json');
  }
  return args;
}

async function loadStore() {
  const outDir = join(tmpdir(), 'imk-libsql-import-bundle');
  mkdirSync(outDir, { recursive: true });
  const outfile = join(outDir, 'libsql-entry.mjs');
  await build({
    entryPoints: [ENTRY],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    logLevel: 'warning',
  });
  return import(`file://${outfile.replace(/\\/g, '/')}`);
}

/** Read a JSONL file into records. A bad line is an error, never a skip. */
function readJsonl(file) {
  if (!existsSync(file)) return [];
  const content = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const records = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '') continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      throw new Error(`${file}:${i + 1} is not valid JSON: ${err.message}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${file}:${i + 1} is not a JSON object`);
    }
    records.push(parsed);
  }
  return records;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(
      'Usage: node site/scripts/import-portal-store.mjs --from <dir> [--verify] [--dry-run] [--manifest <file>]\n',
    );
    return;
  }

  const url = args.url || process.env.LIBSQL_URL;
  const token = args.token || process.env.LIBSQL_TOKEN;
  if (!args.dryRun && (!url || !token)) {
    throw new Error(
      'LIBSQL_URL and LIBSQL_TOKEN are required (the database URL and its auth token). ' +
        'The token is never printed.',
    );
  }

  const store = await loadStore();
  const dataDir = args.from;
  if (!existsSync(dataDir)) {
    throw new Error(`the source directory does not exist: ${dataDir}`);
  }

  // ---- read the source ----------------------------------------------------
  const manifest = { source: dataDir, collections: [], generatedAt: new Date().toISOString() };
  const source = new Map();
  for (const [collection, relative] of Object.entries(store.COLLECTION_FILES)) {
    const file = join(dataDir, relative);
    const records = readJsonl(file);
    source.set(collection, { file, relative, records });
    manifest.collections.push({
      collection,
      file: relative,
      lines: records.length,
      // A collection that does not exist yet is not an error: it is empty.
      sha256: existsSync(file)
        ? createHash('sha256').update(readFileSync(file)).digest('hex')
        : createHash('sha256').update('').digest('hex'),
    });
  }

  process.stdout.write(
    `read ${source.size} collections from ${dataDir}\n` +
      manifest.collections
        .map((c) => `  ${c.collection.padEnd(12)} ${String(c.lines).padStart(5)} lines  ${c.file}`)
        .join('\n') +
      '\n',
  );

  if (args.dryRun) {
    process.stdout.write('dry run: nothing was written\n');
    return;
  }

  // ---- write the database -------------------------------------------------
  const transport = store.createHttpTransport({ url, token });
  const db = store.createLibsqlStore({ transport });
  await store.ensureSchema(transport);

  let written = 0;
  for (const [collection, entry] of source) {
    for (const record of entry.records) {
      await db.append(collection, record);
      written += 1;
    }
  }
  process.stdout.write(`wrote ${written} records into the database\n`);

  // ---- the manifest -------------------------------------------------------
  writeFileSync(args.manifest, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  process.stdout.write(`manifest: ${args.manifest}\n`);

  // ---- the compare pass ---------------------------------------------------
  if (args.verify) {
    const dump = await db.exportAll();
    let mismatches = 0;
    for (const [collection, entry] of source) {
      const left = entry.records.map((record) => JSON.stringify(record));
      const right = dump[collection] ?? [];
      if (left.length !== right.length) {
        mismatches += 1;
        process.stdout.write(
          `MISMATCH ${collection}: the file has ${left.length} records, the database has ${right.length}\n`,
        );
        continue;
      }
      for (let i = 0; i < left.length; i++) {
        if (left[i] !== right[i]) {
          mismatches += 1;
          process.stdout.write(
            `MISMATCH ${collection} at record ${i}: the file and the database differ\n` +
              `  file: ${left[i].slice(0, 160)}\n  db  : ${String(right[i]).slice(0, 160)}\n`,
          );
          break;
        }
      }
    }
    if (mismatches > 0) {
      throw new Error(`${mismatches} collection(s) differ between the file store and the database`);
    }
    process.stdout.write('verify: every collection matches, record for record, in the same order\n');
  }
}

main().catch((err) => {
  process.stderr.write(`import failed: ${err?.message ?? err}\n`);
  process.exit(1);
});
