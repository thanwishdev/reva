// `reva score` (to be wired into src/cli.js by the integrator; this module owns parsing and output).
//   reva score --spec <spec.json> --src <takeDir> --reb <takeDir> [--src-sweep <takeDir> --reb-sweep <takeDir>]
//                    [--identity <takeDir> ...] [--json <out.json>]
// spec.json: {mechanisms: [{id, pairs: ["<selector>|<channel>" | {src, reb}], arms?: ["response","sweep"]}]}
// --identity: further SOURCE takes of the same scenario (repeats or sampler phases): each is scored against --src to
// measure the self-band and the floor, which are then printed next to every number. Without them the record says
// "band unmeasured" / "floor unmeasured" (H6: never a silent default).
// Page-logged events (take.extra.events) are used for arm 2 when both takes carry them; else the recorder's input log.
import fs from 'node:fs';
import path from 'node:path';
import { assertOutsideRepo } from '../util/paths.js';
import { fromTakeDir } from './series.js';
import { scoreTakeSets } from './score.js';
import { selfBand, floors } from './protocol.js';
import { formatScore } from './format.js';

export function parseScoreArgs(argv) {
  const o = { identity: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = argv[i + 1];
    if (a === '--spec') { o.spec = v; i++; } else if (a === '--src') { o.src = v; i++; } else if (a === '--reb') { o.reb = v; i++; }
    else if (a === '--src-sweep') { o.srcSweep = v; i++; } else if (a === '--reb-sweep') { o.rebSweep = v; i++; }
    else if (a === '--identity') { o.identity.push(v); i++; } else if (a === '--json') { o.json = v; i++; }
    else throw new Error(`unknown argument ${a}`);
  }
  if (!o.spec || (!o.src && !o.srcSweep) || (!o.reb && !o.rebSweep)) throw new Error('usage: reva score --spec <spec.json> --src <takeDir> --reb <takeDir> [--src-sweep d --reb-sweep d] [--identity d ...] [--json out]');
  return o;
}

const evOf = (t) => (t && t.extra && Array.isArray(t.extra.events) ? t.extra.events : null);

export function runScore(o) {
  const spec = JSON.parse(fs.readFileSync(o.spec, 'utf8'));
  const load = (d) => (d ? fromTakeDir(d) : null);
  const src = { response: load(o.src), sweep: load(o.srcSweep) }, reb = { response: load(o.reb), sweep: load(o.rebSweep) };
  const events = (a, b) => (evOf(a) && evOf(b) ? { src: evOf(a), reb: evOf(b) } : undefined);
  const ids = o.identity.map(d => { const t = load(d); return scoreTakeSets({ src, reb: { response: t, sweep: src.sweep } }, spec, { events: events(src.response, t) }); });
  const band = ids.length ? selfBand(ids) : undefined, fl = ids.length ? floors(ids) : undefined;
  const rec = scoreTakeSets({ src, reb }, spec, { band, floors: fl, events: events(src.response, reb.response) });
  if (o.json) fs.writeFileSync(assertOutsideRepo(path.resolve(o.json)), JSON.stringify(rec, null, 1));   // scores of site takes are site-derived (H2)
  return { rec, text: formatScore(rec) };
}

export function main(argv) {
  const { rec, text } = runScore(parseScoreArgs(argv));
  console.log(text);
  return rec.refused.length ? 3 : 0;
}
