/**
 * Server-side WebSocket liveness. Every interval each socket that has not
 * answered the previous ping (and sent no frame since) is terminated, so a dead
 * or half-open peer releases its room slot within two intervals. A pong, a
 * client ping or any inbound frame counts as liveness. The default 30 s interval
 * keeps detection below one minute and keeps healthy idle sockets well inside
 * nginx `proxy_read_timeout 300s`, because each ping is upstream traffic for nginx.
 */
export const HEARTBEAT_INTERVAL_MS = 30_000;
const MIN_INTERVAL_MS = 1_000;
const MAX_INTERVAL_MS = 120_000;

/**
 * `RELAY_HEARTBEAT_MS`: unset uses 30 s, `0` disables pings (operator kill
 * switch), and other values are bounded to 1–120 s so two missed intervals stay
 * below nginx `proxy_read_timeout 300s`. Invalid values fall back to 30 s.
 */
export function heartbeatIntervalFrom(value) {
  if (value === undefined || value === "") return HEARTBEAT_INTERVAL_MS;
  const parsed = Number(value);
  if (parsed === 0) return 0;
  return Number.isSafeInteger(parsed) && parsed >= MIN_INTERVAL_MS && parsed <= MAX_INTERVAL_MS
    ? parsed : HEARTBEAT_INTERVAL_MS;
}

export function markAlive(ws) {
  if (ws.relayState) ws.relayState.awaitingPong = false;
}

export function heartbeatSweep(sockets, log) {
  for (const peers of sockets.values()) {
    for (const ws of peers) {
      const state = ws.relayState;
      if (state.awaitingPong) {
        log?.("relay.socket_terminated", { room: state.room, role: state.role, reason: "heartbeat-timeout" });
        ws.terminate();
        continue;
      }
      state.awaitingPong = true;
      try { ws.ping(); } catch { ws.terminate(); }
    }
  }
}

export function startHeartbeat(sockets, { intervalMs = HEARTBEAT_INTERVAL_MS, log } = {}) {
  if (!intervalMs) return () => {};
  const timer = setInterval(() => heartbeatSweep(sockets, log), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
