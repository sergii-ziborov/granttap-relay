/** Replaceable ciphertext is independent of the delivery mailbox and its ACKs. */
export const STATE_TTL_MS = 7 * 86400000;
export const STATE_ROOM_BYTES = 16 * 1024 * 1024;
export const STATE_ROOM_SLOTS = 512;
export const STATE_FRAME_BYTES = 1800000;

export function validRetainedState(envelope, now) {
  if (envelope.stateKey == null && envelope.stateRevision == null && envelope.statePriority == null) return true;
  return envelope.from === 'machine' && envelope.to === 'phone'
    && /^[a-f0-9]{64}$/.test(envelope.recipientKeyId ?? '')
    && /^[a-f0-9]{64}$/.test(envelope.stateKey ?? '')
    && Number.isSafeInteger(envelope.stateRevision) && envelope.stateRevision >= 0
    && envelope.stateRevision <= now + 300000
    && [0, 1, 2, 3].includes(envelope.statePriority)
    && Number.isSafeInteger(envelope.expiresAt) && envelope.expiresAt <= now + STATE_TTL_MS;
}

export function retainState(rows, envelope, raw, now = Date.now(), activity = []) {
  const live = rows.filter(row => row.expiresAt > now);
  if (!envelope.stateKey || !validRetainedState(envelope, now) || envelope.expiresAt <= now) return live;
  const bytes = new TextEncoder().encode(raw).length;
  if (bytes > STATE_FRAME_BYTES) return live;
  const existing = live.find(row => row.recipient === envelope.recipientKeyId && row.key === envelope.stateKey);
  if (existing && existing.revision >= envelope.stateRevision) return live;
  const result = live.filter(row => row !== existing);
  result.push({ recipient: envelope.recipientKeyId, key: envelope.stateKey, revision: envelope.stateRevision,
    priority: envelope.statePriority, expiresAt: envelope.expiresAt, savedAt: now, bytes, raw });
  let total = result.reduce((sum, row) => sum + row.bytes, 0);
  const seen = new Map(activity.filter(row => row.role === 'phone' && row.lastSeenAt > now - STATE_TTL_MS)
    .map(row => [row.id, row.lastSeenAt]));
  result.sort((a, b) => {
    const essential = Number(a.priority <= 1) - Number(b.priority <= 1);
    if (essential) return essential;
    const recency = a.priority > 1 ? (seen.get(a.recipient) ?? 0) - (seen.get(b.recipient) ?? 0) : 0;
    return recency || b.priority - a.priority || a.savedAt - b.savedAt;
  });
  while (result.length > STATE_ROOM_SLOTS || total > STATE_ROOM_BYTES) total -= result.shift().bytes;
  return result;
}

export function replayState(rows, recipient, now = Date.now()) {
  if (!/^[a-f0-9]{64}$/.test(recipient ?? '')) return [];
  return rows.filter(row => row.recipient === recipient && row.expiresAt > now)
    .sort((a, b) => a.priority - b.priority || a.revision - b.revision);
}
