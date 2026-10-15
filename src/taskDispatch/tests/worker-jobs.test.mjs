import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { GrantTapRoom } from '../../relay/room.js';
import { WorkerTaskDispatchStore } from '../worker.js';
import { offerTaskJobs } from '../socket-offers.js';

const roomId = 'e'.repeat(32);
const recipient = 'c'.repeat(64);
const credential = 'b'.repeat(64);
const token = 'd'.repeat(64);
const id = '11111111-1111-4111-8111-111111111111';
const digest = input => createHash('sha256').update(input).digest('hex');
function job(now = Date.now()) {
  const expiresAt = now + 86_400_000;
  return { notBefore: now, expiresAt, acceptanceHash: digest(token), envelope: {
    v: 1, room: roomId, from: 'phone', to: 'machine', senderId: 'controller',
    deliveryId: id, recipientKeyId: recipient, expiresAt, nonce: 'A'.repeat(32), box: 'A'.repeat(32) } };
}
function harness() {
  const values = new Map([['push:auth-sha256', digest(credential)]]);
  let alarm;
  let transaction = Promise.resolve();
  const storage = {
    get: async key => values.get(key),
    put: async (key, value) => { values.set(key, structuredClone(value)); },
    delete: async key => values.delete(key),
    list: async ({ prefix, startAfter, limit = 1000 }) => new Map([...values]
      .filter(([key]) => key.startsWith(prefix) && (!startAfter || key > startAfter))
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).slice(0, limit)),
    setAlarm: async time => { alarm = time; }, deleteAlarm: async () => { alarm = undefined; },
    transaction: work => {
      const current = transaction.then(() => work(storage));
      transaction = current.catch(() => {});
      return current;
    },
  };
  const sockets = [];
  const room = new GrantTapRoom({ storage, getWebSockets: () => sockets }, {});
  return { room, storage, values, sockets, alarm: () => alarm,
    request(method, path, body, auth = credential) {
      return room.fetch(new Request(`https://relay.test/task-jobs${path}?room=${roomId}`, {
        method, headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}) }));
    } };
}

test('Worker durable job API preserves ciphertext, composes endpoint alarms and rejects cancellation after claim', async () => {
  const h = harness();
  const body = job();
  const endpointExpiry = Date.now() + 1000;
  h.values.set('endpoint:test', { expiresAt: endpointExpiry });
  assert.equal((await h.request('PUT', `/${id}`, body)).status, 201);
  assert.equal(h.alarm(), endpointExpiry);
  assert.equal((await h.request('PUT', `/${id}`, body)).status, 200);
  const saved = (await (await h.request('GET', '')).json()).jobs[0];
  assert.equal(saved.envelope.box, undefined);
  assert.equal((await (await h.request('GET', `/${id}`)).json()).job.envelope.box, body.envelope.box);
  assert.equal('acceptanceHash' in saved, false);
  const proof = { token, recipientKeyId: recipient, claimId: 'durable-receiver-01' };
  assert.equal((await h.request('POST', `/${id}/claim`, proof)).status, 200);
  assert.equal((await h.request('DELETE', `/${id}`)).status, 409);
  const result = await h.request('POST', `/${id}/finish`, { ...proof, state: 'completed' });
  assert.equal((await result.json()).job.state, 'completed');
  assert.equal((await h.request('GET', `/${id}`)).status, 200);
  assert.equal((await h.request('GET', '/unknown-job')).status, 404);
  assert.equal((await h.request('POST', `/${id}/finish`, { ...proof, state: 'completed' })).status, 200);
  assert.equal((await h.request('GET', '', null, 'f'.repeat(64))).status, 401);
});

test('scheduled Worker offers survive a new room instance and retain jobs until durable application acceptance', async () => {
  const h = harness();
  const now = Date.now();
  const body = job(now + 60_000);
  assert.equal((await h.request('PUT', `/${id}`, body)).status, 201);
  assert.equal(h.alarm(), body.expiresAt);
  const recovered = new WorkerTaskDispatchStore(h.storage);
  const sent = [];
  const offered = new Map();
  const offer = at => offerTaskJobs({ store: recovered, room: roomId, recipientKeyId: recipient,
    now: at, offered, send: raw => sent.push(JSON.parse(raw)) });
  await offer(now);
  assert.equal(sent.length, 0);
  await offer(body.notBefore);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].job.envelope.box, body.envelope.box);
  await offer(body.notBefore + 1000);
  assert.equal(sent.length, 1);
  assert.equal((await recovered.list(roomId))[0].state, 'queued');
  assert.equal((await recovered.transition(roomId, id, 'claim', { token, recipientKeyId: recipient, claimId: 'durable-receiver-01' }, body.notBefore)).status, 200);
  await offer(body.notBefore + 20_000);
  assert.equal(sent.length, 1);
});

test('Worker transactions serialize cancellation against receiver claims', async () => {
  const h = harness();
  const store = new WorkerTaskDispatchStore(h.storage);
  assert.equal((await store.put(roomId, id, job())).status, 201);
  const results = await Promise.all([
    store.transition(roomId, id, 'claim', { token, recipientKeyId: recipient, claimId: 'durable-receiver-01' }),
    store.transition(roomId, id, 'cancel'),
  ]);
  assert.deepEqual(results.map(row => row.status).sort(), [200, 409]);
  const final = (await store.list(roomId))[0];
  assert.ok(['accepted', 'cancelled'].includes(final.state));
});

test('Worker offers jobs only to the advertised target and cleans expired queue records', async () => {
  const h = harness();
  const sent = [];
  h.sockets.push({ deserializeAttachment: () => ({ room: roomId, role: 'phone', taskDispatch: true }),
    send: () => assert.fail('a phone cannot receive a machine job') });
  h.sockets.push({ deserializeAttachment: () => ({ room: roomId, role: 'machine', taskDispatch: true,
    recipientKeyId: recipient }), send: raw => sent.push(JSON.parse(raw)) });
  assert.equal((await h.request('PUT', `/${id}`, job())).status, 201);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].job.id, id);
  await h.room.alarm();
  assert.equal(sent.length, 1);
  const store = new WorkerTaskDispatchStore(h.storage);
  const saved = h.values.get(`task-job:${roomId}:${id}`);
  h.values.set(`task-job:${roomId}:${id}`, { ...saved, expiresAt: 1 });
  await store.maintain(Date.now());
  assert.equal((await store.list(roomId)).length, 0);
  assert.equal((await h.request('POST', `/${id}/claim`, { token, recipientKeyId: recipient, claimId: 'durable-receiver-01' })).status, 404);
});


test('Worker dispatch history remains complete beyond one storage page', async () => {
  const h = harness();
  const sample = { ...job(), id, state: 'completed', createdAt: Date.now(), updatedAt: Date.now(), bytes: 0 };
  for (let n = 0; n < 1500; n++) {
    const jobId = `history-${String(n).padStart(8, '0')}`;
    h.values.set(`task-job:${roomId}:${jobId}`, { ...sample, id: jobId });
  }
  const store = new WorkerTaskDispatchStore(h.storage);
  assert.equal((await store.list(roomId)).length, 1500);
  assert.equal((await store.put(roomId, id, job())).status, 201);
});

test('offline queued jobs sleep until expiry and a machine reconnect rearms a future schedule', async () => {
  const h = harness();
  const body = job(Date.now() + 60_000);
  assert.equal((await h.request('PUT', `/${id}`, body)).status, 201);
  assert.equal(h.alarm(), body.expiresAt);
  let attachment = { room: roomId, recipientKeyId: recipient, taskDispatch: true };
  const peer = { deserializeAttachment: () => attachment, serializeAttachment: value => { attachment = value; },
    send: () => {} };
  h.sockets.push(peer);
  await h.room.webSocketMessage(peer, JSON.stringify({ ...body.envelope,
    expiresAt: Date.now() + 60_000, from: 'machine', to: 'all', deliveryId: undefined }));
  assert.equal(h.alarm(), body.notBefore);
});
