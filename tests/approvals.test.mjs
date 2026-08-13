import assert from "node:assert/strict";
import test from "node:test";
import {
  applyDecision,
  normalizeDanger,
  parseApprovalCard,
  pruneApprovals,
  publicCard,
  upsertApproval,
  validViewToken,
  approvalsPageHtml,
} from "../src/approvals.js";
import worker, { GrantTapRoom } from "../src/worker.js";

test("danger normalization and card parse", () => {
  assert.equal(normalizeDanger("destructive"), "destructive");
  assert.equal(normalizeDanger("nope"), "caution");
  assert.equal(normalizeDanger(null), "caution");
  assert.equal(validViewToken("ab".repeat(32)), true);
  assert.equal(validViewToken("short"), false);

  const parsed = parseApprovalCard({
    requestId: "req-1",
    title: "Allow shell",
    command: "rm -rf /tmp/x",
    danger: "destructive",
    agent: "cursor",
    cwd: "/tmp",
    tool: "Shell",
    sessionId: "sess",
    batchId: "batch",
    ttlMs: 30_000,
    createdAt: 123,
  });
  assert.equal(parsed.card.danger, "destructive");
  assert.equal(parsed.card.status, "pending");
  assert.equal(parsed.card.cwd, "/tmp");
  assert.equal(parseApprovalCard({}).error, "valid requestId required");
  assert.equal(parseApprovalCard(null).error, "JSON body required");
  assert.equal(
    parseApprovalCard({ requestId: "req-2", title: "" }).error,
    "title required (≤800 chars)",
  );
  const clamped = parseApprovalCard({
    requestId: "req-3",
    title: "ok",
    ttlMs: 999_999_999,
  });
  assert.ok(clamped.card.expiresAt - Date.now() <= 60 * 60 * 1000 + 50);
});

test("upsert prune and decide", () => {
  const now = Date.now();
  let items = [];
  items = upsertApproval(items, {
    requestId: "a",
    danger: "safe",
    title: "t",
    agent: "cursor",
    createdAt: now,
    expiresAt: now + 60_000,
    status: "pending",
  }, now);
  items = upsertApproval(items, {
    requestId: "a",
    danger: "caution",
    title: "t2",
    agent: "cursor",
    createdAt: now,
    expiresAt: now + 60_000,
    status: "pending",
  }, now);
  assert.equal(items.length, 1);
  assert.equal(items[0].danger, "caution");

  const decided = applyDecision(items, "a", "allow", "web", now);
  assert.equal(decided.found, true);
  assert.equal(decided.items[0].status, "allow");
  assert.equal(publicCard(decided.items[0]).decidedBy, "web");
  assert.equal(publicCard({ ...decided.items[0], command: null, cwd: null }).command, null);

  assert.equal(pruneApprovals([{ requestId: "old", expiresAt: now - 1 }], now).length, 0);
  assert.equal(pruneApprovals(null, now).length, 0);
  assert.equal(pruneApprovals([null, { requestId: "x", expiresAt: now + 1 }], now).length, 1);
  assert.equal(applyDecision(items, "missing", "deny", "web", now).found, false);
  assert.equal(
    applyDecision(
      [{ requestId: "a", status: "allow", expiresAt: now + 1 }],
      "a",
      "deny",
      "web",
      now,
    ).found,
    false,
  );
});

test("approvals page html is a visible Allow surface", () => {
  const html = approvalsPageHtml("ab".repeat(16), "cd".repeat(32));
  assert.match(html, /GrantTap Approvals/);
  assert.match(html, /Accept/);
  assert.match(html, /Decline/);
  assert.match(html, /not a chat message/i);
  assert.match(html, /waiting for computer confirmation/i);
  assert.doesNotMatch(html, /st\.textContent=decision==="allow"\?"Accepted"/);
});

test("worker routes /approvals and /a to room DO", async () => {
  const room = "ab".repeat(16);
  let forwarded = null;
  const env = {
    ROOM: {
      idFromName: (name) => name,
      get: () => ({
        fetch: (request) => {
          forwarded = new URL(request.url).pathname;
          return new Response(JSON.stringify({ ok: true }), {
            headers: { "content-type": "application/json" },
          });
        },
      }),
    },
  };

  const api = await worker.fetch(
    new Request(`https://relay.example/approvals?room=${room}`, { method: "GET" }),
    env,
  );
  assert.equal(api.status, 200);
  assert.equal(forwarded, "/approvals");

  const page = await worker.fetch(
    new Request(`https://relay.example/a/${room}/${"ef".repeat(32)}`),
    env,
  );
  assert.equal(page.status, 200);
  assert.equal(forwarded, `/a/${room}/${"ef".repeat(32)}`);
});

test("approval capability endpoints expose strict browser CORS", async () => {
  const room = "ab".repeat(16);
  const token = "ef".repeat(32);
  let forwarded = 0;
  const env = {
    GRANTTAP_WEB_ORIGINS: "https://preview.example,not-a-url",
    ROOM: {
      idFromName: (name) => name,
      get: () => ({
        fetch: () => {
          forwarded += 1;
          return new Response(JSON.stringify({ ok: true, approvals: [] }), {
            headers: { "content-type": "application/json", vary: "Accept-Encoding" },
          });
        },
      }),
    },
  };
  const page = `https://relay.example/a/${room}/${token}/json`;

  const local = await worker.fetch(new Request(page, {
    headers: { origin: "http://127.0.0.1:4173" },
  }), env);
  assert.equal(local.headers.get("access-control-allow-origin"), "http://127.0.0.1:4173");
  assert.match(local.headers.get("vary") ?? "", /Accept-Encoding/);
  assert.match(local.headers.get("vary") ?? "", /Origin/);

  const lovable = await worker.fetch(new Request(page, {
    headers: { origin: "https://granttap-vault.lovable.app" },
  }), env);
  assert.equal(
    lovable.headers.get("access-control-allow-origin"),
    "https://granttap-vault.lovable.app",
  );

  const configured = await worker.fetch(new Request(page, {
    headers: { origin: "https://preview.example" },
  }), env);
  assert.equal(configured.headers.get("access-control-allow-origin"), "https://preview.example");

  const foreign = await worker.fetch(new Request(page, {
    headers: { origin: "https://attacker.example" },
  }), env);
  assert.equal(foreign.status, 200);
  assert.equal(foreign.headers.get("access-control-allow-origin"), null);

  const beforePreflight = forwarded;
  const preflight = await worker.fetch(new Request(page, {
    method: "OPTIONS",
    headers: {
      origin: "https://granttap-vault.lovable.app",
      "access-control-request-method": "POST",
      "access-control-request-headers": "content-type",
    },
  }), env);
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "https://granttap-vault.lovable.app");
  assert.match(preflight.headers.get("access-control-allow-methods") ?? "", /POST/);
  assert.equal(forwarded, beforePreflight);

  const denied = await worker.fetch(new Request(page, {
    method: "OPTIONS",
    headers: {
      origin: "https://attacker.example",
      "access-control-request-method": "POST",
    },
  }), env);
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get("access-control-allow-origin"), null);
});

test("encrypted vault API exposes the same strict product-origin CORS", async () => {
  const vaultId = "ab".repeat(32);
  const calls = [];
  const env = {
    VAULTS: {
      idFromName: (name) => name,
      get: (id) => ({
        fetch: async (request) => {
          calls.push({ id, url: request.url });
          return new Response(JSON.stringify({ error: "vault not found" }), {
            status: 404,
            headers: { "content-type": "application/json" },
          });
        },
      }),
    },
  };
  const url = `https://relay.example/api/vault/${vaultId}`;
  const preflight = await worker.fetch(new Request(url, {
    method: "OPTIONS",
    headers: {
      origin: "https://granttap-vault.lovable.app",
      "access-control-request-method": "PUT",
      "access-control-request-headers": "content-type,if-match,if-none-match",
    },
  }), env);
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "https://granttap-vault.lovable.app");
  assert.match(preflight.headers.get("access-control-allow-methods") ?? "", /PUT/);
  assert.match(preflight.headers.get("access-control-allow-headers") ?? "", /If-Match/);
  assert.match(preflight.headers.get("access-control-allow-headers") ?? "", /If-None-Match/);

  const get = await worker.fetch(new Request(url, {
    headers: { origin: "https://granttap-vault.lovable.app" },
  }), env);
  assert.equal(get.status, 404);
  assert.equal(get.headers.get("access-control-allow-origin"), "https://granttap-vault.lovable.app");
  assert.equal(get.headers.get("access-control-expose-headers"), "ETag");
  assert.deepEqual(calls, [{ id: vaultId, url }]);

  const denied = await worker.fetch(new Request(url, {
    method: "OPTIONS",
    headers: {
      origin: "https://attacker.example",
      "access-control-request-method": "PUT",
    },
  }), env);
  assert.equal(denied.status, 403);
  assert.equal(calls.length, 1);
});

test("room DO publish + view-token decide", async () => {
  const room = "ab".repeat(16);
  const pushAuth = "cd".repeat(32);
  const values = new Map();
  const storage = {
    get: async (key) => values.get(key),
    put: async (key, value) => values.set(key, value),
    delete: async (key) => values.delete(key),
  };
  const roomDo = new GrantTapRoom({ storage }, {});

  const put = await roomDo.fetch(new Request(`https://relay.example/approvals?room=${room}`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${pushAuth}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      requestId: "req-42",
      title: "Allow Cursor shell: rm -rf /tmp/x",
      command: "rm -rf /tmp/x",
      danger: "destructive",
      agent: "cursor",
      tool: "Shell",
    }),
  }));
  assert.equal(put.status, 200);
  const published = await put.json();
  assert.equal(published.ok, true);
  assert.match(published.pageUrl, new RegExp(`/a/${room}/[a-f0-9]{64}$`));
  assert.equal(published.approval.danger, "destructive");

  const viewToken = published.viewToken;
  const html = await roomDo.fetch(new Request(`https://relay.example/a/${room}/${viewToken}`));
  assert.equal(html.status, 200);
  assert.match(await html.text(), /Destructive|destructive|Accept/);

  const decide = await roomDo.fetch(
    new Request(`https://relay.example/a/${room}/${viewToken}/req-42/decide`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "deny" }),
    }),
  );
  assert.equal(decide.status, 200);
  assert.deepEqual(await decide.json(), { ok: true, requestId: "req-42", decision: "deny" });

  const listed = await roomDo.fetch(new Request(`https://relay.example/approvals?room=${room}`, {
    headers: { authorization: `Bearer ${pushAuth}` },
  }));
  const body = await listed.json();
  assert.equal(body.approvals[0].status, "deny");
  assert.equal(body.approvals[0].decidedBy, "web");

  const del = await roomDo.fetch(new Request(
    `https://relay.example/approvals?room=${room}&requestId=req-42`,
    { method: "DELETE", headers: { authorization: `Bearer ${pushAuth}` } },
  ));
  assert.equal(del.status, 200);

  const put2 = await roomDo.fetch(new Request(`https://relay.example/approvals?room=${room}`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${pushAuth}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      requestId: "req-99",
      title: "Allow ls",
      command: "ls",
      danger: "safe",
      agent: "cursor",
    }),
  }));
  const p2 = await put2.json();
  const json = await roomDo.fetch(
    new Request(`https://relay.example/a/${room}/${p2.viewToken}/json`),
  );
  assert.equal(json.status, 200);
  assert.equal((await json.json()).approvals[0].status, "pending");

  const badTok = await roomDo.fetch(
    new Request(`https://relay.example/a/${room}/${"00".repeat(32)}`),
  );
  assert.equal(badTok.status, 401);

  const cancelAll = await roomDo.fetch(new Request(
    `https://relay.example/approvals?room=${room}&all=1`,
    { method: "DELETE", headers: { authorization: `Bearer ${pushAuth}` } },
  ));
  assert.equal(cancelAll.status, 200);
});
