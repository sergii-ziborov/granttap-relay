import assert from "node:assert/strict";
import test from "node:test";
import { GrantTapCodes } from "../src/worker.js";

const mailbox = "ef".repeat(16);
const url = `https://relay.example/pair/${mailbox}`;

function codes() {
  const values = new Map();
  return new GrantTapCodes({ storage: {
    get: async (key) => values.get(key), put: async (key, value) => values.set(key, value),
    deleteAll: async () => values.clear(), setAlarm: async () => {},
  } });
}

test("pairing mailbox supports POST and rejects malformed paths and methods", async () => {
  const instance = codes();
  assert.equal((await instance.fetch(new Request("https://relay.example/pair/bad"))).status, 400);
  assert.equal((await instance.fetch(new Request(url, { method: "PATCH" }))).status, 405);
  const body = { nonce: "A".repeat(32), box: "B".repeat(64) };
  assert.equal((await instance.fetch(new Request(url, { method: "POST", body: JSON.stringify(body) }))).status, 200);
});

test("pairing mailbox clears expired ciphertext before reporting it absent", async () => {
  const values = new Map([["pairing", { nonce: "A".repeat(32), box: "B".repeat(64), expiresAt: Date.now() - 1 }]]);
  const instance = new GrantTapCodes({ storage: {
    get: async (key) => values.get(key), put: async (key, value) => values.set(key, value), deleteAll: async () => values.clear(), setAlarm: async () => {},
  } });
  assert.equal((await instance.fetch(new Request(url))).status, 404);
  assert.equal(values.size, 0);
});
