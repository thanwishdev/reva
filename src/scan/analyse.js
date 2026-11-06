// One chapter of a scan, analysed the way `reva look` analyses a take: which elements move, how they fold into motions, and
// one motion's fit on demand. runLook does this after recording, for a handful of motions in one pass; a scan keeps every
// moving element, so here the plan covers all of them and the fit runs one motion at a time (fit on open, or all with --all).
// Nothing here touches a browser or the site: it reads the take on disk.
import path from 'node:path';
import { loadTake } from '../record/take.js';
import { fitTakeSet } from '../analysis/fit/index.js';
import { exportFit, exportStagger, withRecordedEnds, LIBS } from '../export/index.js';
import { elementStats, planFit, splitDeclaredTransform, fitOrder, renderedTransformStill } from '../look/select.js';
import { LOOK_FIT, mergeFits, coverage, expandDeclaredBirths, dropStatedPaint, groupStagger } from '../look/index.js';
import { describeElement, describeStagger } from '../look/words.js';
import { forExport, exportWord, anchorMapToSamples } from '../look/exportword.js';
import { guardPhysical } from '../look/physical.js';
import { groupStarts, relStart } from '../look/starts.js';
import { glPass } from '../look/gl.js';
import { recordedEnds } from '../mcp/analysis.js';

export const SERIES = ['rows', 'births', 'declared', 'mutations', 'wheel', 'inputLog', 'elements'];
/**
 * One motion, one budget, so a click answers in seconds (look's budgets are for a whole take). Counted in evaluations, not time, so
 * the result is the same at any speed; about 10 s at the 25 M evaluations/s measured here. A cut says so in the motion's own words.
 */
export const PER_MOTION = { ...LOOK_FIT, earlyExit: true, evalBudget: 2.4e8, channelEvalBudget: 1.2e8, identifyBudget: 6e7, driverBudget: 3e7 };
/** `--all`: look's own budgets, so a motion the quick budget cut gets its full fit when nobody is waiting. */
export const DEEP = { ...LOOK_FIT, earlyExit: true };

/** The take of a chapter as look would see it: rows limited to the chapter, everything else as recorded. */
export function openTake(dir) { return loadTake(dir, SERIES); }

const viewportOf = (take) => ({ width: take.env?.innerWidth?.value ?? take.env?.innerWidth ?? 1440, height: take.env?.innerHeight?.value ?? take.env?.innerHeight ?? 900 });

/** The slice of a take's rows that belongs to a chapter (a scroll take holds both directions; fit needs 300 ms of rest before). */
export function chapterRows(rows, ch) {
  const lead = ch.action === 'scroll' ? 300 : 0;
  return rows.filter((r) => (ch.fromT == null || r.T >= ch.fromT - lead) && (ch.toT == null || r.T < ch.toT));
}

/**
 * Every moving element of a chapter, folded into motions and ranked as look ranks them (nothing is cut: top = all).
 * @param {{take:object, data:object, dir:string}} L  an open take
 * @param {{action:string, fromT?:number, toT?:number}} ch
 * @returns {{entries:object[], pageId:number|null, pageKey:string|null, loose:number[], viewport:object}}
 */
export function planChapter(L, ch) {
  const { take, data, dir } = L;
  const rows = chapterRows(data.rows, ch);
  const els = data.elements || [];
  const watched = (take.watch || []).map((w) => (Array.isArray(w) ? w[0] : w));
  const pageId = ch.action === 'scroll' ? ((take.watch || []).find(([id]) => /^HTML\b/.test(els[id] || '')) || [null])[0] : null;
  const candidates = watched.filter((id) => id !== pageId);
  const viewport = viewportOf(take);
  // decoded rows share an unchanged element's object, so an element that never changed here costs one comparison per row, not a walk of its channels
  const changing = candidates.filter((id) => { const v0 = rows[0]?.v?.[id]; return rows.some((r) => r.v?.[id] !== v0); });
  const stats = elementStats({ rows, ids: changing, dt: 1000 / (take.rate || 60), viewport, pointer: null });
  dropStatedPaint(stats, els, dir, ch.action === 'load' ? null : ch.fromT ?? null);
  const sels = new Map((take.selectors || []).map(([id, s, n, gone]) => [id, [s, n, gone]]));
  const plan = planFit({ stats, els, candidates, top: 1e9, aimed: false, maxChannels: 1e9, maxMembers: 24, action: ch.action, sels, viewport });
  const placed = new Set(plan.entries.flatMap((e) => e.ids));
  const pageMoves = pageId != null && new Set(rows.map((r) => r.v?.[pageId]?.['ren:by'])).size > 1;
  return { entries: plan.entries, pageId, pageKey: pageMoves ? `${pageId}|ren:by` : null, loose: candidates.filter((id) => !placed.has(id)), stats, els, sels, viewport };
}

/** First input of the chapter, on the take's clock: the moment the action began. */
function actionT(take, ch) {
  const inChapter = (e) => Number.isFinite(e.T) && (ch.fromT == null || e.T >= ch.fromT - 1) && (ch.toT == null || e.T < ch.toT);
  const e = (take.inputLog || []).find((x) => ((x.type === 'pointer' && x.kind !== 'missing') || x.type === 'wheel') && inChapter(x));
  return e ? e.T : null;
}

/**
 * Fit one motion. The result has the shape of one entry of look.json `motions`, so the card's panel reads it unchanged.
 * @param {object} L        open take
 * @param {object} planned  planChapter's result
 * @param {object} e        one of planned.entries
 * @param {object} ch       the chapter
 * @returns {{motion:object, ms:number, cut:string[]}}
 */
export function fitMotion(L, planned, e, ch, { deep = false } = {}) {
  const t0 = Date.now(), budget = deep ? DEEP : PER_MOTION;
  const { take, dir } = L; const { els, viewport } = planned;
  const rows = chapterRows(L.data.rows, ch);
  const view = { ...L, data: { ...L.data, rows } };
  const tAction = ch.action === 'load' ? null : actionT({ inputLog: L.data.inputLog || [] }, ch);
  const keys = [...(e.fitted?.lead || []).map((c) => `${e.lead}|${c}`), ...(e.fitted?.members || []).map((id) => `${id}|${e.memberChannel}`)].slice(0, LOOK_FIT.maxChannels);
  const noop = new Set(keys.filter((k) => { const [el, c] = k.split('|'); return /^(drv|ren):transform$/.test(c) && renderedTransformStill(rows, el); }));
  const fitKeys = keys.filter((k) => !noop.has(k));
  let res = null; const covered = [];
  if (fitKeys.length) {
    const split = splitDeclaredTransform(fitKeys, view.data.births, els);
    const order = fitOrder([e], view.data.births, els, { pageKey: null });
    res = fitTakeSet({ primary: view }, { ...budget, order, declaredFirst: order.declared, onlyKeys: split.first });
    const declared = new Set(res.records.filter((r) => r.tier === 'declared' && /^ren:(sx|sy|rz|skx|tz|tx|ty)$/.test(r.target.channel)).map((r) => String(r.target.el)));
    const pass2 = split.deferred.filter((k) => { if (declared.has(k.split('|')[0])) { covered.push({ key: k, by: 'the declared transform transition of this element' }); return false; } return true; });
    if (pass2.length) res = mergeFits(res, fitTakeSet({ primary: view }, { ...budget, order, onlyKeys: pass2 }));
    res = { ...res, records: res.records.map((r) => guardPhysical(anchorMapToSamples(r))) };
  }
  const motion = assemble({ L, ch, e, res, rows, keys, covered, noop, tAction, take, dir, els, viewport });
  return { motion, ms: Date.now() - t0, cut: (res?.flags || []).filter((f) => /budget/.test(f.id)).map((f) => f.id) };
}

function assemble({ L, ch, e, res, rows, keys, covered, noop, tAction, take, dir, els, viewport }) {
  const rate = take.rate || 60;
  const endsOf = (r) => { try { return recordedEnds(dir, r); } catch { return null; } };
  const exRes = res ? (({ records, ...rest }) => ({ ...rest, records: records.map((r) => withRecordedEnds(r, endsOf).rec) }))(forExport(res)) : null;
  const ex = res ? exportFit(exRes, { to: LIBS, meta: { url: 'scan', date: String(take.started || '').slice(0, 10), takeName: `scan-${ch.id}` } }) : { items: [], stagger: [] };
  const fallbackTrigger = (t) => (ch.action === 'load' ? (ch.phase === 'idle' ? 'plays by itself' : 'plays on load') : tAction != null && t >= tAction - 1 ? `starts after the ${ch.action}` : null);
  const recs = res ? res.records.filter((r) => r.target.el === e.lead) : [];
  const memberRecs = res && e.kind === 'group' ? res.records.filter((r) => e.ids.includes(r.target.el) && r.target.el !== e.lead) : [];
  const lines0 = describeElement(recs, { fallbackTrigger, oneRate: rate });
  const lines = expandDeclaredBirths(lines0, els[e.lead], null, null, recs, fallbackTrigger);
  let stagger = null;
  if (res && e.kind === 'group') {
    const g = groupStagger(res.records.filter((r) => e.ids.includes(r.target.el)), { data: { rows }, dt: 1000 / rate }, viewport);
    if (g) { const d = describeStagger(g, e.count); const xs = exportStagger(g, new Set(LIBS)); stagger = { ...d, group: g, exports: xs.skipped ? [] : xs.exports }; }
  }
  const lineOf = (l) => ({ text: l.text, kind: l.kind, family: l.family, label: l.label, channels: [...new Set(l.channels)], trigger: l.trigger, t0: l.t0, rel: relStart(l.t0, tAction), times: l.times, values: l.values });
  const exportsOf = ex.items.filter((it) => it.el === e.lead).map((it) => {
    const rec = exRes.records.find((r) => r.target.el === it.el && r.target.channel === it.channel) || null;
    return { channel: it.channel, family: it.family, kind: it.kind, model: it.model, notes: it.notes, fit: it.fit, t0: rec && Number.isFinite(rec.derived?.t0) ? rec.derived.t0 : null,
      exports: it.exports.map((x) => ({ lib: x.lib, form: x.form || null, code: x.code, accuracy: x.accuracy, note: x.note || null, match: exportWord(rec, it, x, rate), ...(x.decl ? { decl: x.decl } : {}) })) };
  });
  const gaps = res || noop.size ? coverage(keys, res, rows, covered, els, noop) : [];
  return {
    rank: e.rank, kind: e.kind, desc: e.desc, selector: e.selector ?? null, selectorMatches: e.matches ?? null, leadSelector: e.leadSelector ?? null, box: e.box || null, count: e.count, lead: e.lead, ids: e.ids,
    notice: e.notice || null, starts: e.kind === 'group' && !stagger ? groupStarts([...recs, ...memberRecs], e.memberChannel) : null, weight: e.weight, weightShare: e.weightShare, channels: e.channels, fitted: e.fitted, membersNotFitted: e.membersNotFitted || 0,
    covered: covered.filter((c) => c.key.split('|')[0] === String(e.lead)).map((c) => ({ channel: c.key.split('|')[1], by: c.by })),
    unknowns: gaps.filter((g) => g.el === e.lead), lines: lines.map(lineOf), stagger, exports: exportsOf,
    records: recs, share: null,
  };
}

/** The page's own scroll line of a scroll chapter (one channel, look's `page` row). */
export function fitPage(L, planned, ch) {
  if (!planned.pageKey) return null;
  const rows = chapterRows(L.data.rows, ch);
  const view = { ...L, data: { ...L.data, rows } };
  const res = fitTakeSet({ primary: view }, { ...PER_MOTION, onlyKeys: [planned.pageKey] });
  const recs = res.records.map((r) => guardPhysical(anchorMapToSamples(r))).filter((r) => r.target.el === planned.pageId);
  const tAction = actionT({ inputLog: L.data.inputLog || [] }, ch);
  const lines = describeElement(recs, { oneRate: L.take.rate }).map((l) => ({ text: l.text, kind: l.kind, family: l.family, label: l.label, channels: [...new Set(l.channels)], trigger: l.trigger, t0: l.t0, rel: relStart(l.t0, tAction), times: l.times, values: l.values }));
  return { el: planned.pageId, desc: planned.els[planned.pageId], channel: 'ren:by', lines, records: recs, channels: ['ren:by'], unknowns: [], covered: [], exports: [] };
}

/** What a canvas drew in this take (shaders, uniforms, camera), look's WebGL pass on the whole take. */
export function fitGl(L, ch) {
  const dir = L.dir;
  const endsOf = (r) => { try { return recordedEnds(dir, r); } catch { return null; } };
  const fallbackTrigger = () => (ch.action === 'load' ? 'plays on load' : null);
  return glPass({ dir, take: L.take, fitOpts: PER_MOTION, rate: L.take.rate, fallbackTrigger, endsOf, series: SERIES });
}

export const takeDirOf = (out, vp, take) => path.join(out, 'takes', vp, take);
