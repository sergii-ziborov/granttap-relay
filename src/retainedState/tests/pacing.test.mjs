import test from 'node:test';
import assert from 'node:assert/strict';
import { replayNodeFrames } from '../socketReplay.js';
import { createSocketDelivery } from '../../node/socketDelivery/index.js';

test('restoring more than a socket budget waits for each write without disconnecting the phone', async () => {
  const callbacks = [], sent = [], socket = { readyState: 1, bufferedAmount: 0, once() {},
    send(raw, done) { sent.push(raw); this.bufferedAmount += raw.length; callbacks.push(() => { this.bufferedAmount = 0; done(); }); },
    close() { assert.fail('Paced replay must not close a healthy receiver'); } };
  const delivery = createSocketDelivery({ maxBufferedBytes: 100, maxPendingBytes: 1000 });
  const work = replayNodeFrames(socket, Array.from({ length: 5 }, () => ({ raw: 'a'.repeat(80) })), delivery);
  assert.equal(sent.length, 1);
  for (let i = 0; i < 5; i++) {
    callbacks.shift()();
    await Promise.resolve();
  }
  await work;
  assert.equal(sent.length, 5);
  assert.equal(delivery.pendingBytes, 0);
});
