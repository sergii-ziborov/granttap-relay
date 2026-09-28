import assert from "node:assert/strict";
import test from "node:test";
import { GrantTapRoom } from "../src/worker.js";

test("Worker refuses an oversized reliable message before forwarding", async () => {
  const room = "ab".repeat(16);
  const values = new Map();
  let forwarded = 0;
  let closeCode;
  const target = { deserializeAttachment: () => ({ room, role: "phone" }),
    send: () => { forwarded += 1; } };
  const state = {
    getWebSockets: () => [sender, target],
    storage: { get: async (key) => values.get(key),
      put: async (key, value) => values.set(key, value),
      delete: async (key) => values.delete(key) },
  };
  const sender = { deserializeAttachment: () => ({ room, role: "machine" }),
    close: (code) => { closeCode = code; } };
  const relayRoom = new GrantTapRoom(state, {});
  const raw = JSON.stringify({ v: 1, room, from: "machine", to: "phone",
    senderId: "machine", deliveryId: "too-large", expiresAt: Date.now() + 60_000,
    nonce: "A".repeat(32), box: "A".repeat(1_800_000) });
  await relayRoom.webSocketMessage(sender, raw);
  assert.equal(closeCode, 1009);
  assert.equal(forwarded, 0);
  assert.equal(values.has("q:phone"), false);
});
