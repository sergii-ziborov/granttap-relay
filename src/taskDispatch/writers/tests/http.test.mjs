import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRelayServer } from '../../../node/server.js';
import { RelayStore } from '../../../node/store.js';
import { GrantTapRoom } from '../../../relay/room.js';

const room = 'a'.repeat(32), owner = 'b'.repeat(64), secret = 'c'.repeat(64), id = 'writer-00000001';
const recipient = 'd'.repeat(64), digest = value => createHash('sha256').update(value).digest('hex');
const grant = () => ({ sourceKeyId: 'e'.repeat(64), recipientKeyId: recipient,
  scopeHash: 'f'.repeat(64), tokenHash: digest(secret), expiresAt: Date.now() + 86_400_000 });

async function nodeFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'granttap-writer-http-'));
  const store = new RelayStore(join(directory, 'relay.sqlite3'));
  store.pinAuth(room, digest(owner));
  const server = createRelayServer({ store, env: {} });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); rmSync(directory, { recursive: true, force: true }); });
  return request => { const url = new URL(request.url);
    return fetch(`http://127.0.0.1:${server.address().port}${url.pathname}${url.search}`, request); };
}

function workerFixture() {
  const values = new Map([['push:auth-sha256', digest(owner)]]);
  let work = Promise.resolve();
  const storage = { get: async key => values.get(key),
    put: async (key, value) => values.set(key, structuredClone(value)),
    delete: async key => values.delete(key),
    list: async ({ prefix, limit = 1000 }) => new Map([...values].filter(([key]) => key.startsWith(prefix)).slice(0, limit)),
    setAlarm: async () => {}, deleteAlarm: async () => {},
    transaction: callback => { const next = work.then(() => callback(storage)); work = next.catch(() => {}); return next; } };
  const target = new GrantTapRoom({ storage, getWebSockets: () => [] }, {});
  return request => target.fetch(request);
}

for (const [name, fixture] of [['Node', nodeFixture], ['Worker', workerFixture]]) {
  test(`${name} writer HTTP grants cannot broaden room authority and expire or revoke independently`, async t => {
    const send = await fixture(t);
    const request = (method, path, body, token = owner) => { const url = new URL(path, 'https://relay.test'); url.searchParams.set('room', room);
      return send(new Request(url, {
      method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}) })); };
    const spec = grant(), credential = `writer:${id}:${secret}`;
    assert.equal((await request('PUT', `/task-job-writers/${id}`, { ...spec, prompt: 'refused' })).status, 400);
    assert.equal((await request('PUT', `/task-job-writers/${id}`, spec)).status, 201);
    assert.equal((await request('PUT', `/task-job-writers/${id}`, spec)).status, 200);
    assert.equal((await request('PUT', `/task-job-writers/${id}`, { ...spec, scopeHash: 'a'.repeat(64) })).status, 409);
    assert.equal((await request('GET', `/task-job-writers/${id}`)).status, 405);
    assert.equal((await request('GET', '/task-jobs', null, credential)).status, 403);
    assert.equal((await request('GET', `/endpoint?recipient=${recipient}`, null, credential)).status, 401);
    assert.equal((await request('GET', '/task-jobs', null, `writer:${id}:${'f'.repeat(64)}`)).status, 401);
    const now = Date.now(), expiresAt = now + 60_000;
    const body = { notBefore: now, expiresAt, acceptanceHash: digest('a'.repeat(64)),
      envelope: { v: 1, room, from: 'phone', to: 'machine', senderId: 'synthetic-source',
        deliveryId: 'peer-job-0001', recipientKeyId: recipient, expiresAt, nonce: 'A'.repeat(32), box: 'A'.repeat(32) } };
    assert.equal((await request('PUT', '/task-jobs/peer-job-0001', body, credential)).status, 201);
    assert.equal((await request('GET', '/task-jobs/peer-job-0001', null, credential)).status, 200);
    const report = { envelope: { ...body.envelope, from: 'machine', to: 'machine',
      recipientKeyId: spec.sourceKeyId, expiresAt: Date.now() + 60_000 } };
    assert.equal((await request('PUT', `/task-resources/${id}`, report)).status, 200);
    assert.equal((await request('GET', `/task-resources/${id}`, null, credential)).status, 200);
    assert.equal((await request('GET', `/task-resources/other-writer`, null, credential)).status, 403);
    assert.equal((await request('PUT', `/task-resources/${id}`, report, credential)).status, 403);
    assert.equal((await request('DELETE', `/task-job-writers/${id}`)).status, 200);
    assert.equal((await request('GET', '/task-jobs/peer-job-0001', null, credential)).status, 401);
  });
}
