import { constantTimeEqual } from '../relay/relaySupport.js';
import { validEnvelope, validRoom } from '../relay/relayValidation.js';

export const JOB_TTL_MS = 30 * 86_400_000;
export const JOB_BYTES = 22_000_000;
export const ROOM_JOB_BYTES = 48_000_000;
export const ROOM_JOB_LIMIT = 100;
export const ROOM_RECEIPT_LIMIT = 10_000;
export const retainsTaskPayload = row => ["queued", "accepted", "failed"].includes(row.state);
const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{7,119}$/;
const digestPattern = /^[a-f0-9]{64}$/;

export function validJobId(id) { return typeof id === 'string' && idPattern.test(id); }

export function normalizeJob(room, id, body, now) {
  if (!validRoom(room) || !validJobId(id) || !body || typeof body !== 'object'
    || Object.keys(body).some(key => !['notBefore', 'expiresAt', 'acceptanceHash', 'envelope', 'writerId', 'writerSourceKeyId'].includes(key))) return null;
  if (body.writerId !== undefined && !validJobId(body.writerId)) return null;
  if (body.writerId !== undefined && !digestPattern.test(body.writerSourceKeyId ?? '')) return null;
  if (body.writerId === undefined && body.writerSourceKeyId !== undefined) return null;
  const { notBefore, expiresAt, acceptanceHash, envelope } = body;
  if (!Number.isSafeInteger(notBefore) || !Number.isSafeInteger(expiresAt)
    || notBefore < 0 || expiresAt <= now || expiresAt <= notBefore
    || expiresAt - notBefore > JOB_TTL_MS
    || expiresAt > now + JOB_TTL_MS || !digestPattern.test(acceptanceHash ?? '')) return null;
  if (!envelope || envelope.deliveryId !== id || envelope.to !== 'machine'
    || !digestPattern.test(envelope.recipientKeyId ?? '') || envelope.expiresAt !== expiresAt
    || !validEnvelope(envelope, room, now, JOB_TTL_MS)) return null;
  const orderedEnvelope = Object.fromEntries(Object.entries(envelope).sort(([a], [b]) => a.localeCompare(b)));
  const normalized = { notBefore, expiresAt, acceptanceHash, envelope: orderedEnvelope,
    ...(body.writerId ? { writerId: body.writerId, writerSourceKeyId: body.writerSourceKeyId } : {}) };
  const encoded = JSON.stringify(normalized);
  if (new TextEncoder().encode(encoded).length > JOB_BYTES) return null;
  return { ...normalized, canonical: encoded, bytes: new TextEncoder().encode(encoded).length };
}

export function publicJob(row) {
  const { id, state, notBefore, expiresAt, createdAt, updatedAt, envelope, resultCode, writerId, resultEnvelope } = row;
  return { id, state, notBefore, expiresAt, createdAt, updatedAt, envelope,
    ...(resultCode ? { resultCode } : {}), ...(writerId ? { writerId } : {}), ...(resultEnvelope ? { resultEnvelope } : {}) };
}

export function expireJob(row, now) {
  return row.state === 'queued' && row.expiresAt <= now
    ? retireJob(row, 'expired', row.expiresAt) : row;
}

export function claimJob(row, proof, now, proofHash) {
  if (!validProof(row, proof, proofHash)) return { status: 403, error: 'invalid acceptance proof' };
  const current = expireJob(row, now);
  if (!validJobId(proof?.claimId)) return { status: 400, error: 'invalid receiver attempt' };
  if (current.state === 'accepted') return current.claimId === proof.claimId
    ? { status: 200, row: current } : { status: 409, error: 'another receiver accepted this job' };
  if (current.state !== 'queued' || current.notBefore > now) return { status: 409, error: 'job is not ready' };
  return { status: 200, row: { ...current, state: 'accepted', claimId: proof.claimId, updatedAt: now } };
}

export function cancelJob(row, now) {
  const current = expireJob(row, now);
  if (current.state === 'cancelled') return { status: 200, row: current };
  if (!['queued', 'failed'].includes(current.state)) return { status: 409, error: 'job has already left the relay queue' };
  return { status: 200, row: retireJob(current, 'cancelled', now) };
}

export function finishJob(row, proof, now, proofHash) {
  if (!validProof(row, proof, proofHash)) return { status: 403, error: 'invalid acceptance proof' };
  if (!row.claimId) return { status: 409, error: 'job has not been accepted' };
  if (!validJobId(proof?.claimId) || row.claimId !== proof.claimId) return { status: 403, error: 'invalid receiver attempt' };
  if (!['completed', 'failed'].includes(proof.state)) return { status: 400, error: 'invalid final state' };
  const codes = ['provider_unavailable', 'policy_denied', 'delivery_failed', 'cancelled', 'confirmation_required'];
  if (proof.resultCode !== undefined && !codes.includes(proof.resultCode)) return { status: 400, error: 'invalid result code' };
  if (row.state === proof.state) return { status: 200, row };
  if (row.state !== 'accepted') return { status: 409, error: 'job has not been accepted' };
  if (proof.resultEnvelope !== undefined) {
    const result = proof.resultEnvelope;
    if (!row.writerId || !result || result.from !== 'machine' || result.to !== 'machine'
      || result.recipientKeyId !== row.writerSourceKeyId
      || !validEnvelope(result, row.envelope.room, now, JOB_TTL_MS)
      || new TextEncoder().encode(JSON.stringify(result)).length > 32_000) {
      return { status: 400, error: 'invalid encrypted task result' };
    }
  }
  const result = proof.state === 'completed' ? retireJob(row, proof.state, now)
    : { ...row, state: proof.state, updatedAt: now };
  return { status: 200, row: { ...result, ...(proof.resultCode ? { resultCode: proof.resultCode } : {}),
    ...(proof.resultEnvelope ? { resultEnvelope: proof.resultEnvelope } : {}) } };
}

function validProof(row, proof, proofHash) {
  if (proof?.recipientKeyId !== row.envelope.recipientKeyId || !digestPattern.test(proof?.token ?? '')) return false;
  return typeof proofHash === 'string' && constantTimeEqual(proofHash, row.acceptanceHash);
}

function retireJob(row, state, updatedAt) {
  const { box, nonce, ...routing } = row.envelope;
  return { ...row, envelope: routing, state, updatedAt, bytes: 0 };
}

/** Status lists never echo complete encrypted photos. Read one job to recover its ciphertext. */
export function taskJobMetadata(row) {
  if (!row) return row;
  const { box, nonce, ...routing } = row.envelope;
  return { ...row, envelope: routing };
}
