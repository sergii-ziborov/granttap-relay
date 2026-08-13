import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  createVault,
  lockSession,
  loginRuntime,
  persistVault,
  unlockVault,
  wipeVault,
} from "../src/vaultLogin.js";
import { destroyVault, loadEnvelope, storageContainsPlaintext, storeRuntime } from "../src/vaultStore.js";
import { generateUnlockCode } from "../src/vaultCrypto.js";

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

describe("vaultLogin", () => {
  beforeEach(async () => {
    storeRuntime.idb = null;
    storeRuntime.storage = memoryStorage();
    await destroyVault();
  });

  it("create → unlock → persist → lock → reunlock", async () => {
    const created = await createVault("Ops");
    assert.equal(created.ok, true);
    if (!created.ok) return;

    assert.equal(created.code.startsWith("GTW1."), true);
    assert.equal(storageContainsPlaintext(created.code), false);
    assert.match(created.vaultId, /^[a-f0-9]{64}$/);

    const unlocked = await unlockVault(created.code);
    assert.equal(unlocked.ok, true);
    if (!unlocked.ok) return;
    assert.equal(unlocked.vault.meta.label, "Ops");

    const next = {
      ...unlocked.vault,
      notes: [{
        id: "1",
        title: "t",
        body: "body-secret",
        createdAt: "2026-08-06T00:00:00.000Z",
      }],
    };
    const env = await persistVault(unlocked.key, next, unlocked.envelope.createdAt);
    assert.equal(JSON.stringify(env).includes("body-secret"), false);

    assert.equal(lockSession(), null);

    const again = await unlockVault(created.code);
    assert.equal(again.ok, true);
    if (!again.ok) return;
    assert.equal(again.vault.notes[0]?.body, "body-secret");
  });

  it("wrong code returns clear error", async () => {
    const created = await createVault();
    assert.equal(created.ok, true);
    const bad = await unlockVault(generateUnlockCode());
    assert.equal(bad.ok, false);
    if (bad.ok) return;
    assert.equal(bad.error, "Wrong code or corrupted vault.");
  });

  it("invalid format returns GrantTap code error", async () => {
    const created = await createVault();
    assert.equal(created.ok, true);
    const bad = await unlockVault("nope");
    assert.equal(bad.ok, false);
    if (bad.ok) return;
    assert.match(bad.error, /GrantTap code/);
  });

  it("unlock without vault asks to create", async () => {
    const res = await unlockVault(generateUnlockCode());
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.match(res.error, /Create one first/);
  });

  it("accepts raw key without GTW1. prefix", async () => {
    const created = await createVault();
    if (!created.ok) throw new Error("create failed");
    const raw = created.code.slice("GTW1.".length);
    const unlocked = await unlockVault(raw);
    assert.equal(unlocked.ok, true);
  });

  it("wipeVault removes envelope", async () => {
    const created = await createVault();
    assert.equal(created.ok, true);
    await wipeVault();
    assert.equal(await loadEnvelope(), null);
  });

  it("createVault returns error when crypto fails", async () => {
    const prev = loginRuntime.generateUnlockCode;
    loginRuntime.generateUnlockCode = () => {
      throw new Error("rng-fail");
    };
    try {
      const res = await createVault();
      assert.equal(res.ok, false);
      if (!res.ok) assert.match(res.error, /Could not create/);
    } finally {
      loginRuntime.generateUnlockCode = prev;
    }
  });

  it("unlockVault can use a provided envelope", async () => {
    const created = await createVault();
    if (!created.ok) throw new Error("create failed");
    await wipeVault();
    const unlocked = await unlockVault(created.code, created.envelope);
    assert.equal(unlocked.ok, true);
  });
});
