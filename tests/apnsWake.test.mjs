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

test("wake payload is a silent sync hint and has no relay task fields", () => {
  const payload = pushPayload();
  assert.equal(payload.aps["content-available"], 1);
  assert.equal(payload.aps.alert, undefined);
  assert.equal(payload.granttapWake, true);
  assert.doesNotMatch(JSON.stringify(payload), /command|prompt|sessionId|ciphertext/i);
});

test('an opaque wake cannot claim that an approval or answer is waiting', () => {
  const payload = pushPayload();
  assert.doesNotMatch(JSON.stringify(payload), /approval|authenticated decision|waiting|answer|sound|interruption-level/i);
  assert.equal(payload.aps['content-available'], 1);
  assert.equal(payload.granttapWake, true);
  assert.deepEqual(Object.keys(payload).sort(), ['aps', 'granttapWake']);
});

test("APNs accepts a successful response and caches the provider token", async () => {
  const key = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const encoded = Buffer.from(new Uint8Array(await crypto.subtle.exportKey("pkcs8", key.privateKey))).toString("base64");
  const env = { APNS_TEAM_ID: "TEAM2", APNS_KEY_ID: "KEY2", APNS_PRIVATE_KEY: `-----BEGIN PRIVATE KEY-----\n${encoded}\n-----END PRIVATE KEY-----` };
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(null, { status: calls === 1 ? 200 : 410 });
  };
  try {
    assert.deepEqual(await sendAPNs(env, { environment: "production", token, bundleId: "com.ziborov.granttap" }), { ok: true, stale: false });
    assert.deepEqual(await sendAPNs(env, { environment: "production", token, bundleId: "com.ziborov.granttap" }), { ok: false, stale: true });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('environment-scoped production credentials do not admit sandbox registration', () => {
  const production = { APNS_TEAM_ID: 'TESTTEAM', APNS_KEY_ID: 'TESTKEY',
    APNS_PRIVATE_KEY: 'configured', APNS_KEY_ENVIRONMENT: 'production' };
  assert.equal(apnsConfigured(production, 'production'), true);
  assert.equal(apnsConfigured(production, 'sandbox'), false);
  assert.equal(apnsConfigured({ ...production, APNS_SANDBOX_KEY_ID: 'SANDBOXKEY',
    APNS_SANDBOX_PRIVATE_KEY: 'configured' }, 'sandbox'), true);
  assert.equal(apnsConfigured({ ...production, APNS_SANDBOX_KEY_ID: 'SANDBOXKEY' }, 'sandbox'), false);
});

test('sandbox and production signers retain separate cached authorization tokens', async () => {
  const key = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const encoded = Buffer.from(await crypto.subtle.exportKey('pkcs8', key.privateKey)).toString('base64');
  const pem = `-----BEGIN PRIVATE KEY-----\n${encoded}\n-----END PRIVATE KEY-----`;
  const env = { APNS_TEAM_ID: 'SCOPEDTEAM', APNS_KEY_ID: 'PRODUCTION', APNS_PRIVATE_KEY: pem,
    APNS_KEY_ENVIRONMENT: 'production', APNS_SANDBOX_KEY_ID: 'SANDBOX', APNS_SANDBOX_PRIVATE_KEY: pem };
  const authorizations = [];
  const deliver = async (_url, options) => {
    authorizations.push(options.headers.authorization);
    return new Response(null, { status: 200 });
  };
  for (const environment of ['production', 'sandbox', 'production']) {
    assert.deepEqual(await sendAPNs(env, { environment, token, bundleId: 'com.ziborov.granttap' }, deliver),
      { ok: true, stale: false });
  }
  assert.equal(authorizations[0], authorizations[2]);
  assert.notEqual(authorizations[0], authorizations[1]);
  const header = authorization => JSON.parse(Buffer.from(authorization.slice(7).split('.')[0], 'base64url'));
  assert.equal(header(authorizations[0]).kid, 'PRODUCTION');
  assert.equal(header(authorizations[1]).kid, 'SANDBOX');
});
