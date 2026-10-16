import assert from "node:assert/strict";
import test from "node:test";
import { createRelayLog, roomTag, sanitizeLogFields } from "../src/relay/relayLog.js";

const room = "af927a60".repeat(4);

test("log fields keep an 8-hex room prefix and drop every non-allowlisted value", () => {
  assert.equal(roomTag(room), "af927a60");
  assert.equal(roomTag("not-a-room"), "-");
  assert.equal(roomTag(undefined), "-");
  const sanitized = sanitizeLogFields({ room, role: "machine", code: 4403, status: 429, retryAfter: 5,
    reason: "admission-required", token: "secret", ticket: "eyJ.sig", ip: "203.0.113.1",
    recipientKeyId: "1".repeat(64), box: "ciphertext", senderId: "hub-1" });
  assert.deepEqual(sanitized, { room: "af927a60", role: "machine", code: 4403, status: 429, retryAfter: 5,
    reason: "admission-required" });
  assert.deepEqual(sanitizeLogFields({ role: "attacker", code: -1, status: 1.5, reason: "Bearer abc" }),
    { room: "-", role: "-" });
  assert.deepEqual(sanitizeLogFields(), { room: "-", role: "-" });
});

test("repeated lines are rate limited per key and report their suppressed count", () => {
  let now = Date.parse("2026-10-16T00:00:00Z");
  const lines = [];
  const log = createRelayLog({ write: (line) => lines.push(JSON.parse(line)), now: () => now, intervalMs: 10_000 });
  const fields = { room, role: "machine", code: 4406, reason: "hub-admission-required", retryAfter: 5 };
  assert.equal(log("relay.policy_close", fields), true);
  for (let index = 0; index < 30; index += 1) assert.equal(log("relay.policy_close", fields), false);
  assert.equal(log("relay.policy_close", { ...fields, room: "b".repeat(32) }), true, "another room has its own budget");
  now += 10_000;
  assert.equal(log("relay.policy_close", fields), true);
  assert.equal(lines.length, 3);
  assert.deepEqual(lines[2], { ts: "2026-10-16T00:00:10.000Z", event: "relay.policy_close", room: "af927a60",
    role: "machine", code: 4406, retryAfter: 5, reason: "hub-admission-required", suppressed: 30 });
  assert.equal(log("Bad Event!", fields), false);
});

test("a global per-second cap bounds total log volume and write failures are ignored", () => {
  let now = 0;
  const lines = [];
  const log = createRelayLog({ write: (line) => lines.push(line), now: () => now, maxPerSecond: 2, maxKeys: 2 });
  for (const status of [401, 403, 429]) log("relay.upgrade_refused", { room, status, reason: "x" });
  assert.equal(lines.length, 2);
  now = 1_000;
  log("relay.upgrade_refused", { room, status: 401, reason: "x" });
  assert.equal(lines.length, 2, "the same key stays within its interval");
  log("relay.upgrade_refused", { room, status: 503, reason: "x" });
  assert.equal(lines.length, 3, "the global budget refills each second");
  const failing = createRelayLog({ write: () => { throw new Error("disk full"); } });
  assert.equal(failing("relay.policy_close", { room }), true);
});
