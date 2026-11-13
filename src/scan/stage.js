// The stage data of a scan (PLAN §8): every chapter of the one timeline, the box of every moving element on every frame, and
// the moving elements folded into motions. Written next to the pictures as plain script files, so the card opens from disk with
// no server: stage/<page>-<viewport>.js (loaded with the page), stage/<page>-<viewport>-<take>.values.js (loaded on the first click).
//
// Boxes are stored as runs, not per frame: an element that rides the page keeps one box in page coordinates, a fixed one keeps
// one box in viewport coordinates, and only real movement adds a run. 1,300 elements over 972 frames come to 0.6 MB.
import fs from 'node:fs';
import path from 'node:path';
import { openTake, planChapter } from './analyse.js';

export const STAGE_SCHEMA = 'reva.stage/0';
const BOX = ['ren:bx', 'ren:by', 'ren:bw', 'ren:bh'];
const NOT_MOTION = /^ren:(bx|by|bw|bh|z|tz|text)$/;
const NAMES = { load: 'Page load', gate: 'Entry screen', 'scroll-down': 'Scroll down', 'scroll-up': 'Scroll back up', idle: 'At rest', 'pointer-sweep': 'Pointer across the page' };
const ORDER = ['load', 'gate', 'idle', 'scroll-down', 'scroll-up', 'pointer-sweep'];
const FAMILY = ['Hover and press', 'Menus', 'Page changes'];
const r3 = (x) => Math.round(x * 1000) / 1000;
const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);

/** Which channels of one row count as the element's own motion (a box riding the scroll does not). */
export const motionChannels = (v) => Object.keys(v).filter((c) => /^(ren|drv):/.test(c) && typeof v[c] === 'number' && !NOT_MOTION.test(c));

/**
 * Runs of one element over a take's pictures.
 * @param {(number|null)[][]} boxes  per picture [x, y, w, h] in viewport px, or null when the element is not in that row
 * @param {number[]} sy              scrollY per picture
 * @returns {{m:'p'|'v', t:number[]}}  m: 'p' y is in page coordinates, 'v' y is in the viewport; t: [frame, x, y, w, h, ...]
 */
export function boxRuns(boxes, sy) {
  const page = [], view = [];
  let lp = null, lv = null;
  boxes.forEach((b, i) => {
    if (!b) { if (lp !== '') { page.push(i, 0, 0, 0, 0); view.push(i, 0, 0, 0, 0); lp = ''; lv = ''; } return; }
    const x = Math.round(b[0]), y = Math.round(b[1]), w = Math.round(b[2]), h = Math.round(b[3]), py = Math.round(b[1] + sy[i]);
    const kp = `${x},${py},${w},${h}`, kv = `${x},${y},${w},${h}`;
    if (kp !== lp) { page.push(i, x, py, w, h); lp = kp; }
    if (kv !== lv) { view.push(i, x, y, w, h); lv = kv; }
  });
  return page.length <= view.length ? { m: 'p', t: page } : { m: 'v', t: view };
}

/** Frames where the element moves by itself, as [from, to, from, to, ...]; gaps under 6 frames join. */
export function moveSpans(flags) {
  const out = [];
  let a = -1, b = -1;
  flags.forEach((on, i) => { if (!on) return; if (a < 0) { a = i; b = i; } else if (i - b <= 6) b = i; else { out.push(a, b); a = i; b = i; } });
  if (a >= 0) out.push(a, b);
  return out;
}

/** One take: pictures, box runs, moving spans and the recorded values of every moving element, indexed by picture. */
function readTake(root, vp, name) {
  const fr = JSON.parse(fs.readFileSync(path.join(root, 'frames', vp, name, 'frames.json'), 'utf8'));
  const L = openTake(path.join(root, 'takes', vp, name));
  const byKey = new Map(L.data.rows.map((r) => [r.k, r]));
  const list = fr.rows.map((f) => byKey.get(f[0]) || null);
  const sy = fr.rows.map((f) => f[2]);
  const els = {}, values = {};
  for (const [id] of L.take.watch || []) {
    const boxes = [], flags = [], val = {};
    let prev = null;
    list.forEach((row, i) => {
      const v = row?.v?.[id];
      if (v && v === prev?.v) { boxes.push(prev.box); flags.push(false); prev.sy = sy[i]; return; }   // decoded rows share what did not change
      const shown = v && num(v[BOX[0]]) != null && !(num(v['ren:opacity']) != null && v['ren:opacity'] < 0.02);
      const box = shown ? BOX.map((k) => v[k]) : null;
      boxes.push(box);
      let mv = false;
      if (v) {
        for (const c of motionChannels(v)) {
          if (prev && typeof prev.v[c] === 'number' && Math.abs(prev.v[c] - v[c]) > 0.002) mv = true;
          const s = (val[c] ||= { last: undefined, a: [] });
          const n = r3(v[c]);
          if (n !== s.last) { s.a.push(i, n); s.last = n; }
        }
        if (prev && shown && prev.shown) {
          const dy = Math.abs((v['ren:by'] + sy[i]) - (prev.v['ren:by'] + prev.sy)), dx = Math.abs(v['ren:bx'] - prev.v['ren:bx']), dw = Math.abs(v['ren:bw'] - prev.v['ren:bw']), dh = Math.abs(v['ren:bh'] - prev.v['ren:bh']);
          const viewDy = Math.abs(v['ren:by'] - prev.v['ren:by']);
          if (dx > 0.05 || dw > 0.05 || dh > 0.05 || (dy > 0.05 && viewDy > 0.05)) mv = true;
        }
        prev = { v, sy: sy[i], shown, box };
      }
      flags.push(mv);
    });
    els[id] = { ...boxRuns(boxes, sy), s: moveSpans(flags) };
    const vv = {};
    for (const [c, s] of Object.entries(val)) if (s.a.length > 2) vv[c] = s.a;
    if (Object.keys(vv).length) values[id] = vv;
  }
  return { fr, L, sy, els, values };
}

/** "a.nav-link~3f2a#1:hover" -> "Hover a.nav-link"; anything else keeps its words. */
function chapterName(id) {
  const m = /^(.*):(\w+)$/.exec(id);
  const word = (s) => s.replace(/[-_]+/g, ' ').replace(/^./, (c) => c.toUpperCase());
  return m ? `${word(m[2])} ${m[1].replace(/~.*$/, '')}` : word(id);  // the card turns the selector part into a plain name
}

/** The one label a family of short chapters shares on the timeline. */
const groupOf = (take) => (/^pattern/.test(take) ? 'Hover and press' : /^open/.test(take) ? 'Menus' : /^change/.test(take) ? 'Page changes' : null);

/**
 * Chapters of one take from its picture phases. A `load` chapter starts with its take, so it has no fromT; it ends where its phase
 * ends, since an arrive take goes on with idle and scroll. A stored `load` take is only its load, and reads whole.
 */
export function chaptersOf(page, vp, name, fr) {
  return (fr.phases || []).map((p) => {
    const id = p.name;
    const action = /scroll/.test(id) ? 'scroll' : /hover|focus|pointer/.test(id) ? 'hover' : /click|open|press|change/.test(id) ? 'click' : 'load';
    return { id: `${page.id}/${vp}/${id}`, name: NAMES[id] || chapterName(id), group: groupOf(name), phase: id, take: name, action, from: p.from, to: p.to,
      fromT: id === 'load' ? null : fr.rows[p.from]?.[1] ?? null, toT: id === 'load' && name === 'load' ? null : (fr.rows[p.to - 1]?.[1] ?? 0) + 1 };
  });
}

/** Moving span of a set of elements within a chapter: first and last frame, chapter-relative; null when none moves in it. */
function spanIn(ids, els, ch) {
  let a = null, b = null;
  for (const id of ids) {
    const s = els[id]?.s || [];
    for (let i = 0; i < s.length; i += 2) {
      const f = Math.max(s[i], ch.from), t = Math.min(s[i + 1], ch.to - 1);
      if (f > t) continue;
      if (a == null || f < a) a = f;
      if (b == null || t > b) b = t;
    }
  }
  return a == null ? null : [a - ch.from, b - ch.from];
}

/** @returns {string} the chapter's id, with its take's name when another chapter already has it */
export function uniqueChapter(ids, id, take) {
  const free = ids.has(id) ? `${id}-${safeId(take)}` : id;
  ids.add(free);
  return free;
}

/** "To /work", from the ledger row of that change. */
function changeName(out, take, vp) {
  try {
    const rows = JSON.parse(fs.readFileSync(path.join(out, 'coverage.json'), 'utf8')).rows;
    const r = rows.find((x) => x.unit === 'page-change' && x.viewport === vp && String(x.evidence?.take ?? '').split(/[\\/]/).includes(take));
    if (!r) return null;
    const p = new URL(String(r.id).replace(/^to /, '')).pathname;
    return `To ${p === '/' ? 'home' : p}`;
  } catch { return null; }
}

export const safeId = (id) => String(id).replace(/[^\w-]+/g, '-');
/** Does the element show a box on screen on any picture of its take? */
function hasBox(e, t, clip) {
  for (let k = 0; k < e.t.length; k += 5) {
    const x = e.t[k + 1], w = e.t[k + 3], h = e.t[k + 4];
    if (w < 4 || h < 4 || x >= clip.width || x + w <= 0) continue;
    if (e.m === 'v') { if (e.t[k + 2] < clip.height && e.t[k + 2] + h > 0) return true; continue; }
    const to = k + 5 < e.t.length ? e.t[k + 5] : t.y.length;
    for (let i = e.t[k]; i < to; i++) { const y = e.t[k + 2] - t.y[i]; if (y < clip.height && y + h > 0) return true; }
  }
  return false;
}

const planFile = (out, chId) => path.join(out, 'stage', `plan-${safeId(chId)}.json`);
export const readPlan = (out, chId) => JSON.parse(fs.readFileSync(planFile(out, chId), 'utf8'));

/**
 * Write the stage of one viewport of one page.
 * @param {string} out  the scan folder
 * @param {{id:string, dir:string}} page  dir: relative to the scan folder ('.' for the first page)
 * @returns {{file:string, chapters:number, elements:number, motions:number, bytes:number}|null}  null when it has no pictures
 */
export function buildViewport(out, page, vp, { log = () => {} } = {}) {
  const root = path.join(out, page.dir), frames = path.join(root, 'frames', vp);
  if (!fs.existsSync(frames)) return null;
  const names = fs.readdirSync(frames).filter((n) => fs.existsSync(path.join(frames, n, 'frames.json')) && fs.existsSync(path.join(root, 'takes', vp, n, 'take.json')));
  if (!names.length) return null;
  const takes = {}, chapters = [], folded = new Map(), ids = new Set();
  let clip = null, pic = null, elements = 0;
  for (const name of names) {
    const t0 = Date.now();
    const { fr, L, sy, els, values } = readTake(root, vp, name);
    clip = clip || fr.clip; pic = pic || fr.size;
    const descs = L.data.elements || [];
    const sels = new Map((L.take.selectors || []).map((r) => [r[0], r[1]]));
    const elsOut = {};
    for (const [id, e] of Object.entries(els)) elsOut[id] = { ...e, d: descs[id] || '', c: sels.get(+id) || null };
    elements += Object.keys(els).length;
    takes[name] = { dir: `${page.dir === '.' ? '' : page.dir + '/'}frames/${vp}/${name}/`, f: fr.rows.map((r) => r[3]), T: fr.rows.map((r) => Math.round(r[1])), y: sy.map(Math.round), files: fr.files, v: fr.video?.file || null, els: elsOut };
    fs.mkdirSync(path.join(out, 'stage'), { recursive: true });
    fs.writeFileSync(path.join(out, 'stage', `${page.id}-${vp}-${safeId(name)}.values.js`), `window.__stageValues(${JSON.stringify(`${page.id}/${vp}/${name}`)},${JSON.stringify(values)});\n`);
    for (const ch of chaptersOf(page, vp, name, fr)) {
      // every page change's phase has the same name: a chapter id says which take it is, or their plans and fits overwrite each other
      ch.id = uniqueChapter(ids, ch.id, name);
      if (/^change/.test(name)) ch.name = changeName(out, name, vp) || ch.name;
      const planned = planChapter(L, ch);
      fs.writeFileSync(planFile(out, ch.id), JSON.stringify({ chapter: ch, takeDir: path.join(page.dir, 'takes', vp, name), entries: planned.entries, pageKey: ch.group ? null : planned.pageKey, pageId: planned.pageId, gl: !ch.group && !!(L.take.gl && (L.take.gl.contexts || []).length) }));
      chapters.push(ch);
      for (const e of planned.entries) {
        const key = `${e.desc}\u0001${e.selector || e.leadSelector || ''}`;
        const m = folded.get(key) || { desc: e.desc, selector: e.selector || e.leadSelector || null, count: 0, rank: Infinity, box: e.box || null, weight: 0, moments: [] };
        m.count = Math.max(m.count, e.count); m.rank = Math.min(m.rank, e.rank); m.weight = Math.max(m.weight, e.weight || 0);
        m.moments.push({ c: ch.id, lead: e.lead, ids: e.ids, rank: e.rank, span: spanIn(e.ids, els, ch) });
        folded.set(key, m);
      }
      if (planned.pageKey && !ch.group) {
        const m = folded.get('\u0001page') || { desc: 'Page scroll', page: true, selector: null, count: 1, rank: 0, box: null, weight: 0, moments: [] };
        m.moments.push({ c: ch.id, lead: 'page', ids: [], rank: 0, span: [0, ch.to - ch.from - 1] });
        folded.set('\u0001page', m);
      }
      if (L.take.gl && (L.take.gl.contexts || []).length && !ch.group) {
        const m = folded.get('\u0001gl') || { desc: 'WebGL scene', gl: true, selector: null, count: 1, rank: 0.5, box: null, weight: 0, moments: [] };
        m.moments.push({ c: ch.id, lead: 'gl', ids: [], rank: 0, span: [0, ch.to - ch.from - 1] });
        folded.set('\u0001gl', m);
      }
    }
    log(`${vp} ${name}: ${Object.keys(els).length} moving elements, ${fr.rows.length} frames, ${Date.now() - t0} ms`);
  }
  const tf = names.map((n) => path.join(frames, n, 'table.json')).find((f) => fs.existsSync(f));
  if (tf) fs.writeFileSync(path.join(out, 'stage', `${page.id}-${vp}.table.js`), `window.__stageTable(${JSON.stringify(`${page.id}/${vp}`)},${fs.readFileSync(tf, 'utf8')});\n`);
  const place = (c) => { const i = ORDER.indexOf(c.phase); return i >= 0 ? i : 10 + (FAMILY.indexOf(c.group) + 1); };
  chapters.sort((a, b) => place(a) - place(b));
  let at = 0;
  for (const c of chapters) { c.at = at; at += c.to - c.from; }
  // what moves but never shows a box (a line of no width, a part behind a closed door) still has a row, with its recorded values
  const placed = new Set([...folded.values()].flatMap((m) => m.moments.flatMap((x) => x.ids.map((id) => `${x.c.split('/').slice(0, 3).join('/')}|${id}`))));
  const boxless = new Map();
  for (const c of chapters) {
    const t = takes[c.take];
    for (const [id, e] of Object.entries(t.els)) {
      if (/^(HTML|BODY)\b/.test(e.d) || placed.has(`${c.id}|${id}`) || hasBox(e, t, clip)) continue;
      const span = spanIn([id], t.els, c); if (!span) continue;
      const m = boxless.get(e.d) || { desc: e.d, selector: e.c, count: 0, rank: 1e6, box: null, weight: 0, recorded: true, moments: [], seen: new Set() };
      m.seen.add(id); m.count = Math.max(m.count, m.seen.size);
      const mo = m.moments.find((x) => x.c === c.id);
      if (mo) mo.ids.push(+id); else m.moments.push({ c: c.id, lead: +id, ids: [+id], rank: 1e6, span, recorded: true });
      boxless.set(e.d, m);
    }
  }
  for (const [k, m] of boxless) { delete m.seen; folded.set(`\u0001none${k}`, m); }
  const atOf = new Map(chapters.map((c) => [c.id, c.at]));
  const motions = [...folded.values()].sort((a, b) => a.rank - b.rank || b.weight - a.weight);
  for (const m of motions) m.moments.sort((a, b) => atOf.get(a.c) - atOf.get(b.c));
  // each take's element boxes are a file of their own, read when Study first shows that take (6 Nov review: 50 MB at open; one site's
  // home on desktop was one 21.6 MB file, 4.2 M numbers of boxes in 23 takes). The doc says so with `split`.
  const lean = {};
  for (const [name, t] of Object.entries(takes)) {
    const { els, ...rest } = t;
    fs.writeFileSync(path.join(out, 'stage', `${page.id}-${vp}-${safeId(name)}.els.js`), `window.__stageEls(${JSON.stringify(`${page.id}/${vp}/${name}`)},${JSON.stringify(els)});\n`);
    lean[name] = rest;
  }
  const doc = { schema: STAGE_SCHEMA, page: page.id, vp, table: !!tf, split: true, clip, pic, total: at, chapters, takes: lean, motions };
  const file = path.join(out, 'stage', `${page.id}-${vp}.js`);
  fs.writeFileSync(file, `window.__stage(${JSON.stringify(`${page.id}/${vp}`)},${JSON.stringify(doc)});\n`);
  return { file, chapters: chapters.length, elements, motions: motions.length, bytes: fs.statSync(file).size };
}
