/** Flush one retained frame at a time so a restored cache cannot flood socket buffers. */
export async function replayNodeFrames(socket, rows, delivery, metrics) {
  for (const item of rows) {
    if (socket.readyState !== 1) break;
    let deliveryId = item.deliveryId;
    if (deliveryId == null) {
      try { deliveryId = JSON.parse(item.raw)?.deliveryId; } catch { /* Synthetic/non-envelope replay has no response allowance. */ }
    }
    const sent = delivery?.sendAndWait ? await delivery.sendAndWait(socket, item.raw, deliveryId)
      : delivery ? delivery.send(socket, item.raw, undefined, deliveryId) : (socket.send(item.raw), true);
    if (!sent) break;
    metrics?.record('forwarded');
    if (Number.isFinite(item.queuedAt)) metrics?.timing('forward', Date.now() - item.queuedAt);
  }
}
