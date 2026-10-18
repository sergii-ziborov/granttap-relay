import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { RelayStore } from '../../../node/store.js';
import { taskDispatchResponse } from '../../index.js';
import { createHash } from 'node:crypto';

const room = 'a'.repeat(32), id = 'b'.repeat(64);
const configuration = (now = Date.now()) => ({ issuerKeyId: 'c'.repeat(64), expiresAt: now + 29 * 86_400_000,
  envelope: { v: 1, room, from: 'phone', to: 'machine', senderId: 'controller', recipientKeyId: 'd'.repeat(64),
    deliveryId: id, expiresAt: now + 29 * 86_400_000, nonce: 'A'.repeat(32), box: 'B'.repeat(128) } });

test('latest encrypted Project configuration survives relay restart and replacement without exposing it to a scoped task writer', async t => {
  const root = mkdtempSync(join(tmpdir(), 'granttap-project-configuration-'));
  const path = join(root, 'relay.sqlite3');
  let relay = new RelayStore(path);
  t.after(() => { relay.close(); rmSync(root, { recursive: true, force: true }); });
  const call = (method, value, owner = true) => taskDispatchResponse({ method, pathname: `/task-job-configurations/${id}`,
    room, authorize: () => owner, read: async () => value, store: relay.taskDispatch });
  assert.deepEqual(await call("GET"), { status: 200, body: { configuration: null } });
  assert.equal((await call("GET", null, false)).status, 401);
  const first = configuration();
  assert.equal((await call('PUT', first)).status, 201);
  relay.close(); relay = new RelayStore(path);
  assert.deepEqual((await call('GET')).body.configuration.envelope, first.envelope);
  const newer = { ...first, envelope: { ...first.envelope, box: 'C'.repeat(128) } };
  assert.equal((await call('PUT', newer)).status, 200);
  assert.deepEqual((await call('GET')).body.configuration.envelope, newer.envelope);
  assert.equal((await call('GET', null, false)).status, 401);
  const secret = 'f'.repeat(64), writerId = 'scoped-config-writer';
  await relay.taskDispatch.writers.put(room, writerId, { sourceKeyId: '1'.repeat(64), recipientKeyId: 'd'.repeat(64),
    scopeHash: '2'.repeat(64), tokenHash: createHash('sha256').update(secret).digest('hex'), expiresAt: Date.now() + 60_000 });
  for (const method of ['GET', 'PUT']) {
    const scoped = await taskDispatchResponse({ method, pathname: `/task-job-configurations/${id}`, room,
      authorize: () => false, credential: `writer:${writerId}:${secret}`, read: async () => first, store: relay.taskDispatch });
    assert.equal(scoped.status, 403, 'A valid task writer cannot read or replace Project permission.');
  }
  const invalid = { ...newer, envelope: { ...newer.envelope, room: 'e'.repeat(32) } };
  assert.equal((await call('PUT', invalid)).status, 400);
  assert.equal((await call('DELETE')).status, 405);
});

test('expired configurations retire and oversized or plaintext configuration bodies are refused', async t => {
  const root = mkdtempSync(join(tmpdir(), 'granttap-project-configuration-expiry-'));
  const relay = new RelayStore(join(root, 'relay.sqlite3'));
  t.after(() => { relay.close(); rmSync(root, { recursive: true, force: true }); });
  const now = Date.now(), first = configuration(now);
  const call = (method, value) => taskDispatchResponse({ method, pathname: `/task-job-configurations/${id}`,
    room, authorize: () => true, read: async () => value, store: relay.taskDispatch });
  assert.equal((await call('PUT', { ...first, plaintext: 'must refuse' })).status, 400);
  assert.equal((await call('PUT', { ...first, envelope: { ...first.envelope, box: 'B'.repeat(100_000) } })).status, 400);
  assert.equal((await call('PUT', first)).status, 201);
  t.mock.method(Date, 'now', () => first.expiresAt + 1);
  assert.deepEqual(await call('GET'), { status: 200, body: { configuration: null } });
});

test('concurrent Project configuration writes share SQLite without overlapping open transactions', async t => {
  const root = mkdtempSync(join(tmpdir(), 'granttap-project-configuration-concurrency-'));
  const relay = new RelayStore(join(root, 'relay.sqlite3'));
  t.after(() => { relay.close(); rmSync(root, { recursive: true, force: true }); });
  const bodies = Array.from({ length: 4 }, (_, index) => {
    const body = configuration();
    const key = String(index + 1).repeat(64);
    return { key, body: { ...body, envelope: { ...body.envelope, deliveryId: key } } };
  });
  const results = await Promise.all(bodies.map(({ key, body }) => relay.taskDispatch.configurations.put(room, key, body)));
  assert.ok(results.every(row => row.status === 201));
  for (const { key } of bodies) assert.ok(await relay.taskDispatch.configurations.get(room, key));
});
