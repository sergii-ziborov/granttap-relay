/**
 * Pure login / unlock orchestration for GrantTap Web.
 * UI stays thin; crypto + storage stay here.
 */
import {
  decryptVault,
  emptyVault,
  encryptVault,
  generateUnlockCode,
  keyFromCode,
  parseCode,
  vaultIdFromMaterial,
} from "./vaultCrypto.js";
import { destroyVault, loadEnvelope, saveEnvelope } from "./vaultStore.js";

/** Injectable for tests (ESM exports are not mockable). */
export const loginRuntime = {
  generateUnlockCode,
};

export async function createVault(label) {
  try {
    const code = loginRuntime.generateUnlockCode();
    const key = await keyFromCode(code);
    const vault = emptyVault(label);
    const envelope = await encryptVault(key, vault);
    await saveEnvelope(envelope);
    const vaultId = await vaultIdFromMaterial(parseCode(code));
    return { ok: true, code, envelope, vault, vaultId };
  } catch {
    return { ok: false, error: "Could not create a vault in this browser." };
  }
}

export async function unlockVault(code, existing) {
  try {
    const material = parseCode(code);
    const key = await keyFromCode(code);
    const env = existing ?? (await loadEnvelope());
    if (!env) {
      return { ok: false, error: "No vault on this browser yet. Create one first." };
    }
    const vault = await decryptVault(key, env);
    const vaultId = await vaultIdFromMaterial(material);
    return { ok: true, key, vault, envelope: env, vaultId };
  } catch (err) {
    const msg =
      err instanceof Error && err.message.includes("GrantTap code")
        ? err.message
        : "Wrong code or corrupted vault.";
    return { ok: false, error: msg };
  }
}

export async function persistVault(key, data, createdAt) {
  const env = await encryptVault(key, data, createdAt);
  await saveEnvelope(env);
  return env;
}

/** Wipe in-memory key reference (caller must drop their copy). */
export function lockSession() {
  return null;
}

export async function wipeVault() {
  await destroyVault();
}
