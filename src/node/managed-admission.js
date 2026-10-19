import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SIGNATURE = /^[A-Za-z0-9_-]{43}$/;
const PUBLIC_KEY = /^[A-Za-z0-9+/]{43}=$/;

/** Only call with a signature-verified ticket. A peer sharing the room or
 * recipient cannot spend another admitted device's reconnect cooldown. */
export function managedCooldownIdentity(ticket) {
  return ticket ? `managed:${createHash('sha256').update(JSON.stringify([ticket.accountId, ticket.computerId, ticket.role ?? 'machine', ticket.publicKey])).digest('hex')}` : null;
}

/** Account authority signs only stable, quota-admitted computers; the relay sees no receipt. */
export function readManagedTicket(token, secret, room, now = Date.now()) {
  if (typeof token !== "string" || token.length > 2_048) return null;
  const parts = token.split(".");
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !SIGNATURE.test(parts[1])) return null;
  const expected = createHmac("sha256", secret).update(`granttap-managed-v1.${parts[0]}`).digest();
  const signature = Buffer.from(parts[1], "base64url");
  if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) return null;
  try {
    const value = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    const supported = value.version === 1 && value.role === undefined
      || value.version === 2 && value.role === "phone";
    return supported && (value.source === undefined || value.source === 'subscription' || value.source === 'beta') && UUID.test(value.accountId) && UUID.test(value.computerId)
      && PUBLIC_KEY.test(value.publicKey) && Buffer.from(value.publicKey, "base64").toString("base64") === value.publicKey
      && value.room === room && Number.isSafeInteger(value.expiresAt)
      && value.expiresAt > now && value.expiresAt <= now + 360_000 ? value : null;
  } catch { return null; }
}

export function managedAdmission(env) {
  if (env.MANAGED_ADMISSION_REQUIRED !== "1") return null;
  if (!env.MANAGED_ADMISSION_KEY_PATH) throw new Error("Managed admission signing key is required.");
  const key = readFileSync(env.MANAGED_ADMISSION_KEY_PATH);
  if (key.length < 32) throw new Error("Managed admission signing key is invalid.");
  return (token, room) => readManagedTicket(token, key, room);
}
