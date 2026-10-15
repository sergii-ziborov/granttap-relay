import { validEnvelope } from '../../relay/relayValidation.js';

export const CONFIGURATION_BYTES = 96_000;
const ttl = 30 * 86_400_000;
const validId = id => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id);
const visible = row => ({ id: row.id, issuerKeyId: row.issuerKeyId, expiresAt: row.expiresAt,
  envelope: row.envelope, updatedAt: row.updatedAt });

export class TaskConfigurations {
  constructor(adapter) { this.adapter = adapter; }
  maintain(now = Date.now()) { return this.adapter.maintain(now); }

  async put(room, id, body, now = Date.now()) {
    if (!validId(id) || !body || Object.keys(body).some(key => !['issuerKeyId', 'expiresAt', 'envelope'].includes(key))
      || !validId(body.issuerKeyId) || !Number.isSafeInteger(body.expiresAt) || body.expiresAt <= now
      || body.expiresAt > now + ttl || body.envelope?.expiresAt !== body.expiresAt
      || body.envelope?.deliveryId !== id || body.envelope.to !== 'machine'
      || !validId(body.envelope.recipientKeyId) || !validEnvelope(body.envelope, room, now, ttl)) {
      return { status: 400, error: 'invalid encrypted Project configuration' };
    }
    const bytes = new TextEncoder().encode(JSON.stringify(body)).length;
    if (bytes > CONFIGURATION_BYTES) return { status: 400, error: 'configuration exceeds its bound' };
    const row = { id, ...body, bytes, updatedAt: now };
    const result = await this.adapter.commit(room, row, now);
    return result.status < 300 ? { ...result, configuration: visible(row) } : result;
  }

  async get(room, id, now = Date.now()) {
    if (!validId(id)) return undefined;
    const row = await this.adapter.current(room, id, now);
    return row ? visible(row) : undefined;
  }
}

export function configurationCapacity(rows, next, now) {
  const active = rows.filter(row => row.expiresAt > now);
  const previous = active.find(row => row.id === next.id);
  return !previous && active.length >= 128
    || active.reduce((sum, row) => sum + row.bytes, 0) - (previous?.bytes ?? 0) + next.bytes > 8_000_000
    ? { status: 429, error: 'configuration capacity reached' } : { status: previous ? 200 : 201 };
}
