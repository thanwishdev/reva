// Runs: one element, one contiguous change of its own channels, split at 200 ms of quiet (DESIGN 2.1, 2.3).
// Rows stream through once and are not kept. The row decoder hands back the same object for an element that did not change, so the
// `a === b` test skips most of a frame; moves4.mjs of the design check measured this shortcut, test/moves-runs.test.js pins it.
// `k` restarts on a new document, so every position here is `K`, a frame number that keeps rising through a take (takeview.js).
import { loadTake } from '../../record/take.js';
import { axisParts, clipParts, colorParts, numOf, positionParts, rotateDeg } from '../../analysis/fit/series.js';
import { familyOf, framesOf, MODEL, pxEquivalent } from './contract.js';

const QUIET = framesOf(MODEL.quietMs);
const SHAPE_POINTS = MODEL.shapePoints, SHAPE_STEP = 1 / MODEL.shapeStep;
const MIN_NUMERIC_STEP = 1e-3, BOX_STEP = 0.05, SCROLL_SLACK_PX = 0.5, BIRTH_BEFORE_FRAMES = 120, WRITE_BEFORE_FRAMES = 2;

/** String channels as numbers by part; a colour's alpha counts on the 0-255 scale, so a fade of a colour compares with its hue. */
export function partsOf(ch, v) {
  if (typeof v === 'number') return Number.isFinite(v) ? { '': v } : null;
  if (typeof v !== 'string') return null;
  if (/^ren:(color|bg|fill|stroke)/.test(ch)) { const c = colorParts(v); return c ? { r: c.r, g: c.g, b: c.b, a: c.a * 255 } : null; }
  if (ch.startsWith('ren:clipPath')) return clipParts(v);
  if (/^ren:(bgPos|maskPos)/.test(ch)) { const p = positionParts(v); return p ? { x: p.x, y: p.y } : null; }
  if (ch === 'ren:translate') { if (v.trim() === 'none') return { x: 0, y: 0, z: 0 }; return axisParts(ch, v); }
  if (ch === 'ren:scale') { if (v.trim() === 'none') return { x: 1, y: 1, z: 1 }; return axisParts(ch, v); }
  if (ch === 'ren:rotate') { const d = rotateDeg(v); return d == null ? null : { '': d }; }
  const n = numOf(v);
  return n == null ? null : { '': n };
}

/** Contiguous stretches of a rising list of frames. */
function stretches(ks) {
  const out = [];
  let a = 0;
  for (let i = 1; i <= ks.length; i++) { if (i < ks.length && ks[i] - ks[i - 1] <= QUIET) continue; out.push([ks[a], ks[i - 1]]); a = i; }
  return out;
}

/** The numbers of one channel inside a run: [K, value, value before] per part. Numeric channels hold them already. */
function seriesOf(ch, points) {
  const out = new Map();
  for (const [k, x, y] of points) {
    const px = partsOf(ch, x), py = partsOf(ch, y);
    if (!px || !py) continue;
    for (const p of Object.keys(px)) { if (py[p] == null) continue; (out.get(p) || out.set(p, []).get(p)).push([k, px[p], py[p]]); }
  }
  return out;
}

/** 13 points of progress, in 5 % steps. */
function shapeOf(nums, k0, k1, start, end, amp) {
  const span = (end - start) || amp || 1, shape = [];
  for (let j = 0; j < SHAPE_POINTS; j++) {
    const t = k0 + (j / (SHAPE_POINTS - 1)) * (k1 - k0);
    let val = start;
    for (const p of nums) { if (p[0] <= t) val = p[1]; else break; }
    shape.push(Math.round(((val - start) / span) * SHAPE_STEP) / SHAPE_STEP);
  }
  return shape;
}

const boxOf = (a) => [a['ren:bx'], a['ren:by'], a['ren:bw'], a['ren:bh']];
const finiteBox = (b) => b.every(Number.isFinite);
const grow = (u, b) => { if (!finiteBox(b)) return u; if (!u) return b.slice(); const x1 = Math.max(u[0] + u[2], b[0] + b[2]), y1 = Math.max(u[1] + u[3], b[1] + b[3]); u[0] = Math.min(u[0], b[0]); u[1] = Math.min(u[1], b[1]); u[2] = x1 - u[0]; u[3] = y1 - u[1]; return u; };

/** Close the current stretch of an element: its last box and the union of its boxes, kept in step with the stretches of `ks`. */
function closeStretch(e) { if (e.lastBox) { e.ends.push(e.lastBox); e.unions.push(e.union); e.lastBox = null; e.union = null; } }

/**
 * Stream one take's rows.
 * @param {string} dir  take folder
 * @param {{keepPoints?:boolean}} o  keepPoints: hold a run's lead value against scrollY, for the scroll kind of 2.4 step 9
 * @returns {object} { take, runs, nRows, offsets, syAt, kFirst, kLast, input, wheel, births, gl, pins }
 */
export function readRuns(dir, { keepPoints = false, pinRange = null } = {}) {
  const first = loadTake(dir, ['births', 'mutations', 'elements', 'inputLog', 'wheel']);
  const take = first.take, ch = new Map(), syAt = new Map(), tAt = new Map(), offsets = [0], docStart = [0], gl = new Map(), rest = new Map();
  let prev = null, prevK = -Infinity, nRows = 0, kFirst = Infinity, kLast = -Infinity;
  const pick = (row) => {
    nRows++;
    if (row.k <= prevK) { offsets.push(prevK + offsets[offsets.length - 1] + 1 - row.k); docStart.push(row.k + offsets[offsets.length - 1]); }
    prevK = row.k;
    const off = offsets[offsets.length - 1], K = row.k + off;
    if (K < kFirst) kFirst = K;
    if (K > kLast) kLast = K;
    syAt.set(K, row.sy ?? 0); tAt.set(K, row.T);
    if (row.gl) for (const u of Object.keys(row.gl)) { const v = row.gl[u]; if (typeof v !== 'number') continue; const g = gl.get(u) || gl.set(u, { last: v, ks: [], n: 0, a: [], s: [] }).get(u); g.n++; if (v !== g.last) { g.ks.push(K); g.a.push(v); g.s.push(row.sy ?? 0); g.last = v; } }
    if (prev && row.v && prev.v) {
      const dsy = (row.sy ?? 0) - (prev.sy ?? 0);
      const pinning = pinRange && dsy && K >= pinRange[0] && K <= pinRange[1];
      for (const id of Object.keys(row.v)) {
        const a = row.v[id], b = prev.v[id];
        if (!b) continue;
        if (pinning) { const o = rest.get(id) || rest.set(id, { a: null, b: null, px: 0, best: null, flow: 0 }).get(id); const still = a === b || a['ren:by'] === b['ren:by']; if (still) { if (o.a == null) o.a = row.sy; o.b = row.sy; o.px += Math.abs(dsy); if (!o.best || o.px > o.best.px) o.best = { px: o.px, from: o.a, to: o.b, by: a['ren:by'] }; } else { o.a = null; o.px = 0; o.flow += Math.abs(dsy); } }
        if (a === b) continue;
        let e = ch.get(id);
        if (!e) ch.set(id, e = { ks: [], ser: {}, bks: [], bbox: [], onset: new Map(), ends: [], unions: [], lastBox: null, union: null, lastK: -Infinity });
        let any = false, boxed = false;
        for (const c of Object.keys(a)) {
          const x = a[c], y = b[c];
          if (x === y) continue;
          if (typeof x === 'number' && typeof y === 'number') {
            if (/^ren:(bw|bh|bx)$/.test(c) && Math.abs(x - y) > BOX_STEP) boxed = true;
            if (c === 'ren:by' && Math.abs((x - y) + dsy) > SCROLL_SLACK_PX) boxed = true;
          }
          if (!familyOf(c)) continue;
          if (typeof x === 'number' && typeof y === 'number') { if (Math.abs(x - y) < MIN_NUMERIC_STEP) continue; (e.ser[c] ||= []).push([K, x, y]); any = true; }
          else if (typeof x === 'string' && typeof y === 'string') { (e.ser[c] ||= []).push([K, x, y]); any = true; }
        }
        if (any) {
          const bx = boxOf(a);
          if (K - e.lastK > QUIET) { closeStretch(e); e.onset.set(K, bx); }
          e.lastK = K; e.ks.push(K); e.lastBox = bx; e.union = grow(e.union, bx);
        }
        // the box before and after this frame, the page's scroll added to y: a box-only run's own ends (fit.js ownEnds)
        if (boxed) { e.bks.push(K); e.bbox.push([b['ren:bx'], (b['ren:by'] ?? 0) + (prev.sy ?? 0), b['ren:bw'], b['ren:bh'], a['ren:bx'], (a['ren:by'] ?? 0) + (row.sy ?? 0), a['ren:bw'], a['ren:bh']]); }
      }
    }
    prev = row;
    return 0;
  };
  loadTake(dir, ['rows'], { rows: pick });

  const birthsRaw = (first.data.births || []), bucket = new Map(), mut = new Map();
  const toK = walker(offsets);
  for (const b of birthsRaw) { const r = { k: toK(b.k), T: b.T, delay: b.delay, duration: b.duration, type: b.type, name: b.name, iterations: b.iterations, timeline: b.timeline, el: b.el }; (bucket.get(String(b.el)) || bucket.set(String(b.el), []).get(String(b.el))).push(r); }
  const toK2 = walker(offsets);
  for (const m of first.data.mutations || []) { const id = String(m[2]); (mut.get(id) || mut.set(id, []).get(id)).push(toK2(m[0])); }

  const sel = new Map((take.selectors || []).map((r) => [String(r[0]), r[1]]));
  const els = first.data.elements || [];
  const runs = [];
  const doc = (K) => { let d = docStart.length - 1; while (d > 0 && K < docStart[d]) d--; return d; };
  for (const [id, e] of ch) {
    closeStretch(e);
    const key = sel.get(id) || els[id] || id, gone = !sel.get(id), desc = els[id] || '';
    const ms = mut.get(id) || [], bs = bucket.get(id) || [];
    const wroteIn = (k0, k1) => ms.some((k) => k >= k0 - WRITE_BEFORE_FRAMES && k <= k1);
    const bornIn = (k0, k1) => bs.some((b) => b.k <= k1 && b.k >= k0 - BIRTH_BEFORE_FRAMES);
    const stretchList = stretches(e.ks);
    stretchList.forEach(([k0, k1], i) => {
      const fams = new Set(), channels = [], spans = {}, ends = {};
      let lead = null, leadPart = null, leadAmp = -1, shape = null, from = null, to = null, nums0 = null;
      for (const [c, s] of Object.entries(e.ser)) {
        const inr = s.filter((p) => p[0] >= k0 && p[0] <= k1);
        if (!inr.length) continue;
        fams.add(familyOf(c)); channels.push(c); spans[c] = inr[inr.length - 1][0] - inr[0][0] + 1;
        for (const [p, nums] of seriesOf(c, inr)) {
          const v = nums.map((q) => q[1]), start = nums[0][2];
          // every channel's own ends, not the lead's alone: a group that rises 50 px while its class's exemplar rose 20 px says 50 (fit.js ownEnds)
          ends[p ? `${c}.${p}` : c] = [Math.round(start * 1e4) / 1e4, Math.round(v[v.length - 1] * 1e4) / 1e4];
          const amp = Math.max(...v, start) - Math.min(...v, start), n = pxEquivalent(c, amp);
          if (n > leadAmp) { leadAmp = n; lead = c; leadPart = p || null; from = start; to = v[v.length - 1]; shape = shapeOf(nums, k0, k1, start, to, amp); nums0 = nums; }
        }
      }
      if (!fams.size) return;
      const run = { id, key, gone, desc, k0, k1, T0: tAt.get(k0), T1: tAt.get(k1), sy0: syAt.get(k0) ?? 0, sy1: syAt.get(k1) ?? 0, doc: doc(k0), fams: [...fams].sort(), lead, leadPart, channels, spans, ends, amp: leadAmp, from, to, shape, box: e.onset.get(k0) || null, boxEnd: e.ends[i] || null, union: e.unions[i] || null, wrote: wroteIn(k0, k1), born: bornIn(k0, k1) };
      if (keepPoints && nums0) run.points = nums0.map((q) => [syAt.get(q[0]) ?? 0, q[1]]);
      runs.push(run);
    });
    // box-only runs: the box changed and no own channel did in that stretch. A ride-along, unless the element itself was touched
    for (const [k0, k1] of stretches(e.bks)) {
      if (e.ks.some((k) => k >= k0 && k <= k1)) continue;
      // a box read for its motion counts x and y from where it stood (intent.js readTracks); width and height are its own
      const i0 = e.bks.indexOf(k0), i1 = e.bks.lastIndexOf(k1), b0 = e.bbox[i0], b1 = e.bbox[i1], ends = {};
      const r4 = (v) => Math.round(v * 1e4) / 1e4;
      if (b0 && b1) [['ren:bx', 0], ['ren:by', 1], ['ren:bw', 2], ['ren:bh', 3]].forEach(([c, j]) => { const a0 = b0[j], a1 = b1[j + 4]; if (!Number.isFinite(a0) || !Number.isFinite(a1)) return; ends[c] = j < 2 ? [0, r4(a1 - a0)] : [r4(a0), r4(a1)]; });
      runs.push({ id, key, gone, desc, k0, k1, T0: tAt.get(k0), T1: tAt.get(k1), sy0: syAt.get(k0) ?? 0, doc: doc(k0), fams: ['box'], lead: 'box', leadPart: null, channels: [], spans: {}, ends, amp: 0, boxOnly: true, from: null, to: null, shape: null, box: null, boxEnd: null, union: null, wrote: wroteIn(k0, k1), born: bornIn(k0, k1) });
    }
  }
  const toK3 = walker(offsets);
  const input = (first.data.inputLog || []).filter((e) => e.type === 'pointer' && e.source !== 'page-observed').map((e) => ({ k: toK3(e.k), kind: e.kind, x: e.x, y: e.y }));
  const toK4 = walker(offsets);
  const wheel = (first.data.wheel || []).map((w) => ({ k: toK4(w.k), dy: w.dy ?? w.deltaY ?? 0, prevented: !!w.prevented }));
  const pins = [];
  for (const [id, o] of rest) if (o.best && o.best.px >= MODEL.pinMinPx && o.flow >= MODEL.pinMinPx) pins.push({ id, key: sel.get(id) || els[id] || id, desc: els[id] || '', from: o.best.from, to: o.best.to, by: o.best.by });
  return { take, runs, nRows, offsets, docOf: doc, syAt, tAt, kFirst, kLast, input, wheel, gl, pins, elements: els, selectors: sel };
}

/** `k` as stored, in list order, to rising K: a drop in `k` means the next document. */
export function walker(offsets) {
  let d = 0, last = -Infinity;
  return (k) => {
    if (k < last && d + 1 < offsets.length) d++;
    last = k;
    return k + offsets[d];
  };
}
