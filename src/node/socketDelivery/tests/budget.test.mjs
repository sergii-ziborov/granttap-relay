import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createSocketDelivery } from '../index.js';

function receiver(bufferedAmount = 0) {
  return Object.assign(new EventEmitter(), { readyState: 1, bufferedAmount, sent: [], closes: [],
    callbacks: [], send(raw, callback) { this.sent.push(raw); this.callbacks.push(callback); },
    close(...args) { this.closes.push(args); }, terminate() { this.readyState = 3; } });
}

test('a slow receiver cannot reserve another ciphertext buffer', () => {
  const delivery = createSocketDelivery({ maxBufferedBytes: 10, maxPendingBytes: 30 });
  const slow = receiver(9);
  assert.equal(delivery.send(slow, 'opaque'), false);
  assert.deepEqual(slow.sent, []);
  assert.deepEqual(slow.closes, [[1013, 'backpressure; retry-after=5']]);
  assert.equal(delivery.pendingBytes, 0);
});

test('aggregate reservations are released on send completion, close and synchronous error', () => {
  const delivery = createSocketDelivery({ maxPendingBytes: 10 });
  const a = receiver(), b = receiver();
  assert.equal(delivery.send(a, '123456'), true);
  assert.equal(delivery.send(b, '12345'), false);
  assert.equal(delivery.pendingBytes, 6);
  a.callbacks[0]();
  assert.equal(delivery.pendingBytes, 0);
  assert.equal(delivery.send(a, '123456'), true);
  a.emit('close'); a.callbacks[1]();
  assert.equal(delivery.pendingBytes, 0);
  a.send = () => { throw Error('closed'); };
  assert.equal(delivery.send(a, '123'), false);
  assert.equal(delivery.pendingBytes, 0);
  assert.equal(delivery.send(a, '123'), false);
});

test('an empty socket may send a single large legal frame within the aggregate budget', () => {
  const delivery = createSocketDelivery({ maxBufferedBytes: 2, maxPendingBytes: 10 });
  const a = receiver();
  assert.equal(delivery.send(a, '12345'), true);
  assert.equal(delivery.pendingBytes, 5);
  a.callbacks[0]();
  assert.equal(delivery.pendingBytes, 0);
});
