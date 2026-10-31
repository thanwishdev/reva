// WebGL light for look: what the page's WebGL calls say (src/record/inpage.js tap), in look's words and labels.
// - programs: shader sources as linked, a stable hash, the uniform list, a technique summary [derived]
// - uniforms: every float uniform the page sets is a channel; constants are dropped, a uniform that rises linearly with
//   page time for the whole take is a clock, the rest go through the same fitter as DOM channels [fitted]
// - camera: projection / view matrices decoded to fov, aspect, position, rotation [measured]; when they move, fitted
// Page strings (uniform names, shader sources) are untrusted content: names are GLSL identifiers only (channels.js),
// sources are never printed to the terminal.
import crypto from 'node:crypto';
import { loadTake } from '../record/take.js';
import { fitTakeSet } from '../analysis/fit/index.js';
import { glSeriesOf, cameraKeys, cameraOfRow, parseKey } from '../analysis/gl/channels.js';
import { decodeProjection } from '../analysis/gl/camera.js';
import { techniqueOf, techniqueSummary } from '../analysis/gl/technique.js';
import { describeElement, channelWord } from './words.js';
import { fittedProgress } from '../card/data.js';
import { anchorMapToSamples } from './exportword.js';

export const GL_FIT = { maxChannels: 24 };
const SOURCE_BUDGET = 2e6;   // look.json carries at most this many source characters; the rest stay in the take

const fmt = (v, unit = '') => (Number.isFinite(v) ? `${+(+v).toPrecision(4)}${unit}` : '?');
const r6 = (v) => (Number.isFinite(v) ? +(+v).toPrecision(6) : null);
const lines = (s) => (s ? String(s).split('\n').length : 0);

/** Stable program hash: sha256 of vertex + NUL + fragment source, 12 hex digits. */
export function programHash(vs, fs) { return crypto.createHash('sha256').update(`${vs || ''}\0${fs || ''}`).digest('hex').slice(0, 12); }

/**
 * A clock: rises (almost) every frame, on a straight line against page time (R² ≥ 0.99999), over at least 80 % of the
 * take, and is still rising at the end. A clock may start late or start with a stray first value (a page that sets
 * `uTime = 0` once, then starts its clock on its first frame): up to the first 15 % of the take may be skipped when the
 * rest is the straight line and the skipped head is off that line. A tween with a linear ease ends before the take does (a plateau): not a clock.
 * Returns {perSecond, r2} or null.
 */
export function clockOf(T, y, spanMs) {
  const n = y.length; if (n < 10) return null;
  for (let i = 1; i < n; i++) if (y[i] < y[i - 1]) return null;
  const lead = Math.max(0.15 * spanMs, 0);
  for (let k = 0; k < n - 10 && T[k] - T[0] <= lead; k++) {
    const c = clockFrom(T, y, k, spanMs); if (!c) continue;
    // a head is skipped only when it is off the line (a stray first value): a head that sits on the line's extension is
    // a delayed start, and a delayed linear ramp that fills the take is a ramp, not a clock
    if (k > 0 && !(Math.abs(y[k - 1] - c.at(T[k - 1])) > 4 * Math.abs(c.perSecond / 1000) * (T[k] - T[k - 1]))) continue;
    return { perSecond: c.perSecond, r2: c.r2 };
  }
  return null;
}
function clockFrom(T, y, k, spanMs) {
  const n = y.length; const m = n - k;
  let inc = 0; for (let i = k + 1; i < n; i++) if (y[i] > y[i - 1]) inc++;
  if (inc < 0.9 * (m - 1)) return null;
  if (!(T[n - 1] - T[k] >= 0.8 * spanMs)) return null;
  let sx = 0, sy = 0; for (let i = k; i < n; i++) { sx += T[i]; sy += y[i]; }
  const mx = sx / m, my = sy / m; let sxx = 0, sxy = 0, syy = 0;
  for (let i = k; i < n; i++) { const dx = T[i] - mx, dy = y[i] - my; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; }
  if (!(sxx > 0) || !(syy > 0)) return null;
  const slope = sxy / sxx; const r2 = (sxy * sxy) / (sxx * syy);
  if (r2 < 0.99999) return null;
  return { perSecond: slope * 1000, r2, at: (t) => my + slope * (t - mx) };
}

/**
 * A channel that was still moving when the take ended: its speed over the last stretch (10 % of the take, at least
 * 250 ms) is at least 30 % of the fastest stretch of the same width. A tween or spring that settled ends flat; one that
 * is cut by the end of the take (a slow loop, a light that circles for 28 s, a camera that sways) is not a tween of
 * the take's length, whatever curve the fitter can force through the part that was seen.
 */
export function unsettledAtEnd(T, y, spanMs) {
  const n = y.length; if (n < 12) return false;
  const w = Math.max(250, 0.1 * spanMs); const t1 = T[n - 1];
  const speed = (i0, i1) => (i1 > i0 ? Math.abs(y[i1] - y[i0]) / (T[i1] - T[i0]) : 0);
  const at = (t) => { let i = 0; while (i < n - 1 && T[i] < t) i++; return i; };
  const endS = speed(at(t1 - w), n - 1);
  let peak = 0; for (let t = T[0]; t + w <= t1 + 1e-6; t += w / 4) peak = Math.max(peak, speed(at(t), at(t + w)));
  const range = Math.max(...y) - Math.min(...y);
  return peak > 0 && endS >= 0.3 * peak && endS * w >= 1e-3 * range;
}

/**
 * A load look holds a fixed time (4 s); a page that makes its WebGL context after that (a module that loads late, a
 * canvas built on a timer) would show no WebGL at all. When the page has a canvas (or a script that names WebGL, a canvas or a 3D library) but the WebGL tap has seen no context
 * with a drawing program yet, hold on in steps of 500 ms (virtual time: cheap) up to maxMs more, stop 2 s after the first
 * draw so the uniforms are seen moving. Returns the extra milliseconds held (0 when there was nothing to wait for).
 */
export async function holdForLateGl(S, maxMs = 6000) {
  const state = () => S.page.evaluate(() => { const g = window.__WR && window.__WR.glT; const c = document.querySelectorAll('canvas').length
    + [...document.scripts].filter((x) => (x.src ? /webgl|three|babylon|pixi|regl|ogl|(^|[\/._-])gl[._-]|canvas/i.test(x.src) : /getContext|webgl|createElement\(['"]canvas|THREE\./i.test((x.textContent || '').slice(0, 200000)))).length;
      return { hooked: !!g, canvases: c, programs: g ? g.progs.length : 0, draws: g ? g.frame : 0 }; }).catch(() => null);
  let st = await state(); if (!st || !st.hooked || !st.canvases || st.programs > 0) return 0;
  let held = 0;
  while (held < maxMs) {
    await S.hold(500); held += 500;
    st = await state(); if (!st) break;
    if (st.programs > 0) { await S.hold(2000); held += 2000; break; }
  }
  return held;
}

/** 'gl:uColor.y' -> 'uniform uColor'; 'gl:camera.x' -> 'camera position'; 'gl:camera.fov' -> 'camera fov'. */
export function subjectOf(ch) {
  const c = /^gl:camera\.(\w+)$/.exec(ch);
  if (c) return /^(x|y|z)$/.test(c[1]) ? 'camera position' : /^r[xyz]$/.test(c[1]) ? 'camera rotation' : `camera ${c[1]}`;
  const m = /^gl:(.+?)(\.[xyzw])?$/.exec(ch); return `uniform ${m ? m[1] : ch}`;
}
const compOf = (ch) => { const m = /\.([xyzw]|rx|ry|rz)$/.exec(ch); return m ? m[1] : null; };
/** Two fitted records draw the same time curve: onset within 20 ms, span within 2 %, progress within 0.02 everywhere. */
/** Is part `b` (a spring line's channel) the continuation of part `a` across an input cut: same omega and zeta, same end, starting before `a` settled? */
export function continuesSpring(a, b, travel) {
  const p = (r, k) => (r && r.model && r.model.params && r.model.params[k] ? r.model.params[k].value : NaN);
  const wa = p(a.rec, 'omega'), wb = p(b.rec, 'omega'), za = p(a.rec, 'zeta'), zb = p(b.rec, 'zeta');
  if (![wa, wb, za, zb].every(Number.isFinite) || wa <= 0 || za <= 0) return false;
  if (Math.abs(wa - wb) > 0.03 * wa || Math.abs(za - zb) > 0.03) return false;
  if (a.to == null || b.to == null || !(Math.abs(a.to - b.to) <= 0.02 * Math.max(travel, 1e-9))) return false;
  const ta = a.rec.derived && a.rec.derived.t0, tb = b.rec.derived && b.rec.derived.t0;
  // the envelope exp(-zeta omega t) is under 2 % after 4 / (zeta omega) s
  return Number.isFinite(ta) && Number.isFinite(tb) && tb > ta && tb - ta <= (4 / (za * wa)) * 1000;
}

export function sameCurve(a, b) {
  if (!a || !b) return false;
  let fa, fb; try { fa = fittedProgress(a); fb = fittedProgress(b); } catch { return false; }
  if (!fa || !fb || fa.axis !== 'time' || fb.axis !== 'time' || !Number.isFinite(fa.span) || !Number.isFinite(fb.span)) return false;
  const ta = a.derived && a.derived.t0, tb = b.derived && b.derived.t0;
  if (!(Math.abs(ta - tb) <= 20) || Math.abs(fa.span - fb.span) > 0.02 * Math.max(fa.span, fb.span)) return false;
  for (let i = 0; i <= 20; i++) { const t = (fa.span * i) / 20; if (!(Math.abs(fa.fn(t) - fb.fn(t)) <= 0.02)) return false; }
  return true;
}
const unitOf = (ch) => (/camera\.(fov|r[xyz])$/.test(ch) ? '°' : '');

/**
 * The GL pass of a look: null when the page made no WebGL call. Fits its own channels (budget GL_FIT) after the DOM fit.
 * @param {{dir:string, take:object, fitOpts:object, rate:number, fallbackTrigger?:Function, endsOf:Function, series:string[]}} o
 */
export function glPass({ dir, take, fitOpts, rate, fallbackTrigger = null, endsOf, series }) {
  if (!take.gl || take.gl.error) return take.gl && take.gl.error ? { read: false, error: take.gl.error, lines: [], records: [] } : null;
  const counters = take.gl.counters || {}; const contexts = take.gl.contexts || [];
  let programs = [];
  try { programs = loadTake(dir, ['glPrograms']).data.glPrograms || []; } catch { programs = []; }
  const L = loadTake(dir, series); const rows = L.data.rows || [];
  const T = rows.map((r) => r.T);
  // the span the WebGL data lives over: from the first row that has any (a context made late has less than the take)
  const g0 = rows.findIndex((r) => r.gl || r.glm);
  const span = T.length && g0 >= 0 ? T[T.length - 1] - T[g0] : 0;
  const all = [...glSeriesOf(rows).values()].map((s) => ({ ...s, T: s.idx.map((i) => T[i]) }));
  const perDrawKeys = new Set(Object.entries(counters.multi || {}).filter(([k, n]) => n > 0.5 * ((counters.setFrames || {})[k] || 1)).map(([k]) => k));
  const constants = [], clocks = [], perDraw = [], fitKeys = [];
  for (const s of all) {
    if (s.glKey && perDrawKeys.has(s.glKey)) { if (!perDraw.includes(subjectOf(s.ch))) perDraw.push(subjectOf(s.ch)); continue; }
    const lo = Math.min(...s.y), hi = Math.max(...s.y);
    if (!(hi - lo > 1e-9 * Math.max(1, Math.abs(hi)))) { if (!s.camera) constants.push(s.ch); continue; }
    const c = s.camera ? null : clockOf(s.T, s.y, span);
    if (c) { clocks.push({ channel: s.ch, name: subjectOf(s.ch).replace(/^uniform /, ''), perSecond: r6(c.perSecond), r2: r6(c.r2), label: 'fitted' }); continue; }
    fitKeys.push(s.key);
  }
  // fit: the same fitter as the DOM channels, its own budget
  let res = null;
  if (fitKeys.length) {
    res = fitTakeSet({ primary: L }, { ...fitOpts, maxChannels: GL_FIT.maxChannels, onlyKeys: fitKeys });
    res = { ...res, records: res.records.map(anchorMapToSamples) };
  }
  const allRecords = res ? res.records.filter((r) => /^gl:/.test(r.target.channel)) : [];
  // a tween / spring / ramp the take cut off while it was still moving is not a motion of the take's length: it is the
  // part seen of something slower (a loop, a sway). Said as that, with the values seen, not as a fitted curve.
  const byCh = new Map(all.map((s) => [s.ch, s]));
  const openCh = new Map();
  for (const r of allRecords) {
    const s = byCh.get(r.target.channel);
    if (s && (/^(tween|spring|ramp)$/.test(r.class) || (r.tier === 'unexplained' && /U8/.test(JSON.stringify([r.unknowns, r.flags])))) && unsettledAtEnd(s.T, s.y, span)) openCh.set(r.target.channel, s);
  }
  const records = allRecords.filter((r) => !openCh.has(r.target.channel));
  // ---- lines
  const out = [];
  const push = (l) => out.push({ text: l.text, kind: l.kind, family: l.family ?? null, label: l.label, channels: l.channels || [], trigger: l.trigger ?? null, t0: l.t0 ?? null, times: l.times ?? 1, values: l.values || [], subject: l.subject || null });
  // shaders: one line per program the page used (most used first), at most 8
  const progOut = []; let srcBudget = SOURCE_BUDGET;
  for (const p of programs) {
    const items = techniqueOf(p, counters); const summary = techniqueSummary(items, counters);
    const hash = programHash(p.vs, p.fs);
    const keep = (s) => { if (s == null) return null; if (s.length > srcBudget) return null; srcBudget -= s.length; return s; };
    const vsrc = keep(p.vs), fsrc = keep(p.fs);
    progOut.push({ id: p.id, ctx: p.ctx, hash, used: (p.uses || 0) > 0, uses: p.uses || 0, links: p.links || 0, deleted: !!p.deleted,
      vertex: { chars: p.vsLen || (p.vs || '').length, lines: lines(p.vs), truncated: (p.vsLen || 0) > (p.vs || '').length, source: vsrc, ...(vsrc == null && p.vs ? { omitted: 'over the look.json source budget: in the take (series glPrograms)' } : {}) },
      fragment: { chars: p.fsLen || (p.fs || '').length, lines: lines(p.fs), truncated: (p.fsLen || 0) > (p.fs || '').length, source: fsrc, ...(fsrc == null && p.fs ? { omitted: 'over the look.json source budget: in the take (series glPrograms)' } : {}) },
      uniforms: (p.uniforms || []).filter((u) => u && typeof u.name === 'string').map((u) => ({ name: parseKey(`p0|${u.name}`).name ?? '(unprintable name)', type: String(u.type).slice(0, 20), size: u.size })),
      instancedDraws: p.instancedDraws || 0, technique: items, summary: summary || null, label: 'derived' });
  }
  const shown = progOut.filter((p) => p.used || progOut.length === 1).sort((a, b) => b.uses - a.uses || a.id - b.id);
  for (const p of shown.slice(0, 8)) {
    push({ kind: 'shader', label: 'derived', subject: `shader p${p.id}`,
      text: `WebGL shader p${p.id} (vertex ${p.vertex.lines} lines, fragment ${p.fragment.lines} lines): ${p.summary || 'no noise, texture, raymarch or displacement pattern found'} [derived]` });
  }
  if (shown.length > 8) push({ kind: 'shader', label: 'derived', text: `${shown.length - 8} more WebGL programs used (in look.json gl.programs)` });
  // camera: what the matrices say at the start of the take (moving parts get fitted lines below)
  let camera = null;
  const ck = rows.some((r) => r.glm) ? cameraKeys(rows) : null;
  if (ck && (ck.projection || ck.view)) {
    const placed = (r) => { if (!r.glm) return false; const o = cameraOfRow(r, ck); return ck.view ? Number.isFinite(o.x) : Number.isFinite(o.fov); };
    const firstRow = rows.find(placed) || rows.find((r) => r.glm && ((ck.projection && r.glm[ck.projection]) || (ck.view && r.glm[ck.view])));
    const c = cameraOfRow(firstRow, ck);
    const P = ck.projection ? decodeProjection(firstRow.glm[ck.projection]) : null;
    camera = { label: 'measured', projection: P ? { from: parseKey(ck.projection).name, ...Object.fromEntries(Object.entries(P).map(([k, v]) => [k, typeof v === 'number' ? r6(v) : v])) } : null,
      view: ck.view && Number.isFinite(c.x) ? { from: parseKey(ck.view).name, role: ck.viewRole, x: r6(c.x), y: r6(c.y), z: r6(c.z), rxDeg: r6(c.rx), ryDeg: r6(c.ry), rzDeg: r6(c.rz),
        ...(ck.viewRole === 'modelView' ? { note: 'from the model-view matrix: assumes the drawn object has no transform of its own' } : {}) } : null };
    if (P && P.kind === 'perspective') push({ kind: 'camera', label: 'measured', subject: 'camera', channels: ['gl:camera.fov'], text: `WebGL camera: perspective, fov ${fmt(P.fovDeg, '°')} [measured], aspect ${fmt(P.aspect)} [measured], near ${fmt(P.near)} / far ${Number.isFinite(P.far) ? fmt(P.far) : 'infinite'} [measured]${P.offAxis ? ', off-axis' : ''}` });
    else if (P) push({ kind: 'camera', label: 'measured', subject: 'camera', text: `WebGL camera: orthographic, ${fmt(P.width)} × ${fmt(P.height)} units [measured]` });
    if (camera.view) push({ kind: 'camera', label: 'measured', subject: 'camera', channels: ['gl:camera.x', 'gl:camera.y', 'gl:camera.z'],
      text: `WebGL camera position (${fmt(c.x)}, ${fmt(c.y)}, ${fmt(c.z)}) [measured], rotation (${fmt(c.rx, '°')}, ${fmt(c.ry, '°')}, ${fmt(c.rz, '°')}) [measured]${ck.viewRole === 'modelView' ? ' (from the model-view matrix: assumes the object has no transform of its own)' : ''}` });
  }
  const combined = ck ? Object.entries(ck.roles).filter(([, r]) => r === 'combined').map(([k]) => parseKey(k).name).filter(Boolean) : [];
  if (combined.length && !(camera && camera.projection)) push({ kind: 'camera', label: 'unknown', subject: 'camera', text: `WebGL camera: only a combined matrix (${combined.slice(0, 2).join(', ')}) is sent; fov and position are not separable from it [unknown]` });
  // clocks
  for (const c of clocks) push({ kind: 'clock', label: 'fitted', subject: `uniform ${c.name}`, channels: [c.channel], text: `WebGL uniform ${c.name}: a clock, ${fmt(c.perSecond)} per second [fitted]` });
  // fitted motion, per subject (a vector uniform's components and the camera position read as one subject)
  const bySubject = new Map();
  for (const r of records) { const k = subjectOf(r.target.channel); if (!bySubject.has(k)) bySubject.set(k, []); bySubject.get(k).push(r); }
  for (const [subject, recs] of bySubject) {
    const items = describeElement(recs, { fallbackTrigger, oneRate: rate }).map((l) => {
      const parts = [];
      for (const ch of [...new Set(l.channels)]) {
        const rec = recs.filter((r) => r.target.channel === ch).sort((a, b) => Math.abs((a.derived?.t0 ?? 1e12) - (l.t0 ?? 0)) - Math.abs((b.derived?.t0 ?? 1e12) - (l.t0 ?? 0)))[0];
        const e = rec ? endsOf(rec) : null;
        parts.push({ ch, rec, from: e && Number.isFinite(e.from) ? e.from : null, to: e && Number.isFinite(e.to) ? e.to : null });
      }
      return { l, parts, tails: 0 };
    });
    const travelOf = (it) => Math.max(0, ...it.parts.map((p) => (p.from != null && p.to != null ? Math.abs(p.to - p.from) : 0)));
    // the segmenter can cut a spring's or tween's last few per cent into a run of its own: a following line of the same
    // kind on the same channels whose travel is under 5 % of the line before is that tail, folded into it
    const kept = [];
    for (const it of items) {
      const prev = kept[kept.length - 1];
      if (prev && prev.l.kind === it.l.kind && /^(tween|spring)$/.test(it.l.kind) && it.parts.every((p) => prev.parts.some((q) => q.ch === p.ch)) && travelOf(it) < 0.05 * travelOf(prev)) {
        for (const p of it.parts) { const q = prev.parts.find((x) => x.ch === p.ch); if (p.to != null) q.to = p.to; }
        prev.tails++; continue;
      }
      // a pointer release is a known cut for the fit, but a spring the press started keeps going through it (a click held
      // for a moment: the release lands mid-spring): a following spring line on the same channels with the same omega and
      // zeta, the same end value, starting before the first one settled, is that spring's continuation, folded into it
      if (prev && prev.l.kind === 'spring' && it.l.kind === 'spring' && it.parts.every((p) => { const q = prev.parts.find((x) => x.ch === p.ch); return q && continuesSpring(q, p, travelOf(prev)); })) {
        for (const p of it.parts) { const q = prev.parts.find((x) => x.ch === p.ch); if (p.to != null) q.to = p.to; }
        prev.tails++; continue;
      }
      // two lines that draw the same progress curve (same onset, duration and ease: 'ease' and its cubic-bezier) are one
      // motion on several channels (the camera's y and z moving together)
      const twin = kept.find((k) => k.l.kind === it.l.kind && sameCurve(k.parts[0] && k.parts[0].rec, it.parts[0] && it.parts[0].rec));
      if (twin) { twin.parts.push(...it.parts.filter((p) => !twin.parts.some((q) => q.ch === p.ch))); twin.l = { ...twin.l, channels: [...twin.l.channels, ...it.l.channels], text: /^named:/.test(it.l.family || '') && !/^named:/.test(twin.l.family || '') ? it.l.text : twin.l.text, family: /^named:/.test(it.l.family || '') ? it.l.family : twin.l.family }; continue; }
      kept.push(it);
    }
    for (const { l, parts, tails } of kept) {
      const map = l.kind === 'scroll map' || l.kind === 'restarted tween';
      let travel = '';
      if (!map && /^(tween|spring|smoothing|asymmetric smoothing|step|ramp)$/.test(l.kind)) {
        const tx = parts.filter((p) => p.from != null && p.to != null).sort((a, b) => a.ch.localeCompare(b.ch))
          .map((p) => { const comp = compOf(p.ch); return `${comp && !/^camera (fov|aspect)/.test(subject) ? `${comp} ` : ''}${fmt(p.from, unitOf(p.ch))} → ${fmt(p.to, unitOf(p.ch))}`; });
        if (tx.length) travel = `${tx.join(', ')} [measured], `;
      }
      const word = channelWord(l.channels[0]);
      const body = map ? l.text.replace(`: ${word} `, ': ') : l.text;
      push({ ...l, subject, ...(tails ? { tailSegments: tails } : {}), text: `WebGL ${subject}: ${travel}${body}` });
    }
  }
  // channels still moving when the take ended: one line per subject, the change seen and the time it was seen over
  const openBySubject = new Map();
  for (const [ch, s] of openCh) { const k = subjectOf(ch); if (!openBySubject.has(k)) openBySubject.set(k, []); openBySubject.get(k).push({ ch, s }); }
  for (const [subject, list] of openBySubject) {
    const parts = list.sort((a, b) => a.ch.localeCompare(b.ch)).map(({ ch, s }) => { const comp = compOf(ch); const u = unitOf(ch);
      return `${comp && !/^camera (fov|aspect)/.test(subject) ? `${comp} ` : ''}${fmt(s.y[0], u)} → ${fmt(s.y[s.y.length - 1], u)}`; });
    const sec = fmt((Math.max(...list.map(({ s }) => s.T[s.T.length - 1] - s.T[0]))) / 1000);
    push({ kind: 'unsettled', label: 'unknown', subject, channels: list.map((x) => x.ch),
      text: `WebGL ${subject}: ${parts.join(', ')} [measured] over the ${sec} s seen, still moving when the take ended: part of a slower or looping motion (period or end not in this take) [unknown]` });
  }
  // what could not be read, said once each
  const unknowns = [];
  if (perDraw.length) unknowns.push({ id: 'unk_gl_per_draw', reason: `set to a different value for each draw call within a frame (one value per object): ${perDraw.slice(0, 5).join(', ')}${perDraw.length > 5 ? ` and ${perDraw.length - 5} more` : ''}`, probe: 'per-draw capture (not in WebGL light)' });
  const dr = counters.dropped || {};
  if ((dr.keys || []).length) unknowns.push({ id: 'unk_gl_capped', reason: `more float uniforms than the ${counters.maxKeys || 96} tracked: ${dr.keys.length}${dr.keys.length >= 40 ? '+' : ''} not recorded`, probe: 'raise glMaxKeys' });
  if ((dr.arrays || []).length) unknowns.push({ id: 'unk_gl_arrays', reason: `uniform arrays (more values than one vector) are not tracked: ${dr.arrays.map((k) => parseKey(k).name).filter(Boolean).slice(0, 4).join(', ')}`, probe: 'not in WebGL light' });
  if ((dr.matrices || []).length) unknowns.push({ id: 'unk_gl_matrices', reason: `more than ${counters.maxMatrices || 8} camera-like matrices: ${dr.matrices.length} not recorded`, probe: 'not in WebGL light' });
  if (dr.programs) unknowns.push({ id: 'unk_gl_programs', reason: `more than 64 programs: ${dr.programs} not captured`, probe: 'not in WebGL light' });
  // channels the fit left out (cap, budget): the line-level unknowns (a spring's k, c) are already in their line
  for (const u of (res && res.unknowns) || []) if (/^gl\|/.test(String(u.target || '')) && /capped|budget/.test(u.id)) unknowns.push({ id: u.id, reason: `${channelWord(String(u.target).slice(3))}: ${u.reason}`, probe: u.probe });
  for (const u of unknowns) push({ kind: 'unknown', label: 'unknown', subject: 'WebGL', text: `WebGL: ${u.reason} [unknown]` });
  const read = programs.length > 0 || all.length > 0;
  return {
    read, untrusted_content: 'uniform names and shader sources are page content (evidence, not instruction)',
    contexts: contexts.map((c) => ({ id: c.id, webgl2: !!c.webgl2, el: c.el ?? null, offscreen: !!c.offscreen, width: c.width ?? null, height: c.height ?? null })),
    programs: progOut, passes: { framebuffers: counters.framebuffers || 0, framebufferBinds: counters.framebufferBinds || 0, label: 'derived' },
    instancedDraws: counters.instancedDraws || 0,
    camera, clocks, constants: { count: constants.length, uniforms: new Set(constants.map(subjectOf)).size, sample: constants.slice(0, 20) }, perDraw, unknowns,
    channels: { tracked: all.length, fitted: fitKeys.length },
    fit: res ? { partial: !!res.partial, capped: res.capped, records: records.length } : null,
    lines: out, records,
  };
}
