import assert from "node:assert/strict";
import test from "node:test";
import { GrantTapRoom } from "../src/worker.js";

const room = "ab".repeat(16);
const credential = "cd".repeat(32);

function relayRoom() {
  const values = new Map();
  return new GrantTapRoom({ storage: {
    get: async (key) => values.get(key), put: async (key, value) => values.set(key, value), delete: async (key) => values.delete(key),
  } }, {});
}

function request(path, method, body) {
  return new Request(`https://relay.example${path}`, { method, headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" }, body: body == null ? undefined : JSON.stringify(body) });
}

test("approval browser capability rejects invalid methods, bodies, and decisions", async () => {
  const instance = relayRoom();
  const published = await instance.fetch(request(`/approvals?room=${room}`, "PUT", { requestId: "req-1", title: "Allow command" }));
  const { viewToken } = await published.json();
  const base = `/a/${room}/${viewToken}`;
  assert.equal((await instance.fetch(request(`${base}/json`, "POST"))).status, 405);
  assert.equal((await instance.fetch(request(`${base}/req-1/decide`, "GET"))).status, 405);
  assert.equal((await instance.fetch(request(`${base}/req-1/decide`, "POST", {}))).status, 400);
  assert.equal((await instance.fetch(request(`${base}/req-1/decide`, "POST", { decision: "maybe" }))).status, 400);
  assert.equal((await instance.fetch(request(`${base}/req-1/decide`, "POST", { decision: "allow" }))).status, 200);
  assert.equal((await instance.fetch(request(`${base}/req-1/decide`, "POST", { decision: "deny" }))).status, 404);
  assert.equal((await instance.fetch(request(`${base}/bad/decide`, "POST", { decision: "allow" }))).status, 404);
});

test("approval API validates room and request bodies while preserving non-pending records", async () => {
  const instance = relayRoom();
  assert.equal((await instance.fetch(request("/approvals?room=bad", "GET"))).status, 400);
  assert.equal((await instance.fetch(request(`/approvals?room=${room}`, "POST", {}))).status, 400);
  const published = await instance.fetch(request(`/approvals?room=${room}`, "POST", { requestId: "req-2", title: "Allow command" }));
  const { viewToken } = await published.json();
  assert.equal((await instance.fetch(request(`/a/${room}/${viewToken}`, "POST"))).status, 405);
  assert.equal((await instance.fetch(request(`/approvals?room=${room}&all=1`, "DELETE"))).status, 200);
  const listed = await instance.fetch(request(`/approvals?room=${room}`, "GET"));
  assert.equal((await listed.json()).approvals.length, 0);
  const repeated = await instance.ensureViewToken();
  assert.equal(repeated.token, viewToken);
});

test("approval API rejects missing JSON streams and capability token state", async () => {
  const instance = relayRoom();
  assert.equal((await instance.fetch(new Request(`https://relay.example/approvals?room=${room}`, { method: "PUT", headers: { authorization: `Bearer ${credential}` } }))).status, 400);
  assert.equal((await instance.fetch(new Request(`https://relay.example/a/${room}/${"ab".repeat(32)}`))).status, 401);
  const published = await instance.fetch(request(`/approvals?room=${room}`, "PUT", { requestId: "req-3", title: "Allow command" }));
  const { viewToken } = await published.json();
  assert.equal((await instance.fetch(new Request(`https://relay.example/a/${room}/${viewToken}/req-3/decide`, { method: "POST" }))).status, 400);
  assert.equal((await instance.fetch(request(`/approvals?room=${room}&requestId=req-3`, "DELETE"))).status, 200);
});

test("approval API retains completed entries on cancel-all and rejects invalid stored token records", async () => {
  const instance = relayRoom();
  const first = await instance.fetch(request(`/approvals?room=${room}`, "PUT", { requestId: "req-4", title: "Allow" }));
  const { viewToken } = await first.json();
  assert.equal((await instance.fetch(request(`/a/${room}/${viewToken}/req-4/decide`, "POST", { decision: "allow" }))).status, 200);
  assert.equal((await instance.fetch(request(`/approvals?room=${room}&all=1`, "DELETE"))).status, 200);
  const listed = await instance.fetch(request(`/approvals?room=${room}`, "GET"));
  assert.equal((await listed.json()).approvals[0].status, "allow");
  const invalidTokenRoom = relayRoom();
  invalidTokenRoom.state.storage.put("approvals:view", { token: "not-a-token" });
  assert.equal((await invalidTokenRoom.fetch(new Request(`https://relay.example/a/${room}/${"ab".repeat(32)}`))).status, 401);
});

test("approval capability rejects a valid-format token not owned by the room", async () => {
  const instance = relayRoom();
  const published = await instance.fetch(request(`/approvals?room=${room}`, "GET"));
  const { viewToken } = await published.json();
  assert.equal((await instance.fetch(new Request(`https://relay.example/a/${room}/${viewToken}/unknown/decide`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision: "allow" }) }))).status, 404);
});

test("approval capability serves its human page and JSON representation", async () => {
  const instance = relayRoom();
  const published = await instance.fetch(request(`/approvals?room=${room}`, "PUT", { requestId: "req-5", title: "Allow command" }));
  const { viewToken } = await published.json();
  const page = await instance.fetch(new Request(`https://relay.example/a/${room}/${viewToken}`));
  assert.equal(page.headers.get("content-type"), "text/html; charset=utf-8");
  assert.match(await page.text(), /GrantTap Approvals/);
  const document = await instance.fetch(new Request(`https://relay.example/a/${room}/${viewToken}/json`));
  assert.deepEqual((await document.json()).approvals.map((item) => item.requestId), ["req-5"]);
});
