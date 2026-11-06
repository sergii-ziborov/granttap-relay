import { apnsRequestContext } from '../../relay/apnsWake.js';
import { ACTIVITY_BUNDLE_ID, validActivityUpdate } from '../policy.js';

/** APNs receives authenticated ciphertext; only the widget holds the preview key. */
export async function sendTaskActivityAPNs({ env, device, update, now = Date.now(), request = fetch }) {
  if (!validActivityUpdate(update, now) || device.bundleId !== ACTIVITY_BUNDLE_ID
    || !['sandbox', 'production'].includes(device.environment)
    || typeof device.token !== 'string' || !/^[a-fA-F0-9]{32,512}$/.test(device.token)
    || device.token.length % 2 !== 0) throw new Error('Invalid encrypted activity delivery.');
  const seconds = Math.floor(now / 1_000);
  const aps = { timestamp: seconds, event: update.event, 'content-state': update.contentState,
    'stale-date': update.staleDate,
    ...(update.event === 'end' ? { 'dismissal-date': seconds - 1 } : {}) };
  const body = JSON.stringify({ aps });
  if (new TextEncoder().encode(body).byteLength > 4_096) throw new Error('Activity payload exceeded the APNs limit.');
  const context = await apnsRequestContext(env, device);
  const response = await request(context.url, { method: 'POST', signal: AbortSignal.timeout(8_000),
    headers: { authorization: context.authorization, 'apns-topic': ACTIVITY_BUNDLE_ID + '.push-type.liveactivity',
      'apns-push-type': 'liveactivity', 'apns-priority': '5', 'apns-expiration': String(seconds + 90),
      'apns-collapse-id': 'granttap-task-activity', 'content-type': 'application/json' }, body });
  let reason = '';
  if (!response.ok) {
    try { reason = String((await response.json()).reason ?? ''); } catch { /* Provider refusals remain opaque. */ }
  }
  return { ok: response.ok, stale: response.status === 410 || ['BadDeviceToken', 'Unregistered'].includes(reason) };
}
