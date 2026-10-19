import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createHmac, createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { WebSocket } from 'ws';

const accounts = Number(process.env.LOAD_ACCOUNTS ?? 20);
assert.ok(Number.isInteger(accounts) && accounts >= 1 && accounts <= 100);
const directory=mkdtempSync(join(tmpdir(),'granttap-relay-load-'));
const secret=randomBytes(32), credential=randomBytes(32).toString('hex');
const keyPath=join(directory,'key'); writeFileSync(keyPath,secret,{mode:0o600});
const sockets=new Set(), receipts=new Map(), received=new Map(), sent=new Map();
const errors=[];
let worker, port, sequence=0, peakConnections=0;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const timeout=async predicate=>{
  const end=Date.now()+20_000;
  while(!predicate()) { if(Date.now()>end) throw Error('Relay load phase timed out'); await delay(10); }
};

async function start() {
  worker=fork(new URL('./server.mjs',import.meta.url),[join(directory,'relay.sqlite3'),keyPath],{silent:true});
  worker.stderr.on('data',()=>{});
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error('Server start timed out')),10_000);
    worker.once('error',reject); worker.once('message',message=>{clearTimeout(timer);port=message.ready;resolve();});
  });
}

function endpoint(room, role, id) {
  const publicKey=randomBytes(32).toString('base64');
  return {room,role,id,publicKey,keyId:createHash('sha256').update(Buffer.from(publicKey,'base64')).digest('hex')};
}

function ticket(peer) {
  const value={version:peer.role==='phone'?2:1, accountId:peer.room.account,
    computerId:peer.id,publicKey:peer.publicKey,room:peer.room.id,expiresAt:Date.now()+300_000,
    ...(peer.role==='phone'?{role:'phone'}:{})};
  const body=Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${body}.${createHmac('sha256',secret).update(`granttap-managed-v1.${body}`).digest('base64url')}`;
}

async function connect(peer) {
  const ws=new WebSocket(`ws://127.0.0.1:${port}/ws?room=${peer.room.id}`,{headers:{
    authorization:`Bearer ${credential}`,'X-GrantTap-Admission':ticket(peer),
    'X-GrantTap-Recipient-Key-Id':peer.keyId,'X-GrantTap-Recipient-Routing':'1'}});
  ws.on('error',()=>errors.push('socket-error'));
  ws.on('message',raw=>{
    const message=JSON.parse(raw.toString());
    if(message.type==='relay.stored') receipts.set(message.deliveryId,performance.now()-sent.get(message.deliveryId));
    if(message.deliveryId && message.from==='phone' && peer.role==='machine') {
      received.set(message.deliveryId,performance.now()-sent.get(message.deliveryId));
      ws.send(JSON.stringify({type:'relay.ack',deliveryId:message.deliveryId}));
    }
  });
  await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});
  sockets.add(ws); peakConnections=Math.max(peakConnections,sockets.size);
  ws.send(JSON.stringify({v:1,room:peer.room.id,from:peer.role,to:'all',senderId:peer.id,
    nonce:'A'.repeat(32),box:'B'.repeat(24)}));
  peer.socket=ws;
}

async function connectAll(peers) {
  for(let i=0;i<peers.length;i+=40) await Promise.all(peers.slice(i,i+40).map(connect));
  await delay(100);
}

function submit(phone,target,size=4096) {
  const id=`user-message-load-${++sequence}`;
  sent.set(id,performance.now());
  phone.socket.send(JSON.stringify({v:1,room:phone.room.id,from:'phone',to:'machine',senderId:phone.id,
    deliveryId:id,recipientKeyId:target.keyId,expiresAt:Date.now()+600_000,
    nonce:'A'.repeat(32),box:'B'.repeat(size)}));
  return id;
}

async function measure() {
  return await new Promise(resolve=>{worker.once('message',message=>resolve(message.measurement));worker.send({type:'measure'});});
}

async function stop() {
  for(const ws of sockets) ws.terminate(); sockets.clear();
  if(!worker) return;
  const child=worker; worker=undefined;
  child.send({type:'stop'});
  await Promise.race([new Promise(resolve=>child.once('exit',resolve)),delay(5_000).then(()=>child.kill())]);
}

function summary(values) {
  const all=[...values].sort((a,b)=>a-b);
  return {count:all.length,p50:all[Math.floor(all.length*.5)],p95:all[Math.floor(all.length*.95)],max:all.at(-1)};
}

async function run() {
  const rooms=[];
  for(let account=0;account<accounts;account++) {
    const accountId=randomUUID();
    for(let mesh=0;mesh<2;mesh++) {
      const room={id:randomBytes(16).toString('hex'),account:accountId};
      room.phones=[endpoint(room,'phone',randomUUID()),endpoint(room,'phone',randomUUID())];
      room.computers=Array.from({length:15},()=>endpoint(room,'machine',randomUUID()));
      rooms.push(room);
    }
  }
  const online=rooms.flatMap(r=>[...r.phones,...r.computers.slice(1)]);
  await start(); await connectAll(online);
  const queued=[];
  for(const r of rooms) for(let provider=0;provider<4;provider++) queued.push(submit(r.phones[0],r.computers[0]));
  await timeout(()=>receipts.size===queued.length);
  assert.equal(received.size,0,'offline computers must not be required for relay receipts');
  await stop(); await start();
  await connectAll(rooms.flatMap(r=>[...r.phones,...r.computers]));
  await timeout(()=>received.size===queued.length);
  for(let round=0;round<10;round++) {
    for(const r of rooms) submit(r.phones[0],r.computers[1],round%5===0?65536:4096);
    await delay(500);
  }
  await timeout(()=>received.size===sent.size && receipts.size===sent.size);
  assert.deepEqual(errors,[]);
  const result={accounts,meshes:rooms.length,peakConnections,offlinePersisted:queued.length,
    submissions:sent.size,relayReceiptMs:summary(receipts.values()),deliveryMs:summary(received.values()),
    server:await measure(),scope:'Local managed Node relay and SQLite, no TLS, APNs or provider execution'};
  console.log(JSON.stringify(result,null,2));
}

try { await run(); } finally { await stop(); rmSync(directory,{recursive:true,force:true}); }
