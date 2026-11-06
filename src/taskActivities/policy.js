export const ACTIVITY_TTL_MS = 8 * 60 * 60 * 1000;
export const ACTIVITY_LIMIT = 8;
export const ACTIVITY_BODY_LIMIT = 8_192;
export const ACTIVITY_BUNDLE_ID = 'com.ziborov.granttap';

export function validActivityRegistration(body, now = Date.now()) {
  return fields(body, ['activityId', 'token', 'environment', 'bundleId', 'expiresAt', 'nonce', 'box'])
    && validActivityId(body.activityId)
    && typeof body.token === 'string' && /^[a-fA-F0-9]{32,512}$/.test(body.token) && body.token.length % 2 === 0
    && ['sandbox', 'production'].includes(body.environment) && body.bundleId === ACTIVITY_BUNDLE_ID
    && Number.isSafeInteger(body.expiresAt) && body.expiresAt > now && body.expiresAt <= now + ACTIVITY_TTL_MS
    && validBase64(body.nonce, 32, 32) && validBase64(body.box, 24, 2_048);
}

export function validActivityUpdate(body, now = Date.now()) {
  const seconds = Math.floor(now / 1_000);
  return fields(body, ['activityId', 'deliveryId', 'event', 'staleDate', 'contentState'])
    && validActivityId(body.activityId) && validActivityId(body.deliveryId)
    && ['update', 'end'].includes(body.event)
    && Number.isSafeInteger(body.staleDate) && body.staleDate >= seconds - 300 && body.staleDate <= seconds + 120
    && fields(body.contentState, ['nonce', 'box'])
    && validBase64(body.contentState.nonce, 32, 32) && validBase64(body.contentState.box, 24, 3_072);
}
export function validActivityId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,180}$/.test(value);
}
import { validBase64 } from '../relay/relayValidation.js';

function fields(value, names) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === names.length && Object.keys(value).every(name => names.includes(name));
}
