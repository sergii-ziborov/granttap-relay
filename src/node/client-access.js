import { isIP } from 'node:net';

export function clientIdentity(ticket, request, env) {
  const peer = request.socket.remoteAddress?.replace(/^::ffff:/, '');
  const trusted = (env.HOSTWATCH_TRUSTED_PROXY_IPS ?? '').split(',').includes(peer);
  const forwarded = request.headers['x-real-ip'];
  const clientIp = trusted && typeof forwarded === 'string' && isIP(forwarded) ? forwarded : peer;
  return ticket ? { category: ticket.source === 'subscription' ? 'subscriber' : ticket.source === 'beta' ? 'beta' : 'registered',
    account: ticket.accountId, device: `${ticket.computerId}:${ticket.role ?? 'machine'}:${ticket.publicKey}`,
    expiresAt: ticket.expiresAt, clientIp } : { category: 'anonymous', clientIp };
}

export function setClientDecision(response, decision) {
  if (!decision) return;
  response.setHeader('X-Hostwatch-Client-Category', decision.category);
  response.setHeader('X-Hostwatch-Client-Limit', decision.allowed ? 'none' : decision.reason);
  if (decision.fallback) response.setHeader('X-Hostwatch-Client-Mode', 'local-fallback');
}

export function trackClientConnection(ws, access, request, env, initial) {
  if (!access || !initial?.leaseId) return;
  // Do not retain the IncomingMessage or its room credential/ticket headers.
  const caller = { socket: { remoteAddress: request.socket.remoteAddress }, headers: { 'x-real-ip': request.headers['x-real-ip'] } };
  const connectionIdentity = () => {
    const identity = clientIdentity(ws.relayState.ticket, caller, env);
    if (!ws.relayState.ticket) identity.identityKind = 'paired-device';
    return identity;
  };
  let leaseId = initial.leaseId;
  let running = false;
  const refresh = setInterval(async () => {
    if (running || ws.readyState !== 1) return;
    running = true;
    try {
      const d = await access.admit(connectionIdentity(), 'renew', leaseId);
      if (d.allowed && d.leaseId) leaseId = d.leaseId;
      // Expiry/authentication are also enforced by the relay's independent
      // managed-admission timer; quota service outages never disable it.
      if (!d.allowed && d.reason !== 'adapter-proof-rejected') ws.close(4429, d.reason);
    } finally { running = false; }
  }, 15000);
  refresh.unref();
  ws.once('close', () => {
    clearInterval(refresh);
    void access.admit(connectionIdentity(), 'release', leaseId);
  });
}
