// Busy-wait guard for the paused / virtual clocks. A page that waits with `while (Date.now() - t0 < ms) {}` (a classic
// UUID generator does) never ends when the harness holds time still: the renderer spins at 100 % CPU, `load` never fires and
// every later call hangs until the step cap (corpus F8 capture goto timeout, F19 motion 1500 s cap).
// The guard counts reads of the clock that return the same value and, after `threshold` of them, lets the value creep
// forward by 1 ms. Count-based, so two identical replays see identical times. The reading stays monotonic: the creep is
// absorbed again when the real (paused or virtual) clock moves on.
export const SPIN_THRESHOLD = 20000;

/** Pure helper (also the reference for the in-page copy): reading = guard(raw). */
export function makeSpinGuard(threshold = SPIN_THRESHOLD) {
  let lastRaw = NaN, n = 0, off = 0;
  return raw => {
    if (raw === lastRaw) { if (++n >= threshold) { n = 0; off += 1; } }
    else { if (lastRaw === lastRaw) off = Math.max(0, off - (raw - lastRaw)); lastRaw = raw; n = 0; }
    return raw + off;
  };
}

/** Init-script source for a page whose Date and performance.now are driven by Playwright's paused fake clock. */
export function spinGuardSource(threshold = SPIN_THRESHOLD) {
  return `(() => {
  if (window.__wrSpinGuard) return; window.__wrSpinGuard = { ticks: 0 };
  const mk = () => { let lastRaw = NaN, n = 0, off = 0; return raw => {
    if (raw === lastRaw) { if (++n >= ${threshold}) { n = 0; off += 1; window.__wrSpinGuard.ticks++; } }
    else { if (lastRaw === lastRaw) off = Math.max(0, off - (raw - lastRaw)); lastRaw = raw; n = 0; }
    return raw + off; }; };
  const D = Date, gd = mk(), gp = mk(), pn = performance.now.bind(performance);
  const dnow = () => gd(D.now());
  window.Date = new Proxy(D, {
    construct(t, a, nt) { return Reflect.construct(t, a.length ? a : [dnow()], nt); },
    get(t, k, r) { return k === 'now' ? dnow : Reflect.get(t, k, t); },
  });
  performance.now = () => gp(pn());
})();`;
}
