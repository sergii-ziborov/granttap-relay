/**
 * GrantTap relay on Cloudflare Workers + Durable Objects.
 *
 * Same zero-knowledge contract as the Node dev relay: the worker reads only the
 * envelope's routing fields (room / from / to) and forwards opaque E2E-encrypted
 * bodies. Payloads never exist here in the clear.
 *
 *   wss://<host>/?room=<room>   WebSocket per pairing room (one DO per room)
 *   PUT/GET /pair/<CODE>        short-code pairing blobs (single use, 15 min)
 *   GET /health
 *
 * The room id rides in the URL because a Durable Object must be chosen before
 * the socket upgrades. WebSocket Hibernation keeps idle rooms free: a paired
 * machine can stay connected all day without billing for duration.
 */

const PAIR_TTL_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;
const HOLD_LIMIT = 100;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPT_SOURCES = 1000;
const DEFAULT_QUEUE_TTL_MS = 15 * 60 * 1000;
const PUSH_TOKEN_LIMIT = 8;
const PUSH_AUTH_KEY = "push:auth-sha256";
const PUSH_TOKENS_KEY = "push:tokens";

let cachedProviderToken = null;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") return json({ ok: true });

    const pair = /^\/pair\/([A-Za-z0-9]{4,16})$/.exec(url.pathname);
    if (pair) {
      // All codes live in one DO so "single use" is a real guarantee,
      // not an eventual-consistency hope.
      const stub = env.CODES.get(env.CODES.idFromName("codes"));
      return stub.fetch(request);
    }

    if (url.pathname === "/push/register" || url.pathname === "/push/status") {
      const room = url.searchParams.get("room");
      if (!room) return json({ error: "room query parameter required" }, 400);
      const stub = env.ROOM.get(env.ROOM.idFromName(room));
      return stub.fetch(request);
    }

    if ((request.headers.get("Upgrade") ?? "").toLowerCase() === "websocket") {
      const room = url.searchParams.get("room");
      if (!room) return json({ error: "room query parameter required" }, 400);
      const stub = env.ROOM.get(env.ROOM.idFromName(room));
      return stub.fetch(request);
    }

    return json({ error: "not found" }, 404);
  },
};

// ------------------------------------------------------------------ the room

export class GrantTapRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/push/register") return this.handlePushRegistration(request);
    if (url.pathname === "/push/status") return this.handlePushStatus(request);
    if ((request.headers.get("Upgrade") ?? "").toLowerCase() !== "websocket") {
      return json({ error: "expected websocket" }, 426);
    }
    const pair = new WebSocketPair();
    const room = url.searchParams.get("room");
    if (!room) return json({ error: "room query parameter required" }, 400);
    const auth = bearer(request);
    const expectedAuth = await this.state.storage.get(PUSH_AUTH_KEY);
    if (expectedAuth && (!auth || await sha256(auth) !== expectedAuth)) {
      return json({ error: "invalid room credential" }, 401);
    }
    // New pairings carry a relay-only random credential. The first authenticated
    // socket pins its hash; the E2EE payload keys remain unknown to the relay.
    if (!expectedAuth && auth) await this.state.storage.put(PUSH_AUTH_KEY, await sha256(auth));
    // Hibernation API: the DO can be evicted while sockets stay open.
    this.state.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({ room });
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== "string") return;
    let env;
    try {
      env = JSON.parse(raw);
    } catch {
      return;
    }
    if (env?.type === "relay.ack" && typeof env.deliveryId === "string") {
      const known = ws.deserializeAttachment() ?? {};
      if (known.role) await this.acknowledge(known.role, env.deliveryId);
      return;
    }
    if (!env || typeof env !== "object" || !env.room || !env.from || !env.to) return;
    if (env.expiresAt != null && env.expiresAt <= Date.now()) return;

    // The URL fixes the room before upgrade; the first packet fixes the role.
    const known = ws.deserializeAttachment() ?? {};
    const room = known.room ?? env.room; // backwards-compatible with pre-upgrade sockets
    if (env.room !== room) return;
    if (!known.role) {
      ws.serializeAttachment({ room, role: env.from });
      await this.flushTo(env.from, ws);
    } else if (known.role !== env.from) return;

    const targets = this.state
      .getWebSockets()
      .filter((s) => s !== ws)
      .filter((s) => {
        const att = s.deserializeAttachment();
        return env.to === "all" || att?.role === env.to;
      });

    if (env.to !== "all" && (targets.length === 0 || env.deliveryId)) {
      // Reliable envelopes stay queued until the recipient confirms successful
      // decryption. Legacy envelopes keep the previous send-or-queue behavior.
      await this.queue(env.to, raw, env.deliveryId, env.expiresAt);
    }

    for (const t of targets) {
      try {
        t.send(raw);
      } catch {
        /* stale socket; hibernation will reap it */
      }
    }
    if (env.to === "phone" && env.wake) {
      await this.sendWakePush(env.wake, env.deliveryId).catch(() => {});
    }
  }

  async queue(role, raw, deliveryId, expiresAt) {
    const key = `q:${role}`;
    const now = Date.now();
    const q = ((await this.state.storage.get(key)) ?? [])
      .filter((item) => (item.expiresAt ?? now + DEFAULT_QUEUE_TTL_MS) > now);
    if (deliveryId && q.some((item) => item.deliveryId === deliveryId)) return;
    q.push({ raw, deliveryId, expiresAt: expiresAt ?? now + DEFAULT_QUEUE_TTL_MS });
    if (q.length > HOLD_LIMIT) q.splice(0, q.length - HOLD_LIMIT);
    await this.state.storage.put(key, q);
  }

  async acknowledge(role, deliveryId) {
    const key = `q:${role}`;
    const q = (await this.state.storage.get(key)) ?? [];
    const remaining = q.filter((item) => item.deliveryId !== deliveryId);
    if (remaining.length) await this.state.storage.put(key, remaining);
    else await this.state.storage.delete(key);
  }

  async flushTo(role, ws) {
    const key = `q:${role}`;
    const q = await this.state.storage.get(key);
    if (!q?.length) return;
    const now = Date.now();
    const pending = q.filter((item) => {
      const expiresAt = typeof item === "string" ? now + DEFAULT_QUEUE_TTL_MS : item.expiresAt;
      return expiresAt > now;
    });
    const remaining = [];
    for (const item of pending) {
      const raw = typeof item === "string" ? item : item.raw;
      if (!raw) continue;
      try {
        ws.send(raw);
        // A delivery id requires an explicit decrypt acknowledgement. Legacy
        // queued items are removed after the successful socket send.
        if (typeof item !== "string" && item.deliveryId) remaining.push(item);
      } catch {
        remaining.push(item);
        break;
      }
    }
    if (remaining.length) await this.state.storage.put(key, remaining);
    else await this.state.storage.delete(key);
  }

  async handlePushRegistration(request) {
    const auth = bearer(request);
    if (!auth) return json({ error: "room credential required" }, 401);
    const digest = await sha256(auth);
    const expected = await this.state.storage.get(PUSH_AUTH_KEY);
    if (expected && expected !== digest) return json({ error: "invalid room credential" }, 401);
    if (!expected) await this.state.storage.put(PUSH_AUTH_KEY, digest);

    let body;
    try { body = await request.json(); } catch { body = {}; }
    const token = String(body.token ?? "").toLowerCase();
    if (!validDeviceToken(token)) return json({ error: "valid APNs token required" }, 400);
    const environment = body.environment === "sandbox" ? "sandbox" : "production";
    const bundleId = String(body.bundleId ?? "");
    if (bundleId !== "com.ziborov.granttap") return json({ error: "unexpected bundle id" }, 400);

    let tokens = (await this.state.storage.get(PUSH_TOKENS_KEY)) ?? [];
    if (request.method === "DELETE") {
      tokens = tokens.filter((item) => item.token !== token);
    } else if (request.method === "PUT" || request.method === "POST") {
      tokens = tokens.filter((item) => item.token !== token);
      tokens.push({ token, environment, bundleId, updatedAt: Date.now() });
      if (tokens.length > PUSH_TOKEN_LIMIT) tokens.splice(0, tokens.length - PUSH_TOKEN_LIMIT);
    } else {
      return json({ error: "method not allowed" }, 405);
    }
    if (tokens.length) await this.state.storage.put(PUSH_TOKENS_KEY, tokens);
    else await this.state.storage.delete(PUSH_TOKENS_KEY);
    return json({
      ok: true,
      registered: request.method !== "DELETE",
      enabled: apnsConfigured(this.env),
      devices: tokens.length,
    });
  }

  async handlePushStatus(request) {
    const auth = bearer(request);
    const expected = await this.state.storage.get(PUSH_AUTH_KEY);
    if (!auth || !expected || await sha256(auth) !== expected) {
      return json({ error: "invalid room credential" }, 401);
    }
    const tokens = (await this.state.storage.get(PUSH_TOKENS_KEY)) ?? [];
    return json({ enabled: apnsConfigured(this.env), devices: tokens.length });
  }

  async sendWakePush(kind, deliveryId) {
    if (!apnsConfigured(this.env)) return;
    const tokens = (await this.state.storage.get(PUSH_TOKENS_KEY)) ?? [];
    if (!tokens.length) return;
    const stale = new Set();
    await Promise.all(tokens.map(async (device) => {
      const result = await sendAPNs(this.env, device, kind, deliveryId);
      if (result.stale) stale.add(device.token);
    }));
    if (stale.size) {
      const remaining = tokens.filter((device) => !stale.has(device.token));
      if (remaining.length) await this.state.storage.put(PUSH_TOKENS_KEY, remaining);
      else await this.state.storage.delete(PUSH_TOKENS_KEY);
    }
  }

  webSocketClose() {}
  webSocketError() {}
}

function bearer(request) {
  const value = request.headers.get("Authorization") ?? "";
  return value.startsWith("Bearer ") ? value.slice(7).trim() : "";
}

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function validDeviceToken(token) {
  return /^[0-9a-f]{32,256}$/.test(token) && token.length % 2 === 0;
}

function apnsConfigured(env) {
  return Boolean(env?.APNS_TEAM_ID && env?.APNS_KEY_ID && env?.APNS_PRIVATE_KEY);
}

export function pushPayload(kind, deliveryId) {
  const approval = kind === "approval";
  return {
    aps: {
      alert: {
        title: "GrantTap",
        body: approval ? "Your agent is waiting for approval." : "A coding task has an update.",
      },
      sound: "default",
      "content-available": 1,
      "interruption-level": approval ? "time-sensitive" : "active",
      "thread-id": "granttap-agent",
      ...(approval ? { category: "GRANTTAP_APPROVAL" } : {}),
    },
    granttapWake: kind,
    ...(deliveryId ? { deliveryId, ...(approval ? { requestId: deliveryId } : {}) } : {}),
  };
}

async function sendAPNs(env, device, kind, deliveryId) {
  const providerToken = await apnsProviderToken(env);
  const host = device.environment === "sandbox"
    ? "https://api.sandbox.push.apple.com"
    : "https://api.push.apple.com";
  const response = await fetch(`${host}/3/device/${device.token}`, {
    method: "POST",
    headers: {
      authorization: `bearer ${providerToken}`,
      "apns-topic": device.bundleId,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "apns-expiration": String(Math.floor(Date.now() / 1000) + 180),
      "content-type": "application/json",
    },
    body: JSON.stringify(pushPayload(kind, deliveryId)),
  });
  let reason = "";
  if (!response.ok) {
    try { reason = String((await response.json()).reason ?? ""); } catch { /* no body */ }
  }
  return { ok: response.ok, stale: response.status === 410 || reason === "BadDeviceToken" || reason === "Unregistered" };
}

async function apnsProviderToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (cachedProviderToken?.team === env.APNS_TEAM_ID && cachedProviderToken?.key === env.APNS_KEY_ID
      && now - cachedProviderToken.issuedAt < 45 * 60) return cachedProviderToken.token;
  const header = base64url(JSON.stringify({ alg: "ES256", kid: env.APNS_KEY_ID }));
  const claims = base64url(JSON.stringify({ iss: env.APNS_TEAM_ID, iat: now }));
  const signingInput = `${header}.${claims}`;
  const pem = String(env.APNS_PRIVATE_KEY).replace(/\\n/g, "\n");
  const keyBytes = Uint8Array.from(
    atob(pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, "")),
    (character) => character.charCodeAt(0),
  );
  const key = await crypto.subtle.importKey(
    "pkcs8", keyBytes, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(signingInput),
  ));
  const token = `${signingInput}.${base64url(signature)}`;
  cachedProviderToken = { team: env.APNS_TEAM_ID, key: env.APNS_KEY_ID, issuedAt: now, token };
  return token;
}

function base64url(value) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ------------------------------------------------- short-code pairing parking

export class GrantTapCodes {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const code = /^\/pair\/([A-Za-z0-9]{4,16})$/.exec(url.pathname)?.[1]?.toUpperCase();
    if (!code) return json({ error: "bad code" }, 400);

    if (request.method === "PUT" || request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "json body required" }, 400);
      }
      if (!body?.nonce || !body?.box) return json({ error: "nonce and box required" }, 400);
      await this.state.storage.put(`c:${code}`, {
        nonce: body.nonce,
        box: body.box,
        expiresAt: Date.now() + PAIR_TTL_MS,
      });
      return json({ ok: true, expiresInSec: PAIR_TTL_MS / 1000 });
    }

    if (request.method === "GET") {
      // Rate limits are per source and expire. A stranger can no longer lock
      // pairing globally for every GrantTap installation with ten bad guesses.
      const source = request.headers.get("CF-Connecting-IP") ?? "local";
      const now = Date.now();
      const attemptTable = (await this.state.storage.get("attempts")) ?? {};
      for (const [key, value] of Object.entries(attemptTable)) {
        if (!value?.resetAt || value.resetAt <= now) delete attemptTable[key];
      }
      let attempts = attemptTable[source] ?? { count: 0, resetAt: now + ATTEMPT_WINDOW_MS };
      if (attempts.resetAt <= now) attempts = { count: 0, resetAt: now + ATTEMPT_WINDOW_MS };
      if (attempts.count >= MAX_ATTEMPTS) return json({ error: "too many attempts" }, 429);

      const item = await this.state.storage.get(`c:${code}`);
      if (!item || item.expiresAt <= Date.now()) {
        attempts.count += 1;
        attemptTable[source] = attempts;
        const sources = Object.entries(attemptTable);
        if (sources.length > MAX_ATTEMPT_SOURCES) {
          sources.sort((a, b) => a[1].resetAt - b[1].resetAt);
          for (const [key] of sources.slice(0, sources.length - MAX_ATTEMPT_SOURCES)) {
            delete attemptTable[key];
          }
        }
        await this.state.storage.put("attempts", attemptTable);
        return json({ error: "unknown or expired code" }, 404);
      }
      await this.state.storage.delete(`c:${code}`); // single use
      delete attemptTable[source];
      if (Object.keys(attemptTable).length) await this.state.storage.put("attempts", attemptTable);
      else await this.state.storage.delete("attempts");
      return json({ nonce: item.nonce, box: item.box });
    }

    return json({ error: "method not allowed" }, 405);
  }
}
