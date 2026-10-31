// M3 verify-loop gate on the lab specimens: thin wrapper around src/verify/gate.js (see there).
//   node test/verify/gate.mjs [--jobs 3] [--only time/m07-i6-p400,scroll/m01] [--write-takes]
// To use the recorder and the lab of another checkout (read-only):
//   REVA_RECORDER_ROOT=<checkout> REVA_LAB_REPO=<checkout> node test/verify/gate.mjs
import { runLabGate } from '../../src/verify/gate.js';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i < 0 ? d : (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true); };
const only = arg('only', null);
const r = await runLabGate({ jobs: +arg('jobs', 3), only: typeof only === 'string' ? only.split(',') : null, writeTakes: !!arg('write-takes', false) });
process.exitCode = r.ok ? 0 : 1;
