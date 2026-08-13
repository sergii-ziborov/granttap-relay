import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { handleVaultApi, validVaultId } from "../src/vaultApi.js";
import {
  emptyVault,
  encryptVault,
  generateUnlockCode,
  keyFromCode,
  vaultIdFromCode,
} from "../src/vaultCrypto.js";

function memoryKv(seed = new Map()) {
  return {
    async get(key, type) {
      if (!seed.has(key)) return null;
      const raw = seed.get(key);
      return type === "json" ? JSON.parse(raw) : raw;
    },
    async put(key, value) { seed.set(key, value); },
    async delete(key) { seed.delete(key); },
    _map: seed,
  };
}

function memoryDurable(seed = new Map()) {
  const storage = {
    async get(key) { return seed.get(key); },
    async put(key, value) { seed.set(key, value); },
    async delete(key) { seed.delete(key); },
    async transaction(callback) { return callback(storage); },
    _map: seed,
  };
  return storage;
}

describe("vaultApi", () => {
  it("validates vault ids", () => {
    assert.equal(validVaultId("ab".repeat(32)), true);
    assert.equal(validVaultId("short"), false);
  });

  it("returns 503 without KV binding", async () => {
    const id = "ab".repeat(32);
    const res = await handleVaultApi(new Request(`https://x/api/vault/${id}`), {});
    assert.equal(res.status, 503);
  });

  it("migrates legacy ciphertext and enforces ETag CAS for PUT and DELETE", async () => {
    const code = generateUnlockCode();
    const key = await keyFromCode(code);
    const envelope = await encryptVault(key, emptyVault("KV"));
    const vaultId = await vaultIdFromCode(code);
    const kv = memoryKv(new Map([[vaultId, JSON.stringify(envelope)]]));
    const durable = memoryDurable();

    const migrated = await handleVaultApi(
      new Request(`https://x/api/vault/${vaultId}`),
      { GRANTTAP_VAULT: kv },
      durable,
    );
    assert.equal(migrated.status, 200);
    const firstEtag = migrated.headers.get("etag");
    assert.match(firstEtag ?? "", /^"[a-f0-9]{64}"$/);
    assert.equal((await migrated.json()).envelope.ciphertext, envelope.ciphertext);

    const newer = await encryptVault(key, {
      ...emptyVault("KV"),
      notes: [{ id: "n1", title: "secret", body: "never plaintext", createdAt: "now" }],
    }, envelope.createdAt);

    const put = await handleVaultApi(
      new Request(`https://x/api/vault/${vaultId}`, {
        method: "PUT",
        headers: { "content-type": "application/json", "if-match": firstEtag },
        body: JSON.stringify({ envelope: newer }),
      }),
      { GRANTTAP_VAULT: kv },
      durable,
    );
    assert.equal(put.status, 200);
    const secondEtag = put.headers.get("etag");
    assert.match(secondEtag ?? "", /^"[a-f0-9]{64}"$/);
    assert.notEqual(secondEtag, firstEtag);

    const stale = await handleVaultApi(
      new Request(`https://x/api/vault/${vaultId}`, {
        method: "PUT",
        headers: { "content-type": "application/json", "if-match": firstEtag },
        body: JSON.stringify({ envelope }),
      }),
      { GRANTTAP_VAULT: kv },
      durable,
    );
    assert.equal(stale.status, 412);
    assert.equal(stale.headers.get("etag"), secondEtag);

    const get = await handleVaultApi(
      new Request(`https://x/api/vault/${vaultId}`),
      { GRANTTAP_VAULT: kv },
      durable,
    );
    assert.equal(get.status, 200);
    const body = await get.json();
    assert.equal(body.envelope.ciphertext, newer.ciphertext);
    assert.equal(body.revision, secondEtag.slice(1, -1));
    assert.equal(JSON.stringify(body).includes("never plaintext"), false);

    const staleDelete = await handleVaultApi(
      new Request(`https://x/api/vault/${vaultId}`, {
        method: "DELETE",
        headers: { "if-match": firstEtag },
      }),
      { GRANTTAP_VAULT: kv },
      durable,
    );
    assert.equal(staleDelete.status, 412);

    const del = await handleVaultApi(
      new Request(`https://x/api/vault/${vaultId}`, {
        method: "DELETE",
        headers: { "if-match": secondEtag },
      }),
      { GRANTTAP_VAULT: kv },
      durable,
    );
    assert.equal(del.status, 200);
    const missing = await handleVaultApi(
      new Request(`https://x/api/vault/${vaultId}`),
      { GRANTTAP_VAULT: kv },
      durable,
    );
    assert.equal(missing.status, 404);
  });

  it("requires create/update preconditions and rejects duplicate create", async () => {
    const code = generateUnlockCode();
    const key = await keyFromCode(code);
    const envelope = await encryptVault(key, emptyVault("CAS"));
    const vaultId = await vaultIdFromCode(code);
    const env = { GRANTTAP_VAULT: memoryKv() };
    const durable = memoryDurable();
    const request = (headers = {}) => handleVaultApi(new Request(`https://x/api/vault/${vaultId}`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ envelope }),
    }), env, durable);

    assert.equal((await request()).status, 428);
    const created = await request({ "if-none-match": "*" });
    assert.equal(created.status, 200);
    assert.equal((await request({ "if-none-match": "*" })).status, 412);
    assert.equal((await request({ "if-match": "\"00\"" })).status, 400);
  });

  it("rejects bad envelopes", async () => {
    const id = "cd".repeat(32);
    const res = await handleVaultApi(
      new Request(`https://x/api/vault/${id}`, {
        method: "PUT",
        headers: { "content-type": "application/json", "if-none-match": "*" },
        body: JSON.stringify({ v: 1 }),
      }),
      { GRANTTAP_VAULT: memoryKv() },
    );
    assert.equal(res.status, 400);
  });
});
