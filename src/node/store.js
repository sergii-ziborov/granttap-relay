import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const DEFAULT_QUEUE_TTL_MS = 15 * 60 * 1000;
const HOLD_LIMIT = 100;
const MAX_QUEUE_BYTES = 1_800_000;
const PUSH_TOKEN_LIMIT = 8;

export class RelayStore {
  constructor(path) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rooms (
        room TEXT PRIMARY KEY,
        auth_sha256 TEXT,
        push_tokens TEXT NOT NULL DEFAULT '[]',
        machine_queue TEXT NOT NULL DEFAULT '[]',
        phone_queue TEXT NOT NULL DEFAULT '[]',
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pairings (
        mailbox TEXT PRIMARY KEY,
        nonce TEXT NOT NULL,
        box TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS pairings_expiry ON pairings(expires_at);
    `);
    this.ensureRoom = this.db.prepare(`
      INSERT INTO rooms(room, updated_at) VALUES (?, ?)
      ON CONFLICT(room) DO UPDATE SET updated_at=excluded.updated_at
    `);
    this.roomStatement = this.db.prepare("SELECT * FROM rooms WHERE room = ?");
  }

  room(room) {
    this.ensureRoom.run(room, Date.now());
    return this.roomStatement.get(room);
  }

  authDigest(room) { return this.room(room).auth_sha256 ?? null; }

  pinAuth(room, digest) {
    this.ensureRoom.run(room, Date.now());
    this.db.prepare(`
      UPDATE rooms SET auth_sha256 = COALESCE(auth_sha256, ?), updated_at = ? WHERE room = ?
    `).run(digest, Date.now(), room);
    return this.authDigest(room);
  }

  queue(room, role) {
    const column = queueColumn(role);
    return parseArray(this.room(room)[column]).filter((item) => item.expiresAt > Date.now());
  }

  enqueue(room, role, raw, deliveryId, expiresAt) {
    const queue = this.queue(room, role);
    if (queue.some((item) => item.deliveryId === deliveryId)) return;
    queue.push({ raw, rawBytes: Buffer.byteLength(raw), deliveryId,
      expiresAt: expiresAt ?? Date.now() + DEFAULT_QUEUE_TTL_MS });
    if (queue.length > HOLD_LIMIT) queue.splice(0, queue.length - HOLD_LIMIT);
    let bytes = queue.reduce((sum, item) => sum + item.rawBytes, 0);
    while (queue.length > 1 && bytes > MAX_QUEUE_BYTES) bytes -= queue.shift().rawBytes;
    this.writeQueue(room, role, queue);
  }

  acknowledge(room, role, deliveryId) {
    this.writeQueue(room, role, this.queue(room, role).filter((item) => item.deliveryId !== deliveryId));
  }

  writeQueue(room, role, queue) {
    const column = queueColumn(role);
    this.db.prepare(`UPDATE rooms SET ${column} = ?, updated_at = ? WHERE room = ?`)
      .run(JSON.stringify(queue), Date.now(), room);
  }

  pushTokens(room) { return parseArray(this.room(room).push_tokens); }

  updatePushToken(room, device, remove = false) {
    let tokens = this.pushTokens(room).filter((item) => item.token !== device.token);
    if (!remove) tokens.push({ ...device, updatedAt: Date.now() });
    if (tokens.length > PUSH_TOKEN_LIMIT) tokens = tokens.slice(-PUSH_TOKEN_LIMIT);
    this.db.prepare("UPDATE rooms SET push_tokens = ?, updated_at = ? WHERE room = ?")
      .run(JSON.stringify(tokens), Date.now(), room);
    return tokens;
  }

  removePushTokens(room, tokens) {
    const stale = new Set(tokens);
    const remaining = this.pushTokens(room).filter((item) => !stale.has(item.token));
    this.db.prepare("UPDATE rooms SET push_tokens = ?, updated_at = ? WHERE room = ?")
      .run(JSON.stringify(remaining), Date.now(), room);
  }

  putPairing(mailbox, body, expiresAt) {
    this.purgeExpiredPairings();
    try {
      this.db.prepare("INSERT INTO pairings(mailbox, nonce, box, expires_at) VALUES (?, ?, ?, ?)")
        .run(mailbox, body.nonce, body.box, expiresAt);
      return true;
    } catch (error) {
      if (String(error?.message).includes("UNIQUE constraint")) return false;
      throw error;
    }
  }

  peekPairing(mailbox) {
    this.purgeExpiredPairings();
    const item = this.db.prepare("SELECT expires_at FROM pairings WHERE mailbox = ?").get(mailbox);
    return Boolean(item && item.expires_at > Date.now());
  }

  takePairing(mailbox) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const item = this.db.prepare("SELECT nonce, box, expires_at FROM pairings WHERE mailbox = ?").get(mailbox);
      this.db.prepare("DELETE FROM pairings WHERE mailbox = ?").run(mailbox);
      this.db.exec("COMMIT");
      return item && item.expires_at > Date.now() ? { nonce: item.nonce, box: item.box } : null;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  purgeExpiredPairings() {
    this.db.prepare("DELETE FROM pairings WHERE expires_at <= ?").run(Date.now());
  }

  close() { this.db.close(); }
}

function queueColumn(role) {
  if (role === "machine") return "machine_queue";
  if (role === "phone") return "phone_queue";
  throw new Error("invalid queue role");
}

function parseArray(value) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}
