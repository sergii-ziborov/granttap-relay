import { initializeRoomTaskDispatch, handleRoomTaskDispatch, offerRoomTaskJobs,
  scheduleRoomTaskAlarm } from "../taskDispatch/worker-room.js";
import { apnsConfigured, sendAPNs } from "./apnsWake.js";
import { bearer, byteLength, constantTimeEqual, readJsonLimited, sha256, json } from "./relaySupport.js";
import { envelopeProblem, validDeviceToken, validIdentifier, validRoom, validRoomCredential } from "./relayValidation.js";
import { QUEUE_RESULT, queueOutcome } from "./connectionPolicy.js";
import { acceptRoomFrame, closeRoomSocket, coolingUpgradeResponse, dropRoomMessage, initializeRoomSocketPolicy,
  refuseCoolingRoomSocket, registerRoomSocketIdentity } from "./roomSockets.js";
import { ENDPOINT_BODY_LIMIT, endpointResponse, endpointStorageKey } from "./endpointDirectory.js";

import { putDirectoryEndpoint } from "./endpointRetention.js";

import { validRecipientKeyId, matchesRecipient, matchesQueuedRecipient } from "./recipientRouting.js";
import { isDurableSubmission, retainSubmission, storedSubmissionNotice } from "./submissionReceipts.js";

const HOLD_LIMIT = 100;
const DEFAULT_QUEUE_TTL_MS = 15 * 60 * 1000;
const PUSH_TOKEN_LIMIT = 8;
const PUSH_AUTH_KEY = "push:auth-sha256";
const PUSH_TOKENS_KEY = "push:tokens";
const MAX_WEBSOCKET_MESSAGE_BYTES = 32 * 1024 * 1024;
const MAX_QUEUE_BYTES = 1_800_000;
const MAX_PUSH_BODY_BYTES = 4_096;

export class GrantTapRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    initializeRoomTaskDispatch(this);
    initializeRoomSocketPolicy(this);
  }

  async fetch(request) {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/task-jobs" || pathname.startsWith("/task-jobs/") || pathname.startsWith("/task-job-writers/") || pathname.startsWith("/task-resources/") || pathname.startsWith("/task-job-configurations/")) return handleRoomTaskDispatch(this, request);
    if (pathname === "/push/register") return this.handlePushRegistration(request);
    if (pathname === "/push/status") return this.handlePushStatus(request);
    if (pathname === "/endpoint") return this.handleEndpoint(request);
    return this.acceptWebSocket(request);
  }

  async acceptWebSocket(request) {
    if ((request.headers.get("Upgrade") ?? "").toLowerCase() !== "websocket") return json({ error: "expected websocket" }, 426);
    const room = new URL(request.url).searchParams.get("room");
    if (!validRoom(room)) return json({ error: "valid room query parameter required" }, 400);
    const authError = await this.requireRoomAuth(request);
    if (authError) return authError;
    const recipientKeyId = request.headers.get("X-GrantTap-Recipient-Key-Id") ?? undefined;
    if (recipientKeyId !== undefined && !validRecipientKeyId(recipientKeyId)) return json({ error: "invalid recipient" }, 400);
    const cooling = coolingUpgradeResponse(this, room, recipientKeyId);
    if (cooling) return cooling;
    const relayControl = request.headers.get("X-GrantTap-Recipient-Routing") === "1";
    const pair = new WebSocketPair();
    this.state.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({ room, ...(recipientKeyId ? { recipientKeyId } : {}),
      ...(relayControl ? { relayControl } : {}), taskDispatch: request.headers.get("X-GrantTap-Task-Dispatch") === "1" });
    if (relayControl) {
      pair[1].send(JSON.stringify({ type: "relay.capabilities", recipientRouting: true, taskDispatch: true }));
    }
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== "string") return;
    const known = ws.deserializeAttachment() ?? {};
    if (byteLength(raw) > MAX_WEBSOCKET_MESSAGE_BYTES) return closeRoomSocket(this, ws, known, "oversize");
    if (!acceptRoomFrame(this, ws)) return closeRoomSocket(this, ws, known, "rate-limit");
    let envelope;
    try { envelope = JSON.parse(raw); } catch { return; }
    if (envelope?.type === "relay.ack" && validIdentifier(envelope.deliveryId, 180)) {
      if (known.role) await this.acknowledge(known.role, envelope.deliveryId);
      return;
    }
    const problem = envelopeProblem(envelope, known.room, Date.now());
    if (problem === "expired") return dropRoomMessage(this, ws, known, envelope, "expired");
    if (problem) return;
    if (!known.role) {
      if (refuseCoolingRoomSocket(this, ws, known, envelope)) return;
      ws.serializeAttachment({ ...known, role: envelope.from });
      registerRoomSocketIdentity(this, ws, known, envelope);
      await this.flushTo(envelope.from, ws);
      if (envelope.from === "machine" && known.taskDispatch) {
        await offerRoomTaskJobs(this);
        await scheduleRoomTaskAlarm(this);
      }
    } else if (known.role !== envelope.from) return;
    const targets = this.targetsFor(ws, envelope);
    if (envelope.to !== "all" && envelope.deliveryId) {
      let stored;
      try { stored = await this.queue(envelope.to, raw, envelope.deliveryId, envelope.expiresAt); }
      catch { return dropRoomMessage(this, ws, known, envelope, 'storage-unavailable'); }
      const outcome = queueOutcome(stored);
      if (outcome.close) return closeRoomSocket(this, ws, { ...known, role: envelope.from }, outcome.close, envelope);
      if (outcome.drop) return dropRoomMessage(this, ws, { ...known, role: envelope.from }, envelope, outcome.drop);
      if (known.relayControl && envelope.from === 'phone' && envelope.to === 'machine'
          && isDurableSubmission(envelope.deliveryId)) {
        ws.send(storedSubmissionNotice(envelope.deliveryId));
      }
    }
    for (const target of targets) {
      try { target.send(raw); } catch { /* stale hibernating socket */ }
    }
    if (envelope.to === "phone" && envelope.wake === true) await this.sendWakePush().catch(() => {});
  }

  targetsFor(ws, envelope) {
    return this.state.getWebSockets().filter((socket) => socket !== ws).filter((socket) => {
      const attachment = socket.deserializeAttachment();
      return (envelope.to === "all" || attachment?.role === envelope.to)
        && matchesRecipient(envelope, attachment?.recipientKeyId);
    });
  }

  /** Returns a `QUEUE_RESULT`, matching the Node store; a full mailbox evicts its oldest rows. */
  async queue(role, raw, deliveryId, expiresAt) {
    const rawBytes = byteLength(raw);
    if (rawBytes > MAX_QUEUE_BYTES) return QUEUE_RESULT.OVERSIZE;
    const key = `q:${role}`;
    const now = Date.now();
    if (expiresAt != null && expiresAt <= now) return QUEUE_RESULT.EXPIRED;
    const queue = ((await this.state.storage.get(key)) ?? []).filter((item) => (item.expiresAt ?? now + DEFAULT_QUEUE_TTL_MS) > now);
    if (deliveryId && queue.some((item) => item.deliveryId === deliveryId)) return QUEUE_RESULT.DUPLICATE;
    const retained = retainSubmission(queue, { raw, rawBytes, deliveryId,
      expiresAt: expiresAt ?? now + DEFAULT_QUEUE_TTL_MS }, HOLD_LIMIT, MAX_QUEUE_BYTES);
    if (retained.result === QUEUE_RESULT.FULL) return QUEUE_RESULT.FULL;
    await this.state.storage.put(key, retained.rows);
    return retained.result;
  }

  async acknowledge(role, deliveryId) {
    const key = `q:${role}`;
    const remaining = ((await this.state.storage.get(key)) ?? []).filter((item) => item.deliveryId !== deliveryId);
    if (remaining.length) await this.state.storage.put(key, remaining);
    else await this.state.storage.delete(key);
  }

  async flushTo(role, ws) {
    const key = `q:${role}`;
    const queue = await this.state.storage.get(key);
    if (!queue?.length) return;
    const now = Date.now();
    const pending = queue.filter((item) => (typeof item === "string" ? now + DEFAULT_QUEUE_TTL_MS : item.expiresAt) > now);
    if (!pending.length) {
      await this.state.storage.delete(key);
      return;
    }
    // Reliable rows already live in storage until their decrypt ACK removes
    // them. Rewriting the pre-send snapshot here races that ACK and resurrects
    // the very row the recipient confirmed, causing duplicate chat events and
    // an immortal backlog ahead of fresh catalog snapshots.
    if (pending.every((item) => typeof item !== "string" && item.deliveryId)) {
      for (const item of pending) {
        try {
          if (matchesQueuedRecipient(item.raw, ws.deserializeAttachment?.()?.recipientKeyId)) ws.send(item.raw);
        } catch { break; }
      }
      return;
    }
    const remaining = [];
    for (let index = 0; index < pending.length; index += 1) {
      const item = pending[index];
      const raw = typeof item === "string" ? item : item.raw;
      if (!raw) continue;
      if (!matchesQueuedRecipient(raw, ws.deserializeAttachment?.()?.recipientKeyId)) {
        remaining.push(item);
        continue;
      }
      try {
        ws.send(raw);
        if (typeof item !== "string" && item.deliveryId) remaining.push(item);
      } catch {
        remaining.push(item, ...pending.slice(index + 1));
        break;
      }
    }
    if (remaining.length) await this.state.storage.put(key, remaining);
    else await this.state.storage.delete(key);
  }

  async handlePushRegistration(request) {
    const authError = await this.requireRoomAuth(request);
    if (authError) return authError;
    let body;
    try { body = await readJsonLimited(request, MAX_PUSH_BODY_BYTES); } catch { return json({ error: "bounded JSON body required" }, 400); }
    const token = String(body?.token ?? "").toLowerCase();
    if (!validDeviceToken(token)) return json({ error: "valid APNs token required" }, 400);
    if (body.environment !== "sandbox" && body.environment !== "production") return json({ error: "environment must be sandbox or production" }, 400);
    const bundleId = String(body.bundleId ?? "");
    if (bundleId !== "com.ziborov.granttap") return json({ error: "unexpected bundle id" }, 400);
    let tokens = (await this.state.storage.get(PUSH_TOKENS_KEY)) ?? [];
    if (request.method === "DELETE") tokens = tokens.filter((item) => item.token !== token);
    else if (request.method === "PUT" || request.method === "POST") {
      tokens = tokens.filter((item) => item.token !== token);
      tokens.push({ token, environment: body.environment, bundleId, updatedAt: Date.now() });
      if (tokens.length > PUSH_TOKEN_LIMIT) tokens.splice(0, tokens.length - PUSH_TOKEN_LIMIT);
    } else return json({ error: "method not allowed" }, 405);
    if (tokens.length) await this.state.storage.put(PUSH_TOKENS_KEY, tokens);
    else await this.state.storage.delete(PUSH_TOKENS_KEY);
    return json({ ok: true, registered: request.method !== "DELETE", enabled: apnsConfigured(this.env, body.environment), devices: tokens.length });
  }

  async handlePushStatus(request) {
    const auth = bearer(request);
    const expected = await this.state.storage.get(PUSH_AUTH_KEY);
    if (!validRoomCredential(auth) || !expected || !constantTimeEqual(await sha256(auth), expected)) return json({ error: "invalid room credential" }, 401);
    return json({ enabled: apnsConfigured(this.env), devices: ((await this.state.storage.get(PUSH_TOKENS_KEY)) ?? []).length });
  }

  async sendWakePush() {
    if (!apnsConfigured(this.env)) return;
    const tokens = (await this.state.storage.get(PUSH_TOKENS_KEY)) ?? [];
    const stale = new Set();
    await Promise.all(tokens.map(async (device) => { if ((await sendAPNs(this.env, device)).stale) stale.add(device.token); }));
    if (!stale.size) return;
    const remaining = tokens.filter((device) => !stale.has(device.token));
    if (remaining.length) await this.state.storage.put(PUSH_TOKENS_KEY, remaining);
    else await this.state.storage.delete(PUSH_TOKENS_KEY);
  }

  async requireRoomAuth(request) {
    const auth = bearer(request);
    if (!validRoomCredential(auth)) return json({ error: "room credential required" }, 401);
    const digest = await sha256(auth);
    const expected = await this.state.storage.get(PUSH_AUTH_KEY);
    if (expected && !constantTimeEqual(digest, expected)) return json({ error: "invalid room credential" }, 401);
    if (!expected) await this.state.storage.put(PUSH_AUTH_KEY, digest);
    return null;
  }

  async handleEndpoint(request) {
    const url = new URL(request.url);
    const room = url.searchParams.get("room");
    const key = endpointStorageKey(room, url.searchParams.get("recipient"));
    if (!key) return json({ error: "invalid endpoint recipient" }, 400);
    const result = await endpointResponse({ method: request.method,
      room,
      authorize: async (pin) => {
        if (!pin && !await this.state.storage.get(PUSH_AUTH_KEY)) return false;
        return !await this.requireRoomAuth(request);
      }, read: () => readJsonLimited(request, ENDPOINT_BODY_LIMIT), store: {
        put: (record) => putDirectoryEndpoint(this.state.storage, key, record),
        get: () => this.state.storage.get(`endpoint:${key}`),
        delete: () => this.state.storage.delete(`endpoint:${key}`),
      } });
    if (result.status < 300) await scheduleRoomTaskAlarm(this);
    return json(result.body, result.status);
  }

  async alarm() { await offerRoomTaskJobs(this); await scheduleRoomTaskAlarm(this); }

  tokensEqual(left, right) { return constantTimeEqual(left, right); }
  webSocketClose() {}
  webSocketError() {}
}
