import assert from "node:assert/strict";
import test from "node:test";
import { bearer, constantTimeEqual, readJsonLimited } from "../src/relay/relaySupport.js";

test("relay support bounds streamed JSON and rejects mismatched bearer digests", async () => {
  assert.equal(bearer(new Request("https://relay.example", { headers: { authorization: "Basic x" } })), "");
  assert.equal(bearer(new Request("https://relay.example", { headers: { authorization: "Bearer  token  " } })), "token");
  assert.equal(constantTimeEqual("same", "same"), true);
  assert.equal(constantTimeEqual("same", "different"), false);
  assert.equal(constantTimeEqual(1, "1"), false);
  const overflow = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); controller.close(); } });
  await assert.rejects(() => readJsonLimited(new Request("https://relay.example", { method: "POST", body: overflow, duplex: "half" }), 2));
  await assert.rejects(() => readJsonLimited(new Request("https://relay.example", { method: "POST", headers: { "content-length": "3" }, body: "{}" }), 2));
  assert.equal(await readJsonLimited(new Request("https://relay.example", { method: "POST", body: "{}" }), 2) instanceof Object, true);
});
