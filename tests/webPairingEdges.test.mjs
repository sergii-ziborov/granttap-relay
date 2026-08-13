import assert from "node:assert/strict";
import test from "node:test";
import { GrantTapWebPairing } from "../src/webPairing.js";

const id = "ab".repeat(16);
const url = `https://relay.example/web-pair/${id}`;

function pairingState(seed) {
  const values = new Map(seed ? [["challenge", seed]] : []);
  return { values, storage: {
    get: async (key) => values.get(key), put: async (key, value) => values.set(key, value),
    deleteAll: async () => values.clear(), setAlarm: async () => {},
  } };
}

test("web pairing rejects malformed, occupied, expired, and unsupported requests", async () => {
  const fresh = { origin: "https://granttap.com", expiresAt: Date.now() + 60_000, sealed: null };
  const state = pairingState(fresh);
  const pairing = new GrantTapWebPairing(state);
  assert.equal((await pairing.fetch(new Request("https://relay.example/web-pair/not-an-id"))).status, 400);
  assert.equal((await pairing.fetch(new Request(url, { method: "PUT", headers: { origin: "https://granttap.com" }, body: JSON.stringify({ origin: "https://granttap.com" }) }))).status, 409);
  assert.equal((await pairing.fetch(new Request(url, { method: "POST", body: "{}" }))).status, 403);
  assert.equal((await pairing.fetch(new Request(url, { method: "DELETE" }))).status, 405);
  const expiredState = pairingState({ ...fresh, expiresAt: Date.now() - 1 });
  const expired = new GrantTapWebPairing(expiredState);
  assert.equal((await expired.fetch(new Request(url))).status, 404);
  assert.equal(expiredState.values.size, 0);
});

test("web pairing accepts localhost HTTP only and rejects malformed cipher fields", async () => {
  const state = pairingState();
  const pairing = new GrantTapWebPairing(state);
  const local = "http://localhost:4173";
  assert.equal((await pairing.fetch(new Request(url, { method: "PUT", headers: { origin: local }, body: JSON.stringify({ origin: local }) }))).status, 201);
  const invalid = await pairing.fetch(new Request(url, { method: "POST", body: JSON.stringify({ origin: local, nonce: "bad", box: "*" }) }));
  assert.equal(invalid.status, 403);
  assert.equal((await pairing.fetch(new Request(url, { headers: { origin: local } }))).status, 202);
  await pairing.alarm();
  assert.equal(state.values.size, 0);
});

test("web pairing requires an exact allowed registration origin", async () => {
  const missingOrigin = pairingState();
  const pairing = new GrantTapWebPairing(missingOrigin);
  assert.equal((await pairing.fetch(new Request(url, { method: "PUT", body: JSON.stringify({ origin: "https://granttap.com" }) }))).status, 403);
  const mismatched = pairingState();
  const mismatchPairing = new GrantTapWebPairing(mismatched);
  assert.equal((await mismatchPairing.fetch(new Request(url, { method: "PUT", headers: { origin: "https://evil.example" }, body: JSON.stringify({ origin: "https://granttap.com" }) }))).status, 403);
});

test("web pairing rejects noncanonical origins and oversized registration bodies", async () => {
  const noncanonical = pairingState();
  const pairing = new GrantTapWebPairing(noncanonical);
  assert.equal((await pairing.fetch(new Request(url, { method: "PUT", headers: { origin: "https://granttap.com/path" }, body: JSON.stringify({ origin: "https://granttap.com/path" }) }))).status, 403);
  const oversized = pairingState();
  const oversizedPairing = new GrantTapWebPairing(oversized);
  assert.equal((await oversizedPairing.fetch(new Request(url, { method: "PUT", headers: { origin: "https://granttap.com", "content-length": "32001" }, body: JSON.stringify({ origin: "https://granttap.com" }) }))).status, 403);
});
