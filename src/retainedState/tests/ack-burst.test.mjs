import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {WebSocket} from 'ws';
import {createRelayServer} from '../../node/server.js';
import {RelayStore} from '../../node/store.js';

const room='7'.repeat(32), credential='8'.repeat(64), recipient='9'.repeat(64);

test('a returning legacy phone can acknowledge its complete 400-frame retained replay and continue',async t=>{
 const root=mkdtempSync(join(tmpdir(),'granttap-replay-acks-'));
 const store=new RelayStore(join(root,'relay.sqlite3'));
 store.pinAuth(room,createHash('sha256').update(credential).digest('hex'));
 const now=Date.now();
 for(let index=0;index<400;index++){
  const key=createHash('sha256').update(String(index)).digest('hex');
  const envelope={v:1,room,from:'machine',to:'phone',senderId:'synthetic-machine',
   nonce:'A'.repeat(32),box:'B'.repeat(24),recipientKeyId:recipient,deliveryId:'sample-'+index,
   stateKey:key,statePriority:1,stateRevision:now+index,expiresAt:now+60_000};
  store.retainedState.put(room,envelope,JSON.stringify(envelope));
 }
 const server=createRelayServer({store,env:{RELAY_HEARTBEAT_MS:'0'},log:()=>{}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const socket=new WebSocket(`ws://127.0.0.1:${server.address().port}/?room=${room}`,{headers:{
  authorization:`Bearer ${credential}`,'X-GrantTap-Recipient-Key-Id':recipient,'X-GrantTap-Recipient-Routing':'1',
 }});
 t.after(async()=>{socket.terminate();await server.shutdown();rmSync(root,{recursive:true,force:true});});
 let received=0,closeCode;
 socket.on('close',code=>{closeCode=code;});
 socket.on('message',raw=>{
  const envelope=JSON.parse(raw.toString());
  if(!envelope.deliveryId)return;
  received++;
  if(socket.readyState===WebSocket.OPEN)socket.send(JSON.stringify({type:'relay.ack',deliveryId:envelope.deliveryId}));
 });
 await once(socket,'open');
 const control={v:1,room,from:'phone',to:'machine',senderId:'synthetic-phone',nonce:'A'.repeat(32),box:'B'.repeat(24),expiresAt:now+60_000};
 socket.send(JSON.stringify(control));
 for(let attempt=0;attempt<100&&received<400&&closeCode==null;attempt++)await delay(10);
 await delay(50);
 assert.equal(received,400);
 assert.equal(closeCode,undefined,'Server-issued replay acknowledgements must not disconnect a healthy phone');
 socket.send(JSON.stringify({...control,deliveryId:'after-replay'}));
 await delay(50);
 assert.ok(store.queue(room,'machine').some(row=>row.deliveryId==='after-replay'));
 // Credits are consumed once. Replaying the same acknowledgement is ordinary unsolicited traffic.
 const closed=once(socket,'close');
 for(let index=0;index<400;index++)socket.send(JSON.stringify({type:'relay.ack',deliveryId:'sample-0'}));
 assert.equal((await closed)[0],4429);
});
