/** Repeated offers are harmless: only a durable receiver claim permits execution. */
export async function offerTaskJobs({ store, room, recipientKeyId, send, offered = new Map(), now = Date.now() }) {
  if (!recipientKeyId) return;
  for (const [id, time] of offered) if (now - time >= 15_000) offered.delete(id);
  const jobs = await store.due(room, recipientKeyId, now, [...offered.keys()]);
  for (const job of jobs) {
    if (offered.has(job.id) && now - offered.get(job.id) < 15_000) continue;
    if (send(JSON.stringify({ type: 'relay.task-job', job })) === false) continue;
    offered.set(job.id, now);
  }
}

export function nodeTaskDispatchPump(store, sockets) {
  const offered = new WeakMap();
  return async () => {
    for (const [room, peers] of sockets) for (const peer of peers) {
      const state = peer.relayState;
      if (peer.readyState !== 1 || state?.role !== 'machine' || !state.taskDispatch) continue;
      const cache = offered.get(peer) ?? new Map();
      offered.set(peer, cache);
      await offerTaskJobs({ store, room, recipientKeyId: state.recipientKeyId, offered: cache,
        send: raw => { if (peer.readyState === 1) peer.send(raw); } });
    }
  };
}
