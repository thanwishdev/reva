// Worker thread of the fit pool: one motion per message. Each worker has its own module state, so a fit's evaluation meter
// never mixes with another's and the result does not depend on how many workers ran.
import { parentPort } from 'node:worker_threads';
import { fitOne } from './fitone.js';

parentPort.on('message', ({ id, out, c, lead, deep }) => {
  try { parentPort.postMessage({ id, ...fitOne(out, c, lead, { deep }) }); }
  catch (e) { parentPort.postMessage({ id, error: String(e && e.message).split('\n')[0].slice(0, 300) }); }
});
parentPort.postMessage({ ready: true });
