// One reader for a page and viewport, whether it holds stored `load`, `idle`, `scroll` takes or one `arrive` take (DESIGN 2.4 step 0).
// M1 and the card build on stored takes and stage H on new ones, so nothing past this file may ask which it is.
// Ranges come from frames.json phases and from the marks the Node side kept: a page's own marks die with its document, and `close` has
// no mark on stored takes. `k` restarts on a new document, so everything here is in K (runs.js), and `partOf` answers in plain words.
import fs from 'node:fs';
import path from 'node:path';
import { parseMark } from './contract.js';
import { readRuns, walker } from './runs.js';

const IDLE_GRACE = 6;   // a run that ends this close to the idle mark is settle, not idle
const naturally = (a, b) => a.localeCompare(b, 'en', { numeric: true });

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }

const roleOf = (name) => (/^arrive/.test(name) ? 'arrive' : name === 'load' ? 'load' : name === 'idle' ? 'idle' : name === 'scroll' ? 'scroll' : /^(patterns|opens)/.test(name) ? 'touch' : /^change/.test(name) ? 'change' : 'other');

/** frames.json phases as K ranges: `to` is the last pictured frame of the phase. */
function phasesOf(fr, offsets) {
  if (!fr || !fr.phases) return [];
  const walk = walker(offsets), ks = (fr.rows || []).map((r) => walk(r[0]));
  return fr.phases.filter((p) => p.to > p.from).map((p) => ({ name: p.name, from: ks[p.from], to: ks[p.to - 1] })).filter((p) => p.from != null && p.to != null);
}

/**
 * Test windows of a take: each test part reaches to the next part. `end` and `opened` close a window and open none.
 * A close seen only in the phases of frames.json gets its window from there.
 */
export function windowsOf(view) {
  const marks = view.marks.map((m) => ({ ...m, part: parseMark(m.name) })).filter((m) => m.part), wins = [];
  for (let i = 0; i < marks.length; i++) {
    const m = marks[i];
    if (m.part.part === 'end' || m.part.part === 'opened') continue;
    wins.push({ id: m.part.id, part: m.part.part, from: m.K, to: marks[i + 1]?.K ?? view.kLast + 1, doc: m.doc, enter: m.extra?.enter ?? 0 });
  }
  const closes = [];
  for (const w of wins) {
    if (w.part !== 'open' || wins.some((q) => q.id === w.id && q.part === 'close')) continue;
    const c = view.phases.filter((p) => p.name === `${w.id}:close`);
    if (c.length) closes.push({ id: w.id, part: 'close', from: c[0].from, to: c[c.length - 1].to + 1, doc: w.doc });
  }
  return { wins, closes };
}

/** One take of a page, runs included. */
function openTake(root, vp, name, { pinRange = true } = {}) {
  const dir = path.join(root, 'takes', vp, name), role = roleOf(name);
  const head = readJson(path.join(dir, 'take.json'));
  if (!head) return null;
  const fr = readJson(path.join(root, 'frames', vp, name, 'frames.json'));
  const motion = role === 'arrive' || role === 'scroll';
  const read = readRuns(dir, { keepPoints: motion, pinRange: motion && pinRange ? [head.marks?.find((m) => m.name === 'scroll-down')?.k ?? 0, Infinity] : null });
  const walk = walker(read.offsets);
  const marks = (head.marks || []).map((m) => { const K = walk(m.k); return { name: m.name, k: m.k, K, T: m.T, sy: m.sy, doc: read.docOf(K), ...(m.extra ? { extra: m.extra } : {}) }; });
  const view = { name, role, dir, take: read.take, runs: read.runs, nRows: read.nRows, offsets: read.offsets, syAt: read.syAt, tAt: read.tAt, kFirst: read.kFirst, kLast: read.kLast, input: read.input, wheel: read.wheel, gl: read.gl, pins: read.pins, elements: read.elements, selectors: read.selectors, marks, phases: phasesOf(fr, read.offsets), pictures: fr?.rows?.length ?? 0 };
  const at = (nm) => view.marks.find((m) => m.name === nm)?.K ?? view.phases.find((p) => p.name === nm)?.from ?? null;
  const gate = view.phases.filter((p) => p.name === 'gate');
  const sweep = view.phases.find((p) => p.name === 'pointer-sweep');
  view.sections = { idle: at('idle'), down: at('scroll-down'), up: at('scroll-up'), sweep: at('pointer-sweep'), sweepEnd: sweep?.to ?? null, gate: gate.length ? [gate[0].from, gate[gate.length - 1].to] : null };
  return view;
}

/** The kind of stretch a run started in, on any take of the arrival: load, gate, idle, down, up, sweep, setup or between. */
export function partOf(view, r) {
  const s = view.sections;
  if (view.role === 'load') return 'load';
  if (view.role === 'idle') {
    if (s.idle != null && r.k1 >= s.idle + IDLE_GRACE) return 'idle';
    if (s.gate && r.k0 >= s.gate[0] && r.k0 <= s.gate[1]) return 'gate';
    return 'setup';
  }
  if (view.role === 'scroll') { if (s.down != null && r.k0 < s.down) return 'setup'; return s.up != null && r.k0 >= s.up ? 'up' : 'down'; }
  if (view.role === 'arrive') {
    if (s.sweep != null && r.k0 >= s.sweep) return s.sweepEnd != null && r.k0 > s.sweepEnd ? 'between' : 'sweep';
    if (s.up != null && r.k0 >= s.up) return 'up';
    if (s.down != null && r.k0 >= s.down) return 'down';
    if (s.gate && r.k0 >= s.gate[0] && r.k0 <= s.gate[1]) return 'gate';
    if (s.idle != null && r.k1 >= s.idle + IDLE_GRACE) return 'idle';
    if (s.gate && r.k0 > s.gate[1]) return 'setup';
    return 'load';
  }
  return 'other';
}

/** The idle window of a page: where it stands and where it ends. */
export function idleWindow(P) {
  for (const v of P.views) {
    if ((v.role !== 'idle' && v.role !== 'arrive') || v.sections.idle == null) continue;
    return { view: v, from: v.sections.idle, last: v.role === 'arrive' ? (v.sections.down ?? v.kLast) : v.kLast };
  }
  return null;
}

/**
 * Open a page and viewport.
 * @param {string} root  the folder that holds takes/ and frames/: the scan folder for home, pages/<id> for the others
 * @returns {object|null} { id, vp, root, views, tests, units, viewport, table, inventory }
 */
export function openPage(root, id, vp) {
  const td = path.join(root, 'takes', vp);
  if (!fs.existsSync(td)) return null;
  const views = [];
  const entries = fs.readdirSync(td).sort(naturally);
  for (const n of entries) { if (!fs.existsSync(path.join(td, n, 'take.json'))) continue; const v = openTake(root, vp, n); if (v) views.push(v); }
  if (!views.length) return null;
  const units = {};
  for (const n of entries) if (n.endsWith('.unit.json')) { const j = readJson(path.join(td, n)); if (j) units[n.slice(0, -'.unit.json'.length)] = j; }
  const tests = new Map();
  for (const u of Object.values(units)) for (const t of u.tests || []) { if (!t.id) continue; tests.set(t.id, t); for (const q of t.insideTests || t.inside || []) if (q.id) tests.set(q.id, q); }
  const env = views[0].take.env || {};
  const viewport = { width: env.innerWidth?.value ?? env.viewport?.value?.width ?? (vp === 'phone' ? 390 : 1440), height: env.innerHeight?.value ?? env.viewport?.value?.height ?? (vp === 'phone' ? 844 : 900) };
  const tableFile = views.map((v) => path.join(root, 'frames', vp, v.name, 'table.json')).find((f) => fs.existsSync(f));
  const inventory = units.survey?.inv ?? units.arrive?.inv ?? views.map((v) => units[v.name]?.inv).find(Boolean) ?? null;
  return { id, vp, root, views, tests, units, viewport, table: tableFile ? readJson(tableFile) : null, inventory, gatePlan: units.survey?.gatePlan ?? units.arrive?.gatePlan ?? null };
}

/** The pages of a scan, home first: [{id, root}]. */
export function pagesOf(scanDir) {
  const pd = path.join(scanDir, 'pages'), out = [{ id: 'home', root: scanDir }];
  if (fs.existsSync(pd)) for (const id of fs.readdirSync(pd).sort(naturally)) if (fs.statSync(path.join(pd, id)).isDirectory()) out.push({ id, root: path.join(pd, id) });
  return out;
}
