import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WebSocket } from 'ws';
import { createRelayServer } from '../../node/server.js';
import { RelayStore } from '../../node/store.js';

const room = 'a'.repeat(32);
const credential = 'b'.repeat(64);
const recipient = 'c'.repeat(64);
const token = 'd'.repeat(64);
const jobId = '11111111-1111-4111-8111-111111111111';

function job(now = Date.now()) {
  const expiresAt = now + 86_400_000;
  return { notBefore: now, expiresAt,
    acceptanceHash: createHash('sha256').update(token).digest('hex'),
    envelope: { v: 1, room, from: 'phone', to: 'machine', senderId: 'test-controller',
      deliveryId: jobId, recipientKeyId: recipient, expiresAt,
      nonce: 'A'.repeat(32), box: 'A'.repeat(32) } };
}

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'granttap-dispatch-'));
  const databasePath = join(directory, 'relay.sqlite3');
  let server;
  let base;
  const start = async () => {
    const store = new RelayStore(databasePath);
    store.pinAuth(room, createHash('sha256').update(credential).digest('hex'));
    server = createRelayServer({ store, env: {}, taskDispatchIntervalMs: 20 });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}/task-jobs`;
  };
  await start();
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    async request(method, suffix, body, auth = credential) {
      return fetch(`${base}${suffix}?room=${room}`, { method,
        headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}) });
    },
    async machine() {
      const socket = new WebSocket(base.replace('http:', 'ws:').replace('/task-jobs', '/ws') + `?room=${room}`, {
        headers: { authorization: `Bearer ${credential}`, 'X-GrantTap-Recipient-Key-Id': recipient,
          'X-GrantTap-Task-Dispatch': '1' } });
      await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
      return socket;
    },
    async restart() { await new Promise(resolve => server.close(resolve)); await start(); },
  };
}

test('relay retains a queued ciphertext job after controller disconnect and server restart', async t => {
  const relay = await fixture(t);
  const submitted = await relay.request('PUT', `/${jobId}`, job());
  assert.equal(submitted.status, 201);
  assert.equal((await submitted.json()).job.state, 'queued');
  await relay.restart();
  const listed = await relay.request('GET', '');
  assert.equal(listed.status, 200);
  const saved = (await listed.json()).jobs.find(row => row.id === jobId);
  assert.equal(saved.state, 'queued');
  assert.equal(saved.envelope.box, undefined);
  assert.equal((await (await relay.request('GET', `/${jobId}`)).json()).job.envelope.box, 'A'.repeat(32));
  assert.equal('acceptanceHash' in saved, false);
});

test('receiver must possess encrypted acceptance proof and cannot claim a future job early', async t => {
  const relay = await fixture(t);
  assert.equal((await relay.request('PUT', `/${jobId}`, job(Date.now() + 60_000))).status, 201);
  assert.equal((await relay.request('POST', `/${jobId}/claim`, { token, recipientKeyId: recipient, claimId: 'durable-receiver-01' })).status, 409);
  assert.equal((await relay.request('POST', `/${jobId}/claim`, { token: 'f'.repeat(64), recipientKeyId: recipient })).status, 403);
  assert.equal((await relay.request('DELETE', `/${jobId}`)).status, 200);
  assert.equal((await relay.request('POST', `/${jobId}/claim`, { token, recipientKeyId: recipient, claimId: 'durable-receiver-01' })).status, 409);
});

test('immutable job identity prevents duplicate submission from changing the scheduled task', async t => {
  const relay = await fixture(t);
  const body = job();
  assert.equal((await relay.request('PUT', `/${jobId}`, body)).status, 201);
  assert.equal((await relay.request('PUT', `/${jobId}`, body)).status, 200);
  const changed = structuredClone(body); changed.envelope.box = 'B'.repeat(32);
  assert.equal((await relay.request('PUT', `/${jobId}`, changed)).status, 409);
  assert.equal((await relay.request('GET', '', null, 'f'.repeat(64))).status, 401);
});


test('relay dispatches at the scheduled time with no phone connection and records receiver acceptance', async t => {
  const relay = await fixture(t);
  const body = job(Date.now() + 800);
  assert.equal((await relay.request('PUT', `/${jobId}`, body)).status, 201);
  const machine = await relay.machine();
  try {
    const offered = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('scheduled task was not offered')), 3000);
      machine.on('message', raw => {
        const message = JSON.parse(raw.toString());
        if (message.type === 'relay.task-job') { clearTimeout(timeout); resolve({ message, at: Date.now() }); }
      });
    });
    machine.send(JSON.stringify({ ...body.envelope, from: 'machine', to: 'all',
      deliveryId: 'machine-ready', expiresAt: Date.now() + 60_000 }));
    const received = await offered;
    assert.ok(received.at >= body.notBefore);
    assert.equal(received.message.job.envelope.box, body.envelope.box);
    const proof = { token, recipientKeyId: recipient, claimId: 'durable-receiver-01' };
    assert.equal((await relay.request('POST', `/${jobId}/claim`, proof)).status, 200);
    assert.equal((await relay.request('POST', `/${jobId}/claim`, proof)).status, 200);
    assert.equal((await relay.request('DELETE', `/${jobId}`)).status, 409);
    const finished = await relay.request('POST', `/${jobId}/finish`, { ...proof, state: 'completed' });
    assert.equal(finished.status, 200);
    assert.equal((await finished.json()).job.state, 'completed');
    const receipt = await relay.request('GET', `/${jobId}`);
    assert.equal(receipt.status, 200);
    assert.equal((await receipt.json()).job.state, 'completed');
    assert.equal((await relay.request('GET', '/unknown-job')).status, 404);
  } finally { machine.terminate(); }
});
