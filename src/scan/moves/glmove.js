// WebGL inside a move (DESIGN 2.5): the uniforms a page sets while one of its moves plays belong to that move. A page change that
// dissolves the screen through a shader is the shader first and the DOM second, so a move's spec holds the uniforms that change in its
// window, fitted like any DOM channel. Pure: rows in, plain objects out; the fit itself is in fit.js (fitGlMove).
// What is left out, and said so in the move file: a uniform the page sets on every draw (per-object values), a clock (a time uniform that
// rises on a straight line), and a uniform that was already moving before the move began (ambient, pointer, a loop).
import { glSeriesOf, parseKey } from '../../analysis/gl/channels.js';
import { techniqueOf, techniqueSummary } from '../../analysis/gl/technique.js';
import { clockOf } from '../../look/gl.js';

export const GLM = Object.freeze({
  preMs: 1500,          // the stretch before a move that says whether a uniform was already moving
  preGapMs: 250,        // ...ending this long before the move, so its own first frames are not counted against it
  preShare: 0.2,        // moving in more than this share of those frames: ambient, not this move's
  restMs: 200,          // a uniform still this long ends one motion; the next change starts another
  minFrames: 4,         // changed frames that make a motion; fewer is a step
  tailMs: 4000,         // a uniform that starts inside the move is followed this long past its end, to its rest
  maxWindowMs: 10000,   // a move's window read for uniforms, at most
  maxGroups: 8,         // uniforms kept in one move, the earliest first
  maxLeft: 12,          // uniforms left out, listed with their reason
  maxClocks: 32,        // clocks kept in one move, by program
  maxObjects: 6,        // moving objects (object matrices) kept in one move, apart from the uniforms
  cover: 0.5,           // a canvas over this share of the screen leads the move's words
  full: 0.9,            // ...and over this share it is full-screen
});
/** The reasons a uniform that changed in a move's window is not in its spec. */
export const GL_LEFT = Object.freeze({
  perDraw: 'set on every draw: one value per object, not one motion',
  clock: 'a clock: rises on a straight line with page time',
  ambient: 'already moving before the move began',
  derived: 'derived by the engine from the camera and object matrices (the camera itself is gl:camera.*)',
  pointer: 'moves with the pointer: its program reads the pointer, and a cursor or scene move carries that',
});
/** three.js sets these per object from its camera and model matrices: they say where things are, not what a move animates. */
const DERIVED = /^(cameraPosition|normalMatrix(\[\d+\])?)$/;
/** A program that reads the pointer: a uniform of its own says so by name. */
const POINTER = /mouse|pointer|cursor/i;

/** Recorder keys the page sets several times a frame: their per-frame value is the last object's, not a motion. */
export function perDrawKeys(counters = {}) {
  return new Set(Object.entries(counters.multi || {}).filter(([k, n]) => n > 0.5 * ((counters.setFrames || {})[k] || 1)).map(([k]) => k));
}

/** One channel's motions in a window: runs of changes split where it rests `restMs`. Each with the resting sample before it. */
export function segmentsOf(T, y, { restMs = GLM.restMs, hideMs = GLM.restMs } = {}) {
  const out = []; let cur = null;
  for (let i = 1; i < y.length; i++) {
    // a stretch with no sample (its program did not draw): what it holds after is where it was set while hidden, a jump, not a motion
    if (T[i] - T[i - 1] > hideMs) { if (cur) { out.push(cur); cur = null; } continue; }
    if (y[i] === y[i - 1]) continue;
    if (cur && T[i] - T[cur.i1] > restMs) { out.push(cur); cur = null; }
    if (!cur) cur = { i0: i - 1, i1: i, frames: 0 };
    cur.i1 = i; cur.frames++;
  }
  if (cur) out.push(cur);
  for (const s of out) { const ys = y.slice(s.i0, s.i1 + 1); s.amp = Math.max(...ys) - Math.min(...ys); s.travel = y[s.i1] - y[s.i0]; }
  return out;
}

const TIME_NAME = /time/i;
/**
 * A motion that is time itself: rising on every changed frame, on a straight line (R² ≥ 0.9999) against page time, at 1 per second
 * or 1 per millisecond (within 2 %), or at any rate under a name with "time" in it (technique.js reads such a uniform as a clock).
 */
export function tickOf(T, y, seg, name = '') {
  if (seg.frames < GLM.minFrames) return false;
  const xs = [], ys = [];
  for (let i = seg.i0 + 1; i <= seg.i1; i++) { if (!(y[i] > y[i - 1])) { if (y[i] === y[i - 1]) continue; return false; } xs.push(T[i]); ys.push(y[i]); }
  const n = xs.length; if (n < GLM.minFrames) return false;
  // a time uniform that counts frames or draws: the same step on every change, whatever the time between (a skinned-mesh WebGL site: uTime +1/60 a draw,
  // drawn 2 of 3 frames: not on a line with page time, still a clock)
  if (TIME_NAME.test(name)) { const st = []; for (let i = 1; i < n; i++) st.push(ys[i] - ys[i - 1]); const m = st.slice().sort((a, b) => a - b)[st.length >> 1]; if (m > 0 && st.every((v) => Math.abs(v - m) <= 0.01 * m)) return true; }
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0, sxy = 0, syy = 0; for (let i = 0; i < n; i++) { sxx += (xs[i] - mx) ** 2; sxy += (xs[i] - mx) * (ys[i] - my); syy += (ys[i] - my) ** 2; }
  if (!(sxx > 0 && syy > 0) || (sxy * sxy) / (sxx * syy) < 0.9999) return false;
  const perSecond = (sxy / sxx) * 1000;
  return TIME_NAME.test(name) || [1, 1000].some((r) => Math.abs(perSecond - r) <= 0.02 * r);
}

/**
 * Every float uniform (and decoded camera quantity) that starts to change inside [T0, T1], with what REVA makes of it. A motion that
 * starts inside the move is followed past T1 up to `Tend`, so a shader pass that outlasts the DOM keeps its whole length.
 * @param {object[]} rows  decoded rows of one document, oldest first, from at least `preMs` before T0
 * @param {{T0:number, T1:number, Tend?:number, perDraw?:Set<string>}} win
 * @returns {{key, ch, glKey, comp, camera, status:'motion'|'step'|'perDraw'|'clock'|'ambient', T:number[], y:number[], onset:number, end:number, frames:number, amp:number}[]}
 */
export function glChannelsIn(rows, { T0, T1, Tend = T1, perDraw = new Set() }) {
  const out = [];
  // a uniform's value counts only while its program draws (row.gld): a program that is not drawn holds its last value, which shows
  // nothing, and a value set while it was hidden is a jump at its next draw (a skinned-mesh WebGL site: uTime, 6 Nov)
  const known = rows.some((r) => r.gld), drew = (prog, r) => !known || !r.gld || !!r.gld[`p${prog}`];
  for (const s0 of glSeriesOf(rows).values()) {
    const prog = s0.glKey ? parseKey(s0.glKey).prog : null;
    let s = s0;
    if (known && prog != null) { const j = s0.idx.map((ri, n) => (drew(prog, rows[ri]) ? n : -1)).filter((n) => n >= 0); if (j.length !== s0.idx.length) s = { ...s0, idx: j.map((n) => s0.idx[n]), y: j.map((n) => s0.y[n]) }; }
    const T = s.idx.map((i) => rows[i].T), inside = [];
    for (let i = 0; i < T.length; i++) if (T[i] >= T0 && T[i] <= Math.max(T1, Tend)) inside.push(i);
    if (inside.length < 2) continue;
    const Ti = inside.map((i) => T[i]), yi = inside.map((i) => s.y[i]);
    // the sample just before the window: a uniform that moves on the window's first frame starts from it
    const before = inside[0] > 0 && T[inside[0] - 1] >= T0 - GLM.preGapMs ? inside[0] - 1 : null;
    const Tw = before == null ? Ti : [T[before], ...Ti], yw = before == null ? yi : [s.y[before], ...yi];
    const segs = segmentsOf(Tw, yw).filter((g) => Tw[g.i0 + 1] <= T1);
    if (!segs.length) continue;
    const base = { key: s.key, ch: s.ch, glKey: s.glKey ?? null, comp: s.comp ?? null, camera: s.camera ?? null };
    // a motion's track: the resting sample before it, its changes, and the rest after it up to `restMs`, so a fit sees it settle
    const say = (status, seg) => {
      let j = seg.i1; while (j + 1 < Tw.length && yw[j + 1] === yw[seg.i1] && Tw[j + 1] - Tw[seg.i1] <= GLM.restMs) j++;
      return { ...base, status, T: Tw.slice(seg.i0, j + 1), y: yw.slice(seg.i0, j + 1), onset: Tw[seg.i0 + 1], end: Tw[seg.i1], frames: seg.frames, amp: seg.amp, from: yw[seg.i0], to: yw[seg.i1] };
    };
    const widest = segs.reduce((a, b) => (b.amp > a.amp ? b : a));
    if (s.glKey && perDraw.has(s.glKey)) { out.push(say('perDraw', widest)); continue; }
    if (!s.camera && DERIVED.test(uniformName(s.ch.replace(/\.[xyzw]$/, '')))) { out.push(say('derived', widest)); continue; }
    // a clock over the window, or a motion of it that rises on a straight line at page time (1 per second or per ms) or under a
    // time name: a program drawn for part of the window holds its time uniform once it stops drawing, a plateau no clock has
    if (!s.camera && (clockOf(Ti, yi, Ti.at(-1) - Ti[0]) || segs.some((g) => tickOf(Tw, yw, g, uniformName(s.ch))))) { out.push({ ...say('clock', widest), clock: clockAt(T, s.y, Ti, yi, T0) }); continue; }
    let pre = 0, preN = 0;
    for (let i = 1; i < T.length; i++) { if (T[i] < T0 - GLM.preMs || T[i] > T0 - GLM.preGapMs) continue; preN++; if (s.y[i] !== s.y[i - 1]) pre++; }
    if (preN && pre > GLM.preShare * preN) { out.push(say('ambient', widest)); continue; }
    const motions = segs.filter((g) => g.frames >= GLM.minFrames);
    const pick = (motions.length ? motions : segs).reduce((a, b) => (b.amp > a.amp ? b : a));
    out.push(say(motions.length ? 'motion' : 'step', pick));
  }
  // a program whose pointer uniform changes in the window: what else it changes there follows the pointer too (a fluid's force)
  const pointerProgs = new Set(out.filter((c) => c.status !== 'perDraw' && c.glKey && POINTER.test(uniformName(c.ch))).map((c) => parseKey(c.glKey).prog));
  for (const c of out) if ((c.status === 'motion' || c.status === 'step') && c.glKey && pointerProgs.has(parseKey(c.glKey).prog)) c.status = 'pointer';
  return out;
}

/**
 * A clock as a rebuild needs it: its rate per second (a line through the frames where it rose) and its value when the move starts.
 * The mock of /world (5 Nov) showed the origin sets an ink blob's shape and a glitch's seeds, so a clock is data, not noise.
 * Before T0 a program that was not drawn holds its last value: that held value is the origin. With no sample before T0, the line is
 * run back to T0 and `extrapolated` says so.
 * @param {number[]} T @param {number[]} y  the series over all rows given; Ti, yi: its samples inside the window
 */
export function clockAt(T, y, Ti, yi, T0) {
  const xs = [], ys = [];
  // the frames where it rose; the frame before the first rise may be a held value, so it is not on the line
  for (let i = 1; i < Ti.length; i++) if (yi[i] > yi[i - 1]) { xs.push(Ti[i]); ys.push(yi[i]); }
  const n = xs.length; let rate = null;
  if (n >= 2) { const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n; let sxx = 0, sxy = 0; for (let i = 0; i < n; i++) { sxx += (xs[i] - mx) ** 2; sxy += (xs[i] - mx) * (ys[i] - my); } rate = sxx > 0 ? (sxy / sxx) * 1000 : null; }
  let at = -1; for (let i = 0; i < T.length; i++) if (T[i] <= T0 + 0.5) at = i; else break;
  const sig = (v) => (v == null ? null : Number(v.toPrecision(7)));
  const tick = tickKind(Ti, yi);
  if (at >= 0) return { rate: sig(rate), ...tick, origin: sig(y[at]), at: T0, sampledAt: T[at] };
  const first = Ti.length ? 0 : -1; if (first < 0 || rate == null) return { rate: sig(rate), ...tick, origin: null, at: T0 };
  return { rate: sig(rate), ...tick, origin: sig(yi[0] - (rate * (Ti[0] - T0)) / 1000), at: T0, extrapolated: true };
}

/**
 * What a clock counts: `per: 'second'` (page time, the rate is its law), `'frame'` (a fixed step each frame the page draws, the
 * step is its law: a shader-transition site, uTime +0.016 a frame, 0.96 per second at 60 fps) or `'draw'` (a fixed step each time its program draws,
 * held while it is not drawn: a skinned-mesh WebGL site, uTime). A step that grows with the time between samples is page time; a fixed step while that time
 * varies counts draws; with every sample one frame apart, a rate of 1 or 1000 per second is page time and any other a frame count.
 * @param {number[]} Ti @param {number[]} yi  its samples in the window, only frames where its program drew
 */
export function tickKind(Ti, yi) {
  const steps = [], dts = [];
  for (let i = 1; i < Ti.length; i++) if (yi[i] > yi[i - 1]) { steps.push(yi[i] - yi[i - 1]); dts.push(Ti[i] - Ti[i - 1]); }
  if (steps.length < GLM.minFrames) return {};
  const med = (a) => a.slice().sort((x, z) => x - z)[a.length >> 1], spread = (a) => { const m = med(a); return m > 0 ? Math.max(...a.map((v) => Math.abs(v - m))) / m : Infinity; };
  const step = med(steps), dt = med(dts), sig = (v) => Number(v.toPrecision(7));
  const even = dts.every((d) => Math.abs(d - dt) <= 1);
  // float32 steps of a small clock wobble in their last digits: 1 % is one step
  const fixed = spread(steps) <= 0.01, timed = spread(steps.map((v, i) => v / dts[i])) <= 0.01;
  if (!even && fixed && !timed) return { per: 'draw', step: sig(step) };
  if (!even) return { per: 'second' };
  const perSecond = (step / dt) * 1000;
  if (!fixed || [1, 1000, 0.001].some((r) => Math.abs(perSecond - r) <= 0.02 * r)) return { per: 'second' };
  return { per: 'frame', step: sig(step), frameMs: Math.round(dt * 1000) / 1000 };
}

/** The clocks of a move's programs: one entry per program whose time uniform ran in the window, at most `maxClocks`. */
export function glClocksOf(channels) {
  return channels.filter((c) => c.status === 'clock' && c.clock).map((c) => ({ uniform: uniformName(c.ch), channel: c.ch, program: c.glKey ? `p${parseKey(c.glKey).prog}` : null, ...c.clock }))
    .sort((a, b) => String(a.program).localeCompare(String(b.program), 'en', { numeric: true })).slice(0, GLM.maxClocks);
}

/** The uniform a channel belongs to: 'gl:uColor@p3.y' -> 'gl:uColor@p3'; a camera quantity is its own. */
export const uniformOf = (c) => (c.comp != null ? c.ch.replace(/\.[xyzw]$/, '') : c.ch);
/** The name a person reads: the GLSL name, without the program suffix. */
export const uniformName = (ch) => ch.replace(/^gl:/, '').replace(/@p\d+$/, '');

/**
 * The channels of a move, as one entry per uniform: the component that travels furthest leads, the others ride along.
 * Kept: motions and steps, earliest first, at most `maxGroups`. Left: the rest, with their reason.
 */
export const isObjectChannel = (ch) => /\.(position|screen|inView)(@p\d+)?(\.[xyzw])?$/.test(ch);
export function glUniformsOf(channels) {
  const by = new Map();
  for (const c of channels) { if (c.status !== 'motion' && c.status !== 'step') continue; const u = uniformOf(c); (by.get(u) || by.set(u, []).get(u)).push(c); }
  // an object on the screen leads its object: its screen position, when known, else its largest position component
  const leadOf = (u, list) => (isObjectChannel(u) && list.some((x) => /\.screen/.test(x.ch)) ? list.filter((x) => /\.screen/.test(x.ch)) : list).reduce((a, b) => (b.amp > a.amp ? b : a));
  const all = [...by.entries()].map(([u, list]) => { const lead = leadOf(u, list); return { uniform: u, lead, rest: list.filter((x) => x !== lead) }; })
    .sort((a, b) => (a.lead.status === 'motion' ? 0 : 1) - (b.lead.status === 'motion' ? 0 : 1) || a.lead.onset - b.lead.onset || (b.lead.end - b.lead.onset) - (a.lead.end - a.lead.onset));
  // the screen position and the 3D position of one object are one group: the uniform key without .position / .screen
  const objKey = (u) => u.replace(/\.(position|screen|inView)(@p\d+)?$/, '$2');
  const objects = [], seen = new Map();
  for (const k of all.filter((x) => isObjectChannel(x.uniform))) { const o = seen.get(objKey(k.uniform)); if (o) { o.rest.push(k.lead, ...k.rest); continue; } seen.set(objKey(k.uniform), k); objects.push(k); }
  for (const o of objects) { const list = [o.lead, ...o.rest], lead = leadOf(o.uniform.replace(/\.position/, '.screen'), list); if (lead !== o.lead) { o.uniform = uniformOf(lead); o.lead = lead; o.rest = list.filter((x) => x !== lead); } }
  const uniforms = all.filter((x) => !isObjectChannel(x.uniform));
  const left = channels.filter((c) => c.status !== 'motion' && c.status !== 'step').map((c) => ({ channel: c.ch, why: GL_LEFT[c.status] }));
  for (const k of uniforms.slice(GLM.maxGroups)) left.push({ channel: k.uniform, why: `past the first ${GLM.maxGroups} uniforms of this move` });
  for (const k of objects.slice(GLM.maxObjects)) left.push({ channel: k.uniform, why: `past the first ${GLM.maxObjects} objects of this move` });
  return { kept: [...uniforms.slice(0, GLM.maxGroups), ...objects.slice(0, GLM.maxObjects)], left: left.slice(0, GLM.maxLeft), leftCount: left.length };
}

/** The program that sets a uniform, its context and what its source says (technique.js). Page-wide items stay out of the short line. */
export function programOf(glKey, programs, counters = {}) {
  const prog = glKey ? parseKey(glKey).prog : null, p = prog == null ? null : programs.find((x) => x.id === prog);
  if (!p) return { program: prog == null ? null : `p${prog}`, ctx: null, technique: null, items: [] };
  const items = techniqueOf(p, counters), own = items.filter((x) => x.id !== 'render-to-texture' && x.id !== 'time');
  return { program: `p${p.id}`, ctx: p.ctx ?? null, technique: techniqueSummary(own, {}) || null, items: items.map((x) => x.id) };
}

/** How much of the screen a context's canvas covers, 0-1: its box in the rows, else its drawing buffer. Null when neither is known. */
export function coverOf(ctx, row, viewport) {
  if (!ctx || !viewport?.width || !viewport?.height) return null;
  const v = row?.v?.[String(ctx.el)];
  let box = v && ['ren:bx', 'ren:by', 'ren:bw', 'ren:bh'].every((k) => Number.isFinite(v[k])) ? [v['ren:bx'], v['ren:by'], v['ren:bw'], v['ren:bh']] : null;
  if (!box && ctx.width > 0 && ctx.height > 0) { const d = viewport.dpr || 1; box = [0, 0, ctx.width / d, ctx.height / d]; }
  if (!box) return null;
  const w = Math.max(0, Math.min(box[0] + box[2], viewport.width) - Math.max(box[0], 0)), h = Math.max(0, Math.min(box[1] + box[3], viewport.height) - Math.max(box[1], 0));
  return Math.round(((w * h) / (viewport.width * viewport.height)) * 1000) / 1000;
}

/** A WebGL group is a layer of the move, not an element. */
export const isGlGroup = (g) => g?.layer === 'gl';
/** A WebGL group that leads a move's words: a motion with a law, on a canvas over most of the screen. An object (a text, a mesh) is a part
 * of the layer, not the layer, so it never leads. */
export const glLeads = (g) => isGlGroup(g) && !isObjectChannel(g.lead?.channel ?? g.channel ?? '') && ['tween', 'spring'].includes(g.law?.class) && ['fitted', 'declared'].includes(g.provenance) && (g.gl?.cover ?? 0) >= GLM.cover;
/** Move kinds whose window is read for WebGL. An ambient move runs all the time and a cursor follows the pointer: their WebGL is the scene's. */
export const GL_KINDS = new Set(['load', 'gate', 'scroll', 'scroll-up', 'touch', 'open', 'change']);

// ---------------------------------------------------------------- passes, draws, objects (recorder row.gld, row.glo, take.gl.textures)
const OBJ_KEY = /^(p\d+)\|([A-Za-z_][A-Za-z0-9_]{0,63})(?:#(\d+))?$/, PROJ = /^(projectionMatrix|uProjection|u_projection|uProjectionMatrix|u_projectionMatrix)$/;
/**
 * Rows with each object matrix's position (translation column) as a vec3 uniform of its program, `p9|modelViewMatrix.position` (object 0)
 * or `p9|modelViewMatrix_2.position` (the third object the program drew), so a mesh or a text that moves in a move's window is read and
 * fitted like any uniform. When the program's projection is known too (row.glo, or row.glm for the first camera keys) and the viewport
 * is given, the object's origin on the screen is `...screen` [x, y] in CSS px from the top left: what a person sees move.
 * Rows without object matrices come back as they were.
 */
export function withObjectPositions(rows, viewport = null) {
  if (!rows.some((r) => r.glo)) return rows;
  const W = viewport?.width, H = viewport?.height;
  return rows.map((r) => {
    if (!r.glo) return r;
    const add = {}, proj = {};
    for (const src of [r.glm, r.glo]) for (const [k, m] of Object.entries(src || {})) { const x = OBJ_KEY.exec(k); if (x && PROJ.test(x[2]) && Array.isArray(m) && m.length >= 16) proj[`${x[1]}#${x[3] || 0}`] = m; }
    for (const [k, m] of Object.entries(r.glo)) {
      const x = OBJ_KEY.exec(k); if (!x || PROJ.test(x[2]) || !Array.isArray(m) || m.length < 16) continue;
      const name = `${x[1]}|${x[2]}${x[3] ? `_${x[3]}` : ''}`;
      add[`${name}.position`] = [m[12], m[13], m[14]];
      const P = proj[`${x[1]}#${x[3] || 0}`] || proj[`${x[1]}#0`];
      if (P && W > 0 && H > 0 && /modelView|MV|mv/.test(x[2])) {
        const cx = P[0] * m[12] + P[4] * m[13] + P[8] * m[14] + P[12], cy = P[1] * m[12] + P[5] * m[13] + P[9] * m[14] + P[13], w = P[3] * m[12] + P[7] * m[13] + P[11] * m[14] + P[15];
        if (Math.abs(w) > 1e-9) add[`${name}.screen`] = [Math.round(((cx / w + 1) / 2) * W * 100) / 100, Math.round(((1 - cy / w) / 2) * H * 100) / 100];
        // inside the camera's depth range (near to far): an object past the far plane is drawn and still not seen (a 3D portfolio site, a 3D page:
        // the title text flies in from z -2500 and shows at frame 62, when it crosses the far plane at 2201)
        const cz = P[2] * m[12] + P[6] * m[13] + P[10] * m[14] + P[14];
        add[`${name}.inView`] = w > 0 && cz >= -w && cz <= w ? 1 : 0;
      }
    }
    return { ...r, gl: { ...(r.gl || {}), ...add } };
  });
}

/**
 * Who drew, from row.gld: per program, the stretches of frames it drew in (a frame without a draw splits them), its draws per frame,
 * the order it drew in (median of its first-draw rank) and the targets it drew into (0 = the canvas). Null when the rows have no draw
 * record (a take made before the recorder kept one).
 * @returns {Map<string, {windows:[number,number][], frames:number, draws:number, order:number, into:number[], states:{id:number,frames:number}[], under:string[]|null}>|null}
 */
export function drawsOf(rows) {
  if (!rows.some((r) => r.gld)) return null;
  const out = new Map(), last = new Map();
  rows.forEach((r, i) => {
    if (!r.gld) return;
    for (const [p, d] of Object.entries(r.gld)) {
      if (!/^p\d+$/.test(p) || !Array.isArray(d)) continue;
      let o = out.get(p); if (!o) out.set(p, (o = { windows: [], frames: 0, draws: 0, orders: [], into: new Set(), states: new Map(), under: new Map() }));
      o.frames++; o.draws += +d[0] || 0; o.orders.push(+d[1] || 0); for (const fb of d.slice(2)) o.into.add(+fb);
      // the composite states it drew with this frame (row.glb: one id, or several when it switched)
      const b = r.glb?.[p]; for (const id of b == null ? [] : Array.isArray(b) ? b : [b]) if (Number.isInteger(id) && id > 0) o.states.set(id, (o.states.get(id) || 0) + 1);
      // the programs it was drawn over this frame (row.glu: drawn into the same target since that target's last colour clear)
      if (r.glu) { o.seen = (o.seen || 0) + 1; for (const q of r.glu[p] || []) if (Number.isInteger(q)) o.under.set(`p${q}`, (o.under.get(`p${q}`) || 0) + 1); }
      if (last.get(p) === i - 1 && o.windows.length) o.windows.at(-1)[1] = r.T; else o.windows.push([r.T, r.T]);
      last.set(p, i);
    }
  });
  // cadence: frames drawn against the frames of its stretches (gaps up to GLM.restMs joined); a page that skips frames on its own
  // (a skinned-mesh WebGL site: a 60 fps limiter on Date.now deltas with a strict '<', so on an exact 60 Hz grid one frame in three is under 1000/60 ms)
  // draws on fewer frames than the clock stepped, and the rows say which: a frame without its row.gld entry is a frame it did not draw
  const Ts = rows.map((r) => r.T), dtRow = Ts.length > 1 ? (Ts.at(-1) - Ts[0]) / (Ts.length - 1) : 1000 / 60;
  for (const o of out.values()) {
    let spanned = 0, a = null, b = null;
    for (const [x, y] of o.windows) { if (a != null && x - b <= GLM.restMs) { b = y; continue; } if (a != null) spanned += Math.round((b - a) / dtRow) + 1; a = x; b = y; }
    if (a != null) spanned += Math.round((b - a) / dtRow) + 1;
    o.cadence = spanned ? Math.round((o.frames / spanned) * 1000) / 1000 : 1;
  }
  for (const o of out.values()) {
    const s = o.orders.sort((a, b) => a - b); o.order = s[s.length >> 1]; delete o.orders; o.into = [...o.into].sort((a, b) => a - b); o.draws = Math.round((o.draws / o.frames) * 10) / 10;
    o.states = [...o.states].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([id, frames]) => ({ id, frames }));   // most frames first
    // drawn over: a program under it in at least half the frames it drew in (a frame where it was the first after a clear counts)
    o.under = o.seen ? [...o.under].filter(([, n]) => n >= o.seen / 2).map(([q]) => q) : null; delete o.seen;
  }
  return out;
}

const ATLAS = /sdf|glyph|font|atlas|troika|msdf/i, NOISE = /noise|blue|perlin|random|dither|grain/i;
/** What a texture is, from its description and the sampler that reads it: a render target, a text atlas, noise, a video, an image, data. */
export function textureKind(t, sampler = '') {
  if (!t) return 'unknown';
  if (t.fb != null) return 'render target';
  if (ATLAS.test(sampler)) return 'text atlas';
  if (NOISE.test(sampler)) return 'noise';
  if (t.source === 'video' || (t.source === 'canvas' && t.updates + t.uploads > 2)) return t.source === 'video' ? 'video' : 'live canvas';
  if (t.source === 'image' || t.source === 'bitmap') return 'static image';
  if (t.source === 'canvas' || t.source === 'imagedata') return 'drawn canvas';
  if (t.source === 'data') return t.updates > 0 || t.uploads > 2 ? 'data (updated)' : 'data';
  return t.source || 'unknown';
}

/**
 * The pass graph of a move's window: every program that drew, in drawing order, what it drew into and what it read. A target another
 * pass drew into is named by that pass, so `p23 -> target 4 -> p24 (u_scene)` reads as one chain. Times are ms since the move's T0.
 * @param {Map} draws  drawsOf over the window
 * @param {{textures?:object[], targets?:object[]}} gl  take.gl
 */
export function passesOf(draws, gl, T0) {
  if (!draws) return null;
  const tex = new Map((gl?.textures || []).map((t) => [t.id, t])), fbs = new Map((gl?.targets || []).map((f) => [f.id, f]));
  const drawersOf = (fb) => [...draws].filter(([, o]) => o.into.includes(fb)).map(([p]) => p);
  const target = (fb) => { if (!fb) return 'canvas'; const f = fbs.get(fb); return `target ${fb}${f?.w ? ` (${f.w}x${f.h})` : ''}`; };
  const reads = (p) => (gl?.textures || []).flatMap((t) => (t.sampled || []).filter((s) => s.startsWith(`${p}|`)).map((s) => {
    const uniform = s.slice(p.length + 1), kind = textureKind(t, uniform);
    return { uniform, texture: `t${t.id}`, kind, size: t.w ? `${t.w}x${t.h}` : null, ...(t.fb != null ? { target: t.fb, from: drawersOf(t.fb).filter((x) => x !== p) } : {}) };
  }));
  const ms = (T) => Math.round((T - T0) * 10) / 10;
  const states = new Map((gl?.states || []).map((x) => [x.id, x])), sorted = [...draws].sort((a, b) => a[1].order - b[1].order || a[1].windows[0][0] - b[1].windows[0][0]);
  return sorted.map(([p, o], i) => {
    // what it is drawn over: from the recorder, the programs drawn into its target since that target's last colour clear (in drawing
    // order); a take without that record: the passes before it that drew into one of the same targets
    const rank = new Map(sorted.map(([q], j) => [q, j]));
    const over = o.under ? o.under.filter((q) => q !== p).sort((a, b) => (rank.get(a) ?? 1e9) - (rank.get(b) ?? 1e9)) : sorted.slice(0, i).filter(([, u]) => u.into.some((fb) => o.into.includes(fb))).map(([q]) => q);
    const st = o.states.length && states.get(o.states[0].id), comp = st ? compositeOf(st) : null;
    // states that read alike (they differ in what the words leave out, e.g. the colour mask of a channel) are one
    const kinds = []; for (const { id, frames } of o.states) { const c = compositeOf(states.get(id) || {}), sig = JSON.stringify(c), had = kinds.find((x) => x.sig === sig); if (had) had.frames += frames; else kinds.push({ sig, c, frames }); }
    return {
      program: p, order: o.order, drawsPerFrame: o.draws, frames: o.frames, into: o.into.map(target), drawn: mergedOf(o.windows).map(([a, b]) => [ms(a), ms(b)]), reads: reads(p),
      // drawn on fewer frames than the clock stepped: said, with the share, so a rebuild skips the same frames
      ...(o.cadence < 0.95 ? { cadence: o.cadence, skips: cadenceWords(o.cadence) } : {}),
      ...(comp ? { blend: comp.blend, depth: comp.depth, ...(comp.cull ? { cull: comp.cull } : {}), ...(comp.scissor ? { scissor: true } : {}), over, shows: showsLine(comp, over, o.into.map(target)), ...(comp.factors ? { factors: comp.factors } : {}) } : {}),
      ...(kinds.length > 1 ? { states: kinds.map(({ c, frames }) => ({ ...c, frames })) } : {}),
    };
  }).filter((x) => tex.size || x.into.length);
}

/** Draw stretches with gaps up to GLM.restMs joined: a program drawn 2 of 3 frames is one stretch, not 125. */
export function mergedOf(windows) { const out = []; for (const [a, b] of windows) { const l = out.at(-1); if (l && a - l[1] <= GLM.restMs) l[1] = b; else out.push([a, b]); } return out; }
/** 0.667 -> 'draws 2 of every 3 frames (the page skips the others; the canvas holds its last picture)'. */
export function cadenceWords(c) {
  for (const d of [2, 3, 4, 5, 6]) for (let n = 1; n < d; n++) if (Math.abs(c - n / d) <= 0.02) return `draws ${n} of every ${d} frames (the page skips the others; the canvas holds its last picture)`;
  return `draws on ${Math.round(c * 100)} % of its frames (the page skips the others; the canvas holds its last picture)`;
}

// ---------------------------------------------------------------- composite state (recorder row.glb, take.gl.states)
const BF = { 0: 'ZERO', 1: 'ONE', 768: 'SRC_COLOR', 769: 'ONE_MINUS_SRC_COLOR', 770: 'SRC_ALPHA', 771: 'ONE_MINUS_SRC_ALPHA', 772: 'DST_ALPHA', 773: 'ONE_MINUS_DST_ALPHA',
  774: 'DST_COLOR', 775: 'ONE_MINUS_DST_COLOR', 776: 'SRC_ALPHA_SATURATE', 32769: 'CONSTANT_COLOR', 32770: 'ONE_MINUS_CONSTANT_COLOR', 32771: 'CONSTANT_ALPHA', 32772: 'ONE_MINUS_CONSTANT_ALPHA' };
const BE = { 32774: 'ADD', 32778: 'SUBTRACT', 32779: 'REVERSE_SUBTRACT', 32775: 'MIN', 32776: 'MAX' };
const DF = { 512: 'NEVER', 513: 'LESS', 514: 'EQUAL', 515: 'LEQUAL', 516: 'GREATER', 517: 'NOTEQUAL', 518: 'GEQUAL', 519: 'ALWAYS' };
const CULL = { 1028: 'front', 1029: 'back', 1032: 'front and back' };
const nm = (t, v) => t[v] ?? String(v);

/**
 * How a pass composites onto what is under it, from one recorded state: `blend` in words a person reads ('replaces', 'alpha over',
 * 'alpha over (premultiplied)', 'additive over', 'multiplies', 'screen over', 'subtracts from', 'keeps the darker', 'keeps the lighter',
 * 'writes no colour', or 'custom blend' with its factors), `depth` ('no depth test' or 'depth LEQUAL, writes' / 'depth LESS, no write'),
 * `cull` (faces culled), `scissor`, and `factors` (equation and factors by name) whenever blending is on.
 */
export function compositeOf(st) {
  const b = st?.blend, cm = st?.colorMask, d = st?.depth || {};
  const depth = d.test ? `depth ${nm(DF, d.func ?? 513)}, ${d.write ? 'writes' : 'no write'}` : 'no depth test';
  const out = { depth, ...(st?.cull != null ? { cull: nm(CULL, st.cull) } : {}), ...(st?.scissor ? { scissor: true } : {}) };
  if (Array.isArray(cm) && cm.every((x) => !x)) return { blend: 'writes no colour', ...out };
  if (!b) return { blend: 'replaces', ...out };
  const [eq] = b.eq || [32774], [s] = b.src || [1], [t] = b.dst || [0];
  const factors = { equation: (b.eq || [32774]).map((x) => nm(BE, x)).join(' / '), src: (b.src || [1]).map((x) => nm(BF, x)).join(' / '), dst: (b.dst || [0]).map((x) => nm(BF, x)).join(' / ') };
  let blend = 'custom blend';
  if (eq === 32775) blend = 'keeps the darker';
  else if (eq === 32776) blend = 'keeps the lighter';
  else if (eq === 32779 && t === 1) blend = 'subtracts from';
  else if (eq === 32774) {
    if (s === 770 && t === 771) blend = 'alpha over';
    else if (s === 1 && t === 771) blend = 'alpha over (premultiplied)';
    else if ((s === 1 || s === 770) && t === 1) blend = 'additive over';
    else if ((s === 774 && t === 0) || (s === 0 && t === 768)) blend = 'multiplies';
    else if (s === 1 && t === 769) blend = 'screen over';
    else if (s === 1 && t === 0) blend = 'replaces';
    else if (s === 0 && t === 1) blend = 'writes no colour';
  }
  return { blend, ...out, factors };
}

/** One line: how the pass shows over what is under it, e.g. "alpha over p21 on the canvas" or "replaces what target 3 held (first since its clear)". */
function showsLine(c, over, into) {
  const where = !into.length ? 'its target' : into.length > 2 ? `${into.length} targets` : into.map((x) => (x === 'canvas' ? 'the canvas' : x)).join(' and '), under = over.length > 4 ? `${over.slice(0, 3).join(', ')} and ${over.length - 3} more` : over.join(', ');
  const depthNote = over.length && /^depth/.test(c.depth) ? ' (depth-tested: the nearer wins)' : '';
  if (c.blend === 'writes no colour') return `writes no colour into ${where} (${c.depth})`;
  if (c.blend === 'replaces') return over.length ? `replaces ${under} where it draws, on ${where}${depthNote}` : `replaces what ${where} held (first since its clear)`;
  return over.length ? `${c.blend} ${under} on ${where}${depthNote}` : `${c.blend} what ${where} held (first since its clear)`;
}

// ---------------------------------------------------------------- every value the move's programs read (S1 6 Nov: a shader-transition site, uCenter, uColor)
const SYNTH = /\.(position|screen|inView)$/, ARRAY_EL = /^(.*)\[(\d+)\]$/;
const sig7 = (v) => (Array.isArray(v) ? v.map(sig7) : typeof v === 'number' && Number.isFinite(v) ? Number(v.toPrecision(7)) : v);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** `uvTransform[0..2]` (the recorder keeps an array uniform one element per key) back into one array value, elements in order. */
function joinArrays(vals) {
  const out = {}, arrays = new Map();
  for (const [k, v] of Object.entries(vals)) { const m = ARRAY_EL.exec(k); if (m) { (arrays.get(m[1]) || arrays.set(m[1], []).get(m[1]))[+m[2]] = v; } else out[k] = v; }
  for (const [k, list] of arrays) out[k] = Array.from(list, (x) => (x === undefined ? null : x));
  return out;
}
/**
 * Every uniform each program drawn in a move's window reads, with its value: `set` (one value over the frames it drew in the window),
 * `animated` (it changed: from, to and what the spec makes of it), `perDraw` (set once per object; the recorder keeps the last object's),
 * `defaults` (in the program, never set by the page: GL's default, 0 or unit 0), `notRecorded` (past the recorder's caps). A program's
 * value counts only on the frames it drew. Programs with one source and the same values are one entry.
 * @param {object[]} rows  the window's rows (object positions added or not), oldest first
 * @param {{programs?:object[], draws?:Map|null, channels?:object[], kept?:object[], T0:number, Tend:number, counters?:object}} o
 */
export function programValuesOf(rows, { programs = [], draws = null, channels = [], kept = [], T0, Tend, counters = {}, sources = null }) {
  const progIds = draws ? [...draws.keys()] : [...new Set(channels.filter((c) => c.glKey).map((c) => `p${parseKey(c.glKey).prog}`))];
  const inWin = rows.filter((r) => r.T >= T0 - 0.5 && r.T <= Tend);
  const byCh = new Map(); for (const c of channels) if (c.glKey) (byCh.get(c.glKey) || byCh.set(c.glKey, []).get(c.glKey)).push(c);
  const groupOf = new Map(); for (const k of kept) for (const c of [k.lead, ...(k.rest || [])]) if (c?.glKey) groupOf.set(c.glKey, uniformName(k.uniform));
  const dropped = new Set([...(counters.dropped?.keys || []), ...(counters.dropped?.matrices || []), ...(counters.dropped?.arrays || []), ...(counters.dropped?.objects || [])]);
  const out = [];
  for (const p of progIds.sort((a, b) => +a.slice(1) - +b.slice(1))) {
    const pre = `${p}|`, drawn = inWin.filter((r) => !r.gld || !draws || !!r.gld[p]);
    const seen = new Map();   // key -> values over the drawn frames
    const slot = new Set();   // object matrices: one key per object (row.glo `name#n`), so never a per-draw value
    const arrays = new Map(), slots = new Map();   // row.gla: uniform arrays by element; row.gls: per-draw values, one slot per set
    for (const r of drawn) {
      for (const bag of [r.gl, r.glm, r.glo]) for (const [k, v] of Object.entries(bag || {})) {
        if (!k.startsWith(pre)) continue; const name = k.slice(pre.length); if (SYNTH.test(name)) continue;
        if (bag === r.glo) slot.add(name);
        const list = seen.get(name) || seen.set(name, []).get(name); if (!list.length || !same(list.at(-1), v)) list.push(v);
      }
      for (const [k, v] of Object.entries(r.gla || {})) {
        if (!k.startsWith(pre)) continue; const m = ARRAY_EL.exec(k.slice(pre.length)), name = m ? m[1] : k.slice(pre.length);
        const a = arrays.get(name) || arrays.set(name, { el: new Map(), changed: new Set(), frames: new Set(), maxDelta: 0, sameAs: null }).get(name);
        if (!m) { if (typeof v === 'string' && v.startsWith('=')) a.sameAs = v.slice(1).split('|')[0]; continue; }
        const i = +m[2], prev = a.el.get(i);
        if (prev && !same(prev.last, v)) { a.changed.add(i); a.frames.add(r.T); if (Array.isArray(v)) v.forEach((x, j) => { const d = Math.abs(x - prev.last[j]); if (d > a.maxDelta) a.maxDelta = d; }); }
        a.el.set(i, { first: prev ? prev.first : v, last: v });
      }
      for (const [k, v] of Object.entries(r.gls || {})) {
        if (!k.startsWith(pre)) continue; const m = /^(.*)#(\d+)$/.exec(k.slice(pre.length)); if (!m) continue;
        const e = slots.get(m[1]) || slots.set(m[1], { first: [], changes: false, last: [] }).get(m[1]);
        if (e.first[+m[2]] === undefined) e.first[+m[2]] = v; else if (!same(e.last[+m[2]], v)) e.changes = true; e.last[+m[2]] = v;
      }
    }
    const set = {}, animated = {}, perDraw = {};
    for (const [name, vals] of seen) {
      const key = pre + name, base = name.replace(/#\d+$/, ''), multi = (counters.multi || {})[key] || (counters.multi || {})[pre + base.replace(/\[\d+\]$/, '')];
      if (!slot.has(name) && multi && (counters.setFrames || {})[pre + base] && multi > 0.5 * counters.setFrames[pre + base]) { perDraw[name] = { last: sig7(vals.at(-1)), note: 'set once per object each frame; this is the last object\'s' }; continue; }
      if (vals.length === 1) { set[name] = sig7(vals[0]); continue; }
      const cs = byCh.get(key) || [], g = groupOf.get(key), st = cs.find((c) => c.status !== 'motion' && c.status !== 'step')?.status;
      animated[name] = { from: sig7(vals[0]), to: sig7(vals.at(-1)), values: vals.length, as: g ? `group WebGL ${g}` : st ? (st === 'clock' ? 'clock' : GL_LEFT[st] ?? st) : 'changes in the window' };
    }
    for (const [name, sl] of slots) { const e = perDraw[name] || (perDraw[name] = {}); delete e.note; e.slots = sig7(Array.from(sl.first, (x) => (x === undefined ? null : x))); e.changes = sl.changes; e.note = 'one value per draw in drawing order, at the first frame it drew in the window'; }
    const arrOut = {};
    for (const [name, a] of arrays) {
      const n = a.el.size, first = [...a.el.keys()].sort((x, z) => x - z).map((i) => a.el.get(i).first), width = first[0]?.length ?? null;
      arrOut[name] = { elements: n, of: width === 16 ? 'mat4' : width === 9 ? 'mat3' : width ? `${width} floats` : null, ...(a.sameAs ? { sameAs: a.sameAs } : {}), changedElements: a.changed.size, changedFrames: a.frames.size, maxDelta: sig7(a.maxDelta),
        ...(a.changed.size ? { values: 'per frame in the take rows (row.gla)' } : {}), first: sig7(first) };
      if (!a.changed.size && !a.sameAs) { set[name] = sig7(first); delete arrOut[name].first; }
    }
    const meta = programs.find((x) => `p${x.id}` === p), defaults = [], notRecorded = [], ints = meta?.ints || {};
    for (const u of meta?.uniforms || []) {
      const nm = u.name.replace(/\[0\]$/, ''); if (u.type === 'more') { notRecorded.push(`${u.size} more uniforms past the recorder's 160`); continue; }
      const has = (k) => seen.has(k) || arrays.has(k) || slots.has(k) || [...seen.keys()].some((x) => x.startsWith(`${k}[`) || x.startsWith(`${k}#`));
      if (has(nm) || has(u.name)) continue;
      if (nm in ints) { set[nm] = ints[nm]; continue; }
      if (dropped.has(pre + nm) || dropped.has(pre + u.name)) { notRecorded.push(nm); continue; }
      if (/^(i|u)?sampler/.test(u.type)) { if (!meta.ints) notRecorded.push(nm); else defaults.push(nm); continue; }
      // an int or bool is kept once it changes (the recorder's int rule), so one set once is not in an older take
      if (/^(int|ivec|uint|uvec|bool)/.test(u.type) && !meta.ints) { notRecorded.push(nm); continue; }
      if (u.size > 1 && /mat4/.test(u.type)) { notRecorded.push(`${nm}[${u.size}]`); continue; }
      defaults.push(nm);
    }
    const src = sources?.byProgram?.get(p) ?? null;
    out.push({ program: p, ...(src ? { source: src } : {}), set: joinArrays(set), animated: joinArrays(animated), ...(Object.keys(arrOut).length ? { arrays: arrOut } : {}), ...(Object.keys(perDraw).length ? { perDraw } : {}), ...(defaults.length ? { defaults } : {}), ...(notRecorded.length ? { notRecorded } : {}) });
  }
  // one entry for programs that share a source and every value (a fur shell drawn by 16 programs)
  const merged = [];
  for (const e of out) {
    const { program, ...rest } = e, sigE = JSON.stringify(rest), had = merged.find((m) => m.sig === sigE);
    if (had) had.e.programs.push(program); else merged.push({ sig: sigE, e: { programs: [program], ...rest } });
  }
  return merged.map((m) => m.e);
}

/**
 * The shader source of every program drawn in the window, one copy per distinct source (a hash of vertex + fragment): what a rebuild
 * compiles. `truncated` when the recorder kept only its first 200,000 characters.
 * @returns {{list:{hash:string, programs:string[], vs:string|null, fs:string|null, vsLen?:number, fsLen?:number, truncated?:boolean}[], byProgram:Map<string,string>}}
 */
export function programSourcesOf(programIds, programs, hash) {
  const list = [], byHash = new Map(), byProgram = new Map();
  for (const p of programIds) {
    const m = programs.find((x) => `p${x.id}` === p); if (!m || (m.vs == null && m.fs == null)) continue;
    const h = hash(`${m.vs ?? ''}\u0000${m.fs ?? ''}`).slice(0, 16);
    byProgram.set(p, h);
    const had = byHash.get(h); if (had) { had.programs.push(p); continue; }
    const truncated = (m.vsLen && m.vs && m.vsLen > m.vs.length) || (m.fsLen && m.fs && m.fsLen > m.fs.length);
    const e = { hash: h, programs: [p], vs: m.vs ?? null, fs: m.fs ?? null, ...(truncated ? { truncated: true, vsLen: m.vsLen, fsLen: m.fsLen } : {}) };
    byHash.set(h, e); list.push(e);
  }
  return { list, byProgram };
}

/**
 * When the set of programs drawn changes inside the window: one event per frame where a program starts or stops drawing (a stop is
 * after `GLM.restMs` without a draw, so a program drawn every other frame is one stretch). Times are ms since T0.
 * @returns {{atStart:string[], events:{atMs:number, starts:string[], stops:string[]}[]}|null}
 */
export function drawEventsOf(rows, { T0, Tend, max = 24 }) {
  const win = rows.filter((r) => r.gld && r.T >= T0 - GLM.preGapMs && r.T <= Tend); if (!win.length) return null;
  const spans = new Map();
  for (const r of win) for (const p of Object.keys(r.gld)) {
    if (!/^p\d+$/.test(p)) continue; const list = spans.get(p) || spans.set(p, []).get(p), last = list.at(-1);
    if (last && r.T - last[1] <= GLM.restMs) last[1] = r.T; else list.push([r.T, r.T]);
  }
  const ms = (T) => Math.round((T - T0) * 10) / 10, at = new Map(), add = (T, kind, p) => { const k = ms(T); const e = at.get(k) || at.set(k, { atMs: k, starts: [], stops: [] }).get(k); e[kind].push(p); };
  const first = win[0].T, lastT = win.at(-1).T, atStart = [];
  for (const [p, list] of spans) for (const [a, b] of list) {
    if (a <= Math.max(first, T0)) atStart.push(p); else add(a, 'starts', p);
    if (b < lastT - GLM.restMs) add(b + DT_GL, 'stops', p);
  }
  const num = (a, b) => +a.slice(1) - +b.slice(1);
  const events = [...at.values()].sort((a, b) => a.atMs - b.atMs).map((e) => ({ atMs: e.atMs, starts: e.starts.sort(num), stops: e.stops.sort(num) }));
  return { atStart: [...new Set(atStart)].sort(num), events: events.slice(0, max), ...(events.length > max ? { more: events.length - max } : {}) };
}
const DT_GL = 1000 / 60;

/**
 * Where each canvas of the move sits among the page's layers: its element, box and CSS at the move's start (rows), and what the recorder
 * read of its place (take.gl.contexts[].place: position, z-index, transform, opacity, blend mode, pointer events, its stacking parents
 * and the elements painted over it).
 */
export function canvasPlacesOf(gl, row, selectors = [], ctxIds = null) {
  return (gl?.contexts || []).filter((c) => !ctxIds || ctxIds.has(c.id)).map((c) => {
    const v = c.el != null ? row?.v?.[String(c.el)] : null, num = (k) => (v && Number.isFinite(v[k]) ? Math.round(v[k] * 100) / 100 : null);
    const box = v && ['ren:bx', 'ren:by', 'ren:bw', 'ren:bh'].every((k) => Number.isFinite(v[k])) ? ['ren:bx', 'ren:by', 'ren:bw', 'ren:bh'].map(num) : null;
    const live = v ? Object.fromEntries(Object.entries({ opacity: v['ren:opacity'], transform: v['ren:transform'] ?? v['drv:transform'], filter: v['ren:filter'], clipPath: v['ren:clipPath'] }).filter(([, x]) => x != null && x !== 'none')) : {};
    return { ctx: c.id, selector: c.el == null ? null : selectors.find((x) => x[0] === c.el)?.[1] ?? null, offscreen: !!c.offscreen, ...(c.worker ? { worker: true } : {}), buffer: [c.width, c.height], box, ...live, ...(c.place ? { place: c.place } : {}) };
  });
}

/** The engine a program's source names: three.js prefixes every shader it compiles with its own uniforms. Null for raw WebGL. */
export function engineOfSources(list = []) {
  if (list.some((x) => /uniform\s+bool\s+isOrthographic/.test(x.vs || '') && /uniform\s+vec3\s+cameraPosition/.test(x.vs || ''))) return 'three.js';
  if (list.some((x) => /\bBABYLON\b|babylonjs/i.test(`${x.vs}${x.fs}`))) return 'Babylon.js';
  if (list.some((x) => /\bPIXI\b|pixi/i.test(`${x.vs}${x.fs}`))) return 'PixiJS';
  return null;
}
/** "a full-screen WebGL layer (three.js) keeps drawing": the canvas layer of a move when no uniform of it leads. */
export function glLayerClause(layer) {
  if (!layer || !(layer.cover >= GLM.cover)) return null;
  const where = layer.cover >= GLM.full ? 'a full-screen WebGL layer' : `a WebGL layer over ${Math.round(layer.cover * 100)} % of the screen`;
  const what = layer.engine ? ` (${layer.engine})` : '';
  const sw = layer.switchAtMs != null ? ` and switches programs at ${Math.round(layer.switchAtMs / 100) / 10} s` : '';
  return `${where}${what} keeps drawing${sw}`;
}

/**
 * What each program drew in the window (row.glg, take.gl.geometries / buffers): mode, vertex or index count, instances, the attribute
 * layout by name and the buffers it reads (size, content hash, the file it came from when known, whether the take keeps its bytes:
 * series glBuffers, buffers up to 256 KB). Null for a take recorded before geometry was.
 */
const MODE = { 0: 'POINTS', 1: 'LINES', 2: 'LINE_LOOP', 3: 'LINE_STRIP', 4: 'TRIANGLES', 5: 'TRIANGLE_STRIP', 6: 'TRIANGLE_FAN' };
export function geometryOf(rows, gl, { T0, Tend, max = 48 } = {}) {
  if (!gl?.geometries || !rows.some((r) => r.glg)) return null;
  const used = new Map();
  // row.glg names each draw's geometry in draw order: a geometry counts once a frame however often it was drawn
  for (const r of rows) { if (r.T < T0 - 0.5 || r.T > Tend || !r.glg) continue; for (const ids of Object.values(r.glg)) for (const id of new Set(Array.isArray(ids) ? ids : [ids])) if (id) used.set(id, (used.get(id) || 0) + 1); }
  const geo = new Map(gl.geometries.map((g) => [g.id, g])), bufs = new Map((gl.buffers || []).map((b) => [b.id, b]));
  const buf = (id) => { const b = bufs.get(id); return b ? { buffer: id, bytes: b.size, hash: b.hash, ...(b.url ? { url: b.url } : {}), kept: !!b.kept, ...(b.updates ? { updates: b.updates } : {}) } : { buffer: id }; };
  const list = [...used].sort((a, b) => a[0] - b[0]).map(([id, frames]) => { const g = geo.get(id); if (!g) return null;
    return { id, program: g.program, mode: MODE[g.mode] ?? g.mode, count: g.count, ...(g.first ? { first: g.first } : {}), instances: g.instances, frames, ...(g.indexType ? { index: { type: g.indexType, offset: g.indexOffset, ...buf(g.indexBuffer) } } : {}),
      attribs: g.attribs.map((a) => (a.constant ? { name: a.name, glslType: a.glslType, constant: true } : { name: a.name, glslType: a.glslType, size: a.size, type: a.type, normalized: a.normalized, stride: a.stride, offset: a.offset, ...(a.divisor ? { divisor: a.divisor } : {}), ...buf(a.buffer) })) }; }).filter(Boolean);
  return { list: list.slice(0, max), ...(list.length > max ? { more: list.length - max } : {}) };
}

/**
 * Rows with a worker's WebGL in them (series glWorker, workergl.js): a worker row is one frame of that worker on the page's frame keys,
 * with the uniforms that changed and its draws; its values are held from row to row like the page's, and its draws count on its frame.
 * Program and target ids of a worker start at 1001, 2001, ..., so they never meet the page's. Rows without workers come back as they were.
 */
export function withWorkerRows(rows, wrows = []) {
  if (!wrows?.length) return rows;
  const by = new Map(); for (const r of wrows) (by.get(r.w) || by.set(r.w, []).get(r.w)).push(r);
  const lanes = [...by.values()].map((list) => ({ list: list.sort((a, b) => a.k - b.k), i: 0, held: {} }));
  return rows.map((r) => {
    let gl = null, gld = null;
    for (const L of lanes) {
      while (L.i < L.list.length && L.list[L.i].k < r.k) { Object.assign(L.held, L.list[L.i].gl || {}); L.i++; }
      const x = L.i < L.list.length && L.list[L.i].k === r.k && Math.abs(L.list[L.i].T - r.T) < 0.5 ? L.list[L.i] : null;
      if (x) { Object.assign(L.held, x.gl || {}); gld = { ...(gld || {}), ...(x.gld || {}) }; }
      if (Object.keys(L.held).length) gl = { ...(gl || {}), ...L.held };
    }
    return gl || gld ? { ...r, ...(gl ? { gl: { ...(r.gl || {}), ...gl } } : {}), ...(gld ? { gld: { ...(r.gld || {}), ...gld } } : {}) } : r;
  });
}
