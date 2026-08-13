import {
  APPROVALS_ITEMS_KEY,
  APPROVALS_VIEW_KEY,
  MAX_APPROVAL_BODY_BYTES,
  applyDecision,
  approvalsPageHtml,
  htmlResponse,
  parseApprovalCard,
  pruneApprovals,
  publicCard,
  upsertApproval,
  validRequestId,
  validViewToken,
} from "../approvals.js";
import { json, randomHex, readJsonLimited } from "./relaySupport.js";
import { validRoom } from "./relayValidation.js";

export async function handleApprovalsApi(roomObject, request) {
  const url = new URL(request.url);
  const room = url.searchParams.get("room");
  if (!validRoom(room)) return json({ error: "valid room query parameter required" }, 400);
  const authError = await roomObject.requireRoomAuth(request);
  if (authError) return authError;
  if (request.method === "GET") return listApprovals(roomObject, url, room);
  if (request.method === "PUT" || request.method === "POST") return publishApproval(roomObject, request, url, room);
  if (request.method === "DELETE") return deleteApproval(roomObject, url);
  return json({ error: "method not allowed" }, 405);
}

export async function handleApprovalsPage(roomObject, request) {
  const match = /^\/a\/([a-f0-9]{16,64})\/([a-f0-9]{64})(?:\/(json)|\/([A-Za-z0-9._-]{4,180})\/decide)?$/.exec(new URL(request.url).pathname);
  if (!match) return json({ error: "not found" }, 404);
  const [, room, viewToken, jsonPath, decideId] = match;
  if (!validViewToken(viewToken)) return json({ error: "invalid view token" }, 401);
  const stored = await roomObject.state.storage.get(APPROVALS_VIEW_KEY);
  if (!stored?.token || !roomObject.tokensEqual(stored.token, viewToken)) return json({ error: "invalid view token" }, 401);
  if (decideId) return decideApproval(roomObject, request, decideId);
  const items = pruneApprovals(await roomObject.state.storage.get(APPROVALS_ITEMS_KEY));
  if (jsonPath) return request.method === "GET"
    ? json({ ok: true, approvals: items.map(publicCard) })
    : json({ error: "method not allowed" }, 405);
  return request.method === "GET"
    ? htmlResponse(approvalsPageHtml(room, viewToken))
    : json({ error: "method not allowed" }, 405);
}

export async function ensureViewToken(roomObject) {
  const existing = await roomObject.state.storage.get(APPROVALS_VIEW_KEY);
  if (existing?.token && validViewToken(existing.token)) return existing;
  const view = { token: randomHex(32), createdAt: Date.now() };
  await roomObject.state.storage.put(APPROVALS_VIEW_KEY, view);
  return view;
}

async function listApprovals(roomObject, url, room) {
  const items = pruneApprovals(await roomObject.state.storage.get(APPROVALS_ITEMS_KEY));
  const view = await ensureViewToken(roomObject);
  return json({ ok: true, pageUrl: `${url.origin}/a/${room}/${view.token}`, viewToken: view.token, approvals: items.map(publicCard) });
}

async function publishApproval(roomObject, request, url, room) {
  let body;
  try { body = await readJsonLimited(request, MAX_APPROVAL_BODY_BYTES); } catch { return json({ error: "bounded JSON body required" }, 400); }
  const parsed = parseApprovalCard(body);
  if (parsed.error) return json({ error: parsed.error }, 400);
  const items = upsertApproval(await roomObject.state.storage.get(APPROVALS_ITEMS_KEY), parsed.card);
  await roomObject.state.storage.put(APPROVALS_ITEMS_KEY, items);
  const view = await ensureViewToken(roomObject);
  return json({ ok: true, pageUrl: `${url.origin}/a/${room}/${view.token}`, viewToken: view.token, approval: publicCard(parsed.card) });
}

async function deleteApproval(roomObject, url) {
  const requestId = url.searchParams.get("requestId");
  const cancelAll = url.searchParams.get("all") === "1";
  let items = pruneApprovals(await roomObject.state.storage.get(APPROVALS_ITEMS_KEY));
  if (cancelAll) items = items.filter((item) => item.status !== "pending");
  else if (validRequestId(requestId)) items = items.filter((item) => item.requestId !== requestId);
  else return json({ error: "requestId or all=1 required" }, 400);
  if (items.length) await roomObject.state.storage.put(APPROVALS_ITEMS_KEY, items);
  else await roomObject.state.storage.delete(APPROVALS_ITEMS_KEY);
  return json({ ok: true });
}

async function decideApproval(roomObject, request, requestId) {
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
  let body;
  try { body = await readJsonLimited(request, MAX_APPROVAL_BODY_BYTES); } catch { return json({ error: "bounded JSON body required" }, 400); }
  const decision = body?.decision === "allow" || body?.decision === "deny" ? body.decision : null;
  if (!decision) return json({ error: "decision must be allow or deny" }, 400);
  if (!validRequestId(requestId)) return json({ error: "invalid requestId" }, 400);
  const applied = applyDecision(await roomObject.state.storage.get(APPROVALS_ITEMS_KEY), requestId, decision, "web");
  if (!applied.found) return json({ error: "approval not pending" }, 404);
  await roomObject.state.storage.put(APPROVALS_ITEMS_KEY, applied.items);
  return json({ ok: true, requestId, decision });
}
