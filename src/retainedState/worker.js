import { retainState, replayState } from './policy.js';

/** A room's Durable Object serializes replacement writes and splits large ciphertext. */
export class WorkerRetainedState {
  constructor(storage, activity = async () => []) {
    this.storage = storage; this.activity = activity; this.pending = Promise.resolve();
  }

  put(envelope, raw, now = Date.now()) {
    const work = this.pending.then(async () => {
      const before = await this.rows();
      const rows = retainState(before, envelope, raw, now, await this.activity() ?? []);
      for (const row of before) if (!rows.includes(row)) await this.remove(row);
      for (const row of rows) if (!before.includes(row)) {
        const chunks = Math.ceil(row.raw.length / 60000);
        for (let i = 0; i < chunks; i++) await this.storage.put(this.key(row, i), row.raw.slice(i * 60000, (i + 1) * 60000));
        const { raw: _, ...metadata } = row;
        await this.storage.put(this.key(row), { ...metadata, chunks });
      }
      await this.storage.put('state:index', rows.map(({ recipient, key }) => ({ recipient, key })));
    });
    this.pending = work.catch(() => {});
    return work;
  }

  key(row, chunk) { return `state:${row.recipient}:${row.key}${chunk == null ? '' : `:${chunk}`}`; }
  async remove(row) {
    const chunks = Math.ceil((row.bytes ?? 0) / 60000);
    for (let i = 0; i < chunks; i++) await this.storage.delete(this.key(row, i));
    await this.storage.delete(this.key(row));
  }
  async rows() {
    const index = await this.storage.get('state:index') ?? [];
    const rows = [];
    for (const row of index) {
      const metadata = await this.storage.get(this.key(row));
      if (!metadata) continue;
      const chunks = [];
      for (let i = 0; i < metadata.chunks; i++) chunks.push(await this.storage.get(this.key(row, i)));
      if (chunks.every(chunk => typeof chunk === 'string')) rows.push({ ...metadata, raw: chunks.join('') });
    }
    return rows;
  }
  async list(recipient, now = Date.now()) { await this.pending; return replayState(await this.rows(), recipient, now); }
}
