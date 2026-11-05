// Push is an opaque synchronization hint, never evidence of a user-facing event.
export const WAKE_INTERVAL_MS = 60_000;
export const WAKE_HISTORY_LIMIT = 256;
const DEFAULT_TTL_MS = 15 * 60_000;
const MAX_ATTEMPTS = 3;

export class WakeDelivery {
  constructor({ read, write, send, now = Date.now, notify = () => {} }) {
    Object.assign(this, { read, write, send, now, notify });
    this.work = new Map();
  }

  serial(room, action) {
    const next = (this.work.get(room) ?? Promise.resolve()).catch(() => {}).then(action);
    this.work.set(room, next);
    void next.finally(() => { if (this.work.get(room) === next) this.work.delete(room); }).catch(() => {});
    return next;
  }

  request(room, envelope) {
    return this.serial(room, async () => {
      const now = this.now(), expiresAt = envelope.expiresAt ?? now + DEFAULT_TTL_MS;
      if (expiresAt <= now) { this.notify('expired'); return; }
      const identity = [envelope.senderId, envelope.recipientKeyId ?? '',
        ...(envelope.deliveryId ? [envelope.deliveryId] : [envelope.nonce, envelope.box])];
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(identity)));
      const key = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
      const previous = (await this.read(room)) ?? {};
      const recent = (previous.recent ?? []).filter(item => item.expiresAt > now);
      if (recent.some(item => item.key === key)) this.notify('duplicate');
      else {
        recent.push({ key, expiresAt });
        const state = { ...previous, recent: recent.slice(-WAKE_HISTORY_LIMIT),
          pending: { expiresAt: Math.max(expiresAt, previous.pending?.expiresAt ?? 0), attempts: 0 },
          nextAt: Math.max(now, Number.isFinite(previous.lastSentAt) ? previous.lastSentAt + WAKE_INTERVAL_MS : now) };
        // Persist before network I/O. ACKs and process restarts do not erase receipts.
        await this.write(room, state);
        this.notify(state.nextAt > now ? 'coalesced' : 'requested');
      }
      await this.sendDue(room);
    });
  }

  drain(room) { return this.serial(room, () => this.sendDue(room)); }

  async nextAt(room) {
    const state = await this.read(room);
    return state?.pending ? Math.min(state.nextAt, state.pending.expiresAt) : null;
  }

  async sendDue(room) {
    const state = await this.read(room), now = this.now();
    if (!state?.pending) return;
    if (state.pending.expiresAt <= now || state.pending.attempts >= MAX_ATTEMPTS) {
      await this.write(room, { ...state, pending: null, nextAt: null });
      this.notify('expired');
      return;
    }
    if (state.nextAt > now) return;
    const claimed = { ...state, lastSentAt: now, nextAt: now + WAKE_INTERVAL_MS,
      pending: { ...state.pending, attempts: state.pending.attempts + 1 } };
    await this.write(room, claimed);
    let ok = false;
    try { ok = await this.send(room); } catch { /* bounded retry; never log APNs credentials */ }
    if (ok || claimed.pending.attempts >= MAX_ATTEMPTS) {
      await this.write(room, { ...claimed, pending: null, nextAt: null });
    }
    this.notify(ok ? 'background-complete' : 'background-failed');
  }
}
