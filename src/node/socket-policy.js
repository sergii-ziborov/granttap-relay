import { applyPolicyClose, refuseCoolingFrame } from "../relay/connectionPolicy.js";
import { socketIdentity } from "../relay/coolDown.js";

/** A socket proves managed admission only while its signed lease is unexpired. */
export function admittedSocket(state, now = Date.now()) {
  return Boolean(state.ticket && state.ticket.expiresAt > now);
}

/** Identity of a live socket; before its first frame the frame's own role and sender are used. */
export function identityOf(state, envelope) {
  return state.identity ?? socketIdentity({ room: state.room, recipientKeyId: state.recipientKeyId,
    role: state.role ?? envelope?.from, senderId: envelope?.senderId });
}

export function closeForPolicy(ws, token, envelope) {
  const state = ws.relayState;
  if(ws.readyState===1)state.capacityPolicyClose=true;
  return applyPolicyClose({ token, room: state.room, role: state.role ?? envelope?.from,
    identity: identityOf(state, envelope), coolDowns: state.policy?.coolDowns, log: state.policy?.log,
    close: (code, reason) => ws.close(code, reason) });
}

/**
 * Sockets without a public-key digest cannot be identified at upgrade, so their
 * cool-down is enforced on the first frame instead. Returns true when refused.
 */
export function refuseCoolingSocket(ws, envelope, now = Date.now()) {
  const state = ws.relayState;
  const remainingMs = state.policy?.coolDowns?.remaining(identityOf(state, envelope),
    { admitted: admittedSocket(state, now) }) ?? 0;
  if (remainingMs <= 0) return false;
  refuseCoolingFrame({ room: state.room, role: envelope.from, remainingMs, log: state.policy.log,
    close: (code, reason) => ws.close(code, reason) });
  return true;
}
