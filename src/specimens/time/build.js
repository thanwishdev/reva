// Mechanisms -> specimen spec (`reva.specimen.time/0`) -> self-contained HTML.
// A "mechanism" is what the normalisers (normalize.js) produce: one motion on one channel of one source element, in the
// source's own time, with its provenance. The builder places them on a neutral stage, shifts them onto the specimen
// timeline (anchor = 0, first onset ~ leadMs), decides the implementation (js / waapi / css) and fixes the duration.
import crypto from 'node:crypto';
import { K, kernelSource } from './kernel.js';
import { pageRuntime } from './runtime.js';

export const SPEC_SCHEMA = 'reva.specimen.time/0';
export const STAGE = { width: 1280, height: 800 };
/** Specimen box layout (generator constants, never source geometry): grid columns, cell pitch, box size, grid origin. */
export const LAYOUT = { cols: 6, cell: 96, size: 56, x0: 40, y0: 60 };
const TF_CH = new Set(['tx', 'ty', 'rz', 'sx', 'sy']);

/** Shift every time field of a motion by d ms (new object). */
export function shiftMotion(m, d) {
  const c = reviveSpec(JSON.parse(serializeSpec(m)));
  const fix = (o) => {
    for (const f of ['startMs', 'atMs', 'onsetMs', 'birthMs']) if (o[f] != null) o[f] += d;
    return o;
  };
  if (c.kind === 'chain') { c.parts = c.parts.map(fix); return c; }
  fix(c);
  if (c.kind === 'spring') { if (c.start) c.start.t += d; if (c.events) for (const e of c.events) e.t += d; }
  return c;
}

/** JSON cannot carry Infinity: spec files hold the string "Infinity". */
export function serializeSpec(spec, space) {
  return JSON.stringify(spec, (k, v) => (v === Infinity ? 'Infinity' : v), space);
}
export function reviveSpec(o) {
  if (o === 'Infinity') return Infinity;
  if (Array.isArray(o)) return o.map(reviveSpec);
  if (o && typeof o === 'object') { const r = {}; for (const k of Object.keys(o)) r[k] = reviveSpec(o[k]); return r; }
  return o;
}

const familyOf = (mech) => {
  const c = mech.channel;
  if (c.ch === 'var') return c.mapTo && TF_CH.has(c.mapTo) ? 'transform' : c.mapTo || null;
  return TF_CH.has(c.ch) ? 'transform' : c.ch;
};

/** Can the engine (CSS / WAAPI) run this motion exactly? */
export function declaredCapable(motion) {
  const ok = (e) => e == null || K.cssEasing(e) != null;
  if (motion.kind === 'tween') return ok(motion.ease);
  if (motion.kind === 'keyframes') return ok(motion.easing) && motion.frames.every((f) => ok(f.easing));
  return false;
}

/**
 * @param {object} o
 * @param {string} o.id
 * @param {'lab'|'site'} o.origin        site-derived specimens must be written outside the repo (PLAN H2)
 * @param {object} o.source              provenance of the input (kind, digest, route, ...)
 * @param {object[]} o.mechanisms        [{elemKey, order?, channel: {ch, name?, mapTo?}, motion, provenance, impl?, label?, assumptions?}]
 * @param {number} [o.frameMs]           nominal frame period of the seek grid (default 1000/120)
 * @param {number} [o.leadMs]            rest time before the first onset (default 500)
 * @param {'auto'|'js'|'declared'} [o.impl]  auto/declared: use css/waapi where the mechanism declared it and the engine can run it
 */
export function buildSpec(o) {
  const frameMs = o.frameMs || 1000 / 120, leadMs = o.leadMs == null ? 500 : o.leadMs, notes = [...(o.notes || [])];
  const mechs = o.mechanisms.filter(Boolean);
  if (!mechs.length) throw new Error(`specimen ${o.id}: no mechanisms`);
  // ---- time shift: onset -> about leadMs, in whole frames so the frame phase of discrete integrators is kept
  const onset = Math.min(...mechs.map((m) => K.startOf(m.motion)));
  const shift = Math.ceil((leadMs - onset) / frameMs - 1e-9) * frameMs;
  const r6 = (x) => Math.round(x * 1e6) / 1e6;
  // ---- implementation per track
  const tracks = mechs.map((m, i) => {
    let impl = 'js';
    const want = o.impl === 'js' ? 'js' : (m.impl || 'js');
    if (want !== 'js') {
      if (declaredCapable(m.motion)) impl = want;
      else notes.push(`track ${i}: ${want} requested but the motion is not expressible exactly in CSS/WAAPI; played by the kernel (js)`);
    }
    return { m, impl };
  });
  // ---- elements with collision splitting
  const elems = [];                       // {key, claims: [{fam, ch, impl, mapped}]}
  const trackEl = [];
  const fits = (e, fam, ch, impl, mapped) => {
    if (!fam) return true;
    if (fam === 'transform') {
      // inline js tracks compose into one transform string; css / waapi transform tracks on one element concatenate with
      // composite add (same engine for all of them); a var mapped through a stylesheet rule or a mix of engines needs its own element
      return e.claims.every((c) => c.fam !== 'transform' || (c.impl === impl && !c.mapped && !mapped && c.ch !== ch));
    }
    return e.claims.every((c) => c.fam !== fam);
  };
  for (const t of tracks) {
    const fam = familyOf(t.m), ch = t.m.channel.ch === 'var' ? 'var:' + t.m.channel.mapTo : t.m.channel.ch, mapped = t.m.channel.ch === 'var' && !!t.m.channel.mapTo;
    let idx = elems.findIndex((e) => e.key === t.m.elemKey && fits(e, fam, ch, t.impl, mapped));
    if (idx < 0) { elems.push({ key: t.m.elemKey, order: t.m.order != null ? t.m.order : elems.length, claims: [] }); idx = elems.length - 1; }
    elems[idx].claims.push({ fam, ch, impl: t.impl, mapped });
    trackEl.push(idx);
  }
  const { cols, cell, size } = LAYOUT;
  const elements = elems.map((e, i) => {
    const used = {}; e.claims.forEach((c) => { used[c.ch] = 1; if (c.fam === 'transform') { const ch = c.ch.startsWith('var:') ? c.ch.slice(4) : c.ch; used[ch] = 1; } });
    return { id: 'e' + i, key: String(e.key), x: LAYOUT.x0 + (i % cols) * cell, y: LAYOUT.y0 + Math.floor(i / cols) * cell, w: size, h: size, tf: { tx: !!used.tx, ty: !!used.ty, rz: !!used.rz, sx: !!used.sx, sy: !!used.sy } };
  });
  // ---- shifted motions, tracks, duration
  const specTracks = tracks.map((t, i) => {
    const motion = shiftMotion(t.m.motion, shift);
    const ch = t.m.channel;
    return {
      id: 't' + i, el: trackEl[i], channel: ch.ch, ...(ch.ch === 'var' ? { name: ch.name, mapTo: ch.mapTo || null } : {}), impl: t.impl,
      label: t.m.label || null, provenance: t.m.provenance || null, ...(t.m.assumptions && t.m.assumptions.length ? { assumptions: t.m.assumptions } : {}), motion,
    };
  });
  let end = 0, hasLoop = false;
  for (const t of specTracks) {
    end = Math.max(end, K.endOf(t.motion, { frameMs }));
    if ((t.motion.kind === 'keyframes' || t.motion.kind === 'ticks') && t.motion.iterations === Infinity) hasLoop = true;
  }
  const durationMs = Math.ceil(end + 500);
  const spec = {
    schema: SPEC_SCHEMA, id: o.id, origin: o.origin, source: o.source,
    timeline: { frameMs: r6(frameMs), refreshHz: r6(1000 / frameMs), leadMs, sourceShiftMs: r6(shift) + 0, durationMs, hasLoop },
    viewport: STAGE, elements, tracks: specTracks, notes,
  };
  spec.digest = digestOf(spec);
  return spec;
}

export function digestOf(spec) {
  const { digest, ...rest } = spec;
  return crypto.createHash('sha256').update(serializeSpec(rest)).digest('hex').slice(0, 16);
}

const REVIVE_SRC = `const R=(o)=>o==='Infinity'?Infinity:Array.isArray(o)?o.map(R):o&&typeof o==='object'?Object.fromEntries(Object.entries(o).map(([k,v])=>[k,R(v)])):o;`;

/** Self-contained, content-free HTML page for a spec (no text nodes, no network, no timers except rAF). */
export function renderHtml(spec) {
  const json = serializeSpec(spec).replace(/</g, '\\u003c').replace(/[\u2028\u2029]/g, (c) => '\\u' + c.charCodeAt(0).toString(16));
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=${STAGE.width}"><title>${spec.id}</title>
<style>html,body{margin:0;background:#f4f4f2}#s{position:relative;width:${STAGE.width}px;height:${STAGE.height}px;overflow:hidden}.b{position:absolute;border-radius:8px;background:#2b3a67}</style>
</head><body><div id="s"></div>
<script>
${REVIVE_SRC}
const K=(${kernelSource})();
(${pageRuntime.toString()})(K,R(${json}));
</script></body></html>
`;
}
