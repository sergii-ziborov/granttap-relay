import assert from "node:assert/strict";
import test from "node:test";
import { GrantTapRoom } from "../src/worker.js";

const room = "ab".repeat(16);
const credential = "cd".repeat(32);
const token = "ef".repeat(32);

function memoryState(values = new Map()) {
  return {
    storage: {
      get: async (key) => values.get(key),
      put: async (key, value) => values.set(key, value),
      delete: async (key) => values.delete(key),
    },
    values,
  };
}

function registration(method = "PUT", body = {}) {
  const headers = { authorization: `Bearer ${credential}` };
  if (method === "GET" || method === "HEAD") {
    return new Request(`https://relay.example/push/register?room=${room}`, { method, headers });
  }
  return new Request(`https://relay.example/push/register?room=${room}`, {
    method,
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ token, environment: "sandbox", bundleId: "com.ziborov.granttap", ...body }),
  });
}

test("room validates and stores APNs registrations", async () => {
  const state = memoryState();
  const relayRoom = new GrantTapRoom(state, {});
  assert.equal((await relayRoom.fetch(registration("GET"))).status, 400);
  assert.equal((await relayRoom.fetch(registration("PUT", { token: "wrong" }))).status, 400);
  assert.equal((await relayRoom.fetch(registration("PUT", { environment: "wrong" }))).status, 400);
  assert.equal((await relayRoom.fetch(registration("PUT", { bundleId: "com.example.bad" }))).status, 400);
  const stored = await relayRoom.fetch(registration());
  assert.deepEqual(await stored.json(), { ok: true, registered: true, enabled: false, devices: 1 });
  const status = await relayRoom.fetch(new Request(`https://relay.example/push/status?room=${room}`, { headers: { authorization: `Bearer ${credential}` } }));
  assert.deepEqual(await status.json(), { enabled: false, devices: 1 });
  assert.equal((await relayRoom.fetch(new Request(`https://relay.example/push/status?room=${room}`))).status, 401);
  const deleted = await relayRoom.fetch(registration("DELETE"));
  assert.deepEqual(await deleted.json(), { ok: true, registered: false, enabled: false, devices: 0 });
});

test("room refuses mismatched credentials and malformed approval requests", async () => {
  const state = memoryState();
  const relayRoom = new GrantTapRoom(state, {});
  assert.equal((await relayRoom.fetch(new Request(`https://relay.example/approvals?room=${room}`))).status, 401);
  await relayRoom.fetch(registration());
  const mismatch = await relayRoom.fetch(new Request(`https://relay.example/approvals?room=${room}`, { headers: { authorization: `Bearer ${"00".repeat(32)}` } }));
  assert.equal(mismatch.status, 401);
  const unsupported = await relayRoom.fetch(new Request(`https://relay.example/approvals?room=${room}`, { method: "PATCH", headers: { authorization: `Bearer ${credential}` } }));
  assert.equal(unsupported.status, 405);
  const badCancel = await relayRoom.fetch(new Request(`https://relay.example/approvals?room=${room}`, { method: "DELETE", headers: { authorization: `Bearer ${credential}` } }));
  assert.equal(badCancel.status, 400);
});

test("room queues, acknowledges, and delivers opaque envelopes", async () => {
  const state = memoryState();
  const relayRoom = new GrantTapRoom({ ...state, getWebSockets: () => [] }, {});
  const envelope = {
    v: 1, room, from: "machine", to: "phone", senderId: "machine-1", deliveryId: "delivery-1",
    expiresAt: Date.now() + 60_000, nonce: "A".repeat(32), box: "A".repeat(24), wake: false,
  };
  const attachment = { room };
  const ws = { deserializeAttachment: () => attachment, serializeAttachment: (next) => Object.assign(attachment, next), send: () => assert.fail("no target should receive") };
  await relayRoom.webSocketMessage(ws, JSON.stringify(envelope));
  assert.equal(state.values.get("q:phone").length, 1);
  await relayRoom.webSocketMessage(ws, JSON.stringify(envelope));
  assert.equal(state.values.get("q:phone").length, 1);
  attachment.role = "phone";
  await relayRoom.webSocketMessage(ws, JSON.stringify({ type: "relay.ack", deliveryId: "delivery-1" }));
  assert.equal(state.values.has("q:phone"), false);
  await relayRoom.webSocketMessage(ws, "not-json");
  await relayRoom.webSocketMessage(ws, JSON.stringify({ ...envelope, from: "phone" }));
});

test("room socket upgrades use pinned room authorization", async () => {
  const original = globalThis.WebSocketPair;
  const OriginalResponse = globalThis.Response;
  class SocketPair {
    constructor() {
      this[0] = {};
      this[1] = { serializeAttachment: (value) => { this.attached = value; } };
    }
  }
  globalThis.WebSocketPair = SocketPair;
  globalThis.Response = class {
    constructor(_body, init) { this.status = init.status; this.webSocket = init.webSocket; }
  };
  try {
    const state = memoryState();
    let accepted = 0;
    state.acceptWebSocket = () => { accepted += 1; };
    const relayRoom = new GrantTapRoom(state, {});
    const response = await relayRoom.fetch(new Request(`https://relay.example/?room=${room}`, { headers: { upgrade: "websocket", authorization: `Bearer ${credential}` } }));
    assert.equal(response.status, 101);
    assert.equal(accepted, 1);
    assert.equal((await relayRoom.fetch(new Request(`https://relay.example/?room=${room}`))).status, 426);
  } finally {
    globalThis.WebSocketPair = original;
    globalThis.Response = OriginalResponse;
  }
});

test("room helper callbacks and wake no-op preserve relay-only state", async () => {
  const state = memoryState();
  const relayRoom = new GrantTapRoom({ ...state, getWebSockets: () => [] }, {});
  assert.equal(relayRoom.tokensEqual("same", "same"), true);
  assert.equal(relayRoom.tokensEqual("same", "different"), false);
  const view = await relayRoom.ensureViewToken();
  assert.match(view.token, /^[a-f0-9]{64}$/);
  await relayRoom.sendWakePush();
  relayRoom.webSocketClose();
  relayRoom.webSocketError();
});
