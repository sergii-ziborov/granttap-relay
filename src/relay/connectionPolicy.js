/**
 * Connection policy shared by the Node relay and the Durable Object room.
 * Close reasons are a stable token, optionally followed by `; retry-after=<s>`.
 * They never contain ciphertext, credentials, keys or routing identifiers.
 */
export const CLOSE_POLICIES = Object.freeze({
  "admission-expired": Object.freeze({ code: 4401, coolDown: true, admission: true }),
  "admission-required": Object.freeze({ code: 4403, coolDown: true, admission: true }),
  "hub-admission-required": Object.freeze({ code: 4406, coolDown: true, admission: true }),
  "admission-renewal-rejected": Object.freeze({ code: 4409, coolDown: true, admission: true }),
  "cool-down": Object.freeze({ code: 4425, coolDown: false, admission: false }),
  "rate-limit": Object.freeze({ code: 4429, coolDown: true, admission: false }),
  oversize: Object.freeze({ code: 1009, coolDown: true, admission: false }),
});

export const QUEUE_RESULT = Object.freeze({
  STORED: "stored", DUPLICATE: "duplicate", OVERSIZE: "oversize", EXPIRED: "expired", NO_ROOM: "no-room", FULL: "full",
});

export const MAX_SOCKET_MESSAGES_PER_SECOND = 300;

export function closeReason(token, retryAfterSeconds) {
  return retryAfterSeconds > 0 ? `${token}; retry-after=${retryAfterSeconds}` : token;
}

/** A phone hub's `hub-` sender prefix selects a clearer reason; it never grants admission. */
export function admissionCloseToken(envelope) {
  return typeof envelope?.senderId === "string" && envelope.senderId.startsWith("hub-")
    ? "hub-admission-required" : "admission-required";
}

/** Only a genuinely oversize frame closes; expired or room-less reliable frames are dropped. */
export function queueOutcome(result) {
  if (result === QUEUE_RESULT.STORED || result === QUEUE_RESULT.DUPLICATE) return { forward: true };
  if (result === QUEUE_RESULT.OVERSIZE) return { close: "oversize" };
  if (result === QUEUE_RESULT.FULL) return { drop: "full" };
  return { drop: result === QUEUE_RESULT.NO_ROOM ? "no-room" : "expired" };
}

/** Sent only to sockets that negotiated relay control frames; echoes the sender's own delivery id. */
export function droppedNotice(deliveryId, reason) {
  return JSON.stringify({ type: "relay.dropped", deliveryId, reason });
}

/** Fixed one-second window; mutates `window` ({ windowStartedAt, windowMessages }). */
export function acceptSocketFrame(window, now = Date.now(), limit = MAX_SOCKET_MESSAGES_PER_SECOND) {
  if (!(now - window.windowStartedAt < 1_000)) {
    window.windowStartedAt = now;
    window.windowMessages = 0;
  }
  window.windowMessages += 1;
  return window.windowMessages <= limit;
}

/**
 * Closes one socket for a documented policy, records a cool-down strike for its
 * non-secret identity when the policy has one, and writes one sanitized log line.
 */
export function applyPolicyClose({ token, room, role, identity, coolDowns, log, close }) {
  const policy = CLOSE_POLICIES[token];
  const backoffMs = policy.coolDown && identity && coolDowns
    ? coolDowns.strike(identity, { admission: policy.admission }) : 0;
  const retryAfter = backoffMs > 0 ? Math.ceil(backoffMs / 1_000) : undefined;
  log?.("relay.policy_close", { room, role, code: policy.code, reason: token, retryAfter });
  try { close(policy.code, closeReason(token, retryAfter)); } catch { /* already closed */ }
  return retryAfter;
}

/** Refuses the first frame of an identity still cooling down; no new strike is recorded. */
export function refuseCoolingFrame({ room, role, remainingMs, log, close }) {
  const retryAfter = Math.max(1, Math.ceil(remainingMs / 1_000));
  log?.("relay.policy_close", { room, role, code: CLOSE_POLICIES["cool-down"].code, reason: "cool-down", retryAfter });
  try { close(CLOSE_POLICIES["cool-down"].code, closeReason("cool-down", retryAfter)); } catch { /* already closed */ }
  return retryAfter;
}
