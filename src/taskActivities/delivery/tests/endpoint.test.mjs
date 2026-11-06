import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { SqliteTaskActivities, TaskActivityEndpoint } from '../../index.js';

const room = '1'.repeat(32), foreign = '2'.repeat(32);
const nonce = Buffer.alloc(24, 1).toString('base64'), box = Buffer.alloc(96, 2).toString('base64');
function setup(t, send) {
  const database = new DatabaseSync(':memory:'); t.after(() => database.close());
  const registry = new SqliteTaskActivities(database), sent = [];
  let now = 1_800_000_000_000, configured = true;
  const endpoint = new TaskActivityEndpoint({ registry, now: () => now, configured: () => configured,
    send: send ?? (async (device, update) => { sent.push({ device, update }); return { ok: true, stale: false }; }) });
  const request = (path, method = 'GET', body, scope = room, authorized = true) => endpoint.handle({
    path: '/push/activity/' + path, method, room: scope, authorize: () => authorized, read: async () => body });
  const registration = (token = 'a'.repeat(64)) => ({ activityId: 'synthetic-activity', token,
    environment: 'sandbox', bundleId: 'com.ziborov.granttap', expiresAt: now + 60_000, nonce, box });
  const update = (deliveryId = 'delivery-1', event = 'update') => ({ activityId: 'synthetic-activity', deliveryId,
    event, staleDate: Math.floor(now / 1_000) + 90, contentState: { nonce, box } });
  return { registry, endpoint, request, registration, update, sent,
    advance: ms => { now += ms; }, disable: () => { configured = false; } };
}

test('a room credential protects registration, opaque enrollment and removal', async t => {
  const h = setup(t);
  assert.equal((await h.request('register', 'PUT', h.registration(), room, false)).status, 401);
  assert.deepEqual(h.registry.list(room, 1_800_000_000_000), []);
  const registered = await h.request('register', 'PUT', h.registration());
  assert.equal(registered.status, 200); assert.equal(registered.body.enabled, true);
  const listed = await h.request('subscriptions'); assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.subscriptions, [{ activityId: 'synthetic-activity', expiresAt: 1_800_000_060_000, nonce, box }]);
  assert.equal(JSON.stringify(listed).includes(h.registration().token), false);
  assert.deepEqual((await h.request('subscriptions', 'GET', undefined, foreign)).body.subscriptions, []);
  assert.equal((await h.request('register', 'DELETE', { activityId: 'synthetic-activity' }, foreign)).status, 200);
  assert.equal((await h.request('subscriptions')).body.subscriptions.length, 1);
  assert.equal((await h.request('register', 'DELETE', { activityId: 'synthetic-activity' })).status, 200);
  assert.deepEqual((await h.request('subscriptions')).body.subscriptions, []);
});

test('delivery receipts deduplicate retries and coalesce replacement snapshots', async t => {
  const h = setup(t); await h.request('register', 'PUT', h.registration());
  assert.equal((await h.request('update', 'POST', h.update())).body.accepted, true);
  assert.equal((await h.request('update', 'POST', h.update())).body.duplicate, true);
  assert.equal(h.sent.length, 1);
  assert.equal((await h.request('update', 'POST', h.update('delivery-2'))).status, 202);
  h.advance(15_000);
  assert.equal((await h.request('update', 'POST', h.update('delivery-2'))).body.accepted, true);
  assert.equal(h.sent.length, 2);
  assert.equal((await h.request('update', 'POST', h.update('delivery-3', 'end'))).body.closed, true);
  assert.deepEqual((await h.request('subscriptions')).body.subscriptions, []);
  assert.equal((await h.request('update', 'POST', h.update('delivery-3', 'end'))).body.closed, true);
  assert.equal(h.sent.length, 3);
});

test('expired and unavailable activities cannot expose keys or private transport errors', async t => {
  const h = setup(t, async () => { throw Error('Synthetic private transport detail'); });
  await h.request('register', 'PUT', h.registration());
  const failed = await h.request('update', 'POST', h.update());
  assert.equal(failed.status, 502); assert.equal(JSON.stringify(failed).includes('private transport detail'), false);
  h.disable(); assert.equal((await h.request('update', 'POST', h.update())).status, 503);
  h.advance(60_000); assert.deepEqual((await h.request('subscriptions')).body.subscriptions, []);
  assert.equal((await h.request('update', 'POST', h.update())).body.closed, true);
});

test('the public activity contract rejects plaintext, wrong methods and malformed enrollment', async t => {
  const h = setup(t);
  assert.equal((await h.request('register', 'PUT', { ...h.registration(), title: 'Synthetic private task' })).status, 400);
  assert.equal((await h.request('update', 'POST', { ...h.update(), contentState: { title: 'Not encrypted' } })).status, 400);
  assert.equal((await h.request('register', 'DELETE', { activityId: '../wrong' })).status, 400);
  assert.equal((await h.request('register', 'GET')).status, 405);
  assert.equal((await h.request('subscriptions', 'POST')).status, 405);
  assert.equal((await h.request('update', 'PUT')).status, 405);
  assert.equal((await h.request('unknown')).status, 404);
  assert.equal((await h.request('subscriptions', 'GET', undefined, '../room')).status, 400);
  const malformed = await h.endpoint.handle({ path: '/push/activity/register', method: 'PUT', room,
    authorize: () => true, read: async () => { throw Error('Invalid JSON content'); } });
  assert.equal(malformed.status, 400);
});
