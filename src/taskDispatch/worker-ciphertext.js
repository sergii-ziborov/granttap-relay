import { sha256 } from '../relay/relaySupport.js';
import { retainsTaskPayload } from './policy.js';

const CHUNK_BYTES = 64_000;
const boxKey = (row, index) => `task-box:${row.room}:${row.id}:${String(index).padStart(4, '0')}`;

/** Keep each value below both SQLite and legacy Durable Object value limits. */
export async function writeTaskJob(storage, key, input) {
  const row = { ...input, envelope: { ...input.envelope } };
  if (!retainsTaskPayload(row)) {
    await deleteCiphertext(storage, row);
    delete row.cipher;
  } else if (!row.cipher && typeof row.envelope.box === 'string') {
    const box = row.envelope.box;
    row.cipher = { count: Math.ceil(box.length / CHUNK_BYTES), digest: await sha256(box), bytes: box.length };
    for (let index = 0; index < row.cipher.count; index++) {
      await storage.put(boxKey(row, index), box.slice(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES));
    }
  }
  delete row.envelope.box;
  await storage.put(key, row);
  return row;
}

export async function hydrateTaskJob(storage, input) {
  if (!input?.cipher) return input;
  const { count, digest, bytes } = input.cipher;
  if (!Number.isInteger(count) || count < 1 || count > 350 || !Number.isInteger(bytes)
    || bytes < 24 || bytes > 22_000_000) throw new Error('Invalid encrypted task storage');
  const chunks = [];
  for (let index = 0; index < count; index++) {
    const value = await storage.get(boxKey(input, index));
    if (typeof value !== 'string' || value.length > CHUNK_BYTES) throw new Error('Incomplete encrypted task storage');
    chunks.push(value);
  }
  const box = chunks.join('');
  if (box.length !== bytes || await sha256(box) !== digest) throw new Error('Corrupt encrypted task storage');
  return { ...input, envelope: { ...input.envelope, box } };
}

export async function deleteCiphertext(storage, row) {
  if (!row.cipher) return;
  for (let index = 0; index < row.cipher.count; index++) await storage.delete(boxKey(row, index));
}
