// The move contract: every word, constant and shape the stages of a scan share (DESIGN sections 2, 3.3, 4, 5.4).
// One file so a number lives once. The constants are a first setting from three sites [J], not findings.
// Pure: no browser, no file system, and nothing here imports another scan module, so any stage may import it.
import crypto from 'node:crypto';

export const SCHEMA = Object.freeze({ index: 'reva.moves/1', move: 'reva.move/1' });
export const RATE = 60;
/** Milliseconds as frames at the rate rows are recorded. */
export const framesOf = (ms, rate = RATE) => Math.round((ms * rate) / 1000);

// ---------------------------------------------------------------- the move model (DESIGN 2.1-2.4)
export const MODEL = Object.freeze({
  quietMs: 200,               // a run ends after this much stillness
  burstGapMs: 300,            // a load move ends at a gap this long between onsets
  shapePoints: 13, shapeStep: 0.05, shapeTolerance: 0.1,
  lengthTolerance: 0.15, lengthToleranceMinFrames: 2,
  bandJaccard: 0.34, bandMaxKeys: 2,
  foldOverlap: 0.7, foldTop: 3,      // the overlap is measured against the LARGER set
  sharedShare: 0.25, sharedMinWindows: 4,
  ambientMinRuns: 2, ambientTailFrames: 30, ambientLateFrames: 120,
  // a timer longer than the idle window (ambient.js onTimer): 3 alike runs on one beat of 0.5 s or more, the beat within 6 %, run lengths within 25 %
  ambientBeatRuns: 3, ambientBeatMin: 30, ambientBeatTol: 0.06, ambientBeatLen: 0.25,
  lagSpreadMs: 300, lagSpreadTests: 3,
  controlFrames: 24, clickControlFrames: 90,
  cursorPx: 120,
  noisePx: 1, noiseScale: 300, noiseDegrees: 3,
  hysteresisShare: 0.08, hysteresisShiftPx: 240,
  pinMinPx: 100,
});

// ---------------------------------------------------------------- what capture records and when it stops (DESIGN 3.3, 3.4, 3.6)
export const STOP = Object.freeze({
  quiet: Object.freeze({ hover: 18, out: 18, focus: 12, release: 12 }),   // n of W.quiet(n)
  focusFrames: Object.freeze([18, 12]), pressFrames: Object.freeze([12, 16]),
  hoverMax: 90, outMax: 60,
  openMin: 90, openLate: 120, lateQuiet: 120,     // the late part of an open, and a change past changeMin, end at 2 s quiet
  changeMin: 180, changeMax: 360,
  insidePatterns: 12,
});
export const SHOTS = Object.freeze({ floor: 15, cap: 30 });   // gate: a shot at least every `floor` frames; `cap` = 30 fps where nobody watches closely
export const ARRIVE = Object.freeze({ loadTailMs: 3000, idleMs: 4000, restMs: 1000, sweepMs: 3000, park: Object.freeze([2, 2]) });
export const APPROACH = Object.freeze({ outsidePx: 40, insidePx: 4, steps: 12 });
export const IDLE_WAIT_MS = 250;      // session option idleMs on scan takes; `reva look` keeps 2 s

/**
 * Phases of an `arrive` take, in order, as frames.json names them. Today's names stay, so `stage.js` chapters keep working.
 * A phase's end is the next phase's first frame or the take's last row: with the shot gate on, the last frame of a phase may have no picture.
 */
export const ARRIVE_PHASES = Object.freeze(['load', 'gate', 'idle', 'scroll-down', 'scroll-up', 'pointer-sweep']);
/** The part a test mark ends in: `<id>:<part>`. `opened` is the end of an open's reaction, `end` closes the test. */
export const TEST_PARTS = Object.freeze(['control', 'focus', 'hover', 'press', 'out', 'open', 'opened', 'close', 'end']);
/** `article~6f8a15:click:open` -> { id: 'article~6f8a15:click', part: 'open' }; null for a mark that is no test part. */
export function parseMark(name) {
  const s = String(name), at = s.lastIndexOf(':');
  if (at <= 0 || !TEST_PARTS.includes(s.slice(at + 1))) return null;
  return { id: s.slice(0, at), part: s.slice(at + 1) };
}

// ---------------------------------------------------------------- clips and what the card asks of them (DESIGN 5.4)
export const CLIP = Object.freeze({
  minW: 480, minH: 300, maxUpscale: 1.25, marginPx: 24, marginShare: 0.15,
  ratios: Object.freeze([[16, 10], [4, 3], [1, 1], [3, 4]]),
  maxMs: 4000, holdMs: 2000, gop: 8, posterQuality: 80,
  viewportShare: 0.4,         // a load move whose union box is under this share of the viewport is cropped
});

// ---------------------------------------------------------------- fit and code (DESIGN 3.5, 4.3)
export const FIT = Object.freeze({
  lawCheckShare: 0.05, lawCheckInstances: 8, lawCheckExtraFits: 2,
  keyframesMax: 24, keyframesShare: 0.01, namedEaseShare: 0.02,
  dotsMax: 90, curveMax: 64, elementsMax: 24,
});

// ---------------------------------------------------------------- words of the index (DESIGN 2.4, 2.7, 4.2)
export const GROUPS = Object.freeze([
  Object.freeze({ id: 'arriving', title: 'Arriving' }), Object.freeze({ id: 'scrolling', title: 'Scrolling' }),
  Object.freeze({ id: 'hover', title: 'Hover and press' }), Object.freeze({ id: 'opening', title: 'Opening and closing' }),
  Object.freeze({ id: 'between', title: 'Between pages' }), Object.freeze({ id: 'always', title: 'Always running' }),
]);
/** One row per kind: its library group, its rank weight, how its frame answers the hand. `scene` follows what drives it, see groupOf. */
export const KIND = Object.freeze({
  load: Object.freeze({ group: 'arriving', weight: 1.3, play: 'once' }),
  gate: Object.freeze({ group: 'arriving', weight: 1.3, play: 'once' }),
  scroll: Object.freeze({ group: 'scrolling', weight: 1.2, play: 'scrub' }),
  'scroll-up': Object.freeze({ group: 'scrolling', weight: 0.8, play: 'scrub' }),
  touch: Object.freeze({ group: 'hover', weight: 1, play: 'hover' }),
  open: Object.freeze({ group: 'opening', weight: 1.1, play: 'hover' }),
  change: Object.freeze({ group: 'between', weight: 1.2, play: 'once' }),
  ambient: Object.freeze({ group: 'always', weight: 0.7, play: 'loop' }),
  cursor: Object.freeze({ group: 'always', weight: 1, play: 'loop' }),
  scene: Object.freeze({ group: 'always', weight: 1.3, play: 'loop' }),
  media: Object.freeze({ group: 'always', weight: 0.6, play: 'loop' }),
  'page-scroll': Object.freeze({ group: 'scrolling', weight: 1.2, play: 'scrub' }),
});
export const KINDS = Object.freeze(Object.keys(KIND));
/** A scene driven by scroll sits with the scroll moves and scrubs; any other scene is always running. */
export const groupOf = (kind, driver = null) => (kind === 'scene' && driver === 'scroll' ? 'scrolling' : KIND[kind].group);
export const playOf = (kind, driver = null) => (kind === 'scene' && driver === 'scroll' ? 'scrub' : KIND[kind].play);

export const TRIGGERS = Object.freeze(['load', 'scroll-linked', 'scroll-triggered', 'hover', 'press', 'focus', 'click', 'page', 'time', 'pointer']);
export const FRAME_SHAPES = Object.freeze(['crop', 'viewport']);
export const PLAY = Object.freeze(['hover', 'once', 'loop', 'scrub', 'tap']);
export const CURVES = Object.freeze(['tween', 'spring', 'map', 'steps', 'keyframes', 'none']);
export const PROOFS = Object.freeze(['declared', 'fitted', 'sampled', 'seen']);
export const PHONE = Object.freeze(['same', 'own', 'none', 'not-recorded']);

// ---------------------------------------------------------------- why values are missing, and what a move's values are (DESIGN 5)
/** `moves[].gap`: one sentence, said where the card would show what is missing. */
export const GAPS = Object.freeze({
  canvas: 'This scene is drawn on a canvas. Its frames are real. Its values cannot be read.',
  media: 'This is a video file. Its frames are real, but it runs on its own clock.',
  noLaw: 'No simple curve fits this, so the code replays what was recorded.',
  noRows: 'Seen in the pictures. Its values could not be read.',
  page: 'The page glides after the wheel, and no single law describes how.',
  wheel: 'The wheel drives a scene here, so the page itself has no scroll law.',
  morph: 'The shape itself changes here, which this code cannot write. The clip shows it.',
});
export const STATUS = Object.freeze({ exact: 'Exact', measured: 'Measured', recorded: 'Recorded', pictures: 'Pictures only' });
const EXACT_FROM = { gsap: "Read from the site's own GSAP code.", lottie: "Read from the site's own Lottie file.", css: "Read from the site's own CSS." };
/**
 * A move's one status, decided here and nowhere else, from its moves.json entry. The proof decides: values from the site's own code
 * are Exact, a fitted law is Measured, a recording replayed frame by frame is Recorded, and a move with no values is Pictures only.
 * Declared always wins: a reason why values could not be read never stands beside values that were read.
 * @param {{proof?:{source?:string, via?:string, errorPct?:number|null, frames?:number|null}, gap?:string|null, frame?:{clip?:string|null}|null}} m
 * @returns {{key:'exact'|'measured'|'recorded'|'pictures', word:string, line:string|null, note:string|null, reason:string|null, clip:string|null}}
 *   line: how the values were read, in one sentence (for Pictures only, that the clip is what there is); note: what Copy gives, when it is less than the whole move; reason: why there are no values
 *   (Pictures only); clip: why there is no clip, when the gap says that and nothing about the values
 */
export function moveStatus(m) {
  const p = m?.proof || {}, gap = empty(m?.gap) ? null : m.gap;
  const aboutValues = gap != null && gap !== GAPS.morph && Object.values(GAPS).some((g) => gap.startsWith(g));
  const clip = gap != null && !aboutValues && gap !== GAPS.morph ? gap : null;
  const note = gap === GAPS.morph ? 'Copy gives the timing and the movement. The change of shape itself is in the clip.' : null;
  if (p.source === 'declared') return { key: 'exact', word: STATUS.exact, line: EXACT_FROM[p.via] ?? EXACT_FROM.css, note, reason: null, clip };
  if (p.source === 'fitted') {
    const err = Number.isFinite(p.errorPct) ? `, within ${+(+p.errorPct).toFixed(p.errorPct < 1 ? 2 : 1)} %` : '';
    return { key: 'measured', word: STATUS.measured, line: `Fitted to ${p.frames ? `all ${p.frames} recorded frames` : 'the recorded frames'}${err}.`, note, reason: null, clip };
  }
  if (p.source === 'sampled') return { key: 'recorded', word: STATUS.recorded, line: 'No simple curve fits, so the values are kept as recorded.', note: note ?? 'Copy replays the recorded path frame by frame.', reason: null, clip };
  return { key: 'pictures', word: STATUS.pictures, line: m?.frame?.clip ? 'The clip shows it as it ran.' : null, note: null, reason: gap ?? GAPS.noRows, clip: null };
}

export const RANK = Object.freeze({ groupsBoost: 0.25, countBoost: 0.15, topMin: 6, topMax: 12, topPerGroup: 3, topMustHave: Object.freeze(['arriving', 'scrolling', 'hover', 'between']) });
/** DESIGN 2.7: notice of the lead group, weighted by trigger, more for a move with several groups and for one seen often. */
export const rankScore = (notice, kind, groups = 1, n = 1) => notice * KIND[kind].weight * (1 + RANK.groupsBoost * Math.log2(Math.max(1, groups))) * (1 + RANK.countBoost * Math.log2(Math.max(1, n)));

// ---------------------------------------------------------------- own motion (DESIGN 2.3)
// `ren:translate`, `ren:scale` and `ren:rotate` are the CSS individual transform properties. They are no mirrors: computed
// `transform` does not include them, so ren:tx and friends stay still while they animate. Parse them with axisParts and rotateDeg.
// `ren:text` is the number in a text, and `ren:chars` is the name kept for the discovery text channel of 3.6, so a count-up or a
// scramble makes a run. `ren:tz`, `ren:transform` and `drv:*` are not own motion.
const FAMILIES = [
  [/^ren:(tx|ty|translate)$/, 'move'], [/^ren:(sx|sy|scale)$/, 'scale'], [/^ren:(rz|skx|rotate)$/, 'rotate'], [/^ren:opacity$/, 'fade'],
  [/^ren:(color|bg|fill|stroke)(\.|$)/, 'colour'], [/^ren:(clipPath|maskPos)(\.|$)/, 'clip'], [/^ren:filter$/, 'filter'], [/^ren:bgPos(\.|$)/, 'bgpos'],
  [/^ren:(wght|wdth|fvar\.)/, 'font'], [/^ren:radius$/, 'radius'], [/^ren:dash$/, 'dash'], [/^ren:--/, 'var'], [/^ren:(text|chars)$/, 'text'],
];
const BOX = /^ren:(bx|by|bw|bh)$/;
/** The family of a channel, null when it is no own motion. */
export function familyOf(ch) { for (const [re, f] of FAMILIES) if (re.test(ch)) return f; return null; }
/** Box channels count as own motion only when the element has a birth or a style write inside the run. */
export const isBoxChannel = (ch) => BOX.test(ch);
/** An amplitude in px-equivalents, so channels compare: the lead channel, and the noise test. */
export function pxEquivalent(ch, amp) {
  const f = familyOf(ch);
  return f === 'fade' || f === 'scale' ? amp * MODEL.noiseScale : f === 'rotate' ? amp * MODEL.noiseDegrees : amp;
}

// ---------------------------------------------------------------- identity, law class, move id (DESIGN 2.1, 4.2)
/** The fingerprint of a run: "is this exactly the same?". run: { fams, k0, k1, shape, amp } */
export function identity(run) {
  const amp = run.amp > 0 ? Number(run.amp.toPrecision(2)) : 0;
  return `${[...run.fams].sort().join('+')}|${run.k1 - run.k0}|${(run.shape || []).join(',')}|${amp}`;
}
/**
 * May two runs share one law? Runs with no numeric lead match by families and length alone.
 * The tolerance has an epsilon: shapes sit on a 0.05 grid, where 0.8 - 0.7 is 0.10000000000000009 in floats.
 */
export function sameLaw(a, b) {
  const fa = [...a.fams].sort().join(), fb = [...b.fams].sort().join();
  if (fa !== fb || a.lead !== b.lead) return false;
  const la = a.k1 - a.k0, lb = b.k1 - b.k0;
  if (Math.abs(la - lb) > Math.max(MODEL.lengthToleranceMinFrames, MODEL.lengthTolerance * Math.max(la, lb))) return false;
  if (!a.shape || !b.shape) return !a.shape && !b.shape;
  return a.shape.length === b.shape.length && a.shape.every((x, i) => Math.abs(x - b.shape[i]) <= MODEL.shapeTolerance + 1e-9);
}
/** A selector with its member index gone, so the members of a list are one key group. */
export const selectorGroup = (key) => String(key).replace(/:nth-(of-type|child)\(\d+\)/g, '').replace(/\s+/g, ' ').trim();
/** Coarse on purpose: two takes of one page differ by a frame or two, and the id must not. */
export const lawSignature = (run) => `${[...run.fams].sort().join('+')}|${run.lead ?? ''}|${Math.round(Math.log(Math.max(1, run.k1 - run.k0 + 1)) / Math.log(1.3))}`;
/** `m-` + 8 hex, stable across runs. Two moves may hash alike on one page: the caller keeps the first and suffixes the rest. */
export const moveId = (kind, leadKey, lawSig) => `m-${crypto.createHash('sha1').update(`${kind}|${selectorGroup(leadKey)}|${lawSig}`).digest('hex').slice(0, 8)}`;
export const MOVE_ID = /^m-[0-9a-f]{8}(-\d+)?$/;

// ---------------------------------------------------------------- tally (DESIGN 2.2): every recorded run lands in exactly one bucket
export const BUCKETS = Object.freeze(['inMoves', 'rideAlong', 'setup', 'between', 'control', 'clocked', 'repeat', 'belowNoise', 'newDocument']);
export const emptyTally = () => ({ runs: 0, ...Object.fromEntries(BUCKETS.map((b) => [b, 0])) });
export function tallyProblems(t) {
  const out = [];
  if (!t || !Number.isFinite(t.runs)) return ['tally: no run count'];
  let sum = 0;
  for (const b of BUCKETS) { if (!Number.isInteger(t[b]) || t[b] < 0) out.push(`tally.${b}: not a count`); else sum += t[b]; }
  if (!out.length && sum !== t.runs) out.push(`tally: buckets add up to ${sum}, runs are ${t.runs}`);
  return out;
}

// ---------------------------------------------------------------- shape of the files (DESIGN 4.2, 4.3)
// Stages fill the index in turn: 'moves' after S7, 'fit' after S8, 'final' after S9. Each check asks only what its stage owes.
const STAGES = ['moves', 'fit', 'final'];
const reached = (stage, s) => STAGES.indexOf(stage) >= STAGES.indexOf(s);
const empty = (v) => v === undefined || v === null || v === '';

/** @returns {string[]} what is wrong with one entry of `moves`; empty when it holds up */
export function moveProblems(m, { stage = 'final' } = {}) {
  const at = `move ${m?.id ?? '?'}`, out = [];
  if (!MOVE_ID.test(m?.id ?? '')) out.push(`${at}: bad id`);
  if (!KINDS.includes(m?.kind)) { out.push(`${at}: unknown kind ${m?.kind}`); return out; }
  for (const f of ['name', 'sentence', 'trigger', 'rank', 'phone']) if (empty(m[f])) out.push(`${at}: no ${f}`);
  if (!GROUPS.some((g) => g.id === m.group)) out.push(`${at}: unknown group ${m.group}`);
  if (m.trigger && !TRIGGERS.includes(m.trigger.kind)) out.push(`${at}: unknown trigger ${m.trigger.kind}`);
  if (!Number.isInteger(m.n) || m.n < 1) out.push(`${at}: n is no count`);
  if (!Array.isArray(m.instances) || !m.instances.length) out.push(`${at}: no instance`);
  if (m.phone && !PHONE.includes(m.phone.status)) out.push(`${at}: unknown phone status ${m.phone.status}`);
  if (reached(stage, 'fit')) {
    for (const f of ['time', 'curve', 'proof']) if (empty(m[f])) out.push(`${at}: no ${f}`);
    if (m.curve && !CURVES.includes(m.curve.kind)) out.push(`${at}: unknown curve ${m.curve.kind}`);
    if (m.proof && !PROOFS.includes(m.proof.source)) out.push(`${at}: unknown proof ${m.proof.source}`);
    if (m.proof?.source === 'seen' && empty(m.gap)) out.push(`${at}: seen, and no gap sentence`);
    if (m.proof && m.proof.source !== 'seen' && m.proof.source !== 'sampled' && m.gap === GAPS.noLaw) out.push(`${at}: ${m.proof.source}, and a gap that says no curve fits`);
  }
  if (reached(stage, 'final')) {
    const fr = m.frame;
    if (!fr) out.push(`${at}: no frame`);
    else {
      if (!FRAME_SHAPES.includes(fr.shape)) out.push(`${at}: unknown frame shape ${fr.shape}`);
      if (!PLAY.includes(fr.play)) out.push(`${at}: unknown play ${fr.play}`);
      if (empty(fr.clip) && empty(m.gap)) out.push(`${at}: no clip and no reason`);
    }
  }
  return out;
}

/** @returns {string[]} what is wrong with moves.json */
export function indexProblems(doc, { stage = 'final' } = {}) {
  if (doc?.schema !== SCHEMA.index) return [`moves.json: schema is ${doc?.schema}`];
  const out = [], ids = new Set();
  if (empty(doc.untrusted_content)) out.push('moves.json: no untrusted_content note');
  if (!Array.isArray(doc.moves)) return [...out, 'moves.json: no moves'];
  for (const m of doc.moves) { if (ids.has(m.id)) out.push(`move ${m.id}: id seen twice`); ids.add(m.id); out.push(...moveProblems(m, { stage })); }
  for (const id of doc.top || []) if (!ids.has(id)) out.push(`top: ${id} is no move`);
  if ((doc.top || []).length && (doc.top.length < RANK.topMin || doc.top.length > RANK.topMax)) out.push(`top: ${doc.top.length} moves, wanted ${RANK.topMin}-${RANK.topMax} or none`);
  const grouped = new Map();
  for (const g of doc.groups || []) for (const id of g.moves || []) { if (!ids.has(id)) out.push(`group ${g.id}: ${id} is no move`); grouped.set(id, (grouped.get(id) || 0) + 1); }
  for (const id of ids) if (grouped.get(id) !== 1) out.push(`move ${id}: in ${grouped.get(id) || 0} groups`);
  out.push(...tallyProblems(doc.tally));
  return out;
}

/** @returns {string[]} what is wrong with moves/<id>.json */
export function moveFileProblems(doc, { stage = 'final' } = {}) {
  const at = `moves/${doc?.id}.json`;
  if (doc?.schema !== SCHEMA.move) return [`${at}: schema is ${doc?.schema}`];
  const out = [];
  if (!Array.isArray(doc.groups)) return [...out, `${at}: no groups`];
  for (const g of doc.groups) {
    if ((g.elements || []).length > FIT.elementsMax) out.push(`${at}: group ${g.name}: more than ${FIT.elementsMax} elements`);
    if ((g.dots || []).length > FIT.dotsMax) out.push(`${at}: group ${g.name}: more than ${FIT.dotsMax} dots`);
    if ((g.curve || []).length > FIT.curveMax) out.push(`${at}: group ${g.name}: more than ${FIT.curveMax} curve points`);
    if (reached(stage, 'fit')) {
      if (!PROOFS.includes(g.provenance)) out.push(`${at}: group ${g.name}: unknown provenance ${g.provenance}`);
      if (g.provenance !== 'seen' && !g.law) out.push(`${at}: group ${g.name}: no law`);
    }
  }
  if (reached(stage, 'final') && !doc.gl && doc.groups.some((g) => g.provenance !== 'seen') && !doc.code) out.push(`${at}: no code`);
  return out;
}
