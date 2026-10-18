import assert from 'node:assert/strict';
import test from 'node:test';
import { isDurableSubmission, retainSubmission } from '../src/relay/submissionReceipts.js';
import { envelope, room, startRelay, waitUntil } from './support/nodeRelay.mjs';
import { validEnvelope } from '../src/relay/relayValidation.js';

test('a relay confirms persisted approvals and messages while every provider computer is offline', async t => {
  const relay = await startRelay(t);
  const phone = await relay.connect({ control: true });
  phone.send(envelope('phone', 'all'));
  const expected = [];
  for (const agent of ['codex', 'claude', 'cursor', 'grok']) {
    for (const prefix of ['approval-decision-', 'user-message-']) {
      const deliveryId = `${prefix}${agent}-offline`;
      expected.push(deliveryId);
      phone.send(envelope('phone', 'machine', { deliveryId, expiresAt: Date.now() + 60_000 }));
    }
  }
  await waitUntil(() => phone.received.filter(x => x.type === 'relay.stored').length === 8);
  assert.deepEqual(phone.received.filter(x => x.type === 'relay.stored').map(x => x.deliveryId), expected);
  assert.deepEqual(relay.store.queue(room, 'machine').map(x => x.deliveryId), expected);
  assert.equal(relay.sockets.length, 1, 'no machine has connected or acknowledged execution');
  phone.close();
  const machine = await relay.connect();
  machine.send(envelope('machine', 'all'));
  await waitUntil(() => machine.received.length === expected.length);
  assert.deepEqual(machine.received.map(x => x.deliveryId), expected,
    'saved submissions arrive after the originating phone disconnected');
  for (const deliveryId of expected) machine.send(JSON.stringify({ type: 'relay.ack', deliveryId }));
  await waitUntil(() => relay.store.queue(room, 'machine').length === 0);
});

test('fresh catalog traffic cannot evict submissions already promised to a phone', () => {
  const saved = { deliveryId: 'user-message-offline', rawBytes: 20, raw: 'opaque' };
  const old = { deliveryId: 'catalog-old', rawBytes: 20, raw: 'opaque' };
  const fresh = { deliveryId: 'catalog-new', rawBytes: 20, raw: 'opaque' };
  assert.deepEqual(retainSubmission([saved, old], fresh, 2, 40),
    { result: 'stored', rows: [saved, fresh] });
  const next = { ...saved, deliveryId: 'approval-decision-next' };
  assert.deepEqual(retainSubmission([saved], next, 1, 20),
    { result: 'full', rows: [saved] }, 'capacity rejects new work without losing accepted work');
});

test('only explicit immutable submission namespaces reserve durable capacity', () => {
  for (const value of ['user-message-id', 'approval-decision-id', 'attachment-id']) {
    assert.equal(isDurableSubmission(value), true);
  }
  for (const value of [undefined, '', 'random-catalog', 'approval-decision-']) {
    assert.equal(isDurableSubmission(value), false);
  }
});

test('byte pressure preserves submitted rows and legacy rows retain their historical eviction policy', () => {
  const saved = { deliveryId: 'attachment-photo', rawBytes: 30, raw: 'opaque' };
  assert.deepEqual(retainSubmission([saved], { deliveryId: 'snapshot', rawBytes: 11 }, 100, 40),
    { result: 'full', rows: [saved] });
  const legacy = { deliveryId: 'old', raw: '12345' };
  const fresh = { deliveryId: 'new', raw: '123456' };
  assert.deepEqual(retainSubmission([legacy], fresh, 100, 6), { result: 'stored', rows: [fresh] });
  assert.deepEqual(retainSubmission(['old'], fresh, 100, 6), { result: 'stored', rows: [fresh] });
});

test('offline task messages and their attachments can wait thirty days without extending permission lifetimes', () => {
  const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000;
  for (const deliveryId of ['user-message-offline', 'attachment-offline']) {
    const value = JSON.parse(envelope('phone', 'machine', { deliveryId, expiresAt }));
    assert.equal(validEnvelope(value, room), true);
    assert.equal(validEnvelope(value, room, Date.now(), 1_000), false, 'an explicit stricter limit still wins');
    assert.equal(validEnvelope({ ...value, from: 'machine', to: 'phone' }, room), false);
  }
  for (const deliveryId of ['approval-decision-old', 'catalog-old', 'user-message-']) {
    assert.equal(validEnvelope(JSON.parse(envelope('phone', 'machine', { deliveryId, expiresAt })), room), false);
  }
});
