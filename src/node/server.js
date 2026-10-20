import { readJson, sendJson } from "./http-payloads.js";
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { apnsConfigured, sendAPNs } from "../relay/apnsWake.js";
import { acceptsWebSocketPath, validBase64, validDeviceToken, validRoom, validRoomCredential } from "../relay/relayValidation.js";
import { RelayStore } from "./store.js";
import { ENDPOINT_BODY_LIMIT, endpointResponse, endpointStorageKey } from "../relay/endpointDirectory.js";
import { managedAdmission, managedCooldownIdentity } from "./managed-admission.js";
import { armManagedExpiry } from "./managed-connection.js";
import { nodeAPNsRequest } from "./pushDelivery/http2.js";
import { nodeTaskDispatchPump } from "../taskDispatch/socket-offers.js";
import { taskDispatchResponse } from "../taskDispatch/index.js";
import { configuredPushEnvironment } from "./pushDelivery/configuration.js";
import { CoolDownRegistry } from "../relay/coolDown.js";
import { createRelayLog } from "../relay/relayLog.js";
import { heartbeatIntervalFrom, markAlive, startHeartbeat } from "./heartbeat.js";
import { handleSocketMessage, MAX_WEBSOCKET_MESSAGE_BYTES } from "./socket-messages.js";
import { refuseUpgrade, upgradeRefusal } from "./upgrade-gate.js";
import { createSocketDelivery } from './socketDelivery/index.js';
import { createRelayCapacity } from './capacity/index.js';
import { clientAccessFromEnv } from './hostwatch-client.mjs';
import { clientIdentity, setClientDecision, trackClientConnection } from './client-access.js';

const MAX_HTTP_BODY_BYTES = 40_000;
const MAX_PUSH_BODY_BYTES = 4_096;
const PAIR_TTL_MS = 15 * 60 * 1000;
const MAX_ROOM_SOCKETS = 32;

export function createRelayServer(options = {}) {
  const store = options.store ?? new RelayStore(options.databasePath ?? process.env.DATABASE_PATH ?? "/data/relay.sqlite3");
  const env = configuredPushEnvironment(options.env ?? process.env);
  const admission = managedAdmission(env);
  const clientAccess = options.clientAccess ?? clientAccessFromEnv(env);
  const baseLog = options.log ?? createRelayLog({ write: (line) => process.stdout.write(`${line}\n`) });

  const sockets = new Map();
  let capacity;
  const log = (event, fields) => { capacity?.log(event); return baseLog(event, fields); };
  const delivery = createSocketDelivery({ log });
  capacity = createRelayCapacity({store,sockets,delivery,env});
  store.metrics = capacity;
  const policy = { coolDowns: options.coolDowns ?? new CoolDownRegistry(), log };
  const offerJobs = nodeTaskDispatchPump(store.taskDispatch, sockets);
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WEBSOCKET_MESSAGE_BYTES });
  const server = createServer((request, response) => {
    response.once('finish', () => { if (response.statusCode === 429) capacity.record('limited429'); });
    void (async () => {
      const url = requestUrl(request);
      if (clientAccess && url?.pathname !== '/health') {
        const room = url?.searchParams.get('room');
        const ticket = admission?.(request.headers['x-granttap-admission'], room);
        // A signed room-bound admission proves quota identity. The endpoint
        // still verifies its own room/writer credential before any data access.
        const d = await clientAccess.admit(clientIdentity(ticket, request, env));
        setClientDecision(response, d);
        if (!d.allowed) { response.setHeader('Retry-After', String(d.retryAfter || 5)); return sendJson(response, 429, { error: 'Client allowance reached', reason: d.reason }); }
      }
      return routeHttp(request, response, store, env);
    })().catch(() => sendJson(response, 500, { error: "internal error" }));
  });

  wss.on('headers', (headers, request) => {
    const d = request.clientAccessDecision;
    if (d) headers.push(`X-Hostwatch-Client-Category: ${d.category}`, 'X-Hostwatch-Client-Limit: none');
  });

  server.on("upgrade", (request, socket, head) => { void (async () => {
    capacity.record('connectionAttempts');
    const url = requestUrl(request);
    const room = url?.searchParams.get("room");
    const ticketHeader = request.headers["x-granttap-admission"];
    const ticket = admission ? admission(ticketHeader, room) : null;
    const recipientKeyId = request.headers["x-granttap-recipient-key-id"];
    const credential = bearer(request);
    const authorized = Boolean(url && acceptsWebSocketPath(url.pathname) && validRoom(room)
      && authorizeUpgrade(store, room, credential));
    const refusal = upgradeRefusal({ authorized, admissionRequired: Boolean(admission), ticketHeader, ticket,
      recipientKeyId, room, roomSize: sockets.get(room)?.size ?? 0, maxRoomSockets: MAX_ROOM_SOCKETS,
      coolDowns: policy.coolDowns });
    if (refusal) {
      capacity.record('connectionsRefused');if(refusal.status===429)capacity.record('limited429');
      log("relay.upgrade_refused", { room, status: refusal.status, reason: refusal.reason, retryAfter: refusal.retryAfter });
      const category = ticket ? clientIdentity(ticket, request, env).category : 'anonymous';
      refuseUpgrade(socket, { ...refusal, category, limitReason: refusal.reason === 'cool-down' ? 'relay-cooldown' : refusal.reason === 'room-full' ? 'relay-room-capacity' : undefined });
      return;
    }
    // A valid room credential proves pairing, not a subscription or account.
    const identity = clientIdentity(ticket, request, env);
    if (!ticket) identity.identityKind = 'paired-device';
    const decision = clientAccess ? await clientAccess.admit(identity, 'connect') : null;
    if (decision && !decision.allowed) {
      capacity.record('connectionsRefused');capacity.record('limited429');
      refuseUpgrade(socket, { status: 429, reason: decision.reason, retryAfter: decision.retryAfter || 5, category: decision.category });
      return;
    }
    request.clientAccessDecision = decision;
    if (socket.destroyed) { if (decision?.leaseId) void clientAccess.admit(clientIdentity(ticket, request, env), 'release', decision.leaseId); return; }
    // Admission is asynchronous: another connection may have filled this room.
    if ((sockets.get(room)?.size ?? 0) >= MAX_ROOM_SOCKETS) {
      if (decision?.leaseId) void clientAccess.admit(clientIdentity(ticket, request, env), 'release', decision.leaseId);
      refuseUpgrade(socket, { status: 429, reason: 'room-full', retryAfter: 5, category: decision?.category, limitReason: 'relay-room-capacity' });
      return;
    }
    if (!authorize(store, room, credential)) {
      if (decision?.leaseId) void clientAccess.admit(clientIdentity(ticket, request, env), 'release', decision.leaseId);
      refuseUpgrade(socket, { status: 401, reason: 'unauthorized' });
      return;
    }
    const relayControl = request.headers["x-granttap-recipient-routing"] === "1";
    wss.handleUpgrade(request, socket, head, (ws) => {
      const capacityClosed=capacity.connected(ticket);ws.once('close', () => { capacity.record('connectionsClosed');if(ws.relayState?.capacityPolicyClose)capacity.record('policyCloses');capacityClosed?.(); });
      ws.relayState = { room, role: null, identity: managedCooldownIdentity(ticket), commercial: !!admission, ticket, policy, relayControl,
        windowStartedAt: Date.now(), windowMessages: 0, recipientKeyId, awaitingPong: false,
        taskDispatch: request.headers["x-granttap-task-dispatch"] === "1" };
      if (ticket) {
        armManagedExpiry(ws, ticket);
        ws.on("close", () => clearTimeout(ws.relayState.admissionTimer));
      }
      trackClientConnection(ws, clientAccess, request, env, decision);
      const roomSockets = sockets.get(room) ?? new Set();
      roomSockets.add(ws);
      sockets.set(room, roomSockets);
      wss.emit("connection", ws);
      if (relayControl) {
        ws.send(JSON.stringify({ type: "relay.capabilities", recipientRouting: true, taskDispatch: true }));
      }
    });
  })().catch(() => socket.destroy()); });

  const wake = (room) => { void sendWakePush(store, room, env); };
  wss.on("connection", (ws) => {
    ws.on("pong", () => markAlive(ws));
    ws.on("ping", () => markAlive(ws));
    ws.on("message", (value, binary) => {
      markAlive(ws);
      if (binary) return;
      handleSocketMessage(ws, value.toString(), { store, sockets, admission, wake, delivery });
    });
    ws.on("close", () => removeSocket(ws, sockets));
    ws.on("error", () => removeSocket(ws, sockets));
  });

  const stopHeartbeat = startHeartbeat(sockets, { log,
    intervalMs: options.heartbeatIntervalMs ?? heartbeatIntervalFrom(env.RELAY_HEARTBEAT_MS) });
  const dispatchTimer = setInterval(() => { void offerJobs().catch(() => {}); }, options.taskDispatchIntervalMs ?? 1000);
  dispatchTimer.unref();
  const cleanup = setInterval(() => store.purgeExpiredPairings(), 60_000);
  cleanup.unref();
  server.on("close", () => { clearInterval(cleanup); clearInterval(dispatchTimer); capacity.close(); stopHeartbeat(); clientAccess?.close?.(); wss.close(); store.close(); });
  server.shutdown = async () => {
    // Let healthy clients receive a restart close, then release their private
    // quota leases before the new instance accepts reconnects.
    const force = setTimeout(() => { for (const peers of sockets.values()) for (const ws of peers) ws.terminate(); }, 1000);
    force.unref();
    for (const peers of sockets.values()) for (const ws of peers) ws.close(1001, 'service-restart');
    await new Promise(resolve => server.close(resolve));
    clearTimeout(force);
    await clientAccess?.close?.();
  };
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
  return equalDigest(digest, expected);
}

/** Policy refusals must stay read-only, even when the caller invents a new room. */
function authorizeUpgrade(store, room, credential) {
  if (!validRoomCredential(credential)) return false;
  const current = store.authDigest(room);
  return !current || equalDigest(createHash('sha256').update(credential).digest('hex'), current);
}

function equalDigest(supplied, expected) {
  const left = Buffer.from(supplied, 'hex');
  const right = Buffer.from(expected, 'hex');
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
  const server = createRelayServer();
  server.listen(port, process.env.HOST ?? "0.0.0.0", () => {
    process.stdout.write(`GrantTap relay listening on port ${port}\n`);
  });
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { void server.shutdown().finally(() => process.exit(0)); });
}
