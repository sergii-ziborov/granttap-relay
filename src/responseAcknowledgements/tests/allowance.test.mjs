import test from 'node:test';
import assert from 'node:assert/strict';
import { createResponseAcknowledgements } from '../index.js';

const ack = deliveryId => JSON.stringify({ type: 'relay.ack', deliveryId });

test('response allowances are exact, single-use and socket-specific', () => {
  const credits = createResponseAcknowledgements(), one = {}, two = {};
  assert.equal(credits.consume(one, ack('absent')), false);
  for (const invalid of [undefined, null, '', 'x'.repeat(181), 42]) credits.issue(one, invalid);
  credits.issue(one, 'delivery');
  assert.equal(credits.consume(two, ack('delivery')), false);
  for (const invalid of [null, '{', 'null', '{}', ack(''), ack(42), ack('x'.repeat(181)),
    JSON.stringify({ type: 'other', deliveryId: 'delivery' }),
    JSON.stringify({ type: 'relay.ack', deliveryId: 'delivery', extra: true }),
    JSON.stringify({ type: 'relay.ack', deliveryId: 'delivery', extra: 'x'.repeat(1536) })]) {
    assert.equal(credits.consume(one, invalid), false);
  }
  assert.equal(credits.consume(one, ack('delivery')), true);
  const escaped = '\u0001'.repeat(180);
  credits.issue(one, escaped);
  assert.equal(credits.consume(one, ack(escaped)), true);
  assert.equal(credits.consume(one, ack('delivery')), false);
  credits.issue(one, 'delivery');
  assert.equal(credits.consume(one, ack('delivery')), true);
});

test('allowances expire and issuing a duplicate does not multiply free responses', () => {
  let at = 0;
  const credits = createResponseAcknowledgements({ now: () => at }), socket = {};
  credits.issue(socket, 'old'); credits.issue(socket, 'old');
  at = 30_000;
  assert.equal(credits.consume(socket, ack('old')), false);
  assert.equal(credits.consume(socket, ack('old')), false);
  credits.issue(socket, 'new'); credits.issue(socket, 'new');
  assert.equal(credits.consume(socket, ack('new')), true);
  assert.equal(credits.consume(socket, ack('new')), false);
});

test('a connection retains only its latest 512 delivery identifiers', () => {
  const credits = createResponseAcknowledgements(), socket = {};
  for (let index = 0; index < 513; index++) credits.issue(socket, String(index));
  assert.equal(credits.consume(socket, ack('0')), false);
  for (let index = 1; index < 513; index++) assert.equal(credits.consume(socket, ack(String(index))), true);
});
