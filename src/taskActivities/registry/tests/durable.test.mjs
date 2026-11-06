import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ACTIVITY_LIMIT, SqliteTaskActivities } from '../../index.js';

const record = (activityId = 'synthetic-activity', expiresAt = 100_000) => ({ activityId,
  token: 'a'.repeat(64), environment: 'sandbox', bundleId: 'com.ziborov.granttap', expiresAt,
  nonce: Buffer.alloc(24, 1).toString('base64'), box: Buffer.alloc(96, 2).toString('base64') });

test('a private APNs route survives restart while subscribers only receive opaque enrollment', t => {
  const root = mkdtempSync(join(tmpdir(), 'granttap-activity-store-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'relay.sqlite3'); let database = new DatabaseSync(path);
  let store = new SqliteTaskActivities(database);
  assert.equal(store.register('room-a', record(), 1_000), true); database.close();
  database = new DatabaseSync(path); store = new SqliteTaskActivities(database); t.after(() => database.close());
  assert.deepEqual(store.list('room-a', 2_000), [{ activityId: 'synthetic-activity', expiresAt: 100_000,
    nonce: record().nonce, box: record().box }]);
  assert.equal(store.get('room-a', 'synthetic-activity', 2_000)?.token, record().token);
  assert.deepEqual(store.list('room-b', 2_000), []);
  assert.equal(store.get('room-b', 'synthetic-activity', 2_000), undefined);
  assert.equal(JSON.stringify(store.list('room-a', 2_000)).includes(record().token), false);
});

test('capacity preserves active registrations and only expires old activity routes', t => {
  const database = new DatabaseSync(':memory:'); t.after(() => database.close());
  const store = new SqliteTaskActivities(database);
  for (let i = 0; i < ACTIVITY_LIMIT; i++) assert.equal(store.register('room', record(`activity-${i}`, 5_000), 1_000), true);
  assert.equal(store.register('room', record('overflow'), 1_000), false);
  assert.equal(store.list('room', 1_000).length, ACTIVITY_LIMIT);
  assert.equal(store.register('other', record(), 1_000), true);
  assert.equal(store.register('room', record('new'), 5_000), true);
  assert.deepEqual(store.list('room', 5_000).map(x => x.activityId), ['new']);
  assert.equal(store.get('other', 'missing', 5_000), undefined);
  store.remove('room', 'new'); assert.deepEqual(store.list('room', 6_000), []);
  store.remove('room', 'missing');
});

test('token rotation preserves delivery receipts for the same activity', t => {
  const database = new DatabaseSync(':memory:'); t.after(() => database.close());
  const store = new SqliteTaskActivities(database);
  assert.equal(store.register('room', record(), 1_000), true);
  store.delivered('room', 'synthetic-activity', 'delivery-1', 2_000);
  assert.equal(store.register('room', { ...record(), token: 'b'.repeat(64) }, 3_000), true);
  const route = store.get('room', 'synthetic-activity', 4_000);
  assert.equal(route.token, 'b'.repeat(64));
  assert.equal(route.lastDeliveryId, 'delivery-1'); assert.equal(route.lastDeliveredAt, 2_000);
  store.delivered('other', 'synthetic-activity', 'foreign', 5_000);
  assert.equal(store.get('room', 'synthetic-activity', 5_000).lastDeliveryId, 'delivery-1');
  assert.deepEqual(store.list('room', 100_000), []);
});
