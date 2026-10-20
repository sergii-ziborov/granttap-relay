import {statSync} from 'node:fs';
import {createMeasurements,capacityReporter} from './client.mjs';

export function queueGauges(store,now=Date.now()){
 const row=store.db.prepare(`WITH items AS (
  SELECT value FROM rooms,json_each(machine_queue) UNION ALL SELECT value FROM rooms,json_each(phone_queue)
 ) SELECT count(*) AS count,coalesce(sum(coalesce(json_extract(value,'$.rawBytes'),length(CAST(json_extract(value,'$.raw') AS BLOB)))),0) AS bytes,
 min(json_extract(value,'$.queuedAt')) AS oldest,
 sum(CASE WHEN json_extract(value,'$.queuedAt') IS NULL THEN 1 ELSE 0 END) AS unknownAge
 FROM items WHERE json_extract(value,'$.expiresAt')>?`).get(now);
 const jobs=store.db.prepare(`SELECT count(*) AS count,coalesce(sum(payload_bytes),0) AS bytes,
 min(json_extract(record,'$.createdAt')) AS oldest FROM task_jobs WHERE state='queued' AND expires_at>?`).get(now);
 const fileBytes=path=>{try{return statSync(path).size;}catch{return null;}};
 const age=(count,oldest)=>!count?0:Number.isFinite(oldest)?Math.max(0,now-oldest):null;
 return {queueCount:row.count,queueBytes:row.bytes,queueOldestAgeMs:row.unknownAge?null:age(row.count,row.oldest),queueUnknownAgeCount:row.unknownAge??0,
  taskQueueCount:jobs.count,taskQueueBytes:jobs.bytes,taskQueueOldestAgeMs:age(jobs.count,jobs.oldest),
  databaseBytes:fileBytes(store.path),walBytes:fileBytes(store.path+'-wal')};
}
export function createRelayCapacity({store,sockets,delivery,env=process.env,now=Date.now}={}){
 const measurements=createMeasurements(),recent=new Map();
 for(const name of ['connectionAttempts','connectionsAccepted','connectionsRefused','connectionsClosed','reconnects','policyCloses','backpressure','limited429','dropped','received','receipts','forwarded','acknowledgements'])measurements.record(name,0);
 let reporter;
 function entities(tag){
  const people=new Map();let machineSockets=0,controllerSockets=0,unknownSockets=0;
  for(const peers of sockets.values())for(const ws of peers){
   if(ws.readyState!==1)continue;
   const ticket=ws.relayState?.ticket;
   if(!ticket||ticket.expiresAt<=now()){unknownSockets++;continue;}
   const kind=ticket.role==='phone'?'controller':'computer',account=tag('account',ticket.accountId);
   const subject=tag(kind,`${ticket.accountId}:${kind==='computer'?ticket.computerId:ticket.publicKey}`);
   const row={tag:subject,account,kind,online:true,lastSeen:new Date(now()).toISOString()};people.set(subject,row);
   if(kind==='computer')machineSockets++;else controllerSockets++;
  }
  return {entities:[...people.values()],gauges:{machineSockets,controllerSockets,unknownSockets,pendingSocketBytes:delivery.pendingBytes,...queueGauges(store,now())}};
 }
 reporter=capacityReporter({env,source:'relay',snapshot:tag=>({...entities(tag),...measurements.snapshot()})});
 return {
  record:measurements.record,timing:measurements.timing,
  connected(ticket){
   measurements.record('connectionsAccepted');if(!ticket||!reporter)return;
   const subject=reporter.identity('connection',`${ticket.accountId}:${ticket.computerId}:${ticket.role??'machine'}:${ticket.publicKey}`);
   const at=now(),previous=recent.get(subject);
   if(previous?.active===0&&at-previous.closedAt<600000)measurements.record('reconnects');
   recent.delete(subject);recent.set(subject,{active:(previous?.active??0)+1,closedAt:previous?.closedAt??0});
   if(recent.size>4096)recent.delete(recent.keys().next().value);
   return()=>{const row=recent.get(subject);if(row){row.active=Math.max(0,row.active-1);if(row.active===0)row.closedAt=now();}};
  },
  log(event){
   if(event==='relay.slow_receiver')measurements.record('backpressure');
   if(event==='relay.message_dropped')measurements.record('dropped');
  },
  snapshot:tag=>({...entities(tag),...measurements.snapshot()}),
  close(){reporter?.close();},
 };
}
