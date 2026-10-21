import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RelayStore } from '../../node/store.js';
import { validEnvelope } from '../../relay/relayValidation.js';

const room = 'a'.repeat(32), recipient = 'b'.repeat(64);
const frame = (revision, changes = {}) => ({ v: 1, room, from: 'machine', to: 'phone',
  senderId: 'fixture', recipientKeyId: recipient, nonce: 'A'.repeat(32), box: 'B'.repeat(24),
  stateKey: 'c'.repeat(64), stateRevision: revision, statePriority: 1,
  expiresAt: Date.now() + 6 * 86400000, ...changes });

test('retained snapshots are bounded machine-to-recipient envelopes', () => {
  assert.equal(validEnvelope(frame(1), room), true);
  for (const changes of [{ from: 'phone' }, { to: 'all' }, { recipientKeyId: undefined },
    { stateKey: 'chat-name' }, { stateRevision: -1 }, { statePriority: 4 },
    { expiresAt: undefined }, { expiresAt: Date.now() + 8 * 86400000 }]) {
    assert.equal(validEnvelope(frame(1, changes), room), false);
  }
});

test('latest encrypted state survives decrypt ACK and relay restart, scoped by room and recipient', () => {
  const dir = mkdtempSync(join(tmpdir(), 'granttap-state-'));
  let store = new RelayStore(join(dir, 'db.sqlite'));
  try {
    store.pinAuth(room, 'd'.repeat(64));
    const old = frame(1), fresh = frame(2, { box: 'C'.repeat(24) });
    for (const envelope of [old, fresh, old]) store.retainedState.put(room, envelope, JSON.stringify(envelope));
    store.acknowledge(room, 'phone', 'already-decrypted');
    store.close(); store = new RelayStore(join(dir, 'db.sqlite'));
    assert.deepEqual(store.retainedState.list(room, recipient).map(row => JSON.parse(row.raw)), [fresh]);
    assert.deepEqual(store.retainedState.list(room, 'e'.repeat(64)), []);
    assert.deepEqual(store.retainedState.list('f'.repeat(32), recipient), []);
    assert.deepEqual(store.retainedState.list(room, undefined), []);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
