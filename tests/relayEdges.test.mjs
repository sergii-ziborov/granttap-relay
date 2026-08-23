import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/worker.js";
import { validBase64, validDeviceToken, validEnvelope, validIdentifier } from "../src/relay/relayValidation.js";

const room = "ab".repeat(16);

test("router reports missing Personal durable bindings", async () => {
  assert.equal((await worker.fetch(new Request(`https://relay.example/pair/${"ef".repeat(16)}`), {})).status, 503);
  assert.equal((await worker.fetch(new Request(`https://relay.example/push/status?room=${room}`), {})).status, 503);
});

test("relay rejects malformed opaque routing data", () => {
  assert.equal(validIdentifier("", 1), false);
  assert.equal(validIdentifier("ab", 1), false);
  assert.equal(validBase64("A".repeat(32), 32, 32), true);
  assert.equal(validBase64("A".repeat(31), 32, 32), false);
  assert.equal(validDeviceToken("a".repeat(33)), false);
  const envelope = { v: 1, room, from: "machine", to: "phone", senderId: "id", nonce: "A".repeat(32), box: "A".repeat(24) };
  assert.equal(validEnvelope(envelope, room), true);
  assert.equal(validEnvelope({ ...envelope, wake: "yes" }, room), false);
  assert.equal(validEnvelope({ ...envelope, deliveryId: "" }, room), false);
  assert.equal(validEnvelope({ ...envelope, box: "*".repeat(24) }, room), false);
});

test("WebSocket routing requires valid room metadata", async () => {
  assert.equal((await worker.fetch(new Request("https://relay.example/?room=bad", { headers: { upgrade: "websocket" } }), {})).status, 400);
  const forwarded = [];
  const env = { ROOM: { idFromName: (name) => name, get: () => ({ fetch: (request) => {
    forwarded.push(request.url);
    return new Response("", { status: 200 });
  } }) } };
  const response = await worker.fetch(new Request(`https://relay.example/?room=${room}`, { headers: { upgrade: "websocket" } }), env);
  assert.equal(response.status, 200);
  assert.match(forwarded[0], new RegExp(`room=${room}`));
});
