import assert from "node:assert/strict";
import test from "node:test";
import { CLOSE_POLICIES, QUEUE_RESULT, acceptSocketFrame, admissionCloseToken, applyPolicyClose, closeReason,
  droppedNotice, queueOutcome, refuseCoolingFrame } from "../src/relay/connectionPolicy.js";
import { CoolDownRegistry } from "../src/relay/coolDown.js";
import { envelopeProblem, validEnvelope } from "../src/relay/relayValidation.js";

const room = "af927a60".repeat(4);

test("every policy close has a distinct documented code and a token reason", () => {
  const codes = Object.values(CLOSE_POLICIES).map((policy) => policy.code);
  assert.equal(new Set(codes).size, codes.length);
  assert.deepEqual(Object.fromEntries(Object.entries(CLOSE_POLICIES).map(([token, policy]) => [token, policy.code])), {
    "admission-expired": 4401, "admission-required": 4403, "hub-admission-required": 4406,
    "admission-renewal-rejected": 4409, "cool-down": 4425, "rate-limit": 4429, oversize: 1009,
  });
  assert.equal(closeReason("rate-limit"), "rate-limit");
  assert.equal(closeReason("rate-limit", 0), "rate-limit");
  assert.equal(closeReason("oversize", 10), "oversize; retry-after=10");
  for (const token of Object.keys(CLOSE_POLICIES)) {
    assert.ok(Buffer.byteLength(closeReason(token, 300)) <= 123, token);
  }
});

test("a phone hub sender gets a distinct admission reason without being admitted", () => {
  assert.equal(admissionCloseToken({ senderId: "hub-1a2b3c4d" }), "hub-admission-required");
  assert.equal(admissionCloseToken({ senderId: "machine-1" }), "admission-required");
  assert.equal(admissionCloseToken({}), "admission-required");
  assert.equal(admissionCloseToken(null), "admission-required");
});

test("only an oversize frame closes; expired and room-less reliable frames are dropped", () => {
  assert.deepEqual(queueOutcome(QUEUE_RESULT.STORED), { forward: true });
  assert.deepEqual(queueOutcome(QUEUE_RESULT.DUPLICATE), { forward: true });
  assert.deepEqual(queueOutcome(QUEUE_RESULT.OVERSIZE), { close: "oversize" });
  assert.deepEqual(queueOutcome(QUEUE_RESULT.EXPIRED), { drop: "expired" });
  assert.deepEqual(queueOutcome(QUEUE_RESULT.NO_ROOM), { drop: "no-room" });
  assert.deepEqual(JSON.parse(droppedNotice("delivery-1", "expired")),
    { type: "relay.dropped", deliveryId: "delivery-1", reason: "expired" });
});

test("socket frame windows reset each second and refuse frames beyond the limit", () => {
  const window = {};
  assert.equal(acceptSocketFrame(window, 1_000, 2), true);
  assert.equal(acceptSocketFrame(window, 1_500, 2), true);
  assert.equal(acceptSocketFrame(window, 1_999, 2), false);
  assert.equal(acceptSocketFrame(window, 2_000, 2), true);
  assert.equal(window.windowMessages, 1);
});

test("policy closes strike the identity, log sanitized fields and tolerate closed sockets", () => {
  const coolDowns = new CoolDownRegistry({ now: () => 0 });
  const lines = [];
  const closes = [];
  const retryAfter = applyPolicyClose({ token: "rate-limit", room, role: "phone", identity: "id",
    coolDowns, log: (event, fields) => lines.push({ event, ...fields }), close: (code, reason) => closes.push([code, reason]) });
  assert.equal(retryAfter, 5);
  assert.deepEqual(closes, [[4429, "rate-limit; retry-after=5"]]);
  assert.deepEqual(lines, [{ event: "relay.policy_close", room, role: "phone", code: 4429, reason: "rate-limit", retryAfter: 5 }]);
  assert.equal(applyPolicyClose({ token: "oversize", room, role: null, identity: null, coolDowns,
    close: () => { throw new Error("already closed"); } }), undefined);
  assert.equal(applyPolicyClose({ token: "cool-down", room, identity: "id", coolDowns, close: () => {} }), undefined);
  assert.equal(coolDowns.entries.get("id").strikes, 1, "a cool-down refusal never extends the backoff");
  const refused = [];
  assert.equal(refuseCoolingFrame({ room, role: "machine", remainingMs: 1, close: (...args) => refused.push(args) }), 1);
  assert.equal(refuseCoolingFrame({ room, role: "machine", remainingMs: 4_001, close: () => { throw new Error("closed"); } }), 5);
  assert.deepEqual(refused, [[4425, "cool-down; retry-after=1"]]);
});

test("envelope validation separates expired from malformed envelopes", () => {
  const now = 1_000_000;
  const envelope = { v: 1, room, from: "machine", to: "phone", senderId: "s", deliveryId: "d",
    expiresAt: now + 1, nonce: "A".repeat(32), box: "A".repeat(24) };
  assert.equal(envelopeProblem(envelope, room, now), null);
  assert.equal(envelopeProblem({ ...envelope, expiresAt: now }, room, now), "expired");
  assert.equal(validEnvelope({ ...envelope, expiresAt: now }, room, now), false);
  assert.equal(envelopeProblem({ ...envelope, expiresAt: now, box: "*" }, room, now), "invalid");
  assert.equal(envelopeProblem({ ...envelope, expiresAt: 1.5 }, room, now), "invalid");
  assert.equal(envelopeProblem({ ...envelope, expiresAt: now + 26 * 3_600_000 }, room, now), "invalid");
  assert.equal(envelopeProblem({ ...envelope, nonce: "short" }, room, now), "invalid");
  assert.equal(envelopeProblem({ ...envelope, room: "other" }, room, now), "invalid");
});
