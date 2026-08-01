import assert from "node:assert/strict";
import test from "node:test";
import worker, { pushPayload, validDeviceToken } from "../src/worker.js";

test("health endpoint is available without bindings", async () => {
  const response = await worker.fetch(new Request("https://relay.example/health"), {});
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});

test("unknown HTTP routes disclose no internals", async () => {
  const response = await worker.fetch(new Request("https://relay.example/private"), {});
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "not found" });
});

test("push registration is routed to the room durable object", async () => {
  let forwarded = null;
  const response = await worker.fetch(
    new Request("https://relay.example/push/status?room=room-a"),
    { ROOM: { idFromName: (name) => name, get: () => ({ fetch: (request) => {
      forwarded = request.url;
      return new Response(JSON.stringify({ enabled: false, devices: 0 }));
    } }) } },
  );
  assert.equal(response.status, 200);
  assert.equal(forwarded, "https://relay.example/push/status?room=room-a");
});

test("APNs wake payload is content-neutral and carries no delivery correlation id", () => {
  assert.equal(validDeviceToken("ab".repeat(32)), true);
  assert.equal(validDeviceToken("not-a-token"), false);
  const payload = pushPayload();
  assert.equal(payload.aps["content-available"], 1);
  assert.equal(payload.aps["interruption-level"], "active");
  assert.equal(payload.granttapWake, true);
  assert.equal("deliveryId" in payload, false);
  assert.doesNotMatch(JSON.stringify(payload), /command|prompt|session|approval|schedule|response/i);
});
