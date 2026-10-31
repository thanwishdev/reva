// Element oracle compare (pure). Exact: every element and pseudo-element must match on box (within 0.5 px),
// every computed property (string-equal after normalise), own text, and platform fonts used.
// Elements flagged live (declared live regions) are skipped and counted, never silently.
import { decodeStyle } from './snapshot.js';
import { isOwned } from './scriptowned.js';

export const BOX_TOL = 0.5;

/** Hook for value normalisation; identity today (same engine on both sides). Kept in one place so a later stage
 *  that needs it (e.g. url() absolutisation) changes it visibly. */
export function normalise(prop, v) { return v; }

export const PX_TOL = 0.02;
const NUM = /-?\d*\.?\d+(?:e-?\d+)?/g;
/** Equal after normalise, with px numbers allowed to differ by PX_TOL: computed values serialise to ~2-3 decimals
 *  while layout snaps to 1/64 px, so 1321.81px re-applied reads back as 1321.8px. Only `px` numbers get the
 *  tolerance; colour channels, alphas, unitless numbers and keywords must match exactly. */
export function sameValue(prop, a, b) {
  a = normalise(prop, a); b = normalise(prop, b);
  if (a === b) return true;
  const ma = /^matrix(3d)?\(([^)]*)\)$/.exec(a), mb = /^matrix(3d)?\(([^)]*)\)$/.exec(b);
  if (ma && mb && ma[1] === mb[1]) {
    // matrix(): translation entries are px (PX_TOL); the linear part must agree to 1e-5
    const A = ma[2].split(',').map(Number), B = mb[2].split(',').map(Number);
    const tr = ma[1] ? new Set([12, 13, 14]) : new Set([4, 5]);
    return A.length === B.length && A.every((x, i) => Math.abs(x - B[i]) <= (tr.has(i) ? PX_TOL : 1e-5));
  }
  if (a.replace(NUM, '#') !== b.replace(NUM, '#')) return false;
  const re = /(-?\d*\.?\d+(?:e-?\d+)?)(px)?/g;
  const na = [...a.matchAll(re)], nb = [...b.matchAll(re)];
  if (na.length !== nb.length) return false;
  for (let i = 0; i < na.length; i++) {
    if (na[i][1] === nb[i][1]) continue;
    if (!na[i][2] || !nb[i][2] || Math.abs(Number(na[i][1]) - Number(nb[i][1])) > PX_TOL) return false;
  }
  return true;
}

/**
 * @param {object} a original snapshot   @param {object} b rebuild snapshot
 * @param {object} [o] { maxDetail }
 * @returns {{pass:boolean, elements:number, compared:number, live:number, failedElements:number,
 *            byKind:object, byProp:object, misses:object[]}}
 */
/** excuse: [{k: RegExp|string (key prefix), prop: RegExp|string, why}] — declared exceptions (e.g. a state a later
 *  stage owns). A matching miss is not a failure; it is counted and listed under `excused`, never dropped. */
/** owned: keys of script-owned elements at this point (scriptowned.js, evidence-backed); they and their subtrees are
 *  skipped on both sides and counted as `owned`. */
export function compareSnapshots(a, b, { maxDetail = 200, excuse = [], owned = [] } = {}) {
  const bm = new Map(b.els.map(e => [e.k, e]));
  const am = new Set(a.els.map(e => e.k));
  const byKind = {}, byProp = {}, misses = [], excused = [];
  let compared = 0, live = 0, failed = 0, ownedN = 0;
  const hit = (pat, v) => (pat == null ? true : pat instanceof RegExp ? pat.test(v ?? '') : String(v ?? '').startsWith(pat));
  const miss = (k, kind, extra = {}) => {
    const ex = excuse.find(x => hit(x.k, k) && hit(x.prop, extra.prop) && (!x.kind || x.kind === kind));
    if (ex) { if (excused.length < maxDetail) excused.push({ k, kind, ...extra, why: ex.why }); return 0; }
    byKind[kind] = (byKind[kind] || 0) + 1;
    if (extra.prop) byProp[extra.prop] = (byProp[extra.prop] || 0) + 1;
    if (misses.length < maxDetail) misses.push({ k, kind, ...extra });
    return 1;
  };
  const styleDiff = (k, sa, sb, where) => {
    let n = 0;
    const A = decodeStyle(a, sa), B = decodeStyle(b, sb);
    for (const [p, va] of A) {
      const vb = B.get(p);
      if (vb === undefined) { if (va !== '') n += miss(k, 'prop', { prop: where + p, a: va, b: null }); continue; }
      if (!sameValue(p, va, vb)) n += miss(k, 'prop', { prop: where + p, a: va, b: vb });
    }
    for (const [p, vb] of B) if (!A.has(p) && vb !== '') n += miss(k, 'prop', { prop: where + p, a: null, b: vb });
    return n;
  };
  for (const ea of a.els) {
    if (ea.live) { live++; continue; }
    if (owned.length && isOwned(ea.k, owned)) { ownedN++; continue; }
    const eb = bm.get(ea.k);
    if (!eb) { failed += miss(ea.k, 'element-missing'); continue; }
    compared++;
    let n = 0;
    const d = ea.b.map((v, i) => Math.abs(v - eb.b[i]));
    if (d.some(x => x > BOX_TOL)) n += miss(ea.k, 'box', { a: ea.b, b: eb.b });
    if (ea.t !== eb.t) n += miss(ea.k, 'text', { a: ea.t.slice(0, 80), b: eb.t.slice(0, 80) });
    if ((ea.f || '') !== (eb.f || '')) n += miss(ea.k, 'font', { a: ea.f, b: eb.f });
    n += styleDiff(ea.k, ea.s, eb.s, '');
    const pa = ea.ps || {}, pb = eb.ps || {};
    for (const w of new Set([...Object.keys(pa), ...Object.keys(pb)])) {
      if (!pa[w] || !pb[w]) { n += miss(ea.k, 'pseudo-missing', { prop: w, a: !!pa[w], b: !!pb[w] }); continue; }
      n += styleDiff(ea.k, pa[w], pb[w], w + ' ');
    }
    if (n) failed++;
  }
  for (const eb of b.els) if (!am.has(eb.k) && !eb.live && !(owned.length && isOwned(eb.k, owned))) failed += miss(eb.k, 'element-extra');
  const topProps = Object.fromEntries(Object.entries(byProp).sort((x, y) => y[1] - x[1]).slice(0, 25));
  return { pass: failed === 0, elements: a.els.length, compared, live, owned: ownedN, failedElements: failed, byKind, byProp: topProps, misses, ...(excused.length ? { excused } : {}) };
}
