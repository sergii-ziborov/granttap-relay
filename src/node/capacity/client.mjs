import {createHmac,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import http from 'node:http';

export const latencyBounds=[10,50,100,250,1000,5000,30000];
export const capacityIdentity=key=>(kind,value)=>createHmac('sha256',key).update(`hostwatch-capacity-v1:${kind}:${value}`).digest('hex');
export function createMeasurements(){
 const counters={},latencies={};
 return {
  record(name,count=1){if(Number.isSafeInteger(count)&&count>=0)counters[name]=(counters[name]??0)+count;},
  timing(name,ms){
   if(!Number.isFinite(ms)||ms<0||ms>86400000)return;
   const h=latencies[name]??={count:0,sumMs:0,bins:Array(8).fill(0)};
   h.count++;h.sumMs+=ms;const index=latencyBounds.findIndex(bound=>ms<=bound);h.bins[index<0?7:index]++;
  },
  snapshot(){return {counters:{...counters},latencies:structuredClone(latencies)};},
 };
}
// Server only. No public endpoint, query string, prompt or message is collected.
export function capacityReporter({env=process.env,source,snapshot,intervalMs=30000}={}){
 const siteId=env.HOSTWATCH_CLIENT_ACCESS_SITE,socketPath=env.HOSTWATCH_CLIENT_ACCESS_SOCKET,keyFile=env.HOSTWATCH_CLIENT_ACCESS_KEY_FILE;
 if(!siteId||!socketPath||!keyFile)return null;
 let key,identity;
 try{key=readFileSync(keyFile);const identityKey=readFileSync(env.HOSTWATCH_METRICS_IDENTITY_KEY_FILE??keyFile);if(key.length<32||identityKey.length<32)return null;identity=capacityIdentity(identityKey);}catch{return null;}
 const bootId=randomUUID(),bootAt=new Date().toISOString();let sequence=0,pending=false,closed=false;
 const agent=new http.Agent({keepAlive:true,maxSockets:1,maxFreeSockets:1});
 async function publish(){
  if(pending||closed)return;pending=true;
  try {
   const value=await snapshot(identity),body=JSON.stringify({...value,version:1,siteId,source,bootId,bootAt,sequence:++sequence,observedAt:new Date().toISOString(),environment:env.HOSTWATCH_METRICS_ENVIRONMENT==='synthetic'?'synthetic':'production'});
   if(Buffer.byteLength(body)>1024*1024)throw new Error('capacity snapshot too large');
   await new Promise((resolve,reject)=>{
    const request=http.request({socketPath,path:'/metrics',method:'POST',agent,headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'}},response=>{
     response.resume();response.on('end',()=>response.statusCode===200?resolve():reject(new Error('capacity snapshot rejected')));response.on('error',reject);
    });
    const timeout=setTimeout(()=>request.destroy(new Error('capacity collector timeout')),750);timeout.unref();
    request.on('close',()=>clearTimeout(timeout));request.on('error',reject);request.end(body);
   });
  } catch { /* Missing observations become stale; never fabricate a zero or affect service traffic. */ }
  finally {pending=false;}
 }
 const timer=setInterval(()=>void publish(),intervalMs);timer.unref();
 const first=setTimeout(()=>void publish(),2000);first.unref();
 return {publish,identity,close(){closed=true;clearTimeout(first);clearInterval(timer);agent.destroy();}};
}
