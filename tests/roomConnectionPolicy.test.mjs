import assert from "node:assert/strict";
import test from "node:test";
import { GrantTapRoom } from "../src/worker.js";
import { QUEUE_RESULT } from "../src/relay/connectionPolicy.js";
import { createRelayLog } from "../src/relay/relayLog.js";

const room = "ab".repeat(16);
const credential = "cd".repeat(32);
const key = "1".repeat(64);

function relayRoom(sockets = []) {
  const values = new Map();
  const relay = new GrantTapRoom({ storage: { get: async (name) => values.get(name),
    put: async (name, value) => values.set(name, value), delete: async (name) => values.delete(name) },
  getWebSockets: () => sockets, acceptWebSocket: () => {} }, {});
  const lines = [];
  relay.log = createRelayLog({ intervalMs: 0, write: (line) => lines.push(JSON.parse(line)) });
  return { relay, values, lines };
}

function socket(attachment) {
  return { attachment, sent: [], closes: [], deserializeAttachment: () => attachment,
    serializeAttachment(next) { Object.assign(attachment, next); },
    send(raw) { this.sent.push(raw); }, close(code, reason) { this.closes.push([code, reason]); } };
}

function envelope(from, to, extra = {}) {
  return JSON.stringify({ v: 1, room, from, to, senderId: `${from}-1`, nonce: "A".repeat(32), box: "A".repeat(24), ...extra });
}

async function withUpgradeGlobals(run) {
  const originalPair = globalThis.WebSocketPair;
  const OriginalResponse = globalThis.Response;
  const attached = [];
  globalThis.WebSocketPair = class {
    constructor() { this[0] = {}; this[1] = { serializeAttachment: (value) => attached.push(value), send: () => {} }; }
  };
  globalThis.Response = class {
    constructor(body, init) { Object.assign(this, { body, status: init.status, headers: new Headers(init.headers) }); }
  };
  try { await run(attached); } finally {
    globalThis.WebSocketPair = originalPair;
    globalThis.Response = OriginalResponse;
  }
}

function upgrade(headers = {}) {
  return new Request(`https://relay.example/?room=${room}`, { headers: { upgrade: "websocket",
    authorization: `Bearer ${credential}`, ...headers } });
}

test("Worker drops an expired reliable message without closing, storing or forwarding it", async () => {
  const target = socket({ room, role: "phone" });
  const sender = socket({ room, role: "machine", relayControl: true });
  const legacy = socket({ room, role: "machine" });
  const { relay, values, lines } = relayRoom([sender, target, legacy]);
  await relay.webSocketMessage(sender, envelope("machine", "phone", { deliveryId: "stale", expiresAt: Date.now() - 1 }));
  await relay.webSocketMessage(legacy, envelope("machine", "phone", { deliveryId: "old", expiresAt: Date.now() - 1 }));
  assert.deepEqual(sender.closes, []);
  assert.deepEqual(legacy.closes, []);
  assert.deepEqual(target.sent, []);
  assert.equal(values.has("q:phone"), false);
  assert.deepEqual(sender.sent.map((raw) => JSON.parse(raw)), [{ type: "relay.dropped", deliveryId: "stale", reason: "expired" }]);
  assert.deepEqual(legacy.sent, []);
  assert.deepEqual(lines.map((line) => [line.event, line.reason]),
    [["relay.message_dropped", "expired"], ["relay.message_dropped", "expired"]]);
  const failing = socket({ room, role: "machine", relayControl: true });
  failing.send = () => { throw new Error("stale"); };
  await relay.webSocketMessage(failing, envelope("machine", "phone", { deliveryId: "x", expiresAt: Date.now() - 1 }));
  assert.deepEqual(failing.closes, []);
});

test("Worker queue reports the same results as the Node store", async () => {
  const { relay, values } = relayRoom();
  assert.equal(await relay.queue("phone", "raw", "one", Date.now() + 60_000), QUEUE_RESULT.STORED);
  assert.equal(await relay.queue("phone", "raw", "one", Date.now() + 60_000), QUEUE_RESULT.DUPLICATE);
  assert.equal(await relay.queue("phone", "raw", "two", Date.now() - 1), QUEUE_RESULT.EXPIRED);
  assert.equal(await relay.queue("phone", "A".repeat(1_800_001), "three"), QUEUE_RESULT.OVERSIZE);
  assert.deepEqual(values.get("q:phone").map((item) => item.deliveryId), ["one"]);
});

test("Worker oversize close cools down the sender's key at upgrade with 429 Retry-After", async () => {
  const sender = socket({ room, role: "machine", recipientKeyId: key });
  const { relay, lines } = relayRoom([sender]);
  await relay.webSocketMessage(sender, envelope("machine", "phone", { deliveryId: "large", expiresAt: Date.now() + 60_000,
    box: "A".repeat(1_800_000) }));
  assert.deepEqual(sender.closes, [[1009, "oversize; retry-after=5"]]);
  await withUpgradeGlobals(async (attached) => {
    const refused = await relay.fetch(upgrade({ "X-GrantTap-Recipient-Key-Id": key }));
    assert.equal(refused.status, 429);
    assert.equal(refused.headers.get("retry-after"), "5");
    assert.deepEqual(JSON.parse(refused.body), { error: "cool-down", retryAfter: 5 });
    const other = await relay.fetch(upgrade({ "X-GrantTap-Recipient-Key-Id": "2".repeat(64), "X-GrantTap-Recipient-Routing": "1" }));
    assert.equal(other.status, 101);
    assert.deepEqual(attached, [{ room, recipientKeyId: "2".repeat(64), relayControl: true, taskDispatch: false }]);
  });
  assert.deepEqual(lines.map(({ ts, ...line }) => line), [
    { event: "relay.policy_close", room: "abababab", role: "machine", code: 1009, retryAfter: 5, reason: "oversize" },
    { event: "relay.upgrade_refused", room: "abababab", role: "-", status: 429, retryAfter: 5, reason: "cool-down" }]);
});

test("Worker rate limit and keyless first-frame cool-down use the shared codes", async () => {
  const noisy = socket({ room, recipientKeyId: key });
  const { relay } = relayRoom([noisy]);
  for (let index = 0; index < 301; index += 1) await relay.webSocketMessage(noisy, "x");
  assert.deepEqual(noisy.closes, [[4429, "rate-limit; retry-after=5"]]);
  const anonymous = socket({ room });
  for (let index = 0; index < 301; index += 1) await relay.webSocketMessage(anonymous, "x");
  assert.deepEqual(anonymous.closes, [[4429, "rate-limit"]], "an unidentified socket cannot be cooled down");

  const first = socket({ room });
  await relay.webSocketMessage(first, envelope("machine", "all"));
  await relay.webSocketMessage(first, envelope("machine", "phone", { deliveryId: "large", box: "A".repeat(1_800_000) }));
  assert.deepEqual(first.closes, [[1009, "oversize; retry-after=5"]]);
  const again = socket({ room });
  await relay.webSocketMessage(again, envelope("machine", "all"));
  assert.equal(again.closes[0][0], 4425);
  assert.match(again.closes[0][1], /^cool-down; retry-after=[1-5]$/);
  assert.equal(again.attachment.role, undefined, "a refused socket never registers a role");
  const phone = socket({ room });
  await relay.webSocketMessage(phone, envelope("phone", "all"));
  assert.deepEqual(phone.closes, []);
  assert.equal(phone.attachment.role, "phone");
});

test("Worker closes frames beyond the WebSocket limit with the oversize policy", async () => {
  const sender = socket({ room });
  const { relay } = relayRoom([sender]);
  await relay.webSocketMessage(sender, "x".repeat(32 * 1024 * 1024 + 1));
  assert.deepEqual(sender.closes, [[1009, "oversize"]]);
});
