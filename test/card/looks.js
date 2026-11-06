// Small synthetic look.json objects, one per plot kind (no real site data). Shape follows docs of reva.look/0.
const base = (motions, extra = {}) => ({
  schema: 'reva.look/0', ok: true, status: motions.length ? 'motion' : 'no-motion', errors: [], warnings: [],
  source: { kind: 'archive', startUrl: 'https://example.com/' }, action: { do: 'load', el: null, on: null },
  take: { dir: '/nonexistent/take', rate: 120, frames: 360, net: { misses: 0 } }, timing: { totalMs: 1000 },
  fit: {}, page: null, motions, unknowns: [], others: [], declaredOnly: [], ...extra,
});
const v = (name, value, unit = null, label = 'fitted') => ({ name, value, unit, label, text: `${value} ${unit || ''} [${label}]` });
function row(i, { kind, label = 'fitted', values = [], channels = ['ren:ty'], t0 = 400, trigger = 'plays on its own time', model = {}, attribution = { label: 'time-driven' }, stagger = null, unknowns = [], text = 'x', desc = `DIV.item${i}`, position = null, exports: ex = [] } = {}) {
  return {
    rank: i, kind: 'element', desc, selector: `div.item${i}`, selectorMatches: 1, box: { x: 100, y: 100 + i * 70, w: 200, h: 48 }, count: 1, lead: 1, ids: [i], weight: 1, weightShare: 0.3 / i,
    channels, fitted: true, lines: [{ text, kind, family: model.family || kind, label, channels, trigger, t0, times: 1, values }],
    records: [{ tier: kind === 'unknown' ? 'unknown' : 'fitted', class: kind, target: { el: i, desc, channel: channels[0] }, attribution, model: { family: model.family || kind, ...model }, unknowns: [] }],
    unknowns, stagger, position, exports: ex,
  };
}
export const KINDS = {
  tween: base([row(1, { kind: 'tween', values: [v('duration', 600, 'ms')], model: { family: 'bezier', bezier: [0.2, 0.8, 0.2, 1] }, text: 'Tween, cubic-bezier(0.2, 0.8, 0.2, 1) [fitted], 600 ms [fitted]' })]),
  tweenNamed: base([row(1, { kind: 'tween', values: [v('duration', 600, 'ms')], model: { family: 'named:easeOutCubic', ease: 'easeOutCubic' }, text: 'Tween, easeOutCubic [fitted], 600 ms [fitted]' })]),
  tweenUnknownEase: base([row(1, { kind: 'tween', values: [v('duration', 600, 'ms')], model: { family: 'named:wobbleOut', ease: 'wobbleOut' }, text: 'Tween, wobbleOut [fitted], 600 ms [fitted]' })]),
  scrollMapUnknownEdge: base([row(1, { kind: 'scroll map', values: [v('from', -20), v('to', 20), v('scrollStart', -409350, 'px', 'unknown'), v('scrollEnd', 8737, 'px')], channels: ['ren:tx'], trigger: 'tied to the scroll', t0: null, model: { family: 'scroll map (linear)', map: { shape: 'linear' }, driver: { kind: 'wheel' } }, attribution: { label: 'wheel-linked' } })], { action: { do: 'scroll' } }),
  // overshooting cubic-bezier (y2 beyond 1): the sentence must say so
  tweenOvershoot: base([row(1, { kind: 'tween', values: [v('duration', 600, 'ms')], model: { family: 'bezier', bezier: [0.34, 1.56, 0.64, 1] }, text: 'Tween, cubic-bezier(0.34, 1.56, 0.64, 1) [fitted], 600 ms [fitted]' })]),
  // bezier + ramp + bezier in one row, from a scroll look: the ramp piece has from/to but no x1..y2
  piecewiseRamp: base([row(1, { kind: 'tween', channels: ['ren:ty', 'ren:tx'], trigger: 'tied to the scroll', t0: 7546, model: { family: 'piecewise', pieces: [
    { family: 'bezier', cls: 'tween', params: { t0: 7546, D: 306, x1: 0.79, y1: 0.97, x2: 1, y2: 1.57, to: -946 }, rms: 5.6, T0: 7400, T1: 7850 },
    { family: 'ramp', cls: 'ramp', params: { t0: 7850, D: 1650, from: -1077.66, to: 8822.34 }, rms: 0.0009, T0: 7850, T1: 9500 },
    { family: 'bezier', cls: 'tween', params: { t0: 9500, D: 1180, x1: 0.12, y1: 0.4, x2: 0.37, y2: 0.06, from: 8822.34, to: 10853.4 }, rms: 0.5, T0: 9500, T1: 10500 }] }, attribution: { label: 'scroll-linked' }, text: 'tween: piecewise [fitted]' })], { action: { do: 'scroll' } }),
  declared: base([row(1, { kind: 'declared', label: 'exact', values: [v('duration', 300, 'ms', 'exact'), v('easing', 'ease-out', null, 'exact'), v('delay', 100, 'ms', 'exact')], model: { family: 'declared:css' } })]),
  // two channels of one declared transition, each with the css rule parts the exporter writes (decl): joined into one rule
  declaredTwo: base([row(1, { kind: 'declared', label: 'exact', channels: ['ren:ty', 'ren:opacity'], t0: 158.3, values: [v('duration', 900, 'ms', 'exact'), v('easing', 'cubic-bezier(0.22, 1, 0.36, 1)', null, 'exact'), v('delay', 150, 'ms', 'exact')], model: { family: 'declared:css' },
    exports: [
      { channel: 'ren:ty', family: 'declared:css', kind: 'tween', t0: 158.3, exports: [{ lib: 'css', code: '/* REVA: measured from x [ren:ty] */\n.el { transform: translateY(32px); transition: transform 900ms cubic-bezier(0.22, 1, 0.36, 1) 150ms; }\n.el.to { transform: translateY(0px); }', accuracy: { label: 'as declared' }, match: { word: 'as declared' }, decl: { prop: 'transform', from: 'translateY(32px)', to: 'translateY(0px)', timing: '900ms cubic-bezier(0.22, 1, 0.36, 1)', delayMs: 150, pre: '' } }] },
      { channel: 'ren:opacity', family: 'declared:css', kind: 'tween', t0: 158.3, exports: [{ lib: 'css', code: '/* REVA: measured from x [ren:opacity] */\n.el { opacity: 0; transition: opacity 900ms cubic-bezier(0.22, 1, 0.36, 1) 150ms; }\n.el.to { opacity: 1; }', accuracy: { label: 'as declared' }, match: { word: 'as declared' }, decl: { prop: 'opacity', from: '0', to: '1', timing: '900ms cubic-bezier(0.22, 1, 0.36, 1)', delayMs: 150, pre: '' } }] },
    ] })]),
  ramp: base([row(1, { kind: 'ramp', values: [v('duration', 800, 'ms')], model: { family: 'ramp' } })]),
  spring: base([row(1, { kind: 'spring', values: [v('overshoot', 9, '%'), v('settle', 700, 'ms'), v('omega', 11, 'rad/s'), v('zeta', 0.6)], model: { family: 'spring' } })]),
  step: base([row(1, { kind: 'step', values: [v('at', 900, 'ms')], model: { family: 'step' }, channels: ['ren:radius'] })]),
  smoothing: base([], { page: row(0, { kind: 'smoothing', values: [v('tau', 150, 'ms'), v('lerp60', 0.1)], model: { family: 'ema' }, trigger: 'tied to the scroll', attribution: { label: 'scroll-linked' }, t0: 1000, desc: 'HTML' }) }),
  scrollMap: base([row(1, { kind: 'scroll map', values: [v('from', 0), v('to', 1), v('scrollStart', 800, 'px'), v('scrollEnd', 1600, 'px')], channels: ['ren:opacity'], trigger: 'tied to the scroll', t0: null, model: { family: 'scroll map (linear)', map: { shape: 'linear' }, driver: { kind: 'scroll' } }, attribution: { label: 'scroll-linked' } })], { action: { do: 'scroll' } }),
  pointerMap: base([row(1, { kind: 'scroll map', values: [v('from', -20), v('to', 20), v('scrollStart', 0, 'px'), v('scrollEnd', 600, 'px')], channels: ['ren:tx'], trigger: 'reacts to the pointer', t0: null, model: { family: 'scroll map (linear)', map: { shape: 'linear' }, driver: { kind: 'pointer' } }, attribution: { label: 'pointer' } })], { action: { do: 'hover' } }),
  wheelMapNegative: base([row(1, { kind: 'scroll map', values: [v('from', -20), v('to', 20), v('scrollStart', -40000, 'px'), v('scrollEnd', 900, 'px')], channels: ['ren:tx'], trigger: 'tied to the scroll', t0: null, model: { family: 'scroll map (linear)', map: { shape: 'linear' }, driver: { kind: 'wheel' } }, attribution: { label: 'wheel-linked' } })], { action: { do: 'scroll' } }),
  pin: base([row(1, { kind: 'pin', values: [v('pinStart', 500, 'px'), v('pinEnd', 1300, 'px')], channels: ['ren:by'], trigger: 'tied to the scroll', t0: null, model: { family: 'pin', pin: { start: { value: 500 }, end: { value: 1300 }, held_px: 800 } }, attribution: { label: 'scroll-linked' } })], { action: { do: 'scroll' } }),
  periodic: base([row(1, { kind: 'periodic', values: [v('period', 400, 'ms')], model: { family: 'periodic' } })]),
  stagger: base([row(1, { kind: 'tween', values: [v('duration', 500, 'ms')], model: { family: 'bezier', bezier: [0.3, 0, 0.2, 1] }, stagger: { kind: 'stagger', n: 6, values: [{ name: 'interval', value: 80, unit: 'ms', label: 'fitted' }] } })]),
  unknown: base([row(1, { kind: 'unknown', label: 'unknown', values: [], t0: null, text: 'moves, but no model explains it [unknown]: changes only below the read-back noise floor', channels: ['ren:sx'] })]),
  empty: base([]),
  declaredOnly: base([], { declaredOnly: [{ kind: 'css-transition', desc: 'A.btn', selector: 'a.btn', durationMs: 200, delayMs: 0, easing: 'ease-in-out', t: 300, properties: [{ prop: 'background-color', from: 'rgb(255, 255, 255)', to: '#1c1d20' }, { prop: 'color', from: 'red; } body{display:none', to: 'blue' }] }] }),
};
