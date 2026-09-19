import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { WebSocket } from "ws";
import { createRelayServer } from "../src/node/server.js";
import { RelayStore } from "../src/node/store.js";

const room = "a".repeat(32);
const credential = "b".repeat(64);
const otherCredential = "c".repeat(64);
const directory = mkdtempSync(join(tmpdir(), "granttap-relay-"));
const store = new RelayStore(join(directory, "relay.sqlite3"));
const server = createRelayServer({ store, env: {} });
let base;

before(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(directory, { recursive: true, force: true });
});

test("health and one-time pairing mailbox work without storing plaintext keys", async () => {
  assert.deepEqual(await fetch(`${base}/health`).then((response) => response.json()), { ok: true });
  const mailbox = "d".repeat(32);
  const sealed = {
    nonce: Buffer.alloc(24, 1).toString("base64"),
    box: Buffer.alloc(24, 2).toString("base64"),
  };
  const put = await fetch(`${base}/pair/${mailbox}`, {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(sealed),
  });
  assert.equal(put.status, 200);
  assert.equal((await fetch(`${base}/pair/${mailbox}`, { method: "HEAD" })).status, 200);
  assert.equal((await fetch(`${base}/pair/${mailbox}`, { method: "HEAD" })).status, 200);
  assert.equal((await fetch(`${base}/pair/${mailbox}`, {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(sealed),
  })).status, 409);
  assert.deepEqual(await fetch(`${base}/pair/${mailbox}`).then((response) => response.json()), sealed);
  assert.equal((await fetch(`${base}/pair/${mailbox}`)).status, 404);
});

test("room credential pins on connection and rejects a different credential", async () => {
  const statusBeforePin = await fetch(`${base}/push/status?room=${room}`, { headers: auth(credential) });
  assert.equal(statusBeforePin.status, 401);
  const socket = await connect(credential);
  socket.close();
  const status = await fetch(`${base}/push/status?room=${room}`, { headers: auth(credential) });
  assert.equal(status.status, 200);
  assert.equal((await connectFailure(otherCredential)), 401);
});

test("iPhone /ws upgrade uses the same room credential as /", async () => {
  const socket = await connect(credential, "/ws");
  socket.close();
  assert.equal((await connectFailure(otherCredential, "/ws")), 401);
});

test("authenticated peers exchange, persist, replay, and acknowledge encrypted envelopes", async () => {
  const machine = await connect(credential);
  const phone = await connect(credential);
  phone.send(envelope("phone", "all", "phone-ready"));
  const live = receive(phone);
  machine.send(envelope("machine", "phone", "live-message"));
  assert.equal((await live).deliveryId, "live-message");
  phone.close();

  machine.send(envelope("machine", "phone", "queued-message"));
  await waitUntil(() => store.queue(room, "phone").length === 2);
  const reconnected = await connect(credential);
  const replay = receiveMany(reconnected, 2);
  reconnected.send(envelope("phone", "all", "phone-back"));
  const replayed = await replay;
  assert.deepEqual(new Set(replayed.map((item) => item.deliveryId)), new Set(["live-message", "queued-message"]));
  for (const item of replayed) reconnected.send(JSON.stringify({ type: "relay.ack", deliveryId: item.deliveryId }));
  await waitUntil(() => store.queue(room, "phone").length === 0);
  machine.close();
  reconnected.close();
});

test("push registration stays bounded and reports disabled without APNs credentials", async () => {
  const token = "de".repeat(32);
  const response = await fetch(`${base}/push/register?room=${room}`, {
    method: "PUT", headers: { ...auth(credential), "content-type": "application/json" },
    body: JSON.stringify({ token, environment: "sandbox", bundleId: "com.ziborov.granttap" }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, registered: true, enabled: false, devices: 1 });
});

function auth(value) { return { authorization: `Bearer ${value}` }; }

function connect(value, path = "/") {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(base.replace("http", "ws") + `${path === "/" ? "/" : path}?room=${room}`, { headers: auth(value) });
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function connectFailure(value, path = "/") {
  return new Promise((resolve) => {
    const ws = new WebSocket(base.replace("http", "ws") + `${path === "/" ? "/" : path}?room=${room}`, { headers: auth(value) });
    ws.once("unexpected-response", (_request, response) => resolve(response.statusCode));
    ws.once("error", () => resolve(0));
  });
}

function envelope(from, to, deliveryId) {
  return JSON.stringify({
    v: 1, room, from, to, senderId: `${from}-test`, deliveryId,
    expiresAt: Date.now() + 60_000,
    nonce: Buffer.alloc(24, 3).toString("base64"),
    box: Buffer.alloc(24, 4).toString("base64"),
  });
}

function receive(ws) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("message timeout")), 2_000);
    ws.once("message", (value) => { clearTimeout(timeout); resolve(JSON.parse(value.toString())); });
  });
}

function receiveMany(ws, count) {
  return new Promise((resolve, reject) => {
    const values = [];
    const timeout = setTimeout(() => { ws.off("message", onMessage); reject(new Error("message timeout")); }, 2_000);
    function onMessage(value) {
      values.push(JSON.parse(value.toString()));
      if (values.length !== count) return;
      clearTimeout(timeout);
      ws.off("message", onMessage);
      resolve(values);
    }
    ws.on("message", onMessage);
  });
}

async function waitUntil(predicate) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
