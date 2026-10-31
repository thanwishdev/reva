// look: which elements and channels to fit (pure functions over a take's rows; no browser, no fitter).
//
// Ranking by visual weight (REVA-PRODUCT §3.2 item 2): area on screen × displacement × time moving. Repeated elements
// (same descriptor: tag, id, classes) fold into one entry, so a 20-word stagger is one motion, not 20.
// Channel filter per element: only channels that change; string mirrors and layout boxes are dropped when a cheaper,
// more direct channel carries the same motion (box channels cost ~10 s each to fit and follow the transform anyway).

import { noticeOf, sortByNotice, steadyLoop } from './rank.js';

const TF = ['ren:tx', 'ren:ty', 'ren:tz', 'ren:sx', 'ren:sy', 'ren:rz', 'ren:skx'];
const BOX = ['ren:bx', 'ren:by', 'ren:bw', 'ren:bh'];
const isBox = (c) => BOX.includes(c);
const isTransformPart = (c) => TF.includes(c);

/** Escape one CSS identifier (CSS.escape, enough for tag/id/class names from a descriptor). */
export function cssEscape(s) {
  // escape every character that is not a plain identifier character, then a leading digit (as CSS.escape does)
  return String(s).replace(/[^a-zA-Z0-9_\u00A0-\uFFFF-]/g, (c) => '\\' + c).replace(/^(-?)(\d)/, (m, d, n) => `${d}\\3${n} `);
}

/** A trailing pseudo-element of a selector: ::before, ::after, ::marker ... (and the legacy one-colon before / after). */
const PSEUDO_TAIL = /(?<!\\)(::(?:before|after|marker|placeholder|first-letter|first-line|selection|backdrop|file-selector-button)|:(?:before|after|first-letter|first-line))\s*$/i;

/** Split a selector list at its top-level commas (not inside (), [] or quotes). */
export function splitSelectorList(sel) {
  const out = []; let depth = 0, q = null, cur = '';
  for (let i = 0; i < sel.length; i++) {
    const c = sel[i];
    if (q) { cur += c; if (c === '\\') { cur += sel[++i] ?? ''; } else if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === '\\') { cur += c + (sel[++i] ?? ''); continue; }
    if (c === '(' || c === '[') depth++; else if (c === ')' || c === ']') depth = Math.max(0, depth - 1);
    if (c === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

/**
 * The --el selector as the page sees it: `a::after, .b` -> host selectors (`a`, `.b`, what querySelectorAll matches) and the
 * pseudo-element each one is read at (`::after`, or null). A part that is only a pseudo-element (`::before`) has every
 * element as its host. Comma-free input comes back as it was.
 * @returns {{selectors:string[], pseudos:(string|null)[], hasPseudo:boolean}}
 */
export function parseAim(el) {
  const parts = splitSelectorList(String(el ?? ''));
  if (!parts.length) return { selectors: [String(el ?? '')], pseudos: [null], hasPseudo: false };
  const selectors = [], pseudos = [];
  for (const part of parts) {
    const m = PSEUDO_TAIL.exec(part);
    if (!m) { selectors.push(part); pseudos.push(null); continue; }
    const host = part.slice(0, m.index).trim() || '*';
    selectors.push(host); pseudos.push(m[1].startsWith('::') ? m[1].toLowerCase() : ':' + m[1].toLowerCase());
  }
  // a selector list with no pseudo keeps the user's text whole (a comma inside :is() etc. never splits it)
  const hasPseudo = pseudos.some(Boolean);
  return hasPseudo ? { selectors, pseudos, hasPseudo } : { selectors: [String(el)], pseudos: [null], hasPseudo: false };
}

/** Element descriptor (`DIV#id.a.b` or `DIV#id.a.b::after`, src/record/inpage.js W.desc) -> a CSS selector for it. */
export function selectorFromDesc(desc0) {
  const pm = /(::[a-z-]+)$/.exec(String(desc0 || '')); const desc = pm ? String(desc0).slice(0, pm.index) : desc0;
  const r = selectorFromDescPlain(desc); return r && pm ? r + pm[1] : r;
}
function selectorFromDescPlain(desc) {
  const m = /^([A-Za-z][A-Za-z0-9-]*)(#[^.]+)?((?:\.[^.]+)*)$/.exec(String(desc || ''));
  if (!m) return null;
  const tag = m[1].toLowerCase();
  const id = m[2] ? '#' + cssEscape(m[2].slice(1)) : '';
  const cls = m[3] ? m[3].slice(1).split('.').filter(Boolean).map((c) => '.' + cssEscape(c)).join('') : '';
  return tag + id + cls;
}

/**
 * The selector to print for a ranked entry (what the user passes to --el). `sels`: Map id -> [unique selector | null,
 * matches of the descriptor's own selector at the end of the take, 1 when the node had left the page]
 * (recorded in the page, src/record/inpage.js W.selectors; older takes: [selector, matches], 0 matches = gone).
 * - one element: its unique selector (checked in the page), else null;
 * - a folded group: the descriptor selector when it matches exactly the group; when it matches more and names a class
 *   or an id, the selector with how many it matches; a bare tag (`div`) is never offered (it matches every div);
 * - the lead node left the page before the take ended (loader removed, hydration / re-render rebuilt the markup): the
 *   descriptor selector (class or id only) when it matches elements now, said to match their successors; else why.
 * @returns {{selector: string|null, matches: number|null, why: string|null, gone?: boolean, leadSelector?: string|null}}
 */
export function entrySelector(e, sels) {
  const s = sels && sels.get(e.lead);
  const group = !(e.count === 1 || e.kind !== 'group');
  const ds = selectorFromDesc(e.desc); const named = !!ds && /[#.]/.test(ds);
  if (!s) return { selector: null, matches: null, why: 'no selector was recorded for this element' };
  const n = s[1];
  const gone = s[2] === 1 || s[2] === true || (s[2] == null && !s[0] && n === 0);
  if (gone) {
    const left = group ? `these ${e.count} elements left the page before the take ended` : 'the element left the page before the take ended';
    if (named && n > 0) {
      const exact = n === (group ? e.count : 1);
      return { selector: ds, matches: n, gone: true, why: `the original node${group ? 's were' : ' was'} replaced; this matches ${exact ? (group ? 'their successors' : 'its successor') : `${n} elements now`}` };
    }
    // nothing has these classes any more (a preloader removed): the descriptor selector still names the nodes while
    // they are on the page, and --el watches every match during the take (how many it matched then is unknown)
    if (named) return { selector: ds, matches: null, gone: true, why: `${left}; this selector names ${group ? 'them' : 'it'} while on the page (--el watches its matches during the take)` };
    return { selector: null, matches: n, gone: true, leadSelector: null, why: `${left}${ds && n ? ` ("${ds}" matches ${n} now)` : ''}` };
  }
  if (!group) {
    if (s[0]) return { selector: s[0], matches: 1, why: null };
    return { selector: null, matches: null, why: 'no selector matches only this element' };
  }
  if (ds && n === e.count) return { selector: ds, matches: n, why: null };
  if (named && n > e.count) return { selector: ds, matches: n, why: `matches ${n} elements; ${e.count} of them moved` };
  // fewer matches than moved: a class was added or removed during the take (selectors are read at its end)
  if (named && n && n < e.count) return { selector: null, matches: n, leadSelector: s[0] || null, why: `"${ds}" matches only ${n} of the ${e.count} elements that moved (a class changed during the take)` };
  // no group selector: the lead's own unique selector still aims at one member (the DOM path is the same every run)
  return { selector: null, matches: n, leadSelector: s[0] || null, why: `no selector matches only these ${e.count} elements${ds && n ? ` ("${ds}" matches ${n})` : ''}` };
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Per-element statistics over the take.
 * `pointer` {x, y}: where the tool itself put the pointer during the take (the scroll action parks it mid-viewport to
 * wheel there). An element whose on-screen centre travels to that point is a cursor follower reacting to the tool's
 * own pointer, not to the action: `followsPointer`.
 * @param {{rows:object[], ids:number[], dt:number, viewport:{width:number,height:number}, pointer?:{x:number,y:number}}} o
 * @returns {Map<number, object>} id -> {moving:Set, energy:{ch:n}, firstMoveT, lastMoveT, box, movingFrames, area, disp, weight, pinPlausible, followsPointer}
 */
export function elementStats({ rows, ids, dt, viewport, pointer = null }) {
  const vw = viewport.width, vh = viewport.height;
  const out = new Map();
  for (const id of ids) {
    let first = null, prev = null, prevSy = null, prevSx = null;
    const moving = new Set(); const docMoving = new Set(); const energy = {}; const lo = {}, hi = {};
    let firstMoveT = null, lastMoveT = null, movingFrames = 0, areaSum = 0, areaN = 0, box = null;   // box: on screen when it starts to move
    // pin evidence: frames where the offset changed while the on-screen y stayed put, and frames where y followed it
    let heldRun = 0, heldMax = 0, followed = 0;   // heldRun / heldMax: px of scroll during which the element stayed put
    let c0 = null, c1 = null;   // on-screen centre, first and last sample (pointer-follower test)
    let onSum = 0, onN = 0;
    let opStart = null, opEnd = null, opMax = null, syFirst = null;   // opacity at the first / last sample, its max; scroll at the first move
    const steps = {};   // translate steps per frame (doc-relative for bx) and whether the page scroll stayed put: marquee test (rank.js steadyLoop)
    for (const r of rows) {
      const v = r.v && r.v[id]; if (!v) continue;
      const op = num(v['ren:opacity']); if (op != null) { if (opStart == null) opStart = op; opEnd = op; opMax = Math.max(opMax ?? op, op); }
      if (num(v['ren:bx']) != null && num(v['ren:by']) != null) { const c = { x: v['ren:bx'] + (num(v['ren:bw']) ?? 0) / 2, y: v['ren:by'] + (num(v['ren:bh']) ?? 0) / 2, s: Math.max(num(v['ren:bw']) ?? 0, num(v['ren:bh']) ?? 0) }; if (!c0) c0 = c; c1 = c; }
      const sy = num(r.sy) ?? 0, sx = num(r.sx) ?? 0;
      if (!first) { first = v; prev = v; prevSy = sy; prevSx = sx; continue; }
      let changed = false;
      for (const [c, x] of Object.entries(v)) {
        const p = prev[c];
        if (typeof x === 'number' && typeof p === 'number') {
          const d = Math.abs(x - p); if (d > 1e-9) { moving.add(c); energy[c] = (energy[c] || 0) + d; }
          // box channels move with the page scroll: the element's OWN motion is the change of its document position
          const xd = c === 'ren:by' ? x + sy : c === 'ren:bx' ? x + sx : x, pd = c === 'ren:by' ? p + prevSy : c === 'ren:bx' ? p + prevSx : p;
          if (Math.abs(xd - pd) > 1e-9) { if (c === 'ren:by' || c === 'ren:bx') docMoving.add(c); changed = true; }
          if (c === 'ren:tx' || c === 'ren:ty' || c === 'ren:bx') { const s = steps[c] || (steps[c] = { d: [], still: [] }); s.d.push(xd - pd); s.still.push(sy === prevSy && sx === prevSx); }
          lo[c] = Math.min(lo[c] ?? xd, xd); hi[c] = Math.max(hi[c] ?? xd, xd);
        } else if (JSON.stringify(x) !== JSON.stringify(p)) { moving.add(c); energy[c] = (energy[c] || 0) + 1; changed = true; }
      }
      // screen-y pin evidence (only meaningful while the offset changes)
      if (sy !== prevSy && num(v['ren:by']) != null && num(prev['ren:by']) != null) {
        if (Math.abs(v['ren:by'] - prev['ren:by']) < 0.5) { heldRun += Math.abs(sy - prevSy); heldMax = Math.max(heldMax, heldRun); } else { heldRun = 0; if (Math.abs((v['ren:by'] + sy) - (prev['ren:by'] + prevSy)) < 0.5) followed++; }
      }
      if (changed) {
        const x = num(v['ren:bx']) ?? 0, y = num(v['ren:by']) ?? 0, w = num(v['ren:bw']) ?? 0, h = num(v['ren:bh']) ?? 0;
        movingFrames++; if (firstMoveT == null) { firstMoveT = r.T; syFirst = sy; box = { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) }; } lastMoveT = r.T;
        const iw = Math.max(0, Math.min(x + w, vw) - Math.max(x, 0)), ih = Math.max(0, Math.min(y + h, vh) - Math.max(y, 0));
        const op = num(v['ren:opacity']) ?? 1;
        areaSum += iw * ih * Math.max(op, 0.05); areaN++;
        if (iw * ih > 0) { onSum += iw * ih * Math.max(op, 0.05); onN++; }   // the frames a person can see it move (rank.js)
      }
      prev = v; prevSy = sy; prevSx = sx;
    }
    const area = areaN ? areaSum / areaN : 0; const L = Math.sqrt(Math.max(area, 1));
    const rng = (c) => (hi[c] != null ? hi[c] - lo[c] : 0);
    const disp = Math.max(
      rng('ren:tx'), rng('ren:ty'), rng('ren:tz'), docMoving.has('ren:bx') ? rng('ren:bx') : 0, docMoving.has('ren:by') ? rng('ren:by') : 0,
      rng('ren:bw'), rng('ren:bh'), (rng('ren:sx') + rng('ren:sy')) / 2 * L, rng('ren:rz') * Math.PI / 180 * L / 2, rng('ren:opacity') * L,
      ['ren:filter', 'ren:clipPath', 'ren:radius'].some((c) => moving.has(c)) ? 0.25 * L : 0,
      // a font axis changes the glyph shapes: a full weight sweep (100 -> 900) or width sweep (50 points) counts as half a box side
      (rng('ren:wght') / 800 + rng('ren:wdth') / 50) * 0.5 * L, [...moving].some((c) => c.startsWith('ren:fvar.')) ? 0.25 * L : 0,
    );
    const movingMs = movingFrames * dt;
    let followsPointer = false;
    if (pointer && c0 && c1 && moving.size) {
      const d0 = Math.hypot(c0.x - pointer.x, c0.y - pointer.y), d1 = Math.hypot(c1.x - pointer.x, c1.y - pointer.y);
      // small (a cursor, a dot, a ring: <= 200 px) and ends centred on the pointer (it travelled there, or it was put
      // there when the pointer arrived and only scaled / faded in)
      followsPointer = c1.s <= 200 && d1 <= Math.max(16, 0.6 * c1.s);
    }
    out.set(id, { id, moving, docMoving, energy, firstMoveT, lastMoveT, box, movingFrames, movingMs, area, disp, weight: area * disp * movingMs / 1000, pinPlausible: heldMax >= 200 && followed >= 2, followsPointer,
      heldMax, syFirst, opStart, opEnd, opMax, loop: steadyLoop(steps, dt), areaOn: onN ? onSum / onN : 0, movingOnMs: onN * dt });
  }
  return out;
}

/**
 * Channels to fit for one element (the per-element channel filter).
 * - only channels that change;
 * - `ren:transform` (the computed string) is dropped when its numeric parts (tx, ty, sx, rz, ...) move;
 * - layout boxes (bx, by, bw, bh) are dropped when anything else moves (they follow the transform / layout), except
 *   `ren:by` on a scroll action when a pin is plausible (a pin is only visible in the box, spike finding 6);
 * - `drv:*` (what the page wrote) is kept: it is the authored value.
 * @param {object} st  elementStats entry
 * @param {{action:string, channels?:string[]}} o
 */
export function chooseChannels(st, { action, channels = null, aimed = false, ridesPage = false } = {}) {
  // not aimed (ranking a whole page), an aimed scroll (fitted against the scroll, a riding box reads the PAGE's smoothing,
  // Lenis lerp 0.1, as the element's own law), or the page itself scrolled (ridesPage: a click that scrolled it, described
  // by the page row): a box that only rides the page scroll is not the element's own motion
  let set = [...st.moving].filter((c) => (aimed && action !== 'scroll' && !ridesPage) || !(c === 'ren:by' || c === 'ren:bx') || st.docMoving.has(c));
  if (channels && channels.length) return set.filter((c) => channels.includes(c));
  if (set.some(isTransformPart)) set = set.filter((c) => c !== 'ren:transform' && c !== 'drv:transform');
  // what the page wrote and what rendered are the same motion: fit the rendered channel (what you see), once
  if (set.includes('ren:opacity')) set = set.filter((c) => c !== 'drv:opacity');
  const nonBox = set.filter((c) => !isBox(c));
  const byEnergy = (a, b) => (st.energy[b] || 0) - (st.energy[a] || 0);
  // fit order: the most motion first (a capped fit keeps the strongest channels) ... except the pin box of a scroll take,
  // which goes after the element's own channels: on a scroll every box rides the page, so its energy (thousands of px)
  // always outranked the transform / opacity that IS the scrubbed motion, and the box went first into the fit budget
  // (a Lenis + GSAP pinned-rail page: 8 box channels spent the whole take budget, the rail's own translate was never fitted)
  if (nonBox.length) return [...nonBox.sort(byEnergy), ...(action === 'scroll' && st.pinPlausible && st.moving.has('ren:by') ? ['ren:by'] : [])];
  return set.sort(byEnergy);
}

/** The channel that best represents an element's motion (for stagger members): numeric, most energy, not a box. */
export function primaryChannel(chs, st) {
  const numeric = chs.filter((c) => !/^(ren|drv):transform$/.test(c) && !/^ren:(filter|clipPath|radius)$/.test(c));
  const pool = numeric.length ? numeric : chs;
  const nb = pool.filter((c) => !isBox(c));
  return (nb.length ? nb : pool)[0] || null;
}

/**
 * Plan the fit: rank elements (folded by descriptor), choose channels, cut at the channel budget.
 * @param {object} o
 * @param {Map} o.stats       elementStats()
 * @param {string[]} o.els    element descriptors by id
 * @param {number[]} o.candidates  element ids eligible (aimed, or every watched element)
 * @param {number} [o.top]    entries to fit when not aimed (default 5)
 * @param {boolean} [o.aimed] true with --el: every candidate entry is fitted (no top cut)
 * @param {number} [o.maxChannels]  channel budget for the whole fit (default 40)
 * @param {number} [o.maxMembers]   members fitted per folded group (default 24)
 * @param {string} o.action
 * @param {string[]} [o.channels]   user channel filter
 * @param {Set<number>} [o.preMoving]  ids already moving before the action (not aimed: listed apart, not ranked)
 * @param {Map} [o.sels]  id -> [unique selector, descriptor matches] (entrySelector)
 */
export function planFit({ stats, els, candidates, top = 5, aimed = false, maxChannels = 40, maxMembers = 24, action, channels = null, preMoving = null, sels = null, ridesPage = false, viewport = null }) {
  const live = candidates.map((id) => stats.get(id)).filter((st) => st && st.moving.size && ((aimed && !ridesPage) || chooseChannels(st, { action, channels, ridesPage }).length));
  // not aimed: an element that only follows the pointer the tool parked (cursor followers on a scroll take) is not the
  // action's motion; it is listed apart (`pointerDriven`), never ranked
  // not aimed, hover / click / scroll: an element already moving before the action (a preloader still fading, an
  // ambient loop) is not the action's motion either; listed apart (`alreadyMoving`). Checked first: a loader logo
  // centred on screen is not a cursor follower.
  const alreadyMoving = aimed ? [] : live.filter((st) => preMoving && preMoving.has(st.id)).map((st) => ({ id: st.id, desc: els[st.id] || `el${st.id}`, selector: (sels && sels.get(st.id) && sels.get(st.id)[0]) || null }));
  const am = new Set(alreadyMoving.map((p) => p.id));
  const pointerDriven = aimed ? [] : live.filter((st) => st.followsPointer && !am.has(st.id)).map((st) => ({ id: st.id, desc: els[st.id] || `el${st.id}` }));
  // the document root's own box (html / body height growing as content loads) is layout, not motion: never ranked
  const root = aimed ? [] : live.filter((st) => /^(HTML|BODY)\b/.test(els[st.id] || ''));
  const pd = new Set([...pointerDriven, ...alreadyMoving, ...root].map((p) => p.id));
  const byDesc = new Map();
  for (const st of live) {
    if (pd.has(st.id)) continue; const d = els[st.id] || `el${st.id}`; const g = byDesc.get(d) || []; g.push(st); byDesc.set(d, g); }
  let entries = [...byDesc].map(([desc, g]) => {
    const members = [...g].sort((a, b) => (a.firstMoveT ?? Infinity) - (b.firstMoveT ?? Infinity) || a.id - b.id);
    const lead = [...g].sort((a, b) => b.weight - a.weight || a.id - b.id)[0];
    return { desc, kind: g.length >= 3 ? 'group' : 'element', ids: members.map((m) => m.id), lead: lead.id, count: g.length,
      weight: g.reduce((a, m) => a + m.weight, 0), firstMoveT: members[0].firstMoveT, box: lead.box || null, _members: [lead, ...members.filter((m) => m !== lead)] };
  });
  // two same-descriptor elements are two entries (no stagger from two)
  entries = entries.flatMap((e) => (e.kind === 'element' && e.count === 2 ? e.ids.map((id) => ({ ...e, ids: [id], lead: id, count: 1, weight: stats.get(id).weight, firstMoveT: stats.get(id).firstMoveT, box: stats.get(id).box || null, _members: [stats.get(id)] })) : [e]));
  // ranked by what a person notices (rank.js), not by raw visual weight: the fit budget goes to those first
  for (const e of entries) { e.notice = viewport ? noticeOf({ members: e._members, desc: e.desc, viewport, action }) : { score: e.weight, why: [] }; delete e._members; }
  sortByNotice(entries);
  const total = entries.reduce((a, e) => a + e.weight, 0) || 1;
  entries.forEach((e, i) => { e.rank = i + 1; e.weightShare = e.weight / total; Object.assign(e, entrySelector(e, sels)); });
  const chosen = aimed ? entries : entries.slice(0, top);
  const rest = aimed ? [] : entries.slice(top);
  // channel budget: lead channels of every chosen entry first (rank order), then the members of folded groups
  const onlyKeys = []; const notFitted = [];
  let left = maxChannels;
  for (const e of chosen) {
    const st = stats.get(e.lead); const chs = chooseChannels(st, { action, channels, aimed, ridesPage });
    e.channels = chs; e.fitted = { lead: [], members: [] };
    for (const c of chs) { if (left > 0) { onlyKeys.push(`${e.lead}|${c}`); e.fitted.lead.push(c); left--; } else notFitted.push({ el: e.lead, desc: e.desc, channel: c, reason: `channel budget ${maxChannels}` }); }
  }
  for (const e of chosen) {
    if (e.kind !== 'group') continue;
    const pc = primaryChannel(e.channels, stats.get(e.lead)); e.memberChannel = pc; if (!pc) continue;
    const others = e.ids.filter((id) => id !== e.lead && stats.get(id).moving.has(pc));
    const take = others.slice(0, Math.max(0, maxMembers - 1));
    for (const id of take) { if (left > 0) { onlyKeys.push(`${id}|${pc}`); e.fitted.members.push(id); left--; } else notFitted.push({ el: id, desc: e.desc, channel: pc, reason: `channel budget ${maxChannels}` }); }
    if (others.length > take.length) e.membersNotFitted = others.length - take.length;
  }
  return { entries: chosen, rest, onlyKeys, notFitted, total, pointerDriven, alreadyMoving };
}

/**
 * Two-pass split for declared transitions (look fit early exit): when an element has a declared CSS/WAAPI animation of
 * `transform` (or `all`), its translate parts (tx, ty, tz) are fitted only if no other transform part of that element
 * comes out declared. Measured (spike, one archived site): a 150 ms `ease` transition of rotate + scale + translate; rz/sx/sy
 * read as declared in 6 ms each, while tx/ty (a small rotated translate) cost 11-13 s each and came out unexplained.
 * @returns {{first:string[], deferred:string[]}} onlyKeys for pass 1 and pass 2
 */
export function splitDeclaredTransform(onlyKeys, births, els) {
  const tfDecl = new Set();
  for (const b of births || []) {
    if (!b || !b.tgt) continue;
    const props = new Set([String(b.name || ''), ...((b.keyframes || []).flatMap((k) => Object.keys(k || {})))]);
    if (props.has('transform') || props.has('all') || props.has('translate')) tfDecl.add(b.tgt);
  }
  const first = [], deferred = [];
  const byEl = new Map(); for (const k of onlyKeys) { const [el, ch] = k.split('|'); const a = byEl.get(el) || []; a.push(ch); byEl.set(el, a); }
  for (const k of onlyKeys) {
    const [el, ch] = k.split('|');
    const others = (byEl.get(el) || []).filter((c) => isTransformPart(c) && !/^ren:t[xyz]$/.test(c));
    if (tfDecl.has(els[+el]) && /^ren:t[xyz]$/.test(ch) && others.length) deferred.push(k); else first.push(k);
  }
  return { first, deferred };
}

/** The CSS properties a declared animation must name to drive a channel (`ren:ty` -> transform / translate). */
function channelProps(ch) {
  const c = String(ch).replace(/^(drv|ren):/, '');
  if (/^(t[xyz]|translate)$/.test(c)) return ['transform', 'translate'];
  if (/^(s[xyz]|scale)$/.test(c)) return ['transform', 'scale'];
  if (/^(r[xyz]|rotate)$/.test(c)) return ['transform', 'rotate'];
  if (/^sk[xy]$/.test(c)) return ['transform'];
  if (c === 'clipPath') return ['clip-path', 'clipPath'];
  return [c];
}
/** Does a declared birth (CSS animation / transition / WAAPI) on this element animate this channel's property? */
function declaresChannel(births, desc, ch) {
  const want = channelProps(ch);
  return (births || []).some((b) => b && b.tgt === desc && [String(b.name || ''), ...((b.keyframes || []).flatMap((k) => Object.keys(k || {})))]
    .some((p) => p === 'all' || want.includes(p)));
}
/**
 * The order the fit spends its evaluation budget in (fitTakeSet opts.order). Measured on an archived real site (load):
 * in plan order the first motion's 13 custom-property and transform channels spent the whole take budget, and the hero's
 * declared CSS entrance (700 ms, exact, read in milliseconds when aimed at) was never fitted. Order:
 *   1. the page scroll line, if planned;
 *   2. channels a declared animation of the element names (exact values, cheap), in rank order;
 *   3. the other lead channels, one per motion per round in rank order (each motion's strongest channel first);
 *   4. the folded groups' members, one per group per round.
 * @param {object[]} entries  planFit entries (with lead, fitted.lead, fitted.members, memberChannel)
 * @returns {string[]} keys `${el}|${channel}`, each planned key once
 */
export function fitOrder(entries, births, els, { pageKey = null } = {}) {
  const out = []; const seen = new Set(); const add = (k) => { if (!seen.has(k)) { seen.add(k); out.push(k); } };
  if (pageKey) add(pageKey);
  const leads = (entries || []).map((e) => ((e.fitted && e.fitted.lead) || []).map((c) => `${e.lead}|${c}`));
  const members = (entries || []).map((e) => ((e.fitted && e.fitted.members) || []).map((id) => `${id}|${e.memberChannel}`));
  const declared = (k) => { const [el, ch] = k.split('|'); return declaresChannel(births, els[+el], ch); };
  const dec = new Set();
  for (let i = 0; i < leads.length; i++) for (const k of [...leads[i], ...members[i]]) if (declared(k)) { add(k); dec.add(k); }
  const rounds = (lists) => { for (let r = 0, more = true; more; r++) { more = false; for (const l of lists) if (r < l.length) { more = true; add(l[r]); } } };
  rounds(leads); rounds(members);
  // the keys placed first because the page declared them (non-enumerable: the order itself stays a plain list). The fit
  // tries only the declared tier on them up front and requeues one the declaration does not explain at the end, so a
  // declared transition that a scroll overrides cannot spend the take budget before the scrubbed channels
  Object.defineProperty(out, 'declared', { value: dec, enumerable: false });
  return out;
}

/**
 * A computed transform string (`none`, `matrix(a, b, c, d, e, f)`, `matrix3d(16 numbers)`) -> its 16 matrix entries
 * (column-major, as DOMMatrix m11..m44), or null when it is not one of those forms.
 */
export function matrixOf(s) {
  if (s === 'none') return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const m = /^(matrix3d|matrix)\(([^)]*)\)$/.exec(String(s || '').trim()); if (!m) return null;
  const n = m[2].split(',').map(Number); if (n.some((x) => !Number.isFinite(x))) return null;
  if (m[1] === 'matrix3d') return n.length === 16 ? n : null;
  if (n.length !== 6) return null;
  const [a, b, c, d, e, f] = n; return [a, b, 0, 0, c, d, 0, 0, 0, 0, 1, 0, e, f, 0, 1];
}

/**
 * Which entries of the rendered matrix (`ren:transform`) change over `rows` for element `el`: names m11 .. m44, in
 * DOMMatrix order. m34 / m44 alone is a perspective change (a 3D zoom), which the decomposed parts do not carry.
 */
export function matrixChanges(rows, el) {
  let first = null; const changed = new Set();
  for (const r of rows) {
    const v = r.v && r.v[el]; if (!v || !('ren:transform' in v)) continue; const M = matrixOf(v['ren:transform']); if (!M) continue;
    if (!first) first = M; else M.forEach((x, i) => { if (Math.abs(x - first[i]) > 1e-6) changed.add(i); });
  }
  return [...changed].sort((a, b) => a - b).map((i) => `m${(i >> 2) + 1}${(i & 3) + 1}`);
}

/**
 * True when the rendered transform of element `el` was recorded and never changed over `rows`. A transform STRING that
 * changes meanwhile (`drv:transform` translate3d(0px, 0px, 0px) -> translate(0px, 0px), GSAP force3D "auto" at a
 * tween's end; `ren:transform` none -> identity matrix) switches between equivalent forms: nothing moved on screen.
 * "Rendered" is the whole computed matrix (`ren:transform`, all 16 entries), not only the decomposed parts ren:tx ..
 * ren:skx: those read a, b, c, d and m41..m43 and miss perspective (m34, m44), so a 3D zoom tweened with
 * perspective() would read as still. Without a parseable `ren:transform` the 7 parts decide.
 */
export function renderedTransformStill(rows, el) {
  let first = null, firstM = null, mats = 0, parts = 0;
  for (const r of rows) {
    const v = r.v && r.v[el]; if (!v) continue;
    const M = 'ren:transform' in v ? matrixOf(v['ren:transform']) : null;
    if (M) { mats++; if (!firstM) firstM = M; else if (M.some((x, i) => Math.abs(x - firstM[i]) > 1e-6)) return false; }
    else if ('ren:transform' in v) return false;   // a rendered transform we cannot read: never call it still
    const p = TF.map((c) => v[c]); if (p.some((x) => typeof x !== 'number' || !Number.isFinite(x))) continue;
    parts++; if (!first) first = p; else if (p.some((x, i) => Math.abs(x - first[i]) > 1e-6)) return false;
  }
  return mats > 0 || parts > 0;
}

/**
 * hover / click: did this fitted line start because of the action? A line that began before the first input, or that
 * plays on its own time and began well after it (a page-load tween that happens to run while the tool hovers), is not
 * the action's result. A line the fitter tied to the pointer, or with no start time, stays. `lagMs`: the longest
 * delay after the first input a time-driven line may have and still count (a hover reaction starts within a few frames).
 * @returns {null|{why:string}}  null = caused by the action; else why not
 */
export function notFromAction(line, tAction, action, lagMs = action === 'click' ? 250 : 50, tLast = null) {
  if (action !== 'hover' && action !== 'click') return null;
  if (!line || tAction == null || !Number.isFinite(line.t0)) return null;
  if (/reacts to the pointer|starts (after the|on (hover|press|release))/.test(line.trigger || '')) return null;
  if (line.t0 < tAction - 1) return { why: `started ${Math.round(tAction - line.t0)} ms before the ${action} (page load)` };
  // tLast: the last input of the action (a click's release: its handler runs there, 1 s after the hover began)
  const ref = tLast != null ? Math.max(tAction, tLast) : tAction;
  if (/plays on its own time/.test(line.trigger || '') && line.t0 - ref > lagMs) return { why: `started ${Math.round(line.t0 - ref)} ms after the ${action} ${tLast != null ? 'ended' : 'began'} and is not tied to the pointer (page load)` };
  return null;
}

// ---------------------------------------------------------------- trigger search (look --do hover|click)
// When the --el target cannot be the trigger (hidden, no size, never hit, or it does not react), look finds the control
// that changes it. These run in the page (serialised by page.evaluate: self-contained, no closures) or are pure.

/**
 * In page: a compact state of the aimed elements (at most 20): shown or not, own style (opacity, transform, filter,
 * clip, colours, stroke dash), size, and the box in document coordinates (so the page's own scroll does not count), plus
 * the number of finite animations running on them. `stateChanged` compares two of them.
 */
export function aimStateInPage(aim) {
  const q = (s) => { try { return [...document.querySelectorAll(s)]; } catch (e) { return []; } };
  const els = [...new Set(aim.flatMap(q))].slice(0, 20);
  const r2 = (x) => Math.round(x / 2) * 2;
  return { n: els.length, els: els.map((e) => {
    const cs = getComputedStyle(e); const r = e.getBoundingClientRect();
    let shown = r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
    try { if (shown && e.checkVisibility) shown = e.checkVisibility({ opacityProperty: true, visibilityProperty: true }); } catch (x) { /* old engine */ }
    let run = 0, inf = false; try { const ra = e.getAnimations().filter((a) => a.playState === 'running'); run = ra.length; inf = ra.some((a) => { try { return a.effect.getComputedTiming().iterations === Infinity; } catch (y) { return false; } }); } catch (x) { run = 0; }
    return { shown, inf, own: [cs.opacity, cs.transform, cs.filter, cs.clipPath, cs.color, cs.backgroundColor, cs.strokeDashoffset, cs.translate, cs.scale, cs.rotate].join('|'),
      size: [r2(r.width), r2(r.height)].join(','), box: [r2(r.x + scrollX), r2(r.y + scrollY)].join(','), run };
  }) };
}

/** Did the aimed elements change between two readings, leaving out an element an endless animation keeps moving (a
 *  loop that runs on its own is not a reaction, and never rests)? Shown / hidden still counts for it. */
export function restChanged(a, b) {
  if (!a || !b) return !!a !== !!b;
  if (a.n !== b.n) return true;
  return a.els.some((x, i) => { const y = b.els[i]; if (!y) return true; if (x.shown !== y.shown) return true; if (x.inf || y.inf) return false; return x.own !== y.own || x.run !== y.run || x.size !== y.size || x.box !== y.box; });
}

/** Did the aimed elements change between two aimStateInPage readings? {changed, own, shown, created} */
export function stateChanged(a, b) {
  if (!a || !b) return { changed: false };
  if (a.n !== b.n) return { changed: true, created: b.n > a.n, shown: b.els.some((e) => e.shown), own: false };
  let own = false, shown = false, moved = false;
  for (let i = 0; i < a.els.length; i++) {
    const x = a.els[i], y = b.els[i];
    if (x.own !== y.own || x.run !== y.run) own = true;
    if (x.shown !== y.shown) shown = true;
    if (x.size !== y.size || x.box !== y.box) moved = true;
  }
  return { changed: own || shown || moved, own, shown, moved, created: false };
}

/**
 * In page: what state the trigger target is in, and the candidate controls that may change the aimed elements, best
 * first. [aim selectors, trigger selector, max]. status: 'missing' (no match) | 'hidden' (no match is shown with a size)
 * | 'offscreen-or-covered' (shown, but no match can be hit once scrolled into view) | 'ok'.
 * Candidates (unique selectors; never a link to another document, never a text field):
 *   1. controls that name an ancestor-or-self of a target (aria-controls, popovertarget, commandfor, label for);
 *   2. a target with no size: its nearest shown ancestor (tapping the area it draws in, e.g. an SVG plane);
 *   3. controls in the target's own component (siblings first: the nearest ancestor that holds any);
 *   4. a target in a closed dialog / hidden subtree: one control per kind (tag + first class) from the whole page,
 *      aria-haspopup / aria-expanded first, then kinds repeated per item (a card's button).
 */
export function triggerCandidatesInPage([aim, trig, max, opt]) {
  const q = (s) => { try { return [...document.querySelectorAll(s)]; } catch (e) { return []; } };
  const targets = [...new Set(aim.flatMap(q))].slice(0, 20);
  const sized = (e) => { const r = e.getBoundingClientRect(); return r.width > 1 && r.height > 1; };
  const shown = (e) => { if (!sized(e)) return false; try { if (e.checkVisibility && !e.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false; } catch (x) { /* old engine */ } const cs = getComputedStyle(e); return cs.visibility !== 'hidden' && cs.display !== 'none'; };
  const hits = (e) => { const r = e.getBoundingClientRect(); const x = r.x + r.width / 2, y = r.y + r.height / 2; if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return false; const h = document.elementFromPoint(x, y); return !!h && (h === e || e.contains(h)); };
  // in a closed subtree: a closed dialog, a [hidden] or aria-hidden ancestor-or-self
  const inClosed = (e) => { for (let n = e; n && n.nodeType === 1; n = n.parentElement) if ((n.localName === 'dialog' && !n.open) || n.hidden || n.getAttribute('aria-hidden') === 'true') return true; return false; };
  // sized and displayed (no visibility:hidden, no display:none on it or above), not in a closed subtree, but transparent:
  // a reveal that has not run yet (a load fade with a delay, a scroll reveal below the fold), not a hidden target
  const transparentOnly = (e) => { if (!sized(e) || shown(e) || inClosed(e)) return false; try { if (e.checkVisibility && !e.checkVisibility({ visibilityProperty: true })) return false; } catch (x) { /* old engine */ } const cs = getComputedStyle(e); return cs.visibility !== 'hidden' && cs.display !== 'none'; };
  const trigEls = trig ? q(trig) : targets;
  let status = 'ok', reveal = null;
  const sx = scrollX, sy = scrollY;
  if (!trigEls.length) status = 'missing';
  else if (!trigEls.some(shown)) {
    // opt.settled: the reveal was waited for (look scrolled it into view and let it run); still transparent = hidden
    const t = trigEls.findIndex(transparentOnly);
    if (t >= 0 && !(opt && opt.settled)) { status = 'transparent'; reveal = t; } else status = 'hidden';
  } else {
    let hit = false;
    for (const e of trigEls.filter(shown).slice(0, 20)) { e.scrollIntoView({ block: 'center', behavior: 'instant' }); if (hits(e)) { hit = true; break; } }
    if (!hit) status = 'offscreen-or-covered';
  }
  scrollTo({ left: sx, top: sy, behavior: 'instant' });
  const esc = (s) => CSS.escape(s);
  const path = (e) => {
    if (e.id && document.querySelectorAll('#' + esc(e.id)).length === 1) return '#' + esc(e.id);
    const parts = []; let n = e;
    while (n && n.nodeType === 1 && n !== document.documentElement && n !== document.body) {
      if (n !== e && n.id && document.querySelectorAll('#' + esc(n.id)).length === 1) { parts.unshift('#' + esc(n.id)); break; }
      let s = n.localName; const cl = [...n.classList].filter((c) => /^[a-zA-Z_-][\w-]*$/.test(c)).slice(0, 2);
      if (cl.length) s += '.' + cl.map(esc).join('.');
      const p = n.parentElement;
      if (p) { const same = [...p.children].filter((c) => c.localName === n.localName); if (same.length > 1 && !(cl.length && same.filter((c) => cl.every((k) => c.classList.contains(k))).length === 1)) s += `:nth-of-type(${same.indexOf(n) + 1})`; }
      parts.unshift(s); n = p;
      try { if (document.querySelectorAll(parts.join(' > ')).length === 1) break; } catch (x) { break; }
    }
    return parts.join(' > ');
  };
  const INTER = 'button, a[href], [role=button], [role=tab], [role=switch], [role=option], summary, [aria-controls], [aria-expanded], [aria-haspopup], [popovertarget], [commandfor], [tabindex]:not([tabindex="-1"]), input[type=submit], input[type=button], input[type=checkbox], input[type=radio], label[for], [onclick]';
  const away = (e) => { if (e.localName !== 'a') return false; const h = e.getAttribute('href') || ''; if (h.startsWith('#') || /^javascript:/i.test(h)) return false; if (e.target && e.target !== '_self') return true; try { const u = new URL(e.href, location.href); return u.origin !== location.origin || u.pathname !== location.pathname; } catch (x) { return true; } };
  const text = (e) => /^(input|textarea|select)$/.test(e.localName) && !/^(submit|button|checkbox|radio)$/i.test(e.type || '');
  const usable = (e) => !away(e) && !text(e) && shown(e) && !e.disabled;
  const out = []; const seen = new Set();
  const add = (e, why) => { if (!e || seen.has(e) || out.length >= max) return; seen.add(e); if (!usable(e)) return; const s = path(e); if (!s) return; out.push({ selector: s, why, tag: e.localName, text: (e.getAttribute('aria-label') || e.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40) }); };
  const anc = (e) => { const a = []; for (let n = e; n && n.nodeType === 1; n = n.parentElement) a.push(n); return a; };
  const ids = new Set(targets.flatMap(anc).map((n) => n.id).filter(Boolean));
  // 1. controls that name a target or its container
  for (const c of q('[aria-controls], [popovertarget], [commandfor], label[for], [aria-owns]')) {
    const names = [c.getAttribute('aria-controls'), c.getAttribute('popovertarget'), c.getAttribute('commandfor'), c.getAttribute('for'), c.getAttribute('aria-owns')].filter(Boolean).join(' ').split(/\s+/);
    if (names.some((n) => ids.has(n))) add(c, 'names the target');
  }
  // a target that does not exist yet: the nearest part of its selector that does (".readout img" -> ".readout")
  let t0 = targets[0];
  if (!t0) for (const s of aim) { const parts = s.trim().split(/\s+(?![^\[]*\])/); while (!t0 && parts.length > 1) { parts.pop(); while (parts.length && /^[>+~]$/.test(parts[parts.length - 1])) parts.pop(); if (parts.length) t0 = q(parts.join(' '))[0]; } if (t0) break; }
  // 2. a target with no size: the area it draws in
  if (targets.length && !targets.some(sized)) for (const a of anc(t0).slice(1, 6)) { if (a === document.body || a === document.documentElement) break; if (shown(a)) { add(a, 'the area the target draws in'); break; } }
  // 3. the target's own component
  if (t0) {
    for (const a of anc(t0).slice(1, 8)) {
      if (a === document.body || a === document.documentElement) break;
      // (in the component, items a pointer can rest on count too: a chart column with a tabindex, a list item)
      const inside = [...a.querySelectorAll(INTER + ', [tabindex], [role=listitem], [role=gridcell], [role=row], [role=img]')].filter((c) => !targets.includes(c) && usable(c));
      if (!inside.length) continue;
      const kinds = new Set();
      for (const c of inside) { const k = c.localName + '.' + ([...c.classList][0] || '') + '.' + (c.getAttribute('role') || ''); if (kinds.has(k)) continue; kinds.add(k); add(c, 'in the target\'s component'); }
      if (a.matches('section, article, dialog, form, [role=dialog], [role=region]') || out.length >= 3) break;
    }
  }
  // 4. a target inside a closed dialog / hidden subtree: one control per kind from the whole page
  const closed = t0 && anc(t0).some((a) => (a.localName === 'dialog' && !a.open) || a.hidden || a.getAttribute('aria-hidden') === 'true' || getComputedStyle(a).display === 'none' || getComputedStyle(a).visibility === 'hidden');
  if (closed || status !== 'ok') {
    const kinds = new Map();
    for (const c of q(INTER)) {
      if (targets.includes(c) || targets.some((t) => t.contains(c)) || !usable(c)) continue;
      const k = c.localName + '.' + ([...c.classList][0] || '');
      if (!kinds.has(k)) kinds.set(k, { el: c, n: 0, pop: false });
      const g = kinds.get(k); g.n++; if (c.hasAttribute('aria-haspopup') || c.getAttribute('aria-expanded') === 'false') g.pop = true;
    }
    const order = [...kinds.values()].sort((a, b) => (b.pop - a.pop) || ((b.n >= 3) - (a.n >= 3)) || (b.n - a.n));
    for (const g of order) add(g.el, g.pop ? 'opens something (aria)' : g.n >= 3 ? 'repeated per item' : 'a control on the page');
  }
  // opt.matchesExcept (the index of the match the action used): the other matches of the trigger that are shown and can be
  // hit once scrolled into view, as unique selectors; a current / selected / disabled one last (clicking it changes nothing)
  let matches;
  if (opt && Number.isInteger(opt.matchesExcept)) {
    const m = []; const sx2 = scrollX, sy2 = scrollY;
    for (let i = 0; i < trigEls.length && i < 60 && m.length < 12; i++) {
      const e = trigEls[i]; if (i === opt.matchesExcept || !shown(e)) continue;
      e.scrollIntoView({ block: 'center', behavior: 'instant' }); if (!hits(e)) continue;
      const s = path(e); if (!s || m.some((x) => x.selector === s)) continue;
      const late = e.getAttribute('aria-current') != null && e.getAttribute('aria-current') !== 'false' || e.getAttribute('aria-selected') === 'true' || !!e.disabled || e.getAttribute('aria-disabled') === 'true';
      m.push({ selector: s, index: i, late });
    }
    scrollTo({ left: sx2, top: sy2, behavior: 'instant' });
    matches = [...m.filter((x) => !x.late), ...m.filter((x) => x.late)].slice(0, opt.maxMatches || 3);
  }
  return { status, n: trigEls.length, candidates: out, ...(reveal != null ? { reveal } : {}), ...(matches ? { matches } : {}) };
}

/**
 * In page: is a finite animation (a CSS transition / animation, a Web Animation, running or still in its delay) on an
 * aimed element or one of its ancestors? A load fade with a delay leaves the target transparent and unchanged until it
 * starts, so two equal state readings alone do not mean the reveal is over.
 */
export function revealPendingInPage(aim) {
  const q = (s) => { try { return [...document.querySelectorAll(s)]; } catch (e) { return []; } };
  const targets = [...new Set(aim.flatMap(q))].slice(0, 20);
  if (!targets.length) return false;
  let anims = []; try { anims = document.getAnimations(); } catch (e) { return false; }
  for (const a of anims) {
    if (a.playState !== 'running' && a.playState !== 'pending') continue;
    let t = null; try { t = a.effect && a.effect.getComputedTiming(); } catch (e) { t = null; }
    if (!t || !Number.isFinite(t.endTime) || t.iterations === Infinity) continue;
    const tg = a.effect && a.effect.target; if (!tg || tg.nodeType !== 1) continue;
    if (targets.some((e) => tg === e || tg.contains(e))) return true;
  }
  return false;
}

/**
 * Did the action start a declared CSS transition / animation on the aimed elements (or their pseudo-elements)? A hover
 * that grows an underline (background-size, a ::after scale) changes no sampled channel, yet the page declared its motion.
 * @param {object[]} births  recorder births ({type, tgt, T})
 * @param {Set<string>|string[]} descs  descriptors of the aimed elements (W.desc)
 * @param {number} fromT  the action's first input (page ms); toT: the end of the action window (optional)
 */
export function declaredReaction(births, descs, fromT, toT = Infinity) {
  const want = descs instanceof Set ? descs : new Set(descs || []);
  if (!want.size) return null;
  for (const b of births || []) {
    if (!b || !/^CSS(Transition|Animation)$/.test(String(b.type || '')) || !Number.isFinite(b.T) || b.T < fromT - 1 || b.T > toT) continue;
    const base = String(b.tgt || '').replace(/::(before|after|marker|placeholder|first-letter|first-line|backdrop|selection|file-selector-button)$/, '');
    if (want.has(base)) return { name: b.name, tgt: b.tgt, T: b.T };
  }
  return null;
}
