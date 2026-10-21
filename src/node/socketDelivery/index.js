import { WebSocket } from 'ws';

/** Bound ciphertext waiting for slow receivers; reliable rows remain in SQLite. */
export function createSocketDelivery({ log, maxBufferedBytes = 4 * 1024 ** 2,
  maxPendingBytes = 64 * 1024 ** 2 } = {}) {
  let pendingBytes = 0;
  const flights = new WeakMap();
  return {
    get pendingBytes() { return pendingBytes; },
    sendAndWait(socket, raw) { return new Promise(resolve => this.send(socket, raw, resolve)); },
    send(socket, raw, completed) {
      if (socket.readyState !== WebSocket.OPEN) { completed?.(false); return false; }
      const bytes = Buffer.byteLength(raw);
      // One legal large frame can pass an empty socket, but no second one can pile behind it.
      const buffered = socket.bufferedAmount ?? 0;
      if (buffered > 0 && buffered + bytes > Math.max(maxBufferedBytes, bytes)
        || pendingBytes + bytes > maxPendingBytes) {
        const state = socket.relayState;
        log?.('relay.slow_receiver', { room: state?.room, role: state?.role, reason: 'backpressure' });
        socket.close(1013, 'backpressure; retry-after=5');
        completed?.(false);
        return false;
      }
      pendingBytes += bytes;
      let releases = flights.get(socket);
      if (!releases) {
        releases = new Set(); flights.set(socket, releases);
        socket.once('close', () => { for (const release of releases) release(); });
      }
      let pending = true;
      const release = error => {
        if (!pending) return;
        pending = false;
        pendingBytes -= bytes;
        releases.delete(release);
        completed?.(!error && socket.readyState === WebSocket.OPEN);
      };
      releases.add(release);
      try {
        socket.send(raw, release);
        return true;
      } catch (error) {
        release(error);
        socket.terminate();
        return false;
      }
    },
  };
}
