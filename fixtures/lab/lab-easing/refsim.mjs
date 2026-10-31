// refsim for the lab-easing group (design section 11): given a route, its parameters and the frames/inputs of an
// actual (or planned) take, return the values the page writes and the values a browser renders on those frames.
//
// It reproduces the `hx` recorder semantics (src/record/inpage.js, D-M2-2 A1.6 g) from the specification, not from the
// fitter: timers run at their exact due time with performance.now() = due; rAF callbacks of frame k see T_k; an input
// handled after frame k (a mark + eval, a scrollTo) runs at virtual time T_k and its rAF work lands in frame k+1; a
// CSS/WAAPI animation created in such a real task starts at T_(k+1), one created in a timer or rAF callback of frame j
// starts at T_j. A same-document view transition runs its update callback in the real frame of step k+1 and its
// pseudo-element animations start at T_(k+2) (measured on the recorder, test/parity).
//
// Pure functions, no DOM, no imports from src/. core.js is shared with the pages (formulas and tables only).
import {
  r6, clamp01, cubicBezier, easeFn, tweenAt, quant, staggerIndex,
  M06_MAP, M11_GEO, M12_GEO, M15_GEO, M17_GEO, M18_GEO, VIEW,
} from './core.js';

// ------------------------------------------------------------------------------------------------ hx scheduler model
/**
 * @param {{k:number,T:number,sy:number,sx:number}[]} frames   rows of the take, k = 1.. (the frame after k = 0, T = 0)
 * @param {{name:string,k:number,T:number}[]} marks            recorder marks (a trigger is a real task after its frame k)
 */
export function makeSim(frames) {
  const S = {
    frames, now: 0, j: -1, phase: 'real', lastK: 0,
    timers: [], rafs: [], seq: 1, tasks: new Map(),
    setTimeout(cb, ms) { S.timers.push({ due: r6(S.now + Math.max(0, +ms || 0)), cb, seq: S.seq++ }); },
    raf(cb) { S.rafs.push(cb); },
    /** run `fn` as a real task right after frame k (after its sample), at virtual time T_k */
    after(k, fn) { if (!S.tasks.has(k)) S.tasks.set(k, []); S.tasks.get(k).push(fn); },
    /** start time of a CSS/WAAPI animation created now: next frame if created in a real task, this frame otherwise */
    birth() {
      if (S.phase === 'frame') return frames[S.j].T;
      const nx = frames[S.j + 1];
      return nx ? nx.T : Infinity;
    },
    /** frame index whose T is the first >= t (a timer due at t fires in that frame), or -1 */
    frameAtOrAfter(t) { for (let i = 0; i < frames.length; i++) if (frames[i].T >= t) return i; return -1; },
    run(onFrame) {
      S.phase = 'real'; S.j = -1; S.now = 0;
      for (const fn of S.tasks.get(0) || []) fn();
      for (let j = 0; j < frames.length; j++) {
        const target = frames[j].T;
        S.j = j; S.phase = 'frame';
        for (;;) {
          let best = null;
          for (const t of S.timers) if (t.due <= target && (!best || t.due < best.due || (t.due === best.due && t.seq < best.seq))) best = t;
          if (!best) break;
          S.timers.splice(S.timers.indexOf(best), 1);
          S.now = Math.max(S.now, best.due);
          best.cb();
        }
        S.now = target;
        const cbs = S.rafs.splice(0);
        for (const cb of cbs) cb(S.now);
        onFrame(j);
        S.phase = 'real';
        for (const fn of S.tasks.get(frames[j].k) || []) fn();
      }
    },
  };
  return S;
}

const key = (sel, ch) => `${sel}|${ch}`;
function recorder(n) {
  const channels = {};
  return { channels, put(sel, ch, j, v) { const k = key(sel, ch); (channels[k] || (channels[k] = new Array(n).fill(null)))[j] = v; } };
}
const markK = (marks, name) => { const m = (marks || []).find((x) => x.name === name); return m ? m.k : null; };

// ------------------------------------------------------------------------------------------------ rAF tween routes (M19, M16e, M16f)
function tweenRoute(route, P, ctx) {
  const { frames, marks } = ctx;
  const S = makeSim(frames);
  const R = recorder(frames.length);
  const ease = route === 'm16f' ? easeFn(P.bz) : easeFn(P.ease);
  let tw = null, rafPending = false, cur = P.from, written = P.from;
  const tick = () => {
    rafPending = false;
    if (!tw) return;
    const r = tweenAt(tw, S.now);
    cur = r.v; written = quant(r.v, P.write || 'full');
    if (!r.done) { S.raf(tick); rafPending = true; }
  };
  const start = (from, to, D, e, t0 = S.now) => { tw = { from, to, D, ease: e, t0 }; if (!rafPending) { S.raf(tick); rafPending = true; } };
  const active = () => !!tw && S.now - tw.t0 < tw.D;
  const events = [];
  const click = () => {
    if (active()) { events.push({ kind: 'retarget', T: S.now, from: cur }); start(cur, P.to2, P.D2, ease); }
    else { events.push({ kind: 'start', T: S.now }); start(P.from, P.to, P.D, ease); }
  };
  const variant = ctx.variant || (route === 'm19' ? (markK(marks, 'go2') != null ? 'retarget' : null) : 'go');
  if (!variant) throw new Error('m19 refsim needs ctx.variant (timer | click | retarget)');
  const kGo = markK(marks, 'go'), kGo2 = markK(marks, 'go2');
  if (kGo == null) throw new Error('refsim needs the "go" mark');
  if (route === 'm19' && variant === 'timer') S.after(kGo, () => S.setTimeout(() => { events.push({ kind: 'start', T: S.now }); start(P.from, P.to, P.D, ease); }, P.delay));
  else if (route === 'm19') { S.after(kGo, click); if (variant === 'retarget') S.after(kGo2, click); }
  else S.after(kGo, () => { events.push({ kind: 'start', T: S.now }); start(P.from, P.to, P.D, ease); });
  S.run((j) => {
    R.put('#b0', 'drv:--v', j, written); R.put('#b0', 'ren:--v', j, written);
    R.put('#b0', 'ren:tx', j, written); R.put('#b0', 'ren:ty', j, 0);
    R.put('#b0', 'ren:bx', j, 100 + written); R.put('#b0', 'ren:by', j, 300);
    R.put('#b0', 'ren:bw', j, 80); R.put('#b0', 'ren:bh', j, 80); R.put('#b0', 'ren:opacity', j, 1);
  });
  return { channels: R.channels, events };
}

// ------------------------------------------------------------------------------------------------ M06 @property hold
/** e(t) of the keyframes `0% {0} hold% {0, timing bz} 100% {1}` over D ms after `local` ms of animation time. */
export function holdValue(local, D, hold, bz) {
  if (local <= 0) return 0;
  const u = local / D;
  if (u >= 1) return 1;
  if (u <= hold) return 0;
  return cubicBezier(bz[0], bz[1], bz[2], bz[3])((u - hold) / (1 - hold));
}
function rotBox(cx, cy, w, h, scale, deg) {
  const t = (deg * Math.PI) / 180, c = Math.abs(Math.cos(t)), s = Math.abs(Math.sin(t));
  const bw = scale * (w * c + h * s), bh = scale * (w * s + h * c);
  return { x: cx - bw / 2, y: cy - bh / 2, w: bw, h: bh };
}
function m06(P, ctx) {
  const { frames, marks } = ctx;
  const S = makeSim(frames);
  const R = recorder(frames.length);
  const kGo = markK(marks, 'go');
  if (kGo == null) throw new Error('refsim needs the "go" mark');
  let start = Infinity;
  const events = [];
  S.after(kGo, () => {
    start = S.birth();
    for (let i = 0; i < P.n; i++) events.push({ kind: 'birth', target: `#b${i}`, T: start, delay: P.base + i * P.step, duration: P.D, easing: 'linear' });
  });
  const M = M06_MAP;
  S.run((j) => {
    const T = frames[j].T;
    for (let i = 0; i < P.n; i++) {
      const e = holdValue(T - start - (P.base + i * P.step), P.D, P.hold, P.bz);
      const sel = `#b${i}`, sc = 1, rot = e * M.rot, tx = e * M.tx;
      R.put(sel, 'ren:--e', j, e); R.put(sel, 'ren:tx', j, tx); R.put(sel, 'ren:ty', j, 0);
      R.put(sel, 'ren:sx', j, 1); R.put(sel, 'ren:sy', j, 1); R.put(sel, 'ren:rz', j, rot);
      R.put(sel, 'ren:opacity', j, M.opA + e * (1 - M.opA));
      const bb = rotBox(120 + 45 + tx, 60 + i * 100 + 35, 90, 70, sc, rot);
      R.put(sel, 'ren:bx', j, bb.x); R.put(sel, 'ren:by', j, bb.y); R.put(sel, 'ren:bw', j, bb.w); R.put(sel, 'ren:bh', j, bb.h);
    }
  });
  return { channels: R.channels, events };
}

// ------------------------------------------------------------------------------------------------ M11 scroll-driven twins
export function m11Range(P) {
  const L = VIEW.h - M11_GEO.H, base = M11_GEO.Y + M11_GEO.H - VIEW.h;
  return { s0: base + (P.r0 / 100) * L, s1: base + (P.r1 / 100) * L, base, L };
}
function m11(P, ctx) {
  const { frames } = ctx;
  const R = recorder(frames.length);
  const { s0, s1 } = m11Range(P);
  const ez = easeFn(P.ease);
  for (let j = 0; j < frames.length; j++) {
    const p = clamp01((frames[j].sy - s0) / (s1 - s0));
    const e = ez(p), tx = P.amp * e, op = 0.15 + 0.85 * e;
    for (const [sel, left] of [['#b0', 100], ['#b1', 700]]) {
      R.put(sel, 'ren:tx', j, tx); R.put(sel, 'ren:ty', j, 0); R.put(sel, 'ren:opacity', j, op);
      R.put(sel, 'ren:bx', j, left + tx); R.put(sel, 'ren:by', j, M11_GEO.Y - frames[j].sy);
      R.put(sel, 'ren:bw', j, 300); R.put(sel, 'ren:bh', j, M11_GEO.H);
    }
  }
  return { channels: R.channels, events: [] };
}

// ------------------------------------------------------------------------------------------------ M12 stagger + count-up + typing
function m12(P, ctx) {
  const { frames, inputs } = ctx;
  const G = M12_GEO, n = G.cols * G.rows;
  const S = makeSim(frames);
  const R = recorder(frames.length);
  const scroll = (inputs || []).find((i) => i.type === 'scrollTo');
  if (!scroll) throw new Error('m12 refsim needs the scrollTo input');
  const ease = easeFn('easeOutCubic'), bz = easeFn(P.bz);
  let animStart = Infinity, t0 = null, count = 0, typed = 0;
  const events = [];
  const loop = () => {
    const p = Math.min(1, (S.now - t0) / P.cD);
    count = P.N * ease(p);
    typed = Math.min(P.text.length, Math.floor((S.now - t0) / P.char));
    if (p < 1 || typed < P.text.length) S.raf(loop);
  };
  S.after(scroll.k, () => {               // the IntersectionObserver callback runs in the real settle of the scrollTo
    animStart = S.birth(); t0 = S.now; S.raf(loop);
    for (let i = 0; i < n; i++) events.push({ kind: 'birth', target: `#b${i}`, T: animStart, delay: staggerIndex(P.order, i, G.cols, G.rows) * P.step, duration: P.du, easing: 'linear' });
  });
  S.run((j) => {
    const T = frames[j].T, sy = frames[j].sy;
    for (let i = 0; i < n; i++) {
      const sel = `#b${i}`, r = Math.floor(i / G.cols), c = i % G.cols;
      const local = T - animStart - staggerIndex(P.order, i, G.cols, G.rows) * P.step;
      const e = local <= 0 ? 0 : local >= P.du ? 1 : bz(local / P.du);
      const ty = G.rise * (1 - e);
      R.put(sel, 'ren:opacity', j, e); R.put(sel, 'ren:ty', j, ty); R.put(sel, 'ren:tx', j, 0);
      R.put(sel, 'ren:bx', j, 80 + c * 150); R.put(sel, 'ren:by', j, 1500 + 120 + r * 90 + ty - sy);
      R.put(sel, 'ren:bw', j, 120); R.put(sel, 'ren:bh', j, 70);
    }
    R.put('#n', 'drv:--c', j, count); R.put('#n', 'ren:--c', j, count);
    R.put('#t', 'drv:--n', j, typed); R.put('#t', 'ren:--n', j, typed);
  });
  return { channels: R.channels, events };
}

// ------------------------------------------------------------------------------------------------ M15 SMIL
function m15(P, ctx) {
  const { frames, marks } = ctx;
  const S = makeSim(frames);
  const R = recorder(frames.length);
  const kGo = markK(marks, 'go');
  if (kGo == null) throw new Error('refsim needs the "go" mark');
  const f = P.spline ? cubicBezier(P.spline[0], P.spline[1], P.spline[2], P.spline[3]) : (x) => x;
  let begin = null;
  const events = [];
  S.after(kGo, () => S.setTimeout(() => { begin = S.now; events.push({ kind: 'smil-begin', T: begin, dur: P.dur }); }, P.delay));
  S.run((j) => {
    const T = frames[j].T;
    let cx = P.from;
    if (begin != null && T >= begin) {
      const frac = (r6(T - begin) % P.dur) / P.dur;
      cx = P.from + (P.to - P.from) * f(frac);
    }
    const g = M15_GEO;
    R.put('#b0', 'ren:bx', j, cx - g.r); R.put('#b0', 'ren:by', j, g.cy - g.r);
    R.put('#b0', 'ren:bw', j, 2 * g.r); R.put('#b0', 'ren:bh', j, 2 * g.r);
  });
  return { channels: R.channels, events };
}

// ------------------------------------------------------------------------------------------------ M17 view transitions
/** Frames between the trigger's frame and the first frame that shows the new layout / the pseudo-element animations. */
export const VT_CALLBACK_FRAMES = 1;
export const VT_ANIM_FRAMES = 2;
const matrixOf = (b) => `matrix(1, 0, 0, 1, ${b.x}, ${b.y})`;
const cssEase = (e) => (Array.isArray(e) ? `cubic-bezier(${e.join(', ')})` : e);
function m17(P, ctx) {
  const { frames, marks } = ctx;
  const R = recorder(frames.length);
  const kGo = markK(marks, 'go');
  if (kGo == null) throw new Error('refsim needs the "go" mark');
  const events = [];
  const born = frames.find((f) => f.k === kGo + VT_ANIM_FRAMES);
  const T = born ? born.T : Infinity;
  for (const [g, d, e] of [['g0', P.d0, P.e0], ['g1', P.d1, P.e1]]) {
    const { A, B } = M17_GEO[g];
    events.push({ kind: 'birth', name: `-ua-view-transition-group-anim-${g}`, T, delay: 0, duration: d, easing: 'linear',
      keyframes: [{ offset: 0, easing: cssEase(e), transform: matrixOf(A), width: `${A.w}px`, height: `${A.h}px` },
        { offset: 1, easing: cssEase(e), transform: matrixOf(B), width: `${B.w}px`, height: `${B.h}px` }] });
  }
  for (let j = 0; j < frames.length; j++) {
    const st = frames[j].k > kGo + (VT_CALLBACK_FRAMES - 1) ? 'B' : 'A';
    for (const [sel, g] of [['#b0', 'g0'], ['#b1', 'g1']]) {
      const b = M17_GEO[g][st];
      R.put(sel, 'ren:bx', j, b.x); R.put(sel, 'ren:by', j, b.y); R.put(sel, 'ren:bw', j, b.w); R.put(sel, 'ren:bh', j, b.h);
    }
  }
  return { channels: R.channels, events };
}

// ------------------------------------------------------------------------------------------------ M18 FLIP
const inv = (d, k) => ({ tx: d.dx * k, ty: d.dy * k, sx: 1 + (d.sx - 1) * k, sy: 1 + (d.sy - 1) * k });
function m18(P, ctx) {
  const { frames, marks } = ctx;
  const S = makeSim(frames);
  const R = recorder(frames.length);
  const ease = easeFn(P.bz);
  const goKs = [markK(marks, 'go'), markK(marks, 'go2')].filter((k) => k != null);
  if (!goKs.length) throw new Error('refsim needs the "go" mark');
  let state = 'A', d = null, k = 0;            // k = inversion factor 1 -> 0 of the running flip
  let anim = null, rafPending = false, tw = null;
  const events = [];
  const layout = () => M18_GEO[state];
  const visual = () => { const L = layout(), t = inv(d || { dx: 0, dy: 0, sx: 1, sy: 1 }, d ? k : 0); return { left: L.x + t.tx, top: L.y + t.ty, width: L.w * t.sx, height: L.h * t.sy }; };
  const tick = () => {
    rafPending = false;
    if (!tw) return;
    if (tw.t0 == null) tw.t0 = S.now;
    const r = tweenAt(tw, S.now);
    k = r.done ? 0 : r.v;
    if (!r.done) { S.raf(tick); rafPending = true; }
  };
  const flip = () => {
    const first = visual();
    anim = null; tw = null; rafPending = false; S.rafs.length = 0; k = 0;       // stop(): cancel the animation / the loop
    state = state === 'A' ? 'B' : 'A';
    const L = layout();
    d = { dx: first.left - L.x, dy: first.top - L.y, sx: first.width / L.w, sy: first.height / L.h };
    events.push({ kind: 'flip', T: S.now, delta: { ...d }, from: first, to: { left: L.x, top: L.y, width: L.w, height: L.h } });
    if (P.impl === 'waapi') {
      anim = { start: S.birth() };
      events.push({ kind: 'birth', target: '#b0', T: anim.start, delay: 0, duration: P.D, easing: `cubic-bezier(${P.bz.join(', ')})` });
      k = 1;
    } else {
      k = 1; tw = { from: 1, to: 0, D: P.D, ease, t0: null }; S.raf(tick); rafPending = true;
    }
  };
  for (const kk of goKs) S.after(kk, flip);
  S.run((j) => {
    const T = frames[j].T;
    if (anim && T >= anim.start) { const p = clamp01((T - anim.start) / P.D); k = 1 - ease(p); }
    const t = inv(d || { dx: 0, dy: 0, sx: 1, sy: 1 }, d ? k : 0), L = layout();
    R.put('#b0', 'ren:tx', j, t.tx); R.put('#b0', 'ren:ty', j, t.ty); R.put('#b0', 'ren:sx', j, t.sx); R.put('#b0', 'ren:sy', j, t.sy);
    R.put('#b0', 'ren:bx', j, L.x + t.tx); R.put('#b0', 'ren:by', j, L.y + t.ty); R.put('#b0', 'ren:bw', j, L.w * t.sx); R.put('#b0', 'ren:bh', j, L.h * t.sy);
  });
  return { channels: R.channels, events };
}

// ------------------------------------------------------------------------------------------------ entry
const ROUTES = { m06, m11, m12, m15, m17, m18, m19: (P, c) => tweenRoute('m19', P, c), m16e: (P, c) => tweenRoute('m16e', P, c), m16f: (P, c) => tweenRoute('m16f', P, c) };

/**
 * @param {string} routeId
 * @param {object} params  full parameter object
 * @param {{frames:object[], inputs?:object[], marks?:object[], variant?:string}} ctx  taken from the actual take
 * @returns {{channels: Object<string, (number|null)[]>, events: object[]}}
 */
export function simulate(routeId, params, ctx) {
  const f = ROUTES[routeId];
  if (!f) throw new Error('unknown route ' + routeId);
  return f(params, ctx);
}
