/** Flush one retained frame at a time so a restored cache cannot flood socket buffers. */
export async function replayNodeFrames(socket, rows, delivery, metrics) {
  for (const item of rows) {
    if (socket.readyState !== 1) break;
    const sent = delivery?.sendAndWait ? await delivery.sendAndWait(socket, item.raw)
      : delivery ? delivery.send(socket, item.raw) : (socket.send(item.raw), true);
    if (!sent) break;
    metrics?.record('forwarded');
    if (Number.isFinite(item.queuedAt)) metrics?.timing('forward', Date.now() - item.queuedAt);
  }
}
