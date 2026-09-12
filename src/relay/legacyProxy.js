import { json } from "./relaySupport.js";
import { validRoom } from "./relayValidation.js";

const PAIRING_PATH = /^\/pair\/[a-f0-9]{32}$/;
const PUSH_PATHS = new Set(["/push/register", "/push/status"]);

export async function proxyLegacyRequest(request, upstreamOrigin, fetcher = fetch) {
  const incoming = new URL(request.url);
  if (!allowedRequest(request, incoming)) return json({ error: "not found" }, 404);

  let upstream;
  try {
    upstream = new URL(upstreamOrigin);
  } catch {
    return json({ error: "relay upstream unavailable" }, 503);
  }
  if (upstream.protocol !== "https:" || upstream.host === incoming.host) {
    return json({ error: "relay upstream unavailable" }, 503);
  }

  upstream.pathname = incoming.pathname;
  upstream.search = incoming.search;
  return fetcher(new Request(upstream, request));
}

function allowedRequest(request, url) {
  if (url.pathname === "/health") return request.method === "GET";
  if (PAIRING_PATH.test(url.pathname)) {
    return request.method === "GET" || request.method === "PUT" || request.method === "POST";
  }
  if (PUSH_PATHS.has(url.pathname)) {
    return validRoom(url.searchParams.get("room"));
  }
  const websocket = (request.headers.get("Upgrade") ?? "").toLowerCase() === "websocket";
  return url.pathname === "/" && websocket && validRoom(url.searchParams.get("room"));
}
