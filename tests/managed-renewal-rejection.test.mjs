import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WebSocket } from 'ws';
import { createRelayServer } from '../src/node/server.js';
import { RelayStore } from '../src/node/store.js';

test('renewal cannot change a paid socket identity, reuse an old lease or authorize a phone', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'granttap-renewal-deny-'));
  const secret = Buffer.alloc(32, 7), key = join(dir, 'key');
  writeFileSync(key, secret, { mode: 0o600 });
  const room = 'a'.repeat(32), credential = 'b'.repeat(64);
  const claim = { version: 1, accountId: '12345678-1234-4123-8123-123456789012',
    computerId: '22345678-1234-4123-8123-123456789012', publicKey: Buffer.alloc(32, 4).toString('base64'),
    room, expiresAt: Date.now() + 10_000 };
  const sign = value => { const body = Buffer.from(JSON.stringify(value)).toString('base64url');
    return `${body}.${createHmac('sha256', secret).update(`granttap-managed-v1.${body}`).digest('base64url')}`; };
  const server = createRelayServer({ store: new RelayStore(join(dir, 'relay.sqlite')), env: {
    MANAGED_ADMISSION_REQUIRED: '1', MANAGED_ADMISSION_KEY_PATH: key } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const sockets = [];
  t.after(async () => { for (const socket of sockets) socket.terminate();
    await new Promise(resolve => server.close(resolve)); rmSync(dir, { recursive: true, force: true }); });
  const url = `ws://127.0.0.1:${server.address().port}/?room=${room}`;
  for (const change of [{ accountId: '32345678-1234-4123-8123-123456789012' },
    { computerId: '32345678-1234-4123-8123-123456789012' },
    { publicKey: Buffer.alloc(32, 5).toString('base64') }, { expiresAt: claim.expiresAt }, null, 'phone']) {
    const phone = change === 'phone';
    const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${credential}`,
      ...(!phone ? { 'X-GrantTap-Admission': sign(claim) } : {}) } });
    sockets.push(socket); await once(socket, 'open');
    const closed = once(socket, 'close');
    socket.send(JSON.stringify({ type: 'relay.admission', ticket: change === null ? 'invalid'
      : sign({ ...claim, expiresAt: Date.now() + 20_000, ...(phone ? {} : change) }) }));
    assert.equal((await closed)[0], 1008);
  }
});
