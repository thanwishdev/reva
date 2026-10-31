// Scroll specimens (M3, part "specimens-scroll"): public API.
//
//   buildScrollSpecimen(records, opts) -> { spec, html, parts }
//   writeSpecimen(dir, built, { site })  -> files written (site: true refuses to write inside the repo, PLAN H2)
//   simulate(spec, input, K)             -> per-frame channel values (the same Replayer the page's seek(t) uses)
//   inputFromTake(loadedTake)            -> the input description (frames, wheel, pointer, triggers) of a recorded take
//
// A scroll specimen is a content-free page that re-implements the mechanisms of motion records whose driver is the scroll
// offset (scroll maps, pins, per-frame EMA / dt-aware damping / asymmetric smoothing / restarted tweens, hysteresis
// staircases), the wheel (smooth scrollers, latched tweens), the pointer (release inertia) or a trigger (FLIP, view
// transitions). See README.md for the page contract.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { SPECIMEN_SCHEMA, Replayer, framesUpTo } from './core.js';
import { normalizeRecords, VIEWPORT_DEFAULT } from './normalize.js';
import { emitHtml } from './emit.js';
import { assertOutsideRepo } from '../../util/paths.js';

export { SPECIMEN_SCHEMA } from './core.js';
export { normalizeRecords } from './normalize.js';
export { emitHtml } from './emit.js';

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const stable = (o) => JSON.stringify(o, (k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((q) => [q, v[q]])) : v));

/**
 * @param {object|object[]} records  lab truth items, fitted motion records, or a fit result ({records, pins})
 * @param {object} [opts]  { id, viewport, frameMs (nominal frame period of seek, default 1000/120), docHeight, input, source }
 */
export function buildScrollSpecimen(records, opts = {}) {
  const parts = normalizeRecords(records, opts);
  const viewport = parts.viewport || VIEWPORT_DEFAULT;
  const mechanisms = parts.mechanisms.map((m, i) => ({ id: 'm' + i, ...m }));
  const used = new Set([...mechanisms.map((m) => m.subject), ...parts.pins.map((p) => p.subject)]);
  for (const m of mechanisms) if (m.kind === 'view-transition') for (const g of m.groups) used.add(g.subject);
  const subjects = parts.subjects.filter((s) => used.has(s.id)).map((s) => ({ ...s }));
  const core = { viewport, docHeight: parts.docHeight, subjects, mechanisms, pins: parts.pins };
  const id = opts.id || `scroll-${sha256(stable(core)).slice(0, 10)}`;
  const spec = {
    schema: SPECIMEN_SCHEMA, id, family: 'scroll', contract: 'window.seek(t) / window.specimen (see README.md)',
    viewport, frameMs: opts.frameMs ?? 1000 / 120, docHeight: parts.docHeight,
    subjects, mechanisms, pins: parts.pins, input: opts.input || mergeHints(parts.inputHints),
    channelMap: parts.channelMap.filter((c) => used.has(c.specimen.split('|')[0])),
    declared: parts.declared,
    skipped: parts.skipped, unknowns: parts.unknowns, assumptions: parts.assumptions,
    placeholders: parts.unknowns.filter((u) => u.placeholder).map((u) => u.id),
    boot: { until: 'window.specimen && window.specimen.ready === true' },
    scene: { selectors: subjects.map((s) => '#' + s.id) },
    source: opts.source || null,
  };
  const html = emitHtml(spec);
  return { spec, html, parts };
}

const mergeHints = (h) => (h && (h.pointer.length || h.triggers.length) ? { pointer: h.pointer, triggers: h.triggers } : null);

/**
 * Integration entry (same shape as the time-specimen generator's specimensFromFit): a fit result or record list ->
 * { specs: [{spec, html}], skipped, claimed } . `claimed` lists the source targets a scroll mechanism rebuilt, so a caller that
 * also runs the time-specimen builder can see which records each builder took. Empty when no record is scroll-driven.
 */
export function scrollSpecimensFromFit(fit, o = {}) {
  const built = buildScrollSpecimen(fit, { id: o.id, ...o });
  const claimed = [...new Set([...built.spec.channelMap.map((c) => c.source), ...(built.spec.declared || []).map((d) => d.source), ...built.spec.pins.map((p) => p.source), ...built.spec.mechanisms.flatMap((m) => m.sources || [])])];
  if (!built.spec.mechanisms.length) return { specs: [], skipped: built.spec.skipped, claimed: [] };
  return { specs: [built], skipped: built.spec.skipped, claimed };
}

/** Write index.html + spec.json (+ extra named files) into `dir`. `site: true` = site-derived: refuse the repo (H2). */
export function writeSpecimen(dir, built, { site = false, extra = {} } = {}) {
  if (site) assertOutsideRepo(path.resolve(dir));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), built.html);
  fs.writeFileSync(path.join(dir, 'spec.json'), JSON.stringify(built.spec, null, 1) + '\n');
  for (const [name, content] of Object.entries(extra)) fs.writeFileSync(path.join(dir, name), typeof content === 'string' ? content : JSON.stringify(content, null, 1) + '\n');
  return fs.readdirSync(dir);
}

/** Node simulation: snapshots of frames 1..K (all frames of the input by default). */
export function simulate(spec, input, K) {
  const inp = input || spec.input || {};
  const n = K ?? (inp.frames ? inp.frames.length : framesUpTo(inp, spec.frameMs, 5000));
  const rep = new Replayer(spec, inp);
  const frames = rep.to(n, true);
  const channels = {};
  for (const f of frames) for (const [key, v] of Object.entries(f.channels)) (channels[key] ||= []).push(v);
  return { frames, channels, eventLog: rep.eventLog, T: frames.map((f) => f.T) };
}

/**
 * Input description of a loaded take ({take, data} from loadTake with at least ['rows', 'inputLog', 'wheel']): the exact scroll
 * offset of every frame row plus the wheel / pointer events with the time they landed (virtual ms). Triggers come from the
 * take's marks named `go`, `go2`, ... (the scenario marks the frame after which it calls `specimen.go()`); a pointer script
 * that the page schedules itself (`specimen.script()` after `{mark: 'script'}`) is taken from `opts.spec.input.pointer`,
 * shifted to the mark's time.
 */
export function inputFromTake({ take, data }, opts = {}) {
  const frames = data.rows.map((r) => ({ k: r.k, T: r.T, sy: r.sy }));
  const Tof = new Map(frames.map((f) => [f.k, f.T]));
  const pageWheel = data.wheel || [];
  const wheel = [], pointer = [], triggers = [];
  let wi = 0;
  for (const e of data.inputLog || []) {
    if (e.type === 'wheel') {
      // an input handled after frame k lands at T_k (hx); entries recorded before design X2 carry k: null, so the page-side
      // wheel log (same order) supplies the frame index
      const pw = pageWheel[wi++];
      const k = typeof e.k === 'number' ? e.k : pw ? pw.k : null;
      wheel.push({ T: k != null && Tof.has(k) ? Tof.get(k) : e.T, dy: e.dy });
    } else if (/^pointer/.test(e.type || '') && e.x != null) pointer.push({ T: typeof e.k === 'number' && Tof.has(e.k) ? Tof.get(e.k) : e.T, type: e.type.replace(/^pointer/, ''), x: e.x });
  }
  const marks = (take && take.marks) || [];
  for (const m of marks) if (/^go\d*$/.test(m.name)) triggers.push({ T: m.T });
  const sm = marks.find((m) => m.name === 'script');
  if (sm && opts.spec && opts.spec.input && opts.spec.input.pointer) for (const p of opts.spec.input.pointer) pointer.push({ ...p, T: Math.round((sm.T + p.T) * 1e6) / 1e6 });
  return { frames, wheel, pointer, triggers };
}
