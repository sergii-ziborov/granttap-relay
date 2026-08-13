import assert from "node:assert/strict";
import test from "node:test";
import { handleVaultApi } from "../src/vaultApi.js";
import { emptyVault, encryptVault, generateUnlockCode, keyFromCode, vaultIdFromCode } from "../src/vaultCrypto.js";

function memoryKv() {
  const values = new Map();
  return {
    get: async (key, type) => type === "json" && values.has(key) ? JSON.parse(values.get(key)) : null,
    put: async (key, value) => values.set(key, value),
    delete: async (key) => values.delete(key),
  };
}

function memoryStorage() {
  const values = new Map();
  const storage = {
    get: async (key) => values.get(key), put: async (key, value) => values.set(key, value),
    delete: async (key) => values.delete(key), transaction: async (callback) => callback(storage),
  };
  return storage;
}

test("vault API rejects malformed routes, bodies, methods, and preconditions", async () => {
  const kv = memoryKv();
  const id = "ab".repeat(32);
  const env = { GRANTTAP_VAULT: kv };
  assert.equal((await handleVaultApi(new Request("https://relay.example/api/vault/nope"), env)).status, 404);
  assert.equal((await handleVaultApi(new Request(`https://relay.example/api/vault/${id}`, { method: "PATCH" }), env)).status, 405);
  assert.equal((await handleVaultApi(new Request(`https://relay.example/api/vault/${id}`, { method: "PUT", body: "{" }), env)).status, 400);
  const code = generateUnlockCode();
  const envelope = await encryptVault(await keyFromCode(code), emptyVault());
  const put = (headers, body = { envelope }) => handleVaultApi(new Request(`https://relay.example/api/vault/${id}`, {
    method: "PUT", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
  }), env);
  assert.equal((await put({ "if-match": "\"" + "00".repeat(32) + "\"", "if-none-match": "*" })).status, 400);
  assert.equal((await put({ "if-none-match": "bad" })).status, 400);
  assert.equal((await put({ "if-none-match": "*" }, { envelope: { ...envelope, iv: "A".repeat(65) } })).status, 400);
  assert.equal((await handleVaultApi(new Request(`https://relay.example/api/vault/${id}`, { method: "DELETE" }), env)).status, 428);
});

test("vault API preserves canonical durable records when optional KV mirror fails", async () => {
  const code = generateUnlockCode();
  const id = await vaultIdFromCode(code);
  const envelope = await encryptVault(await keyFromCode(code), emptyVault("mirror"));
  const storage = memoryStorage();
  const env = { GRANTTAP_VAULT: { get: async () => null, put: async () => { throw new Error("mirror unavailable"); }, delete: async () => { throw new Error("mirror unavailable"); } } };
  const create = await handleVaultApi(new Request(`https://relay.example/api/vault/${id}`, { method: "PUT", headers: { "if-none-match": "*", "content-type": "application/json" }, body: JSON.stringify({ envelope }) }), env, storage);
  assert.equal(create.status, 200);
  const revision = create.headers.get("etag");
  const remove = await handleVaultApi(new Request(`https://relay.example/api/vault/${id}`, { method: "DELETE", headers: { "if-match": revision } }), env, storage);
  assert.equal(remove.status, 200);
});

test("vault API supports direct KV records and treats malformed stored data as absent", async () => {
  const code = generateUnlockCode();
  const id = await vaultIdFromCode(code);
  const envelope = await encryptVault(await keyFromCode(code), emptyVault("direct"));
  const kv = memoryKv();
  const env = { GRANTTAP_VAULT: kv };
  const create = await handleVaultApi(new Request(`https://relay.example/api/vault/${id}`, { method: "PUT", headers: { "if-none-match": "*", "content-type": "application/json" }, body: JSON.stringify({ envelope }) }), env);
  assert.equal(create.status, 200);
  const revision = create.headers.get("etag");
  assert.equal((await handleVaultApi(new Request(`https://relay.example/api/vault/${id}`), env)).status, 200);
  assert.equal((await handleVaultApi(new Request(`https://relay.example/api/vault/${id}`, { method: "DELETE", headers: { "if-match": revision } }), env)).status, 200);
  const badKv = { get: async () => ({ envelope: { invalid: true }, revision: "not-a-revision" }), put: async () => {}, delete: async () => {} };
  assert.equal((await handleVaultApi(new Request(`https://relay.example/api/vault/${id}`), { GRANTTAP_VAULT: badKv })).status, 404);
});

test("vault API cancels streamed bodies that exceed the ciphertext size limit", async () => {
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("x".repeat(64_001))); controller.close(); } });
  const response = await handleVaultApi(new Request(`https://relay.example/api/vault/${"ab".repeat(32)}`, { method: "PUT", body: stream, duplex: "half" }), { GRANTTAP_VAULT: memoryKv() });
  assert.equal(response.status, 400);
});

test("vault API rejects weak delete ETags and reports a missing-record conflict", async () => {
  const id = "ef".repeat(32);
  const env = { GRANTTAP_VAULT: memoryKv() };
  assert.equal((await handleVaultApi(new Request(`https://relay.example/api/vault/${id}`, { method: "DELETE", headers: { "if-match": `W/\"${"ab".repeat(32)}\"` } }), env)).status, 428);
  const conflict = await handleVaultApi(new Request(`https://relay.example/api/vault/${id}`, { method: "DELETE", headers: { "if-match": `\"${"ab".repeat(32)}\"` } }), env);
  assert.equal(conflict.status, 412);
  assert.equal((await conflict.json()).revision, null);
});

test("vault API accepts the documented POST create alias", async () => {
  const code = generateUnlockCode();
  const id = await vaultIdFromCode(code);
  const envelope = await encryptVault(await keyFromCode(code), emptyVault("post"));
  const response = await handleVaultApi(new Request(`https://relay.example/api/vault/${id}`, { method: "POST", headers: { "if-none-match": "*", "content-type": "application/json" }, body: JSON.stringify({ envelope }) }), { GRANTTAP_VAULT: memoryKv() });
  assert.equal(response.status, 200);
});
