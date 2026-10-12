import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('APNs private-key mounts load independently without changing process environment', async () => {
  const { configuredPushEnvironment } = await import('../src/node/pushDelivery/configuration.js');
  const directory = mkdtempSync(join(tmpdir(), 'granttap-apns-config-'));
  const production = join(directory, 'production.p8');
  const sandbox = join(directory, 'sandbox.p8');
  const marker = value => `-----BEGIN PRIVATE KEY-----\n${value}\n-----END PRIVATE KEY-----`;
  writeFileSync(production, marker('production'), { mode: 0o600 });
  writeFileSync(sandbox, marker('sandbox'), { mode: 0o600 });
  const env = { APNS_PRIVATE_KEY_PATH: production, APNS_SANDBOX_PRIVATE_KEY_PATH: sandbox };
  try {
    const configured = configuredPushEnvironment(env);
    assert.equal(configured.APNS_PRIVATE_KEY, marker('production'));
    assert.equal(configured.APNS_SANDBOX_PRIVATE_KEY, marker('sandbox'));
    assert.equal(env.APNS_PRIVATE_KEY, undefined);
    assert.throws(() => configuredPushEnvironment({ APNS_PRIVATE_KEY_PATH: join(directory, 'missing') }),
      /APNs signing key/);
    writeFileSync(production, 'not a private key');
    assert.throws(() => configuredPushEnvironment(env), /APNs signing key/);
    assert.equal(configuredPushEnvironment({ APNS_PRIVATE_KEY: 'legacy' }).APNS_PRIVATE_KEY, 'legacy');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
