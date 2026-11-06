export const INGRESS_WINDOW = 64;
const RECEIPT_EVERY = 16;

export function ingressCapabilities(enabled) { return enabled ? { ingressWindow: INGRESS_WINDOW } : {}; }

/** A cumulative transport read receipt, never a durable delivery acknowledgement. */
export function noteIngressFrame(state, send, save) {
  if (!state.ingressFlow) return;
  state.ingressReceived = (state.ingressReceived ?? 0) + 1;
  save?.();
  if (state.ingressReceived % RECEIPT_EVERY !== 0) return;
  try { send(JSON.stringify({ type: 'relay.ingress', received: state.ingressReceived })); }
  catch { /* A closed socket cannot prevent routing a frame already read. */ }
}
