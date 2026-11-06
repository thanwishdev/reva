// Worker thread of the law fit: one job per message. Each worker has its own evaluation meter and its own open takes,
// so a result does not depend on how many workers ran.
import { parentPort } from 'node:worker_threads';
import { runJob } from './fit.js';

parentPort.on('message', (job) => {
  try { parentPort.postMessage({ result: runJob(job) }); }
  catch (e) { parentPort.postMessage({ error: String(e && e.message).split('\n')[0].slice(0, 300) }); }
});
parentPort.postMessage({ ready: true });
