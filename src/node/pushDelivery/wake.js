import { apnsConfigured, sendAPNs } from "../../relay/apnsWake.js";

export async function sendWakePush(store, room, env, request, log) {
  if (!apnsConfigured(env)) return true;
  const stale = [];
  let ok = true;
  await Promise.all(store.pushTokens(room).map(async (device) => {
    try {
      const result = await sendAPNs(env, device, request);
      log('relay.apns', { reason: result.ok ? 'background-accepted' : result.stale ? 'stale-token' : 'background-rejected' });
      if (result.stale) stale.push(device.token);
      else if (!result.ok) ok = false;
    } catch { ok = false; log('relay.apns', { reason: 'background-failed' }); }
  }));
  if (stale.length) store.removePushTokens(room, stale);
  return ok;
}

