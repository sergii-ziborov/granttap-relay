import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { RelayStore } from '../../node/store.js';

test('independent relay writers cannot replace an immutable job with conflicting ciphertext', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'granttap-job-race-'));
  const path = join(directory, 'jobs.sqlite3');
  const initial = new RelayStore(path); initial.close();
  const gate = new SharedArrayBuffer(4);
  const room = 'a'.repeat(32), id = 'concurrent-job-1';
  const now = Date.now(), expiresAt = now + 60_000;
  const workers = [], ready = [], results = [];
  try {
    for (const letter of ['A', 'B', 'C', 'D']) {
      const body = { notBefore: now, expiresAt,
        acceptanceHash: createHash('sha256').update('d'.repeat(64)).digest('hex'), envelope: {
          v: 1, room, from: 'phone', to: 'machine', senderId: 'controller', deliveryId: id,
          recipientKeyId: 'b'.repeat(64), expiresAt, nonce: 'A'.repeat(32), box: letter.repeat(1_700_000) } };
      const worker = new Worker(new URL('./race-worker.mjs', import.meta.url), {
        workerData: { path, gate, room, id, body } });
      workers.push(worker);
      ready.push(new Promise((resolve, reject) => {
        worker.once('message', resolve); worker.once('error', reject);
      }));
      const outcome = new Promise((resolve, reject) => {
        worker.on('message', value => { if (value.status) resolve(value.status); });
        worker.once('error', reject);
      });
      outcome.catch(() => {});
      results.push(outcome);
    }
    await Promise.all(ready);
    Atomics.store(new Int32Array(gate), 0, 1); Atomics.notify(new Int32Array(gate), 0);
    const statuses = await Promise.all(results);
    assert.deepEqual(statuses.sort(), [201, 409, 409, 409]);
  } finally {
    await Promise.all(workers.map(worker => worker.terminate()));
    rmSync(directory, { recursive: true, force: true });
  }
});
