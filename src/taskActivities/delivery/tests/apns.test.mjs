import assert from 'node:assert/strict';
import test from 'node:test';
import { sendTaskActivityAPNs } from '../../index.js';

async function environment() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const bytes = Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  return { APNS_TEAM_ID: 'SYNTHETIC_TEAM', APNS_KEY_ID: 'SYNTHETIC_KEY',
    APNS_PRIVATE_KEY: `-----BEGIN PRIVATE KEY-----\n${bytes.toString('base64')}\n-----END PRIVATE KEY-----` };
}
const now = 1_800_000_000_000;
const device = { token: 'a'.repeat(64), environment: 'sandbox', bundleId: 'com.ziborov.granttap' };
const update = (event = 'update') => ({ activityId: 'synthetic-activity', deliveryId: 'synthetic-delivery', event,
  staleDate: now / 1_000 + 90, contentState: { nonce: Buffer.alloc(24, 1).toString('base64'),
    box: Buffer.alloc(160, 2).toString('base64') } });

test('ActivityKit delivery uses its APNs topic with opaque content state and honest freshness', async () => {
  const env = await environment(); let sent;
  const result = await sendTaskActivityAPNs({ env, device, update: update(), now,
    request: async (url, options) => { sent = { url, options }; return { ok: true, status: 200 }; } });
  assert.equal(result.ok, true); assert.equal(result.stale, false);
  assert.equal(sent.url, 'https://api.sandbox.push.apple.com/3/device/' + device.token);
  assert.equal(sent.options.headers['apns-topic'], 'com.ziborov.granttap.push-type.liveactivity');
  assert.equal(sent.options.headers['apns-push-type'], 'liveactivity');
  assert.equal(sent.options.headers['apns-priority'], '5');
  const body = JSON.parse(sent.options.body);
  assert.deepEqual(body.aps['content-state'], update().contentState);
  assert.equal(body.aps.timestamp, now / 1_000); assert.equal(body.aps['stale-date'], now / 1_000 + 90);
  assert.equal(body.aps.event, 'update'); assert.equal(body.aps.alert, undefined);
  assert.ok(Buffer.byteLength(sent.options.body) <= 4_096);
});

test('ActivityKit end dismisses immediately and stale routes are distinguished from provider refusal', async () => {
  const env = await environment(); let body;
  const ended = await sendTaskActivityAPNs({ env, device: { ...device, environment: 'production' }, update: update('end'), now,
    request: async (_url, options) => { body = JSON.parse(options.body); return { ok: true, status: 200 }; } });
  assert.equal(ended.ok, true); assert.equal(body.aps.event, 'end');
  assert.ok(body.aps['dismissal-date'] < now / 1_000);
  const stale = await sendTaskActivityAPNs({ env, device, update: update(), now,
    request: async () => ({ ok: false, status: 410, json: async () => ({ reason: 'Unregistered' }) }) });
  assert.equal(stale.stale, true);
  const refused = await sendTaskActivityAPNs({ env, device, update: update(), now,
    request: async () => ({ ok: false, status: 403, json: async () => ({ reason: 'TopicDisallowed' }) }) });
  assert.equal(refused.stale, false); assert.equal(refused.ok, false);
});

test('plaintext content state and missing signing configuration never reach APNs', async () => {
  let sends = 0;
  const request = async () => { sends++; return { ok: true, status: 200 }; };
  await assert.rejects(sendTaskActivityAPNs({ env: await environment(), device,
    update: { ...update(), contentState: { title: 'Synthetic private task' } }, now, request }));
  await assert.rejects(sendTaskActivityAPNs({ env: {}, device, update: update(), now, request }));
  assert.equal(sends, 0);
});
