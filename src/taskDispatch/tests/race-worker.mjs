import { parentPort, workerData } from 'node:worker_threads';
import { RelayStore } from '../../node/store.js';
const relay = new RelayStore(workerData.path);
parentPort.postMessage({ ready: true });
Atomics.wait(new Int32Array(workerData.gate), 0, 0);
try {
  const result = relay.taskDispatch.put(workerData.room, workerData.id, workerData.body);
  parentPort.postMessage({ status: result.status });
} finally { relay.close(); }
