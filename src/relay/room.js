import { apnsConfigured, sendAPNs } from "./apnsWake.js";
import { bearer, byteLength, constantTimeEqual, readJsonLimited, sha256, json } from "./relaySupport.js";
import { validDeviceToken, validEnvelope, validIdentifier, validRoom, validRoomCredential } from "./relayValidation.js";

const HOLD_LIMIT = 100;
const DEFAULT_QUEUE_TTL_MS = 15 * 60 * 1000;
const PUSH_TOKEN_LIMIT = 8;
const PUSH_AUTH_KEY = "push:auth-sha256";
const PUSH_TOKENS_KEY = "push:tokens";
const MAX_WEBSOCKET_MESSAGE_BYTES = 32 * 1024 * 1024;
const MAX_QUEUE_BYTES = 1_800_000;
const MAX_PUSH_BODY_BYTES = 4_096;

export class GrantTapRoom {
  constructor(state, env) { this.state = state; this.env = env; }

  async fetch(request) {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/push/register") return this.handlePushRegistration(request);
    if (pathname === "/push/status") return this.handlePushStatus(request);
    return this.acceptWebSocket(request);
  }

  async acceptWebSocket(request) {
    if ((request.headers.get("Upgrade") ?? "").toLowerCase() !== "websocket") return json({ error: "expected websocket" }, 426);
    const room = new URL(request.url).searchParams.get("room");
    if (!validRoom(room)) return json({ error: "valid room query parameter required" }, 400);
    const authError = await this.requireRoomAuth(request);
    if (authError) return authError;
    const pair = new WebSocketPair();
    this.state.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({ room });
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== "string" || byteLength(raw) > MAX_WEBSOCKET_MESSAGE_BYTES) return;
    let envelope;
    try { envelope = JSON.parse(raw); } catch { return; }
    const known = ws.deserializeAttachment() ?? {};
    if (envelope?.type === "relay.ack" && validIdentifier(envelope.deliveryId, 180)) {
      if (known.role) await this.acknowledge(known.role, envelope.deliveryId);
      return;
    }
    if (!validEnvelope(envelope, known.room, Date.now())) return;
    if (!known.role) {
      ws.serializeAttachment({ room: known.room, role: envelope.from });
      await this.flushTo(envelope.from, ws);
    } else if (known.role !== envelope.from) return;
    const targets = this.targetsFor(ws, envelope);
    if (envelope.to !== "all" && envelope.deliveryId) {
      await this.queue(envelope.to, raw, envelope.deliveryId, envelope.expiresAt);
    }
    for (const target of targets) {
      try { target.send(raw); } catch { /* stale hibernating socket */ }
    }
    if (envelope.to === "phone" && envelope.wake === true) await this.sendWakePush().catch(() => {});
  }

  targetsFor(ws, envelope) {
    return this.state.getWebSockets().filter((socket) => socket !== ws).filter((socket) => {
      const attachment = socket.deserializeAttachment();
      return envelope.to === "all" || attachment?.role === envelope.to;
    });
  }

  async queue(role, raw, deliveryId, expiresAt) {
    const rawBytes = byteLength(raw);
    if (rawBytes > MAX_QUEUE_BYTES) return;
    const key = `q:${role}`;
    const now = Date.now();
    const queue = ((await this.state.storage.get(key)) ?? []).filter((item) => (item.expiresAt ?? now + DEFAULT_QUEUE_TTL_MS) > now);
    if (deliveryId && queue.some((item) => item.deliveryId === deliveryId)) return;
    queue.push({ raw, rawBytes, deliveryId, expiresAt: expiresAt ?? now + DEFAULT_QUEUE_TTL_MS });
    if (queue.length > HOLD_LIMIT) queue.splice(0, queue.length - HOLD_LIMIT);
    trimQueue(queue);
    await this.state.storage.put(key, queue);
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
        try { ws.send(item.raw); } catch { break; }
      }
      return;
    }
    const remaining = [];
    for (let index = 0; index < pending.length; index += 1) {
      const item = pending[index];
      const raw = typeof item === "string" ? item : item.raw;
      if (!raw) continue;
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
    return json({ ok: true, registered: request.method !== "DELETE", enabled: apnsConfigured(this.env), devices: tokens.length });
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

  tokensEqual(left, right) { return constantTimeEqual(left, right); }
  webSocketClose() {}
  webSocketError() {}
}

function trimQueue(queue) {
  const itemBytes = (item) => typeof item === "string" ? byteLength(item) : (item.rawBytes ?? byteLength(item.raw ?? ""));
  let total = queue.reduce((sum, item) => sum + itemBytes(item), 0);
  while (queue.length > 1 && total > MAX_QUEUE_BYTES) total -= itemBytes(queue.shift());
}
