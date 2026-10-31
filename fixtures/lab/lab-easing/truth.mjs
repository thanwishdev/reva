// Ground truth for the lab-easing group (design section 11). Read ONLY by the lab runner/scorer: the blind server
// refuses this file. Regime-dependent values (the start of a CSS animation is the first frame after its trigger) come
// from refsim on the planned trace, or on the actual take's frames when the caller passes them.
import {
  r6, cubicBezier, easeFn, bezierOvershoot, staggerIndex, equivalentKeys,
  DEFAULTS, M06_MAP, M11_GEO, M12_GEO, M15_GEO, M17_GEO, M18_GEO, VIEW,
} from './core.js';
import { simulate, m11Range, holdValue, VT_ANIM_FRAMES } from './refsim.mjs';

export const SCHEMA = 'reva.labtruth/0';

/** Frame regimes of D-M2-2 Amendment 1 (R1 retired). R6 = R2 takes with every 2nd row dropped (truth as R2). */
export const REGIMES = {
  R2: { id: 'R2', rate: 60, dt: 1000 / 60, stall: null },
  R3: { id: 'R3', rate: 120, dt: 1000 / 120, stall: null },
  R4: { id: 'R4', rate: 30, dt: 1000 / 30, stall: null },
  R5: { id: 'R5', rate: 60, dt: 1000 / 60, stall: { every: 30, ms: 100 } },
  R6: { id: 'R6', rate: 60, dt: 1000 / 60, stall: null, derived: 'every-2nd-row' },
};
/** T_k = round6(T0 + k*dt + floor(k/30)*(100 - dt)), never accumulated (design X1). */
export const frameT = (reg, k) => r6(k * reg.dt + (reg.stall ? Math.floor(k / reg.stall.every) * (reg.stall.ms - reg.dt) : 0));

const BOOT_FRAMES = 4;                       // measured: S.boot steps 4 frames before the first readiness check passes
const MAX_SCROLL = { m11: 1800, m12: 1800 };

/** Run a trace's action list symbolically on the regime's frame grid -> {frames, inputs, marks}. */
export function planCtx(routeId, trace, regimeId) {
  const reg = REGIMES[regimeId];
  if (!reg) throw new Error('unknown regime ' + regimeId);
  const frames = [], marks = [], inputs = [];
  let k = 0, sy = 0;
  const step = (n) => { for (let i = 0; i < n; i++) { k++; frames.push({ k, T: frameT(reg, k), sy, sx: 0 }); } };
  const scrollTo = (y) => {
    const got = Math.min(y, MAX_SCROLL[routeId] ?? 0);
    inputs.push({ type: 'scrollTo', k, T: frameT(reg, k), want: y, got });
    sy = got;
  };
  step(BOOT_FRAMES);
  marks.push({ name: 'boot-done', k, T: frameT(reg, k) });
  for (const a of trace.actions) {
    if ('hold' in a) step(Math.round(a.hold / reg.dt));
    else if ('snapshot' in a) { /* reads the declared layer; no frames */ }
    else if ('mark' in a) marks.push({ name: a.mark, k, T: frameT(reg, k) });
    else if ('scrollTo' in a) scrollTo(a.scrollTo);
    else if ('denseSweep' in a) {
      const { from, to, px, framesPerPos = 1 } = a.denseSweep;
      const ys = []; for (let y = from; y <= to; y += px) ys.push(y);
      for (const y of [...ys, ...ys.slice(0, -1).reverse()]) { scrollTo(y); step(framesPerPos); }
    } else if (!('eval' in a)) throw new Error('planCtx: unsupported action ' + JSON.stringify(a));
  }
  return { frames, marks, inputs, variant: trace.variant, viewport: trace.viewport };
}

// ------------------------------------------------------------------------------------------------ derived curve numbers
/**
 * Derived numbers of a curve f(t) (value units) that goes from `v0` to `v1` between tA and tB (absolute ms):
 * t10/t50/t90/t99 (first time the value has covered that share of v1 - v0), peak velocity (units per ms) and its time,
 * overshoot beyond v1 as a fraction of |v1 - v0|, and the number of crossings of v1.
 */
export function curveDerived(f, v0, v1, tA, tB, stepMs = 0.05) {
  const A = v1 - v0, sgn = Math.sign(A) || 1;
  const out = { t10: null, t50: null, t90: null, t99: null, peakVelocity: 0, tPeak: null, overshoot: 0, crossings: 0, amplitude: A };
  const marks = { t10: 0.1, t50: 0.5, t90: 0.9, t99: 0.99 };
  let prev = f(tA), prevSide = Math.sign(prev - v1);
  for (let t = tA + stepMs; t <= tB + 1e-9; t += stepMs) {
    const v = f(t), share = ((v - v0) * sgn) / Math.abs(A);
    for (const [name, s] of Object.entries(marks)) if (out[name] == null && share >= s) out[name] = r6(t);
    const vel = Math.abs(v - prev) / stepMs;
    if (vel > out.peakVelocity) { out.peakVelocity = vel; out.tPeak = r6(t - stepMs / 2); }
    out.overshoot = Math.max(out.overshoot, ((v - v1) * sgn) / Math.abs(A));
    const side = Math.sign(v - v1);
    if (side !== 0 && prevSide !== 0 && side !== prevSide) out.crossings++;
    if (side !== 0) prevSide = side;
    prev = v;
  }
  out.overshoot = Math.max(0, out.overshoot);
  return out;
}

const item = (target, rest) => ({ target, ...rest });
/** Re-express the absolute times of curveDerived() relative to `base` (null stays null). */
const rel = (d, base, label) => ({ ...d, ...Object.fromEntries(['t10', 't50', 't90', 't99', 'tPeak'].map((k) => [k, d[k] == null ? null : r6(d[k] - base)])), relative_to: label });
const stripNull = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

// ------------------------------------------------------------------------------------------------ per-route truth
function trM06(P, ctx, sim) {
  const M = M06_MAP, items = [], onsets = [];
  const start = sim.events[0].T;
  const maps = { '--e': [0, 1], tx: [0, M.tx], rz: [0, M.rot], opacity: [M.opA, 1] };
  for (let i = 0; i < P.n; i++) {
    const delay = P.base + i * P.step, t0 = start + delay;
    const visOnset = P.hold > 0 ? r6(t0 + P.hold * P.D) : r6(t0);
    const visDur = r6((1 - P.hold) * P.D), visEnd = r6(visOnset + visDur);
    const f = (t) => holdValue(t - t0, P.D, P.hold, P.bz);
    const d = curveDerived(f, 0, 1, visOnset, visEnd);
    onsets.push(visOnset);
    for (const [ch, [a, b]] of Object.entries(maps)) {
      const target = `#b${i}|${ch === '--e' ? 'ren:--e' : 'ren:' + ch}`;
      items.push(item(target, {
        class: 'declared', sub: 'css', family: 'css-keyframes-bezier-segments', provenance: 'declared',
        params: {
          declared: { start_ms: start, delay_ms: delay, duration_ms: P.D, iterations: 1, fill: 'both', animation_easing: 'linear',
            keyframes: P.hold > 0 ? [{ offset: 0, easing: 'linear-flat' }, { offset: P.hold, easing: P.bz }, { offset: 1 }] : [{ offset: 0, easing: P.bz }, { offset: 1 }] },
          visible: { onset_ms: visOnset, duration_ms: visDur, end_ms: visEnd, hold_fraction: P.hold, hold_ms: P.hold * P.D },
          segment_bezier: P.bz, from: a, to: b,
        },
        derived: rel(d, visOnset, 'visible_onset'),
        hold: P.hold > 0, declared_vs_visible_disagree: P.hold > 0,
      }));
    }
  }
  return {
    items, attribution: Object.fromEntries(items.map((it) => [it.target, 'time-driven'])),
    stagger: { step_ms: P.step, base_ms: P.base, order: 'dom', direction: 'forward', equivalent: ['dom-index', 'y', 'row-major', 'column-major'], onsets_ms: onsets, declared: true },
    metrics: { 'm06.visible_onset': onsets, 'm06.declared_vs_visible': P.hold > 0, 'm06.segment_bezier': P.bz, 'm06_m12.stagger': { step_ms: P.step, direction: 'forward' }, class: 'declared' },
  };
}

function trM11(P) {
  const { s0, s1, base, L } = m11Range(P);
  const map = { shape: Array.isArray(P.ease) ? { bezier: P.ease } : P.ease, s0, s1, s0_vh: s0 / VIEW.h, s1_vh: s1 / VIEW.h, subject_top: M11_GEO.Y, subject_height: M11_GEO.H };
  const declared = { timeline: 'view', axis: 'block', range_start: `contain ${P.r0}%`, range_end: `contain ${P.r1}%`, fill: 'both', easing: P.ease, subject_height: M11_GEO.H,
    range_start_px: s0, range_end_px: s1, contain_start_px: base, contain_length_px: L };
  const items = [];
  for (const [sel, sub] of [['#b0', 'css'], ['#b1', 'waapi']]) {
    for (const [ch, a, b] of [['ren:opacity', 0.15, 1], ['ren:tx', 0, P.amp]]) {
      items.push(item(`${sel}|${ch}`, { class: 'declared', sub, observableClass: 'scroll-map', family: 'scroll-timeline', provenance: 'declared', params: { declared, map: { ...map, a, b } } }));
    }
  }
  return {
    items, attribution: Object.fromEntries(items.map((it) => [it.target, 'scroll-linked'])),
    metrics: { 'm11.declared_range': { start: declared.range_start, end: declared.range_end }, 'm11.measured_range': { s0, s1 }, 'm11.css_waapi_parity': 0, class: 'declared' },
  };
}

function trM12(P, ctx, sim) {
  const G = M12_GEO, n = G.cols * G.rows, items = [], onsets = [];
  const scroll = ctx.inputs.find((i) => i.type === 'scrollTo');
  const start = sim.events[0].T, t0 = scroll.T;
  for (let i = 0; i < n; i++) {
    const rank = staggerIndex(P.order, i, G.cols, G.rows), delay = rank * P.step;
    const bz = easeFn(P.bz);
    const f = (t) => { const l = t - start - delay; return l <= 0 ? 0 : l >= P.du ? 1 : bz(l / P.du); };
    const onset = r6(start + delay);
    const d = curveDerived(f, 0, 1, onset, onset + P.du);
    onsets.push(onset);
    for (const [ch, a, b] of [['ren:opacity', 0, 1], ['ren:ty', G.rise, 0]]) {
      items.push(item(`#b${i}|${ch}`, { class: 'declared', sub: 'css', family: 'css-animation-bezier', provenance: 'declared',
        params: { declared: { start_ms: start, delay_ms: delay, duration_ms: P.du, easing: P.bz, iterations: 1, fill: 'both', stagger_rank: rank }, onset_ms: onset, from: a, to: b },
        derived: rel(d, onset, 'onset') }));
    }
  }
  const cease = easeFn('easeOutCubic');
  const dc = curveDerived((t) => P.N * cease(Math.min(1, Math.max(0, (t - t0) / P.cD))), 0, P.N, t0, t0 + P.cD);
  items.push(item('#n|drv:--c', { class: 'tween', family: 'named:easeOutCubic', provenance: 'declared-by-code',
    params: { t0_ms: t0, duration_ms: P.cD, from: 0, to: P.N, ease: 'easeOutCubic' }, derived: rel(dc, t0, 't0') }));
  items.push(item('#n|ren:--c', { class: 'tween', family: 'named:easeOutCubic', params: { t0_ms: t0, duration_ms: P.cD, from: 0, to: P.N, ease: 'easeOutCubic' } }));
  const len = P.text.length;
  items.push(item('#t|drv:--n', { class: 'ramp', family: 'quantised-ramp', provenance: 'declared-by-code',
    params: { t0_ms: t0, char_ms: P.char, length: len, lattice: 1, rate_per_ms: 1 / P.char, duration_ms: len * P.char } }));
  items.push(item('#t|ren:--n', { class: 'ramp', family: 'quantised-ramp', params: { t0_ms: t0, char_ms: P.char, length: len, lattice: 1, rate_per_ms: 1 / P.char, duration_ms: len * P.char } }));
  const attribution = Object.fromEntries(items.map((it) => [it.target, 'scroll-triggered time-based']));
  const eq = equivalentKeys(P.order);
  return {
    items, attribution,
    stagger: { step_ms: P.step, order: P.order, direction: P.order === 'reverse' ? 'reverse' : 'forward', equivalent: eq, onsets_ms: onsets, declared: true, grid: { cols: G.cols, rows: G.rows } },
    metrics: { 'm06_m12.stagger': { step_ms: P.step, order: P.order }, 'm12.onset': onsets, 'm12.countup': { t0_ms: t0, duration_ms: P.cD, ease: 'easeOutCubic' }, class: 'declared' },
  };
}

function trM15(P, ctx, sim) {
  const g = M15_GEO, begin = sim.events[0].T;
  const items = [item('#b0|ren:bx', {
    class: 'declared', sub: 'smil', observableClass: 'periodic', family: 'smil-animate-sawtooth', provenance: 'declared',
    params: { begin_ms: begin, begin_offset_after_trigger_ms: P.delay, duration_ms: P.dur, repeat: 'indefinite', calcMode: P.spline ? 'spline' : 'linear', key_splines: P.spline || null,
      from: P.from - g.r, to: P.to - g.r, attribute: 'cx', visible_to_getAnimations: false },
    derived: { period_ms: P.dur } })];
  return { items, attribution: { '#b0|ren:bx': 'time-driven' },
    metrics: { 'm15.smil_duration_begin': { duration_ms: P.dur, begin_ms: begin }, class: 'declared' } };
}

function trM17(P, ctx, sim) {
  const items = [], births = sim.events.filter((e) => e.kind === 'birth');
  for (const [g, d, e] of [['g0', P.d0, P.e0], ['g1', P.d1, P.e1]]) {
    const { A, B } = M17_GEO[g];
    const ev = births.find((b) => b.name.endsWith(g));
    items.push(item(`html::view-transition-group(${g})`, { class: 'declared', sub: 'view-transition', family: 'view-transition-group', provenance: 'declared',
      params: { start_ms: ev.T, delay_ms: 0, duration_ms: d, easing: e, old: A, new: B, delta: { dx: B.x - A.x, dy: B.y - A.y, dw: B.w - A.w, dh: B.h - A.h },
        companions: ['fade-in', 'fade-out', 'plus-lighter', 'plus-lighter'], animation_name: ev.name, frames_after_trigger: VT_ANIM_FRAMES } }));
    const sel = g === 'g0' ? '#b0' : '#b1';
    for (const [ch, key] of [['ren:bx', 'x'], ['ren:by', 'y'], ['ren:bw', 'w'], ['ren:bh', 'h']]) {
      // a box edge that does not move between the two layouts is static (integrator fix: the item said step for 60 → 60)
      items.push(item(`${sel}|${ch}`, { class: A[key] === B[key] ? 'static' : 'step', family: 'layout-update', provenance: 'measured', params: { from: A[key], to: B[key] },
        note: 'the live element jumps to the new layout; the view-transition animation runs on pseudo-elements the recorder does not sample' }));
    }
  }
  return { items, attribution: Object.fromEntries(items.map((it) => [it.target, 'time-driven'])),
    metrics: { 'm17.detected': true, 'm17.declared_timing': [{ duration_ms: P.d0, easing: P.e0 }, { duration_ms: P.d1, easing: P.e1 }], 'm17.group_geometry': { g0: M17_GEO.g0, g1: M17_GEO.g1 }, class: 'declared' } };
}

function trM18(P, ctx, sim) {
  const flips = sim.events.filter((e) => e.kind === 'flip'), births = sim.events.filter((e) => e.kind === 'birth');
  const ease = easeFn(P.bz);
  const items = [];
  flips.forEach((fl, idx) => {
    const t0 = P.impl === 'waapi' ? births[idx].T : null;
    const start = P.impl === 'waapi' ? t0 : ctx.frames.find((f) => f.T > fl.T).T;   // rAF: first loop callback is the next frame
    const d = fl.delta;
    const common = { impl: P.impl, segment: idx + 1, start_ms: start, duration_ms: P.D, easing: P.bz, layout_delta: { dx: d.dx, dy: d.dy, sx: d.sx, sy: d.sy }, trigger_ms: fl.T,
      retarget: idx > 0 ? 'from-current' : null, interrupted: idx < flips.length - 1 };
    const f = (t) => 1 - ease(Math.min(1, Math.max(0, (t - start) / P.D)));
    const cut = flips[idx + 1] ? flips[idx + 1].T : Infinity;
    const dv = curveDerived(f, 1, 0, start, Math.min(start + P.D, cut));
    for (const [ch, from] of [['ren:tx', d.dx], ['ren:ty', d.dy], ['ren:sx', d.sx], ['ren:sy', d.sy]]) {
      const to = ch === 'ren:sx' || ch === 'ren:sy' ? 1 : 0;
      items.push(item(`#b0|${ch}`, P.impl === 'waapi'
        ? { class: 'declared', sub: 'flip', family: 'waapi-bezier', provenance: 'declared', params: { ...common, from, to }, derived: rel(dv, start, 'start') }
        : { class: 'tween', pattern: 'flip', family: 'bezier', params: { ...common, from, to }, derived: rel(dv, start, 'start') }));
    }
  });
  return { items, attribution: Object.fromEntries(items.map((it) => [it.target, 'time-driven'])),
    metrics: { 'm18.detected': true, 'm18.layout_delta': flips.map((f) => f.delta), 'm18.timing': { duration_ms: P.D, easing: P.bz, impl: P.impl }, 'm18.retarget': flips.length > 1 ? 'from-current' : null, class: P.impl === 'waapi' ? 'declared' : 'tween' } };
}

function trTween(route, P, ctx, sim) {
  const items = [], isF = route === 'm16f';
  const spec = isF ? P.bz : P.ease;
  const ease = easeFn(spec);
  const segs = [];
  const ev = sim.events;
  const variant = ctx.variant;
  if (route !== 'm19' || variant !== 'retarget') {
    const s = ev.find((e) => e.kind === 'start');
    segs.push({ t0: s.T, from: P.from, to: P.to, D: P.D, end: s.T + P.D });
  } else {
    const s = ev.find((e) => e.kind === 'start'), rt = ev.find((e) => e.kind === 'retarget');
    segs.push({ t0: s.T, from: P.from, to: P.to, D: P.D, end: rt.T, interrupted: true });
    segs.push({ t0: rt.T, from: rt.from, to: P.to2, D: P.D2, end: rt.T + P.D2, retarget: 'from-current' });
  }
  segs.forEach((sg, idx) => {
    const f = (t) => { const p = Math.min(1, Math.max(0, (t - sg.t0) / sg.D)); return sg.from + (sg.to - sg.from) * ease(p); };
    const d = curveDerived(f, sg.from, sg.to, sg.t0, Math.min(sg.t0 + sg.D, sg.end));   // an interrupted segment only reaches what it reached
    const first = ctx.frames.find((fr) => fr.T >= sg.t0);
    for (const ch of ['drv:--v', 'ren:--v', 'ren:tx']) {
      items.push(item(`#b0|${ch}`, { class: 'tween', family: Array.isArray(spec) ? 'cubic-bezier' : 'named:' + spec, provenance: 'declared-by-code',
        segment: idx + 1,
        params: { t0_ms: sg.t0, duration_ms: sg.D, from: sg.from, to: sg.to, ease: spec, first_frame_T: first ? first.T : null, subframe_onset_ms: first ? r6(first.T - sg.t0) : null,
          interrupted: !!sg.interrupted, retarget: sg.retarget || null, end_of_segment_ms: sg.end },
        derived: rel(d, sg.t0, 't0'),
        ...(route !== 'm19' ? { negativeFor: 'spring', abstainOk: true, overshoot_fraction: isF ? bezierOvershoot(P.bz) : 0 } : {}) }));
    }
  });
  const m = route === 'm19'
    ? { 'm19.onset': segs.map((s) => s.t0), 'm19.duration': segs.map((s) => s.D), 'm19.easing': spec, 'm19.retarget': segs.length > 1 ? 'from-current' : null, class: 'tween' }
    : { 'm16.negative': { correct: ['tween', 'unknown'], falseSpring: false }, class: 'tween' };
  return { items, attribution: Object.fromEntries(items.map((it) => [it.target, 'time-driven'])), metrics: m };
}

const BUILD = {
  m06: trM06, m11: trM11, m12: trM12, m15: trM15, m17: trM17, m18: trM18,
  m19: (P, c, s) => trTween('m19', P, c, s), m16e: (P, c, s) => trTween('m16e', P, c, s), m16f: (P, c, s) => trTween('m16f', P, c, s),
};

/**
 * @param {string} routeId
 * @param {object} params full parameter object
 * @param {string} regime 'R2'|'R3'|'R4'|'R5'|'R6'
 * @param {{variant?:string, trace?:object, ctx?:object}} [opts]  ctx = the actual take's {frames, inputs, marks}; else the planned trace
 */
export function truth(routeId, params, regime, opts = {}) {
  const build = BUILD[routeId];
  if (!build) throw new Error('unknown route ' + routeId);
  const P = { ...DEFAULTS[routeId], ...params };
  let ctx = opts.ctx;
  if (!ctx) {
    if (!opts.trace) throw new Error('truth() needs opts.ctx (a take\'s frames) or opts.trace (the trace spec) to plan');
    ctx = planCtx(routeId, opts.trace, regime);
  }
  ctx = { ...ctx, variant: ctx.variant || opts.variant };
  const sim = simulate(routeId, P, ctx);
  const r = build(P, ctx, sim);
  return stripNull({ schema: SCHEMA, route: routeId, params: P, regime, variant: ctx.variant, ...r });
}
