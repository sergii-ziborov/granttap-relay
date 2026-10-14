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

test("a modified controller cannot publish as a paid computer and expired admission closes the socket", { timeout: 5_000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), "granttap-managed-socket-"));
  const secret = Buffer.alloc(32, 7);
  const key = join(dir, "key");
  writeFileSync(key, secret, { mode: 0o600 });
  const room = "a".repeat(32), credential = "b".repeat(64);
  const server = createRelayServer({ store: new RelayStore(join(dir, "relay.sqlite")), env: {
    MANAGED_ADMISSION_REQUIRED: "1", MANAGED_ADMISSION_KEY_PATH: key,
  } });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `ws://127.0.0.1:${server.address().port}/?room=${room}`;
  const sockets = [];
  t.after(async () => { for (const socket of sockets) socket.terminate();
    await new Promise(resolve => server.close(resolve)); rmSync(dir, { recursive: true, force: true }); });
  async function connect(ticket) {
    const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${credential}`,
      ...(ticket ? { "X-GrantTap-Admission": ticket } : {}) } });
    sockets.push(socket);
    await once(socket, "open");
    return socket;
  }
  const envelope = from => JSON.stringify({ v: 1, room, from, to: "all", senderId: "fixture",
    nonce: Buffer.alloc(24, 1).toString("base64"), box: Buffer.alloc(24, 2).toString("base64") });
  const denied = await connect();
  const deniedClose = once(denied, "close");
  denied.send(envelope("machine"));
  assert.equal((await deniedClose)[0], 1008);

  const claim = { version: 1, accountId: "12345678-1234-4123-8123-123456789012",
    computerId: "22345678-1234-4123-8123-123456789012",
    publicKey: Buffer.alloc(32, 4).toString("base64"), room, expiresAt: Date.now() + 500 };
  const body = Buffer.from(JSON.stringify(claim)).toString("base64url");
  const ticket = `${body}.${createHmac("sha256", secret).update(`granttap-managed-v1.${body}`).digest("base64url")}`;
  const phone = await connect();
  phone.send(envelope("phone"));
  const machine = await connect(ticket);
  const delivered = once(phone, "message");
  machine.send(envelope("machine"));
  assert.equal(JSON.parse((await delivered)[0].toString()).from, "machine");
  const renewalClaim = { ...claim, expiresAt: Date.now() + 1_200 };
  const renewalBody = Buffer.from(JSON.stringify(renewalClaim)).toString("base64url");
  const renewedTicket = `${renewalBody}.${createHmac("sha256", secret)
    .update(`granttap-managed-v1.${renewalBody}`).digest("base64url")}`;
  const renewed = once(machine, "message");
  machine.send(JSON.stringify({ type: "relay.admission", ticket: renewedTicket }));
  const answer = await Promise.race([renewed,
    new Promise((_, reject) => setTimeout(() => reject(Error("Renewal was not confirmed")), 700))]);
  assert.equal(JSON.parse(answer[0].toString()).type, "relay.admission.accepted");
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.equal(machine.readyState, WebSocket.OPEN, "The first ticket expiry must not interrupt a renewed computer");
  assert.equal((await once(machine, "close"))[0], 1008);
  const invalid = new WebSocket(url, { headers: { Authorization: `Bearer ${credential}`, "X-GrantTap-Admission": "invalid" } });
  sockets.push(invalid);
  const status = await new Promise(resolve => {
    invalid.once("unexpected-response", (_request, response) => { resolve(response.statusCode); response.resume(); invalid.terminate(); });
    invalid.on("error", () => {});
  });
  assert.equal(status, 403);
});
