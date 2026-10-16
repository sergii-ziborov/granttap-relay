/**
 * Bounded, in-memory reconnect cool-down after policy closes.
 *
 * Keys contain only a room prefix, a public-key identifier prefix, or a role
 * plus a non-cryptographic digest of the cleartext sender id. Tokens, room
 * credentials, admission tickets and ciphertext are never stored here.
 */
export const COOL_DOWN_BASE_MS = 5_000;
export const COOL_DOWN_MAX_MS = 5 * 60_000;
export const COOL_DOWN_RESET_MS = 15 * 60_000;
export const COOL_DOWN_MAX_ENTRIES = 10_000;
const SWEEP_PER_STRIKE = 8;

export class CoolDownRegistry {
  constructor({ baseMs = COOL_DOWN_BASE_MS, maxMs = COOL_DOWN_MAX_MS, resetMs = COOL_DOWN_RESET_MS,
    maxEntries = COOL_DOWN_MAX_ENTRIES, now = Date.now } = {}) {
    Object.assign(this, { baseMs, maxMs, resetMs, maxEntries, now });
    this.entries = new Map();
  }

  get size() { return this.entries.size; }

  /** Records one policy close and returns the new backoff in milliseconds. */
  strike(key, { admission = false } = {}) {
    const now = this.now();
    const previous = this.entries.get(key);
    const fresh = !previous || now - previous.until > this.resetMs;
    const strikes = fresh ? 1 : previous.strikes + 1;
    const backoffMs = Math.min(this.maxMs, this.baseMs * 2 ** Math.min(strikes - 1, 30));
    const entry = { strikes, until: now + backoffMs,
      admissionOnly: admission && (fresh || previous.admissionOnly) };
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.sweep(now);
    return backoffMs;
  }

  /**
   * Remaining cool-down for an identity. A socket that proves a valid managed
   * admission lease clears an entry caused only by admission closes.
   */
  remaining(key, { admitted = false } = {}) {
    if (!key) return 0;
    const entry = this.entries.get(key);
    if (!entry) return 0;
    const now = this.now();
    if (admitted && entry.admissionOnly) {
      this.entries.delete(key);
      return 0;
    }
    if (now - entry.until > this.resetMs) {
      this.entries.delete(key);
      return 0;
    }
    return Math.max(0, entry.until - now);
  }

  sweep(now) {
    let checked = 0;
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= this.maxEntries && checked >= SWEEP_PER_STRIKE) break;
      checked += 1;
      if (this.entries.size > this.maxEntries || now - entry.until > this.resetMs) this.entries.delete(key);
    }
  }
}

/** Identity available before the upgrade: the room plus the advertised public-key digest. */
export function upgradeIdentity(room, recipientKeyId) {
  return typeof room === "string" && typeof recipientKeyId === "string" && recipientKeyId
    ? `${room.slice(0, 16)}|k|${recipientKeyId.slice(0, 32)}` : null;
}

/** Identity of one socket: its public-key digest, else its first frame's role and sender. */
export function socketIdentity({ room, recipientKeyId, role, senderId }) {
  const keyed = upgradeIdentity(room, recipientKeyId);
  if (keyed) return keyed;
  if (typeof room !== "string" || !role || typeof senderId !== "string") return null;
  return `${room.slice(0, 16)}|s|${role}|${digest(senderId)}`;
}

/** Two FNV-1a passes; enough to separate senders without retaining the cleartext id. */
function digest(value) {
  let first = 0x811c9dc5;
  let second = 0x01000193;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193) >>> 0;
    second = Math.imul(second ^ code, 0x811c9dc5) >>> 0;
  }
  return first.toString(16).padStart(8, "0") + second.toString(16).padStart(8, "0");
}
