import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { createRelayServer } from "../src/node/server.js";
import { RelayStore } from "../src/node/store.js";
import { readManagedTicket } from "../src/node/managed-admission.js";

const secret = Buffer.alloc(32, 9);
const claim = { version: 2, role: "phone", accountId: "12345678-1234-4123-8123-123456789012",
  computerId: "22345678-1234-4123-8123-123456789012", publicKey: Buffer.alloc(32, 3).toString("base64"),
  room: "a".repeat(32), expiresAt: Date.now() + 60_000 };
const sign = value => { const body = Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${body}.${createHmac("sha256", secret).update(`granttap-managed-v1.${body}`).digest("base64url")}`; };

test("signed controller access binds the phone role and rejects invented roles", () => {
  assert.deepEqual(readManagedTicket(sign(claim), secret, claim.room), claim);
  for (const role of [undefined, "machine", "all", "admin"]) {
    assert.equal(readManagedTicket(sign({ ...claim, role }), secret, claim.room), null);
  }
});

test("licensed controllers store submissions while their computer is offline and renew only their identity", async t => {
  const dir = mkdtempSync(join(tmpdir(), "granttap-controller-"));
  const key = join(dir, "key"); writeFileSync(key, secret, { mode: 0o600 });
  const store = new RelayStore(join(dir, "relay.sqlite"));
  const server = createRelayServer({ store, env: { MANAGED_ADMISSION_REQUIRED: "1", MANAGED_ADMISSION_KEY_PATH: key } });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const sockets = [];
  t.after(async () => { sockets.forEach(socket => socket.terminate());
    await new Promise(resolve => server.close(resolve)); rmSync(dir, { recursive: true, force: true }); });
  const connect = async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/?room=${claim.room}`, { headers: {
      Authorization: `Bearer ${"b".repeat(64)}`, "X-GrantTap-Admission": sign(claim), "X-GrantTap-Recipient-Routing": "1" } });
    socket.on("error", () => {}); sockets.push(socket); await once(socket, "open"); return socket;
  };
  const phone = await connect();
  const envelope = { v: 1, room: claim.room, from: "phone", to: "machine", senderId: "fixture",
    deliveryId: "user-message-controller-offline", expiresAt: Date.now() + 60_000,
    nonce: Buffer.alloc(24, 1).toString("base64"), box: Buffer.alloc(24, 2).toString("base64") };
  const stored = once(phone, "message"); phone.send(JSON.stringify(envelope));
  assert.equal(JSON.parse((await stored)[0].toString()).type, "relay.stored");
  assert.equal(store.queue(claim.room, "machine")[0].deliveryId, envelope.deliveryId);
  const accepted = once(phone, "message");
  phone.send(JSON.stringify({ type: "relay.admission", ticket: sign({ ...claim, expiresAt: claim.expiresAt + 1_000 }) }));
  assert.equal(JSON.parse((await accepted)[0].toString()).type, "relay.admission.accepted");
  const closed = once(phone, "close");
  phone.send(JSON.stringify({ type: "relay.admission", ticket: sign({ ...claim,
    publicKey: Buffer.alloc(32, 4).toString("base64"), expiresAt: claim.expiresAt + 2_000 }) }));
  assert.equal((await closed)[0], 4409);
  const forged = await connect(); const denied = once(forged, "close");
  forged.send(JSON.stringify({ ...envelope, from: "machine", to: "phone" }));
  assert.equal((await denied)[0], 4403);
});
