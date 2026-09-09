import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { apnsConfigured, sendAPNs } from "../relay/apnsWake.js";
import { validBase64, validDeviceToken, validEnvelope, validIdentifier,
  validRoom, validRoomCredential } from "../relay/relayValidation.js";
import { RelayStore } from "./store.js";

const MAX_HTTP_BODY_BYTES = 40_000;
const MAX_PUSH_BODY_BYTES = 4_096;
const MAX_WEBSOCKET_MESSAGE_BYTES = 32 * 1024 * 1024;
const PAIR_TTL_MS = 15 * 60 * 1000;
const MAX_ROOM_SOCKETS = 32;
const MAX_SOCKET_MESSAGES_PER_SECOND = 300;

export function createRelayServer(options = {}) {
  const store = options.store ?? new RelayStore(options.databasePath ?? process.env.DATABASE_PATH ?? "/data/relay.sqlite3");
  const env = options.env ?? process.env;
  const sockets = new Map();
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WEBSOCKET_MESSAGE_BYTES });
  const server = createServer((request, response) => {
    void routeHttp(request, response, store, env).catch(() => sendJson(response, 500, { error: "internal error" }));
  });

  server.on("upgrade", (request, socket, head) => {
    const url = requestUrl(request);
    const room = url?.searchParams.get("room");
    if (!url || url.pathname !== "/" || !validRoom(room) || !authorize(store, room, bearer(request))) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    if ((sockets.get(room)?.size ?? 0) >= MAX_ROOM_SOCKETS) {
      socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      ws.relayState = { room, role: null, windowStartedAt: Date.now(), windowMessages: 0 };
      const roomSockets = sockets.get(room) ?? new Set();
      roomSockets.add(ws);
      sockets.set(room, roomSockets);
      wss.emit("connection", ws);
    });
  });

  wss.on("connection", (ws) => {
    ws.on("message", (value, binary) => {
      if (binary) return;
      void handleMessage(ws, value.toString(), store, sockets, env);
    });
    ws.on("close", () => removeSocket(ws, sockets));
    ws.on("error", () => removeSocket(ws, sockets));
  });

  const cleanup = setInterval(() => store.purgeExpiredPairings(), 60_000);
  cleanup.unref();
  server.on("close", () => { clearInterval(cleanup); wss.close(); store.close(); });
  return server;
}

async function routeHttp(request, response, store, env) {
  const url = requestUrl(request);
  if (!url) return sendJson(response, 400, { error: "bad request" });
  if (url.pathname === "/health" && request.method === "GET") {
    return sendJson(response, 200, { ok: true });
  }
  const mailbox = /^\/pair\/([a-f0-9]{32})$/.exec(url.pathname)?.[1];
  if (mailbox) return handlePairing(request, response, store, mailbox);
  if (url.pathname === "/push/register" || url.pathname === "/push/status") {
    return handlePush(request, response, store, env, url);
  }
  return sendJson(response, 404, { error: "not found" });
}

async function handlePairing(request, response, store, mailbox) {
  if (request.method === "GET") {
    const item = store.takePairing(mailbox);
    return item ? sendJson(response, 200, item)
      : sendJson(response, 404, { error: "unknown or expired mailbox" });
  }
  if (request.method !== "PUT" && request.method !== "POST") {
    return sendJson(response, 405, { error: "method not allowed" });
  }
  const body = await readJson(request, MAX_HTTP_BODY_BYTES);
  if (!body || !validBase64(body.nonce, 32, 32) || !validBase64(body.box, 24, 32_768)) {
    return sendJson(response, 400, { error: "canonical bounded base64 nonce and box required" });
  }
  const stored = store.putPairing(mailbox, body, Date.now() + PAIR_TTL_MS);
  return stored ? sendJson(response, 200, { ok: true, expiresInSec: PAIR_TTL_MS / 1000 })
    : sendJson(response, 409, { error: "mailbox already occupied" });
}

async function handlePush(request, response, store, env, url) {
  const room = url.searchParams.get("room");
  if (!validRoom(room)) return sendJson(response, 400, { error: "valid room query parameter required" });
  const pinAuth = url.pathname === "/push/register";
  if (!authorize(store, room, bearer(request), pinAuth)) {
    return sendJson(response, 401, { error: "invalid room credential" });
  }
  if (url.pathname === "/push/status") {
    if (request.method !== "GET") return sendJson(response, 405, { error: "method not allowed" });
    return sendJson(response, 200, { enabled: apnsConfigured(env), devices: store.pushTokens(room).length });
  }
  if (!["PUT", "POST", "DELETE"].includes(request.method)) {
    return sendJson(response, 405, { error: "method not allowed" });
  }
  const body = await readJson(request, MAX_PUSH_BODY_BYTES);
  const token = String(body?.token ?? "").toLowerCase();
  if (!validDeviceToken(token)) return sendJson(response, 400, { error: "valid APNs token required" });
  if (!["sandbox", "production"].includes(body.environment)) {
    return sendJson(response, 400, { error: "environment must be sandbox or production" });
  }
  if (body.bundleId !== "com.ziborov.granttap") return sendJson(response, 400, { error: "unexpected bundle id" });
  const tokens = store.updatePushToken(room, { token, environment: body.environment, bundleId: body.bundleId },
    request.method === "DELETE");
  return sendJson(response, 200, { ok: true, registered: request.method !== "DELETE",
    enabled: apnsConfigured(env), devices: tokens.length });
}

async function handleMessage(ws, raw, store, sockets, env) {
  if (Buffer.byteLength(raw) > MAX_WEBSOCKET_MESSAGE_BYTES) return ws.close(1009);
  if (!acceptSocketMessage(ws.relayState)) return ws.close(1008, "rate limit");
  let envelope;
  try { envelope = JSON.parse(raw); } catch { return; }
  const state = ws.relayState;
  if (envelope?.type === "relay.ack" && validIdentifier(envelope.deliveryId, 180)) {
    if (state.role) store.acknowledge(state.room, state.role, envelope.deliveryId);
    return;
  }
  if (!validEnvelope(envelope, state.room, Date.now())) return;
  if (!state.role) {
    state.role = envelope.from;
    flushQueue(ws, store.queue(state.room, state.role));
  } else if (state.role !== envelope.from) return;
  if (envelope.to !== "all" && envelope.deliveryId) {
    store.enqueue(state.room, envelope.to, raw, envelope.deliveryId, envelope.expiresAt);
  }
  for (const target of sockets.get(state.room) ?? []) {
    if (target === ws || target.readyState !== WebSocket.OPEN) continue;
    if (envelope.to === "all" || target.relayState?.role === envelope.to) target.send(raw);
  }
  if (envelope.to === "phone" && envelope.wake === true) {
    void sendWakePush(store, state.room, env);
  }
}

function acceptSocketMessage(state) {
  const now = Date.now();
  if (now - state.windowStartedAt >= 1_000) {
    state.windowStartedAt = now;
    state.windowMessages = 0;
  }
  state.windowMessages += 1;
  return state.windowMessages <= MAX_SOCKET_MESSAGES_PER_SECOND;
}

function flushQueue(ws, queue) {
  for (const item of queue) {
    if (ws.readyState !== WebSocket.OPEN) break;
    ws.send(item.raw);
  }
}

async function sendWakePush(store, room, env) {
  if (!apnsConfigured(env)) return;
  const stale = [];
  await Promise.all(store.pushTokens(room).map(async (device) => {
    try { if ((await sendAPNs(env, device)).stale) stale.push(device.token); } catch { /* retry on next wake */ }
  }));
  if (stale.length) store.removePushTokens(room, stale);
}

function authorize(store, room, credential, pin = true) {
  if (!validRoomCredential(credential)) return false;
  const digest = createHash("sha256").update(credential).digest("hex");
  const current = store.authDigest(room);
  if (!current && !pin) return false;
  const expected = current ?? store.pinAuth(room, digest);
  const left = Buffer.from(digest, "hex");
  const right = Buffer.from(expected, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

async function readJson(request, maxBytes) {
  const declared = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > maxBytes) return null;
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return null; }
}

function sendJson(response, status, body) {
  if (response.headersSent) return;
  const payload = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store", "x-content-type-options": "nosniff" });
  response.end(payload);
}

function requestUrl(request) {
  try { return new URL(request.url, "http://relay.invalid"); } catch { return null; }
}

function bearer(request) {
  const value = String(request.headers.authorization ?? "");
  return value.startsWith("Bearer ") ? value.slice(7).trim() : "";
}

function removeSocket(ws, sockets) {
  const roomSockets = sockets.get(ws.relayState?.room);
  if (!roomSockets) return;
  roomSockets.delete(ws);
  if (!roomSockets.size) sockets.delete(ws.relayState.room);
}

const isEntryPoint = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isEntryPoint) {
  const port = Number(process.env.PORT ?? 3201);
  createRelayServer().listen(port, process.env.HOST ?? "0.0.0.0", () => {
    process.stdout.write(`GrantTap relay listening on port ${port}\n`);
  });
}
