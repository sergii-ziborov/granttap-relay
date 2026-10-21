import { NodeRoomPresence } from "../roomPresence/index.js";
import { NodeRetainedState } from "../retainedState/node.js";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { NodeTaskDispatchStore } from "../taskDispatch/node.js";
import { QUEUE_RESULT } from "../relay/connectionPolicy.js";
import { retainSubmission } from "../relay/submissionReceipts.js";

const DEFAULT_QUEUE_TTL_MS = 15 * 60 * 1000;
const HOLD_LIMIT = 100;
const MAX_QUEUE_BYTES = 1_800_000;
const PUSH_TOKEN_LIMIT = 8;

export class RelayStore {
  constructor(path) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
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
      CREATE TABLE IF NOT EXISTS endpoint_directory (
        room TEXT PRIMARY KEY, nonce TEXT NOT NULL, box TEXT NOT NULL, expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS endpoint_expiry ON endpoint_directory(expires_at);
    `);
    this.ensureRoom = this.db.prepare(`
      INSERT INTO rooms(room, updated_at) VALUES (?, ?)
      ON CONFLICT(room) DO UPDATE SET updated_at=excluded.updated_at
    `);
    this.roomStatement = this.db.prepare("SELECT * FROM rooms WHERE room = ?");
    this.authStatement = this.db.prepare("SELECT auth_sha256 FROM rooms WHERE room = ?");
    this.queueStatements = Object.fromEntries(['machine', 'phone'].map(role => [role, {
      read: this.db.prepare(`SELECT ${role}_queue AS value FROM rooms WHERE room = ?`),
      write: this.db.prepare(`UPDATE rooms SET ${role}_queue = ?, updated_at = ? WHERE room = ?`),
    }]));
    this.taskDispatch = new NodeTaskDispatchStore(this.db);
    this.presence = new NodeRoomPresence(this.db);
    this.retainedState = new NodeRetainedState(this.db, room => this.presence.rows(room));
  }

  room(room) {
    return this.roomStatement.get(room);
  }

  authDigest(room) { return this.authStatement.get(room)?.auth_sha256 ?? null; }

  pinAuth(room, digest) {
    this.ensureRoom.run(room, Date.now());
    this.db.prepare(`
      UPDATE rooms SET auth_sha256 = COALESCE(auth_sha256, ?), updated_at = ? WHERE room = ?
    `).run(digest, Date.now(), room);
    return this.authDigest(room);
  }

  queue(room, role) {
    queueColumn(role);
    const row = this.queueStatements[role].read.get(room);
    if (!row) return [];
    const stored = parseArray(row.value);
    const live = stored.filter((item) => item.expiresAt > Date.now());
    if (live.length !== stored.length) this.writeQueue(room, role, live);
    return live;
  }

  /** Returns a `QUEUE_RESULT`; only `oversize` means the frame itself can never be retained. */
  enqueue(room, role, raw, deliveryId, expiresAt) {
    const started = performance.now();
    const rawBytes = Buffer.byteLength(raw);
    if (rawBytes > MAX_QUEUE_BYTES) return QUEUE_RESULT.OVERSIZE;
    if (expiresAt != null && expiresAt <= Date.now()) return QUEUE_RESULT.EXPIRED;
    if (!this.room(room)) return QUEUE_RESULT.NO_ROOM;
    const queue = this.queue(room, role);
    if (queue.some((item) => item.deliveryId === deliveryId)) return QUEUE_RESULT.DUPLICATE;
    const retained = retainSubmission(queue, { raw, rawBytes, deliveryId,
      queuedAt: Date.now(), expiresAt: expiresAt ?? Date.now() + DEFAULT_QUEUE_TTL_MS }, HOLD_LIMIT, MAX_QUEUE_BYTES);
    if (retained.result === QUEUE_RESULT.FULL) return QUEUE_RESULT.FULL;
    this.writeQueue(room, role, retained.rows);
    this.metrics?.record('receipts'); this.metrics?.timing('receipt', performance.now() - started);
    return retained.result;
  }

  acknowledge(room, role, deliveryId) {
    const queue = this.queue(room, role);
    const acknowledged = queue.find(item => item.deliveryId === deliveryId);
    if (acknowledged) {
      this.metrics?.record('acknowledgements');
      if (Number.isFinite(acknowledged.queuedAt)) this.metrics?.timing('ack', Date.now() - acknowledged.queuedAt);
    }
    const remaining = queue.filter((item) => item.deliveryId !== deliveryId);
    if (remaining.length !== queue.length) this.writeQueue(room, role, remaining);
  }

  writeQueue(room, role, queue) {
    queueColumn(role);
    this.queueStatements[role].write.run(JSON.stringify(queue), Date.now(), room);
  }

  pushTokens(room) { return parseArray(this.room(room)?.push_tokens ?? "[]"); }

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
    this.taskDispatch.purge();
    this.retainedState.purge();
    this.db.prepare("DELETE FROM pairings WHERE expires_at <= ?").run(Date.now());
    this.db.prepare("DELETE FROM endpoint_directory WHERE expires_at <= ?").run(Date.now());
  }

  putEndpoint(room, record) {
    this.purgeExpiredPairings();
    const prefix = room.split(":", 1)[0];
    const count = this.db.prepare("SELECT COUNT(*) AS count FROM endpoint_directory WHERE room = ? OR room LIKE ?")
      .get(prefix, `${prefix}:%`).count;
    if (!this.endpoint(room) && count >= 32) return false;
    this.db.prepare(`INSERT INTO endpoint_directory(room, nonce, box, expires_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(room) DO UPDATE SET nonce=excluded.nonce, box=excluded.box, expires_at=excluded.expires_at
      WHERE nonce != excluded.nonce OR box != excluded.box OR expires_at != excluded.expires_at`)
      .run(room, record.nonce, record.box, record.expiresAt);
    return true;
  }

  endpoint(room) {
    const item = this.db.prepare("SELECT nonce, box, expires_at FROM endpoint_directory WHERE room = ?").get(room);
    if (!item || item.expires_at <= Date.now()) { this.deleteEndpoint(room); return null; }
    return { nonce: item.nonce, box: item.box, expiresAt: item.expires_at };
  }

  deleteEndpoint(room) { this.db.prepare("DELETE FROM endpoint_directory WHERE room = ?").run(room); }

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
