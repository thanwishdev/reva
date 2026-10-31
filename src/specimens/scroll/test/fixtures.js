// Hermetic records for the specimen tests: own numbers, no lab file, no site value. Two dialects (lab truth items and
// fitted records) in the shapes the builder accepts.
export const truthSmooth = (over = {}) => [
  { scored: true, target: '#t|drv:--e', role: 'driver', class: 'first-order smoothing', family: 'ema', law: 'per-frame', attribution: 'scroll-linked',
    params: { alpha: { value: 0.2, unit: 'per frame' }, snap_eps: { value: 0.001, unit: 'progress' }, write: 'full',
      map: { shape: 'smoothstep', a: 0, b: 1, px: { s0: 500, s1: 1100 } }, ...over } },
  { scored: false, target: '#t|ren:ty', role: 'rendered-mirror', mirrorOf: '#t|drv:--e', class: 'first-order smoothing', family: 'ema', attribution: 'scroll-linked',
    params: { alpha: { value: 0.2, unit: 'per frame' }, map: { shape: 'smoothstep', a: 0, b: -200, px: { s0: 500, s1: 1100 } } } },
];
export const truthMap = () => [
  { scored: true, target: '#m|drv:--p', role: 'driver', class: 'scroll-map', family: 'linear', attribution: 'scroll-linked',
    params: { map: { shape: 'linear', a: 1, b: -1, px: { s0: 200, s1: 900 } } } },
];
export const truthAsym = () => [
  { scored: true, target: '#a|drv:--a', role: 'driver', class: 'asymmetric smoothing', family: 'snap-up-ease-down', law: 'per-frame', attribution: 'scroll-linked',
    params: { alpha_down: { value: 0.3 }, alpha_up: { value: 1 }, snap_eps: { value: 0.001 }, map: { shape: 'smoothstep', a: 0, b: 1, px: { s0: 700, s1: 1000 } } } },
];
export const truthHysteresis = () => [
  { scored: true, target: '#h|drv:--i', role: 'driver', class: 'scroll-map', family: 'staircase-hysteresis', attribution: 'scroll-linked',
    params: { levels: { value: 4 }, edges_px: { up: [600, 900, 1200], down: [500, 800, 1100] } } },
  { scored: true, target: '#h|ren:by', role: 'rendered', class: 'scroll-map', family: 'pin', attribution: 'scroll-linked', params: { pin: { start_px: 300, end_px: 1300, held_value: 0 } } },
];
export const truthWheel = () => [
  { scored: true, target: '#w|drv:--y', role: 'driver', class: 'first-order smoothing', family: 'damp', law: 'dt-aware', attribution: 'wheel',
    params: { lerp: { value: 0.1 }, lambda: { value: 6 } } },
];
export const truthInertia = () => [
  { target: '.d|--x', segment: 'drag', class: 'ramp', scored: false, derived: { from_ms: 510, to_ms: 900, speed_px_ms: 0.6 } },
  { target: '.d|--x', segment: 'post-release', class: 'friction', family: 'friction', law: 'per-frame', scored: true,
    params: { friction: 0.9, law: 'per-frame', stop_eps_px_per_frame: 0.05 }, derived: { release_ms: 905, stopping_distance_px: 89.5362 } },
];
export const truthFlip = () => ['tx', 'ty', 'sx', 'sy'].flatMap((c) => [1, 2].map((seg) => ({
  target: `#f|ren:${c}`, class: 'declared', sub: 'flip', family: 'waapi-bezier', provenance: 'declared',
  params: { impl: 'waapi', segment: seg, start_ms: seg === 1 ? 441.666667 : 741.666667, duration_ms: 600, easing: [0.2, 0.9, 0.1, 1], trigger_ms: seg === 1 ? 433.333333 : 733.333333,
    layout_delta: seg === 1 ? { dx: -440, dy: -180, sx: 0.5, sy: 0.5555555555555556 } : { dx: 426.407033446666, dy: 174.4392409554543, sx: 1.9691068941969683, sy: 1.7752855153575746 } } })));
export const truthVT = () => [
  { target: 'html::view-transition-group(g0)', class: 'declared', sub: 'view-transition', family: 'view-transition-group', provenance: 'declared',
    params: { start_ms: 450, delay_ms: 0, duration_ms: 600, easing: [0.2, 0.9, 0.1, 1], old: { x: 100, y: 120, w: 120, h: 80 }, new: { x: 520, y: 300, w: 260, h: 140 }, frames_after_trigger: 2 } },
  { target: '#v|ren:bx', class: 'step', family: 'layout-update', provenance: 'measured', params: { from: 100, to: 520 } },
];

/** A fitted record in the shape src/analysis/fit writes (only the fields the builder reads). */
export const fittedEma = (over = {}) => ({
  schema: 'reva.motion/0', target: { el: 0, desc: 'DIV#hero', channel: 'drv:--s', untrusted_content: true },
  attribution: { label: 'scroll-linked', provenance: 'inferred' }, tier: 'fitted', class: 'first-order smoothing',
  model: { family: 'ema', params: { alpha_per_frame: { value: 0.25, provenance: 'fitted' }, mapS0: { value: 400 }, mapS1: { value: 1200 } }, law: 'per-frame', valid_at: { frame_ms: 8.333, refresh_hz: 120 },
    map: { shape: 'easeInOutCubic', a: 1, b: -0.5, s0_px: 400, s1_px: 1200, s0_provenance: 'fitted', s1_provenance: 'fitted', ...over } },
  smoothing: { type: 'ema', alpha: 0.25, lambda: 34.5, snap_eps: 0.001, asymmetric: null, law: 'per-frame', measured_at_hz: 120 },
  unknowns: [], ambiguity: null, flags: [],
});
export const fittedMapUnknownCorner = () => ({
  schema: 'reva.motion/0', target: { el: 1, desc: 'DIV#box', channel: 'drv:--p', untrusted_content: true },
  attribution: { label: 'scroll-linked', provenance: 'inferred' }, tier: 'fitted', class: 'scroll map',
  model: { family: 'scroll map (linear)', params: { mapS0: { value: null, provenance: 'unknown', withheld_value: -155.5, reason: 'no finite CI' }, mapS1: { value: 592.5, provenance: 'fitted' } }, law: null,
    map: { shape: 'linear', a: 1.25, b: -1.25, s0_px: -155.5, s1_px: 592.5, s0_provenance: 'unknown', s1_provenance: 'fitted' } },
  unknowns: [{ id: 'unk_map_start', reason: 'no sample below the map start', probe: 'scroll above the start of the range' }], ambiguity: null, flags: [],
});
export const fittedUnexplained = () => ({
  schema: 'reva.motion/0', target: { el: 2, desc: 'DIV#x', channel: 'drv:--q', untrusted_content: true }, attribution: { label: 'scroll-linked' },
  tier: 'unexplained', class: 'unknown', model: { family: 'unexplained', params: {}, law: null }, unknowns: [], flags: [],
});
export const truthLatch = () => [
  { scored: true, target: '#l|drv:--m', role: 'driver', class: 'tween', family: 'named-ease', ease: 'easeOutCubic', attribution: 'wheel',
    params: { duration: { value: 400, unit: 'ms' }, ease: 'easeOutCubic', latch: { visible_height_min_vh: 0.45, bottom_max_vh_plus_px: 8, arming_root_margin: '200% 0px', section_px: { top: 1500, height: 720 } } } },
];
