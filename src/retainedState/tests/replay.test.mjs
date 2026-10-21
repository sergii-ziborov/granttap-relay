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

test('read cache pressure keeps decryption grants and catalogs ahead of large chat heads', async () => {
  const { retainState, STATE_ROOM_BYTES } = await import('../policy.js');
  const now = Date.now();
  const grant = frame(now, { statePriority: 0 });
  let rows = retainState([], grant, JSON.stringify(grant), now);
  for (let i = 0; i < 20; i++) {
    const head = frame(now + i + 1, { stateKey: i.toString(16).padStart(64, '0'), statePriority: 3,
      box: 'D'.repeat(1000000) });
    rows = retainState(rows, head, JSON.stringify(head), now + i + 1);
  }
  assert.ok(rows.some(row => row.key === grant.stateKey), 'A cached chat must not evict its decryption grant');
  assert.ok(rows.reduce((sum, row) => sum + row.bytes, 0) <= STATE_ROOM_BYTES);
});

test('dormant controller copies cannot crowd out recent readers under cache pressure', async () => {
  const { retainState } = await import('../policy.js');
  const now = Date.now(), other = 'f'.repeat(64);
  const activity = [{ role: 'phone', id: recipient, lastSeenAt: now }];
  const activeHead = frame(now, { statePriority: 3, box: 'D'.repeat(1000000) });
  let rows = retainState([], activeHead, JSON.stringify(activeHead), now, activity);
  for (let i = 0; i < 20; i++) {
    const dormant = frame(now + i + 1, { recipientKeyId: other, statePriority: 2,
      stateKey: i.toString(16).padStart(64, '0'), box: 'D'.repeat(1000000) });
    rows = retainState(rows, dormant, JSON.stringify(dormant), now + i + 1, activity);
  }
  assert.ok(rows.some(row => row.recipient === recipient), 'Previously used phones keep their readable head');
});
