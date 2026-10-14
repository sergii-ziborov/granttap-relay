import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { WebSocket } from 'ws';
import { createRelayServer } from '../src/node/server.js';
import { RelayStore } from '../src/node/store.js';
import { GrantTapRoom } from '../src/relay/room.js';

const firstKey = '1'.repeat(64);
const secondKey = '2'.repeat(64);

function envelope(room, from, id, recipientKeyId) {
  return {
    v: 1, room, from, to: from === 'phone' ? 'all' : 'phone', senderId: 'fixture',
    nonce: Buffer.alloc(24, 1).toString('base64'), box: Buffer.alloc(24, 2).toString('base64'),
    ...(id ? { deliveryId: id } : {}), ...(recipientKeyId ? { recipientKeyId } : {}),
  };
}

test('a controller receives its own live and retained ciphertext; legacy peers stay compatible', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'granttap-recipient-'));
  const server = createRelayServer({ store: new RelayStore(join(dir, 'db.sqlite')), env: {} });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const room = 'a'.repeat(32);
  const sockets = [];
  const received = new Map();
  const url = `ws://127.0.0.1:${server.address().port}/ws?room=${room}`;
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    await new Promise(resolve => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });
  async function connect(id) {
    const socket = new WebSocket(url, { headers: {
      Authorization: `Bearer ${'b'.repeat(64)}`,
      ...(id ? { 'X-GrantTap-Recipient-Key-Id': id } : {}),
    } });
    sockets.push(socket);
    received.set(socket, []);
    socket.on('message', raw => received.get(socket).push(JSON.parse(raw.toString())));
    await once(socket, 'open');
    return socket;
  }
  const first = await connect(firstKey);
  const second = await connect(secondKey);
  const legacy = await connect();
  for (const socket of [first, second, legacy]) socket.send(JSON.stringify(envelope(room, 'phone')));
  const machine = await connect();
  machine.send(JSON.stringify(envelope(room, 'machine', 'first-only', firstKey)));
  machine.send(JSON.stringify(envelope(room, 'machine', 'second-only', secondKey)));
  machine.send(JSON.stringify(envelope(room, 'machine', 'legacy-compatible')));
  await new Promise(resolve => setTimeout(resolve, 100));
  const deliveries = socket => received.get(socket).filter(frame => frame.from === 'machine').map(frame => frame.deliveryId);
  assert.deepEqual(deliveries(first), ['first-only', 'legacy-compatible']);
  assert.deepEqual(deliveries(second), ['second-only', 'legacy-compatible']);
  assert.equal(deliveries(legacy).length, 3);
  const resumed = await connect(secondKey);
  resumed.send(JSON.stringify(envelope(room, 'phone')));
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual(deliveries(resumed), ['second-only', 'legacy-compatible']);
  const rejected = new WebSocket(url, { headers: {
    Authorization: `Bearer ${'b'.repeat(64)}`, 'X-GrantTap-Recipient-Key-Id': 'bad',
  } });
  rejected.on('error', () => {});
  const [, response] = await once(rejected, 'unexpected-response');
  assert.equal(response.statusCode, 400);
  rejected.terminate();
});

test('Worker preserves other recipients in a mixed retained queue and filters live targets', async () => {
  const first = JSON.stringify({ recipientKeyId: firstKey });
  const second = JSON.stringify({ recipientKeyId: secondKey });
  const queue = [first, second, { raw: second, deliveryId: 'other', expiresAt: Date.now() + 60_000 }];
  const values = new Map([['q:phone', queue]]);
  const sent = [];
  const target = { deserializeAttachment: () => ({ role: 'phone', recipientKeyId: firstKey }), send: raw => sent.push(raw) };
  const other = { deserializeAttachment: () => ({ role: 'phone', recipientKeyId: secondKey }) };
  const room = new GrantTapRoom({
    storage: { get: async key => values.get(key), put: async (key, value) => values.set(key, value), delete: async key => values.delete(key) },
    getWebSockets: () => [target, other],
  }, {});
  await room.flushTo('phone', target);
  assert.deepEqual(sent, [first]);
  assert.deepEqual(values.get('q:phone'), queue.slice(1));
  assert.deepEqual(room.targetsFor({}, { to: 'phone', recipientKeyId: firstKey }), [target]);
});
