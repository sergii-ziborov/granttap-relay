import { json } from "./relaySupport.js";
import { validRoom } from "./relayValidation.js";

export async function routeRequest(request, env) {
  const url = new URL(request.url);
  const websocket = (request.headers.get("Upgrade") ?? "").toLowerCase() === "websocket";
  if (url.pathname === "/health") return json({ ok: true });
  if (/^\/pair\/([a-f0-9]{32})$/.test(url.pathname)) return routeTo(request, env, "CODES", url.pathname.slice(6));
  if (["/push/register", "/push/status"].includes(url.pathname)) return routeRoom(request, env, url);
  if (websocket) return routeRoom(request, env, url);
  return json({ error: "not found" }, 404);
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
