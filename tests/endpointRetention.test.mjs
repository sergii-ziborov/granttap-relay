import assert from 'node:assert/strict';
import test from 'node:test';
import { webcrypto } from 'node:crypto';
import { GrantTapRoom } from '../src/relay/room.js';
if (!globalThis.crypto) globalThis.crypto = webcrypto;

function harness() {
  const values = new Map();
  let alarm;
  const storage = {
    get: async key => values.get(key),
    put: async (key, value) => values.set(key, value),
    delete: async key => values.delete(key),
    list: async ({ prefix }) => new Map([...values].filter(([key]) => key.startsWith(prefix))),
    setAlarm: async time => { alarm = time; },
    deleteAlarm: async () => { alarm = undefined; },
  };
  return { room: new GrantTapRoom({ storage }, {}), values, alarm: () => alarm };
}

test('Worker directory caps recipients, cleans expired ciphertext by alarm and keeps chat data', async () => {
  const h = harness();
  const room = 'af'.repeat(16);
  const record = { nonce: Buffer.alloc(24).toString('base64'),
    box: Buffer.alloc(30).toString('base64'), expiresAt: Date.now() + 50_000 };
  const put = recipient => h.room.fetch(new Request(`https://relay.test/endpoint?room=${room}&recipient=${recipient}`, {
    method: 'PUT', headers: { authorization: `Bearer ${'cd'.repeat(32)}` }, body: JSON.stringify(record),
  }));
  for (let n = 0; n < 32; n++) assert.equal((await put(n.toString(16).padStart(64, '0'))).status, 200);
  assert.equal((await put('ff'.repeat(32))).status, 409);
  assert.equal((await put('00'.repeat(32))).status, 200);
  assert.equal(h.alarm(), record.expiresAt);
  h.values.set('q:phone', ['encrypted chat']);
  for (const [key, item] of h.values) if (key.startsWith('endpoint:')) h.values.set(key, { ...item, expiresAt: 1 });
  await h.room.alarm();
  assert.equal([...h.values.keys()].filter(key => key.startsWith('endpoint:')).length, 0);
  assert.deepEqual(h.values.get('q:phone'), ['encrypted chat']);
  assert.equal(h.alarm(), undefined);
});
