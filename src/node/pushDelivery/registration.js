import { readJson, sendJson } from "../http-payloads.js";
import { validDeviceToken, validRoom } from "../../relay/relayValidation.js";
import { apnsConfigured } from "../../relay/apnsWake.js";

const MAX_PUSH_BODY_BYTES = 4_096;

export async function handlePushRegistration({ request, response, store, env, url, authorize }) {
  const room = url.searchParams.get("room");
  if (!validRoom(room)) return sendJson(response, 400, { error: "valid room query parameter required" });
  const pinAuth = url.pathname === "/push/register";
  if (!authorize(room, pinAuth)) {
    return sendJson(response, 401, { error: "invalid room credential" });
  }
  if (url.pathname === "/push/status") {
    if (request.method !== "GET") return sendJson(response, 405, { error: "method not allowed" });
    return sendJson(response, 200, { enabled: apnsConfigured(env), devices: store.pushTokens(room).length });
  }
  if (!["PUT", "POST", "DELETE"].includes(request.method)) {
    return sendJson(response, 405, { error: "method not allowed" });
  }
  const body = await readJson(request, MAX_PUSH_BODY_BYTES);
  const token = String(body?.token ?? "").toLowerCase();
  if (!validDeviceToken(token)) return sendJson(response, 400, { error: "valid APNs token required" });
  if (!["sandbox", "production"].includes(body.environment)) {
    return sendJson(response, 400, { error: "environment must be sandbox or production" });
  }
  if (body.bundleId !== "com.ziborov.granttap") return sendJson(response, 400, { error: "unexpected bundle id" });
  const tokens = store.updatePushToken(room, { token, environment: body.environment, bundleId: body.bundleId },
    request.method === "DELETE");
  return sendJson(response, 200, { ok: true, registered: request.method !== "DELETE",
    enabled: apnsConfigured(env, body.environment), devices: tokens.length });
}

