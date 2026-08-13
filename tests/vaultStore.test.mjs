import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  LS_KEY,
  destroyVault,
  loadEnvelope,
  lsGet,
  lsSet,
  saveEnvelope,
  storageContainsPlaintext,
  storeRuntime,
} from "../src/vaultStore.js";
import {
  emptyVault,
  encryptVault,
  generateUnlockCode,
  keyFromCode,
} from "../src/vaultCrypto.js";

function memoryStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    get length() { return map.size; },
    clear: () => map.clear(),
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, v); },
    removeItem: (k) => { map.delete(k); },
    key: (i) => [...map.keys()][i] ?? null,
  };
}

async function sampleEnv() {
  const code = generateUnlockCode();
  const key = await keyFromCode(code);
  const env = await encryptVault(key, emptyVault());
  return { code, env };
}

describe("vaultStore", () => {
  beforeEach(async () => {
    storeRuntime.idb = null;
    storeRuntime.storage = memoryStorage();
    await destroyVault();
  });

  it("save and load via localStorage fallback", async () => {
    const { env } = await sampleEnv();
    await saveEnvelope(env);
    assert.deepEqual(await loadEnvelope(), env);
    assert.deepEqual(lsGet(), env);
  });

  it("destroyVault clears storage", async () => {
    const { env } = await sampleEnv();
    await saveEnvelope(env);
    await destroyVault();
    assert.equal(await loadEnvelope(), null);
  });

  it("does not store plaintext code", async () => {
    const { code, env } = await sampleEnv();
    await saveEnvelope(env);
    assert.equal(storageContainsPlaintext(code), false);
    assert.ok(storeRuntime.storage.getItem(LS_KEY));
  });

  it("lsSet / lsGet roundtrip", async () => {
    const { env } = await sampleEnv();
    lsSet(env);
    assert.deepEqual(lsGet(), env);
  });

  it("prefers idb when available", async () => {
    const { env } = await sampleEnv();
    let stored = null;
    storeRuntime.idb = {
      async get() { return stored; },
      async put(e) { stored = e; },
      async del() { stored = null; },
    };
    await saveEnvelope(env);
    assert.deepEqual(stored, env);
    assert.deepEqual(await loadEnvelope(), env);
    await destroyVault();
    assert.equal(stored, null);
  });
});
