import { updatePresence, presenceMessage } from './index.js';

export async function noteWorkerPresence(room, ws, closed = false) {
  const state = ws?.deserializeAttachment();
  if (!state?.room) return;
  const rows = updatePresence(await room.state.storage.get('presence') ?? [], state.role, state.recipientKeyId);
  await room.state.storage.put('presence', rows);
  const peers = room.state.getWebSockets().filter(peer => peer !== ws || !closed);
  const message = presenceMessage(state.room, rows, peers.map(peer => peer.deserializeAttachment()).filter(Boolean));
  for (const peer of peers) {
    const target = peer.deserializeAttachment();
    if (target?.presenceEnabled && target.role === 'phone') {
      try { peer.send(message); } catch { /* edge will close a stale socket */ }
    }
  }
}
