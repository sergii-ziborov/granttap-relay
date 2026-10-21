import test from 'node:test';
import assert from 'node:assert/strict';
import { updatePresence, presenceMessage } from '../index.js';
const room = 'a'.repeat(32), id = 'b'.repeat(64);
test('last seen is retained; online comes only from current sockets in the same room', () => {
  const rows = updatePresence([], 'machine', id, 1000000);
  const read = states => JSON.parse(presenceMessage(room, rows, states, 1001000)).devices[0];
  assert.equal(read([]).online, false);
  assert.equal(read([]).lastSeenAt, 1000000);
  assert.equal(read([{ room, role: 'machine', recipientKeyId: id }]).online, true);
  assert.equal(read([{ room: 'other', role: 'machine', recipientKeyId: id }]).online, false);
  assert.deepEqual(updatePresence(rows, 'phone', 'invalid', 1001000), rows);
  assert.equal(updatePresence(rows, 'machine', id, 1002000).length, 1);
});
