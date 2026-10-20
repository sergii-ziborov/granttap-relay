import test from 'node:test';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import assert from 'node:assert/strict';
import {RelayStore} from '../src/node/store.js';
import {queueGauges,createRelayCapacity} from '../src/node/capacity/index.js';
import {createMeasurements,capacityIdentity} from '../src/node/capacity/client.mjs';

test('durable receipts and receiver ACKs are counted once; legacy queue age stays unknown',t=>{
 const store=new RelayStore(':memory:');t.after(()=>store.close());store.metrics=createMeasurements();
 const room='a'.repeat(32);store.pinAuth(room,'b'.repeat(64));const raw='private ciphertext that metrics must never contain';
 store.enqueue(room,'machine',raw,'user-message-1',Date.now()+60000);
 store.enqueue(room,'machine',raw,'user-message-1',Date.now()+60000);
 assert.equal(store.metrics.snapshot().counters.receipts,1);
 const gauges=queueGauges(store);assert.equal(gauges.queueCount,1);assert.equal(gauges.queueBytes,Buffer.byteLength(raw));assert.ok(gauges.queueOldestAgeMs>=0);
 assert.ok(!JSON.stringify(gauges).includes(raw));
 store.acknowledge(room,'machine','user-message-1');store.acknowledge(room,'machine','user-message-1');
 assert.equal(store.metrics.snapshot().counters.acknowledgements,1);assert.equal(store.metrics.snapshot().latencies.ack.count,1);
 store.writeQueue(room,'machine',[{raw,rawBytes:Buffer.byteLength(raw),deliveryId:'legacy',expiresAt:Date.now()+60000}]);
 const legacy=queueGauges(store);assert.equal(legacy.queueOldestAgeMs,null);assert.equal(legacy.queueUnknownAgeCount,1);
});
test('live sockets and distinct signed control identities remain separate, with no raw identifiers',t=>{
 const store=new RelayStore(':memory:');t.after(()=>store.close());const sockets=new Map();
 const ticket={accountId:'private-account',computerId:'private-computer',publicKey:'private-key',role:'phone',expiresAt:Date.now()+60000};
 const socket=()=>({readyState:1,relayState:{ticket}});sockets.set('room',new Set([socket(),socket(),{readyState:1,relayState:{}}]));
 const capacity=createRelayCapacity({store,sockets,delivery:{pendingBytes:12},env:{}});t.after(()=>capacity.close());
 const value=capacity.snapshot(capacityIdentity(Buffer.from('k'.repeat(64))));
 assert.equal(value.gauges.controllerSockets,2);assert.equal(value.entities.length,1);assert.equal(value.gauges.unknownSockets,1);
 for(const secret of ['private-account','private-computer','private-key'])assert.ok(!JSON.stringify(value).includes(secret));
});

test('parallel sockets are not reconnects; reopening after the last close is',t=>{
 const dir=mkdtempSync(join(tmpdir(),'capacity-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const key=join(dir,'key');writeFileSync(key,'k'.repeat(64));
 const store=new RelayStore(':memory:');t.after(()=>store.close());const capacity=createRelayCapacity({store,sockets:new Map(),delivery:{pendingBytes:0},env:{HOSTWATCH_CLIENT_ACCESS_SITE:'app',HOSTWATCH_CLIENT_ACCESS_SOCKET:join(dir,'unused.sock'),HOSTWATCH_CLIENT_ACCESS_KEY_FILE:key}});t.after(()=>capacity.close());
 const ticket={accountId:'account',computerId:'machine',publicKey:'key'};
 const first=capacity.connected(ticket),second=capacity.connected(ticket);const tag=capacityIdentity(Buffer.from('k'.repeat(64)));
 assert.equal(capacity.snapshot(tag).counters.reconnects,0);first();second();const third=capacity.connected(ticket);
 assert.equal(capacity.snapshot(tag).counters.reconnects,1);third();
});
