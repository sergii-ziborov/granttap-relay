import assert from 'node:assert/strict';
import test from 'node:test';
import { GrantTapRoom } from '../src/relay/room.js';
import { envelope, room, startRelay, waitUntil } from './support/nodeRelay.mjs';

test('a permitted image submission is stored offline and replayed without disconnecting the phone', async t => {
  const relay = await startRelay(t);
  const phone = await relay.connect({ control: true });
  phone.send(envelope('phone', 'all'));
  const deliveryId = 'user-message-image-fixture';
  const value = JSON.parse(envelope('phone', 'machine', { deliveryId, expiresAt: Date.now() + 60_000 }));
  value.box = Buffer.alloc(2_100_000, 7).toString('base64');
  const raw = JSON.stringify(value);
  phone.send(raw);
  await waitUntil(() => phone.received.some(x => x.type === 'relay.stored' && x.deliveryId === deliveryId));
  assert.equal(phone.readyState, 1);
  assert.equal(relay.store.queue(room, 'machine')[0].raw, raw);
  const machine = await relay.connect();
  machine.send(envelope('machine', 'all'));
  await waitUntil(() => machine.received.some(x => x.deliveryId === deliveryId));
  assert.equal(machine.received.find(x => x.deliveryId === deliveryId).box, value.box);
  machine.send(JSON.stringify({ type: 'relay.ack', deliveryId }));
  await waitUntil(() => relay.store.queue(room, 'machine').length === 0);
  assert.equal(phone.readyState, 1);
});

test('a storage-size rejection reports the exact submission and preserves the control socket', async () => {
  const state = { room, role: 'phone', relayControl: true, windowStartedAt: Date.now(), windowMessages: 0 };
  const received = [], closes = [];
  const phone = { deserializeAttachment: () => state, serializeAttachment() {},
    send: raw => received.push(JSON.parse(raw)), close: (...args) => closes.push(args) };
  const relay = new GrantTapRoom({ getWebSockets: () => [phone], storage: { get: async () => undefined } }, {});
  const deliveryId = 'user-message-oversized-for-worker';
  const value = JSON.parse(envelope('phone', 'machine', { deliveryId }));
  value.box = 'A'.repeat(1_800_000);
  await relay.webSocketMessage(phone, JSON.stringify(value));
  assert.deepEqual(received, [{ type: 'relay.dropped', deliveryId, reason: 'oversize' }]);
  assert.deepEqual(closes, [], 'A storage budget is not a WebSocket protocol violation');
});
