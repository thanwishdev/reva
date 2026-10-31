// Browser-side helpers shared by the lab-scroll pages (not used by refsim).
import { decodeParams } from '../core.js';

/** Page parameters: the defaults of the route, overridden by the URL hash `#p=<base64url JSON>`. */
export function params(defaults) {
  return { ...defaults, ...decodeParams(location.hash) };
}

/** A block at an absolute document position, built before it is attached (so no style mutation is recorded). */
export function block(id, top, height, extraCss = '') {
  const el = document.createElement('div');
  el.id = id;
  el.style.cssText = `position:absolute;left:0;width:100%;top:${top}px;height:${height}px;${extraCss}`;
  document.body.appendChild(el);
  return el;
}

/** Writes a custom property only when the text changed (as most pages do). */
export function writer(el) {
  const last = new Map();
  return (name, text) => {
    if (last.get(name) === text) return;
    last.set(name, text);
    el.style.setProperty(name, text);
  };
}

/** One rAF loop for the whole page; the callback receives the frame timestamp. */
export function loop(fn) {
  const t = (now) => { fn(now); requestAnimationFrame(t); };
  requestAnimationFrame(t);
}
