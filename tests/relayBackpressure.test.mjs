import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { RelayStore } from '../src/node/store.js';
import { createSocketDelivery } from '../src/node/socketDelivery/index.js';
import { handleSocketMessage } from '../src/node/socket-messages.js';

test('a congested computer leaves its message durable and the phone receives its relay receipt', t => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-slow-computer-'));
  const store = new RelayStore(join(directory, 'queue.sqlite3'));
  t.after(() => { store.close(); rmSync(directory, {recursive:true,force:true}); });
  const room = 'a'.repeat(32); store.pinAuth(room, 'digest');
  const received = [], closed = [];
  const phone = Object.assign(new EventEmitter(), {readyState:1,
    relayState:{room,role:'phone',relayControl:true,windowStartedAt:Date.now(),windowMessages:0},
    send: (raw, callback) => { received.push(JSON.parse(raw)); callback?.(); }});
  const computer = {readyState:1,bufferedAmount:100,relayState:{room,role:'machine'},
    send: () => assert.fail('must not append more ciphertext to a congested socket'),
    close: (...args) => closed.push(args)};
  const raw = JSON.stringify({v:1,room,from:'phone',to:'machine',senderId:'test-phone',
    deliveryId:'user-message-durable',nonce:'A'.repeat(32),box:'B'.repeat(24),expiresAt:Date.now()+60_000});
  handleSocketMessage(phone,raw,{store,sockets:new Map([[room,new Set([phone,computer])]]),
    delivery:createSocketDelivery({maxBufferedBytes:10})});
  assert.deepEqual(received,[{type:'relay.stored',deliveryId:'user-message-durable'}]);
  assert.equal(store.queue(room,'machine')[0].raw,raw);
  assert.deepEqual(closed,[[1013,'backpressure; retry-after=5']]);
});
