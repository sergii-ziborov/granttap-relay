import { json } from "./relaySupport.js";

const DEFAULT_WEB_ORIGINS = new Set([
  "https://granttap.com",
  "https://www.granttap.com",
  "https://granttap-vault.lovable.app",
]);

export function approvalPreflight(request, env) {
  const origin = allowedWebOrigin(request, env);
  if (!origin) return json({ error: "origin not allowed" }, 403);
  const method = (request.headers.get("Access-Control-Request-Method") ?? "").toUpperCase();
  if (method !== "GET" && method !== "POST") return withApprovalCors(json({ error: "method not allowed" }, 405), request, env);
  const headers = requestedHeaders(request);
  if (headers.some((value) => value !== "content-type" && value !== "accept")) {
    return withApprovalCors(json({ error: "headers not allowed" }, 403), request, env);
  }
  return withApprovalCors(new Response(null, { status: 204, headers: { "cache-control": "no-store" } }), request, env, true);
}

export function vaultPreflight(request, env) {
  const origin = allowedWebOrigin(request, env);
  if (!origin) return json({ error: "origin not allowed" }, 403);
  const method = (request.headers.get("Access-Control-Request-Method") ?? "").toUpperCase();
  if (!["GET", "PUT", "POST", "DELETE"].includes(method)) {
    return withApprovalCors(json({ error: "method not allowed" }, 405), request, env);
  }
  const allowed = new Set(["content-type", "accept", "if-match", "if-none-match"]);
  if (requestedHeaders(request).some((value) => !allowed.has(value))) {
    return withVaultCors(json({ error: "headers not allowed" }, 403), request, env);
  }
  return withVaultCors(new Response(null, { status: 204, headers: { "cache-control": "no-store" } }), request, env, true);
}

export function withVaultCors(response, request, env, preflight = false) {
  const next = withApprovalCors(response, request, env, preflight);
  if (!allowedWebOrigin(request, env)) return next;
  next.headers.set("Access-Control-Expose-Headers", "ETag");
  if (preflight) {
    next.headers.set("Access-Control-Allow-Methods", "GET, PUT, POST, DELETE, OPTIONS");
    next.headers.set("Access-Control-Allow-Headers", "Content-Type, Accept, If-Match, If-None-Match");
  }
  return next;
}

export function withApprovalCors(response, request, env, preflight = false) {
  const origin = allowedWebOrigin(request, env);
  if (!origin) return response;
  const next = new Response(response.body, response);
  next.headers.set("Access-Control-Allow-Origin", origin);
  appendVary(next.headers, "Origin");
  if (preflight) {
    next.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    next.headers.set("Access-Control-Allow-Headers", "Content-Type, Accept");
    next.headers.set("Access-Control-Max-Age", "600");
  }
  return next;
}

export function allowedWebOrigin(request, env) {
  const raw = request.headers.get("Origin");
  if (!raw) return null;
  let parsed;
  try { parsed = new URL(raw); } catch { return null; }
  if (parsed.origin !== raw || parsed.username || parsed.password) return null;
  if (parsed.origin === new URL(request.url).origin || DEFAULT_WEB_ORIGINS.has(parsed.origin)) return parsed.origin;
  if (["localhost", "127.0.0.1"].includes(parsed.hostname) && ["http:", "https:"].includes(parsed.protocol)) {
    return parsed.origin;
  }
  const configured = String(env?.GRANTTAP_WEB_ORIGINS ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  return configured.some((value) => isExactOrigin(value, parsed.origin)) ? parsed.origin : null;
}

function requestedHeaders(request) {
  return (request.headers.get("Access-Control-Request-Headers") ?? "")
    .split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
}

function isExactOrigin(value, origin) {
  try {
    const candidate = new URL(value);
    return candidate.origin === value && candidate.origin === origin;
  } catch {
    return false;
  }
}

function appendVary(headers, value) {
  const entries = (headers.get("Vary") ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  if (!entries.some((item) => item.toLowerCase() === value.toLowerCase())) entries.push(value);
  headers.set("Vary", entries.join(", "));
}
