import { createWorkerRuntime } from './workerRuntime';

interface WorkerEndpoint {
  postMessage(message: unknown): void;
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
}
const endpoint = globalThis as unknown as WorkerEndpoint;
(globalThis as unknown as Record<string, unknown>).window = globalThis;
const receive = createWorkerRuntime(message => endpoint.postMessage(message));
endpoint.onmessage = event => {
  void receive(event.data).catch(error => {
    // Invalid control messages are fatal; the client handles worker error explicitly.
    setTimeout(() => { throw error; }, 0);
  });
};
