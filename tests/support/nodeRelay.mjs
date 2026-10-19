import { createHmac } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { createRelayServer } from "../../src/node/server.js";
import { RelayStore } from "../../src/node/store.js";
import { createRelayLog } from "../../src/relay/relayLog.js";

export const room = `af927a60${"0".repeat(24)}`;
export const credential = "b".repeat(64);
const secret = Buffer.alloc(32, 7);

/** Starts a Node relay on a random loopback port; everything is torn down after the test. */
export async function startRelay(t, { managed = false, coolDowns, heartbeatIntervalMs, clientAccess, Store = RelayStore } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "granttap-policy-"));
  const env = {};
  if (managed) {
    const key = join(dir, "key");
    writeFileSync(key, secret, { mode: 0o600 });
    Object.assign(env, { MANAGED_ADMISSION_REQUIRED: "1", MANAGED_ADMISSION_KEY_PATH: key });
  }
  const lines = [];
  const raw = [];
  const store = new Store(join(dir, "relay.sqlite3"));
  const server = createRelayServer({ store, env, coolDowns, heartbeatIntervalMs, clientAccess,
    log: createRelayLog({ intervalMs: 0, write: (line) => { raw.push(line); lines.push(JSON.parse(line)); } }) });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const sockets = [];
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });
  const url = `ws://127.0.0.1:${server.address().port}/ws?room=${room}`;
  const headersFor = ({ key, ticket, control, autoPong } = {}) => ({ autoPong: autoPong ?? true, headers: {
    Authorization: `Bearer ${credential}`, ...(key ? { "X-GrantTap-Recipient-Key-Id": key } : {}),
    ...(ticket ? { "X-GrantTap-Admission": ticket } : {}), ...(control ? { "X-GrantTap-Recipient-Routing": "1" } : {}) } });

  async function connect(options) {
    const socket = new WebSocket(url, headersFor(options));
    sockets.push(socket);
    socket.received = [];
    socket.on("message", (value) => socket.received.push(JSON.parse(value.toString())));
    socket.on("error", () => {});
    await once(socket, "open");
    return socket;
  }

  function refusal(options) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, headersFor(options));
      sockets.push(socket);
      socket.on("error", () => {});
      socket.once("open", () => reject(new Error("upgrade was accepted")));
      socket.once("unexpected-response", (_request, response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          socket.terminate();
          resolve({ status: response.statusCode, retryAfter: response.headers["retry-after"],
            body: Buffer.concat(chunks).toString() });
        });
      });
    });
  }

  return { store, lines, raw, sockets, connect, refusal };
}

export function sign(claim) {
  const body = Buffer.from(JSON.stringify(claim)).toString("base64url");
  return `${body}.${createHmac("sha256", secret).update(`granttap-managed-v1.${body}`).digest("base64url")}`;
}

export function lease(overrides = {}) {
  return sign({ version: 1, accountId: "12345678-1234-4123-8123-123456789012",
    computerId: "22345678-1234-4123-8123-123456789012", publicKey: Buffer.alloc(32, 4).toString("base64"),
    room, expiresAt: Date.now() + 60_000, ...overrides });
}

export function envelope(from, to, { senderId = `${from}-test`, deliveryId, expiresAt, box } = {}) {
  return JSON.stringify({ v: 1, room, from, to, senderId, ...(deliveryId ? { deliveryId } : {}),
    ...(expiresAt ? { expiresAt } : {}), nonce: Buffer.alloc(24, 3).toString("base64"),
    box: box ?? Buffer.alloc(24, 4).toString("base64") });
}

export function closed(socket) {
  return once(socket, "close").then(([code, reason]) => ({ code, reason: reason.toString() }));
}

export function settle(ms = 80) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitUntil(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition timeout");
    await settle(10);
  }
}
