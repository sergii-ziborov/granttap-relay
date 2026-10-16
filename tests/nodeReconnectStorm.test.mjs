import assert from "node:assert/strict";
import { WebSocket } from "ws";
import test from "node:test";
import { CoolDownRegistry } from "../src/relay/coolDown.js";
import { closed, credential, envelope, lease, room, settle, startRelay } from "./support/nodeRelay.mjs";

const hubKey = "1".repeat(64);
const memberKey = "2".repeat(64);
const computerKey = "3".repeat(64);

test("storm regression: a phone hub machine link is refused once, then cooled down at upgrade", async (t) => {
  const relay = await startRelay(t, { managed: true });
  const member = await relay.connect({ key: memberKey });
  member.send(envelope("phone", "all", { senderId: "member-1" }));

  const hub = await relay.connect({ key: hubKey, control: true });
  const hubClosed = closed(hub);
  hub.send(envelope("machine", "all", { senderId: "hub-1a2b3c4d" }));
  assert.deepEqual(await hubClosed, { code: 4406, reason: "hub-admission-required; retry-after=5" });

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const refused = await relay.refusal({ key: hubKey });
    assert.equal(refused.status, 429);
    assert.ok(Number(refused.retryAfter) >= 1 && Number(refused.retryAfter) <= 5);
    assert.deepEqual(JSON.parse(refused.body), { error: "cool-down", retryAfter: Number(refused.retryAfter) });
  }

  const computer = await relay.connect({ key: computerKey, ticket: lease() });
  computer.send(envelope("machine", "phone", { senderId: "machine-1", deliveryId: "for-member" }));
  await settle();
  assert.equal(member.readyState, WebSocket.OPEN, "another identity in the room is unaffected");
  assert.deepEqual(member.received.map((frame) => frame.deliveryId), ["for-member"]);
  assert.equal(computer.readyState, WebSocket.OPEN);

  const close = relay.lines.filter((line) => line.event === "relay.policy_close");
  assert.deepEqual(close.map(({ ts, ...line }) => line), [{ event: "relay.policy_close", room: "af927a60",
    role: "machine", code: 4406, retryAfter: 5, reason: "hub-admission-required" }]);
  const refusals = relay.lines.filter((line) => line.event === "relay.upgrade_refused");
  assert.equal(refusals.length, 10);
  assert.deepEqual(Object.keys(refusals[0]).sort(), ["event", "reason", "retryAfter", "role", "room", "status", "ts"]);
  const text = relay.raw.join("\n");
  for (const secret of [hubKey, memberKey, credential, "hub-1a2b3c4d", room, "127.0.0.1"]) {
    assert.equal(text.includes(secret), false, `log must not contain ${secret.slice(0, 12)}`);
  }
});

test("cool-down doubles after each repeated policy close and a valid lease clears admission cool-downs", async (t) => {
  const coolDowns = new CoolDownRegistry({ baseMs: 150 });
  const relay = await startRelay(t, { managed: true, coolDowns });
  const first = await relay.connect({ key: computerKey });
  const firstClosed = closed(first);
  first.send(envelope("machine", "all", { senderId: "machine-1" }));
  assert.deepEqual(await firstClosed, { code: 4403, reason: "admission-required; retry-after=1" });
  assert.equal((await relay.refusal({ key: computerKey })).status, 429);

  await settle(200);
  const second = await relay.connect({ key: computerKey });
  const secondClosed = closed(second);
  second.send(envelope("machine", "all", { senderId: "machine-1" }));
  assert.equal((await secondClosed).code, 4403);
  assert.equal([...coolDowns.entries.values()][0].strikes, 2);
  assert.equal((await relay.refusal({ key: computerKey })).status, 429);

  const admitted = await relay.connect({ key: computerKey, ticket: lease() });
  admitted.send(envelope("machine", "all", { senderId: "machine-1" }));
  await settle();
  assert.equal(admitted.readyState, WebSocket.OPEN);
  assert.equal(coolDowns.size, 0, "a proven lease clears an admission-only cool-down");
});

test("a socket without a public-key digest is cooled down on its first frame, per sender", async (t) => {
  const relay = await startRelay(t, { managed: true });
  const hub = await relay.connect();
  const hubClosed = closed(hub);
  hub.send(envelope("machine", "all", { senderId: "hub-keyless" }));
  assert.equal((await hubClosed).code, 4406);

  const retry = await relay.connect();
  const retryClosed = closed(retry);
  retry.send(envelope("machine", "all", { senderId: "hub-keyless" }));
  const refused = await retryClosed;
  assert.equal(refused.code, 4425);
  assert.match(refused.reason, /^cool-down; retry-after=[1-5]$/);

  const phone = await relay.connect();
  phone.send(envelope("phone", "all", { senderId: "member-keyless" }));
  await settle();
  assert.equal(phone.readyState, WebSocket.OPEN, "a different sender in the room is unaffected");
  assert.deepEqual(relay.lines.filter((line) => line.event === "relay.policy_close").map((line) => line.code), [4406, 4425]);
});

test("rate-limited and oversize senders close with accurate codes and cool down", async (t) => {
  const relay = await startRelay(t);
  const noisy = await relay.connect({ key: memberKey });
  const noisyClosed = closed(noisy);
  for (let index = 0; index < 301; index += 1) noisy.send("x");
  assert.deepEqual(await noisyClosed, { code: 4429, reason: "rate-limit; retry-after=5" });
  assert.equal((await relay.refusal({ key: memberKey })).status, 429);

  const large = await relay.connect({ key: computerKey });
  const largeClosed = closed(large);
  large.send(envelope("machine", "phone", { deliveryId: "too-large", expiresAt: Date.now() + 60_000,
    box: Buffer.alloc(1_350_001, 7).toString("base64") }));
  assert.deepEqual(await largeClosed, { code: 1009, reason: "oversize; retry-after=5" });
  assert.equal(relay.store.queue(room, "phone").length, 0);
  const refused = await relay.refusal({ key: computerKey });
  assert.equal(refused.status, 429);
  assert.equal(await relay.connect({ key: hubKey }).then((socket) => socket.readyState), WebSocket.OPEN);
});
