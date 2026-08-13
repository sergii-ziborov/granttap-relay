let cachedProviderToken = null;

export function apnsConfigured(env) {
  return Boolean(env?.APNS_TEAM_ID && env?.APNS_KEY_ID && env?.APNS_PRIVATE_KEY);
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

export async function sendAPNs(env, device) {
  const providerToken = await apnsProviderToken(env);
  const host = device.environment === "sandbox" ? "https://api.sandbox.push.apple.com" : "https://api.push.apple.com";
  const response = await fetch(`${host}/3/device/${device.token}`, {
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
  if (cachedProviderToken?.team === env.APNS_TEAM_ID && cachedProviderToken?.key === env.APNS_KEY_ID
      && now - cachedProviderToken.issuedAt < 45 * 60) return cachedProviderToken.token;
  const header = base64url(JSON.stringify({ alg: "ES256", kid: env.APNS_KEY_ID }));
  const claims = base64url(JSON.stringify({ iss: env.APNS_TEAM_ID, iat: now }));
  const signingInput = `${header}.${claims}`;
  const pem = String(env.APNS_PRIVATE_KEY).replace(/\\n/g, "\n");
  const bytes = Uint8Array.from(atob(pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, "")), (char) => char.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", bytes, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(signingInput)));
  const token = `${signingInput}.${base64url(signature)}`;
  cachedProviderToken = { team: env.APNS_TEAM_ID, key: env.APNS_KEY_ID, issuedAt: now, token };
  return token;
}

function base64url(value) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
