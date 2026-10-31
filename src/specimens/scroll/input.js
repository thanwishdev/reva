// Planned input of a scenario: what the recorder's action list produces on the `hx` frame grid, without a browser.
// The same semantics as src/record/session.js (hold(ms) = round(ms / dt) frames, an instant scrollTo lands before the next
// frame, a wheel event costs one frame, denseSweep = scrollTo + step per position) so a specimen can ship the scenario of
// its source and seek(t) can replay it. A test compares the plan with a recorded take.
import { round6 } from './core.js';

/**
 * @param {object[]} actions  recorder actions ({hold}, {step}, {scrollTo}, {wheel}, {denseSweep}, {sweep}, {eval}, ...)
 * @param {object} o  { frameMs, k0 (frames before the first action, default 4: the specimen is ready at once), maxScroll, rows (1-based frame count to plan at least) }
 * @returns {{frames: {k,T,sy}[], wheel: {T,dy}[], triggers: {T}[], scrollTo: object[]}}
 */
export function planInput(actions, { frameMs, k0 = 4, maxScroll = Infinity } = {}) {
  const frames = [], wheel = [], triggers = [], scrollTo = [];
  let k = 0, sy = 0;
  const T = () => round6(k * frameMs);
  const step = (n) => { for (let i = 0; i < n; i++) { k++; frames.push({ k, T: T(), sy }); } };
  const jump = (y) => { sy = Math.min(Math.max(0, y), maxScroll); scrollTo.push({ k, T: T(), want: y, got: sy }); };
  step(k0);
  for (const a of actions) {
    if ('hold' in a) step(Math.round(a.hold / frameMs));
    else if ('step' in a) step(a.step);
    else if ('scrollTo' in a) jump(a.scrollTo);
    else if ('wheel' in a) { const n = a.wheel.n ?? 100, dy = a.wheel.dy ?? 10; for (let i = 0; i < n; i++) { wheel.push({ T: T(), dy }); step(1); } }
    else if ('denseSweep' in a) {
      const { from = 0, to, px = 10, framesPerPos = 1 } = a.denseSweep; const ys = []; for (let y = from; y <= to; y += px) ys.push(y);
      for (const y of [...ys, ...ys.slice(0, -1).reverse()]) { jump(y); step(framesPerPos); }
    } else if ('sweep' in a) {
      const { from = 0, to, step: sp = 300, holdMs = 350, both = false } = a.sweep; const ys = []; for (let y = from; y <= to; y += sp) ys.push(y);
      if (ys[ys.length - 1] !== to) ys.push(to);
      for (const y of (both ? [...ys, ...ys.slice(0, -1).reverse()] : ys)) { jump(y); step(Math.round(holdMs / frameMs)); }
    } else if ('eval' in a && /\.go\s*\(|__go\s*\(/.test(String(a.eval))) triggers.push({ T: T() });
    else if ('mark' in a || 'eval' in a || 'watch' in a || 'snapshot' in a || 'sampling' in a) continue;
    else throw new Error('planInput: unknown action ' + JSON.stringify(a));
  }
  return { frames, wheel, pointer: [], triggers, scrollTo };
}

/** Pointer script: press at downT, move every stepMs along a line of `speed` px/ms from moveFromT to moveToT, release at upT. */
export function pointerScript({ downT, x0 = 160, speed, moveFromT, moveToT, stepMs = 10, upT }) {
  const ev = [{ T: downT, type: 'down', x: x0 }];
  for (let t = moveFromT; t <= moveToT + 1e-9; t += stepMs) ev.push({ T: t, type: 'move', x: x0 + speed * (t - downT) });
  ev.push({ T: upT, type: 'up', x: x0 + speed * (moveToT - downT) });
  return ev;
}

/**
 * Recorder actions that replay the trigger / pointer part of an input description: holds between the events,
 * `{mark: 'go'}` + `{eval: 'window.specimen.go()'}` per trigger, `window.specimen.script()` for a pointer path. A scroll or wheel
 * input comes from its own action list (planInput) and is not converted back.
 */
export function actionsFromInput(input, { frameMs, tailMs = 1000, k0 = 4 } = {}) {
  const actions = []; let at = k0 * frameMs;   // the recorder starts its actions after the boot frames
  const holdTo = (T) => { const ms = Math.max(0, T - at); if (ms > 0) { actions.push({ hold: Math.round(ms / frameMs) * frameMs }); at += Math.round(ms / frameMs) * frameMs; } };
  const evs = [];
  (input.triggers || []).forEach((t, i) => evs.push({ T: t.T, a: [{ mark: i ? 'go' + (i + 1) : 'go' }, { eval: 'window.specimen.go()' }] }));
  if ((input.pointer || []).length) evs.push({ T: 0, a: [{ mark: 'script' }, { eval: 'window.specimen.script(undefined, performance.now())' }] });
  evs.sort((a, b) => a.T - b.T);
  for (const e of evs) { holdTo(e.T); actions.push(...e.a); }
  const last = Math.max(0, ...(input.pointer || []).map((p) => p.T), ...(input.triggers || []).map((t) => t.T));
  actions.push({ hold: Math.round((last + tailMs - at) / frameMs) * frameMs });
  return actions;
}
