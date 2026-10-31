// Reference simulator for Fixture Lab group D (design §11). Pure functions, no browser.
//
//   simulate(routeId, params, ctx) -> { channels: { "<selector>|<channel>": (number|null)[] per ctx frame }, events }
//
// ctx is built from the ACTUAL take:
//   frames  [{k, T, sy, sx}]  recorder rows, consecutive in k from the page's start signal onward (R6 callers pass the
//                             undropped R2 rows: the page ran on every frame, the dropped rows only hide samples)
//   inputs  recorder inputLog entries: {type:'scrollTo', k, T, got}, optional {type:'pointer', k, T, x, y}
//   marks   take.marks: {name, k, T}. The start signal is the mark "go"; until the recorder has S.pointer (X3),
//           pointer events are the marks "ptr:<x>,<y>" (same k/T as an inputLog entry would carry)
//   dateEpoch  take.cfg.dateEpoch (orbit variant: Date.now() = dateEpoch + T on the virtual clock)
//
// It reproduces the `hx` semantics of src/record/inpage.js (design §11, DECISIONS A1.6 g):
//   - an input given after frame k is handled at virtual time T_k; the page's frame callback k+1 sees its effect
//   - timers fire at their exact due time, before the frame whose T is >= the due time
//   - frame callbacks of frame k see now = T_k and scrollY as sampled in row k
//   - a CSS transition created by a frame callback starts at T_k (local time 0 at that frame, first visible at k+1)
// Independence: this file never imports src/ (and src/analysis/fit never imports this folder).
import {
  parseParams, quant, clamp, followStep, mulberry32, slewStep, springConsts, springI7, springI1, cameraTarget, lerp1,
  CAM, projectViewport, easeOutQuart, expoOut, tweenAt, cubicBezier,
} from './core.js';

export const DEFAULT_DATE_EPOCH = Date.UTC(2026, 9, 14, 9, 0, 0);
const IO_Y = 1500, IO_H = 200, VH = 800;                    // sentinel block of the attribution page
const r6 = (x) => Math.round(x * 1e6) / 1e6;

/** Normalise ctx: find the start signal, the pointer events and the scroll events. */
function prep(ctx) {
  const frames = ctx.frames;
  const go = (ctx.marks || []).find((m) => m.name === 'go');
  if (!go) throw new Error('refsim: ctx.marks has no "go" mark (the start signal)');
  const pointer = [];
  for (const m of ctx.marks || []) {
    const r = /^ptr:(-?[\d.]+),(-?[\d.]+)$/.exec(m.name);
    if (r) pointer.push({ k: m.k, T: m.T, x: +r[1], y: +r[2] });
  }
  for (const e of ctx.inputs || []) if (e.type === 'pointer') pointer.push({ k: e.k, T: e.T, x: e.x, y: e.y });
  pointer.sort((a, b) => a.k - b.k || a.T - b.T);
  const scrolls = (ctx.inputs || []).filter((e) => e.type === 'scrollTo').map((e) => ({ k: e.k, T: e.T, y: e.got })).sort((a, b) => a.k - b.k);
  let prev = null;
  for (const f of frames) {
    if (f.k <= go.k) continue;
    if (prev != null && f.k !== prev + 1) throw new Error(`refsim: frames after the start signal must be consecutive (k ${prev} -> ${f.k})`);
    prev = f.k;
  }
  return { frames, go, pointer, scrolls, epoch: ctx.dateEpoch ?? DEFAULT_DATE_EPOCH };
}

/** Frame loop helper: calls fn(frame, index) for frames after the start signal; returns nothing. */
function eachFrame(c, fn) {
  for (let i = 0; i < c.frames.length; i++) if (c.frames[i].k > c.go.k) fn(c.frames[i], i);
}
const col = (n, v = null) => new Array(n).fill(v);

const SIMS = {
  m13(P, c) {
    const n = c.frames.length, X = col(n), Y = col(n), RX = col(n, 0), RY = col(n, 0);
    const s = { x: 0, y: 0 }, g = { x: 0, y: 0 }; let last = c.go.T, pi = 0;
    eachFrame(c, (f, i) => {
      while (pi < c.pointer.length && c.pointer[pi].k <= f.k - 1) { g.x = c.pointer[pi].x; g.y = c.pointer[pi].y; pi++; }
      const dt = f.T - last; last = f.T;
      followStep(s, g, P, dt);
      X[i] = quant(s.x, P.write); Y[i] = quant(s.y, P.write); RX[i] = X[i]; RY[i] = Y[i];
    });
    return { '.b0|drv:--x': X, '.b0|drv:--y': Y, '.b0|ren:tx': RX, '.b0|ren:ty': RY };
  },

  m14(P, c, withGl = true) {
    const n = c.frames.length, A = col(n, 0), out = { 'gl:u_a': A };
    for (const key of ['m', 'n']) { out[`pix:${key}:x`] = col(n); out[`pix:${key}:y`] = col(n); }
    const sp = springConsts(P.zeta, P.lag), s = { x: 0, v: 0 }; let last = c.go.T;
    const put = (i, angle) => {
      A[i] = angle;
      for (const [key, m] of Object.entries(CAM.markers)) { const p = projectViewport(m.pos, angle); out[`pix:${key}:x`][i] = p.x; out[`pix:${key}:y`][i] = p.y; }
    };
    for (let i = 0; i < n; i++) if (c.frames[i].k <= c.go.k) put(i, 0);          // the page draws angle 0 once at load
    eachFrame(c, (f, i) => {
      const dt = f.T - last; last = f.T;
      let angle;
      if (P.mode === 'orbit') angle = (c.epoch + f.T - (c.epoch + c.go.T)) * P.orbitRate;
      else {
        const g = cameraTarget(P, f.sy);
        springI7(s, g, sp.k, sp.c, dt, P.capMs);
        if (Math.abs(s.v) < P.snapV && Math.abs(s.x - g) < P.snapX) { s.x = g; s.v = 0; }
        angle = s.x;
      }
      put(i, angle);
    });
    if (!withGl) delete out['gl:u_a'];
    return out;
  },
  m14b(P, c) { return SIMS.m14(P, c, false); },

  m16a(P, c) {
    const n = c.frames.length, o = {};
    for (const k of ['.b0|drv:--x', '.b0|drv:--y', '.b0|drv:--o', '.b1|drv:--x']) o[k] = col(n);
    o['.b0|ren:tx'] = col(n, 0); o['.b0|ren:ty'] = col(n, 0); o['.b0|ren:opacity'] = col(n, 1); o['.b1|ren:tx'] = col(n, 0);
    for (let i = 0; i < n; i++) if (c.frames[i].k > c.go.k) {
      o['.b0|drv:--x'][i] = P.x; o['.b0|drv:--y'][i] = P.y; o['.b0|drv:--o'][i] = P.opacity; o['.b1|drv:--x'][i] = P.x * 2;
      o['.b0|ren:tx'][i] = P.x; o['.b0|ren:ty'][i] = P.y; o['.b0|ren:opacity'][i] = P.opacity; o['.b1|ren:tx'][i] = P.x * 2;
    }
    return o;
  },

  m16b(P, c) {
    const n = c.frames.length, X = col(n), R = col(n, 0), rand = mulberry32(P.seed);
    eachFrame(c, (f, i) => { X[i] = P.base + P.amp * (2 * rand() - 1); R[i] = X[i]; });
    return { '.b0|drv:--x': X, '.b0|ren:tx': R };
  },

  m16c(P, c) {
    const n = c.frames.length, X = col(n), R = col(n, 0); let x = 0, last = c.go.T;
    eachFrame(c, (f, i) => {
      const dt = f.T - last; last = f.T;
      x = slewStep(x, clamp(f.sy, 0, P.max) * P.gain, P.speed, dt);
      X[i] = x; R[i] = x;
    });
    return { '.b0|drv:--x': X, '.b0|ren:tx': R };
  },

  m16d(P, c) {
    const n = c.frames.length, X = col(n), R = col(n, 0); let pending = 0;
    eachFrame(c, (f, i) => {
      X[i] = pending; R[i] = pending;
      pending = f.sy > P.threshold ? P.amp : 0;
    });
    return { '.b0|drv:--x': X, '.b0|ren:tx': R };
  },

  m21(P, c) {
    const n = c.frames.length, V = col(n), R = col(n, 0), events = [];
    const tw = { from: 0, to: 0, t0: c.go.T, dur: P.durMs, ease: expoOut }; let si = 0, prevY = 0;
    eachFrame(c, (f, i) => {
      while (si < c.scrolls.length && c.scrolls[si].k <= f.k - 1) {
        const e = c.scrolls[si++];
        if (e.y === prevY) continue;                              // no scroll event when the position did not change
        prevY = e.y;
        const to = clamp(e.y, 0, P.max) * P.gain;
        if (to === tw.to) continue;
        tw.from = tweenAt(tw, e.T); tw.to = to; tw.t0 = e.T;
        events.push({ type: 'tween-restart', k: e.k, T: e.T, from: tw.from, to });
      }
      const v = tweenAt(tw, f.T);
      V[i] = quant(v, P.write); R[i] = V[i];
    });
    return { channels: { '.b0|drv:--v': V, '.b0|ren:tx': R }, events };
  },

  m22(P, c) {
    const n = c.frames.length, D = col(n), R = col(n, 0), events = [];
    const ease = cubicBezier(...P.ease);
    let chain = { from: 0, to: 0, t0: 0 }, d = 0;
    const val = (T) => (chain.to === chain.from ? chain.to : chain.from + (chain.to - chain.from) * ease(clamp((T - chain.t0) / P.durMs, 0, 1)));
    eachFrame(c, (f, i) => {
      const r = val(f.T);                                         // the value on screen at T_k (before this frame's write)
      const g = clamp(f.sy, 0, P.max) * P.gain;
      d = lerp1(d, g, P.alpha);
      if (Math.abs(g - d) < P.snap) d = g;
      const w = quant(d, P.write);
      D[i] = w; R[i] = r;
      if (w !== chain.to) { chain = { from: r, to: w, t0: f.T }; events.push({ type: 'transition-start', k: f.k, T: f.T, from: r, to: w }); }
    });
    return { channels: { '.b0|drv:--d': D, '.b0|ren:tx': R }, events };
  },

  m20(P, c) {
    const n = c.frames.length, out = {};
    for (const k of ['.e0|drv:--q', '.e1|drv:--s', '.e2|drv:--w', '.e3|drv:--z']) out[k] = col(n);
    out['.e0|ren:tx'] = col(n, 0); out['.e1|ren:tx'] = col(n, 0); out['.e2|ren:opacity'] = col(n, 0.35); out['.e3|ren:tx'] = col(n, 0);
    const events = [];
    const s0 = { x: 0, v: 0 }; let q = 0, g1 = 0, tick = 0, last = c.go.T, si = 0, inView = false;
    const tw = { from: 0, to: 0, t0: 0, dur: P.tweenMs, ease: easeOutQuart };
    // timers created by the start signal handler: setInterval(.., 1000) and setTimeout(offset) -> setInterval(.., 1000)
    let dueSpring = r6(c.go.T + 1000), dueTick = r6(r6(c.go.T + P.tickOffsetMs) + 1000);
    eachFrame(c, (f, i) => {
      // inputs given after the previous frame: scroll position -> observer callback at the input's virtual time
      while (si < c.scrolls.length && c.scrolls[si].k <= f.k - 1) {
        const e = c.scrolls[si++];
        const now = e.y + VH > IO_Y && e.y < IO_Y + IO_H;
        if (now !== inView) {
          inView = now; tw.from = tweenAt(tw, e.T); tw.to = inView ? P.tweenAmp : 0; tw.t0 = e.T;
          events.push({ type: 'observer', k: e.k, T: e.T, inView });
        }
      }
      // timers due at or before this frame's time, in due order, each at its exact due time
      for (;;) {
        const nx = Math.min(dueSpring, dueTick);
        if (nx > f.T) break;
        if (dueSpring <= dueTick) { g1 = g1 === 0 ? P.amp1 : 0; events.push({ type: 'retarget', T: dueSpring, to: g1 }); dueSpring = r6(dueSpring + 1000); }
        else { tick++; events.push({ type: 'tick', T: dueTick, n: tick }); dueTick = r6(dueTick + 1000); }
      }
      const dt = f.T - last; last = f.T;
      const g0 = clamp(f.sy, 0, P.scrollMax) * P.scrollGain;
      q = lerp1(q, g0, P.alpha);
      if (Math.abs(g0 - q) < P.snap) q = g0;
      springI1(s0, g1, P.k, P.c, dt, P.hMs);
      if (Math.abs(s0.v) < 0.01 && Math.abs(s0.x - g1) < 0.001) { s0.x = g1; s0.v = 0; }
      const z = tweenAt(tw, f.T);
      out['.e0|drv:--q'][i] = quant(q, P.write); out['.e0|ren:tx'][i] = out['.e0|drv:--q'][i];
      out['.e1|drv:--s'][i] = quant(s0.x, P.write); out['.e1|ren:tx'][i] = out['.e1|drv:--s'][i];
      out['.e3|drv:--z'][i] = quant(z, P.write); out['.e3|ren:tx'][i] = out['.e3|drv:--z'][i];
      // the tick state persists between frames: fill from the running counter
      out['.e2|drv:--w'][i] = tick === 0 ? null : tick % 2;
      out['.e2|ren:opacity'][i] = 0.35 + 0.65 * (tick % 2);
    });
    return { channels: out, events };
  },
};

/** The values the page writes (drv:) and the expected rendered values (ren:, gl:, pix:) on the take's own frames. */
export function simulate(routeId, params, ctx) {
  if (!SIMS[routeId]) throw new Error(`refsim: unknown route ${routeId}`);
  const P = parseParams(routeId, params);
  const c = prep(ctx);
  const r = SIMS[routeId](P, c);
  return r.channels ? { channels: r.channels, events: r.events || [] } : { channels: r, events: [] };
}

export const ROUTE_IDS = Object.keys(SIMS);
