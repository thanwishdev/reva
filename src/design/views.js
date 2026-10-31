// Derived design views (stage D3), built FROM the captured rule table (src/static/ruletable.js) and the element
// snapshots of the gate (src/gate/snapshot.js). No browser: everything here is a pure function of recorded data.
//   components   repeated structures: families of subtrees grouped by root tag + base rule set, variants = distinct
//                (DOM shape + rule-id set) signatures, with instance counts
//   sections     page outline: landmarks / top-level blocks in document order with box and size share
//   breakpoints  per measured edge: rules that start / stop applying (media and container conditions evaluated at
//                both sides) and the elements / computed properties that change there (snapshots at t-1 and t+1)
//   assets       element -> asset map: img/srcset/picture/video/svg/object + url() in computed styles (background,
//                mask, list-style, border-image, content, cursor) + fonts actually used, with request + archive file
import { evalMedia, evalCondition, mediaEnv } from './media.js';
import { decodeStyle } from '../gate/snapshot.js';

// ---------- shared helpers ----------
/** Snapshot (gate) -> Map(key -> {b, t, f, style()}) with lazy style decoding. */
export function snapIndex(snap) {
  const m = new Map();
  for (const e of snap.els) {
    let st = null, ps = null;
    m.set(e.k, { b: e.b, t: e.t, f: e.f, style: () => st || (st = decodeStyle(snap, e.s)), pseudo: () => ps || (ps = Object.fromEntries(Object.entries(e.ps || {}).map(([w, f]) => [w, decodeStyle(snap, f)]))) });
  }
  return m;
}
/** Every node of the table's DOM trees (documents, shadow roots, iframes), parents before children. */
function nodes(table) {
  const out = [];
  const walk = (n, doc) => { if (!n || typeof n === 'string') return; out.push({ n, doc }); if (n.sr) for (const c of n.sr.c) walk(c, doc); for (const c of n.c || []) walk(c, doc); };
  for (const d of table.docs) walk(d.tree, d.i);
  return out;
}
const attrs = n => Object.fromEntries(n.a || []);
const elKids = n => [...(n.sr ? n.sr.c : []), ...(n.c || [])].filter(c => c && typeof c !== 'string');
const textOf = n => { let s = ''; const w = x => { if (typeof x === 'string') s += x; else if (x) { for (const c of x.c || []) w(c); } }; w(n); return s.replace(/\s+/g, ' ').trim(); };
const ruleIdsOf = e => { const s = new Set([...(e.r || []), ...(e.hr || []), ...(e.st || [])]); for (const ids of Object.values(e.pe || {})) for (const id of ids) s.add(id); return [...s].sort((a, b) => a - b); };
const maxSpec = r => (r.spec || [[0, 0, 0]]).reduce((m, x) => (x[0] - m[0] || x[1] - m[1] || x[2] - m[2]) > 0 ? x : m, [0, 0, 0]);
const specCmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

// ---------- components ----------
/**
 * Components = families of repeated subtrees. A subtree's signature is its DOM shape (tags, recursively) plus the rule-id
 * set of every element in it (selector matches recorded by the engine, whatever the condition or state). The family
 * key is the root's tag + its BASE rules: the matched rules that carry a class / id / attribute (type and universal
 * rules describe every element, not a component) with the lowest specificity among them (`.card` for both
 * `.card` and `.card.has-media`; a modifier or an attribute state adds a more specific rule, which makes a variant).
 * Variants = distinct signatures inside a family. A family whose instances all sit inside instances of another
 * family is listed as a part of it.
 */
export function components(table, { minInstances = 2 } = {}) {
  const R = table.rules, E = table.els;
  const intern = new Map(); const id = s => { let v = intern.get(s); if (v === undefined) { v = intern.size; intern.set(s, v); } return v; };
  const info = new Map(); // el index -> {tag, ids, shape, exact, size, node}
  const sig = n => {
    const kids = elKids(n).map(sig);
    const e = E[n.i]; const ids = ruleIdsOf(e);
    const x = { tag: n.t, ids, node: n, shape: id(`${n.t}(${kids.map(k => k.shape).join(',')})`), exact: id(`${n.t}[${ids.join(',')}](${kids.map(k => k.exact).join(',')})`), size: 1 + kids.reduce((s, k) => s + k.size, 0) };
    info.set(n.i, x);
    return x;
  };
  for (const d of table.docs) sig(d.tree);
  const fams = new Map();
  for (const [i, x] of info) {
    const idRules = x.ids.filter(r => R[r].t === 'style' && (maxSpec(R[r])[0] > 0 || maxSpec(R[r])[1] > 0));
    if (!idRules.length || x.tag === 'html' || x.tag === 'body') continue;
    const lo = idRules.map(r => maxSpec(R[r])).reduce((m, s) => (specCmp(s, m) < 0 ? s : m));
    const base = idRules.filter(r => specCmp(maxSpec(R[r]), lo) === 0);
    const key = `${x.tag}|${base.join(',')}`;
    let f = fams.get(key); if (!f) fams.set(key, f = { key, tag: x.tag, base, members: [] });
    f.members.push(i);
  }
  const list = [...fams.values()].filter(f => f.members.length >= minInstances);
  // parts: every instance inside an instance of another (listed) family
  const famOf = new Map(); list.forEach((f, j) => { for (const i of f.members) famOf.set(i, j); });
  const out = list.map((f, j) => {
    const common = f.members.map(i => new Set(info.get(i).ids)).reduce((a, b) => new Set([...a].filter(x => b.has(x))));
    const byExact = new Map();
    for (const i of f.members) { const x = info.get(i); let v = byExact.get(x.exact); if (!v) byExact.set(x.exact, v = { exact: x.exact, shape: x.shape, members: [] }); v.members.push(i); }
    const variants = [...byExact.values()].sort((a, b) => b.members.length - a.members.length).map(v => {
      const x = info.get(v.members[0]);
      const extra = x.ids.filter(r => !common.has(r));
      return { instances: v.members.length, extraRules: extra.map(r => ({ id: r, sel: R[r].sel })), shape: shapeText(x.node), elements: x.size, keys: v.members.slice(0, 5).map(i => E[i].k) };
    });
    let partOf = null;
    const anc = i => { const s = []; for (let k = E[i].pi; k != null; k = E[k].pi) s.push(k); return s; };
    const parents = f.members.map(i => anc(i).map(k => famOf.get(k)).find(g => g != null && g !== j));
    if (parents.every(p => p != null && p === parents[0])) partOf = parents[0];
    return { id: j, name: `${f.tag} ${[...new Set(f.base.map(r => R[r].sel))].join(' | ')}`, tag: f.tag, base: f.base.map(r => ({ id: r, sel: R[r].sel })), instances: f.members.length, variants, partOf, commonRules: common.size };
  });
  for (const c of out) if (c.partOf != null) (out[c.partOf].parts || (out[c.partOf].parts = [])).push(c.id);
  out.sort((a, b) => (b.instances * b.variants[0].elements) - (a.instances * a.variants[0].elements));
  return { count: out.length, top: out.filter(c => c.partOf == null).length, components: out };
}
function shapeText(n, depth = 0) {
  const kids = elKids(n);
  if (!kids.length || depth >= 2) return n.t + (kids.length ? '(…)' : '');
  return `${n.t}(${kids.map(k => shapeText(k, depth + 1)).join(' ')})`;
}

// ---------- sections ----------
const REGION_ROLES = new Set(['banner', 'navigation', 'main', 'contentinfo', 'complementary', 'form', 'search', 'region']);
const LANDMARK = { header: 'banner', nav: 'navigation', main: 'main', footer: 'contentinfo', aside: 'complementary', form: 'form', search: 'search' };
/**
 * Page outline from the table's DOM + the snapshot boxes at the same point: the rendered children of body, in
 * document order, descending through `main` and through wrappers (a block whose rendered children are themselves
 * blocks covering it, i.e. one child, or children that include landmarks / sections). Each entry: key, tag, role
 * (explicit or implicit landmark), label (aria-label or first heading), box, size share of the document height.
 */
export function sections(table, snap, { maxDepth = 4 } = {}) {
  const S = snapIndex(snap), E = table.els;
  const docH = snap.docH || 1;
  const body = elKids(table.docs[0].tree).find(n => n.t === 'body');
  if (!body) return { outline: [], docH };
  const box = n => S.get(E[n.i].k)?.b || [0, 0, 0, 0];
  const st = n => S.get(E[n.i].k)?.style() || new Map();
  const rendered = n => { const b = box(n), s = st(n); return s.get('display') !== 'none' && (b[2] > 0 && b[3] > 0); };
  const role = (n, inSection) => { const a = attrs(n); if (a.role) return a.role; if ((n.t === 'header' || n.t === 'footer') && inSection) return null; if (n.t === 'section') return a['aria-label'] || a['aria-labelledby'] ? 'region' : null; return LANDMARK[n.t] || null; };
  const heading = n => { let h = null; const w = x => { if (h || !x || typeof x === 'string') return; if (/^h[1-6]$/.test(x.t)) { h = { level: +x.t[1], text: textOf(x).slice(0, 120) }; return; } for (const c of elKids(x)) w(c); }; w(n); return h; };
  // display: contents wrappers (framework roots) have no box: their children take their place
  const flat = n => elKids(n).flatMap(c => (st(c).get('display') === 'contents' ? flat(c) : [c]));
  const outline = [];
  const visit = (n, depth, parent, inSection) => {
    const kids = flat(n).filter(rendered);
    for (const c of kids) {
      const b = box(c), s = st(c), a = attrs(c), r = role(c, inSection);
      const h = heading(c);
      const entry = { k: E[c.i].k, tag: c.t, depth, parent, role: r, label: a['aria-label'] || (h ? h.text : null), heading: h, id: a.id || null,
        box: b, share: Math.round(1000 * b[3] / docH) / 1000, position: ['fixed', 'sticky', 'absolute'].includes(s.get('position')) ? s.get('position') : undefined };
      const idx = outline.length; outline.push(entry);
      const sub = flat(c).filter(rendered);
      const wrapper = c.t === 'main' || r === 'main' || (!r && ((sub.length === 1 && flat(sub[0]).some(rendered) && box(sub[0])[3] >= 0.6 * b[3]) || sub.some(k => REGION_ROLES.has(role(k, true)) || k.t === 'section')));
      if (wrapper && depth + 1 < maxDepth && sub.length) visit(c, depth + 1, idx, inSection || ['article', 'aside', 'main', 'nav', 'section'].includes(c.t));
    }
  };
  visit(body, 0, null, false);
  return { docH, vw: snap.vw, outline };
}

// ---------- breakpoints ----------
const docScope = sc => (/^d\d+/.exec(sc) || ['d0'])[0];
/** Condition chain of a rule: [{kind, id, cond, name}] for media / container / supports groups (incl. sheet media). */
function chainOf(table, r) {
  const out = [];
  for (const gid of r.ctx || []) {
    const g = table.rules[gid];
    if (g.t === 'media') out.push({ kind: 'media', id: gid, cond: g.cond });
    else if (g.t === 'import' && g.media && g.media !== 'all') out.push({ kind: 'media', id: gid, cond: g.media });
    else if (g.t === 'container') out.push({ kind: 'container', id: gid, cond: g.cond, name: g.name || null });
    else if (g.t === 'supports') out.push({ kind: 'supports', id: gid, active: g.active ?? null });
  }
  return out;
}
const px = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
/** Viewport environment of each document scope at one point: d0 = the window; an iframe doc = the iframe's content box. */
function envs(table, S, base) {
  const m = { d0: base };
  for (const d of table.docs) {
    if (d.i === 0) continue;
    const host = table.els[d.tree.i]?.pi;
    const s = host != null ? S.get(table.els[host].k) : null;
    if (!s) { m[d.scope] = null; continue; }
    const st = s.style();
    m[d.scope] = { ...base, w: s.b[2] - px(st.get('padding-left')) - px(st.get('padding-right')) - px(st.get('border-left-width')) - px(st.get('border-right-width')), h: s.b[3] - px(st.get('padding-top')) - px(st.get('padding-bottom')) - px(st.get('border-top-width')) - px(st.get('border-bottom-width')) };
  }
  return m;
}
/** Query container of element i for a container rule (nearest ancestor with container-type, matching name). */
function containerEnv(table, S, i, name) {
  for (let k = table.els[i].pi; k != null; k = table.els[k].pi) {
    const s = S.get(table.els[k].k); if (!s) continue;
    const st = s.style(); const type = st.get('container-type');
    if (!type || type === 'normal') continue;
    if (name && !String(st.get('container-name') || '').split(/\s+/).includes(name)) continue;
    const w = s.b[2] - px(st.get('padding-left')) - px(st.get('padding-right')) - px(st.get('border-left-width')) - px(st.get('border-right-width'));
    const h = type === 'size' ? s.b[3] - px(st.get('padding-top')) - px(st.get('padding-bottom')) - px(st.get('border-top-width')) - px(st.get('border-bottom-width')) : null;
    return { w, h, container: table.els[k].k };
  }
  return null;
}
/** Elements each style rule matches as a subject (any condition / state), from the table. */
function matchIndex(table) {
  const m = new Map();
  table.els.forEach((e, i) => { for (const id of ruleIdsOf(e)) { let s = m.get(id); if (!s) m.set(id, s = []); s.push(i); } });
  return m;
}

/**
 * Whether each conditional style rule applies at one point: media chains against the viewport (or the iframe's box),
 * container chains per matched element against its query container's box from the snapshot, supports as recorded.
 * Returns Map(ruleId -> {state: true|false|null, perEl?: Map(elIndex -> true|false|null)}). Unconditional rules are
 * omitted.
 */
export function ruleStates(table, snap, envBase) {
  const S = snapIndex(snap);
  const E = envs(table, S, envBase);
  const M = matchIndex(table);
  const out = new Map();
  for (const r of table.rules) {
    if (r.t !== 'style' || r.starting) continue;
    const ch = chainOf(table, r);
    if (!ch.length) continue;
    const env = E[docScope(r.scope)];
    let state = true;
    const conts = [];
    for (const c of ch) {
      const v = c.kind === 'media' ? (env ? evalMedia(c.cond, env) : null) : c.kind === 'supports' ? c.active : (conts.push(c), true);
      state = state === false || v === false ? false : state === null || v === null ? null : true;
    }
    if (!conts.length) { out.set(r.id, { state }); continue; }
    const perEl = new Map();
    for (const i of M.get(r.id) || []) {
      let s = state;
      for (const c of conts) { const ce = containerEnv(table, S, i, c.name); const v = ce ? evalCondition(c.cond, ce, 'container') : null; s = s === false || v === false ? false : s === null || v === null ? null : true; }
      perEl.set(i, s);
    }
    const vals = [...perEl.values()];
    out.set(r.id, { state: vals.length ? (vals.some(v => v === true) ? true : vals.some(v => v === null) ? null : false) : state, perEl, container: true });
  }
  return out;
}

const SHORT = { inset: ['top', 'right', 'bottom', 'left'], gap: ['row-gap', 'column-gap'], 'grid-gap': ['row-gap', 'column-gap'], 'place-items': ['align-items', 'justify-items'], 'place-content': ['align-content', 'justify-content'], 'place-self': ['align-self', 'justify-self'], 'padding-inline': ['padding-left', 'padding-right'], 'padding-block': ['padding-top', 'padding-bottom'], 'margin-inline': ['margin-left', 'margin-right'], 'margin-block': ['margin-top', 'margin-bottom'], 'padding-inline-start': ['padding-left'], 'padding-inline-end': ['padding-right'], 'margin-inline-start': ['margin-left'], 'margin-inline-end': ['margin-right'], 'padding-block-start': ['padding-top'], 'padding-block-end': ['padding-bottom'], 'margin-block-start': ['margin-top'], 'margin-block-end': ['margin-bottom'], 'inline-size': ['width'], 'block-size': ['height'], 'min-inline-size': ['min-width'], 'max-inline-size': ['max-width'], 'min-block-size': ['min-height'], 'max-block-size': ['max-height'], 'inset-inline': ['left', 'right'], 'inset-block': ['top', 'bottom'], font: ['font-', 'line-height'], grid: ['grid-'], 'grid-area': ['grid-row', 'grid-column'], 'grid-row': ['grid-row-'], 'grid-column': ['grid-column-'], overflow: ['overflow-x', 'overflow-y'] };
/** Computed properties a declared property can change. */
export function covers(declared, computed) {
  if (declared === computed) return true;
  if (computed.startsWith(declared + '-')) return true;
  for (const x of SHORT[declared] || []) if (x.endsWith('-') ? computed.startsWith(x) : computed === x || computed.startsWith(x + '-')) return true;
  return false;
}
const INHERITED = /^(--|color$|font|line-height|letter-spacing|word-spacing|text-(align|indent|transform|shadow|rendering|wrap)|white-space|visibility|cursor|list-style|direction|writing-mode|quotes|tab-size|hyphens|-webkit-text-fill-color|caret-color)/;

const numShape = v => String(v ?? '').replace(/-?\d*\.?\d+(e-?\d+)?/g, '#');
/** Two computed values that differ only in their numbers (same units, same number of tracks / layers). */
export const continuous = (a, b) => a != null && b != null && numShape(a) === numShape(b) && /\d/.test(String(a));

/** Snapshot diff between two points: key -> {props: {p: [a, b]}, box: [a, b] | undefined}; added / removed keys. */
export function snapDiff(a, b, { boxTol = 0.5 } = {}) {
  const A = snapIndex(a), B = snapIndex(b);
  const changed = new Map(); const removed = [], added = [];
  for (const [k, x] of A) {
    const y = B.get(k); if (!y) { removed.push(k); continue; }
    const sa = x.style(), sb = y.style(); const props = {};
    for (const [p, v] of sa) { const w = sb.get(p); if (w !== v) props[p] = [v, w ?? null]; }
    for (const [p, w] of sb) if (!sa.has(p)) props[p] = [null, w];
    const boxCh = x.b.some((v, j) => Math.abs(v - y.b[j]) > boxTol);
    if (Object.keys(props).length || boxCh) changed.set(k, { props, ...(boxCh ? { box: [x.b, y.b] } : {}) });
  }
  for (const k of B.keys()) if (!A.has(k)) added.push(k);
  return { changed, added, removed };
}

/**
 * Breakpoint change list. edges: [{t, cls, below: {pointId, snap}, above: {pointId, snap}, env: {h, dpr, touch}}];
 * table = the rule table of that class. Per edge: rules whose applying condition differs between t-1 and t+1
 * (on = starts applying going wider, off = stops), with the elements they match and the computed properties of those
 * elements that change; changes not covered by a flipped rule (fluid units, script, inherited from elsewhere) are
 * summarised separately. Also the declared thresholds of the top document's media groups over the swept range.
 */
export function breakpoints(table, edges, { range = null, maxEls = 40 } = {}) {
  const R = table.rules, E = table.els;
  const keyIdx = new Map(E.map((e, i) => [e.k, i]));
  const out = [];
  for (const ed of edges) {
    const envA = mediaEnv({ ...ed.env, w: ed.below.snap.vw, h: ed.below.snap.vh }), envB = mediaEnv({ ...ed.env, w: ed.above.snap.vw, h: ed.above.snap.vh });
    const sa = ruleStates(table, ed.below.snap, envA), sb = ruleStates(table, ed.above.snap, envB);
    const flips = [], unknown = [];
    for (const [id, x] of sa) {
      const y = sb.get(id);
      if (x.perEl) {
        const els = [];
        for (const [i, v] of x.perEl) { const w = y.perEl.get(i); if (v !== w) els.push({ i, from: v, to: w }); }
        if (els.some(e => e.from === null || e.to === null)) unknown.push({ id, sel: R[id].sel, why: 'container condition not evaluable' });
        const on = els.filter(e => e.from === false && e.to === true).map(e => e.i), off = els.filter(e => e.from === true && e.to === false).map(e => e.i);
        if (on.length) flips.push({ id, dir: 'on', els: on, container: true });
        if (off.length) flips.push({ id, dir: 'off', els: off, container: true });
      } else if (x.state !== y.state) {
        if (x.state === null || y.state === null) { unknown.push({ id, sel: R[id].sel, why: 'condition not evaluable' }); continue; }
        flips.push({ id, dir: y.state ? 'on' : 'off', els: matchIndex(table).get(id) || [] });
      }
    }
    // computed changes
    const diff = snapDiff(ed.below.snap, ed.above.snap);
    const explained = new Map(); // key -> Set(props)
    const byRule = flips.map(f => {
      const r = R[f.id]; const decl = (r.d || []).map(([p]) => p);
      const els = [];
      for (const i of f.els) {
        const k = E[i].k; const ch = diff.changed.get(k);
        const props = ch ? Object.fromEntries(Object.entries(ch.props).filter(([p]) => decl.some(d => covers(d, p)))) : {};
        if (Object.keys(props).length) { els.push({ k, props }); const s = explained.get(k) || new Set(); for (const p of Object.keys(props)) s.add(p); explained.set(k, s); }
      }
      return { id: f.id, dir: f.dir, sel: r.sel, when: chainOf(table, r).map(c => c.kind === 'container' ? `@container ${c.name ? c.name + ' ' : ''}${c.cond}` : c.kind === 'media' ? `@media ${c.cond}` : '@supports').join(' > '), declares: decl, matched: f.els.length, changed: els.length, elements: els.slice(0, maxEls), ...(f.container ? { container: true } : {}) };
    });
    // inherited propagation of explained props to descendants
    const rest = new Map(), inheritedN = { elements: 0 }; const fluidEls = new Set(); let boxEls = 0, underEls = 0;
    for (const [k, ch] of diff.changed) {
      const ex = explained.get(k) || new Set();
      let anc = new Set();
      const i = keyIdx.get(k);
      if (i != null) for (let p = E[i].pi; p != null; p = E[p].pi) { const s = explained.get(E[p].k); if (s) for (const x of s) anc.add(x); }
      const left = Object.keys(ch.props).filter(p => !ex.has(p) && !(anc.has(p) && INHERITED.test(p)));
      if (left.length < Object.keys(ch.props).length && !ex.size) inheritedN.elements++;
      // continuous = the same value shape with other numbers (fluid units, % of a resized box): not a breakpoint
      const disc = left.filter(p => !continuous(ch.props[p][0], ch.props[p][1]));
      if (left.length > disc.length) fluidEls.add(k);
      if (disc.length && anc.size) underEls++; else if (disc.length) rest.set(k, disc);
      if (ch.box) boxEls++;
    }
    const hist = {}; for (const ps of rest.values()) for (const p of ps) hist[p] = (hist[p] || 0) + 1;
    out.push({
      edge: ed.t, cls: ed.cls, below: ed.below.pointId, above: ed.above.pointId,
      rulesOn: byRule.filter(x => x.dir === 'on'), rulesOff: byRule.filter(x => x.dir === 'off'), unknown,
      changes: { elements: diff.changed.size, added: diff.added.length, removed: diff.removed.length, explainedElements: explained.size, inheritedElements: inheritedN.elements, fluidElements: fluidEls.size, insideFlipped: underEls, boxChanged: boxEls,
        other: { what: 'discrete computed changes no flipped rule explains (script, inherited, container, structure)', elements: rest.size, topProps: Object.entries(hist).sort((a, b) => b[1] - a[1]).slice(0, 12), sample: [...rest.keys()].slice(0, 8), addedSample: diff.added.slice(0, 5), removedSample: diff.removed.slice(0, 5) } },
      explanation: byRule.length ? 'rules' : diff.added.length || diff.removed.length ? 'structure (script) - no rule flips' : 'no rule flips (fluid / script / container outside the edge)',
    });
  }
  return { edges: out, declared: range ? declaredThresholds(table, range, edges[0]?.env) : null };
}

/** Widths where a top-document media group condition flips over [from, to] (last old width t), pure sweep. */
export function declaredThresholds(table, { from, to, h = 900 }, env = {}) {
  const groups = new Map();
  for (const r of table.rules) {
    if (r.t !== 'style' || docScope(r.scope) !== 'd0') continue;
    for (const c of chainOf(table, r)) if (c.kind === 'media') { const g = groups.get(c.cond) || { cond: c.cond, rules: 0 }; g.rules++; groups.set(c.cond, g); }
  }
  const out = new Map();
  for (const g of groups.values()) {
    let prev = evalMedia(g.cond, mediaEnv({ ...env, w: from, h }));
    for (let w = from + 1; w <= to; w++) {
      const v = evalMedia(g.cond, mediaEnv({ ...env, w, h }));
      if (v !== prev && v !== null && prev !== null) { const t = w - 1; const x = out.get(t) || { t, conds: [] }; x.conds.push({ cond: g.cond, rules: g.rules, to: v }); out.set(t, x); }
      prev = v;
    }
  }
  return [...out.values()].sort((a, b) => a.t - b.t);
}

// ---------- assets ----------
const URL_RE = /url\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^)\s]*))\s*\)/g;
export function urlsIn(v) { return [...String(v || '').matchAll(URL_RE)].map(m => (m[1] ?? m[2] ?? m[3] ?? '').replace(/\\(.)/g, '$1')).filter(u => u && !u.startsWith('#')); }
/** srcset -> [{url, d}] (candidate strings split on commas that follow a descriptor or a URL). */
export function parseSrcset(s) {
  const out = []; const str = String(s || ''); let i = 0;
  while (i < str.length) {
    while (i < str.length && /[\s,]/.test(str[i])) i++;
    if (i >= str.length) break;
    let j = i; while (j < str.length && !/\s/.test(str[j])) j++;
    let url = str.slice(i, j); let d = '';
    if (url.endsWith(',')) { url = url.replace(/,+$/, ''); i = j; out.push({ url, d }); continue; }
    let k = j; let depth = 0; while (k < str.length && (depth || str[k] !== ',')) { if (str[k] === '(') depth++; else if (str[k] === ')') depth--; k++; }
    d = str.slice(j, k).trim(); i = k + 1;
    out.push({ url, d });
  }
  return out;
}
const CSS_ASSET_PROPS = ['background-image', 'mask-image', '-webkit-mask-image', 'mask-border-source', '-webkit-mask-box-image-source', 'border-image-source', 'list-style-image', 'content', 'cursor', 'shape-outside', 'filter', 'clip-path'];
const famName = s => String(s).trim().replace(/^["']|["']$/g, '').toLowerCase();
const weightIn = (w, desc) => { if (!desc) return true; const p = String(desc).split(/\s+/).map(x => (x === 'normal' ? 400 : x === 'bold' ? 700 : parseFloat(x))); return p.length > 1 ? w >= p[0] && w <= p[1] : w === p[0]; };

/**
 * Element -> asset map at the captured point. table + snapshot of the same point; requests = the session's request
 * list [{type, url}]; fileFor(url) -> archive file path or null. Every asset says how it is referenced (attribute /
 * srcset candidate / picture source / computed property / pseudo-element / font face), whether the page requested it,
 * and where it is in the archive.
 */
export function assets(table, snap, { requests = [], fileFor = () => null, baseUrl = table.url } = {}) {
  const S = snapIndex(snap), E = table.els;
  const req = new Set(requests.map(r => r.url));
  const abs = (u, base = baseUrl) => { try { return new URL(u, base).href; } catch { return u; } };
  const per = new Map(); const all = new Map();
  const put = (i, a) => {
    const k = E[i].k; if (!per.has(k)) per.set(k, []);
    const url = a.url ? abs(a.url, a.base) : null; delete a.base;
    const res = url ? url.replace(/#.*$/, '') : null; // the resource (an svg sprite `file.svg#id` is one request)
    const rec = { ...a, url, ...(url ? (url.startsWith('data:') ? { inline: 'data-uri', url: url.slice(0, 40) + '…' } : { requested: req.has(res), file: fileFor(res) }) : {}) };
    per.get(k).push(rec);
    if (url && !url.startsWith('data:')) { let x = all.get(res); if (!x) all.set(res, x = { url: res, kinds: new Set(), elements: new Set(), requested: req.has(res), file: fileFor(res) }); x.kinds.add(a.kind); x.elements.add(k); }
  };
  const faces = table.rules.filter(r => r.t === 'font-face').map(r => { const d = Object.fromEntries(r.d || []); return { id: r.id, family: famName(d['font-family'] || ''), weight: d['font-weight'], style: d['font-style'] || 'normal', src: urlsIn(d.src), base: table.sheets[r.sheet]?.href || baseUrl }; });
  for (const { n, doc } of nodes(table)) {
    const i = n.i, a = attrs(n), docUrl = table.docs[doc].url;
    const t = n.t;
    if ((t === 'img' || t === 'source' || (t === 'input' && a.type === 'image')) && a.src) put(i, { kind: t === 'source' ? 'source' : 'img', attr: 'src', url: a.src, ...(a.loading ? { loading: a.loading } : {}), base: docUrl });
    if ((t === 'img' || t === 'source') && a.srcset) for (const c of parseSrcset(a.srcset)) put(i, { kind: t === 'source' ? 'source-srcset' : 'srcset', attr: 'srcset', url: c.url, descriptor: c.d || '1x', ...(a.sizes ? { sizes: a.sizes } : {}), ...(a.media ? { media: a.media } : {}), ...(a.type ? { type: a.type } : {}), base: docUrl });
    if (t === 'picture') {
      // the picture's img gets every source candidate (the engine picks one source per point)
      const img = elKids(n).find(c => c.t === 'img');
      if (img) for (const s of elKids(n).filter(c => c.t === 'source')) { const sa = attrs(s); for (const c of parseSrcset(sa.srcset || sa.src || '')) put(img.i, { kind: 'picture-source', url: c.url, descriptor: c.d || '1x', ...(sa.media ? { media: sa.media } : {}), ...(sa.type ? { type: sa.type } : {}), base: docUrl }); }
    }
    if ((t === 'video' || t === 'audio' || t === 'track') && a.src) put(i, { kind: t, attr: 'src', url: a.src, ...(a.preload ? { preload: a.preload } : {}), base: docUrl });
    if (t === 'video' && a.poster) put(i, { kind: 'poster', attr: 'poster', url: a.poster, base: docUrl });
    if ((t === 'use' || t === 'image' || t === 'feimage') && (a.href || a['xlink:href'])) { const u = a.href || a['xlink:href']; if (!u.startsWith('#')) put(i, { kind: t === 'use' ? 'svg-use' : 'svg-image', attr: a.href ? 'href' : 'xlink:href', url: u, base: docUrl }); }
    if (t === 'svg' && !(E[i].pi != null && /\/svg\[\d+\]/.test(E[E[i].pi].k))) put(i, { kind: 'svg-inline', url: null, elements: 1 + countEls(n) });
    if (t === 'object' && a.data) put(i, { kind: 'object', attr: 'data', url: a.data, base: docUrl });
    if (t === 'embed' && a.src) put(i, { kind: 'embed', attr: 'src', url: a.src, base: docUrl });
    if (t === 'iframe' && a.src) put(i, { kind: 'iframe', attr: 'src', url: a.src, base: docUrl });
    // computed url() (element + pseudo-elements), at this point
    const s = S.get(E[i].k);
    if (s) {
      const st = s.style();
      for (const p of CSS_ASSET_PROPS) for (const u of urlsIn(st.get(p))) put(i, { kind: p === 'content' ? 'content' : 'css', prop: p, url: u });
      for (const [w, pst] of Object.entries(s.pseudo())) for (const p of CSS_ASSET_PROPS) for (const u of urlsIn(pst.get(p))) put(i, { kind: 'css', prop: p, pseudo: w, url: u });
      // fonts actually used for this element's own text (CDP platform fonts, custom = '*'), matched to @font-face
      if (s.f) for (const part of String(s.f).split('|')) {
        const m = /^(.*?)(\*)?:(\d+)$/.exec(part); if (!m || !m[2]) continue;
        const fam = famName(m[1]); const w = parseFloat(st.get('font-weight')) || 400; const style = st.get('font-style') || 'normal';
        let fs = faces.filter(f => f.family === fam);
        const exact = fs.filter(f => weightIn(w, f.weight) && (f.style === style || (style === 'normal' && !f.style)));
        if (exact.length) fs = exact;
        if (!fs.length) put(i, { kind: 'font', family: m[1], glyphs: +m[3], url: null, note: 'custom font with no matching @font-face (FontFace API or a local font)' });
        for (const f of fs) for (const u of f.src) put(i, { kind: 'font', family: m[1], glyphs: +m[3], face: f.id, ...(f.weight ? { weight: f.weight } : {}), url: u, base: f.base });
      }
    }
  }
  const list = [...all.values()].map(x => ({ url: x.url, kinds: [...x.kinds], elements: x.elements.size, requested: x.requested, file: x.file }));
  const counts = {}; for (const x of per.values()) for (const a of x) counts[a.kind] = (counts[a.kind] || 0) + 1;
  return {
    summary: { elementsWithAssets: per.size, references: Object.values(counts).reduce((s, n) => s + n, 0), byKind: counts, urls: list.length, requested: list.filter(x => x.requested).length,
      inArchive: list.filter(x => x.file).length, requestedNotInArchive: list.filter(x => x.requested && !x.file).map(x => x.url).slice(0, 20) },
    elements: [...per.entries()].map(([k, a]) => ({ k, assets: a })),
    assets: list,
  };
}
function countEls(n) { let c = 0; for (const k of elKids(n)) c += 1 + countEls(k); return c; }
