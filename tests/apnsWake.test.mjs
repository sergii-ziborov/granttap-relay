import assert from "node:assert/strict";
import test from "node:test";
import { apnsConfigured, pushPayload, sendAPNs } from "../src/relay/apnsWake.js";

const token = "ef".repeat(32);

test("APNs configuration and stale-token responses are handled without opaque payload leakage", async () => {
  assert.equal(apnsConfigured({}), false);
  const key = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", key.privateKey));
  const encoded = Buffer.from(pkcs8).toString("base64").match(/.{1,64}/g).join("\n");
  const env = { APNS_TEAM_ID: "TEAM", APNS_KEY_ID: "KEY", APNS_PRIVATE_KEY: `-----BEGIN PRIVATE KEY-----\n${encoded}\n-----END PRIVATE KEY-----` };
  assert.equal(apnsConfigured(env), true);
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return new Response(JSON.stringify({ reason: "BadDeviceToken" }), { status: 400 });
  };
  try {
    const result = await sendAPNs(env, { environment: "sandbox", token, bundleId: "com.ziborov.granttap" });
    assert.deepEqual(result, { ok: false, stale: true });
    assert.match(requests[0].url, /api\.sandbox\.push\.apple\.com/);
    assert.equal(requests[0].options.headers["apns-topic"], "com.ziborov.granttap");
    assert.doesNotMatch(requests[0].options.body, /command|ciphertext|session/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("wake payload is alert plus content-available and has no relay task fields", () => {
  const payload = pushPayload();
  assert.equal(payload.aps["content-available"], 1);
  assert.equal(payload.aps.alert.title, "GrantTap");
  assert.equal(payload.granttapWake, true);
  assert.doesNotMatch(JSON.stringify(payload), /command|prompt|sessionId|ciphertext/i);
});
