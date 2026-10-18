/** Explicit client submissions survive transient catalog traffic until decrypt ACK or expiry. */
export function isDurableSubmission(deliveryId) {
  return typeof deliveryId === 'string' && ['user-message-', 'approval-decision-', 'attachment-']
    .some(prefix => deliveryId.startsWith(prefix) && deliveryId.length > prefix.length);
}

export function retainSubmission(queue, incoming, maxCount = 100, maxBytes = 1_800_000) {
  const rows = [...queue, incoming];
  let bytes = rows.reduce((sum, row) => sum + rowBytes(row), 0);
  while (rows.length > maxCount || bytes > maxBytes) {
    const removable = rows.findIndex(row => !isDurableSubmission(row?.deliveryId));
    if (removable < 0 || rows[removable] === incoming) return { result: 'full', rows: queue };
    bytes -= rowBytes(rows.splice(removable, 1)[0]);
  }
  return { result: 'stored', rows };
}

function rowBytes(row) {
  return Number.isFinite(row?.rawBytes) ? row.rawBytes
    : new TextEncoder().encode(typeof row === 'string' ? row : row.raw).byteLength;
}

export function storedSubmissionNotice(deliveryId) {
  return JSON.stringify({ type: 'relay.stored', deliveryId });
}
