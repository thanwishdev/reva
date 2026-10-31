// Fixture Lab group B (springs + inertia): pure math shared by the pages and by refsim.mjs.
// No DOM, no globals except atob/btoa, no imports. The fitter (src/analysis/fit) never imports this file and this file
// never imports the fitter: the recurrences below are the ground truth, the fitter's integrator hypotheses are its own code.
//
// Units: x in px, v in px/s, dt in seconds, times in ms. Canonical spring: x'' = (-k (x - g) - c x') / m.
// Own parameters only (design M2-fitter.md 11): nothing here is copied from a site.

export const r6 = (x) => Math.round(x * 1e6) / 1e6;

// ---------------------------------------------------------------------------------------------------------- params
export const encodeParams = (o) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const decodeParams = (s) => {
  let b = String(s).replace(/-/g, '+').replace(/_/g, '/'); while (b.length % 4) b += '=';
  return JSON.parse(atob(b));
};
/** Page hash is `#p=<base64url JSON>`. */
export const paramsFromHash = (hash) => {
  const m = /[#&]p=([A-Za-z0-9_-]+)/.exec(String(hash || ''));
  return m ? decodeParams(m[1]) : {};
};

/** Written-value quantisation (`write` param; design 11 "Channels"). */
export const quantise = (v, mode) => (mode === 'q3' ? Math.round(v * 1e3) / 1e3 : mode === 'q2' ? Math.round(v * 1e2) / 1e2 : v);

// ------------------------------------------------------------------------------------------------------- integrators
/** Ids -> implementation. `h` in seconds. */
export const INTEGRATORS = {
  i1h16: { kind: 'sie-sub', h: 0.016, label: 'semi-implicit Euler, 16 ms substeps with remainder' },
  i1h2: { kind: 'sie-sub', h: 0.002, label: 'semi-implicit Euler, 2 ms substeps with remainder' },
  i1h1: { kind: 'sie-sub', h: 0.001, label: 'semi-implicit Euler, 1 ms substeps with remainder' },
  i1h5: { kind: 'sie-sub', h: 0.005, label: 'semi-implicit Euler, 5 ms substeps with remainder (out of the fitter set)' },
  i4: { kind: 'frame-unit', cap: 1 / 30, label: 'frame-unit Euler (position history), dt capped at 1/30 s' },
  i5: { kind: 'rk4', label: 'classic RK4, one step per frame' },
  i6: { kind: 'analytic', label: 'closed form evaluated at the frame time' },
  i7: { kind: 'sie-cap', cap: 1 / 30, label: 'semi-implicit Euler, one step of min(dt, 1/30 s)' },
  verlet: { kind: 'verlet', label: 'velocity Verlet, one step per frame (out of the fitter set)' },
};

/** Done rule shared by every discrete variant: snap to the target when slow and close (px, px/s). */
export const SNAP = { x: 0.004, v: 0.04 };

const accel = (P, x, v, g) => (-P.k * (x - g) - P.c * v) / P.m;

/** Canonical (k, c, m) from the params of a route. i4 uses native per-frame (kf, cf) and has no (k, c, m). */
export function canonical(params) {
  if (params.omega0 != null) {          // M08 style: unit mass
    return { k: params.omega0 * params.omega0, c: 2 * params.zeta * params.omega0, m: 1 };
  }
  return { k: params.k, c: params.c, m: params.m ?? 1 };
}

/** Closed form of one segment at tau seconds: x(0) = x0, v(0) = v0, target g. Returns {x, v}. */
export function analyticAt(seg, tauSec) {
  const { x0, v0, g, omega, zeta } = seg;
  const d = x0 - g;
  if (tauSec <= 0) return { x: x0, v: v0 };
  if (Math.abs(zeta - 1) < 1e-9) {
    const e = Math.exp(-omega * tauSec);
    return { x: g + e * (d + (v0 + omega * d) * tauSec), v: e * (v0 - omega * (v0 + omega * d) * tauSec) };
  }
  if (zeta < 1) {
    const wd = omega * Math.sqrt(1 - zeta * zeta), a = zeta * omega, e = Math.exp(-a * tauSec);
    const B = (v0 + a * d) / wd, cs = Math.cos(wd * tauSec), sn = Math.sin(wd * tauSec);
    return { x: g + e * (d * cs + B * sn), v: e * (-a * (d * cs + B * sn) + (-d * wd * sn + B * wd * cs)) };
  }
  const r = omega * Math.sqrt(zeta * zeta - 1), s1 = -omega * zeta + r, s2 = -omega * zeta - r;
  const c2 = (v0 - s1 * d) / (s2 - s1), c1 = d - c2;
  const e1 = Math.exp(s1 * tauSec), e2 = Math.exp(s2 * tauSec);
  return { x: g + c1 * e1 + c2 * e2, v: c1 * s1 * e1 + c2 * s2 * e2 };
}

/**
 * A spring that is retargeted by timers and advanced once per animation frame.
 *   retarget(g, tMs, v?)  : timer callback at its exact due time (v optional px/s velocity override)
 *   frame(dtSec, tMs)     : animation-frame callback at the frame time; returns the written x
 * Discrete variants carry (x, v) across a retarget (velocity continuity); the closed form is re-based on the state at the
 * retarget instant.
 */
export class TimedSpring {
  constructor(params, x0 = 0) {
    this.id = params.integrator || 'i6';
    this.I = INTEGRATORS[this.id];
    if (!this.I) throw new Error('unknown integrator ' + this.id);
    this.native = params.kf != null ? { kf: params.kf, cf: params.cf } : null;
    this.P = this.native ? null : canonical(params);
    this.x = x0; this.v = 0; this.xp = x0; this.g = x0;
    if (this.I.kind === 'analytic') {
      this.seg = { x0, v0: 0, g: x0, t0: 0, omega: Math.sqrt(this.P.k / this.P.m), zeta: this.P.c / (2 * Math.sqrt(this.P.k * this.P.m)) };
    }
    if (this.native && this.I.kind !== 'frame-unit') throw new Error('native (kf, cf) params need integrator i4');
  }
  retarget(g, tMs, v) {
    if (this.I.kind === 'analytic') {
      const s = analyticAt(this.seg, (tMs - this.seg.t0) / 1000);
      this.seg = { ...this.seg, x0: s.x, v0: v != null ? v : s.v, g, t0: tMs };
      this.x = s.x; this.v = v != null ? v : s.v;
    } else if (v != null) { this.v = v; this.xp = this.x - v / 60; }
    this.g = g;
  }
  frame(dtSec, tMs) {
    const I = this.I, g = this.g, P = this.P;
    if (I.kind === 'analytic') {
      const s = analyticAt(this.seg, (tMs - this.seg.t0) / 1000); this.x = s.x; this.v = s.v; return this.x;
    }
    if (I.kind === 'sie-sub') {
      let o = dtSec;
      while (o > 1e-9) { const q = Math.min(o, I.h); this.v += accel(P, this.x, this.v, g) * q; this.x += this.v * q; o -= q; }
    } else if (I.kind === 'sie-cap') {
      const q = Math.min(dtSec, I.cap); this.v += accel(P, this.x, this.v, g) * q; this.x += this.v * q;
    } else if (I.kind === 'rk4') {
      const h = dtSec, f = (x, v) => accel(P, x, v, g);
      const k1x = this.v, k1v = f(this.x, this.v);
      const k2x = this.v + 0.5 * h * k1v, k2v = f(this.x + 0.5 * h * k1x, this.v + 0.5 * h * k1v);
      const k3x = this.v + 0.5 * h * k2v, k3v = f(this.x + 0.5 * h * k2x, this.v + 0.5 * h * k2v);
      const k4x = this.v + h * k3v, k4v = f(this.x + h * k3x, this.v + h * k3v);
      this.x += (h / 6) * (k1x + 2 * k2x + 2 * k3x + k4x); this.v += (h / 6) * (k1v + 2 * k2v + 2 * k3v + k4v);
    } else if (I.kind === 'verlet') {
      const h = dtSec, a0 = accel(P, this.x, this.v, g);
      const xn = this.x + this.v * h + 0.5 * a0 * h * h;
      const vp = this.v + a0 * h, a1 = accel(P, xn, vp, g);
      this.v += 0.5 * (a0 + a1) * h; this.x = xn;
    } else if (I.kind === 'frame-unit') {
      const u = Math.min(dtSec, I.cap) * 60;
      const vel = (this.x - this.xp) / u;
      const acc = this.native.kf * (g - this.x) - this.native.cf * vel;
      const xn = this.x + (vel + acc) * u;
      this.xp = this.x; this.x = xn; this.v = (this.x - this.xp) / u * 60;
    }
    if (Math.abs(this.x - g) < SNAP.x && Math.abs(this.v) < SNAP.v) { this.x = g; this.v = 0; this.xp = g; }
    return this.x;
  }
}

// ----------------------------------------------------------------------------------------------------------- inertia
export const INERTIA_STOP = 0.05;   // px per 60 Hz frame
/**
 * Drag then coast. Pointer samples arrive from timers/events (down/move/up with the handler's own performance.now());
 * the release velocity is read from the samples of the last 100 ms. Coast law:
 *   'frame': v *= f; x += v                      (v in px per frame)
 *   'dt'   : s = 60 dt; v *= f^s; x += v s       (v in px per 60 Hz frame)
 * stop when |v| < INERTIA_STOP (the final sub-threshold step is not applied).
 */
export class Inertia {
  constructor(params, x0) {
    this.f = params.friction; this.law = params.law === 'dt' ? 'dt' : 'frame';
    this.x = x0; this.v = 0; this.mode = 'idle'; this.ptr = 0; this.grab = 0; this.samples = [];
    this.release = null;
  }
  down(px, tMs) { this.mode = 'drag'; this.ptr = px; this.grab = this.x - px; this.samples = [{ t: tMs, x: px }]; this.v = 0; }
  move(px, tMs) { if (this.mode !== 'drag') return; this.ptr = px; this.samples.push({ t: tMs, x: px }); if (this.samples.length > 400) this.samples.shift(); }
  up(tMs) {
    if (this.mode !== 'drag') return;
    const w = this.samples.filter(s => s.t >= tMs - 100);
    let vms = 0;
    if (w.length >= 2) { const a = w[0], b = w[w.length - 1]; if (b.t > a.t) vms = (b.x - a.x) / (b.t - a.t); }
    this.v = vms * (1000 / 60);
    this.release = { t: tMs, x: this.x, vms, vFrame: this.v };
    this.mode = Math.abs(this.v) < INERTIA_STOP ? 'done' : 'coast';
    if (this.mode === 'done') this.v = 0;
  }
  frame(dtSec) {
    if (this.mode === 'drag') this.x = this.ptr + this.grab;
    else if (this.mode === 'coast') {
      const s = this.law === 'dt' ? 60 * dtSec : 1;
      this.v *= this.law === 'dt' ? Math.pow(this.f, s) : this.f;
      if (Math.abs(this.v) < INERTIA_STOP) { this.v = 0; this.mode = 'done'; } else this.x += this.v * s;
    }
    return this.x;
  }
}

// --------------------------------------------------------------------------------------------------------- schedules
// Times are ms after the page's first animation-frame callback (the anchor); the first event is always at >= 500 ms.
// `level` is a fraction of the amplitude A; `v` (optional) is an initial velocity in amplitude fractions per second.
export const SCHEDULES = {
  p1000: [{ t: 500, level: 1 }, { t: 1500, level: 0 }, { t: 2500, level: 1 }],
  p400: [{ t: 500, level: 1 }, { t: 900, level: 0 }, { t: 1300, level: 1 }, { t: 1700, level: 0 }, { t: 2100, level: 1 }, { t: 2500, level: 0 }],
  rest: [{ t: 500, level: 1 }],
  retarget: [{ t: 500, level: 1 }, { t: 1000, level: 0.3 }],
  v0: [{ t: 500, level: 1, v: -2.5 }],
};

/** Pointer scripts: down at `down.t`, moves every `step` ms along the line, up at `up`. Positions are viewport clientX. */
export const POINTER_SCRIPTS = {
  fast: { downT: 500, x0: 160, speed: 0.6, moveFromT: 510, moveToT: 900, step: 10, upT: 905 },
  slow: { downT: 500, x0: 160, speed: 0.25, moveFromT: 510, moveToT: 900, step: 10, upT: 905 },
  still: { downT: 500, x0: 160, speed: 0.5, moveFromT: 510, moveToT: 800, step: 10, upT: 1100 },
};
/** Expand a pointer script into ordered events [{t, type, x}] (t ms after the anchor). */
export function pointerEvents(name) {
  const s = POINTER_SCRIPTS[name]; if (!s) throw new Error('unknown pointer script ' + name);
  const ev = [{ t: s.downT, type: 'down', x: s.x0 }];
  for (let t = s.moveFromT; t <= s.moveToT; t += s.step) ev.push({ t, type: 'move', x: s.x0 + s.speed * (t - s.downT) });
  ev.push({ t: s.upT, type: 'up', x: s.x0 + s.speed * (Math.min(s.moveToT, s.upT) - s.downT) });
  return ev;
}

export const BOX_X0 = 120;   // inertia box start (px), pointer grabs at BOX_X0 + 40
export const AMPLITUDE = 200;
