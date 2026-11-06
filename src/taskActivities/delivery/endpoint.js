import { validRoom } from '../../relay/relayValidation.js';
import { ACTIVITY_BODY_LIMIT, validActivityId, validActivityRegistration, validActivityUpdate } from '../policy.js';

const result = (status, body) => ({ status, body });
const paths = new Set(['/push/activity/register', '/push/activity/subscriptions', '/push/activity/update']);

export class TaskActivityEndpoint {
  constructor(options) { this.options = options; this.inFlight = new Map(); }

  async handle(request) {
    if (!validRoom(request.room)) return result(400, { error: 'valid room required' });
    if (!paths.has(request.path)) return result(404, { error: 'not found' });
    let authorized = false;
    try { authorized = await request.authorize(); } catch { /* Fail closed without reflecting the credential. */ }
    if (!authorized) return result(401, { error: 'invalid room credential' });
    const now = (this.options.now ?? Date.now)();
    if (request.path === '/push/activity/subscriptions') {
      if (request.method !== 'GET') return result(405, { error: 'method not allowed' });
      return result(200, { ok: true, subscriptions: await this.options.registry.list(request.room, now) });
    }
    const register = request.path === '/push/activity/register';
    if (!(register ? ['PUT', 'POST', 'DELETE'] : ['POST']).includes(request.method)) {
      return result(405, { error: 'method not allowed' });
    }
    let body;
    try { body = await request.read(ACTIVITY_BODY_LIMIT); }
    catch { return result(400, { error: 'bounded JSON body required' }); }
    if (register) return this.registration(request, body, now);
    if (!validActivityUpdate(body, now)) return result(400, { error: 'bounded encrypted activity update required' });
    return this.enqueue(request.room, body);
  }

  async registration(request, body, now) {
    if (request.method === 'DELETE') {
      if (!body || Object.keys(body).length !== 1 || !validActivityId(body.activityId)) {
        return result(400, { error: 'valid activity identity required' });
      }
      await this.options.registry.remove(request.room, body.activityId, now);
      return result(200, { ok: true, registered: false });
    }
    if (!validActivityRegistration(body, now)) return result(400, { error: 'bounded encrypted enrollment required' });
    if (!await this.options.registry.register(request.room, body, now)) {
      return result(409, { error: 'active activity capacity reached' });
    }
    return result(200, { ok: true, registered: true, enabled: this.options.configured(body.environment) });
  }

  async enqueue(room, update) {
    const key = room + '\0' + update.activityId;
    const previous = this.inFlight.get(key) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(() => this.deliver(room, update));
    this.inFlight.set(key, pending);
    try { return await pending; }
    finally { if (this.inFlight.get(key) === pending) this.inFlight.delete(key); }
  }

  async deliver(room, update) {
    const now = (this.options.now ?? Date.now)();
    const route = await this.options.registry.get(room, update.activityId, now);
    if (!route) return result(200, { ok: true, accepted: false, closed: true });
    if (route.lastDeliveryId === update.deliveryId) return result(200, { ok: true, accepted: true, duplicate: true });
    if (!this.options.configured(route.environment)) return result(503, { error: 'activity delivery unavailable' });
    const elapsed = now - route.lastDeliveredAt;
    if (update.event !== 'end' && route.lastDeliveredAt > 0 && elapsed < 10_000) {
      return result(202, { ok: true, accepted: false, retryAfterSeconds: Math.ceil((10_000 - elapsed) / 1_000) });
    }
    let sent;
    try { sent = await this.options.send(route, update, now); }
    catch { return result(502, { error: 'activity delivery unavailable' }); }
    if (sent?.stale) {
      const current = await this.options.registry.get(room, update.activityId, now);
      const closed = current?.token === route.token;
      if (closed) await this.options.registry.remove(room, update.activityId, now);
      return result(200, { ok: true, accepted: false, closed });
    }
    if (!sent?.ok) return result(502, { error: 'activity delivery unavailable' });
    await this.options.registry.delivered(room, update.activityId, update.deliveryId, now);
    if (update.event === 'end') await this.options.registry.remove(room, update.activityId, now);
    return result(200, { ok: true, accepted: true, closed: update.event === 'end' });
  }
}
