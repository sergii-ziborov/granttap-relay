import assert from "node:assert/strict";
import test from "node:test";
import worker, {
  GrantTapCodes,
  GrantTapRoom,
  pushPayload,
  validDeviceToken,
  validEnvelope,
  validRoom,
  validRoomCredential,
} from "../src/worker.js";

test("health endpoint is available without bindings", async () => {
  const response = await worker.fetch(new Request("https://relay.example/health"), {});
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(await response.json(), { ok: true });
});

test("unknown HTTP routes disclose no internals", async () => {
  const response = await worker.fetch(new Request("https://relay.example/private"), {});
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "not found" });
});

test("push registration is routed to the room durable object", async () => {
  let forwarded = null;
  const room = "ab".repeat(16);
  const response = await worker.fetch(
    new Request(`https://relay.example/push/status?room=${room}`),
    { ROOM: { idFromName: (name) => name, get: () => ({ fetch: (request) => {
      forwarded = request.url;
      return new Response(JSON.stringify({ enabled: false, devices: 0 }));
    } }) } },
  );
  assert.equal(response.status, 200);
  assert.equal(forwarded, `https://relay.example/push/status?room=${room}`);
});

test("relay rejects enumerable room names and malformed routing envelopes", async () => {
  assert.equal(validRoom("ab".repeat(8)), true); // legacy 64-bit rooms remain routable
  assert.equal(validRoom("ab".repeat(16)), true);
  assert.equal(validRoom("room-a"), false);
  assert.equal(validRoomCredential("cd".repeat(32)), true);
  assert.equal(validRoomCredential("password"), false);

  const invalidRoom = await worker.fetch(
    new Request("https://relay.example/push/status?room=room-a"),
    { ROOM: { idFromName: () => assert.fail("invalid room must not reach a DO") } },
  );
  assert.equal(invalidRoom.status, 400);

  const now = Date.now();
  const base = {
    v: 1,
    room: "ab".repeat(16),
    from: "machine",
    to: "phone",
    senderId: "machine-1",
    deliveryId: "delivery-1",
    expiresAt: now + 60_000,
    nonce: "A".repeat(32),
    box: "A".repeat(24),
  };
  assert.equal(validEnvelope(base, base.room, now), true);
  assert.equal(validEnvelope({ ...base, to: "attacker" }, base.room, now), false);
  assert.equal(validEnvelope({ ...base, room: "cd".repeat(16) }, base.room, now), false);
  assert.equal(validEnvelope({ ...base, expiresAt: now + 26 * 60 * 60 * 1000 }, base.room, now), false);
});

test("pairing mailboxes are isolated, non-overwritable, single-use, and alarm-cleaned", async () => {
  const mailbox = "ef".repeat(16);
  let routedName = "";
  const routed = await worker.fetch(
    new Request(`https://relay.example/pair/${mailbox}`, { method: "GET" }),
    { CODES: {
      idFromName: (name) => { routedName = name; return name; },
      get: () => ({ fetch: () => new Response("{}", { status: 404 }) }),
    } },
  );
  assert.equal(routed.status, 404);
  assert.equal(routedName, mailbox);

  const values = new Map();
  let alarmAt = 0;
  const storage = {
    get: async (key) => values.get(key),
    put: async (key, value) => values.set(key, value),
    delete: async (key) => values.delete(key),
    deleteAll: async () => { values.clear(); alarmAt = 0; },
    setAlarm: async (value) => { alarmAt = value; },
  };
  const codes = new GrantTapCodes({ storage });
  const url = `https://relay.example/pair/${mailbox}`;
  const body = { nonce: "A".repeat(32), box: "B".repeat(64) };
  const put = () => codes.fetch(new Request(url, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
  const invalid = await codes.fetch(new Request(url, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ nonce: "not-base64", box: "B".repeat(64) }),
  }));
  assert.equal(invalid.status, 400);
  assert.equal((await put()).status, 200);
  assert.ok(alarmAt > Date.now());
  assert.equal((await put()).status, 409);
  const get = await codes.fetch(new Request(url));
  assert.equal(get.status, 200);
  assert.deepEqual(await get.json(), body);
  assert.equal((await codes.fetch(new Request(url))).status, 404);

  assert.equal((await put()).status, 200);
  await codes.alarm();
  assert.equal(values.size, 0);
});

test("queue flush preserves every unsent envelope after a socket failure", async () => {
  const queued = [
    { raw: "one", deliveryId: "delivery-1", expiresAt: Date.now() + 60_000 },
    { raw: "two", deliveryId: "delivery-2", expiresAt: Date.now() + 60_000 },
    { raw: "three", deliveryId: "delivery-3", expiresAt: Date.now() + 60_000 },
  ];
  let saved = [];
  const room = new GrantTapRoom({
    storage: {
      get: async () => queued,
      put: async (_key, value) => { saved = value; },
      delete: async () => assert.fail("reliable queue must remain"),
    },
  }, {});
  let sends = 0;
  await room.flushTo("phone", {
    send() {
      sends += 1;
      if (sends === 2) throw new Error("socket closed");
    },
  });
  assert.equal(sends, 2);
  assert.deepEqual(saved.map((item) => item.deliveryId), [
    "delivery-1",
    "delivery-2",
    "delivery-3",
  ]);
});

test("APNs wake payload is content-neutral and carries no delivery correlation id", () => {
  assert.equal(validDeviceToken("ab".repeat(32)), true);
  assert.equal(validDeviceToken("not-a-token"), false);
  const payload = pushPayload();
  assert.equal(payload.aps["content-available"], 1);
  assert.deepEqual(Object.keys(payload.aps), ["content-available"]);
  assert.equal(payload.granttapWake, true);
  assert.equal("deliveryId" in payload, false);
  assert.doesNotMatch(JSON.stringify(payload), /alert|sound|command|prompt|session|approval|schedule|response/i);
});
