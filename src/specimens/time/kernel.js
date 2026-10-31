// Time-specimen kernel (M3 "specimens-time"): the pure math that evaluates one motion at a time t.
// Isomorphic on purpose: Node (tests, expected curves, generator) and the specimen page both run THIS function body.
// The generator inlines `createKernel.toString()` into every specimen, so the function must stay self-contained
// (no imports, no outer-scope references, no DOM, no Date.now, no Math.random). All times are ms on the specimen
// timeline (0 = the anchor frame), all values are in the unit of the channel they drive.
//
// Motion kinds (the `reva.specimen.time/0` motion vocabulary):
//   tween      {from, to, startMs, durationMs, ease, quantum?, birthMs?, base?}   time-based tween with a named/bezier/stops/steps ease (quantum: write lattice,
//                                                                         e.g. typing). birthMs/base: a declared animation that does not exist before birthMs
//                                                                         (the element shows the unanimated identity value `base` until then)
//   chain      {parts: [tween...]}                                        retargeted tweens: the last part that has started wins
//   keyframes  {startMs, durationMs, iterations, direction, easing, easingScope, frames: [{offset, value, easing?}]}
//                                                                         CSS/WAAPI semantics, loops (iterations Infinity), SMIL sawtooth
//   spring     {integrator, k, c | kf, cf, start: {t, x, v}, g0, events: [{t, g, v?}], onsetMs, snap?}
//                                                                         analytic (i6) or a discrete integrator (see INTEGRATORS)
//   friction   {startMs, x0, v0, friction, law, stopV}                    inertia coast (v0 in value per 60 Hz frame)
//   step       {atMs, before, after}                                      one-frame change
//   ticks      {startMs, periodMs, values, iterations}                    discrete cycle (e.g. a 1 Hz class toggle)
//
// Frame-based motions (spring, friction) are stateful: their value depends on the frame times they were advanced over.
// `series(motion, times)` advances over an explicit frame list (what the page did on a real take, stalls included);
// `valueAt(motion, t, {frameMs})` is the deterministic seek: it advances over the nominal grid k*frameMs and finishes with
// one remainder step to t, so seek(t) is a pure function of (spec, t, frameMs).
export function createKernel() {
  'use strict';
  const INF = Infinity;
  // Frame and event times are r6-rounded (1e-6 ms) by the recorder; an event exactly on a frame boundary must fire on that frame.
  const EPS_T = 1e-5;

  // ------------------------------------------------------------------------------------------------------ easing
  function cubicBezierFn(x1, y1, x2, y2) {
    // CSS cubic-bezier(x1, y1, x2, y2): solve x(s) = u (Newton, bisection fallback), return y(s).
    const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
    const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
    const X = (s) => ((ax * s + bx) * s + cx) * s;
    const Y = (s) => ((ay * s + by) * s + cy) * s;
    const dX = (s) => (3 * ax * s + 2 * bx) * s + cx;
    return (u) => {
      if (u <= 0) return 0;
      if (u >= 1) return 1;
      let s = u;
      for (let i = 0; i < 12; i++) {
        const e = X(s) - u;
        if (Math.abs(e) < 1e-13) return Y(s);
        const d = dX(s);
        if (Math.abs(d) < 1e-9) break;
        s -= e / d;
      }
      let lo = 0, hi = 1; s = u;
      for (let i = 0; i < 80; i++) {
        const e = X(s) - u;
        if (Math.abs(e) < 1e-13) break;
        if (e > 0) hi = s; else lo = s;
        s = (lo + hi) / 2;
      }
      return Y(s);
    };
  }
  const c1 = 1.70158, c2 = c1 * 1.525, c3 = c1 + 1;
  const pw = (n) => ({ in: (p) => Math.pow(p, n), out: (p) => 1 - Math.pow(1 - p, n), inOut: (p) => (p < 0.5 ? Math.pow(2, n - 1) * Math.pow(p, n) : 1 - Math.pow(-2 * p + 2, n) / 2) });
  const FAMILIES = {
    sine: { in: (p) => 1 - Math.cos((p * Math.PI) / 2), out: (p) => Math.sin((p * Math.PI) / 2), inOut: (p) => -(Math.cos(Math.PI * p) - 1) / 2 },
    quad: pw(2), cubic: pw(3), quart: pw(4), quint: pw(5),
    expo: { in: (p) => Math.pow(2, 10 * p - 10), out: (p) => 1 - Math.pow(2, -10 * p),
      inOut: (p) => (p < 0.5 ? Math.pow(2, 20 * p - 10) / 2 : (2 - Math.pow(2, -20 * p + 10)) / 2) },
    circ: { in: (p) => 1 - Math.sqrt(1 - p * p), out: (p) => Math.sqrt(1 - (p - 1) * (p - 1)),
      inOut: (p) => (p < 0.5 ? (1 - Math.sqrt(1 - 4 * p * p)) / 2 : (Math.sqrt(1 - Math.pow(-2 * p + 2, 2)) + 1) / 2) },
    back: { in: (p) => c3 * p * p * p - c1 * p * p, out: (p) => 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2),
      inOut: (p) => (p < 0.5 ? (Math.pow(2 * p, 2) * ((c2 + 1) * 2 * p - c2)) / 2 : (Math.pow(2 * p - 2, 2) * ((c2 + 1) * (p * 2 - 2) + c2) + 2) / 2) },
  };
  const CSS_KEYWORDS = { linear: [0, 0, 1, 1], ease: [0.25, 0.1, 0.25, 1], 'ease-in': [0.42, 0, 1, 1], 'ease-out': [0, 0, 0.58, 1], 'ease-in-out': [0.42, 0, 0.58, 1] };
  /** Resolve a named ease: 'easeOutCubic', 'expo.out', 'power3.inOut', 'ease-out', 'linear'. Returns a (u in (0,1)) function or null. */
  function namedFn(name) {
    if (CSS_KEYWORDS[name]) { const b = CSS_KEYWORDS[name]; return name === 'linear' ? (p) => p : cubicBezierFn(b[0], b[1], b[2], b[3]); }
    let m = /^ease(In|Out|InOut)([A-Z][a-z]+)$/.exec(name);
    if (m && FAMILIES[m[2].toLowerCase()]) return FAMILIES[m[2].toLowerCase()][m[1] === 'In' ? 'in' : m[1] === 'Out' ? 'out' : 'inOut'];
    m = /^(sine|quad|cubic|quart|quint|expo|circ|back)\.(in|out|inOut)$/.exec(name);
    if (m) return FAMILIES[m[1]][m[2]];
    m = /^power([1-5])\.(in|out|inOut)$/.exec(name);
    if (m) return FAMILIES[['', 'quad', 'cubic', 'quart', 'quint'][+m[1] - 1] || 'quad'][m[2]] || null;
    return null;
  }
  const easeCache = new Map();
  /** ease spec -> function on [0,1]. kinds: linear | bezier {p} | named {name} | stops {stops: [[x, y]...]} | steps {n, pos} */
  function easeFn(spec) {
    if (!spec || spec.kind === 'linear') return (p) => p;
    const key = JSON.stringify(spec);
    let f = easeCache.get(key);
    if (f) return f;
    if (spec.kind === 'bezier') f = cubicBezierFn(spec.p[0], spec.p[1], spec.p[2], spec.p[3]);
    else if (spec.kind === 'named') { f = namedFn(spec.name); if (!f) throw new Error('unknown ease ' + spec.name); }
    else if (spec.kind === 'stops') {
      const st = spec.stops;
      f = (p) => {
        if (p <= st[0][0]) return st[0][1];
        for (let i = 1; i < st.length; i++) if (p <= st[i][0]) { const a = st[i - 1], b = st[i]; return b[0] === a[0] ? b[1] : a[1] + ((b[1] - a[1]) * (p - a[0])) / (b[0] - a[0]); }
        return st[st.length - 1][1];
      };
    } else if (spec.kind === 'steps') {
      const n = spec.n, pos = spec.pos || 'end';
      f = (p) => {
        const jumpStart = pos === 'start' || pos === 'jump-start' || pos === 'jump-both';
        const jumps = pos === 'jump-both' ? n + 1 : pos === 'jump-none' ? n - 1 : n;
        let s = Math.floor(p * n); if (jumpStart) s++;
        if (p >= 1) s = jumps;
        return Math.min(1, s / jumps);
      };
    } else throw new Error('unknown ease kind ' + spec.kind);
    easeCache.set(key, f);
    return f;
  }
  const ease = (spec, u) => (u <= 0 ? 0 : u >= 1 ? 1 : easeFn(spec)(u));
  /** CSS easing string for an ease spec, or null when CSS cannot express it exactly (named Penner eases other than the keywords). */
  function cssEasing(spec) {
    if (!spec || spec.kind === 'linear') return 'linear';
    if (spec.kind === 'bezier') return 'cubic-bezier(' + spec.p.join(', ') + ')';
    if (spec.kind === 'named') return CSS_KEYWORDS[spec.name] && spec.name !== 'linear' ? spec.name : null;
    if (spec.kind === 'steps') return 'steps(' + spec.n + ', ' + (spec.pos || 'end') + ')';
    if (spec.kind === 'stops') return 'linear(' + spec.stops.map((s) => s[1] + ' ' + s[0] * 100 + '%').join(', ') + ')';
    return null;
  }

  // ------------------------------------------------------------------------------------------------ stateless motions
  function tweenAt(m, t) {
    if (m.birthMs != null && t < m.birthMs - EPS_T) return m.base;
    const u = (t - m.startMs) / m.durationMs;
    if (u <= 0) return m.from;
    if (u >= 1) return m.to;
    const v = m.from + (m.to - m.from) * easeFn(m.ease)(u);
    return m.quantum ? m.from + Math.floor((v - m.from) / m.quantum + 1e-9) * m.quantum : v;
  }
  function chainAt(m, t) {
    let part = m.parts[0];
    for (const p of m.parts) if (p.startMs <= t + EPS_T) part = p;   // a part that starts exactly on a frame (to the 1e-6 ms grid) shows on that frame, as its birth does
    return tweenAt(part, t);
  }
  /** CSS/WAAPI keyframe animation evaluated by hand (declared motions, loops, SMIL sawtooth). */
  function keyframesAt(m, t) {
    const F = m.frames, D = m.durationMs, iters = m.iterations == null ? 1 : m.iterations;
    if (m.birthMs != null && t < m.birthMs - EPS_T) return m.base;
    const rest = m.rest != null ? m.rest : F[0].value;
    const fill = m.fill || 'both';
    let lt = t - m.startMs;
    if (lt < 0) { if (fill !== 'both' && fill !== 'backwards') return rest; lt = 0; }      // fill backwards shows the directed state at progress 0
    const active = D * iters;
    let it, p;
    if (lt >= active) {
      if (fill !== 'both' && fill !== 'forwards') return rest;
      it = iters === INF ? 0 : Math.ceil(iters) - 1; p = iters === INF ? 0 : iters - it;
      if (p === 0 || p > 1) p = 1;
    } else { it = Math.floor(lt / D); p = (lt - it * D) / D; }
    const dir = m.direction || 'normal';
    const rev = dir === 'reverse' || (dir === 'alternate' && it % 2 === 1) || (dir === 'alternate-reverse' && it % 2 === 0);
    if (rev) p = 1 - p;
    if (m.easingScope === 'effect' && m.easing) p = ease(m.easing, p);
    if (p <= F[0].offset) return F[0].value;
    for (let j = 1; j < F.length; j++) {
      if (p <= F[j].offset || j === F.length - 1) {
        const a = F[j - 1], b = F[j];
        let u = b.offset === a.offset ? 1 : (p - a.offset) / (b.offset - a.offset);
        u = u < 0 ? 0 : u > 1 ? 1 : u;
        const segEase = a.easing !== undefined && a.easing !== null ? a.easing : (m.easingScope === 'effect' ? null : m.easing);
        if (segEase) u = ease(segEase, u);
        return a.value + (b.value - a.value) * u;
      }
    }
    return F[F.length - 1].value;
  }
  function stepAt(m, t) { return t >= m.atMs ? m.after : m.before; }
  function ticksAt(m, t) {
    const lt = t - m.startMs, n = m.values.length;
    if (lt < 0) return m.values[0];
    const i = Math.floor(lt / m.periodMs);
    if (m.iterations != null && i >= m.iterations * n) return m.values[(m.iterations * n - 1) % n];
    return m.values[i % n];
  }

  // -------------------------------------------------------------------------------------------------------- springs
  /** Integrator ids -> behaviour. h / cap in ms. The page and the fitter's hypotheses share these definitions (S3 3.2). */
  const INTEGRATORS = {
    i6: { kind: 'analytic', label: 'closed form evaluated at the frame time' },
    i1: { kind: 'sie-sub', label: 'semi-implicit Euler, fixed substep h with remainder' },
    i7: { kind: 'sie-cap', cap: 1000 / 30, label: 'semi-implicit Euler, one step of min(dt, cap)' },
    i5: { kind: 'rk4', label: 'classic RK4, one step per frame' },
    i4: { kind: 'frame-unit', cap: 1000 / 30, label: 'frame-unit Euler on position history (native kf, cf per 60 Hz frame)' },
    verlet: { kind: 'verlet', label: 'velocity Verlet, one step per frame' },
  };
  /** Canonical integrator spec from any of: 'i1h16', 'I1(16)', 'i6', {id:'i1', h:2}. */
  function integratorOf(x) {
    if (x && typeof x === 'object') return { id: x.id, h: x.h, cap: x.cap };
    const s = String(x).toLowerCase();
    let m = /^i1h(\d+(?:\.\d+)?)$/.exec(s) || /^i1\((\d+(?:\.\d+)?)\)$/.exec(s);
    if (m) return { id: 'i1', h: +m[1] };
    if (INTEGRATORS[s]) return { id: s };
    throw new Error('unknown integrator ' + x);
  }
  /** Closed-form state of x'' = -k (x - g) - c x' after tau seconds from (x0, v0 per s). */
  function analyticState(k, c, x0, v0, g, tau) {
    const w = Math.sqrt(k), z = c / (2 * w), d = x0 - g;
    if (tau <= 0) return [x0, v0];
    if (Math.abs(z - 1) < 1e-9) { const e = Math.exp(-w * tau); return [g + e * (d + (v0 + w * d) * tau), e * (v0 - w * (v0 + w * d) * tau)]; }
    if (z < 1) {
      const wd = w * Math.sqrt(1 - z * z), a = z * w, e = Math.exp(-a * tau), B = (v0 + a * d) / wd, cs = Math.cos(wd * tau), sn = Math.sin(wd * tau);
      return [g + e * (d * cs + B * sn), e * (-a * (d * cs + B * sn) + (-d * wd * sn + B * wd * cs))];
    }
    const r = w * Math.sqrt(z * z - 1), s1 = -w * z + r, s2 = -w * z - r, q2 = (v0 - s1 * d) / (s2 - s1), q1 = d - q2, e1 = Math.exp(s1 * tau), e2 = Math.exp(s2 * tau);
    return [g + q1 * e1 + q2 * e2, q1 * s1 * e1 + q2 * s2 * e2];
  }

  /**
   * Frame-advanced spring. k, c per s^2 / per s (unit mass); i4 uses kf, cf per 60 Hz frame. Times in ms.
   *   frame(T)  advance to frame time T (T non-decreasing); returns x. Events with e.t <= T are applied first.
   *   clone()   independent copy (for the seek grid and remainder steps)
   * Semantics (fitter simulate + lab TimedSpring): before start.t the value is start.x; a retarget keeps position and
   * velocity (unless the event carries v, px/s); the first frame after start.t integrates dt = T - start.t.
   */
  class SpringSim {
    constructor(m) {
      this.m = m;
      this.I = integratorOf(m.integrator || 'i6');
      this.kind = INTEGRATORS[this.I.id].kind;
      this.h = this.I.h; this.cap = this.I.cap != null ? this.I.cap : INTEGRATORS[this.I.id].cap;
      this.k = (m.k != null ? m.k : 0) / 1e6; this.c = (m.c != null ? m.c : 0) / 1e3;      // per ms^2, per ms
      this.kf = m.kf; this.cf = m.cf;
      this.ev = (m.events || []).slice().sort((a, b) => a.t - b.t);
      this.j = 0;
      const s = m.start || { t: 0, x: 0, v: 0 };
      this.t0 = s.t; this.x = s.x; this.v = (s.v || 0) / 1000; this.xp = s.x - (s.v || 0) / 60; this.last = s.t;
      this.g = m.g0 != null ? m.g0 : s.x;
      this.segT = s.t; this.segX = s.x; this.segV = s.v || 0;          // analytic: current segment start state
      this.snap = m.snap || null;
    }
    clone() { const o = Object.create(SpringSim.prototype); Object.assign(o, this); return o; }
    _retarget(e) {
      if (this.kind === 'analytic') {
        const st = analyticState(this.m.k, this.m.c, this.segX, this.segV, this.g, (e.t - this.segT) / 1000);
        this.segT = e.t; this.segX = st[0]; this.segV = e.v != null ? e.v : st[1]; this.x = st[0]; this.v = this.segV / 1000;
      } else if (e.v != null) { this.v = e.v / 1000; this.xp = this.x - e.v / 60; }
      this.g = e.g;
    }
    frame(T) {
      if (T <= this.t0 + EPS_T) return this.x;
      while (this.j < this.ev.length && this.ev[this.j].t <= T + EPS_T) this._retarget(this.ev[this.j++]);
      if (this.kind === 'analytic') {
        const st = analyticState(this.m.k, this.m.c, this.segX, this.segV, this.g, (T - this.segT) / 1000);
        this.x = st[0]; this.v = st[1] / 1000; this.last = T; return this.x;
      }
      const dt = T - this.last; this.last = T;
      if (!(dt > 0)) return this.x;
      const g = this.g, k = this.k, c = this.c;
      if (this.kind === 'sie-sub') { let o = dt; while (o > 1e-9) { const s = Math.min(o, this.h); this.v += (-k * (this.x - g) - c * this.v) * s; this.x += this.v * s; o -= s; } }
      else if (this.kind === 'sie-cap') { const s = Math.min(dt, this.cap); this.v += (-k * (this.x - g) - c * this.v) * s; this.x += this.v * s; }
      else if (this.kind === 'rk4') {
        const a = (xx, vv) => -k * (xx - g) - c * vv, s = dt, x = this.x, v = this.v;
        const k1x = v, k1v = a(x, v), k2x = v + 0.5 * s * k1v, k2v = a(x + 0.5 * s * k1x, v + 0.5 * s * k1v);
        const k3x = v + 0.5 * s * k2v, k3v = a(x + 0.5 * s * k2x, v + 0.5 * s * k2v), k4x = v + s * k3v, k4v = a(x + s * k3x, v + s * k3v);
        this.x += (s / 6) * (k1x + 2 * k2x + 2 * k3x + k4x); this.v += (s / 6) * (k1v + 2 * k2v + 2 * k3v + k4v);
      } else if (this.kind === 'verlet') {
        const a0 = -k * (this.x - g) - c * this.v, xn = this.x + this.v * dt + 0.5 * a0 * dt * dt, vp = this.v + a0 * dt, a1 = -k * (xn - g) - c * vp;
        this.v += 0.5 * (a0 + a1) * dt; this.x = xn;
      } else if (this.kind === 'frame-unit') {
        const u = (Math.min(dt, this.cap) * 60) / 1000, vel = (this.x - this.xp) / u, acc = this.kf * (g - this.x) - this.cf * vel, xn = this.x + (vel + acc) * u;
        this.xp = this.x; this.x = xn; this.v = (this.x - this.xp) / u * 60 / 1000;
      }
      const sn = this.snap;
      if (sn && Math.abs(this.x - g) < sn.x && Math.abs(this.v * 1000) < sn.v) { this.x = g; this.v = 0; this.xp = g; }
      return this.x;
    }
  }

  // ----------------------------------------------------------------------------------------------------- friction
  /** Inertia coast. v0 in value per 60 Hz frame; law 'frame': v *= f; x += v. law 'dt': s = 60 dt; v *= f^s; x += v s. */
  class FrictionSim {
    constructor(m) { this.m = m; this.x = m.x0; this.v = m.v0; this.done = false; this.last = m.startMs; this.stopV = m.stopV != null ? m.stopV : 0.05; }
    clone() { const o = Object.create(FrictionSim.prototype); Object.assign(o, this); return o; }
    frame(T) {
      if (T <= this.m.startMs + EPS_T || this.done) return this.x;
      const dt = T - this.last; this.last = T;
      const s = this.m.law === 'dt' ? (60 * dt) / 1000 : 1;
      this.v *= this.m.law === 'dt' ? Math.pow(this.m.friction, s) : this.m.friction;
      if (Math.abs(this.v) < this.stopV) { this.v = 0; this.done = true; } else this.x += this.v * s;
      return this.x;
    }
  }

  const isFrameBased = (m) => m.kind === 'spring' || m.kind === 'friction';
  const makeSim = (m) => (m.kind === 'spring' ? new SpringSim(m) : new FrictionSim(m));
  /** Values at an explicit ascending frame-time list (the frames a real take had, stalls included). */
  function series(m, times) {
    if (!isFrameBased(m)) return times.map((t) => stateless(m, t));
    const sim = makeSim(m); return times.map((t) => sim.frame(t));
  }
  const gridCache = new WeakMap();
  /** Snapshots of the sim at every nominal frame k*frameMs, k = 0..n (grown on demand). */
  function gridOf(m, frameMs) {
    let e = gridCache.get(m);
    if (!e || e.frameMs !== frameMs) { e = { frameMs, snaps: [makeSim(m)] }; e.snaps[0].frame(0); e.xs = [e.snaps[0].x]; gridCache.set(m, e); }
    return e;
  }
  function gridValue(m, t, frameMs) {
    if (t <= 0) return makeSim(m).frame(t <= 0 ? 0 : t);
    const e = gridOf(m, frameMs);
    const kf = Math.floor(t / frameMs + 1e-9);
    while (e.snaps.length <= kf) { const s = e.snaps[e.snaps.length - 1].clone(); s.frame(e.snaps.length * frameMs); e.snaps.push(s); e.xs.push(s.x); }
    const rem = t - kf * frameMs;
    if (rem < 1e-6) return e.xs[kf];
    const s = e.snaps[kf].clone(); return s.frame(t);
  }
  function stateless(m, t) {
    switch (m.kind) {
      case 'tween': return tweenAt(m, t);
      case 'chain': return chainAt(m, t);
      case 'keyframes': return keyframesAt(m, t);
      case 'step': return stepAt(m, t);
      case 'ticks': return ticksAt(m, t);
      default: throw new Error('not a stateless motion: ' + m.kind);
    }
  }
  /** Deterministic seek value: a pure function of (motion, t, frameMs). */
  function valueAt(m, t, o) {
    const frameMs = (o && o.frameMs) || 1000 / 120;
    if (m.kind === 'spring') {
      if (INTEGRATORS[integratorOf(m.integrator || 'i6').id].kind === 'analytic') { const s = new SpringSim(m); return s.frame(t); }
      return gridValue(m, t, frameMs);
    }
    if (m.kind === 'friction') return gridValue(m, t, frameMs);
    return stateless(m, t);
  }

  // ------------------------------------------------------------------------------------------------------- extents
  /** Time at which a frame-based motion has settled (|x - g| and |v| below tol for 250 ms), capped; for stateless: the end. */
  function endOf(m, o) {
    const frameMs = (o && o.frameMs) || 1000 / 120, cap = (o && o.capMs) || 15000;
    switch (m.kind) {
      case 'tween': return m.startMs + m.durationMs;
      case 'chain': return Math.max(...m.parts.map((p) => p.startMs + p.durationMs));
      case 'keyframes': return m.startMs + m.durationMs * (m.iterations == null ? 1 : m.iterations === INF ? (o && o.loopPreview) || 3 : m.iterations);
      case 'step': return m.atMs;
      case 'ticks': return m.startMs + m.periodMs * m.values.length * (m.iterations == null ? 1 : m.iterations === INF ? (o && o.loopPreview) || 3 : m.iterations);
      case 'spring': {
        const lastEv = Math.max(m.start ? m.start.t : 0, ...(m.events || []).map((e) => e.t));
        const sim = new SpringSim(m);
        const tol = (o && o.tol) || 1e-3 * Math.max(1, Math.abs((m.events && m.events.length ? m.events[m.events.length - 1].g : m.g0) - (m.start ? m.start.x : 0))), win = Math.ceil(250 / frameMs);
        let calm = 0, T = 0;
        for (let k = 0; T < cap; k++) {
          T = k * frameMs; const x = sim.frame(T);
          if (T < lastEv) { calm = 0; continue; }
          const g = sim.g;
          if (Math.abs(x - g) < tol && Math.abs(sim.v * 1000) < tol * 5) calm++; else calm = 0;
          if (calm >= win) return T - (win - 1) * frameMs;
        }
        return cap;
      }
      case 'friction': {
        const sim = new FrictionSim(m);
        for (let T = m.startMs, k = 0; T < m.startMs + cap; k++) { T = m.startMs + k * frameMs; sim.frame(T); if (sim.done) return T; }
        return m.startMs + cap;
      }
      default: return 0;
    }
  }
  /** First time the motion leaves its start value (stateless: scan). */
  function startOf(m) {
    switch (m.kind) {
      case 'tween': case 'keyframes': case 'friction': return m.startMs;
      case 'chain': return Math.min(...m.parts.map((p) => p.startMs));
      case 'step': return m.atMs;
      case 'ticks': return m.startMs;
      case 'spring': return m.onsetMs != null ? m.onsetMs : Math.min(m.start ? m.start.t : 0, ...(m.events || []).map((e) => e.t));
      default: return 0;
    }
  }
  /** Rest value (before the motion) of a motion. */
  function restOf(m) {
    switch (m.kind) {
      case 'tween': return m.from;
      case 'chain': return m.parts[0].from;
      case 'keyframes': return m.rest != null ? m.rest : m.frames[0].value;
      case 'step': return m.before;
      case 'ticks': return m.values[0];
      case 'spring': return m.start ? m.start.x : 0;
      case 'friction': return m.x0;
      default: return 0;
    }
  }

  return { easeFn, ease, cssEasing, cubicBezierFn, namedFn, tweenAt, chainAt, keyframesAt, stepAt, ticksAt, SpringSim, FrictionSim,
    INTEGRATORS, integratorOf, analyticState, series, valueAt, endOf, startOf, restOf, isFrameBased, makeSim, KINDS: ['tween', 'chain', 'keyframes', 'spring', 'friction', 'step', 'ticks'] };
}

export const kernelSource = createKernel.toString();
export const K = createKernel();
