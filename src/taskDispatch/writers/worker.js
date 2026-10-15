import { TaskWriterGrants, commitWriterGrant } from './index.js';

const prefix = room => `task-writer:${room}:`;
const adapterFor = storage => ({
  get: (room, id) => storage.get(prefix(room) + id),
  list: async room => [...(await storage.list({ prefix: prefix(room), limit: 129 })).values()],
  put: (room, row) => storage.put(prefix(room) + row.id, row),
  delete: (room, id) => storage.delete(prefix(room) + id),
  getResources: (room, id) => storage.get(`task-resources:${room}:${id}`),
  putResources: (room, id, report) => storage.put(`task-resources:${room}:${id}`, report),
  deleteResources: (room, id) => storage.delete(`task-resources:${room}:${id}`),
  revoke: (room, id, now) => storage.transaction(async transaction => {
    const adapter = adapterFor(transaction), row = await adapter.get(room, id);
    if (row && row.revokedAt == null) await adapter.put(room, { ...row, revokedAt: now });
    await adapter.deleteResources(room, id);
  }),
  commit: (room, row, now) => storage.transaction(transaction => commitWriterGrant(adapterFor(transaction), room, row, now)),
});

export const workerTaskWriters = storage => new TaskWriterGrants(adapterFor(storage));
