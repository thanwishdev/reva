// Motion that belongs to the page, not to an element's rows (DESIGN 2.5): the page's own scroll, a canvas with a context, a playing video.
// They have no runs, so they never touch the tally. Laws and uniforms come later in S8 from `fitPage` and `fitGl`; this file says what
// exists and what drives it, from what the take already holds.
import { loadTake } from '../../record/take.js';
import { techniqueOf, techniqueSummary } from '../../analysis/gl/technique.js';
import { selectorGroup } from './contract.js';

const SETTLE_FRAMES = 6, SCROLLED_PX = 8, SCROLL_CORR = 0.9, CLOCK_SHARE = 0.5, MIN_CANVAS_PX = 80;

/**
 * The page's own scroll law, from one take with a scroll pass: wheel in, scrollY out. Native scroll lands with the wheel. A smoothed page
 * takes the wheel itself or arrives late. A page whose document never moves spends the wheel on a scene.
 * @returns {{mode:'native'|'smoothed'|'wheel-consumed', lagMs:?number, take:string}|null}
 */
export function scrollLaw(view) {
  const s = view.sections;
  if (s.down == null) return null;
  const end = s.up ?? view.kLast, wheel = view.wheel.filter((w) => w.k >= s.down && w.k < end && w.dy > 0);
  if (!wheel.length) return null;
  const ys = [];
  for (let k = s.down; k < end; k++) if (view.syAt.has(k)) ys.push([k, view.syAt.get(k)]);
  if (!ys.length) return null;
  const y0 = ys[0][1], max = Math.max(...ys.map((p) => p[1]));
  if (max - y0 < SCROLLED_PX) return { mode: 'wheel-consumed', lagMs: null, take: view.name };
  // the lag: how long after each wheel event the page reaches where the wheel sent it
  const lags = [];
  let want = y0, at = 0;
  for (const w of wheel) {
    want += w.dy;
    if (want > max) break;
    while (at < ys.length && (ys[at][0] < w.k || ys[at][1] < want - 1)) at++;
    if (at >= ys.length) break;
    lags.push(ys[at][0] - w.k);
  }
  lags.sort((a, b) => a - b);
  const lag = lags.length ? lags[lags.length >> 1] : 0, taken = wheel.filter((w) => w.prevented).length * 2 >= wheel.length;
  return { mode: taken || lag > SETTLE_FRAMES ? 'smoothed' : 'native', lagMs: Math.round((lag * 1000) / 60), take: view.name };
}

const corr = (a, b) => {
  const n = a.length;
  if (n < 8) return 0;
  const ma = a.reduce((x, y) => x + y, 0) / n, mb = b.reduce((x, y) => x + y, 0) / n;
  let ab = 0, aa = 0, bb = 0;
  for (let i = 0; i < n; i++) { ab += (a[i] - ma) * (b[i] - mb); aa += (a[i] - ma) ** 2; bb += (b[i] - mb) ** 2; }
  return aa && bb ? ab / Math.sqrt(aa * bb) : 0;
};

/** What drives each uniform, over the arrival takes of a page: the clock, the scroll, or the pointer. */
function uniformDrivers(P) {
  const out = new Map();
  for (const v of P.views) {
    for (const [key, g] of v.gl) {
      if (!g.ks.length) continue;
      const e = out.get(key) || out.set(key, { key, time: false, scroll: false, pointer: false }).get(key);
      const s = v.sections;
      if (v.role === 'idle' || v.role === 'arrive') { const from = s.idle ?? v.kFirst, to = v.role === 'arrive' ? (s.down ?? v.kLast) : v.kLast; const n = g.ks.filter((k) => k >= from && k <= to).length; if (to > from && n >= CLOCK_SHARE * (to - from)) e.time = true; }
      if (s.down != null && g.a.length >= 8 && Math.abs(corr(g.a, g.s)) >= SCROLL_CORR) e.scroll = true;
      if (v.role === 'touch') e.pointer = true;
    }
  }
  for (const e of out.values()) e.driver = e.time ? 'time' : e.scroll ? 'scroll' : e.pointer ? 'pointer' : 'load';
  return [...out.values()];
}

function canvasRow(P, sel) {
  const rows = (P.table?.rows || []).filter((r) => r[0] === 'canvas');
  return rows.find((r) => r[1] === sel) || (rows.length === 1 ? rows[0] : null);
}

/**
 * Canvases with a WebGL context on this page and viewport, visible ones only: a context with no box on the page draws a texture for another.
 * @returns {object[]} { key, box, ctx, take, technique, uniforms, programs, driver }
 */
export function scenesOf(P) {
  const v = P.views.find((x) => x.take.gl?.contexts?.length && x.role !== 'touch' && x.role !== 'change');
  if (!v) return [];
  let programs = [];
  try { programs = loadTake(v.dir, ['glPrograms']).data.glPrograms || []; } catch { programs = []; }
  const drivers = uniformDrivers(P), out = [];
  for (const ctx of v.take.gl.contexts) {
    if (ctx.offscreen) continue;
    const sel = v.selectors.get(String(ctx.el)) || null, row = canvasRow(P, sel);
    if (!row) continue;
    const box = [row[2], row[3], row[4], row[5]];
    if (box[2] < MIN_CANVAS_PX || box[3] < MIN_CANVAS_PX) continue;
    const own = programs.filter((p) => (p.ctx ?? ctx.id) === ctx.id && (p.uses || 0) > 0);
    const ids = new Set(own.map((p) => `p${p.id}`));
    const uniforms = drivers.filter((d) => ids.has(d.key.split('|')[0]));
    const counters = v.take.gl.counters || {};
    const items = own.flatMap((p) => techniqueOf(p, counters));
    let technique = null;
    try { technique = techniqueSummary(items, counters) || null; } catch { technique = null; }
    const counts = { time: 0, scroll: 0, pointer: 0 };
    for (const u of uniforms) if (counts[u.driver] != null) counts[u.driver]++;
    const driver = counts.scroll ? 'scroll' : counts.pointer && !counts.time ? 'pointer' : counts.time ? 'time' : 'load';
    out.push({ key: sel || `canvas ${ctx.id}`, desc: v.elements[ctx.el] || 'CANVAS', box, ctx: ctx.id, take: v.name, T0: null, technique, uniforms: uniforms.map((u) => ({ name: u.key.split('|').slice(1).join('|'), program: u.key.split('|')[0], driver: u.driver })), programs: own.length, driver });
  }
  return out;
}

/**
 * Playing media elements of a page: the take's escape holds their addresses, the table holds their boxes. A move needs a frame, so an
 * address with no box left over stays a ledger row and makes no tile.
 */
export function mediaOf(P) {
  const seen = new Map();
  const videos = (P.table?.rows || []).filter((r) => r[0] === 'video');
  for (const v of P.views) {
    const e = v.take.escapes?.['media-element'];
    if (!e) continue;
    for (const url of e.details || []) { if (seen.has(url) || seen.size >= videos.length) continue; const row = videos[seen.size]; seen.set(url, { key: row[1] ? selectorGroup(row[1]) : 'video', url, box: [row[2], row[3], row[4], row[5]], take: v.name }); }
  }
  return [...seen.values()];
}
