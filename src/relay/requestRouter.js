import { handleVaultApi } from "../vaultApi.js";
import { vaultHtmlResponse } from "../vaultPage.js";
import { approvalPreflight, vaultPreflight, withApprovalCors, withVaultCors } from "./relayCors.js";
import { json } from "./relaySupport.js";
import { validRoom } from "./relayValidation.js";

export async function routeRequest(request, env) {
  const url = new URL(request.url);
  const websocket = (request.headers.get("Upgrade") ?? "").toLowerCase() === "websocket";
  if (url.pathname === "/health") return json({ ok: true });
  if ((url.pathname === "/" || url.pathname === "/vault") && !websocket) return vaultPage(request);
  if (url.pathname.startsWith("/api/vault/")) return routeVault(request, env, url);
  if (/^\/pair\/([a-f0-9]{32})$/.test(url.pathname)) return routeTo(request, env, "CODES", url.pathname.slice(6));
  if (/^\/web-pair\/([a-f0-9]{32})$/.test(url.pathname)) return routeWebPair(request, env, url);
  if (["/push/register", "/push/status", "/approvals"].includes(url.pathname)) return routeRoom(request, env, url);
  if (/^\/a\/([a-f0-9]{16,64})\/([a-f0-9]{64})(?:\/(json)|\/([A-Za-z0-9._-]{4,180})\/decide)?$/.test(url.pathname)) {
    if (request.method === "OPTIONS") return approvalPreflight(request, env);
    return withApprovalCors(await routeTo(request, env, "ROOM", url.pathname.split("/")[2]), request, env);
  }
  if (websocket) return routeRoom(request, env, url);
  return json({ error: "not found" }, 404);
}

function vaultPage(request) {
  if (request.method === "GET" || request.method === "HEAD") return vaultHtmlResponse();
  return json({ error: "method not allowed" }, 405);
}

async function routeVault(request, env, url) {
  if (request.method === "OPTIONS") return vaultPreflight(request, env);
  const vaultId = /^\/api\/vault\/([a-f0-9]{64})$/.exec(url.pathname)?.[1];
  const response = vaultId && env?.VAULTS
    ? await env.VAULTS.get(env.VAULTS.idFromName(vaultId)).fetch(request)
    : await handleVaultApi(request, env);
  return withVaultCors(response, request, env);
}

async function routeWebPair(request, env, url) {
  if (request.method === "OPTIONS") return vaultPreflight(request, env);
  if (!env?.WEB_CODES) return withVaultCors(json({ error: "web pairing unavailable" }, 503), request, env);
  return withVaultCors(await routeTo(request, env, "WEB_CODES", url.pathname.slice(10)), request, env);
}

async function routeRoom(request, env, url) {
  const room = url.searchParams.get("room");
  if (!validRoom(room)) return json({ error: "valid room query parameter required" }, 400);
  return routeTo(request, env, "ROOM", room);
}

function routeTo(request, env, binding, name) {
  const namespace = env?.[binding];
  if (!namespace) return json({ error: "relay binding unavailable" }, 503);
  return namespace.get(namespace.idFromName(name)).fetch(request);
}
