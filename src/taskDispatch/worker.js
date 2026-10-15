import { writeTaskJob, hydrateTaskJob, deleteCiphertext } from './worker-ciphertext.js';
import { listTaskJobRecords } from './worker-records.js';
import { workerTaskWriters } from './writers/worker.js';
import { workerTaskConfigurations } from './configurations/worker.js';
import { sha256 } from '../relay/relaySupport.js';
import { cancelJob, claimJob, expireJob, finishJob, normalizeJob, publicJob,
  ROOM_JOB_BYTES, ROOM_JOB_LIMIT, ROOM_RECEIPT_LIMIT, retainsTaskPayload } from './policy.js';

const prefix = room => `task-job:${room}:`;
const key = (room, id) => `${prefix(room)}${id}`;

/** Durable Object transactions serialize claims against cancellation and retries. */
export class WorkerTaskDispatchStore {
  constructor(storage) {
    this.storage = storage;
    this.writers = workerTaskWriters(storage);
    this.configurations = workerTaskConfigurations(storage);
  }

  async rows(room, now = Date.now(), storage = this.storage) {
    const rows = [...(await listTaskJobRecords(storage, prefix(room))).values()];
    return Promise.all(rows.map(async saved => {
      const row = expireJob(saved, now);
      if (row !== saved) await writeTaskJob(storage, key(room, row.id), row);
      return row;
    }));
  }

  async list(room, now = Date.now()) { return (await this.rows(room, now)).map(publicJob); }

  async listActive(room, now = Date.now()) { return (await this.list(room, now)).filter(retainsTaskPayload); }

  async getPublic(room, id, now = Date.now(), metadataOnly = false) {
    const saved = await this.storage.get(key(room, id));
    if (!saved) return null;
    const row = expireJob(saved, now);
    if (row !== saved) await writeTaskJob(this.storage, key(room, id), row);
    return publicJob(metadataOnly ? row : await hydrateTaskJob(this.storage, row));
  }

  async due(room, recipientKeyId, now = Date.now(), excluded = []) {
    const skip = new Set(excluded);
    const rows = (await this.rows(room, now)).filter(row => row.state === 'queued' && row.notBefore <= now
      && row.envelope.recipientKeyId === recipientKeyId && !skip.has(row.id));
    const next = rows.sort((a, b) => a.notBefore - b.notBefore || a.createdAt - b.createdAt)[0];
    return next ? [publicJob(await hydrateTaskJob(this.storage, next))] : [];
  }

  async put(room, id, body, now = Date.now()) {
    return this.storage.transaction(async storage => {
      const existing = await storage.get(key(room, id));
      const parsed = normalizeJob(room, id, body, existing?.createdAt ?? now);
      if (!parsed) return { status: 400, error: 'invalid encrypted task job' };
      const { canonical, ...normalized } = parsed;
      normalized.fingerprint = await sha256(canonical);
      if (existing) return existing.fingerprint === normalized.fingerprint
        ? { status: 200, job: publicJob(expireJob(existing, now)) }
        : { status: 409, error: 'job identity already exists' };
      const rows = await this.rows(room, now, storage);
      const active = rows.filter(retainsTaskPayload);
      if (rows.length >= ROOM_RECEIPT_LIMIT || active.length >= ROOM_JOB_LIMIT
        || active.reduce((sum, row) => sum + row.bytes, 0)
        + normalized.bytes > ROOM_JOB_BYTES) return { status: 429, error: 'task queue capacity reached' };
      const row = { ...normalized, id, room, state: 'queued', createdAt: now, updatedAt: now };
      await writeTaskJob(storage, key(room, id), row);
      return { status: 201, job: publicJob(row) };
    });
  }

  async transition(room, id, action, body, now = Date.now()) {
    const proofHash = await sha256(typeof body?.token === 'string' ? body.token : '');
    return this.storage.transaction(async storage => {
      const row = await storage.get(key(room, id));
      if (!row) return { status: 404, error: 'unknown task job' };
      const result = action === 'claim' ? claimJob(row, body, now, proofHash)
        : action === 'finish' ? finishJob(row, body, now, proofHash) : cancelJob(row, now);
      if (!result.row) return result;
      await writeTaskJob(storage, key(room, id), result.row);
      return { status: result.status, job: publicJob(result.row) };
    });
  }

  async maintain(now = Date.now(), connectedRecipients) {
    const rows = await listTaskJobRecords(this.storage, 'task-job:');
    let next = await this.configurations.maintain(now);
    for (const [name, saved] of rows) {
      if (!name.startsWith('task-job:')) continue;
      const row = expireJob(saved, now);
      if (row.state !== 'accepted' && now > Math.max(row.expiresAt, row.updatedAt) + 7 * 86_400_000) {
        await deleteCiphertext(this.storage, row);
        await this.storage.delete(name);
        continue;
      }
      if (row !== saved) await writeTaskJob(this.storage, name, row);
      const deadline = row.state === 'queued'
        ? (connectedRecipients && !connectedRecipients.has(row.envelope.recipientKeyId)
          ? row.expiresAt : Math.min(row.expiresAt, row.notBefore > now ? row.notBefore : now + 15_000))
        : row.state === 'accepted' ? undefined : Math.max(row.expiresAt, row.updatedAt) + 7 * 86_400_000;
      if (deadline !== undefined) next = Math.min(next ?? Infinity, deadline);
    }
    return next;
  }
}
