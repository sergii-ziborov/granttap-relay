import { upgradeIdentity } from "../relay/coolDown.js";
import { validRecipientKeyId } from "../relay/recipientRouting.js";
import { managedCooldownIdentity } from './managed-admission.js';

const STATUS_TEXT = { 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden",
  429: "Too Many Requests", 503: "Service Unavailable" };

/**
 * Decides whether an authenticated upgrade may proceed. Returns null to accept,
 * otherwise `{ status, reason, retryAfter? }`. A valid managed admission lease
 * clears a cool-down caused only by admission closes.
 */
export function upgradeRefusal({ authorized, admissionRequired, ticketHeader, ticket, recipientKeyId,
  room, roomSize, maxRoomSockets, coolDowns }) {
  if (!authorized) return { status: 401, reason: "unauthorized" };
  if (admissionRequired && ticketHeader && !ticket) return { status: 403, reason: "admission-invalid" };
  if (recipientKeyId !== undefined && !validRecipientKeyId(recipientKeyId)) {
    return { status: 400, reason: "recipient-invalid" };
  }
  const legacy = upgradeIdentity(room, recipientKeyId);
  if (ticket) coolDowns.remaining(legacy, { admitted: true }); // clear admission-only legacy cooldowns
  const waitMs = coolDowns.remaining(managedCooldownIdentity(ticket) ?? legacy, { admitted: Boolean(ticket) });
  if (waitMs > 0) return { status: 429, reason: "cool-down", retryAfter: Math.max(1, Math.ceil(waitMs / 1_000)) };
  if (roomSize >= maxRoomSockets) return { status: 503, reason: "room-full" };
  return null;
}

/** Raw HTTP refusal before the WebSocket handshake; 429 carries Retry-After and a tiny JSON body. */
export function refuseUpgrade(socket, { status, reason, retryAfter, category, limitReason }) {
  const body = status === 429 ? JSON.stringify({ error: reason, retryAfter }) : "";
  const lines = [`HTTP/1.1 ${status} ${STATUS_TEXT[status]}`, "Connection: close"];
  if (retryAfter) lines.push(`Retry-After: ${retryAfter}`);
  if (category && ['anonymous','registered','subscriber','beta'].includes(category)) lines.push(`X-Hostwatch-Client-Category: ${category}`, `X-Hostwatch-Client-Limit: ${/^[a-z-]+$/.test(limitReason ?? reason) ? limitReason ?? reason : 'policy-limit'}`);
  if (body) lines.push("Content-Type: application/json", "Cache-Control: no-store",
    `Content-Length: ${Buffer.byteLength(body)}`);
  socket.write(`${lines.join("\r\n")}\r\n\r\n${body}`);
  socket.destroy();
}
