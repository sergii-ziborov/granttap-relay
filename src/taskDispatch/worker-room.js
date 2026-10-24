import { json, readJsonLimited } from '../relay/relaySupport.js';
import { purgeEndpointDirectory } from '../relay/endpointRetention.js';
import { taskDispatchResponse } from './index.js';
import { WorkerTaskDispatchStore } from './worker.js';
import { offerTaskJobs } from './socket-offers.js';

export function initializeRoomTaskDispatch(room) {
  room.taskDispatch = new WorkerTaskDispatchStore(room.state.storage);
  room.taskOffers = new WeakMap();
}

export async function handleRoomTaskDispatch(room, request) {
  const url = new URL(request.url);
  const result = await taskDispatchResponse({ method: request.method, pathname: url.pathname,
    room: url.searchParams.get('room'), store: room.taskDispatch, metadataOnly: url.searchParams.get('metadata') === '1',
    credential: request.headers.get('Authorization')?.replace(/^Bearer /, ''),
    authorize: async () => Boolean(await room.state.storage.get('push:auth-sha256'))
      && !await room.requireRoomAuth(request),
    read: limit => readJsonLimited(request, limit) });
  if (result.status < 300 && request.method !== 'GET') {
    if (request.method === 'PUT') await offerRoomTaskJobs(room);
    await scheduleRoomTaskAlarm(room);
  }
  return json(result.body, result.status);
}

export async function offerRoomTaskJobs(room) {
  for (const peer of room.state.getWebSockets()) {
    const attachment = peer.deserializeAttachment();
    if (attachment?.role !== 'machine' || !attachment.taskDispatch) continue;
    const offered = room.taskOffers.get(peer) ?? new Map();
    room.taskOffers.set(peer, offered);
    await offerTaskJobs({ store: room.taskDispatch, room: attachment.room,
      recipientKeyId: attachment.recipientKeyId, offered, send: raw => { try { peer.send(raw); } catch { return false; } } });
  }
}

export function scheduleRoomTaskAlarm(room) {
  const work = async () => {
    const endpointAlarm = await purgeEndpointDirectory(room.state.storage);
    const recipients = new Set(room.state.getWebSockets().flatMap(peer => {
      const attachment = peer.deserializeAttachment();
      return attachment?.role === 'machine' && attachment.taskDispatch ? [attachment.recipientKeyId] : [];
    }));
    const taskAlarm = await room.taskDispatch.maintain(Date.now(), recipients);
    const wakeAlarm = await room.wakes.nextAt('room');
    const next = Math.min(endpointAlarm ?? Infinity, taskAlarm ?? Infinity, wakeAlarm ?? Infinity);
    if (Number.isFinite(next)) await room.state.storage.setAlarm(next);
    else await room.state.storage.deleteAlarm();
  };
  room.taskAlarmWork = (room.taskAlarmWork ?? Promise.resolve()).catch(() => {}).then(work);
  return room.taskAlarmWork;
}
