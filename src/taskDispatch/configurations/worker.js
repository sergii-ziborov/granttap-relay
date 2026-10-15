import { TaskConfigurations, configurationCapacity } from './index.js';

const prefix = room => `task-configuration:${room}:`;
const adapterFor = storage => ({
  get: (room, id) => storage.get(prefix(room) + id),
  list: async room => [...(await storage.list({ prefix: prefix(room), limit: 129 })).values()],
  put: (room, row) => storage.put(prefix(room) + row.id, row),
  delete: (room, id) => storage.delete(prefix(room) + id),
  maintain: async now => {
    let next;
    for (const [key, row] of await storage.list({ prefix: 'task-configuration:', limit: 129 })) {
      if (row.expiresAt <= now) await storage.delete(key);
      else next = Math.min(next ?? Infinity, row.expiresAt);
    }
    return next;
  },
  current: (room, id, now) => storage.transaction(async transaction => {
    const adapter = adapterFor(transaction), row = await adapter.get(room, id);
    if (row?.expiresAt <= now) { await adapter.delete(room, id); return undefined; }
    return row;
  }),
  commit: (room, row, now) => storage.transaction(async transaction => {
    const adapter = adapterFor(transaction), rows = await adapter.list(room);
    for (const old of rows) if (old.expiresAt <= now) await adapter.delete(room, old.id);
    const result = configurationCapacity(rows, row, now);
    if (result.status < 300) await adapter.put(room, row);
    return result;
  }),
});

export const workerTaskConfigurations = storage => new TaskConfigurations(adapterFor(storage));
