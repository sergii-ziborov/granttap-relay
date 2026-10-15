import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { RelayStore } from '../../../node/store.js';
import { taskDispatchResponse } from '../../index.js';

const room = 'a'.repeat(32), writerId = 'writer-00000001', secret = 'c'.repeat(64);
const digest = value => createHash('sha256').update(value).digest('hex');
const auth = `writer:${writerId}:${secret}`;
const grant = () => ({ sourceKeyId: 'b'.repeat(64), recipientKeyId: 'd'.repeat(64),
  scopeHash: 'e'.repeat(64), tokenHash: digest(secret), expiresAt: Date.now() + 86_400_000 });
const body = id => { const now = Date.now(), expiresAt = now + 60_000;
  return { notBefore: now, expiresAt, acceptanceHash: digest('f'.repeat(64)), envelope: {
    v: 1, room, from: 'phone', to: 'machine', senderId: 'source', deliveryId: id,
    recipientKeyId: 'd'.repeat(64), expiresAt, nonce: 'A'.repeat(32), box: 'A'.repeat(32) } }; };

test('scoped writers survive relay restart and cannot inspect or cancel controller jobs', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'granttap-writers-'));
  const path = join(directory, 'relay.sqlite3');
  let relay = new RelayStore(path);
  t.after(() => { relay.close(); rmSync(directory, { recursive: true, force: true }); });
  const call = (method, pathname, value, token) => taskDispatchResponse({ method, pathname, room,
    authorize: () => !token, credential: token, read: async () => value, store: relay.taskDispatch });
  assert.equal((await call('PUT', `/task-job-writers/${writerId}`, grant())).status, 201);
  assert.equal((await call('PUT', '/task-jobs/controller-job', body('controller-job'))).status, 201);
  relay.close(); relay = new RelayStore(path);
  assert.equal((await call('PUT', '/task-jobs/peer-job-0001', body('peer-job-0001'), auth)).status, 201);
  assert.equal((await call('GET', '/task-jobs/peer-job-0001', null, auth)).body.job.writerId, writerId);
  assert.equal((await call('GET', '/task-jobs/controller-job', null, auth)).status, 404);
  assert.equal((await call('DELETE', '/task-jobs/controller-job', null, auth)).status, 404);
  assert.equal((await call('GET', '/task-jobs', null, auth)).status, 403);
  assert.equal((await call('POST', '/task-jobs/peer-job-0001/claim', {}, auth)).status, 403);
  const wrongTarget = body('peer-job-wrong'); wrongTarget.envelope.recipientKeyId = 'f'.repeat(64);
  assert.equal((await call('PUT', '/task-jobs/peer-job-wrong', wrongTarget, auth)).status, 403);
  assert.equal((await call('PUT', `/task-job-writers/another-writer`, grant(), auth)).status, 403);
  const proof = { token: 'f'.repeat(64), recipientKeyId: 'd'.repeat(64), claimId: 'receiver-attempt-01' };
  assert.equal((await call('POST', '/task-jobs/peer-job-0001/claim', proof)).status, 200);
  const resultEnvelope = { ...body('peer-job-0001').envelope, from: 'machine', to: 'machine', recipientKeyId: 'b'.repeat(64) };
  assert.equal((await call('POST', '/task-jobs/peer-job-0001/finish', { ...proof, state: 'completed', resultEnvelope })).status, 200);
  const complete = (await call('GET', '/task-jobs/peer-job-0001', null, auth)).body.job;
  assert.equal(complete.envelope.box, undefined);
  assert.equal(complete.resultEnvelope.box, resultEnvelope.box);
  assert.equal((await call('PUT', '/task-jobs/peer-job-0002', body('peer-job-0002'), auth)).status, 201);
  assert.equal((await call('DELETE', '/task-jobs/peer-job-0002', null, auth)).status, 200);
  assert.equal((await call('DELETE', `/task-job-writers/${writerId}`)).status, 200);
  assert.equal((await call('PUT', '/task-jobs/peer-job-0002', body('peer-job-0002'), auth)).status, 401);
});

test('an expired writer may recover only its retained job metadata, with no new work or resource access', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'granttap-writer-expiry-'));
  const relay = new RelayStore(join(directory, 'relay.sqlite3'));
  t.after(() => { relay.close(); rmSync(directory, { recursive: true, force: true }); });
  const now = Date.now(), expiresAt = now + 120_000;
  const call = (method, pathname, value) => taskDispatchResponse({ method, pathname, room,
    authorize: () => false, credential: auth, metadataOnly: true, read: async () => value, store: relay.taskDispatch });
  await relay.taskDispatch.writers.put(room, writerId, { ...grant(), expiresAt }, now);
  assert.equal((await call('PUT', '/task-jobs/peer-old-0001', body('peer-old-0001'))).status, 201);
  t.mock.method(Date, 'now', () => expiresAt + 1_000);
  assert.equal((await call('GET', '/task-jobs/peer-old-0001')).status, 200);
  assert.equal((await call('GET', '/task-jobs/controller-job')).status, 404);
  assert.equal((await call('PUT', '/task-jobs/peer-new-0001', body('peer-new-0001'))).status, 401);
  assert.equal((await call('DELETE', '/task-jobs/peer-old-0001')).status, 401);
  assert.equal((await call('GET', '/task-jobs')).status, 401);
  assert.equal((await call('GET', `/task-resources/${writerId}`)).status, 401);
  t.mock.method(Date, 'now', () => expiresAt + 8 * 86_400_000);
  assert.equal((await call('GET', '/task-jobs/peer-old-0001')).status, 401);
});

test('revoking a writer stops new work immediately while retaining access to its own past receipt for recovery', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'granttap-writer-revoke-'));
  const path = join(directory, 'relay.sqlite3');
  let relay = new RelayStore(path);
  t.after(() => { relay.close(); rmSync(directory, { recursive: true, force: true }); });
  const call = (method, pathname, value) => taskDispatchResponse({ method, pathname, room, metadataOnly: true,
    authorize: () => false, credential: auth, read: async () => value, store: relay.taskDispatch });
  await relay.taskDispatch.writers.put(room, writerId, grant());
  assert.equal((await call('PUT', '/task-jobs/peer-past-0001', body('peer-past-0001'))).status, 201);
  await relay.taskDispatch.writers.revoke(room, writerId);
  relay.close(); relay = new RelayStore(path);
  assert.equal((await call('GET', '/task-jobs/peer-past-0001')).status, 200);
  assert.equal((await call('GET', '/task-jobs/other-job-0001')).status, 404);
  assert.equal((await call('PUT', '/task-jobs/peer-new-0001', body('peer-new-0001'))).status, 401);
  assert.equal((await call('GET', `/task-resources/${writerId}`)).status, 401);
  assert.equal((await call('DELETE', '/task-jobs/peer-past-0001')).status, 401);
  t.mock.method(Date, 'now', () => Date.parse('2100-01-01T00:00:00Z'));
  assert.equal((await call('GET', '/task-jobs/peer-past-0001')).status, 401);
});
