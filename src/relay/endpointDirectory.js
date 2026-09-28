import { validBase64, validRoom } from "./relayValidation.js";

export const ENDPOINT_BODY_LIMIT = 12_000;
export const ENDPOINT_TTL_MS = 15 * 60 * 1000;

export function endpointStorageKey(room, recipient) {
  if (!validRoom(room) || (recipient !== null && !/^[a-f0-9]{64}$/.test(recipient))) return null;
  return recipient === null ? room : `${room}:${recipient}`;
}

export function validEndpointRecord(body, now = Date.now()) {
  return body && typeof body === "object" && !Array.isArray(body)
    && Object.keys(body).length === 3
    && Object.keys(body).every((key) => ["nonce", "box", "expiresAt"].includes(key))
    && validBase64(body.nonce, 32, 32) && validBase64(body.box, 24, 10_924)
    && Number.isSafeInteger(body.expiresAt) && body.expiresAt > now
    && body.expiresAt <= now + ENDPOINT_TTL_MS;
}

/** The directory never accepts an address or opens a connection to a client endpoint. */
export async function endpointResponse({ method, room, authorize, read, store }) {
  const reply = (status, body) => ({ status, body });
  if (!validRoom(room)) return reply(400, { error: "valid room required" });
  if (!["PUT", "GET", "DELETE"].includes(method)) return reply(405, { error: "method not allowed" });
  let record;
  if (method === "PUT") {
    try { record = await read(); } catch { /* invalid bounded JSON */ }
    if (!validEndpointRecord(record)) return reply(400, { error: "bounded sealed endpoint required" });
  }
  if (!await authorize(method === "PUT")) return reply(401, { error: "invalid room credential" });
  if (method === "PUT") {
    if (await store.put(record) === false) return reply(409, { error: "endpoint capacity" });
    return reply(200, { ok: true });
  }
  if (method === "DELETE") {
    await store.delete();
    return reply(200, { ok: true });
  }
  const current = await store.get();
  if (!current || !validEndpointRecord(current)) {
    if (current) await store.delete();
    return reply(404, { error: "endpoint unavailable" });
  }
  return reply(200, current);
}
