// Where a moving element is: its box in CSS px, relative to the recorded viewport, when its motion starts and when it ends,
// plus a small crop of the page at that box at the end of the recording (for the motion card).
//
// Everything comes from what the recorder already has: every sampled frame carries the element's getBoundingClientRect
// (ren:bx, ren:by, ren:bw, ren:bh; viewport-relative, transforms included) and the scroll offset (sx, sy). The only
// addition is ONE viewport screenshot taken after the take (look/index.js); the crops are cut from it here. Nothing runs
// in the page for this.
//
// Labels: the boxes are `measured` (read from the browser's layout in the sampled frame, 120 Hz virtual clock; not fitted,
// not declared). A box is therefore as exact as the frame it was read in; `t` says which frame.
import { PNG } from 'pngjs';

export const POSITION_SCHEMA = 'reva.position/0';
const round = (x) => Math.round(x * 100) / 100;
const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);

/** The box of element `id` in `row`, or null (not sampled, or no layout box: display none). */
export function boxIn(row, id) {
  const v = row && row.v && row.v[id]; if (!v) return null;
  const x = num(v['ren:bx']), y = num(v['ren:by']), w = num(v['ren:bw']), h = num(v['ren:bh']);
  if (x == null || y == null || w == null || h == null) return null;
  return { x: round(x), y: round(y), w: round(w), h: round(h) };
}
const hasArea = (b) => !!b && b.w > 0 && b.h > 0;
/** Union of boxes that have an area (a member with no layout box adds nothing). */
export function unionOf(boxes) {
  const bs = boxes.filter(hasArea); if (!bs.length) return null;
  const x0 = Math.min(...bs.map((b) => b.x)), y0 = Math.min(...bs.map((b) => b.y));
  const x1 = Math.max(...bs.map((b) => b.x + b.w)), y1 = Math.max(...bs.map((b) => b.y + b.h));
  return { x: round(x0), y: round(y0), w: round(x1 - x0), h: round(y1 - y0) };
}
/** Index of the first row with T >= t (rows are in time order). */
function lowerBound(rows, t) { let lo = 0, hi = rows.length; while (lo < hi) { const m = (lo + hi) >> 1; if (rows[m].T < t) lo = m + 1; else hi = m; } return lo; }

/**
 * The frame where an element is still at rest before its motion: the last frame before `t0` in which it had a box
 * (the first frame when the motion starts at once).
 */
function restRow(rows, id, t0) {
  for (let i = Math.min(lowerBound(rows, t0), rows.length) - 1; i >= 0; i--) if (boxIn(rows[i], id)) return rows[i];
  const i = lowerBound(rows, t0); return rows[Math.min(i, rows.length - 1)] || null;
}
/** Member boxes are kept for groups of at most this many members (look.json stays small; a bigger group is drawn whole). */
export const MEMBER_BOXES = 40;
const at = (row, box) => (row && box ? { ...box, t: round(row.T), scroll: { x: round(num(row.sx) ?? 0), y: round(num(row.sy) ?? 0) } } : null);

/**
 * Positions of the planned motion rows.
 * @param {object[]} entries  plan entries (rank, kind, lead, ids, count)
 * @param {Map} stats         elementStats (firstMoveT / lastMoveT per element id)
 * @param {object[]} rows     the whole take's rows
 * @param {{width:number,height:number}} viewport
 * @returns {Map<number, object|null>} rank -> position (no image yet), null where the element has no box
 */
export function motionPositions({ entries, stats, rows, viewport }) {
  const out = new Map();
  const last = rows[rows.length - 1] || null;
  for (const e of entries) {
    const st = stats.get(e.lead);
    if (!st || st.firstMoveT == null || !rows.length) { out.set(e.rank, null); continue; }
    const rest = restRow(rows, e.lead, st.firstMoveT);
    const endRow = rows[lowerBound(rows, st.lastMoveT)] || last;
    const start = boxIn(rest, e.lead), end = boxIn(endRow, e.lead);
    const pos = {
      schema: POSITION_SCHEMA, label: 'measured', unit: 'css px, relative to the recorded viewport (getBoundingClientRect, transforms included)',
      viewport: { width: viewport.width, height: viewport.height },
      start: at(rest, start), end: at(endRow, end),
      endBoxLast: boxIn(last, e.lead),
    };
    if (e.kind === 'group' && e.ids.length > 1) {
      const sts = e.ids.map((id) => stats.get(id)).filter((s) => s && s.firstMoveT != null);
      if (sts.length) {
        const t0 = Math.min(...sts.map((s) => s.firstMoveT)), t1 = Math.max(...sts.map((s) => s.lastMoveT));
        const r1 = rows[lowerBound(rows, t1)] || last;
        const startBoxes = e.ids.map((id) => boxIn(restRow(rows, id, t0), id));
        const endBoxes = e.ids.map((id) => boxIn(r1, id));
        pos.group = { members: e.ids.length, withBox: endBoxes.filter(hasArea).length,
          start: unionOf(startBoxes) ? { ...unionOf(startBoxes), t: round(t0) } : null, end: unionOf(endBoxes) ? { ...unionOf(endBoxes), t: round(r1.T) } : null,
          what: 'the box that holds all members: at the first member\'s onset, and when the last member has stopped' };
        pos.groupLast = unionOf(e.ids.map((id) => boxIn(last, id)));
        // each member's own boxes and start, so the card can cut each one from the group's crop and replay it on its own
        // offset: its rest box before it moved, its box in the last frame (where the crop is cut), and its first move
        // relative to the lead's (ms). Only for groups small enough to draw one by one.
        if (e.ids.length <= MEMBER_BOXES) {
          pos.group.boxes = e.ids.map((id) => {
            const s = stats.get(id), t = s && s.firstMoveT != null ? s.firstMoveT : null;
            return { start: boxIn(restRow(rows, id, t ?? t0), id), last: boxIn(last, id), dt: t != null ? round(t - st.firstMoveT) : null };
          });
        }
      }
    }
    if (!pos.start && !pos.end && !(pos.group && (pos.group.start || pos.group.end))) { out.set(e.rank, null); continue; }
    out.set(e.rank, pos);
  }
  return out;
}

const within = (a, b, tol = 1) => !!a && !!b && Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol && Math.abs(a.w - b.w) <= tol && Math.abs(a.h - b.h) <= tol;

/** The part of `box` inside the viewport (null when less than 4 px² shows). */
export function visiblePart(box, viewport) {
  if (!hasArea(box)) return null;
  const x0 = Math.max(0, box.x), y0 = Math.max(0, box.y), x1 = Math.min(viewport.width, box.x + box.w), y1 = Math.min(viewport.height, box.y + box.h);
  if (x1 - x0 < 1 || y1 - y0 < 1 || (x1 - x0) * (y1 - y0) < 4) return null;
  return { x: round(x0), y: round(y0), w: round(x1 - x0), h: round(y1 - y0) };
}

/** Longest side of a stored crop, in file px (larger crops are averaged down; `image.file.scale` says by how much). */
export const CROP_MAX = 640;

/** Cut `box` (CSS px) out of a decoded viewport PNG; area-average down to CROP_MAX. Returns {png, width, height, scale} (scale = file px per CSS px). */
export function cropPng(src, box, cssScale) {
  const sx0 = Math.max(0, Math.round(box.x * cssScale)), sy0 = Math.max(0, Math.round(box.y * cssScale));
  const sx1 = Math.min(src.width, Math.round((box.x + box.w) * cssScale)), sy1 = Math.min(src.height, Math.round((box.y + box.h) * cssScale));
  const cw = sx1 - sx0, ch = sy1 - sy0; if (cw < 1 || ch < 1) return null;
  const k = Math.min(1, CROP_MAX / Math.max(cw, ch));
  const w = Math.max(1, Math.round(cw * k)), h = Math.max(1, Math.round(ch * k));
  const out = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    const ya = sy0 + (y * ch) / h, yb = sy0 + ((y + 1) * ch) / h;
    for (let x = 0; x < w; x++) {
      const xa = sx0 + (x * cw) / w, xb = sx0 + ((x + 1) * cw) / w;
      let r = 0, g = 0, b = 0, a = 0, wsum = 0;
      for (let yy = Math.floor(ya); yy < Math.ceil(yb); yy++) {
        const wy = Math.min(yy + 1, yb) - Math.max(yy, ya); if (wy <= 0 || yy >= src.height) continue;
        for (let xx = Math.floor(xa); xx < Math.ceil(xb); xx++) {
          const wx = Math.min(xx + 1, xb) - Math.max(xx, xa); if (wx <= 0 || xx >= src.width) continue;
          const i = (yy * src.width + xx) * 4, wt = wx * wy;
          r += src.data[i] * wt; g += src.data[i + 1] * wt; b += src.data[i + 2] * wt; a += src.data[i + 3] * wt; wsum += wt;
        }
      }
      const o = (y * w + x) * 4;
      if (wsum > 0) { out.data[o] = Math.round(r / wsum); out.data[o + 1] = Math.round(g / wsum); out.data[o + 2] = Math.round(b / wsum); out.data[o + 3] = Math.round(a / wsum); }
    }
  }
  return { png: out, width: w, height: h, scale: round((w / cw) * cssScale) };
}

/**
 * Crops for every position that has one, from one viewport screenshot (PNG buffer). Mutates `positions` entries: adds
 * `image` ({path, box, ...}) and returns the files to write: [{path, data}]. `fileFor(rank)` names the file (relative).
 */
export function cropsFor({ positions, screenshot, viewport, fileFor }) {
  const files = [];
  let src = null;
  if (screenshot) { try { src = PNG.sync.read(screenshot); } catch { src = null; } }
  const cssScale = src ? src.width / viewport.width : 1;
  for (const [rank, pos] of positions) {
    if (!pos) continue;
    const g = pos.group && pos.groupLast && pos.group.withBox > 1 ? pos.groupLast : null;
    const whole = g || pos.endBoxLast;
    const box = visiblePart(whole, viewport);
    const endBox = g ? (pos.group.end || null) : pos.end;
    const matchesEnd = within(whole, endBox);
    const base = { what: g ? 'the box that holds all members at the last recorded frame' : 'the element at the last recorded frame', at: 'end of the recording', matchesEnd };
    delete pos.endBoxLast; delete pos.groupLast;
    if (!src) { pos.image = { path: null, ...base, reason: 'no screenshot of the page could be taken' }; continue; }
    if (!box) { pos.image = { path: null, ...base, box: whole || null, reason: whole ? 'the element is outside the viewport at the end of the recording' : 'the element has no layout box at the end of the recording' }; continue; }
    const c = cropPng(src, box, cssScale);
    if (!c) { pos.image = { path: null, ...base, box, reason: 'the crop is empty' }; continue; }
    const file = fileFor(rank);
    files.push({ path: file, data: PNG.sync.write(c.png) });
    pos.image = { path: file, ...base, box, visible: within(box, whole, 0.5) ? 'full' : 'partial (the part inside the viewport)', file: { width: c.width, height: c.height, pxPerCssPx: c.scale },
      note: 'pixels of the page inside that box: anything drawn over the element shows too' };
  }
  return files;
}
