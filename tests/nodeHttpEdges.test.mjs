import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRelayServer } from "../src/node/server.js";
import { RelayStore } from "../src/node/store.js";
import { credential, envelope, room, settle, startRelay } from "./support/nodeRelay.mjs";

test("Node HTTP routes reject unknown paths, methods and malformed bodies", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "granttap-http-edges-"));
  const server = createRelayServer({ store: new RelayStore(join(dir, "relay.sqlite3")), env: {}, log: () => {} });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const auth = { authorization: `Bearer ${credential}`, "content-type": "application/json" };
  const mailbox = `${base}/pair/${"e".repeat(32)}`;
  assert.equal((await fetch(`${base}/unknown`)).status, 404);
  assert.equal((await fetch(mailbox, { method: "DELETE" })).status, 405);
  assert.equal((await fetch(mailbox, { method: "PUT", body: JSON.stringify({ nonce: "short", box: "x" }) })).status, 400);
  assert.equal((await fetch(`${base}/push/status?room=bad`)).status, 400);
  assert.equal((await fetch(`${base}/push/register?room=${room}`, { method: "PATCH", headers: auth })).status, 405);
  assert.equal((await fetch(`${base}/push/status?room=${room}`, { method: "POST", headers: auth })).status, 405);
  const token = "de".repeat(32);
  for (const body of [{ token: "bad" }, { token, environment: "dev" }, { token, environment: "sandbox", bundleId: "x" }]) {
    const response = await fetch(`${base}/push/register?room=${room}`, { method: "PUT", headers: auth, body: JSON.stringify(body) });
    assert.equal(response.status, 400);
  }
  const removed = await fetch(`${base}/push/register?room=${room}`, { method: "DELETE", headers: auth,
    body: JSON.stringify({ token, environment: "sandbox", bundleId: "com.ziborov.granttap" }) });
  assert.deepEqual(await removed.json(), { ok: true, registered: false, enabled: false, devices: 0 });
});

test("a wake envelope without APNs credentials is still delivered live", async (t) => {
  const relay = await startRelay(t);
  const phone = await relay.connect();
  phone.send(envelope("phone", "all"));
  const machine = await relay.connect();
  machine.send(JSON.stringify({ ...JSON.parse(envelope("machine", "phone", { deliveryId: "wake-1",
    expiresAt: Date.now() + 60_000 })), wake: true }));
  await settle();
  assert.deepEqual(phone.received.map((frame) => frame.deliveryId), ["wake-1"]);
});
