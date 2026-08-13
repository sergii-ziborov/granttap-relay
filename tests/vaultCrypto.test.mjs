import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CODE_PREFIX,
  assertKeyBytes,
  decryptVault,
  emptyVault,
  encryptVault,
  fromBase64Url,
  generateUnlockCode,
  isVaultEnvelope,
  keyFromCode,
  parseCode,
  toBase64Url,
  vaultIdFromCode,
  vaultIdFromMaterial,
} from "../src/vaultCrypto.js";

describe("vaultCrypto", () => {
  it("generates GTW1. codes with 32-byte keys", () => {
    const code = generateUnlockCode();
    assert.equal(code.startsWith(CODE_PREFIX), true);
    assert.equal(parseCode(code).length, 32);
  });

  it("accepts GTW1. prefix and raw base64url", () => {
    const code = generateUnlockCode();
    const raw = code.slice(CODE_PREFIX.length);
    assert.deepEqual(parseCode(code), parseCode(raw));
    assert.deepEqual(parseCode(`  ${code}  `), parseCode(code));
  });

  it("rejects invalid codes", () => {
    assert.throws(() => parseCode(""), /GrantTap code/);
    assert.throws(() => parseCode("short"), /GrantTap code/);
    assert.throws(() => parseCode("GTW1.not-valid!!!"), /GrantTap code/);
    assert.throws(() => parseCode(`GTW1.${"a".repeat(42)}`), /GrantTap code/);
  });

  it("rejects decoded key that is not 32 bytes", () => {
    assert.throws(() => assertKeyBytes(new Uint8Array(16)), /GrantTap code/);
    assert.equal(assertKeyBytes(new Uint8Array(32)).length, 32);
  });

  it("roundtrips base64url", () => {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    assert.deepEqual(fromBase64Url(toBase64Url(bytes)), bytes);
  });

  it("encrypt/decrypt roundtrip preserves vault data", async () => {
    const code = generateUnlockCode();
    const key = await keyFromCode(code);
    const data = emptyVault("Lab");
    data.notes.push({
      id: "n1",
      title: "hello",
      body: "secret note",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const env = await encryptVault(key, data);
    assert.equal(env.v, 1);
    assert.ok(env.iv);
    assert.ok(env.ciphertext);
    assert.ok(env.createdAt);
    assert.ok(env.updatedAt);
    assert.equal(JSON.stringify(env).includes("secret note"), false);
    assert.deepEqual(await decryptVault(key, env), data);
    assert.equal(isVaultEnvelope(env), true);
    assert.equal(isVaultEnvelope({ v: 2 }), false);
  });

  it("preserves createdAt when re-encrypting", async () => {
    const key = await keyFromCode(generateUnlockCode());
    const createdAt = "2020-01-01T00:00:00.000Z";
    const env = await encryptVault(key, emptyVault(), createdAt);
    assert.equal(env.createdAt, createdAt);
  });

  it("fails decrypt with the wrong key", async () => {
    const a = await keyFromCode(generateUnlockCode());
    const b = await keyFromCode(generateUnlockCode());
    const env = await encryptVault(a, emptyVault());
    await assert.rejects(() => decryptVault(b, env));
  });

  it("emptyVault defaults label", () => {
    assert.deepEqual(emptyVault(), {
      version: 1,
      notes: [],
      sessions: [],
      meta: { label: "Personal vault" },
    });
  });

  it("vaultId is stable SHA-256 of key material", async () => {
    const code = generateUnlockCode();
    const a = await vaultIdFromCode(code);
    const b = await vaultIdFromMaterial(parseCode(code));
    assert.equal(a, b);
    assert.match(a, /^[a-f0-9]{64}$/);
  });
});
