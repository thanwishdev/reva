// Declared tier (design §3): read CSS animations / transitions / WAAPI timing from births, then CHECK the samples
// against the declared model simulated on the take's own frame times. Keyframe values are solved by linear least
// squares (the output is linear in them), so the check needs no CSS value parser and tests timing + easing exactly.
import { parseEasing, easeAt } from './eases.js';
import { ols } from './numeric.js';
import { keyframeChannelValues } from './declvalues.js';

export const PROPS_OF = (ch) => { const c0 = ch.replace(/^(ren|drv):/, ''); if (c0.startsWith('--')) return [c0];
  // a sub-channel (clipPath.right, one inset side) is animated by its whole property
  const c = c0.replace(/\.[a-zA-Z]+$/, ''); if (c === 'opacity') return ['opacity'];
  if (['tx', 'ty', 'tz', 'sx', 'sy', 'rz', 'skx'].includes(c)) return ['transform', 'translate', 'scale', 'rotate'];
  if (['bx', 'by', 'bw', 'bh'].includes(c)) return ['transform', 'translate', 'scale', 'rotate', 'left', 'top', 'width', 'height', 'inset', 'margin-left', 'margin-top'];
  if (c === 'radius') return ['border-top-left-radius', 'border-radius']; if (c === 'filter') return ['filter']; if (c === 'clipPath') return ['clip-path']; return [c]; };
export const camel = (s) => s.replace(/-([a-z])/g, (_, x) => x.toUpperCase());

/** Kind label for a birth. */
export function declaredKind(b) {
  if (/^-ua-view-transition|::view-transition/.test(b.name || '') || /view-transition/.test(b.tgt || '')) return 'view-transition';
  if (b.type === 'CSSAnimation' || b.type === 'CSSTransition') return 'css';
  return 'waapi';
}

/** Descriptor match (tag#id.classes): class lists change over a take (a birth sees `.go`, the final descriptor `.go.go2`). */
export function descMatch(a, b) {
  if (!a || !b) return false; if (a === b) return true;
  // a pseudo-element descriptor (`DIV.cursor.is-big::before`) matches the same pseudo-element of the same host, class lists as below
  const pa = /::[a-z-]+$/.exec(a), pb = /::[a-z-]+$/.exec(b);
  if (pa || pb) return !!pa && !!pb && pa[0] === pb[0] && descMatch(a.slice(0, pa.index), b.slice(0, pb.index));
  const P = (d) => { const m = /^([^#.]+)(?:#([^.]+))?(.*)$/.exec(d) || []; return { tag: m[1], id: m[2] || null, cls: (m[3] || '').split('.').filter(Boolean) }; };
  const x = P(a), y = P(b); if (x.tag !== y.tag) return false;
  if (x.id || y.id) return x.id === y.id;
  const [s, l] = x.cls.length <= y.cls.length ? [x.cls, y.cls] : [y.cls, x.cls];
  return s.length > 0 && s.every((c) => l.includes(c));
}

/** Births that animate a property of this channel on this element. */
export function birthsFor(view, s) {
  const props = PROPS_OF(s.ch).flatMap((p) => [p, camel(p)]);
  // Chrome's getKeyframes() omits animated custom properties: a keyframe list with no property at all animates only
  // custom properties, which any channel of the element may depend on through calc() (lab case M06); the declared check
  // below decides whether it explains the channel (keyframe values are solved, so an affine dependence fits exactly)
  const META = new Set(['offset', 'easing', 'composite', 'computedOffset']);
  const onlyCustom = (b) => (b.keyframes || []).length > 0 && b.keyframes.every((kf) => Object.keys(kf).every((k) => META.has(k)));
  return view.births.filter((b) => mine(b, s) && ((b.keyframes || []).some((kf) => Object.keys(kf).some((k) => props.includes(k)))
    || (b.type === 'CSSTransition' && props.includes(camel(String(b.name || '')))) || onlyCustom(b)));
}
/**
 * A birth is this element's: by the recorder's element id when both carry one (siblings that share a descriptor, the two
 * lines of a split heading, each see only their own animations), else by descriptor (takes recorded before births carried
 * the id).
 */
const mine = (b, s) => (Number.isInteger(b.el) && Number.isInteger(s.el) ? b.el === s.el : descMatch(b.tgt, s.desc));

/** Directed, eased iteration progress of an effect at local time lt (ms since start), or null when inactive. */
export function effectProgress(b, lt) {
  const delay = +b.delay || 0, dur = +b.duration || 0; const iters = b.iterations == null ? Infinity : +b.iterations;
  const fill = b.fill || 'auto'; const dir = b.direction || 'normal'; const E = parseEasing(b.easing) || ((p) => p);
  const active = dur * iters; const t = lt - delay;
  let it, frac;
  if (t < 0) { if (!(fill === 'backwards' || fill === 'both' || b.type === 'CSSTransition')) return null; it = 0; frac = 0; }
  else if (t >= active) { if (!(fill === 'forwards' || fill === 'both')) return null; if (!Number.isFinite(iters)) return null; it = Math.max(0, Math.ceil(iters) - 1); frac = iters - it; if (frac === 0) frac = 1; }
  else { it = dur > 0 ? Math.floor(t / dur) : 0; frac = dur > 0 ? (t - it * dur) / dur : 1; }
  const rev = dir === 'reverse' || (dir === 'alternate' && it % 2 === 1) || (dir === 'alternate-reverse' && it % 2 === 0);
  const p = rev ? 1 - frac : frac; return easeAt(E, p);
}

/** Keyframe offsets (null offsets distributed evenly) and per-keyframe easing functions. */
function kfOffsets(kfs) {
  const o = kfs.map((k) => (k.offset == null ? null : +k.offset)); if (o[0] == null) o[0] = 0; if (o.at(-1) == null) o[o.length - 1] = 1;
  for (let i = 1; i < o.length - 1; i++) if (o[i] == null) { let j = i; while (o[j] == null) j++; for (let q = i; q < j; q++) o[q] = o[i - 1] + ((o[j] - o[i - 1]) * (q - i + 1)) / (j - i + 1); }
  return o;
}
/** Basis weights over the keyframe values at iteration progress p. */
function kfWeights(kfs, offs, p) {
  const w = new Array(kfs.length).fill(0); if (kfs.length === 1) { w[0] = 1; return w; }
  let i = 0; while (i < offs.length - 2 && p > offs[i + 1]) i++;
  const span = offs[i + 1] - offs[i]; const q = span > 0 ? (p - offs[i]) / span : 1; const E = parseEasing(kfs[i].easing) || ((x) => x);
  const e = span > 0 ? (q <= 0 || q >= 1 ? q : E(q)) : 1; w[i] += 1 - e; w[i + 1] += e; return w;
}

/**
 * Check a series against its declared animations.
 * @returns null when no birth applies; else {model, rms, explains, mismatch, births, visible, kind, composite}
 */
export function checkDeclared(view, s, nf) {
  const bs = birthsFor(view, s).filter((b) => b.timeline === 'document' || b.timeline == null || b.timeline === 'none');
  const scrollBs = birthsFor(view, s).filter((b) => b.timeline && b.timeline !== 'document' && b.timeline !== 'none');
  if (!bs.length && !scrollBs.length) return null;
  if (!bs.length) return { kind: 'scroll-timeline', scrollTimeline: true, births: scrollBs.map(slim) };
  const all = checkBirths(s, nf, bs, view);
  if (bs.length < 2) { if (all.explains) return all; const played = playedLater(s, nf, bs, view); return played && played.explains ? played : all; }
  // two births of one animation name in one frame cannot both be this element's: siblings share the descriptor. Then the
  // whole set can "explain" with the wrong birth in front (another sibling's delay); the element's own subset decides
  const sameFrame = new Set(); let siblings = false;
  for (const b of bs) { const key = `${b.type}|${b.name}|${Number.isInteger(b.k) ? b.k : Math.round(b.T)}`; if (sameFrame.has(key)) { siblings = true; break; } sameFrame.add(key); }
  if (all.explains && !siblings) return all;
  const own = ownBirths(s, nf, bs, view);
  if (own && own.explains) return own;
  if (all.explains) return all;
  const played = playedLater(s, nf, bs, view);
  return played && played.explains ? played : all;
}

/**
 * An animation created paused and played later (a reveal the page builds at load and plays from an IntersectionObserver)
 * is born long before it runs: the declared model at its birth time explains nothing. Its duration, curve and keyframes
 * are still the page's own; only the start is not. One birth at a time, the start is searched over the frame in which
 * the samples leave their rest value (and the frame before it); a start that makes the declared model explain the samples is
 * MEASURED (to a sub-frame), and the delay cannot be told apart from it.
 */
function playedLater(s, nf, bs, view) {
  const T = s.T, y = s.y; if (T.length < 4) return null;
  const vi = y.findIndex((v) => Math.abs(v - y[0]) > nf.explainBar);
  if (vi < 1) return null;
  const dt = T[vi] - T[vi - 1];
  const at = (b, onset) => { const nb = { ...b, T: onset - (+b.delay || 0), k: undefined }; const r = checkBirths({ ...s, k: null }, nf, [nb], view); return r && Number.isFinite(r.rms) ? { r, nb, b, x: onset } : null; };
  // visible onset (start + delay) somewhere in the two frames before the first moved frame: a coarse scan per distinct
  // animation, then a golden-section refinement around the best point (a steep curve needs the start to a small part of a frame)
  const lo0 = T[vi - 1] - dt, step = (2 * dt) / 24;
  const seen = new Set(); let top = null; let n = 0;
  for (const b of bs) {
    if (!(+b.duration > 0) || b.T >= T[vi]) continue;
    const key = `${b.type}|${b.name}|${b.duration}|${b.easing}|${JSON.stringify(b.keyframes)}`; if (seen.has(key)) continue; seen.add(key);
    if (++n > PLAYED_MAX_CANDIDATES) break;
    for (let q = 0; q <= 24; q++) { const v = at(b, lo0 + q * step); if (v && (!top || v.r.rms < top.r.rms)) top = v; }
  }
  if (!top) return null;
  let a = top.x - step, c = top.x + step; const g = (Math.sqrt(5) - 1) / 2;
  for (let it = 0; it < 24 && !top.r.explains; it++) {
    const x1 = c - g * (c - a), x2 = a + g * (c - a); const v1 = at(top.b, x1), v2 = at(top.b, x2);
    const e1 = v1 ? v1.r.rms : Infinity, e2 = v2 ? v2.r.rms : Infinity;
    if (e1 < e2) { c = x2; if (e1 < top.r.rms) top = v1; } else { a = x1; if (e2 < top.r.rms) top = v2; }
  }
  return { ...top.r, startMeasured: { start: top.nb.T, birthT: top.b.T, note: 'created before it ran (a paused animation the page played later): start measured from the samples, to a sub-frame; the delay is not separable from it' } };
}
const PLAYED_MAX_CANDIDATES = 12;

/**
 * Births are matched to an element by its descriptor (tag.classes), so siblings that share one (eight `svg.glint`, six
 * `TR.is-on`, the lines of a code block) all see each other's animations, and the declared model of the whole set
 * (the latest active birth wins) explains none of them, or explains with another sibling's birth in front. An element's
 * own births are the subset whose declared model explains its samples: chosen greedily (the birth that lowers the
 * residual most, until the model explains or nothing helps). The record says how the births were chosen.
 */
const OWN_MAX_CANDIDATES = 48, OWN_MAX_PICKS = 8;
function ownBirths(s, nf, bs, view) {
  const T0 = s.T[0], T1 = s.T.at(-1);
  // an animation that ends before the series starts, or is born after it ends, cannot explain any of it
  const alive = (b) => { const end = (+b.delay || 0) + (+b.duration || 0) * (b.iterations == null ? Infinity : +b.iterations); return b.T <= T1 && b.T + end >= T0 - 1; };
  const cand = bs.map((b, i) => ({ b, i })).filter((x) => alive(x.b)).slice(0, OWN_MAX_CANDIDATES);
  if (!cand.length) return null;
  let mean = 0; for (const v of s.y) mean += v; mean /= s.y.length; let ss = 0; for (const v of s.y) ss += (v - mean) ** 2;
  let curRms = Math.sqrt(ss / s.y.length); let pick = []; let cur = null;
  for (let round = 0; round < OWN_MAX_PICKS; round++) {
    let best = null;
    for (const c of cand) {
      if (pick.includes(c)) continue;
      const set = [...pick, c].sort((a, b) => a.i - b.i);
      const r = checkBirths(s, nf, set.map((x) => x.b), view);
      if (r && Number.isFinite(r.rms) && (!best || r.rms < best.r.rms)) best = { c, r };
    }
    if (!best || !(best.r.rms < curRms * 0.9)) break;
    pick = [...pick, best.c]; cur = best.r; curRms = best.r.rms;
    if (cur.explains) break;
  }
  if (!cur || !cur.explains) return null;
  cur.ownOf = { matched: bs.length, own: pick.length, note: `${bs.length} animations share this element's descriptor (siblings); its own ${pick.length === 1 ? 'one is the one' : `${pick.length} are the ones`} whose declared timing explains its samples` };
  return cur;
}

/**
 * A rotation is read back as a continuous angle (series.js unwrapDegrees: each sample within 180 deg of the one before), so a
 * repeating effect that turns once per iteration (infinite rotate 0 -> 360) reads 0 -> 480 deg in a take longer than one
 * iteration, while the effect restarts at 0 every iteration. A rotation channel is therefore also tried modulo whole turns:
 * one extra column, the number of finished iterations of the effect on show, with a free coefficient that must come out a
 * whole number of turns (a multiple of 360 deg) other than zero. Only tried when the plain model does not explain.
 */
const TURN_TOL = 1;   // deg: how close to a whole number of turns the solved per-iteration offset must be
function checkBirths(s, nf, bs, view) {
  const plain = checkBirthsCore(s, nf, bs, view, false);
  if (plain && plain.explains) return plain;
  if (s.ch !== 'ren:rz' || !bs.some((b) => b.iterations == null || +b.iterations > 1)) return plain;
  const turned = checkBirthsCore(s, nf, bs, view, true);
  return turned && turned.explains ? turned : plain;
}
function checkBirthsCore(s, nf, bs, view, turns) {
  const T = s.T, y = s.y; const nb = bs.length;
  // columns: keyframe values of each birth, then a base value per inactive run
  const cols = []; bs.forEach((b, j) => { const kfs = b.keyframes && b.keyframes.length ? b.keyframes : [{ offset: 0 }, { offset: 1 }]; for (let q = 0; q < kfs.length; q++) cols.push({ birth: j, kf: q }); });
  const rowsW = []; const owner = []; const dtF = view.dtPage || (T.length > 1 ? T[1] - T[0] : 0);
  for (let i = 0; i < T.length; i++) {
    // an animation exists from its creation frame (birth rule `next`: start = creation + one frame) and shows
    // progress at local time max(0, T − start) while pending
    // existence from the creation frame key (a birth records the frame k it was seen in: in-frame births start at T_k,
    // `next`-rule births at T_(k+1) and are pending in frame k); the time rule is the fallback without keys
    let top = -1, pr = null; for (let j = nb - 1; j >= 0; j--) { if (s.k && Number.isInteger(bs[j].k) ? s.k[i] < bs[j].k : T[i] < bs[j].T - dtF - 1e-6) continue; const p = effectProgress(bs[j], Math.max(0, T[i] - bs[j].T)); if (p != null) { top = j; pr = p; break; } }
    owner.push(top); rowsW.push(pr);
  }
  // finished iterations of the effect on show (turns variant only)
  const done = owner.map((o, i) => { if (!turns || o < 0) return 0; const b = bs[o]; const dur = +b.duration || 0; if (!(dur > 0)) return 0; const t = Math.max(0, T[i] - b.T) - (+b.delay || 0); return t > 0 ? Math.floor(t / dur) : 0; });
  const baseRuns = []; let run = -1; owner.forEach((o, i) => { if (o < 0) { if (run < 0 || owner[i - 1] >= 0) { baseRuns.push([]); run = baseRuns.length - 1; } baseRuns[run].push(i); } });
  const ncol = cols.length + baseRuns.length + (turns ? 1 : 0); const X = [];
  const colStart = []; let c0 = 0; bs.forEach((b) => { colStart.push(c0); c0 += (b.keyframes && b.keyframes.length ? b.keyframes.length : 2); });
  const runOf = new Map(); baseRuns.forEach((r, q) => r.forEach((i) => runOf.set(i, q)));
  for (let i = 0; i < T.length; i++) {
    const row = new Array(ncol).fill(0);
    if (owner[i] >= 0) { const b = bs[owner[i]]; const kfs = b.keyframes && b.keyframes.length ? b.keyframes : [{ offset: 0 }, { offset: 1 }]; const w = kfWeights(kfs, kfOffsets(kfs), rowsW[i]); w.forEach((v, q) => { row[colStart[owner[i]] + q] = v; }); }
    else row[cols.length + runOf.get(i)] = 1;
    if (turns) row[ncol - 1] = done[i];
    X.push(row);
  }
  // drop all-zero columns (keyframes never reached), solve
  const used = []; for (let c = 0; c < ncol; c++) if (X.some((r) => Math.abs(r[c]) > 1e-12)) used.push(c);
  const Xu = X.map((r) => used.map((c) => r[c])); const sol = used.length ? ols(Xu, y) : null;
  if (!sol) return { kind: declaredKind(bs[0]), births: bs.map(slim), explains: false, mismatch: true, rms: Infinity, reason: 'declared model not solvable' };
  if (turns) {
    // the solved offset per finished iteration must be a nonzero whole number of turns
    const ix = used.indexOf(ncol - 1); const C = ix >= 0 ? sol.beta[ix] : 0; const m = Math.round(C / 360);
    if (ix < 0 || m === 0 || Math.abs(C - 360 * m) > TURN_TOL) return null;
  }
  const pred = Xu.map((r) => r.reduce((a, v, q) => a + v * sol.beta[q], 0));
  let ss = 0; for (let i = 0; i < y.length; i++) ss += (pred[i] - y[i]) ** 2; const rms = Math.sqrt(ss / y.length);
  const values = bs.map((b, j) => { const n = b.keyframes && b.keyframes.length ? b.keyframes.length : 2; return Array.from({ length: n }, (_, q) => { const ix = used.indexOf(colStart[j] + q); return ix >= 0 ? sol.beta[ix] : null; }); });
  // visible onset / duration vs declared (M06 holds)
  const b0 = bs[0]; const decOnset = b0.T + (+b0.delay || 0); const rest = y[Math.max(0, T.findIndex((t) => t >= b0.T - 1e-6))];
  const vi = T.findIndex((t, i) => t >= b0.T - 1e-6 && Math.abs(y[i] - rest) > nf.explainBar);
  let ve = -1; for (let i = y.length - 1; i > 0; i--) if (Math.abs(y[i] - y[i - 1]) > nf.sigma * 3) { ve = i; break; }
  const visible = vi > 0 ? { onset: T[vi - 1], onsetLatest: T[vi], duration: ve > vi ? T[ve] - T[vi - 1] : null } : null;
  // exact visible onset from the confirmed declared model: the first keyframe interval whose solved values differ
  // (a flat keyframe segment is a hold), at start + delay + offset × duration (lab case M06)
  if (visible && values[0]) {
    const kfs0 = b0.keyframes && b0.keyframes.length ? b0.keyframes : [{ offset: 0 }, { offset: 1 }]; const offs0 = kfOffsets(kfs0);
    const q = values[0].findIndex((v, i) => i < values[0].length - 1 && v != null && values[0][i + 1] != null && Math.abs(values[0][i + 1] - v) > nf.explainBar);
    if (q >= 0 && Number.isFinite(+b0.duration)) { const on = b0.T + (+b0.delay || 0) + offs0[q] * (+b0.duration); if (on >= visible.onset - 1e-6 && on <= visible.onsetLatest + 1e-6) visible.onsetModel = on; }
  }
  const dt = T.length > 1 ? (T.at(-1) - T[0]) / (T.length - 1) : 0;
  const holdFlag = visible && visible.onset - decOnset > dt * 1.01 ? { id: 'visible_onset_after_declared', declaredOnset: decOnset, visibleOnset: visible.onset, diffMs: visible.onset - decOnset } : null;
  // retargeted: transitions that owned frames of this series (a sibling's transitions matched by the shared descriptor own none)
  const owned = new Set(owner.filter((o) => o >= 0));
  const transitions = bs.filter((b, j) => b.type === 'CSSTransition' && owned.has(j)).length;
  // the declared keyframe values of the first birth, checked against the samples: [exact] when they explain them
  const exact = rms <= nf.explainBar ? exactValues(s, nf, b0, X, y, ncol, colStart[0], values[0]) : null;
  return { kind: declaredKind(b0), births: bs.map(slim), values, ...(exact ? { exact } : {}), rms, explains: rms <= nf.explainBar, mismatch: rms > nf.explainBar, predict: pred, visible, holdFlag, declaredOnset: decOnset,
    declaredDuration: (+b0.duration || 0) * (b0.iterations == null ? Infinity : +b0.iterations), retargeted: transitions >= 3 ? transitions : 0 };
}
/**
 * The first birth's keyframe values as the page declares them, fixed in the declared model (a relative unit, translateY(20%),
 * by one solved px factor; the other columns solved again): {values (channel units, px), declared, unit, factor, implicit,
 * rms} when the model with them still explains the samples, {rejected, rms} when it does not, null when the keyframes give
 * no number for this channel (not named, not parsed). A keyframe that does not name the property (an implicit `from`: the
 * computed value) keeps its solved value and is marked implicit.
 */
function exactValues(s, nf, b0, X, y, ncol, c0, solved) {
  const kfs = b0.keyframes && b0.keyframes.length ? b0.keyframes : null; if (!kfs) return null;
  const ev = keyframeChannelValues(s.ch, s.form || null, kfs); if (!ev) return null;
  const rels = [...new Set(ev.filter((e) => e && e.rel).map((e) => e.unit))];
  // one relative unit, and no non-zero absolute length beside it (20% -> 10px is not one factor)
  if (rels.length > 1 || (rels.length && ev.some((e) => e && !e.rel && e.v !== 0))) return null;
  const rel = rels[0] || null;
  const fixed = new Map(); ev.forEach((e, q) => { if (e) fixed.set(c0 + q, e.v); });
  const free = []; for (let c = 0; c < ncol; c++) if (!fixed.has(c) && X.some((r) => Math.abs(r[c]) > 1e-12)) free.push(c);
  const z = X.map((r) => { let v = 0; for (const [c, k] of fixed) v += r[c] * k; return v; });
  const relCol = rel && z.some((v) => Math.abs(v) > 1e-12);
  const yy = rel ? y : y.map((v, i) => v - z[i]);
  const Xf = X.map((r, i) => [...(relCol ? [z[i]] : []), ...free.map((c) => r[c])]);
  let beta = [];
  if (Xf[0].length) { const sol = ols(Xf, yy); if (!sol) return null; beta = sol.beta; }
  const pred = Xf.map((r) => r.reduce((a, v, q) => a + v * beta[q], 0));
  let ss = 0; for (let i = 0; i < y.length; i++) ss += (pred[i] - yy[i]) ** 2; const rms = Math.sqrt(ss / y.length);
  if (!(rms <= nf.explainBar)) return { rejected: true, rms };
  const factor = rel ? (relCol ? beta[0] : null) : 1;
  if (rel && relCol && !(Number.isFinite(factor) && factor > 0)) return { rejected: true, rms };
  const values = ev.map((e, q) => (e ? (rel ? (e.v === 0 ? 0 : factor != null ? e.v * factor : null) : e.v) : solved[q]));
  return { values, declared: ev.map((e) => (e ? e.v : null)), unit: rel, factor: rel ? factor : null, implicit: ev.map((e) => !e), rms };
}
const slim = (b) => ({ type: b.type, name: b.name, ...(Number.isInteger(b.el) ? { el: b.el } : {}), T: b.T, k: b.k, delay: b.delay, duration: b.duration, easing: b.easing, iterations: b.iterations, direction: b.direction, fill: b.fill, timeline: b.timeline, keyframes: b.keyframes, provenance: 'declared' });

/** Keyframe property names (dashed and camelCase) that drive a channel. */
export const declaredProps = (ch) => PROPS_OF(ch).flatMap((p) => [p, camel(p)]);
