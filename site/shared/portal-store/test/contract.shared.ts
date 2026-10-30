// site/shared/portal-store/test/contract.shared.ts
//
// THE STORE CONTRACT, as a body that runs against ANY adapter.
//
// WHY IT IS FACTORED OUT
//   The PortalStore interface only means something if two different adapters
//   behave the SAME way. The file adapter (JSONL on disk) and the libSQL
//   adapter (a Turso database over HTTP) must satisfy the SAME assertions —
//   that is the proof that the interface is real, and that the libSQL adapter
//   is interchangeable with the file store (the rollback path).
//
// EVERY ASSERTION IN HERE IS ADAPTER-AGNOSTIC: it may not look at a file, at
// a table or at the network. The file-specific assertions (the byte format of
// the JSONL, the mapping of a collection onto a file) stay in contract.test.ts.
//
// The assertions come from the original file-adapter contract test
// (contract.test.ts, 22 cases). Nothing was weakened: every behaviour that
// could be expressed adapter-agnostically is here, and the fidelity cases
// (the number/string/boolean comparison) are NEW — they are the ones the SQL
// had to be written for.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { StorageError } from '../errors.js';
import type { PortalStore } from '../types.js';

export interface ContractOptions {
  /**
   * A store whose writes always fail, for the "a failed write raises" case.
   * Each adapter builds its own: a directory where the file should be (file),
   * a transport that always throws (libSQL).
   */
  brokenStore?: () => PortalStore | Promise<PortalStore>;
}

/**
 * Run the store contract against one adapter.
 *
 * @param name       the adapter name, used in the test titles
 * @param makeStore  a factory that returns a FRESH, EMPTY store
 */
export function describeStoreContract(
  name: string,
  makeStore: () => PortalStore | Promise<PortalStore>,
  options: ContractOptions = {},
): void {
  const fresh = async (): Promise<PortalStore> => await makeStore();

  test(`${name}: an empty collection is an empty list, not an error`, async () => {
    const store = await fresh();
    assert.deepEqual(await store.list('projects'), []);
    assert.equal(await store.get('projects', { field: 'id', value: 'p1' }), null);
  });

  test(`${name}: append preserves insertion order and list returns it oldest-first`, async () => {
    const store = await fresh();
    await store.append('projects', { id: 'p1' });
    await store.append('projects', { id: 'p2' });
    await store.append('projects', { id: 'p3' });
    const all = await store.list('projects');
    assert.deepEqual(
      all.map((r) => r.id),
      ['p1', 'p2', 'p3'],
    );
  });

  test(`${name}: append writes one JSON object per record`, async () => {
    const store = await fresh();
    await store.append('comments', { id: 'c1', body: 'hi' });
    await store.append('comments', { id: 'c2', body: 'there' });
    const dump = await store.exportAll();
    assert.deepEqual(dump.comments, ['{"id":"c1","body":"hi"}', '{"id":"c2","body":"there"}']);
  });

  test(`${name}: list filters by equality and ignores undefined filter values`, async () => {
    const store = await fresh();
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

  test(`${name}: get returns the first match and null when absent`, async () => {
    const store = await fresh();
    await store.append('clients', { id: 'cli_1', email: 'a@b.c' });
    await store.append('clients', { id: 'cli_2', email: 'a@b.c' });
    const first = await store.get('clients', { field: 'email', value: 'a@b.c' });
    assert.equal(first?.id, 'cli_1');
    assert.equal(await store.get('clients', { field: 'email', value: 'nobody@x.y' }), null);
  });

  test(`${name}: update patches every matching record, reports the count and leaves the rest alone`, async () => {
    const store = await fresh();
    await store.append('comments', { id: 'c1', projectId: 'p1', state: 'open' });
    await store.append('comments', { id: 'c2', projectId: 'p1', state: 'open' });
    await store.append('comments', { id: 'c3', projectId: 'p2', state: 'open' });
    const count = await store.update('comments', { projectId: 'p1' }, { state: 'closed' });
    assert.equal(count, 2);
    const all = await store.list('comments');
    assert.equal(all.filter((r) => r.state === 'closed').length, 2);
    assert.equal(all.find((r) => r.id === 'c3')?.state, 'open');
  });

  test(`${name}: update on the reviews collection is refused (decideReview only)`, async () => {
    const store = await fresh();
    await assert.rejects(
      () => store.update('reviews', { ref: 'rev_1' }, { state: 'approved' }),
      (e: unknown) => e instanceof StorageError && e.code === 'invalid-operation',
    );
  });

  test(`${name}: remove on the reviews collection is refused (the log is append-only)`, async () => {
    const store = await fresh();
    await assert.rejects(
      () => store.remove('reviews', { ref: 'rev_1' }),
      (e: unknown) => e instanceof StorageError && e.code === 'invalid-operation',
    );
  });

  test(`${name}: remove deletes matching records and reports the count`, async () => {
    const store = await fresh();
    await store.append('sessions', { token: 't1', expiresAt: 1 });
    await store.append('sessions', { token: 't2', expiresAt: 2 });
    assert.equal(await store.remove('sessions', { token: 't1' }), 1);
    const left = await store.list('sessions');
    assert.deepEqual(
      left.map((r) => r.token),
      ['t2'],
    );
  });

  test(`${name}: latest returns the newest matching revision (later wins)`, async () => {
    const store = await fresh();
    await store.append('reviews', { ref: 'rev_1', type: 'review', projectId: 'p1', state: 'pending', quote: 'v1' });
    await store.append('reviews', { ref: 'rev_1', type: 'review', projectId: 'p1', state: 'pending', quote: 'v2' });
    await store.append('reviews', { ref: 'rev_2', type: 'review', projectId: 'p2', state: 'pending', quote: 'other' });
    await store.append('reviews', { ref: 'rev_1', type: 'review', projectId: 'p1', state: 'pending', quote: 'v3' });
    const latest = await store.latest('reviews', { type: 'review', projectId: 'p1' });
    assert.equal(latest?.quote, 'v3');
    const byRef = await store.latest('reviews', { ref: 'rev_1' });
    assert.equal(byRef?.quote, 'v3');
  });

  test(`${name}: decideReview flips only the newest revision and leaves older ones untouched`, async () => {
    const store = await fresh();
    await store.append('reviews', { ref: 'rev_1', type: 'review', projectId: 'p1', state: 'pending', quote: 'v1' });
    await store.append('reviews', { ref: 'rev_1', type: 'review', projectId: 'p1', state: 'pending', quote: 'v2' });
    await store.append('reviews', { ref: 'rev_2', type: 'review', projectId: 'p2', state: 'pending', quote: 'other' });

    const result = await store.decideReview('rev_1', 'approved', '2026-10-20T10:00:00.000Z');
    assert.equal(result?.state, 'approved');
    assert.equal(result?.decidedAt, '2026-10-20T10:00:00.000Z');
    assert.equal(result?.decidedBy, 'one-click-link');
    assert.equal(result?.quote, 'v2', 'the newest revision is the one that was flipped');

    const all = await store.list('reviews');
    assert.equal(all[0].state, 'pending', 'older revision untouched');
    assert.equal(all[0].quote, 'v1');
    assert.equal(all[1].state, 'approved');
    assert.equal(all[2].state, 'pending', 'other ref untouched');
    assert.equal(all[2].quote, 'other');
  });

  test(`${name}: decideReview is idempotent: a second call changes nothing`, async () => {
    const store = await fresh();
    await store.append('reviews', { ref: 'rev_1', type: 'review', projectId: 'p1', state: 'pending' });

    const first = await store.decideReview('rev_1', 'approved', '2026-10-20T10:00:00.000Z');
    const second = await store.decideReview('rev_1', 'approved', '2026-10-20T11:00:00.000Z');
    assert.equal(first?.state, 'approved');
    assert.equal(second?.state, 'approved');
    assert.equal(second?.decidedAt, '2026-10-20T10:00:00.000Z', 'the original decision time is kept');
    assert.equal(second?.decidedBy, 'one-click-link');
  });

  test(`${name}: decideReview does not flip an already-decided record, not even the other way`, async () => {
    const store = await fresh();
    await store.append('reviews', { ref: 'rev_1', type: 'review', projectId: 'p1', state: 'approved', decidedAt: 'earlier' });
    const result = await store.decideReview('rev_1', 'rejected', '2026-10-20T10:00:00.000Z');
    assert.equal(result?.state, 'approved');
    assert.equal(result?.decidedAt, 'earlier');
    const all = await store.list('reviews');
    assert.equal(all[0].state, 'approved');
  });

  test(`${name}: decideReview returns null for an unknown ref`, async () => {
    const store = await fresh();
    await store.append('reviews', { ref: 'rev_1', type: 'review', projectId: 'p1', state: 'pending' });
    assert.equal(await store.decideReview('rev_missing', 'approved', '2026-10-20T10:00:00.000Z'), null);
  });

  // --- the revision scope (wave 10, F-2) -------------------------------------

  test(`${name}: decideReview with an expected revision flips ONLY that revision`, async () => {
    const store = await fresh();
    await store.append('reviews', { ref: 'rev_1', type: 'review', projectId: 'p1', state: 'pending', revision: 1, quote: 'v1' });
    await store.append('reviews', { ref: 'rev_1', type: 'review', projectId: 'p1', state: 'pending', revision: 2, quote: 'v2' });

    // The newest revision is 2; the decision is for revision 1. Nothing may be
    // flipped: approving revision 1's text would publish a quote the owner
    // did not sign for, and the record that holds revision 2 must stay
    // untouched too.
    const stale = await store.decideReview(
      'rev_1',
      'approved',
      '2026-10-22T10:00:00.000Z',
      'one-click-link',
      1,
    );
    assert.equal(stale, null, 'a decision for another revision must not be applied');

    const untouched = await store.list('reviews');
    assert.equal(untouched[0].state, 'pending', 'the older revision was flipped');
    assert.equal(untouched[1].state, 'pending', 'the newest revision was flipped');

    // The matching revision flips the newest record — the normal path.
    const applied = await store.decideReview(
      'rev_1',
      'approved',
      '2026-10-22T10:00:00.000Z',
      'one-click-link',
      2,
    );
    assert.equal(applied?.state, 'approved');
    assert.equal(applied?.quote, 'v2', 'the newest revision is the one that was flipped');
    assert.equal(applied?.decidedAt, '2026-10-22T10:00:00.000Z');
  });

  test(`${name}: decideReview with an expected revision is still idempotent`, async () => {
    const store = await fresh();
    await store.append('reviews', { ref: 'rev_1', type: 'review', projectId: 'p1', state: 'pending', revision: 3 });

    const first = await store.decideReview('rev_1', 'approved', '2026-10-22T10:00:00.000Z', 'one-click-link', 3);
    const second = await store.decideReview('rev_1', 'approved', '2026-10-22T11:00:00.000Z', 'one-click-link', 3);
    assert.equal(first?.state, 'approved');
    assert.equal(second?.state, 'approved');
    assert.equal(second?.decidedAt, '2026-10-22T10:00:00.000Z', 'the original decision time is kept');
  });

  test(`${name}: decideReview ignores a non-review record that happens to share the ref`, async () => {
    const store = await fresh();
    await store.append('reviews', { ref: 'rev_1', type: 'something-else', state: 'pending' });
    await store.append('reviews', { ref: 'rev_1', type: 'review', projectId: 'p1', state: 'pending' });
    const result = await store.decideReview('rev_1', 'approved', '2026-10-20T10:00:00.000Z');
    assert.equal(result?.state, 'approved');
    const all = await store.list('reviews');
    assert.equal(all[0].state, 'pending', 'the non-review record is not touched');
  });

  test(`${name}: a record with no state is not decided by decideReview`, async () => {
    const store = await fresh();
    await store.append('reviews', { ref: 'rev_1', type: 'review', projectId: 'p1' });
    const result = await store.decideReview('rev_1', 'approved', '2026-10-20T10:00:00.000Z');
    assert.equal(result?.state, undefined, 'a record whose state is not exactly pending is left alone');
  });

  test(`${name}: a failing write raises instead of reporting success`, async (t) => {
    if (!options.brokenStore) {
      t.skip('this adapter has no broken-store fixture');
      return;
    }
    const store = await options.brokenStore();
    await assert.rejects(
      () => store.append('comments', { id: 'c1' }),
      (e: unknown) => e instanceof StorageError && e.code === 'storage-unavailable',
    );
  });

  test(`${name}: exportAll drains every collection as raw JSONL lines`, async () => {
    const store = await fresh();
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

  // --- the record identity (wave 12, B-1) ------------------------------------

  test(`${name}: a record in the reviews collection is given an identity`, async () => {
    const store = await fresh();
    const stored = await store.append('reviews', {
      ref: 'rev_1',
      type: 'review',
      projectId: 'p1',
      state: 'pending',
    });
    assert.equal(typeof stored.recordId, 'string', 'the stored record carries no identity');
    assert.ok((stored.recordId as string).length > 0, 'the identity is empty');

    // The identity is IN the store, not only in the returned object.
    const all = await store.list('reviews');
    assert.equal(all.length, 1);
    assert.equal(all[0].recordId, stored.recordId, 'the stored record does not carry the identity');
  });

  test(`${name}: two records never share an identity`, async () => {
    const store = await fresh();
    const identities: string[] = [];
    for (let i = 0; i < 20; i++) {
      const stored = await store.append('reviews', { ref: `rev_${i}`, type: 'review' });
      identities.push(String(stored.recordId));
    }
    assert.equal(new Set(identities).size, identities.length, 'two records share one identity');
  });

  test(`${name}: decideReview with an expected identity flips ONLY the record it names`, async () => {
    const store = await fresh();
    // THE COLLISION (audit MAJOR-1): two records with the SAME ref and the
    // SAME revision number — what two concurrent submissions produce, when
    // both read the same current record and compute the same next revision.
    // The revision NUMBER cannot tell them apart.
    const first = await store.append('reviews', {
      ref: 'rev_1',
      type: 'review',
      projectId: 'p1',
      state: 'pending',
      revision: 2,
      quote: 'QUOTE-A',
    });
    const second = await store.append('reviews', {
      ref: 'rev_1',
      type: 'review',
      projectId: 'p1',
      state: 'pending',
      revision: 2,
      quote: 'QUOTE-B',
    });
    assert.notEqual(first.recordId, second.recordId, 'the two records share one identity');

    // The link names QUOTE-A. The newest record for the ref is QUOTE-B, so
    // the decision must be REFUSED — approving QUOTE-B here would publish a
    // quote the owner was never shown.
    const refused = await store.decideReview(
      'rev_1',
      'approved',
      '2026-10-22T10:00:00.000Z',
      'one-click-link',
      2,
      String(first.recordId),
    );
    assert.equal(refused, null, 'a decision for another record was applied');

    const untouched = await store.list('reviews');
    assert.equal(untouched[0].state, 'pending', 'the named record was flipped anyway');
    assert.equal(untouched[1].state, 'pending', 'the OTHER record was flipped');

    // The link that names the CURRENT record works — and flips only it.
    const applied = await store.decideReview(
      'rev_1',
      'approved',
      '2026-10-22T10:00:00.000Z',
      'one-click-link',
      2,
      String(second.recordId),
    );
    assert.equal(applied?.state, 'approved');
    assert.equal(applied?.quote, 'QUOTE-B', 'the wrong record was flipped');
    const after = await store.list('reviews');
    assert.equal(after[0].state, 'pending', 'the other record was flipped');
    assert.equal(after[1].state, 'approved');
  });

  // --- the fidelity cases: the SQL had to be written for these ---------------

  test(`${name}: a numeric field matches its text form (the file adapter's String() rule)`, async () => {
    const store = await fresh();
    await store.append('comments', { id: 'c1', projectId: 'p1', order: 2 });
    await store.append('comments', { id: 'c2', projectId: 'p1', order: 3 });
    assert.deepEqual(
      (await store.list('comments', { order: '2' })).map((r) => r.id),
      ['c1'],
      'the string "2" matches the number 2',
    );
    assert.deepEqual(
      (await store.list('comments', { order: 2 })).map((r) => r.id),
      ['c1'],
      'the number 2 matches the number 2',
    );
    assert.deepEqual((await store.list('comments', { order: '9' })).map((r) => r.id), []);
  });

  test(`${name}: a boolean field keeps its spelling (true is not 1)`, async () => {
    const store = await fresh();
    await store.append('comments', { id: 'c1', projectId: 'p1', flag: true });
    await store.append('comments', { id: 'c2', projectId: 'p1', flag: false });
    assert.deepEqual(
      (await store.list('comments', { flag: true })).map((r) => r.id),
      ['c1'],
    );
    assert.deepEqual(
      (await store.list('comments', { flag: 'true' })).map((r) => r.id),
      ['c1'],
    );
    assert.deepEqual(
      (await store.list('comments', { flag: false })).map((r) => r.id),
      ['c2'],
    );
    assert.deepEqual((await store.list('comments', { flag: '1' })).map((r) => r.id), [], '1 is not true');
  });

  test(`${name}: a missing field never matches`, async () => {
    const store = await fresh();
    await store.append('comments', { id: 'c1', projectId: 'p1' });
    assert.deepEqual((await store.list('comments', { body: 'anything' })).map((r) => r.id), []);
    assert.deepEqual((await store.list('comments', { projectId: 'p2' })).map((r) => r.id), []);
  });

  test(`${name}: a patch keeps the type of the value it writes`, async () => {
    const store = await fresh();
    await store.append('comments', { id: 'c1', projectId: 'p1', order: 2, flag: false });
    await store.update('comments', { id: 'c1' }, { order: 7, flag: true });
    const record = (await store.list('comments'))[0];
    assert.equal(record.order, 7, 'the number stayed a number');
    assert.equal(record.flag, true, 'the boolean stayed a boolean');
    assert.equal(typeof record.order, 'number');
    assert.equal(typeof record.flag, 'boolean');
  });
}
