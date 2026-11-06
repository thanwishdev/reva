// Law classes and the groups inside a move (DESIGN 2.1, 2.4 step 10). A law class is site-wide, so one class is fitted once.
import { framesOf, RATE, sameLaw } from './contract.js';

const STAGGER_SLACK_FRAMES = 2, STAGGER_SHARE = 0.7;

/**
 * Give every run of every move its law class. Classes are made from the runs that head a move; a run of a later instance joins the
 * class it matches and makes none, so the fit count stays the count of what is shown.
 * @returns {object[]} law classes: the first run of each, with `lc` its index
 */
export function lawClasses(moves) {
  const all = [], buckets = new Map();
  const bucketOf = (r) => { const k = `${r.fams.join()}|${r.lead}`; return buckets.get(k) || buckets.set(k, []).get(k); };
  const find = (r) => { const b = bucketOf(r); for (let i = b.length - 1; i >= 0; i--) if (sameLaw(b[i], r)) return b[i]; return null; };
  for (const m of moves) for (const r of m.runs) {
    let c = find(r);
    if (!c) { c = r; c.lcId = all.length; all.push(c); bucketOf(r).push(c); }
    r.lc = c.lcId;
  }
  for (const m of moves) for (const q of m.instances || []) for (const r of q.runs) { const c = find(r); r.lc = c ? c.lcId : null; }
  return all;
}

/** Top law classes of a move by run count, and the sets the fold compares. */
export function summarise(m) {
  const c = new Map(), amp = new Map();
  for (const r of m.runs) { c.set(r.lc, (c.get(r.lc) || 0) + 1); amp.set(r.lc, Math.max(amp.get(r.lc) ?? 0, r.amp)); }
  // ties go to the larger motion: a class of one element is common, and the one a person sees must not lose to its label
  m.lcTop = [...c].sort((a, b) => b[1] - a[1] || amp.get(b[0]) - amp.get(a[0]) || a[0] - b[0]).slice(0, 3).map((x) => x[0]);
  m.lcN = c.size;
  m.keys = new Set(m.runs.map((r) => r.key));
  return m;
}

/** Onset spacing of one instance's runs. @returns {{ms:number, order:string, from:string}|null} */
export function staggerOf(runs) {
  const first = new Map();
  for (const r of runs) if (!first.has(r.id) || r.k0 < first.get(r.id).k0) first.set(r.id, r);
  const on = [...first.values()].sort((a, b) => a.k0 - b.k0 || (a.box?.[0] ?? 0) - (b.box?.[0] ?? 0));
  if (on.length < 3) return null;
  const gaps = on.slice(1).map((r, i) => r.k0 - on[i].k0).sort((a, b) => a - b), med = gaps[gaps.length >> 1];
  if (!(med > 0) || med > framesOf(400)) return null;
  if (gaps.filter((g) => Math.abs(g - med) <= STAGGER_SLACK_FRAMES).length < STAGGER_SHARE * gaps.length) return null;
  const a = on[0].box, b = on[on.length - 1].box;
  const axis = a && b ? (Math.abs(b[0] - a[0]) >= Math.abs(b[1] - a[1]) ? (b[0] >= a[0] ? 'start' : 'end') : (b[1] >= a[1] ? 'start' : 'end')) : 'start';
  return { ms: Math.round((med * 1000) / RATE), order: axis, from: axis === 'start' ? 'first' : 'last' };
}

const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : null; };

const AXIS = { 'ren:tx': 0, 'ren:ty': 1 }, SCREEN_MIN_PX = 1, STILL_SHARE = 0.1;
/** A run's own travel on its axis and where its box went on the screen (y in page px, so a scroll is not a motion). */
function travelOf(r) {
  const ax = r.lead === 'ren:translate' ? (r.leadPart === 'y' ? 1 : r.leadPart === 'x' ? 0 : null) : AXIS[r.lead];
  if (ax == null || !Number.isFinite(r.from) || !Number.isFinite(r.to) || !r.box || !r.boxEnd) return null;
  const a = r.box[ax], b = r.boxEnd[ax]; if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return { ax, own: r.to - r.from, screen: ax === 1 ? (b + (r.sy1 ?? r.sy0 ?? 0)) - (a + (r.sy0 ?? 0)) : b - a };
}
/**
 * What a group's motion does ON SCREEN when that is not what its lead's own transform says. An inner element that moves against its
 * parent by the same amount stands still on the screen while the parent's box moves (a 3D portfolio site, a menu: parent x +590.39, inner
 * x -590.39): the screen shows the parent's box going right, the content holding still, so a wipe to the right, not a slide left.
 * Read from the runs' screen boxes (getBoundingClientRect at their first and last frame), in the lead's own document and window.
 * @returns {{axis:'x'|'y', px:number, counter:boolean}|null}  null when the lead's own direction is what the screen shows
 */
export function screenOf(runs, lead) {
  const tl = travelOf(lead); if (!tl || Math.abs(tl.own) < SCREEN_MIN_PX) return null;
  const near = runs.filter((r) => r.view === lead.view && r.doc === lead.doc && r.k0 <= lead.k1 && r.k1 >= lead.k0).map((r) => ({ r, t: travelOf(r) })).filter((x) => x.t && x.t.ax === tl.ax);
  const mover = near.reduce((a, b) => (Math.abs(b.t.screen) > Math.abs(a?.t.screen ?? 0) ? b : a), null);
  if (!mover || Math.abs(mover.t.screen) < SCREEN_MIN_PX) return null;
  const leadStill = Math.abs(tl.screen) < STILL_SHARE * Math.abs(tl.own);
  if (!leadStill && Math.sign(tl.screen) === Math.sign(tl.own)) return null;
  // a counter-move: something in the group travels against what the screen shows and holds still there
  const counter = near.some((x) => Math.sign(x.t.own) !== Math.sign(mover.t.screen) && Math.abs(x.t.own) >= 0.5 * Math.abs(mover.t.screen) && Math.abs(x.t.screen) < STILL_SHARE * Math.abs(x.t.own));
  return { axis: tl.ax ? 'y' : 'x', px: Math.round(mover.t.screen * 100) / 100, counter };
}

/**
 * The groups of a move class: one per law class, over all its moves. `count` is the elements on the busiest page: a class can fold one
 * tile after another down a page, and each is an element of the same motion. `total` counts every element on every page.
 * @param {object[]} members  the class's moves
 */
export function groupsOf(members) {
  const by = new Map();
  for (const m of members) for (const r of m.runs) {
    const e = by.get(r.lc) || by.set(r.lc, { lc: r.lc, runs: [], per: new Map(), page: new Map() }).get(r.lc);
    e.runs.push(r);
    const k = `${m.page}|${m.vp}|${m.label}`, p = e.per.get(k) || e.per.set(k, []).get(k);
    p.push(r);
    const q = `${m.page}|${m.vp}`;
    (e.page.get(q) || e.page.set(q, new Set()).get(q)).add(r.key);
  }
  for (const m of members) for (const q of m.instances || []) for (const r of q.runs) { const e = by.get(r.lc); if (e) e.page.get(`${m.page}|${m.vp}`)?.add(r.key); }
  return [...by.values()].map((g) => {
    const lead = g.runs.slice().sort((a, b) => b.amp - a.amp || a.k0 - b.k0)[0];
    const channels = new Map();
    for (const r of g.runs) for (const [c, f] of Object.entries(r.spans || {})) (channels.get(c) || channels.set(c, []).get(c)).push(f);
    const screen = screenOf(g.runs, lead);
    return { lc: g.lc, runs: g.runs, lead, ...(screen ? { screen } : {}), count: Math.max(...[...g.page.values()].map((s) => s.size)), total: new Set(g.runs.map((r) => `${r.view?.name}|${r.id}`)).size, frames: med(g.runs.map((r) => r.k1 - r.k0 + 1)), spans: Object.fromEntries([...channels].map(([c, f]) => [c, med(f)])), stagger: staggerOf([...g.per.values()][0]) };
  });
}
