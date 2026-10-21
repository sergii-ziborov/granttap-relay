import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkerRetainedState } from '../worker.js';
import { GrantTapRoom } from '../../relay/room.js';
const recipient = 'b'.repeat(64), roomId = 'a'.repeat(32), now = Date.now();
const frame = (revision, key = 'c'.repeat(64), bytes = 24) => ({ v: 1, room: roomId, from: 'machine', to: 'phone',
  recipientKeyId: recipient, senderId: 'fixture', nonce: 'A'.repeat(32), box: 'B'.repeat(bytes),
  stateKey: key, stateGroup: key, stateRevision: revision, statePriority: 1, expiresAt: now + 10000 });
function storage() {
  const values = new Map();
  return { values, get: async key => values.get(key), put: async (key, value) => {
    assert.ok(JSON.stringify(value).length < 128000); values.set(key, value);
  }, delete: async key => values.delete(key) };
}
test('Worker retains large encrypted state, replaces it and replays after reconstruction without its publisher', async () => {
  const saved = storage();
  const retained = new WorkerRetainedState(saved);
  const original = frame(now, undefined, 180000);
  await retained.put(original, JSON.stringify(original), now);
  assert.equal((await new WorkerRetainedState(saved).list(recipient))[0].raw, JSON.stringify(original));
  const newer = frame(now + 1);
  await retained.put(newer, JSON.stringify(newer), now + 1);
  assert.equal((await retained.list(recipient)).length, 1);
  assert.equal((await retained.list(recipient))[0].raw, JSON.stringify(newer));
  assert.equal((await retained.list('d'.repeat(64))).length, 0);
  assert.equal((await retained.list(recipient, now + 20000)).length, 0);
  const expired = frame(now + 2, 'e'.repeat(64));
  await retained.put(expired, JSON.stringify(expired), now + 20000);
  assert.equal(saved.values.get('state:index').length, 0);
});
test('Worker socket replays state independently of its reliable ACK queue and reports its own presence', async () => {
  const saved = storage(), sent = [], devices = [];
  const state = { storage: saved, getWebSockets: () => devices };
  const room = new GrantTapRoom(state, {});
  const snapshot = frame(now);
  await room.retainedState.put(snapshot, JSON.stringify(snapshot));
  let attachment = { room: roomId, recipientKeyId: recipient, presenceEnabled: true };
  const socket = { deserializeAttachment: () => attachment, serializeAttachment: next => { attachment = next; },
    send: raw => sent.push(JSON.parse(raw)) };
  devices.push(socket);
  await room.webSocketMessage(socket, JSON.stringify({ v: 1, room: roomId, from: 'phone', to: 'all',
    senderId: 'fixture', nonce: 'A'.repeat(32), box: 'B'.repeat(24) }));
  assert.equal(sent.filter(value => value.stateKey).length, 1);
  assert.equal(sent.find(value => value.type === 'relay.presence').devices[0].online, true);
  await room.webSocketClose(socket);
});
