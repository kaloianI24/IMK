// site/shared/portal-store/test/contract.test.ts
//
// Adapter contract tests (proposal T3 acceptance):
//   ordering, newest-wins, error-throwing, decideReview idempotency.
//
// Every test runs against a throw-away data directory in the OS temp folder —
// the repository's own site/data is never touched.
//
// Run with: npm run test:store   (bundles this file with esbuild, then node --test)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createFileStore } from '../file-adapter.js';
import { getStore } from '../index.js';
import { getStore as getEdgeStore } from '../edge.js';
import { StorageError } from '../errors.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'imk-store-'));
}

function reviewsFile(dir: string): string {
  return path.join(dir, 'moderation', 'reviews.jsonl');
}

function seedReviews(dir: string, records: Record<string, any>[]): void {
  fs.mkdirSync(path.join(dir, 'moderation'), { recursive: true });
  fs.writeFileSync(
    reviewsFile(dir),
    records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : ''),
    'utf8',
  );
}

// --- basics -----------------------------------------------------------------

test('a missing file is an empty collection, not an error', async () => {
  const store = createFileStore({ dataDir: tmpDir() });
  assert.deepEqual(await store.list('projects'), []);
  assert.equal(await store.get('projects', { field: 'id', value: 'p1' }), null);
});

test('append preserves insertion order and list returns it oldest-first', async () => {
  const store = createFileStore({ dataDir: tmpDir() });
  await store.append('projects', { id: 'p1' });
  await store.append('projects', { id: 'p2' });
  await store.append('projects', { id: 'p3' });
  const all = await store.list('projects');
  assert.deepEqual(
    all.map((r) => r.id),
    ['p1', 'p2', 'p3'],
  );
});

test('append creates parent directories and writes one JSON object per line', async () => {
  const dir = tmpDir();
  const store = createFileStore({ dataDir: dir });
  await store.append('comments', { id: 'c1', body: 'hi' });
  const file = path.join(dir, 'portal', 'comments.jsonl');
  assert.equal(fs.readFileSync(file, 'utf8'), '{"id":"c1","body":"hi"}\n');
});

test('the collections map onto the same files the handlers use today', async () => {
  const dir = tmpDir();
  const store = createFileStore({ dataDir: dir });
  await store.append('invites', { email: 'a@b.c' });
  await store.append('clients', { id: 'cli_1' });
  await store.append('planItems', { id: 'pl_1' });
  await store.append('updates', { id: 'up_1' });
  assert.ok(fs.existsSync(path.join(dir, 'portal', 'invited.jsonl')));
  assert.ok(fs.existsSync(path.join(dir, 'portal', 'clients.jsonl')));
  assert.ok(fs.existsSync(path.join(dir, 'portal', 'planItems.jsonl')));
  assert.ok(fs.existsSync(path.join(dir, 'portal', 'updates.jsonl')));
});

test('list filters by equality and ignores undefined filter values', async () => {
  const store = createFileStore({ dataDir: tmpDir() });
  await store.append('comments', { id: 'c1', projectId: 'p1' });
  await store.append('comments', { id: 'c2', projectId: 'p1' });
  await store.append('comments', { id: 'c3', projectId: 'p2' });
  const forP1 = await store.list('comments', { projectId: 'p1' });
  assert.deepEqual(
    forP1.map((r) => r.id),
    ['c1', 'c2'],
  );
  const loose = await store.list('comments', { projectId: 'p1', body: undefined });
  assert.equal(loose.length, 2);
});

test('get returns the first match and null when absent', async () => {
  const store = createFileStore({ dataDir: tmpDir() });
  await store.append('clients', { id: 'cli_1', email: 'a@b.c' });
  await store.append('clients', { id: 'cli_2', email: 'a@b.c' });
  const first = await store.get('clients', { field: 'email', value: 'a@b.c' });
  assert.equal(first?.id, 'cli_1');
  assert.equal(await store.get('clients', { field: 'email', value: 'nobody@x.y' }), null);
});

test('update patches every matching record, reports the count and leaves the rest alone', async () => {
  const dir = tmpDir();
  const store = createFileStore({ dataDir: dir });
  await store.append('comments', { id: 'c1', projectId: 'p1', state: 'open' });
  await store.append('comments', { id: 'c2', projectId: 'p1', state: 'open' });
  await store.append('comments', { id: 'c3', projectId: 'p2', state: 'open' });
  const count = await store.update('comments', { projectId: 'p1' }, { state: 'closed' });
  assert.equal(count, 2);
  const all = await store.list('comments');
  assert.equal(all.filter((r) => r.state === 'closed').length, 2);
  assert.equal(all.find((r) => r.id === 'c3')?.state, 'open');
});

test('update on the reviews collection is refused (decideReview only)', async () => {
  const store = createFileStore({ dataDir: tmpDir() });
  await assert.rejects(
    () => store.update('reviews', { ref: 'rev_1' }, { state: 'approved' }),
    (e: unknown) => e instanceof StorageError && e.code === 'invalid-operation',
  );
});

test('remove deletes matching records and reports the count', async () => {
  const store = createFileStore({ dataDir: tmpDir() });
  await store.append('sessions', { token: 't1', expiresAt: 1 });
  await store.append('sessions', { token: 't2', expiresAt: 2 });
  assert.equal(await store.remove('sessions', { token: 't1' }), 1);
  const left = await store.list('sessions');
  assert.deepEqual(
    left.map((r) => r.token),
    ['t2'],
  );
});

// --- newest-wins ------------------------------------------------------------

test('latest returns the newest matching revision (later lines win)', async () => {
  const dir = tmpDir();
  seedReviews(dir, [
    { ref: 'rev_1', type: 'review', projectId: 'p1', state: 'pending', quote: 'v1' },
    { ref: 'rev_1', type: 'review', projectId: 'p1', state: 'pending', quote: 'v2' },
    { ref: 'rev_2', type: 'review', projectId: 'p2', state: 'pending', quote: 'other' },
    { ref: 'rev_1', type: 'review', projectId: 'p1', state: 'pending', quote: 'v3' },
  ]);
  const store = createFileStore({ dataDir: dir });
  const latest = await store.latest('reviews', { type: 'review', projectId: 'p1' });
  assert.equal(latest?.quote, 'v3');
  const byRef = await store.latest('reviews', { ref: 'rev_1' });
  assert.equal(byRef?.quote, 'v3');
});

test('decideReview flips only the newest revision and leaves older ones untouched', async () => {
  const dir = tmpDir();
  seedReviews(dir, [
    { ref: 'rev_1', type: 'review', projectId: 'p1', state: 'pending', quote: 'v1' },
    { ref: 'rev_1', type: 'review', projectId: 'p1', state: 'pending', quote: 'v2' },
    { ref: 'rev_2', type: 'review', projectId: 'p2', state: 'pending', quote: 'other' },
  ]);
  const store = createFileStore({ dataDir: dir });

  const result = await store.decideReview('rev_1', 'approved', '2026-10-20T10:00:00.000Z');
  assert.equal(result?.state, 'approved');
  assert.equal(result?.decidedAt, '2026-10-20T10:00:00.000Z');
  assert.equal(result?.decidedBy, 'one-click-link');
  assert.equal(result?.quote, 'v2', 'the newest revision is the one that was flipped');

  const lines = fs
    .readFileSync(reviewsFile(dir), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l));
  assert.equal(lines[0].state, 'pending', 'older revision untouched');
  assert.equal(lines[0].quote, 'v1');
  assert.equal(lines[1].state, 'approved');
  assert.equal(lines[2].state, 'pending', 'other ref untouched');
  assert.equal(lines[2].quote, 'other');
});

test('decideReview is idempotent: a second call changes nothing and rewrites nothing', async () => {
  const dir = tmpDir();
  seedReviews(dir, [
    { ref: 'rev_1', type: 'review', projectId: 'p1', state: 'pending' },
  ]);
  const store = createFileStore({ dataDir: dir });
  const file = reviewsFile(dir);

  const first = await store.decideReview('rev_1', 'approved', '2026-10-20T10:00:00.000Z');
  const bytesAfterFirst = fs.readFileSync(file, 'utf8');
  const mtimeAfterFirst = fs.statSync(file).mtimeMs;

  const second = await store.decideReview('rev_1', 'approved', '2026-10-20T11:00:00.000Z');
  assert.equal(first?.state, 'approved');
  assert.equal(second?.state, 'approved');
  assert.equal(second?.decidedAt, '2026-10-20T10:00:00.000Z', 'the original decision time is kept');
  assert.equal(fs.readFileSync(file, 'utf8'), bytesAfterFirst, 'file is byte-identical');
  assert.equal(fs.statSync(file).mtimeMs, mtimeAfterFirst, 'the file was not rewritten');
});

test('decideReview does not flip an already-decided record, not even the other way', async () => {
  const dir = tmpDir();
  seedReviews(dir, [
    { ref: 'rev_1', type: 'review', projectId: 'p1', state: 'approved', decidedAt: 'earlier' },
  ]);
  const store = createFileStore({ dataDir: dir });
  const result = await store.decideReview('rev_1', 'rejected', '2026-10-20T10:00:00.000Z');
  assert.equal(result?.state, 'approved');
  assert.equal(result?.decidedAt, 'earlier');
  const line = JSON.parse(fs.readFileSync(reviewsFile(dir), 'utf8').trim());
  assert.equal(line.state, 'approved');
});

test('decideReview returns null for an unknown ref', async () => {
  const dir = tmpDir();
  seedReviews(dir, [{ ref: 'rev_1', type: 'review', projectId: 'p1', state: 'pending' }]);
  const store = createFileStore({ dataDir: dir });
  assert.equal(await store.decideReview('rev_missing', 'approved', '2026-10-20T10:00:00.000Z'), null);
});

test('decideReview ignores a non-review record that happens to share the ref', async () => {
  const dir = tmpDir();
  seedReviews(dir, [
    { ref: 'rev_1', type: 'something-else', state: 'pending' },
    { ref: 'rev_1', type: 'review', projectId: 'p1', state: 'pending' },
  ]);
  const store = createFileStore({ dataDir: dir });
  const result = await store.decideReview('rev_1', 'approved', '2026-10-20T10:00:00.000Z');
  assert.equal(result?.state, 'approved');
  const lines = fs
    .readFileSync(reviewsFile(dir), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l));
  assert.equal(lines[0].state, 'pending', 'the non-review record is not touched');
});

// --- error behaviour --------------------------------------------------------

test('a corrupt file raises instead of silently returning an empty list', async () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'portal'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'portal', 'projects.jsonl'), '{"id":"p1"}\nnot json\n', 'utf8');
  const store = createFileStore({ dataDir: dir });
  await assert.rejects(
    () => store.list('projects'),
    (e: unknown) => e instanceof StorageError && e.code === 'storage-corrupt',
  );
});

test('a failed write raises (append never reports success for a lost write)', async () => {
  const dir = tmpDir();
  // A directory where the file should be -> the append must fail loudly.
  fs.mkdirSync(path.join(dir, 'portal', 'comments.jsonl'), { recursive: true });
  const store = createFileStore({ dataDir: dir });
  await assert.rejects(
    () => store.append('comments', { id: 'c1' }),
    (e: unknown) => e instanceof StorageError && e.code === 'storage-unavailable',
  );
});

test('exportAll drains every collection as raw JSONL lines', async () => {
  const dir = tmpDir();
  const store = createFileStore({ dataDir: dir });
  await store.append('projects', { id: 'p1' });
  await store.append('projects', { id: 'p2' });
  const dump = await store.exportAll();
  assert.deepEqual(dump.projects, ['{"id":"p1"}', '{"id":"p2"}']);
  assert.deepEqual(dump.reviews, []);
  assert.deepEqual(Object.keys(dump).sort(), [
    'clients',
    'comments',
    'invites',
    'planItems',
    'projects',
    'reviews',
    'sessions',
    'updates',
  ]);
});

test('a file written by the adapter is byte-identical to the legacy rewriteJsonl format', async () => {
  const dir = tmpDir();
  const store = createFileStore({ dataDir: dir });
  await store.append('reviews', { ref: 'rev_1', type: 'review' });
  await store.append('reviews', { ref: 'rev_2', type: 'review' });
  const written = fs.readFileSync(reviewsFile(dir), 'utf8');
  const legacy = [
    { ref: 'rev_1', type: 'review' },
    { ref: 'rev_2', type: 'review' },
  ]
    .map((r) => JSON.stringify(r))
    .join('\n') + '\n';
  assert.equal(written, legacy);
  assert.ok(!written.includes('\n\n'), 'no blank lines');
});

// --- store selection --------------------------------------------------------

test('getStore defaults to the file adapter and honours PORTAL_DATA_DIR', async () => {
  const dir = tmpDir();
  const store = getStore({ PORTAL_DATA_DIR: dir });
  await store.append('projects', { id: 'p1' });
  assert.ok(fs.existsSync(path.join(dir, 'portal', 'projects.jsonl')));
});

test('getStore refuses an unknown backend and an unimplemented one', () => {
  assert.throws(
    () => getStore({ PORTAL_STORE: 'postgres' }),
    (e: unknown) => e instanceof StorageError && e.code === 'invalid-config',
  );
  assert.throws(
    () => getStore({ PORTAL_STORE: 'libsql' }),
    (e: unknown) => e instanceof StorageError && e.code === 'not-implemented',
  );
});

test('the edge entry point refuses the file adapter (no writable disk on the edge)', () => {
  assert.throws(
    () => getEdgeStore({ PORTAL_STORE: 'file' }),
    (e: unknown) => e instanceof StorageError && e.code === 'invalid-config',
  );
  assert.throws(
    () => getEdgeStore({ PORTAL_STORE: 'libsql' }),
    (e: unknown) => e instanceof StorageError && e.code === 'not-implemented',
  );
});
