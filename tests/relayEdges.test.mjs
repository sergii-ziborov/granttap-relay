import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/worker.js";
import { allowedWebOrigin, withApprovalCors } from "../src/relay/relayCors.js";
import { validBase64, validEnvelope, validIdentifier } from "../src/relay/relayValidation.js";

const room = "ab".repeat(16);
const token = "cd".repeat(32);
const origin = "https://granttap.com";

test("CORS preflights reject unsupported methods and headers", async () => {
  const approval = `https://relay.example/a/${room}/${token}/json`;
  const headers = (extra) => ({ origin, ...extra });
  assert.equal((await worker.fetch(new Request(approval, { method: "OPTIONS", headers: headers({ "access-control-request-method": "PUT" }) }), {})).status, 405);
  assert.equal((await worker.fetch(new Request(approval, { method: "OPTIONS", headers: headers({ "access-control-request-method": "GET", "access-control-request-headers": "authorization" }) }), {})).status, 403);
  const vault = `https://relay.example/api/vault/${room.repeat(2)}`;
  assert.equal((await worker.fetch(new Request(vault, { method: "OPTIONS", headers: headers({ "access-control-request-method": "PATCH" }) }), {})).status, 405);
  assert.equal((await worker.fetch(new Request(vault, { method: "OPTIONS", headers: headers({ "access-control-request-method": "GET", "access-control-request-headers": "authorization" }) }), {})).status, 403);
});

test("router reports missing durable bindings without forwarding requests", async () => {
  assert.equal((await worker.fetch(new Request(`https://relay.example/pair/${"ef".repeat(16)}`), {})).status, 503);
  assert.equal((await worker.fetch(new Request(`https://relay.example/web-pair/${"ef".repeat(16)}`), {})).status, 503);
  assert.equal((await worker.fetch(new Request(`https://relay.example/push/status?room=${room}`), {})).status, 503);
});

test("relay validation rejects malformed opaque routing data", () => {
  assert.equal(validIdentifier("", 1), false);
  assert.equal(validIdentifier("ab", 1), false);
  assert.equal(validBase64("A".repeat(32), 32, 32), true);
  assert.equal(validBase64("A".repeat(31), 32, 32), false);
  assert.equal(validBase64("A".repeat(32) + "!", 32, 40), false);
  const envelope = { v: 1, room, from: "machine", to: "phone", senderId: "id", nonce: "A".repeat(32), box: "A".repeat(24) };
  assert.equal(validEnvelope(envelope, room), true);
  assert.equal(validEnvelope({ ...envelope, wake: "yes" }, room), false);
  assert.equal(validEnvelope({ ...envelope, deliveryId: "" }, room), false);
  assert.equal(validEnvelope({ ...envelope, box: "*".repeat(24) }, room), false);
});

test("origin policy handles missing, malformed, same-origin, and malformed configured origins", async () => {
  const request = (value, url = "https://relay.example/a") => new Request(url, { headers: value == null ? {} : { origin: value } });
  assert.equal(allowedWebOrigin(request(null), {}), null);
  assert.equal(allowedWebOrigin(request("not-a-url"), {}), null);
  assert.equal(allowedWebOrigin(request("https://relay.example"), {}), "https://relay.example");
  assert.equal(allowedWebOrigin(request("https://preview.example"), { GRANTTAP_WEB_ORIGINS: "not-a-url,https://preview.example/" }), null);
  const cors = withApprovalCors(new Response("ok", { headers: { vary: "Origin" } }), request(origin), {});
  assert.equal(cors.headers.get("vary"), "Origin");
});

test("router enforces vault-page methods and routes WebSocket room metadata", async () => {
  assert.equal((await worker.fetch(new Request("https://relay.example/vault", { method: "POST" }), {})).status, 405);
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

test("CORS accepts empty requested headers and exposes vault revisions only to allowed origins", async () => {
  const vault = `https://relay.example/api/vault/${room.repeat(2)}`;
  const preflight = await worker.fetch(new Request(vault, { method: "OPTIONS", headers: { origin, "access-control-request-method": "DELETE" } }), {});
  assert.equal(preflight.status, 204);
  const noOrigin = withApprovalCors(new Response("ok"), new Request("https://relay.example/a"), {}, true);
  assert.equal(noOrigin.headers.get("access-control-allow-origin"), null);
});
