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

const roomId = "ab".repeat(16);

test("health endpoint is available without bindings", async () => {
  const response = await worker.fetch(new Request("https://relay.example/health"), {});
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});

test("Personal relay exposes no browser workspace routes", async () => {
  const paths = ["/", "/vault", `/api/vault/${"ab".repeat(32)}`, "/approvals", `/a/${roomId}/${"cd".repeat(32)}`, `/web-pair/${"ef".repeat(16)}`];
  for (const path of paths) {
    const response = await worker.fetch(new Request(`https://relay.example${path}`), {});
    assert.equal(response.status, 404, path);
    assert.deepEqual(await response.json(), { error: "not found" });
  }
});

test("push registration is routed by opaque room id", async () => {
  let forwarded = null;
  const env = { ROOM: { idFromName: (name) => name, get: () => ({ fetch: (request) => {
    forwarded = request.url;
    return new Response(JSON.stringify({ enabled: false, devices: 0 }));
  } }) } };
  const url = `https://relay.example/push/status?room=${roomId}`;
  assert.equal((await worker.fetch(new Request(url), env)).status, 200);
  assert.equal(forwarded, url);
});

test("relay validates only bounded ciphertext envelope fields", () => {
  assert.equal(validRoom("ab".repeat(8)), true);
  assert.equal(validRoom("room-a"), false);
  assert.equal(validRoomCredential("cd".repeat(32)), true);
  const now = Date.now();
  const envelope = {
    v: 1, room: roomId, from: "machine", to: "phone", senderId: "machine-1",
    deliveryId: "delivery-1", expiresAt: now + 60_000,
    nonce: "A".repeat(32), box: "A".repeat(24),
  };
  assert.equal(validEnvelope(envelope, roomId, now), true);
  for (const field of ["title", "command", "cwd", "prompt"]) {
    assert.equal(validEnvelope({ ...envelope, [field]: "plaintext" }, roomId, now), false, field);
  }
  assert.equal(validEnvelope({ ...envelope, to: "attacker" }, roomId, now), false);
});

test("pairing mailbox is isolated, single-use, and alarm-cleaned", async () => {
  const mailbox = "ef".repeat(16);
  const values = new Map();
  let alarmAt = 0;
  const codes = new GrantTapCodes({ storage: {
    get: async (key) => values.get(key), put: async (key, value) => values.set(key, value),
    deleteAll: async () => { values.clear(); }, setAlarm: async (value) => { alarmAt = value; },
  } });
  const url = `https://relay.example/pair/${mailbox}`;
  const body = { nonce: "A".repeat(32), box: "B".repeat(64) };
  const put = () => codes.fetch(new Request(url, { method: "PUT", body: JSON.stringify(body) }));
  assert.equal((await put()).status, 200);
  assert.ok(alarmAt > Date.now());
  assert.equal((await put()).status, 409);
  assert.deepEqual(await (await codes.fetch(new Request(url))).json(), body);
  assert.equal((await codes.fetch(new Request(url))).status, 404);
  assert.equal((await put()).status, 200);
  await codes.alarm();
  assert.equal(values.size, 0);
});

test("queue flush preserves every reliable envelope after socket failure", async () => {
  const queued = ["one", "two", "three"].map((raw, index) => ({
    raw, deliveryId: `delivery-${index + 1}`, expiresAt: Date.now() + 60_000,
  }));
  const values = new Map([["q:phone", queued]]);
  const relay = new GrantTapRoom({ storage: {
    get: async (key) => values.get(key), put: async (key, value) => values.set(key, value),
    delete: async () => assert.fail("reliable queue must remain"),
  } }, {});
  let sends = 0;
  await relay.flushTo("phone", { send() { sends += 1; if (sends === 2) throw new Error("closed"); } });
  assert.equal(sends, 2);
  assert.deepEqual(values.get("q:phone").map((item) => item.deliveryId), ["delivery-1", "delivery-2", "delivery-3"]);
});

test("APNs wake contains no task plaintext", () => {
  assert.equal(validDeviceToken("ab".repeat(32)), true);
  assert.equal(validDeviceToken("not-a-token"), false);
  const payload = pushPayload();
  assert.equal(payload.aps["content-available"], 1);
  assert.equal(payload.granttapWake, true);
  assert.doesNotMatch(JSON.stringify(payload), /command|prompt|sessionId|approval\.request|cwd|shell/i);
});
