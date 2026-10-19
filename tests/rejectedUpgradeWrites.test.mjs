import assert from 'node:assert/strict';
import test from 'node:test';
import { startRelay } from './support/nodeRelay.mjs';

test('a refused managed upgrade never allocates an authentication room', async t => {
  const relay = await startRelay(t,{managed:true});
  const before=relay.store.db.prepare('SELECT total_changes() AS n').get().n;
  assert.equal((await relay.refusal({ticket:'invalid-ticket'})).status,403);
  assert.equal(relay.store.db.prepare('SELECT COUNT(*) AS n FROM rooms').get().n,0);
  assert.equal(relay.store.db.prepare('SELECT total_changes() AS n').get().n,before);
});
