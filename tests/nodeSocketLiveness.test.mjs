import assert from "node:assert/strict";
import { once } from "node:events";
import { WebSocket } from "ws";
import test from "node:test";
import { HEARTBEAT_INTERVAL_MS, heartbeatIntervalFrom, heartbeatSweep, markAlive, startHeartbeat } from "../src/node/heartbeat.js";
import { RelayStore } from "../src/node/store.js";
import { QUEUE_RESULT } from "../src/relay/connectionPolicy.js";
import { closed, envelope, room, settle, startRelay, waitUntil } from "./support/nodeRelay.mjs";

class RacingStore extends RelayStore {
  enqueue(roomId, role, raw, deliveryId, expiresAt) {
    if (deliveryId === "racing") return QUEUE_RESULT.EXPIRED;
    if (deliveryId === "orphan") return QUEUE_RESULT.NO_ROOM;
    return super.enqueue(roomId, role, raw, deliveryId, expiresAt);
  }
}

test("an already expired reliable message is dropped and the sender stays open", async (t) => {
  const relay = await startRelay(t);
  const sender = await relay.connect({ control: true });
  sender.send(envelope("machine", "all"));
  const phone = await relay.connect();
  phone.send(envelope("phone", "all"));
  await settle();
  const before = phone.received.length;
  sender.send(envelope("machine", "phone", { deliveryId: "stale", expiresAt: Date.now() - 1 }));
  await waitUntil(() => sender.received.some((frame) => frame.type === "relay.dropped"));
  assert.deepEqual(sender.received.at(-1), { type: "relay.dropped", deliveryId: "stale", reason: "expired" });
  assert.equal(sender.readyState, WebSocket.OPEN);
  assert.equal(relay.store.queue(room, "phone").some((item) => item.deliveryId === "stale"), false);

  sender.send(envelope("machine", "phone", { deliveryId: "fresh", expiresAt: Date.now() + 60_000 }));
  await waitUntil(() => phone.received.length > before);
  assert.deepEqual(phone.received.slice(before).map((frame) => frame.deliveryId), ["fresh"]);

  const legacy = await relay.connect();
  legacy.send(envelope("machine", "phone", { deliveryId: "legacy-stale", expiresAt: Date.now() - 1 }));
  await settle();
  assert.equal(legacy.readyState, WebSocket.OPEN);
  assert.deepEqual(legacy.received, [], "clients without relay control frames get no notice");
  assert.deepEqual(relay.lines.filter((line) => line.event === "relay.message_dropped").map((line) => line.reason),
    ["expired", "expired"]);
});

test("a reliable message that expires or loses its room while queueing is dropped, not closed", async (t) => {
  const relay = await startRelay(t, { Store: RacingStore });
  const sender = await relay.connect({ control: true });
  sender.send(envelope("machine", "all"));
  const phone = await relay.connect();
  phone.send(envelope("phone", "all"));
  await settle();
  const before = phone.received.length;
  sender.send(envelope("machine", "phone", { deliveryId: "racing", expiresAt: Date.now() + 60_000 }));
  sender.send(envelope("machine", "phone", { deliveryId: "orphan", expiresAt: Date.now() + 60_000 }));
  sender.send(envelope("machine", "phone", { deliveryId: "after", expiresAt: Date.now() + 60_000 }));
  await waitUntil(() => phone.received.length > before);
  await settle();
  assert.deepEqual(phone.received.slice(before).map((frame) => frame.deliveryId), ["after"]);
  assert.deepEqual(sender.received.filter((frame) => frame.type === "relay.dropped"), [
    { type: "relay.dropped", deliveryId: "racing", reason: "expired" },
    { type: "relay.dropped", deliveryId: "orphan", reason: "no-room" }]);
  assert.equal(sender.readyState, WebSocket.OPEN);
});

test("heartbeat terminates dead peers so they release room slots", { timeout: 10_000 }, async (t) => {
  // Build-time CPU contention must not expire peers while the test fills the room.
  t.mock.timers.enable({ apis: ["setInterval"] });
  const relay = await startRelay(t, { heartbeatIntervalMs: 100 });
  const dead = [];
  for (let index = 0; index < 32; index += 1) dead.push(await relay.connect({ autoPong: false }));
  const full = await relay.refusal();
  assert.equal(full.status, 503);
  const closedPeers = Promise.all(dead.map((socket) => once(socket, "close")));
  t.mock.timers.tick(200);
  await closedPeers;
  const healthy = await relay.connect();
  t.mock.timers.tick(100); await settle(25);
  t.mock.timers.tick(100); await settle(25);
  assert.equal(healthy.readyState, WebSocket.OPEN, "a peer that answers pings stays connected");
  const terminated = relay.lines.filter((line) => line.event === "relay.socket_terminated");
  assert.equal(terminated.length, 32);
  assert.deepEqual(Object.keys(terminated[0]).sort(), ["event", "reason", "role", "room", "ts"]);
  assert.equal(terminated[0].reason, "heartbeat-timeout");
  assert.ok(relay.lines.some((line) => line.event === "relay.upgrade_refused" && line.reason === "room-full"));
});

test("heartbeat pings once, spares sockets that answered and terminates silent ones", () => {
  const events = [];
  const socket = (name, throws = false) => ({ relayState: { room, role: "phone", awaitingPong: false },
    ping: () => { events.push(`ping:${name}`); if (throws) throw new Error("closing"); },
    terminate: () => events.push(`terminate:${name}`) });
  const alive = socket("alive");
  const silent = socket("silent");
  const broken = socket("broken", true);
  const logs = [];
  const sockets = new Map([[room, new Set([alive, silent, broken])]]);
  heartbeatSweep(sockets, (event, fields) => logs.push([event, fields.reason]));
  markAlive(alive);
  markAlive({});
  heartbeatSweep(sockets);
  assert.deepEqual(events, ["ping:alive", "ping:silent", "ping:broken", "terminate:broken",
    "ping:alive", "terminate:silent", "terminate:broken"]);
  assert.deepEqual(logs, []);
  heartbeatSweep(new Map([[room, new Set([silent])]]), (event, fields) => logs.push([event, fields.reason]));
  assert.deepEqual(logs, [["relay.socket_terminated", "heartbeat-timeout"]]);
});

test("heartbeat interval is bounded below nginx proxy_read_timeout and can be disabled", () => {
  assert.equal(HEARTBEAT_INTERVAL_MS, 30_000);
  assert.equal(heartbeatIntervalFrom(undefined), 30_000);
  assert.equal(heartbeatIntervalFrom(""), 30_000);
  assert.equal(heartbeatIntervalFrom("0"), 0);
  assert.equal(heartbeatIntervalFrom("45000"), 45_000);
  for (const value of ["999", "120001", "300000", "abc", "1.5"]) assert.equal(heartbeatIntervalFrom(value), 30_000, value);
  const stop = startHeartbeat(new Map(), { intervalMs: 0 });
  assert.equal(typeof stop, "function");
  stop();
});

test("a peer that pings the relay itself stays alive without answering pings", { timeout: 10_000 }, async (t) => {
  const relay = await startRelay(t, { heartbeatIntervalMs: 100 });
  const pinging = await relay.connect({ autoPong: false });
  const timer = setInterval(() => pinging.ping(), 40);
  t.after(() => clearInterval(timer));
  const silent = await relay.connect({ autoPong: false });
  await once(silent, "close");
  assert.equal(pinging.readyState, WebSocket.OPEN);
});
