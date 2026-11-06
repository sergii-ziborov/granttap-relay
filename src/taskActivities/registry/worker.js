import { ACTIVITY_LIMIT, validActivityRegistration } from '../policy.js';

export class WorkerTaskActivities {
  constructor(storage) { this.storage = storage; }

  async register(room, record, now = Date.now()) {
    if (!validActivityRegistration(record, now)) return false;
    return this.change(room, now, rows => {
      const existing = rows.find(row => row.activityId === record.activityId);
      if (!existing && rows.length >= ACTIVITY_LIMIT) return false;
      const privateRecord = { activityId: record.activityId, token: record.token.toLowerCase(),
        environment: record.environment, bundleId: record.bundleId, expiresAt: record.expiresAt,
        nonce: record.nonce, box: record.box, lastDeliveryId: existing?.lastDeliveryId,
        lastDeliveredAt: existing?.lastDeliveredAt ?? 0 };
      if (existing) rows.splice(rows.indexOf(existing), 1, privateRecord);
      else rows.push(privateRecord);
      return true;
    });
  }

  async list(room, now = Date.now()) {
    return this.change(room, now, rows => rows.map(({ activityId, expiresAt, nonce, box }) =>
      ({ activityId, expiresAt, nonce, box })).sort((left, right) => left.activityId.localeCompare(right.activityId)));
  }

  async get(room, id, now = Date.now()) {
    return this.change(room, now, rows => rows.find(row => row.activityId === id));
  }

  async remove(room, id, now = Date.now()) {
    return this.change(room, now, rows => {
      const index = rows.findIndex(row => row.activityId === id);
      if (index >= 0) rows.splice(index, 1);
    });
  }

  async delivered(room, id, deliveryId, now = Date.now()) {
    return this.change(room, now, rows => {
      const row = rows.find(item => item.activityId === id);
      if (row) { row.lastDeliveryId = deliveryId; row.lastDeliveredAt = now; }
    });
  }

  async change(room, now, update) {
    const key = 'task-activities:v1:' + room;
    return this.storage.transaction(async transaction => {
      const saved = await transaction.get(key);
      const rows = Array.isArray(saved) ? saved.filter(row => row?.expiresAt > now) : [];
      const result = update(rows);
      if (rows.length) await transaction.put(key, rows);
      else await transaction.delete(key);
      return result;
    });
  }
}
