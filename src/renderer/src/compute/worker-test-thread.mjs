import { parentPort } from 'node:worker_threads';
import { createRealm, localFetch } from './test-support.mjs';
const realm = createRealm({ fetch: localFetch });
const receive = realm.load('./workerRuntime').createWorkerRuntime(value => parentPort.postMessage(value));
parentPort.on('message', message => {
  void receive(realm.dto(message)).catch(error => { throw error; });
});
