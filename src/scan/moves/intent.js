// What a group of runs means to a person: the channels of a run read back from rows, their values as a designer would have written
// them, and the sentence the card opens with (DESIGN 2.7, 4.3). Pure: rows in, plain objects out. `raw` always keeps what was recorded,
// so an intent value never hides the measurement. Page words reach here as group names only, and stay data.
import { axisParts, clipParts, colorParts, numOf, positionParts, rotateDeg } from '../../analysis/fit/series.js';
import { rdpVertical, round } from '../../export/curves.js';
import { familyOf, FIT } from './contract.js';
import { GLM, glLayerClause, glLeads, isGlGroup } from './glmove.js';
import { subjectOfGroup } from './name.js';

// ---------------------------------------------------------------- channels as numbers
const BOX_FAMILY = { 'ren:bw': 'box', 'ren:bh': 'box', 'ren:bx': 'move', 'ren:by': 'move' };
const COLOUR = /^ren:(color|bg|fill|stroke)$/, POSITION = /^ren:(bgPos|maskPos)$/;
/** Numbers of one recorded value by part; a single number has the part ''. Null when the value holds none. */
export function partsOfValue(ch, v) {
  if (typeof v === 'number') return Number.isFinite(v) ? { '': v } : null;
  if (typeof v !== 'string') return null;
  if (COLOUR.test(ch)) return colorParts(v);
  if (ch === 'ren:clipPath') return clipParts(v);
  if (POSITION.test(ch)) { const p = positionParts(v); return p ? { x: p.x, y: p.y } : null; }
  if (ch === 'ren:translate') return v.trim() === 'none' ? { x: 0, y: 0, z: 0 } : axisParts(ch, v);
  if (ch === 'ren:scale') return v.trim() === 'none' ? { x: 1, y: 1, z: 1 } : axisParts(ch, v);
  if (ch === 'ren:rotate') { const d = rotateDeg(v); return d == null ? null : { '': d }; }
  const n = numOf(v);
  return n == null ? null : { '': n };
}

/**
 * Every own channel of one element inside a window, as one track per recorded channel.
 * A track follows the part that travels furthest, so a wipe on the bottom side of a clip-path reads as that side.
 * @param {object[]} rows  decoded rows, oldest first
 * @param {number|string} el
 * @param {{T0:number, T1:number}} win
 * @param {{box?:boolean}} [o]  box: a run with no own channel, its box written by a style change: the box is the motion
 * @returns {{channel:string, family:string, part:string, T:number[], y:number[], sy:number[], raw:any[], amp:number}[]} widest first
 */
export function readTracks(rows, el, { T0, T1 }, { box = false } = {}) {
  const id = String(el), byCh = new Map();
  for (const r of rows) {
    if (r.T < T0 || r.T > T1) continue;
    const v = r.v && r.v[id]; if (!v) continue;
    for (const ch of Object.keys(v)) {
      const family = familyOf(ch) ?? (box && BOX_FAMILY[ch]); if (!family) continue;
      const parts = partsOfValue(ch, ch === 'ren:by' ? v[ch] + (r.sy ?? 0) : v[ch]); if (!parts) continue;
      let t = byCh.get(ch); if (!t) byCh.set(ch, (t = { channel: ch, family, T: [], sy: [], raw: [], parts: {} }));
      t.T.push(r.T); t.sy.push(r.sy ?? 0); t.raw.push(v[ch]);
      for (const p of Object.keys(parts)) { if (typeof parts[p] === 'number') (t.parts[p] ||= []).push(parts[p]); }
    }
  }
  const out = [];
  for (const t of byCh.values()) {
    // a box read for its motion counts from where it stood, never from the top of the page
    if (BOX_FAMILY[t.channel] === 'move') { const a = t.parts[''][0]; t.parts[''] = t.parts[''].map((y) => y - a); t.raw = t.raw.map((v, i) => t.parts[''][i]); }
    let part = null, amp = 0;
    for (const [p, ys] of Object.entries(t.parts)) { if (ys.length !== t.T.length) continue; const a = Math.max(...ys) - Math.min(...ys); if (a > amp) { amp = a; part = p; } }
    if (part == null || !(amp > 0)) continue;
    out.push({ channel: t.channel, family: t.family, part, T: t.T, y: t.parts[part], sy: t.sy, raw: t.raw, amp });
  }
  return out.sort((a, b) => b.amp - a.amp);
}

// ---------------------------------------------------------------- values as written
const PROPERTY = { 'ren:bw': 'width', 'ren:bh': 'height', 'ren:bx': 'x', 'ren:by': 'y', 'ren:tx': 'x', 'ren:ty': 'y', 'ren:sx': 'scaleX', 'ren:sy': 'scaleY', 'ren:rz': 'rotate', 'ren:skx': 'skewX', 'ren:opacity': 'opacity', 'ren:color': 'color', 'ren:bg': 'backgroundColor', 'ren:fill': 'fill', 'ren:stroke': 'stroke', 'ren:clipPath': 'clipPath', 'ren:maskPos': 'maskPosition', 'ren:filter': 'filter', 'ren:bgPos': 'backgroundPosition', 'ren:wght': 'fontWeight', 'ren:wdth': 'fontStretch', 'ren:radius': 'borderRadius', 'ren:dash': 'strokeDashoffset', 'ren:translate': 'translate', 'ren:scale': 'scale', 'ren:rotate': 'rotate', 'ren:text': 'text', 'ren:chars': 'text' };
const propertyOf = (ch) => PROPERTY[ch] || ch.replace(/^ren:/, '');
const unitOf = (ch, family) => (family === 'move' || family === 'radius' || family === 'dash' || family === 'box' ? 'px' : family === 'rotate' ? 'deg' : '');
const TEXTY = new Set(['colour', 'clip', 'filter', 'bgpos', 'text']);
/** A travel past this share of its own box is no designer's percent (a 1 px link that rises 17.5 px read as 1747 %): it stays px. */
const PERCENT_MAX = 200;
/** A track whose ends are closer than this share of its range went out and came back. */
const OUT_BACK = 0.25;
/** Below these a change is not seen on the screen: 5 % of opacity, 1 % of scale, half a degree, 1 px. */
export const SEEN = Object.freeze({ opacity: 0.05, scalePct: 1, deg: 0.5, px: 1 });

/**
 * The value someone probably typed, when the recording allows it: the nearest round number, within 1 % of the travel.
 * A travel of 0.2 keeps three decimals, so a small move is never rounded away. Declared values are exact and skip this.
 */
export function snap(v, travel) {
  const tol = Math.abs(travel) * 0.01;
  for (const step of [100, 10, 5, 1, 0.5, 0.1, 0.05, 0.01, 0.005, 0.001]) { const s = Math.round(v / step) * step; if (Math.abs(s - v) <= tol) return round(s, 3); }
  return round(v, 3);
}
/** A travel that is a round share of the element's own size, so the code stays true at any size: 72.9 px on a 72.9 px line is 100 %. */
export function percentOfBox(travel, size) {
  if (!(size > 0)) return null;
  const pct = (travel / size) * 100, s = Math.round(pct / 5) * 5;
  return s !== 0 && Math.abs(pct - s) <= Math.max(0.5, Math.abs(pct) * 0.01) ? s : null;
}

/**
 * A declared value as the site wrote it. The first recorded frame is already a little way into the tween (9.9931 px of a 10 px
 * rise, opacity 0.1087 one frame into a 250 ms ease-out), so the caller passes the ends the declared curve extrapolates to, and this
 * keeps the coarsest round number within 0.5 % of the travel: 10, not 9.9931 (6 Nov review).
 */
export function tidyDeclared(v, travel) {
  if (!Number.isFinite(v)) return v;
  const tol = Math.max(Math.abs(travel) * 0.005, 1e-3);
  for (const d of [0, 1, 2]) { const r = round(v, d); if (Math.abs(r - v) <= tol) return r; }
  return round(v, 4);
}
/** The numbers inside a declared value's text, tidied the same way: blur(9.99338px) is blur(10px). */
export const tidyDeclaredText = (s) => (typeof s !== 'string' ? s : s.replace(/-?\d*\.\d+|-?\d+/g, (x) => { const v = +x; return String(tidyDeclared(v, Math.max(1, Math.abs(v)))); }));
/** A value with at most two decimals, to a hair: what a person types. */
export const isRound = (v) => Number.isFinite(v) && Math.abs(v * 100 - Math.round(v * 100)) < 1e-3;
/** The ends a declared curve extrapolates to, used only when they sit near what was recorded (within a quarter of the travel). */
function declaredEnds(t, a, b) {
  const e = t.ends, travel = Math.abs(b - a) || t.amp || 0;
  if (!e || !Number.isFinite(e.from) || !Number.isFinite(e.to)) return [a, b];
  // a recorded end that is already a round number (1, 0.45) is the value itself, sampled at rest: the extrapolation only corrects one
  // that the first frame caught part way (9.9931); a fit's own ends can be off by a little and would turn 1 into 0.995
  const near = (x, y) => Math.abs(x - y) <= 0.25 * travel, use = (x, y) => !isRound(y) && near(x, y);
  let from = use(e.from, a) ? e.from : a, to = use(e.to, b) ? e.to : b;
  if (t.family === 'fade') { from = Math.min(1, Math.max(0, from)); to = Math.min(1, Math.max(0, to)); }
  return [from, to];
}

const rawAt = (t, i) => t.raw[i];
/** One change: what a track did, from its first frame to its last. `box` is [x, y, w, h] at onset. */
export function changeOf(t, { box = null, exact = false } = {}) {
  const n = t.T.length, a = t.y[0], b = t.y[n - 1], travel = b - a, range = t.amp;
  const unit = unitOf(t.channel, t.family), property = propertyOf(t.channel);
  const out = { property, channel: t.channel, family: t.family, unit };
  if (TEXTY.has(t.family)) {
    out.raw = { from: rawAt(t, 0), to: rawAt(t, n - 1) };
    out.from = exact ? tidyDeclaredText(out.raw.from) : out.raw.from; out.to = exact ? tidyDeclaredText(out.raw.to) : out.raw.to;
    if (out.from === out.to && range > 0) out.back = true;   // went somewhere and came back: a hover colour, a scramble that settles
    return out;
  }
  const within = Math.abs(travel) || range;   // a track that goes out and back must not round its ends by the width of the trip
  const [da, db] = exact ? declaredEnds(t, a, b) : [a, b];
  out.from = exact ? tidyDeclared(da, within) : snap(a, within); out.to = exact ? tidyDeclared(db, within) : snap(b, within);
  out.raw = { from: round(a, 4), to: round(b, 4) };
  // the declared curve's own ends, before rounding: what the code's value error is measured against (raw is the first recorded frame)
  if (exact && (da !== a || db !== b)) out.ends = { from: round(da, 4), to: round(db, 4) };
  // out and back: it ends near where it began but went somewhere on the way; the furthest point is what a person sees
  if (range > 0 && Math.abs(travel) < OUT_BACK * range) { const far = t.y.reduce((m, y) => (Math.abs(y - a) > Math.abs(m - a) ? y : m), a); out.peak = exact ? tidyDeclared(far, range) : snap(far, range); }
  if (t.family === 'move' && box) {
    // a declared tween's percent is read from its own ends, not the first frame (16 px of a 285 px box is not 5 %)
    const [pa, pb] = exact ? [da, db] : [a, b];
    const size = property === 'y' ? box[3] : box[2], rest = Math.abs(pb) < Math.abs(pa) ? pb : pa, pct = percentOfBox(pb - pa, size);
    if (pct != null && Math.abs(pct) <= PERCENT_MAX && Math.abs(rest) < 0.5) { out.percent = { from: Math.abs(pa) < 0.5 ? 0 : Math.round((pa / size) * 100), to: Math.abs(pb) < 0.5 ? 0 : Math.round((pb / size) * 100) }; }
  }
  return out;
}

/**
 * What the card may state as travel and time (ZD, 11 Nov). A part is measured when its values were checked against the recorded frames:
 * a law fitted to them, or one the site declares and a fit confirms. A part recorded frame by frame (sampled), an instant step and a
 * part with no law are not: their two ends may hold a jump (a carousel re-layout, a ticker reset, a layout shift) the card cannot tell
 * from travel. Their numbers stay in the details, marked as recorded; the headline says only what changes. A group with no provenance
 * (built by hand, before the fit) is not judged here.
 */
export const isMeasured = (g) => !!g?.law && g.provenance !== 'sampled' && g.provenance !== 'seen' && g.law.class !== 'steps';
/**
 * A jump, not travel (ZC truth.mjs): a track whose recorded samples cannot show it travelling. Fewer than 3 samples, or one gap between
 * two neighbouring samples holds over half of the track's whole range.
 */
export const JUMP = Object.freeze({ minSamples: 3, share: 0.5 });
/** @returns {{n:number, share:number, gapMs:number|null, at:number, side:'out'|'back', jump:boolean}} the largest one-gap step as a share of the range */
export function travelOf(T, y) {
  const n = y?.length ?? 0, range = n ? Math.max(...y) - Math.min(...y) : 0;
  if (!(range > 0)) return { n, share: 0, gapMs: null, at: 0, side: 'out', jump: false };
  let worst = 0, at = 0;
  for (let i = 1; i < n; i++) { const d = Math.abs(y[i] - y[i - 1]); if (d > worst) { worst = d; at = i; } }
  // which leg the step is: 'out' leaves the start (it jumps away, then glides back), 'back' returns to it (a marquee's reset)
  const side = at && Math.abs(y[at] - y[0]) < Math.abs(y[at - 1] - y[0]) ? 'back' : 'out';
  return { n, share: round(worst / range, 3), gapMs: at ? round(T[at] - T[at - 1], 1) : null, at, side, jump: n < JUMP.minSamples || worst / range > JUMP.share };
}
/**
 * The samples show the track moving: no jump, or, with one, the other leg glides over at least half the range on 3 or more samples
 * (a FLIP jumps out and glides back; a drift glides out and its reset jumps back).
 */
export function travels(T, y) {
  const v = travelOf(T, y);
  if (!v.jump) return v.share > 0;
  if (!v.at) return false;
  const [t, w] = v.side === 'out' ? [T.slice(v.at), y.slice(v.at)] : [T.slice(0, v.at), y.slice(0, v.at)];
  const l = travelOf(t, w), range = Math.max(...y) - Math.min(...y), legRange = w.length ? Math.max(...w) - Math.min(...w) : 0;
  return !l.jump && l.n >= JUMP.minSamples && legRange * 2 >= range;
}
/**
 * The time a move shows (ZD): of its first measured part. With none, the recording's window, unless no change in it travels (the law
 * says stretched: the window belongs to a jump); then no time. Null for no part with a law.
 * @returns {{g:object, ms:number|null, measured:boolean, withheld:boolean}|null}
 */
export function spanOf(groups) {
  const dom = (groups || []).filter((g) => g?.law && !isGlGroup(g) && !g.state);
  const m = dom.find(isMeasured);
  if (m) return { g: m, ms: m.law.class === 'map' ? null : m.law.ms ?? null, measured: true, withheld: false };
  const g = dom[0]; if (!g) return null;
  return g.law.stretched ? { g, ms: null, measured: false, withheld: true } : { g, ms: g.law.class === 'map' ? null : g.law.ms ?? null, measured: false, withheld: false };
}
/** Changes of a group, scale x and y of one size read as one scale. */
export function changesOf(tracks, opts = {}) {
  const list = tracks.map((t) => ({ ...changeOf(t, opts), follows: t.follows !== false }));
  const sx = list.find((c) => c.property === 'scaleX'), sy = list.find((c) => c.property === 'scaleY');
  if (sx && sy && sx.from === sy.from && sx.to === sy.to && sx.follows === sy.follows) return [...list.filter((c) => c !== sx && c !== sy), { ...sx, property: 'scale', channels: [sx.channel, sy.channel] }];
  return list;
}

/** At most `max` of `pts` ({x, y}, ends kept): each next one the frame furthest from the line between the keys around it. */
function worstFirst(pts, max) {
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const worstIn = (i0, i1) => {
    const a = pts[i0], b = pts[i1]; let d = -1, at = -1;
    for (let i = i0 + 1; i < i1; i++) { const p = pts[i], y = a.y + ((b.y - a.y) * (p.x - a.x)) / (b.x - a.x || 1), e = Math.abs(p.y - y); if (e > d) { d = e; at = i; } }
    return { d, at, i0, i1 };
  };
  const segs = [worstIn(0, pts.length - 1)];
  for (let n = 2; n < max; n++) {
    let k = -1;
    for (let s = 0; s < segs.length; s++) if (segs[s].at >= 0 && (k < 0 || segs[s].d > segs[k].d)) k = s;
    if (k < 0 || segs[k].d <= 0) break;
    const { at, i0, i1 } = segs[k]; keep[at] = 1;
    segs.splice(k, 1, worstIn(i0, at), worstIn(at, i1));
  }
  return pts.filter((_, i) => keep[i]);
}

/** The stops of a recorded curve: at most `max` points, within `share` of the range (DESIGN 4.3). [[ms since start, value]] */
export function reduceTrack(xs, ys, { max = FIT.keyframesMax, share = FIT.keyframesShare } = {}) {
  const pts = xs.map((x, i) => ({ x, y: ys[i] })), range = (Math.max(...ys) - Math.min(...ys)) || 1;
  let kept = rdpVertical(pts, range * share);
  // over the cap: the worst frame joins the keys, one at a time, until the cap. Growing the tolerance instead jumped from 25 keys to 2
  // on a jagged track (a 13 s equaliser bar) and replayed it as one straight line
  if (kept.length > max) kept = worstFirst(pts, max);
  // the error the replayed keys really make, every recorded frame against the straight line between its two keys (the code plays them
  // linear). It used to be the search's tolerance: 1 % × 1.3 per try, a bound and not a measure (66.54 % = 1.3^16 on two sites, 11 Nov)
  let worst = 0, j = 0;
  for (const p of pts) {
    while (j < kept.length - 2 && kept[j + 1].x < p.x) j++;
    const a = kept[j], b = kept[Math.min(j + 1, kept.length - 1)], y = b.x > a.x ? a.y + ((b.y - a.y) * (p.x - a.x)) / (b.x - a.x) : a.y;
    worst = Math.max(worst, Math.abs(p.y - y));
  }
  return { keys: kept.map((p) => [round(p.x, 1), round(p.y, 4)]), errorPct: round((worst / range) * 100, 2) };
}

// ---------------------------------------------------------------- words
const PLAIN = (s) => String(s || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
const num = (x) => String(round(Math.abs(x), 1));
const VAR_NAME = /^--[A-Za-z0-9_-]{1,40}$/;
/** Past this growth a scale is said by its two sizes, not as a share (11 Nov, U4: 420 % to 1800 % on two sites). */
const SCALE_SAID_PCT = 300;
/**
 * "drops 138 px, slides left 122 px and scales down 75 %, then returns": when every clause of one subject goes and comes back, the
 * return is said once (11 Nov, U4: "and back, … and back and … and back" chains); with two or more that come back, those lead and the rest follow.
 */
export function backOnce(clauses, { many = false } = {}) {
  const backs = clauses.filter((c) => / and back$/.test(c)), rest = clauses.filter((c) => !/ and back$/.test(c));
  if (backs.length < 2) return null;
  const list = (l) => (l.length < 2 ? l[0] : `${l.slice(0, -1).join(', ')} and ${l.at(-1)}`);
  // the ones that come back first, the return said once, then what stays: "rises 58 px and slides right 27 px, then returns, and rounds"
  return `${list(backs.map((c) => c.replace(/ and back$/, '')))}, then return${many ? '' : 's'}${rest.length ? `, and ${list(rest)}` : ''}`;
}
/** ", 0.6 s" after a sentence; under half a frame it is no time a person sees ("0 s" on 11 moves, 11 Nov): "at once". */
export const spanWords = (ms) => (ms < 8.5 ? ', at once' : `, ${seconds(ms)}`);
/**
 * One clause for one change: "scales up 6 %", "fades in". Null when nothing visible can be said: a change under what the eye sees (SEEN),
 * or a channel with no family. `screen`: the group's motion on the screen when its own transform says otherwise (group.js screenOf).
 */
export function clauseOf(c, { many = false, screen = null, bare = false } = {}) {
  const s = many ? '' : 's', { property: p, from, to } = c, family = c.family ?? (c.channel ? familyOf(c.channel) : null);
  const nums = typeof from === 'number' && typeof to === 'number', back = nums && Number.isFinite(c.peak) ? c.peak : null;
  const end = back ?? to, up = end > from, and = back != null ? ' and back' : '';
  const px = nums ? Math.abs(end - from) : null;
  switch (family) {
    case 'move': {
      const axis = p === 'y' || (p === 'translate' && c.part === 'y') ? 'y' : 'x';
      if (screen && screen.axis === axis && Math.abs(screen.px) >= SEEN.px) {
        const d = screen.px > 0, n = bare ? '' : ` ${num(screen.px)} px`;
        if (screen.counter) return `wipe${s} ${axis === 'x' ? (d ? 'right' : 'left') : d ? 'down' : 'up'}${n}`;
        return axis === 'x' ? `slide${s} ${d ? 'right' : 'left'}${n}` : `${d ? 'drop' : 'rise'}${s}${n}`;
      }
      if (px != null && px < SEEN.px && !c.percent) return null;
      const size = bare ? '' : c.percent && back == null ? ` ${Math.abs(c.percent.to - c.percent.from)} %` : ` ${num(px ?? 0)} px`;
      return axis === 'x' ? `slide${s} ${up ? 'right' : 'left'}${size}${and}` : `${up ? 'drop' : 'rise'}${s}${size}${and}`;
    }
    case 'scale': {
      if (!nums) return null;
      // a sign change is a flip, not a size change (scaleY 1 -> -1 read as "scales down 200 %", 11 Nov)
      if ((from > 0 && end < 0) || (from < 0 && end > 0)) return `flip${s}${and}`;
      if (!(from > 0)) return end > from ? `scale${s} up${and}` : null;
      const pct = round((Math.abs(end - from) / from) * 100, 0);
      if (pct < SEEN.scalePct) return null;
      if (bare) return `scale${s} ${up ? 'up' : 'down'}${and}`;
      // from a small start a share reads as broken ("scales up 1800 %", a line at scale 0.05): past 3 times its size, the two sizes
      return pct > SCALE_SAID_PCT ? `scale${s} ${up ? 'up' : 'down'} from ${value(from)} to ${value(end)}${and}` : `scale${s} ${up ? 'up' : 'down'} ${pct} %${and}`;
    }
    case 'rotate': return px != null && px < SEEN.deg ? null : bare ? `turn${s}${and}` : `turn${s} ${num(px ?? 0)}°${and}`;
    case 'fade': {
      if (!nums || px < SEEN.opacity) return null;
      if (back != null) return from > 0.5 && back < 0.05 ? `fade${s} out and back in` : from < 0.05 && back > 0.5 ? `flash${many ? '' : 'es'} in and out` : bare ? `fade${s} and back` : `fade${s} to ${round(back * 100, 0)} % and back`;
      return from < 0.05 && to > 0.5 ? `fade${s} in` : from > 0.5 && to < 0.05 ? `fade${s} out` : bare ? `fade${s}` : `fade${s} from ${round(from * 100, 0)} % to ${round(to * 100, 0)} %`;
    }
    case 'colour': return from === to && !c.back ? null : `change${s} colour${c.back ? ' and back' : ''}`;
    case 'clip': return from === to && !c.back ? null : `wipe${s}`;
    case 'filter': return from === to && !c.back ? null : /blur/.test(String(from)) || /blur/.test(String(to)) ? `blur${s}` : `shift${s} tone`;
    case 'bgpos': return from === to && !c.back ? null : `pan${s}`;
    case 'font': return px != null && px < SEEN.px ? null : nums ? `change${s} weight ${value(from)} → ${value(to)}` : `change${s} weight`;
    case 'radius': return px != null && px < SEEN.px ? null : `round${s}`;
    case 'box': return px != null && px < SEEN.px ? null : `resize${s}`;
    case 'dash': return px != null && px < SEEN.px ? null : `draw${s}`;
    case 'text': {
      if (nums) return from === to ? null : `count${s} ${up ? 'up' : 'down'} ${value(from)} → ${value(to)}`;
      const a = String(from ?? ''), b = String(to ?? '');
      if (a === b) return c.back ? `scramble${s} its letters and settle${s}` : null;
      return b.startsWith(a) ? `type${s} on` : a.startsWith(b) ? `type${s} off` : a.length === b.length ? `scramble${s} its letters` : `swap${s} its text`;
    }
    case 'var': {
      const name = String(c.property || c.channel || '').replace(/^ren:/, '');
      if (!nums || px === 0) return null;
      return `run${s} ${VAR_NAME.test(name) ? name : 'a CSS variable'} ${value(from)} → ${value(end)}${and}`;
    }
    default: return null;
  }
}

const OPENERS = { load: 'On load', gate: 'As the intro plays', scroll: 'As you scroll', 'scroll-up': 'Scrolling back up', touch: 'On hover', open: 'When it opens', change: 'Between pages', ambient: 'All the time', cursor: 'With the pointer', scene: 'All the time', media: 'All the time', 'page-scroll': 'As the page scrolls' };
const PART_WORD = { hover: 'On hover', press: 'On press', focus: 'On focus', click: 'On click', out: 'On leave' };

/** "the image scales up 6 % and fades in" */
function groupClause(g, { lone }) {
  const many = (g.count || 1) > 1;
  // a counted plural or one named element: "20 letters of the heading blur", "3 elements fade in", never "the block, bottom lefts"
  const subject = lone && !many ? 'it' : PLAIN(subjectOfGroup(g));
  const clauses = (g.changes || []).map((c) => clauseOf(c, { many, screen: g.screen, bare: !isMeasured(g) && !!g.provenance })).filter(Boolean).filter((x, i, l) => l.indexOf(x) === i).slice(0, 2);
  return clauses.length ? `${subject} ${backOnce(clauses, { many }) ?? clauses.join(' and ')}` : null;
}
const seconds = (ms) => `${round(ms / 1000, ms >= 10000 ? 0 : ms < 1000 ? 2 : 1)} s`;
const value = (v) => (typeof v === 'number' ? String(round(v, Math.abs(v) >= 10 ? 1 : 3)) : PLAIN(v));
/** "a full-screen WebGL layer (a noise function, 2 textures) runs u_progress 0 → 1 over 2.4 s, expo.inOut": its technique from the shader source. */
function glClause(g) {
  const c = g.changes[0], cover = g.gl?.cover ?? 0, law = g.law || {};
  const where = cover >= GLM.full ? 'a full-screen WebGL layer' : `a WebGL layer over ${Math.round(cover * 100)} % of the screen`;
  const how = g.gl?.technique ? ` (${PLAIN(g.gl.technique)})` : '';
  const ease = law.class === 'tween' ? law.named ?? law.declared ?? null : law.class === 'spring' ? 'a spring' : law.class === 'keyframes' ? 'as recorded' : null;
  const span = Number.isFinite(law.ms) && law.ms >= 8.5 ? ` over ${seconds(law.ms)}` : '';
  return `${where}${how} runs ${PLAIN(c.property)} ${value(c.from)} → ${value(c.to)}${span}${ease ? `, ${ease}` : ''}`;
}

/**
 * One line, at most two clauses, technique when known (DESIGN 2.7). A touch move with a press or focus part says so.
 * @param {{kind:string, trigger?:object, technique?:string|null}} move
 * @param {{name:string, count?:number, changes:object[], law?:object, part?:string}[]} groups  in rank order
 */
export function sentenceOf(move, groups) {
  const kind = move.kind, all = (groups || []).filter((g) => (g.changes || []).length);
  const first = move.trigger?.kind && kind === 'touch' ? PART_WORD[move.trigger.kind] ?? OPENERS.touch : OPENERS[kind];
  // the largest visible layer first: a WebGL pass over most of the screen leads, the DOM follows in one clause. A new page's state,
  // set at once, is no motion and never leads; a WebGL layer that does not lead stays in the spec, out of the line.
  const list = all.filter((g) => !isGlGroup(g) && !g.state);
  if (all[0] && glLeads(all[0])) {
    // the time of the DOM rest: the move's first measured page part (ZD), not the first page part
    const dom = list[0], ms = dom ? spanOf(list)?.ms : null, rest = dom ? groupClause(dom, { lone: false }) : null;
    return `${first} ${glClause(all[0])}${rest ? `; ${rest}${Number.isFinite(ms) && ms > 0 ? spanWords(ms) : ''}` : ''}.`;
  }
  if (!list.length) return null;
  if (kind === 'cursor') { const ms = list.find((g) => g.law?.ms > 0 && (isMeasured(g) || !g.provenance))?.law.ms; return `It follows the pointer${ms ? ` and catches up in ${seconds(ms)}` : ''}.`; }
  const parts = kind === 'touch' ? [...new Set(list.map((g) => g.part).filter((p) => p && p !== 'out'))] : [];
  const layer = glLayerClause(move.glLayer);
  if (parts.length > 1) {
    const say = parts.slice(0, 2).map((p, i) => { const c = groupClause(list.find((g) => g.part === p), { lone: true }); return c && `${i ? PART_WORD[p]?.toLowerCase() ?? `on ${p}` : PART_WORD[p] ?? first} ${c}`; }).filter(Boolean);
    // the largest visible layer, a canvas no uniform of which leads, first (a skinned-mesh WebGL site: "Over a full-screen WebGL layer that keeps drawing, ...")
    if (say.length) return layer ? `Over ${layer.replace(/ keeps drawing/, ' that keeps drawing')}: ${say.join('; ').replace(/^./, (c) => c.toLowerCase())}.` : `${say.join('; ')}.`;
  }
  const top = list.filter((g, i) => list.findIndex((x) => PLAIN(x.name) === PLAIN(g.name)) === i).slice(0, 2), lone = top.length === 1;
  const clauses = top.map((g) => groupClause(g, { lone })).filter(Boolean);
  if (!clauses.length) return null;
  // the time: of the move's first measured part (ZD), in rank order, said or not; else the window, when no jump stretches it
  const span = spanOf(groups), law = span?.g.law ?? top[0].law, ms = span ? span.ms : law?.class === 'map' ? null : law?.ms;
  const when = law?.class === 'map' ? ', tied to scroll' : Number.isFinite(ms) && ms > 0 ? spanWords(ms) : '';
  const how = move.technique ? ` (${PLAIN(move.technique)})` : '';
  // the largest visible layer is a canvas no uniform of which leads (a skinned-mesh WebGL site: a full-screen three.js scene under the DOM): said first
  if (layer) return `${first} ${layer}; ${clauses.join(' and ')}${how}${when}.`;
  // a clause that starts with a count reads after a comma: "On load, 20 letters of the heading blur", not "On load 20 letters"
  return `${first}${/^\d/.test(clauses[0]) ? ',' : ''} ${clauses.join(' and ')}${how}${when}.`;
}

/** Why a move is no motion a person sees, or null when something visible moves (or REVA cannot tell: then it is never hidden). */
export const NOT_A_MOVE = Object.freeze({
  state: "only a new page's state, set at once: nothing moves",
  unseen: 'nothing visible moves: every change is under what the eye sees',
  placement: 'only an instant jump into place or the drift of something that is always moving: no motion of its own',
});
/**
 * A move is not a move when every group it says is a new page's state, or changes nothing a person can see (clauseOf is null for each
 * change). A WebGL layer, or a group with no values at all, is a motion REVA could not judge from the DOM, so the move stays.
 * @returns {string|null} the reason, one of NOT_A_MOVE
 */
export function notAMove(groups) {
  const live = (groups || []).filter((g) => g.part !== 'out' && g.part !== 'close');
  if (!live.length) return null;
  for (const g of live) {
    if (isGlGroup(g) || !(g.changes || []).length) return null;
    if (!g.state && g.changes.some((c) => clauseOf(c, { screen: g.screen }) != null)) return null;
  }
  return live.every((g) => g.state) ? NOT_A_MOVE.state : NOT_A_MOVE.unseen;
}

/** "Image scale 1 to 1.06. Label rises 12 px, fades in." */
export function changesWords(groups, { lone = false } = {}) {
  const say = (c) => {
    if (typeof c.from === 'number' && typeof c.to === 'number' && c.family === 'scale') return `scale ${c.from} to ${c.to}`;
    if (typeof c.from === 'number' && typeof c.to === 'number' && c.family === 'rotate') return `rotation ${c.from}° to ${c.to}°`;
    return clauseOf(c, { many: false });
  };
  return (groups || []).filter((g) => (g.changes || []).length).slice(0, 3).map((g) => {
    const t = g.changes.map(say).filter(Boolean).slice(0, 2).join(', ');
    return lone ? `${t[0]?.toUpperCase() ?? ''}${t.slice(1)}.` : `${PLAIN(g.name)} ${t}.`;
  }).join(' ');
}
