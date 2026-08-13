export const MAX_ENVELOPE_TTL_MS = 25 * 60 * 60 * 1000;

export function validRoom(room) {
  return typeof room === "string" && /^[a-f0-9]{16,64}$/.test(room);
}

export function validRoomCredential(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

export function validIdentifier(value, max) {
  return typeof value === "string" && value.length >= 1 && value.length <= max;
}

export function validEnvelope(envelope, room, now = Date.now()) {
  if (!envelope || typeof envelope !== "object" || envelope.v !== 1 || envelope.room !== room) return false;
  if (envelope.from !== "machine" && envelope.from !== "phone") return false;
  if (envelope.to !== "machine" && envelope.to !== "phone" && envelope.to !== "all") return false;
  if (!validIdentifier(envelope.senderId, 180)) return false;
  if (envelope.deliveryId != null && !validIdentifier(envelope.deliveryId, 180)) return false;
  if (envelope.wake != null && typeof envelope.wake !== "boolean") return false;
  if (envelope.expiresAt != null && (!Number.isSafeInteger(envelope.expiresAt)
      || envelope.expiresAt <= now || envelope.expiresAt > now + MAX_ENVELOPE_TTL_MS)) return false;
  if (typeof envelope.nonce !== "string" || !/^[A-Za-z0-9+/]{32}$/.test(envelope.nonce)) return false;
  return typeof envelope.box === "string" && envelope.box.length >= 24
    && /^[A-Za-z0-9+/]+={0,2}$/.test(envelope.box);
}

export function validDeviceToken(token) {
  return /^[0-9a-f]{32,256}$/.test(token) && token.length % 2 === 0;
}

export function validBase64(value, minLength, maxLength) {
  if (typeof value !== "string" || value.length < minLength || value.length > maxLength
      || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  return btoa(atob(value)) === value;
}
