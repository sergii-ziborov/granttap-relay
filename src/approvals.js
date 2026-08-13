/**
 * Visible Cloudflare approval surface — first-class Allow cards with danger
 * level + Accept/Decline. Not chat/notify text.
 *
 * Deliberate exception to E2EE: room-scoped, expiring command summaries so a
 * browser can render Accept/Decline. Machine publishes with Bearer room cred;
 * the page uses an unguessable durable capability token.
 */

export const APPROVALS_VIEW_KEY = "approvals:view";
export const APPROVALS_ITEMS_KEY = "approvals:items";
export const APPROVALS_LIMIT = 24;
export const APPROVALS_DEFAULT_TTL_MS = 15 * 60 * 1000;
export const APPROVALS_MAX_TTL_MS = 60 * 60 * 1000;
export const MAX_APPROVAL_BODY_BYTES = 16_384;

const DANGER = new Set(["safe", "caution", "dangerous", "destructive"]);

export function validViewToken(token) {
  return typeof token === "string" && /^[a-f0-9]{64}$/.test(token);
}

export function validRequestId(id) {
  return typeof id === "string" && id.length >= 4 && id.length <= 180;
}

export function normalizeDanger(value) {
  if (typeof value === "string" && DANGER.has(value)) return value;
  return "caution";
}

export function pruneApprovals(items, now = Date.now()) {
  return (items ?? [])
    .filter((item) => item && typeof item === "object")
    .filter((item) => (item.expiresAt ?? 0) > now)
    .slice(-APPROVALS_LIMIT);
}

export function upsertApproval(items, card, now = Date.now()) {
  const next = pruneApprovals(items, now).filter((item) => item.requestId !== card.requestId);
  next.push(card);
  return next.slice(-APPROVALS_LIMIT);
}

export function applyDecision(items, requestId, decision, decidedBy, now = Date.now()) {
  let found = false;
  const next = pruneApprovals(items, now).map((item) => {
    if (item.requestId !== requestId || item.status !== "pending") return item;
    found = true;
    return {
      ...item,
      status: decision,
      decidedAt: now,
      decidedBy,
    };
  });
  return { found, items: next };
}

export function publicCard(item) {
  return {
    requestId: item.requestId,
    danger: item.danger,
    title: item.title,
    command: item.command ?? null,
    cwd: item.cwd ?? null,
    agent: item.agent,
    tool: item.tool ?? null,
    sessionId: item.sessionId ?? null,
    createdAt: item.createdAt,
    expiresAt: item.expiresAt,
    status: item.status,
    decidedAt: item.decidedAt ?? null,
    decidedBy: item.decidedBy ?? null,
  };
}

export function parseApprovalCard(body, now = Date.now()) {
  if (!body || typeof body !== "object") return { error: "JSON body required" };
  if (!validRequestId(body.requestId)) return { error: "valid requestId required" };
  const title = String(body.title ?? "").trim();
  if (!title || title.length > 800) return { error: "title required (≤800 chars)" };
  const command = body.command == null ? null : String(body.command).slice(0, 4000);
  const ttlMs = Number.isFinite(body.ttlMs)
    ? Math.min(Math.max(Number(body.ttlMs), 5_000), APPROVALS_MAX_TTL_MS)
    : APPROVALS_DEFAULT_TTL_MS;
  return {
    card: {
      requestId: String(body.requestId),
      batchId: body.batchId ? String(body.batchId).slice(0, 80) : null,
      danger: normalizeDanger(body.danger),
      title,
      command,
      cwd: body.cwd == null ? null : String(body.cwd).slice(0, 500),
      agent: String(body.agent ?? "agent").slice(0, 64),
      tool: body.tool == null ? null : String(body.tool).slice(0, 80),
      sessionId: body.sessionId == null ? null : String(body.sessionId).slice(0, 180),
      createdAt: Number.isFinite(body.createdAt) ? Number(body.createdAt) : now,
      expiresAt: now + ttlMs,
      status: "pending",
    },
  };
}

export function approvalsPageHtml(room, viewToken) {
  const roomAttr = escapeHtml(room);
  const tokenAttr = escapeHtml(viewToken);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta name="robots" content="noindex,nofollow"/>
<title>GrantTap Approvals</title>
<style>
:root{
  --bg:#0f1419;--panel:#1a222c;--text:#e8eef4;--muted:#8b9aab;
  --safe:#3d8f6a;--caution:#c9a227;--dangerous:#d17a3a;--destructive:#c44b4b;
  --line:#2a3542;--btn:#e8eef4;--btnText:#0f1419;--deny:#3a4552;
}
*{box-sizing:border-box}
body{margin:0;font:15px/1.45 ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif;
  background:radial-gradient(1200px 600px at 10% -10%,#1c2a38,transparent),var(--bg);color:var(--text);min-height:100vh}
header{padding:1.25rem 1.25rem .5rem;max-width:720px;margin:0 auto}
h1{font-size:1.35rem;margin:0 0 .25rem;letter-spacing:-.02em}
.sub{color:var(--muted);font-size:.9rem}
main{max-width:720px;margin:0 auto;padding:0 1.25rem 2.5rem;display:grid;gap:1rem}
.empty{color:var(--muted);padding:2rem 0}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:1rem 1.1rem}
.row{display:flex;align-items:center;gap:.6rem;flex-wrap:wrap;margin-bottom:.55rem}
.badge{font-size:.72rem;font-weight:700;letter-spacing:.04em;text-transform:uppercase;
  padding:.28rem .55rem;border-radius:999px;color:#0b1014}
.badge.safe{background:var(--safe)}.badge.caution{background:var(--caution)}
.badge.dangerous{background:var(--dangerous)}.badge.destructive{background:var(--destructive)}
.agent{color:var(--muted);font-size:.85rem}
.title{font-weight:600;margin:.15rem 0 .5rem;white-space:pre-wrap}
pre{margin:0;padding:.75rem;background:#0c1117;border-radius:8px;overflow:auto;
  font:12.5px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#d7e2ec;max-height:220px}
.meta{color:var(--muted);font-size:.8rem;margin:.55rem 0 .85rem}
.actions{display:flex;gap:.6rem;flex-wrap:wrap}
button{appearance:none;border:0;border-radius:10px;padding:.7rem 1.1rem;font-weight:650;cursor:pointer;font-size:.95rem}
button.accept{background:var(--btn);color:var(--btnText)}
button.decline{background:var(--deny);color:var(--text)}
button:disabled{opacity:.5;cursor:default}
.status{font-size:.85rem;color:var(--muted)}
footer{max-width:720px;margin:0 auto;padding:0 1.25rem 2rem;color:var(--muted);font-size:.78rem}
</style>
</head>
<body>
<header>
  <h1>GrantTap Approvals</h1>
  <p class="sub">Accept or decline pending shell allows. This is not a chat message.</p>
</header>
<main id="root"><p class="empty">Loading…</p></main>
<footer>Room <code>${roomAttr}</code> · auto-refreshes · requests expire; keep this page URL private</footer>
<script>
const ROOM=${JSON.stringify(room)};
const TOKEN=${JSON.stringify(viewToken)};
const root=document.getElementById("root");
function esc(s){return String(s??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}
function label(d){return ({safe:"Safe",caution:"Caution",dangerous:"Dangerous",destructive:"Destructive"})[d]||d;}
async function load(){
  const r=await fetch("/a/"+encodeURIComponent(ROOM)+"/"+encodeURIComponent(TOKEN)+"/json",{cache:"no-store"});
  if(!r.ok){root.innerHTML='<p class="empty">This approval page link is invalid.</p>';return;}
  const data=await r.json();
  const active=(data.approvals||[]).filter(a=>a.status==="pending"||a.status==="allow"||a.status==="deny");
  if(!active.length){root.innerHTML='<p class="empty">No approvals are waiting on this computer.</p>';return;}
  root.innerHTML=active.map(a=>\`
    <article class="card" data-id="\${esc(a.requestId)}">
      <div class="row">
        <span class="badge \${esc(a.danger)}">\${esc(label(a.danger))}</span>
        <span class="agent">\${esc(a.agent)}\${a.tool?" · "+esc(a.tool):""}</span>
      </div>
      <div class="title">\${esc(a.title)}</div>
      \${a.command?\`<pre>\${esc(a.command)}</pre>\`:""}
      <div class="meta">\${a.cwd?esc(a.cwd)+" · ":""}id \${esc(a.requestId)}</div>
      \${a.status==="pending"?\`<div class="actions">
        <button class="accept" data-act="allow">Accept</button>
        <button class="decline" data-act="deny">Decline</button>
      </div><p class="status" hidden></p>\`:\`<p class="status">\${a.status==="allow"?"Allowed":"Denied"} · sent; waiting for computer confirmation…</p>\`}
    </article>\`).join("");
  root.querySelectorAll("button").forEach(btn=>{
    btn.addEventListener("click",async()=>{
      const card=btn.closest(".card");
      const id=card.dataset.id;
      const decision=btn.dataset.act;
      card.querySelectorAll("button").forEach(b=>b.disabled=true);
      const st=card.querySelector(".status");
      st.hidden=false;st.textContent="Sending…";
      const res=await fetch("/a/"+encodeURIComponent(ROOM)+"/"+encodeURIComponent(TOKEN)+"/"+encodeURIComponent(id)+"/decide",{
        method:"POST",headers:{"content-type":"application/json"},
        body:JSON.stringify({decision})
      });
      if(!res.ok){st.textContent="Failed — try again";card.querySelectorAll("button").forEach(b=>b.disabled=false);return;}
      st.textContent=(decision==="allow"?"Allowed":"Denied")+" · sent; waiting for computer confirmation…";
      setTimeout(load,400);
    });
  });
}
load();
setInterval(load,2500);
</script>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function htmlResponse(html, status = 200) {
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}
