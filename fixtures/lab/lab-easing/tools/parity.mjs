// Parity proof: record a take, run refsim on that take's frames/inputs/marks, compare channels and declared births.
import { simulate } from '../refsim.mjs';
import { recordCell, compareToTake } from './harness.mjs';

export function ctxOf(take, variant) {
  return {
    frames: take.data.rows.map((r) => ({ k: r.k, T: r.T, sy: r.sy, sx: r.sx })),
    inputs: take.inputLog, marks: take.marks, variant, viewport: take.context && take.context.viewport,
  };
}

/** target selector of a birth record ('DIV#b0.b' -> '#b0') */
const targetOf = (b) => { const g = /#([A-Za-z0-9_-]+)/.exec(b.tgt || ''); return g ? '#' + g[1] : b.tgt; };

export function compareBirths(take, events) {
  const want = events.filter((e) => e.kind === 'birth');
  const got = take.data.births;
  const out = { want: want.length, got: got.length, mismatches: [] };
  const used = new Set();
  for (const e of want) {
    const i = got.findIndex((b, ix) => !used.has(ix) && (e.name ? b.name === e.name : targetOf(b) === e.target && Math.abs(b.delay - e.delay) < 1e-9));
    if (i < 0) { out.mismatches.push({ e, why: 'no matching birth' }); continue; }
    used.add(i);
    const b = got[i];
    const bad = [];
    if (Math.abs(b.T - e.T) > 1e-5) bad.push(`T ${b.T} vs ${e.T}`);
    if (Math.abs(b.duration - e.duration) > 1e-9) bad.push(`duration ${b.duration} vs ${e.duration}`);
    if (Math.abs((b.delay || 0) - (e.delay || 0)) > 1e-9) bad.push(`delay ${b.delay} vs ${e.delay}`);
    if (e.easing && b.easing !== e.easing) bad.push(`easing ${b.easing} vs ${e.easing}`);
    if (e.keyframes) {
      for (let q = 0; q < e.keyframes.length; q++) {
        const kf = (b.keyframes || [])[q], ek = e.keyframes[q];
        if (!kf) { bad.push('keyframe ' + q + ' missing'); continue; }
        for (const f of Object.keys(ek)) if (String(kf[f]) !== String(ek[f])) bad.push(`keyframe ${q}.${f} ${kf[f]} vs ${ek[f]}`);
      }
    }
    if (bad.length) out.mismatches.push({ e, why: bad.join('; ') });
  }
  return out;
}

export async function parityCell({ origin, route, params, variant, rate, stall = false }) {
  const take = await recordCell({ origin, route, params, variant, rate, stall });
  const sim = simulate(route, params, ctxOf(take, variant));
  const cmp = compareToTake(take, sim);
  const births = compareBirths(take, sim.events);
  const pass = cmp.ok && births.mismatches.length === 0;
  return { route, variant, rate, stall, pass, channels: cmp.channels, births, frames: take.data.rows.length, take, sim, errors: [...(take.pageErrors || []), ...(take.errors || [])] };
}

export function summarize(r) {
  const bad = r.channels.filter((c) => !c.ok);
  const worst = [...r.channels].sort((a, b) => (b.maxAbs / (b.tol || 1)) - (a.maxAbs / (a.tol || 1)))[0];
  return `${r.pass ? 'PASS' : 'FAIL'} ${r.route}.${r.variant}@${r.rate}${r.stall ? '+stall' : ''} frames=${r.frames} channels=${r.channels.length} bad=${bad.length}` +
    (worst ? ` worst=${worst.key} max=${worst.maxAbs.toExponential(2)} tol=${worst.tol.toExponential(2)} (k=${worst.k})` : '') +
    ` births=${r.births.got}/${r.births.want} birthMismatch=${r.births.mismatches.length}` + (r.errors.length ? ` errors=${JSON.stringify(r.errors)}` : '');
}
