// S8, the fit (DESIGN 3.5): moves.json, moves/<id>.json and moves-laws.json in, the same files out with laws, code, proof and sentences.
// One exemplar is fitted per law class, site-wide, then up to 8 other runs are held against that law. A run the law does not hold on
// leaves the class and gets its own fit, at most 2 per class. What no law fits ships as sampled keyframes and says so.
//   const r = await fitMoves(scanDir);     // { files, classes, ms, ledger: [{viewport, fitted, sampled, split, cut}] }
// Work runs in phases so a take opens as few times as it can: fits sorted by take, then one batch of checks per take.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { fitTakeSet } from '../../analysis/fit/index.js';
import { baseKey } from '../../analysis/fit/series.js';
import { fitGl, PER_MOTION, SERIES } from '../analyse.js';
import { loadTake } from '../../record/take.js';
import { openRows } from '../../record/series-io.js';
import { safeJson } from '../fitone.js';
import { fitOrder } from '../../look/select.js';
import { asExportRecord, anchorMapToSamples } from '../../look/exportword.js';
import { guardPhysical } from '../../look/physical.js';
import { familyKind, declaredEasing, exportRecord } from '../../export/index.js';
import { round } from '../../export/curves.js';
import { agentPrompt, curveOfLaw, followGroup, glSpecOf, leadGroup, pickEase, proofOf, timingLine } from '../../export/move.js';
import { closeMove } from './close.js';
import { evaluator, holds, lawError, pickInstances, slimRecord } from './lawcheck.js';
import { changesOf, notAMove, reduceTrack, readTracks, sentenceOf } from './intent.js';
import { feelOf } from './feel.js';
import { FIT, GAPS, indexProblems, MODEL, moveFileProblems, pxEquivalent, selectorGroup } from './contract.js';
import { LAWS_FILE } from './index.js';
import crypto from 'node:crypto';
import { parseKey } from '../../analysis/gl/channels.js';
import { canvasPlacesOf, coverOf, drawEventsOf, drawsOf, engineOfSources, geometryOf, mergedOf, glChannelsIn, glClocksOf, GL_KINDS, GLM, glLeads, glUniformsOf, isGlGroup, passesOf, perDrawKeys, programOf, programSourcesOf, programValuesOf, uniformName, withObjectPositions, withWorkerRows } from './glmove.js';

const DT = 1000 / 60, BEFORE_MS = 500, AFTER_MS = 700, TAKES_KEPT = 2, STEP_FRAMES = 3;
const T_SLACK = 0.02;   // moves-laws.json rounds its times to 0.01 ms, so a frame's own time can fall just outside them
/** A law fit has its own budgets; this only catches a worker that hangs. */
export const JOB_LIMIT_MS = 120000;
/** Old-generation cap of one fit worker, MB (runAll). 0: V8's own limit. */
export const WORKER_HEAP_MB = 512;
export const defaultWorkers = () => Math.max(1, Math.min(6, os.cpus().length - 2));
/** The gap sentences live in the contract; fit.js keeps the name it always exported. */
export { GAPS };

const thin = (pts, n) => (pts.length <= n ? pts : Array.from({ length: n }, (_, i) => pts[Math.round((i * (pts.length - 1)) / (n - 1))]));
const takeDir = (out, s) => path.join(out, ...(s.page && s.page !== 'home' ? ['pages', s.page] : []), 'takes', s.viewport, s.take);

// ---------------------------------------------------------------- one take, in a worker
// A worker holds a take's rows as text (openRows) and reads only the rows a job asks for. Holding the whole take decoded
// put a large marketing site at 16.2 GB in six workers (ACCEPT, After G11); every job here reads a window of a few hundred rows.
const takes = new Map();
const PARTS = SERIES.filter((n) => n !== 'rows');
function take(dir) {
  if (takes.has(dir)) { const v = takes.get(dir); takes.delete(dir); takes.set(dir, v); return v; }
  const L = loadTake(dir, PARTS), s = L.take.series?.rows, rows = s ? openRows(path.join(dir, s.file)) : { n: 0, ks: [], read: () => new Map() };
  // `k` restarts on a new document, and the fit list speaks in `k` as stored, so rows carry the number of their document
  let prev = -Infinity, doc = 0; const docs = new Array(rows.n);
  rows.ks.forEach((k, i) => { if (k <= prev) doc++; prev = k; docs[i] = doc; });
  const v = { L, rows, docs }; takes.set(dir, v);
  while (takes.size > TAKES_KEPT) takes.delete(takes.keys().next().value);
  return v;
}
/** Which document a run is in: the one where its element changes at its first frame. `got`: rows read, by row number. */
function docOf({ rows: { ks }, docs }, s, got) {
  const id = s.el == null ? null : String(s.el);
  let first = 0, seen = false;
  for (let i = 0; i < ks.length; i++) {
    if (ks[i] !== s.k0) continue;
    if (!seen) { first = docs[i]; seen = true; }
    const r = got.get(i), p = got.get(i - 1);
    if (id != null && r.v?.[id] && i > 0 && r.v[id] !== p.v?.[id]) return docs[i];
  }
  return first;
}
/** The rows around one run, inside its own document. Only these rows, and the row before each start frame, are read. */
function rowsAround(t, s, padFrames) {
  const { ks } = t.rows, lo = s.k0 - padFrames, hi = s.k1 + padFrames, need = new Set();
  for (let i = 0; i < ks.length; i++) {
    if (ks[i] >= lo && ks[i] <= hi) need.add(i);
    if (ks[i] === s.k0) { need.add(i); if (i > 0) need.add(i - 1); }
  }
  const got = t.rows.read([...need].sort((a, b) => a - b)), doc = docOf(t, s, got), out = [];
  for (let i = 0; i < ks.length; i++) { if (t.docs[i] === doc && ks[i] >= lo && ks[i] <= hi) out.push(got.get(i)); }
  return out;
}
const framesFor = (ms) => Math.round(ms / DT);
/** A run's tracks: from the frame before it starts to its last, so a track holds the rest it left. */
function tracksOf(rows, s, box = false) {
  const start = rows.find((r) => r.T >= s.T0 - T_SLACK), i = rows.indexOf(start), T0 = rows[Math.max(0, i - 1)]?.T ?? s.T0;
  return readTracks(rows, s.el, { T0, T1: s.T1 + T_SLACK }, { box });
}
const rowAt = (rows, s) => rows.find((r) => r.T >= s.T0 - T_SLACK) || rows[0];
function boxAt(rows, s) {
  const r = rowAt(rows, s), v = r?.v?.[String(s.el)];
  return v && [v['ren:bx'], v['ren:by'], v['ren:bw'], v['ren:bh']].every(Number.isFinite) ? [v['ren:bx'], v['ren:by'], v['ren:bw'], v['ren:bh']] : null;
}

/**
 * The rows as the fit of one element sees them: that element alone, with the frame, scroll, canvas and WebGL fields.
 * fitTakeSet with onlyKeys fits one element's channel and reads the others only to build their series (every channel of
 * every watched element: 1,474 elements on a large marketing site, past 512 MB of heap for one job), so the result is the same without them.
 */
const alone = (rows, el) => { const id = String(el); return rows.map((r) => { const v = r.v?.[id]; return { ...r, v: v ? { [id]: v } : {} }; }); };

/** The fit itself, as `reva look` runs one element: declared first, then the fitter on this one channel. */
function fitChannel(L, rows, el, lead) {
  const view = { ...L, data: { ...L.data, rows: alone(rows, el) } }, key = `${el}|${lead}`;
  const order = fitOrder([{ lead: +el, fitted: { lead: [lead], members: [] }, memberChannel: null }], L.data.births, L.data.elements || [], { pageKey: null });
  const res = fitTakeSet({ primary: view }, { ...PER_MOTION, order, declaredFirst: order.declared, onlyKeys: [key] });
  const recs = res.records.filter((r) => String(r.target.el) === String(el) && baseKey(`${el}|${r.target.channel}`) === key).map((r) => guardPhysical(anchorMapToSamples(asExportRecord(r))));
  return { recs, cut: (res.flags || []).some((f) => /budget/.test(f.id)) };
}

/** Recorded progress against a law's own axis: [[ms since its start, or px since s0, progress]]. Every frame. */
function pointsOf(track, ev, e) {
  const span = e.to - e.from;
  if (ev.axis === 'scroll') return track.sy.map((s, i) => [round(s - ev.s0 - e.shift, 2), round((track.y[i] - e.from) / span, 5)]);
  return track.T.map((t, i) => [round(t - ev.t0 - e.shift, 2), round((track.y[i] - e.from) / span, 5)]);
}
/** The law sampled at up to 64 points, so the card needs no evaluator. */
function curveOf(ev, span) {
  const n = FIT.curveMax - 1;
  return Array.from({ length: n + 1 }, (_, i) => { const x = (span * i) / n; return [round(x, 2), round(ev.axis === 'scroll' ? ev.fn(ev.s0 + x) : ev.fn(x), 4)]; });
}
export function lawOf(rec, ev, pts) {
  const fam = rec.model.family, kind = familyKind(fam);
  if (kind === 'spring') { const p = rec.model.params, v0 = p.v0?.value ?? p.v0?.withheld_value ?? 0, x0 = ev.x0, tg = p.target?.value ?? p.target?.withheld_value, travel = x0 != null && tg != null ? tg - x0 : 0; return { class: 'spring', ms: round(ev.span, 1), delayMs: 0, omega: p.omega?.value ?? p.omega?.withheld_value, zeta: p.zeta?.value ?? p.zeta?.withheld_value, v0, v0n: travel ? v0 / travel : 0 }; }
  if (kind === 'scroll map') { const m = rec.model.map; return { class: 'map', s0: round(m.s0_px, 1), s1: round(m.s1_px, 1), shape: m.shape ?? ((/\(([^)]+)\)/.exec(fam) || [])[1] || 'linear'), driver: rec.model.driver?.kind ?? 'scroll' }; }
  const ms = round(ev.span, 1), law = { class: 'tween', ms, delayMs: 0 };
  if (fam === 'declared:css' || fam === 'declared:waapi') { const d = declaredEasing(rec), delay = rec.model.params?.delay?.value; if (!d.easing) return null; law.declared = d.easing; if (delay > 0) law.delayMs = round(delay, 1); return law; }
  if (fam === 'ramp') law.key = 'linear';
  else if (fam.startsWith('named:')) law.key = rec.model.ease || fam.slice(6);
  else if (rec.model.bezier) law.bezier = rec.model.bezier.map((x) => round(x, 4));
  else { const b = ['x1', 'y1', 'x2', 'y2'].map((k) => rec.model.params?.[k]?.value); if (b.every(Number.isFinite)) law.bezier = b.map((x) => round(x, 4)); }
  const pick = pickEase(pts, ms);
  if (pick) { law.key = pick.key; law.named = pick.name; law.namedErrorPct = pick.errorPct; law.runnerUp = pick.runnerUp; }
  return law;
}
/** Keys of a track, ms since its first frame, in values the code can print: a string channel keeps its recorded strings. */
function keysOf(t) {
  const start = t.T[0], { keys, errorPct } = reduceTrack(t.T.map((x) => x - start), t.y), at = new Map(t.T.map((x, i) => [round(x - start, 1), i]));
  return { keys: typeof t.raw[0] === 'string' && !/^ren:(tx|ty|sx|sy|rz|skx|opacity)$/.test(t.channel) ? keys.map(([x, v]) => [x, t.raw[at.get(x)] ?? v]) : keys, errorPct };
}
function sampledLaw(lead) {
  const { errorPct } = keysOf(lead), start = lead.T[0], lo = Math.min(...lead.y), hi = Math.max(...lead.y), a = lead.y[0], b = lead.y.at(-1), base = Math.abs(b - a) > 0.1 * (hi - lo) ? [a, b - a] : [lo, hi - lo];
  const points = reduceTrack(lead.T.map((x) => x - start), lead.y).keys.map(([x, y]) => [x, round((y - base[0]) / (base[1] || 1), 4)]);
  return { class: 'keyframes', ms: round(lead.T.at(-1) - start, 1), delayMs: 0, points, errorPct };
}

/**
 * Fit one exemplar. In a worker, or in the caller's thread when there are no workers.
 * @param {{dir:string, s:object, lead:string, partHint?:string}} job  s: one `sample` entry of moves-laws.json
 * @returns {object} the law class's result: law, tracks' changes, proof numbers, and a slim record for the check
 */
export function fitExemplar({ dir, s, lead, noMap = false }) {
  const started = Date.now(), t = take(dir), { L } = t, rows = rowsAround(t, s, framesFor(AFTER_MS + BEFORE_MS));
  const near = rows.filter((r) => r.T >= s.T0 - BEFORE_MS && r.T <= s.T1 + AFTER_MS);
  const all = tracksOf(rows, s, lead === 'box'), box = boxAt(rows, s), vh = L.take.env?.innerHeight?.value ?? L.take.env?.innerHeight ?? 900;
  const sy0 = rowAt(rows, s)?.sy ?? 0;
  const leadTrack = all.find((x) => x.channel === lead) || all[0];
  if (!leadTrack) return { none: true, sy0 };
  const tracks = all.filter((x) => x === leadTrack || pxEquivalent(x.channel, x.amp) >= MODEL.noisePx);
  let fit = { recs: [], cut: false }, failed = null;
  try { fit = fitChannel(L, near, s.el, leadTrack.channel); } catch (e) { failed = String(e && e.message).slice(0, 200); }
  // the record that best explains this run: a take window can hold another motion of the same element
  let best = null;
  for (const rec of fit.recs) {
    if (noMap && familyKind(rec.model.family) === 'scroll map') continue;   // nothing scrolled this move: the map is a coincidence of the rows
    const x0 = leadTrack.y[0], ev = evaluator(rec, { x0 }); if (!ev) continue;
    const e = lawError(ev, leadTrack); if (e && (!best || e.errorPct < best.e.errorPct)) best = { rec, ev, e };
  }
  const stepRec = fit.recs.find((r) => r.class === 'step');
  const base = { ms: Date.now() - started, sy0, box, frames: leadTrack.T.length, T0: s.T0, cut: fit.cut || !!failed, failed, family: best?.rec.model.family ?? fit.recs[0]?.model?.family ?? null, rejectedPct: best && !holds(best.e) ? round(best.e.errorPct, 1) : null };
  const ownKeys = (tr) => { const { keys } = keysOf(tr); return keys; };
  const exact = best?.rec.tier === 'declared';
  if (best && holds(best.e)) {
    const onset = best.ev.axis === 'time' ? best.ev.t0 + best.e.shift - DT : -Infinity;
    const from = (tr) => { const i = tr.T.findIndex((t) => t >= onset); return i <= 0 ? tr : { ...tr, T: tr.T.slice(i), y: tr.y.slice(i), sy: tr.sy.slice(i), raw: tr.raw.slice(i) }; };
    const leadOn = from(leadTrack), pts = pointsOf(leadOn, best.ev, best.e), law = lawOf(best.rec, best.ev, pts);
    if (law) {
      const others = tracks.map((tr) => { const t1 = from(tr); if (tr === leadTrack) return { ...t1, follows: true }; const e = lawError(best.ev, tr); return { ...t1, follows: holds(e) }; });
      const changes = changesOf(others, { box, exact }).map((c) => { if (c.follows) return c; const tr = others.find((x) => x.channel === c.channel); return { ...c, keys: ownKeys(tr) }; });
      const span = law.class === 'map' ? law.s1 - law.s0 : law.ms;
      const mapScroll = law.class === 'map' && box ? { start: `top ${Math.round(((box[1] + sy0 - law.s0) / vh) * 100)}%`, end: `top ${Math.round(((box[1] + sy0 - law.s1) / vh) * 100)}%` } : null;
      return { ...base, law, changes, pts, dots: thin(pts, FIT.dotsMax), curve: curveOf(best.ev, span), provenance: exact ? 'declared' : 'fitted', errorPct: round(best.e.errorPct, 2), rec: slimRecord(best.rec), x0: best.ev.x0 ?? leadTrack.y[0], axis: best.ev.axis, mapScroll, t0: best.ev.t0 ?? null, leadChannel: leadTrack.channel };
    }
  }
  const changes = changesOf(tracks.map((tr) => ({ ...tr, follows: false })), { box }).map((c) => { const tr = tracks.find((x) => x.channel === (c.channels?.[0] ?? c.channel)); return { ...c, keys: ownKeys(tr) }; });
  if (stepRec ? leadTrack.T.length <= STEP_FRAMES + 1 : leadTrack.T.length <= STEP_FRAMES) return { ...base, law: { class: 'steps', ms: 0, delayMs: 0 }, changes: changesOf(tracks, { box }), pts: [], dots: [], curve: [], provenance: 'fitted', errorPct: 0, rec: null, axis: null, t0: leadTrack.T[0], leadChannel: leadTrack.channel };
  const law = sampledLaw(leadTrack), start = leadTrack.T[0], span = leadTrack.y.at(-1) - leadTrack.y[0];
  const pts = leadTrack.T.map((t1, i) => [round(t1 - start, 2), round((leadTrack.y[i] - leadTrack.y[0]) / (span || leadTrack.amp), 5)]);
  return { ...base, law, changes, pts, dots: thin(pts, FIT.dotsMax), curve: law.points.slice(0, FIT.curveMax), provenance: 'sampled', errorPct: law.errorPct, rec: null, axis: null, t0: start, leadChannel: leadTrack.channel };
}

/**
 * Hold laws against other runs, all in one take.
 * @param {{dir:string, items:{lawId:number, i:number, s:object, rec:object, x0:number, ref:{T0:number, sy0:number}, axis:string, channel:string}[]}} job
 * @returns {{lawId:number, i:number, errorPct:number|null}[]}
 */
export function checkTake({ dir, items }) {
  const t = take(dir);
  return items.map(({ lawId, i, s, rec, x0, ref, axis, channel }) => {
    const rows = rowsAround(t, s, 2), track = tracksOf(rows, s, /^ren:b[wxyh]$/.test(channel)).find((x) => x.channel === channel);
    if (!track) return { lawId, i, errorPct: null };
    const shift = axis === 'scroll' ? (rowAt(rows, s)?.sy ?? 0) - ref.sy0 : s.T0 - ref.T0;
    const e = lawError(evaluator(rec, { x0 }), track, { shift });
    return { lawId, i, errorPct: e ? round(e.errorPct, 2) : null };
  });
}

/** The page's own scroll law. */
export function fitPageScroll({ dir, k0, k1 }) {
  const t = take(dir), { L } = t, els = L.data.elements || [];
  const pageId = ((L.take.watch || []).find(([id]) => /^HTML\b/.test(els[id] || '')) || [null])[0];
  if (pageId == null) return { none: true };
  const rows = rowsAround(t, { k0, k1 }, 18), res = fitTakeSet({ primary: { ...L, data: { ...L.data, rows: alone(rows, pageId) } } }, { ...PER_MOTION, onlyKeys: [`${pageId}|ren:by`] });
  const rec = res.records.map((r) => anchorMapToSamples(asExportRecord(r))).find((r) => String(r.target.el) === String(pageId) && familyKind(r.model?.family) === 'smoothing');
  if (!rec) return { none: true };
  const ex = exportRecord(rec, { to: ['lenis', 'raf', 'gsap'], meta: {} }), code = (lib) => ex.exports?.find((x) => x.lib === lib)?.code ?? null;
  const tau = rec.model.params?.tau_ms?.value ?? rec.derived?.tau_ms ?? (rec.model.params?.lambda?.value ? 1000 / rec.model.params.lambda.value : null);
  return { tauMs: tau == null ? null : round(tau, 2), lenis: code('lenis'), raf: code('raf'), gsap: code('gsap') };
}
/** What a canvas drew in one take, reduced to what a person can read. */
export function fitScene({ dir }) {
  // glPass reads the whole take itself; here only take.json, or the rows sat in memory twice (5 Nov: 2.4 GB of a 3D portfolio site's 4.8 GB peak)
  const L = loadTake(dir, []), g = fitGl(L, { action: 'load' });
  if (!g) return { none: true };
  // every line and every reason: the agent reads this file, and a list cut at a round number would hide what could not be read
  const lines = (g.lines || []).filter((l) => (l.channels || []).length).map((l) => ({ text: l.text, family: l.family ?? null, channels: l.channels }));
  return { read: !!g.read, lines, camera: g.camera ?? null, programs: (g.programs || []).length, notRead: (g.unknowns || []).map((u) => ({ what: 'WebGL', why: u.reason })) };
}

/** A uniform's motion as a track: `fitTakeSet` on the rows around it, held to the law the way a DOM run is. */
function fitGlTrack(L, rows, c) {
  const track = { channel: c.ch, family: 'uniform', T: c.T, y: c.y, sy: c.T.map(() => 0), raw: c.y, amp: c.amp };
  const step = { law: { class: 'steps', ms: 0, delayMs: 0 }, provenance: 'fitted', pts: [], dots: [], curve: [], errorPct: 0, t0: c.onset, family: null, cut: false };
  if (c.status === 'step' || c.frames <= STEP_FRAMES) return { res: step, ev: null };
  const lo = c.T[0] - BEFORE_MS, hi = c.T.at(-1) + AFTER_MS;
  const view = { ...L, data: { ...L.data, rows: rows.filter((r) => r.T >= lo && r.T <= hi).map((r) => ({ ...r, v: {} })) } };
  let recs = [], cut = false, failed = null;
  try {
    const res = fitTakeSet({ primary: view }, { ...PER_MOTION, onlyKeys: [c.key] });
    recs = res.records.filter((r) => r.target.channel === c.ch).map((r) => guardPhysical(anchorMapToSamples(asExportRecord(r))));
    cut = (res.flags || []).some((f) => /budget/.test(f.id));
  } catch (e) { failed = String(e && e.message).slice(0, 200); }
  let best = null;
  for (const rec of recs) {
    if (familyKind(rec.model.family) === 'scroll map') continue;
    const ev = evaluator(rec, { x0: c.y[0] }); if (!ev || ev.axis !== 'time') continue;
    const e = lawError(ev, track); if (e && (!best || e.errorPct < best.e.errorPct)) best = { rec, ev, e };
  }
  if (best && holds(best.e)) {
    const onset = best.ev.t0 + best.e.shift - DT, i = track.T.findIndex((t) => t >= onset);
    const on = i <= 0 ? track : { ...track, T: track.T.slice(i), y: track.y.slice(i), sy: track.sy.slice(i), raw: track.raw.slice(i) };
    const pts = pointsOf(on, best.ev, best.e), law = lawOf(best.rec, best.ev, pts);
    if (law) return { ev: best.ev, res: { law, provenance: best.rec.tier === 'declared' ? 'declared' : 'fitted', pts, dots: thin(pts, FIT.dotsMax), curve: curveOf(best.ev, law.ms), errorPct: round(best.e.errorPct, 2), t0: best.ev.t0 + best.e.shift, family: best.rec.model.family, cut, failed } };
  }
  const law = sampledLaw(track), start = track.T[0], span = track.y.at(-1) - track.y[0];
  const pts = track.T.map((t1, i) => [round(t1 - start, 2), round((track.y[i] - track.y[0]) / (span || track.amp), 5)]);
  return { ev: null, res: { law, provenance: 'sampled', pts, dots: thin(pts, FIT.dotsMax), curve: law.points.slice(0, FIT.curveMax), errorPct: law.errorPct, t0: start, family: best?.rec.model.family ?? recs[0]?.model?.family ?? null, rejectedPct: best ? round(best.e.errorPct, 1) : null, cut, failed } };
}
const glValue = (v) => round(v, 4);
const glProperty = (c) => (c.camera ? `camera.${c.camera}` : `${uniformName(c.comp != null ? c.ch.replace(/\.[xyzw]$/, '') : c.ch)}${c.comp != null ? `.${'xyzw'[c.comp]}` : ''}`);
/**
 * The WebGL uniforms one move's window holds (glmove.js), each fitted on its own rows. `s`: the move's first instance.
 * @returns {{groups:object[], left:{channel:string, why:string}[], leftCount:number}|{none:true}}
 */
export function fitGlMove({ dir, s }) {
  const started = Date.now(), t = take(dir), { L } = t, gl = L.take.gl;
  if (!gl?.contexts?.length || s?.k0 == null || !Number.isFinite(s.T0)) return { none: true };
  const T0 = s.T0, T1 = Math.min(s.T1 ?? s.T0, s.T0 + GLM.maxWindowMs), Tend = Math.min(T1 + GLM.tailMs, T0 + GLM.maxWindowMs);
  // object matrices read as positions of their program, so a text or a mesh that moves in the window is a channel like a uniform
  const val0 = (x) => (x && typeof x === 'object' && 'value' in x ? x.value : x), env0 = L.take.env || {};
  const vp0 = { width: val0(env0.innerWidth) ?? val0(env0.viewport)?.width, height: val0(env0.innerHeight) ?? val0(env0.viewport)?.height };
  // a worker's WebGL (series glWorker) joins the rows on its frames, so its uniforms and draws read like the page's
  let wrows = []; try { if (L.take.series?.glWorker) wrows = loadTake(dir, ['glWorker']).data.glWorker || []; } catch { wrows = []; }
  const rows = withObjectPositions(withWorkerRows(rowsAround(t, { k0: s.k0, k1: s.k0 + framesFor(Tend - T0), el: null }, framesFor(GLM.preMs)), wrows), vp0);
  if (!rows.some((r) => r.gl)) return { none: true };
  const channels = glChannelsIn(rows, { T0, T1, Tend, perDraw: perDrawKeys(gl.counters) }), clocks = glClocksOf(channels);
  // who drew what, where, in the window: a program that does not draw is hidden, whatever its uniforms say
  const draws = drawsOf(rows.filter((r) => r.T >= T0 - GLM.preGapMs && r.T <= Tend)), passes = passesOf(draws, gl, T0);
  const drawnOf = (program) => (draws ? mergedOf(draws.get(program)?.windows || []).map(([a, b]) => [round(a - T0, 1), round(b - T0, 1)]) : null);
  const { kept, left, leftCount } = glUniformsOf(channels);
  let programs = []; try { programs = loadTake(dir, ['glPrograms']).data.glPrograms || []; } catch { programs = []; }
  // what a rebuild needs beside the motion: every value the drawn programs read, their shader source (one copy per source), when the
  // drawn set changes, and where each canvas sits among the page's layers
  const drawnIds = draws ? [...draws.keys()] : [...new Set(channels.filter((c) => c.glKey).map((c) => `p${parseKey(c.glKey).prog}`))];
  const sources = programSourcesOf(drawnIds, programs, (x) => crypto.createHash('sha256').update(x).digest('hex'));
  const values = programValuesOf(rows, { programs, draws, channels, kept, T0, Tend, counters: gl.counters, sources });
  const events = drawEventsOf(rows, { T0, Tend });
  const ctxIds = new Set(drawnIds.map((p) => programs.find((x) => `p${x.id}` === p)?.ctx).filter((x) => x != null));
  const canvases = canvasPlacesOf(gl, rowAt(rows, s), L.take.selectors || [], ctxIds.size ? ctxIds : null);
  // the canvas layer: the largest canvas a pass drew onto in the window, its engine from the shader sources, its first program switch
  const vpL = { width: vp0.width, height: vp0.height, dpr: val0(env0.dpr) || 1 }, atRow = rowAt(rows, s);
  const onCanvas = new Set((passes || []).filter((x) => x.into.includes('canvas')).map((x) => programs.find((q) => `p${q.id}` === x.program)?.ctx).filter((x) => x != null));
  // each canvas's largest cover over the window (sampled every 6th row): a canvas may be sized or shown only once its pass starts
  const coverIn = (c) => { let best = coverOf(c, atRow, vpL) ?? 0; for (let i = 0; i < rows.length; i += 6) if (rows[i].T >= T0 && rows[i].T <= Tend) best = Math.max(best, coverOf(c, rows[i], vpL) ?? 0); return best; };
  const layerCtx = gl.contexts.filter((c) => onCanvas.has(c.id) || (!passes && gl.contexts.length === 1)).map((c) => ({ c, cover: coverIn(c) })).sort((a, b) => b.cover - a.cover)[0];
  const layer = layerCtx ? { ctx: layerCtx.c.id, cover: layerCtx.cover, engine: engineOfSources(sources.list), ...(events?.events.length ? { switchAtMs: events.events[0].atMs } : {}) } : null;
  const geometry = geometryOf(rows, gl, { T0, Tend });
  const extra = { values, sources: sources.list, ...(events?.events.length ? { events } : {}), canvases, ...(layer ? { layer } : {}), ...(geometry?.list.length ? { geometry } : {}) };
  if (!kept.length) return { groups: [], left, leftCount, clocks, passes, ...extra, ms: Date.now() - started };
  const val = (x) => (x && typeof x === 'object' && 'value' in x ? x.value : x), env = L.take.env || {};
  const viewport = { width: val(env.innerWidth) ?? val(env.viewport)?.width, height: val(env.innerHeight) ?? val(env.viewport)?.height, dpr: val(env.dpr) || 1 }, at = rowAt(rows, s);
  const groups = kept.map(({ uniform, lead, rest }) => {
    const p = programOf(lead.glKey, programs, gl.counters), ctx = gl.contexts.find((c) => c.id === p.ctx) ?? (gl.contexts.length === 1 ? gl.contexts[0] : null);
    const sel = ctx ? (L.take.selectors || []).find((x) => x[0] === ctx.el)?.[1] ?? null : null;
    const { res, ev } = fitGlTrack(L, rows, lead);
    const change = (c, follows) => ({ property: glProperty(c), channel: c.ch, family: 'uniform', unit: c.camera && /^(fov|r[xyz])$/.test(c.camera) ? 'deg' : /\.screen(@p\d+)?\.[xy]$/.test(c.ch) ? 'px' : '', from: glValue(c.from), to: glValue(c.to), raw: { from: glValue(c.from), to: glValue(c.to) }, follows });
    // a component follows the lead's law when the law holds on it; a step follows a step on the same frame
    const follows = (c) => (res.law.class === 'steps' ? c.onset === lead.onset : !!ev && holds(lawError(ev, { T: c.T, y: c.y, sy: c.T.map(() => 0) })));
    // a component that does not follow the lead's law keeps its own recorded stops (ms since its own first frame, at T0 of the take)
    const own = (c) => { const ch = change(c, follows(c)); if (ch.follows) return ch; const { keys } = reduceTrack(c.T.map((x) => x - c.T[0]), c.y); return { ...ch, keys, keysT0: round(c.T[0], 2) }; };
    const changes = [change(lead, true), ...rest.map(own)];
    return { uniform, name: uniformName(uniform), channel: lead.ch, channels: [lead.ch, ...rest.map((c) => c.ch)], frames: Math.round((lead.end - lead.onset) / DT) + 1, k0: rows.find((r) => r.T >= lead.onset - T_SLACK)?.k ?? null,
      // its cover when it moves: a canvas sized only when its pass starts (a shader-transition site: 0 x 0 until the click's shader, 1440 x 900 from then)
      program: p.program, ctx: ctx?.id ?? null, selector: sel, cover: coverOf(ctx, rows.find((r) => r.T >= lead.onset - T_SLACK) || at, viewport), technique: p.technique, items: p.items, drawn: drawnOf(p.program), changes, ...res };
  });
  return { groups, left, leftCount, clocks, passes, ...extra, ms: Date.now() - started };
}

/** One message's work. Exported for the worker file. */
export function runJob(job) {
  if (job.type === 'glmove') return fitGlMove(job);
  if (job.type === 'fit') return fitExemplar(job);
  if (job.type === 'check') return checkTake(job);
  if (job.type === 'page') return fitPageScroll(job);
  if (job.type === 'gl') return fitScene(job);
  throw new Error(`no job ${job.type}`);
}

// ---------------------------------------------------------------- the pool
/**
 * Run jobs on worker threads, a worker keeping to one take while it can. `workers: 0` runs them here, in order.
 * heapMb caps each worker's old generation. A fit throws away far more than it keeps (a large marketing site, whole rows: 2.2-2.7 GB of heap
 * after a job, 12-26 MB of it still live), and V8 lets a heap grow to its own limit before it collects. With a cap a worker
 * collects early (a large marketing site, one element's rows: 5.0 GB for the whole fit without a cap, 4.1 GB with 512 MB). A job that runs
 * out of heap under the cap runs again alone without it, so the cap changes memory and never a result.
 */
async function runAll(jobs, { workers, limitMs = JOB_LIMIT_MS, heapMb = WORKER_HEAP_MB, onJob = () => {} }) {
  const out = new Array(jobs.length);
  if (!workers) { jobs.forEach((j, i) => { try { out[i] = runJob(j); } catch (e) { out[i] = { error: String(e && e.message) }; } onJob(); }); return out; }
  const left = jobs.map((j, i) => ({ j, i }));
  const next = (dir) => { let at = left.findIndex((x) => x.j.dir === dir); if (at < 0) at = 0; return left.splice(at, 1)[0]; };
  await Promise.all(Array.from({ length: Math.min(workers, jobs.length) }, () => new Promise((done) => {
    // again: a job that ran out of heap under the cap; this worker runs it with no cap, then makes way for a capped one
    let cap = heapMb;
    const spawn = (again = null) => {
      const w = new Worker(new URL('./fitworker.js', import.meta.url), cap && !again ? { resourceLimits: { maxOldGenerationSizeMb: cap } } : {});
      let cur = null, timer = null, dir = null;
      const give = () => {
        clearTimeout(timer);
        if (again && cur) { cur = null; w.terminate(); spawn(); return; }
        if (!again && !left.length) { cur = null; w.terminate().then(done, done); return; }
        cur = again || next(dir); dir = cur.j.dir;
        timer = setTimeout(() => { const c = cur; cur = null; out[c.i] = { error: `stopped after ${Math.round(limitMs / 1000)} s` }; onJob(); w.terminate(); spawn(); }, limitMs);
        w.postMessage(cur.j);
      };
      w.on('message', (m) => { if (m.ready) { give(); return; } clearTimeout(timer); if (cur) { out[cur.i] = m.error ? { error: m.error } : m.result; onJob(); } give(); });
      w.on('error', (e) => {
        clearTimeout(timer);
        if (e.code === 'ERR_WORKER_OUT_OF_MEMORY' && !again && cap) { if (!cur) { cap = 0; spawn(); return; } const c = cur; cur = null; spawn(c); return; }   // no job yet: the cap is too small to start
        if (cur) { out[cur.i] = { error: String(e.message).slice(0, 300) }; onJob(); cur = null; }
        spawn();
      });
    };
    spawn();
  })));
  return out;
}

// ---------------------------------------------------------------- one move, in full
/** Which part of a test a group answers, and when it starts: from the run of this group the fit list holds, when it holds one. */
function placeGroup(doc, g, law) {
  const inst = doc.instances?.[0], marks = inst?.marks; if (!inst) return {};
  const on = (law?.sample || []).filter((x) => x.page === inst.page && x.viewport === inst.viewport && x.take === inst.take && selectorGroup(x.key) === g.selector);
  const s = marks?.in != null ? on.find((x) => x.k0 >= marks.in - 1) ?? on[0] : on[0];
  if (!s) return {};
  const k = s.k0, part = !marks ? null : marks.out != null && k >= marks.out ? 'out' : marks.press != null && k >= marks.press ? 'press' : 'in';
  return { part, k0: k };
}
/** The class's law on this group's own ends: the lead channel keeps what this group's lead run did. */
function ownEnds(changes, g, res) {
  const lead = g.lead; if (!lead || lead.from == null || lead.to == null || !res.leadChannel) return changes;
  return changes.map((c) => {
    if ((c.channels?.[0] ?? c.channel) !== res.leadChannel && !c.channels?.includes(res.leadChannel)) return { ...c, fromExemplar: true };
    if (typeof c.from !== 'number' || typeof c.to !== 'number' || (lead.part && lead.part !== '')) return c;
    const a = c.raw?.from ?? c.from, b = c.raw?.to ?? c.to;
    if (Math.abs(a - lead.from) <= 1e-2 * Math.abs(b - a) && Math.abs(b - lead.to) <= 1e-2 * Math.abs(b - a)) return c;
    const scale = (v) => (b === a ? v : round(lead.from + ((v - a) * (lead.to - lead.from)) / (b - a), 4));
    return { ...c, from: lead.from, to: lead.to, raw: { from: lead.from, to: lead.to }, percent: undefined, ...(c.keys ? { keys: c.keys.map(([x, v]) => [x, typeof v === 'number' ? scale(v) : v]) } : {}) };
  });
}

function groupFor(entry, doc, g, res, lawDoc, stats) {
  const place = placeGroup(doc, g, lawDoc);
  const own = res.extra?.find((x) => x.selector === g.selector && x.take === doc.instances?.[0]?.take);
  const r = own?.res ?? res;
  if (r.none || !r.law) return { ...g, provenance: 'seen', law: null, fit: { rmsPct: null, runnerUp: null, cut: !!r.cut }, checked: null, place };
  const part = place.part === 'in' ? undefined : place.part === 'out' && entry.kind === 'open' ? 'close' : place.part ?? undefined;
  if (!stats.seen.has(g.lawClass)) { stats.seen.add(g.lawClass); stats[r.provenance === 'sampled' ? 'sampled' : 'fitted']++; if (r.cut) stats.cut++; }
  const checks = res.checks ?? null;
  return {
    ...g, law: r.law, provenance: r.provenance,
    changes: ownEnds(r.changes, g, r), part, place, pts: r.pts, scrollAt: r.mapScroll ?? null,
    fit: { rmsPct: r.errorPct, runnerUp: r.law.runnerUp ?? null, cut: !!r.cut, family: r.family ?? null, ...(r.rejectedPct != null ? { rejectedPct: r.rejectedPct } : {}), ...(r.failed ? { failed: r.failed } : {}) },
    dots: r.dots, curve: r.curve, t0: r.t0, clipT0: null,
    checked: checks ? { instances: checks.instances, worstPct: checks.worstPct, split: checks.split, ownFit: checks.ownFit } : null,
  };
}

const persist = ({ pts, place, scrollAt, ...g }) => g;

/** The WebGL groups of a move, as moves/<id>.json holds them: a layer of the move, on its canvas, with the law of its uniform. */
function glGroupDocs(gl) {
  return (gl?.groups || []).map((r) => {
    const c = r.changes[0];
    return {
      name: `WebGL ${r.name}`, role: 'part', layer: 'gl', count: 1, total: 1, lawClass: null,
      selector: r.selector || 'canvas', selectors: [r.selector || 'canvas'], elements: ['CANVAS'], stagger: null,
      lead: { channel: r.channel, part: null, from: c.from, to: c.to, frames: r.frames, px: null }, channels: r.channels, spans: Object.fromEntries(r.channels.map((x) => [x, r.frames])),
      gl: { uniform: r.name, program: r.program, ctx: r.ctx, cover: r.cover, technique: r.technique, items: r.items, ...(r.drawn ? { drawn: r.drawn } : {}) },
      changes: r.changes, law: r.law, provenance: r.provenance,
      fit: { rmsPct: r.errorPct, runnerUp: r.law.runnerUp ?? null, cut: !!r.cut, family: r.family ?? null, ...(r.rejectedPct != null ? { rejectedPct: r.rejectedPct } : {}), ...(r.failed ? { failed: r.failed } : {}) },
      dots: r.dots, curve: r.curve, t0: r.t0, clipT0: null, checked: null, pts: r.pts, place: r.k0 == null ? {} : { k0: r.k0 },
    };
  });
}

/** The moves entry and file of one move, finished. */
function finishMove(entry, doc, laws, stats, gl = null) {
  const dom = (doc.groups || []).filter((g) => !isGlGroup(g)).map((g) => { const res = laws.get(g.lawClass); return res ? groupFor(entry, doc, g, res, res.doc, stats) : { ...g, provenance: 'seen', law: null, checked: null }; });
  // a page change sets the new page at once: those groups are its state, kept as data, never its motion
  if (entry.kind === 'change') for (const g of dom) { if (g.law?.class === 'steps') g.state = 'new page'; else delete g.state; }
  // the largest visible layer leads: a WebGL pass over most of the screen comes before the DOM
  // the WebGL group that leads is the first that may (a fitted tween or spring over most of the screen), not merely the first in time
  const glGroups = glGroupDocs(gl), at = glGroups.findIndex(glLeads), glFirst = at >= 0;
  if (at > 0) glGroups.unshift(...glGroups.splice(at, 1));
  if (glFirst) { glGroups[0].role = 'lead'; for (const g of dom) if (g.role === 'lead') g.role = 'part'; }
  const groups = glFirst ? [...glGroups, ...dom] : [...dom, ...glGroups];
  const first = new Map();
  for (const g of groups) { if (g.place?.k0 == null) continue; const k = g.part ?? 'in'; first.set(k, Math.min(first.get(k) ?? Infinity, g.place.k0)); }
  for (const g of groups) { if (g.place?.k0 == null) continue; const d = (g.place.k0 - first.get(g.part ?? 'in')) * DT; if (d > 0) g.delayMs = round(d, 1); }
  const leaving = (g) => g.part === 'out' || g.part === 'close';
  const said = groups.filter((g) => !leaving(g));
  const lead = (entry.kind === 'cursor' ? followGroup(said) : null) ?? leadGroup(groups);
  const scroll = lead?.scrollAt ?? (entry.trigger?.scroll?.start ? entry.trigger.scroll : null);
  if (lead?.scrollAt && entry.trigger?.scroll) entry.trigger.scroll = { ...entry.trigger.scroll, ...lead.scrollAt };
  const spec = { kind: entry.kind, trigger: entry.trigger, scroll, groups: lead ? [lead, ...groups.filter((g) => g !== lead)] : groups, name: entry.name, technique: entry.technique, ...(gl?.layer && !glFirst ? { glLayer: gl.layer } : {}) };
  const sentence = sentenceOf(spec, spec.groups.filter((g) => !leaving(g)).map((g) => ({ ...g, part: g.part === undefined ? entry.trigger?.kind : g.part })));
  const glLeft = gl?.left?.length ? { count: gl.leftCount ?? gl.left.length, list: gl.left } : null;
  // the clocks of the programs that ran in the window: their origin at the move's start shapes what a shader draws
  const glClocks = gl?.clocks?.length ? gl.clocks : null, glPasses = gl?.passes?.length ? gl.passes : null;
  const glExtra = { ...(glLeft ? { glLeft } : {}), ...(glClocks ? { glClocks } : {}), ...(glPasses ? { glPasses } : {}),
    ...(gl?.layer ? { glLayer: gl.layer } : {}), ...(gl?.values?.length ? { glValues: gl.values } : {}), ...(gl?.sources?.length ? { glSources: gl.sources } : {}), ...(gl?.events ? { glEvents: gl.events } : {}), ...(gl?.canvases?.length ? { glCanvases: gl.canvases } : {}), ...(gl?.geometry ? { glGeometry: gl.geometry } : {}) };
  if (sentence) entry.sentence = sentence;
  // nothing a person sees: kept in moves.json and its file, left off the card (card/moves.js cardIndex)
  const not = notAMove(spec.groups.filter((g) => !leaving(g)));
  if (not) entry.notMove = not; else delete entry.notMove;
  if (!lead?.law) {
    entry.curve = { kind: 'none' }; entry.proof = proofOf({ source: 'seen' }); entry.gap = entry.gap ?? GAPS.noRows;
    return { entry, doc: { ...doc, groups: groups.map(persist), ...glExtra } };
  }
  const { code, timing, prompt, proofLine: line } = closeMove(entry, spec, { frames: lead.pts?.length || null, gl: glSpecOf(glExtra) });
  const file = { ...doc, groups: groups.map(persist), ...glExtra, timing, code, notes: [...code.notes], prompt, ...(line ? { proofLine: line } : {}) };
  return { entry, doc: file };
}

const write = (file, text) => { const tmp = `${file}.${process.pid}.tmp`; fs.writeFileSync(tmp, text); fs.renameSync(tmp, file); };
export const moveScript = (id, doc) => `window.__move(${JSON.stringify(id)},${safeJson(doc)});\n`;
function writeDoc(out, doc) {
  write(path.join(out, 'moves', `${doc.id}.json`), JSON.stringify(doc));
  write(path.join(out, 'moves', `${doc.id}.js`), moveScript(doc.id, doc));
}
function readFiles(out) {
  const dir = path.join(out, 'moves'), files = new Map();
  for (const n of fs.readdirSync(dir)) if (n.endsWith('.json')) { const d = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')); files.set(d.id, d); }
  return files;
}

/** Scene, video, and the page's own scroll: no law class, their own words. */
function finishPageLevel(entry, doc, extras) {
  if (entry.kind === 'media') { entry.curve = { kind: 'none' }; entry.proof = proofOf({ source: 'seen' }); entry.gap = GAPS.media; return doc; }
  if (entry.kind === 'scene') {
    const g = extras.get(entry.id);
    entry.curve = { kind: 'none' }; entry.proof = proofOf({ source: 'seen' });
    const known = doc.gl?.uniforms?.length ? ` ${new Set(doc.gl.uniforms.map((u) => u.driver)).size > 1 ? 'Several things drive' : 'One thing drives'} its values.` : '';
    entry.gap = `${GAPS.canvas}${known}`;
    return { ...doc, gl: { ...(doc.gl || {}), ...(g && !g.none && !g.error ? { lines: g.lines, camera: g.camera, programs: g.programs, notRead: g.notRead } : {}) } };
  }
  const p = extras.get(entry.id), tau = p?.tauMs;
  if (tau == null) { entry.curve = { kind: 'none' }; entry.proof = proofOf({ source: 'seen' }); entry.gap = entry.time?.ms == null ? GAPS.wheel : GAPS.page; return doc; }
  const law = { class: 'smoothing', ms: round(tau * 5, 1), tauMs: tau, delayMs: 0 };
  const code = { css: '/* CSS cannot smooth the page scroll: it needs JS. */', gsap: p.gsap ?? '// GSAP has no snippet for this law.', motion: p.raf ?? '// Motion has no snippet for this law.', form: 'relative', errorPct: { css: null, gsap: null, motion: null }, notes: [...(p.lenis ? [`With Lenis: ${p.lenis.split('\n').pop()}`] : [])] };
  entry.curve = curveOfLaw(law); entry.proof = proofOf({ source: 'fitted' }); entry.time = { ...entry.time, ms: law.ms };
  const timing = timingLine({ groups: [{ law }], trigger: entry.trigger });
  return { ...doc, timing, code, notes: code.notes, prompt: agentPrompt({ ...entry, timing, groups: [{ name: 'Page', law, changes: [], provenance: 'fitted' }] }) };
}

// ---------------------------------------------------------------- the whole site
/**
 * S8. Reads moves.json, moves/*.json and moves-laws.json in `out`, writes them back filled, with moves/<id>.js for the card.
 * @param {string} out  scan folder
 * @param {{workers?:number, limitMs?:number, log?:function}} [o]  workers: 0 runs in this thread
 * @returns {Promise<{ms:number, fitMs:number, medianFitMs:number|null, classes:number, files:number, ledger:object[], problems:string[]}>}
 */
export async function fitMoves(out, { workers = defaultWorkers(), limitMs = JOB_LIMIT_MS, heapMb = WORKER_HEAP_MB, log = () => {} } = {}) {
  const t0 = Date.now(), index = JSON.parse(fs.readFileSync(path.join(out, 'moves.json'), 'utf8')), files = readFiles(out);
  const laws = JSON.parse(fs.readFileSync(path.join(out, LAWS_FILE), 'utf8')).laws.filter((l) => l.sample?.length);

  // 1. one exemplar per class, sorted by take
  const kindOf = new Map(index.moves.map((m) => [m.id, m.kind]));
  const noMap = (l) => !l.groups.some(([id]) => ['scroll', 'scroll-up', undefined].includes(kindOf.get(id)));
  const fits = laws.map((l) => ({ type: 'fit', dir: takeDir(out, l.sample[0]), s: l.sample[0], lead: l.lead, lawId: l.id, noMap: noMap(l) })).sort((a, b) => a.dir.localeCompare(b.dir));
  const doneFit = await runAll(fits, { workers, limitMs, heapMb });
  const byId = new Map(laws.map((l) => [l.id, l])), results = new Map();
  fits.forEach((f, i) => { const r = doneFit[i]; results.set(f.lawId, r?.error ? { none: true, cut: true, failed: r.error } : r); });
  const fitMs = Date.now() - t0, each = doneFit.map((r) => r?.ms).filter(Number.isFinite).sort((a, b) => a - b), medianFitMs = each[each.length >> 1] ?? null;
  log(`fit ${fits.length} law classes in ${fitMs} ms`);

  // 2. the law check, one batch per take
  const batches = new Map();
  for (const l of laws) {
    const r = results.get(l.id); if (!r?.rec) continue;
    pickInstances(l.sample, l.sample[0]).forEach((s) => {
      const dir = takeDir(out, s), b = batches.get(dir) || batches.set(dir, { type: 'check', dir, items: [] }).get(dir);
      b.items.push({ lawId: l.id, i: l.sample.indexOf(s), s, rec: r.rec, x0: r.x0, ref: { T0: r.T0, sy0: r.sy0 }, axis: r.axis, channel: r.leadChannel });
    });
  }
  const checks = await runAll([...batches.values()], { workers, limitMs, heapMb });
  const failed = new Map();
  for (const list of checks) for (const c of Array.isArray(list) ? list : []) {
    if (c.errorPct == null) continue;
    const r = results.get(c.lawId), k = r.checks || (r.checks = { instances: 0, worstPct: 0, split: 0, ownFit: 0 });
    k.instances++; k.worstPct = Math.max(k.worstPct, c.errorPct);
    if (c.errorPct > FIT.lawCheckShare * 100) { k.split++; k.ownFit = Math.min(k.split, FIT.lawCheckExtraFits); (failed.get(c.lawId) || failed.set(c.lawId, []).get(c.lawId)).push(c.i); }
  }

  // 3. a run the law does not hold on gets its own fit, at most 2 per class
  const extra = [];
  for (const [lawId, idx] of failed) for (const i of idx.slice(0, FIT.lawCheckExtraFits)) { const l = byId.get(lawId), s = l.sample[i]; extra.push({ type: 'fit', dir: takeDir(out, s), s, lead: l.lead, lawId, noMap: noMap(l), selector: selectorGroup(s.key), take: s.take }); }
  const doneExtra = await runAll(extra, { workers, limitMs, heapMb });
  extra.forEach((e, i) => { if (!doneExtra[i] || doneExtra[i].error) return; const r = results.get(e.lawId); (r.extra ||= []).push({ selector: e.selector, take: e.take, res: doneExtra[i] }); });
  for (const l of laws) { const r = results.get(l.id); if (r) r.doc = l; }

  // 4. the page's own scroll and the canvases
  const sideJobs = [];
  for (const m of index.moves) {
    const doc = files.get(m.id), i = doc?.instances?.[0]; if (!i) continue;
    if (m.kind === 'scene') sideJobs.push({ type: 'gl', dir: takeDir(out, i), id: m.id });
    if (m.kind === 'page-scroll' && m.time?.ms != null) sideJobs.push({ type: 'page', dir: takeDir(out, i), k0: i.k0, k1: i.k1, id: m.id });
  }
  // one at a time: a canvas reads its whole take, so two at once held two takes (a 3D portfolio site, 5 Nov: the tree at 5.1 GB when the fit ended)
  const sideDone = await runAll(sideJobs, { workers: Math.min(workers, 1), limitMs, heapMb });
  const extras = new Map(sideJobs.map((j, i) => [j.id, sideDone[i]]));
  // the WebGL in every other move's window: a window of rows each, like a fit, so on all workers, a take opening once
  const glJobs = [];
  for (const m of index.moves) {
    if (!GL_KINDS.has(m.kind)) continue;
    const i = files.get(m.id)?.instances?.[0]; if (i?.k0 == null || !i.take) continue;
    glJobs.push({ type: 'glmove', dir: takeDir(out, i), s: { k0: i.k0, k1: i.k1, T0: i.T0, T1: i.T1 }, id: m.id });
  }
  glJobs.sort((a, b) => a.dir.localeCompare(b.dir));
  const glDone = await runAll(glJobs, { workers, limitMs, heapMb });
  const glOf = new Map(glJobs.map((j, i) => [j.id, glDone[i]?.error || glDone[i]?.none ? null : glDone[i]]));
  log(`WebGL in move windows: ${[...glOf.values()].filter((g) => g?.groups?.length).length} of ${glJobs.length} moves`);

  // 5. every move, then the site
  const perView = new Map(), statsOf = (vp) => perView.get(vp) || perView.set(vp, { fitted: 0, sampled: 0, split: 0, cut: 0, seen: new Set() }).get(vp);
  const fitted = [], seen = new Set();
  const finish = (entry, doc) => {
    const vp = entry.viewport ?? doc.instances?.[0]?.viewport ?? 'desktop', stats = statsOf(vp);
    if (['scene', 'media', 'page-scroll'].includes(entry.kind)) { const d = finishPageLevel(entry, doc, extras); writeDoc(out, d); return d; }
    const r = finishMove(entry, doc, results, stats, glOf.get(entry.id) ?? null);
    writeDoc(out, r.doc); return r.doc;
  };
  for (const entry of index.moves) { const doc = files.get(entry.id); if (!doc) continue; seen.add(entry.id); const d = finish(entry, doc); fitted.push({ kind: entry.kind, groups: d.groups || [] }); }
  // a phone file with no entry of its own: the same work, with an entry that is only written into the file
  for (const [id, doc] of files) {
    if (seen.has(id)) continue;
    const twin = index.moves.find((m) => m.phone?.id === id);
    finish({ id, kind: twin?.kind ?? 'ambient', trigger: twin?.trigger ?? { kind: 'time', parts: [] }, time: {}, name: doc.groups?.[0]?.name ?? '', technique: null, viewport: 'phone' }, doc);
  }
  for (const r of results.values()) if (r?.checks?.split) statsOf(r.doc?.sample?.[0]?.viewport ?? 'desktop').split += r.checks.split;

  const ps = index.moves.find((m) => m.kind === 'page-scroll');
  index.site.feel = feelOf(fitted, { scroll: ps ? { mode: ps.time?.ms == null ? 'wheel-consumed' : 'smoothed', lagMs: extras.get(ps.id)?.tauMs ? null : ps.time?.ms ?? null } : null, smoother: ps?.technique ?? null });
  write(path.join(out, 'moves.json'), JSON.stringify(index));
  const written = [...files.keys()].map((id) => JSON.parse(fs.readFileSync(path.join(out, 'moves', `${id}.json`), 'utf8')));
  const problems = [...indexProblems(index, { stage: 'fit' }), ...written.flatMap((d) => moveFileProblems(d, { stage: 'fit' }))];
  const ledger = [...perView].map(([viewport, { seen, ...s }]) => ({ viewport, ...s }));
  log(`moves written, ${problems.length} problems`);
  return { ms: Date.now() - t0, fitMs, medianFitMs, classes: laws.length, files: files.size, ledger, problems };
}

/**
 * `clipT0` needs the clip's start, so it is written once S9 has ended (DESIGN 4.4).
 * @param {string} out
 * @param {Map<string,number>|Object} starts  move id -> the clip's first frame, ms on the take's clock
 */
export function writeClipT0(out, starts) {
  const get = (id) => (starts instanceof Map ? starts.get(id) : starts[id]);
  for (const n of fs.readdirSync(path.join(out, 'moves'))) {
    if (!n.endsWith('.json')) continue;
    const file = path.join(out, 'moves', n), doc = JSON.parse(fs.readFileSync(file, 'utf8')), at = get(doc.id);
    if (!Number.isFinite(at)) continue;
    // a group that starts before the clip's first picture points at frame 0, and says how far into its motion that frame is
    for (const g of doc.groups || []) {
      const d = Number.isFinite(g.t0) ? g.t0 - at : null;
      g.clipT0 = d == null ? null : round(Math.max(0, d) / 1000, 3);
      if (d != null && d < 0) g.clipLagMs = round(-d, 1); else delete g.clipLagMs;
    }
    writeDoc(out, doc);
  }
}
