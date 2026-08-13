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
import { GrantTapWebPairing } from "../src/webPairing.js";

test("health endpoint is available without bindings", async () => {
  const response = await worker.fetch(new Request("https://relay.example/health"), {});
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(await response.json(), { ok: true });
});

test("web pairing challenges are origin-bound, single-use, and keep the transfer key off relay", async () => {
  const id = "ad".repeat(16);
  let routedName = "";
  const routed = await worker.fetch(
    new Request(`https://relay.example/web-pair/${id}`, {
      method: "PUT",
      headers: { origin: "https://granttap.com", "content-type": "application/json" },
      body: JSON.stringify({ origin: "https://granttap.com" }),
    }),
    { WEB_CODES: {
      idFromName: (name) => { routedName = name; return name; },
      get: () => ({ fetch: () => new Response("{}", { status: 201 }) }),
    } },
  );
  assert.equal(routed.status, 201);
  assert.equal(routedName, id);

  const values = new Map();
  let alarmAt = 0;
  const storage = {
    get: async (key) => values.get(key),
    put: async (key, value) => values.set(key, value),
    deleteAll: async () => { values.clear(); },
    setAlarm: async (value) => { alarmAt = value; },
  };
  const pairing = new GrantTapWebPairing({ storage });
  const url = `https://relay.example/web-pair/${id}`;
  const register = await pairing.fetch(new Request(url, {
    method: "PUT",
    headers: { origin: "https://granttap.com", "content-type": "application/json" },
    body: JSON.stringify({ origin: "https://granttap.com" }),
  }));
  assert.equal(register.status, 201);
  assert.ok(alarmAt > Date.now());
  assert.doesNotMatch(JSON.stringify([...values.values()]), /transferKey|GTW1/);
  assert.equal((await pairing.fetch(new Request(url, { headers: { origin: "https://granttap.com" } }))).status, 202);
  assert.equal((await pairing.fetch(new Request(url, { headers: { origin: "https://evil.example" } }))).status, 403);

  const sealed = { origin: "https://granttap.com", nonce: "A".repeat(32), box: "B".repeat(64) };
  assert.equal((await pairing.fetch(new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...sealed, origin: "https://evil.example" }),
  }))).status, 403);
  assert.equal((await pairing.fetch(new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(sealed),
  }))).status, 200);
  assert.equal((await pairing.fetch(new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(sealed),
  }))).status, 409);

  const consumed = await pairing.fetch(new Request(url, { headers: { origin: "https://granttap.com" } }));
  assert.equal(consumed.status, 200);
  assert.deepEqual(await consumed.json(), sealed);
  assert.equal((await pairing.fetch(new Request(url, { headers: { origin: "https://granttap.com" } }))).status, 404);
});

test("vault login UI is served at / and /vault", async () => {
  for (const path of ["/", "/vault"]) {
    const response = await worker.fetch(new Request(`https://relay.example${path}`), {});
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/);
    const html = await response.text();
    assert.match(html, /GrantTap/);
    assert.match(html, /GTW1/);
    assert.match(html, /Unlock/);
    assert.match(html, /if-none-match/);
    assert.match(html, /if-match/);
    assert.match(html, /revision conflict/);
  }
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

test("APNs wake payload is alert+content-available with no task ciphertext", () => {
  assert.equal(validDeviceToken("ab".repeat(32)), true);
  assert.equal(validDeviceToken("not-a-token"), false);
  const payload = pushPayload();
  assert.equal(payload.aps["content-available"], 1);
  assert.equal(payload.aps.sound, "default");
  assert.equal(payload.aps.alert?.title, "GrantTap");
  assert.match(String(payload.aps.alert?.body ?? ""), /waiting/i);
  assert.equal(payload.granttapWake, true);
  assert.equal("deliveryId" in payload, false);
  // Generic wake copy only — never command/session/approval payload fields.
  assert.doesNotMatch(JSON.stringify(payload), /command|prompt|sessionId|approval\.request|cwd|shell/i);
});
