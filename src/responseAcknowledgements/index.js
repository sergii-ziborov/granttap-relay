import { validIdentifier } from '../relay/relayValidation.js';

const MAX_OUTSTANDING = 512;
const LIFETIME_MS = 30_000;
const MAX_ACK_BYTES = 1536;

/** One bounded, single-use response allowance for each delivery this socket was sent. */
export function createResponseAcknowledgements({ now = Date.now } = {}) {
  const sockets = new WeakMap();
  return {
    issue(socket, deliveryId) {
      if (!validIdentifier(deliveryId, 180)) return;
      let pending = sockets.get(socket);
      if (!pending) { pending = new Map(); sockets.set(socket, pending); }
      pending.delete(deliveryId);
      pending.set(deliveryId, now() + LIFETIME_MS);
      if (pending.size > MAX_OUTSTANDING) pending.delete(pending.keys().next().value);
    },
    consume(socket, raw) {
      if (typeof raw !== 'string' || Buffer.byteLength(raw) > MAX_ACK_BYTES) return false;
      let frame;
      try { frame = JSON.parse(raw); } catch { return false; }
      if (frame?.type !== 'relay.ack' || !validIdentifier(frame.deliveryId, 180)
          || Object.keys(frame).length !== 2) return false;
      const pending = sockets.get(socket);
      const expiresAt = pending?.get(frame.deliveryId);
      if (expiresAt === undefined) return false;
      pending.delete(frame.deliveryId);
      return expiresAt > now();
    },
  };
}
