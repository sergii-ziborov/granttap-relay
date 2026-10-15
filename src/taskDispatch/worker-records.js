import { ROOM_RECEIPT_LIMIT, ROOM_JOB_LIMIT } from './policy.js';

/** Durable Object list pages are bounded to 1,000 keys, including after hibernation. */
export async function listTaskJobRecords(storage, prefix) {
  const records = new Map();
  let startAfter;
  for (;;) {
    const page = await storage.list({ prefix, startAfter, limit: 1000 });
    for (const [key, value] of page) records.set(key, value);
    if (records.size > ROOM_RECEIPT_LIMIT + ROOM_JOB_LIMIT) throw new Error('task history exceeds storage bounds');
    if (page.size < 1000) return records;
    const last = [...page.keys()].at(-1);
    if (!last || (startAfter && last <= startAfter)) throw new Error('task history cursor did not advance');
    startAfter = last;
  }
}
