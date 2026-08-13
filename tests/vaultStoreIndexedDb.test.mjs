import assert from "node:assert/strict";
import test from "node:test";
import { destroyVault, loadEnvelope, saveEnvelope, storeRuntime } from "../src/vaultStore.js";

function indexedDbMemory() {
  const values = new Map();
  const db = {
    objectStoreNames: { contains: () => false },
    createObjectStore: () => {},
    close: () => {},
    transaction: (_store, mode) => {
      const transaction = { error: null, oncomplete: null, onerror: null };
      const complete = () => queueMicrotask(() => transaction.oncomplete?.());
      transaction.objectStore = () => ({
        get: (key) => {
          const request = { result: values.get(key), onerror: null, onsuccess: null };
          queueMicrotask(() => request.onsuccess?.());
          return request;
        },
        put: (value, key) => { values.set(key, value); complete(); },
        delete: (key) => { values.delete(key); complete(); },
      });
      assert.equal(mode === "readonly" || mode === "readwrite", true);
      return transaction;
    },
  };
  return {
    open: () => {
      const request = { result: db, error: null, onupgradeneeded: null, onerror: null, onsuccess: null };
      queueMicrotask(() => { request.onupgradeneeded?.(); request.onsuccess?.(); });
      return request;
    },
  };
}

test("default IndexedDB adapter persists and removes ciphertext envelopes", async () => {
  const original = globalThis.indexedDB;
  globalThis.indexedDB = indexedDbMemory();
  storeRuntime.idb = undefined;
  storeRuntime.storage = null;
  const envelope = { v: 1, iv: "test", ciphertext: "opaque" };
  try {
    assert.equal(await loadEnvelope(), null);
    await saveEnvelope(envelope);
    assert.deepEqual(await loadEnvelope(), envelope);
    await destroyVault();
    assert.equal(await loadEnvelope(), null);
  } finally {
    globalThis.indexedDB = original;
    storeRuntime.idb = undefined;
    storeRuntime.storage = undefined;
  }
});
