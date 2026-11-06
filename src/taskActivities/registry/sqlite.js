import { ACTIVITY_LIMIT, validActivityRegistration } from '../policy.js';

export class SqliteTaskActivities {
  constructor(database) {
    this.database = database;
    database.exec(`CREATE TABLE IF NOT EXISTS task_activities (
      room TEXT NOT NULL, activity_id TEXT NOT NULL, record_json TEXT NOT NULL,
      expires_at INTEGER NOT NULL, last_delivery_id TEXT, last_delivered_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(room, activity_id));
      CREATE INDEX IF NOT EXISTS task_activities_expiry ON task_activities(expires_at);`);
  }

  register(room, record, now = Date.now()) {
    if (!validActivityRegistration(record, now)) return false;
    this.purge(now);
    const existing = this.get(room, record.activityId, now);
    const count = this.database.prepare('SELECT COUNT(*) AS count FROM task_activities WHERE room=?').get(room).count;
    if (!existing && count >= ACTIVITY_LIMIT) return false;
    const privateRecord = { activityId: record.activityId, token: record.token.toLowerCase(),
      environment: record.environment, bundleId: record.bundleId, expiresAt: record.expiresAt,
      nonce: record.nonce, box: record.box };
    this.database.prepare(`INSERT INTO task_activities(room,activity_id,record_json,expires_at) VALUES (?,?,?,?)
      ON CONFLICT(room,activity_id) DO UPDATE SET record_json=excluded.record_json,expires_at=excluded.expires_at`)
      .run(room, record.activityId, JSON.stringify(privateRecord), record.expiresAt);
    return true;
  }

  list(room, now = Date.now()) {
    this.purge(now);
    return this.database.prepare('SELECT record_json FROM task_activities WHERE room=? ORDER BY activity_id').all(room)
      .map(row => {
        const { activityId, expiresAt, nonce, box } = JSON.parse(row.record_json);
        return { activityId, expiresAt, nonce, box };
      });
  }

  get(room, id, now = Date.now()) {
    this.purge(now);
    const row = this.database.prepare('SELECT * FROM task_activities WHERE room=? AND activity_id=?').get(room, id);
    return row ? { ...JSON.parse(row.record_json), lastDeliveryId: row.last_delivery_id ?? undefined,
      lastDeliveredAt: row.last_delivered_at } : undefined;
  }

  remove(room, id) { this.database.prepare('DELETE FROM task_activities WHERE room=? AND activity_id=?').run(room, id); }

  delivered(room, id, deliveryId, now = Date.now()) {
    this.database.prepare(`UPDATE task_activities SET last_delivery_id=?,last_delivered_at=?
      WHERE room=? AND activity_id=? AND expires_at>?`).run(deliveryId, now, room, id, now);
  }

  purge(now) { this.database.prepare('DELETE FROM task_activities WHERE expires_at<=?').run(now); }
}
