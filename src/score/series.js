// Score inputs: a take (from disk or straight from session.finish) normalised to what the scorer needs, element
// resolution by selector, numeric channel extraction and the event list (inputs the response arm aligns on).
import { loadTake } from '../record/take.js';

/** Normalise a take folder (written by writeTake) into a score input. */
export function fromTakeDir(dir) {
  const { take, data } = loadTake(dir, ['rows', 'elements', 'inputLog']);
  const env = take.env || {};
  const vp = env.viewport && env.viewport.value;
  return {
    id: dir, digest: take.series && take.series.rows && take.series.rows.digest,
    rows: data.rows || [], elements: data.elements || [], inputLog: data.inputLog || [], marks: take.marks || [],
    extra: take.extra || {},
    meta: {
      lane: take.lane, rate: take.rate,
      dtMs: env.dtMs && env.dtMs.provenance !== 'unknown' ? env.dtMs.value : null,
      refreshHz: env.refreshHz ? env.refreshHz.value : null,
      viewport: vp ? { width: vp.width, height: vp.height } : null,
      dpr: env.dpr ? env.dpr.value : null,
      reducedMotion: env.reducedMotion ? env.reducedMotion.value : null,
      engine: env.engine ? env.engine.value : null,
      toolkit: env.toolkit ? env.toolkit.value : null,
      readback: env.readbackFloor && env.readbackFloor.provenance === 'measured' ? env.readbackFloor.value : null,
    },
  };
}

/** Normalise a raw take (session.finish({write:false}).take) into a score input. */
export function fromRawTake(t, id = 'raw') {
  const rts = t.rtDt && t.rtDt.length ? [...t.rtDt].sort((a, b) => a - b) : null;
  return {
    id, digest: null, rows: t.data.rows, elements: t.els || [], inputLog: t.inputLog || [], marks: t.marks || [], extra: t.extra || {},
    meta: {
      lane: t.lane, rate: t.rate, dtMs: t.lane === 'hx' ? t.dt : null,
      refreshHz: rts ? 1000 / rts[rts.length >> 1] : (t.lane === 'hx' ? 1000 / t.dt : null),
      viewport: t.env ? { width: t.env.innerWidth, height: t.env.innerHeight } : null,
      dpr: t.env ? t.env.dpr : null, reducedMotion: t.env ? t.env.reducedMotion : null,
      engine: t.browser && t.browser.engine, toolkit: t.browser && t.browser.toolkit, readback: t.env ? t.env.readback : null,
    },
  };
}

// ------------------------------------------------------------------ element resolution
/** Parse a recorder element descriptor "TAG#id.c1.c2" (src/record/inpage.js desc()). */
export function parseDesc(d) {
  if (!d) return null;
  const m = /^([A-Za-z][\w-]*)(#[^.]+)?((?:\.[^.]+)*)$/.exec(d);
  if (!m) return { tag: null, id: null, classes: [] };
  return { tag: m[1].toUpperCase(), id: m[2] ? m[2].slice(1) : null, classes: m[3] ? m[3].split('.').filter(Boolean) : [] };
}

/** Simple selectors only: tag, #id, .class combinations, optional ":nth(i)" to pick among several matches. */
export function parseSelector(sel) {
  const nth = /:nth\((\d+)\)$/.exec(sel);
  const s = nth ? sel.slice(0, nth.index) : sel;
  const m = /^([A-Za-z][\w-]*)?(#[\w-]+)?((?:\.[\w-]+)*)$/.exec(s);
  if (!m || !s) throw new Error(`unsupported selector "${sel}" (use tag, #id, .class, optional :nth(i))`);
  return { tag: m[1] ? m[1].toUpperCase() : null, id: m[2] ? m[2].slice(1) : null, classes: m[3] ? m[3].split('.').filter(Boolean) : [], nth: nth ? +nth[1] : null };
}

export function resolveElement(elements, sel) {
  const q = parseSelector(sel);
  const hits = [];
  elements.forEach((d, i) => {
    const p = parseDesc(d); if (!p) return;
    if (q.tag && p.tag !== q.tag) return;
    if (q.id && p.id !== q.id) return;
    if (q.classes.some(c => !p.classes.includes(c))) return;
    hits.push(i);
  });
  if (q.nth != null) { if (q.nth >= hits.length) throw new Error(`selector "${sel}": only ${hits.length} matches`); return hits[q.nth]; }
  if (hits.length !== 1) throw new Error(`selector "${sel}" matched ${hits.length} recorded elements (need exactly 1; add :nth(i))`);
  return hits[0];
}

// ------------------------------------------------------------------ channels
/** "#id|ren:tx" or "#id|ren:clipPath#1" (the n-th number inside a string value). */
export function parseChannelKey(key) {
  const i = key.indexOf('|');
  if (i < 0) throw new Error(`channel key "${key}" must be "<selector>|<channel>"`);
  const sel = key.slice(0, i); let ch = key.slice(i + 1); let idx = 0;
  const m = /#(\d+)$/.exec(ch); if (m) { idx = +m[1]; ch = ch.slice(0, m.index); }
  return { sel, channel: ch, idx };
}

// Computed-style keyword values that mean a known number (the property's initial/identity value).
const NONE_VALUE = { 'ren:scale': 1, 'ren:translate': 0, 'ren:rotate': 0, 'ren:clipPath': 0, 'ren:filter': 0, 'ren:transform': null };

/** Numeric value of a recorded channel value; null when absent or not numeric. */
export function numericOf(v, channel, idx = 0) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  if (s === 'none' || s === '') return channel in NONE_VALUE ? NONE_VALUE[channel] : null;
  const nums = s.match(/(?<![a-z_\d.])-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi);   // not the 3 of 'translate3d' (fit/series.js numOf)
  if (!nums || idx >= nums.length) return null;
  return parseFloat(nums[idx]);
}

/** Extract one channel as parallel arrays over the take's rows (rows without the element are skipped). */
export function extractSeries(input, key) {
  const { sel, channel, idx } = parseChannelKey(key);
  const el = resolveElement(input.elements, sel);
  const T = [], v = [], sy = [], k = [];
  for (const r of input.rows) {
    const o = r.v && r.v[el]; if (!o) continue;
    const x = numericOf(o[channel], channel, idx); if (x == null) continue;
    T.push(r.T); v.push(x); sy.push(r.sy); k.push(r.k);
  }
  return { key, el, channel, T, v, sy, k };
}

/** Read-back floor (D3) of a channel kind, in the channel's own units; 0 when unknown. */
export function readbackOf(input, channel) {
  const rb = input.meta.readback; if (!rb) return 0;
  const pick = (n) => rb[n] ? rb[n].maxAbsErr : 0;
  if (/ren:(tx|ty|tz|translate|bx|by|bw|bh)/.test(channel)) return Math.max(pick('translateX(px)'), /b[xywh]/.test(channel) ? pick('left(px)') : 0);
  if (/ren:(sx|sy|scale)/.test(channel)) return pick('scale');
  if (/ren:(rz|rotate)/.test(channel)) return pick('rotate(deg)');
  if (channel === 'ren:opacity') return pick('opacity');
  if (channel === 'ren:radius') return pick('border-radius(px)');
  if (channel === 'ren:filter') return pick('filter-blur(px)');
  if (channel === 'ren:clipPath') return pick('clip-inset(%)');
  return pick('--var(unregistered)');
}

// ------------------------------------------------------------------ events (what arm 2 aligns on)
/**
 * Inputs and triggers in time order. Default: the recorder's input log (scrollTo, wheel with a known T) plus scenario
 * marks except boot. `opts.events` (array of {T, kind, value}) replaces them, e.g. page-logged triggers that fire at a
 * sub-frame time the recorder cannot log. Entries without a time are returned in `untimed` (arm 2 refuses them).
 */
export function eventsOf(input, opts = {}) {
  if (opts.events) return { events: opts.events.map(e => ({ T: e.T, kind: e.kind || 'time', value: e.value ?? null })).sort((a, b) => a.T - b.T), untimed: [] };
  const ev = [], untimed = [];
  for (const e of input.inputLog) {
    if (e.type === 'scrollTo') { if (e.T != null) ev.push({ T: e.T, kind: 'scroll', value: e.got }); else untimed.push(e); }
    else if (e.type === 'wheel') { if (e.T != null) ev.push({ T: e.T, kind: 'wheel', value: e.dy }); else untimed.push(e); }
    else if (e.T != null) ev.push({ T: e.T, kind: e.type, value: e.value ?? null }); else untimed.push(e);
  }
  for (const m of input.marks) if (m.name !== 'boot-done' && m.name !== 'sweep' && m.T != null) ev.push({ T: m.T, kind: 'time', value: m.name });
  ev.sort((a, b) => a.T - b.T);
  return { events: ev, untimed };
}
