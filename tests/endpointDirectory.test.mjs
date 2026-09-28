import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRelayServer } from "../src/node/server.js";
import { RelayStore } from "../src/node/store.js";

test("authenticated endpoint discovery retains only bounded ciphertext across restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "granttap-endpoint-"));
  const database = join(directory, "relay.sqlite3");
  const room = "de".repeat(16);
  const credential = "aa".repeat(32);
  const auth = { authorization: `Bearer ${credential}`, "content-type": "application/json" };
  let server = createRelayServer({ databasePath: database, env: {} });
  const start = async () => {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${server.address().port}/endpoint?room=${room}`;
  };
  const stop = () => new Promise((resolve) => server.close(resolve));
  try {
    let endpoint = await start();
    assert.equal((await fetch(endpoint, { headers: auth })).status, 401);
    const sealed = { nonce: Buffer.alloc(24, 1).toString("base64"),
      box: Buffer.alloc(80, 2).toString("base64"), expiresAt: Date.now() + 120_000 };
    assert.equal((await fetch(endpoint, { method: "PUT", headers: auth,
      body: JSON.stringify(sealed) })).status, 200);
    assert.deepEqual(await fetch(endpoint, { headers: auth }).then((r) => r.json()), sealed);
    const recipient = `${endpoint}&recipient=${"ef".repeat(32)}`;
    const alternate = { ...sealed, box: Buffer.alloc(80, 3).toString("base64") };
    assert.equal((await fetch(recipient, { method: "PUT", headers: auth,
      body: JSON.stringify(alternate) })).status, 200);
    assert.deepEqual(await fetch(endpoint, { headers: auth }).then((r) => r.json()), sealed);
    assert.deepEqual(await fetch(recipient, { headers: auth }).then((r) => r.json()), alternate);
    assert.equal((await fetch(`${endpoint}&recipient=bad`, { headers: auth })).status, 400);
    assert.equal((await fetch(endpoint, { headers: { authorization: `Bearer ${"bb".repeat(32)}` } })).status, 401);
    assert.equal((await fetch(endpoint, { method: "PUT", headers: auth,
      body: JSON.stringify({ ...sealed, relayUrl: "https://private.example" }) })).status, 400);
    assert.equal((await fetch(endpoint, { method: "PUT", headers: auth,
      body: JSON.stringify({ ...sealed, expiresAt: Date.now() - 1 }) })).status, 400);
    assert.equal((await fetch(endpoint, { method: "PUT", headers: auth,
      body: JSON.stringify({ ...sealed, expiresAt: Date.now() + 3_600_000 }) })).status, 400);
    assert.equal((await fetch(endpoint, { method: "PUT", headers: auth,
      body: JSON.stringify({ ...sealed, box: Buffer.alloc(9_000).toString("base64") }) })).status, 400);
    assert.equal((await fetch(endpoint, { method: "POST", headers: auth })).status, 405);
    await stop();
    server = createRelayServer({ databasePath: database, env: {} });
    endpoint = await start();
    assert.deepEqual(await fetch(endpoint, { headers: auth }).then((r) => r.json()), sealed);
    assert.equal((await fetch(endpoint, { method: "DELETE", headers: auth })).status, 200);
    assert.equal((await fetch(endpoint, { headers: auth })).status, 404);
  } finally {
    await stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("expired directory entries are unavailable and do not erase encrypted chat queues", () => {
  const directory = mkdtempSync(join(tmpdir(), "granttap-endpoint-expiry-"));
  const store = new RelayStore(join(directory, "relay.sqlite3"));
  try {
    store.pinAuth("ab".repeat(16), "cd".repeat(32));
    store.enqueue("ab".repeat(16), "phone", "opaque chat ciphertext", "delivery", Date.now() + 120_000);
    store.putEndpoint("ab".repeat(16), { nonce: "n", box: "b", expiresAt: Date.now() - 1 });
    assert.equal(store.endpoint("ab".repeat(16)), null);
    assert.equal(store.queue("ab".repeat(16), "phone").length, 1);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
