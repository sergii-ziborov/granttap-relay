import assert from "node:assert/strict";
import test from "node:test";
import { COOL_DOWN_MAX_MS, CoolDownRegistry, socketIdentity, upgradeIdentity } from "../src/relay/coolDown.js";

const room = "af927a60".repeat(4);
const keyId = "1".repeat(64);

test("policy closes back off exponentially up to the cap and reset after a quiet period", () => {
  let now = 0;
  const registry = new CoolDownRegistry({ now: () => now });
  const steps = [];
  for (let index = 0; index < 9; index += 1) {
    steps.push(registry.strike("id"));
    now = registry.entries.get("id").until;
  }
  assert.deepEqual(steps, [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000, 300_000]);
  assert.equal(COOL_DOWN_MAX_MS, 300_000);
  now += 15 * 60_000 + 1;
  assert.equal(registry.strike("id"), 5_000, "strikes are forgotten after fifteen quiet minutes");
});

test("remaining time reports the window and expires stale entries", () => {
  let now = 0;
  const registry = new CoolDownRegistry({ now: () => now });
  assert.equal(registry.remaining(null), 0);
  assert.equal(registry.remaining("unknown"), 0);
  registry.strike("id");
  now = 1_000;
  assert.equal(registry.remaining("id"), 4_000);
  now = 5_000;
  assert.equal(registry.remaining("id"), 0);
  assert.equal(registry.size, 1, "an elapsed window still remembers its strike count");
  now = 5_000 + 15 * 60_000 + 1;
  assert.equal(registry.remaining("id"), 0);
  assert.equal(registry.size, 0);
});

test("a valid admission lease clears only admission-caused cool-downs", () => {
  const registry = new CoolDownRegistry({ now: () => 0 });
  registry.strike("admission", { admission: true });
  registry.strike("admission", { admission: true });
  assert.equal(registry.remaining("admission", { admitted: false }), 10_000);
  assert.equal(registry.remaining("admission", { admitted: true }), 0);
  assert.equal(registry.size, 0);
  registry.strike("mixed", { admission: true });
  registry.strike("mixed", { admission: false });
  assert.equal(registry.remaining("mixed", { admitted: true }), 10_000);
  registry.strike("rate", { admission: false });
  assert.equal(registry.remaining("rate", { admitted: true }), 5_000);
});

test("memory stays bounded by evicting the least recently struck identities", () => {
  let now = 0;
  const registry = new CoolDownRegistry({ now: () => now, maxEntries: 3 });
  for (const key of ["a", "b", "c"]) registry.strike(key);
  registry.strike("a");
  registry.strike("d");
  assert.deepEqual([...registry.entries.keys()], ["c", "a", "d"]);
  now = 20 * 60_000;
  registry.strike("e");
  assert.deepEqual([...registry.entries.keys()], ["e"], "stale entries are swept while striking");
});

test("identities contain only room and key prefixes or a sender digest", () => {
  assert.equal(upgradeIdentity(room, keyId), `${room.slice(0, 16)}|k|${keyId.slice(0, 32)}`);
  assert.equal(upgradeIdentity(room, undefined), null);
  assert.equal(upgradeIdentity(room, ""), null);
  assert.equal(upgradeIdentity(undefined, keyId), null);
  assert.equal(socketIdentity({ room, recipientKeyId: keyId, role: "machine", senderId: "hub-1" }), upgradeIdentity(room, keyId));
  const hub = socketIdentity({ room, role: "machine", senderId: "hub-1a2b3c4d" });
  assert.match(hub, /^af927a60af927a60\|s\|machine\|[a-f0-9]{16}$/);
  assert.equal(hub.includes("hub-"), false);
  assert.notEqual(hub, socketIdentity({ room, role: "machine", senderId: "hub-1a2b3c4e" }));
  assert.notEqual(hub, socketIdentity({ room, role: "phone", senderId: "hub-1a2b3c4d" }));
  assert.equal(socketIdentity({ room, role: null, senderId: "x" }), null);
  assert.equal(socketIdentity({ room, role: "phone" }), null);
  assert.equal(socketIdentity({ role: "phone", senderId: "x" }), null);
});
