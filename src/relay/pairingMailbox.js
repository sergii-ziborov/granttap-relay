import { json, readJsonLimited } from "./relaySupport.js";
import { validBase64 } from "./relayValidation.js";

const PAIR_TTL_MS = 15 * 60 * 1000;
const MAX_PAIRING_BODY_BYTES = 40_000;

export class GrantTapCodes {
  constructor(state) { this.state = state; }

  async fetch(request) {
    const mailbox = /^\/pair\/([a-f0-9]{32})$/.exec(new URL(request.url).pathname)?.[1];
    if (!mailbox) return json({ error: "bad mailbox" }, 400);
    if (request.method === "PUT" || request.method === "POST") return this.put(request);
    if (request.method === "GET") return this.get();
    return json({ error: "method not allowed" }, 405);
  }

  async put(request) {
    let body;
    try { body = await readJsonLimited(request, MAX_PAIRING_BODY_BYTES); } catch { return json({ error: "bounded JSON body required" }, 400); }
    if (!validBase64(body?.nonce, 32, 32) || !validBase64(body?.box, 24, 32_768)) {
      return json({ error: "canonical bounded base64 nonce and box required" }, 400);
    }
    if ((await this.state.storage.get("pairing"))?.expiresAt > Date.now()) return json({ error: "mailbox already occupied" }, 409);
    const expiresAt = Date.now() + PAIR_TTL_MS;
    await this.state.storage.put("pairing", { nonce: body.nonce, box: body.box, expiresAt });
    await this.state.storage.setAlarm(expiresAt);
    return json({ ok: true, expiresInSec: PAIR_TTL_MS / 1000 });
  }

  async get() {
    const item = await this.state.storage.get("pairing");
    if (!item || item.expiresAt <= Date.now()) {
      if (item) await this.state.storage.deleteAll();
      return json({ error: "unknown or expired mailbox" }, 404);
    }
    await this.state.storage.deleteAll();
    return json({ nonce: item.nonce, box: item.box });
  }

  async alarm() { await this.state.storage.deleteAll(); }
}
