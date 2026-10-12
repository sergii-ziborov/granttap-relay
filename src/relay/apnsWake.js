const cachedProviderTokens = new Map();

export function apnsConfigured(env, environment) {
  if (!environment) return apnsConfigured(env, "production") || apnsConfigured(env, "sandbox");
  const selected = apnsEnvironment(env, environment);
  return Boolean(selected?.APNS_TEAM_ID && selected?.APNS_KEY_ID && selected?.APNS_PRIVATE_KEY);
}

function apnsEnvironment(env, environment) {
  if (!env) return null;
  if (environment === "sandbox" && env.APNS_SANDBOX_KEY_ID) {
    return { ...env, APNS_TEAM_ID: env.APNS_SANDBOX_TEAM_ID ?? env.APNS_TEAM_ID,
      APNS_KEY_ID: env.APNS_SANDBOX_KEY_ID, APNS_PRIVATE_KEY: env.APNS_SANDBOX_PRIVATE_KEY };
  }
  return env.APNS_KEY_ENVIRONMENT && env.APNS_KEY_ENVIRONMENT !== environment ? null : env;
}

export function pushPayload() {
  return {
    aps: {
      alert: { title: "GrantTap", body: "An agent is waiting for an authenticated decision." },
      sound: "default",
      "content-available": 1,
      "interruption-level": "time-sensitive",
    },
    granttapWake: true,
  };
}

export async function sendAPNs(env, device, request = fetch) {
  if (!apnsConfigured(env, device.environment)) throw new Error("APNs environment is not configured.");
  env = apnsEnvironment(env, device.environment);
  const providerToken = await apnsProviderToken(env);
  const host = device.environment === "sandbox" ? "https://api.sandbox.push.apple.com" : "https://api.push.apple.com";
  const response = await request(`${host}/3/device/${device.token}`, {
    method: "POST",
    headers: {
      authorization: `bearer ${providerToken}`,
      "apns-topic": device.bundleId,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "apns-expiration": String(Math.floor(Date.now() / 1000) + 180),
      "apns-collapse-id": "granttap-wake",
      "content-type": "application/json",
    },
    body: JSON.stringify(pushPayload()),
  });
  let reason = "";
  if (!response.ok) {
    try { reason = String((await response.json()).reason ?? ""); } catch { /* no body */ }
  }
  return { ok: response.ok, stale: response.status === 410 || reason === "BadDeviceToken" || reason === "Unregistered" };
}

async function apnsProviderToken(env) {
  const now = Math.floor(Date.now() / 1000);
  const identity = `${env.APNS_TEAM_ID}:${env.APNS_KEY_ID}`;
  const cached = cachedProviderTokens.get(identity);
  if (cached && now - cached.issuedAt < 45 * 60) return cached.token;
  const header = base64url(JSON.stringify({ alg: "ES256", kid: env.APNS_KEY_ID }));
  const claims = base64url(JSON.stringify({ iss: env.APNS_TEAM_ID, iat: now }));
  const signingInput = `${header}.${claims}`;
  const pem = String(env.APNS_PRIVATE_KEY).replace(/\\n/g, "\n");
  const bytes = Uint8Array.from(atob(pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, "")), (char) => char.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", bytes, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(signingInput)));
  const token = `${signingInput}.${base64url(signature)}`;
  if (cachedProviderTokens.size >= 4) cachedProviderTokens.delete(cachedProviderTokens.keys().next().value);
  cachedProviderTokens.set(identity, { issuedAt: now, token });
  return token;
}

function base64url(value) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
