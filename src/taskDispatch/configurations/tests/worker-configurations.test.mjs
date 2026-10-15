import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { GrantTapRoom } from '../../../relay/room.js';

test('Worker exposes only owner-authenticated encrypted latest configuration and schedules its expiry', async () => {
  const roomId = 'a'.repeat(32), id = 'b'.repeat(64), credential = 'c'.repeat(64);
  const values = new Map([['push:auth-sha256', createHash('sha256').update(credential).digest('hex')]]);
  let chain = Promise.resolve(), alarm;
  const storage = {
    get: async key => values.get(key), put: async (key, value) => values.set(key, structuredClone(value)),
    delete: async key => values.delete(key),
    list: async ({ prefix, limit = 1000 }) => new Map([...values].filter(([key]) => key.startsWith(prefix)).slice(0, limit)),
    setAlarm: async value => { alarm = value; }, deleteAlarm: async () => { alarm = undefined; },
    transaction: work => { const next = chain.then(() => work(storage)); chain = next.catch(() => {}); return next; },
  };
  const room = new GrantTapRoom({ storage, getWebSockets: () => [] }, {});
  const now = Date.now(), expiresAt = now + 29 * 86_400_000;
  const body = { issuerKeyId: 'd'.repeat(64), expiresAt, envelope: {
    v: 1, room: roomId, from: 'phone', to: 'machine', senderId: 'controller', deliveryId: id,
    recipientKeyId: 'e'.repeat(64), expiresAt, nonce: 'A'.repeat(32), box: 'B'.repeat(128) } };
  const request = (method, value, token = credential) => room.fetch(new Request(
    `https://relay.test/task-job-configurations/${id}?room=${roomId}`, { method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(value ? { body: JSON.stringify(value) } : {}) }));
  assert.equal((await request('PUT', body)).status, 201);
  assert.equal(alarm, expiresAt);
  const response = await request('GET');
  assert.deepEqual((await response.json()).configuration.envelope, body.envelope);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await request('GET', undefined, 'f'.repeat(64))).status, 401);
  assert.equal((await request('DELETE')).status, 405);
  await room.taskDispatch.maintain(expiresAt + 1);
  assert.equal(values.has(`task-configuration:${roomId}:${id}`), false);
});
