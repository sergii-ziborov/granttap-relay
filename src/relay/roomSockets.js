/**
 * Durable Object glue for the shared connection policy. Per-socket counters and
 * cool-downs are in memory: they reset when the room hibernates, which only
 * happens once its sockets have gone quiet. Workers cannot ping a hibernatable
 * socket, so dead peers are detected by the Cloudflare edge, not by app timers.
 */
import { acceptSocketFrame, applyPolicyClose, droppedNotice, refuseCoolingFrame } from "./connectionPolicy.js";
import { CoolDownRegistry, socketIdentity, upgradeIdentity } from "./coolDown.js";
import { createRelayLog } from "./relayLog.js";
import { json } from "./relaySupport.js";

const ROOM_COOL_DOWN_ENTRIES = 256;

export function initializeRoomSocketPolicy(room) {
  room.coolDowns = new CoolDownRegistry({ maxEntries: ROOM_COOL_DOWN_ENTRIES });
  room.log = createRelayLog({ write: (line) => console.log(line) });
  room.socketPolicy = new WeakMap();
}

function socketState(room, ws) {
  let local = room.socketPolicy.get(ws);
  if (!local) {
    local = { windowStartedAt: -Infinity, windowMessages: 0, identity: null };
    room.socketPolicy.set(ws, local);
  }
  return local;
}

export function acceptRoomFrame(room, ws) {
  return acceptSocketFrame(socketState(room, ws));
}

/** 429 with Retry-After while the upgrading public-key identity is cooling down. */
export function coolingUpgradeResponse(room, roomId, recipientKeyId) {
  const waitMs = room.coolDowns.remaining(upgradeIdentity(roomId, recipientKeyId));
  if (waitMs <= 0) return null;
  const retryAfter = Math.max(1, Math.ceil(waitMs / 1_000));
  room.log("relay.upgrade_refused", { room: roomId, status: 429, reason: "cool-down", retryAfter });
  return json({ error: "cool-down", retryAfter }, 429, { "retry-after": String(retryAfter) });
}

function frameIdentity(known, envelope) {
  return socketIdentity({ room: known.room, recipientKeyId: known.recipientKeyId,
    role: known.role ?? envelope?.from, senderId: envelope?.senderId });
}

export function closeRoomSocket(room, ws, known, token, envelope) {
  return applyPolicyClose({ token, room: known.room, role: known.role ?? envelope?.from,
    identity: socketState(room, ws).identity ?? frameIdentity(known, envelope),
    coolDowns: room.coolDowns, log: room.log, close: (code, reason) => ws.close(code, reason) });
}

/** First-frame check for identities that sent no public-key digest at upgrade. */
export function refuseCoolingRoomSocket(room, ws, known, envelope) {
  const remainingMs = room.coolDowns.remaining(frameIdentity(known, envelope));
  if (remainingMs <= 0) return false;
  refuseCoolingFrame({ room: known.room, role: envelope.from, remainingMs, log: room.log,
    close: (code, reason) => ws.close(code, reason) });
  return true;
}

export function registerRoomSocketIdentity(room, ws, known, envelope) {
  socketState(room, ws).identity = frameIdentity(known, envelope);
}

/** Expired reliable frames are neither stored nor forwarded; the sender's socket stays open. */
export function dropRoomMessage(room, ws, known, envelope, reason) {
  room.log("relay.message_dropped", { room: known.room, role: known.role ?? envelope.from, reason });
  if (!known.relayControl || !envelope.deliveryId) return;
  try { ws.send(droppedNotice(envelope.deliveryId, reason)); } catch { /* stale hibernating socket */ }
}
