import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RelayStore } from "../src/node/store.js";

function temporaryStore(t) {
  const directory = mkdtempSync(join(tmpdir(), "granttap-relay-bounds-"));
  const store = new RelayStore(join(directory, "relay.sqlite3"));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return store;
}

test("reading unknown room authentication does not allocate a room", (t) => {
  const store = temporaryStore(t);
  assert.equal(store.authDigest("unknown"), null);
  const rows = store.db.prepare("SELECT COUNT(*) AS count FROM rooms").get();
  assert.equal(rows.count, 0);
});

test("one oversized ciphertext cannot exceed the durable queue byte cap", (t) => {
  const store = temporaryStore(t);
  store.pinAuth("room", "digest");
  store.enqueue("room", "phone", "x".repeat(1_800_001), "large", Date.now() + 60_000);
  assert.equal(store.queue("room", "phone").length, 0);
});

test("expired ciphertext is deleted from the database during queue read", (t) => {
  const store = temporaryStore(t);
  store.pinAuth("room", "digest");
  store.enqueue("room", "phone", "ciphertext", "expired", Date.now() - 1);
  assert.deepEqual(store.queue("room", "phone"), []);
  const row = store.db.prepare("SELECT phone_queue FROM rooms WHERE room = ?").get("room");
  assert.deepEqual(JSON.parse(row.phone_queue), []);
});
