import { readJson, sendJson } from "./http-payloads.js";
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { apnsConfigured, sendAPNs } from "../relay/apnsWake.js";
import { acceptsWebSocketPath, validBase64, validDeviceToken, validEnvelope, validIdentifier,
  validRoom, validRoomCredential } from "../relay/relayValidation.js";
import { RelayStore } from "./store.js";
import { ENDPOINT_BODY_LIMIT, endpointResponse, endpointStorageKey } from "../relay/endpointDirectory.js";
import { managedAdmission } from "./managed-admission.js";
import { armManagedExpiry, renewManagedConnection } from "./managed-connection.js";
import { nodeAPNsRequest } from "./pushDelivery/http2.js";
import { nodeTaskDispatchPump } from "../taskDispatch/socket-offers.js";
import { taskDispatchResponse } from "../taskDispatch/index.js";
import { configuredPushEnvironment } from "./pushDelivery/configuration.js";

import { validRecipientKeyId, matchesRecipient, matchesQueuedRecipient } from "../relay/recipientRouting.js";

const MAX_HTTP_BODY_BYTES = 40_000;
const MAX_PUSH_BODY_BYTES = 4_096;
const MAX_WEBSOCKET_MESSAGE_BYTES = 32 * 1024 * 1024;
const PAIR_TTL_MS = 15 * 60 * 1000;
const MAX_ROOM_SOCKETS = 32;
const MAX_SOCKET_MESSAGES_PER_SECOND = 300;

export function createRelayServer(options = {}) {
  const store = options.store ?? new RelayStore(options.databasePath ?? process.env.DATABASE_PATH ?? "/data/relay.sqlite3");
  const env = configuredPushEnvironment(options.env ?? process.env);
  const admission = managedAdmission(env);
  const sockets = new Map();
  const offerJobs = nodeTaskDispatchPump(store.taskDispatch, sockets);
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WEBSOCKET_MESSAGE_BYTES });
  const server = createServer((request, response) => {
    void routeHttp(request, response, store, env).catch(() => sendJson(response, 500, { error: "internal error" }));
  });

  server.on("upgrade", (request, socket, head) => {
    const url = requestUrl(request);
    const room = url?.searchParams.get("room");
    const ticketHeader = request.headers["x-granttap-admission"];
    const ticket = admission ? admission(ticketHeader, room) : null;
    if (!url || !acceptsWebSocketPath(url.pathname) || !validRoom(room) || !authorize(store, room, bearer(request))) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    if (admission && ticketHeader && !ticket) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    if ((sockets.get(room)?.size ?? 0) >= MAX_ROOM_SOCKETS) {
      socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const recipientKeyId = request.headers["x-granttap-recipient-key-id"];
    if (recipientKeyId !== undefined && !validRecipientKeyId(recipientKeyId)) {
      socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      ws.relayState = { room, role: null, commercial: !!admission, ticket,
        windowStartedAt: Date.now(), windowMessages: 0, recipientKeyId,
        taskDispatch: request.headers["x-granttap-task-dispatch"] === "1" };
      if (ticket) {
        armManagedExpiry(ws, ticket);
        ws.on("close", () => clearTimeout(ws.relayState.admissionTimer));
      }
      const roomSockets = sockets.get(room) ?? new Set();
      roomSockets.add(ws);
      sockets.set(room, roomSockets);
      wss.emit("connection", ws);
      if (request.headers["x-granttap-recipient-routing"] === "1") {
        ws.send(JSON.stringify({ type: "relay.capabilities", recipientRouting: true, taskDispatch: true }));
      }
    });
  });

  wss.on("connection", (ws) => {
    ws.on("message", (value, binary) => {
      if (binary) return;
      void handleMessage(ws, value.toString(), store, sockets, env, admission);
    });
    ws.on("close", () => removeSocket(ws, sockets));
    ws.on("error", () => removeSocket(ws, sockets));
  });

  const dispatchTimer = setInterval(() => { void offerJobs().catch(() => {}); }, options.taskDispatchIntervalMs ?? 1000);
  dispatchTimer.unref();
  const cleanup = setInterval(() => store.purgeExpiredPairings(), 60_000);
  cleanup.unref();
  server.on("close", () => { clearInterval(cleanup); clearInterval(dispatchTimer); wss.close(); store.close(); });
  return server;
}

async function routeHttp(request, response, store, env) {
  const url = requestUrl(request);
  if (!url) return sendJson(response, 400, { error: "bad request" });
  if (url.pathname === "/health" && request.method === "GET") {
    return sendJson(response, 200, { ok: true,
      ...(env.RELAY_INSTANCE_ID ? { instanceId: env.RELAY_INSTANCE_ID } : {}) });
  }
  if (url.pathname === "/task-jobs" || url.pathname.startsWith("/task-jobs/") || url.pathname.startsWith("/task-job-writers/") || url.pathname.startsWith("/task-resources/") || url.pathname.startsWith("/task-job-configurations/")) {
    const room = url.searchParams.get("room");
    const result = await taskDispatchResponse({ method: request.method, pathname: url.pathname, room,
      authorize: () => authorize(store, room, bearer(request), false), credential: bearer(request),
      read: limit => readJson(request, limit), store: store.taskDispatch,
      metadataOnly: url.searchParams.get("metadata") === "1" });
    return sendJson(response, result.status, result.body);
  }
  const mailbox = /^\/pair\/([a-f0-9]{32})$/.exec(url.pathname)?.[1];
  if (mailbox) return handlePairing(request, response, store, mailbox);
  if (url.pathname === "/endpoint") {
    const room = url.searchParams.get("room");
    const key = endpointStorageKey(room, url.searchParams.get("recipient"));
    if (!key) return sendJson(response, 400, { error: "invalid endpoint recipient" });
    const result = await endpointResponse({ method: request.method, room,
      authorize: (pin) => authorize(store, room, bearer(request), pin),
      read: () => readJson(request, ENDPOINT_BODY_LIMIT), store: {
        put: (record) => store.putEndpoint(key, record), get: () => store.endpoint(key),
        delete: () => store.deleteEndpoint(key),
      } });
    return sendJson(response, result.status, result.body);
  }
  if (url.pathname === "/push/register" || url.pathname === "/push/status") {
    return handlePush(request, response, store, env, url);
  }
  return sendJson(response, 404, { error: "not found" });
}

async function handlePairing(request, response, store, mailbox) {
  if (request.method === "HEAD") {
    response.writeHead(store.peekPairing(mailbox) ? 200 : 404);
    response.end();
    return;
  }
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
    enabled: apnsConfigured(env, body.environment), devices: tokens.length });
}

async function handleMessage(ws, raw, store, sockets, env, admission) {
  if (Buffer.byteLength(raw) > MAX_WEBSOCKET_MESSAGE_BYTES) return ws.close(1009);
  if (!acceptSocketMessage(ws.relayState)) return ws.close(1008, "rate limit");
  let envelope;
  try { envelope = JSON.parse(raw); } catch { return; }
  if (renewManagedConnection(ws, envelope, admission)) return;
  const state = ws.relayState;
  if (envelope?.type === "relay.ack" && validIdentifier(envelope.deliveryId, 180)) {
    if (state.role) store.acknowledge(state.room, state.role, envelope.deliveryId);
    return;
  }
  if (!validEnvelope(envelope, state.room, Date.now())) return;
  if (state.commercial && envelope.from === "machine"
    && (!state.ticket || state.ticket.expiresAt <= Date.now())) {
    return ws.close(1008, "managed computer admission required");
  }
  if (!state.role) {
    state.role = envelope.from;
    flushQueue(ws, store.queue(state.room, state.role));
  } else if (state.role !== envelope.from) return;
  if (envelope.to !== "all" && envelope.deliveryId) {
    if (!store.enqueue(state.room, envelope.to, raw, envelope.deliveryId, envelope.expiresAt)) {
      return ws.close(1009, "queue capacity");
    }
  }
  for (const target of sockets.get(state.room) ?? []) {
    if (target === ws || target.readyState !== WebSocket.OPEN) continue;
    if (envelope.to === "all" || target.relayState?.role === envelope.to) {
      if (matchesRecipient(envelope, target.relayState?.recipientKeyId)) target.send(raw);
    }
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
    if (matchesQueuedRecipient(item.raw, ws.relayState.recipientKeyId)) ws.send(item.raw);
  }
}

async function sendWakePush(store, room, env) {
  if (!apnsConfigured(env)) return;
  const stale = [];
  await Promise.all(store.pushTokens(room).map(async (device) => {
    try { if ((await sendAPNs(env, device, nodeAPNsRequest)).stale) stale.push(device.token); } catch { /* retry on next wake */ }
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
