// look: rank motions by what a person notices (pure; no browser, no fitter).
//
// Visual weight (select.js: area × displacement × time moving) lets a big element that blinks for 250 ms, an endless logo
// marquee or a sticky nav toggling its scroll state outrank the thing everyone sees (a full-screen WebGL gradient). The
// notice score multiplies a few bounded factors, each with its reason:
//   area   on-screen area while moving (visible part only, opacity-weighted), share of the viewport, sqrt
//   amp    travel / change relative to the element's own size
//   dur    time moving (saturates at 0.8 s)
//   pos    the first screen counts more (motion that starts with the page unscrolled, centre above 3/4 of the viewport)
//   rep    repeated elements (a folded group) count a little more
// and down-ranks, each said in `why`: sticky / fixed navigation (a scroll-state toggle), endless marquees (constant-speed
// loops), short changes on small elements, placeholders that fade out and are gone, elements invisible at rest, no change.
// WebGL canvases are ranked by the same factors (glMotions), so a canvas scene is compared with elements on one scale.

const TF = new Set(['ren:tx', 'ren:ty', 'ren:tz', 'ren:sx', 'ren:sy', 'ren:rz', 'ren:skx']);
const BOX = new Set(['ren:bx', 'ren:by', 'ren:bw', 'ren:bh']);
const SHAPE = /^ren:(filter|clipPath|radius|wght|wdth|fvar\.)/;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const r2 = (x) => Math.round(x * 100) / 100;
const pctOf = (f) => (f > 0 && f < 0.01 ? `${Math.max(0.1, Math.round(f * 1000) / 10)} %` : `${Math.round(f * 100)} %`);
export const NAV_NAME = /\b(nav|navbar|navigation|header|menu|toolbar|topbar|localnav|globalnav|ac-ln|ac-gn|masthead)\b|nav[-_]|[-_]nav\b|header[-_]|[-_]header\b/i;

/**
 * A constant-speed loop (marquee / ticker) on one translate channel: moving in >= 85 % of the frame steps, >= 75 % of the
 * steps within 0.6-1.6x the median step (same sign), at most 10 % wrap jumps, over >= 60 steps. On a scroll take it must
 * also move in the steps where the page did not scroll (a scroll-linked parallax stops with the wheel).
 * @param {Object<string, {d:number[], still:boolean[]}>} steps per channel: deltas between sampled frames, and whether the page scroll stayed put
 * @param {number} dt ms per step
 * @returns {{channel:string, pxPerSecond:number}|null}
 */
export function steadyLoop(steps, dt) {
  for (const [ch, s] of Object.entries(steps || {})) {
    const d = s.d || []; const m = d.length; if (m < 60) continue;
    const nz = d.filter((x) => Math.abs(x) > 1e-6); if (nz.length < 0.85 * m) continue;
    const abs = nz.map(Math.abs).sort((a, b) => a - b);
    const sign = Math.sign(nz.reduce((a, x) => a + Math.sign(x), 0)) || 1;
    const same = nz.filter((x) => Math.sign(x) === sign).map(Math.abs).sort((a, b) => a - b);
    const med = same[same.length >> 1]; if (!(med > 0) || !abs.length) continue;
    const within = same.filter((x) => x >= 0.6 * med && x <= 1.6 * med).length;
    const wraps = nz.filter((x) => Math.sign(x) !== sign || Math.abs(x) > 5 * med).length;
    if (within < 0.75 * m || wraps > 0.1 * m) continue;
    const still = (s.still || []).map((x, i) => (x ? i : -1)).filter((i) => i >= 0);
    if (still.length >= 10 && still.filter((i) => Math.abs(d[i]) > 1e-6).length < 0.75 * still.length) continue;
    return { channel: ch, pxPerSecond: r2((sign * med * 1000) / dt) };
  }
  return null;
}

/**
 * Notice score of one ranked entry (an element or a folded group), from elementStats entries.
 * @param {object} o
 * @param {object[]} o.members  elementStats entries of the entry's elements (lead first)
 * @param {string} [o.desc]     descriptor (tag + classes)
 * @param {{width:number,height:number}} o.viewport
 * @param {string} o.action
 * @returns {{score:number, why:string[], factors:object}}
 */
export function noticeOf({ members, desc = '', viewport, action }) {
  const lead = members[0]; const why = [];
  const va = Math.max(1, viewport.width * viewport.height);
  // on-screen area and time: over the frames it moved while (partly) in the viewport (a scroll take moves an element
  // through many frames off screen; those are not seen)
  const on = (m) => (m.areaOn != null ? m.areaOn : m.area || 0);
  const areaFrac = clamp(members.reduce((a, m) => a + on(m), 0) / va, 0, 1);
  const box = lead.box || null;
  const ownL = box && box.w > 0 && box.h > 0 ? Math.sqrt(box.w * box.h) : Math.sqrt(Math.max(on(lead), 1));
  const ampRel = clamp((lead.disp || 0) / Math.max(ownL, 1), 0, 1);
  const movingMs = Math.max(...members.map((m) => (m.movingOnMs != null ? m.movingOnMs : m.movingMs || 0)));
  const f = {
    area: Math.sqrt(areaFrac),
    amp: 0.25 + 0.75 * Math.sqrt(ampRel),
    dur: Math.sqrt(clamp(movingMs / 800, 0.1, 1)),
    pos: 1, rep: 1, penalty: 1,
  };
  const seen = areaFrac > 0;
  why.push(seen ? `${pctOf(areaFrac)} of the screen while moving` : 'off screen while moving');
  if (seen && ampRel >= 0.5) why.push('large change for its size'); else if (seen && ampRel < 0.05) why.push('small change for its size');
  if (seen && movingMs < 300) why.push(`moves ${Math.round(movingMs)} ms`);
  const firstScreen = box && Math.abs(lead.syFirst ?? 0) < 1 && box.y + box.h / 2 < 0.75 * viewport.height && box.y + box.h > 0;
  if (firstScreen) { f.pos = 1.3; if (seen) why.push('first screen'); }
  if (members.length >= 3) { f.rep = Math.min(1.6, 1 + 0.15 * Math.log2(members.length)); why.push(`${members.length} repeats`); }
  const pen = (k, w) => { f.penalty *= k; why.push(w); };
  const moving = lead.moving instanceof Set ? [...lead.moving] : (lead.moving || []);
  const opacityOnly = moving.length > 0 && !moving.some((c) => TF.has(c) || (BOX.has(c) && (lead.docMoving ? lead.docMoving.has(c) : true)) || SHAPE.test(c));
  const opMax = lead.opMax ?? 1, opStart = lead.opStart ?? 1, opEnd = lead.opEnd ?? 1;
  // the top band: its bottom edge within the top ~200 px (a nav sliding in from above starts with a negative y)
  const topBand = box && box.h <= Math.max(200, 0.22 * viewport.height) && box.y + box.h <= Math.max(200, 0.22 * viewport.height);
  const navName = NAV_NAME.test(desc);
  if (!(lead.weight > 0) || !seen) pen(0.05, 'no visible change (0 % weight)');
  else if (opMax < 0.05) pen(0.1, 'invisible (opacity 0 throughout)');
  else if (action === 'scroll' && topBand && ((lead.heldMax ?? 0) >= 200 || navName)) pen(0.15, 'sticky / fixed navigation: a scroll-state change');
  else if (lead.loop) pen(0.2, `endless marquee / ticker (constant ${Math.abs(lead.loop.pxPerSecond)} px/s loop)`);
  else if (opacityOnly && opEnd < 0.05 && opStart > 0.5 && movingMs < 600) pen(0.3, 'fades out and is gone (a placeholder swap)');
  else if (movingMs < 300 && (areaFrac < 0.02 || opMax < 0.1)) pen(0.2, 'short change on a small element');
  else if (opStart < 0.05 && opEnd < 0.05) pen(0.3, 'invisible at rest (opacity 0 before and after)');
  const score = 100 * f.area * f.amp * f.dur * f.pos * f.rep * f.penalty;
  return { score: r2(score), why, factors: { areaFrac: r2(areaFrac), ampRel: r2(ampRel), movingMs: Math.round(movingMs), pos: f.pos, rep: r2(f.rep), penalty: r2(f.penalty) } };
}

/** Order entries by notice score (then visual weight, then start), in place; returns the array. */
export function sortByNotice(entries) {
  return entries.sort((a, b) => (b.notice?.score ?? 0) - (a.notice?.score ?? 0) || (b.weight ?? 0) - (a.weight ?? 0) || (a.firstMoveT ?? 0) - (b.firstMoveT ?? 0));
}

const visible = (b, vp) => {
  if (!b || !(b.w > 0) || !(b.h > 0)) return 0;
  const iw = Math.max(0, Math.min(b.x + b.w, vp.width) - Math.max(b.x, 0)), ih = Math.max(0, Math.min(b.y + b.h, vp.height) - Math.max(b.y, 0));
  return (iw * ih) / Math.max(1, vp.width * vp.height);
};
const MOVING_GL = (l) => !['shader', 'unknown', 'camera', 'clock'].includes(l.kind);

/**
 * WebGL scenes as ranked motions: one entry per canvas (a WebGL context drawing into a page canvas) that is on screen and
 * moves: fitted uniforms that are not mere clocks, a moving camera, or a canvas whose pixels changed (a before / after
 * comparison of the canvas box) or that a clock uniform drives when no comparison was possible.
 * @param {object} o
 * @param {object} o.gl         glPass() result (lines, records, contexts, programs, clocks)
 * @param {object[]} o.canvases [{id (element id), end:{x,y,w,h}, before?:{x,y,w,h}, diff?:number|null, why?:string, sel?:string}] measured in the page
 * @param {{width:number,height:number}} o.viewport
 * @param {string} o.action
 * @param {number} [o.scrollY]  page scroll when the canvas box was read (first-screen bonus at 0)
 * @param {Map} [o.sels]        id -> [selector, matches]
 * @returns {object[]} motion-shaped entries (kind 'gl'), each with notice {score, why}; no rank yet
 */
export function glMotions({ gl, canvases = [], viewport, action, scrollY = 0, sels = null }) {
  if (!gl || !gl.read) return [];
  const ctxs = (gl.contexts || []).filter((c) => c.el != null && !c.offscreen);
  if (!ctxs.length) return [];
  const boxOf = new Map(canvases.map((c) => [c.id, c]));
  const progCtx = new Map((gl.programs || []).map((p) => [p.id, p.ctx]));
  const ctxOfProgUniform = (name) => { const out = new Set(); for (const p of gl.programs || []) if ((p.uniforms || []).some((u) => u.name === name)) out.add(p.ctx); return out; };
  const byUse = [...ctxs].sort((a, b) => (visible((boxOf.get(b.el) || {}).end, viewport) - visible((boxOf.get(a.el) || {}).end, viewport)));
  const main = byUse[0];
  // which context a line belongs to: `uniform name@pN` -> program N; `uniform name` -> the programs that declare it; else the largest canvas
  const ctxOfLine = (l) => {
    const s = String(l.subject || ''); let m = /@p(\d+)$/.exec(s);
    if (m && progCtx.has(+m[1])) return progCtx.get(+m[1]);
    m = /^uniform (.+?)$/.exec(s);
    if (m) { const set = ctxOfProgUniform(m[1].replace(/@p\d+$/, '')); if (set.size === 1) return [...set][0]; }
    return main.id;
  };
  const out = [];
  for (const c of ctxs) {
    const cv = boxOf.get(c.el); if (!cv || !cv.end) continue;
    const cover = Math.max(visible(cv.end, viewport), visible(cv.before, viewport));
    if (cover < 0.01) continue;
    const mine = (gl.lines || []).filter((l) => l.kind !== 'shader' && l.kind !== 'unknown' && (ctxs.length === 1 || ctxOfLine(l) === c.id));
    const moving = mine.filter(MOVING_GL);
    const clocks = mine.filter((l) => l.kind === 'clock');
    const pix = Number.isFinite(cv.diff) ? cv.diff : null;
    const pixChanged = pix != null && pix >= 0.004;
    const changes = moving.length > 0 || pixChanged || (pix == null && clocks.length > 0);
    if (!changes) continue;
    // (the camera's static decode stays in the WebGL section; a moving camera has its own fitted lines)
    const lines = moving.length ? [...moving, ...clocks] : clocks;
    const chans = new Set(lines.flatMap((l) => l.channels || []));
    const records = (gl.records || []).filter((r) => chans.has(r.target.channel));
    const why = [`${pctOf(cover)} of the screen (canvas)`];
    let note = null;
    if (moving.length) why.push(`WebGL values change: ${[...new Set(moving.map((l) => String(l.subject || l.kind).replace(/^uniform /, '')))].slice(0, 3).join(', ')}`);
    else {
      note = clocks.length
        ? `moves, values inside the canvas not measured: only a clock uniform (${clocks.map((l) => String(l.subject || '').replace(/^uniform /, '')).slice(0, 3).join(', ')}) changes; what the shader draws from it is not fitted`
        : `moves, values inside the canvas not measured: its pixels changed but no uniform or camera value changed (the motion is computed inside the shader or from data the WebGL tap does not read)`;
      why.push(clocks.length ? 'driven by a clock uniform' : 'pixels change');
    }
    if (pix != null) why.push(pixChanged ? `pixels changed (${r2(pix * 100)} % mean)` : 'pixels did not change in the compared frames');
    const box = cv.end;
    const firstScreen = Math.abs(scrollY) < 1 && box.y + box.h / 2 < 0.75 * viewport.height && box.y + box.h > 0;
    const f = { area: Math.sqrt(cover), amp: pix != null ? 0.25 + 0.75 * Math.sqrt(clamp(pix / 0.15, 0, 1)) : 0.75, dur: 1, pos: firstScreen ? 1.3 : 1 };
    if (firstScreen) why.push('first screen');
    const score = r2(100 * f.area * f.amp * f.dur * f.pos);
    const own = sels && sels.get(c.el);
    const sel = own && own[0] ? own : cv.sel ? [cv.sel, 1] : own || null;
    const desc = `WebGL scene (canvas, ${pctOf(cover)} of the screen)`;
    const toLine = (l) => ({ text: l.text, kind: l.kind, family: l.family ?? null, label: l.label, channels: l.channels || [], trigger: l.trigger ?? null, t0: l.t0 ?? null, times: l.times ?? 1, values: l.values || [], subject: l.subject || null });
    out.push({
      kind: 'gl', desc, selector: (sel && sel[0]) || null, selectorMatches: sel ? sel[1] ?? null : null, selectorWhy: sel && sel[0] ? null : 'the canvas has no unique selector', leadSelector: null, selectorGone: !!(sel && sel[2]),
      box: { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.w), h: Math.round(box.h) }, count: 1, lead: c.el, ids: [c.el],
      starts: null, weight: null, weightShare: null, channels: [...chans], fitted: null, membersNotFitted: 0, covered: [],
      unknowns: [],
      lines: note ? [{ text: `WebGL scene: ${note} [unknown]`, kind: 'not measured', family: null, label: 'unknown', channels: [], trigger: null, t0: null, times: 1, values: [] }, ...lines.map(toLine)] : lines.map(toLine),
      stagger: null, share: null, records, exports: [],
      gl: { context: c.id, cover: r2(cover), pixels: pix == null ? { compared: false, why: cv.why || 'no before / after frame of the canvas box to compare' } : { compared: true, meanDiff: r2(pix), changed: pixChanged } },
      notice: { score, why, factors: { areaFrac: r2(cover), pos: f.pos, amp: r2(f.amp) } },
    });
  }
  return out;
}

/**
 * Merge gl entries into the ranked motions by notice score and number the ranks 1..n again. Returns the old -> new rank
 * map (the caller renumbers whatever is keyed by rank: plan entries, positions, `others`).
 */
export function mergeRanked(motions, glEntries) {
  const all = [...motions, ...glEntries];
  const order = all.map((m, i) => ({ m, i })).sort((a, b) => (b.m.notice?.score ?? 0) - (a.m.notice?.score ?? 0) || a.i - b.i).map((x) => x.m);
  const map = new Map();
  order.forEach((m, i) => { if (m.rank != null) map.set(m.rank, i + 1); m.rank = i + 1; });
  motions.splice(0, motions.length, ...order);
  return map;
}

/** look.json "screens" from what was captured (pure: the shape the card codes against). */
export function screensOf({ end = null, before = null, page = null } = {}) {
  const vp = (s, file) => (s ? { file, w: s.w, h: s.h, scrollY: s.scrollY, dpr: s.dpr } : null);
  return {
    viewport: vp(end, 'screen-end.jpg'),
    before: vp(before, 'screen-before.jpg'),
    page: page ? { file: 'page.jpg', w: page.w, h: page.h, scale: page.scale, ...(page.capped ? { capped: page.capped } : {}) } : null,
  };
}
