// The move card, Node side (DESIGN 4.2, 4.4, 5). page/moves.html is the page; this file gives it what it reads:
//   cardIndex     moves.json trimmed to the inline index the first screen needs
//   clipRequests  what S9 must cut for each move: rows, box and marks, read from the take's frames.json
//   applyClips    S9's results written into moves.json's fields: frame, phone clip, instance video
//   heroRequests  one hero poster per page and viewport; applyHeroes writes site.pages[].hero
//   injectMoves   the page joined to the card
// Pure over its arguments except for reading frames.json. Page text stays inert: page/moves.html escapes every string.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VIDEO_NAME } from '../scan/video.js';
import { heroSpans, sourceOf } from '../scan/clips.js';
import { moveStatus } from '../scan/moves/contract.js';

const PAGE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'page');
const RATE = 60;
/** Frames kept before a move starts and after it ends, so a clip opens at rest and is not cut on its last frame. */
const LEAD = 12, TAIL = 18;
/** Where the poster of a load or a page change sits, as a share of its clip. */
const LATE_POSTER = 0.75;
/** What a frame answers with, by kind (DESIGN 5.4). A scroll move is never on a timer. */
export const PLAY = Object.freeze({ load: 'once', gate: 'once', change: 'once', scroll: 'scrub', 'scroll-up': 'scrub', 'page-scroll': 'scrub', touch: 'hover', open: 'hover', ambient: 'loop', cursor: 'loop', media: 'loop', scene: 'loop' });

/** The move's play mode: a scene driven by scroll scrubs, any other scene loops. */
export function playOf(m) {
  if (m.kind === 'scene' && /scroll/.test(m.trigger?.kind || '')) return 'scrub';
  return PLAY[m.kind] || 'once';
}

/** A take's picture folder, relative to the scan folder. */
export function takeDir(instance, pages = []) {
  const pg = pages.find((p) => p.id === instance.page), base = pg?.dir ?? (instance.page === 'home' ? '.' : path.join('pages', instance.page));
  return path.join(base, 'frames', instance.viewport, instance.take).split(path.sep).join('/');
}

/** Index of the row of frame k, near clock T when given: `k` restarts on a new document, so one take can hold it twice. */
export function rowOf(rows, k, T = null) {
  let best = -1, bestD = Infinity;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i][0] < k) continue;
    if (rows[i][0] === k) {
      if (T == null) return i;
      const d = Math.abs(rows[i][1] - T);
      if (d < bestD) { best = i; bestD = d; }
    } else if (best < 0) best = i;
  }
  return best;
}

const docCache = (root) => {
  const seen = new Map();
  return (rel) => { if (!seen.has(rel)) seen.set(rel, sourceOf(path.join(root, rel))); return seen.get(rel); };
};

/** The screen of a viewport by name, when nothing better is known. */
const SCREEN = { desktop: { width: 1440, height: 900 }, phone: { width: 390, height: 844 } };
/** A box [x, y, w, h] cut to the screen; null when nothing of it is on the screen. */
export function onScreen(box, screen) {
  if (!Array.isArray(box) || box.length < 4 || !box.every(Number.isFinite)) return null;
  const x0 = Math.max(0, box[0]), y0 = Math.max(0, box[1]), x1 = Math.min(screen.width, box[0] + box[2]), y1 = Math.min(screen.height, box[1] + box[3]);
  return x1 > x0 && y1 > y0 ? [x0, y0, x1 - x0, y1 - y0] : null;
}
/** How far past the screen a box reaches, as a share of the screen: 1 when it fits. */
const reach = (box, screen) => Math.max(box[2] / screen.width, box[3] / screen.height, 1);
/** Past this share of the screen a box is elements far off it (a page change counts the old page and the new), not the move's frame. */
export const OFF_SCREEN = 4;

/** Frames a stretch of pictures may miss and stay one stretch (a pointer path's step without a picture, a skinned-mesh WebGL site, 6 Nov: 1 in 12). */
export const HOLE_FRAMES = 6;
/** The rows around row `at` with no hole between them: each next frame at most HOLE_FRAMES on, its time with it, in one document. */
export function runOf(rows, at) {
  const next = (a, b) => b[0] > a[0] && b[0] - a[0] <= HOLE_FRAMES && b[1] - a[1] > 0 && b[1] - a[1] <= (b[0] - a[0] + 0.5) * (1000 / RATE);
  let lo = at, hi = at;
  while (lo > 0 && next(rows[lo - 1], rows[lo])) lo--;
  while (hi + 1 < rows.length && next(rows[hi], rows[hi + 1])) hi++;
  return { lo, hi };
}

/** One clip request from one instance, or null when its take holds no pictures. */
function requestOf(m, inst, src, take, { phone = false } = {}) {
  const rows = src.doc.rows, N = rows.length;
  const marksK = inst.marks || {}, marks = {};
  for (const [k, v] of Object.entries(marksK)) { const r = rowOf(rows, v, null); if (r >= 0) marks[k] = r; }
  const kind = m.kind === 'scroll-up' || m.kind === 'page-scroll' ? 'scroll' : m.kind;
  const k0 = rowOf(rows, inst.k0 ?? rows[0][0], inst.T0), k1 = inst.k1 == null ? N - 1 : rowOf(rows, inst.k1, inst.T1);
  if (k0 < 0) return null;
  const first = Math.min(k0, ...['in', 'press'].map((p) => marks[p] ?? Infinity));
  // a touch clip opens at the pointer's arrival: what ran before it (a focus part) is not what a hand answers with
  const at = kind === 'touch' && Number.isFinite(marks.in) ? marks.in : first;
  // a clip is one stretch of pictures: the take keeps pictures in bursts, and a lead or tail across a hole would put frames of another
  // moment into it and shift every time after (a shader-transition site, 6 Nov: 12 frames from 2 s earlier, the lead's clipT0 past the clip's end)
  // the stretch is the one the move starts in; a mark in an earlier stretch (a press before a hole) is not part of its clip
  const { lo, hi } = runOf(rows, k0);
  const fromRow = Math.max(lo, at - LEAD), toRow = Math.min(hi + 1, Math.max(k1 < 0 ? N - 1 : k1, marks.out ?? 0) + TAIL);
  if (toRow <= fromRow) return null;
  const viewport = src.doc.clip || { width: 1440, height: 900 };
  // the frame is cut from the screen: a box that reaches 118,882 px off it (elements parked off-screen) frames the screen, never past it
  const box = inst.box ? onScreen(inst.box, viewport) : null;
  const rq = { id: m.id, phone, take, kind, fromRow, toRow, marks, boxes: box ? [box] : [], viewport, startT: rows[fromRow][1], play: playOf(m) };
  // A page change is mostly dark at its middle: the old page has left and the new one has not come. A poster near the arrival says what
  // it is. clips.js reads a chosen poster row for load and gate only, and a whole viewport comes from no boxes, so it is asked as a load.
  if (kind === 'change') Object.assign(rq, { kind: 'load', boxes: [], peakRow: Math.round(fromRow + LATE_POSTER * (toRow - fromRow)) });
  // the rows cannot say which frame has most members mid-way, and on a load the first part is often still the dark ground
  if (kind === 'load' || kind === 'gate') rq.peakRow = Math.round(fromRow + LATE_POSTER * (toRow - fromRow));
  return rq;
}

/**
 * What S9 must cut, for cutClips in src/scan/clips.js. One request for a move's first instance with pictures, a desktop one when it has
 * one, plus a `-p` request when the same move also ran on phone. Sorted by take, since opening a take's video is the slow part.
 * @param {string} root  the scan folder
 * @param {object} index moves.json
 * @param {{pages?:object[], phone?:boolean, only?:Set<string>}} [o]  pages: scan.json pages; only: a subset of move ids
 */
export function clipRequests(root, index, { pages = [], phone = true, only = null } = {}) {
  const docOf = docCache(root), out = [];
  for (const m of index.moves) {
    if (only && !only.has(m.id)) continue;
    const list = (m.instances || []).filter((i) => i.take);
    const pick = (vp) => list.filter((i) => i.viewport === vp).find((i) => docOf(takeDir(i, pages)));
    const main = pick('desktop') || pick('phone');
    if (!main) continue;
    const take = takeDir(main, pages), rq = requestOf(m, main, docOf(take), take);
    if (rq) out.push(rq);
    const p = phone && main.viewport === 'desktop' ? pick('phone') : null;
    if (p) { const t = takeDir(p, pages), r = requestOf(m, p, docOf(t), t, { phone: true }); if (r) out.push(r); }
  }
  return out.sort((a, b) => a.take.localeCompare(b.take));
}

/** Every instance's place in its take video, so See it in the page needs no frames.json in the card. */
function instanceVideo(inst, src, take) {
  if (src?.kind !== 'video') return null;
  const rows = src.doc.rows, a = rowOf(rows, inst.k0 ?? rows[0][0], inst.T0), b = inst.k1 == null ? rows.length - 1 : rowOf(rows, inst.k1, inst.T1);
  if (a < 0) return null;
  const end = b < 0 ? rows.length - 1 : b;
  return { file: `${take}/${src.doc.video?.file || VIDEO_NAME}`, t0: +(a / RATE).toFixed(3), t1: +(end / RATE).toFixed(3) };
}

/**
 * Writes S9's results into the index. The caller then writes moves.json, and passes `starts` to writeClipT0 in src/scan/moves/fit.js.
 * @param {string} root
 * @param {object} index  changed in place
 * @param {object[]} requests  clipRequests' list, as cut
 * @param {object[]} results   cutClips' results
 * @param {{pages?:object[]}} [o]
 * @returns {{starts:Object<string,number>, framed:number, failed:{id:string,error:string}[]}} starts: move id to ms on the take's clock
 */
export function applyClips(root, index, requests, results, { pages = [] } = {}) {
  const byId = new Map(index.moves.map((m) => [m.id, m])), docOf = docCache(root);
  const starts = {}, failed = [];
  let framed = 0;
  results.forEach((r, i) => {
    const rq = requests[i], m = byId.get(r.id);
    if (!m || !rq) return;
    if (r.error) { failed.push({ id: r.id, error: r.error }); return; }
    if (rq.phone) {
      m.phone = { ...m.phone, clip: r.frame.clip ?? null, poster: r.frame.poster ?? null, w: r.frame.w, h: r.frame.h };
      return;
    }
    m.frame = { ...r.frame, play: rq.play, ...(r.sampled ? { step: r.sampled } : {}) };
    if (r.gap && !m.gap) m.gap = r.gap;
    starts[m.id] = rq.startT;
    framed++;
  });
  for (const m of index.moves) for (const inst of m.instances || []) {
    if (inst.video || !inst.take) continue;
    const take = takeDir(inst, pages);
    inst.video = instanceVideo(inst, docOf(take), take);
  }
  return { starts, framed, failed };
}

/** The takes a hero plays: one arrive take, or a stored scan's load and scroll takes. */
function heroTakes(root, page, vp, pages, docOf) {
  const of = (take) => { const t = takeDir({ page: page.id, viewport: vp, take }, pages); const src = docOf(t); return src ? { take: t, src } : null; };
  const arrive = of('arrive');
  return arrive ? { load: arrive, scroll: arrive } : { load: of('load'), scroll: of('scroll') };
}

/** One hero poster per page and viewport, for cutHeroPosters: the last frame of the load. */
export function heroRequests(root, index, { pages = [] } = {}) {
  const docOf = docCache(root), out = [];
  for (const page of index.site.pages) for (const vp of index.site.viewports) {
    const { load } = heroTakes(root, page, vp, pages, docOf);
    if (!load) continue;
    const ph = (load.src.doc.phases || []).find((p) => p.name === 'load');
    out.push({ page: page.id, viewportName: vp, take: load.take, row: Math.max(0, (ph ? ph.to : load.src.doc.rows.length) - 1), viewport: load.src.doc.clip || { width: 1440, height: 900 } });
  }
  return out;
}

/** Writes site.pages[].hero from cutHeroPosters' results. A stored scan keeps load and scroll in two videos, hence `scrollVideo`. */
export function applyHeroes(root, index, heroes, { pages = [] } = {}) {
  const docOf = docCache(root);
  for (const page of index.site.pages) for (const vp of index.site.viewports) {
    const { load, scroll } = heroTakes(root, page, vp, pages, docOf);
    const cut = heroes.find((h) => h.page === page.id && h.viewportName === vp);
    if (!load || load.src.kind !== 'video') continue;
    const file = (t) => `${t.take}/${t.src.doc.video?.file || VIDEO_NAME}`;
    const hero = { video: file(load), load: heroSpans(load.src.doc).load ?? null, scroll: null, poster: cut?.hero?.poster ?? null };
    if (scroll?.src.kind === 'video') {
      hero.scroll = heroSpans(scroll.src.doc).scroll ?? null;
      if (scroll.take !== load.take) hero.scrollVideo = file(scroll);
    }
    page.hero = { ...page.hero, [vp]: hero };
  }
}

/**
 * The size of what moves, on the screen: the first instance's box cut to the screen. `off` is the whole box, in px, when it reaches
 * far past the screen, so the card can say why the frame shows the screen only.
 */
function sizeOf(m) {
  const inst = (m.instances || []).find((i) => i.viewport === 'desktop' && i.box) || (m.instances || []).find((i) => i.box);
  if (!inst) return {};
  // the frame is cut from the same instance (desktop first), so a whole-screen frame is that screen's size
  const screen = m.frame?.shape === 'viewport' && m.frame.w && m.frame.h ? { width: m.frame.w, height: m.frame.h } : SCREEN[inst.viewport] || SCREEN.desktop;
  const b = onScreen(inst.box, screen);
  if (!b) return {};
  const far = reach(inst.box, screen) > OFF_SCREEN;
  return { size: { w: Math.round(b[2]), h: Math.round(b[3]), screen: [screen.width, screen.height], ...(far ? { off: [Math.round(inst.box[2]), Math.round(inst.box[3])] } : {}) } };
}

const pick = (o, keys) => { const r = {}; if (o) for (const k of keys) if (o[k] !== undefined && o[k] !== null) r[k] = o[k]; return r; };

/**
 * The inline index: everything the first screen, Find, the open view's first paint and Site read, and nothing else. Instances fold
 * into the viewports and pages a move ran on, plus the first one with a video, for See it in the page.
 * @param {object} index  moves.json
 * @param {{coverage?:object, missing?:string[]}} [o]  from siteWords; moves.json may hold no coverage yet
 */
export function cardIndex(index, { coverage = null, missing = [] } = {}) {
  const pageAt = new Map(index.site.pages.map((p, i) => [p.id, i]));
  // a move whose every change is under what the eye sees, or only a new page's state, stays in moves.json and off the card
  const moves = index.moves.filter((m) => !m.notMove).map((m) => {
    const inst = m.instances || [];
    const vp = [...new Set(inst.map((i) => i.viewport))];
    const pg = [...new Set(inst.map((i) => pageAt.get(i.page)))].filter((i) => i != null);
    const seen = inst.find((i) => i.video);
    return {
      ...pick(m, ['id', 'kind', 'group', 'name', 'sentence', 'technique', 'time', 'n', 'variants', 'gap']),
      status: moveStatus(m),
      ...sizeOf(m),
      trigger: pick(m.trigger, ['kind', 'word', 'lagMs', 'parts', 'scroll']),
      curve: pick(m.curve, ['kind', 'name']),
      proof: pick(m.proof, ['source', 'word']),
      frame: m.frame ? { ...pick(m.frame, ['shape', 'w', 'h', 'clip', 'poster', 'ms', 'fps', 'marks', 'step']), play: m.frame.play || playOf(m) } : null,
      phone: m.phone || null,
      vp, pg,
      ...(seen ? { seen: { ...seen.video, viewport: seen.viewport } } : {}),
    };
  });
  return {
    site: { host: index.site.host, url: index.site.url, pages: index.site.pages.map((p) => pick(p, ['id', 'label', 'url', 'hero'])), viewports: index.site.viewports, built: index.site.built, feel: index.site.feel ?? null },
    scan: index.scan ?? null,
    coverage: coverage ?? index.coverage ?? null,
    missing,
    tally: index.tally ?? null,
    groups: index.groups, top: index.top, moves,
  };
}

/** The section the screens live in, the page's style in the head, its script after the stage's. */
export function injectMoves(html) {
  const page = fs.readFileSync(path.join(PAGE, 'moves.html'), 'utf8'), cut = page.indexOf('<script>');
  const withStyle = html.replace('</head>', () => `${page.slice(0, cut)}</head>`)
    .replace('<main>', () => '<main><section id="moves" class="view" aria-label="Moves" hidden="until-found"></section>');
  const end = withStyle.lastIndexOf('</body>');
  return withStyle.slice(0, end) + page.slice(cut) + withStyle.slice(end);
}
