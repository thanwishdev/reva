// Script-owned regions (stage D1b). Some element state on a page is written by page script after load, not by CSS:
// a clock-driven digit counter's inline transform, a section size measured from the viewport height in JS, nodes a
// script inserts on resize. A CSS capture cannot (and must not) reproduce that state at a point it never saw, so the
// gate excludes it, but only with EVIDENCE:
//   1. recorder (init script, every original session): a MutationObserver sees every attribute / text / child-list
//      change after the load event (no parser runs after load, so each one was made by script), and the DOM write
//      APIs are wrapped to attribute each written (element, attribute) to the first script frame (url:line:col).
//      Writes are tagged with the phase they happened in (sweep, point id, time/resize probe) and the viewport size.
//   2. per point, the current values of every script-written (element, attribute) are stored with the snapshot.
//   3. owned(P) = elements whose script-written values at point P differ from those at the class's captured point,
//      plus elements present at only one of the two (script-inserted/removed). Each must be declared by the capture
//      (written by script in the capture session: load, sweep, time probe or resize probe), else it is not excused.
// The rebuild run gets the original's script-written values for owned(P) (the script's output, not CSS), so layout
// around them matches; the owned elements themselves (with their subtrees) are skipped by the oracle and painted out
// of both screenshots, and the masked area is reported per point. Their behaviour over time is the motion layer's
// job (src/record records it, src/analysis/motion.js fits it).

/** In-page init script. Self-contained. */
export function scriptWriteRecorder() {
  if (window.__wrSW) return;
  const W = { phase: 'load', loaded: false, agg: new Map(), touched: new Set(), first: new WeakMap(), dropped: 0 };
  Object.defineProperty(window, '__wrSW', { value: W, enumerable: false });
  const where = (err = new Error()) => {
    const L = String(err.stack || '').split('\n');
    for (let i = 1; i < L.length; i++) { const m = /(https?:\/\/[^\s)]+?):(\d+):(\d+)/.exec(L[i]); if (m) return `${m[1]}:${m[2]}:${m[3]}`; }
    return '';
  };
  const note = (el, name) => {
    if (!el || el.nodeType !== 1) return;
    let m = W.first.get(el); if (!m) W.first.set(el, (m = new Map()));
    if (!m.has(name)) m.set(name, where());
  };
  const wrapM = (proto, fn, f) => { const o = proto && proto[fn]; if (typeof o !== 'function') return; proto[fn] = function (...a) { try { f(this, a); } catch {} return o.apply(this, a); }; };
  const wrapS = (proto, prop, f) => {
    const d = proto && Object.getOwnPropertyDescriptor(proto, prop);
    if (!d || !d.set || !d.configurable) return;
    Object.defineProperty(proto, prop, { ...d, set(v) { try { f(this, v); } catch {} return d.set.call(this, v); } });
  };
  // inline style: a CSSStyleDeclaration does not know its element, so remember it when `.style` is read. Chrome
  // exposes the CSS properties (`style.transform = ...`) as OWN properties of each declaration, so they cannot be
  // wrapped; the `.style` read that precedes such a write is: its stack (an unformatted Error, cheap) is kept per
  // element and used when the observer then sees that element's style attribute change.
  const declEl = new WeakMap(), tokEl = new WeakMap(), styleGet = new WeakMap();
  for (const P of [window.HTMLElement, window.SVGElement, window.MathMLElement].map(c => c && c.prototype)) {
    const d = P && Object.getOwnPropertyDescriptor(P, 'style');
    if (!d || !d.get) continue;
    Object.defineProperty(P, 'style', { ...d, get() { const s = d.get.call(this); declEl.set(s, this); styleGet.set(this, new Error()); return s; }, set(v) { note(this, 'style'); return d.set.call(this, v); } });
  }
  // property accessors live on CSSStyleDeclaration.prototype or (newer Chrome) on CSSStyleProperties.prototype
  for (let P = Object.getPrototypeOf(document.createElement('div').style); P && P !== Object.prototype; P = Object.getPrototypeOf(P)) {
    for (const fn of ['setProperty', 'removeProperty']) if (Object.prototype.hasOwnProperty.call(P, fn)) wrapM(P, fn, s => note(declEl.get(s), 'style'));
    for (const p of Object.getOwnPropertyNames(P)) wrapS(P, p, s => note(declEl.get(s), 'style'));
  }
  const EP = Element.prototype, NP = Node.prototype;
  const cl = Object.getOwnPropertyDescriptor(EP, 'classList');
  if (cl && cl.get) Object.defineProperty(EP, 'classList', { ...cl, get() { const t = cl.get.call(this); tokEl.set(t, this); return t; } });
  for (const fn of ['add', 'remove', 'toggle', 'replace']) wrapM(DOMTokenList.prototype, fn, t => note(tokEl.get(t), 'class'));
  for (const fn of ['setAttribute', 'removeAttribute', 'toggleAttribute']) wrapM(EP, fn, (el, a) => note(el, String(a[0]).toLowerCase()));
  for (const fn of ['setAttributeNS', 'removeAttributeNS']) wrapM(EP, fn, (el, a) => note(el, String(a[1]).replace(/^.*:/, '').toLowerCase()));
  wrapS(EP, 'className', el => note(el, 'class')); wrapS(EP, 'id', el => note(el, 'id'));
  for (const fn of ['appendChild', 'insertBefore', 'removeChild', 'replaceChild']) wrapM(NP, fn, el => note(el, 'childList'));
  for (const fn of ['append', 'prepend', 'replaceChildren', 'insertAdjacentElement', 'insertAdjacentHTML', 'insertAdjacentText']) wrapM(EP, fn, el => note(el, 'childList'));
  for (const fn of ['before', 'after', 'replaceWith', 'remove']) wrapM(EP, fn, el => note(el.parentElement, 'childList'));
  wrapS(EP, 'innerHTML', el => note(el, 'childList')); wrapS(EP, 'outerHTML', el => note(el.parentElement, 'childList'));
  wrapS(NP, 'textContent', el => note(el.nodeType === 1 ? el : el.parentElement, el.nodeType === 1 ? 'childList' : 'text'));
  wrapS(HTMLElement.prototype, 'innerText', el => note(el, 'childList'));
  wrapS(CharacterData.prototype, 'data', n => note(n.parentElement, 'text')); wrapS(NP, 'nodeValue', n => note(n.parentElement, 'text'));
  // top-layer entry order (stage D2): the rebuild re-enters open popovers/modals in this order, so they stack alike
  W.top = [];
  const opened = el => { const i = W.top.indexOf(el); if (i >= 0) W.top.splice(i, 1); W.top.push(el); };
  for (const [C, fn] of [[window.HTMLElement, 'showPopover'], [window.HTMLElement, 'togglePopover'], [window.HTMLDialogElement, 'showModal']]) wrapM(C && C.prototype, fn, el => opened(el));
  document.addEventListener('beforetoggle', e => { if (e.newState === 'open' && e.target && e.target.nodeType === 1) opened(e.target); }, true);
  const ownText = el => { let s = ''; for (const n of el.childNodes) if (n.nodeType === 3) s += n.nodeValue; return s; };
  const mo = new MutationObserver(list => {
    if (!W.loaded) return; // parser and pre-load script output are part of the captured state
    for (const r of list) {
      const el = r.target.nodeType === 1 ? r.target : r.target.parentElement;
      if (!el) continue;
      const name = r.type === 'attributes' ? r.attributeName : r.type === 'childList' ? (el === r.target ? 'childList' : 'text') : 'text';
      if (name === 'style' && styleGet.has(el) && !(W.first.get(el) && W.first.get(el).get('style'))) { let m = W.first.get(el); if (!m) W.first.set(el, (m = new Map())); m.set('style', where(styleGet.get(el))); }
      let a = W.agg.get(el); if (!a) { if (W.agg.size > 20000) { W.dropped++; continue; } W.agg.set(el, (a = new Map())); }
      let x = a.get(name);
      if (!x) { x = { old0: r.type === 'attributes' ? r.oldValue : null, writes: 0, phases: [], sizes: [], t0: Date.now() }; a.set(name, x); }
      x.writes++;
      if (!x.phases.includes(W.phase) && x.phases.length < 40) x.phases.push(W.phase);
      const sz = innerWidth + 'x' + innerHeight; if (!x.sizes.includes(sz) && x.sizes.length < 40) x.sizes.push(sz);
      x.t1 = Date.now();
      W.touched.add(el);
    }
  });
  const start = () => mo.observe(document, { subtree: true, attributes: true, attributeOldValue: true, childList: true, characterData: true });
  if (document.documentElement) start(); else document.addEventListener('readystatechange', start, { once: true });
  addEventListener('load', () => { mo.takeRecords(); W.loaded = true; W.phase = 'settle'; }, { once: true });
  W.ownText = ownText;
}

/** In-page: flush pending records, then return every script-written (element, name) with its current value and
 *  evidence, keyed like the snapshot (structural path, non-rendered tags skipped); afterwards tag writes `next`. */
export function collectScriptWrites(next) {
  const W = window.__wrSW;
  if (!W) return null;
  const SKIP = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'TEMPLATE', 'BASE', 'TITLE', 'HEAD']);
  const keyOf = el => {
    const parts = [];
    for (let e = el; e; ) {
      if (e === document.documentElement) { parts.unshift('html'); return parts.join('/'); }
      const p = e.parentElement;
      if (!p || !e.isConnected || SKIP.has(e.tagName.toUpperCase())) return null;
      let n = 0;
      for (const c of p.children) { if (SKIP.has(c.tagName.toUpperCase())) continue; if (c.localName === e.localName) n++; if (c === e) break; }
      parts.unshift(`${e.localName}[${n}]`); e = p;
    }
    return null;
  };
  const out = { phase: W.phase, size: innerWidth + 'x' + innerHeight, now: Date.now(), dropped: W.dropped, els: {} };
  for (const [el, a] of W.agg) {
    const k = keyOf(el);
    if (!k) continue;
    const names = {};
    for (const [name, x] of a) {
      const cur = name === 'childList' ? [...el.children].filter(c => !SKIP.has(c.tagName.toUpperCase())).map(c => c.localName).join(',') : name === 'text' ? W.ownText(el) : el.getAttribute(name);
      names[name] = { cur, old0: x.old0, writes: x.writes, phases: x.phases, sizes: x.sizes, where: (W.first.get(el) && W.first.get(el).get(name)) || '' };
      // stage D2 structural replay: the script's child-list output itself (markup of the current children, non-rendered
      // tags dropped), so a rebuild can be given the same DOM at this point and its CSS compared there (no mask)
      if (name === 'childList') {
        const c = el.cloneNode(true);
        for (const x of c.querySelectorAll('script,style,link,template,noscript')) x.remove();
        const h = c.innerHTML;
        names[name].html = h.length <= 300000 ? h : null;
      }
    }
    out.els[k] = names;
  }
  if (next) W.phase = next;
  return out;
}

/** Node: run collectScriptWrites after flushing the observer queue (a microtask turn). */
export async function collectWrites(page, next) {
  await page.evaluate(() => new Promise(r => queueMicrotask(r))).catch(() => {});
  return page.evaluate(collectScriptWrites, next);
}

const under = (k, o) => k === o || k.startsWith(o + '/') || k.startsWith(o + '#');
/** True when key k is (inside) one of the owned keys. */
export const isOwned = (k, owned) => owned.some(o => under(k, o));

/**
 * owned(P) for one point: compare the script-written state at the captured point (swC) with that at P (swP) and the
 * two original snapshots (textC/textP: Map key -> own text, i.e. their element key sets). Returns [{k, how, names, inject}] where inject = {attr: value|null}
 * (the original's value at P, applied to the rebuild for attribute changes).
 */
export function ownedAt(swC, swP, textC, textP) {
  const out = [];
  if (!swC || !swP) return out;
  const keysC = [...textC.keys()], keysP = [...textP.keys()];
  for (const [k, names] of Object.entries(swP.els)) {
    const changed = {}, inject = {};
    for (const [name, x] of Object.entries(names)) {
      // value at the captured point: recorded there, else (first written after it) the value before the first write;
      // child lists are judged by the key-set diff below, script-written text by the two snapshots' own text
      if (name === 'childList') continue;
      const atC = name === 'text' ? textC.get(k) : swC.els[k]?.[name] ? swC.els[k][name].cur : x.old0;
      const atP = name === 'text' ? textP.get(k) : x.cur;
      if (atC !== atP) { changed[name] = { c: short(atC), p: short(atP), where: x.where, phases: x.phases, sizes: x.sizes.length, writes: x.writes }; if (name !== 'childList' && name !== 'text') inject[name] = x.cur; }
    }
    if (Object.keys(changed).length) out.push({ k, how: 'written', names: changed, inject });
  }
  // structure: elements at only one of the two points (no parser after load: inserted/removed by script)
  const P = new Set(keysP), C = new Set(keysC);
  const only = [...keysP.filter(k => !C.has(k)).map(k => ['P', k]), ...keysC.filter(k => !P.has(k)).map(k => ['C', k])];
  for (const [side, k] of only) {
    if (only.some(([, o]) => o !== k && under(k, o))) continue; // keep the top of each inserted/removed subtree
    out.push({ k, how: side === 'P' ? 'inserted' : 'removed', names: {}, inject: {} });
  }
  return out;
}

/** Every script-written attribute value at P (swP), for replay into the rebuild: the rebuild session visits several
 *  points in turn, so values replayed at an earlier point must be put back to P's value even where P equals the
 *  captured point (measured on a real site: a scene paused at one scroll point stayed paused at a later one otherwise). */
export function writtenStateAt(swP) {
  const out = [];
  for (const [k, names] of Object.entries(swP?.els || {})) {
    const inject = {};
    for (const [name, x] of Object.entries(names)) if (name !== 'childList' && name !== 'text') inject[name] = x.cur;
    if (Object.keys(inject).length) out.push({ k, inject });
  }
  return out;
}
const short = v => (v == null ? v : String(v).length > 160 ? String(v).slice(0, 160) + '…' : String(v));

/** Evidence that owned element k is a script writer seen by the capture session (key or an ancestor written,
 *  or for inserted/removed nodes a child-list write on an ancestor). Returns the declaring entry or null. */
export function declaredBy(k, declared) {
  let best = null;
  for (const d of declared) if (under(k, d.k) && (!best || d.k.length > best.k.length)) best = d;
  return best;
}

/**
 * Structural replay (stage D2; D1b masked these): for owned entries a replay CAN set, the script's output at P.
 *   script-written text           -> {k, text}  (the element's own text at P, recorded with the write)
 *   script-inserted/removed nodes -> {k: A, html} for the nearest ancestor-or-self A with a recorded child-list write
 *                                    at P whose markup was recorded (collectScriptWrites)
 * Returns {replay, rest}: rest = owned entries with no recorded output (still excluded + masked).
 */
export function structureAt(own, swP) {
  const replay = [], rest = [];
  const els = swP?.els || {};
  const writerOf = k => { let best = null; for (const [dk, n] of Object.entries(els)) if (n.childList && n.childList.html != null && under(k, dk) && (!best || dk.length > best.length)) best = dk; return best; };
  for (const e of own) {
    if (e.how === 'written') {
      if (!e.names.text) continue; // attribute-only: replayed by writtenStateAt
      const t = els[e.k]?.text;
      if (t && t.cur != null) replay.push({ k: e.k, text: t.cur }); else rest.push(e);
      continue;
    }
    // removed nodes: the writer is an ancestor present at P; inserted: the inserted top's parent chain
    const w = writerOf(e.k);
    if (w) { if (!replay.some(r => r.k === w && r.html != null)) replay.push({ k: w, html: els[w].childList.html }); } else rest.push(e);
  }
  // an html replay of an ancestor already sets everything below it
  const html = replay.filter(r => r.html != null).map(r => r.k);
  const covered = k => html.some(a => a !== k && under(k, a));
  return { replay: replay.filter(r => !covered(r.k)), rest: rest.filter(e => !covered(e.k)) };
}

/** In-page (rebuild, page JS off; runs via CDP evaluate): set the original's script output at a point: child-list
 *  markup ({k, html}), own text ({k, text}), then attribute values ({k, inject}). Structure replayed at an earlier
 *  point is put back first (the rebuild's own markup/text is stashed on first replay), so nothing leaks between
 *  points (same reason as writtenStateAt). */
export function injectOwned(list) {
  const SKIP = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'TEMPLATE', 'BASE', 'TITLE', 'HEAD']);
  const find = k => {
    const parts = k.split('/');
    if (parts[0] !== 'html') return null;
    let el = document.documentElement;
    for (const p of parts.slice(1)) {
      const m = /^([^[]+)\[(\d+)\]$/.exec(p); if (!m) return null;
      let n = 0, hit = null;
      for (const c of el.children) { if (SKIP.has(c.tagName.toUpperCase())) continue; if (c.localName === m[1] && ++n === Number(m[2])) { hit = c; break; } }
      if (!hit) return null; el = hit;
    }
    return el;
  };
  let set = 0, missing = 0, html = 0, text = 0;
  const stash = window.__wrStash || (window.__wrStash = { html: new Map(), text: new Map() });
  const wantH = new Set(list.filter(x => x.html != null).map(x => x.k)), wantT = new Set(list.filter(x => x.text != null).map(x => x.k));
  const setText = (el, t) => { const tn = [...el.childNodes].filter(n => n.nodeType === 3); if (!tn.length) el.appendChild(document.createTextNode(t)); else { tn[0].nodeValue = t; for (const n of tn.slice(1)) n.nodeValue = ''; } };
  // restore earlier replays not wanted here (deepest first, so a restored ancestor is not overwritten by a child)
  const touched = [];
  for (const k of [...stash.text.keys()].filter(k => !wantT.has(k)).sort((a, b) => b.length - a.length)) { const el = find(k); if (el) { setText(el, stash.text.get(k)); touched.push(el); } stash.text.delete(k); }
  for (const k of [...stash.html.keys()].filter(k => !wantH.has(k)).sort((a, b) => b.length - a.length)) { const el = find(k); if (el) { el.innerHTML = stash.html.get(k); touched.push(el, ...el.querySelectorAll('*')); } stash.html.delete(k); }
  for (const x of list) if (x.html != null) { const el = find(x.k); if (!el) { missing++; continue; } if (!stash.html.has(x.k)) stash.html.set(x.k, el.innerHTML); el.innerHTML = x.html; html++; touched.push(...el.querySelectorAll('*')); }
  for (const x of list) if (x.text != null) { const el = find(x.k); if (!el) { missing++; continue; } if (!stash.text.has(x.k)) stash.text.set(x.k, [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.nodeValue).join('')); setText(el, x.text); text++; touched.push(el); }
  for (const { k, inject } of list) {
    if (!inject) continue;
    const el = find(k);
    if (!el) { missing++; continue; }
    for (const [name, v] of Object.entries(inject)) { if (v == null) el.removeAttribute(name); else el.setAttribute(name, v); set++; }
    touched.push(el);
  }
  // Replayed nodes inside a skipped `content-visibility: auto` subtree (off screen) get NO layout box: Chrome does not
  // lay out a skipped subtree, and a forced read (getBoundingClientRect) does not lay out nodes inserted into it
  // (measured on a real site, D2b: the chat carousel cards are 0x0 until the section is next on screen). In the
  // original those nodes have their layout at P. So each c-v:auto ancestor of a replayed node is made visible for one
  // forced layout and put back in the same task: no rendering frame sees it unskipped, so its remembered intrinsic
  // size (contain-intrinsic-size: auto) is not touched (scrolling it into view would change that; D2 measured it).
  const cvAnc = new Set();
  const seen = new Set();
  for (const el of touched) for (let a = el.parentElement; a && !seen.has(a); a = a.parentElement) { seen.add(a); if (getComputedStyle(a).contentVisibility === 'auto') cvAnc.add(a); }
  let laidOut = 0;
  if (cvAnc.size) {
    const saved = [...cvAnc].map(a => [a, a.getAttribute('style')]);
    // through the attribute, not el.style (a CSSOM write re-serializes the attribute lazily: style="" after removal)
    for (const [a, st] of saved) a.setAttribute('style', `${st ? st + ';' : ''}content-visibility: visible !important`);
    for (const el of touched) el.getBoundingClientRect();
    for (const [a, st] of saved) { if (st == null) a.removeAttribute('style'); else a.setAttribute('style', st); laidOut++; }
  }
  return { set, missing, html, text, ...(laidOut ? { cvLaidOut: laidOut } : {}) };
}

/** In-page (rebuild; via CDP evaluate): put the table's top-layer elements back into the top layer, in table order:
 *  :popover-open -> showPopover(), :modal -> showModal(). Idempotent. Keys are main-document paths. */
export function enterTopLayer(list) {
  const SKIP = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'TEMPLATE', 'BASE', 'TITLE', 'HEAD']);
  const find = k => {
    let el = document.documentElement;
    for (const p of k.split('/').slice(1)) {
      const m = /^([^[]+)\[(\d+)\]$/.exec(p); if (!m) return null;
      let n = 0, hit = null;
      for (const c of el.children) { if (SKIP.has(c.tagName.toUpperCase())) continue; if (c.localName === m[1] && ++n === Number(m[2])) { hit = c; break; } }
      if (!hit) return null; el = hit;
    }
    return el;
  };
  let entered = 0, missing = 0, failed = 0;
  for (const { k, how } of list) {
    const el = find(k);
    if (!el) { missing++; continue; }
    try {
      if (how === ':popover-open' && !el.matches(':popover-open')) { el.showPopover(); entered++; }
      // a modal dialog carries the `open` attribute in the captured DOM; showModal() refuses an already open dialog
      else if (how === ':modal' && !el.matches(':modal')) { if (el.hasAttribute('open')) el.removeAttribute('open'); el.showModal(); entered++; }
    } catch { failed++; }
  }
  return { entered, missing, failed };
}

/** In-page (rebuild): load the <img> elements that were loaded in the original at this point (keys from the original
 *  session) but are not loaded here: lazy images inside markup the harness replayed or a state rebuild rendered never
 *  intersect before the snapshot (measured on a real site: tab panel photos and carousel avatars), while the original
 *  had them in its available-images list. Each is switched to eager loading and awaited (3 s cap), then decoded. */
export async function loadImagesLike(keys) {
  const SKIP = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'TEMPLATE', 'BASE', 'TITLE', 'HEAD']);
  const find = k => { let el = document.documentElement; for (const p of k.split('/').slice(1)) { const m = /^([^[]+)\[(\d+)\]$/.exec(p); if (!m) return null; let n = 0, hit = null; for (const c of el.children) { if (SKIP.has(c.tagName.toUpperCase())) continue; if (c.localName === m[1] && ++n === Number(m[2])) { hit = c; break; } } if (!hit) return null; el = hit; } return el; };
  const todo = keys.map(find).filter(i => i && i.localName === 'img' && !(i.complete && i.naturalWidth));
  for (const i of todo) i.loading = 'eager';
  await Promise.all(todo.map(i => (i.complete ? null : new Promise(r => { i.addEventListener('load', r, { once: true }); i.addEventListener('error', r, { once: true }); setTimeout(r, 3000); }))));
  await Promise.all(todo.filter(i => i.complete && i.naturalWidth).map(i => i.decode().catch(() => {})));
  return { loaded: todo.filter(i => i.complete && i.naturalWidth).length, of: todo.length };
}

/** In-page: keys of loaded <img> elements (main document). */
export function loadedImages() {
  const SKIP = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'TEMPLATE', 'BASE', 'TITLE', 'HEAD']);
  const keyOf = el => { const parts = []; for (let e = el; e; ) { if (e === document.documentElement) { parts.unshift('html'); return parts.join('/'); } const p = e.parentElement; if (!p) return null; let n = 0; for (const c of p.children) { if (SKIP.has(c.tagName.toUpperCase())) continue; if (c.localName === e.localName) n++; if (c === e) break; } parts.unshift(`${e.localName}[${n}]`); e = p; } return null; };
  return [...document.images].filter(i => i.complete && i.naturalWidth).map(keyOf).filter(Boolean);
}

/** In-page: elements in the top layer now (open popover / modal dialog), keyed like the snapshot, document order.
 *  Original runs record it so a rebuild with no table (the G suite's T6 dump) can be put in the same top layer. */
export function topLayerNow() {
  const SKIP = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'TEMPLATE', 'BASE', 'TITLE', 'HEAD']);
  const keyOf = el => { const parts = []; for (let e = el; e; ) { if (e === document.documentElement) { parts.unshift('html'); return parts.join('/'); } const p = e.parentElement; if (!p) return null; let n = 0; for (const c of p.children) { if (SKIP.has(c.tagName.toUpperCase())) continue; if (c.localName === e.localName) n++; if (c === e) break; } parts.unshift(`${e.localName}[${n}]`); e = p; } return null; };
  const out = [];
  for (const el of document.querySelectorAll('*')) for (const q of [':popover-open', ':modal']) { try { if (el.matches(q)) { const k = keyOf(el); if (k) out.push({ k, how: q }); break; } } catch {} }
  return out;
}

/** In-page: scroll offsets of inner scrollers (not the document), keyed like the snapshot. */
export function innerScrolls() {
  const SKIP = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'TEMPLATE', 'BASE', 'TITLE', 'HEAD']);
  const keyOf = el => { const parts = []; for (let e = el; e; ) { if (e === document.documentElement) { parts.unshift('html'); return parts.join('/'); } const p = e.parentElement; if (!p) return null; let n = 0; for (const c of p.children) { if (SKIP.has(c.tagName.toUpperCase())) continue; if (c.localName === e.localName) n++; if (c === e) break; } parts.unshift(`${e.localName}[${n}]`); e = p; } return null; };
  const out = [];
  for (const el of document.body ? document.body.querySelectorAll('*') : []) if (el.scrollLeft || el.scrollTop) { const k = keyOf(el); if (k) out.push({ k, x: el.scrollLeft, y: el.scrollTop }); }
  return out;
}

/** In-page (rebuild): set inner scroller offsets recorded in the original. */
export function setInnerScrolls(list) {
  const SKIP = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'TEMPLATE', 'BASE', 'TITLE', 'HEAD']);
  const find = k => { let el = document.documentElement; for (const p of k.split('/').slice(1)) { const m = /^([^[]+)\[(\d+)\]$/.exec(p); if (!m) return null; let n = 0, hit = null; for (const c of el.children) { if (SKIP.has(c.tagName.toUpperCase())) continue; if (c.localName === m[1] && ++n === Number(m[2])) { hit = c; break; } } if (!hit) return null; el = hit; } return el; };
  let set = 0;
  for (const { k, x, y } of list) { const el = find(k); if (el) { el.scrollLeft = x; el.scrollTop = y; set++; } }
  return set;
}

/** Rects (document px, rounded out) of every element in snap at or under an owned key. */
export function ownedRects(snap, owned) {
  const r = [];
  for (const e of snap.els) if (isOwned(e.k, owned) && e.b[2] > 0 && e.b[3] > 0) r.push([Math.floor(e.b[0]), Math.floor(e.b[1]), Math.ceil(e.b[0] + e.b[2]), Math.ceil(e.b[1] + e.b[3])]);
  return r;
}

/** Paint rects into an RGBA buffer (both screenshots get the same paint); returns the number of px painted. */
export function paintRects(png, rects) {
  const { width: w, height: h, data } = png;
  const m = new Uint8Array(w * h);
  for (const [x0, y0, x1, y1] of rects) for (let y = Math.max(0, y0); y < Math.min(h, y1); y++) for (let x = Math.max(0, x0); x < Math.min(w, x1); x++) m[y * w + x] = 1;
  let n = 0;
  for (let i = 0; i < m.length; i++) if (m[i]) { n++; const o = i * 4; data[o] = 255; data[o + 1] = 0; data[o + 2] = 255; data[o + 3] = 255; }
  return n;
}
