import { closeForPolicy } from "./socket-policy.js";

/** Admission can be renewed only for the computer identity authenticated at upgrade. */
export function armManagedExpiry(ws, ticket) {
  clearTimeout(ws.relayState.admissionTimer);
  ws.relayState.ticket = ticket;
  ws.relayState.admissionTimer = setTimeout(() => closeForPolicy(ws, "admission-expired"),
    ticket.expiresAt - Date.now());
  ws.relayState.admissionTimer.unref();
}

export function renewManagedConnection(ws, value, verify) {
  if (value?.type !== "relay.admission") return false;
  const state = ws.relayState;
  if (!state.commercial) return true;
  const next = verify?.(value.ticket, state.room);
  const current = state.ticket;
  if (!next || !current || next.version !== current.version || next.role !== current.role
    || state.role && state.role !== (current.role ?? "machine")
    || next.accountId !== current.accountId || next.computerId !== current.computerId
    || next.publicKey !== current.publicKey || next.expiresAt <= current.expiresAt) {
    closeForPolicy(ws, "admission-renewal-rejected");
    return true;
  }
  armManagedExpiry(ws, next);
  ws.send(JSON.stringify({ type: "relay.admission.accepted", expiresAt: next.expiresAt }));
  return true;
}
