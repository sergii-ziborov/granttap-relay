const RETENTION_MS = 7 * 86400000;
export function updatePresence(rows, role, id, now = Date.now()) {
  const live = rows.filter(row => row.lastSeenAt > now - RETENTION_MS);
  if (!['phone', 'machine'].includes(role) || !/^[a-f0-9]{64}$/.test(id ?? '')) return live;
  return [...live.filter(row => row.id !== id || row.role !== role), { id, role, lastSeenAt: now }].slice(-32);
}
export function presenceMessage(room, rows, states, now = Date.now()) {
  const online = new Set(states.filter(state => state.room === room).map(state => `${state.role}:${state.recipientKeyId}`));
  return JSON.stringify({ type: 'relay.presence', room, generatedAt: now,
    devices: rows.map(row => ({ ...row, online: online.has(`${row.role}:${row.id}`),
      lastSeenAt: online.has(`${row.role}:${row.id}`) ? now : row.lastSeenAt })) });
}

export class NodeRoomPresence {
  constructor(db) {
    this.db = db;
    db.exec('CREATE TABLE IF NOT EXISTS room_presence (room TEXT PRIMARY KEY, record TEXT NOT NULL)');
  }
  rows(room) {
    return JSON.parse(this.db.prepare('SELECT record FROM room_presence WHERE room=?').get(room)?.record ?? '[]');
  }
  note(room, role, id, now = Date.now()) {
    const rows = updatePresence(this.rows(room), role, id, now);
    this.db.prepare('INSERT OR REPLACE INTO room_presence(room,record) VALUES(?,?)').run(room, JSON.stringify(rows));
  }
}

export function publishNodePresence(room, store, sockets, delivery) {
  if (!store.presence || store.db?.isOpen === false) return;
  const peers = [...(sockets.get(room) ?? [])].filter(ws => ws.readyState === 1);
  const message = presenceMessage(room, store.presence.rows(room), peers.map(ws => ws.relayState));
  for (const peer of peers) if (peer.relayState?.presenceEnabled && peer.relayState.role === 'phone') {
    if (delivery) delivery.send(peer, message); else peer.send(message);
  }
}

export function closeNodeSocket(ws, sockets, store, delivery) {
  const state = ws.relayState;
  const peers = sockets.get(state?.room);
  if (!peers?.delete(ws)) return;
  if (!peers.size) sockets.delete(state.room);
  if (!store.presence || store.db?.isOpen === false) return;
  store.presence.note(state.room, state.role, state.recipientKeyId);
  publishNodePresence(state.room, store, sockets, delivery);
}
