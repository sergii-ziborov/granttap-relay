import { retainState } from './policy.js';

export class NodeRetainedState {
  constructor(db, activity = () => []) {
    this.db = db;
    this.activity = activity;
    db.exec(`CREATE TABLE IF NOT EXISTS retained_state (
      room TEXT NOT NULL, recipient TEXT NOT NULL, slot TEXT NOT NULL,
      revision INTEGER NOT NULL, priority INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      saved_at INTEGER NOT NULL, bytes INTEGER NOT NULL, raw TEXT NOT NULL,
      PRIMARY KEY(room,recipient,slot));
      CREATE INDEX IF NOT EXISTS retained_state_expiry ON retained_state(expires_at);`);
  }

  metadata(room) {
    return this.db.prepare(`SELECT recipient,slot AS key,revision,priority,
      expires_at AS expiresAt,saved_at AS savedAt,bytes FROM retained_state WHERE room=?`).all(room);
  }

  put(room, envelope, raw, now = Date.now()) {
    // Capacity/replacement needs small metadata, never a parse of every stored chat.
    const before = this.metadata(room);
    const rows = retainState(before, envelope, raw, now, this.activity(room));
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const remove = this.db.prepare('DELETE FROM retained_state WHERE room=? AND recipient=? AND slot=?');
      for (const old of before) if (!rows.includes(old)) remove.run(room, old.recipient, old.key);
      const put = this.db.prepare(`INSERT OR REPLACE INTO retained_state
        (room,recipient,slot,revision,priority,expires_at,saved_at,bytes,raw) VALUES(?,?,?,?,?,?,?,?,?)`);
      for (const row of rows) if (!before.includes(row)) {
        put.run(room,row.recipient,row.key,row.revision,row.priority,row.expiresAt,row.savedAt,row.bytes,row.raw);
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  list(room, recipient, now = Date.now()) {
    if (!/^[a-f0-9]{64}$/.test(recipient ?? '')) return [];
    return this.db.prepare(`SELECT raw FROM retained_state WHERE room=? AND recipient=? AND expires_at>?
      ORDER BY priority,revision`).all(room,recipient,now);
  }
  purge(now = Date.now()) { this.db.prepare('DELETE FROM retained_state WHERE expires_at<=?').run(now); }
}
