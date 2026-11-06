import assert from 'node:assert/strict';
import test from 'node:test';
import { ACTIVITY_LIMIT, WorkerTaskActivities } from '../../index.js';

class Storage {
  values = new Map(); tail = Promise.resolve();
  async get(key) { return structuredClone(this.values.get(key)); }
  async put(key, value) { this.values.set(key, structuredClone(value)); }
  async delete(key) { this.values.delete(key); }
  transaction(work) {
    const next = this.tail.then(() => work(this));
    this.tail = next.catch(() => {}); return next;
  }
}
const record = (activityId = 'synthetic-activity', expiresAt = 100_000) => ({ activityId,
  token: 'a'.repeat(64), environment: 'sandbox', bundleId: 'com.ziborov.granttap', expiresAt,
  nonce: Buffer.alloc(24, 1).toString('base64'), box: Buffer.alloc(96, 2).toString('base64') });

test('Worker activity routes remain scoped and opaque after the room object restarts', async () => {
  const storage = new Storage(); let store = new WorkerTaskActivities(storage);
  assert.equal(await store.register('room', record(), 1_000), true);
  store = new WorkerTaskActivities(storage);
  assert.deepEqual(await store.list('room', 2_000), [{ activityId: 'synthetic-activity', expiresAt: 100_000,
    nonce: record().nonce, box: record().box }]);
  assert.equal((await store.get('room', 'synthetic-activity', 2_000)).token, record().token);
  assert.deepEqual(await store.list('foreign', 2_000), []);
  assert.equal(await store.get('foreign', 'synthetic-activity', 2_000), undefined);
  await store.remove('foreign', 'synthetic-activity', 2_000);
  assert.equal((await store.list('room', 2_000)).length, 1);
});

test('concurrent Worker registrations preserve capacity and do not evict another phone', async () => {
  const store = new WorkerTaskActivities(new Storage());
  const results = await Promise.all(Array.from({ length: ACTIVITY_LIMIT + 2 }, (_, i) =>
    store.register('room', record(`activity-${i}`, 5_000), 1_000)));
  assert.equal(results.filter(Boolean).length, ACTIVITY_LIMIT);
  assert.equal((await store.list('room', 1_000)).length, ACTIVITY_LIMIT);
  assert.equal(await store.register('room', record('new'), 5_000), true);
  assert.deepEqual((await store.list('room', 5_000)).map(x => x.activityId), ['new']);
  assert.equal(await store.register('room', { ...record(), token: 'invalid' }, 5_000), false);
});

test('Worker token rotation preserves receipts and expired records release their private token', async () => {
  const storage = new Storage(), store = new WorkerTaskActivities(storage);
  await store.register('room', record(), 1_000);
  await store.delivered('room', 'synthetic-activity', 'delivery-1', 2_000);
  await store.register('room', { ...record(), token: 'b'.repeat(64) }, 3_000);
  const route = await store.get('room', 'synthetic-activity', 4_000);
  assert.equal(route.token, 'b'.repeat(64)); assert.equal(route.lastDeliveryId, 'delivery-1');
  assert.equal(route.lastDeliveredAt, 2_000);
  await store.delivered('foreign', 'synthetic-activity', 'wrong', 5_000);
  await store.remove('room', 'missing', 5_000);
  assert.equal((await store.get('room', 'synthetic-activity', 5_000)).lastDeliveryId, 'delivery-1');
  assert.deepEqual(await store.list('room', 100_000), []);
  assert.equal([...storage.values.values()].flat().length, 0);
});
