import assert from 'node:assert/strict';
import test from 'node:test';
import { GrantTapRoom } from '../src/relay/room.js';
import { handleSocketMessage } from '../src/node/socket-messages.js';
import { envelope, room, waitUntil } from './support/nodeRelay.mjs';

function phone() {
  const state = { room, role: 'phone', relayControl: true,
    windowStartedAt: Date.now(), windowMessages: 0 };
  return { relayState: state, readyState: 1, received: [],
    deserializeAttachment: () => state,
    send(raw) { this.received.push(JSON.parse(raw)); } };
}

test('Worker storage acknowledgement follows the completed write and repeats safely', async () => {
  const socket = phone();
  const values = new Map();
  let started = false;
  let release;
  const write = new Promise(resolve => { release = resolve; });
  const storage = { get: async key => values.get(key), delete: async key => values.delete(key),
    put: async (key, value) => { started = true; await write; values.set(key, value); } };
  const relay = new GrantTapRoom({ storage, getWebSockets: () => [socket] }, {});
  const deliveryId = 'approval-decision-worker-offline';
  const raw = envelope('phone', 'machine', { deliveryId, expiresAt: Date.now() + 60_000 });
  const sending = relay.webSocketMessage(socket, raw);
  await waitUntil(() => started);
  assert.deepEqual(socket.received, [], 'an unfinished disk write cannot earn a storage receipt');
  release();
  await sending;
  assert.deepEqual(socket.received, [{ type: 'relay.stored', deliveryId }]);
  assert.equal(values.get('q:machine')[0].deliveryId, deliveryId);
  await relay.webSocketMessage(socket, raw);
  assert.equal(socket.received.length, 2);
  assert.equal(values.get('q:machine').length, 1);
});

test('Worker never reports success when its storage write fails', async () => {
  const socket = phone();
  const storage = { get: async () => undefined, put: async () => { throw new Error('disk'); } };
  const relay = new GrantTapRoom({ storage, getWebSockets: () => [socket] }, {});
  const deliveryId = 'user-message-storage-failure';
  await relay.webSocketMessage(socket, envelope('phone', 'machine', { deliveryId }));
  assert.deepEqual(socket.received, [{ type: 'relay.dropped', deliveryId, reason: 'storage-unavailable' }]);
});

test('Node retains a working socket and never acknowledges failed persistence', () => {
  const socket = phone();
  const store = { enqueue: () => { throw new Error('disk'); } };
  const deliveryId = 'user-message-storage-failure';
  assert.doesNotThrow(() => handleSocketMessage(socket,
    envelope('phone', 'machine', { deliveryId }), { store, sockets: new Map() }));
  assert.deepEqual(socket.received, [{ type: 'relay.dropped', deliveryId, reason: 'storage-unavailable' }]);
});
