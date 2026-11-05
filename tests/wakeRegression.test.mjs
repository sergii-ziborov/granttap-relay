import assert from 'node:assert/strict';
import test from 'node:test';
import { pushPayload, sendAPNs } from '../src/relay/apnsWake.js';
import { WakeDelivery, WAKE_INTERVAL_MS, WAKE_HISTORY_LIMIT } from '../src/relay/wakeDelivery.js';
import { RelayStore } from '../src/node/store.js';
import { GrantTapRoom } from '../src/relay/room.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createRelayServer } from '../src/node/server.js';
import { waitUntil } from './support/nodeRelay.mjs';

const room = 'a'.repeat(32);
const frame = (id, extra = {}) => ({ v: 1, room, from: 'machine', to: 'phone', senderId: 'test-machine',
  deliveryId: id, wake: true, nonce: 'A'.repeat(32), box: 'A'.repeat(24), ...extra });
function harness(send = async () => true) {
  const rows = new Map(), events = [], calls = [], clock = { now: 1_000_000 };
  const options = { read: async key => structuredClone(rows.get(key)),
    write: async (key, state) => rows.set(key, structuredClone(state)),
    send: async key => { calls.push(key); return send(key); }, now: () => clock.now,
    notify: event => events.push(event) };
  return { rows, events, calls, clock, options, wakes: new WakeDelivery(options) };
}

test('duplicate delivery IDs remain quiet after ACK, restart and a full throttle interval', async () => {
  const h = harness();
  await h.wakes.request(room, frame('same-id'));
  h.clock.now += WAKE_INTERVAL_MS * 2;
  await new WakeDelivery(h.options).request(room, frame('same-id'));
  assert.equal(h.calls.length, 1);
  assert.ok(h.events.includes('duplicate'));
  await h.wakes.request(room, frame('genuinely-new-id'));
  assert.equal(h.calls.length, 2, 'a new delivery after quiet time must still wake');
  assert.equal(await h.wakes.nextAt(room), null);
});

test('burst coalescing has a durable trailing wake, without an idle reminder loop', async () => {
  const h = harness();
  await h.wakes.request(room, frame('first'));
  await h.wakes.request(room, frame('second'));
  await h.wakes.request(room, frame('third'));
  assert.equal(h.calls.length, 1);
  assert.equal(await h.wakes.nextAt(room), h.clock.now + WAKE_INTERVAL_MS);
  await h.wakes.drain(room);
  assert.equal(h.calls.length, 1);
  h.clock.now += WAKE_INTERVAL_MS;
  await new WakeDelivery(h.options).drain(room);
  assert.equal(h.calls.length, 2);
  await h.wakes.drain(room);
  h.clock.now += WAKE_INTERVAL_MS;
  await h.wakes.drain(room);
  assert.equal(h.calls.length, 2);
  assert.ok(h.events.includes('coalesced'));
});

test('simultaneous retransmissions and failed persistence never produce a push burst', async () => {
  const h = harness();
  await Promise.all(Array.from({ length: 30 }, () => h.wakes.request(room, frame('concurrent'))));
  assert.equal(h.calls.length, 1);
  assert.equal(h.wakes.work.size, 0);
  let failed = true;
  const safe = new WakeDelivery({ ...h.options, write: async (...args) => {
    if (failed) throw new Error('disk unavailable'); return h.options.write(...args);
  } });
  await assert.rejects(safe.request('other-room', frame('disk')), /disk unavailable/);
  assert.equal(h.calls.length, 1);
  failed = false;
  await safe.request('other-room', frame('disk'));
  assert.equal(h.calls.length, 2);
});

test('transient retries use a ciphertext fingerprint, with bounded expiring metadata only', async () => {
  const h = harness();
  const transient = frame(undefined);
  await h.wakes.request(room, transient);
  await h.wakes.request(room, transient);
  assert.equal(h.calls.length, 1);
  await h.wakes.request(room, frame('expired', { expiresAt: h.clock.now }));
  for (let i = 0; i < WAKE_HISTORY_LIMIT + 5; i++) await h.wakes.request(room, frame(`unique-${i}`));
  assert.equal(h.rows.get(room).recent.length, WAKE_HISTORY_LIMIT);
  assert.doesNotMatch(JSON.stringify(h.rows.get(room)), /test-machine|unique-|AAAAAAAA/);
  h.clock.now += 15 * 60_000 + 1;
  await h.wakes.drain(room);
  assert.equal(h.rows.get(room).pending, null, 'expired pending work cannot wake later');
  await h.wakes.request(room, frame('fresh-after-expiry'));
  assert.equal(h.rows.get(room).recent.length, 1);
});

test('APNs failures retry at most three times, and success cancels retries', async () => {
  let throws = true;
  const h = harness(async () => { if (throws) throw new Error('network'); return false; });
  await h.wakes.request(room, frame('retry'));
  h.clock.now += WAKE_INTERVAL_MS;
  throws = false;
  await new WakeDelivery(h.options).drain(room);
  h.clock.now += WAKE_INTERVAL_MS;
  await h.wakes.drain(room);
  h.clock.now += WAKE_INTERVAL_MS;
  await h.wakes.drain(room);
  assert.equal(h.calls.length, 3);
  assert.equal(h.rows.get(room).pending, null);
  await h.wakes.request(room, frame('retry'));
  assert.equal(h.calls.length, 3, 'a retransmission cannot reset exhausted retries');
  h.rows.set(room, { pending: { expiresAt: h.clock.now + 1000, attempts: 3 }, nextAt: h.clock.now });
  await h.wakes.drain(room);
  assert.equal(h.calls.length, 3, 'crash recovery preserves the attempt bound');
});

test('SQLite wake receipts survive restart and ACK without deleting encrypted deliveries', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'granttap-wake-'));
  const path = join(dir, 'relay.sqlite3');
  let store = new RelayStore(path);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  store.pinAuth(room, 'opaque-auth-digest');
  const value = frame('encrypted-event', { expiresAt: Date.now() + 300_000 });
  store.enqueue(room, 'phone', JSON.stringify(value), value.deliveryId, value.expiresAt);
  let calls = 0;
  const options = { read: key => store.wakeState(key), write: (key, state) => store.saveWakeState(key, state),
    send: async () => { calls++; return true; } };
  assert.equal(store.wakeState(room), null);
  await new WakeDelivery(options).request(room, value);
  assert.equal(store.queue(room, 'phone')[0].raw, JSON.stringify(value));
  store.acknowledge(room, 'phone', value.deliveryId);
  store.close(); store = new RelayStore(path);
  await new WakeDelivery(options).request(room, value);
  assert.equal(calls, 1);
  assert.equal(store.queue(room, 'phone').length, 0);
  const now = Date.now();
  store.saveWakeState(room, { recent: [], pending: { expiresAt: now + 1000, attempts: 0 }, nextAt: now - 1 });
  assert.deepEqual(store.dueWakeRooms(), [room]);
  await new WakeDelivery(options).drain(room);
  assert.deepEqual(store.dueWakeRooms(), []);
  store.purgeExpiredPairings();
  assert.equal(store.wakeState(room), null);
});

test('Worker forwards/replays ciphertext while deduplicating wakes across ACK and hibernation', async t => {
  const values = new Map();
  let alarm, now = Date.now(), pushes = 0;
  t.mock.method(Date, 'now', () => now);
  const storage = { get: async key => values.get(key), put: async (key, value) => values.set(key, structuredClone(value)),
    delete: async key => values.delete(key), list: async ({ prefix = '' } = {}) => new Map([...values].filter(([key]) => key.startsWith(prefix))),
    setAlarm: async at => { alarm = at; }, deleteAlarm: async () => { alarm = null; } };
  const delivered = [], attachment = { room, role: 'machine' };
  const sender = { deserializeAttachment: () => attachment, send: () => {} };
  const phone = { deserializeAttachment: () => ({ room, role: 'phone' }), send: raw => delivered.push(raw) };
  const state = { storage, getWebSockets: () => [sender, phone] };
  let relay = new GrantTapRoom(state, {});
  relay.sendWakePush = async () => { pushes++; return true; };
  const raw = JSON.stringify(frame('worker-event', { expiresAt: now + 300_000 }));
  await relay.webSocketMessage(sender, raw);
  await relay.webSocketMessage(sender, raw);
  await relay.acknowledge('phone', 'worker-event');
  relay = new GrantTapRoom(state, {});
  relay.sendWakePush = async () => { pushes++; return true; };
  await relay.webSocketMessage(sender, raw);
  assert.equal(pushes, 1);
  assert.deepEqual(delivered, [raw, raw, raw]);
  assert.equal(values.get('q:phone')[0].raw, raw);
  const fresh = JSON.stringify(frame('worker-fresh', { expiresAt: now + 300_000 }));
  await relay.webSocketMessage(sender, fresh);
  assert.equal(pushes, 1);
  assert.equal(alarm, now + WAKE_INTERVAL_MS);
  now += WAKE_INTERVAL_MS;
  await relay.alarm();
  assert.equal(pushes, 2);
  assert.equal(values.get('q:phone').length, 2);
  assert.equal(alarm, null);
});

test('Node live socket delivery, ACK, background APNs and persistent retry pump work together', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'granttap-wake-server-'));
  const store = new RelayStore(join(dir, 'relay.sqlite3'));
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const encoded = Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).toString('base64');
  const env = { APNS_TEAM_ID: 'NODE-WAKE-TEST', APNS_KEY_ID: 'NODE-WAKE-TEST',
    APNS_PRIVATE_KEY: `-----BEGIN PRIVATE KEY-----\n${encoded}\n-----END PRIVATE KEY-----` };
  const requests = [], logs = [], sockets = [];
  let mode = 'success';
  const server = createRelayServer({ store, env, cleanupIntervalMs: 20, log: (event, fields) => logs.push({ event, ...fields }),
    pushRequest: async (url, request) => {
      requests.push(request);
      if (url.endsWith('aa'.repeat(32))) return new Response(null, { status: 410 });
      if (mode === 'throw') throw new Error('private provider response must not appear in logs');
      return new Response(null, { status: mode === 'success' ? 200 : 503 });
    } });
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    await new Promise(resolve => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  async function connect() {
    const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/?room=${room}`,
      { headers: { Authorization: `Bearer ${'b'.repeat(64)}` } });
    sockets.push(socket); socket.received = [];
    socket.on('message', raw => socket.received.push(JSON.parse(raw)));
    await once(socket, 'open'); return socket;
  }
  const machine = await connect(), phone = await connect();
  phone.send(JSON.stringify(frame('ready', { from: 'phone', to: 'all', wake: false })));
  for (const byte of ['aa', 'bb']) store.updatePushToken(room,
    { token: byte.repeat(32), environment: 'production', bundleId: 'com.ziborov.granttap' });
  const value = frame('node-live-wake');
  machine.send(JSON.stringify(value));
  await waitUntil(() => requests.length === 2 && phone.received.some(item => item.deliveryId === value.deliveryId));
  await waitUntil(() => store.wakeState(room)?.pending === null);
  assert.equal(store.pushTokens(room).length, 1, 'stale tokens are pruned without removing healthy devices');
  machine.send(JSON.stringify(value));
  phone.send(JSON.stringify({ type: 'relay.ack', deliveryId: value.deliveryId }));
  await waitUntil(() => store.queue(room, 'phone').length === 0);
  machine.send(JSON.stringify(value));
  await waitUntil(() => phone.received.filter(item => item.deliveryId === value.deliveryId).length === 3);
  assert.equal(requests.length, 2);
  mode = 'reject';
  machine.send(JSON.stringify(frame('node-new-event')));
  await waitUntil(() => store.wakeState(room)?.pending !== null);
  const due = () => { const state = store.wakeState(room); store.saveWakeState(room, { ...state, nextAt: Date.now() - 1 }); };
  due();
  await waitUntil(() => requests.length === 3 && store.wakeState(room)?.pending?.attempts === 1);
  mode = 'throw'; due();
  await waitUntil(() => requests.length === 4 && store.wakeState(room)?.pending?.attempts === 2);
  mode = 'success'; due();
  await waitUntil(() => requests.length === 5 && store.wakeState(room)?.pending === null);
  assert.equal(store.queue(room, 'phone').length, 2);
  for (const request of requests) {
    assert.equal(request.headers['apns-push-type'], 'background');
    assert.deepEqual(JSON.parse(request.body), pushPayload());
  }
  assert.ok(logs.some(item => item.reason === 'background-accepted'));
  assert.ok(logs.some(item => item.reason === 'background-rejected'));
  assert.ok(logs.some(item => item.reason === 'background-failed'));
  assert.doesNotMatch(JSON.stringify(logs), /private provider response|NODE-WAKE-TEST|AAAAAAAA|node-live-wake/);
});

test('opaque synchronization cannot display or sound a Time Sensitive alert', () => {
  assert.deepEqual(pushPayload(), { aps: { 'content-available': 1 }, granttapWake: true });
});

test('ordinary sync uses background APNs semantics and no stale offline delivery', async () => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const encoded = Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).toString('base64');
  const env = { APNS_TEAM_ID: 'WAKE-TEST', APNS_KEY_ID: 'WAKE-TEST',
    APNS_PRIVATE_KEY: `-----BEGIN PRIVATE KEY-----\n${encoded}\n-----END PRIVATE KEY-----` };
  const captured = [];
  await sendAPNs(env, { environment: 'production', token: 'aa'.repeat(32), bundleId: 'com.ziborov.granttap' },
    async (_url, request) => { captured.push(request); return new Response(null, { status: 200 }); });
  assert.equal(captured[0].headers['apns-push-type'], 'background');
  assert.equal(captured[0].headers['apns-priority'], '5');
  assert.equal(captured[0].headers['apns-expiration'], '0');
  assert.equal(captured[0].headers['apns-collapse-id'], 'granttap-wake');
  assert.deepEqual(JSON.parse(captured[0].body), pushPayload());
});
