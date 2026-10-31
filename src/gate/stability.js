// Stability of identical replays (corpus S2). When two replays of the same archive (orig1, orig2) differ, the gate
// cannot judge a capture there: the verdict is `indeterminate`, never `fail`, and the regions that moved are LISTED
// with a reason and their area, never masked silently. Pure (snapshots + the identity compare result in, JSON out).
import { compareSnapshots } from './compare.js';

const MOTION = /^(transform|translate|rotate|scale|opacity|visibility|filter|clip-path|offset-|d$|stroke-dash)/;
const LAYOUT = /^(width|height|block-size|inline-size|min-|max-|inset|top|left|right|bottom|margin|padding|grid-template|perspective-origin|transform-origin|x$|y$|cx$|cy$|r$)/;
const OPAQUE = /\/(canvas|video|iframe|img|svg|picture)\[\d+\]$/;

/** Reason for one unstable element from its misses (first match wins, most specific first). */
export function reasonOf(kinds, props, key) {
  const p = props.map(x => x.split(' ').pop());
  if (kinds.has('element-missing') || kinds.has('element-extra')) return 'dom-differs';
  if (kinds.has('text')) return 'text-differs';
  if (kinds.has('font')) return 'font-differs';
  if (p.some(x => MOTION.test(x))) return 'motion-state';
  if (p.some(x => x.startsWith('--'))) return 'custom-property';
  if (p.some(x => /^(animation|transition)/.test(x))) return 'animation-declaration';
  if (p.length && p.every(x => LAYOUT.test(x))) return 'layout';
  if (p.length) return 'style:' + p[0];
  if (kinds.has('box')) return OPAQUE.test(key) ? 'layout(media)' : 'layout';
  return [...kinds][0] || 'unknown';
}

const parentOf = k => { const i = Math.max(k.lastIndexOf('/'), k.lastIndexOf('#')); return i > 0 ? k.slice(0, i) : null; };

/** Union area of boxes ([x, y, w, h], document px) inside a clip rect, on a 4 px grid. */
export function unionArea(boxes, clip) {
  const G = 4, cw = Math.ceil(clip[2] / G), ch = Math.ceil(clip[3] / G);
  if (cw <= 0 || ch <= 0) return 0;
  const grid = new Uint8Array(cw * ch);
  let n = 0;
  for (const [x, y, w, h] of boxes) {
    const x0 = Math.max(0, Math.floor((x - clip[0]) / G)), y0 = Math.max(0, Math.floor((y - clip[1]) / G));
    const x1 = Math.min(cw, Math.ceil((x + w - clip[0]) / G)), y1 = Math.min(ch, Math.ceil((y + h - clip[1]) / G));
    for (let j = y0; j < y1; j++) for (let i = x0; i < x1; i++) { const c = j * cw + i; if (!grid[c]) { grid[c] = 1; n++; } }
  }
  return n * G * G;
}

/** Opaque-content elements (canvas / video / iframe / img / svg / picture, by kind) whose box overlaps a differing
 *  blob [x0, y0, x1, y1] of a snapshot: pixels there are painted by the element's own content, which a rebuild without
 *  script (or two replays of a time-driven page) does not reproduce. Diagnostic only: it never changes a verdict. */
export function opaqueUnder(snap, bb) {
  const kinds = {};
  if (!bb) return kinds;
  for (const e of snap.els) if (OPAQUE.test(e.k) && e.b[2] * e.b[3] > 0 && e.b[0] < bb[2] && e.b[0] + e.b[2] > bb[0] && e.b[1] < bb[3] && e.b[1] + e.b[3] > bb[1]) { const t = e.k.match(OPAQUE)[1]; kinds[t] = (kinds[t] || 0) + 1; }
  return kinds;
}

/**
 * Unstable regions of one point: a = orig1 snapshot, b = orig2 snapshot, res = compareRuns(...)[pointId].
 * An element that differs only in its box while one of its descendants also differs is a symptom (it grew because a
 * child changed) and is folded into that child. Regions = the topmost remaining differing elements, each with the
 * reason of its own misses and its document box (from orig1, or orig2 for an element only orig2 has).
 * Pixel-only differences (element oracle equal) are listed from the pixel compare's largest blob, with the elements
 * under it that paint opaquely (canvas / video / iframe / img).
 */
export function unstableAt(a, b, res, { maxRegions = 30 } = {}) {
  const o = compareSnapshots(a, b, { maxDetail: Infinity });
  const by = new Map();
  for (const m of o.misses) {
    let e = by.get(m.k); if (!e) by.set(m.k, e = { kinds: new Set(), props: [] });
    e.kinds.add(m.kind); if (m.kind === 'prop' && m.prop) e.props.push(m.prop);
  }
  const boxOf = new Map([...b.els.map(e => [e.k, e.b]), ...a.els.map(e => [e.k, e.b])]);
  const hasFailingDesc = new Set();
  for (const k of by.keys()) for (let p = parentOf(k); p; p = parentOf(p)) { if (hasFailingDesc.has(p)) break; hasFailingDesc.add(p); }
  const keep = [...by.entries()].filter(([k, e]) => !(e.kinds.size === 1 && e.kinds.has('box') && hasFailingDesc.has(k)));
  // html/body never root a region (their box is the page): their own differences are listed as page-level entries
  const ROOT = new Set(['html', 'html/body[1]']);
  const kept = new Set(keep.map(([k]) => k).filter(k => !ROOT.has(k)));
  const top = keep.filter(([k]) => { if (ROOT.has(k)) return true; for (let p = parentOf(k); p; p = parentOf(p)) if (kept.has(p)) return false; return true; });
  const keptDesc = new Set();
  for (const k of kept) for (let p = parentOf(k); p; p = parentOf(p)) keptDesc.add(p);
  const vp = [0, 0, a.vw, a.vh], page = [0, 0, a.vw, Math.max(a.docH || 0, b.docH || 0, a.vh)];
  const regions = top.map(([k, e]) => {
    const inside = ROOT.has(k) ? [[k, e]] : keep.filter(([k2]) => k2 === k || k2.startsWith(k + '/') || k2.startsWith(k + '#'));
    const props = {}; for (const [, x] of inside) for (const p of x.props) props[p] = (props[p] || 0) + 1;
    const reasons = {}; for (const [k2, x] of inside) { const r = reasonOf(x.kinds, x.props, k2); reasons[r] = (reasons[r] || 0) + 1; }
    const box = ROOT.has(k) ? null : boxOf.get(k) || null;
    return { k, ...(ROOT.has(k) ? { page: true } : {}), reason: reasonOf(e.kinds, e.props, k), reasons, elements: inside.length, props: Object.entries(props).sort((x, y) => y[1] - x[1]).slice(0, 6).map(([p, n]) => `${p}:${n}`), box, areaPx: box ? Math.round(box[2] * box[3]) : 0 };
  }).sort((x, y) => y.areaPx - x.areaPx);
  // area: the deepest differing elements only (a container's box would count its stable children too)
  const leafBoxes = [...kept].filter(k => !keptDesc.has(k)).map(k => boxOf.get(k)).filter(Boolean);
  const out = {
    oracleFailed: o.failedElements, elements: o.elements,
    unstablePctViewport: +(100 * unionArea(leafBoxes, vp) / (vp[2] * vp[3])).toFixed(2),
    unstablePctPage: +(100 * unionArea(leafBoxes, page) / (page[2] * page[3])).toFixed(2),
    regions: regions.slice(0, maxRegions), regionsTotal: regions.length,
  };
  const px = res?.pixel;
  if (px && !px.pass) {
    const bb = px.blobBox; // [x0, y0, x1, y1] of the largest differing blob (pixels.js)
    const kinds = opaqueUnder(a, bb);
    out.pixel = { reason: px.reason, diffPx: px.diffPx, blob: px.blob, blobBox: bb, opaqueUnder: kinds, why: Object.keys(kinds).length ? `pixels under ${Object.keys(kinds).join('/')}` : (o.failedElements ? 'follows the element differences' : 'pixels only (no element differs)') };
  }
  return out;
}

/** Unstable regions for every failing point of an identity compare (dirs hold <point>.json.gz snapshots). */
export function identityUnstable(read, identity, opts) {
  const out = {};
  for (const [id, r] of Object.entries(identity)) if (!r.pass) out[id] = unstableAt(read('a', id), read('b', id), r, opts);
  return out;
}

/** Verdict status of a capture gate (CHECK §6 S2, review §4 guards b and d): identity must pass, and no rebuild point
 *  may have more than maxMaskedPct of its viewport masked; otherwise the result cannot be judged: `indeterminate`. */
export function statusOf({ identityPass, acceptance, maskedPctViewportMax = 0, clockStalled = false, skipped = [] }, { maxMaskedPct = 15 } = {}) {
  if (clockStalled) return { status: 'indeterminate', why: 'the fake-clock install stalled (overload): Date was reset but performance.now()/rAF ticks were not, so replays cannot be compared' };
  if (!identityPass) return { status: 'indeterminate', why: 'identity failed: two replays of the same archive differ (see identity.unstable)' };
  if (maskedPctViewportMax > maxMaskedPct) return { status: 'indeterminate', why: `masked ${maskedPctViewportMax}% of a viewport > ${maxMaskedPct}%` };
  if (skipped.length) return { status: 'partial', why: `skipped checks: ${skipped.join(', ')}` };
  return { status: acceptance ? 'pass' : 'fail', why: null };
}
