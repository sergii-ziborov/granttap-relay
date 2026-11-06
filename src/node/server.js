import { closeNodeSocket } from "../roomPresence/index.js";
import { readJson, sendJson, requestUrl } from "./http-payloads.js";
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { apnsConfigured } from "../relay/apnsWake.js";
import { acceptsWebSocketPath, validBase64, validRoom, validRoomCredential } from "../relay/relayValidation.js";
import { RelayStore } from "./store.js";
import { ENDPOINT_BODY_LIMIT, endpointResponse, endpointStorageKey } from "../relay/endpointDirectory.js";
import { managedAdmission, managedCooldownIdentity } from "./managed-admission.js";
import { armManagedExpiry } from "./managed-connection.js";
import { nodeAPNsRequest, configuredPushEnvironment, handlePushRegistration, sendWakePush } from "./pushDelivery/index.js";
import { nodeTaskDispatchPump } from "../taskDispatch/socket-offers.js";
import { taskDispatchResponse } from "../taskDispatch/index.js";
import { CoolDownRegistry } from "../relay/coolDown.js";
import { createRelayLog } from "../relay/relayLog.js";
import { heartbeatIntervalFrom, markAlive, startHeartbeat } from "./heartbeat.js";
import { handleSocketMessage, MAX_WEBSOCKET_MESSAGE_BYTES } from "./socket-messages.js";
import { refuseUpgrade, upgradeRefusal } from "./upgrade-gate.js";
import { createSocketDelivery } from './socketDelivery/index.js';
import { createRelayCapacity } from './capacity/index.js';
import { clientAccessFromEnv } from './hostwatch-client.mjs';
import { clientIdentity, setClientDecision, trackClientConnection } from './client-access.js';
import { TaskActivityEndpoint, sendTaskActivityAPNs } from "../taskActivities/index.js";
import { ingressCapabilities } from '../ingressFlow/index.js';
import { WakeDelivery } from '../relay/wakeDelivery.js';

const MAX_HTTP_BODY_BYTES = 40_000;
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
  const activities = new TaskActivityEndpoint({ registry: store.taskActivities,
    configured: environment => apnsConfigured(env, environment),
    send: async (device, update, now) => {
      const result = await sendTaskActivityAPNs({ env, device, update, now,
        request: options.pushRequest ?? nodeAPNsRequest });
      log('relay.apns', { reason: result.ok ? 'activity-accepted' : result.stale ? 'stale-token' : 'activity-rejected' });
      return result;
    } });
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
      return routeHttp(request, response, store, env, activities);
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
        ingressFlow: relayControl && request.headers['x-granttap-ingress-flow'] === '1',
        windowStartedAt: Date.now(), windowMessages: 0, recipientKeyId, awaitingPong: false,
        presenceEnabled: request.headers["x-granttap-presence"] === "1",
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
        ws.send(JSON.stringify({ type: "relay.capabilities", recipientRouting: true, taskDispatch: true,
          retainedState: true, retainedStateGroups: true, ...ingressCapabilities(ws.relayState.ingressFlow) }));
      }
    });
  })().catch(() => socket.destroy()); });

  const wakes = new WakeDelivery({ read: room => store.wakeState(room),
    write: (room, state) => store.saveWakeState(room, state),
    send: room => sendWakePush(store, room, env, options.pushRequest ?? nodeAPNsRequest, log),
    notify: reason => log('relay.wake', { reason }) });
  const wake = (room, envelope) => { void wakes.request(room, envelope).catch(() => log('relay.wake', { reason: 'storage-unavailable' })); };
  let wakePump;
  const pumpWakes = () => wakePump ??= (async () => {
    for (const room of store.dueWakeRooms()) await wakes.drain(room);
  })().catch(() => log('relay.wake', { reason: 'storage-unavailable' })).finally(() => { wakePump = null; });
  wss.on("connection", (ws) => {
    ws.on("pong", () => markAlive(ws));
    ws.on("ping", () => markAlive(ws));
    ws.on("message", (value, binary) => {
      markAlive(ws);
      if (binary) return;
      handleSocketMessage(ws, value.toString(), { store, sockets, admission, wake, delivery });
    });
    ws.on("close", () => closeNodeSocket(ws, sockets, store, delivery));
    ws.on("error", () => closeNodeSocket(ws, sockets, store, delivery));
  });

  const stopHeartbeat = startHeartbeat(sockets, { log,
    intervalMs: options.heartbeatIntervalMs ?? heartbeatIntervalFrom(env.RELAY_HEARTBEAT_MS) });
  const dispatchTimer = setInterval(() => { void offerJobs().catch(() => {}); }, options.taskDispatchIntervalMs ?? 1000);
  dispatchTimer.unref();
  const cleanup = setInterval(() => { store.purgeExpiredPairings(); void pumpWakes(); }, options.cleanupIntervalMs ?? 60_000);
  server.once('listening', () => { void pumpWakes(); });
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

async function routeHttp(request, response, store, env, activities) {
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
  if (url.pathname.startsWith('/push/activity/')) {
    const room = url.searchParams.get('room');
    const result = await activities.handle({ path: url.pathname, method: request.method, room,
      authorize: () => authorize(store, room, bearer(request), false), read: limit => readJson(request, limit) });
    return sendJson(response, result.status, result.body);
  }
  if (url.pathname === "/push/register" || url.pathname === "/push/status") {
    return handlePushRegistration({ request, response, store, env, url,
      authorize: (room, pin) => authorize(store, room, bearer(request), pin) });
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



function bearer(request) {
  const value = String(request.headers.authorization ?? "");
  return value.startsWith("Bearer ") ? value.slice(7).trim() : "";
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
