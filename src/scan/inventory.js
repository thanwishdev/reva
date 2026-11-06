// Inventory of one page at rest (PLAN §6 step 5): what can be touched, folded into patterns. Measured 2 Nov: 45, 35 and 136
// interactive elements fall to 26, 18 and 33 patterns, and an inner page adds only 2-4 new ones. Members of a pattern share
// one test; a second member is always sampled, because the fold is good, not perfect (10 of 12 reacted alike).
import crypto from 'node:crypto';
import { NEVER_PRESS } from './gate.js';

/** Runs before the page's code: remembers which elements got pointer or key listeners. */
export const LISTENER_INIT = `(() => { const M = window.__REVA_L = new WeakMap(); const add = EventTarget.prototype.addEventListener;
  const re = /^(mouseenter|mouseleave|mouseover|mouseout|mousemove|pointerenter|pointerleave|pointerover|pointerout|pointermove|click|pointerdown|mousedown|touchstart|focus|focusin|keydown|change|input)$/;
  EventTarget.prototype.addEventListener = function (t, f, o) { try { if (this && this.nodeType === 1 && re.test(String(t))) { let s = M.get(this); if (!s) M.set(this, s = new Set()); s.add(String(t)); } } catch (e) {} return add.call(this, t, f, o); }; })();`;

/** In the page: interactive elements grouped by signature, a spread of each group's members, every link. */
export function inventoryInPage({ perGroup = 6 } = {}) {
  const norm = (c) => c.replace(/^(css|sc|jsx|svelte|emotion|tw)-[a-z0-9]+$/i, '').replace(/[_-]{1,2}[0-9a-z]{5,}$/i, (m) => (/\d/.test(m) ? '' : m)).replace(/\d+/g, '#');
  const shape = (e, d = 0) => (d >= 2 ? '' : [...e.children].slice(0, 6).map((c) => c.localName + (d < 1 ? `(${shape(c, d + 1)})` : '')).join(','));
  const pathOf = (e) => { const p = []; for (let x = e; x && x !== document.documentElement; x = x.parentElement) { const par = x.parentElement; if (!par) break; p.unshift(`${/^[a-z][a-z0-9-]*$/.test(x.localName) ? x.localName : '*'}:nth-child(${[...par.children].indexOf(x) + 1})`); } return 'html>' + p.join('>'); };
  const state = { hover: [], focus: 0, active: 0 }; let blocked = 0, keyframes = 0;
  const walk = (list) => { for (const r of list) { if (r.type === 7) { keyframes++; continue; } if (r.cssRules && r.selectorText == null) { walk(r.cssRules); continue; }
    if (!r.selectorText) continue; if (r.selectorText.includes(':focus')) state.focus++; if (r.selectorText.includes(':active')) state.active++;
    if (r.selectorText.includes(':hover')) for (const s of r.selectorText.split(',')) if (s.includes(':hover')) state.hover.push(s.replace(/:{1,2}(hover|focus-visible|focus-within|focus|active|before|after)\b/g, '').trim() || '*'); } };
  for (const s of document.styleSheets) { try { walk(s.cssRules); } catch (e) { blocked++; } }
  const hovered = new WeakSet(); for (const b of new Set(state.hover)) { try { for (const e of document.querySelectorAll(b)) hovered.add(e); } catch (e) { /* a selector this engine cannot read */ } }
  const INT = 'a[href],button,[role=button],[role=tab],[role=menuitem],[role=switch],[role=checkbox],summary,input,select,textarea,label[for],[tabindex]:not([tabindex="-1"]),[aria-expanded],[aria-haspopup],[onclick]';
  const sem = new Set(document.querySelectorAll(INT)); const L = window.__REVA_L; const groups = new Map(); let visible = 0, interactive = 0;
  const here = location.href.split('#')[0]; const links = new Map();
  for (const e of document.querySelectorAll('body *')) {
    const r = e.getBoundingClientRect(); const cs = getComputedStyle(e);
    if (!(r.width > 1 && r.height > 1 && cs.display !== 'none' && cs.visibility !== 'hidden')) continue;
    visible++;
    const ls = L && L.get(e); const ptr = cs.cursor === 'pointer' && !(e.parentElement && getComputedStyle(e.parentElement).cursor === 'pointer');
    if (!(sem.has(e) || ptr || ls || (hovered.has(e) && (cs.transitionDuration !== '0s' || cs.cursor === 'pointer')))) continue;
    interactive++;
    const cls = [...e.classList].map(norm).filter(Boolean).sort().join('.');
    const sig = [e.localName, e.getAttribute('role') || '', cls, cs.cursor, cs.transitionProperty.slice(0, 40), cs.transitionDuration.slice(0, 20), hovered.has(e) ? 'H' : '', ls ? [...ls].sort().join('+') : '', shape(e)].join('|');
    const href = e.closest('a[href]') ? e.closest('a[href]').href : null;
    const opener = e.hasAttribute('aria-expanded') || e.hasAttribute('aria-haspopup') || e.hasAttribute('aria-controls');
    const raw = e.localName === 'a' ? e.getAttribute('href') : null;
    const form = e.closest('form');
    const inputKind = /^(input|select|textarea)$/.test(e.localName);
    const submit = (e.localName === 'button' && form && (e.getAttribute('type') || 'submit') === 'submit') || (e.localName === 'input' && /^(submit|image)$/.test(e.type));
    const nav = href && !opener && !/^(javascript:|#|$)/.test((raw ?? e.closest('a[href]').getAttribute('href') ?? '').trim()) && href.split('#')[0] !== here;
    const kind = submit ? 'submit' : inputKind ? 'input' : nav ? 'link' : 'control';
    const text = (e.innerText || e.value || e.getAttribute('aria-label') || e.getAttribute('title') || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!groups.has(sig)) groups.set(sig, { sig, tag: e.localName, cls, kind, focusable: e.tabIndex >= 0, listeners: ls ? [...ls].sort() : [], cursor: cs.cursor, n: 0, els: [] });
    const g = groups.get(sig); g.n++; g.els.push({ e, x: Math.round(r.x), y: Math.round(r.y + scrollY), w: Math.round(r.width), h: Math.round(r.height), text, href, kind });
    if (nav && /^https?:/.test(href)) { const blank = e.closest('a[href]')?.target === '_blank'; if (!links.has(href) || (links.get(href).blank && !blank)) links.set(href, { sel: pathOf(e), blank }); }
  }
  const spread = (a, n) => (a.length <= n ? a : Array.from({ length: n }, (_, i) => a[Math.floor((i * a.length) / n)]));
  const out = [...groups.values()].map(({ els, ...g }) => ({ ...g, members: spread(els, perGroup).map(({ e, ...m }) => ({ ...m, sel: pathOf(e) })) }));
  return { url: location.href, visible, interactive, pageH: document.documentElement.scrollHeight, groups: out, links: [...links].map(([href, l]) => ({ href, ...l })), css: { hover: state.hover.length, focus: state.focus, active: state.active, keyframes, blockedSheets: blocked } };
}

/** The state of the page as far as an open menu or dialog changes it. Compared with stateDiffers. */
export function stateInPage() {
  const inView = () => { let shown = 0, view = 0; for (const e of document.querySelectorAll('body *')) { const r = e.getBoundingClientRect(); if (r.width < 2 || r.height < 2) continue; try { if (e.checkVisibility && !e.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue; } catch (x) { /* old engine */ } shown++; if (r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth) view++; } return { shown, view }; };
  const grid = []; for (let i = 1; i < 9; i++) for (let j = 1; j < 9; j++) { const t = document.elementFromPoint((innerWidth * i) / 9, (innerHeight * j) / 9); grid.push(t ? (t.localName + '.' + (t.getAttribute('class') || '').slice(0, 24) + '#' + (t.id || '')) : ''); }
  return { ...inView(), expanded: document.querySelectorAll('[aria-expanded="true"]').length, dialogs: document.querySelectorAll('dialog[open],[aria-modal="true"],:popover-open').length, marks: [...document.querySelectorAll('[aria-selected="true"],[aria-pressed="true"],[aria-checked="true"],details[open]')].map((e) => [...e.parentElement.children].indexOf(e)).join(','), lock: getComputedStyle(document.documentElement).overflow + '/' + getComputedStyle(document.body).overflow, url: location.href, grid };
}

/** How far two page states are apart. A page has its own small changes (an icon swaps, a cursor follows): an open state takes a part of the
 * screen, or says so in ARIA, a dialog, a selected tab or a scroll lock. @returns {{changed:boolean, navigated:boolean, cells:number, view:number, shown:number}} */
export function stateDiffers(a, b, { cells = 4, elements = 12, ignore = null } = {}) {
  let n = 0; for (let i = 0; i < a.grid.length; i++) if (a.grid[i] !== b.grid[i] && !ignore?.has(i)) n++;
  const view = Math.abs(a.view - b.view), shown = Math.abs(a.shown - b.shown);
  const navigated = a.url.split('#')[0] !== b.url.split('#')[0];
  return { changed: navigated || n >= cells || view >= elements || shown >= elements || a.expanded !== b.expanded || a.dialogs !== b.dialogs || a.marks !== b.marks || a.lock !== b.lock, navigated, cells: n, view, shown };
}

/** The cells of the screen that change with nothing touched (a marquee, a carousel on its own timer): two looks, no input between. */
export function noisyCells(a, b) { const s = new Set(); for (let i = 0; i < a.grid.length; i++) if (a.grid[i] !== b.grid[i]) s.add(i); return s; }

export const patternId = (g) => `${g.tag}${g.cls ? '.' + g.cls.slice(0, 48) : ''}~${crypto.createHash('sha1').update(g.sig).digest('hex').slice(0, 6)}`;

/** Inventory groups as patterns, with the ledger id, in the order of the page. */
export function patternsOf(inv) {
  return inv.groups.map((g) => ({ ...g, id: patternId(g) })).sort((a, b) => a.members[0].y - b.members[0].y || a.members[0].x - b.members[0].x);
}

/** May a click test press this pattern? Links are page changes, forms are never sent, words that commit the visitor are never pressed. */
export function clickVerdict(p) {
  if (p.kind === 'link') return { ok: false, why: 'a link: its click is a page change' };
  if (p.kind === 'submit') return { ok: false, why: 'it would send a form; forms are never submitted' };
  if (p.kind === 'input') return { ok: false, why: 'a field: it is focused, nothing is typed' };
  const said = p.members.map((m) => m.text).find((t) => t && NEVER_PRESS.test(t));
  if (said) return { ok: false, why: `its words commit the visitor ("${said}"); REVA never presses those` };
  return { ok: true };
}
