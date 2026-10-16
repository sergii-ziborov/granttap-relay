/**
 * Privacy-safe, rate-limited structured relay diagnostics.
 *
 * Only allowlisted fields survive: an 8-hex room prefix, role, close code,
 * HTTP status, reason token, retry delay and suppression count. Tokens, keys,
 * envelopes, sender ids and IP addresses cannot be written through this logger.
 */
const ROLES = new Set(["machine", "phone"]);
const TOKEN = /^[a-z][a-z0-9-]{0,47}$/;

export function roomTag(room) {
  return typeof room === "string" && /^[a-f0-9]{16,64}$/.test(room) ? room.slice(0, 8) : "-";
}

export function sanitizeLogFields(fields = {}) {
  const clean = { room: roomTag(fields.room), role: ROLES.has(fields.role) ? fields.role : "-" };
  for (const name of ["code", "status", "retryAfter"]) {
    if (Number.isSafeInteger(fields[name]) && fields[name] >= 0) clean[name] = fields[name];
  }
  if (TOKEN.test(fields.reason ?? "")) clean.reason = fields.reason;
  return clean;
}

/**
 * Emits at most one line per (event, room, role, reason, code/status) per
 * interval and at most `maxPerSecond` lines overall. Suppressed repeats are
 * reported as `suppressed` on the next line for the same key.
 */
export function createRelayLog({ write, now = Date.now, intervalMs = 10_000, maxPerSecond = 50, maxKeys = 1_000 } = {}) {
  const seen = new Map();
  let secondStartedAt = -Infinity;
  let secondLines = 0;
  return function log(event, fields) {
    if (!TOKEN.test(event.replace(/[._]/g, "-"))) return false;
    const entry = sanitizeLogFields(fields);
    const key = `${event}|${entry.room}|${entry.role}|${entry.reason ?? ""}|${entry.code ?? entry.status ?? ""}`;
    const time = now();
    const previous = seen.get(key);
    if (previous && time - previous.at < intervalMs) { previous.suppressed += 1; return false; }
    if (time - secondStartedAt >= 1_000) { secondStartedAt = time; secondLines = 0; }
    if (secondLines >= maxPerSecond) {
      if (previous) previous.suppressed += 1;
      return false;
    }
    secondLines += 1;
    seen.delete(key);
    seen.set(key, { at: time, suppressed: 0 });
    if (seen.size > maxKeys) seen.delete(seen.keys().next().value);
    const suppressed = previous?.suppressed ? { suppressed: previous.suppressed } : {};
    try { write(JSON.stringify({ ts: new Date(time).toISOString(), event, ...entry, ...suppressed })); }
    catch { /* diagnostics never break relay traffic */ }
    return true;
  };
}
