// Scroll-linked specimens (M3, part "specimens-scroll"): the pure core.
//
// Browser-safe and import-free on purpose. The same text is (a) imported by Node (the simulator, the tests) and (b) inlined
// into every generated specimen page after its top-level `export ` keywords are removed (emit.js). So the page and the
// simulator run literally the same recurrences; what the browser adds (layout, sticky pins, CSS, wheel/pointer events,
// WAAPI, View Transitions) is what the browser tests check against these functions.
//
// Frame semantics (identical to the recorder's `hx` lane and to the Fixture Lab's refsim):
//   * frame k runs at virtual time T_k; its rAF callback reads the scroll offset of row k;
//   * an input that lands between frame k-1 and frame k (event time T_e < T_k) is handled before frame k;
//     an input dispatched at T_e == T_k (after frame k) is therefore handled before frame k+1.
// Nothing here knows a site: every number arrives through the specimen spec.

export const SPECIMEN_SCHEMA = 'reva.specimen.scroll/0';

// ------------------------------------------------------------------------------------------------ scalar maths
export const clamp = (lo, x, hi) => Math.min(hi, Math.max(lo, x));
export const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const lerp = (a, b, t) => a + (b - a) * t;
export const round6 = (x) => Math.round(x * 1e6) / 1e6;

/** CSS cubic-bezier(x1, y1, x2, y2) as a function of progress (Newton with a bisection fallback, double precision). */
export function cubicBezier(x1, y1, x2, y2) {
  if (x1 === y1 && x2 === y2) return (x) => x;
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const X = (t) => ((ax * t + bx) * t + cx) * t;
  const Y = (t) => ((ay * t + by) * t + cy) * t;
  const dX = (t) => (3 * ax * t + 2 * bx) * t + cx;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 12; i++) {
      const e = X(t) - x;
      if (Math.abs(e) < 1e-14) return Y(t);
      const d = dX(t);
      if (Math.abs(d) < 1e-9) break;
      t -= e / d;
    }
    let lo = 0, hi = 1; t = x;
    for (let i = 0; i < 80; i++) {
      const e = X(t) - x;
      if (Math.abs(e) < 1e-14) break;
      if (e > 0) hi = t; else lo = t;
      t = (lo + hi) / 2;
    }
    return Y(t);
  };
}

const C1 = 1.70158, C3 = C1 + 1, C2 = C1 * 1.525;
const NAMED = {
  linear: (u) => u,
  smoothstep: (u) => u * u * (3 - 2 * u),
  smootherstep: (u) => u * u * u * (u * (u * 6 - 15) + 10),
  easeinquad: (u) => u * u, easeoutquad: (u) => 1 - (1 - u) * (1 - u), easeinoutquad: (u) => (u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2),
  easeincubic: (u) => u * u * u, easeoutcubic: (u) => 1 - Math.pow(1 - u, 3), easeinoutcubic: (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2),
  easeinquart: (u) => u ** 4, easeoutquart: (u) => 1 - Math.pow(1 - u, 4), easeinoutquart: (u) => (u < 0.5 ? 8 * u ** 4 : 1 - Math.pow(-2 * u + 2, 4) / 2),
  easeinquint: (u) => u ** 5, easeoutquint: (u) => 1 - Math.pow(1 - u, 5), easeinoutquint: (u) => (u < 0.5 ? 16 * u ** 5 : 1 - Math.pow(-2 * u + 2, 5) / 2),
  easeinsine: (u) => 1 - Math.cos((u * Math.PI) / 2), easeoutsine: (u) => Math.sin((u * Math.PI) / 2), easeinoutsine: (u) => -(Math.cos(Math.PI * u) - 1) / 2,
  easeinexpo: (u) => (u === 0 ? 0 : Math.pow(2, 10 * u - 10)), easeoutexpo: (u) => (u === 1 ? 1 : 1 - Math.pow(2, -10 * u)),
  easeinoutexpo: (u) => (u === 0 ? 0 : u === 1 ? 1 : u < 0.5 ? Math.pow(2, 20 * u - 10) / 2 : (2 - Math.pow(2, -20 * u + 10)) / 2),
  easeincirc: (u) => 1 - Math.sqrt(1 - u * u), easeoutcirc: (u) => Math.sqrt(1 - Math.pow(u - 1, 2)),
  easeinoutcirc: (u) => (u < 0.5 ? (1 - Math.sqrt(1 - Math.pow(2 * u, 2))) / 2 : (Math.sqrt(1 - Math.pow(-2 * u + 2, 2)) + 1) / 2),
  easeinback: (u) => C3 * u * u * u - C1 * u * u, easeoutback: (u) => 1 + C3 * Math.pow(u - 1, 3) + C1 * Math.pow(u - 1, 2),
  easeinoutback: (u) => (u < 0.5 ? (Math.pow(2 * u, 2) * ((C2 + 1) * 2 * u - C2)) / 2 : (Math.pow(2 * u - 2, 2) * ((C2 + 1) * (u * 2 - 2) + C2) + 2) / 2),
};
// CSS keywords and GSAP-style spellings
const ALIASES = {
  ease: [0.25, 0.1, 0.25, 1], easein: [0.42, 0, 1, 1], easeout: [0, 0, 0.58, 1], easeinout: [0.42, 0, 0.58, 1],
  'ease-in': [0.42, 0, 1, 1], 'ease-out': [0, 0, 0.58, 1], 'ease-in-out': [0.42, 0, 0.58, 1],
};
const GSAP = { 'expo.out': 'easeoutexpo', 'expo.in': 'easeinexpo', 'expo.inout': 'easeinoutexpo', 'power1.out': 'easeoutquad', 'power2.out': 'easeoutcubic', 'power3.out': 'easeoutquart', 'power4.out': 'easeoutquint',
  'power1.in': 'easeinquad', 'power2.in': 'easeincubic', 'power3.in': 'easeinquart', 'power4.in': 'easeinquint', 'power1.inout': 'easeinoutquad', 'power2.inout': 'easeinoutcubic', 'power3.inout': 'easeinoutquart', 'power4.inout': 'easeinoutquint', 'sine.out': 'easeoutsine', 'sine.in': 'easeinsine', 'sine.inout': 'easeinoutsine', none: 'linear' };

/** Canonical lower-case key of an ease name ("named:easeOutCubic" -> "easeoutcubic"), or null when unknown. */
export function easeKey(name) {
  if (typeof name !== 'string') return null;
  let s = name.trim().toLowerCase().replace(/^named:/, '');
  if (GSAP[s]) s = GSAP[s];
  if (NAMED[s]) return s;
  if (NAMED['ease' + s]) return 'ease' + s;
  return null;
}
export const EASE_NAMES = Object.keys(NAMED);

/** An ease spec is a name, a CSS keyword, or [x1, y1, x2, y2]. Returns f(progress) -> value; throws on an unknown name. */
export function easeFn(spec) {
  if (Array.isArray(spec)) return cubicBezier(spec[0], spec[1], spec[2], spec[3]);
  const k = easeKey(spec);
  if (k) return NAMED[k];
  const a = typeof spec === 'string' ? ALIASES[spec.trim().toLowerCase()] : null;
  if (a) return cubicBezier(a[0], a[1], a[2], a[3]);
  throw new Error('unknown ease: ' + JSON.stringify(spec));
}
/** CSS timing-function text for an ease spec (bezier arrays and the CSS keywords; named Penner eases have no CSS form). */
export function cssEase(spec) {
  if (Array.isArray(spec)) return `cubic-bezier(${spec.join(', ')})`;
  const s = String(spec).trim().toLowerCase();
  if (s === 'linear' || ALIASES[s]) return s === 'easein' ? 'ease-in' : s === 'easeout' ? 'ease-out' : s === 'easeinout' ? 'ease-in-out' : s;
  return null;
}

/** Scroll-map shape: { shape, bezier? } -> S(u) with u in [0, 1] already clamped. */
export function shapeFn(map) {
  if (Array.isArray(map.bezier)) return cubicBezier(map.bezier[0], map.bezier[1], map.bezier[2], map.bezier[3]);
  return easeFn(map.shape);
}

/** Text written to the DOM: 'full' = shortest round-trip double, 'q3'/'q2' = toFixed(3/2), 'int' = rounded integer. */
export function fmt(x, mode = 'full') {
  if (mode === 'q3') return x.toFixed(3);
  if (mode === 'q2') return x.toFixed(2);
  if (mode === 'int') return String(Math.round(x));
  return String(x);
}
/** The number a reader gets back from the written text. */
export const written = (x, mode = 'full') => parseFloat(fmt(x, mode));

// ------------------------------------------------------------------------------------------------ smoothing recurrences
/** Per-frame exponential smoothing with a snap. */
export function emaStep(cur, target, alpha, snap) {
  const d = target - cur;
  return Math.abs(d) < snap || alpha >= 1 ? target : cur + alpha * d;
}
/** dt-aware damping: the same curve as emaStep with alpha = 1 - exp(-lambda dt). */
export function dampStep(cur, target, lambda, dtMs, snap) {
  const d = target - cur;
  return Math.abs(d) < snap ? target : cur + d * (1 - Math.exp(-lambda * dtMs * 0.001));
}
/** Asymmetric smoothing: alphaUp on a rising target, alphaDown on a falling one (alphaUp = 1 is a snap on rise). */
export function asymStep(cur, target, alphaUp, alphaDown, snap) {
  return emaStep(cur, target, target > cur ? alphaUp : alphaDown, snap);
}

// ------------------------------------------------------------------------------------------------ mechanisms
// Every mechanism: reset(f0) / event(ev, ctx) / frame(f) / values(out). `out` receives the internal quantities by
// name; the engine turns them into channel values with the affine maps of the spec (channelValues below).
// f = { k, T, dt, sy, vh, vw }; dt is the time since the previous frame in ms (0 on the first).

class ScrollDriven {
  constructor(spec) {
    this.s = spec; this.S = shapeFn(spec.map); this.sm = spec.smoothing || { law: 'none' };
    this.ease = this.sm.law === 'restarted' ? easeFn(this.sm.ease || 'expo.out') : null;
    this.lag = Math.max(0, spec.map.lagFrames | 0);   // driver lag in frames (record: map.driverLagFrames); 0 = same frame
  }
  target(sy) {
    const m = this.s.map; const u = clamp01((sy - m.s0) / (m.s1 - m.s0)); const p = this.S(u);
    return m.flip ? 1 - p : p;
  }
  reset(f0) {
    this.hist = [f0.sy];
    const t = this.target(f0.sy);
    this.cur = typeof this.s.init === 'number' ? this.s.init : t; this.tw = null; this.lastTarget = t; this.x = this.cur;
  }
  event() { return null; }
  frame(f) {
    // the driver reads the scroll offset `lag` frames late: the offset of frame k - lag (the first offset until then)
    this.hist.push(f.sy); if (this.hist.length > this.lag + 1) this.hist.shift();
    const t = this.target(this.hist[0]), sm = this.sm;
    const snap = sm.snap ?? 0;
    switch (sm.law) {
      case 'ema': this.cur = emaStep(this.cur, t, sm.alpha, snap); break;
      case 'dtdamp': this.cur = dampStep(this.cur, t, sm.lambda, f.dt, snap); break;
      case 'asym': this.cur = asymStep(this.cur, t, sm.alphaUp, sm.alphaDown, snap); break;
      case 'restarted': {
        if (!this.tw || Math.abs(t - this.tw.to) > 1e-12) this.tw = { from: this.cur, to: t, t0: f.T };
        const p = clamp01((f.T - this.tw.t0) / sm.L);
        this.cur = lerp(this.tw.from, this.tw.to, this.ease(p));
        break;
      }
      default: this.cur = t;
    }
    this.lastTarget = t; this.x = this.cur;
  }
  values(out) { out.x = this.x; out.target = this.lastTarget; }
}

class Hysteresis {
  constructor(spec) { this.s = spec; }
  reset(f0) { this.i = this.s.init ?? 0; this.step(f0.sy); }
  step(sy) {
    const { up, down, levels } = this.s;
    while (this.i < levels - 1 && sy >= up[this.i]) this.i++;
    while (this.i > 0 && sy <= down[this.i - 1]) this.i--;
  }
  event() { return null; }
  frame(f) { this.step(f.sy); }
  values(out) { out.i = this.i; }
}

// Wheel-driven smooth scroller (smooth-scroll-library-class 'damp' with an exact lerp -> lambda, or a legacy per-frame lerp).
class WheelSmooth {
  constructor(spec) { this.s = spec; }
  reset(f0) { this.cur = f0.sy; this.target = f0.sy; this.running = false; }
  event(ev) {
    if (ev.type !== 'wheel') return null;
    const t = clamp(0, this.target + ev.dy * (this.s.mult ?? 1), this.s.limit);
    if (t === this.target) return { prevent: true, changed: false };
    this.target = t; this.running = true;
    return { prevent: true, changed: true };
  }
  frame(f) {
    if (this.running) {
      const s = this.s;
      this.cur = s.law === 'dtdamp' ? this.cur + (this.target - this.cur) * (1 - Math.exp(-s.lambda * f.dt * 0.001)) : lerp(this.cur, this.target, s.lerp);
      if (Math.round(this.cur) === Math.round(this.target)) { this.cur = this.target; this.running = false; }
    }
  }
  values(out) { out.y = this.cur; out.scrollTo = Math.round(this.cur); }
}

// Wheel-latched tween: while a section is latched in view a wheel tick starts a 0 <-> 1 tween (retarget from the current
// value), the wheel event is swallowed and the scroll offset is held. Armed state is computed from geometry (an
// IntersectionObserver callback is not deterministic under the virtual clock).
class WheelLatch {
  constructor(spec) { this.s = spec; this.E = easeFn(spec.ease || 'easeOutCubic'); }
  reset() { this.p = 0; this.tw = null; this.pinY = null; }
  armed(sy, vh) { const top = this.s.section.top - sy, bottom = top + this.s.section.height, m = (this.s.armMarginVh ?? 2) * vh; return top <= vh + m && bottom >= -m; }
  latched(sy, vh) {
    const top = this.s.section.top - sy, bottom = top + this.s.section.height;
    const vis = Math.min(bottom, vh) - Math.max(top, 0);
    return vis >= (this.s.visMinVh ?? 0.45) * vh && bottom <= vh + (this.s.bottomSlack ?? 8);
  }
  value(T) { if (!this.tw) return this.p; const u = clamp01((T - this.tw.t0) / this.s.dur); return u >= 1 ? this.tw.to : lerp(this.tw.from, this.tw.to, this.E(u)); }
  event(ev, ctx) {
    if (ev.type !== 'wheel') return null;
    if (!this.armed(ctx.sy, ctx.vh) || Math.abs(ev.dy) < 1) return { prevent: false, action: 'ignored' };
    if (!this.latched(ctx.sy, ctx.vh)) return { prevent: false, action: 'not-latched' };
    const target = ev.dy > 0 ? 1 : 0, cur = this.value(ctx.T);
    if (!this.tw && cur === target) return { prevent: false, action: 'at-rest' };
    if (this.tw && this.tw.to === target) return { prevent: true, action: 'swallowed' };
    const action = this.tw ? 'retarget' : 'start';
    this.tw = { from: cur, to: target, t0: ctx.T };
    if (this.pinY == null) this.pinY = ctx.sy;
    return { prevent: true, action };
  }
  frame(f) {
    if (this.tw) {
      const u = clamp01((f.T - this.tw.t0) / this.s.dur);
      this.p = u >= 1 ? this.tw.to : lerp(this.tw.from, this.tw.to, this.E(u));
      if (u >= 1) this.tw = null;
    }
    this.pinTo = this.tw ? this.pinY : null;
    if (!this.tw) this.pinY = null;
  }
  values(out) { out.m = this.p; if (this.pinTo != null) out.scrollTo = this.pinTo; }
}

// Pointer drag + release inertia: x follows the pointer while dragging, then v *= friction per frame (law 'frame') or
// friction^(60 dt) (law 'dt'); release velocity = pointer displacement over the last `velWindowMs` ms, in px per
// nominal 60 Hz frame.
class Inertia {
  constructor(spec) { this.s = spec; }
  reset() { this.x = this.s.x0 ?? 0; this.v = 0; this.mode = 'idle'; this.ptr = 0; this.grab = 0; this.samples = []; this.release = null; }
  event(ev) {
    const w = this.s.velWindowMs ?? 100, hz = this.s.nominalHz ?? 60;
    if (ev.type === 'pointerdown') { this.mode = 'drag'; this.ptr = ev.x; this.grab = this.x - ev.x; this.samples = [{ t: ev.T, x: ev.x }]; this.v = 0; }
    else if (ev.type === 'pointermove') { if (this.mode !== 'drag') return null; this.ptr = ev.x; this.samples.push({ t: ev.T, x: ev.x }); if (this.samples.length > 400) this.samples.shift(); }
    else if (ev.type === 'pointerup') {
      if (this.mode !== 'drag') return null;
      const ws = this.samples.filter((s) => s.t >= ev.T - w); let vms = 0;
      if (ws.length >= 2) { const a = ws[0], b = ws[ws.length - 1]; if (b.t > a.t) vms = (b.x - a.x) / (b.t - a.t); }
      this.v = vms * (1000 / hz);
      this.release = { T: ev.T, x: this.x, vms, vFrame: this.v };
      this.mode = Math.abs(this.v) < this.s.stopEps ? 'done' : 'coast';
      if (this.mode === 'done') this.v = 0;
    }
    return null;
  }
  frame(f) {
    if (this.mode === 'drag') this.x = this.ptr + this.grab;
    else if (this.mode === 'coast') {
      const sc = this.s.law === 'dt' ? (60 * f.dt) / 1000 : 1;
      this.v *= this.s.law === 'dt' ? Math.pow(this.s.friction, sc) : this.s.friction;
      if (Math.abs(this.v) < this.s.stopEps) { this.v = 0; this.mode = 'done'; } else this.x += this.v * sc;
    }
  }
  values(out) { out.x = this.x; }
}

// FLIP: First-Last-Invert-Play on a two-state layout. The inverse is translate(dx, dy) scale(sx, sy) about the box's top-left corner;
// k = 1 at the inverted state, 0 at rest. A trigger while it runs restarts from the current visual rect.
export const rectOf = (L, t) => ({ x: L.x + t.tx, y: L.y + t.ty, w: L.w * t.sx, h: L.h * t.sy });   // transform-origin 0 0
export const flipDelta = (first, last) => ({ dx: first.x - last.x, dy: first.y - last.y, sx: first.w / last.w, sy: first.h / last.h });
export const flipInverse = (d, k) => ({ tx: d.dx * k, ty: d.dy * k, sx: 1 + (d.sx - 1) * k, sy: 1 + (d.sy - 1) * k });
class Flip {
  constructor(spec) { this.s = spec; this.E = easeFn(spec.ease); }
  reset() { this.state = 0; this.seg = null; this.vis = { tx: 0, ty: 0, sx: 1, sy: 1 }; this.pendingStart = null; this.log = []; }
  layout() { return this.state ? this.s.B : this.s.A; }
  event(ev, ctx) {
    if (ev.type !== 'trigger') return null;
    const first = rectOf(this.layout(), this.vis);
    this.state ^= 1;
    const d = flipDelta(first, this.layout());
    this.seg = { d, t0: null, from: 1 };
    this.vis = flipInverse(d, 1);
    this.log.push({ T: ctx.T, d });
    return { action: 'trigger' };
  }
  frame(f) {
    if (!this.seg) return;
    if (this.seg.t0 == null) this.seg.t0 = f.T;    // the play starts on the first frame after the trigger (WAAPI / rAF alike)
    const p = (f.T - this.seg.t0) / this.s.D;
    if (p >= 1) { this.vis = { tx: 0, ty: 0, sx: 1, sy: 1 }; this.seg = null; return; }
    this.vis = flipInverse(this.seg.d, 1 - this.E(p < 0 ? 0 : p));
  }
  values(out) { out.tx = this.vis.tx; out.ty = this.vis.ty; out.sx = this.vis.sx; out.sy = this.vis.sy; out.state = this.state; }
}

// View Transition: named groups morph from the old to the new layout box, each with its own duration and timing function.
// Numeric expectation of the ::view-transition-group box at time since the animation start (the page uses the real API).
export function vtGroupAt(g, ms) {
  const p = clamp01((ms - (g.delay ?? 0)) / g.d), e = easeFn(g.ease)(p);
  return { x: lerp(g.A.x, g.B.x, e), y: lerp(g.A.y, g.B.y, e), w: lerp(g.A.w, g.B.w, e), h: lerp(g.A.h, g.B.h, e), p, e };
}
class ViewTransition {
  constructor(spec) { this.s = spec; }
  reset() { this.fired = null; this.t0 = null; }
  event(ev, ctx) { if (ev.type === 'trigger' && this.fired == null) { this.fired = ctx.T; return { action: 'trigger' }; } return null; }
  frame(f) { if (this.fired != null && this.t0 == null && f.T > this.fired) this.t0 = f.T; }
  values(out) {
    out.started = this.t0 != null ? 1 : 0;
    out.groups = {};
  }
}

const KINDS = {
  'scroll-driven': ScrollDriven, hysteresis: Hysteresis, 'wheel-smooth': WheelSmooth, 'wheel-latch': WheelLatch,
  inertia: Inertia, flip: Flip, 'view-transition': ViewTransition,
};
export const MECHANISM_KINDS = Object.keys(KINDS);

// ------------------------------------------------------------------------------------------------ channels
/**
 * Channel values of one mechanism from its internal quantities. Channel = { name, kind: 'var'|'ren', prop, of, k0, k1,
 * via?, write? }: value = k0 + k1 * q, q = the internal quantity `of` (var channels) or the WRITTEN value of the var
 * channel `via` (ren channels that the stylesheet of the source maps from a written custom property).
 */
export function channelValues(mech, q) {
  const res = {}; const writtenBy = [];
  mech.channels.forEach((c, i) => {
    if (c.via != null) return;
    const v = c.k0 + c.k1 * q[c.of];
    const w = c.kind === 'var' ? written(v, c.write || 'full') : v;
    res[c.name] = w; writtenBy[i] = w;
  });
  mech.channels.forEach((c) => { if (c.via != null) res[c.name] = c.k0 + c.k1 * writtenBy[c.via]; });
  return res;
}

// ------------------------------------------------------------------------------------------------ engine
/**
 * The deterministic engine: one instance per page, owns the mechanisms. `setup` reads the spec; `begin(f0)` resets every
 * mechanism to its initial state from the first frame's inputs; `deliver(ev, ctx)` hands an input to the mechanisms;
 * `frame(f)` advances; `snapshot()` returns { 'subject|channel': value } plus requests (scroll positions to set).
 */
export class Engine {
  constructor(spec) {
    this.spec = spec;
    this.vh = spec.viewport.height; this.vw = spec.viewport.width;
    this.mechs = spec.mechanisms.map((m) => ({ spec: m, impl: new KINDS[m.kind](m) }));
  }
  begin(f0) {
    this.prevT = null; this.k = 0; this.lastSy = f0.sy;
    for (const m of this.mechs) m.impl.reset({ ...f0, vh: this.vh, vw: this.vw });
  }
  deliver(ev0, ctx) {
    const ev = ev0.T == null ? { ...ev0, T: ctx.T } : ev0;
    const res = [];
    for (const m of this.mechs) { const r = m.impl.event(ev, { ...ctx, vh: this.vh, vw: this.vw }); if (r) res.push({ id: m.spec.id, ...r }); }
    return res;
  }
  frame(f) {
    const dt = this.prevT == null ? 0 : f.T - this.prevT; this.prevT = f.T; this.k = f.k; this.lastSy = f.sy;
    const ff = { ...f, dt, vh: this.vh, vw: this.vw };
    for (const m of this.mechs) m.impl.frame(ff);
  }
  snapshot() {
    const channels = {}; const aux = {}; let scrollTo = null;
    for (const m of this.mechs) {
      const q = {}; m.impl.values(q);
      const cv = channelValues(m.spec, q);
      for (const [name, v] of Object.entries(cv)) channels[`${m.spec.subject}|${name}`] = v;
      aux[m.spec.id] = q;
      if (q.scrollTo != null) scrollTo = q.scrollTo;
    }
    return { channels, aux, scrollTo };
  }
}

/** Frame k (1-based) of an input description: { frames?: [{k, T, sy}], scroll?: [{T, sy}], sy0? } and a nominal period. */
export function frameAt(input, frameMs, k) {
  if (input && input.frames && input.frames.length) {
    const f = input.frames[k - (input.frames[0].k ?? 1)];
    if (f && f.k === k) return { k, T: f.T, sy: f.sy };
    return null;
  }
  const T = round6(k * frameMs); let sy = input && input.sy0 != null ? input.sy0 : 0;
  const ev = input && input.scroll;
  if (ev) for (let i = 0; i < ev.length && ev[i].T < T; i++) sy = ev[i].sy;
  return { k, T, sy };
}

/** Events (wheel / pointer / trigger) of an input description, sorted by time (stable). */
export function inputEvents(input) {
  const out = [];
  if (!input) return out;
  for (const w of input.wheel || []) out.push({ type: 'wheel', T: w.T, dy: w.dy });
  for (const p of input.pointer || []) out.push({ type: 'pointer' + p.type, T: p.T, x: p.x });
  for (const t of input.triggers || []) out.push({ type: 'trigger', T: t.T });
  return out.map((e, i) => ({ e, i })).sort((a, b) => a.e.T - b.e.T || a.i - b.i).map((x) => x.e);
}

/**
 * Deterministic replay of frames 1..K of a spec under an input description. Returns the per-frame snapshots when
 * `collect` is true. The page's seek(t) and the Node simulator are both this function.
 */
export class Replayer {
  constructor(spec, input) {
    this.spec = spec; this.input = input || {}; this.eng = new Engine(spec);
    this.frameMs = spec.frameMs; this.events = inputEvents(this.input);
    this.rewind();
  }
  rewind() { this.k = 0; this.ei = 0; this.started = false; this.last = null; this.eventLog = []; }
  /** Advance to frame K (>= current); K = 0 is the initial state. Returns the snapshot after frame K (or every frame's when `collect`). */
  to(K, collect) {
    const out = [];
    if (!this.started) { const f1 = frameAt(this.input, this.frameMs, 1); if (f1) { this.eng.begin(f1); this.started = true; } }
    while (this.started && this.k < K) {
      const k = this.k + 1; const f = frameAt(this.input, this.frameMs, k);
      if (!f) break;
      while (this.ei < this.events.length && this.events[this.ei].T < f.T) {
        const ev = this.events[this.ei++];
        const res = this.eng.deliver(ev, { T: ev.T, sy: this.eng.lastSy });
        if (res.length) this.eventLog.push({ ...ev, k: this.k, res });
      }
      this.eng.frame(f); this.k = k;
      if (collect) out.push({ k, T: f.T, sy: f.sy, ...this.eng.snapshot() });
    }
    this.last = this.started ? { k: this.k, ...this.eng.snapshot() } : null;
    return collect ? out : this.last;
  }
}

/** Number of whole frames whose time is <= t under the input's frame list or the nominal period. */
export function framesUpTo(input, frameMs, t) {
  if (input && input.frames && input.frames.length) {
    let n = 0; for (const f of input.frames) { if (f.T <= t + 1e-9) n++; else break; } return n;
  }
  return Math.max(0, Math.floor(t / frameMs + 1e-9));
}
