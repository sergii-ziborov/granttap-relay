import { createHash } from 'node:crypto';
import { initializeTaskJobSchema } from './node-schema.js';
import { nodeTaskWriters } from './writers/node.js';
import { nodeTaskConfigurations } from './configurations/node.js';
import { cancelJob, claimJob, expireJob, finishJob, normalizeJob, publicJob,
  ROOM_JOB_BYTES, ROOM_JOB_LIMIT, ROOM_RECEIPT_LIMIT } from './policy.js';

export class NodeTaskDispatchStore {
  constructor(db) {
    this.db = db;
    initializeTaskJobSchema(db);
    this.writers = nodeTaskWriters(db);
    this.configurations = nodeTaskConfigurations(db);
  }

  transact(work) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* original failure remains authoritative */ }
      throw error;
    }
  }

  rows(room, now = Date.now()) {
    return this.db.prepare('SELECT record FROM task_jobs WHERE room = ?').all(room)
      .map(item => {
        const saved = JSON.parse(item.record); const current = expireJob(saved, now);
        if (current !== saved) this.save(room, current);
        return current;
      });
  }

  list(room, now = Date.now()) {
    return this.transact(() => this.rows(room, now).map(publicJob));
  }

  getPublic(room, id, now = Date.now(), metadataOnly = false) {
    return this.transact(() => {
      this.expireQueued(room, now);
      const field = metadataOnly ? "json_remove(record, '$.envelope.box', '$.envelope.nonce')" : "record";
      const saved = this.db.prepare(`SELECT ${field} AS record FROM task_jobs WHERE room=? AND id=?`).get(room, id);
      return saved ? publicJob(JSON.parse(saved.record)) : null;
    });
  }

  listActive(room, now = Date.now()) {
    return this.transact(() => {
      this.expireQueued(room, now);
      return this.db.prepare(`SELECT json_remove(record, '$.envelope.box', '$.envelope.nonce') AS record
        FROM task_jobs WHERE room=? AND (state IN ('queued','accepted','failed') OR state IS NULL)`)
        .all(room).map(row => publicJob(JSON.parse(row.record)));
    });
  }

  due(room, recipientKeyId, now = Date.now(), excluded = []) {
    return this.transact(() => {
      this.expireQueued(room, now);
      const skip = excluded.length ? ` AND id NOT IN (${excluded.map(() => '?').join(',')})` : '';
      return this.db.prepare(`SELECT record FROM task_jobs WHERE room=? AND state='queued' AND recipient=?
        AND not_before<=? AND expires_at>?${skip} ORDER BY not_before,updated_at LIMIT 1`)
        .all(room, recipientKeyId, now, now, ...excluded).map(row => publicJob(JSON.parse(row.record)));
    });
  }

  expireQueued(room, now) {
    const rows = this.db.prepare("SELECT record FROM task_jobs WHERE room=? AND state='queued' AND expires_at<=?").all(room, now);
    for (const item of rows) this.save(room, expireJob(JSON.parse(item.record), now));
  }

  put(room, id, body, now = Date.now()) {
    return this.transact(() => this.putInTransaction(room, id, body, now));
  }

  putInTransaction(room, id, body, now) {
    const existing = this.get(room, id);
    const parsed = normalizeJob(room, id, body, existing?.createdAt ?? now);
    const { canonical, ...normalized } = parsed ?? {};
    if (canonical) normalized.fingerprint = digest(canonical);
    if (!parsed) return { status: 400, error: 'invalid encrypted task job' };
    if (existing) return existing.fingerprint === normalized.fingerprint
      ? { status: 200, job: publicJob(expireJob(existing, now)) }
      : { status: 409, error: 'job identity already exists' };
    this.expireQueued(room, now);
    const count = this.db.prepare('SELECT COUNT(*) AS count FROM task_jobs WHERE room=?').get(room).count;
    const active = this.db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(payload_bytes),0) AS bytes
      FROM task_jobs WHERE room=? AND (state IN ('queued','accepted','failed') OR state IS NULL)`).get(room);
    if (count >= ROOM_RECEIPT_LIMIT || active.count >= ROOM_JOB_LIMIT
      || active.bytes + normalized.bytes > ROOM_JOB_BYTES) return { status: 429, error: 'task queue capacity reached' };
    const row = { ...normalized, id, state: 'queued', createdAt: now, updatedAt: now };
    this.save(room, row);
    return { status: 201, job: publicJob(row) };
  }

  transition(room, id, action, body, now = Date.now()) {
    return this.transact(() => this.transitionInTransaction(room, id, action, body, now));
  }

  transitionInTransaction(room, id, action, body, now) {
    const row = this.get(room, id);
    if (!row) return { status: 404, error: 'unknown task job' };
    const result = action === 'claim' ? claimJob(row, body, now, digest(body?.token ?? ""))
      : action === 'finish' ? finishJob(row, body, now, digest(body?.token ?? "")) : cancelJob(row, now);
    if (!result.row) return result;
    this.save(room, result.row);
    return { status: result.status, job: publicJob(result.row) };
  }

  get(room, id) {
    const saved = this.db.prepare('SELECT record FROM task_jobs WHERE room = ? AND id = ?').get(room, id);
    return saved ? JSON.parse(saved.record) : null;
  }

  save(room, row) {
    this.db.prepare(`INSERT INTO task_jobs(room,id,record,state,recipient,not_before,expires_at,updated_at,payload_bytes)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(room,id) DO UPDATE SET record=excluded.record,
      state=excluded.state,recipient=excluded.recipient,not_before=excluded.not_before,expires_at=excluded.expires_at,
      updated_at=excluded.updated_at,payload_bytes=excluded.payload_bytes`)
      .run(room,row.id,JSON.stringify(row),row.state,row.envelope.recipientKeyId,row.notBefore,row.expiresAt,row.updatedAt,row.bytes);
  }

  purge(now = Date.now()) { this.transact(() => this.purgeInTransaction(now)); }

  purgeInTransaction(now) {
    this.configurations.maintain(now);
    const retention = 7 * 86_400_000;
    const rows = this.db.prepare(`SELECT room,id,record FROM task_jobs WHERE (state='queued' AND expires_at<=?)
      OR (state!='accepted' AND expires_at<? AND updated_at<?) OR state IS NULL`).all(now,now-retention,now-retention);
    for (const item of rows) {
      const saved = JSON.parse(item.record);
      const row = expireJob(saved, now);
      if (row !== saved) this.save(item.room, row);
      if (row.state !== 'accepted' && now > Math.max(row.expiresAt, row.updatedAt) + retention) {
        this.db.prepare('DELETE FROM task_jobs WHERE room = ? AND id = ?').run(item.room, item.id);
      }
    }
  }
}

function digest(value) { return createHash("sha256").update(String(value)).digest("hex"); }
