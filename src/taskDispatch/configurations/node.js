import { TaskConfigurations, configurationCapacity } from './index.js';

export function nodeTaskConfigurations(db) {
  db.exec('CREATE TABLE IF NOT EXISTS task_configurations(room TEXT NOT NULL,id TEXT NOT NULL,expires_at INTEGER NOT NULL,record TEXT NOT NULL,PRIMARY KEY(room,id))');
  db.exec('CREATE INDEX IF NOT EXISTS task_configuration_expiry ON task_configurations(expires_at)');
  const adapter = {
    get: (room, id) => {
      const row = db.prepare('SELECT record FROM task_configurations WHERE room=? AND id=?').get(room, id);
      return row ? JSON.parse(row.record) : undefined;
    },
    list: room => db.prepare('SELECT record FROM task_configurations WHERE room=? LIMIT 129').all(room).map(row => JSON.parse(row.record)),
    put: (room, row) => db.prepare(`INSERT INTO task_configurations(room,id,expires_at,record) VALUES(?,?,?,?)
      ON CONFLICT(room,id) DO UPDATE SET expires_at=excluded.expires_at,record=excluded.record`).run(room, row.id, row.expiresAt, JSON.stringify(row)),
    delete: (room, id) => db.prepare('DELETE FROM task_configurations WHERE room=? AND id=?').run(room, id),
    maintain: now => {
      db.prepare('DELETE FROM task_configurations WHERE expires_at<=?').run(now);
      return db.prepare('SELECT MIN(expires_at) AS expiry FROM task_configurations').get().expiry ?? undefined;
    },
    current(room, id, now) {
      const row = adapter.get(room, id);
      if (row?.expiresAt <= now) { adapter.delete(room, id); return undefined; }
      return row;
    },
    commit: (room, row, now) => {
      db.exec('BEGIN IMMEDIATE');
      try {
        const rows = adapter.list(room);
        for (const old of rows) if (old.expiresAt <= now) adapter.delete(room, old.id);
        const result = configurationCapacity(rows, row, now);
        if (result.status < 300) adapter.put(room, row);
        db.exec('COMMIT'); return result;
      }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    },
  };
  return new TaskConfigurations(adapter);
}
