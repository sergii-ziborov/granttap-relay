import test from 'node:test';
import assert from 'node:assert/strict';
import { startRelay, lease, closed } from './support/nodeRelay.mjs';
import { managedCooldownIdentity } from '../src/node/managed-admission.js';
import { CoolDownRegistry } from '../src/relay/coolDown.js';
import { clientIdentity } from '../src/node/client-access.js';

test('only signed admission source grants a subscriber or beta category', () => {
  const req = { socket: { remoteAddress: '10.88.0.1' }, headers: { 'x-real-ip': '203.0.113.9', 'x-hostwatch-client-category': 'subscriber' } };
  const env = { HOSTWATCH_TRUSTED_PROXY_IPS: '10.88.0.1' };
  assert.equal(clientIdentity(null, req, env).category, 'anonymous');
  assert.equal(clientIdentity({ source: 'subscription', accountId: 'a', computerId: 'c', publicKey: 'p', expiresAt: 1 }, req, env).category, 'subscriber');
  assert.equal(clientIdentity({ source: 'beta', accountId: 'a', computerId: 'c', publicKey: 'p', expiresAt: 1 }, req, env).category, 'beta');
  assert.equal(clientIdentity({ accountId: 'a', computerId: 'c', publicKey: 'p', expiresAt: 1 }, req, env).category, 'registered');
  assert.equal(clientIdentity(null, req, {}).clientIp, '10.88.0.1');
});
test('verified account/device context reaches quota authority before the WebSocket upgrade', async t => {
  const calls = [];
  const access = { async admit(identity, operation) { calls.push({ identity, operation }); return { allowed: calls.filter(x => x.operation === 'connect').length <= 1 || operation !== 'connect', category: identity.category, reason: 'device-connections', retryAfter: 5, ...(operation === 'connect' ? { leaseId: 'test-lease' } : {}) }; }, close() {} };
  const relay = await startRelay(t, { managed: true, clientAccess: access });
  const ticket = lease({ source: 'subscription' });
  const first = await relay.connect({ ticket });
  const second = await relay.refusal({ ticket });
  assert.equal(second.status, 429); assert.match(second.body, /device-connections/);
  assert.equal(calls[0].identity.category, 'subscriber');
  assert.equal(calls[0].identity.account, calls[1].identity.account);
  assert.equal(calls[0].identity.device, calls[1].identity.device);
  first.terminate();
});

test('a paid device cooldown survives IP changes without locking another device at the same recipient', async t => {
  const coolDowns = new CoolDownRegistry();
  const relay = await startRelay(t, { managed: true, coolDowns });
  const ticketA = lease({ source: 'subscription' });
  const claimA = JSON.parse(Buffer.from(ticketA.split('.')[0], 'base64url').toString());
  coolDowns.strike(managedCooldownIdentity(claimA));
  assert.equal((await relay.refusal({ ticket: ticketA })).status, 429);
  const ticketB = lease({ source: 'subscription', publicKey: Buffer.alloc(32, 9).toString('base64') });
  const good = await relay.connect({ ticket: ticketB });
  assert.equal(good.readyState, 1);
  good.terminate();
});
