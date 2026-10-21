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
  stateKey: 'c'.repeat(64), stateGroup: '9'.repeat(64), stateRevision: revision, statePriority: 1,
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
    const head = frame(now + i + 1, { stateKey: i.toString(16).padStart(64, '0'), stateGroup: i.toString(16).padStart(64, '0'), statePriority: 3,
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
      stateKey: i.toString(16).padStart(64, '0'), stateGroup: i.toString(16).padStart(64, '0'), box: 'D'.repeat(1000000) });
    rows = retainState(rows, dormant, JSON.stringify(dormant), now + i + 1, activity);
  }
  assert.ok(rows.some(row => row.recipient === recipient), 'Previously used phones keep their readable head');
});

test('slot pressure evicts a scoped key and its head together, preserving catalog discovery', async () => {
  const { retainState } = await import('../policy.js');
  const now = Date.now();
  const catalog = frame(now, { stateKey: 'f'.repeat(64), stateGroup: undefined, statePriority: 1 });
  let rows = retainState([], catalog, JSON.stringify(catalog), now);
  for (let i = 0; i < 300; i++) {
    const stateGroup = (i + 1).toString(16).padStart(64, '0');
    const grant = frame(now + i + 1, { stateKey: (i * 2).toString(16).padStart(64, '0'), stateGroup, statePriority: 0 });
    const head = frame(now + i + 1, { stateKey: (i * 2 + 1).toString(16).padStart(64, '0'), stateGroup, statePriority: 3 });
    rows = retainState(rows, grant, JSON.stringify(grant), now + i + 1);
    rows = retainState(rows, head, JSON.stringify(head), now + i + 1);
  }
  assert.ok(rows.some(row => row.key === catalog.stateKey));
  const groups = new Map();
  for (const row of rows) {
    const group = JSON.parse(row.raw).stateGroup;
    if (group) groups.set(group, (groups.get(group) ?? 0) + 1);
  }
  assert.ok(groups.size > 0);
  assert.ok([...groups.values()].every(count => count === 2));
  assert.ok(rows.length <= 512);
});

test('legacy read-cache migration preserves catalogs and the durable delivery queue', () => {
  const dir = mkdtempSync(join(tmpdir(), 'granttap-state-migration-'));
  let store = new RelayStore(join(dir, 'db.sqlite'));
  try {
    store.pinAuth(room, 'd'.repeat(64));
    const raw = JSON.stringify(frame(Date.now(), { stateGroup: undefined, statePriority: 1 }));
    store.retainedState.put(room, JSON.parse(raw), raw);
    store.enqueue(room, 'machine', 'synthetic queued ciphertext', 'queued-job', Date.now() + 10000);
    store.db.exec('ALTER TABLE retained_state DROP COLUMN state_group');
    store.close(); store = new RelayStore(join(dir, 'db.sqlite'));
    assert.equal(store.retainedState.list(room, recipient).length, 1);
    assert.equal(store.queue(room, 'machine')[0].deliveryId, 'queued-job');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
