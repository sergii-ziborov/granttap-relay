import { WebSocket } from 'ws';

/** Bound ciphertext waiting for slow receivers; reliable rows remain in SQLite. */
export function createSocketDelivery({ log, maxBufferedBytes = 4 * 1024 ** 2,
  maxPendingBytes = 64 * 1024 ** 2 } = {}) {
  let pendingBytes = 0;
  const flights = new WeakMap();
  return {
    get pendingBytes() { return pendingBytes; },
    send(socket, raw) {
      if (socket.readyState !== WebSocket.OPEN) return false;
      const bytes = Buffer.byteLength(raw);
      // One legal large frame can pass an empty socket, but no second one can pile behind it.
      const buffered = socket.bufferedAmount ?? 0;
      if (buffered > 0 && buffered + bytes > Math.max(maxBufferedBytes, bytes)
        || pendingBytes + bytes > maxPendingBytes) {
        const state = socket.relayState;
        log?.('relay.slow_receiver', { room: state?.room, role: state?.role, reason: 'backpressure' });
        socket.close(1013, 'backpressure; retry-after=5');
        return false;
      }
      pendingBytes += bytes;
      let releases = flights.get(socket);
      if (!releases) {
        releases = new Set(); flights.set(socket, releases);
        socket.once('close', () => { for (const release of releases) release(); });
      }
      let pending = true;
      const release = () => { if (pending) { pending = false; pendingBytes -= bytes; releases.delete(release); } };
      releases.add(release);
      try {
        socket.send(raw, release);
        return true;
      } catch {
        release();
        socket.terminate();
        return false;
      }
    },
  };
}
