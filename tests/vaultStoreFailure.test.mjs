import assert from "node:assert/strict";
import test from "node:test";
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

function storageWithFailures() {
  const values = new Map();
  return {
    values,
    getItem(key) {
      if (key === "throw-get") throw new Error("read unavailable");
      return values.get(key) ?? null;
    },
    setItem(key, value) { values.set(key, value); },
    removeItem(key) { values.delete(key); },
  };
}

test("vault storage degrades to local ciphertext when IndexedDB operations fail", async () => {
  const storage = storageWithFailures();
  const originalGet = storage.getItem;
  storeRuntime.storage = storage;
  storeRuntime.idb = {
    get: async () => { throw new Error("idb get unavailable"); },
    put: async () => { throw new Error("idb put unavailable"); },
    del: async () => { throw new Error("idb delete unavailable"); },
  };
  try {
    storage.values.set(LS_KEY, JSON.stringify({ ciphertext: "local" }));
    assert.deepEqual(await loadEnvelope(), { ciphertext: "local" });
    await saveEnvelope({ ciphertext: "next" });
    assert.deepEqual(JSON.parse(storage.values.get(LS_KEY)), { ciphertext: "next" });
    await destroyVault();
    assert.equal(storage.values.has(LS_KEY), false);
    storage.getItem = () => { throw new Error("storage blocked"); };
    assert.equal(lsGet(), null);
    assert.equal(storageContainsPlaintext("secret"), false);
    lsSet({ value: BigInt(1) });
  } finally {
    storage.getItem = originalGet;
    storeRuntime.idb = undefined;
    storeRuntime.storage = undefined;
  }
});

test("vault storage handles unavailable browser local storage", async () => {
  storeRuntime.idb = null;
  storeRuntime.storage = null;
  try {
    assert.equal(lsGet(), null);
    lsSet({ ciphertext: "not persisted" });
    assert.equal(storageContainsPlaintext("secret"), false);
  } finally {
    storeRuntime.idb = undefined;
    storeRuntime.storage = undefined;
  }
});

test("vault storage uses browser localStorage and absorbs removal failures", async () => {
  const original = globalThis.localStorage;
  const values = new Map();
  globalThis.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: () => { throw new Error("remove blocked"); },
  };
  storeRuntime.idb = null;
  storeRuntime.storage = undefined;
  try {
    lsSet({ ciphertext: "browser-local" });
    assert.deepEqual(lsGet(), { ciphertext: "browser-local" });
    await destroyVault();
    assert.equal(storageContainsPlaintext("browser-local"), true);
  } finally {
    globalThis.localStorage = original;
    storeRuntime.idb = undefined;
    storeRuntime.storage = undefined;
  }
});

test("vault storage handles a browser localStorage accessor that throws", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get: () => { throw new Error("blocked"); } });
  storeRuntime.storage = undefined;
  try {
    assert.equal(lsGet(), null);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else delete globalThis.localStorage;
    storeRuntime.storage = undefined;
  }
});
