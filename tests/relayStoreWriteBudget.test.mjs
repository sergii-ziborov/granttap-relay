import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { RelayStore } from '../src/node/store.js';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'relay-write-budget-'));
  const store = new RelayStore(join(directory, 'queue.sqlite3'));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.pinAuth('room', 'digest');
  return store;
}

const changes = store => store.db.prepare('SELECT total_changes() AS n').get().n;

test('repeated or unknown ACK does not rewrite a retained ciphertext queue', t => {
  const store = fixture(t);
  store.enqueue('room', 'phone', 'opaque', 'keep', Date.now() + 60_000);
  const before = changes(store);
  for (let i = 0; i < 20; i++) store.acknowledge('room', 'phone', 'already-removed');
  assert.equal(changes(store), before, 'idempotent ACK must perform zero durable writes');
  assert.deepEqual(store.queue('room', 'phone').map(row => row.deliveryId), ['keep']);
  store.acknowledge('room', 'phone', 'keep');
  assert.deepEqual(store.queue('room', 'phone'), []);
});

test('an unchanged endpoint announcement does not rewrite durable routing state', t => {
  const store = fixture(t);
  const record = { nonce: 'opaque nonce', box: 'opaque box', expiresAt: Date.now() + 60_000 };
  store.putEndpoint('room', record);
  const before = changes(store);
  for (let i = 0; i < 20; i++) store.putEndpoint('room', record);
  assert.equal(changes(store), before, 'duplicate metadata must not dirty the WAL');
  assert.equal(store.endpoint('room').box, record.box);
  assert.equal(store.endpoint('room:missing'), null);
  const after = changes(store);
  store.deleteEndpoint('room:missing');
  assert.equal(changes(store), after);
});
