import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { createRelayServer } from '../../node/server.js';
import { RelayStore } from '../../node/store.js';

const room = 'a'.repeat(32), credential = 'b'.repeat(64), phoneKey = 'c'.repeat(64), machineKey = 'd'.repeat(64);
const envelope = (from, changes = {}) => ({ v: 1, room, from, to: 'all', senderId: from,
  nonce: 'A'.repeat(32), box: 'B'.repeat(24), ...changes });
const delay = () => new Promise(resolve => setTimeout(resolve, 50));

test('a restarted relay answers a returning phone with no Mac: keys, catalog, Mesh, chat, presence', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'granttap-replay-wire-'));
  const path = join(dir, 'db.sqlite');
  const sockets = [];
  let server;
  async function start() {
    server = createRelayServer({ store: new RelayStore(path), env: {} });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  }
  async function connect(role, recipient) {
    const frames = [];
    const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/ws?room=${room}`, { headers: {
      Authorization: `Bearer ${credential}`, 'X-GrantTap-Recipient-Key-Id': recipient,
      'X-GrantTap-Recipient-Routing': '1', 'X-GrantTap-Presence': '1',
    } });
    sockets.push(socket);
    socket.on('message', raw => frames.push(JSON.parse(raw)));
    await once(socket, 'open');
    socket.send(JSON.stringify(envelope(role)));
    await delay();
    return { socket, frames };
  }
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    if (server.listening) await server.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });
  await start();
  const machine = await connect('machine', machineKey);
  const now = Date.now();
  for (const priority of [3, 1, 0, 2]) {
    machine.socket.send(JSON.stringify(envelope('machine', { to: 'phone', recipientKeyId: phoneKey,
      stateKey: String(priority).repeat(64), statePriority: priority, stateRevision: now + priority,
      expiresAt: now + 6 * 86400000 })));
  }
  await delay();
  const phone = await connect('phone', phoneKey);
  assert.deepEqual(phone.frames.filter(frame => frame.stateKey).map(frame => frame.statePriority), [0, 1, 2, 3]);
  await server.shutdown();
  await start();
  const returned = await connect('phone', phoneKey);
  assert.deepEqual(returned.frames.filter(frame => frame.stateKey).map(frame => frame.statePriority), [0, 1, 2, 3]);
  const presence = returned.frames.find(frame => frame.type === 'relay.presence');
  assert.equal(presence.devices.find(device => device.role === 'machine').online, false);
  assert.ok(presence.devices.find(device => device.role === 'machine').lastSeenAt > 0);
  const other = await connect('phone', 'e'.repeat(64));
  assert.equal(other.frames.filter(frame => frame.stateKey).length, 0);
});
