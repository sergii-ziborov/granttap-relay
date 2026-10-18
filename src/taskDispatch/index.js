import { validRoom } from '../relay/relayValidation.js';
import { validJobId, JOB_BYTES, taskJobMetadata } from './policy.js';
import { CONFIGURATION_BYTES } from './configurations/index.js';

export async function taskDispatchResponse({ method, pathname, room, authorize, credential, read, store, metadataOnly = false }) {
  if (!validRoom(room)) return { status: 400, body: { error: 'invalid room' } };
  const owner = await authorize();
  const retainedRead = method === 'GET' && metadataOnly
    && /^\/task-jobs\/[A-Za-z0-9][A-Za-z0-9_-]{7,119}$/.test(pathname);
  const writer = owner ? undefined : await store.writers?.authorize(room, credential, Date.now(), retainedRead);
  if (!owner && !writer) return { status: 401, body: { error: 'invalid room credential' } };
  const configurationId = /^\/task-job-configurations\/([a-f0-9]{64})$/.exec(pathname)?.[1];
  if (configurationId) {
    if (!owner) return { status: 403, body: { error: 'room owner required' } };
    if (method === 'GET') {
      const configuration = await store.configurations.get(room, configurationId);
      return { status: 200, body: { configuration: configuration ?? null } };
    }
    if (method !== 'PUT') return { status: 405, body: { error: 'method not allowed' } };
    const { status, ...body } = await store.configurations.put(room, configurationId, await read(CONFIGURATION_BYTES));
    return { status, body };
  }
  const resourceId = /^\/task-resources\/([A-Za-z0-9][A-Za-z0-9_-]{7,119})$/.exec(pathname)?.[1];
  if (resourceId) {
    if (!owner && (resourceId !== writer.id || method !== 'GET')) return { status: 403, body: { error: 'resource report scope refused' } };
    if (!['GET', 'PUT'].includes(method)) return { status: 405, body: { error: 'method not allowed' } };
    const { status, ...body } = await store.writers.resources(room, resourceId, method === 'PUT' ? (await read(32_000) ?? null) : undefined);
    return { status, body };
  }
  const grantId = /^\/task-job-writers\/([A-Za-z0-9][A-Za-z0-9_-]{7,119})$/.exec(pathname)?.[1];
  if (grantId) {
    if (!owner) return { status: 403, body: { error: 'room owner required' } };
    const { status, ...body } = method === 'PUT' ? await store.writers.put(room, grantId, await read(4_096))
      : method === 'DELETE' ? await store.writers.revoke(room, grantId)
      : { status: 405, error: 'method not allowed' };
    return { status, body };
  }
  const match = /^\/task-jobs(?:\/([^/]+)(?:\/(claim|finish))?)?$/.exec(pathname);
  if (!match || (match[1] && !validJobId(match[1]))) return { status: 400, body: { error: 'invalid job path' } };
  const [, id, action] = match;
  if (writer) {
    if (!id || action || !['GET', 'PUT', 'DELETE'].includes(method)) return { status: 403, body: { error: 'writer scope refused' } };
    const existing = await store.getPublic(room, id, Date.now(), true);
    if ((method !== 'PUT' || existing) && existing?.writerId !== writer.id) return { status: 404, body: { error: 'unknown task job' } };
  }
  if (method === 'GET' && !id) return { status: 200, body: { jobs: (await store.listActive(room)).map(taskJobMetadata) } };
  if (method === 'GET' && id && !action) {
    const job = await store.getPublic(room, id, Date.now(), metadataOnly);
    return job ? { status: 200, body: { job } } : { status: 404, body: { error: 'unknown task job' } };
  }
  let result;
  if (method === 'PUT' && id && !action) {
    let body = await read(JOB_BYTES);
    if (writer) {
      if (body?.envelope?.recipientKeyId !== writer.recipientKeyId || body?.expiresAt > writer.expiresAt) {
        return { status: 403, body: { error: 'writer recipient or lifetime refused' } };
      }
      body = { ...body, writerId: writer.id, writerSourceKeyId: writer.sourceKeyId };
    }
    result = await store.put(room, id, body);
  }
  else if (method === 'POST' && id && action) result = await store.transition(room, id, action, await read(action === 'finish' ? 34_000 : 1024));
  else if (method === 'DELETE' && id && !action) result = await store.transition(room, id, 'cancel');
  else return { status: 405, body: { error: 'method not allowed' } };
  const { status, ...body } = result;
  return { status, body: body.job ? { ...body, job: taskJobMetadata(body.job) } : body };
}
