import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WebSocket } from 'ws';
import { createRelayServer } from '../../node/server.js';
import { GrantTapRoom } from '../../relay/room.js';

const room = 'f'.repeat(32), credential = 'a'.repeat(64);
const envelope = () => JSON.stringify({ v: 1, room, from: 'machine', to: 'phone', senderId: 'synthetic',
  nonce: 'A'.repeat(32), box: 'A'.repeat(24), expiresAt: Date.now() + 30_000 });

test('Node negotiates per-connection ingress receipts and preserves legacy clients', async t => {
  const root = mkdtempSync(join(tmpdir(), 'granttap-ingress-'));
  const server = createRelayServer({databasePath: join(root, 'relay.sqlite3'), env: {RELAY_HEARTBEAT_MS: '0'}, log: () => {}});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const sockets = [];
  t.after(async () => { sockets.forEach(ws => ws.terminate()); await server.shutdown(); rmSync(root, {recursive: true, force: true}); });
  async function connect(flow) {
    const frames = [];
    const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/?room=${room}`, {headers: {
      authorization: `Bearer ${credential}`, 'X-GrantTap-Recipient-Routing': '1',
      ...(flow ? {'X-GrantTap-Ingress-Flow': '1'} : {}),
    }});
    sockets.push(ws); ws.on('message', raw => frames.push(JSON.parse(raw.toString())));
    await once(ws, 'open'); await delay(10);
    return {ws, frames};
  }
  const modern = await connect(true);
  assert.equal(modern.frames[0].ingressWindow, 64);
  for (let i = 0; i < 35; i++) modern.ws.send(envelope());
  await delay(30);
  assert.deepEqual(modern.frames.filter(x => x.type === 'relay.ingress').map(x => x.received), [16, 32]);
  modern.ws.send(JSON.stringify({type: 'relay.admission', ticket: 'synthetic-unused-self-hosted-ticket'}));
  for (let i = 0; i < 13; i++) modern.ws.send(envelope());
  await delay(30);
  assert.deepEqual(modern.frames.filter(x => x.type === 'relay.ingress').map(x => x.received), [16, 32, 48]);
  const renewed = await connect(true);
  for (let i = 0; i < 16; i++) renewed.ws.send(envelope());
  await delay(30);
  assert.deepEqual(renewed.frames.filter(x => x.type === 'relay.ingress').map(x => x.received), [16]);
  const legacy = await connect(false);
  assert.equal(legacy.frames[0].ingressWindow, undefined);
  for (let i = 0; i < 20; i++) legacy.ws.send(envelope());
  await delay(30);
  assert.equal(legacy.frames.some(x => x.type === 'relay.ingress'), false);
  const closed = once(modern.ws, 'close');
  for (let i = 0; i < 400; i++) modern.ws.send(envelope());
  assert.equal((await closed)[0], 4429, 'Negotiation never exempts a client from the abuse ceiling');
});

test('Worker read credits survive room recreation and do not become durable delivery acknowledgements', async () => {
  const values = new Map(), frames = [];
  let attachment = {room, role: 'machine', ingressFlow: true, ingressReceived: 15};
  const ws = {deserializeAttachment: () => structuredClone(attachment),
    serializeAttachment: next => { attachment = structuredClone(next); }, send: raw => frames.push(JSON.parse(raw))};
  const state = {getWebSockets: () => [ws], storage: {
    get: async key => values.get(key), put: async (key, value) => values.set(key, value),
    delete: async key => values.delete(key),
  }};
  let object = new GrantTapRoom(state, {});
  const ack = JSON.stringify({type: 'relay.ack', deliveryId: 'synthetic-application-receipt'});
  await object.webSocketMessage(ws, ack);
  assert.equal(attachment.ingressReceived, 16);
  object = new GrantTapRoom(state, {});
  for (let i = 0; i < 16; i++) await object.webSocketMessage(ws, ack);
  assert.equal(attachment.ingressReceived, 32);
  assert.deepEqual(frames, [{type: 'relay.ingress', received: 16}, {type: 'relay.ingress', received: 32}]);
  assert.equal(values.size, 0);
});

test('Worker upgrade advertises a read window only to an opted-in control connection', async () => {
  const originalPair = globalThis.WebSocketPair, originalResponse = globalThis.Response;
  const attachments = [], frames = [], values = new Map();
  globalThis.WebSocketPair = class {
    constructor() {
      this[0] = {};
      this[1] = {serializeAttachment: value => attachments.push(value), send: raw => frames.push(JSON.parse(raw))};
    }
  };
  globalThis.Response = class { constructor(_body, init) { this.status = init.status; } };
  try {
    const object = new GrantTapRoom({acceptWebSocket: () => {}, storage: {
      get: async key => values.get(key), put: async (key, value) => values.set(key, value),
      delete: async key => values.delete(key),
    }}, {});
    const response = await object.acceptWebSocket(new Request(`https://relay.test/?room=${room}`, {headers: {
      upgrade: 'websocket', authorization: `Bearer ${credential}`, 'X-GrantTap-Recipient-Routing': '1',
      'X-GrantTap-Ingress-Flow': '1',
    }}));
    assert.equal(response.status, 101);
    assert.equal(attachments[0].ingressFlow, true);
    assert.equal(frames[0].ingressWindow, 64);
  } finally { globalThis.WebSocketPair = originalPair; globalThis.Response = originalResponse; }
});
