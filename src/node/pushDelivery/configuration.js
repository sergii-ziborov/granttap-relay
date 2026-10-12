import { readFileSync } from 'node:fs';

/** Private signing files remain mounted on the server, never baked into an image. */
export function configuredPushEnvironment(env) {
  const configured = { ...env };
  for (const prefix of ['APNS', 'APNS_SANDBOX']) {
    const path = env[`${prefix}_PRIVATE_KEY_PATH`];
    if (!path) continue;
    try {
      const pem = readFileSync(path, 'utf8').trim();
      if (!pem.startsWith('-----BEGIN PRIVATE KEY-----') || !pem.endsWith('-----END PRIVATE KEY-----')) {
        throw new Error('Invalid key format.');
      }
      configured[`${prefix}_PRIVATE_KEY`] = pem;
    } catch { throw new Error('APNs signing key is unreadable or invalid.'); }
  }
  return configured;
}
