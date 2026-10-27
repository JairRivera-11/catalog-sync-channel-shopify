import test from 'node:test';
import assert from 'node:assert/strict';
import { auditProduct } from '../src/lib/jobs.ts';
import { deferred, fixture, product, pubs } from './helpers.ts';

test('scan compares Publication IDs, respects scheduled channels, skips drafts and does not count preexisting publications as fixes', async t => {
  const scheduled = { ...product('3', [pubs[0].id]), scheduledIds: [pubs[1].id] };
  const f = fixture([product('1', [pubs[0].id]), product('2', pubs.map(p => p.id)), scheduled, { ...product('4'), status: 'DRAFT' }]);
  t.after(() => f.store.close());
  f.jobs.startScan(); await f.jobs.waitForIdle();
  assert.equal(f.store.getJob().scan_status, 'completed');
  assert.equal(f.store.getJob().total_products, 4);
  assert.deepEqual(f.store.getAnalytics(), { total: 4, complete: 2, fixed: 0, incomplete: 1, errors: 0, skipped: 1 });
  f.jobs.startFix(); await f.jobs.waitForIdle();
  assert.deepEqual(f.calls, [{ id: product('1').id, ids: [pubs[1].id] }]);
  assert.equal(f.store.getAnalytics().fixed, 1);
  assert.equal(f.store.getAnalytics().incomplete, 0);
  assert.equal(f.store.getJob().fixed_products, 1);
});

test('subscriptions are skipped and targets outside selection are not required', () => {
  assert.equal(auditProduct({ ...product('1'), requiresSellingPlan: true }, pubs).status, 'skipped');
  assert.equal(auditProduct(product('1', [pubs[0].id]), [pubs[0]]).status, 'complete');
});

test('failures are visible and retried once on the next explicit correction run', async t => {
  const f = fixture(); t.after(() => f.store.close());
  f.jobs.startScan(); await f.jobs.waitForIdle();
  const publish = f.client.publish;
  let attempts = 0;
  f.client.publish = async (...args) => { if (++attempts === 1) throw new Error('Permiso temporalmente denegado'); await publish(...args); };
  f.jobs.startFix(); await f.jobs.waitForIdle();
  assert.equal(attempts, 1);
  assert.equal(f.store.getJob().fix_status, 'error');
  assert.match(f.store.getProducts(1, 50, 'incomplete').products[0].error_message!, /Permiso/);
  f.jobs.startFix(); await f.jobs.waitForIdle();
  assert.equal(attempts, 2);
  assert.equal(f.store.getAnalytics().fixed, 1);
});

test('revalidation skips a product archived after the scan', async t => {
  const f = fixture(); t.after(() => f.store.close());
  f.jobs.startScan(); await f.jobs.waitForIdle();
  f.products.get(product('1').id)!.status = 'ARCHIVED';
  f.jobs.startFix(); await f.jobs.waitForIdle();
  assert.equal(f.calls.length, 0); assert.equal(f.store.getAnalytics().skipped, 1);
});

test('unconfirmed mutations are not reported as fixed', async t => {
  const f = fixture(); t.after(() => f.store.close());
  f.jobs.startScan(); await f.jobs.waitForIdle();
  f.client.publish = async () => {};
  f.jobs.startFix(); await f.jobs.waitForIdle();
  assert.equal(f.store.getAnalytics().fixed, 0);
  assert.equal(f.store.getAnalytics().errors, 1);
});

test('reset waits for an in-flight request and prevents late writes and concurrent jobs', async t => {
  const f = fixture(); t.after(() => f.store.close());
  const started = deferred<void>();
  const batch = deferred<{ products: ReturnType<typeof product>[]; nextCursor: null }>();
  f.client.getProductsBatch = async () => { started.resolve(); return batch.promise; };
  f.jobs.startScan(); await started.promise;
  assert.throws(() => f.jobs.startFix(), /operación actual/);
  assert.throws(() => f.jobs.selectPublications([pubs[0].id]), /operación actual/);
  const resetting = f.jobs.reset();
  assert.throws(() => f.jobs.startScan(), /operación actual/);
  batch.resolve({ products: [product('1')], nextCursor: null });
  await resetting;
  assert.equal(f.jobs.busy, null); assert.equal(f.store.getAnalytics().total, 0);
  assert.equal(f.store.getJob().scan_status, 'idle');
});

test('scan resumes from a committed page and a new scan clears old products and counters', async t => {
  const f = fixture(); t.after(() => f.store.close());
  let fail = true;
  const cursors: (string | null)[] = [];
  f.client.getProductsBatch = async cursor => {
    cursors.push(cursor);
    if (cursor && fail) throw new Error('Network failure');
    return cursor ? { products: [product('2')], nextCursor: null } : { products: [product('1')], nextCursor: 'page-2' };
  };
  f.jobs.startScan(); await f.jobs.waitForIdle();
  assert.equal(f.store.getJob().scanned_products, 1);
  assert.equal(f.store.getJob().next_cursor, 'page-2');
  fail = false; f.jobs.startScan(); await f.jobs.waitForIdle();
  assert.deepEqual(cursors, [null, 'page-2', 'page-2']);
  assert.equal(f.store.getJob().scanned_products, 2);
  f.client.getProductsBatch = async () => ({ products: [product('9')], nextCursor: null });
  f.jobs.startScan(); await f.jobs.waitForIdle();
  assert.equal(f.store.getJob().scanned_products, 1);
  assert.equal(f.store.getProducts(1, 50, 'all').products[0].id, product('9').id);
});

test('changing store invalidates old audit and channel selection', async t => {
  const f = fixture(); t.after(() => f.store.close());
  f.jobs.startScan(); await f.jobs.waitForIdle();
  await f.jobs.saveSettings('another.myshopify.com', 'another-fake-token');
  assert.equal(f.store.getAnalytics().total, 0);
  assert.equal(f.store.getPublications().filter(p => p.selected).length, 0);
});

test('selected channels define the missing-product list and only those missing channels are published', async t => {
  const [a, b] = pubs;
  const c = { id: 'gid://shopify/Publication/3', name: 'Otro canal' };
  const f = fixture([
    product('1', [a.id, b.id]), // Missing only an unselected channel: exclude.
    product('2', [a.id]),       // Missing B.
    product('3', [b.id]),       // Missing A.
    product('4', [c.id]),       // Missing A and B.
    product('5', [a.id, b.id, c.id]),
  ]);
  t.after(() => f.store.close());
  f.client.getPublications = async () => [a, b, c];
  f.store.refreshPublications([a, b, c]);
  f.jobs.startScan(); await f.jobs.waitForIdle();
  const matches = f.store.getProducts(1, 50, 'incomplete');
  assert.equal(matches.pagination.total, 3);
  assert.deepEqual(matches.products.map(p => [p.id, p.missing_channels.map(c => c.id)]), [
    [product('2').id, [b.id]], [product('3').id, [a.id]], [product('4').id, [a.id, b.id]],
  ]);
  assert.equal(f.calls.length, 0, 'Scanning must never activate a channel.');
  f.jobs.startFix(); await f.jobs.waitForIdle();
  assert.deepEqual(f.calls, [
    { id: product('2').id, ids: [b.id] },
    { id: product('3').id, ids: [a.id] },
    { id: product('4').id, ids: [a.id, b.id] },
  ]);
  assert.equal(f.store.getProducts(1, 50, 'incomplete').pagination.total, 0);
  assert.equal(f.products.get(product('4').id)!.publishedIds.includes(c.id), true);
});
