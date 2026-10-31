// Parity of a lab specimen with the lab's own reference simulator (independent implementation of the same recurrences):
//   1. record the specimen with the M1 recorder (hx, 120 Hz) under the lab's scenario for its route;
//   2. run the lab's refsim on the specimen take's frames and inputs (ctxFromTake);
//   3. compare every compared channel pair of the specimen's channelMap, and compare with this module's own Node simulation.
// The lab is only READ (dynamic import of <labRoot>/lab-scroll/refsim.mjs); nothing is written there.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildLabSpecimen, LAB_SPECIMENS, DEFAULT_LAB_ROOT } from './lab.js';
import { simulate, inputFromTake } from './index.js';
import { servePages, recordSpecimen } from './test/helpers.js';

/** Max |a - b| over finite pairs, with the number of pairs compared. */
export function maxDiff(a, b) {
  let m = 0, n = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (!Number.isFinite(a[i]) || !Number.isFinite(b[i])) continue;
    m = Math.max(m, Math.abs(a[i] - b[i])); n++;
  }
  return { max: m, n };
}

export async function labParity(routeId, { labRoot = DEFAULT_LAB_ROOT, scenario, rate = 120 } = {}) {
  const lab = LAB_SPECIMENS.find((s) => s.id === routeId);
  if (!lab || lab.group !== 'lab-scroll') throw new Error(`no scroll-group lab route ${routeId}`);
  const { built, inputs } = buildLabSpecimen(labRoot, lab, { frameMs: 1000 / rate });
  const variant = scenario || lab.defaultTrace;
  const sc = inputs[variant]; if (!sc) throw new Error(`no scenario ${variant} for ${routeId}`);
  const refsim = await import(pathToFileURL(path.join(labRoot, 'lab-scroll', 'refsim.mjs')).href);
  const srv = await servePages({ '/s.html': built.html });
  let rec;
  try { rec = await recordSpecimen({ url: srv.origin + '/s.html', spec: built.spec, actions: sc.actions, rate }); } finally { await srv.close(); }
  const { take } = rec; const data = take.data;
  const ref = refsim.simulate(routeId, refsim.defaultsOf(routeId), refsim.ctxFromTake({ take, data: { rows: data.rows, inputLog: take.inputLog || rec.inputLog || data.inputLog, wheel: data.wheel } }));
  const own = simulate(built.spec, inputFromTake({ take, data: { rows: data.rows, inputLog: take.inputLog || rec.inputLog || data.inputLog, wheel: data.wheel } }, { spec: built.spec }));
  const out = [];
  for (const c of built.spec.channelMap) {
    if (!c.compare) continue;
    const [sid, name] = [c.specimen.slice(0, c.specimen.indexOf('|')), c.specimen.slice(c.specimen.indexOf('|') + 1)];
    const ei = take.els.findIndex((d) => d && d.includes('#' + sid));
    const got = data.rows.map((r) => (r.v[ei] ? r.v[ei][name] : NaN));
    const exp = ref.channels[c.source];
    out.push({ source: c.source, specimen: c.specimen, vsRefsim: exp ? maxDiff(got, exp.slice(0, got.length)) : null, vsOwnSim: maxDiff(got, own.channels[c.specimen] || []) });
  }
  return { route: routeId, scenario: variant, frames: data.rows.length, channels: out, events: ref.events && ref.events.length, rec };
}
