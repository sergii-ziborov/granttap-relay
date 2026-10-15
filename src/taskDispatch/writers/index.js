import { constantTimeEqual, sha256 } from '../../relay/relaySupport.js';
import { validJobId } from '../policy.js';
import { validEnvelope } from '../../relay/relayValidation.js';

const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const lifetime = 30 * 86_400_000;
export const writerRetainedUntil = row => Math.min(row.expiresAt, row.revokedAt ?? Infinity) + 7 * 86_400_000;
export function publicWriter(row) {
  if (!row) return row;
  const { tokenHash, ...visible } = row;
  return visible;
}

/** A writer can address its granted recipient and its own jobs, never the room's control API. */
export class TaskWriterGrants {
  constructor(adapter) { this.adapter = adapter; }

  async put(room, id, body, now = Date.now()) {
    if (!validJobId(id) || !body || Object.keys(body).some(key =>
      !['sourceKeyId', 'recipientKeyId', 'scopeHash', 'tokenHash', 'expiresAt'].includes(key))
      || !['sourceKeyId', 'recipientKeyId', 'scopeHash', 'tokenHash'].every(key => digest(body[key]))
      || !Number.isSafeInteger(body.expiresAt) || body.expiresAt <= now
      || body.expiresAt > now + lifetime) return { status: 400, error: 'invalid writer grant' };
    const row = { id, sourceKeyId: body.sourceKeyId, recipientKeyId: body.recipientKeyId,
      scopeHash: body.scopeHash, tokenHash: body.tokenHash, expiresAt: body.expiresAt };
    return this.adapter.commit(room, row, now);
  }

  async revoke(room, id, now = Date.now()) {
    await this.adapter.revoke(room, id, now);
    return { status: 200, revoked: true };
  }

  async authorize(room, credential, now = Date.now(), retainedRead = false) {
    const match = /^writer:([A-Za-z0-9][A-Za-z0-9_-]{7,119}):([a-f0-9]{64})$/.exec(credential ?? '');
    if (!match) return undefined;
    const row = await this.adapter.get(room, match[1]);
    if (!row || (retainedRead ? writerRetainedUntil(row) <= now : row.revokedAt != null || row.expiresAt <= now)
      || !constantTimeEqual(await sha256(match[2]), row.tokenHash)) return undefined;
    return row;
  }

  async resources(room, id, body, now = Date.now()) {
    const grant = await this.adapter.get(room, id);
    if (!grant || grant.revokedAt != null || grant.expiresAt <= now) return { status: 404, error: 'unknown writer' };
    if (body !== undefined) {
      const envelope = body?.envelope;
      if (!body || Object.keys(body).length !== 1 || !envelope
        || envelope.from !== 'machine' || envelope.to !== 'machine'
        || envelope.recipientKeyId !== grant.sourceKeyId
        || !Number.isSafeInteger(envelope.expiresAt) || envelope.expiresAt > now + 90_000
        || !validEnvelope(envelope, room, now, 90_000)
        || new TextEncoder().encode(JSON.stringify(body)).length > 32_000) return { status: 400, error: 'invalid encrypted resource report' };
      await this.adapter.putResources(room, id, { envelope, updatedAt: now });
      return { status: 200, ok: true };
    }
    const report = await this.adapter.getResources(room, id);
    return report?.envelope.expiresAt > now ? { status: 200, ...report } : { status: 404, error: 'no fresh resource report' };
  }
}

export async function commitWriterGrant(adapter, room, row, now) {
  const previous = await adapter.get(room, row.id);
  if (previous) return existingWriter(previous, row);
  const rows = await adapter.list(room);
  for (const item of rows) if (writerRetainedUntil(item) <= now) {
    await adapter.delete(room, item.id); await adapter.deleteResources(room, item.id);
  }
  if (rows.filter(item => writerRetainedUntil(item) > now).length >= 128) return { status: 429, error: 'writer grant capacity reached' };
  await adapter.put(room, row);
  return { status: 201, writer: publicWriter(row) };
}

export function existingWriter(previous, row) {
  return JSON.stringify(row) === JSON.stringify(previous)
    ? { status: 200, writer: publicWriter(previous) } : { status: 409, error: 'writer identity already exists' };
}
