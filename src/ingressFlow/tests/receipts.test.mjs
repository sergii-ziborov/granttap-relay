import test from 'node:test';
import assert from 'node:assert/strict';
import { ingressCapabilities, noteIngressFrame } from '../index.js';

test('only negotiated flow emits bounded cumulative read receipts, without ciphertext or delivery acknowledgement', () => {
  const legacy = {}, state = { ingressFlow: true }, frames = [];
  noteIngressFrame(legacy, frame => frames.push(frame));
  assert.equal(frames.length, 0);
  assert.deepEqual(ingressCapabilities(false), {});
  assert.deepEqual(ingressCapabilities(true), { ingressWindow: 64 });
  for (let i = 0; i < 33; i++) noteIngressFrame(state, frame => frames.push(JSON.parse(frame)));
  assert.deepEqual(frames, [{type: 'relay.ingress', received: 16}, {type: 'relay.ingress', received: 32}]);
  assert.equal(state.ingressReceived, 33);
});

test('a hibernated socket resumes its own cumulative counter and provider send failure cannot interrupt routing', () => {
  const state = { ingressFlow: true, ingressReceived: 31 };
  let persisted;
  noteIngressFrame(state, () => { throw Error('closed'); }, () => { persisted = {...state}; });
  assert.equal(persisted.ingressReceived, 32);
  const receipts = [];
  for (let i = 0; i < 16; i++) noteIngressFrame(persisted, frame => receipts.push(JSON.parse(frame)));
  assert.deepEqual(receipts, [{type: 'relay.ingress', received: 48}]);
});
