import { STATE_TTL_MS, validRetainedState } from "../retainedState/policy.js";
export const MAX_ENVELOPE_TTL_MS = 25 * 60 * 60 * 1000;
const MAX_SUBMISSION_TTL_MS = 31 * 24 * 60 * 60 * 1000;

export function validRoom(room) {
  return typeof room === "string" && /^[a-f0-9]{16,64}$/.test(room);
}

/** Mac helper upgrades `/`. The iPhone currently opens `/ws`. Accept both. */
export function acceptsWebSocketPath(pathname) {
  return pathname === "/" || pathname === "/ws";
}

export function validRoomCredential(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

export function validIdentifier(value, max) {
  return typeof value === "string" && value.length >= 1 && value.length <= max;
}

const ENVELOPE_FIELDS = new Set(["v", "room", "from", "to", "senderId", "deliveryId", "wake", "expiresAt", "nonce", "box", "recipientKeyId", "stateKey", "stateRevision", "statePriority", "stateGroup"]);

export function validEnvelope(envelope, room, now = Date.now(), maximumTtlMs) {
  return envelopeProblem(envelope, room, now, maximumTtlMs) === null;
}

/**
 * `null` for a deliverable envelope, `"expired"` for an otherwise well-formed
 * envelope whose expiry already passed, and `"invalid"` for anything else.
 */
export function envelopeProblem(envelope, room, now = Date.now(), maximumTtlMs) {
  if (!envelope || typeof envelope !== "object" || envelope.v !== 1 || envelope.room !== room) return "invalid";
  if (Object.keys(envelope).some((key) => !ENVELOPE_FIELDS.has(key))) return "invalid";
  if (envelope.from !== "machine" && envelope.from !== "phone") return "invalid";
  if (envelope.to !== "machine" && envelope.to !== "phone" && envelope.to !== "all") return "invalid";
  if (!validIdentifier(envelope.senderId, 180)) return "invalid";
  if (envelope.deliveryId != null && !validIdentifier(envelope.deliveryId, 180)) return "invalid";
  if (envelope.recipientKeyId != null && !/^[a-f0-9]{64}$/.test(envelope.recipientKeyId)) return "invalid";
  if (envelope.wake != null && typeof envelope.wake !== "boolean") return "invalid";
  const extended = envelope.from === 'phone' && envelope.to === 'machine'
    && typeof envelope.deliveryId === 'string' && ['user-message-', 'attachment-']
      .some(prefix => envelope.deliveryId.startsWith(prefix) && envelope.deliveryId.length > prefix.length);
  if (!validRetainedState(envelope, now)) return "invalid";
  const ttlLimit = maximumTtlMs ?? (envelope.stateKey ? STATE_TTL_MS : extended ? MAX_SUBMISSION_TTL_MS : MAX_ENVELOPE_TTL_MS);
  if (envelope.expiresAt != null && (!Number.isSafeInteger(envelope.expiresAt)
      || envelope.expiresAt > now + ttlLimit)) return "invalid";
  if (typeof envelope.nonce !== "string" || !/^[A-Za-z0-9+/]{32}$/.test(envelope.nonce)) return "invalid";
  if (typeof envelope.box !== "string" || envelope.box.length < 24
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.box)) return "invalid";
  return envelope.expiresAt != null && envelope.expiresAt <= now ? "expired" : null;
}

export function validDeviceToken(token) {
  return /^[0-9a-f]{32,256}$/.test(token) && token.length % 2 === 0;
}

export function validBase64(value, minLength, maxLength) {
  if (typeof value !== "string" || value.length < minLength || value.length > maxLength
      || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  return btoa(atob(value)) === value;
}
