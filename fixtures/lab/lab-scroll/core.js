// Fixture Lab, group C (scroll): pure math shared by the pages and refsim.
// No DOM, no globals, no imports: every function here is a plain function of its arguments, so the page (browser) and
// refsim.mjs (Node) run the very same recurrences. What the browser adds (layout, calc() mapping, serialisation) is
// what the parity test checks against the `render*` functions below.
// All parameter values are the lab's own (docs/design/M2-fitter.md section 11): none comes from a frozen site build.

export const VW = 1280;
export const VH = 800;

// ---------------------------------------------------------------- params in the URL hash (#p=<base64url JSON>)
export function encodeParams(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let bin = ''; for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function decodeParams(hash) {
  const m = /(?:^#|&)p=([A-Za-z0-9_-]+)/.exec(String(hash || ''));
  if (!m) return {};
  const b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))));
}

// ---------------------------------------------------------------- scalar maths
export const clamp = (lo, x, hi) => Math.min(hi, Math.max(lo, x));
export const clamp01 = (x) => clamp(0, x, 1);
export const smoothstep = (u) => u * u * (3 - 2 * u);
export const easeInOutCubic = (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
export const easeOutCubic = (u) => 1 - Math.pow(1 - u, 3);
export const lerp = (a, b, t) => a + (b - a) * t;

/** Text written to the DOM. mode: 'full' (shortest round-trip double), 'q3' / 'q2' (toFixed 3 / 2 decimals). */
export function fmt(x, mode = 'full') {
  if (mode === 'q3') return x.toFixed(3);
  if (mode === 'q2') return x.toFixed(2);
  return String(x);
}
/** The number a reader gets back from the written text. */
export const written = (x, mode = 'full') => parseFloat(fmt(x, mode));

/** Per-frame exponential smoothing with a snap: the recurrence every EMA route uses. */
export function emaStep(cur, target, alpha, snap) {
  const d = target - cur;
  return Math.abs(d) < snap ? target : cur + alpha * d;
}
/** Snap on rise, ease on fall. */
export function asymStep(cur, target, alphaDown, snap) {
  return target > cur ? target : emaStep(cur, target, alphaDown, snap);
}

// ---------------------------------------------------------------- M01: linear scroll map, no smoothing
export const M01 = {
  defaults: { o: 120, h: 0.85 },
  TOP: 'runway marker at document y = o; p = 1 - clamp(-top, 0, H) / H, H = h * VH',
  frame(p, top) {
    const H = p.h * VH;
    return { p: 1 - clamp(0, -top, H) / H };
  },
  range(p) { return { s0: p.o, s1: p.o + p.h * VH }; },
  // what the stylesheet maps --p to (calc() in the page): translate, opacity
  render(pw) { return { tx: pw * 420, ty: pw * -150, opacity: 0.2 + pw * 0.8 }; },
};

// ---------------------------------------------------------------- M02: smoothstep target + per-frame EMA, settle tail
export const M02 = {
  defaults: { alpha: 0.18, snap: 1e-3, b0: 0.85, b1: 0.25, write: 'full' },
  BOTTOM: 1500,   // document y of the observed block's bottom edge
  init() { return { cur: 0 }; },
  target(p, bottom) { return smoothstep(clamp01((p.b0 - bottom / VH) / (p.b0 - p.b1))); },
  frame(st, p, bottom) {
    const target = M02.target(p, bottom);
    st.cur = emaStep(st.cur, target, p.alpha, p.snap);
    return { target, cur: st.cur, e: written(st.cur, p.write) };
  },
  range(p) { return { s0: M02.BOTTOM - p.b0 * VH, s1: M02.BOTTOM - p.b1 * VH }; },
  render(ew) { return { ty: ew * -260, s: 1 - ew * 0.22, opacity: 1 - ew * 0.6 }; },
};

// ---------------------------------------------------------------- M03: asymmetric snap/ease, p = max(enter, exit)
export const M03 = {
  defaults: { aDown: 0.25, aExit: 0.18, snap: 1e-3, enter: [0.5, 0.1], exit: [0.95, 0.55], write: 'full' },
  BOTTOM_A: 2500,   // enter block: bottom edge, document y
  BOTTOM_B: 1400,   // exit block
  init() { return { a: 0, b: 1 }; },
  targets(p, botA, botB) {
    const ue = clamp01((p.enter[0] - botA / VH) / (p.enter[0] - p.enter[1]));
    const ux = clamp01((p.exit[0] - botB / VH) / (p.exit[0] - p.exit[1]));
    return { ta: smoothstep(ue), tb: 1 - smoothstep(ux) };
  },
  frame(st, p, botA, botB) {
    const { ta, tb } = M03.targets(p, botA, botB);
    st.a = asymStep(st.a, ta, p.aDown, p.snap);
    st.b = emaStep(st.b, tb, p.aExit, p.snap);
    const m = Math.max(st.a, st.b);
    return { ta, tb, a: written(st.a, p.write), b: written(st.b, p.write), p: written(m, p.write) };
  },
  enterRange(p) { return { s0: M03.BOTTOM_A - p.enter[0] * VH, s1: M03.BOTTOM_A - p.enter[1] * VH }; },
  exitRange(p) { return { s0: M03.BOTTOM_B - p.exit[0] * VH, s1: M03.BOTTOM_B - p.exit[1] * VH }; },
  render(pw) { return { opacity: 0.15 + pw * 0.85, s: 0.9 + pw * 0.1 }; },
};

// ---------------------------------------------------------------- M04: pinned scrub (ease in-out cubic) + EMA + hysteresis index
export const M04 = {
  defaults: { alpha: 0.15, snap: 1e-3, h: 1.18, scrub: 1.3, tabs: 0.3, n: 5, hy: 0.3, ty0: 60, ox0: 18 },
  RY: 400,   // document y of the runway top
  geom(p) {
    const S = p.scrub * VH, T = (p.n - 1) * p.tabs * VH;
    return { S, T, tabUnit: p.tabs * VH, runway: VH + S + T, pinStart: M04.RY, pinEnd: M04.RY + S + T };
  },
  init() { return { es: 0, i: 0 }; },
  frame(st, p, top) {
    const g = M04.geom(p);
    const sp = clamp(0, -top, g.S + g.T);
    const e = easeInOutCubic(clamp01(sp / g.S));
    st.es = emaStep(st.es, e, p.alpha, p.snap);
    const tp = clamp(0, (sp - g.S) / g.tabUnit, p.n - 1);
    while (st.i < p.n - 1 && tp >= st.i + 0.5 + p.hy) st.i++;
    while (st.i > 0 && tp <= st.i - 0.5 - p.hy) st.i--;
    const s = p.h + (1 - p.h) * st.es, y = p.ty0 * (1 - st.es), o = p.ox0 + (50 - p.ox0) * st.es;
    return { e, es: st.es, tp, i: st.i, s: parseFloat(s.toFixed(3)), y: parseFloat(y.toFixed(2)), o: parseFloat(o.toFixed(2)),
      sText: s.toFixed(3), yText: y.toFixed(2), oText: o.toFixed(2) };
  },
  /** hysteresis edges in tab units: switching i -> i+1 upward / (i+1) -> i downward */
  edges(p) {
    const up = [], down = [];
    for (let i = 0; i < p.n - 1; i++) { up.push(i + 0.5 + p.hy); down.push(i + 0.5 - p.hy); }
    return { up, down };
  },
  /** CSS: bbox of the pinned block's top edge as a function of scrollY */
  pinTop(p, sy) {
    const g = M04.geom(p);
    return sy < g.pinStart ? g.pinStart - sy : sy <= g.pinEnd ? 0 : g.pinEnd - sy;
  },
  /** rendered channels for written (s, y, o): the transform matrix excludes the origin; the bbox includes it */
  render(sw, yw, ow) {
    return { sx: sw, ty: yw, bx: (ow / 100) * VW * (1 - sw), bw: VW * sw };
  },
};

// ---------------------------------------------------------------- M05: wheel-latched tween (retarget from the current value)
export const M05 = {
  defaults: { dur: 540 },
  SECTION_Y: 3000, SECTION_H: 720,
  ARM_MARGIN: 2 * VH,
  /** IntersectionObserver rootMargin '200% 0px': armed while the section is inside [-2vh, 3vh] */
  armed(p, sy) {
    const top = M05.SECTION_Y - sy, bottom = top + M05.SECTION_H;
    return top <= VH + M05.ARM_MARGIN && bottom >= -M05.ARM_MARGIN;
  },
  /** the section's visible height is at least 0.45 vh and its bottom edge is inside the viewport (+8 px) */
  latched(sy) {
    const top = M05.SECTION_Y - sy, bottom = top + M05.SECTION_H;
    const vis = Math.min(bottom, VH) - Math.max(top, 0);
    return vis >= 0.45 * VH && bottom <= VH + 8;
  },
  init() { return { p: 0, tw: null, pinY: null }; },
  value(st, p, now) {
    if (!st.tw) return st.p;
    const u = clamp01((now - st.tw.t0) / p.dur);
    return u >= 1 ? st.tw.to : lerp(st.tw.from, st.tw.to, easeOutCubic(u));
  },
  /** wheel handler: returns {prevent, action}. `armed`/`sy` are what the page knows at the event. */
  wheel(st, p, { dy, now, sy, armed }) {
    if (!armed || Math.abs(dy) < 1) return { prevent: false, action: 'ignored' };
    if (!M05.latched(sy)) return { prevent: false, action: 'not-latched' };
    const target = dy > 0 ? 1 : 0;
    const cur = M05.value(st, p, now);
    if (!st.tw && cur === target) return { prevent: false, action: 'at-rest' };       // nothing left to play: let the page scroll
    if (st.tw && st.tw.to === target) return { prevent: true, action: 'swallowed' };  // same direction already running
    const action = st.tw ? 'retarget' : 'start';
    st.tw = { from: cur, to: target, t0: now };
    if (st.pinY == null) st.pinY = sy;
    return { prevent: true, action };
  },
  /** rAF: advance, return the written values and the scroll position to hold (or null) */
  frame(st, p, now) {
    if (st.tw) {
      const u = clamp01((now - st.tw.t0) / p.dur);
      st.p = u >= 1 ? st.tw.to : lerp(st.tw.from, st.tw.to, easeOutCubic(u));
      if (u >= 1) st.tw = null;
    }
    const pinTo = st.tw ? st.pinY : null;
    if (!st.tw) st.pinY = null;
    const m = st.p, f = 1 - Math.min(1, m / 0.5);
    return { m, f, pinTo };
  },
  render(m) { return { tx: m * -300, s: 1 + m * 0.3 }; },
};

// ---------------------------------------------------------------- M09b: legacy per-frame lerp scroller (own code)
export const M09B = {
  defaults: { lerp: 0.1, mult: 1 },
  DOC_H: 6000,
  limit() { return M09B.DOC_H - VH; },
  init() { return { cur: 0, target: 0, running: false }; },
  wheel(st, p, dy) {
    const t = clamp(0, st.target + dy * p.mult, M09B.limit());
    if (t === st.target) return;
    st.target = t; st.running = true;
  },
  frame(st, p) {
    if (st.running) {
      st.cur = lerp(st.cur, st.target, p.lerp);
      if (Math.round(st.cur) === Math.round(st.target)) { st.cur = st.target; st.running = false; }
    }
    return { y: st.cur };
  },
};

// ---------------------------------------------------------------- M09: Lenis (vendored 1.3.26) page parameters
export const M09 = {
  defaults: { lerp: 0.1, mult: 1 },
  DOC_H: 6000,
  limit() { return M09.DOC_H - VH; },
};

/** the stylesheet of the two scroller pages maps --y to a translation */
export const renderScroller = (y) => ({ tx: y * 0.1 });
