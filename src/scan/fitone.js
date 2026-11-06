// One fit, ready for the card: the motion in look's shape, trimmed the way the card trims it, written as a script next to the
// pictures so the card reads it the same way with or without a server.
import fs from 'node:fs';
import path from 'node:path';
import { openTake, fitMotion, fitPage, fitGl, chapterRows } from './analyse.js';
import { readPlan, safeId } from './stage.js';
import { trimMotion, trimGl, factsOf, dotsOf, realGaps } from '../card/build.js';

export const fitDir = (out, c) => path.join(out, 'fits', safeId(c));
export const fitFile = (out, c, lead) => path.join(fitDir(out, c), `${lead}.js`);
export const safeJson = (v) => JSON.stringify(v).replace(/</g, '\\u003c').replace(new RegExp(String.fromCharCode(0x2028), 'g'), '\\u2028').replace(new RegExp(String.fromCharCode(0x2029), 'g'), '\\u2029');

/** Was this stored fit stopped by a budget? (The summary sits at the end of the file.) */
export function wasCut(out, c, lead) {
  const file = fitFile(out, c, lead), st = fs.statSync(file), n = Math.min(st.size, 2000), b = Buffer.alloc(n), fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, b, 0, n, st.size - n); } finally { fs.closeSync(fd); }
  return !/"cut":\[\],"note":/.test(b.toString('utf8'));
}

const takeCache = new Map();
/** The last two takes stay open: a person clicks around one chapter, and reading a big take costs 200 ms. */
function take(dir) {
  if (takeCache.has(dir)) { const v = takeCache.get(dir); takeCache.delete(dir); takeCache.set(dir, v); return v; }
  const v = openTake(dir); takeCache.set(dir, v);
  while (takeCache.size > 2) takeCache.delete(takeCache.keys().next().value);
  return v;
}
const planCache = new Map();
function planOf(out, c) {
  const k = `${out}|${c}`;
  if (!planCache.has(k)) { const p = readPlan(out, c); p.byLead = new Map(p.entries.map((e) => [String(e.lead), e])); planCache.set(k, p); }
  return planCache.get(k);
}

/** @returns {{ms:number, cut:string[], tier:string|null}} the summary; the fit itself lands in fits/<chapter>/<lead>.js */
export function fitOne(out, c, lead, { deep = false } = {}) {
  const t0 = Date.now();
  const plan = planOf(out, c), ch = plan.chapter;
  const L = take(path.join(out, plan.takeDir));
  const stub = { take: { frames: L.data.rows.length, rate: L.take.rate, lane: L.take.lane || 'hx' }, action: { do: ch.action === 'load' ? 'load' : ch.action }, motions: [], others: [], warnings: [], errors: [], fit: {}, status: 'ok', declaredOnly: [], declaredTotal: 0, leftOut: [], unknowns: [], notFitted: [], pointerDriven: 0, alreadyMoving: 0 };
  let cut = [], note = null;
  const planned = { ...plan, els: L.data.elements || [], viewport: { width: L.take.env?.innerWidth ?? 1440, height: L.take.env?.innerHeight ?? 900 } };
  const rows = chapterRows(L.data.rows, ch), inputs = L.data.inputLog || null;
  if (lead === 'page') {
    const p = fitPage(L, planned, ch);
    stub.page = p ? { ...trimMotion(p, null), dots: dotsOf(p, rows, inputs) } : null;
    if (!p) note = 'The page does not scroll by itself here.';
  } else if (lead === 'gl') {
    const g = fitGl(L, ch);
    stub.gl = trimGl(g, null);
    if (!stub.gl) note = 'The WebGL calls of this part could not be read; the pictures are the record.';
  } else {
    const e = plan.byLead.get(String(lead));
    if (!e) throw new Error(`no motion ${lead} in ${c}`);
    const r = fitMotion(L, planned, e, ch, { deep });
    cut = r.cut;
    stub.motions = [{ ...trimMotion(r.motion, null), facts: factsOf(r.motion, stub, null), dots: dotsOf(r.motion, rows, inputs), stable: null, gaps: realGaps(r.motion.unknowns) }];
  }
  const ms = Date.now() - t0;
  fs.mkdirSync(fitDir(out, c), { recursive: true });
  const file = fitFile(out, c, lead), tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `window.__fit(${JSON.stringify(c)},${JSON.stringify(lead)},${safeJson({ look: stub, ms, cut, note })});\n`);
  fs.renameSync(tmp, file);
  return { ms, cut };
}
