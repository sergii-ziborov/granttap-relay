/**
 * GrantTap vault login UI — served from the relay Worker.
 * Brand: ink/slate + warm amber accent (matches approvals surface, not purple AI).
 */

import { htmlResponse } from "./approvals.js";

export function vaultPageHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta name="robots" content="noindex,nofollow"/>
<title>GrantTap — Unlock</title>
<style>
:root{
  --bg:#0f1419;--panel:#1a222c;--text:#e8eef4;--muted:#8b9aab;
  --line:#2a3542;--accent:#d4a574;--accentText:#0f1419;
  --ok:#3d8f6a;--bad:#c44b4b;--field:#0c1117;
}
*{box-sizing:border-box}
body{
  margin:0;min-height:100vh;color:var(--text);
  font:16px/1.5 "Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif;
  background:
    radial-gradient(900px 480px at 85% -10%,rgba(212,165,116,.14),transparent 55%),
    radial-gradient(700px 420px at 0% 100%,rgba(61,143,106,.08),transparent 50%),
    var(--bg);
}
.wrap{max-width:440px;margin:0 auto;padding:2.5rem 1.25rem 3rem}
.brand{
  font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif;
  font-size:1.75rem;font-weight:750;letter-spacing:-.04em;margin:0 0 .35rem;
}
.tag{color:var(--muted);font-size:.95rem;margin:0 0 1.75rem;
  font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif}
.panel{
  background:linear-gradient(180deg,rgba(26,34,44,.95),rgba(15,20,25,.9));
  border:1px solid var(--line);border-radius:14px;padding:1.35rem 1.25rem 1.4rem;
  box-shadow:0 18px 40px rgba(0,0,0,.28);
}
label{display:block;font-size:.78rem;letter-spacing:.06em;text-transform:uppercase;
  color:var(--muted);margin-bottom:.45rem;
  font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif}
textarea,input{
  width:100%;background:var(--field);color:var(--text);border:1px solid var(--line);
  border-radius:10px;padding:.85rem .9rem;font:13px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  resize:vertical;min-height:4.5rem;
}
textarea:focus,input:focus{outline:2px solid rgba(212,165,116,.45);outline-offset:1px}
.row{display:flex;gap:.6rem;flex-wrap:wrap;margin-top:1rem}
button{
  appearance:none;border:0;border-radius:10px;padding:.72rem 1.15rem;font-weight:650;cursor:pointer;
  font:14px/1 ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif;
}
button.primary{background:var(--accent);color:var(--accentText)}
button.ghost{background:#2a3542;color:var(--text)}
button:disabled{opacity:.5;cursor:default}
.msg{margin:.9rem 0 0;font-size:.9rem;min-height:1.2em;
  font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif}
.msg.bad{color:#f0a0a0}.msg.ok{color:#9fd4b8}
.shell{display:none}
.shell.on{display:block}
.login.on{display:block}
.login{display:none}
.stat{
  display:grid;gap:.65rem;margin-top:.25rem;
  font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif;font-size:.92rem;
}
.stat div{display:flex;justify-content:space-between;gap:1rem;padding:.55rem 0;border-bottom:1px solid var(--line)}
.stat span{color:var(--muted)}
.codebox{
  margin-top:1rem;padding:.85rem;background:var(--field);border:1px dashed var(--line);
  border-radius:10px;font:12.5px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  word-break:break-all;display:none;
}
.codebox.on{display:block}
.hint{margin-top:1.25rem;color:var(--muted);font-size:.82rem;
  font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif}
a{color:var(--accent)}
</style>
</head>
<body>
<div class="wrap">
  <h1 class="brand">GrantTap</h1>
  <p class="tag">Phone-code unlock · encrypted vault on this relay</p>

  <section id="login" class="panel login on">
    <label for="code">Unlock code from phone</label>
    <textarea id="code" autocomplete="off" spellcheck="false" placeholder="GTW1.…"></textarea>
    <div class="row">
      <button class="primary" id="unlockBtn" type="button">Unlock</button>
      <button class="ghost" id="createBtn" type="button">Create vault</button>
    </div>
    <p class="msg" id="loginMsg"></p>
    <div class="codebox" id="newCode"></div>
    <p class="hint">Codes use GTW1 + AES-GCM (same as granttap-vault). Only revisioned ciphertext syncs to the relay; the code never leaves this device.</p>
  </section>

  <section id="shell" class="panel shell">
    <p class="tag" style="margin:0 0 1rem">Vault unlocked</p>
    <div class="stat">
      <div><span>Label</span><strong id="vLabel">—</strong></div>
      <div><span>Notes</span><strong id="vNotes">0</strong></div>
      <div><span>Sessions</span><strong id="vSessions">0</strong></div>
      <div><span>KV sync</span><strong id="vSync">—</strong></div>
    </div>
    <p class="hint" style="margin-top:1rem">Sessions &amp; approvals shell — placeholder. Live Allow cards stay at <code>/a/&lt;room&gt;/&lt;token&gt;</code>.</p>
    <div class="row">
      <button class="ghost" id="lockBtn" type="button">Lock</button>
      <button class="ghost" id="wipeBtn" type="button">Wipe local</button>
    </div>
    <p class="msg" id="shellMsg"></p>
  </section>
</div>
<script type="module">
const CODE_PREFIX="GTW1.";
const LS_KEY="granttap-web.vault";

function toBase64Url(bytes){
  let bin="";for(const b of bytes)bin+=String.fromCharCode(b);
  return btoa(bin).replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=+$/,"");
}
function fromBase64Url(s){
  const pad=s.length%4===0?"":"=".repeat(4-(s.length%4));
  const bin=atob(s.replace(/-/g,"+").replace(/_/g,"/")+pad);
  const out=new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++)out[i]=bin.charCodeAt(i);
  return out;
}
function parseCode(input){
  const raw=input.trim().replace(/\\s+/g,"");
  const body=raw.startsWith(CODE_PREFIX)?raw.slice(CODE_PREFIX.length):raw;
  if(!/^[A-Za-z0-9\\-_]{43}$/.test(body))throw new Error("That doesn't look like a GrantTap code.");
  const bytes=fromBase64Url(body);
  if(bytes.length!==32)throw new Error("That doesn't look like a GrantTap code.");
  return bytes;
}
function generateUnlockCode(){
  const key=new Uint8Array(32);crypto.getRandomValues(key);
  return CODE_PREFIX+toBase64Url(key);
}
async function importKey(material){
  return crypto.subtle.importKey("raw",material.slice().buffer,{name:"AES-GCM",length:256},false,["encrypt","decrypt"]);
}
async function vaultIdFromMaterial(material){
  const digest=await crypto.subtle.digest("SHA-256",material.slice().buffer);
  return [...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,"0")).join("");
}
function emptyVault(label="Personal vault"){return{version:1,notes:[],sessions:[],meta:{label}};}
async function encryptVault(key,data,createdAt){
  const iv=new Uint8Array(12);crypto.getRandomValues(iv);
  const plain=new TextEncoder().encode(JSON.stringify(data));
  const ct=await crypto.subtle.encrypt({name:"AES-GCM",iv},key,plain);
  const now=new Date().toISOString();
  return{v:1,iv:toBase64Url(iv),ciphertext:toBase64Url(new Uint8Array(ct)),createdAt:createdAt??now,updatedAt:now};
}
async function decryptVault(key,env){
  const iv=fromBase64Url(env.iv);const ct=fromBase64Url(env.ciphertext);
  const plain=await crypto.subtle.decrypt({name:"AES-GCM",iv},key,ct);
  return JSON.parse(new TextDecoder().decode(plain));
}
function loadLocal(){try{const r=localStorage.getItem(LS_KEY);return r?JSON.parse(r):null;}catch{return null;}}
function saveLocal(env){try{localStorage.setItem(LS_KEY,JSON.stringify(env));}catch{}}
function wipeLocal(){try{localStorage.removeItem(LS_KEY);}catch{}}

async function fetchRemote(vaultId){
  try{
    const r=await fetch("/api/vault/"+vaultId,{cache:"no-store"});
    if(r.status===404||r.status===503)return null;
    if(!r.ok)return null;
    const data=await r.json();
    const revision=String(data.revision??"");
    const etag=r.headers.get("etag");
    if(!data.envelope||!/^[a-f0-9]{64}$/.test(revision)||etag!=="\""+revision+"\"")return null;
    return{envelope:data.envelope,revision};
  }catch{return null;}
}
async function putRemote(vaultId,envelope,expectedRevision){
  try{
    const condition=expectedRevision==null?{"if-none-match":"*"}:{"if-match":"\""+expectedRevision+"\""};
    const r=await fetch("/api/vault/"+vaultId,{
      method:"PUT",headers:{"content-type":"application/json",...condition},
      body:JSON.stringify({envelope})
    });
    if(r.status===412)return{ok:false,conflict:true,revision:null};
    if(!r.ok)return{ok:false,conflict:false,revision:null};
    const data=await r.json();const revision=String(data.revision??"");
    if(!/^[a-f0-9]{64}$/.test(revision)||r.headers.get("etag")!=="\""+revision+"\"")return{ok:false,conflict:false,revision:null};
    return{ok:true,conflict:false,revision};
  }catch{return{ok:false,conflict:false,revision:null};}
}

const login=document.getElementById("login");
const shell=document.getElementById("shell");
const loginMsg=document.getElementById("loginMsg");
const shellMsg=document.getElementById("shellMsg");
const newCode=document.getElementById("newCode");
let session=null;

function showLogin(){
  login.classList.add("on");shell.classList.remove("on");session=null;
}
function showShell(vault,sync){
  login.classList.remove("on");shell.classList.add("on");
  document.getElementById("vLabel").textContent=vault.meta?.label??"Vault";
  document.getElementById("vNotes").textContent=String(vault.notes?.length??0);
  document.getElementById("vSessions").textContent=String(vault.sessions?.length??0);
  document.getElementById("vSync").textContent=sync;
}

document.getElementById("unlockBtn").onclick=async()=>{
  loginMsg.textContent="";loginMsg.className="msg";
  const code=document.getElementById("code").value;
  try{
    const material=parseCode(code);
    const key=await importKey(material);
    const vaultId=await vaultIdFromMaterial(material);
    const local=loadLocal();
    let remote=await fetchRemote(vaultId);
    let env=remote?.envelope??local;
    if(!env){loginMsg.textContent="No vault yet. Create one, or use a code whose ciphertext is already synced.";loginMsg.className="msg bad";return;}
    let vault=await decryptVault(key,env);
    let revision=remote?.revision??null;
    let synced=Boolean(remote);
    if(!remote&&local){
      const created=await putRemote(vaultId,env,null);
      revision=created.revision;synced=created.ok;
      if(created.conflict){
        remote=await fetchRemote(vaultId);
        if(!remote)throw new Error("Vault revision conflict; refresh and try again.");
        env=remote.envelope;vault=await decryptVault(key,env);revision=remote.revision;synced=true;
      }
    }
    saveLocal(env);
    session={key,vault,envelope:env,vaultId,code,revision};
    showShell(vault,synced?"synced":"local only");
  }catch(err){
    loginMsg.textContent=err?.message?.includes("GrantTap code")||err?.message?.includes("revision conflict")?err.message:"Wrong code or corrupted vault.";
    loginMsg.className="msg bad";
  }
};

document.getElementById("createBtn").onclick=async()=>{
  loginMsg.textContent="";newCode.classList.remove("on");
  try{
    const code=generateUnlockCode();
    const material=parseCode(code);
    const key=await importKey(material);
    const vault=emptyVault("Personal vault");
    const envelope=await encryptVault(key,vault);
    const vaultId=await vaultIdFromMaterial(material);
    saveLocal(envelope);
    const stored=await putRemote(vaultId,envelope,null);
    const synced=stored.ok;
    newCode.textContent="Save this code — it is the only key:\\n"+code;
    newCode.classList.add("on");
    document.getElementById("code").value=code;
    loginMsg.textContent=synced?"Vault created and synced to KV.":"Vault created (local). KV sync unavailable.";
    loginMsg.className="msg ok";
    session={key,vault,envelope,vaultId,code,revision:stored.revision};
    showShell(vault,synced?"synced":"local only");
  }catch{
    loginMsg.textContent="Could not create a vault in this browser.";
    loginMsg.className="msg bad";
  }
};

document.getElementById("lockBtn").onclick=()=>{
  session=null;document.getElementById("code").value="";showLogin();
  loginMsg.textContent="Locked.";loginMsg.className="msg ok";
};
document.getElementById("wipeBtn").onclick=()=>{
  wipeLocal();session=null;document.getElementById("code").value="";showLogin();
  loginMsg.textContent="Local vault wiped.";loginMsg.className="msg ok";
};
</script>
</body>
</html>`;
}

export function vaultHtmlResponse() {
  return htmlResponse(vaultPageHtml());
}
