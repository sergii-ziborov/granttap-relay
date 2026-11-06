import assert from 'node:assert/strict';
import test from 'node:test';
import { GrantTapRoom } from '../../relay/room.js';
import { routeRequest } from '../../relay/requestRouter.js';
import { proxyLegacyRequest } from '../../relay/legacyProxy.js';

class Storage {
  values = new Map(); tail = Promise.resolve();
  async get(key) { return structuredClone(this.values.get(key)); }
  async put(key, value) { this.values.set(key, structuredClone(value)); }
  async delete(key) { return this.values.delete(key); }
  async list() { return new Map(); }
  async getAlarm() { return null; }
  async setAlarm() {}
  transaction(work) { const next = this.tail.then(() => work(this)); this.tail = next.catch(() => {}); return next; }
}
const room = '5'.repeat(32), credential = '6'.repeat(64);
const nonce = Buffer.alloc(24, 1).toString('base64'), box = Buffer.alloc(96, 2).toString('base64');
const request = (path, method = 'GET', body, secret = credential) => new Request(`https://relay.test${path}?room=${room}`, {
  method, headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
  ...(body ? { body: JSON.stringify(body) } : {}) });

test('Worker activities require the existing room credential and survive object recreation', async () => {
  const state = { storage: new Storage() }; let object = new GrantTapRoom(state, {});
  const enrollment = { activityId: 'synthetic-activity', token: 'a'.repeat(64), environment: 'sandbox',
    bundleId: 'com.ziborov.granttap', expiresAt: Date.now() + 60_000, nonce, box };
  assert.equal((await object.fetch(request('/push/activity/register', 'PUT', enrollment))).status, 401);
  assert.equal((await object.fetch(request('/push/register', 'PUT', enrollment))).status, 200);
  assert.equal((await object.fetch(request('/push/activity/register', 'PUT', enrollment, 'f'.repeat(64)))).status, 401);
  assert.equal((await object.fetch(request('/push/activity/register', 'PUT', enrollment))).status, 200);
  object = new GrantTapRoom(state, {});
  const response = await object.fetch(request('/push/activity/subscriptions'));
  assert.equal(response.status, 200); const body = await response.json();
  assert.equal(body.subscriptions.length, 1); assert.equal(JSON.stringify(body).includes(enrollment.token), false);
  const update = { activityId: enrollment.activityId, deliveryId: 'synthetic-update', event: 'update',
    staleDate: Math.floor(Date.now() / 1_000) + 90, contentState: { nonce, box } };
  assert.equal((await object.fetch(request('/push/activity/update', 'POST', update))).status, 503);
  assert.equal((await object.fetch(request('/push/activity/register', 'DELETE', { activityId: enrollment.activityId }))).status, 200);
  assert.deepEqual((await (await object.fetch(request('/push/activity/subscriptions'))).json()).subscriptions, []);
});

test('Worker front routing and legacy proxy preserve bounded activity endpoints', async () => {
  const seen = [];
  const env = { ROOM: { idFromName: value => value, get: id => ({ fetch: async req => {
    seen.push({ id, path: new URL(req.url).pathname }); return new Response('activity route');
  } }) } };
  const routed = await routeRequest(request('/push/activity/subscriptions'), env);
  assert.equal(routed.status, 200); assert.deepEqual(seen, [{ id: room, path: '/push/activity/subscriptions' }]);
  let upstream;
  const proxied = await proxyLegacyRequest(request('/push/activity/subscriptions'), 'https://old-relay.test', async req => {
    upstream = req; return new Response('activity route');
  });
  assert.equal(proxied.status, 200); assert.equal(new URL(upstream.url).host, 'old-relay.test');
  assert.equal(upstream.headers.get('authorization'), `Bearer ${credential}`);
});
