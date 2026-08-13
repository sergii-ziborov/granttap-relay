import assert from "node:assert/strict";
import test from "node:test";
import worker, { GrantTapRoom } from "../src/worker.js";

function roomBinding(onFetch) {
  return { ROOM: { idFromName: (name) => name, get: () => ({ fetch: onFetch }) } };
}

test("worker routes approval APIs and page capability to a room DO", async () => {
  const room = "ab".repeat(16);
  let forwarded = null;
  const env = roomBinding((request) => {
    forwarded = new URL(request.url).pathname;
    return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
  });
  const api = await worker.fetch(new Request(`https://relay.example/approvals?room=${room}`, { method: "GET" }), env);
  assert.equal(api.status, 200);
  assert.equal(forwarded, "/approvals");
  const page = await worker.fetch(new Request(`https://relay.example/a/${room}/${"ef".repeat(32)}`), env);
  assert.equal(page.status, 200);
  assert.equal(forwarded, `/a/${room}/${"ef".repeat(32)}`);
});

test("approval capability endpoints expose strict browser CORS", async () => {
  const room = "ab".repeat(16);
  const token = "ef".repeat(32);
  let forwarded = 0;
  const env = {
    GRANTTAP_WEB_ORIGINS: "https://preview.example,not-a-url",
    ...roomBinding(() => {
      forwarded += 1;
      return new Response(JSON.stringify({ ok: true, approvals: [] }), { headers: { "content-type": "application/json", vary: "Accept-Encoding" } });
    }),
  };
  const page = `https://relay.example/a/${room}/${token}/json`;
  for (const origin of ["http://127.0.0.1:4173", "https://granttap-vault.lovable.app", "https://preview.example"]) {
    const response = await worker.fetch(new Request(page, { headers: { origin } }), env);
    assert.equal(response.headers.get("access-control-allow-origin"), origin);
  }
  const foreign = await worker.fetch(new Request(page, { headers: { origin: "https://attacker.example" } }), env);
  assert.equal(foreign.status, 200);
  assert.equal(foreign.headers.get("access-control-allow-origin"), null);
  const beforePreflight = forwarded;
  const preflight = await worker.fetch(new Request(page, { method: "OPTIONS", headers: {
    origin: "https://granttap-vault.lovable.app", "access-control-request-method": "POST", "access-control-request-headers": "content-type",
  } }), env);
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "https://granttap-vault.lovable.app");
  assert.match(preflight.headers.get("vary") ?? "", /Origin/);
  assert.equal(forwarded, beforePreflight);
  const denied = await worker.fetch(new Request(page, { method: "OPTIONS", headers: { origin: "https://attacker.example", "access-control-request-method": "POST" } }), env);
  assert.equal(denied.status, 403);
});

test("encrypted vault API exposes strict product-origin CORS", async () => {
  const vaultId = "ab".repeat(32);
  const calls = [];
  const env = { VAULTS: { idFromName: (name) => name, get: (id) => ({ fetch: async (request) => {
    calls.push({ id, url: request.url });
    return new Response(JSON.stringify({ error: "vault not found" }), { status: 404, headers: { "content-type": "application/json" } });
  } }) } };
  const url = `https://relay.example/api/vault/${vaultId}`;
  const preflight = await worker.fetch(new Request(url, { method: "OPTIONS", headers: {
    origin: "https://granttap-vault.lovable.app", "access-control-request-method": "PUT", "access-control-request-headers": "content-type,if-match,if-none-match",
  } }), env);
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get("access-control-allow-headers") ?? "", /If-None-Match/);
  const get = await worker.fetch(new Request(url, { headers: { origin: "https://granttap-vault.lovable.app" } }), env);
  assert.equal(get.status, 404);
  assert.equal(get.headers.get("access-control-expose-headers"), "ETag");
  assert.deepEqual(calls, [{ id: vaultId, url }]);
});

test("room DO publishes, decides, lists, and cancels approvals", async () => {
  const room = "ab".repeat(16);
  const credential = "cd".repeat(32);
  const values = new Map();
  const storage = { get: async (key) => values.get(key), put: async (key, value) => values.set(key, value), delete: async (key) => values.delete(key) };
  const relayRoom = new GrantTapRoom({ storage }, {});
  const publish = await relayRoom.fetch(new Request(`https://relay.example/approvals?room=${room}`, { method: "PUT", headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" }, body: JSON.stringify({ requestId: "req-42", title: "Allow shell", command: "rm -rf /tmp/x", danger: "destructive", agent: "cursor" }) }));
  assert.equal(publish.status, 200);
  const published = await publish.json();
  assert.match(published.pageUrl, new RegExp(`/a/${room}/[a-f0-9]{64}$`));
  const decide = await relayRoom.fetch(new Request(`https://relay.example/a/${room}/${published.viewToken}/req-42/decide`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision: "deny" }) }));
  assert.deepEqual(await decide.json(), { ok: true, requestId: "req-42", decision: "deny" });
  const listed = await relayRoom.fetch(new Request(`https://relay.example/approvals?room=${room}`, { headers: { authorization: `Bearer ${credential}` } }));
  assert.equal((await listed.json()).approvals[0].status, "deny");
  const deleted = await relayRoom.fetch(new Request(`https://relay.example/approvals?room=${room}&requestId=req-42`, { method: "DELETE", headers: { authorization: `Bearer ${credential}` } }));
  assert.equal(deleted.status, 200);
  const invalidToken = await relayRoom.fetch(new Request(`https://relay.example/a/${room}/${"00".repeat(32)}`));
  assert.equal(invalidToken.status, 401);
});
