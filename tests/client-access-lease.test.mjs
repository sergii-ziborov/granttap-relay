import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { setClientDecision } from '../src/node/client-access.js';
import { startRelay, lease, closed, waitUntil } from './support/nodeRelay.mjs';

test('quota responses expose the verified decision and local fallback over HTTP', async t => {
  let decision;
  const server = createServer((_request, response) => {
    setClientDecision(response, decision);
    response.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const absent = await fetch(url);
  assert.equal(absent.headers.get('x-hostwatch-client-category'), null);
  decision = { category: 'subscriber', allowed: true };
  const admitted = await fetch(url);
  assert.equal(admitted.headers.get('x-hostwatch-client-category'), 'subscriber');
  assert.equal(admitted.headers.get('x-hostwatch-client-limit'), 'none');
  assert.equal(admitted.headers.get('x-hostwatch-client-mode'), null);
  decision = { category: 'registered', allowed: false, reason: 'device-connections', fallback: true };
  const refused = await fetch(url);
  assert.equal(refused.headers.get('x-hostwatch-client-limit'), 'device-connections');
  assert.equal(refused.headers.get('x-hostwatch-client-mode'), 'local-fallback');
});

test('live socket renews its quota lease and releases the latest lease on closure', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const calls = [];
  let renewal = { allowed: true, leaseId: 'renewed-lease' };
  const access = {
    async admit(identity, operation, leaseId) {
      calls.push({ identity, operation, leaseId });
      return operation === 'renew' ? renewal : { allowed: true, category: identity.category, leaseId: 'first-lease' };
    },
    close() {},
  };
  const relay = await startRelay(t, { managed: true, clientAccess: access });
  const socket = await relay.connect({ ticket: lease({ source: 'subscription' }) });
  t.mock.timers.tick(15_000);
  await waitUntil(() => calls.some(call => call.operation === 'renew'));
  assert.equal(calls.find(call => call.operation === 'renew').leaseId, 'first-lease');
  renewal = { allowed: false, reason: 'adapter-proof-rejected' };
  t.mock.timers.tick(15_000);
  await waitUntil(() => calls.filter(call => call.operation === 'renew').length === 2);
  assert.equal(socket.readyState, 1, 'quota adapter outage leaves the independent ticket expiry in force');
  renewal = { allowed: false, reason: 'device-connections' };
  const ended = closed(socket);
  t.mock.timers.tick(15_000);
  assert.deepEqual(await ended, { code: 4429, reason: 'device-connections' });
  await waitUntil(() => calls.some(call => call.operation === 'release'));
  const released = calls.find(call => call.operation === 'release');
  assert.equal(released.leaseId, 'renewed-lease');
  assert.deepEqual(released.identity, calls[0].identity);
  const count = calls.length;
  t.mock.timers.tick(60_000);
  assert.equal(calls.length, count, 'closed sockets stop renewing');
});

test('legacy paired sockets retain pairing evidence when renewing and closing', async t => {
  t.mock.timers.enable({apis:['setInterval']});const calls=[];
  const access={async admit(identity,operation){calls.push({identity,operation});return {allowed:true,category:identity.category,leaseId:'paired-lease'};},close(){}};
  const relay=await startRelay(t,{managed:true,clientAccess:access});const socket=await relay.connect();
  t.mock.timers.tick(15000);await waitUntil(()=>calls.some(x=>x.operation==='renew'));
  assert.equal(calls.find(x=>x.operation==='renew').identity.identityKind,'paired-device');
  assert.equal(calls.find(x=>x.operation==='renew').identity.category,'anonymous');
  socket.terminate();await waitUntil(()=>calls.some(x=>x.operation==='release'));
  assert.equal(calls.find(x=>x.operation==='release').identity.identityKind,'paired-device');
});
