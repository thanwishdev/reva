// Fixture Lab, group C (scroll): the reference simulator.
//   simulate(routeId, params, ctx) -> { channels: { "<selector>|<channel>": number[] per frame }, events, notes }
// ctx = { frames: [{k, T, sy, sx}], inputs: inputLog, viewport } taken from the ACTUAL take (design section 11).
// It reproduces the `hx` semantics of src/record/inpage.js: rAF callbacks of frame k run at T_k and read the scroll
// position of row k; an input that landed after frame k is handled at virtual time T_k, before frame k+1.
// Rendered channels (ren:*) are what the stylesheet's calc() mapping must produce from the written values (the
// `render*` functions of core.js); the parity test compares them with what the browser read back.
// M09 (the vendored Lenis 1.3.26) is simulated from the library's documented recurrence, written here independently of
// the vendored code: damp(x, y, 60 * lerp, dt) with dt = rAF timestamp difference, completion when the rounded value
// equals the rounded target, reset to the browser's scroll position at completion.
import * as C from './core.js';

const key = (sel, ch) => `${sel}|${ch}`;

function contiguous(frames) {
  for (let i = 1; i < frames.length; i++) {
    if (frames[i].k !== frames[i - 1].k + 1) throw new Error(`refsim needs contiguous frames (k ${frames[i - 1].k} -> ${frames[i].k}); pass the frames of the take before any R6 row dropping`);
  }
}

/** Wheel events by frame index. Entries need a numeric `k` (design X2); use ctxFromTake for takes recorded before X2. */
function wheelsByFrame(inputs) {
  const m = new Map();
  for (const e of inputs || []) {
    if (e.type !== 'wheel') continue;
    if (typeof e.k !== 'number') throw new Error('wheel input without frame index k: build ctx with ctxFromTake(take, data)');
    if (!m.has(e.k)) m.set(e.k, []);
    m.get(e.k).push(e);
  }
  return m;
}

function table(names) { const o = {}; for (const n of names) o[n] = []; return o; }
const push = (ch, sel, name, v) => ch[key(sel, name)].push(v);

// ---------------------------------------------------------------- per-route simulators
const SIM = {
  m01(p, frames) {
    const names = ['#c|drv:--p', '#c|ren:--p', '#c|ren:tx', '#c|ren:ty', '#c|ren:opacity'];
    const ch = table(names);
    for (const f of frames) {
      const r = C.M01.frame(p, p.o - f.sy);
      const rd = C.M01.render(r.p);
      push(ch, '#c', 'drv:--p', r.p); push(ch, '#c', 'ren:--p', r.p);
      push(ch, '#c', 'ren:tx', rd.tx); push(ch, '#c', 'ren:ty', rd.ty); push(ch, '#c', 'ren:opacity', rd.opacity);
    }
    return { channels: ch, events: [] };
  },
  m02(p, frames) {
    const names = ['#c|drv:--e', '#c|ren:--e', '#c|ren:ty', '#c|ren:sx', '#c|ren:sy', '#c|ren:opacity'];
    const ch = table(names); const st = C.M02.init(); const target = [], cur = [];
    for (const f of frames) {
      const r = C.M02.frame(st, p, C.M02.BOTTOM - f.sy);
      const rd = C.M02.render(r.e);
      push(ch, '#c', 'drv:--e', r.e); push(ch, '#c', 'ren:--e', r.e);
      push(ch, '#c', 'ren:ty', rd.ty); push(ch, '#c', 'ren:sx', rd.s); push(ch, '#c', 'ren:sy', rd.s); push(ch, '#c', 'ren:opacity', rd.opacity);
      target.push(r.target); cur.push(st.cur);
    }
    return { channels: ch, events: [], aux: { target, cur } };
  },
  m03(p, frames) {
    const names = ['#c|drv:--a', '#c|drv:--b', '#c|drv:--p', '#c|ren:--a', '#c|ren:--b', '#c|ren:--p', '#c|ren:opacity', '#c|ren:sx', '#c|ren:sy'];
    const ch = table(names); const st = C.M03.init(); const ta = [], tb = [], sa = [], sb = [];
    for (const f of frames) {
      const r = C.M03.frame(st, p, C.M03.BOTTOM_A - f.sy, C.M03.BOTTOM_B - f.sy);
      const rd = C.M03.render(r.p);
      for (const [n, v] of [['--a', r.a], ['--b', r.b], ['--p', r.p]]) { push(ch, '#c', 'drv:' + n, v); push(ch, '#c', 'ren:' + n, v); }
      push(ch, '#c', 'ren:opacity', rd.opacity); push(ch, '#c', 'ren:sx', rd.s); push(ch, '#c', 'ren:sy', rd.s);
      ta.push(r.ta); tb.push(r.tb); sa.push(st.a); sb.push(st.b);
    }
    return { channels: ch, events: [], aux: { ta, tb, a: sa, b: sb } };
  },
  m04(p, frames) {
    const names = ['#k|drv:--s', '#k|drv:--y', '#k|drv:--o', '#c|drv:--i', '#k|ren:--s', '#k|ren:--y', '#k|ren:--o', '#c|ren:--i',
      '#k|ren:sx', '#k|ren:sy', '#k|ren:tx', '#k|ren:ty', '#k|ren:bx', '#k|ren:bw', '#c|ren:by'];
    const ch = table(names); const st = C.M04.init(); const tp = [], e = [], es = [];
    for (const f of frames) {
      const r = C.M04.frame(st, p, C.M04.RY - f.sy);
      const rd = C.M04.render(r.s, r.y, r.o);
      for (const [sel, n, v] of [['#k', '--s', r.s], ['#k', '--y', r.y], ['#k', '--o', r.o], ['#c', '--i', r.i]]) { push(ch, sel, 'drv:' + n, v); push(ch, sel, 'ren:' + n, v); }
      push(ch, '#k', 'ren:sx', rd.sx); push(ch, '#k', 'ren:sy', rd.sx); push(ch, '#k', 'ren:tx', 0); push(ch, '#k', 'ren:ty', rd.ty);
      push(ch, '#k', 'ren:bx', rd.bx); push(ch, '#k', 'ren:bw', rd.bw);
      push(ch, '#c', 'ren:by', C.M04.pinTop(p, f.sy));
      tp.push(r.tp); e.push(r.e); es.push(r.es);
    }
    return { channels: ch, events: [], aux: { tp, e, es } };
  },
  m05(p, frames, inputs) {
    const names = ['#c|drv:--m', '#c|drv:--f', '#c|ren:--m', '#c|ren:--f', '#c|ren:tx', '#c|ren:sx', '#c|ren:sy', '#c|ren:opacity'];
    const ch = table(names); const st = C.M05.init(); const events = []; const pins = [];
    const wheels = wheelsByFrame(inputs);
    for (const f of frames) {
      const r = C.M05.frame(st, p, f.T);
      const rd = C.M05.render(r.m);
      push(ch, '#c', 'drv:--m', r.m); push(ch, '#c', 'ren:--m', r.m); push(ch, '#c', 'drv:--f', r.f); push(ch, '#c', 'ren:--f', r.f);
      push(ch, '#c', 'ren:tx', rd.tx); push(ch, '#c', 'ren:sx', rd.s); push(ch, '#c', 'ren:sy', rd.s); push(ch, '#c', 'ren:opacity', r.f);
      if (r.pinTo != null) pins.push({ k: f.k, pinTo: r.pinTo });
      for (const w of wheels.get(f.k) || []) {
        const armed = C.M05.armed(p, f.sy);
        const d = C.M05.wheel(st, p, { dy: w.dy, now: f.T, sy: f.sy, armed });
        events.push({ type: 'wheel', k: f.k, T: f.T, dy: w.dy, sy: f.sy, armed, latched: C.M05.latched(f.sy), prevented: d.prevent, action: d.action,
          tween: st.tw ? { from: st.tw.from, to: st.tw.to, t0: st.tw.t0, dur: p.dur } : null });
      }
    }
    return { channels: ch, events, aux: { pins } };
  },
  m09(p, frames, inputs) {
    // Lenis 1.3.26 recurrence, independent of the vendored source
    const names = ['#c|drv:--y', '#c|ren:--y', '#c|ren:tx', 'window|sy'];
    const ch = table(names); const events = [];
    const wheels = wheelsByFrame(inputs);
    const limit = C.M09.limit();
    let animated = 0, target = 0, to = 0, running = false, time = 0;
    const auxTarget = [], auxRunning = [];
    for (const f of frames) {
      // raf(time): deltaTime = time - (this.time || time); animate.advance(deltaTime * 0.001)
      const dt = f.T - (time || f.T); time = f.T;
      if (running) {
        const lambda = p.lerp * 60, sec = dt * 0.001;
        animated = animated + (to - animated) * (1 - Math.exp(-lambda * sec));
        if (Math.round(animated) === Math.round(to)) { animated = to; running = false; target = to; }
      }
      push(ch, '#c', 'drv:--y', animated); push(ch, '#c', 'ren:--y', animated); push(ch, '#c', 'ren:tx', C.renderScroller(animated).tx);
      ch['window|sy'].push(Math.round(animated));   // the browser keeps integer scroll offsets here
      for (const w of wheels.get(f.k) || []) {
        const delta = w.dy * p.mult;
        const t = Math.min(limit, Math.max(0, target + delta));
        events.push({ type: 'wheel', k: f.k, T: f.T, dy: w.dy, prevented: true, targetBefore: target, targetAfter: t, changed: t !== target });
        if (t === target) continue;
        target = t; to = t; running = true;      // fromTo(animatedScroll, target): value = from = animated
      }
      auxTarget.push(target); auxRunning.push(running);
    }
    return { channels: ch, events, aux: { target: auxTarget, running: auxRunning } };
  },
  m09b(p, frames, inputs) {
    const names = ['#c|drv:--y', '#c|ren:--y', '#c|ren:tx', 'window|sy'];
    const ch = table(names); const events = [];
    const wheels = wheelsByFrame(inputs);
    const st = C.M09B.init();
    const auxTarget = [], auxRunning = [];
    for (const f of frames) {
      const o = C.M09B.frame(st, p);
      push(ch, '#c', 'drv:--y', o.y); push(ch, '#c', 'ren:--y', o.y); push(ch, '#c', 'ren:tx', C.renderScroller(o.y).tx);
      ch['window|sy'].push(Math.round(o.y));
      for (const w of wheels.get(f.k) || []) {
        const before = st.target; C.M09B.wheel(st, p, w.dy);
        events.push({ type: 'wheel', k: f.k, T: f.T, dy: w.dy, prevented: true, targetBefore: before, targetAfter: st.target, changed: st.target !== before });
      }
      auxTarget.push(st.target); auxRunning.push(st.running);
    }
    return { channels: ch, events, aux: { target: auxTarget, running: auxRunning } };
  },
};

const CORE_OF = { m01: C.M01, m02: C.M02, m03: C.M03, m04: C.M04, m05: C.M05, m09: C.M09, m09b: C.M09B };
export const ROUTE_IDS = Object.keys(SIM);

export function defaultsOf(routeId) {
  if (!CORE_OF[routeId]) throw new Error(`unknown route ${routeId}`);
  return { ...CORE_OF[routeId].defaults };
}

export function simulate(routeId, params, ctx) {
  const sim = SIM[routeId];
  if (!sim) throw new Error(`unknown route ${routeId}`);
  const p = { ...defaultsOf(routeId), ...(params || {}) };
  const frames = ctx.frames;
  contiguous(frames);
  const out = sim(p, frames, ctx.inputs || []);
  return { route: routeId, params: p, frames: frames.length, ...out };
}

/**
 * ctx from a loaded take: { take, data } as returned by loadTake(dir, ['rows','inputLog','wheel']).
 * hx wheel entries of the input log carry k: null before recorder extension X2; their frame index is then taken from the
 * page-side wheel log (same order).
 */
export function ctxFromTake({ take, data }) {
  const frames = data.rows.map(r => ({ k: r.k, T: r.T, sy: r.sy, sx: r.sx }));
  const pageWheel = data.wheel || [];
  let wi = 0;
  const inputs = (data.inputLog || []).map((e) => {
    if (e.type !== 'wheel') return e;
    const pw = pageWheel[wi++];
    return { ...e, k: typeof e.k === 'number' ? e.k : (pw ? pw.k : null), dyPage: pw ? pw.dy : undefined, prevented: pw ? pw.prevented : undefined };
  });
  return { frames, inputs, viewport: take.context && take.context.viewport };
}
