import { statSync } from 'node:fs';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { createRelayServer } from '../../src/node/server.js';
import { RelayStore } from '../../src/node/store.js';

const [databasePath, keyPath] = process.argv.slice(2);
const store = new RelayStore(databasePath);
const server = createRelayServer({ store, env: { MANAGED_ADMISSION_REQUIRED: '1',
  MANAGED_ADMISSION_KEY_PATH: keyPath }, log: () => {} });
let peakRss = 0;
const loop = monitorEventLoopDelay({ resolution: 10 }); loop.enable();
const sample = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); },100);
sample.unref();
server.listen(0,'127.0.0.1',() => process.send({ready:server.address().port}));
process.on('message',message => {
  if(message.type === 'measure') {
    peakRss = Math.max(peakRss,process.memoryUsage().rss);
    let walBytes=0;
    try { walBytes=statSync(databasePath+'-wal').size; } catch {}
    process.send({measurement:{peakRss, rss:process.memoryUsage().rss,
      eventLoopP95Ms:loop.percentile(95)/1e6,cpu:process.cpuUsage(),
      changes:store.db.prepare('SELECT total_changes() AS n').get().n,walBytes}});
  }
  if(message.type === 'stop') server.close(() => { loop.disable(); clearInterval(sample); process.disconnect(); });
});
