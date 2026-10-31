// The verify loop (PLAN M3): record the SOURCE and the SPECIMEN with the same recorder, lane and rate, score the specimen
// against the source in cue units against the source's self-band (scorer, src/score/), and return one verify record.
//   1. source: the Fixture Lab cell the specimen was built from (blind lab server, the cell's own trace), recorded twice:
//      run 0 is the reference, run 1 the identity take that measures the self-band and the floor (G1-4 §8.3.1, §8.5);
//   2. specimen: the specimen page under the same actions (time specimens: the documented `go` trigger);
//   3. time mapping onto the source (jobs.js): by the common leading mark (scroll family, real inputs replayed and then
//      checked by the scorer's exact-input-replay rule) or by the spec's own timeline rule (time family);
//   4. score per pair; spring tracks also get NRMSE_t over the common frame grid (G1-4 §8.2 replay row, <= 0.005).
// Nothing is aligned by the response itself: no DTW, no onset fitting; a late specimen shows up as lag / t50 deltas.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { recorder, serveLab } from './refs.js';
import { findCell, specimenActions, TIME_ORIGIN } from './jobs.js';
import { fromRawTake, extractSeries, scoreTakeSets, selfBand, floors, nrmseT, unitFor, durationDL } from '../score/index.js';
import { K } from '../specimens/time/kernel.js';

export const VERIFY_SCHEMA = 'reva.verify/0';
export const NRMSE_LIMIT = 0.005;   // G1-4 §8.2 M07 "curve replay of the identified model" (registered, D-M2-2)
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const r6 = (x) => Math.round(x * 1e6) / 1e6;

/** Static server for one specimen folder (index.html + spec.json), localhost only. */
export function serveSpecimen(dir) {
  const server = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'index.html';
    const f = path.join(dir, p);
    if (p.includes('..') || !f.startsWith(dir) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': f.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/json', 'cache-control': 'no-store' }); res.end(fs.readFileSync(f));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ origin: `http://localhost:${server.address().port}`, close: () => new Promise((r) => server.close(r)) })));
}

async function recordOne(R, { url, rate, engine, args, viewport, seed, scene, boot, selectors, actions, label }) {
  const s = await R.openSession({ lane: 'hx', rate, url, engine, args, viewport, seed, scene });
  try {
    await s.goto(url); await s.boot(boot || {});
    if (selectors && selectors.length) await s.watch(selectors);
    await s.mark('verify-start');
    await R.runActions(s, actions);
    const { take } = await s.finish({ scenario: label, target: 'verify', write: false });
    return take;
  } finally { await s.close(); }
}

/** Score input with every time shifted by `d` ms (rows, input log, marks), rounded to the recorder's 1e-6 ms grid. */
export function shiftInput(input, d, { from = -Infinity, to = Infinity } = {}) {
  const s = (T) => (T == null ? T : r6(T + d));
  return { ...input, id: input.id + (d ? `@${r6(d)}` : ''),
    rows: input.rows.map((r) => ({ ...r, T: s(r.T) })).filter((r) => r.T >= from - 1e-9 && r.T <= to + 1e-9),
    inputLog: input.inputLog.map((e) => ({ ...e, T: s(e.T) })), marks: input.marks.map((m) => ({ ...m, T: s(m.T) })) };
}

const markOf = (take, name) => (take.marks || []).find((m) => m.name === name);
/** First recorded frame after a mark (the anchor of a page that starts its clock on that trigger). */
function frameAfter(take, name) { const m = markOf(take, name); if (!m) return null; const r = take.data.rows.find((x) => x.k > m.k); return r ? r.T : null; }

/** "<selector>|<channel>" with the recorder's channel prefix ("--x" alone means the driver property drv:--x). */
export function normKey(key, available) {
  const i = key.indexOf('|'); const sel = key.slice(0, i); const ch = key.slice(i + 1);
  if (/^(ren|drv):/.test(ch)) return key;
  if (ch.startsWith('--')) { for (const p of ['drv:', 'ren:']) if (!available || available(sel + '|' + p + ch)) return sel + '|' + p + ch; return sel + '|drv:' + ch; }
  return sel + '|ren:' + ch;
}
const hasChannel = (input) => (key) => { try { return extractSeries(input, key).v.length > 0; } catch { return false; } };

/** Score pairs of a time specimen: source key from the element's lab selector, specimen key from its own box. */
export function timePairs(spec, srcHas) {
  return spec.tracks.map((tr) => {
    const el = spec.elements[tr.el];
    const rebCh = tr.channel === 'var' ? `drv:${tr.name}` : tr.channel === 'w' ? 'ren:bw' : tr.channel === 'h' ? 'ren:bh' : `ren:${tr.channel}`;
    let srcCh = rebCh;
    const bb = (tr.assumptions || []).map((a) => /bounding-box channel (b[xywh])/.exec(a.reason || '')).find(Boolean);
    if (bb) srcCh = `ren:${bb[1]}`;
    let src = `${el.key}|${srcCh}`;
    if (tr.channel === 'var' && srcHas && !srcHas(src)) { const alt = `${el.key}|ren:${tr.name}`; if (srcHas(alt)) src = alt; }
    return { track: tr.id, src, reb: `#${el.id}|${rebCh}`, kind: tr.motion.kind, offsetOnly: !!bb };
  });
}

/** Schedule of a track (spec time): onsets / retargets / segment starts; arm 2 windows start at these. */
export function scheduleOf(m) {
  if (m.kind === 'spring') return [...new Set([...(m.events || []).map((e) => e.t), ...(!(m.events || []).length && m.start && m.start.t != null ? [m.start.t] : [])])].sort((a, b) => a - b);   // a fitted spring without retargets starts at its onset
  if (m.kind === 'chain') return m.parts.map((p) => p.startMs).sort((a, b) => a - b);
  return [K.startOf(m)];
}

const worse = (a, b) => { const o = { pass: 0, 'needs-owner': 1, fail: 2 }; return (o[b] ?? 2) > (o[a] ?? 2) ? b : a; };

/**
 * Verify one job (jobs.js). Returns the verify record; with `write`, also writes the three takes under `outDir`.
 * @param {object} job
 * @param {{outDir?: string, write?: boolean}} [o]
 */
export async function verifyJob(job, o = {}) {
  const R = await recorder();
  const t0 = Date.now();
  const { A, cell } = await findCell(job.group, job.route, job.variant, job.params);
  const ss = A.sessionSpec(cell);
  const lab = await serveLab();
  const spSrv = await serveSpecimen(job.dir);
  const spec = readJson(path.join(job.dir, 'spec.json'));
  const rec = { schema: VERIFY_SCHEMA, id: job.id, family: job.family, specimen: job.specimen, specimenDigest: spec.digest || null,
    source: { group: job.group, route: job.route, variant: job.variant, cell: cell.key || null, params: cell.params },
    recorder: { root: R.root, digest: R.digest, lane: 'hx', rate: job.rate }, created: new Date().toISOString() };
  try {
    const base = { rate: job.rate, engine: ss.engine, viewport: ss.viewport, seed: ss.seed };
    const srcOpts = { ...base, url: `${lab.origin}/${ss.page}${ss.hash}`, args: ss.args, scene: ss.scene, boot: ss.boot, selectors: ss.selectors, actions: ss.actions };
    const srcTake = await recordOne(R, { ...srcOpts, label: `verify-src-${job.id}` });
    const idTake = await recordOne(R, { ...srcOpts, label: `verify-id-${job.id}` });
    const { actions, mapping } = specimenActions(job, ss.actions, spec);
    const rebSel = job.family === 'time' ? ['.b'] : spec.scene.selectors;
    const rebBoot = job.family === 'time' ? { until: '!!window.__specimen' } : spec.boot;
    const rebTake = await recordOne(R, { ...base, url: `${spSrv.origin}/index.html`, args: ss.args, scene: {}, boot: rebBoot, selectors: rebSel, actions, label: `verify-reb-${job.id}` });
    rec.wallMs = Date.now() - t0;
    try { rec.sourceParity = A.parity(srcTake, cell); } catch (e) { rec.sourceParity = { pass: false, error: String(e.message || e).slice(0, 200) }; }
    if (o.write && o.outDir) {
      for (const [name, t] of [['source', srcTake], ['identity', idTake], ['specimen', rebTake]]) { const d = path.join(o.outDir, job.id.replace(/\//g, '__'), name); fs.mkdirSync(d, { recursive: true }); R.writeTake(t, { root: d }); }
    }
    if (o.keepTakes) Object.defineProperty(rec, 'takes', { value: { srcTake, idTake, rebTake, mapping, spec }, enumerable: false });
    Object.assign(rec, scoreJob(job, spec, { srcTake, idTake, rebTake, mapping }));
  } catch (e) {
    rec.error = String(e && e.stack || e).slice(0, 800); rec.verdict = 'fail'; rec.scored = false;
  } finally { await spSrv.close(); await lab.close(); }
  return rec;
}

/**
 * Declared arm (specimens whose motion exists only as declared animations, e.g. View Transition pseudo-elements, which
 * the recorder sees as births, not as element channels): compare every birth of the source with the specimen's birth of
 * the same pseudo-element / name, after the same time mapping. Timing cues get layer 2 in the scorer's units (onset:
 * Rammsayer DL of the onset, like a programmatic-trigger lag; duration: DL of the duration); a keyframe value or easing
 * that differs has no perceptual unit here and is `needs-owner`. The self-band is the identity take's |Δ| (0 under hx).
 */
export function declaredArm(src, id, reb, { dReb = 0, dId = 0, origin = 0 } = {}) {
  const key = (b) => `${b.pseudoElement || b.tgt}|${b.name}`;
  const kfSig = (b) => JSON.stringify((b.keyframes || []).map((k) => ({ o: k.offset, e: k.easing, t: k.transform, w: k.width, h: k.height, op: k.opacity })));
  const idx = (births) => new Map((births || []).map((b) => [key(b), b]));
  const S = idx(src), I = idx(id), R = idx(reb);
  const out = { births: S.size, diffs: [], missing: [], extra: [...R.keys()].filter((k) => !S.has(k)) };
  for (const [k, b] of S) {
    const r = R.get(k), i = I.get(k);
    if (!r) { out.missing.push(k); continue; }
    const onsetS = b.T - origin, onsetR = r.T + dReb - origin;
    const bandOn = i ? Math.abs(i.T + dId - b.T) : null, bandDur = i ? Math.abs(i.duration - b.duration) : null;
    const timing = [
      { cue: 'onset', src: onsetS, reb: onsetR, delta: onsetR - onsetS, band: bandOn, unit: unitFor('lag', { kind: 'time', srcValue: onsetS }) },
      { cue: 'duration', src: b.duration, reb: r.duration, delta: r.duration - b.duration, band: bandDur, unit: { jnd: durationDL(b.duration), pass: durationDL(b.duration) / 2, fail: durationDL(b.duration), source: 'Rammsayer DL of the duration' } },
      { cue: 'delay', src: b.delay || 0, reb: r.delay || 0, delta: (r.delay || 0) - (b.delay || 0), band: i ? Math.abs((i.delay || 0) - (b.delay || 0)) : null, unit: { jnd: durationDL(b.delay || 0), pass: durationDL(b.delay || 0) / 2, fail: durationDL(b.delay || 0), source: 'Rammsayer DL of the delay' } },
    ];
    for (const d of timing) {
      const tol = (d.band ?? 0) + 1e-6;
      d.layer1 = Math.abs(d.delta) <= tol ? 'identical' : 'different';
      d.e = Math.abs(d.delta) / d.unit.jnd;
      d.layer2 = d.layer1 === 'identical' || Math.abs(d.delta) < d.unit.pass ? 'pass' : Math.abs(d.delta) > d.unit.fail ? 'fail' : 'needs-owner';
      out.diffs.push({ birth: k, ...d });
    }
    const same = (b.easing === r.easing) && kfSig(b) === kfSig(r) && (b.iterations === r.iterations) && (b.direction === r.direction) && (b.fill === r.fill);
    out.diffs.push({ birth: k, cue: 'keyframes+easing', delta: same ? 0 : null, band: i ? (kfSig(i) === kfSig(b) ? 0 : null) : null, layer1: same ? 'identical' : 'different', e: same ? 0 : null, layer2: same ? 'pass' : 'needs-owner', note: same ? null : 'keyframe values or easing differ: no perceptual unit for this cue' });
  }
  const es = out.diffs.filter((d) => d.e != null).map((d) => d.e);
  const E = Math.cbrt(es.reduce((a, e) => a + e ** 3, 0));
  out.pooled = { E, score: Math.exp(-(E ** 3)), n: es.length };
  out.verdict = { layer1: out.missing.length || out.extra.length || out.diffs.some((d) => d.layer1 === 'different') ? 'different' : 'identical',
    layer2: out.missing.length ? 'fail' : out.diffs.some((d) => d.layer2 === 'fail') ? 'fail' : out.diffs.some((d) => d.layer2 === 'needs-owner') || out.extra.length ? 'needs-owner' : 'pass', layer2Provisional: true };
  return out;
}

/** Scoring half of the loop (no browser): mapping, pairs, events, scores, NRMSE, verdict. */
export function scoreJob(job, spec, { srcTake, idTake, rebTake, mapping }) {
  const out = { mapping: { mode: mapping } };
  let src = fromRawTake(srcTake, `source:${job.id}`), id = idTake ? fromRawTake(idTake, `identity:${job.id}`) : null, reb = fromRawTake(rebTake, `specimen:${job.id}`);
  // identity take: same page, same actions -> mapped by the common mark (0 under hx when boots are equal). Without one the
  // self-band and the floor are reported as unmeasured (H6), never as 0.
  const startOf = (t) => (markOf(t, 'verify-start') || markOf(t, 'boot-done') || { T: 0 }).T;
  const dId = idTake ? startOf(srcTake) - startOf(idTake) : 0;
  if (id) id = shiftInput(id, dId);
  const srcEnd = src.rows.length ? src.rows[src.rows.length - 1].T : 0;
  let pairs, eventsFor;
  if (mapping === 'anchor') {
    const origin = TIME_ORIGIN[job.group] === 'absolute' ? 0 : frameAfter(srcTake, 'go');
    const Ar = frameAfter(rebTake, 'go');
    if (origin == null || Ar == null) throw new Error(`time mapping: missing anchor (source ${origin}, specimen ${Ar})`);
    const shift = spec.timeline.sourceShiftMs;
    const d = origin - Ar - shift;
    const from = origin - shift;                     // specimen t = 0
    reb = shiftInput(reb, d, { from, to: srcEnd }); src = shiftInput(src, 0, { from, to: srcEnd }); if (id) id = shiftInput(id, 0, { from, to: srcEnd });
    Object.assign(out.mapping, { origin: TIME_ORIGIN[job.group], sourceOriginT: origin, specimenAnchorT: Ar, sourceShiftMs: shift, deltaMs: r6(d), window: [r6(from), srcEnd] });
    pairs = timePairs(spec, hasChannel(src));
    const tracks = new Map(spec.tracks.map((t) => [t.id, t]));
    eventsFor = (p) => scheduleOf(tracks.get(p.track).motion).map((t, i) => ({ T: r6(origin + t - shift), kind: 'time', value: `${p.track}#${i}` }));
  } else {
    const d = startOf(srcTake) - startOf(rebTake);
    reb = shiftInput(reb, d);
    Object.assign(out.mapping, { by: 'mark verify-start', deltaMs: r6(d) });
    const srcHas = hasChannel(src);
    pairs = (spec.channelMap || []).filter((c) => c.compare).map((c) => ({ track: c.specimen, src: normKey(c.source, srcHas), reb: '#' + c.specimen }));
    eventsFor = null;
  }
  // a dense sweep (dozens of one-frame landings) is arm 1; discrete steps / wheel / triggers are arm 2
  const arms = job.family === 'scroll' && (srcTake.inputLog || []).filter((e) => e.type === 'scrollTo').length > 40 ? ['sweep'] : ['response'];
  out.arms = arms; out.pairs = [];
  const mechs = [];
  for (const p of pairs) {
    const mspec = { mechanisms: [{ id: p.track, pairs: [{ src: p.src, reb: p.reb }], arms }] };
    const ev = eventsFor ? eventsFor(p) : null;
    const sets = (a) => (arms[0] === 'sweep' ? { sweep: a } : { response: a });
    const opt = (b) => ({ ...(ev ? { events: { src: ev, reb: ev } } : {}), ...b });
    const idSpec = { mechanisms: [{ id: p.track, pairs: [{ src: p.src, reb: p.src }], arms }] };       // run 0 vs run 1 of the SOURCE
    const idRec = id ? scoreTakeSets({ src: sets(src), reb: sets(id) }, idSpec, opt({})) : null;
    const band = idRec ? selfBand([idRec]) : undefined, fl = idRec ? floors([idRec]) : undefined;
    const sc = scoreTakeSets({ src: sets(src), reb: sets(reb) }, mspec, opt({ band, floors: fl }));
    const m = sc.mechanisms[0];
    const row = { track: p.track, src: p.src, reb: p.reb, kind: p.kind || null, refused: sc.refused.length ? sc.refused : null };
    if (m && m.pooled) {
      row.score = m.pooled.score; row.E = m.pooled.E; row.verdict = m.verdict; row.floor = m.floor; row.lag = m.lag; row.worst = m.worst; row.counts = m.counts;
      if (m.unscorable) row.unscorable = m.unscorable;
      const resp = m.pairs[0].response; if (resp && resp.nrmse) row.nrmse = resp.nrmse;
      const im = idRec ? idRec.mechanisms[0] : null;
      row.identity = im ? { score: im.pooled ? im.pooled.score : null, layer1: im.verdict ? im.verdict.layer1 : null, unscorable: im.unscorable || null, refused: idRec.refused.length ? idRec.refused : null } : { unmeasured: true, reason: 'no identity take' };
      if (resp && !resp.nrmse) { try { const S = extractSeries(src, p.src), Rr = extractSeries(reb, p.reb); row.nrmse = nrmseT(S, Rr, null); } catch { /* unscorable is reported above */ } }
      if (p.offsetOnly) row.note = 'bounding-box source channel vs translate specimen channel: absolute offset differs by layout (shape only)';
    } else row.unscored = (m && m.refused) || 'no comparable arm';
    out.pairs.push(row);
    mechs.push(sc);
  }
  out.records = mechs;
  if (!pairs.length && ((srcTake.data.births || []).length)) {
    // declared-only specimen: the declared arm carries the score (same mapping as the channels would use)
    const dReb = out.mapping.deltaMs || 0;
    const dec = declaredArm(srcTake.data.births, idTake ? idTake.data.births : [], rebTake.data.births, { dReb, dId, origin: (markOf(srcTake, 'go') || markOf(srcTake, 'verify-start')).T });
    out.declared = dec;
    out.pairs.push({ track: 'declared', src: `${dec.births} births`, reb: 'births', kind: 'declared', score: dec.pooled.score, E: dec.pooled.E, verdict: dec.verdict,
      floor: { mean: 1, sd: 0, n: 1, note: 'identity take: every birth equal (hx)' }, worst: dec.diffs.filter((d) => d.e != null).sort((a, b) => b.e - a.e).slice(0, 5).map((d) => ({ where: d.birth, cue: d.cue, delta: d.delta, band: d.band, e: d.e, layer2: d.layer2 })) });
  }
  // verdict: worst provisional layer-2 verdict over the scored pairs; an unscored pair fails the job
  let v = 'pass'; let scored = out.pairs.length > 0;
  for (const p of out.pairs) { if (!p.verdict) { scored = false; v = 'fail'; continue; } v = worse(v, p.verdict.layer2); }
  out.scored = scored; out.verdict = scored ? v : 'fail';
  if (!out.pairs.length) out.unscoredReason = 'no compared channel pair in the specimen (declared-only specimen)';
  const springs = out.pairs.filter((p) => p.kind === 'spring' && p.nrmse);
  if (springs.length) out.springReplay = { limit: NRMSE_LIMIT, worst: Math.max(...springs.map((p) => p.nrmse.nrmse ?? Infinity)), n: springs.map((p) => p.nrmse.n), pass: springs.every((p) => p.nrmse.nrmse != null && p.nrmse.nrmse <= NRMSE_LIMIT && p.nrmse.n > 10) };
  return out;
}
