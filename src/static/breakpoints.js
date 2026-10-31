// Breakpoint detection (PLAN M4 "build only breakpoint detection", S6 §1.5): width sweep + layout signature + binary
// search around each change, then every measured change is explained by a query/gate or listed `unknown`.
// The pure parts (this file, no browser) are unit-tested with synthetic signatures; `sweepBreakpoints` drives a page.
import crypto from 'node:crypto';
import { SIG_PROPS } from './props.js';
import { layoutRows, mediaEdgesInPage } from './inpage.js';

const sha = s => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);

/** Sorted unique widths: regular steps plus a probe at each extra width (declared edges: t-1, t, t+1). */
export function sweepWidths({ from, to, step, extra = [] }) {
  const set = new Set();
  for (let w = from; w < to; w += step) set.add(w);
  set.add(to);
  for (const e of extra) if (e >= from && e <= to) set.add(e);
  return [...set].sort((a, b) => a - b);
}

/**
 * snapshots: Map<width, Array<[id, ...vals]>>. Returns Set of "id|col" keys whose value changes in >= `run` consecutive
 * sweep intervals: a fluid property (clamp(), %, vw, auto width) moves continuously, a breakpoint moves in one interval.
 * Fluid keys are excluded from the signature; they are counted and reported, never silently dropped.
 */
export function classifyFluid(widths, snapshots, run = 3, dependent = []) {
  const series = new Map(); // key -> values per width index
  widths.forEach((w, wi) => {
    for (const row of snapshots.get(w) || []) {
      const id = row[0];
      for (let c = 1; c < row.length; c++) {
        const k = id + '|' + c;
        let s = series.get(k); if (!s) { s = new Array(widths.length).fill(undefined); series.set(k, s); }
        s[wi] = row[c];
      }
    }
  });
  const fluid = new Set();
  for (const [k, s] of series) {
    let streak = 0, best = 0;
    for (let i = 1; i < s.length; i++) {
      if (s[i] !== undefined && s[i - 1] !== undefined && s[i] !== s[i - 1]) { streak++; best = Math.max(best, streak); } else streak = 0;
    }
    if (best >= run) fluid.add(k);
  }
  // content-driven geometry: when an element's width is fluid, its auto height moves with text wrapping, which is reflow and
  // not a rule; a fixed-width element keeps its height cell (a rule that resizes it is still seen)
  for (const [src, dst] of dependent) for (const k of [...fluid]) { const [id, c] = k.split('|'); if (+c === src) fluid.add(id + '|' + dst); }
  return fluid;
}

/** Signature of one snapshot with fluid keys masked out. */
export function signature(rows, fluid, { ignoreWrap = false } = {}) {
  const parts = [];
  for (const row of rows) {
    const id = row[0]; const vals = [];
    for (let c = 1; c < (ignoreWrap ? row.length - 1 : row.length); c++) if (!fluid.has(id + '|' + c)) vals.push(row[c]);
    parts.push(id + ':' + vals.join('\u0001'));
  }
  return sha(parts.join('\n'));
}

/**
 * Binary search for exact edges between two widths whose signatures differ.
 * sigAt(w) -> Promise<string>. Handles a third state in between (recurses into both halves).
 * @returns {Promise<Array<{lastOld:number, firstNew:number}>>}
 */
export async function bisectEdges(sigAt, lo, hi, sigLo, sigHi, { maxProbes = Infinity } = {}) {
  const out = []; let probes = 0;
  async function go(a, b, sa, sb) {
    if (b - a <= 1) { out.push({ lastOld: a, firstNew: b }); return; }
    if (++probes > maxProbes) { out.over = true; return; }
    const m = Math.floor((a + b) / 2); const sm = await sigAt(m);
    if (sm === sa && sm !== sb) await go(m, b, sm, sb);
    else if (sm === sb && sm !== sa) await go(a, m, sa, sm);
    else { await go(a, m, sa, sm); await go(m, b, sm, sb); }
  }
  if (sigLo === sigHi) return out;
  await go(lo, hi, sigLo, sigHi);
  return out;
}

/**
 * Explain measured edges by query edges. queryEdges: [{query, source:'css'|'js-matchMedia', file?, edges:[{lastOld, firstNew}]}].
 * Exact (lastOld, firstNew) match only; edges within 2 px are reported as `near` but are NOT counted as explained.
 */
export function explainEdges(measuredEdges, queryEdges) {
  const explained = measuredEdges.map(e => {
    const by = []; const near = [];
    for (const q of queryEdges) for (const qe of q.edges) {
      if (qe.lastOld === e.lastOld && qe.firstNew === e.firstNew) by.push({ query: q.query, source: q.source, file: q.file ?? null });
      else if (Math.abs(qe.firstNew - e.firstNew) <= 2) near.push({ query: q.query, source: q.source, edge: qe });
    }
    return { ...e, explainedBy: by, near };
  });
  const matched = new Set(explained.flatMap(e => e.explainedBy.map(b => b.query + '|' + b.source)));
  const declaredWithoutMeasuredEffect = [];
  for (const q of queryEdges) for (const qe of q.edges) {
    const hit = measuredEdges.some(e => e.lastOld === qe.lastOld && e.firstNew === qe.firstNew);
    if (!hit) declaredWithoutMeasuredEffect.push({ query: q.query, source: q.source, file: q.file ?? null, edge: qe });
  }
  return { explained, declaredWithoutMeasuredEffect, matchedQueries: [...matched] };
}

/**
 * Drives a Playwright page through the sweep. `declaredEdgeWidths` adds probes at t-1,t,t+1 of every declared edge.
 * @returns {{widths:number[], fluidCount:number, trackedCells:number, edges:Array<{lastOld,firstNew,sigLo,sigHi}>, probes:number}}
 */
export async function sweepBreakpoints(page, { from = 320, to = 1920, step = 40, height = 900, declaredEdgeWidths = [], maxElements = 2000, settle, ignoreWrap = false, maxProbesPerInterval = Infinity } = {}) {
  // maxProbesPerInterval: an interval whose layout changes at more widths than that is one fluid interval (not searched
  // pixel by pixel; REVA's design pass)
  // ignoreWrap: wrap flags leave the signature, so text wrapping on its own makes no edge and costs no binary search
  // (REVA's design pass; the reflow-only edges are then not counted)
  const snaps = new Map(); const rawRows = new Map();
  // a page that reloads or redirects on resize destroys the context mid-probe: wait for the new document and measure
  // it at the same width (it loaded at that width, so it does not navigate again); `navigations` names those widths
  const navigations = [];
  const measure = async () => {
    if (settle) await settle(page);
    else await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    return page.evaluate(layoutRows, { sigProps: SIG_PROPS, maxElements });
  };
  const grab = async w => {
    if (rawRows.has(w)) return rawRows.get(w);
    await page.setViewportSize({ width: w, height });
    let rows;
    for (let attempt = 0; ; attempt++) {
      try { rows = await measure(); break; } catch (e) {
        if (attempt >= 2 || !/Execution context was destroyed/.test(e.message)) throw e;
        navigations.push({ width: w, url: page.url() });
        await page.waitForLoadState('load', { timeout: 30000 }).catch(() => {});
      }
    }
    rawRows.set(w, rows); return rows;
  };
  const widths = sweepWidths({ from, to, step, extra: declaredEdgeWidths });
  for (const w of widths) snaps.set(w, await grab(w));
  const fluid = classifyFluid(widths, snaps, 3, [[SIG_PROPS.indexOf('width') + 1, SIG_PROPS.indexOf('height') + 1]]);
  const sigCache = new Map();
  const sigAt = async w => { if (!sigCache.has(w)) sigCache.set(w, signature(await grab(w), fluid, { ignoreWrap })); return sigCache.get(w); };
  const edges = [];
  for (let i = 1; i < widths.length; i++) {
    const [a, b] = [widths[i - 1], widths[i]];
    const [sa, sb] = [await sigAt(a), await sigAt(b)];
    const found = sa !== sb ? await bisectEdges(sigAt, a, b, sa, sb, { maxProbes: maxProbesPerInterval }) : [];
    if (found.over) { edges.push({ lastOld: a, firstNew: b, reflowOnly: false, fluidInterval: true, sigLo: sa, sigHi: sb }); continue; }
    for (const e of found) {
      // reflow-only: the sibling wrap flags changed but no computed style did (text/flex items wrapping on their own)
      const reflowOnly = signature(await grab(e.lastOld), fluid, { ignoreWrap: true }) === signature(await grab(e.firstNew), fluid, { ignoreWrap: true });
      edges.push({ ...e, reflowOnly, sigLo: sa, sigHi: sb });
    }
  }
  let cells = 0; for (const rows of snaps.values()) cells = Math.max(cells, rows.length * (rows[0] ? rows[0].length - 1 : 0));
  return { widths, fluidCount: fluid.size, trackedCells: cells, edges, probes: rawRows.size, ignoreWrap, navigations };
}

/** Engine-evaluated edges of a list of media query strings (hidden iframe viewport; operators/units/range syntax are the engine's). */
export async function queryEdges(page, queries, { from = 200, to = 2600 } = {}) {
  if (!queries.length) return {};
  return page.evaluate(mediaEdgesInPage, { queries, from, to });
}
