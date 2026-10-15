/** Indexed routing keeps retired receipts and large photos out of the dispatch scan. */
export function initializeTaskJobSchema(db) {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS task_jobs (
      room TEXT NOT NULL, id TEXT NOT NULL, record TEXT NOT NULL,
      state TEXT, recipient TEXT, not_before INTEGER, expires_at INTEGER, updated_at INTEGER, payload_bytes INTEGER,
      PRIMARY KEY(room,id))`);
    const columns = new Set(db.prepare('PRAGMA table_info(task_jobs)').all().map(row => row.name));
    for (const [name, type] of Object.entries({ state: 'TEXT', recipient: 'TEXT', not_before: 'INTEGER',
      expires_at: 'INTEGER', updated_at: 'INTEGER', payload_bytes: 'INTEGER' })) {
      if (!columns.has(name)) db.exec(`ALTER TABLE task_jobs ADD COLUMN ${name} ${type}`);
    }
    const update = db.prepare(`UPDATE task_jobs SET state=?, recipient=?, not_before=?, expires_at=?,
      updated_at=?, payload_bytes=? WHERE room=? AND id=?`);
    for (const item of db.prepare('SELECT room,id,record FROM task_jobs WHERE state IS NULL').all()) {
      try {
        const row = JSON.parse(item.record);
        if (typeof row.state !== 'string' || !row.envelope) continue;
        update.run(row.state, row.envelope.recipientKeyId ?? '', row.notBefore, row.expiresAt,
          row.updatedAt, row.bytes, item.room, item.id);
      } catch { /* Corrupt records remain visible to integrity inspection, never to dispatch. */ }
    }
    db.exec(`CREATE INDEX IF NOT EXISTS task_dispatch_due ON task_jobs(room,state,recipient,not_before,expires_at);
      CREATE INDEX IF NOT EXISTS task_dispatch_retention ON task_jobs(state,expires_at,updated_at)`);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* Preserve the migration error. */ }
    throw error;
  }
}
