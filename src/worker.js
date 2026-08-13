/**
 * GrantTap relay on Cloudflare Workers + Durable Objects.
 *
 * Same zero-knowledge contract as the Node dev relay: the worker reads only the
 * envelope's routing fields (room / from / to) and forwards opaque E2E-encrypted
 * bodies. Payloads never exist here in the clear.
 *
 *   wss://<host>/?room=<room>   WebSocket per pairing room (one DO per room)
 *   PUT/GET /pair/<MAILBOX>     encrypted pairing blob (single use, 15 min)
 *   GET /health
 *   GET /  and /vault               phone-code vault login (GTW1 + AES-GCM)
 *   GET/PUT/DELETE /api/vault/:id   revisioned ciphertext vault (DO + KV mirror)
 *   PUT/GET/DELETE /approvals?room=  machine-managed visible Allow cards
 *   GET /a/<room>/<viewToken>       browser Accept/Decline page (not chat)
 *
 * The room id rides in the URL because a Durable Object must be chosen before
 * the socket upgrades. WebSocket Hibernation keeps idle rooms free: a paired
 * machine can stay connected all day without billing for duration.
 *
 * Approval cards are a deliberate expiring cleartext surface (command summary
 * + danger level) so Accept/Decline is not buried in notify text. The page URL
 * itself is a durable capability and must be protected like a secret.
 */

import {
  APPROVALS_ITEMS_KEY,
  APPROVALS_VIEW_KEY,
  MAX_APPROVAL_BODY_BYTES,
  applyDecision,
  approvalsPageHtml,
  htmlResponse,
  parseApprovalCard,
  pruneApprovals,
  publicCard,
  upsertApproval,
  validRequestId,
  validViewToken,
} from "./approvals.js";
import { handleVaultApi } from "./vaultApi.js";
import { vaultHtmlResponse } from "./vaultPage.js";

const PAIR_TTL_MS = 15 * 60 * 1000;
const WEB_PAIR_TTL_MS = 5 * 60 * 1000;
const HOLD_LIMIT = 100;
const DEFAULT_QUEUE_TTL_MS = 15 * 60 * 1000;
const PUSH_TOKEN_LIMIT = 8;
const PUSH_AUTH_KEY = "push:auth-sha256";
const PUSH_TOKENS_KEY = "push:tokens";
const MAX_WEBSOCKET_MESSAGE_BYTES = 32 * 1024 * 1024;
// One SQLite-backed Durable Object key/value is limited to 2 MB. Keep the
// complete retry queue below that boundary; larger envelopes remain live-only.
const MAX_QUEUE_BYTES = 1_800_000;
const MAX_PAIRING_BODY_BYTES = 40_000;
const MAX_PUSH_BODY_BYTES = 4_096;
const MAX_WEB_PAIR_BODY_BYTES = 32_000;
const MAX_ENVELOPE_TTL_MS = 25 * 60 * 60 * 1000;
const DEFAULT_APPROVAL_WEB_ORIGINS = new Set([
  "https://granttap.com",
  "https://www.granttap.com",
  "https://granttap-vault.lovable.app",
]);

let cachedProviderToken = null;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") return json({ ok: true });

    // WebSocket upgrades are GET with Upgrade: websocket. The vault HTML on `/`
    // must NOT steal those — Mac/phone pairings use wss://host/?room=… and a
    // vault response (HTTP 200 HTML) looks like "relay up" nowhere: clients
    // fail the handshake and sessions.status never reaches the phone.
    const isWebSocketUpgrade =
      (request.headers.get("Upgrade") ?? "").toLowerCase() === "websocket";

    if ((url.pathname === "/" || url.pathname === "/vault") && !isWebSocketUpgrade) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return json({ error: "method not allowed" }, 405);
      }
      return vaultHtmlResponse();
    }

    if (url.pathname.startsWith("/api/vault/")) {
      if (request.method === "OPTIONS") return vaultPreflight(request, env);
      const vaultId = /^\/api\/vault\/([a-f0-9]{64})$/.exec(url.pathname)?.[1];
      const response = vaultId && env?.VAULTS
        ? await env.VAULTS.get(env.VAULTS.idFromName(vaultId)).fetch(request)
        : await handleVaultApi(request, env);
      return withVaultCors(response, request, env);
    }

    const pair = /^\/pair\/([a-f0-9]{32})$/.exec(url.pathname);
    if (pair) {
      // One DO per unguessable mailbox gives atomic single-use reads without a
      // global hot object, and lets its alarm reclaim expired ciphertext.
      const stub = env.CODES.get(env.CODES.idFromName(pair[1]));
      return stub.fetch(request);
    }

    const webPair = /^\/web-pair\/([a-f0-9]{32})$/.exec(url.pathname);
    if (webPair) {
      if (request.method === "OPTIONS") return vaultPreflight(request, env);
      if (!env?.WEB_CODES) return withVaultCors(json({ error: "web pairing unavailable" }, 503), request, env);
      const stub = env.WEB_CODES.get(env.WEB_CODES.idFromName(webPair[1]));
      return withVaultCors(await stub.fetch(request), request, env);
    }

    if (url.pathname === "/push/register" || url.pathname === "/push/status") {
      const room = url.searchParams.get("room");
      if (!validRoom(room)) return json({ error: "valid room query parameter required" }, 400);
      const stub = env.ROOM.get(env.ROOM.idFromName(room));
      return stub.fetch(request);
    }

    if (url.pathname === "/approvals") {
      const room = url.searchParams.get("room");
      if (!validRoom(room)) return json({ error: "valid room query parameter required" }, 400);
      const stub = env.ROOM.get(env.ROOM.idFromName(room));
      return stub.fetch(request);
    }

    // Visible approval page: /a/<room>/<viewToken>[/json|/decide]
    const approvalPath = /^\/a\/([a-f0-9]{16,64})\/([a-f0-9]{64})(?:\/(json)|\/([A-Za-z0-9._-]{4,180})\/decide)?$/.exec(
      url.pathname,
    );
    if (approvalPath) {
      const room = approvalPath[1];
      if (request.method === "OPTIONS") return approvalPreflight(request, env);
      const stub = env.ROOM.get(env.ROOM.idFromName(room));
      const response = await stub.fetch(request);
      return withApprovalCors(response, request, env);
    }

    if (isWebSocketUpgrade) {
      const room = url.searchParams.get("room");
      if (!validRoom(room)) return json({ error: "valid room query parameter required" }, 400);
      const stub = env.ROOM.get(env.ROOM.idFromName(room));
      return stub.fetch(request);
    }

    return json({ error: "not found" }, 404);
  },
};

function approvalPreflight(request, env) {
  const origin = allowedApprovalOrigin(request, env);
  if (!origin) return json({ error: "origin not allowed" }, 403);
  const method = (request.headers.get("Access-Control-Request-Method") ?? "").toUpperCase();
  if (method !== "GET" && method !== "POST") {
    return withApprovalCors(json({ error: "method not allowed" }, 405), request, env);
  }
  const requestedHeaders = (request.headers.get("Access-Control-Request-Headers") ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (requestedHeaders.some((value) => value !== "content-type" && value !== "accept")) {
    return withApprovalCors(json({ error: "headers not allowed" }, 403), request, env);
  }
  return withApprovalCors(new Response(null, {
    status: 204,
    headers: { "cache-control": "no-store" },
  }), request, env, true);
}

function vaultPreflight(request, env) {
  const origin = allowedApprovalOrigin(request, env);
  if (!origin) return json({ error: "origin not allowed" }, 403);
  const method = (request.headers.get("Access-Control-Request-Method") ?? "").toUpperCase();
  if (!["GET", "PUT", "POST", "DELETE"].includes(method)) {
    return withApprovalCors(json({ error: "method not allowed" }, 405), request, env);
  }
  const requestedHeaders = (request.headers.get("Access-Control-Request-Headers") ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const allowedHeaders = new Set(["content-type", "accept", "if-match", "if-none-match"]);
  if (requestedHeaders.some((value) => !allowedHeaders.has(value))) {
    return withVaultCors(json({ error: "headers not allowed" }, 403), request, env);
  }
  return withVaultCors(new Response(null, {
    status: 204,
    headers: { "cache-control": "no-store" },
  }), request, env, true);
}

function withVaultCors(response, request, env, preflight = false) {
  const next = withApprovalCors(response, request, env, preflight);
  if (!allowedApprovalOrigin(request, env)) return next;
  next.headers.set("Access-Control-Expose-Headers", "ETag");
  if (preflight) {
    next.headers.set("Access-Control-Allow-Methods", "GET, PUT, POST, DELETE, OPTIONS");
    next.headers.set("Access-Control-Allow-Headers", "Content-Type, Accept, If-Match, If-None-Match");
  }
  return next;
}

function withApprovalCors(response, request, env, preflight = false) {
  const origin = allowedApprovalOrigin(request, env);
  if (!origin) return response;
  const next = new Response(response.body, response);
  next.headers.set("Access-Control-Allow-Origin", origin);
  appendVary(next.headers, "Origin");
  if (preflight) {
    next.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    next.headers.set("Access-Control-Allow-Headers", "Content-Type, Accept");
    next.headers.set("Access-Control-Max-Age", "600");
  }
  return next;
}

function allowedApprovalOrigin(request, env) {
  const raw = request.headers.get("Origin");
  if (!raw) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.origin !== raw || parsed.username || parsed.password) return null;
  const requestOrigin = new URL(request.url).origin;
  if (parsed.origin === requestOrigin || DEFAULT_APPROVAL_WEB_ORIGINS.has(parsed.origin)) {
    return parsed.origin;
  }
  if ((parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1")
      && (parsed.protocol === "http:" || parsed.protocol === "https:")) {
    return parsed.origin;
  }
  const configured = String(env?.GRANTTAP_WEB_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return configured.some((value) => {
    try {
      const candidate = new URL(value);
      return candidate.origin === value && candidate.origin === parsed.origin;
    } catch {
      return false;
    }
  }) ? parsed.origin : null;
}

function appendVary(headers, value) {
  const existing = (headers.get("Vary") ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (!existing.some((item) => item.toLowerCase() === value.toLowerCase())) existing.push(value);
  headers.set("Vary", existing.join(", "));
}

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
    if (url.pathname === "/approvals") return this.handleApprovalsApi(request);
    if (url.pathname.startsWith("/a/")) return this.handleApprovalsPage(request);
    if ((request.headers.get("Upgrade") ?? "").toLowerCase() !== "websocket") {
      return json({ error: "expected websocket" }, 426);
    }
    const pair = new WebSocketPair();
    const room = url.searchParams.get("room");
    if (!validRoom(room)) return json({ error: "valid room query parameter required" }, 400);
    const auth = bearer(request);
    if (!validRoomCredential(auth)) return json({ error: "room credential required" }, 401);
    const expectedAuth = await this.state.storage.get(PUSH_AUTH_KEY);
    const authDigest = await sha256(auth);
    if (expectedAuth && !constantTimeEqual(authDigest, expectedAuth)) {
      return json({ error: "invalid room credential" }, 401);
    }
    // New pairings carry a relay-only random credential. The first authenticated
    // socket pins its hash; the E2EE payload keys remain unknown to the relay.
    if (!expectedAuth) await this.state.storage.put(PUSH_AUTH_KEY, authDigest);
    // Hibernation API: the DO can be evicted while sockets stay open.
    this.state.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({ room });
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== "string") return;
    if (byteLength(raw) > MAX_WEBSOCKET_MESSAGE_BYTES) return;
    let env;
    try {
      env = JSON.parse(raw);
    } catch {
      return;
    }
    if (env?.type === "relay.ack" && validIdentifier(env.deliveryId, 180)) {
      const known = ws.deserializeAttachment() ?? {};
      if (known.role) await this.acknowledge(known.role, env.deliveryId);
      return;
    }
    // The URL fixes the room before upgrade; the first packet fixes the role.
    const known = ws.deserializeAttachment() ?? {};
    const room = known.room;
    if (!validEnvelope(env, room, Date.now())) return;
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
    if (env.to === "phone" && env.wake === true) {
      await this.sendWakePush().catch(() => {});
    }
  }

  async queue(role, raw, deliveryId, expiresAt) {
    const rawBytes = byteLength(raw);
    if (rawBytes > MAX_QUEUE_BYTES) return;
    const key = `q:${role}`;
    const now = Date.now();
    const q = ((await this.state.storage.get(key)) ?? [])
      .filter((item) => (item.expiresAt ?? now + DEFAULT_QUEUE_TTL_MS) > now);
    if (deliveryId && q.some((item) => item.deliveryId === deliveryId)) return;
    q.push({ raw, rawBytes, deliveryId, expiresAt: expiresAt ?? now + DEFAULT_QUEUE_TTL_MS });
    if (q.length > HOLD_LIMIT) q.splice(0, q.length - HOLD_LIMIT);
    const storedBytes = (item) => typeof item === "string"
      ? byteLength(item)
      : (item.rawBytes ?? byteLength(item.raw ?? ""));
    let totalBytes = q.reduce((total, item) => total + storedBytes(item), 0);
    while (q.length > 1 && totalBytes > MAX_QUEUE_BYTES) {
      const removed = q.shift();
      totalBytes -= storedBytes(removed);
    }
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
    for (let index = 0; index < pending.length; index += 1) {
      const item = pending[index];
      const raw = typeof item === "string" ? item : item.raw;
      if (!raw) continue;
      try {
        ws.send(raw);
        // A delivery id requires an explicit decrypt acknowledgement. Legacy
        // queued items are removed after the successful socket send.
        if (typeof item !== "string" && item.deliveryId) remaining.push(item);
      } catch {
        remaining.push(item);
        remaining.push(...pending.slice(index + 1));
        break;
      }
    }
    if (remaining.length) await this.state.storage.put(key, remaining);
    else await this.state.storage.delete(key);
  }

  async handlePushRegistration(request) {
    const auth = bearer(request);
    if (!validRoomCredential(auth)) return json({ error: "room credential required" }, 401);
    const digest = await sha256(auth);
    const expected = await this.state.storage.get(PUSH_AUTH_KEY);
    if (expected && !constantTimeEqual(digest, expected)) {
      return json({ error: "invalid room credential" }, 401);
    }
    if (!expected) await this.state.storage.put(PUSH_AUTH_KEY, digest);

    let body;
    try { body = await readJsonLimited(request, MAX_PUSH_BODY_BYTES); } catch { body = null; }
    if (!body) return json({ error: "bounded JSON body required" }, 400);
    const token = String(body.token ?? "").toLowerCase();
    if (!validDeviceToken(token)) return json({ error: "valid APNs token required" }, 400);
    if (body.environment !== "sandbox" && body.environment !== "production") {
      return json({ error: "environment must be sandbox or production" }, 400);
    }
    const environment = body.environment;
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
    if (!validRoomCredential(auth) || !expected
        || !constantTimeEqual(await sha256(auth), expected)) {
      return json({ error: "invalid room credential" }, 401);
    }
    const tokens = (await this.state.storage.get(PUSH_TOKENS_KEY)) ?? [];
    return json({ enabled: apnsConfigured(this.env), devices: tokens.length });
  }

  async sendWakePush() {
    if (!apnsConfigured(this.env)) return;
    const tokens = (await this.state.storage.get(PUSH_TOKENS_KEY)) ?? [];
    if (!tokens.length) return;
    const stale = new Set();
    await Promise.all(tokens.map(async (device) => {
      const result = await sendAPNs(this.env, device);
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

  /** Machine: publish / list / cancel visible approvals (Bearer room credential). */
  async handleApprovalsApi(request) {
    const url = new URL(request.url);
    const room = url.searchParams.get("room");
    if (!validRoom(room)) return json({ error: "valid room query parameter required" }, 400);
    const authOk = await this.requireRoomAuth(request);
    if (authOk) return authOk;

    if (request.method === "GET") {
      const items = pruneApprovals(await this.state.storage.get(APPROVALS_ITEMS_KEY));
      const view = await this.ensureViewToken();
      return json({
        ok: true,
        pageUrl: approvalsPageUrl(url, room, view.token),
        viewToken: view.token,
        approvals: items.map(publicCard),
      });
    }

    if (request.method === "PUT" || request.method === "POST") {
      let body;
      try {
        body = await readJsonLimited(request, MAX_APPROVAL_BODY_BYTES);
      } catch {
        return json({ error: "bounded JSON body required" }, 400);
      }
      const parsed = parseApprovalCard(body);
      if (parsed.error) return json({ error: parsed.error }, 400);
      const items = upsertApproval(await this.state.storage.get(APPROVALS_ITEMS_KEY), parsed.card);
      await this.state.storage.put(APPROVALS_ITEMS_KEY, items);
      const view = await this.ensureViewToken();
      return json({
        ok: true,
        pageUrl: approvalsPageUrl(url, room, view.token),
        viewToken: view.token,
        approval: publicCard(parsed.card),
      });
    }

    if (request.method === "DELETE") {
      const requestId = url.searchParams.get("requestId");
      const cancelAll = url.searchParams.get("all") === "1";
      let items = pruneApprovals(await this.state.storage.get(APPROVALS_ITEMS_KEY));
      if (cancelAll) {
        items = items.filter((item) => item.status !== "pending");
      } else if (validRequestId(requestId)) {
        items = items.filter((item) => item.requestId !== requestId);
      } else {
        return json({ error: "requestId or all=1 required" }, 400);
      }
      if (items.length) await this.state.storage.put(APPROVALS_ITEMS_KEY, items);
      else await this.state.storage.delete(APPROVALS_ITEMS_KEY);
      return json({ ok: true });
    }

    return json({ error: "method not allowed" }, 405);
  }

  /** Browser: HTML page / JSON / Accept-Decline via view token (no room Bearer). */
  async handleApprovalsPage(request) {
    const url = new URL(request.url);
    const match = /^\/a\/([a-f0-9]{16,64})\/([a-f0-9]{64})(?:\/(json)|\/([A-Za-z0-9._-]{4,180})\/decide)?$/.exec(
      url.pathname,
    );
    if (!match) return json({ error: "not found" }, 404);
    const room = match[1];
    const viewToken = match[2];
    const isJson = match[3] === "json";
    const decideId = match[4];
    if (!validViewToken(viewToken)) return json({ error: "invalid view token" }, 401);

    const stored = await this.state.storage.get(APPROVALS_VIEW_KEY);
    if (!stored?.token || !constantTimeEqual(stored.token, viewToken)) {
      return json({ error: "invalid view token" }, 401);
    }

    if (decideId) {
      if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
      let body;
      try {
        body = await readJsonLimited(request, MAX_APPROVAL_BODY_BYTES);
      } catch {
        return json({ error: "bounded JSON body required" }, 400);
      }
      const decision = body?.decision === "allow" || body?.decision === "deny"
        ? body.decision
        : null;
      if (!decision) return json({ error: "decision must be allow or deny" }, 400);
      if (!validRequestId(decideId)) return json({ error: "invalid requestId" }, 400);
      const applied = applyDecision(
        await this.state.storage.get(APPROVALS_ITEMS_KEY),
        decideId,
        decision,
        "web",
      );
      if (!applied.found) return json({ error: "approval not pending" }, 404);
      await this.state.storage.put(APPROVALS_ITEMS_KEY, applied.items);
      return json({ ok: true, requestId: decideId, decision });
    }

    const items = pruneApprovals(await this.state.storage.get(APPROVALS_ITEMS_KEY));
    if (isJson) {
      if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
      return json({ ok: true, approvals: items.map(publicCard) });
    }
    if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
    return htmlResponse(approvalsPageHtml(room, viewToken));
  }

  async requireRoomAuth(request) {
    const auth = bearer(request);
    if (!validRoomCredential(auth)) return json({ error: "room credential required" }, 401);
    const digest = await sha256(auth);
    const expected = await this.state.storage.get(PUSH_AUTH_KEY);
    if (expected && !constantTimeEqual(digest, expected)) {
      return json({ error: "invalid room credential" }, 401);
    }
    if (!expected) await this.state.storage.put(PUSH_AUTH_KEY, digest);
    return null;
  }

  async ensureViewToken() {
    const existing = await this.state.storage.get(APPROVALS_VIEW_KEY);
    if (existing?.token && validViewToken(existing.token)) return existing;
    const token = randomHex(32);
    const view = { token, createdAt: Date.now() };
    await this.state.storage.put(APPROVALS_VIEW_KEY, view);
    return view;
  }
}

/** Strongly ordered CAS coordinator; only opaque vault envelopes enter storage. */
export class GrantTapVault {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  fetch(request) {
    return handleVaultApi(request, this.env, this.state.storage);
  }
}

function approvalsPageUrl(url, room, viewToken) {
  return `${url.origin}/a/${room}/${viewToken}`;
}

function randomHex(bytes) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return [...arr].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function bearer(request) {
  const value = request.headers.get("Authorization") ?? "";
  return value.startsWith("Bearer ") ? value.slice(7).trim() : "";
}

export function validRoom(room) {
  return typeof room === "string" && /^[a-f0-9]{16,64}$/.test(room);
}

export function validRoomCredential(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function validIdentifier(value, max) {
  return typeof value === "string" && value.length >= 1 && value.length <= max;
}

export function validEnvelope(env, room, now = Date.now()) {
  if (!env || typeof env !== "object" || env.v !== 1 || env.room !== room) return false;
  if (env.from !== "machine" && env.from !== "phone") return false;
  if (env.to !== "machine" && env.to !== "phone" && env.to !== "all") return false;
  if (!validIdentifier(env.senderId, 180)) return false;
  if (env.deliveryId != null && !validIdentifier(env.deliveryId, 180)) return false;
  if (env.wake != null && typeof env.wake !== "boolean") return false;
  if (env.expiresAt != null && (!Number.isSafeInteger(env.expiresAt)
      || env.expiresAt <= now || env.expiresAt > now + MAX_ENVELOPE_TTL_MS)) return false;
  if (typeof env.nonce !== "string" || !/^[A-Za-z0-9+/]{32}$/.test(env.nonce)) return false;
  if (typeof env.box !== "string" || env.box.length < 24
      || !/^[A-Za-z0-9+/]+={0,2}$/.test(env.box)) return false;
  return true;
}

function byteLength(value) {
  return new TextEncoder().encode(value).byteLength;
}

async function readJsonLimited(request, maxBytes) {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("body too large");
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maxBytes) {
      await reader.cancel();
      throw new Error("body too large");
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(merged));
}

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string" || left.length !== right.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

export function validDeviceToken(token) {
  return /^[0-9a-f]{32,256}$/.test(token) && token.length % 2 === 0;
}

function apnsConfigured(env) {
  return Boolean(env?.APNS_TEAM_ID && env?.APNS_KEY_ID && env?.APNS_PRIVATE_KEY);
}

/** Alert + content-available: visible when backgrounded/killed (silent alone cannot relaunch after force-quit). No task ciphertext. */
export function pushPayload() {
  return {
    aps: {
      alert: {
        title: "GrantTap",
        body: "An agent is waiting for an authenticated decision.",
      },
      sound: "default",
      "content-available": 1,
      "interruption-level": "time-sensitive",
    },
    granttapWake: true,
  };
}

async function sendAPNs(env, device) {
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
      "apns-collapse-id": "granttap-wake",
      "content-type": "application/json",
    },
    body: JSON.stringify(pushPayload()),
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

// ------------------------------------------------ secure pairing mailbox parking

export class GrantTapCodes {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const mailbox = /^\/pair\/([a-f0-9]{32})$/.exec(url.pathname)?.[1];
    if (!mailbox) return json({ error: "bad mailbox" }, 400);

    if (request.method === "PUT" || request.method === "POST") {
      let body;
      try {
        body = await readJsonLimited(request, MAX_PAIRING_BODY_BYTES);
      } catch {
        return json({ error: "bounded JSON body required" }, 400);
      }
      if (!validBase64(body?.nonce, 32, 32) || !validBase64(body?.box, 24, 32_768)) {
        return json({ error: "canonical bounded base64 nonce and box required" }, 400);
      }
      const existing = await this.state.storage.get("pairing");
      if (existing?.expiresAt > Date.now()) {
        return json({ error: "mailbox already occupied" }, 409);
      }
      await this.state.storage.put("pairing", {
        nonce: body.nonce,
        box: body.box,
        expiresAt: Date.now() + PAIR_TTL_MS,
      });
      await this.state.storage.setAlarm(Date.now() + PAIR_TTL_MS);
      return json({ ok: true, expiresInSec: PAIR_TTL_MS / 1000 });
    }

    if (request.method === "GET") {
      const item = await this.state.storage.get("pairing");
      if (!item || item.expiresAt <= Date.now()) {
        if (item) await this.state.storage.deleteAll();
        return json({ error: "unknown or expired mailbox" }, 404);
      }
      await this.state.storage.deleteAll(); // atomically consumed; alarm included
      return json({ nonce: item.nonce, box: item.box });
    }

    return json({ error: "method not allowed" }, 405);
  }

  async alarm() {
    await this.state.storage.deleteAll();
  }
}

export class GrantTapWebPairing {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const challenge = /^\/web-pair\/([a-f0-9]{32})$/.exec(new URL(request.url).pathname)?.[1];
    if (!challenge) return json({ error: "bad challenge" }, 400);
    const existing = await this.state.storage.get("challenge");
    const now = Date.now();

    if (request.method === "PUT") {
      if (existing?.expiresAt > now) return json({ error: "challenge occupied" }, 409);
      let body;
      try { body = await readJsonLimited(request, MAX_WEB_PAIR_BODY_BYTES); } catch { body = null; }
      const origin = exactWebOrigin(body?.origin);
      if (!origin || request.headers.get("Origin") !== origin) {
        return json({ error: "exact allowed origin required" }, 403);
      }
      await this.state.storage.put("challenge", {
        origin,
        expiresAt: now + WEB_PAIR_TTL_MS,
        sealed: null,
      });
      await this.state.storage.setAlarm(now + WEB_PAIR_TTL_MS);
      return json({ ok: true, expiresInSec: WEB_PAIR_TTL_MS / 1000 }, 201);
    }

    if (!existing || existing.expiresAt <= now) {
      if (existing) await this.state.storage.deleteAll();
      return json({ error: "unknown or expired challenge" }, 404);
    }

    if (request.method === "POST") {
      if (existing.sealed) return json({ error: "challenge already approved" }, 409);
      let body;
      try { body = await readJsonLimited(request, MAX_WEB_PAIR_BODY_BYTES); } catch { body = null; }
      if (body?.origin !== existing.origin
          || typeof body?.nonce !== "string" || !/^[A-Za-z0-9_-]{32}$/.test(body.nonce)
          || typeof body?.box !== "string" || body.box.length < 1 || body.box.length > 24_000
          || !/^[A-Za-z0-9_-]+$/.test(body.box)) {
        return json({ error: "origin-bound ciphertext required" }, 403);
      }
      await this.state.storage.put("challenge", { ...existing, sealed: body });
      return json({ ok: true });
    }

    if (request.method === "GET") {
      if (request.headers.get("Origin") !== existing.origin) {
        return json({ error: "origin mismatch" }, 403);
      }
      if (!existing.sealed) return json({ status: "pending" }, 202);
      const sealed = existing.sealed;
      await this.state.storage.deleteAll();
      return json(sealed);
    }
    return json({ error: "method not allowed" }, 405);
  }

  async alarm() { await this.state.storage.deleteAll(); }
}

function exactWebOrigin(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    const local = ["localhost", "127.0.0.1"].includes(url.hostname);
    if ((url.protocol !== "https:" && !(local && url.protocol === "http:"))
        || url.origin !== value || url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function validBase64(value, minLength, maxLength) {
  if (typeof value !== "string" || value.length < minLength || value.length > maxLength
      || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  try {
    return btoa(atob(value)) === value;
  } catch {
    return false;
  }
}
