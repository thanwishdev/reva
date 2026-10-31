// Page glue shared by the group-B routes. Blind page: parameters arrive in the URL hash (#p=<base64url JSON>);
// nothing here exposes the parameters or the mechanism through a global, an attribute or a probe hook.
import { paramsFromHash, quantise, TimedSpring, Inertia, SCHEDULES, AMPLITUDE, BOX_X0, pointerEvents } from '../core.js';

const box = () => document.querySelector('.b0');

function writer(el, mode) {
  let last = null;
  // The first write happens inside the first animation-frame callback, so the first sampled row that carries the
  // driver channel is the frame the page's timers are anchored to (no race with script evaluation).
  return (x) => { const q = quantise(x, mode); if (q !== last) { last = q; el.style.setProperty('--x', String(q)); } };
}

/** Spring retargeted by timers; advanced once per animation frame. Timers are set from the first frame after `go` (the anchor). */
export function runTimedSpring() {
  const P = paramsFromHash(location.hash);
  const A = P.A ?? AMPLITUDE;
  const sched = SCHEDULES[P.sched];
  if (!sched) throw new Error('unknown schedule');
  const sim = new TimedSpring(P, 0);
  const put = writer(box(), P.write);
  let last = null;
  const frame = (ts) => {
    requestAnimationFrame(frame);
    if (last == null) {
      put(0);
      for (const ev of sched) setTimeout(() => sim.retarget(ev.level * A, performance.now(), ev.v != null ? ev.v * A : undefined), ev.t);
    } else put(sim.frame((ts - last) / 1000, ts));
    last = ts;
  };
  // the clock starts on an explicit post-boot `go` (the recorder dispatches it at a fixed virtual frame): starting at
  // the first animation frame after module evaluation raced real page-load time (D-M2-8 determinism root cause)
  addEventListener('go', () => requestAnimationFrame(frame), { once: true });
}

/** Drag then coast. `drive: 'script'` dispatches pointer events from timers; an external driver may send real ones. */
export function runInertia() {
  const P = paramsFromHash(location.hash);
  const el = box(), host = document.getElementById('c');
  const sim = new Inertia(P, BOX_X0);
  const put = writer(el, P.write);
  host.addEventListener('pointerdown', (e) => sim.down(e.clientX, performance.now()));
  host.addEventListener('pointermove', (e) => sim.move(e.clientX, performance.now()));
  host.addEventListener('pointerup', (e) => sim.up(performance.now()));
  let last = null;
  const frame = (ts) => {
    requestAnimationFrame(frame);
    if (last == null) {
      put(BOX_X0);
      if ((P.drive || 'script') === 'script') {
        for (const ev of pointerEvents(P.path)) setTimeout(() => {
          host.dispatchEvent(new PointerEvent('pointer' + ev.type, { clientX: ev.x, clientY: 100, bubbles: true }));
        }, ev.t);
      }
    } else put(sim.frame((ts - last) / 1000));
    last = ts;
  };
  // the clock starts on an explicit post-boot `go` (the recorder dispatches it at a fixed virtual frame): starting at
  // the first animation frame after module evaluation raced real page-load time (D-M2-8 determinism root cause)
  addEventListener('go', () => requestAnimationFrame(frame), { once: true });
}
