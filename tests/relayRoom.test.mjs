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
  await relayRoom.webSocketMessage(ws, JSON.stringify({ ...envelope, title: "plaintext" }));
  assert.equal(state.values.has("q:machine"), false);
});

test("offline transient envelopes never enter the reliable mailbox", async () => {
  const state = memoryState();
  const relayRoom = new GrantTapRoom({ ...state, getWebSockets: () => [] }, {});
  const attachment = { room, role: "machine" };
  const socket = {
    deserializeAttachment: () => attachment,
    serializeAttachment: () => {},
    send: () => {},
  };
  const transient = {
    v: 1,
    room,
    from: "machine",
    to: "phone",
    senderId: "machine-1",
    expiresAt: Date.now() + 60_000,
    nonce: "A".repeat(32),
    box: "A".repeat(24),
  };

  await relayRoom.webSocketMessage(socket, JSON.stringify(transient));

  assert.equal(state.values.has("q:phone"), false);
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
  await relayRoom.sendWakePush();
  relayRoom.webSocketClose();
  relayRoom.webSocketError();
});

test("room sends live envelopes and clears successfully flushed legacy queue entries", async () => {
  const state = memoryState();
  const senderAttachment = { room, role: "machine" };
  const recipientAttachment = { room, role: "phone" };
  const sent = [];
  const sender = { deserializeAttachment: () => senderAttachment, serializeAttachment: () => {}, send: () => {} };
  const recipient = { deserializeAttachment: () => recipientAttachment, send: (raw) => sent.push(raw) };
  const relayRoom = new GrantTapRoom({ ...state, getWebSockets: () => [sender, recipient] }, {});
  const envelope = { v: 1, room, from: "machine", to: "phone", senderId: "machine-1", nonce: "A".repeat(32), box: "A".repeat(24) };
  await relayRoom.webSocketMessage(sender, JSON.stringify(envelope));
  assert.equal(sent.length, 1);
  state.values.set("q:phone", ["legacy"]);
  await relayRoom.flushTo("phone", { send: (raw) => sent.push(raw) });
  assert.equal(state.values.has("q:phone"), false);
});

test("same device identity may use monitor and hook sockets concurrently", async () => {
  const state = memoryState();
  const staleAttachment = { room, role: "phone", senderId: "phone-1" };
  const currentAttachment = { room };
  let staleClosed = 0;
  const stale = {
    deserializeAttachment: () => staleAttachment,
    close: () => { staleClosed += 1; },
    send: () => {},
  };
  const current = {
    deserializeAttachment: () => currentAttachment,
    serializeAttachment: (next) => Object.assign(currentAttachment, next),
    close: () => {},
    send: () => {},
  };
  const relayRoom = new GrantTapRoom({
    ...state,
    getWebSockets: () => [stale, current],
  }, {});
  const hello = {
    v: 1, room, from: "phone", to: "machine", senderId: "phone-1",
    nonce: "A".repeat(32), box: "A".repeat(24),
  };

  await relayRoom.webSocketMessage(current, JSON.stringify(hello));

  assert.deepEqual(currentAttachment, { room, role: "phone" });
  assert.equal(staleClosed, 0);
});

test("room removes stale wake registrations after APNs response", async () => {
  const key = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const pem = Buffer.from(new Uint8Array(await crypto.subtle.exportKey("pkcs8", key.privateKey))).toString("base64");
  const state = memoryState(new Map([["push:tokens", [{ token, environment: "sandbox", bundleId: "com.ziborov.granttap" }]]]));
  const relayRoom = new GrantTapRoom(state, { APNS_TEAM_ID: "ROOM", APNS_KEY_ID: "ROOMKEY", APNS_PRIVATE_KEY: `-----BEGIN PRIVATE KEY-----\n${pem}\n-----END PRIVATE KEY-----` });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 410 });
  try {
    await relayRoom.sendWakePush();
    assert.equal(state.values.has("push:tokens"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("room ignores stale live sockets and broadcasts opaque envelopes to every role", async () => {
  const state = memoryState();
  const attachment = { room, role: "machine" };
  const sender = { deserializeAttachment: () => attachment, serializeAttachment: () => {}, send: () => {} };
  const stale = { deserializeAttachment: () => ({ room, role: "phone" }), send: () => { throw new Error("closed"); } };
  const received = [];
  const observer = { deserializeAttachment: () => ({ room, role: "machine" }), send: (raw) => received.push(raw) };
  const relayRoom = new GrantTapRoom({ ...state, getWebSockets: () => [sender, stale, observer] }, {});
  const envelope = { v: 1, room, from: "machine", to: "all", senderId: "machine-1", nonce: "A".repeat(32), box: "A".repeat(24) };
  await relayRoom.webSocketMessage(sender, JSON.stringify(envelope));
  assert.equal(received.length, 1);
  await relayRoom.flushTo("phone", { send: () => assert.fail("empty queue must not send") });
});

test("room retains acknowledged queue leftovers and bounds malformed queue inputs", async () => {
  const state = memoryState(new Map([["q:phone", [{ deliveryId: "one" }, { deliveryId: "two" }]]]));
  const relayRoom = new GrantTapRoom({ ...state, getWebSockets: () => [] }, {});
  await relayRoom.acknowledge("phone", "one");
  assert.deepEqual(state.values.get("q:phone"), [{ deliveryId: "two" }]);
  await relayRoom.queue("phone", "A".repeat(1_800_001));
  assert.equal(state.values.get("q:phone").length, 1);
  state.values.set("q:machine", [{ raw: "expired", expiresAt: Date.now() - 1 }, { raw: "", expiresAt: Date.now() + 1 }]);
  await relayRoom.flushTo("machine", { send: () => assert.fail("expired and empty entries must not send") });
  assert.equal(state.values.has("q:machine"), false);
});

test("room ignores invalid socket messages and rejects invalid upgrade room metadata", async () => {
  const state = memoryState();
  const relayRoom = new GrantTapRoom({ ...state, getWebSockets: () => [] }, {});
  const socket = { deserializeAttachment: () => ({}), serializeAttachment: () => {}, send: () => {} };
  await relayRoom.webSocketMessage(socket, null);
  await relayRoom.webSocketMessage(socket, JSON.stringify({ type: "relay.ack", deliveryId: "id" }));
  await relayRoom.webSocketMessage(socket, JSON.stringify({ v: 1 }));
  assert.equal((await relayRoom.fetch(new Request("https://relay.example/?room=bad", { headers: { upgrade: "websocket" } }))).status, 400);
  const invalidStatus = await relayRoom.fetch(new Request(`https://relay.example/push/status?room=${room}`, { headers: { authorization: `Bearer ${"00".repeat(32)}` } }));
  assert.equal(invalidStatus.status, 401);
});

test("room bounds device registrations and queued delivery count", async () => {
  const initial = Array.from({ length: 8 }, (_, index) => ({ token: `${index.toString(16).padStart(2, "0")}`.repeat(32), environment: "sandbox", bundleId: "com.ziborov.granttap" }));
  const state = memoryState(new Map([["push:tokens", initial]]));
  const relayRoom = new GrantTapRoom({ ...state, getWebSockets: () => [] }, {});
  const register = new Request(`https://relay.example/push/register?room=${room}`, { method: "POST", headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" }, body: JSON.stringify({ token, environment: "production", bundleId: "com.ziborov.granttap" }) });
  assert.equal((await relayRoom.fetch(register)).status, 200);
  assert.equal(state.values.get("push:tokens").length, 8);
  for (let index = 0; index < 101; index += 1) await relayRoom.queue("phone", `message-${index}`);
  assert.equal(state.values.get("q:phone").length, 100);
  await relayRoom.sendWakePush();
});

test("room keeps non-stale wake devices and rejects a role switch", async () => {
  const key = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const pem = Buffer.from(new Uint8Array(await crypto.subtle.exportKey("pkcs8", key.privateKey))).toString("base64");
  const state = memoryState(new Map([["push:tokens", [{ token, environment: "production", bundleId: "com.ziborov.granttap" }]]]));
  const relayRoom = new GrantTapRoom({ ...state, getWebSockets: () => [] }, { APNS_TEAM_ID: "KEEP", APNS_KEY_ID: "KEEPKEY", APNS_PRIVATE_KEY: `-----BEGIN PRIVATE KEY-----\n${pem}\n-----END PRIVATE KEY-----` });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 200 });
  try {
    await relayRoom.sendWakePush();
    assert.equal(state.values.get("push:tokens").length, 1);
  } finally { globalThis.fetch = originalFetch; }
  const attachment = { room, role: "machine" };
  const ws = { deserializeAttachment: () => attachment, serializeAttachment: () => {}, send: () => {} };
  await relayRoom.webSocketMessage(ws, JSON.stringify({ v: 1, room, from: "phone", to: "machine", senderId: "phone-1", nonce: "A".repeat(32), box: "A".repeat(24) }));
  assert.equal(state.values.has("q:machine"), false);
});

test("room rejects unauthenticated upgrades and avoids nonmatching live targets", async () => {
  const state = memoryState();
  const relayRoom = new GrantTapRoom({ ...state, getWebSockets: () => [] }, {});
  assert.equal((await relayRoom.fetch(new Request(`https://relay.example/?room=${room}`, { headers: { upgrade: "websocket", authorization: "Bearer bad" } }))).status, 401);
  const attachment = { room, role: "machine" };
  const sender = { deserializeAttachment: () => attachment, serializeAttachment: () => {}, send: () => {} };
  const unrelated = { deserializeAttachment: () => null, send: () => assert.fail("unrelated socket must not receive") };
  relayRoom.state.getWebSockets = () => [sender, unrelated];
  await relayRoom.webSocketMessage(sender, JSON.stringify({ v: 1, room, from: "machine", to: "phone", senderId: "machine-1", nonce: "A".repeat(32), box: "A".repeat(24) }));
  assert.equal(state.values.has("q:phone"), false);
});

test("room rejects unsupported push mutation after authenticated bounded JSON", async () => {
  const state = memoryState();
  const relayRoom = new GrantTapRoom({ ...state, getWebSockets: () => [] }, {});
  const request = new Request(`https://relay.example/push/register?room=${room}`, { method: "PATCH", headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" }, body: JSON.stringify({ token, environment: "sandbox", bundleId: "com.ziborov.granttap" }) });
  assert.equal((await relayRoom.fetch(request)).status, 405);
});

test("room accepts wake envelopes and prunes expired queued records before retry", async () => {
  const state = memoryState(new Map([["q:phone", [{ raw: "expired", expiresAt: Date.now() - 1 }]]]));
  const attachment = { room, role: "machine" };
  const ws = { deserializeAttachment: () => attachment, serializeAttachment: () => {}, send: () => {} };
  const relayRoom = new GrantTapRoom({ ...state, getWebSockets: () => [] }, {});
  await relayRoom.webSocketMessage(ws, JSON.stringify({ v: 1, room, from: "machine", to: "phone", senderId: "machine-1", deliveryId: "wake-1", nonce: "A".repeat(32), box: "A".repeat(24), wake: true }));
  assert.equal(state.values.get("q:phone").length, 1);
  assert.equal(state.values.get("q:phone")[0].raw.includes("expired"), false);
});

test("room retains healthy APNs tokens and reliable queue entries", async () => {
  const key = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const pem = Buffer.from(new Uint8Array(await crypto.subtle.exportKey("pkcs8", key.privateKey))).toString("base64");
  const healthy = "aa".repeat(32);
  const stale = "bb".repeat(32);
  const state = memoryState(new Map([
    ["push:tokens", [{ token: healthy, environment: "sandbox", bundleId: "com.ziborov.granttap" }, { token: stale, environment: "sandbox", bundleId: "com.ziborov.granttap" }]],
    ["q:phone", [{ raw: "reliable", deliveryId: "delivery-1", expiresAt: Date.now() + 60_000 }]],
  ]));
  const relayRoom = new GrantTapRoom({ ...state, getWebSockets: () => [] }, { APNS_TEAM_ID: "MIX", APNS_KEY_ID: "MIXKEY", APNS_PRIVATE_KEY: `-----BEGIN PRIVATE KEY-----\n${pem}\n-----END PRIVATE KEY-----` });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => new Response(null, { status: String(url).includes(stale) ? 410 : 200 });
  try {
    await relayRoom.sendWakePush();
    assert.deepEqual(state.values.get("push:tokens").map((item) => item.token), [healthy]);
  } finally { globalThis.fetch = originalFetch; }
  await relayRoom.flushTo("phone", { send: (raw) => assert.equal(raw, "reliable") });
  assert.equal(state.values.get("q:phone").length, 1);
});

test("queue flush never resurrects a reliable envelope acknowledged during send", async () => {
  const first = {
    raw: "first",
    rawBytes: 5,
    deliveryId: "delivery-1",
    expiresAt: Date.now() + 60_000,
  };
  const second = {
    raw: "second",
    rawBytes: 6,
    deliveryId: "delivery-2",
    expiresAt: Date.now() + 60_000,
  };
  const state = memoryState(new Map([["q:phone", [first, second]]]));
  const relayRoom = new GrantTapRoom({ ...state, getWebSockets: () => [] }, {});
  const socket = {
    send(raw) {
      if (raw !== "first") return;
      state.values.set("q:phone", [second]);
    },
  };

  await relayRoom.flushTo("phone", socket);

  assert.deepEqual(state.values.get("q:phone"), [second]);
});

test("room removes one registered push device without dropping remaining devices", async () => {
  const first = "11".repeat(32);
  const second = "22".repeat(32);
  const state = memoryState(new Map([["push:tokens", [{ token: first, environment: "sandbox", bundleId: "com.ziborov.granttap" }, { token: second, environment: "production", bundleId: "com.ziborov.granttap" }]]]));
  const relayRoom = new GrantTapRoom({ ...state, getWebSockets: () => [] }, {});
  const request = new Request(`https://relay.example/push/register?room=${room}`, { method: "DELETE", headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" }, body: JSON.stringify({ token: first, environment: "sandbox", bundleId: "com.ziborov.granttap" }) });
  assert.equal((await relayRoom.fetch(request)).status, 200);
  assert.deepEqual(state.values.get("push:tokens").map((item) => item.token), [second]);
});
