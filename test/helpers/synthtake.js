// Synthetic takes: the same files a scan writes (take.json, delta rows, frames.json, *.unit.json), from a scene with a known
// truth, so a test of the move model needs no browser and no third-party data. All names here are invented.
//
//   const t = synthTake({ name: 'load', frames: 200 });
//   const id = t.el('DIV.card', { selector: 'div.card', box: [0, 0, 100, 100] });
//   t.ramp(id, 'ren:ty', { k0: 10, k1: 40, from: 40, to: 0, ease: easeOut });
//   t.mark('idle', 120); t.phase('load', 1, 200);
//   t.write(root);       // <root>/takes/desktop/load/ and <root>/frames/desktop/load/frames.json
//
// `k` in every call is the builder's frame. Rows print it as recorded, so newDocument() restarts `k` and `T` from there on.
// synthSite() writes one whole page, as stored takes ('stored') or as one arrive take ('arrive'); SYNTH_TRUTH says what is in it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeTake } from '../../src/record/take.js';
import { rowEncoder, DELTA_HEADER } from '../../src/record/rowcodec.js';
import { Spool } from '../../src/record/series-io.js';
import { FRAMES_SCHEMA } from '../../src/scan/frames.js';
import { SHOTS } from '../../src/scan/moves/contract.js';

export const VIEWPORTS = { desktop: { width: 1440, height: 900 }, phone: { width: 390, height: 844 } };
export const linear = (p) => p;
export const easeOut = (p) => 1 - (1 - p) ** 3;
export const easeInOut = (p) => (p < 0.5 ? 4 * p ** 3 : 1 - (-2 * p + 2) ** 3 / 2);
export const rgb = (a, b) => (p) => `rgb(${a.map((x, i) => Math.round(x + (b[i] - x) * p)).join(', ')})`;

const BLANK = { 'ren:tx': 0, 'ren:ty': 0, 'ren:tz': 0, 'ren:sx': 1, 'ren:sy': 1, 'ren:rz': 0, 'ren:skx': 0, 'ren:transform': 'none', 'ren:translate': 'none', 'ren:scale': 'none', 'ren:rotate': 'none', 'ren:opacity': 1, 'ren:wght': 400, 'ren:wdth': 100, 'ren:radius': '0px', 'ren:clipPath': 'none', 'ren:filter': 'none', 'ren:bg': 'rgba(0, 0, 0, 0)' };
const round6 = (x) => +x.toFixed(6);

/** A writeTake input with nothing of a real machine in it. */
function rawBase({ name, target, rate, viewport, url }) {
  return {
    scenario: name, target, lane: 'hx', rate, dt: 1000 / rate, started: '2026-11-03T00:00:00.000Z', wallMs: 1,
    cfg: { dateEpoch: 1, dateInteger: false, birthRule: 'next', yieldMode: 'macro', seed: 7, maxElements: Infinity },
    browser: { engine: 'synth', product: 'Synth/1', protocolVersion: '1.3', revision: '@synth', toolkit: 'synth', playwright: '0', executablePath: '/synth', args: [] },
    env: { innerWidth: viewport.width, innerHeight: viewport.height, dpr: 1, reducedMotion: 'no-preference', ua: 'synth', readback: { opacity: { maxAbsErr: 0 } } },
    host: { platform: 'synth', release: '0', node: '0', loadavg: [0, 0, 0], cpus: 1 }, net: { misses: 0, missList: [], blocked: 0, docStatus: 200, url }, c: {},
    bootWallMs: 0, bootFrames: 4,
  };
}

/**
 * One take. Values change only through ramps, so what a row holds is what the scene said.
 * @param {{name?:string, frames?:number, from?:number, viewport?:'desktop'|'phone', rate?:number, url?:string, target?:string}} o  frames: last builder frame; from: first frame with a row
 */
export function synthTake({ name = 'take', frames = 240, from = 1, viewport = 'desktop', rate = 60, url = 'https://synth.test/', target = 'scan-synth.test' } = {}) {
  const vp = VIEWPORTS[viewport], els = [], sels = [], watch = [], marks = [], phases = [], births = [], mut = [], wheel = [], input = [], scrolls = [], uniforms = [], docs = [];
  const escapes = {}; let gl = null, drawFn = null, objFn = null, blendFn = null, underFn = null;
  const valueAt = (e, ch, k) => { let v = e.base[ch]; for (const r of e.ramps) { if (r.ch !== ch || k < r.k0) continue; const p = r.k1 > r.k0 ? Math.min(1, (k - r.k0) / (r.k1 - r.k0)) : 1; v = r.fn(r.ease(p)); } return v; };
  const scrollAt = (k) => { let y = 0; for (const s of scrolls) { if (k < s.k0) continue; y = s.y0 + (s.y1 - s.y0) * Math.min(1, s.k1 > s.k0 ? (k - s.k0) / (s.k1 - s.k0) : 1); } return Math.round(y); };

  const t = {
    name, viewport, frames, from,
    /** @param {string} desc  the element descriptor @param {{selector?:string, box?:number[], fixed?:boolean, parent?:number, gone?:boolean, why?:string, at?:number, base?:object}} o */
    el(desc, { selector = null, box = [0, 0, 100, 100], fixed = false, parent = null, gone = false, why = 'animation', at = from, base = {} } = {}) {
      const id = els.length; els.push({ desc, box, fixed, parent, at, base: { ...BLANK, ...base }, ramps: [] });
      sels.push(gone ? [id, null, 1, 1] : [id, selector ?? desc.toLowerCase(), 1, 0]); watch.push([id, why]);
      return id;
    },
    /** Change one channel from k0 to k1. Numbers tween; a `fn` turns progress into any value, a string channel among them. */
    ramp(id, ch, { k0, k1, from: a = 0, to: b = 1, ease = linear, fn = null }) { els[id].ramps.push({ ch, k0, k1, ease, fn: fn ?? ((p) => round6(a + (b - a) * p)) }); return t; },
    /** A hover pair: there at `k`, back at `out`. */
    swell(id, ch, { k, out, len = 18, rest = 1, peak = 1.06, ease = easeOut }) { t.ramp(id, ch, { k0: k, k1: k + len, from: rest, to: peak, ease }); return t.ramp(id, ch, { k0: out, k1: out + len, from: peak, to: rest, ease }); },
    scroll(k0, k1, y0, y1) { scrolls.push({ k0, k1, y0, y1 }); return t; },
    /** A style write on the element, as the mutation series holds it. */
    styleWrite(id, k, isClass = 0) { mut.push({ k, id, isClass }); return t; },
    birth(id, { k, type = 'CSSTransition', name: nm = 'transform', duration = 300, delay = 0, easing = 'ease', iterations = 1 }) { births.push({ name: nm, type, tgt: els[id].desc, timeline: 'document', delay, duration, easing, iterations, direction: 'normal', fill: 'backwards', keyframes: [], el: id, k, provenance: 'declared' }); return t; },
    mark(nm, k) { marks.push({ name: nm, k, extra: null }); return t; },
    /** Pictures for frames k0..k1; `gated` keeps the first frame and the floor of DESIGN 3.3, as a phase of known behaviour has. */
    phase(nm, k0, k1, { gated = false } = {}) { phases.push({ name: nm, k0, k1, gated }); return t; },
    pointer(kind, x, y, k) { input.push({ type: 'pointer', kind, x, y, k }); input.push({ type: 'pointer', ev: kind === 'mouseMoved' ? 'pointermove' : 'pointerdown', k, x, y, buttons: 0, trusted: true, source: 'page-observed' }); return t; },
    wheel(k, dy) { input.push({ type: 'wheel', i: input.length, dy, k }); wheel.push({ k, dy }); return t; },
    /** A float uniform: `fn(k)` on every row, under a recorder key `p<program>|<name>`. */
    uniform(key, fn) { uniforms.push({ key, fn }); return t; },
    canvas(id, { programs = [], textures = null, targets = null, states = null } = {}) { gl = { contexts: [{ id: 0, webgl2: true, el: id, offscreen: false, width: 1440, height: 900 }], counters: {}, programs, ...(textures ? { textures, targets: targets || [] } : {}), ...(states ? { states } : {}) }; return t; },
    /** Who drew in frame k (row.gld, recorder 6 Nov): `fn(k)` -> { p<id>: [draws, order, target...] }. */
    draws(fn) { drawFn = fn; return t; },
    /** Object matrices in frame k (row.glo): `fn(k)` -> { 'p<id>|modelViewMatrix': [16 numbers] }. */
    objects(fn) { objFn = fn; return t; },
    /** Composite state ids per program in frame k (row.glb, recorder 6 Nov): `fn(k)` -> { p<id>: stateId | [ids] }; the states go in canvas({ states }). */
    blends(fn) { blendFn = fn; return t; },
    /** What each program was drawn over in frame k (row.glu): `fn(k)` -> { p<id>: [program ids] }. */
    unders(fn) { underFn = fn; return t; },
    escape(kind, reason, details = []) { escapes[kind] = { kind, steppable: false, reason, count: 1, first: 0, details }; return t; },
    /** From frame `k` the page is a new document: `k` and `T` restart. `lost`: what a stored take did, rows and marks before it died with the page. */
    newDocument(k, { lost = false } = {}) { docs.push({ k, lost }); return t; },

    /** Rows as the session would have written them, in order. The heart of the builder, also handy in a test. */
    rows() {
      const out = [], doc = [...docs].sort((a, b) => a.k - b.k), lost = doc.filter((d) => d.lost).at(-1)?.k ?? -Infinity;
      for (let k = from; k <= frames; k++) {
        if (k < lost) continue;
        const start = doc.filter((d) => d.k <= k).at(-1)?.k ?? 0, rk = start ? k - start + 1 : k;
        const sy = scrollAt(k), v = {};
        els.forEach((e, id) => {
          if (k < e.at) return;
          const o = { ...e.base };
          for (const r of e.ramps) if (k >= r.k0) o[r.ch] = valueAt(e, r.ch, k);
          const p = e.parent != null ? els[e.parent] : null;
          const dx = o['ren:tx'] + (p ? valueAt(p, 'ren:tx', k) : 0), dy = o['ren:ty'] + (p ? valueAt(p, 'ren:ty', k) : 0), s = o['ren:sx'] * (p ? valueAt(p, 'ren:sx', k) : 1);
          if (o['ren:tx'] || o['ren:ty'] || o['ren:sx'] !== 1 || o['ren:sy'] !== 1) o['ren:transform'] = `matrix(${o['ren:sx']}, 0, 0, ${o['ren:sy']}, ${o['ren:tx']}, ${o['ren:ty']})`;
          o['ren:bx'] = round6(e.box[0] + dx); o['ren:by'] = round6(e.box[1] + dy - (e.fixed ? 0 : sy)); o['ren:bw'] = round6(e.box[2] * s); o['ren:bh'] = round6(e.box[3] * s);
          v[id] = o;
        });
        const row = { k: rk, T: round6((rk * 1000) / rate), sy, sx: 0, v, i: k };
        if (uniforms.length) { row.gl = {}; for (const u of uniforms) row.gl[u.key] = u.fn(k); }
        if (drawFn) row.gld = drawFn(k);
        if (objFn) row.glo = objFn(k);
        if (blendFn) row.glb = blendFn(k);
        if (underFn) row.glu = underFn(k);
        out.push(row);
      }
      return out;
    },

    /** Write the take where a scan would. @returns {{take:string, frames:string}} the two folders */
    write(root) {
      const dir = path.join(root, 'takes', viewport, name), frameDir = path.join(root, 'frames', viewport, name);
      fs.mkdirSync(path.dirname(dir), { recursive: true }); fs.mkdirSync(frameDir, { recursive: true });
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-synth-'));
      const spool = { rows: new Spool(path.join(tmp, 'rows'), JSON.stringify(DELTA_HEADER)), mut: new Spool(path.join(tmp, 'mutations')) };
      const enc = rowEncoder(), rows = t.rows(), at = new Map(rows.map((r) => [r.i, r])), light = [];
      let prevK = -1;
      for (const { i, ...r } of rows) { if (r.k <= prevK) enc.reset(); prevK = r.k; spool.rows.line(JSON.stringify(enc.row(r))); light.push({ k: r.k, T: r.T, sy: r.sy, sx: 0 }); }
      const stamp = (x) => { const r = at.get(x.k); return r ? { ...x, k: r.k, T: r.T, sy: r.sy } : null; };
      for (const m of mut) { const r = at.get(m.k); if (r) spool.mut.line(JSON.stringify([r.k, r.sy, m.id, m.isClass])); }
      writeTake({
        ...rawBase({ name, target, rate, viewport: vp, url }), marks: marks.map(stamp).filter(Boolean), escapes, watch, selectors: sels, els: els.map((e) => e.desc), inputLog: input.map(stamp).filter(Boolean), extra: {}, ...(gl ? { gl } : {}),
        data: { rows: light, births: births.map(stamp).filter(Boolean), declared: [], wheel: wheel.map(stamp).filter(Boolean), spool },
      }, { root: dir });
      fs.rmSync(tmp, { recursive: true, force: true });
      // pictures: the rows frames.json holds, one per frame, or the gate's choice
      const fr = [], ph = [];
      for (const p of phases) {
        const rec = { name: p.name, from: fr.length, to: fr.length };
        for (let k = p.k0; k <= p.k1; k++) { const r = at.get(k); if (!r || (p.gated && (k - p.k0) % SHOTS.floor)) continue; fr.push([r.k, r.T, r.sy, fr.length]); }
        rec.to = fr.length; ph.push(rec);
      }
      fs.writeFileSync(path.join(frameDir, 'frames.json'), JSON.stringify({ schema: FRAMES_SCHEMA, format: 'jpeg', quality: 55, scale: 1, clip: vp, size: vp, cols: ['k', 'T', 'sy', 'f'], rows: fr, phases: ph, files: fr.length, bytes: 0 }));
      return { take: dir, frames: frameDir };
    },
  };
  return t;
}

/** A unit record, next to the takes. */
export function writeUnit(root, viewport, name, unit) {
  const d = path.join(root, 'takes', viewport); fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, `${name}.unit.json`), JSON.stringify(unit));
}

// ---------------------------------------------------------------- one whole page with a known truth

/** What synthSite holds: a move model that reads this page right has each `desc` where this says, and none of the traps there. */
export const SYNTH_TRUTH = Object.freeze({
  load: ['SPAN.word', 'DIV.intro'],                 // DIV.intro ends inside the idle window: the tail of the load, not ambient
  ambient: ['DIV.marquee'],
  scroll: ['P.reveal', 'IMG.parallax'],             // triggered once; linked both ways
  scrollUp: ['HEADER.site'],                        // moves on the way up, never on the way down
  touch: ['A.card', 'BUTTON.cta', 'SPAN.tip'],      // SPAN.tip reacts to every test and never moves: a tooltip, a hover, not a cursor
  open: ['NAV.menu'],
  menuTouch: ['A.menu-item'],                       // an inside test, place Menu
  change: ['MAIN.page', 'DIV.exit'],                // a click that left, and a page change by link
  cursor: ['DIV.cursor'],                           // shared, moved between tests, settles on the pointer
  rideAlong: ['DIV.inner'],                         // box only, its parent scales: never in a move
  clocked: ['LI.slide'],                            // a carousel on a 5.4 s timer: starts inside control windows
  belowNoise: ['DIV.shiver'],
});

const LOAD_END = 120, IDLE_LEN = 240;
const TESTS = [
  { id: 'a.card~aa0001#0', pattern: 'a.card~aa0001', member: 0, x: 300, y: 500 }, { id: 'a.card~aa0001#1', pattern: 'a.card~aa0001', member: 1, x: 700, y: 500 },
  { id: 'button.cta~aa0002#0', pattern: 'button.cta~aa0002', member: 0, x: 720, y: 300 }, { id: 'a.foot~aa0003#0', pattern: 'a.foot~aa0003', member: 0, x: 200, y: 820 },
  { id: 'a.logo~aa0004#0', pattern: 'a.logo~aa0004', member: 0, x: 60, y: 40 }, { id: 'a.nav~aa0005#0', pattern: 'a.nav~aa0005', member: 0, x: 1200, y: 40 },
];

/** Hero: three words rising, staggered, with a parent scale carrying a child, a noise-level shiver, and an intro that ends late. */
function loadScene(t, { at = 1, intro = true } = {}) {
  const hero = t.el('SECTION.hero', { selector: 'section.hero', box: [0, 0, 1440, 900] });
  t.ramp(hero, 'ren:sx', { k0: at + 8, k1: at + 60, from: 1.04, to: 1, ease: easeOut }).styleWrite(hero, at + 8);
  t.el('DIV.inner', { selector: 'section.hero > div.inner', box: [100, 100, 400, 300], parent: hero });
  [0, 1, 2].forEach((i) => { const w = t.el('SPAN.word', { selector: `h1 > span:nth-of-type(${i + 1})`, box: [200 + i * 120, 400, 110, 60] }); t.ramp(w, 'ren:ty', { k0: at + 10 + i * 4, k1: at + 46 + i * 4, from: 72.9, to: 0, ease: easeOut }); });
  if (intro) t.ramp(t.el('DIV.intro', { selector: 'div.intro', box: [0, 700, 1440, 40] }), 'ren:opacity', { k0: at + 90, k1: at + LOAD_END + 40, from: 0, to: 1, ease: easeInOut });
  const sh = t.el('DIV.shiver', { selector: 'div.shiver', box: [10, 10, 10, 10] });
  t.ramp(sh, 'ren:tx', { k0: at + 20, k1: at + 40, from: 0, to: 0.4 });
  return { hero };
}
/** Runs the whole take: a loop at rest. */
function loopScene(t, frames) {
  const m = t.el('DIV.marquee', { selector: 'div.marquee', box: [0, 860, 2880, 30], fixed: true });
  t.ramp(m, 'ren:tx', { k0: 1, k1: frames, from: 0, to: -frames * 0.5 });
}
/** A reveal that fires once on the way down, a parallax tied to scrollY both ways, a header that returns on the way up. */
function scrollScene(t, k0, len, pageH = 3600) {
  t.mark('scroll-down', k0).mark('scroll-up', k0 + len).phase('scroll-down', k0, k0 + len - 1).phase('scroll-up', k0 + len, k0 + 2 * len - 1);
  t.scroll(k0, k0 + len, 0, pageH).scroll(k0 + len, k0 + 2 * len, pageH, 0);
  for (let k = k0; k < k0 + len; k += 3) t.wheel(k, 100);
  for (let k = k0 + len; k < k0 + 2 * len; k += 3) t.wheel(k, -100);
  const rev = t.el('P.reveal', { selector: 'p.reveal', box: [200, 1500, 600, 80] });
  t.ramp(rev, 'ren:opacity', { k0: k0 + 90, k1: k0 + 126, from: 0, to: 1, ease: easeOut }).ramp(rev, 'ren:ty', { k0: k0 + 90, k1: k0 + 126, from: 30, to: 0, ease: easeOut });
  const par = t.el('IMG.parallax', { selector: 'img.parallax', box: [0, 1200, 1440, 500] });
  t.ramp(par, 'ren:ty', { k0, k1: k0 + len, from: 0, to: -120 }).ramp(par, 'ren:ty', { k0: k0 + len, k1: k0 + 2 * len, from: -120, to: 0 });
  const head = t.el('HEADER.site', { selector: 'header.site', box: [0, 0, 1440, 72], fixed: true });
  t.ramp(head, 'ren:ty', { k0: k0 + len + 30, k1: k0 + len + 54, from: -72, to: 0, ease: easeOut });
}

/** The touch take: every test has control, hover, press, out; a carousel ticks over all of it; a cursor and a tooltip follow every test. */
function patternsScene(t) {
  const card = [0, 1].map((i) => t.el('A.card', { selector: `a.card:nth-of-type(${i + 1})`, box: [200 + i * 400, 400, 300, 200] }));
  const cta = t.el('BUTTON.cta', { selector: 'button.cta', box: [620, 270, 200, 60] });
  const cursor = t.el('DIV.cursor', { selector: 'div.cursor', box: [0, 0, 16, 16], fixed: true });
  const tip = t.el('SPAN.tip', { selector: 'span.tip', box: [1300, 800, 90, 30], fixed: true });
  const slide = t.el('LI.slide', { selector: 'ul.deck > li:nth-of-type(1)', box: [900, 100, 300, 200] });
  for (let k = 46; k < t.frames; k += 324) t.ramp(slide, 'ren:tx', { k0: k, k1: k + 40, from: 0, to: -300, ease: easeInOut }).ramp(slide, 'ren:tx', { k0: k + 41, k1: k + 42, from: -300, to: 0 });
  let k = 40, px = 0, py = 0;
  TESTS.forEach((c, i) => {
    t.mark(`${c.id}:control`, k); k += 24;
    const hover = k, press = k + 42, out = press + 30, end = out + 30;
    t.mark(`${c.id}:hover`, hover).mark(`${c.id}:press`, press).mark(`${c.id}:out`, out).mark(`${c.id}:end`, end);
    t.phase(`${c.id}:hover`, hover, press - 1).phase(`${c.id}:press`, press, out - 1).phase(`${c.id}:out`, out, end - 1);
    t.pointer('mouseMoved', c.x, c.y, hover).pointer('mousePressed', c.x, c.y, press).pointer('mouseMoved', 2, 2, out);
    t.ramp(cursor, 'ren:tx', { k0: hover, k1: hover + 12, from: px, to: c.x, ease: easeOut }).ramp(cursor, 'ren:ty', { k0: hover, k1: hover + 12, from: py, to: c.y, ease: easeOut }); px = c.x; py = c.y;
    t.swell(tip, 'ren:opacity', { k: hover + 1, out: out + 1, rest: 0.2, peak: 1 });
    if (c.pattern.startsWith('a.card')) t.swell(card[c.member], 'ren:sx', { k: hover + 1, out: out + 1, peak: 1.06 }).swell(card[c.member], 'ren:sy', { k: hover + 1, out: out + 1, peak: 1.06 });
    if (c.pattern.startsWith('button')) t.ramp(cta, 'ren:bg', { k0: hover + 1, k1: hover + 19, fn: rgb([0, 0, 0], [40, 80, 200]) }).ramp(cta, 'ren:bg', { k0: out + 1, k1: out + 19, fn: rgb([40, 80, 200], [0, 0, 0]) }).ramp(cta, 'ren:sx', { k0: press + 1, k1: press + 7, from: 1, to: 0.97 }).ramp(cta, 'ren:sx', { k0: press + 12, k1: press + 18, from: 0.97, to: 1 });
    k = end + 6;
  });
  return { tests: TESTS.map(({ id, pattern, member }) => ({ id, pattern, member, take: t.name, reacts: true, reacted: { hover: ['ren:sx'] }, signature: '{"hover":["scale"],"press":[]}' })) };
}

/** A click that opens a menu, an item hovered inside it, and the close. */
function opensScene(t) {
  const id = 'button.burger~aa0006:click';
  const k = 140, close = k + 200;
  t.mark(`${id}:open`, k).mark(`${id}/a.menu-item~aa0007#0:hover`, k + 110).mark(`${id}/a.menu-item~aa0007#0:out`, k + 140).mark(`${id}/a.menu-item~aa0007#0:end`, k + 170).mark(`${id}:close`, close).mark(`${id}:end`, close + 60);
  t.phase(`${id}:open`, k, k + 109).phase(`${id}/a.menu-item~aa0007#0:hover`, k + 110, k + 139, { gated: true }).phase(`${id}/a.menu-item~aa0007#0:out`, k + 140, k + 169, { gated: true }).phase(`${id}:close`, close, close + 59);
  t.pointer('mousePressed', 1380, 40, k);
  const nav = t.el('NAV.menu', { selector: 'nav.menu', box: [1040, 0, 400, 900], fixed: true });
  t.ramp(nav, 'ren:tx', { k0: k + 2, k1: k + 42, from: 400, to: 0, ease: easeOut }).ramp(nav, 'ren:tx', { k0: close + 2, k1: close + 32, from: 0, to: 400, ease: easeOut });
  const item = t.el('A.menu-item', { selector: 'nav.menu a', box: [1100, 200, 200, 40], fixed: true });
  t.swell(item, 'ren:opacity', { k: k + 111, out: k + 141, rest: 0.6, peak: 1, len: 12 });
  return { pattern: 'button.burger~aa0006', id, take: t.name, opened: { changed: true, navigated: false }, closedBy: 'the same control', inside: [{ id: `${id}/a.menu-item~aa0007#0`, pattern: 'a.menu-item~aa0007', member: 0, reacts: true }] };
}
/** A click that left: it reads as a page change, not an open. */
function leavingScene(t) {
  const id = 'a.project~aa0008:click', k = 140;
  t.mark(`${id}:open`, k).phase(`${id}:open`, k, k + 149).pointer('mousePressed', 400, 400, k);
  const page = t.el('MAIN.page', { selector: 'main.page', box: [0, 0, 1440, 3600] });
  t.ramp(page, 'ren:opacity', { k0: k + 22, k1: k + 100, from: 1, to: 0, ease: easeInOut });
  return { pattern: 'a.project~aa0008', id, take: t.name, navigated: 'https://synth.test/p1', pressed: true };
}
/** A page change by link: same document, a cover wipes. */
function changeScene(t) {
  const k = 106;
  t.mark('change', k).mark('change-end', k + 198).phase('change', k, k + 197).pointer('mousePressed', 800, 60, k);
  const exit = t.el('DIV.exit', { selector: 'div.exit', box: [0, 0, 1440, 900], fixed: true });
  t.ramp(exit, 'ren:ty', { k0: k + 12, k1: k + 60, from: 900, to: 0, ease: easeInOut }).ramp(exit, 'ren:ty', { k0: k + 90, k1: k + 138, from: 0, to: -900, ease: easeInOut });
}

/**
 * One page, one viewport, written to `root`.
 * `stored`: load, idle, scroll, patterns, opens-0, opens-1, change-0, as the scans on disk today.
 * `arrive`: arrive holds load, idle, scroll and the pointer sweep in one take; the rest as stored.
 * @returns {string[]} the take names
 */
export function synthSite(root, { form = 'stored', viewport = 'desktop', url = 'https://synth.test/' } = {}) {
  const mk = (name, frames) => synthTake({ name, frames, viewport, url });
  const names = [];
  const save = (t) => { t.write(root); names.push(t.name); };
  const boot = (t, gap = 4) => t.mark('boot-done', gap);
  const scrollFrames = 420, afterLoad = 95;
  if (form === 'stored') {
    { const t = mk('load', 184); loadScene(t); loopScene(t, 184); t.mark('load-complete', 4).phase('load', 1, 184); save(t); }
    { const t = mk('idle', afterLoad + IDLE_LEN); loadScene(t); loopScene(t, t.frames); boot(t).mark('idle', afterLoad - 1).phase('idle', afterLoad, afterLoad + IDLE_LEN - 1); save(t); }
    { const t = mk('scroll', afterLoad + 2 * scrollFrames); loadScene(t); loopScene(t, t.frames); boot(t); scrollScene(t, afterLoad, scrollFrames); save(t); }
  } else {
    const idleAt = 300, scrollAt = idleAt + IDLE_LEN, sweepAt = scrollAt + 2 * scrollFrames + 60, end = sweepAt + 240;
    const t = mk('arrive', end); loadScene(t); loopScene(t, end);
    t.mark('load-complete', 4).phase('load', 1, 183).mark('idle', idleAt).phase('idle', idleAt, scrollAt - 1); scrollScene(t, scrollAt, scrollFrames);
    t.mark('pointer-sweep', sweepAt).phase('pointer-sweep', sweepAt, end);
    for (let k = sweepAt; k < sweepAt + 180; k += 12) t.pointer('mouseMoved', 100 + (k - sweepAt) * 6, 200 + ((k - sweepAt) % 60) * 8, k);
    save(t);
  }
  { const t = mk('patterns', 860); loadScene(t, { intro: false }); boot(t); const u = patternsScene(t); save(t); writeUnit(root, viewport, 'patterns', { take: 'patterns', viewport, tests: u.tests, missList: [], ok: true }); }
  const o0 = mk('opens-0', 460), o1 = mk('opens-1', 300); for (const t of [o0, o1]) { loadScene(t, { intro: false }); boot(t); }
  const open = opensScene(o0), left = leavingScene(o1); save(o0); save(o1);
  writeUnit(root, viewport, 'opens', { ok: true, tests: [open, left], takes: [], missList: [], names: ['opens-0', 'opens-1'] });
  const ch = mk('change-0', 310); boot(ch); changeScene(ch); save(ch);
  writeUnit(root, viewport, 'change-0', { take: 'change-0', viewport, change: { url: 'https://synth.test/p1', same: true, arrived: true, kind: 'same-document' }, missList: [], ok: true });
  return names;
}
