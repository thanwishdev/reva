// What a group of runs means to a person: the channels of a run read back from rows, their values as a designer would have written
// them, and the sentence the card opens with (DESIGN 2.7, 4.3). Pure: rows in, plain objects out. `raw` always keeps what was recorded,
// so an intent value never hides the measurement. Page words reach here as group names only, and stay data.
import { axisParts, clipParts, colorParts, numOf, positionParts, rotateDeg } from '../../analysis/fit/series.js';
import { rdpVertical, round } from '../../export/curves.js';
import { familyOf, FIT } from './contract.js';
import { GLM, glLayerClause, glLeads, isGlGroup } from './glmove.js';

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

const rawAt = (t, i) => t.raw[i];
/** One change: what a track did, from its first frame to its last. `box` is [x, y, w, h] at onset. */
export function changeOf(t, { box = null, exact = false } = {}) {
  const n = t.T.length, a = t.y[0], b = t.y[n - 1], travel = b - a, range = t.amp;
  const unit = unitOf(t.channel, t.family), property = propertyOf(t.channel);
  const out = { property, channel: t.channel, family: t.family, unit };
  if (TEXTY.has(t.family)) {
    out.from = rawAt(t, 0); out.to = rawAt(t, n - 1); out.raw = { from: out.from, to: out.to };
    if (out.from === out.to && range > 0) out.back = true;   // went somewhere and came back: a hover colour, a scramble that settles
    return out;
  }
  const within = Math.abs(travel) || range;   // a track that goes out and back must not round its ends by the width of the trip
  out.from = exact ? round(a, 4) : snap(a, within); out.to = exact ? round(b, 4) : snap(b, within);
  out.raw = { from: round(a, 4), to: round(b, 4) };
  // out and back: it ends near where it began but went somewhere on the way; the furthest point is what a person sees
  if (range > 0 && Math.abs(travel) < OUT_BACK * range) { const far = t.y.reduce((m, y) => (Math.abs(y - a) > Math.abs(m - a) ? y : m), a); out.peak = exact ? round(far, 4) : snap(far, range); }
  if (t.family === 'move' && box) {
    const size = property === 'y' ? box[3] : box[2], rest = Math.abs(b) < Math.abs(a) ? b : a, pct = percentOfBox(travel, size);
    if (pct != null && Math.abs(pct) <= PERCENT_MAX && Math.abs(rest) < 0.5) { out.percent = { from: Math.abs(a) < 0.5 ? 0 : Math.round((a / size) * 100), to: Math.abs(b) < 0.5 ? 0 : Math.round((b / size) * 100) }; }
  }
  return out;
}

/** Changes of a group, scale x and y of one size read as one scale. */
export function changesOf(tracks, opts = {}) {
  const list = tracks.map((t) => ({ ...changeOf(t, opts), follows: t.follows !== false }));
  const sx = list.find((c) => c.property === 'scaleX'), sy = list.find((c) => c.property === 'scaleY');
  if (sx && sy && sx.from === sy.from && sx.to === sy.to && sx.follows === sy.follows) return [...list.filter((c) => c !== sx && c !== sy), { ...sx, property: 'scale', channels: [sx.channel, sy.channel] }];
  return list;
}

/** The stops of a recorded curve: at most `max` points, within `share` of the range (DESIGN 4.3). [[ms since start, value]] */
export function reduceTrack(xs, ys, { max = FIT.keyframesMax, share = FIT.keyframesShare } = {}) {
  const pts = xs.map((x, i) => ({ x, y: ys[i] })), range = (Math.max(...ys) - Math.min(...ys)) || 1;
  let tol = range * share, kept = rdpVertical(pts, tol);
  while (kept.length > max) { tol *= 1.3; kept = rdpVertical(pts, tol); }
  return { keys: kept.map((p) => [round(p.x, 1), round(p.y, 4)]), errorPct: round((tol / range) * 100, 2) };
}

// ---------------------------------------------------------------- words
const PLAIN = (s) => String(s || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
const num = (x) => String(round(Math.abs(x), 1));
const VAR_NAME = /^--[A-Za-z0-9_-]{1,40}$/;
/**
 * One clause for one change: "scales up 6 %", "fades in". Null when nothing visible can be said: a change under what the eye sees (SEEN),
 * or a channel with no family. `screen`: the group's motion on the screen when its own transform says otherwise (group.js screenOf).
 */
export function clauseOf(c, { many = false, screen = null } = {}) {
  const s = many ? '' : 's', { property: p, from, to } = c, family = c.family ?? (c.channel ? familyOf(c.channel) : null);
  const nums = typeof from === 'number' && typeof to === 'number', back = nums && Number.isFinite(c.peak) ? c.peak : null;
  const end = back ?? to, up = end > from, and = back != null ? ' and back' : '';
  const px = nums ? Math.abs(end - from) : null;
  switch (family) {
    case 'move': {
      const axis = p === 'y' || (p === 'translate' && c.part === 'y') ? 'y' : 'x';
      if (screen && screen.axis === axis && Math.abs(screen.px) >= SEEN.px) {
        const d = screen.px > 0, n = `${num(screen.px)} px`;
        if (screen.counter) return `wipe${s} ${axis === 'x' ? (d ? 'right' : 'left') : d ? 'down' : 'up'} ${n}`;
        return axis === 'x' ? `slide${s} ${d ? 'right' : 'left'} ${n}` : `${d ? 'drop' : 'rise'}${s} ${n}`;
      }
      if (px != null && px < SEEN.px && !c.percent) return null;
      const size = c.percent && back == null ? `${Math.abs(c.percent.to - c.percent.from)} %` : `${num(px ?? 0)} px`;
      return axis === 'x' ? `slide${s} ${up ? 'right' : 'left'} ${size}${and}` : `${up ? 'drop' : 'rise'}${s} ${size}${and}`;
    }
    case 'scale': {
      if (!nums) return null;
      if (!(from > 0)) return end > from ? `scale${s} up${and}` : null;
      const pct = round((Math.abs(end - from) / from) * 100, 0);
      return pct < SEEN.scalePct ? null : `scale${s} ${up ? 'up' : 'down'} ${pct} %${and}`;
    }
    case 'rotate': return px != null && px < SEEN.deg ? null : `turn${s} ${num(px ?? 0)}°${and}`;
    case 'fade': {
      if (!nums || px < SEEN.opacity) return null;
      if (back != null) return from > 0.5 && back < 0.05 ? `fade${s} out and back in` : from < 0.05 && back > 0.5 ? `flash${many ? '' : 'es'} in and out` : `fade${s} to ${round(back * 100, 0)} % and back`;
      return from < 0.05 && to > 0.5 ? `fade${s} in` : from > 0.5 && to < 0.05 ? `fade${s} out` : `fade${s} from ${round(from * 100, 0)} % to ${round(to * 100, 0)} %`;
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
  const name = PLAIN(g.name).toLowerCase();
  const subject = lone && !many ? 'it' : many ? `the ${/s$/.test(name) ? name : `${name}s`}` : `the ${name}`;
  const clauses = (g.changes || []).map((c) => clauseOf(c, { many, screen: g.screen })).filter(Boolean).filter((x, i, l) => l.indexOf(x) === i).slice(0, 2);
  return clauses.length ? `${subject} ${clauses.join(' and ')}` : null;
}
const seconds = (ms) => `${round(ms / 1000, ms >= 10000 ? 0 : ms < 1000 ? 2 : 1)} s`;
const value = (v) => (typeof v === 'number' ? String(round(v, Math.abs(v) >= 10 ? 1 : 3)) : PLAIN(v));
/** "a full-screen WebGL layer (a noise function, 2 textures) runs u_progress 0 → 1 over 2.4 s, expo.inOut": its technique from the shader source. */
function glClause(g) {
  const c = g.changes[0], cover = g.gl?.cover ?? 0, law = g.law || {};
  const where = cover >= GLM.full ? 'a full-screen WebGL layer' : `a WebGL layer over ${Math.round(cover * 100)} % of the screen`;
  const how = g.gl?.technique ? ` (${PLAIN(g.gl.technique)})` : '';
  const ease = law.class === 'tween' ? law.named ?? law.declared ?? null : law.class === 'spring' ? 'a spring' : law.class === 'keyframes' ? 'as recorded' : null;
  const span = Number.isFinite(law.ms) && law.ms > 0 ? ` over ${seconds(law.ms)}` : '';
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
    const dom = list[0], ms = dom?.law?.class === 'map' ? null : dom?.law?.ms, rest = dom ? groupClause(dom, { lone: false }) : null;
    return `${first} ${glClause(all[0])}${rest ? `; ${rest}${Number.isFinite(ms) && ms > 0 ? `, ${seconds(ms)}` : ''}` : ''}.`;
  }
  if (!list.length) return null;
  if (kind === 'cursor') { const ms = list.find((g) => g.law?.ms > 0)?.law.ms; return `It follows the pointer${ms ? ` and catches up in ${seconds(ms)}` : ''}.`; }
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
  const law = top[0].law, ms = law?.class === 'map' ? null : law?.ms;
  const when = law?.class === 'map' ? ', tied to scroll' : Number.isFinite(ms) && ms > 0 ? `, ${seconds(ms)}` : '';
  const how = move.technique ? ` (${PLAIN(move.technique)})` : '';
  // the largest visible layer is a canvas no uniform of which leads (a skinned-mesh WebGL site: a full-screen three.js scene under the DOM): said first
  if (layer) return `${first} ${layer}; ${clauses.join(' and ')}${how}${when}.`;
  return `${first} ${clauses.join(' and ')}${how}${when}.`;
}

/** Why a move is no motion a person sees, or null when something visible moves (or REVA cannot tell: then it is never hidden). */
export const NOT_A_MOVE = Object.freeze({
  state: "only a new page's state, set at once: nothing moves",
  unseen: 'nothing visible moves: every change is under what the eye sees',
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
