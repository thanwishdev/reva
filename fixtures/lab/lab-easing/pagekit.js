// DOM helpers shared by the lab-easing pages (not used by refsim: it must not depend on a DOM).
import { paramsFromHash, DEFAULTS, tweenAt, quant } from './core.js';

export const $ = (id) => document.getElementById(id);

/** Route parameters from `#p=<base64url JSON>` over this route's defaults (the runner always sends the full set). */
export function params(route) { return { ...DEFAULTS[route], ...paramsFromHash(location.hash) }; }

/** Append a generated stylesheet (declarations only: no inline style writes, so the recorder sees none). */
export function css(text) {
  const s = document.createElement('style');
  s.textContent = text;
  document.head.appendChild(s);
}

export function setVar(el, name, value) { el.style.setProperty(name, String(value)); }

/** Mark the page ready for the recorder's boot wait. */
export function ready() { window.__ready = true; }

/**
 * rAF tween engine: one tween at a time on `el`, written to custom property `prop` through quant(). The loop reads
 * performance.now() (the virtual clock under hx), starts a new tween from `start()`, and stops after the final write.
 * `cur` is the last unquantised value, so a retarget starts from the current value.
 */
export function makeTweener(el, prop, write) {
  let tw = null, raf = 0;
  const self = {
    cur: 0,
    tick() {
      raf = 0;
      if (!tw) return;
      const r = tweenAt(tw, performance.now());
      self.cur = r.v;
      setVar(el, prop, quant(r.v, write));
      if (!r.done) raf = requestAnimationFrame(self.tick);
    },
    start(from, to, D, ease, t0 = performance.now()) {
      tw = { from, to, D, ease, t0 };
      if (!raf) raf = requestAnimationFrame(self.tick);
    },
    active() { return !!tw && performance.now() - tw.t0 < tw.D; },
    set(v) { self.cur = v; setVar(el, prop, quant(v, write)); },
  };
  return self;
}
