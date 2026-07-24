import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/worker.js";

test("health endpoint is available without bindings", async () => {
  const response = await worker.fetch(new Request("https://relay.example/health"), {});
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});

test("unknown HTTP routes disclose no internals", async () => {
  const response = await worker.fetch(new Request("https://relay.example/private"), {});
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "not found" });
});
