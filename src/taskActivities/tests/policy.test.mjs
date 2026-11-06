import assert from 'node:assert/strict';
import test from 'node:test';
import { ACTIVITY_TTL_MS, validActivityRegistration, validActivityUpdate, validActivityId } from '../index.js';

const now = 1_800_000_000_000;
const nonce = Buffer.alloc(24, 1).toString('base64');
const box = Buffer.alloc(96, 2).toString('base64');
const registration = () => ({ activityId: 'synthetic-activity', token: 'a'.repeat(64),
  environment: 'sandbox', bundleId: 'com.ziborov.granttap', expiresAt: now + ACTIVITY_TTL_MS, nonce, box });
const update = () => ({ activityId: 'synthetic-activity', deliveryId: 'synthetic-delivery',
  event: 'update', staleDate: Math.floor(now / 1_000) + 90, contentState: { nonce, box } });

test('an activity registration accepts only bounded opaque key enrollment for GrantTap', () => {
  assert.equal(validActivityRegistration(registration(), now), true);
  assert.equal(validActivityRegistration({ ...registration(), environment: 'production' }, now), true);
  for (const patch of [{ expiresAt: now }, { expiresAt: now + ACTIVITY_TTL_MS + 1 },
    { bundleId: 'other.app' }, { environment: 'unknown' }, { token: 'g'.repeat(64) },
    { token: 'a'.repeat(513) }, { nonce: 'not-base64' }, { box: 'x'.repeat(2_052) },
    { previewKey: 'plaintext-key-is-never-an-HTTP-field' }, { title: 'Synthetic private task' }]) {
    assert.equal(validActivityRegistration({ ...registration(), ...patch }, now), false, JSON.stringify(Object.keys(patch)));
  }
  for (const value of [undefined, null, [], 'unexpected']) assert.equal(validActivityRegistration(value, now), false);
});

test('APNs updates carry encrypted state and a bounded honest stale date', () => {
  assert.equal(validActivityUpdate(update(), now), true);
  assert.equal(validActivityUpdate({ ...update(), event: 'end' }, now), true);
  for (const patch of [{ event: 'start' }, { staleDate: now }, { staleDate: now / 1_000 - 301 },
    { deliveryId: '' }, { title: 'Synthetic private task' }, { contentState: { title: 'Plaintext is forbidden' } },
    { contentState: { nonce, box, preview: 'forbidden' } }, { contentState: { nonce, box: 'x'.repeat(3_076) } }]) {
    assert.equal(validActivityUpdate({ ...update(), ...patch }, now), false, JSON.stringify(Object.keys(patch)));
  }
  for (const value of [undefined, null, [], 1]) assert.equal(validActivityUpdate(value, now), false);
});

test('activity identities are opaque bounded locators, never paths', () => {
  assert.equal(validActivityId('A_1-valid'), true);
  for (const id of ['', 'a'.repeat(181), '../private', '?token=x', 2, null]) assert.equal(validActivityId(id), false);
});
