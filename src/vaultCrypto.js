/**
 * GrantTap Web vault crypto — Web Crypto only, client-side.
 * Code format: GTW1.<base64url 32 bytes>  (raw 43-char base64url also accepted)
 * Compatible with granttap-vault.lovable.app / apps/granttap-web.
 */

export const CODE_PREFIX = "GTW1.";

export function toBase64Url(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(s) {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function generateUnlockCode() {
  const key = new Uint8Array(32);
  crypto.getRandomValues(key);
  return CODE_PREFIX + toBase64Url(key);
}

/** Parse a user-entered code into raw 32-byte key material. Throws on bad format. */
export function parseCode(input) {
  const raw = input.trim().replace(/\s+/g, "");
  const body = raw.startsWith(CODE_PREFIX) ? raw.slice(CODE_PREFIX.length) : raw;
  if (!/^[A-Za-z0-9\-_]{43}$/.test(body)) {
    throw new Error("That doesn't look like a GrantTap code.");
  }
  return assertKeyBytes(fromBase64Url(body));
}

/** Exported for tests — rejects non-256-bit key material. */
export function assertKeyBytes(bytes) {
  if (bytes.length !== 32) throw new Error("That doesn't look like a GrantTap code.");
  return bytes;
}

export async function importKey(material) {
  return crypto.subtle.importKey(
    "raw",
    material.slice().buffer,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function keyFromCode(code) {
  return importKey(parseCode(code));
}

/** Opaque vault lookup id — SHA-256 of key material (never the code itself). */
export async function vaultIdFromMaterial(material) {
  const digest = await crypto.subtle.digest("SHA-256", material.slice().buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function vaultIdFromCode(code) {
  return vaultIdFromMaterial(parseCode(code));
}

export function emptyVault(label = "Personal vault") {
  return { version: 1, notes: [], sessions: [], meta: { label } };
}

export async function encryptVault(key, data, createdAt) {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const plain = new TextEncoder().encode(JSON.stringify(data));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain);
  const now = new Date().toISOString();
  return {
    v: 1,
    iv: toBase64Url(iv),
    ciphertext: toBase64Url(new Uint8Array(ct)),
    createdAt: createdAt ?? now,
    updatedAt: now,
  };
}

export async function decryptVault(key, env) {
  const iv = fromBase64Url(env.iv);
  const ct = fromBase64Url(env.ciphertext);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return JSON.parse(new TextDecoder().decode(plain));
}

export function isVaultEnvelope(value) {
  return Boolean(
    value
      && typeof value === "object"
      && value.v === 1
      && typeof value.iv === "string"
      && typeof value.ciphertext === "string"
      && typeof value.createdAt === "string"
      && typeof value.updatedAt === "string",
  );
}
