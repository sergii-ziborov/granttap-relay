import { json, readJsonLimited } from '../../relay/relaySupport.js';
import { apnsConfigured } from '../../relay/apnsWake.js';
import { WorkerTaskActivities } from '../registry/index.js';
import { TaskActivityEndpoint } from './endpoint.js';
import { sendTaskActivityAPNs } from './apns.js';

export function initializeRoomTaskActivities(room) {
  room.taskActivities = new TaskActivityEndpoint({ registry: new WorkerTaskActivities(room.state.storage),
    configured: environment => apnsConfigured(room.env, environment),
    send: (device, update, now) => sendTaskActivityAPNs({ env: room.env, device, update, now }) });
}

export async function handleRoomTaskActivities(room, request) {
  const url = new URL(request.url);
  const result = await room.taskActivities.handle({ path: url.pathname, method: request.method,
    room: url.searchParams.get('room'),
    authorize: async () => Boolean(await room.state.storage.get('push:auth-sha256'))
      && !await room.requireRoomAuth(request),
    read: limit => readJsonLimited(request, limit) });
  return json(result.body, result.status);
}
