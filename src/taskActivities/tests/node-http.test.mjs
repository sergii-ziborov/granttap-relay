import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import test from 'node:test';
import { WebSocket } from 'ws';
import { createRelayServer } from '../../node/server.js';

const room = '3'.repeat(32), credential = '4'.repeat(64);
const nonce = Buffer.alloc(24, 1).toString('base64'), box = Buffer.alloc(96, 2).toString('base64');
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'granttap-activity-http-'));
  const key = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pem = Buffer.from(await crypto.subtle.exportKey('pkcs8', key.privateKey)).toString('base64');
  const sent = [], sockets = [];
  const server = createRelayServer({ databasePath: join(root, 'relay.sqlite3'),
    env: { APNS_TEAM_ID: 'SYNTHETIC_TEAM', APNS_KEY_ID: 'SYNTHETIC_ACTIVITY_HTTP_KEY',
      APNS_PRIVATE_KEY: `-----BEGIN PRIVATE KEY-----\n${pem}\n-----END PRIVATE KEY-----` }, log: () => {},
    pushRequest: async (url, options) => { sent.push({ url, options }); return { ok: true, status: 200 }; } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { for (const socket of sockets) socket.terminate(); await server.shutdown(); rmSync(root, { recursive: true, force: true }); });
  const request = (path, method = 'GET', body, secret = credential) => fetch(`${base}${path}?room=${room}`, {
    method, headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  const pin = () => request('/push/register', 'PUT', { token: 'a'.repeat(64), environment: 'sandbox', bundleId: 'com.ziborov.granttap' });
  const enrollment = { activityId: 'synthetic-activity', token: 'b'.repeat(64), environment: 'sandbox',
    bundleId: 'com.ziborov.granttap', expiresAt: Date.now() + 60_000, nonce, box };
  return { request, pin, enrollment, sent, base, sockets };
}

test('Node activity registration requires an already-authorized room and hides its APNs route', async t => {
  const h = await fixture(t);
  assert.equal((await h.request('/push/activity/register', 'PUT', h.enrollment)).status, 401);
  assert.equal((await h.pin()).status, 200);
  assert.equal((await h.request('/push/activity/register', 'PUT', h.enrollment, 'f'.repeat(64))).status, 401);
  const registered = await h.request('/push/activity/register', 'PUT', h.enrollment);
  assert.equal(registered.status, 200); assert.equal((await registered.json()).enabled, true);
  const listed = await h.request('/push/activity/subscriptions');
  assert.equal(listed.status, 200); const body = await listed.json();
  assert.equal(body.subscriptions.length, 1); assert.equal(JSON.stringify(body).includes(h.enrollment.token), false);
});

test('Node sends opaque ActivityKit state without disturbing an existing relay socket', async t => {
  const h = await fixture(t); await h.pin();
  const socket = new WebSocket(h.base.replace('http:', 'ws:') + `/?room=${room}`,
    { headers: { authorization: `Bearer ${credential}` } }); h.sockets.push(socket); await once(socket, 'open');
  await h.request('/push/activity/register', 'PUT', h.enrollment);
  const update = { activityId: h.enrollment.activityId, deliveryId: 'synthetic-update', event: 'update',
    staleDate: Math.floor(Date.now() / 1_000) + 90, contentState: { nonce, box } };
  const response = await h.request('/push/activity/update', 'POST', update);
  assert.equal(response.status, 200); assert.equal((await response.json()).accepted, true);
  assert.equal(h.sent.length, 1); assert.equal(h.sent[0].options.headers['apns-push-type'], 'liveactivity');
  assert.deepEqual(JSON.parse(h.sent[0].options.body).aps['content-state'], { nonce, box });
  assert.equal(socket.readyState, WebSocket.OPEN);
  const invalid = await h.request('/push/activity/update', 'POST', { ...update, contentState: { title: 'Synthetic private task' } });
  assert.equal(invalid.status, 400); assert.equal(socket.readyState, WebSocket.OPEN);
  assert.equal((await h.request('/push/activity/update', 'POST', update)).status, 200);
  assert.equal(h.sent.length, 1, 'An accepted delivery receipt survives an HTTP retry');
});
