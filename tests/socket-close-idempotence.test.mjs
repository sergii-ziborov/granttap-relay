import assert from 'node:assert/strict';
import test from 'node:test';
import { WebSocket } from 'ws';
import { CoolDownRegistry } from '../src/relay/coolDown.js';
import { closeForPolicy } from '../src/node/socket-policy.js';
import { handleSocketMessage } from '../src/node/socket-messages.js';

function fixture() {
  const coolDowns = new CoolDownRegistry({ now: () => 1_000 });
  const closes = [], logs = [];
  const ws = {
    readyState: WebSocket.OPEN,
    relayState: { room: 'a'.repeat(32), role: 'machine', identity: 'fixture-machine',
      windowStartedAt: Date.now(), windowMessages: 300,
      policy: { coolDowns, log: (...args) => logs.push(args) } },
    close(code, reason) { closes.push({ code, reason }); this.readyState = WebSocket.CLOSING; },
  };
  return { ws, coolDowns, closes, logs };
}

test('one rate-limited socket cannot turn buffered frames into repeated cooldown strikes', () => {
  const { ws, coolDowns, closes, logs } = fixture();
  const dependencies = { store: {}, sockets: new Map() };
  for (let frame = 0; frame < 20; frame++) handleSocketMessage(ws, '{}', dependencies);
  assert.equal(closes[0].code, 4429);
  assert.equal(coolDowns.remaining('fixture-machine'), 5_000);
  assert.equal(coolDowns.entries.get('fixture-machine').strikes, 1);
  assert.equal(closes.length, 1);
  assert.equal(logs.length, 1);
});

test('a closing socket neither acknowledges queued messages nor escalates another close', () => {
  const { ws, coolDowns, closes } = fixture();
  closeForPolicy(ws, 'rate-limit');
  closeForPolicy(ws, 'oversize');
  ws.relayState.windowMessages = 0;
  let acknowledgements = 0;
  const store = { acknowledge() { acknowledgements++; } };
  handleSocketMessage(ws, JSON.stringify({ type: 'relay.ack', deliveryId: 'fixture-delivery' }),
    { store, sockets: new Map() });
  assert.equal(acknowledgements, 0);
  assert.equal(coolDowns.remaining('fixture-machine'), 5_000);
  assert.equal(closes.length, 1);
});
