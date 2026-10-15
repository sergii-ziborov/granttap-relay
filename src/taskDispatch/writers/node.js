import { TaskWriterGrants, existingWriter, publicWriter, writerRetainedUntil } from './index.js';

export function nodeTaskWriters(db) {
  db.exec('CREATE TABLE IF NOT EXISTS task_job_writers(room TEXT NOT NULL,id TEXT NOT NULL,record TEXT NOT NULL,PRIMARY KEY(room,id))');
  db.exec('CREATE TABLE IF NOT EXISTS task_writer_resources(room TEXT NOT NULL,id TEXT NOT NULL,record TEXT NOT NULL,PRIMARY KEY(room,id))');
  const adapter = {
    get: (room, id) => {
      const row = db.prepare('SELECT record FROM task_job_writers WHERE room=? AND id=?').get(room, id);
      return row ? JSON.parse(row.record) : undefined;
    },
    list: room => db.prepare('SELECT record FROM task_job_writers WHERE room=? LIMIT 129').all(room).map(row => JSON.parse(row.record)),
    put: (room, row) => db.prepare('INSERT INTO task_job_writers(room,id,record) VALUES(?,?,?)').run(room, row.id, JSON.stringify(row)),
    delete: (room, id) => db.prepare('DELETE FROM task_job_writers WHERE room=? AND id=?').run(room, id),
    deleteResources: (room, id) => db.prepare('DELETE FROM task_writer_resources WHERE room=? AND id=?').run(room, id),
    putResources: (room, id, value) => db.prepare(`INSERT INTO task_writer_resources(room,id,record) VALUES(?,?,?)
      ON CONFLICT(room,id) DO UPDATE SET record=excluded.record`).run(room, id, JSON.stringify(value)),
    getResources: (room, id) => {
      const row = db.prepare('SELECT record FROM task_writer_resources WHERE room=? AND id=?').get(room, id);
      return row ? JSON.parse(row.record) : undefined;
    },
    revoke(room, id, now) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const row = adapter.get(room, id);
        if (row && row.revokedAt == null) {
          db.prepare('UPDATE task_job_writers SET record=? WHERE room=? AND id=?')
            .run(JSON.stringify({ ...row, revokedAt: now }), room, id);
        }
        adapter.deleteResources(room, id);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    commit(room, row, now) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const previous = adapter.get(room, row.id);
        let result;
        if (previous) result = existingWriter(previous, row);
        else {
          for (const old of adapter.list(room)) if (writerRetainedUntil(old) <= now) {
            adapter.delete(room, old.id); adapter.deleteResources(room, old.id);
          }
          if (adapter.list(room).length >= 128) result = { status: 429, error: 'writer grant capacity reached' };
          else { adapter.put(room, row); result = { status: 201, writer: publicWriter(row) }; }
        }
        db.exec('COMMIT'); return result;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
  };
  return new TaskWriterGrants(adapter);
}
