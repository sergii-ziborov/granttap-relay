import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { WorkerTaskDispatchStore } from '../worker.js';

const room = 'a'.repeat(32), id = 'large-photo-job', token = 'b'.repeat(64), recipient = 'c'.repeat(64);
function storage() {
  const values = new Map();
  const api = { get: async key => structuredClone(values.get(key)),
    put: async (key, value) => {
      if (Buffer.byteLength(JSON.stringify(value)) > 128 * 1024) throw new Error('Storage value exceeds platform bound');
      values.set(key, structuredClone(value));
    }, delete: async key => values.delete(key),
    list: async ({ prefix, startAfter, limit = 1000 }) => new Map([...values]
      .filter(([key]) => key.startsWith(prefix) && (!startAfter || key > startAfter))
      .sort(([a], [b]) => a.localeCompare(b)).slice(0, limit)),
    transaction: async work => work(api) };
  return { api, values };
}

test('encrypted queued photos exceed one storage value safely and are removed after completion', async () => {
  const s = storage(), store = new WorkerTaskDispatchStore(s.api), now = Date.now(), expiresAt = now + 60_000;
  const box = 'A'.repeat(3_000_000);
  const body = { notBefore: now, expiresAt,
    acceptanceHash: createHash('sha256').update(token).digest('hex'), envelope: {
      v: 1, room, from: 'phone', to: 'machine', senderId: 'controller', deliveryId: id,
      recipientKeyId: recipient, expiresAt, nonce: 'A'.repeat(32), box } };
  assert.equal((await store.put(room, id, body, now)).status, 201);
  const restarted = new WorkerTaskDispatchStore(s.api);
  assert.equal((await restarted.due(room, recipient, now))[0].envelope.box, box);
  assert.equal((await restarted.getPublic(room, id, now)).envelope.box, box);
  const proof = { token, recipientKeyId: recipient, claimId: 'durable-receiver-01' };
  assert.equal((await restarted.transition(room, id, 'claim', proof, now)).status, 200);
  assert.equal((await restarted.transition(room, id, 'finish', { ...proof, state: 'completed' }, now)).status, 200);
  assert.equal([...s.values.keys()].some(key => key.startsWith('task-box:')), false);
  assert.equal((await restarted.getPublic(room, id, now)).envelope.box, undefined);
});
