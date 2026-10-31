// Stage D2: interaction states, each scored by the stage G gate (review F4).
//   candidates  CSS states from the rule table: every rule whose selector needs :hover/:focus/:focus-visible/
//               :focus-within/:active/:target/... and whose state-free selector matches an element (table `st`/`~pe`),
//               resolved in the page to the element that must carry the pseudo-class (e.g. `.card:hover h2` -> the
//               card); a greedy set cover picks the fewest states that reach every such rule.
//               JS states from ARIA / HTML: [aria-expanded=false], inactive [role=tab], [popovertarget], closed
//               <details>, [aria-haspopup] buttons; a closed <dialog>/[popover] no element controls is opened by the
//               harness (showModal/showPopover) and labelled so. One representative per component (same tag, role
//               and classes); the rest are listed as covered by it.
//   exercise    CSS states: CDP CSS.forcePseudoState on the target, in the original and in the rebuild alike.
//               JS states: real input through the src/record action driver (runActions + {click}), on a fresh load.
//   capture     JS states: a rule table of the page IN the state (cap session) -> the state's rebuild is rendered
//               from that JSON alone. Interaction pseudo-classes left by the input (:focus, :focus-within, :hover)
//               and top-layer entries are recorded and re-applied to the rebuild by the harness, like D1b replays.
//   per state   newly applying rules (CDP rule usage delta, mapped to rule-table ids), computed delta (element oracle,
//               base vs state, same session), newly loaded assets + archive misses, and the G gate at the captured
//               point and one held-out point of the class: rebuild-in-state vs original-in-state (oracle + pixels;
//               noise caps from identical replays o1/o2, identity o3 vs o1).
//   coverage    every state rule of the base table: exercised (by which state) or not, with the reason.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { inSlot } from './limit.js';
import { labelStates } from './causes.js';
import { openSession, newGatePools, compareRuns, noiseCapsFrom, summarize, gzRead, gzWrite, finishFiniteAnimations, NO_SCRIPT_CSP, frames, advance, freezeMedia, clipProblem, pageSize, markNoShot, isClipError, pageTimerError, sameArtifact } from './run.js';
import { takeSnapshot } from './snapshot.js';
import { compareSnapshots } from './compare.js';
import { renderRebuild } from './rebuild.js';
import { auditSources } from './audit.js';
import { inPageSources } from './audit.js';
import { collectWrites, injectOwned, enterTopLayer, innerScrolls, setInnerScrolls, loadImagesLike, loadedImages } from './scriptowned.js';
import { scriptOwnedPlan, ruleTableCapture } from './capture.js';
import { captureRuntimeState, saveRuntimeState, loadRuntimeState, applyRuntimeState } from './runtimeemit.js';
import { captureRun } from './run.js';
import { mergeUsage } from '../static/ruletable.js';
import { openCss, startRuleUsage, sheetText, sheetIdsByOwner, isGoneError } from '../static/cdpcss.js';
import { captureRuleTable, attachUsage } from '../static/ruletable.js';
import { runActions } from '../record/scenario.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
/** pseudo-classes CDP CSS.forcePseudoState accepts (Chrome 147); others in a state selector are entered by script */
export const FORCEABLE = ['hover', 'focus-visible', 'focus-within', 'focus', 'active', 'target', 'visited'];
const STATE_PC = /:(hover|focus-visible|focus-within|focus|active|target-within|target|visited|popover-open|modal|fullscreen|user-invalid|user-valid|autofill|-webkit-autofill)(?![\w-])/g;

/** In-page: element by oracle key (main document, open shadow roots `#s`, same-origin iframes `#f/html`). */
export function findByKey(k) {
  const SKIP = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'TEMPLATE', 'BASE', 'TITLE', 'HEAD']);
  const parts = k.split('/');
  let doc = document, el = null, root = null;
  for (let i = 0; i < parts.length; i++) {
    let p = parts[i];
    if (p === 'html') { el = doc.documentElement; root = null; continue; }
    const m = /^([^[]+)\[(\d+)\](#s|#f)?$/.exec(p); if (!m || !el) return null;
    let n = 0, hit = null;
    for (const c of (root || el).children) { if (SKIP.has(c.tagName.toUpperCase())) continue; if (c.localName === m[1] && ++n === Number(m[2])) { hit = c; break; } }
    if (!hit) return null;
    el = hit; root = null;
    if (m[3] === '#s') { if (!el.shadowRoot) return null; root = el.shadowRoot; }
    else if (m[3] === '#f') { try { doc = el.contentDocument; } catch { return null; } if (!doc) return null; }
  }
  return el;
}

/** In-page: for state-candidate (rule, element) pairs, the element(s) that must carry each state pseudo-class.
 *  pairs: [{rid, sel, k}] -> [{rid, k, targets: [{k, pc: [...]}] | null, why}] */
export function inPageStateTargets({ pairs, find }) {
  const findByKey = (0, eval)('(' + find + ')');
  const SKIP = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'TEMPLATE', 'BASE', 'TITLE', 'HEAD']);
  const keyOf = el => { // inverse of findByKey (main document + open shadow roots)
    const parts = [];
    let e = el, sfx = '';
    while (e) {
      if (e === document.documentElement) { parts.unshift('html' + sfx); return parts.join('/'); }
      const pn = e.parentNode;
      const shadowChild = pn && pn.nodeType === 11 && pn.host;
      const list = shadowChild ? pn.children : e.parentElement ? e.parentElement.children : null;
      if (!list) return null;
      let n = 0;
      for (const c of list) { if (SKIP.has(c.tagName.toUpperCase())) continue; if (c.localName === e.localName) n++; if (c === e) break; }
      parts.unshift(`${e.localName}[${n}]${sfx}`);
      if (shadowChild) { e = pn.host; sfx = '#s'; } else { e = e.parentElement; sfx = ''; }
    }
    return null;
  };
  const RE = /:(hover|focus-visible|focus-within|focus|active|target-within|target|visited|popover-open|modal|fullscreen|user-invalid|user-valid|autofill|-webkit-autofill)(?![\w-])/g;
  const splitTop = (s, chars) => { const out = []; let d = 0, q = null, cur = ''; for (let i = 0; i < s.length; i++) { const ch = s[i]; if (q) { cur += ch; if (ch === '\\') { cur += s[++i] || ''; continue; } if (ch === q) q = null; continue; } if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; } if (ch === '(' || ch === '[') d++; else if (ch === ')' || ch === ']') d--; if (d === 0 && chars.includes(ch)) { out.push(cur); out.push(ch); cur = ''; continue; } cur += ch; } out.push(cur); return out; };
  const out = [];
  for (const { rid, sel, k } of pairs) {
    const E = findByKey(k);
    if (!E) { out.push({ rid, k, targets: null, why: 'element-not-found' }); continue; }
    const parts = splitTop(sel, ',').filter((x, i) => i % 2 === 0).map(x => x.trim()).filter(x => { RE.lastIndex = 0; return RE.test(x); });
    let done = null;
    for (const part0 of parts) {
      const part = part0.replace(/::?(before|after|first-line|first-letter|marker|placeholder|selection|backdrop)\b.*$/, '').trim();
      // compounds separated by top-level combinators
      const toks = splitTop(part.replace(/\s*([>+~])\s*/g, '$1').replace(/\s+/g, ' '), ' >+~');
      const comps = [], combs = [];
      for (let i = 0; i < toks.length; i++) { if (i % 2 === 0) { if (toks[i] !== '') comps.push(toks[i]); } else combs.push(toks[i]); }
      if (comps.length !== combs.length + 1) continue;
      // walk from the subject (last compound) leftwards, tracking the element each compound stands for
      const targets = [];
      let cur = E, ok = true;
      for (let c = comps.length - 1; c >= 0 && ok; c--) {
        const comp = comps[c];
        RE.lastIndex = 0;
        const pcs = [...comp.matchAll(RE)].map(m => m[1]);
        let free = comp.replace(RE, '').replace(/:(is|where)\(\s*\)/g, '') || '*';
        if (/^[>+~]/.test(free)) free = '*';
        if (c < comps.length - 1) {
          const comb = combs[c];
          let x = null;
          try {
            if (comb === '>') x = cur.parentElement && cur.parentElement.matches(free) ? cur.parentElement : null;
            else if (comb === ' ') x = cur.parentElement ? cur.parentElement.closest(free) : null;
            else if (comb === '+') x = cur.previousElementSibling && cur.previousElementSibling.matches(free) ? cur.previousElementSibling : null;
            else if (comb === '~') { for (let s = cur.previousElementSibling; s; s = s.previousElementSibling) if (s.matches(free)) { x = s; break; } }
          } catch { x = null; }
          if (!x) { ok = false; break; }
          cur = x;
        }
        if (pcs.length) { const tk = keyOf(cur); if (!tk) { ok = false; break; } targets.push({ k: tk, pc: [...new Set(pcs)].sort() }); }
      }
      if (ok && targets.length) { done = targets; break; }
    }
    out.push(done ? { rid, k, targets: done } : { rid, k, targets: null, why: 'target-unresolved' });
  }
  return out;
}

/** In-page: JS-state candidates from ARIA / HTML semantics. Returns [{k, how, action, sig, label, visible, harness}]. */
export function inPageJsCandidates({ find }) {
  void find;
  const SKIP = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'TEMPLATE', 'BASE', 'TITLE', 'HEAD']);
  const keyOf = el => { const parts = []; for (let e = el; e; ) { if (e === document.documentElement) { parts.unshift('html'); return parts.join('/'); } const p = e.parentElement; if (!p) return null; let n = 0; for (const c of p.children) { if (SKIP.has(c.tagName.toUpperCase())) continue; if (c.localName === e.localName) n++; if (c === e) break; } parts.unshift(`${e.localName}[${n}]`); e = p; } return null; };
  const vis = el => { const b = el.getBoundingClientRect(); const cs = getComputedStyle(el); return b.width > 0 && b.height > 0 && cs.visibility !== 'hidden'; };
  const STATEY = /^(is-|has-)?(active|selected|open|current|expanded|checked|on)$/;
  const sig = el => [el.localName, el.getAttribute('role') || '', [...el.classList].filter(c => !STATEY.test(c)).sort().join('.')].join('|');
  const label = el => (el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 50);
  const out = [], seen = new Set();
  const add = (el, how, harness = false) => { if (seen.has(el)) return; seen.add(el); const k = keyOf(el); if (!k) return; out.push({ k, how, sig: how + '|' + sig(el), label: label(el), visible: vis(el), disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true', harness }); };
  for (const el of document.querySelectorAll('[aria-expanded="false"]')) add(el, 'aria-expanded');
  for (const el of document.querySelectorAll('[role="tab"]:not([aria-selected="true"])')) add(el, 'tab');
  for (const el of document.querySelectorAll('[popovertarget], [commandfor]')) add(el, 'popovertarget');
  for (const el of document.querySelectorAll('details:not([open]) > summary')) add(el, 'details');
  for (const el of document.querySelectorAll('[aria-haspopup]:not([aria-expanded])')) add(el, 'haspopup');
  // closed dialogs / popovers that no element in the page controls: entered by script on a condition the page does
  // not expose (e.g. a server flag); the harness opens them so their CSS is exercised, labelled `harness`
  const controlled = id => id && document.querySelector(`[aria-controls~="${CSS.escape(id)}"], [popovertarget="${CSS.escape(id)}"], [commandfor="${CSS.escape(id)}"]`);
  for (const el of document.querySelectorAll('dialog:not([open])')) if (!controlled(el.id)) add(el, 'dialog', true);
  for (const el of document.querySelectorAll('[popover]')) if (!el.matches(':popover-open') && !controlled(el.id)) add(el, 'popover', true);
  return out;
}

/** Event types whose listener on an element makes it a JS-state candidate, by the input that fires it. */
export const LISTENER_KINDS = {
  click: 'click', pointerdown: 'click', pointerup: 'click', mousedown: 'click', mouseup: 'click', touchstart: 'click', touchend: 'click',
  keydown: 'key', keyup: 'key', keypress: 'key',
  focus: 'focus', focusin: 'focus',
  mouseenter: 'hover', mouseover: 'hover', pointerenter: 'hover', pointerover: 'hover',
};

/** In-page (callFunctionOn, this = element): oracle key + component signature + why it must not be clicked. */
function describeListenerTarget() {
  const SKIP = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'TEMPLATE', 'BASE', 'TITLE', 'HEAD']);
  const keyOf = el => { const parts = []; for (let e = el; e; ) { if (e === document.documentElement) { parts.unshift('html'); return parts.join('/'); } const p = e.parentElement; if (!p) return null; let n = 0; for (const c of p.children) { if (SKIP.has(c.tagName.toUpperCase())) continue; if (c.localName === e.localName) n++; if (c === e) break; } parts.unshift(`${e.localName}[${n}]`); e = p; } return null; };
  const STATEY = /^(is-|has-)?(active|selected|open|current|expanded|checked|on)$/;
  const el = this;
  const b = el.getBoundingClientRect(), cs = getComputedStyle(el);
  const a = el.closest('a[href]');
  const href = a ? a.getAttribute('href') : null;
  // input that would leave the page (the state must be entered in place): a link to another document, a form submit
  const leaves = href && !/^(#|javascript:)/i.test(href.trim()) ? `navigates (a[href=${href.slice(0, 60)}])`
    : (el.form && (el.type === 'submit' || el.type === 'image')) ? 'submits a form' : null;
  return { k: keyOf(el), sig: [el.localName, el.getAttribute('role') || '', [...el.classList].filter(c => !STATEY.test(c)).sort().join('.')].join('|'),
    label: (el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 50),
    visible: b.width > 0 && b.height > 0 && cs.visibility !== 'hidden', disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true', leaves };
}

/**
 * JS-state candidates from event listeners (stage D2b): CDP DOMDebugger.getEventListeners on every element of the
 * main document. An element with its own click / pointer / key / focus / hover listener can change state on input
 * even with no ARIA/HTML hint (a script toggling a class or data attribute). Elements the ARIA/HTML scan already
 * found, and components (same signature) it already represents, are not candidates again. Listeners on document /
 * window (framework event delegation) cannot be tied to an element: reported as `delegated`, not exercised.
 * Returns {cands, excluded: [{k, sig, events, reason}], delegated: {target: [types]}, scanned}.
 */
export async function listenerCandidates(context, page, ariaCands) {
  const cdp = await context.newCDPSession(page);
  try {
    const ariaKeys = new Set(ariaCands.map(c => c.k));
    const ariaSig = new Map(ariaCands.map(c => [c.sig.slice(c.sig.indexOf('|') + 1), c.how]));
    const relevant = ls => [...new Set(ls.map(l => l.type).filter(t => LISTENER_KINDS[t]))];
    const delegated = {};
    for (const [name, expr] of [['window', 'window'], ['document', 'document'], ['html', 'document.documentElement'], ['body', 'document.body']]) {
      const { result } = await cdp.send('Runtime.evaluate', { expression: expr });
      if (!result.objectId) continue;
      const { listeners } = await cdp.send('DOMDebugger.getEventListeners', { objectId: result.objectId, depth: 0 });
      const ev = relevant(listeners);
      if (ev.length) delegated[name] = ev;
    }
    const { result: arr } = await cdp.send('Runtime.evaluate', { expression: `[...document.body.querySelectorAll('*')]` });
    const { result: props } = await cdp.send('Runtime.getProperties', { objectId: arr.objectId, ownProperties: true });
    const els = props.filter(p => /^\d+$/.test(p.name) && p.value?.objectId).map(p => p.value.objectId);
    const cands = [], excluded = [];
    for (const objectId of els) {
      const { listeners } = await cdp.send('DOMDebugger.getEventListeners', { objectId, depth: 0 });
      const events = relevant(listeners);
      if (!events.length) continue;
      const { result } = await cdp.send('Runtime.callFunctionOn', { objectId, functionDeclaration: String(describeListenerTarget), returnByValue: true });
      const d = result.value;
      if (!d?.k || ariaKeys.has(d.k)) continue;
      const kinds = [...new Set(events.map(t => LISTENER_KINDS[t]))];
      // one input per candidate: click covers pointer/mouse/touch; else key, focus, hover in that order
      const kind = ['click', 'key', 'focus', 'hover'].find(x => kinds.includes(x));
      const row = { k: d.k, sig: `listener:${kind}|${d.sig}`, events };
      if (d.leaves) { excluded.push({ ...row, reason: d.leaves }); continue; }
      if (ariaSig.has(d.sig)) { excluded.push({ ...row, reason: `same component as the ${ariaSig.get(d.sig)} candidate (one representative per component)` }); continue; }
      cands.push({ k: d.k, how: `listener:${kind}`, sig: row.sig, label: d.label, visible: d.visible, disabled: d.disabled, harness: false, events });
    }
    await cdp.send('Runtime.releaseObjectGroup', { objectGroup: '' }).catch(() => {});
    return { cands, excluded, delegated, scanned: els.length };
  } finally { await cdp.detach().catch(() => {}); }
}

/** In-page: interaction pseudo-classes present now (left by real input), to re-apply to a rebuild via CDP. */
export function inPageInteraction({ find }) {
  void find;
  const SKIP = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'TEMPLATE', 'BASE', 'TITLE', 'HEAD']);
  const keyOf = el => { const parts = []; for (let e = el; e; ) { if (e === document.documentElement) { parts.unshift('html'); return parts.join('/'); } const p = e.parentElement; if (!p) return null; let n = 0; for (const c of p.children) { if (SKIP.has(c.tagName.toUpperCase())) continue; if (c.localName === e.localName) n++; if (c === e) break; } parts.unshift(`${e.localName}[${n}]`); e = p; } return null; };
  const m = new Map();
  for (const pc of ['hover', 'active', 'focus', 'focus-visible', 'focus-within']) for (const el of document.querySelectorAll(':' + pc)) {
    if (el === document.documentElement && pc !== 'focus-within') continue;
    const k = keyOf(el); if (!k) continue;
    if (!m.has(k)) m.set(k, []); m.get(k).push(pc);
  }
  return [...m].map(([k, pc]) => ({ k, pc }));
}

/** Pure: greedy set cover. states: Map(stateKey -> {targets, rules:Set}). Returns chosen keys (max n). */
export function coverStates(states, max = 60) {
  const left = new Set(); for (const s of states.values()) for (const r of s.rules) left.add(r);
  const chosen = [];
  while (left.size && chosen.length < max) {
    let best = null, bn = 0;
    for (const [key, s] of states) { if (chosen.includes(key)) continue; let n = 0; for (const r of s.rules) if (left.has(r)) n++; if (n > bn || (n === bn && n > 0 && best && s.visible && !states.get(best).visible)) { best = key; bn = n; } }
    if (!best) break;
    chosen.push(best); for (const r of states.get(best).rules) left.delete(r);
  }
  return { chosen, uncovered: [...left] };
}

/** Pure: state-candidate (rule, element) pairs from a table: `st` ids and `~pseudo` ids per element. */
export function statePairs(table) {
  const pairs = [];
  for (const e of table.els) {
    for (const id of e.st || []) pairs.push({ rid: id, sel: table.rules[id].full || table.rules[id].sel, k: e.k });
    for (const [pk, ids] of Object.entries(e.pe || {})) if (pk.startsWith('~')) for (const id of ids) pairs.push({ rid: id, sel: table.rules[id].full || table.rules[id].sel, k: e.k, pe: pk.slice(1) });
  }
  return pairs;
}

/** Pure: CSS state plan from resolved pairs. One state = a set of (element, pseudo-classes) targets. */
export function planCssStates(table, resolved, { max = 60, visibleKeys = new Set() } = {}) {
  const states = new Map(), unforceable = {}, unresolved = {};
  for (const x of resolved) {
    if (!x.targets) { (unresolved[x.rid] || (unresolved[x.rid] = [])).push(x.why); continue; }
    const bad = x.targets.flatMap(t => t.pc.filter(p => !FORCEABLE.includes(p)));
    if (bad.length) { const u = unforceable[x.rid] || (unforceable[x.rid] = new Set()); for (const b of bad) u.add(b); continue; }
    const key = JSON.stringify(x.targets.map(t => [t.k, t.pc]).sort());
    let s = states.get(key);
    if (!s) states.set(key, (s = { targets: x.targets, rules: new Set(), visible: x.targets.every(t => visibleKeys.has(t.k)) }));
    s.rules.add(x.rid);
  }
  const { chosen, uncovered } = coverStates(states, max);
  const list = chosen.map((key, i) => ({ id: `c${i + 1}`, kind: 'css', targets: states.get(key).targets, rules: [...states.get(key).rules], visible: states.get(key).visible }));
  return { states: list, candidates: states.size, uncovered, unforceable: Object.fromEntries(Object.entries(unforceable).map(([k, v]) => [k, [...v]])), unresolved };
}

/** Pure: JS state plan: one representative per component signature (visible, enabled first). */
export function planJsStates(cands, { max = 8 } = {}) {
  const groups = new Map();
  for (const c of cands) { if (!groups.has(c.sig)) groups.set(c.sig, []); groups.get(c.sig).push(c); }
  const states = [], skipped = [];
  for (const [sig, list] of groups) {
    const rep = list.find(c => c.visible && !c.disabled) || (list[0].harness ? list[0] : null);
    if (!rep) { skipped.push({ sig, n: list.length, why: 'no visible enabled member' }); continue; }
    if (states.length >= max) { skipped.push({ sig, n: list.length, why: `cap ${max}` }); continue; }
    const id = `j${states.length + 1}`;
    const find = `(${findByKey})`;
    const action = rep.harness
      ? [{ eval: `${find}(${JSON.stringify(rep.k)}).${rep.how === 'dialog' ? 'showModal' : 'showPopover'}()` }]
      : rep.how === 'listener:hover' ? [{ hover: rep.k }]
      : rep.how === 'listener:focus' ? [{ focus: rep.k }]
      : rep.how === 'listener:key' ? [{ focus: rep.k }, { press: 'Enter' }]
      : [{ click: rep.k }];
    states.push({ id, kind: 'js', how: rep.how, k: rep.k, label: rep.label, harness: rep.harness, actions: action, sameComponent: list.filter(c => c !== rep).map(c => c.k), ...(rep.events ? { events: rep.events } : {}) });
  }
  return { states, skipped };
}

/** runActions adapter over a gate session (fixed clock). Input is real (CDP mouse/keyboard via Playwright). */
export function gateDriver(page) {
  const box = async k => page.evaluate(([f, k]) => { const el = (0, eval)('(' + f + ')')(k); if (!el) return null; const anc = []; for (let a = el.parentElement; a && a !== document.documentElement && a !== document.body; a = a.parentElement) anc.push([a, a.scrollLeft, a.scrollTop]); el.scrollIntoView({ block: 'center', inline: 'nearest' }); for (const [a, x, y] of anc) { a.scrollLeft = x; a.scrollTop = y; } const r = el.getBoundingClientRect(); const x = r.x + r.width / 2, y = r.y + r.height / 2; const top = document.elementFromPoint(x, y); return { x, y, hit: !!top && (top === el || el.contains(top)) }; }, [String(findByKey), k]);
  const log = [];
  return {
    log,
    // a page's own timer exception is recorded, not fatal (run.js pageTimerError, L7)
    hold: async ms => { try { await page.clock.runFor(ms); } catch (e) { if (!(await pageTimerError(page, e, null))) throw e; } },
    scrollTo: y => page.evaluate(v => scrollTo({ left: 0, top: v, behavior: 'instant' }), y),
    ev: (fn, arg) => page.evaluate(fn, arg),
    // dom-click fallback: an SVG element has no click() (a corpus WebGL map app: "click is not a function"), it gets the same event
    async click(k) { const b = await box(k); if (!b) throw new Error('click target not found ' + k); await frames(page, 2); if (b.hit) await page.mouse.click(b.x, b.y); else await page.evaluate(([f, k]) => { const el = (0, eval)('(' + f + ')')(k); if (typeof el.click === 'function') el.click(); else el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, view: window })); }, [String(findByKey), k]); log.push({ click: k, via: b.hit ? 'mouse' : 'dom-click (point obscured)' }); },
    async hover(k) { const b = await box(k); await page.mouse.move(b.x, b.y); log.push({ hover: k }); },
    async focus(k) { await page.evaluate(([f, k]) => (0, eval)('(' + f + ')')(k).focus(), [String(findByKey), k]); log.push({ focus: k }); },
    async press(key) { await page.keyboard.press(key); log.push({ press: key }); },
  };
}

async function settle(page, js) {
  if (js) { await page.evaluate(finishFiniteAnimations); await advance(page, null, 1000); await page.evaluate(finishFiniteAnimations); await advance(page, null, 300); }
  // real frames (rAF kept before the fake clock, run.js), not a real-time sleep: the page's own rAF is on the paused clock
  await page.evaluate(finishFiniteAnimations);
  await page.evaluate(freezeMedia);
  await frames(page, 2);
  await page.evaluate(finishFiniteAnimations);
}

/** Wait (2 s cap, real time: the fake clock is paused in original sessions, so no in-page timer) until no <img>
 *  request is in flight, then decode the complete ones. Measured on a real site (tab state): a photo the click
 *  revealed was still loading at the snapshot in some original sessions and painted in others (identity failed in 1 of
 *  2 runs); every session now waits the same way. Deferred lazy images (no request yet: currentSrc '') are not waited for. */
export async function imagesInFlight(page, capMs = 2000) {
  const t0 = Date.now();
  let busy = 0;
  do { busy = await page.evaluate(() => [...document.images].filter(i => !i.complete && i.currentSrc).length); if (!busy) break; await sleep(50); } while (Date.now() - t0 < capMs);
  await page.evaluate(() => Promise.all([...document.images].filter(i => i.complete && i.naturalWidth).map(i => i.decode().catch(() => {}))));
  return busy;
}

/** CDP pseudo-state forcing by oracle key; returns a clear() function. A target the page replaced between lookup and
 *  forcing ("Could not find node with given id") is looked up again once; a target that is still gone, or not found, is
 *  SKIPPED and recorded in `skipped` ({k, reason}) instead of failing the step: the state is then taken without it, the
 *  same way in every run that meets the same page, and the skip is listed in the state row and the verdict. */
export async function forceStates(css, page, targets, skipped = []) {
  const forced = [];
  // DOM.getDocument resets the agent's node ids (and with them forced states): once per session only
  if (!css.docFetched) { await css.cdp.send('DOM.getDocument', { depth: 0 }); css.docFetched = true; }
  const resolve = async k => {
    // a target that a script is just re-rendering (lazy images, carousels) can be absent for a moment: retry briefly
    // (corpus F25: found only after a 39-minute step)
    let objectId = null;
    for (let i = 0; i < 4 && !objectId; i++) {
      if (i) await sleep(250);
      objectId = (await css.cdp.send('Runtime.evaluate', { expression: `(${findByKey})(${JSON.stringify(k)})` })).result?.objectId;
    }
    return objectId ? (await css.cdp.send('DOM.requestNode', { objectId })).nodeId : null;
  };
  for (const t of targets) {
    const classes = t.pc.filter(p => FORCEABLE.includes(p));
    let done = false, why = null;
    for (let attempt = 0; attempt < 2 && !done; attempt++) {
      try {
        const nodeId = await resolve(t.k);
        if (!nodeId) { why = 'element not found (the page removed or replaced it)'; break; }
        await css.cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: classes });
        forced.push(nodeId); done = true;
      } catch (e) {
        if (!isGoneError(e)) throw e;
        why = `node replaced by the page while forcing (${attempt ? 'after one re-lookup' : 'looking up again'})`;
        await sleep(250);
      }
    }
    if (!done) skipped.push({ k: t.k, reason: why });
  }
  return async () => { for (const nodeId of forced) await css.cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] }).catch(() => {}); };
}

/** Rule usage delta since the last call, as base-table rule ids (local table L tags this session's sheets). */
async function usageDelta(css, L, base, texts) {
  const { coverage } = await css.cdp.send('CSS.takeCoverageDelta');
  const owner = await sheetIdsByOwner(css);
  const per = new Map();
  for (const u of coverage) { const sid = owner.get(u.styleSheetId); if (sid == null) continue; if (!per.has(u.styleSheetId)) per.set(u.styleSheetId, { sid, usage: [] }); per.get(u.styleSheetId).usage.push(u); }
  const perSheet = [];
  for (const [id, x] of per) { if (!texts.has(id)) texts.set(id, await sheetText(css, id)); if (texts.get(id) == null) continue; perSheet.push({ ...x, text: texts.get(id) }); } // null: sheet removed (F9)
  const clone = { rules: L.rules.map(r => ({ ...r })) };
  attachUsage(clone, perSheet);
  // same page, same walk: sheets line up by (scope, position); hrefs are not used (a served fixture's origin varies)
  const key = (T, r) => { const sh = T.sheets[r.sheet]; const pos = T.sheets.filter(x => x.scope === sh.scope).indexOf(sh); return `${sh.scope}|${pos}|${r.seq}`; };
  const bmap = new Map(base.rules.filter(r => r.t === 'style').map(r => [key(base, r), r.id]));
  const used = [], unmapped = [];
  for (const r of clone.rules) if (r.t === 'style' && r.used === true) { const b = bmap.get(key(L, r)); if (b != null) used.push(b); else unmapped.push(r.sel.slice(0, 80)); }
  const unmappedSheets = coverage.filter(u => !owner.has(u.styleSheetId)).length;
  return { used, unmapped, unmappedSheets };
}

const ptState = (pt, sid) => (sid ? `${pt.id}~${sid}` : pt.id);

/**
 * The browser a state session of (run, cls) runs in (S-SPEED #1). One session at a time per (run, cls), which is all the
 * sequential suite ever has, gets the run's pooled browser (a fresh context), as before. A session that starts while
 * another of the same (run, cls) is open launches a browser of its own (the WR_GATE_POOL=0 path: same flags and context
 * options), so no page ever shares a browser with another live page (the gate brings every page to the front because a
 * page that is not frontmost can get no compositor frames, CFT 147 / macOS: two live pages in one browser are not proven
 * safe). Different runs never share a browser either way. REVA_STATES_LANES=0: every session of (run, cls) takes a
 * context in the one pooled browser. Concurrent suite (ctx.concurrent): never pooled, see the F1 note below. Returns {pool, release()}.
 */
export function sessionBrowser(ctx, run, cls, env = process.env) {
  if (!ctx.pools) return { pool: null, release() {} };
  // F1 (27 Oct final review): concurrent sessions never take a pooled browser. A pool's browser stays open, idle, until the
  // commit loop ends its run, so it would be a live Chrome the lease (step + gate slots) does not count. With every session
  // on its own browser, live browsers = live sessions <= the slots. Sequential (REVA_STATES_PAR=1, a budget, rescore): pooled as before.
  if (ctx.concurrent && env.REVA_STATES_LANES !== '0') return { pool: null, release() {} };
  const k = `${run}|${cls}`, busy = ctx.poolBusy || (ctx.poolBusy = new Map());
  if ((busy.get(k) || 0) > 0 && env.REVA_STATES_LANES !== '0') return { pool: null, release() {} };
  busy.set(k, (busy.get(k) || 0) + 1);
  let done = false;
  return { pool: ctx.pools.get(k), release() { if (!done) { done = true; busy.set(k, busy.get(k) - 1); } } };
}

/**
 * One session of one run over a class: run in o1/o2/o3 (original replays), cap (original; state tables), cov
 * (original, rule-usage tracked), rb (rebuild). group = {kind:'css', states} | {kind:'js', state}.
 */
async function stateSession(site, run, cls, group, pts, ctx) {
  return inSlot(() => stateSessionInner(site, run, cls, group, pts, ctx));
}
async function stateSessionInner(site, run, cls, group, pts, ctx) {
  const dir = path.join(ctx.out, run);
  fs.mkdirSync(dir, { recursive: true });
  const isRb = run === 'rb', isCov = run === 'cov', isCap = run === 'cap';
  const key = group.kind === 'css' ? cls : `${cls}~${group.state.id}`;
  const artifact = isRb ? ctx.artifacts[key] : null;
  const meta = { cls: key, points: {}, states: {} };
  const br = sessionBrowser(ctx, run, cls);
  let s;
  try { s = await openSession(site, cls, { artifact, beforeGoto: isCov ? async h => { const css = await openCss(h.context, h.page); await startRuleUsage(css); return css; } : null, pool: br.pool }); }
  catch (e) { br.release(); throw e; }
  meta.clockLateMs = s.clockLateMs || 0; meta.installLateMs = s.installLateMs || 0;
  const page = s.h.page;
  // F6: a failed openCss closes the session's browser too (in a lane that is a whole Chrome), then frees the slot
  const css = s.capState || await openCss(s.h.context, page).catch(async e => { try { await s.h.close(); } catch {} br.release(); throw e; });
  const texts = new Map();
  let L = null;
  const shot = async (id, clip) => {
    await page.bringToFront().catch(() => {});
    // an empty clip, or one entirely outside the page (the page is shorter than where the original's changed rows were): skip this point, say why
    const bad = clipProblem(clip, await page.evaluate(pageSize));
    if (bad) { markNoShot(dir, id, bad); (meta.shotSkipped || (meta.shotSkipped = {}))[id] = bad; return; }
    try { await fs.promises.writeFile(path.join(dir, `${id}.png`), await page.screenshot({ fullPage: true, scale: 'css', animations: 'disabled', caret: 'hide', ...(clip ? { clip } : {}) })); }
    catch (e) { if (!isClipError(e)) throw e; const why = `screenshot: ${String(e.message).split('\n')[0]}`; markNoShot(dir, id, why); (meta.shotSkipped || (meta.shotSkipped = {}))[id] = why; }
  };
  const snap = async id => { await imagesInFlight(page); if (run === 'o1') (meta.imgs || (meta.imgs = {}))[id] = await page.evaluate(loadedImages); const sn = await takeSnapshot(page, { live: site.live }); await gzWrite(path.join(dir, `${id}.json.gz`), sn); if (!isRb) { const sw = await collectWrites(page, null); if (sw) await gzWrite(path.join(dir, `sw-${id}.json.gz`), sw); } return sn; };
  const toPt = async pt => { await page.setViewportSize({ width: pt.w, height: pt.h }); await frames(page, 2); if (s.js) { await page.evaluate(finishFiniteAnimations); await advance(page, s.flight, 1000); } await page.evaluate(freezeMedia); await page.evaluate(() => document.fonts.ready); await page.evaluate(() => Promise.all([...document.images].filter(i => i.complete && i.naturalWidth).map(i => i.decode().catch(() => {})))); };
  const net = () => ({ req: s.requests.length, miss: s.net.misses.length });
  const netSince = n0 => ({ requests: s.requests.slice(n0.req).map(r => `${r.type} ${r.url}`).slice(0, 30), newRequests: s.requests.length - n0.req, misses: s.net.misses.slice(n0.miss).slice(0, 20), missN: s.net.misses.length - n0.miss });
  try {
    if (group.kind === 'css') {
      // time budget (o1 only): the states are in plan order (most valuable first); at the first point that takes states the
      // loop stops once the cut time has passed, and the other points repeat exactly the states finished there. The caller drops
      // the rest from every later run (meta.cssDone), so all runs compare the same state set.
      const cut = run === 'o1' ? ctx.cssCut?.[cls] : null;
      const done = new Set();
      let frozen = null;
      for (const pt of pts) {
        if (s.js) await page.evaluate(ph => { if (window.__wrSW) window.__wrSW.phase = ph; }, `pt:${pt.id}`);
        await toPt(pt);
        if (isRb) meta.points[pt.id] = { prepared: await ctx.prepare(page, pt, null, css) };
        if (!isCov) { await snap(pt.id); await shot(pt.id); }
        if (run === 'o1' && pt.kind === 'captured') fs.writeFileSync(path.join(dir, `sources-${cls}.json`), JSON.stringify(await page.evaluate(inPageSources)));
        if (isCov) { L = await captureRuleTable(page, css, { usage: false }); await css.cdp.send('CSS.takeCoverageDelta'); }
        const isStPt = (ctx.statePts[cls] || []).includes(pt.id);
        for (const st of group.states.filter(x => isStPt && (!frozen || frozen.has(x.id)))) {
          if (cut && !frozen && done.size && Date.now() > cut.at) break; // at least one state runs
          const id = ptState(pt, st.id);
          const n0 = net();
          if (isCov) await css.cdp.send('CSS.takeCoverageDelta');
          const forceSkipped = [];
          const clear = await forceStates(css, page, st.targets, forceSkipped);
          await settle(page, false);
          if (isCov) { meta.states[id] = { usage: await usageDelta(css, L, ctx.tables[cls], texts), ...(forceSkipped.length ? { forceSkipped } : {}) }; }
          else {
            const sn = await snap(id);
            let clip = ctx.clips?.[id];
            if (run === 'o1') { clip = clipFor(gzRead(path.join(dir, `${pt.id}.json.gz`)), sn, st.targets.map(t => t.k)); ctx.clips[id] = clip; }
            await shot(id, clip);
            meta.states[id] = { net: netSince(n0), ...(forceSkipped.length ? { forceSkipped } : {}) };
          }
          await clear();
          await settle(page, false);
          done.add(st.id);
        }
        if (cut && !frozen && isStPt) frozen = new Set(done);
      }
      if (cut) meta.cssDone = [...(frozen || done)];
    } else {
      const st = group.state;
      const [cap, ...rest] = pts;
      if (s.js) await page.evaluate(ph => { if (window.__wrSW) window.__wrSW.phase = ph; }, `pt:${cap.id}`);
      await toPt(cap);
      const id = ptState(cap, st.id);
      if (isRb) meta.points[id] = { prepared: await ctx.prepare(page, cap, st, css) };
      else {
        if (isCov) { L = await captureRuleTable(page, css, { usage: false }); await css.cdp.send('CSS.takeCoverageDelta'); }
        // the same session's state just before the input: the state's computed delta is taken against it
        if (run === 'o1') { await page.evaluate(ph => { if (window.__wrSW) window.__wrSW.phase = ph; }, `pre:${st.id}`); await gzWrite(path.join(dir, `${id}.pre.json.gz`), await takeSnapshot(page, { live: site.live })); }
        const n0 = net();
        const drv = gateDriver(page);
        await page.evaluate(ph => { if (window.__wrSW) window.__wrSW.phase = ph; }, `state:${st.id}`);
        await runActions(drv, st.actions);
        // the pointer leaves the page (no hover left behind by the click); focus stays as the input left it
        // (a hover state keeps the pointer where the input left it: moving away would end it)
        if (!st.actions.some(a => a.hover)) await page.mouse.move(-20, -20).catch(() => {});
        await settle(page, true);
        // the state at rest at the top of the page (snapshots are taken at scroll 0): the click scrolled its target
        // into view, so scroll-driven script (e.g. a sticky header class) and its transitions settle first
        // back up in steps, as the gate sweep does (scroll-linked script can be path dependent: a real site, D1b)
        for (let y = await page.evaluate(() => scrollY); y > 0; y -= 600) { await page.evaluate(v => scrollTo({ left: 0, top: v, behavior: 'instant' }), Math.max(0, y - 600)); await frames(page, 2); await page.evaluate(finishFiniteAnimations); await advance(page, s.flight, 120); }
        await frames(page, 3);
        await settle(page, true);
        await page.evaluate(ph => { if (window.__wrSW) window.__wrSW.phase = ph; }, `pt:${id}`);
        meta.states[id] = { actions: drv.log, net: netSince(n0), interaction: await page.evaluate(inPageInteraction, { find: '' }), scrolls: await page.evaluate(innerScrolls) };
        if (isCov) meta.states[id].usage = await usageDelta(css, L, ctx.tables[cls], texts);
        if (isCap) { const t = await captureRuleTable(page, css, { usage: false }); t.state = { id: st.id, actions: st.actions, interaction: meta.states[id].interaction, harness: !!st.harness }; fs.writeFileSync(path.join(dir, `table-${key}.json`), JSON.stringify(t)); saveRuntimeState(await captureRuntimeState(page), dir, key); }
      }
      if (!isCov && !isCap) { await snap(id); await shot(id); }
      for (const pt of rest) {
        const pid = ptState(pt, st.id);
        if (s.js) await page.evaluate(ph => { if (window.__wrSW) window.__wrSW.phase = ph; }, `pt:${pid}`);
        await toPt(pt);
        if (isRb) meta.points[pid] = { prepared: await ctx.prepare(page, pt, st, css) };
        if (isCov) { await css.cdp.send('CSS.takeCoverageDelta'); continue; }
        if (isCap) continue;
        if (run === 'o1') meta.states[pid] = { ...(meta.states[pid] || {}), scrolls: await page.evaluate(innerScrolls) };
        await snap(pid); await shot(pid);
      }
    }
  } finally {
    meta.misses = s.net.misses.length; meta.missSample = s.net.misses.slice(0, 5); meta.requests = s.requests; meta.scriptsBlocked = !s.js ? `csp: ${NO_SCRIPT_CSP}` : null;
    if (!s.capState) await css.close().catch(() => {}); else await s.capState.close().catch(() => {});
    try { await s.h.close(); } finally { br.release(); } // F6: the slot is freed even when close throws
  }
  fs.writeFileSync(path.join(dir, `meta-${key}.json`), JSON.stringify(meta));
  return meta;
}

/** Pure: screenshot clip for a CSS state: full width, rows spanning every element whose box or style changed
 *  between base and state (same session) plus the targets, padded; clamped to the page. */
export function clipFor(base, state, targetKeys, pad = 24) {
  const d = compareSnapshots(base, state, { maxDetail: 100000 });
  const keys = new Set([...d.misses.map(m => m.k), ...targetKeys]);
  let y0 = Infinity, y1 = -Infinity;
  for (const e of state.els) if (keys.has(e.k) && e.b[3] > 0) { y0 = Math.min(y0, e.b[1]); y1 = Math.max(y1, e.b[1] + e.b[3]); }
  if (!Number.isFinite(y0)) return { x: 0, y: 0, width: state.vw, height: Math.min(state.docH, state.vh) };
  const top = Math.max(0, Math.floor(y0 - pad)), bot = Math.min(state.docH, Math.ceil(y1 + pad));
  return { x: 0, y: top, width: state.vw, height: Math.max(1, bot - top) };
}

/** Pure: per state rule coverage for one class. */
export function stateCoverage(table, plan, exercisedBy) {
  const STATE_SEL = /:(hover|focus-visible|focus-within|focus|active|target|popover-open|modal|fullscreen|checked|disabled|enabled|invalid|valid|user-invalid|user-valid|placeholder-shown|open|closed|indeterminate|visited|autofill|-webkit-autofill)(?![\w-])|\[(aria-(expanded|selected|checked|pressed|current|hidden)|open|data-state)[^\]]*\]/;
  const rows = [];
  const cov = table.coverage;
  // rules with at least one candidate element (state-free selector matched something at the captured point)
  const candidates = new Set([...plan.css.states.flatMap(s => s.rules), ...Object.keys(plan.css.unforceable).map(Number), ...Object.keys(plan.css.unresolved).map(Number), ...plan.css.uncovered]);
  for (const u of cov.unused) {
    if (!u.why.includes('state')) continue;
    const by = exercisedBy.get(u.id);
    if (by) { rows.push({ id: u.id, sel: u.sel, ctx: u.ctx, status: 'exercised', by: [...by] }); continue; }
    let reason;
    if (u.why.some(w => ['media-inactive', 'supports-false', 'container'].includes(w))) reason = `condition inactive in this class (${u.why.filter(w => w !== 'state').join(',')})`;
    else if (u.why.includes('no-element')) reason = 'no element on this page matches the selector without its state part (dead CSS here)';
    else if (plan.css.unforceable[u.id]) reason = `needs ${plan.css.unforceable[u.id].map(p => ':' + p).join(',')} (not forceable) and no discovered JS state entered it`;
    else if (plan.css.unresolved[u.id]) reason = `state target could not be resolved (${[...new Set(plan.css.unresolved[u.id])].join(',')})`;
    else if (plan.css.uncovered.includes(u.id)) reason = 'candidate state over the per-class cap (not exercised)';
    else if (plan.css.states.some(s => s.rules.includes(u.id))) reason = 'forced, but the engine did not use the rule (overridden / other condition false)';
    else if (/\[(aria-|open|data-)/.test(u.sel) || /:(checked|disabled|enabled|invalid|valid|placeholder-shown|open|closed|indeterminate)/.test(u.sel)) reason = 'attribute / form state: no discovered JS state reached it (needs another trigger, e.g. auth, form input, server data)';
    else if (/::?(-webkit-|-moz-)/.test(u.sel) || /:lang\(/.test(u.sel)) reason = 'vendor / language condition not met on this page';
    else if (!candidates.has(u.id)) reason = 'no element on this page matches the selector without its state part (dead CSS here)';
    else reason = STATE_SEL.test(u.sel) ? 'state part not reached by any exercised state' : 'listed as state by matching only';
    rows.push({ id: u.id, sel: u.sel, ctx: u.ctx, status: 'not-exercised', reason });
  }
  const counts = {}; for (const r of rows) { const k = r.status === 'exercised' ? 'exercised' : r.reason.split(' (')[0].split(':')[0]; counts[k] = (counts[k] || 0) + 1; }
  return { stateRules: rows.length, exercised: rows.filter(r => r.status === 'exercised').length, counts, rows };
}

/** Pure: JS-state candidate coverage (D2b) from a JS plan: every candidate component, by source (aria/html or
 *  listener), exercised (state id) or listed with the reason; listener elements excluded before planning and
 *  document/window listeners (delegation, no element to drive) are listed too. */
export function jsCoverage(js) {
  const src = how => (how.startsWith('listener:') ? 'listener' : 'aria/html');
  const rows = [];
  for (const st of js.states) rows.push({ sig: `${st.how}|${st.k}`, source: src(st.how), how: st.how, k: st.k, label: st.label, n: 1 + st.sameComponent.length, status: 'exercised', by: st.id, ...(st.events ? { events: st.events } : {}) });
  for (const sk of js.skipped) rows.push({ sig: sk.sig, source: src(sk.sig), how: sk.sig.split('|')[0], n: sk.n, status: 'not-exercised', reason: sk.why });
  const L = js.listeners || { excluded: [], delegated: {} };
  for (const x of L.excluded) rows.push({ sig: x.sig, source: 'listener', how: x.sig.split('|')[0], k: x.k, n: 1, events: x.events, status: 'not-exercised', reason: x.reason });
  for (const [target, events] of Object.entries(L.delegated)) rows.push({ sig: `delegated|${target}`, source: 'listener', how: 'delegated', k: target, n: 1, events, status: 'not-exercised', reason: 'listener on document/window (event delegation): no element to drive from the listener alone' });
  const by = f => { const o = {}; for (const r of rows.filter(f)) { const key = r.status === 'exercised' ? 'exercised' : r.reason.split(' (')[0]; o[key] = (o[key] || 0) + 1; } return o; };
  return { scanned: L.scanned ?? null, listenerCandidates: L.candidates ?? 0, exercised: rows.filter(r => r.status === 'exercised').length, rows: rows.length,
    bySource: { 'aria/html': by(r => r.source === 'aria/html'), listener: by(r => r.source === 'listener') }, list: rows };
}

/** Base rule tables when no D1 suite output is at hand: the D1 cap (untracked) + cov (tracked) replays at the
 *  captured points, usage merged, as runCaptureSuite does. Returns {cls: table}. */
export async function captureBaseTables(site, capPts, dir, log = () => {}) {
  await captureRun(site, capPts, path.join(dir, 'cap'), { capture: ruleTableCapture(), log });
  await captureRun(site, capPts, path.join(dir, 'cov'), { capture: ruleTableCapture({ usage: true }), log });
  const tables = {};
  for (const p of capPts) {
    const t = JSON.parse(fs.readFileSync(path.join(dir, 'cap', `table-${p.cls}.json`), 'utf8'));
    mergeUsage(t, JSON.parse(fs.readFileSync(path.join(dir, 'cov', `table-${p.cls}.json`), 'utf8')));
    tables[p.cls] = t;
  }
  return tables;
}

/**
 * Run the D2 states suite. tables: {cls: base rule table (with coverage)} (from the D1 suite: cap/table-<cls>.json).
 * points: the suite's test points; held: {cls: pointId} held-out point per class (default: the held-out point of the
 * class farthest in width from its captured point); basePoints: extra point ids visited in the base state (to check
 * script-owned replays). capFloor: {cls: px} measured noise per class from the D1 suite (identical replays).
 */
/** Pure: why a JS state's session failed, as a short reason (the state is skipped, the suite goes on). */
export function jsFailReason(e) {
  const m = String(e?.message || e).split('\n')[0].slice(0, 200);
  if (/Execution context was destroyed|navigation|Target (page|closed)/i.test(m)) return `navigated: ${m}`;
  if (/click target not found/.test(m)) return m;
  if (/is not a function/.test(m)) return `not clickable: ${m}`;
  return `error: ${m}`;
}

/**
 * The replays of the states suite per class, in order (26 Oct S14, data first in every mode): o1 (every state's values,
 * the clips, the pre-input snapshots) and cov (rule usage; state-coverage-<cls>.json is written right after it, L3) are
 * the data. o2/o3 (noise + identity), cap (the JS states' rule tables, read only by the rebuild) and rb (the rebuild) only
 * verify. verify 'data' (deep mode ก) stops after the data: plan + o1 + cov, no scoring.
 * @param {'full'|'data'} verify
 * @returns {{data:string[], verification:string[]}}
 */
export function statesRunPlan(verify = 'full') {
  return { data: ['o1', 'cov'], verification: verify === 'data' ? [] : ['o2', 'o3', 'cap', 'rb'] };
}

/**
 * S-SPEED #1 (27 Oct): may a class's state sessions run side by side? Not with a time budget (its cuts read the clock
 * between sessions, so the state set would depend on timing), not on a rescore (no sessions), not with REVA_STATES_PAR=1
 * (the old one-session-at-a-time order).
 */
export const statesConcurrent = ({ budgetMs = null, rescore = false, env = process.env } = {}) => env.REVA_STATES_PAR !== '1' && !budgetMs && !rescore;

/**
 * Pure: the sessions of one class for the runs `runs` (statesRunPlan order, rb excluded), in the order the sequential
 * suite runs them (the canonical order: per run, the CSS session then every JS state in plan order; `cap` has no CSS
 * session), each with `after` = indexes of the sessions it must wait for. Everything not ordered by `after` may overlap.
 *  - CSS o2 / o3 after CSS o1: o1 records the clips o2/o3 shoot with (ctx.clips).
 *  - CSS cov: no order (it reads only the base table); the time-budget cut that made it wait for o1 is never concurrent.
 *  - JS (run k, state s) after JS (run k-1, state s): a state whose session fails is dropped and its later runs never
 *    start (jsFailReason). A state is dropped only by its own sessions, so this chain gives exactly the sequential
 *    suite's state sets, files and skip reasons. In data mode that is cov after o1 of the same state; o1 and cov of
 *    different states, and every CSS session, overlap.
 * Sessions of different classes never wait for each other (they never did: the classes ran side by side).
 * @param {{runs:string[], jsIds:string[]}} o
 * @returns {{run:string, kind:'css'|'js', id:string|null, name:string, after:number[]}[]}
 */
export function statesSessionPlan({ runs, jsIds }) {
  const list = [], at = new Map(); // `${run}|${kind}|${id}` -> index
  for (const run of runs) {
    if (run === 'rb') continue;
    if (run !== 'cap') {
      const after = (run === 'o2' || run === 'o3') && at.has('o1|css|') ? [at.get('o1|css|')] : [];
      at.set(`${run}|css|`, list.length); list.push({ run, kind: 'css', id: null, name: `${run}-css`, after });
    }
    for (const id of jsIds) {
      const prev = runs.slice(0, runs.indexOf(run)).reverse().find(x => x !== 'rb' && at.has(`${x}|js|${id}`));
      at.set(`${run}|js|${id}`, list.length); list.push({ run, kind: 'js', id, name: `${run}-${id}`, after: prev ? [at.get(`${prev}|js|${id}`)] : [] });
    }
  }
  return list;
}

/** Pure: true when sessions i and j of a statesSessionPlan may run at the same time (neither waits for the other). */
export function sessionsMayOverlap(plan, i, j) {
  const reaches = (from, to) => { const st = [from], seen = new Set(); while (st.length) { const x = st.pop(); if (x === to) return true; if (seen.has(x)) continue; seen.add(x); st.push(...plan[x].after); } return false; };
  return i !== j && !reaches(i, j) && !reaches(j, i);
}

/**
 * Run a class's sessions as statesSessionPlan orders them and commit the results in the canonical order (S-SPEED #1).
 * Sessions are ISSUED in the canonical order, each once the sessions it waits for have settled (the gate slots, FIFO,
 * bound how many run at once); the results are COMMITTED in the canonical order too, so every side effect the sequential
 * suite has between sessions (metas key order, r.steps key order, dropped states and their order, the coverage file
 * after the last cov session, pool closes and progress after each run) happens in the same order with the same inputs.
 * runOne(s) -> {meta, ms} (a skipped JS state: {skipped:true}; a failed one: {error}). commit(s, res) applies it.
 * endOfRun(run) is called for every run of `runs` in order, once its sessions are committed (a run with no session too,
 * as the sequential loop did). A failed CSS session stops new issues and is thrown once the commit order reaches it, after
 * the sessions already running have ended (the sequential suite threw there too).
 */
export async function runSessionPlan(plan, runs, { runOne, commit, endOfRun }) {
  const settled = plan.map(() => { let res; const p = new Promise(r => { res = r; }); return { p, res }; });
  let fatal = false;
  const issuing = (async () => {
    for (let i = 0; i < plan.length; i++) {
      await Promise.all(plan[i].after.map(j => settled[j].p));
      if (fatal) { settled[i].res({ notRun: true }); continue; }
      Promise.resolve().then(() => runOne(plan[i])).then(v => v, e => ({ error: e })).then(v => { if (v.error && plan[i].kind === 'css') fatal = true; settled[i].res(v); });
    }
  })();
  const order = runs.filter(x => x !== 'rb');
  let r = 0; // runs before order[r] have ended
  const endUpTo = async run => { const k = run == null ? order.length : order.indexOf(run); for (; r < k; r++) await endOfRun(order[r]); };
  for (let i = 0; i < plan.length; i++) {
    await endUpTo(plan[i].run);
    const v = await settled[i].p;
    if (v.notRun) continue;
    if (v.error && plan[i].kind === 'css') { await issuing.catch(() => {}); await Promise.all(settled.map(x => x.p)); throw v.error; }
    await commit(plan[i], v);
  }
  await endUpTo(null);
  await issuing;
}

export async function runStatesSuite(site, opts) {
  const pools = newGatePools();
  try { return await runStatesSuiteInner(site, opts, pools); } finally { await pools.closeAll(); }
}
async function runStatesSuiteInner(site, { points, tables, out, held = {}, basePoints = [], capFloor = {}, maxCss = 60, maxJs = 8, budgetMs = null, stateMutant = null, rescore = false, verify = 'full', captureCauses = [], log = console.log }, pools) {
  const runPlan = statesRunPlan(rescore ? 'full' : verify);
  const concurrent = statesConcurrent({ budgetMs, rescore });
  const t0 = Date.now();
  // time budget: no session starts after workEnd; the rest (scoring) fits in the remaining 12 %. Unfinished states are reported
  // skipped ('time budget'), never scored as passes.
  const workEnd = budgetMs ? t0 + budgetMs * 0.88 : Infinity;
  const skippedJs = {}, skippedCss = {};
  const progress = (phase, extra = {}) => { try { fs.writeFileSync(path.join(out, 'states-progress.json'), JSON.stringify({ phase, elapsedMs: Date.now() - t0, budgetMs, skippedJs, skippedCss, ...extra }, null, 1)); } catch {} };
  fs.mkdirSync(out, { recursive: true });
  const ctx = { out, tables, artifacts: {}, clips: {}, statePts: {}, prepare: null, cssCut: {} };
  const r = { site: site.id, steps: {}, classes: {} };
  const classes = Object.keys(tables);
  const ptsOf = {};
  for (const cls of classes) {
    const cp = points.find(p => p.cls === cls && p.kind === 'captured');
    const ho = points.filter(p => p.cls === cls && p.kind !== 'captured');
    const hp = held[cls] ? points.find(p => p.id === held[cls]) : ho.sort((a, b) => Math.abs(b.w - cp.w) - Math.abs(a.w - cp.w) || Math.abs(b.h - cp.h) - Math.abs(a.h - cp.h))[0];
    ptsOf[cls] = { cap: cp, held: hp, base: [cp, hp, ...points.filter(p => p.cls === cls && basePoints.includes(p.id) && p !== hp)].filter(Boolean) };
    ctx.statePts[cls] = [cp.id, hp?.id].filter(Boolean);
  }
  const step = async (name, fn) => { const t = Date.now(); const v = await fn(); r.steps[name] = (r.steps[name] || 0) + Date.now() - t; log(`step ${name} ${Date.now() - t}ms`); return v; };

  // ---- plan (live original page at the captured point) ----
  const plans = {};
  // F3: the viewport classes are independent; their sessions run side by side (bounded by the gate's session slots)
  await Promise.all(classes.map(async cls => {
    // rescore: plans and every session's output are read back from `out` (no browser); rule sets come back as arrays
    if (rescore) { plans[cls] = JSON.parse(fs.readFileSync(path.join(out, `plan-${cls}.json`), 'utf8')); return; }
    plans[cls] = await step(`plan-${cls}`, () => inSlot(async () => {
      const s = await openSession(site, cls);
      try {
        const page = s.h.page;
        const { cap } = ptsOf[cls];
        await page.setViewportSize({ width: cap.w, height: cap.h }); await frames(page, 2); await advance(page, s.flight, 1000);
        const pairs = statePairs(tables[cls]);
        const resolved = await page.evaluate(inPageStateTargets, { pairs, find: String(findByKey) });
        const vis = new Set(await page.evaluate(([f, ks]) => ks.filter(k => { const el = (0, eval)('(' + f + ')')(k); if (!el) return false; const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0; }), [String(findByKey), [...new Set(resolved.flatMap(x => (x.targets || []).map(t => t.k)))]]));
        const cssPlan = planCssStates(tables[cls], resolved, { max: maxCss, visibleKeys: vis });
        // JS states: ARIA/HTML hints first, then elements with their own input listeners (D2b) under the same cap
        const aria = await page.evaluate(inPageJsCandidates, { find: '' });
        const lis = await listenerCandidates(s.h.context, page, aria);
        const jsPlan = planJsStates([...aria, ...lis.cands], { max: maxJs });
        jsPlan.listeners = { scanned: lis.scanned, candidates: lis.cands.length, excluded: lis.excluded, delegated: lis.delegated };
        return { pairs: pairs.length, css: cssPlan, js: jsPlan };
      } finally { await s.h.close(); }
    }));
    fs.writeFileSync(path.join(out, `plan-${cls}.json`), JSON.stringify(plans[cls], null, 1));
    log(`plan ${cls}: pairs ${plans[cls].pairs}, css states ${plans[cls].css.states.length} (candidates ${plans[cls].css.candidates}, uncovered ${plans[cls].css.uncovered.length}, unforceable ${Object.keys(plans[cls].css.unforceable).length}), js ${plans[cls].js.states.map(s => s.how + ':' + s.label).join(' | ')}`);
  }));

  // ---- originals ----
  const metas = {};
  const M = (run, key) => metas[`${run}|${key}`];
  const setMeta = (run, key, m) => { metas[`${run}|${key}`] = m; };
  const covEnd = run => run === 'cov';
  const keysOf = cls => [cls, ...plans[cls].js.states.map(s => `${cls}~${s.id}`)];
  if (rescore) for (const cls of classes) for (const k of keysOf(cls)) for (const run of ['o1', 'o2', 'o3', 'cap', 'cov', 'rb']) { const f = path.join(out, run, `meta-${k}.json`); if (fs.existsSync(f)) metas[`${run}|${k}`] = JSON.parse(fs.readFileSync(f, 'utf8')); }
  // F3/F4: classes run side by side; inside a class the sessions go run by run (o1 for every state, then o2, ...): o1
  // must precede o2/o3/rb of the same state (it records the clips and the pre-input snapshots), and one pooled browser
  // per (run, class) serves all that run's sessions. Different runs never share a browser, so o1/o2/o3 stay independent.
  ctx.pools = pools; ctx.concurrent = concurrent;
  // the points scored per class (base + every planned state at its points), and what each point's cov session used
  const classPoints = cls => {
    const P = ptsOf[cls];
    const statePts = [];
    for (const st of plans[cls].css.states) for (const pid of ctx.statePts[cls]) { const p = points.find(x => x.id === pid); statePts.push({ ...p, id: ptState(p, st.id), state: st.id }); }
    for (const st of plans[cls].js.states) for (const p of [P.cap, P.held].filter(Boolean)) statePts.push({ ...p, id: ptState(p, st.id), state: st.id });
    return [...P.base, ...statePts];
  };
  const covUsage = (cls, p) => {
    const sid = p.state || null;
    const st = sid ? [...plans[cls].css.states, ...plans[cls].js.states].find(x => x.id === sid) : null;
    const mkey = st?.kind === 'js' ? `${cls}~${sid}` : cls;
    const covm = M('cov', mkey)?.states?.[p.id];
    const baseUnused = new Set(tables[cls].rules.filter(x => x.t === 'style' && x.used === false).map(x => x.id));
    const used = covm?.usage?.used || [];
    return { sid, st, mkey, covm, used, newly: used.filter(id => baseUnused.has(id)) };
  };
  // S10 (26 Oct): coverage needs only the cov sessions, so it is written as soon as a class's cov run ends; a step stopped
  // later (rebuild sessions, scoring) keeps it. Scoring below rewrites it (same numbers unless a JS state drops in rb).
  const covAfter = {};
  const writeCoverageAfterCov = cls => {
    try {
      const exercisedBy = new Map();
      for (const p of classPoints(cls)) { const u = covUsage(cls, p); for (const id of u.newly) { if (!exercisedBy.has(id)) exercisedBy.set(id, new Set()); exercisedBy.get(id).add(u.sid); } }
      const cov = stateCoverage(tables[cls], plans[cls], exercisedBy);
      cov.jsCandidates = jsCoverage(plans[cls].js);
      covAfter[cls] = cov;
      fs.writeFileSync(path.join(out, `state-coverage-${cls}.json`), JSON.stringify({ ...cov, stage: runPlan.verification.length ? 'after the cov run (rebuild not scored yet)' : 'after the cov run (deep data mode: final, no rebuild)' }, null, 1));
    } catch (e) { log(`state coverage ${cls} after cov: not written (${String(e.message).split('\n')[0]})`); }
  };
  await Promise.all((rescore ? [] : classes).map(async cls => {
    const P = ptsOf[cls];
    const css = run => step(`${run}-${cls}-css`, () => stateSession(site, run, cls, { kind: 'css', states: plans[cls].css.states }, run === 'cov' ? [P.cap, P.held].filter(Boolean) : P.base, ctx)).then(m => setMeta(run, cls, m));
    const dropJs = (st, reason) => { const i = plans[cls].js.states.indexOf(st); if (i < 0) return; plans[cls].js.states.splice(i, 1); (skippedJs[cls] || (skippedJs[cls] = [])).push({ id: st.id, how: st.how, label: st.label, reason }); log(`js state ${cls}~${st.id} skipped: ${reason}`); progress('running'); };
    let jsEnd = Infinity;
    const js = async (run, st) => {
      if (!plans[cls].js.states.includes(st)) return;
      if (Date.now() > workEnd || (run === 'o1' && Date.now() > jsEnd)) return dropJs(st, 'time budget');
      try { await step(`${run}-${cls}-${st.id}`, () => stateSession(site, run, cls, { kind: 'js', state: st }, [P.cap, P.held].filter(Boolean), ctx)).then(m => setMeta(run, `${cls}~${st.id}`, m)); }
      catch (e) { dropJs(st, jsFailReason(e)); } // one state's failed input (navigation, vanished target, ...) costs that state only
    };
    // S14: data first (statesRunPlan): o1, cov (+ coverage file), then o2, o3, cap; rb runs after every class below
    const runs = [...runPlan.data, ...runPlan.verification.filter(x => x !== 'rb')];
    const endOfRun = async run => { await pools.closeMatching(`${run}|${cls}`); if (covEnd(run)) { writeCoverageAfterCov(cls); progress(`cov-${cls}`); } else progress(run); };
    if (concurrent) {
      // S-SPEED #1: the same sessions, overlapped as statesSessionPlan allows, committed in the sequential order
      const byId = new Map(plans[cls].js.states.map(st => [st.id, st]));
      const failed = new Set();
      const plan = statesSessionPlan({ runs, jsIds: plans[cls].js.states.map(st => st.id) });
      await runSessionPlan(plan, runs, {
        runOne: async s => {
          const name = `${s.run}-${cls}-${s.kind === 'css' ? 'css' : s.id}`, t = Date.now();
          if (s.kind === 'css') { const meta = await stateSession(site, s.run, cls, { kind: 'css', states: plans[cls].css.states }, s.run === 'cov' ? [P.cap, P.held].filter(Boolean) : P.base, ctx); log(`step ${name} ${Date.now() - t}ms`); return { meta, ms: Date.now() - t }; }
          if (failed.has(s.id)) return { skipped: true };
          try { const meta = await stateSession(site, s.run, cls, { kind: 'js', state: byId.get(s.id) }, [P.cap, P.held].filter(Boolean), ctx); log(`step ${name} ${Date.now() - t}ms`); return { meta, ms: Date.now() - t }; }
          catch (e) { failed.add(s.id); return { error: e }; }
        },
        commit: async (s, v) => {
          if (v.skipped) return;
          const st = s.kind === 'js' ? byId.get(s.id) : null;
          if (v.error) return dropJs(st, jsFailReason(v.error));
          const name = `${s.run}-${cls}-${s.kind === 'css' ? 'css' : s.id}`;
          r.steps[name] = (r.steps[name] || 0) + v.ms;
          setMeta(s.run, s.kind === 'css' ? cls : `${cls}~${s.id}`, v.meta);
        },
        endOfRun,
      });
      return;
    }
    for (const run of runs) {
      if (run === 'cap') { for (const st of [...plans[cls].js.states]) await js('cap', st); await pools.closeMatching(`cap|${cls}`); progress(run); continue; }
      if (run === 'o1' && budgetMs) { const R = workEnd - Date.now(); ctx.cssCut[cls] = { at: Date.now() + R * 0.6 / 6 * 0.5 }; }
      const tc = Date.now();
      await css(run);
      if (run === 'o1') {
        const m = metas[`o1|${cls}`];
        if (m.cssDone && m.cssDone.length < plans[cls].css.states.length) {
          const keep = new Set(m.cssDone), all = plans[cls].css.states;
          skippedCss[cls] = all.filter(x => !keep.has(x.id)).map(x => ({ id: x.id, targets: x.targets.length, reason: 'time budget' }));
          plans[cls].css.states = all.filter(x => keep.has(x.id));
          plans[cls].css.budgetSkipped = skippedCss[cls].length;
          log(`css states ${cls}: ${plans[cls].css.states.length}/${all.length} within the time budget`);
        }
        // the first run of the JS states may use what is left after the css states' remaining 5 runs, shared by 6 runs
        if (budgetMs) jsEnd = Date.now() + Math.max(0, workEnd - Date.now() - 5 * (Date.now() - tc)) / 6;
      }
      for (const st of [...plans[cls].js.states]) await js(run, st);
      await pools.closeMatching(`${run}|${cls}`);
      if (covEnd(run)) { writeCoverageAfterCov(cls); progress(`cov-${cls}`); } else progress(run);
    }
  }));
  fs.writeFileSync(path.join(out, 'clips.json'), JSON.stringify(ctx.clips));

  // ---- S14 deep data mode: the data is complete (plan, o1, cov, coverage); no rebuild, no scoring, no gate claim ----
  if (!runPlan.verification.length) {
    await pools.closeAll();
    r.archiveMisses = Object.fromEntries(Object.entries(metas).map(([k, m]) => [k, m.misses]));
    const o1m = Object.entries(metas).filter(([k]) => k.startsWith('o1|')).map(([, m]) => m);
    for (const cls of classes) {
      const P = ptsOf[cls];
      const c = covAfter[cls];
      r.classes[cls] = {
        points: { cap: P.cap.id, held: P.held?.id, base: P.base.map(p => p.id) },
        plan: { pairs: plans[cls].pairs, cssCandidates: plans[cls].css.candidates, css: plans[cls].css.states.length, js: plans[cls].js.states.map(s => ({ id: s.id, how: s.how, label: s.label, k: s.k, harness: s.harness, sameComponent: s.sameComponent.length })), jsSkipped: plans[cls].js.skipped, budgetSkipped: { js: skippedJs[cls] || [], css: skippedCss[cls] || [] }, unforceable: Object.keys(plans[cls].css.unforceable).length, uncovered: plans[cls].css.uncovered.length },
        measured: { base: P.base.length, states: classPoints(cls).filter(p => p.state).length },
        coverage: c ? { stateRules: c.stateRules, exercised: c.exercised, counts: c.counts, jsCandidates: { scanned: c.jsCandidates.scanned, listenerCandidates: c.jsCandidates.listenerCandidates, exercised: c.jsCandidates.exercised, bySource: c.jsCandidates.bySource } } : null,
      };
    }
    r.states = {};
    r.verdict = {
      verification: 'sampled-out', acceptance: null, // never claimed: o2/o3, the JS-state tables and the rebuild did not run
      states: classes.reduce((a, cls) => a + r.classes[cls].measured.states, 0), base: classes.reduce((a, cls) => a + r.classes[cls].measured.base, 0),
      coverage: Object.fromEntries(Object.entries(r.classes).map(([c, x]) => [c, x.coverage ? `${x.coverage.exercised}/${x.coverage.stateRules}` : null])),
      archiveMisses: Object.values(r.archiveMisses).reduce((a, b) => a + b, 0),
      clockLateMs: Math.max(0, ...Object.values(metas).map(m => m.clockLateMs || 0)),
      installStalled: Object.values(metas).some(m => m.installLateMs > 0),
      shotSkipped: o1m.flatMap(m => Object.entries(m.shotSkipped || {}).map(([point, reason]) => ({ point, reason }))),
      skippedStates: [...Object.entries(skippedJs).flatMap(([cls, l]) => l.map(x => ({ cls, kind: 'js', ...x }))), ...Object.entries(skippedCss).flatMap(([cls, l]) => l.map(x => ({ cls, kind: 'css', ...x })))],
      forceSkipped: o1m.flatMap(m => Object.entries(m.states || {}).flatMap(([state, x]) => (x.forceSkipped || []).map(f => ({ state, ...f })))),
    };
    progress('data-done');
    r.wallMs = Date.now() - t0;
    fs.writeFileSync(path.join(out, 'states-gate.json'), JSON.stringify(r, null, 1));
    return r;
  }

  // ---- rebuild artifacts: base from the base table, JS states from their state tables ----
  const stTables = {};
  for (const cls of classes) {
    ctx.artifacts[cls] = renderRebuild(tables[cls]);
    for (const st of plans[cls].js.states) {
      const key = `${cls}~${st.id}`;
      stTables[key] = JSON.parse(fs.readFileSync(path.join(out, 'cap', `table-${key}.json`), 'utf8'));
      applyRuntimeState(stTables[key], loadRuntimeState(path.join(out, 'cap'), key), { dir: path.join(out, 'cap') }); // S3
      ctx.artifacts[key] = renderRebuild(stTables[key]);
    }
  }
  // script-owned replay plans (D1b, + structural replay): base points vs the captured point; JS states: held-out
  // point in the state vs the captured point in the state
  const O1 = path.join(out, 'o1');
  const inject = {}, owned = {};
  for (const cls of classes) {
    const P = ptsOf[cls];
    const base = scriptOwnedPlan(O1, P.base, [P.cap], { [cls]: tables[cls] });
    Object.assign(inject, base.inject); Object.assign(owned, base.ownedKeys);
    for (const st of plans[cls].css.states) for (const pid of ctx.statePts[cls]) { if (base.inject[pid]) inject[`${pid}~${st.id}`] = base.inject[pid]; if (base.ownedKeys[pid]) owned[`${pid}~${st.id}`] = base.ownedKeys[pid]; }
    for (const st of plans[cls].js.states) {
      const key = `${cls}~${st.id}`;
      const sp = [P.cap, P.held].filter(Boolean).map(p => ({ ...p, id: ptState(p, st.id), cls: key }));
      const pl = scriptOwnedPlan(O1, sp, [sp[0]], { [key]: stTables[key] });
      Object.assign(inject, pl.inject); Object.assign(owned, pl.ownedKeys);
    }
  }
  const forcedOf = new WeakMap(); // page -> {clear}: the forced pseudo-states of that session (classes run in parallel)
  ctx.prepare = async (page, pt, st, css) => {
    const id = ptState(pt, st?.id);
    const tkey = st ? `${pt.cls}~${st.id}` : pt.cls;
    const T = st ? stTables[tkey] : tables[pt.cls];
    const o = inject[id]?.length ? await page.evaluate(injectOwned, inject[id]) : null;
    const tl = T.topLayer?.length ? await page.evaluate(enterTopLayer, T.topLayer) : null;
    // interaction pseudo-classes the input left in the original (from o1 at this point), re-applied via CDP
    let ia = null;
    if (st) {
      // showModal() focuses the dialog; without a prior user input Chrome marks that focus :focus-visible (measured on
      // the fixture: outline auto in the rebuild, none in the original after a mouse click). Drop it; the original's
      // own focus state is forced below exactly as recorded.
      await page.evaluate(() => { const a = document.activeElement; if (a && a !== document.body) a.blur(); });
      const rec = M('o1', tkey)?.states?.[ptState({ id: ctx.statePts[pt.cls][0] }, st.id)]?.interaction || [];
      const fo = forcedOf.get(page) || {}; forcedOf.set(page, fo);
      if (fo.clear) await fo.clear();
      const forceSkipped = [];
      fo.clear = await forceStates(css, page, rec.filter(x => x.pc.some(p => FORCEABLE.includes(p))), forceSkipped);
      ia = rec;
      if (forceSkipped.length) fo.skipped = forceSkipped;
      // inner scroller offsets the state left (e.g. a tab rail the site scrolled to the clicked tab), as recorded
      const sc = M('o1', tkey)?.states?.[id]?.scrolls || [];
      if (sc.length) ia = { pseudo: rec, scrolls: await page.evaluate(setInnerScrolls, sc) };
    }
    // images the original had loaded at this point (o1), loaded here too
    const im = M('o1', tkey)?.imgs?.[id];
    const li = im?.length ? await page.evaluate(loadImagesLike, im) : null;
    await settle(page, false);
    return { ...(o || {}), ...(tl ? { topLayer: tl } : {}), ...(ia ? { interaction: ia } : {}), ...(li?.of ? { images: li } : {}) , ...(ia && forcedOf.get(page)?.skipped?.length ? { forceSkipped: forcedOf.get(page).skipped } : {}) };
  };
  await Promise.all((rescore ? [] : classes).map(async cls => {
    const P = ptsOf[cls];
    if (concurrent) {
      // S-SPEED #1: the rebuild sessions of a class are independent of each other (each renders its own artifact, its
      // prepare() state lives on its own page); they run side by side and are committed in the sequential order
      const sts = [...plans[cls].js.states], t = Date.now();
      const settle = pr => pr.then(meta => ({ meta, ms: Date.now() - t }), error => ({ error }));
      const timed = (name, pr) => pr.then(m => { log(`step ${name} ${Date.now() - t}ms`); return m; });
      const cssP = settle(timed(`rb-${cls}-css`, stateSession(site, 'rb', cls, { kind: 'css', states: plans[cls].css.states }, P.base, ctx)));
      const jsP = sts.map(st => settle(timed(`rb-${cls}-${st.id}`, stateSession(site, 'rb', cls, { kind: 'js', state: st }, [P.cap, P.held].filter(Boolean), ctx))));
      const c = await cssP;
      if (c.error) { await Promise.all(jsP); throw c.error; }
      r.steps[`rb-${cls}-css`] = (r.steps[`rb-${cls}-css`] || 0) + c.ms; metas[`rb|${cls}`] = c.meta;
      for (const [i, st] of sts.entries()) {
        const v = await jsP[i];
        if (!v.error) { r.steps[`rb-${cls}-${st.id}`] = (r.steps[`rb-${cls}-${st.id}`] || 0) + v.ms; metas[`rb|${cls}~${st.id}`] = v.meta; }
        else { const k = plans[cls].js.states.indexOf(st); if (k >= 0) plans[cls].js.states.splice(k, 1); (skippedJs[cls] || (skippedJs[cls] = [])).push({ id: st.id, how: st.how, label: st.label, reason: jsFailReason(v.error) }); }
      }
      await pools.closeMatching(`rb|${cls}`);
      return;
    }
    metas[`rb|${cls}`] = await step(`rb-${cls}-css`, () => stateSession(site, 'rb', cls, { kind: 'css', states: plans[cls].css.states }, P.base, ctx));
    for (const st of [...plans[cls].js.states]) {
      try { metas[`rb|${cls}~${st.id}`] = await step(`rb-${cls}-${st.id}`, () => stateSession(site, 'rb', cls, { kind: 'js', state: st }, [P.cap, P.held].filter(Boolean), ctx)); }
      catch (e) { const i = plans[cls].js.states.indexOf(st); if (i >= 0) plans[cls].js.states.splice(i, 1); (skippedJs[cls] || (skippedJs[cls] = [])).push({ id: st.id, how: st.how, label: st.label, reason: jsFailReason(e) }); }
    }
    await pools.closeMatching(`rb|${cls}`);
  }));
  await pools.closeAll();
  progress('scoring');

  // ---- score ----
  const D = n => path.join(out, n);
  r.states = {};
  r.archiveMisses = {};
  for (const [k, m] of Object.entries(metas)) r.archiveMisses[k] = m.misses;
  for (const cls of classes) {
    const P = ptsOf[cls];
    const all = classPoints(cls);
    // noise: o1/o2 per point, raised to the class floor measured by the D1 suite and the class max here
    const pair = compareRuns(D('o1'), D('o2'), all, null);
    const nz = noiseCapsFrom([pair]);
    const caps = Object.fromEntries(Object.entries(nz.caps).map(([id, c]) => [id, Math.max(c, capFloor[cls] || 0)]));
    const ident = compareRuns(D('o1'), D('o3'), all, caps);
    const gate = compareRuns(D('o1'), D('rb'), all, caps, { heatDir: D(`heat-${cls}`), owned });
    const exercisedBy = new Map();
    const rows = {};
    for (const p of all) {
      const { sid, st, mkey, covm, used, newly } = covUsage(cls, p);
      const o1m = M('o1', mkey)?.states?.[p.id] || {};
      const baseId = p.id.split('~')[0];
      let delta = null;
      if (sid) {
        // JS state: against the same session just before the input (fs: o1/<cap>~<sid>.pre); CSS state: same session base
        const pre = D(`o1/${ptState(P.cap, sid)}.pre.json.gz`);
        const a = st.kind === 'js' && p.kind === 'captured' && fs.existsSync(pre) ? gzRead(pre) : gzRead(D(`o1/${baseId}.json.gz`)), b = gzRead(D(`o1/${p.id}.json.gz`));
        const d = compareSnapshots(a, b, { maxDetail: 8 });
        delta = { changedElements: d.failedElements, byKind: d.byKind, byProp: Object.fromEntries(Object.entries(d.byProp).sort((x, y) => y[1] - x[1]).slice(0, 12)), sample: d.misses.slice(0, 6) };
      }
      for (const id of newly) { if (!exercisedBy.has(id)) exercisedBy.set(id, new Set()); exercisedBy.get(id).add(sid); }
      const g = gate[p.id], id = ident[p.id];
      const fsk = !!(o1m.forceSkipped?.length || M('rb', mkey)?.states?.[p.id]?.forceSkipped?.length || M('rb', mkey)?.points?.[p.id]?.prepared?.forceSkipped?.length);
      rows[p.id] = {
        state: sid, kind: p.kind, how: st ? (st.kind === 'css' ? st.targets.map(t => `${t.pc.map(x => ':' + x).join('')} ${t.k}`).join(' + ') : `${st.harness ? 'harness ' : ''}${st.how} ${st.label}`) : 'base',
        pass: g.pass && !fsk, ...(fsk ? { indeterminate: 'a force target was skipped (node gone): the state was not exercised as planned' } : {}), identity: id.pass, oracle: { pass: g.oracle.pass, failedElements: g.oracle.failedElements, byKind: g.oracle.byKind, byProp: g.oracle.byProp, misses: g.oracle.misses.slice(0, 8), owned: g.oracle.owned || 0 },
        pixel: { pass: g.pixel.pass, diffPx: g.pixel.diffPx, decodePx: g.pixel.decodePx, cap: g.pixel.cap, blob: g.pixel.blob, reason: g.pixel.reason, masked: g.pixel.masked || null, size: g.pixel.size },
        rulesNew: sid ? newly.map(x => ({ id: x, sel: tables[cls].rules[x].sel.slice(0, 120) })) : undefined,
        rulesUsedInState: sid ? used.length : undefined, usageUnmapped: covm?.usage?.unmappedSheets || 0,
        delta, assets: o1m.net || null, actions: o1m.actions, interaction: o1m.interaction, ...(o1m.forceSkipped?.length ? { forceSkipped: o1m.forceSkipped } : {}), ...(g.shotSkipped ? { shotSkipped: g.shotSkipped } : {}),
        prepared: M('rb', mkey)?.points?.[p.id]?.prepared || null,
      };
    }
    const cov = stateCoverage(tables[cls], plans[cls], exercisedBy);
    cov.jsCandidates = jsCoverage(plans[cls].js);
    fs.writeFileSync(D(`state-coverage-${cls}.json`), JSON.stringify(cov, null, 1));
    // audit + provenance of every artifact served for this class
    const src = JSON.parse(fs.readFileSync(D(`o1/sources-${cls}.json`), 'utf8'));
    const audit = {};
    for (const key of [cls, ...plans[cls].js.states.map(s => `${cls}~${s.id}`)]) {
      const m = M('rb', key);
      audit[key] = auditSources(src, ctx.artifacts[key], { requests: m.requests, scriptsBlocked: m.scriptsBlocked });
      const re = renderRebuild(key === cls ? tables[cls] : stTables[key]);
      audit[key].provenance = sameArtifact(re, ctx.artifacts[key]);
      if (!audit[key].provenance) audit[key].pass = false;
    }
    const sum = summarize(Object.fromEntries(all.map(p => [p.id, { kind: p.kind, ...gate[p.id] }])));
    r.classes[cls] = {
      points: { cap: P.cap.id, held: P.held?.id, base: P.base.map(p => p.id) },
      plan: { pairs: plans[cls].pairs, cssCandidates: plans[cls].css.candidates, css: plans[cls].css.states.length, js: plans[cls].js.states.map(s => ({ id: s.id, how: s.how, label: s.label, k: s.k, harness: s.harness, sameComponent: s.sameComponent.length })), jsSkipped: plans[cls].js.skipped, budgetSkipped: { js: skippedJs[cls] || [], css: skippedCss[cls] || [] }, unforceable: Object.keys(plans[cls].css.unforceable).length, uncovered: plans[cls].css.uncovered.length },
      noise: { perClass: nz.perClass[cls] || 0, floor: capFloor[cls] || 0, oraclePass: Object.values(pair).every(x => x.oracle.pass) },
      identity: summarize(Object.fromEntries(all.map(p => [p.id, { kind: p.kind, ...ident[p.id] }]))),
      gate: sum, coverage: { stateRules: cov.stateRules, exercised: cov.exercised, counts: cov.counts, jsCandidates: { scanned: cov.jsCandidates.scanned, listenerCandidates: cov.jsCandidates.listenerCandidates, exercised: cov.jsCandidates.exercised, bySource: cov.jsCandidates.bySource } }, audit,
    };
    Object.assign(r.states, rows);
    try { fs.writeFileSync(D('states-gate.partial.json'), JSON.stringify({ site: site.id, classes: r.classes, states: r.states, skippedJs, skippedCss }, null, 1)); } catch {}
  }
  // optional: a state mutant (a corrupted state rule must fail its state's gate): {cls, ruleSel, prop, value}
  if (stateMutant && !rescore) r.stateMutant = await step('state-mutant', () => runStateMutant(site, ctx, plans, ptsOf, tables, stateMutant, metas));
  const all = Object.values(r.states);
  r.verdict = {
    states: all.filter(x => x.state).length, statePass: all.filter(x => x.state && x.pass).length,
    base: all.filter(x => !x.state).length, basePass: all.filter(x => !x.state && x.pass).length,
    identity: all.filter(x => x.identity).length + '/' + all.length,
    auditPass: Object.values(r.classes).every(c => Object.values(c.audit).every(a => a.pass)),
    archiveMisses: Object.values(r.archiveMisses).reduce((a, b) => a + b, 0),
    maskedPctViewportMax: Math.max(0, ...all.map(x => x.pixel.masked?.pctViewport || 0)),
    coverage: Object.fromEntries(Object.entries(r.classes).map(([c, x]) => [c, `${x.coverage.exercised}/${x.coverage.stateRules}`])),
    clockLateMs: Math.max(0, ...Object.values(metas).map(m => m.clockLateMs || 0)),
    installStalled: Object.values(metas).some(m => m.installLateMs > 0),
    indeterminateStates: all.filter(x => x.indeterminate).length,
    shotSkipped: Object.entries(r.states).filter(([, x]) => x.shotSkipped).map(([id, x]) => ({ point: id, reason: x.shotSkipped })), // pixel check skipped (clip empty / outside the page); oracle still scored
    skippedStates: [...Object.entries(skippedJs).flatMap(([cls, l]) => l.map(x => ({ cls, kind: 'js', ...x }))), ...Object.entries(skippedCss).flatMap(([cls, l]) => l.map(x => ({ cls, kind: 'css', ...x })))], // planned states that were not measured (navigated, target gone, time budget): reported, never passed
    forceSkipped: all.flatMap(x => (x.forceSkipped || []).map(f => ({ state: x.state, ...f }))), // targets the page replaced/removed: state taken without them
  };
  r.verdict.acceptance = all.length > 0 && r.verdict.statePass === r.verdict.states && r.verdict.basePass === r.verdict.base && r.verdict.auditPass && all.every(x => x.identity) && !r.verdict.shotSkipped.length && !r.verdict.indeterminateStates && !r.verdict.installStalled && !r.verdict.skippedStates.length;
  // S16 (L7): why each failing check failed, tool or site (base rebuild causes come from the capture gate: same tables)
  try { r.verdict.causes = labelStates(r, { capture: captureCauses }); } catch (e) { r.verdict.causes = [{ check: 'labels', bucket: 'error', label: 'tool', reason: `labelStates failed: ${String(e.message).split('\n')[0]}`, evidence: {} }]; }
  r.wallMs = Date.now() - t0;
  fs.writeFileSync(D(rescore ? 'states-gate-rescore.json' : 'states-gate.json'), JSON.stringify(r, null, 1));
  return r;
}

/** State mutant: change one declaration of a state rule in the base table; the rebuild in that CSS state must fail. */
async function runStateMutant(site, ctx, plans, ptsOf, tables, m, metas) {
  const T = JSON.parse(JSON.stringify(tables[m.cls]));
  const rule = T.rules.find(x => x.t === 'style' && x.sel === m.ruleSel);
  if (!rule) return { error: 'rule not found' };
  const d = rule.d.find(x => x[0] === m.prop); if (!d) return { error: 'prop not found' };
  d[1] = m.value;
  const st = plans[m.cls].css.states.find(s => s.rules.includes(rule.id));
  if (!st) return { error: 'no state exercises the rule' };
  const out = path.join(ctx.out, 'mut');
  const c2 = { ...ctx, pools: null, out, artifacts: { [m.cls]: renderRebuild(T) } };
  const P = ptsOf[m.cls];
  await stateSession(site, 'rb', m.cls, { kind: 'css', states: [st] }, [P.cap], c2);
  const id = ptState(P.cap, st.id);
  const res = compareRuns(path.join(ctx.out, 'o1'), path.join(out, 'rb'), [{ ...P.cap, id }], { [id]: 0 })[id];
  const baseRes = compareRuns(path.join(ctx.out, 'o1'), path.join(out, 'rb'), [P.cap], { [P.cap.id]: 0 })[P.cap.id];
  void metas;
  return { rule: m.ruleSel, prop: m.prop, value: m.value, state: st.id, statePass: res.pass, basePass: baseRes.pass, killed: !res.pass, firstMiss: res.oracle.misses[0] || null };
}
