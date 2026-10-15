import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { RelayStore } from '../../node/store.js';
import { validEnvelope } from '../../relay/relayValidation.js';
import { taskDispatchResponse } from '../index.js';

const room = 'a'.repeat(32);
const recipient = 'b'.repeat(64);
const token = 'c'.repeat(64);
const id = 'job-00000001';
const now = 1_000_000;
const proof = { token, recipientKeyId: recipient, claimId: 'durable-receiver-01' };
const digest = value => createHash('sha256').update(value).digest('hex');
function body(jobId = id) {
  const expiresAt = now + 60_000;
  return { notBefore: now, expiresAt, acceptanceHash: digest(token), envelope: {
    v: 1, room, from: 'phone', to: 'machine', senderId: 'controller', deliveryId: jobId,
    recipientKeyId: recipient, expiresAt, nonce: 'A'.repeat(32), box: 'A'.repeat(32) } };
}
function store(t) {
  const directory = mkdtempSync(join(tmpdir(), 'granttap-job-state-'));
  const relay = new RelayStore(join(directory, 'jobs.sqlite3'));
  t.after(() => { relay.close(); rmSync(directory, { recursive: true, force: true }); });
  return relay.taskDispatch;
}

test('task jobs reject invalid clocks, unknown metadata, oversized ciphertext and malformed recipients', t => {
  const jobs = store(t);
  const mutations = [
    x => { x.notBefore = -1; }, x => { x.expiresAt = now; },
    x => { x.notBefore = x.expiresAt; }, x => { x.expiresAt = now + 31 * 86_400_000; },
    x => { x.acceptanceHash = 'invalid'; }, x => { x.prompt = 'plaintext is prohibited'; },
    x => { x.envelope.recipientKeyId = 'invalid'; }, x => { x.envelope.deliveryId = 'wrong-id'; },
    x => { x.envelope.to = 'all'; }, x => { x.envelope.expiresAt++; },
    x => { x.envelope.nonce = 'invalid'; }, x => { x.envelope.box = 'A'.repeat(22_000_004); },
  ];
  for (const mutate of mutations) {
    const input = body(); mutate(input);
    assert.equal(jobs.put(room, id, input, now).status, 400);
  }
  assert.equal(jobs.put('invalid', id, body(), now).status, 400);
  assert.equal(jobs.put(room, '..', body(), now).status, 400);
  assert.equal(jobs.put(room, id, null, now).status, 400);
  assert.deepEqual(jobs.list(room, now), []);
});

test('job expiry and retries remain deterministic without resurrecting work', t => {
  const jobs = store(t); const input = body();
  assert.equal(jobs.put(room, id, input, now).status, 201);
  assert.equal(jobs.put(room, id, input, now + 600_000).job.state, 'expired');
  assert.equal(jobs.list(room, now + 600_000)[0].updatedAt, input.expiresAt);
  assert.equal(jobs.transition(room, id, 'claim', proof, now + 600_000).status, 409);
  assert.equal(jobs.transition(room, id, 'cancel', null, now + 600_000).status, 409);
  jobs.purge(now + 8 * 86_400_000);
  assert.deepEqual(jobs.list(room, now + 8 * 86_400_000), []);
});

test('failed execution records only bounded result codes and requires a receiver claim', t => {
  const jobs = store(t); jobs.put(room, id, body(), now);
  assert.equal(jobs.transition(room, 'unknown-job', 'claim', proof, now).status, 404);
  assert.equal(jobs.transition(room, id, 'claim', { ...proof, recipientKeyId: 'd'.repeat(64) }, now).status, 403);
  assert.equal(jobs.transition(room, id, 'finish', { ...proof, state: 'failed' }, now).status, 409);
  assert.equal(jobs.transition(room, id, 'claim', proof, now).status, 200);
  assert.equal(jobs.transition(room, id, 'finish', { ...proof, token: 'd'.repeat(64), state: 'failed' }, now).status, 403);
  assert.equal(jobs.transition(room, id, 'finish', { ...proof, state: 'arbitrary' }, now).status, 400);
  assert.equal(jobs.transition(room, id, 'finish', { ...proof, state: 'failed', resultCode: 'unbounded text' }, now).status, 400);
  const result = jobs.transition(room, id, 'finish', { ...proof, state: 'failed', resultCode: 'policy_denied' }, now);
  assert.equal(result.job.state, 'failed');
  assert.equal(result.job.resultCode, 'policy_denied');
  assert.equal(jobs.transition(room, id, 'finish', { ...proof, state: 'completed' }, now).status, 409);
  assert.equal(jobs.transition(room, id, 'finish', { ...proof, state: 'failed' }, now).status, 200);
  assert.equal('acceptanceHash' in result.job, false);
});

test('full job queues reject overflow without evicting accepted or pending work', t => {
  const jobs = store(t);
  for (let n = 0; n < 100; n++) {
    const jobId = `job-${String(n).padStart(8, '0')}`;
    assert.equal(jobs.put(room, jobId, body(jobId), now).status, 201);
  }
  assert.equal(jobs.put(room, 'job-overflow', body('job-overflow'), now).status, 429);
  assert.equal(jobs.list(room, now).length, 100);
  assert.ok(jobs.get(room, 'job-00000000'));
  assert.equal(jobs.transition(room, 'job-00000000', 'cancel', null, now).job.state, 'cancelled');
  assert.equal(jobs.transition(room, 'job-00000000', 'cancel', null, now).status, 200);
  assert.equal(jobs.put(room, 'job-after-cancel', body('job-after-cancel'), now).status, 201);
});

test('long scheduling windows do not broaden legacy WebSocket envelope lifetimes', t => {
  const jobs = store(t); const input = body();
  input.expiresAt = input.envelope.expiresAt = now + 10 * 86_400_000;
  input.notBefore = now + 9 * 86_400_000;
  assert.equal(validEnvelope(input.envelope, room, now), false);
  assert.equal(jobs.put(room, id, input, now).status, 201);
  assert.deepEqual(jobs.due(room, recipient, now), []);
  assert.equal(jobs.due(room, recipient, input.notBefore).length, 1);
});

test('job HTTP surface requires a supported method and bounded job identity', async () => {
  const call = overrides => taskDispatchResponse({ method: 'GET', pathname: '/task-jobs', room,
    authorize: () => true, read: () => null, store: {}, ...overrides });
  assert.equal((await call({ room: 'invalid' })).status, 400);
  assert.equal((await call({ authorize: () => false })).status, 401);
  assert.equal((await call({ pathname: '/task-jobs/..' })).status, 400);
  assert.equal((await call({ method: 'PATCH' })).status, 405);
});


test('completed message receipts preserve deduplication without occupying the pending queue', t => {
  const jobs = store(t); const input = body();
  jobs.put(room, id, input, now);
  jobs.transition(room, id, 'claim', proof, now);
  const completed = jobs.transition(room, id, 'finish', { ...proof, state: 'completed' }, now);
  assert.equal(completed.job.state, 'completed');
  assert.equal('box' in completed.job.envelope, false);
  assert.equal(jobs.put(room, id, input, now + 1000).job.state, 'completed');
});

test('a corrupt stored room fails explicitly without leaving the database transaction open', t => {
  const jobs = store(t);
  jobs.db.prepare('INSERT INTO task_jobs(room,id,record) VALUES (?,?,?)').run(room, 'corrupt-job', 'invalid json');
  assert.throws(() => jobs.list(room, now));
  const otherRoom = 'f'.repeat(32), input = body(); input.envelope.room = otherRoom;
  assert.equal(jobs.put(otherRoom, id, input, now).status, 201);
  assert.equal(jobs.getPublic(otherRoom, id, now).state, 'queued');
});

test('an unexpired queued upload may arrive after its original due time', t => {
  const jobs = store(t), input = body();
  input.notBefore = now - 600_000;
  assert.equal(jobs.put(room, id, input, now).status, 201);
  assert.equal(jobs.due(room, recipient, now)[0].id, id);
});

test('only the winning durable receiver attempt may claim and finish one queued job', t => {
  const jobs = store(t); jobs.put(room, id, body(), now);
  const first = { ...proof, claimId: 'first-durable-receiver' };
  const second = { ...proof, claimId: 'other-durable-receiver' };
  assert.equal(jobs.transition(room, id, 'claim', first, now).status, 200);
  assert.equal(jobs.transition(room, id, 'claim', first, now).status, 200);
  assert.equal(jobs.transition(room, id, 'claim', second, now).status, 409);
  assert.equal(jobs.transition(room, id, 'finish', { ...second, state: 'completed' }, now).status, 403);
  assert.equal(jobs.transition(room, id, 'finish', { ...first, state: 'completed' }, now).status, 200);
});
