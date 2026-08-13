/**
 * Encrypted-at-rest vault storage. IndexedDB with localStorage fallback.
 * Only ciphertext ever touches disk — never the unlock code.
 */

const DB_NAME = "granttap-web";
const STORE = "vault";
const RECORD_ID = "primary";
export const LS_KEY = "granttap-web.vault";

function defaultIdb() {
  if (typeof indexedDB === "undefined") return null;
  const open = () =>
    new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) {
          req.result.createObjectStore(STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("idb-open-failed"));
    });

  return {
    async get() {
      const db = await open();
      try {
        return await new Promise((resolve, reject) => {
          const tx = db.transaction(STORE, "readonly");
          const req = tx.objectStore(STORE).get(RECORD_ID);
          req.onsuccess = () => resolve(req.result ?? null);
          req.onerror = () => reject(req.error);
        });
      } finally {
        db.close();
      }
    },
    async put(env) {
      const db = await open();
      try {
        await new Promise((resolve, reject) => {
          const tx = db.transaction(STORE, "readwrite");
          tx.objectStore(STORE).put(env, RECORD_ID);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      } finally {
        db.close();
      }
    },
    async del() {
      const db = await open();
      try {
        await new Promise((resolve) => {
          const tx = db.transaction(STORE, "readwrite");
          tx.objectStore(STORE).delete(RECORD_ID);
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
        });
      } finally {
        db.close();
      }
    },
  };
}

/** Injectable for tests. */
export const storeRuntime = {
  idb: undefined,
  storage: undefined,
};

function idb() {
  if (storeRuntime.idb !== undefined) return storeRuntime.idb;
  return defaultIdb();
}

function storage() {
  if (storeRuntime.storage !== undefined) return storeRuntime.storage;
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function lsGet() {
  try {
    const ls = storage();
    if (!ls) return null;
    const raw = ls.getItem(LS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function lsSet(env) {
  try {
    storage()?.setItem(LS_KEY, JSON.stringify(env));
  } catch {
    /* storage unavailable */
  }
}

export async function loadEnvelope() {
  try {
    const adapter = idb();
    if (adapter) {
      const env = await adapter.get();
      if (env) return env;
    }
  } catch {
    /* fall through */
  }
  return lsGet();
}

export async function saveEnvelope(env) {
  try {
    const adapter = idb();
    if (adapter) await adapter.put(env);
  } catch {
    /* localStorage still written below */
  }
  lsSet(env);
}

export async function destroyVault() {
  try {
    const adapter = idb();
    if (adapter) await adapter.del();
  } catch {
    /* ignore */
  }
  try {
    storage()?.removeItem(LS_KEY);
  } catch {
    /* ignore */
  }
}

/** Test helper: inspect whether plaintext unlock code leaked into storage. */
export function storageContainsPlaintext(code) {
  try {
    const raw = storage()?.getItem(LS_KEY) ?? "";
    return Boolean(code && raw.includes(code));
  } catch {
    return false;
  }
}
