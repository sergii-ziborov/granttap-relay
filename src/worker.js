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
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    if ((request.headers.get("Upgrade") ?? "").toLowerCase() !== "websocket") {
      return json({ error: "expected websocket" }, 426);
    }
    const pair = new WebSocketPair();
    const room = new URL(request.url).searchParams.get("room");
    if (!room) return json({ error: "room query parameter required" }, 400);
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

    if (targets.length === 0 && env.to !== "all") {
      // Nobody home for that role — park it durably and deliver on connect.
      const key = `q:${env.to}`;
      const q = (await this.state.storage.get(key)) ?? [];
      q.push({ raw, expiresAt: env.expiresAt ?? Date.now() + DEFAULT_QUEUE_TTL_MS });
      if (q.length > HOLD_LIMIT) q.shift();
      await this.state.storage.put(key, q);
      return;
    }

    for (const t of targets) {
      try {
        t.send(raw);
      } catch {
        /* stale socket; hibernation will reap it */
      }
    }
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
    let sent = 0;
    for (const item of pending) {
      const raw = typeof item === "string" ? item : item.raw;
      if (!raw) { sent++; continue; }
      try {
        ws.send(raw);
        sent++;
      } catch {
        break;
      }
    }
    const remaining = pending.slice(sent);
    if (remaining.length) await this.state.storage.put(key, remaining);
    else await this.state.storage.delete(key);
  }

  webSocketClose() {}
  webSocketError() {}
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
