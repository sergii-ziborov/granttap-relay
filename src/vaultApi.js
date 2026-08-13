/**
 * Durable Object coordinated ciphertext parking for GrantTap vault envelopes.
 * Server never sees unlock codes — only opaque AES-GCM envelopes keyed by
 * SHA-256(key material).
 */

import { isVaultEnvelope } from "./vaultCrypto.js";

export const MAX_VAULT_BODY_BYTES = 64_000;
export const VAULT_ID_RE = /^[a-f0-9]{64}$/;
export const VAULT_REVISION_RE = /^[a-f0-9]{64}$/;

const VAULT_RECORD_KEY = "vault:record";
const VAULT_INITIALIZED_KEY = "vault:initialized";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });

export function validVaultId(id) {
  return typeof id === "string" && VAULT_ID_RE.test(id);
}

/**
 * Serve a ciphertext-only vault with strong revision preconditions.
 *
 * Production passes a vault-scoped Durable Object storage instance. That makes
 * the read/check/write transaction strongly ordered; KV remains an encrypted
 * compatibility mirror and a one-time migration source for pre-CAS vaults.
 */
export async function handleVaultApi(request, env, durableStorage = null) {
  const url = new URL(request.url);
  const match = /^\/api\/vault\/([a-f0-9]{64})$/.exec(url.pathname);
  if (!match) return json({ error: "not found" }, 404);
  const vaultId = match[1];
  if (!validVaultId(vaultId)) return json({ error: "invalid vault id" }, 400);

  if (!env?.GRANTTAP_VAULT) {
    return json({ error: "vault storage not configured" }, 503);
  }

  if (durableStorage) await initializeDurableVault(durableStorage, env.GRANTTAP_VAULT, vaultId);

  if (request.method === "GET") {
    const record = await readRecord(env.GRANTTAP_VAULT, vaultId, durableStorage);
    if (!record) return json({ error: "vault not found" }, 404);
    return revisionJson({ ok: true, envelope: record.envelope, revision: record.revision }, 200, record.revision);
  }

  if (request.method === "PUT" || request.method === "POST") {
    let body;
    try {
      body = await readJsonLimited(request, MAX_VAULT_BODY_BYTES);
    } catch {
      return json({ error: "bounded JSON body required" }, 400);
    }
    const envelope = body?.envelope ?? body;
    if (!isVaultEnvelope(envelope)) {
      return json({ error: "valid vault envelope required" }, 400);
    }
    if (envelope.iv.length > 64 || envelope.ciphertext.length > 48_000) {
      return json({ error: "envelope too large" }, 400);
    }
    const nextEnvelope = {
      v: 1,
      iv: envelope.iv,
      ciphertext: envelope.ciphertext,
      createdAt: envelope.createdAt,
      updatedAt: envelope.updatedAt,
    };
    const nextRecord = {
      envelope: nextEnvelope,
      revision: await revisionForEnvelope(nextEnvelope),
    };
    const precondition = parseWritePrecondition(request);
    if (precondition.error) return json({ error: precondition.error }, precondition.status);

    const outcome = await compareAndSwap(
      env.GRANTTAP_VAULT,
      vaultId,
      durableStorage,
      precondition,
      nextRecord,
    );
    if (!outcome.ok) {
      return revisionJson(
        { error: "vault revision conflict", revision: outcome.current?.revision ?? null },
        412,
        outcome.current?.revision,
      );
    }
    // The Durable Object is canonical. KV mirrors only opaque ciphertext so an
    // older deployment can still be migrated without ever seeing the key.
    if (durableStorage) {
      await env.GRANTTAP_VAULT.put(vaultId, JSON.stringify(nextEnvelope)).catch(() => {});
    }
    return revisionJson({ ok: true, revision: nextRecord.revision }, 200, nextRecord.revision);
  }

  if (request.method === "DELETE") {
    const precondition = parseDeletePrecondition(request);
    if (precondition.error) return json({ error: precondition.error }, precondition.status);
    const outcome = await compareAndDelete(
      env.GRANTTAP_VAULT,
      vaultId,
      durableStorage,
      precondition.revision,
    );
    if (!outcome.ok) {
      return revisionJson(
        { error: "vault revision conflict", revision: outcome.current?.revision ?? null },
        412,
        outcome.current?.revision,
      );
    }
    if (durableStorage) await env.GRANTTAP_VAULT.delete(vaultId).catch(() => {});
    return json({ ok: true });
  }

  return json({ error: "method not allowed" }, 405);
}

function revisionJson(body, status, revision) {
  const response = json(body, status);
  if (revision) response.headers.set("etag", `"${revision}"`);
  return response;
}

async function revisionForEnvelope(envelope) {
  const canonical = JSON.stringify({
    v: envelope.v,
    iv: envelope.iv,
    ciphertext: envelope.ciphertext,
    createdAt: envelope.createdAt,
    updatedAt: envelope.updatedAt,
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function recordFromStored(raw) {
  if (!raw) return null;
  if (isVaultEnvelope(raw)) {
    return { envelope: raw, revision: await revisionForEnvelope(raw) };
  }
  if (isVaultEnvelope(raw.envelope) && VAULT_REVISION_RE.test(raw.revision)) {
    return { envelope: raw.envelope, revision: raw.revision };
  }
  return null;
}

async function initializeDurableVault(storage, kv, vaultId) {
  if (await storage.get(VAULT_INITIALIZED_KEY)) return;
  const legacy = await recordFromStored(await kv.get(vaultId, "json"));
  await storage.transaction(async (txn) => {
    if (await txn.get(VAULT_INITIALIZED_KEY)) return;
    if (legacy) await txn.put(VAULT_RECORD_KEY, legacy);
    await txn.put(VAULT_INITIALIZED_KEY, true);
  });
}

async function readRecord(kv, vaultId, storage) {
  if (storage) return recordFromStored(await storage.get(VAULT_RECORD_KEY));
  return recordFromStored(await kv.get(vaultId, "json"));
}

function parseWritePrecondition(request) {
  const ifMatch = request.headers.get("if-match");
  const ifNoneMatch = request.headers.get("if-none-match");
  if (ifMatch && ifNoneMatch) {
    return { error: "use exactly one vault revision precondition", status: 400 };
  }
  if (ifNoneMatch != null) {
    if (ifNoneMatch.trim() !== "*") {
      return { error: "If-None-Match must be * when creating a vault", status: 400 };
    }
    return { kind: "create" };
  }
  if (ifMatch != null) {
    const revision = parseStrongEtag(ifMatch);
    if (!revision) return { error: "If-Match must contain one strong vault ETag", status: 400 };
    return { kind: "update", revision };
  }
  return { error: "vault revision precondition required", status: 428 };
}

function parseDeletePrecondition(request) {
  const revision = parseStrongEtag(request.headers.get("if-match"));
  if (!revision) return { error: "exact If-Match vault ETag required", status: 428 };
  return { revision };
}

function parseStrongEtag(value) {
  const match = /^"([a-f0-9]{64})"$/.exec(String(value ?? "").trim());
  return match?.[1] ?? null;
}

async function compareAndSwap(kv, vaultId, storage, precondition, nextRecord) {
  if (storage) {
    return storage.transaction(async (txn) => {
      const current = await recordFromStored(await txn.get(VAULT_RECORD_KEY));
      if (!preconditionAllows(precondition, current)) return { ok: false, current };
      await txn.put(VAULT_RECORD_KEY, nextRecord);
      return { ok: true, current };
    });
  }
  const current = await readRecord(kv, vaultId, null);
  if (!preconditionAllows(precondition, current)) return { ok: false, current };
  await kv.put(vaultId, JSON.stringify(nextRecord.envelope));
  return { ok: true, current };
}

function preconditionAllows(precondition, current) {
  if (precondition.kind === "create") return current == null;
  return current?.revision === precondition.revision;
}

async function compareAndDelete(kv, vaultId, storage, expectedRevision) {
  if (storage) {
    return storage.transaction(async (txn) => {
      const current = await recordFromStored(await txn.get(VAULT_RECORD_KEY));
      if (current?.revision !== expectedRevision) return { ok: false, current };
      await txn.delete(VAULT_RECORD_KEY);
      return { ok: true, current };
    });
  }
  const current = await readRecord(kv, vaultId, null);
  if (current?.revision !== expectedRevision) return { ok: false, current };
  await kv.delete(vaultId);
  return { ok: true, current };
}

async function readJsonLimited(request, maxBytes) {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("body too large");
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maxBytes) {
      await reader.cancel();
      throw new Error("body too large");
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(merged));
}
