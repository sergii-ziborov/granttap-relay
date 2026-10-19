import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';

export const defaultPolicy = {
  enabled: true, serviceRpm: 30000, serviceConnections: 1024, anonymousRpm: 1200, anonymousConnections: 32,
  registered: { accountRpm: 600, deviceRpm: 300, accountConnections: 32, deviceConnections: 8 },
  subscriber: { accountRpm: 2400, deviceRpm: 1200, accountConnections: 128, deviceConnections: 12 },
  beta: { accountRpm: 2400, deviceRpm: 1200, accountConnections: 128, deviceConnections: 12 },
};

/** Server-side only. Call after authenticating the session and checking its
 * current entitlement. Never copy category/account/device from public headers.
 * Socket + a distinct per-app key authenticate this app, not the user.
 */
export function createClientAccess({ siteId, socketPath, key, timeoutMs = 500, now = Date.now } = {}) {
  if (!siteId || !socketPath || !key) return null;
  if (Buffer.byteLength(key) < 32) throw new Error('Client access key is too short');
  const agent = new http.Agent({ keepAlive: true, maxSockets: 32, maxFreeSockets: 4 });
  const fallback = new Map();
  const localLeases = new Map();
  let policy = { ...defaultPolicy, siteId, revision: 1 };
  let pending = 0;
  let closing;
  const tag = (kind, value) => createHmac('sha256', key).update(`${kind}:${value}`).digest('hex');
  function spend(id, rpm, at) {
    if (fallback.size >= 32768) for (const [k, v] of fallback) if (at - v.at > 120000) fallback.delete(k);
    const cap = Math.max(3, Math.min(200, rpm / 10));
    const v = fallback.get(id) ?? { tokens: cap, at };
    if (!fallback.has(id) && fallback.size >= 32768) return false;
    v.tokens = Math.min(cap, v.tokens + (at - v.at) * rpm / 60000); v.at = at;
    const allowed = v.tokens >= 1; if (allowed) v.tokens--; fallback.set(id, v); return allowed;
  }
  function boundedFallback(a) {
    const at = now();
    for (const [k, v] of localLeases) if (v.expiresAt <= at) localLeases.delete(k);
    const d = { allowed: true, category: a.category, reason: 'local-fallback', retryAfter: 0, policy, fallback: true };
    if (a.operation === 'release') { localLeases.delete(a.leaseId); return d; }
    if (a.operation === 'renew' && localLeases.has(a.leaseId)) { localLeases.set(a.leaseId, a); return { ...d, leaseId: a.leaseId }; }
    const t = policy[a.category] ?? policy.registered;
    const aKey = `a:${a.account}`, dKey = `d:${a.account}:${a.device}`;
    const aPrevious = fallback.has(aKey) ? { ...fallback.get(aKey) } : null;
    const dPrevious = fallback.has(dKey) ? { ...fallback.get(dKey) } : null;
    const deny = reason => Object.assign(d, { allowed: false, reason, retryAfter: 5 });
    if (a.account && !spend(`a:${a.account}`, t.accountRpm, at)) deny('account-rate');
    else if (a.device && !spend(`d:${a.account}:${a.device}`, t.deviceRpm, at)) deny('device-rate');
    else if (!a.account && !spend(`n:${tag('ip', a.clientIp ?? '')}`, policy.anonymousRpm, at)) deny('anonymous-network-rate');
    if (d.allowed && ['connect', 'renew'].includes(a.operation)) {
      const all = [...localLeases.values()];
      if (all.length >= policy.serviceConnections) deny('service-connections');
      else if (a.account && all.filter(x => x.account === a.account).length >= t.accountConnections) deny('account-connections');
      else if (a.device && all.filter(x => x.account === a.account && x.device === a.device).length >= t.deviceConnections) deny('device-connections');
      if (!a.account && all.filter(x => !x.account && x.clientIp === a.clientIp).length >= policy.anonymousConnections) deny('anonymous-network-connections');
      if (d.allowed) { a.expiresAt ??= at + 30000; d.leaseId = a.leaseId || tag('lease', `${at}:${Math.random()}`); localLeases.set(d.leaseId, a); }
    }
    if (d.allowed && !['release', 'renew'].includes(a.operation) && !spend('service', policy.serviceRpm, at)) { if (d.leaseId) localLeases.delete(d.leaseId); deny('service-rate'); }
    if (!d.allowed && a.account) { if (aPrevious) fallback.set(aKey, aPrevious); else fallback.delete(aKey); if (dPrevious) fallback.set(dKey, dPrevious); else fallback.delete(dKey); }
    return d;
  }
  function remote(a) {
    return new Promise((resolve, reject) => {
      if (pending >= 256) { reject(new Error('adapter busy')); return; }
      pending++;
      const finish = () => { pending--; };
      const req = http.request({ socketPath, path: '/admit', method: 'POST', agent,
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' } }, res => {
        let data = ''; res.setEncoding('utf8');
        res.on('data', chunk => { data += chunk; if (data.length > 16384) req.destroy(new Error('adapter response too large')); });
        res.on('end', () => {
          if (res.statusCode !== 200) { reject(Object.assign(new Error('adapter rejected proof'), { configuration: true, leaseMissing: data.includes('connection lease not found') })); return; }
          try { const d = JSON.parse(data); if (typeof d.allowed !== 'boolean' || !d.policy) throw new Error('invalid adapter decision'); resolve(d); }
          catch (e) { reject(e); }
        });
        res.on('error', reject);
      });
      // Includes queue time, not just the time after a socket is assigned.
      const timer = setTimeout(() => req.destroy(new Error('adapter timeout')), timeoutMs); timer.unref();
      req.on('close', () => { clearTimeout(timer); finish(); }); req.on('error', reject);
      req.end(JSON.stringify(a));
    });
  }
  return {
    async admit(identity = {}, operation = 'request', leaseId) {
      const category = identity.category ?? 'anonymous';
      const identified = category !== 'anonymous';
      if (!['anonymous', 'registered', 'subscriber', 'beta'].includes(category)
        || identified && (typeof identity.account !== 'string' || !identity.account || typeof identity.device !== 'string' || !identity.device || !Number.isSafeInteger(identity.expiresAt) || (operation !== 'release' && (identity.expiresAt <= now() || identity.expiresAt > now() + 360000)))) {
        return { allowed: false, category: 'anonymous', reason: 'invalid-proof', retryAfter: 0, policy };
      }
      const a = { siteId, operation, category, clientIp: identity.clientIp,
        ...(identified ? { account: tag('account', identity.account), device: tag('device', identity.device), expiresAt: identity.expiresAt } : { expiresAt: now() + 30000 }),
        ...(leaseId ? { leaseId } : {}) };
      try {
        let d;
        try { d = await remote(a); } catch (e) { if (operation !== 'renew' || !e.leaseMissing) throw e; d = await remote({ ...a, operation: 'connect', leaseId: undefined }); }
        policy = d.policy;
        if (d.allowed && d.leaseId) localLeases.set(d.leaseId, { ...a, expiresAt: a.expiresAt ?? now() + 30000 });
        if (operation === 'release') localLeases.delete(leaseId);
        return d;
      } catch (e) {
        // Auth/config errors never become a privileged fallback. Transport
        // outages retain bounded local account/device + service ceilings.
        if (e.configuration) return { allowed: false, category, reason: 'adapter-proof-rejected', retryAfter: 5, policy };
        return boundedFallback(a);
      }
    },
    close() {
      return closing ??= Promise.allSettled([...localLeases].map(([leaseId, a]) => remote({ ...a, operation: 'release', leaseId })))
        .finally(() => { localLeases.clear(); agent.destroy(); });
    },
  };
}
export function clientAccessFromEnv(env = process.env) {
  if (!env.HOSTWATCH_CLIENT_ACCESS_KEY_FILE || !env.HOSTWATCH_CLIENT_ACCESS_SOCKET || !env.HOSTWATCH_CLIENT_ACCESS_SITE) return null;
  return createClientAccess({ siteId: env.HOSTWATCH_CLIENT_ACCESS_SITE, socketPath: env.HOSTWATCH_CLIENT_ACCESS_SOCKET,
    key: readFileSync(env.HOSTWATCH_CLIENT_ACCESS_KEY_FILE) });
}
