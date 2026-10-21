import { replayNodeFrames } from "../retainedState/socketReplay.js";
import { publishNodePresence } from "../roomPresence/index.js";
import { WebSocket } from "ws";
import { acceptSocketFrame, admissionCloseToken, droppedNotice, queueOutcome } from "../relay/connectionPolicy.js";
import { socketIdentity } from "../relay/coolDown.js";
import { matchesQueuedRecipient, matchesRecipient } from "../relay/recipientRouting.js";
import { envelopeProblem, validIdentifier } from "../relay/relayValidation.js";
import { renewManagedConnection } from "./managed-connection.js";
import { admittedSocket, closeForPolicy, refuseCoolingSocket } from "./socket-policy.js";
import { isDurableSubmission, storedSubmissionNotice } from "../relay/submissionReceipts.js";

export const MAX_WEBSOCKET_MESSAGE_BYTES = 32 * 1024 * 1024;

/** Routes one text frame from an authenticated Node relay socket. */
export function handleSocketMessage(ws, raw, { store, sockets, admission, wake, delivery }) {
  const started = performance.now();
  const state = ws.relayState;
  if (Buffer.byteLength(raw) > MAX_WEBSOCKET_MESSAGE_BYTES) return closeForPolicy(ws, "oversize");
  if (!acceptSocketFrame(state)) return closeForPolicy(ws, "rate-limit");
  let envelope;
  try { envelope = JSON.parse(raw); } catch { return; }
  if (renewManagedConnection(ws, envelope, admission)) return;
  if (envelope?.type === "relay.ack" && validIdentifier(envelope.deliveryId, 180)) {
    if (state.role) store.acknowledge(state.room, state.role, envelope.deliveryId);
    return;
  }
  const problem = envelopeProblem(envelope, state.room, Date.now());
  if (problem === "expired") return dropMessage(ws, envelope, "expired");
  if (problem) return;
  if (!state.role && refuseCoolingSocket(ws, envelope)) return;
  if (state.commercial && state.ticket && envelope.from !== (state.ticket.role ?? "machine")) {
    return closeForPolicy(ws, "admission-required", envelope);
  }
  if (state.commercial && envelope.from === "machine" && !admittedSocket(state)) {
    return closeForPolicy(ws, admissionCloseToken(envelope), envelope);
  }
  store.metrics?.record('received');
  if (!state.role) {
    registerRole(ws, envelope, store, delivery);
    store.presence?.note(state.room, state.role, state.recipientKeyId);
    publishNodePresence(state.room, store, sockets, delivery);
  }
  else if (state.role !== envelope.from) return;
  if (!state.presenceAt || Date.now() - state.presenceAt >= 30000) {
    store.presence?.note(state.room, state.role, state.recipientKeyId);
    state.presenceAt = Date.now();
  }
  if (envelope.stateKey) {
    try { store.retainedState.put(state.room, envelope, raw); }
    catch { return dropMessage(ws, envelope, "storage-unavailable"); }
  }
  if (envelope.to !== "all" && envelope.deliveryId) {
    let stored;
    try { stored = store.enqueue(state.room, envelope.to, raw, envelope.deliveryId, envelope.expiresAt); }
    catch { return dropMessage(ws, envelope, 'storage-unavailable'); }
    const outcome = queueOutcome(stored);
    if (outcome.close) return closeForPolicy(ws, outcome.close);
    if (outcome.drop) return dropMessage(ws, envelope, outcome.drop);
    if (state.relayControl && envelope.from === 'phone' && envelope.to === 'machine'
        && isDurableSubmission(envelope.deliveryId) && ws.readyState === WebSocket.OPEN) {
      const receipt = storedSubmissionNotice(envelope.deliveryId);
      if (delivery) delivery.send(ws, receipt); else ws.send(receipt);
    }
  }
  for (const target of sockets.get(state.room) ?? []) {
    if (target === ws || target.readyState !== WebSocket.OPEN) continue;
    if (envelope.to === "all" || target.relayState?.role === envelope.to) {
      if (matchesRecipient(envelope, target.relayState?.recipientKeyId)) {
        const sent = delivery ? delivery.send(target, raw) : (target.send(raw), true);
        if (sent) { store.metrics?.record('forwarded'); store.metrics?.timing('forward', performance.now() - started); }
      }
    }
  }
  if (envelope.to === "phone" && envelope.wake === true) wake?.(state.room);
}

function registerRole(ws, envelope, store, delivery) {
  const state = ws.relayState;
  state.role = envelope.from;
  state.identity ??= socketIdentity({ room: state.room, recipientKeyId: state.recipientKeyId,
    role: state.role, senderId: envelope.senderId });
  const saved = state.role === "phone" ? store.retainedState.list(state.room, state.recipientKeyId) : [];
  const rows = [...saved, ...store.queue(state.room, state.role)]
    .filter(item => matchesQueuedRecipient(item.raw, state.recipientKeyId));
  void replayNodeFrames(ws, rows, delivery, store.metrics);

}

/** Expired or room-less reliable frames are neither stored nor forwarded; the socket stays open. */
function dropMessage(ws, envelope, reason) {
  const state = ws.relayState;
  state.policy?.log?.("relay.message_dropped", { room: state.room, role: state.role ?? envelope.from, reason });
  if (state.relayControl && envelope.deliveryId && ws.readyState === WebSocket.OPEN) {
    ws.send(droppedNotice(envelope.deliveryId, reason));
  }
}
