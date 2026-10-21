/** Replaceable ciphertext is independent of the delivery mailbox and its ACKs. */
export const STATE_TTL_MS = 7 * 86400000;
export const STATE_ROOM_BYTES = 16 * 1024 * 1024;
export const STATE_ROOM_SLOTS = 512;
export const STATE_FRAME_BYTES = 1800000;

export function validRetainedState(envelope, now) {
  if (envelope.stateKey == null && envelope.stateRevision == null && envelope.statePriority == null
      && envelope.stateGroup == null) return true;
  return envelope.from === 'machine' && envelope.to === 'phone'
    && /^[a-f0-9]{64}$/.test(envelope.recipientKeyId ?? '')
    && /^[a-f0-9]{64}$/.test(envelope.stateKey ?? '')
    && (envelope.stateGroup == null || /^[a-f0-9]{64}$/.test(envelope.stateGroup))
    && Number.isSafeInteger(envelope.stateRevision) && envelope.stateRevision >= 0
    && envelope.stateRevision <= now + 300000
    && [0, 1, 2, 3].includes(envelope.statePriority)
    && Number.isSafeInteger(envelope.expiresAt) && envelope.expiresAt <= now + STATE_TTL_MS;
}

export function retainState(rows, envelope, raw, now = Date.now(), activity = []) {
  const live = rows.filter(row => row.expiresAt > now);
  if (!envelope.stateKey || !validRetainedState(envelope, now) || envelope.expiresAt <= now) return live;
  // Legacy unlinked keys/heads remain live-compatible but cannot crowd the read cache.
  if (envelope.statePriority !== 1 && !envelope.stateGroup) return live;
  const bytes = new TextEncoder().encode(raw).length;
  if (bytes > STATE_FRAME_BYTES) return live;
  const existing = live.find(row => row.recipient === envelope.recipientKeyId && row.key === envelope.stateKey);
  if (existing && existing.revision >= envelope.stateRevision) return live;
  let result = live.filter(row => row !== existing);
  result.push({ recipient: envelope.recipientKeyId, key: envelope.stateKey, revision: envelope.stateRevision,
    priority: envelope.statePriority, groupId: envelope.stateGroup, expiresAt: envelope.expiresAt, savedAt: now, bytes, raw });
  let total = result.reduce((sum, row) => sum + row.bytes, 0);
  for (const group of evictionGroups(result, activity, now)) {
    if (result.length <= STATE_ROOM_SLOTS && total <= STATE_ROOM_BYTES) break;
    const removed = new Set(group.rows);
    result = result.filter(row => !removed.has(row));
    total -= group.rows.reduce((sum, row) => sum + row.bytes, 0);
  }
  return result;
}

function evictionGroups(rows, activity, now) {
  const seen = new Map(activity.filter(row => row.role === 'phone' && row.lastSeenAt > now - STATE_TTL_MS)
    .map(row => [row.id, row.lastSeenAt]));
  const groups = new Map();
  for (const row of rows) {
    const id = `${row.recipient}:${row.groupId ?? row.key}`;
    const group = groups.get(id) ?? { rows: [], priority: 2, savedAt: row.savedAt, seen: seen.get(row.recipient) ?? 0 };
    group.rows.push(row);
    const bodies = group.rows.filter(item => item.priority !== 0);
    group.priority = bodies.length ? Math.max(...bodies.map(item => item.priority)) : row.groupId ? 2 : 4;
    group.savedAt = Math.max(...(bodies.length ? bodies : group.rows).map(item => item.savedAt));
    groups.set(id, group);
  }
  return [...groups.values()].sort((a, b) => {
    const essential = Number(a.priority === 1) - Number(b.priority === 1);
    return essential || a.seen - b.seen || b.priority - a.priority || a.savedAt - b.savedAt;
  });
}

export function replayState(rows, recipient, now = Date.now()) {
  if (!/^[a-f0-9]{64}$/.test(recipient ?? '')) return [];
  return rows.filter(row => row.recipient === recipient && row.expiresAt > now)
    .sort((a, b) => a.priority - b.priority || a.revision - b.revision);
}
