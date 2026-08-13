const TTL_MS = 5 * 60 * 1000;
const MAX_BODY_BYTES = 32_000;

export class GrantTapWebPairing {
  constructor(state) { this.state = state; }

  async fetch(request) {
    const id = /^\/web-pair\/([a-f0-9]{32})$/.exec(new URL(request.url).pathname)?.[1];
    if (!id) return json({ error: "bad challenge" }, 400);
    const existing = await this.state.storage.get("challenge");
    const now = Date.now();
    if (request.method === "PUT") return this.register(request, existing, now);
    if (!existing || existing.expiresAt <= now) {
      if (existing) await this.state.storage.deleteAll();
      return json({ error: "unknown or expired challenge" }, 404);
    }
    if (request.method === "POST") return this.approve(request, existing);
    if (request.method === "GET") return this.consume(request, existing);
    return json({ error: "method not allowed" }, 405);
  }

  async register(request, existing, now) {
    if (existing?.expiresAt > now) return json({ error: "challenge occupied" }, 409);
    const body = await boundedJson(request).catch(() => null);
    const origin = exactOrigin(body?.origin);
    if (!origin || request.headers.get("Origin") !== origin) {
      return json({ error: "exact allowed origin required" }, 403);
    }
    await this.state.storage.put("challenge", { origin, expiresAt: now + TTL_MS, sealed: null });
    await this.state.storage.setAlarm(now + TTL_MS);
    return json({ ok: true, expiresInSec: TTL_MS / 1000 }, 201);
  }

  async approve(request, existing) {
    if (existing.sealed) return json({ error: "challenge already approved" }, 409);
    const body = await boundedJson(request).catch(() => null);
    if (!validSealed(body, existing.origin)) return json({ error: "origin-bound ciphertext required" }, 403);
    await this.state.storage.put("challenge", { ...existing, sealed: body });
    return json({ ok: true });
  }

  async consume(request, existing) {
    if (request.headers.get("Origin") !== existing.origin) return json({ error: "origin mismatch" }, 403);
    if (!existing.sealed) return json({ status: "pending" }, 202);
    const sealed = existing.sealed;
    await this.state.storage.deleteAll();
    return json(sealed);
  }

  async alarm() { await this.state.storage.deleteAll(); }
}

function validSealed(body, origin) {
  return body?.origin === origin
    && typeof body.nonce === "string" && /^[A-Za-z0-9_-]{32}$/.test(body.nonce)
    && typeof body.box === "string" && body.box.length >= 1 && body.box.length <= 24_000
    && /^[A-Za-z0-9_-]+$/.test(body.box);
}

function exactOrigin(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    const local = ["localhost", "127.0.0.1"].includes(url.hostname);
    if ((url.protocol !== "https:" && !(local && url.protocol === "http:"))
        || url.origin !== value || url.username || url.password) return null;
    return url.origin;
  } catch { return null; }
}

async function boundedJson(request) {
  const length = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) throw new Error("too large");
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) throw new Error("too large");
  return JSON.parse(text);
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}
