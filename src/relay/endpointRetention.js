const PREFIX = 'endpoint:';
export const ENDPOINT_RECIPIENT_LIMIT = 32;

/** Expiry is enforced by storage alarms even if a controller never reads again. */
export async function purgeEndpointDirectory(storage, now = Date.now()) {
  const rows = await storage.list({ prefix: PREFIX });
  let next;
  for (const [key, row] of rows) {
    if (!row || row.expiresAt <= now) await storage.delete(key);
    else next = Math.min(next ?? row.expiresAt, row.expiresAt);
  }
  if (next !== undefined) await storage.setAlarm(next);
  else await storage.deleteAlarm();
}

export async function putDirectoryEndpoint(storage, key, record) {
  await purgeEndpointDirectory(storage);
  const rows = await storage.list({ prefix: PREFIX });
  const name = `${PREFIX}${key}`;
  if (!rows.has(name) && rows.size >= ENDPOINT_RECIPIENT_LIMIT) return false;
  await storage.put(name, record);
  await storage.setAlarm(Math.min(record.expiresAt, ...[...rows.values()].map(row => row.expiresAt)));
  return true;
}
