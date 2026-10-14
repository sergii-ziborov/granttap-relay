/** An opaque public-key digest selects ciphertext; it grants no decryption rights. */
export function validRecipientKeyId(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

export function matchesRecipient(envelope, recipientKeyId) {
  return !recipientKeyId || !envelope?.recipientKeyId || envelope.recipientKeyId === recipientKeyId;
}

export function matchesQueuedRecipient(raw, recipientKeyId) {
  if (!recipientKeyId) return true;
  try { return matchesRecipient(JSON.parse(raw), recipientKeyId); }
  catch { return false; }
}
