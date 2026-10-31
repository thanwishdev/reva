// Declared-only motion: a CSS transition / CSS animation / WAAPI animation that changes only properties the recorder does not
// sample frame by frame (colour, background, border colour, shadows, fill / stroke). The page declares timing, easing and the
// two end values, so they are EXACT; the curve between them is the declared easing (not measured). Without this a hover on
// the commonest kind of web motion (a button changing colour) came back "no motion found".
import { effectiveEasing } from '../analysis/fit/eases.js';
import { FONT_PROP, parseAxes, axisWord, travelText, axisOfChannel } from './fontaxes.js';

// properties the recorder does not sample (it samples transform / translate / scale / rotate, opacity, border radius,
// clip-path, filter, font-weight / font-stretch / font-variation-settings (those are sampled as the wght, wdth and axis
// channels, and listed here too for their exact timing, easing and end values), the box and custom properties). `all` is not here: it names sampled channels too.
const PAINT = /^(color|background|background-(color|image|position(-[xy])?|size)|border(-(top|right|bottom|left))?-color|outline(-color)?|text-decoration(-color)?|caret-color|accent-color|column-rule-color|box-shadow|text-shadow|fill|fill-opacity|stroke|stroke-opacity|stroke-width|stroke-dashoffset|stroke-dasharray|backdrop-filter|-webkit-text-fill-color|-webkit-text-stroke-color|font-variation-settings|font-weight|font-stretch)$/;
const kebab = (p) => String(p).replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()).replace(/^css-float$/, 'float');
const SIDES = ['top', 'right', 'bottom', 'left'];

/** CSS property names a birth animates (a transition names one; animations and WAAPI name them in their keyframes). */
function propsOfBirth(b) {
  const names = new Set();
  if (/^CSSTransition$/.test(b.type || '') && b.name) names.add(kebab(b.name));
  for (const k of b.keyframes || []) for (const key of Object.keys(k || {})) if (!['offset', 'easing', 'composite', 'computedOffset'].includes(key)) names.add(kebab(key));
  return [...names];
}
function endValues(b, prop) {
  const camel = prop.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  const kf = (b.keyframes || []).filter((k) => k && (k[camel] != null || k[prop] != null));
  if (kf.length < 2) return null;
  const v = (k) => String(k[camel] ?? k[prop]).slice(0, 120);
  return { from: v(kf[0]), to: v(kf[kf.length - 1]) };
}
/**
 * A font property row as one row per axis ('font weight 300 → 800'), when the page's keyframes name the values. Chrome
 * serialises a transition's font-variation-settings keyframes as 'normal', so those rows keep from / to null with
 * `measure: true`: look fills them from the recording (labelled measured, never exact).
 */
function fontRows(p) {
  if (!FONT_PROP.test(p.prop)) return [p];
  const a = parseAxes(p.prop, p.from), b = parseAxes(p.prop, p.to);
  if (!a && !b) return [{ prop: p.prop, axis: null, word: p.prop === 'font-weight' ? axisWord('wght') : p.prop === 'font-stretch' ? axisWord('wdth') : 'font variation', from: null, to: null, measure: true }];
  const order = ['wght', 'wdth', 'slnt', 'ital', 'opsz']; const rk = (t) => (order.includes(t) ? order.indexOf(t) : 9);
  const tags = [...new Set([...Object.keys(a || {}), ...Object.keys(b || {})])].sort((x, y) => rk(x) - rk(y) || (x < y ? -1 : 1));
  return tags.map((t) => ({ prop: p.prop, axis: t, word: axisWord(t), from: a && t in a ? a[t] : null, to: b && t in b ? b[t] : null, ...(a && b && t in a && t in b ? {} : { measure: true }) }));
}
const safeIdent = (s) => /^[a-z][a-z-]{0,40}$/.test(s);
const num = (x) => (Number.isFinite(+x) ? +x : null);

/**
 * @param {object[]} births   take.data.births
 * @param {object} o
 * @param {Set<string>|null} o.descs  aimed: only births on these element descriptors; null: any element
 * @param {number|null} o.fromT       only births from this time on (ms; the action's start, page time)
 * @param {number} [o.max]
 * @returns {object[]}
 */
export function declaredOnly(births, { descs = null, fromT = null, max = 8 } = {}) {
  const groups = new Map();
  for (const b of births || []) {
    if (!b || (descs && !descs.has(b.tgt))) continue;
    if (fromT != null && Number.isFinite(b.T) && b.T < fromT - 1) continue;
    if (b.timeline && b.timeline !== 'document') continue; // scroll / view timelines are scroll maps, not paint transitions
    const props = propsOfBirth(b);
    if (!props.length || !props.every((p) => PAINT.test(p) || /^border-(top|right|bottom|left)-color$/.test(p))) continue;
    const dur = num(b.duration), delay = num(b.delay) ?? 0;
    if (dur == null || dur <= 0) continue;
    const key = [b.tgt, b.type, dur, delay, b.easing, b.iterations, b.direction].join('|');
    const g = groups.get(key) || { tgt: b.tgt, type: b.type, dur, delay, easing: b.easing, iterations: b.iterations, direction: b.direction, T: b.T, kf: b.keyframes, props: new Map() };
    // Chrome serialises a font property's CSS transition keyframes wrongly ('normal' / 400 for both ends, VERIFIED): never read
    // them; look measures the ends from the recording. CSS animations and Web Animations keep the author's keyframes.
    for (const p of props) if (!g.props.has(p)) g.props.set(p, FONT_PROP.test(p) && /Transition/.test(b.type || '') ? null : endValues(b, p));
    groups.set(key, g);
  }
  const out = [];
  for (const g of groups.values()) {
    // four border sides that went the same way are one border-color
    const props = [...g.props.entries()].map(([prop, v]) => ({ prop, from: v && v.from, to: v && v.to }));
    const sides = SIDES.map((s) => props.find((p) => p.prop === `border-${s}-color`));
    const merged = props.filter((p) => !/^border-(top|right|bottom|left)-color$/.test(p.prop));
    if (sides.every(Boolean) && sides.every((p) => p.from === sides[0].from && p.to === sides[0].to)) merged.push({ prop: 'border-color', from: sides[0].from, to: sides[0].to });
    else merged.push(...props.filter((p) => /^border-(top|right|bottom|left)-color$/.test(p.prop)));
    const shown = merged.flatMap(fontRows);
    // the easing that really runs: the effect's, or the keyframes' own (a CSS animation keeps its timing function there)
    const ease = effectiveEasing(g.easing, g.kf).easing || null;
    out.push({
      kind: /Transition/.test(g.type) ? 'css-transition' : /CSSAnimation/.test(g.type) ? 'css-animation' : 'waapi',
      desc: g.tgt, properties: shown, durationMs: g.dur, delayMs: g.delay, easing: ease,
      iterations: g.iterations ?? 1, direction: g.direction || 'normal', t: Number.isFinite(g.T) ? Math.round(g.T) : null,
      label: 'exact', note: 'timing, easing and end values are read from the page; the colour between them is not sampled frame by frame',
      css: cssOf(g, merged, ease),
    });
  }
  out.sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
  return out.slice(0, max);
}

/** The page's own declaration, rebuilt from validated pieces only (page text never lands in code). Null when it cannot be. */
function cssOf(g, props, ease) {
  if (!/Transition/.test(g.type || '') || !ease) return null;
  const names = [...new Set(props.map((p) => p.prop))];
  if (!names.every(safeIdent)) return null;
  const ms = (x) => `${+(+x).toFixed(3)}ms`;
  return `transition: ${names.map((n) => `${n} ${ms(g.dur)} ${ease}${g.delay ? ` ${ms(g.delay)}` : ''}`).join(', ')};`;
}

/** One plain line for the text report. */
export function declaredLine(d) {
  const p = d.properties.map((x) => {
    if (!x.word) return `${x.prop}${x.from != null ? ` ${x.from} → ${x.to}` : ''}`;
    const nums = Number.isFinite(+x.from) && Number.isFinite(+x.to) && x.from != null && x.to != null;
    // a font property: plain words; end values the page does not expose are measured from the frames, so [fitted], not [exact]
    const body = nums ? (x.axis ? travelText(x.axis, x.from, x.to) : `${x.word} ${x.from} → ${x.to}`) : `${x.word} (end values not exposed by the page)`;
    return `${body}${nums && x.source === 'measured' ? ' [fitted]' : ''}`;
  }).join('; ');
  const what = d.kind === 'css-transition' ? 'CSS transition' : d.kind === 'css-animation' ? 'CSS animation' : 'Web Animation';
  return `${what}: ${p} · ${d.durationMs} ms [exact], ${d.easing || 'easing unknown'} [exact]${d.delayMs ? `, delay ${d.delayMs} ms [exact]` : ''}`;
}

/**
 * Fill the font-axis end values the page does not expose (rows with `measure`) from the fitted records of the same element:
 * records(desc) -> the element's records, endsOf(rec) -> {from, to} recorded at the motion's start and end. A filled value is
 * labelled `source: 'measured'` ([fitted] in the text), never exact. A row nothing measured keeps null and says so.
 * @param {object[]} declared  declaredOnly() output
 */
export function fillMeasuredFontEnds(declared, records, endsOf) {
  for (const d of declared) {
    const recs = (records || []).filter((r) => r.target && r.target.desc === d.desc && axisOfChannel(r.target.channel));
    const out = [];
    for (const p of d.properties) {
      if (!p.measure) { out.push(p); continue; }
      const want = p.axis ? [p.axis] : p.prop === 'font-weight' ? ['wght'] : p.prop === 'font-stretch' ? ['wdth'] : null;   // null: any axis that moved
      const mine = recs.filter((r) => !want || want.includes(axisOfChannel(r.target.channel)));
      const byAxis = new Map();
      for (const r of mine) {
        const t = axisOfChannel(r.target.channel); const t0 = r.derived && r.derived.t0;
        const dist = Number.isFinite(t0) && d.t != null ? Math.abs(t0 - d.t) : 0;
        const e = endsOf(r); if (!e || !Number.isFinite(e.from) || !Number.isFinite(e.to) || e.from === e.to) continue;
        const cur = byAxis.get(t); if (!cur || dist < cur.dist) byAxis.set(t, { dist, e });
      }
      if (!byAxis.size) { out.push({ ...p, note: 'the page does not expose the end values of this property and no recorded channel of the element measured them' }); continue; }
      for (const [t, { e }] of byAxis) out.push({ prop: p.prop, axis: t, word: axisWord(t), from: p.axis === t && p.from != null ? p.from : e.from, to: p.axis === t && p.to != null ? p.to : e.to, source: 'measured' });
    }
    d.properties = out;
  }
  return declared;
}
