// Why a deep-run check failed, as data (26 Oct, L7 / S16). Every failing check of a capture / capture-inner gate, a states
// gate, or a crashed verification step gets one or more causes {check, bucket, label: 'tool'|'site', reason, evidence}.
//   tool: the harness, the capture or the rebuild is wrong or incomplete there (fix the tool);
//   site: the page itself is not reproducible there (live / self-moving content, randomness the page draws outside every
//         clock and seed the harness controls). Never a pass: a site cause only says why a check cannot hold.
// Pure: gate JSON (+ the step result for a crash) in, causes out. Evidence the gate JSON alone does not hold (root causes
// of a rebuild difference against the session the table was captured in, the HTML parser's re-nesting of the rebuild
// markup) is computed at capture time by rebuildEvidence() (pure, snapshots + tables in) and stored in the gate
// (r.rebuild.evidence), so the stored gate is enough to label it; stored gates from before are labelled the same way
// by recomputing it offline from their local snapshots (L7 evidence run, $P/lanes/L7-causes.tsv).
// Read by: capture-gate.json verdict.causes, the step's verify.causes (corpus truth / criterion 4).
import { compareSnapshots } from './compare.js';
import { parserMoves } from './rebuild.js';

const parentOf = k => { const i = Math.max(k.lastIndexOf('/'), k.lastIndexOf('#')); return i > 0 ? k.slice(0, i) : null; };
const under = (k, p) => k === p || k.startsWith(p + '/') || k.startsWith(p + '#');
// a box or one of these props differing alone is a symptom (the element grew or moved because something else changed)
const SIZE = /^(width|height|block-size|inline-size|perspective-origin|transform-origin|grid-template-(rows|columns)|min-|max-)/;
const POS = /^(top|left|right|bottom|inset|inset-block-start|inset-block-end|inset-inline-start|inset-inline-end)$/;
const MEDIA = /\/(video|img|canvas|iframe|picture|object|embed)\[\d+\]$/;
const FAMILY = /^(transition|border|outline|padding|margin|mask|background|animation|font|inset|grid|flex|gap|column|list-style|text-decoration|place|overflow|scroll|container|offset)/;
const family = p => { const w = p.split(' ').pop().replace(/^-webkit-/, ''); return FAMILY.exec(w)?.[1] || w; };

/**
 * Root causes of an oracle difference a -> b (pure). An element whose only misses are its box / size / position is a
 * symptom: dropped when it moved without changing size, or when a descendant also differs (it grew because of it).
 * What remains is classified: 'renest' (inside a region the HTML parser re-nests, see parserMoves), 'element-missing',
 * 'element-extra', 'text', 'font', 'pseudo-missing', 'media-size' (canvas/video/img/iframe box only), 'leaf-size' (a
 * leaf's box only), 'lossy-var-shorthand' (the table's rule for that property family is a var() shorthand the CSSOM
 * could not serialise: empty longhands), 'custom-prop', 'transition', 'animation', 'pseudo:<prop>', 'prop:<prop>'.
 * @param {object} a snapshot (reference)  @param {object} b snapshot (compared)
 * @param {object[]} misses compareSnapshots(a, b).misses with maxDetail Infinity
 * @param {{moves?:object[], table?:object}} [o] parser moves of the table; the table (empty longhands per element)
 * @returns {{k:string, cat:string, props:string[], a?:string, b?:string}[]}
 */
export function diffOrigins(a, b, misses, { moves = [], table = null } = {}) {
  const by = new Map();
  for (const m of misses) { let e = by.get(m.k); if (!e) by.set(m.k, e = { k: m.k, kinds: new Set(), props: [], ms: [] }); e.kinds.add(m.kind); if (m.prop) e.props.push(m.prop); e.ms.push(m); }
  const am = new Map(a.els.map(e => [e.k, e])), bm = new Map(b.els.map(e => [e.k, e]));
  const hasDesc = new Set();
  for (const k of by.keys()) for (let p = parentOf(k); p; p = parentOf(p)) { if (hasDesc.has(p)) break; hasDesc.add(p); }
  const regions = moves.map(m => m.parent).filter(Boolean);
  const emptyFams = table ? emptyFamiliesOf(table) : null;
  const out = [], sym = [];
  for (const e of by.values()) {
    const own = e.props.filter(p => !SIZE.test(p.split(' ').pop()) && !POS.test(p.split(' ').pop()));
    const geomOnly = [...e.kinds].every(k => k === 'box' || k === 'prop') && own.length === 0;
    const ea = am.get(e.k), eb = bm.get(e.k);
    const sameSize = ea && eb && Math.abs(ea.b[2] - eb.b[2]) <= 0.5 && Math.abs(ea.b[3] - eb.b[3]) <= 0.5;
    if (geomOnly && (sameSize || hasDesc.has(e.k))) { sym.push(e); continue; }
    let cat;
    if (regions.some(p => under(e.k, p))) cat = 'renest';
    else if (e.kinds.has('element-missing')) cat = 'element-missing';
    else if (e.kinds.has('element-extra')) cat = 'element-extra';
    else if (e.kinds.has('text')) cat = 'text';
    else if (e.kinds.has('font')) cat = 'font';
    else if (e.kinds.has('pseudo-missing')) cat = 'pseudo-missing';
    else if (geomOnly) cat = MEDIA.test(e.k) ? 'media-size' : 'leaf-size';
    else {
      const ef = emptyFams?.get(e.k);
      const p = own[0], w = p.split(' ').pop();
      if (ef && own.some(x => ef.has(family(x)))) cat = 'lossy-var-shorthand';
      else cat = p.includes('::') ? `pseudo:${w}` : w.startsWith('--') ? 'custom-prop' : /^transition/.test(w) ? 'transition' : /^animation/.test(w) ? 'animation' : `prop:${w}`;
    }
    const m0 = e.ms.find(m => m.prop && own.includes(m.prop));
    out.push({ k: e.k, cat, props: own.slice(0, 4), ...(m0 ? { a: String(m0.a ?? '').slice(0, 80), b: String(m0.b ?? '').slice(0, 80) } : {}) });
  }
  // only symptoms (every difference is a box / size / position one): the origin is the deepest element whose SIZE differs
  // with no differing descendant ('subpixel' when every number differs by < 0.5 px: a value the table holds rounded, e.g.
  // CSSOM's 6 significant digits inside a compound value, or text measured at another sub-pixel width)
  if (!out.length && sym.length) {
    const sz = e => e.props.some(p => SIZE.test(p.split(' ').pop()));
    let roots = sym.filter(e => !hasDesc.has(e.k) && sz(e));
    if (!roots.length) roots = sym.filter(e => !hasDesc.has(e.k));
    const num = v => (String(v ?? '').match(/-?\d*\.?\d+/g) || []).map(Number);
    for (const e of roots) {
      const d = Math.max(0, ...e.ms.filter(m => m.prop).flatMap(m => { const x = num(m.a), y = num(m.b); return x.length === y.length ? x.map((v, i) => Math.abs(v - y[i])) : [Infinity]; }));
      const m0 = e.ms.find(m => m.prop) || e.ms[0];
      out.push({ k: e.k, cat: d < 0.5 ? 'subpixel' : 'geometry', props: e.props.slice(0, 4), a: String(m0.a ?? '').slice(0, 80), b: String(m0.b ?? '').slice(0, 80) });
    }
  }
  // nested origins of one category under one root count once (the root)
  const keys = new Map(out.map(o => [o.k, o.cat]));
  return out.filter(o => { for (let p = parentOf(o.k); p; p = parentOf(p)) if (keys.get(p) === o.cat) return false; return true; });
}

/** element key -> property families whose declaration in the table (a matched rule or the inline style) has an EMPTY value:
 *  a shorthand holding var() the CSSOM read back as empty longhands and the authored text could not supply (ruletable.js
 *  styleDecls, counted in table.lossy). The rebuild drops such a declaration. */
export function emptyFamiliesOf(T) {
  const nodes = [];
  const walk = n => { if (!n || typeof n === 'string') return; nodes[n.i] = n; (n.c || []).forEach(walk); if (n.sr) n.sr.c.forEach(walk); };
  for (const d of T.docs || []) walk(d.tree);
  const out = new Map();
  T.els.forEach((e, i) => {
    let s = null;
    // an empty custom property (`--tw-pan-x: ;`) is authored that way, not a lost shorthand
    for (const id of e.r || []) for (const d of T.rules[id]?.d || []) if (d[1] === '' && !d[0].startsWith('--')) (s || (s = new Set())).add(family(d[0]));
    for (const d of nodes[i]?.s || []) if (d[1] === '' && !d[0].startsWith('--')) (s || (s = new Set())).add(family(d[0]));
    if (s) out.set(e.k, s);
  });
  return out;
}

// misses kept per compare for the root search (a whole-page shift on a 30k-element page is millions of misses)
const MAX_MISSES = 200000;
const countBy = list => list.reduce((m, x) => ((m[x] = (m[x] || 0) + 1), m), {});
const topOf = m => Object.entries(m).sort((x, y) => y[1] - x[1]);

/**
 * Rebuild evidence for the stored gate (pure; computed by runCaptureSuite, and offline for stored gates). For each failing
 * rebuild point: the root causes of its oracle difference. At a captured point the rebuild is compared with the CAPTURE
 * session (`cap`, the replay the table was taken in): a difference there is the rebuild's / table's own; one that exists
 * only against orig1 follows the replays' instability (identity / capture session). A held-out point has no capture
 * session: compared with orig1 (script-owned regions excluded, as the gate does).
 * @param {{points:object[], results:object, read:(run:string, id:string)=>object|null, tables:object, owned?:object}} o
 *   results: compareRuns(orig1, rb) per point; read('orig1'|'cap'|'rb', pointId) -> snapshot or null
 * @returns {{moves:object, perPoint:object}}
 */
export function rebuildEvidence({ points, results, read, tables, owned = {}, unstable = {} }) {
  const moves = {}, mv = {};
  for (const [cls, T] of Object.entries(tables)) { mv[cls] = parserMoves(T); if (mv[cls].length) moves[cls] = { n: mv[cls].length, why: countBy(mv[cls].map(m => m.why.replace(/^<[\w-]+> inside <p>$/, '<block> inside <p>'))), repaired: mv[cls].filter(m => m.repair).length, sample: mv[cls].slice(0, 3).map(m => ({ k: m.k, why: m.why })) }; }
  const perPoint = {};
  for (const pt of points) {
    const r = results[pt.id];
    if (!r || r.pass) continue;
    if (r.oracle.pass) { perPoint[pt.id] = { vs: 'orig1', oracle: true, pixel: r.pixel.reason || null, ...(r.unpaintable ? { unpaintable: true } : {}) }; continue; }
    const b = read('rb', pt.id);
    let a = pt.kind === 'captured' ? read('cap', pt.id) : null, vs = 'cap';
    if (!a) { a = read('orig1', pt.id); vs = 'orig1'; }
    if (!a || !b) { perPoint[pt.id] = { vs, error: 'snapshot missing' }; continue; }
    const o = compareSnapshots(a, b, { maxDetail: MAX_MISSES, owned: vs === 'orig1' ? owned[pt.id] || [] : [] });
    if (o.pass) { perPoint[pt.id] = { vs, followsReplay: true, failedVsOrig1: r.oracle.failedElements }; continue; }
    let or = diffOrigins(a, b, o.misses, { moves: mv[pt.cls] || [], table: tables[pt.cls] });
    // against orig1 (held-out point), a root inside a region where orig1 and the identity replay also differ follows the
    // replays' instability, not the rebuild
    const regs = vs === 'orig1' ? (unstable[pt.id]?.regions || []).map(r => r.k) : [];
    const inReg = x => regs.some(r => under(x.k, r) || under(r, x.k));
    const replay = or.filter(inReg).length;
    if (replay) or = or.filter(x => !inReg(x));
    if (!or.length) { perPoint[pt.id] = { vs, followsReplay: true, failedVsOrig1: r.oracle.failedElements, inUnstable: replay }; continue; }
    perPoint[pt.id] = { vs, failed: o.failedElements, cats: countBy(or.map(x => x.cat)), ...(replay ? { replayRoots: replay } : {}), ...(o.misses.length >= MAX_MISSES ? { truncated: true } : {}), sample: or.slice(0, 6) };
  }
  return { moves, perPoint };
}

/** Capture-session evidence (pure): for each captured point where the capture session differs from orig1, how many
 *  differing elements, and how many of them sit in a region where orig1 and the identity replay also differ (the same
 *  instability, not the CDP attach). */
export function sessionEvidence({ points, sameAsOrig1, read, unstable = {} }) {
  const out = {};
  for (const pt of points) {
    if (sameAsOrig1[pt.id] !== false) continue;
    const a = read('orig1', pt.id), b = read('cap', pt.id);
    if (!a || !b) { out[pt.id] = { error: 'snapshot missing' }; continue; }
    const o = compareSnapshots(a, b, { maxDetail: MAX_MISSES });
    const keys = [...new Set(o.misses.map(m => m.k))];
    const regs = (unstable[pt.id]?.regions || []).map(r => r.k);
    const inUnstable = keys.filter(k => regs.some(r => under(k, r) || under(r, k))).length;
    out[pt.id] = { failed: o.failedElements, byKind: o.byKind, pixelOnly: o.pass, inIdentityUnstable: inUnstable, identityFailedHere: !!unstable[pt.id], sample: keys.slice(0, 4) };
  }
  return out;
}

// ---------- labels ----------
const C = (check, bucket, label, reason, evidence = {}) => ({ check, bucket, label, reason, evidence });

/** A crashed / killed / timed-out verification step (its step result). */
export function crashCause(step) {
  const m = String(step?.reason || '');
  const ev = { status: step?.status, reason: m.slice(0, 160), ...(step?.peakRssMb ? { peakRssMb: step.peakRssMb } : {}), ...(step?.wallMs ? { wallMs: step.wallMs } : {}) };
  if (/STOP file|deferred:stop/.test(m)) return C('crash', 'stop-kill', 'tool', 'the runner killed the in-flight step on a STOP file (L3: a stop now lets in-flight steps finish)', ev);
  if (/^timeout:|wall cap|after \d+ s$/.test(m) || step?.status === 'timeout') return C('crash', 'wall-timeout', 'tool', 'stopped by a wall-clock cap (L3: caps are backstops, a stall watchdog decides)', ev);
  if (/^clock\.(runFor|pauseAt|fastForward)/.test(m) && !/closed|destroyed/i.test(m)) return C('crash', 'page-timer-error', 'tool', "the page's own timer exception, rethrown by Playwright's fake clock after it ran every timer, failed the step (L7: recorded, the replay goes on)", ev);
  if (/Execution context was destroyed|navigation/i.test(m)) return C('crash', 'state-navigated', 'tool', "a state's input navigated the page and the whole step failed (fa678f7: that state is skipped and reported)", ev);
  if (/click target not found/.test(m)) return C('crash', 'state-target-gone', 'tool', "a state's click target was gone and the whole step failed (fa678f7: that state is skipped and reported)", ev);
  if (/is not a function/.test(m)) return C('crash', 'state-not-clickable', 'tool', 'the dom-click fallback called click() on an element without it (an SVG element; L7: the click event is dispatched)', ev);
  if (/page\.screenshot: Timeout/.test(m)) return C('crash', 'screenshot-timeout', 'tool', 'a full-page screenshot did not complete in time (no compositor frame); the harness retries once only after a font-load timeout', ev);
  if (/Target page, context or browser has been closed|Target closed|browser has been closed/i.test(m)) return C('crash', 'browser-gone', 'tool', "the browser or its renderer died mid-session and the step failed with it: not a pool recycle (the gate's replays launch their own browser; a BrowserPool recycles only after its sessions drained), so a renderer crash / memory (evidence.peakRssMb)", ev);
  if (step?.status === 'killed') return C('crash', 'killed', 'tool', `the runner killed the step (${m.slice(0, 80)})`, ev);
  return C('crash', 'harness-error', 'tool', 'the step failed with an error of the harness (see evidence.reason)', ev);
}

/** Identity: two replays of the same archive differ (indeterminate gate). */
function identityCauses(g) {
  const v = g.verdict || {};
  if (v.installStalled) return [C('identity', 'clock-stall', 'tool', 'the fake-clock install stalled (machine overload): Date was reset but performance.now()/rAF ticks were not, so replays are not comparable', { clockLateMs: v.clockLateMs })];
  const fails = g.identity?.fails || {}, unst = g.identity?.unstable || {};
  const per = {};
  for (const id of Object.keys(fails)) {
    const u = unst[id];
    let b;
    if (!u) b = 'unknown';
    else if (!u.oracleFailed) {
      const k = Object.keys(u.pixel?.opaqueUnder || {});
      b = k.includes('canvas') ? 'canvas-pixels' : k.includes('video') ? 'video-pixels' : k.includes('iframe') ? 'iframe-pixels' : k.some(x => x === 'img' || x === 'picture') ? 'image-pixels' : k.includes('svg') ? 'svg-pixels' : 'pixels-only';
    } else {
      const r = {}; for (const reg of u.regions || []) for (const [x, n] of Object.entries(reg.reasons || {})) r[x] = (r[x] || 0) + n;
      const top = topOf(r)[0]?.[0] || 'unknown';
      b = top.startsWith('style:') ? 'style-state' : top === 'layout(media)' ? 'layout-media' : top;
    }
    (per[b] || (per[b] = [])).push(id);
  }
  const SITE = { 'canvas-pixels': 'pixels inside <canvas> differ between identical replays with every element equal: the page keeps drawing live content (a render loop / clock outside the main-thread fake clock: workers, WebGL/WebGPU, audio time)', 'video-pixels': 'pixels inside <video> differ between identical replays with every element equal: live media (a stream or a frame decoded at another moment)', 'iframe-pixels': 'pixels inside an <iframe> differ between identical replays: live embedded content the page does not render itself' };
  const TOOL = {
    'image-pixels': 'pixels inside <img> differ with every element equal: raster/decode history (decode scale, image quality after scroll), or an animated image; the harness pins neither',
    'svg-pixels': 'pixels inside <svg> differ with every element equal: SVG painting not pinned (SMIL animation runs on real time; the harness freezes CSS/WAAPI and media only)',
    'pixels-only': 'pixels differ with every element equal and nothing opaque under them (raster / compositing timing)',
    'motion-state': 'script-driven transform/opacity values differ between identical replays: an input the harness does not pin (real-frame scroll/observer callbacks interleaving with fake-clock timers, a worker or crypto random source)',
    'custom-property': 'script-written custom properties differ between identical replays (same mechanism as motion-state)',
    layout: 'layout differs between identical replays (script-written sizes, lazy content that landed at another point of the sweep)',
    'layout-media': 'media boxes differ between identical replays (media loaded / sized at another point: load order race)',
    'dom-differs': 'the DOM differs between identical replays (script inserted/removed other nodes: a load-order or timing race)',
    'text-differs': 'text differs between identical replays (script-written text from a source the harness does not pin)',
    'font-differs': 'a different font was used between identical replays (font load landed at another point)',
    'animation-declaration': 'animation/transition declarations differ between identical replays (script toggled classes at another point)',
    'style-state': 'computed style differs between identical replays (script toggled state at another point)',
    unknown: 'identity failed without stored regions',
  };
  return topOf(Object.fromEntries(Object.entries(per).map(([b, ids]) => [b, ids.length]))).map(([b, n]) => {
    const site = !!SITE[b];
    const id0 = per[b][0], u0 = unst[id0];
    return C('identity', b, site ? 'site' : 'tool', site ? SITE[b] : TOOL[b] || TOOL.unknown, {
      points: n, of: Object.keys(fails).length, sample: per[b].slice(0, 3),
      ...(u0?.pixel ? { pixel: { diffPx: u0.pixel.diffPx, blob: u0.pixel.blob, under: u0.pixel.opaqueUnder } } : {}),
      ...(u0?.regions?.length ? { regions: u0.regions.slice(0, 2).map(r => ({ k: r.k, reason: r.reason, props: r.props?.slice(0, 3) })) } : {}),
      noisePerClass: g.noise?.perClass || null,
    });
  });
}

const REBUILD = {
  renest: ['tool', 'the HTML parser re-nested the rebuild markup (a block inside <p>, <a> in <a>, <li> in <li>, an element directly in <html>): the rebuild DOM was not the table DOM (L7: such content is put in by the harness, rebuild.js parserMoves)'],
  'lossy-var-shorthand': ['tool', "a shorthand holding var() could not be serialised by the CSSOM and the authored text was not mapped: the table carries empty longhands and the rebuild drops the declaration (L7: cross-origin sheets' text, escapes and engine-dropped statements now map)"],
  'element-missing': ['tool', 'an element of the original is missing in the rebuild (the table did not express it: custom element upgrade, an iframe document, a shadow root)'],
  'element-extra': ['tool', 'the rebuild has an element the original did not (markup the table expresses differently)'],
  text: ['tool', 'rendered text differs (script-written text the rebuild does not reproduce at that point)'],
  font: ['tool', 'the rebuild used another platform font than the original (a font the table did not carry or that was not loaded)'],
  'pseudo-missing': ['tool', 'a ::before/::after/::marker present on one side only'],
  'media-size': ['tool', "media intrinsic size differs (the original's script loaded the video/image; the rebuild, with no script, does not)"],
  'leaf-size': ['tool', 'an element box differs with no property difference (intrinsic size: form control, replaced content, text wrap)'],
  subpixel: ['tool', 'sizes differ by < 0.5 px only (the box passes, the computed value does not): a number the table holds rounded (CSSOM serialises 6 significant digits inside compound values) or text measured at another sub-pixel width'],
  geometry: ['tool', 'only boxes / sizes / positions differ, no property names a cause (layout from content the table reproduces differently)'],
  'custom-prop': ['tool', 'a custom property value differs (e.g. url() absolutised in the table where the page keeps the authored token)'],
  transition: ['tool', 'transition values differ (a transition declaration the table did not carry)'],
  animation: ['tool', 'animation values differ (an animation declaration the table did not carry)'],
};
const rebuildReason = cat => REBUILD[cat] || (cat.startsWith('pseudo:') ? ['tool', `a pseudo-element's ${cat.slice(7)} differs (a rule or value the table did not carry for it)`] : ['tool', `${cat.replace(/^prop:/, '')} differs (a value the table did not carry, or a script-set value not replayed at a held-out point)`]);

/** Rebuild: points where the rule-table rebuild differs from orig1. */
function rebuildCauses(g, ev, replayLabel = null) {
  const res = g.rebuild?.results || {};
  const failing = Object.keys(res).filter(k => !res[k].pass);
  if (!failing.length) return [];
  const out = [];
  const pp = ev?.perPoint || {};
  // points that fail only in pixels under script-painted content (unpaintable) or with every element exact
  const unp = failing.filter(k => res[k].unpaintable);
  const pix = failing.filter(k => !res[k].unpaintable && res[k].oracle.pass);
  const follows = failing.filter(k => pp[k]?.followsReplay);
  const cats = {}, pts = {}, samples = {};
  for (const k of failing) for (const [c, n] of Object.entries(pp[k]?.cats || {})) { cats[c] = (cats[c] || 0) + n; (pts[c] || (pts[c] = [])).push(k); if (!samples[c]) samples[c] = (pp[k].sample || []).find(x => x.cat === c); }
  for (const [c] of topOf(Object.fromEntries(Object.entries(pts).map(([c, l]) => [c, l.length])))) {
    const [label, reason] = rebuildReason(c);
    const cap = pts[c].filter(k => pp[k]?.vs === 'cap');
    // where it was seen: at a captured point the rebuild is compared with the capture session (the table's own replay),
    // at a held-out point with orig1 (script-owned values replayed)
    out.push(C('rebuild', c, label, `${reason} [${cap.length} captured point(s) vs the capture session, ${pts[c].length - cap.length} held-out vs orig1]`, { points: pts[c].length, atCaptured: cap.length, roots: cats[c], sample: samples[c] || null, ...(c === 'renest' && ev?.moves ? { moves: ev.moves } : {}) }));
  }
  if (follows.length) out.push(C('rebuild', 'follows-replay', replayLabel || 'tool', 'the rebuild equals the capture session at these captured points; it differs from orig1 only because the capture session differs from orig1 (see identity / capture-session)', { points: follows.length, sample: follows.slice(0, 3) }));
  if (unp.length) out.push(C('rebuild', 'unpaintable', 'site', 'every element exact; the only pixel difference is inside canvas / video / iframe content the page paints by script, which a CSS rebuild cannot paint (listed, never a pass)', { points: unp.length, sample: unp.slice(0, 3) }));
  if (pix.length) {
    const under = countBy(pix.flatMap(k => Object.keys(res[k].pixelUnder || {})));
    const img = pix.filter(k => res[k].pixelUnder && (res[k].pixelUnder.img || res[k].pixelUnder.picture));
    out.push(C('rebuild', 'pixels-only', 'tool', `every element exact, pixels differ ${img.length ? '(under <img>: raster/decode history)' : '(raster / compositing)'}`, { points: pix.length, under, sample: pix.slice(0, 3).map(k => ({ k, pixel: res[k].pixel.reason })) }));
  }
  const explained = new Set([...unp, ...pix, ...follows, ...Object.values(pts).flat()]);
  const rest = failing.filter(k => !explained.has(k));
  if (rest.length) {
    // no evidence block (a gate stored before L7 not re-analysed): the stored per-point kinds only
    const kinds = countBy(rest.flatMap(k => Object.keys(res[k].oracle.byKind || {})));
    out.push(C('rebuild', 'unanalysed', 'tool', 'rebuild differs from orig1; root causes not computed for this gate (no rebuild evidence stored)', { points: rest.length, kinds, sample: rest.slice(0, 3) }));
  }
  return out;
}

function sessionCauses(g, sev, idLabel = null) {
  const same = g.captureSession?.sameAsOrig1 || {};
  const bad = Object.keys(same).filter(k => same[k] === false);
  if (!bad.length) return [];
  const idFail = g.verdict?.identityPass === false;
  const e = sev || {};
  const followIds = bad.filter(k => e[k] && (e[k].pixelOnly || (e[k].identityFailedHere && e[k].inIdentityUnstable >= Math.ceil(0.5 * (e[k].failed || 0)))));
  const own = bad.filter(k => !followIds.includes(k));
  const out = [];
  if (followIds.length || (idFail && !sev)) out.push(C('capture-session', 'follows-identity', idFail ? idLabel || 'tool' : 'tool', idFail ? 'the capture session differs from orig1 where the identical replays already differ (same instability: see identity)' : 'the capture session differs from orig1 in pixels only', { points: (sev ? followIds : bad).length, sample: (sev ? followIds : bad).slice(0, 3) }));
  if (own.length && sev) out.push(C('capture-session', 'session-state', 'tool', 'the capture session (CDP CSS attached at capture time, rule-table capture) differs from orig1 where identical replays agree: the capture shifted page state', { points: own.length, sample: own.slice(0, 3).map(k => ({ k, ...e[k] })) }));
  return out;
}

function auditCauses(audit) {
  const out = [];
  const iss = Object.entries(audit || {}).flatMap(([cls, a]) => (a.issues || []).map(i => ({ cls, ...i })));
  const by = {}; for (const i of iss) (by[i.kind] || (by[i.kind] = [])).push(i);
  const R = {
    network: 'the rebuild loaded scripts/stylesheets: an <iframe> the table holds no document for loads its original from the archive (cross-origin embed)',
    'script-handler': 'the rebuild markup keeps an executable URL from the original DOM (href="javascript:..."); CSP blocks it, the audit forbids it in the artifact',
    provenance: 'the served artifact is not exactly render(table)',
  };
  for (const [k, l] of Object.entries(by)) out.push(C('audit', k, 'tool', R[k] || `audit issue ${k}`, { n: l.length, sample: l.slice(0, 2).map(x => ({ cls: x.cls, sample: x.sample || x.tag || null })) }));
  return out;
}

/**
 * The causes of every failing check of a capture / capture-inner gate (r of runCaptureSuite, or capture-gate.json).
 * @param {object|null} g gate (null for a step that crashed before it wrote one)
 * @param {{step?:object, evidence?:{rebuild?:object, session?:object}}} [o]
 * @returns {{check:string, bucket:string, label:'tool'|'site', reason:string, evidence:object}[]}
 */
export function labelFailures(g, { step = null, evidence = null } = {}) {
  const crashed = step && (['failed', 'timeout', 'killed'].includes(step.status) || (step.status === 'deferred' && /stop/i.test(step.reason || '')));
  if (crashed) return [crashCause(step)];
  if (!g?.verdict) return [];
  const v = g.verdict;
  const ev = evidence || {};
  const out = [];
  // a check that only follows another one takes that one's label (the label of its largest bucket)
  const lead = list => list.slice().sort((x, y) => (y.evidence.points || 0) - (x.evidence.points || 0))[0]?.label || null;
  const id = v.identityPass === false || v.installStalled ? identityCauses(g) : [];
  out.push(...id);
  const sess = v.captureSessionSame === false ? sessionCauses(g, ev.session || g.captureSession?.evidence, lead(id)) : [];
  out.push(...sess);
  if (v.verification === 'sampled-out') return out; // data mode: no rebuild / audit / mutants ran
  if (v.allPass === false) out.push(...rebuildCauses(g, ev.rebuild || g.rebuild?.evidence, lead(sess) || lead(id)));
  if (v.auditPass === false) out.push(...auditCauses(g.audit));
  if (v.mutantsPass === false && g.mutants?.made) {
    const m = g.mutants;
    const surv = (m.rows || []).filter(x => !x.killed && !x.crashed);
    out.push(C('mutants', m.made < 20 ? 'too-few-mutants' : m.baselinePass ? 'mutant-survived' : 'survived-on-failing-baseline', 'tool', m.made < 20 ? `the table offered ${m.made} mutable winning declarations (< 20)` : m.baselinePass ? 'a corrupted table value rendered no visible difference at the mutated point: the gate did not see it' : 'the rebuild already fails at the mutated point; a survivor changed nothing visible against it (follows the rebuild causes)', { made: m.made, killed: m.killed, crashed: m.crashed || 0, survivors: surv.slice(0, 3).map(x => x.desc) }));
  }
  if (v.scriptOwnedUndeclared > 0) out.push(C('undeclared', 'script-owned-undeclared', 'tool', 'script-written state at a held-out point the recorder has no evidence for (not excused, the point fails)', { points: v.scriptOwnedUndeclared }));
  if (v.unreadableSheets?.length) out.push(C('skipped', 'unreadable-sheet', 'tool', 'a cross-origin stylesheet whose text neither CDP nor the archive could give: walked empty, counted lossy (freeze completeness)', { sheets: v.unreadableSheets.slice(0, 3) }));
  if (v.shotSkipped) out.push(C('skipped', 'shot-skipped', 'tool', 'a full-page screenshot could not be taken (clip outside the page): no pixel check there', { n: v.shotSkipped }));
  if (v.dumpSkipped?.length) out.push(C('skipped', 'dump-skipped', 'tool', 'the T6 computed dump was too large for a JS string', { n: v.dumpSkipped.length }));
  return out;
}

/**
 * The causes of a states gate (runStatesSuite result / states-gate.json). Base rebuild differences are the capture's
 * (same tables, same renderer): a state row that fails exactly like its base point follows them.
 * @param {object} g states gate  @param {{capture?:object[]}} [o] the capture gate's causes (rebuild ones are reused)
 */
export function labelStates(g, { capture = [] } = {}) {
  const v = g?.verdict;
  if (!v || v.verification === 'sampled-out') return [];
  const out = [];
  const rows = Object.entries(g.states || {});
  const idBad = rows.filter(([, x]) => !x.identity).map(([k]) => k);
  if (v.installStalled) out.push(C('identity', 'clock-stall', 'tool', 'the fake-clock install stalled (machine overload)', { clockLateMs: v.clockLateMs }));
  else if (idBad.length) {
    const capId = capture.filter(c => c.check === 'identity').sort((x, y) => (y.evidence.points || 0) - (x.evidence.points || 0));
    out.push(C('identity', 'state-replays-differ', capId[0]?.label || 'tool', `o1 and o3 (identical replays of the same state) differ at these points${capId.length ? ` (the capture gate's identical replays differ too: ${capId.slice(0, 3).map(c => c.bucket).join(', ')})` : ' (the capture gate\'s replays agree: a state-time input the harness does not pin)'}`, { points: idBad.length, of: rows.length, sample: idBad.slice(0, 3), captureBuckets: capId.map(c => c.bucket) }));
  }
  const bad = rows.filter(([, x]) => !x.pass);
  if (bad.length) {
    const base = Object.fromEntries(rows.filter(([, x]) => !x.state));
    const follows = bad.filter(([k, x]) => x.state && base[k.split('~')[0]] && !base[k.split('~')[0]].pass && x.oracle.failedElements <= base[k.split('~')[0]].oracle.failedElements);
    const baseBad = bad.filter(([, x]) => !x.state);
    const own = bad.filter(([k, x]) => x.state && !follows.some(([f]) => f === k));
    const capRb = capture.filter(c => c.check === 'rebuild');
    if (baseBad.length || follows.length) out.push(C('rebuild', 'follows-base-rebuild', capRb[0]?.label || 'tool', `the base rebuild already fails (same tables and renderer as the capture gate${capRb.length ? `: ${capRb.slice(0, 3).map(c => c.bucket).join(', ')}` : ''}); ${follows.length} state row(s) fail no more than their base point`, { base: baseBad.length, states: follows.length, captureBuckets: capRb.map(c => c.bucket) }));
    if (own.length) {
      const kinds = countBy(own.flatMap(([, x]) => Object.keys(x.oracle.byKind || {})));
      const pixel = own.filter(([, x]) => x.oracle.pass).length;
      out.push(C('rebuild', 'state-rebuild', 'tool', 'the state rebuild differs beyond its base point (a state rule or state-time value the state table / forced pseudo-classes did not reproduce)', { states: own.length, pixelOnly: pixel, kinds, sample: own.slice(0, 3).map(([k, x]) => ({ k, how: x.how?.slice(0, 80), misses: (x.oracle.misses || []).slice(0, 2) })) }));
    }
  }
  if (v.auditPass === false) out.push(...auditCauses(Object.assign({}, ...Object.values(g.classes || {}).map(c => c.audit || {}))));
  for (const s of v.skippedStates || []) {
    const r = String(s.reason || '');
    const b = /^navigated/.test(r) ? 'state-navigated' : /not clickable/.test(r) ? 'state-not-clickable' : /target not found/.test(r) ? 'state-target-gone' : /time budget/.test(r) ? 'state-time-budget' : 'state-error';
    out.push(C('skipped', b, b === 'state-navigated' ? 'site' : 'tool', b === 'state-navigated' ? "the state's input leaves the page (a link): not a state of this page, skipped and reported" : b === 'state-time-budget' ? 'the state was cut by the states wall budget (85 % of the step cap; L3: no budget by default, the stall watchdog decides)' : `the state's input failed (${r.slice(0, 80)})`, { cls: s.cls, id: s.id }));
  }
  return mergeSame(out);
}

/** One cause per (check, bucket): counts add up, the first evidence stays. */
function mergeSame(list) {
  const m = new Map();
  for (const c of list) { const k = `${c.check}|${c.bucket}`; const x = m.get(k); if (!x) m.set(k, { ...c, evidence: { ...c.evidence, n: c.evidence.n ?? 1 } }); else x.evidence.n += c.evidence.n ?? 1; }
  return [...m.values()];
}
