// S7, the move model (DESIGN 2.4): stored or new takes in, moves.json and moves/<id>.json out. No browser, one thread, seconds.
//   const built = buildMoves(scanDir);   writeMoves(scanDir, built);
// The fit (S8), clips (S9) and the card (S10) fill in what is left: `time`, `curve` and `proof` from the fit, `frame` from the clips.
// `moves-laws.json` is the fit's work list: one entry per law class, with the rows of its exemplar and of up to 8 other instances.
import fs from 'node:fs';
import path from 'node:path';
import { BUCKETS, consentOf, emptyTally, familyOf, FIT, GROUPS, groupOf, indexProblems, KIND, lawSignature, moveFileProblems, moveId, SCHEMA, selectorGroup } from './contract.js';
import { cursorKeys, finishPage, mergeBands, readPage } from './trigger.js';
import { groupsOf, lawClasses, summarise } from './group.js';
import { foldViewport, pairViewports } from './fold.js';
import { rankClass, topOf } from './rank.js';
import { nameOf, nearestHeading, pageWords, plainSentence, splitOf, subjectOf, techniqueOfGroups } from './name.js';
import { moveScrollKind } from './scrollkind.js';
import { mediaOf, scenesOf, scrollLaw } from './pagelevel.js';
import { openPage, pagesOf } from './takeview.js';
import { apart } from './same.js';

export const LAWS_FILE = 'moves-laws.json';
const INDEX_INSTANCES = 3, SELECTORS_MAX = 6, CHANNELS_MAX = 12, ROUND = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);
const msOf = (frames) => Math.round((frames * 1000) / 60);

const sitePath = (url) => { try { const p = new URL(url).pathname; return p === '/' ? 'Home' : p.replace(/\/$/, ''); } catch { return url; } };
const pathOf = (url) => (url ? pageWords(sitePath(url), 48) : null);
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }

/** `site.built`, from what the design pass read: libraries, GSAP and Lenis probes (S6). */
export function builtWith(look, { webgl = false } = {}) {
  if (!look && !webgl) return [];
  const out = [], seen = new Set();
  const add = (e) => { const k = e.name.toLowerCase(); if (!seen.has(k)) { seen.add(k); out.push(e); } };
  if (look?.gsap?.found) add({ name: 'GSAP', version: look.gsap.version ?? null, via: 'read' });
  if (look?.lenis?.found) add({ name: 'Lenis', version: look.lenis.version ?? null, via: 'read' });
  for (const l of look?.libraries?.list || []) { if (l.status !== 'detected' || l.implied) continue; add({ name: l.name, version: l.version?.value ?? null, via: l.version?.provenance === 'measured' ? 'read' : 'bundle' }); }
  // a page that draws WebGL says so beside its libraries, near the front (the bar shows four): its engine when one is read, or
  // probable in the bundle and confirmed by the canvas drawing; raw WebGL otherwise (a skinned-mesh WebGL site, 6 Nov: the bar said GSAP only)
  if (webgl) {
    const ENG = /three\.js|babylon|pixi|ogl|playcanvas|regl|curtains|spline|webgl/i, lib = (look?.libraries?.list || []).find((l) => ENG.test(l.name) && !l.implied && (l.status === 'detected' || l.status === 'probable'));
    const e = lib ? { name: lib.name, version: lib.version?.value ?? null, via: lib.status === 'detected' ? 'bundle' : 'bundle, probable; the page draws WebGL', webgl: true } : { name: 'WebGL', version: null, via: 'the page draws WebGL (no engine read)', webgl: true };
    const had = out.findIndex((x) => x.name.toLowerCase() === e.name.toLowerCase()); if (had >= 0) out.splice(had, 1);
    out.splice(Math.min(1, out.length), 0, e);
  }
  return out;
}

const unionOf = (boxes) => {
  const list = boxes.filter((b) => b && b.every(Number.isFinite));
  if (!list.length) return null;
  const x = Math.min(...list.map((b) => b[0])), y = Math.min(...list.map((b) => b[1]));
  return [x, y, Math.max(...list.map((b) => b[0] + b[2])) - x, Math.max(...list.map((b) => b[1] + b[3])) - y].map(ROUND);
};

/** One place a move was seen. Times are on its take's own clock; `k0`, `k1` are the frames as stored in that take's rows. */
function instanceOf(m, viewName = null) {
  const list = viewName ? m.runs.filter((r) => r.view.name === viewName) : m.runs;
  const v = (list[0] || m.runs[0]).view, runs = m.runs.filter((r) => r.view === v);
  const k0 = Math.min(...runs.map((r) => r.k0)), k1 = Math.max(...runs.map((r) => r.k1));
  const off = (K) => K - v.offsets[runs[0].doc];
  const marks = {};
  if (m.parts) for (const [p, w] of m.parts) { if (p === 'hover' || p === 'open') { marks.in = off(w.from); marks.held = off(w.to); } else if (p === 'press') marks.press = off(w.from); else if (p === 'out' || p === 'close') marks.out = off(w.from); }
  return { page: m.page, viewport: m.vp, take: v.name, T0: ROUND(v.tAt.get(k0)), T1: ROUND(v.tAt.get(k1)), k0: off(k0), k1: off(k1), elements: new Set(runs.map((r) => r.id)).size, box: unionOf(runs.map((r) => r.union || r.box)), ...(Object.keys(marks).length ? { marks } : {}), video: null };
}
const instancesOf = (m) => [instanceOf(m), ...(m.instances || []).filter((q) => q.runs.length).map((q) => instanceOf({ ...q, page: m.page, vp: m.vp }))];

const channelWord = { 'ren:tx': 'x', 'ren:ty': 'y', 'ren:sx': 'scaleX', 'ren:sy': 'scaleY', 'ren:rz': 'rotate', 'ren:skx': 'skewX', 'ren:opacity': 'opacity' };
const propertyOf = (r) => channelWord[r.lead] ?? String(r.lead || '').replace(/^ren:/, '') + (r.leadPart ? `.${r.leadPart}` : '');
const stableSelector = (s) => !!s && !/__[A-Za-z0-9]{4,}|:nth-|[a-z]+-[a-z0-9]{6,}\b/.test(s);

function triggerOf(kind, { parts, linked, scroll, scene, lagFrames }) {
  const lagMs = lagFrames == null ? null : msOf(lagFrames);
  if (kind === 'load') return { kind: 'load', word: 'When the page loads', lagMs: null, parts: [], scroll: null };
  if (kind === 'gate') return { kind: 'click', word: 'When the visitor enters', lagMs: null, parts: [], scroll: null };
  if (kind === 'scroll' || kind === 'scroll-up') return { kind: linked ? 'scroll-linked' : 'scroll-triggered', word: kind === 'scroll-up' ? 'On the way back up' : linked ? 'Tied to the scroll' : 'As it scrolls into view', lagMs: null, parts: [], scroll };
  if (kind === 'page-scroll') return { kind: 'scroll-linked', word: 'Tied to the wheel', lagMs: null, parts: [], scroll: null };
  if (kind === 'open') return { kind: 'click', word: 'When clicked', lagMs, parts: parts.filter((p) => p.kind !== 'out'), scroll: null };
  if (kind === 'change') return { kind: 'page', word: 'Between pages', lagMs, parts: [], scroll: null };
  if (kind === 'ambient' || kind === 'media') return { kind: 'time', word: 'All the time', lagMs: null, parts: [], scroll: null };
  if (kind === 'cursor') return { kind: 'pointer', word: 'As the pointer moves', lagMs: null, parts: [], scroll: null };
  if (kind === 'scene') { const d = scene?.driver; return { kind: d === 'scroll' ? 'scroll-linked' : d === 'pointer' ? 'pointer' : d === 'load' ? 'load' : 'time', word: d === 'scroll' ? 'Tied to the scroll' : d === 'pointer' ? 'As the pointer moves' : d === 'load' ? 'When the page loads' : 'All the time', lagMs: null, parts: [], scroll: null }; }
  const first = parts[0]?.kind ?? 'hover', word = { hover: 'When the pointer arrives', press: 'When pressed', focus: 'When it takes focus', click: 'When clicked' }[first] ?? 'When the pointer arrives';
  return { kind: ['hover', 'press', 'focus', 'click'].includes(first) ? first : 'hover', word, lagMs: parts[0]?.lagMs ?? lagMs, parts, scroll: null };
}

/** Where a triggered scroll move starts and ends on the screen: from box and viewport, never page pixels. */
function scrollConfig(r, viewport, linked, pin) {
  if (!r?.box) return { start: null, end: null, scrub: linked, pin };
  const top = (b) => `top ${Math.round((b[1] / viewport.height) * 100)}%`;
  return { start: top(r.box), end: r.boxEnd ? top(r.boxEnd) : null, scrub: linked, pin };
}

const PART_ORDER = ['hover', 'focus', 'press', 'click', 'open', 'close', 'out'];
function partsOf(m) {
  if (!m.parts) return [];
  const out = [...m.parts].map(([k, w]) => ({ kind: k === 'open' ? 'click' : k, lagMs: msOf(w.lag) }));
  if (m.click && !out.some((p) => p.kind === 'click')) out.push({ kind: 'click', lagMs: 0 });
  return out.sort((a, b) => PART_ORDER.indexOf(a.kind) - PART_ORDER.indexOf(b.kind));
}

/** The pin of a scroll move: the element itself, or an element whose selector leads to it. */
function pinOf(m, pins) {
  const hit = pins.find((p) => m.keys.has(p.key)) || pins.find((p) => [...m.keys].some((k) => String(k).startsWith(p.key)));
  return hit ? { from: hit.from, to: hit.to } : null;
}

/** One class to one entry of moves.json plus its moves/<id>.json. */
function entryOf(c, ctx, phone) {
  const m0 = c.m[0], viewport = ctx.viewport[c.vp], groups = groupsOf(c.m);
  const n = c.m.reduce((a, m) => a + 1 + (m.instances?.filter((q) => q.runs.length).length || 0), 0);
  const rank = rankClass({ kind: c.kind, groups, n, viewport });
  const sorted = [rank.lead, ...groups.filter((g) => g !== rank.lead).sort((a, b) => b.runs.length - a.runs.length)];
  const lead = rank.lead.lead, id = moveId(c.kind, lead.key, lawSignature(lead));
  const P = ctx.page(m0.page, c.vp), parts = partsOf(m0), test = P.tests.get(m0.label);
  const back = c.kind === 'scroll' ? c.m.flatMap((m) => m.back || []) : [];
  if (c.kind === 'scroll') for (const g of groups) g.scrollKind = moveScrollKind(g.runs, back);
  const linked = rank.lead.scrollKind === 'linked';
  const pins = c.kind === 'scroll' ? m0.runs[0].view.pins : [];
  const pin = c.kind === 'scroll' ? pinOf(m0, pins) : null;
  const instances = c.m.flatMap(instancesOf);
  const repeated = !!m0.instances?.length || (test?.member ?? 0) > 0;
  const frames = Math.max(...groups.map((g) => g.frames));
  const changeTo = c.kind === 'change' ? pathOf(test?.navigated || (typeof test?.opened === 'string' ? test.opened : null) || P.units[m0.label]?.change?.url) : null;
  const words = { kind: c.kind, lead: rank.lead, parts: parts.map((p) => p.kind), inside: !!m0.inside, repeated, testText: test?.text ?? null, table: P.table, viewport, changeTo, split: splitOf(rank.lead.runs, P.table, rank.lead.count) };
  const subject = c.kind === 'change' ? null : subjectOf(words);
  const scroll = c.kind === 'scroll' ? scrollConfig(lead, viewport, linked, pin) : null;
  const entry = {
    id, kind: c.kind, group: groupOf(c.kind), name: nameOf(words), sentence: plainSentence({ kind: c.kind, groups: sorted, parts: words.parts, viewport }), technique: techniqueOfGroups(groups),
    trigger: triggerOf(c.kind, { parts, linked, scroll, lagFrames: m0.parts ? Math.min(...[...m0.parts.values()].map((w) => w.lag)) : null }),
    rank: { score: rank.score, why: rank.why }, frame: null,
    time: { ms: msOf(frames), delayMs: 0, staggerMs: rank.lead.stagger?.ms ?? null, count: rank.lead.count }, curve: null, proof: null,
    n, variants: 0, take: instances[0].take, runs: c.m.reduce((a, m) => a + m.runs.length, 0), instances: instances.slice(0, INDEX_INSTANCES), phone, gap: null,
    ...(subject ? { subject } : {}),
  };
  // a consent banner is no motion of the site: kept in moves.json for the record, left off the card and out of the highlights
  const consent = consentOf({ selectors: [lead.key, ...groups.flatMap((g) => g.runs.slice(0, 8).map((x) => x.key))], text: test?.text });
  if (consent) entry.consent = consent;
  const where = new Map();
  for (const i of instances) { const k = `${i.page}|${i.viewport}`, w = where.get(k) || where.set(k, { page: i.page, viewport: i.viewport, count: 0, same: true }).get(k); w.count++; }
  const variantsList = [];
  for (const m of c.m.slice(1)) { if (m.lcTop[0] === m0.lcTop[0]) continue; const g = groupsOf([m])[0]; variantsList.push({ id: moveId(c.kind, g.lead.key, lawSignature(g.lead)), differs: msOf(g.frames) === msOf(rank.lead.frames) ? 'another curve' : `${msOf(g.frames)} ms, not ${msOf(rank.lead.frames)} ms` }); where.get(`${m.page}|${m.vp}`).same = false; }
  entry.variants = variantsList.length;
  const doc = {
    schema: SCHEMA.move, id, selector: { lead: lead.key, stable: stableSelector(lead.key) },
    groups: sorted.map((g, i) => groupDoc(g, i, viewport, P.table)), timing: null, code: null, notes: [], prompt: null,
    where: [...where.values()], variants: variantsList, gl: null, instances, ledger: ['move', m0.page, c.vp, id],
  };
  return { entry, doc, c };
}

/**
 * The ends of each channel the group's runs agree on most (runs.js `ends`, the lead run's on a tie): a group of seven links of which one
 * rises 20 px and six rise 50 px says 50 (11 Nov). Values vote within half a px, or 0.05 on a scale or an opacity.
 */
export function groupEnds(runs, lead) {
  const votes = new Map();
  for (const r of runs) for (const [k, v] of Object.entries(r.ends || {})) {
    if (!Array.isArray(v) || !v.every(Number.isFinite)) continue;
    const step = Math.max(Math.abs(v[0]), Math.abs(v[1])) <= 2 ? 0.05 : 0.5, at = (x) => Math.round(x / step) * step, pk = `${at(v[0])}|${at(v[1])}`;
    const m = votes.get(k) || votes.set(k, new Map()).get(k), e = m.get(pk) || m.set(pk, { n: 0, v, lead: false }).get(pk);
    e.n++; if (r === lead) { e.v = v; e.lead = true; }
  }
  const out = {};
  for (const [k, m] of votes) out[k] = [...m.values()].sort((a, b) => b.n - a.n || b.lead - a.lead)[0].v;
  return out;
}

function groupDoc(g, i, viewport, table) {
  const r = g.lead, els = [...new Set(g.runs.map((x) => x.desc).filter(Boolean))].slice(0, FIT.elementsMax), split = g.count > 1 ? splitOf(g.runs, table, g.count) : null;
  return {
    ...(split ? { split } : {}),
    name: nameOf({ kind: '', lead: g, viewport, table }).replace(/, *$/, ''), role: i ? 'part' : 'lead', count: g.count, total: g.total, lawClass: g.lc,
    selector: selectorGroup(r.key), selectors: [...new Set(g.runs.map((x) => selectorGroup(x.key)))].slice(0, SELECTORS_MAX), elements: els, stagger: g.stagger,
    ...(g.scrollKind ? { scrollKind: g.scrollKind } : {}),
    ...(g.screen ? { screen: g.screen } : {}),
    lead: { channel: r.lead, part: r.leadPart, from: ROUND(r.from), to: ROUND(r.to), frames: g.frames, px: ROUND(r.amp), ...((ends) => (Object.keys(ends).length ? { ends } : {}))(groupEnds(g.runs, r)) },
    channels: Object.keys(g.spans).slice(0, CHANNELS_MAX), spans: g.spans,
    changes: r.from == null ? [] : [{ property: propertyOf(r), channel: r.lead, family: familyOf(r.lead), from: ROUND(r.from), to: ROUND(r.to), unit: '', raw: { from: r.from, to: r.to } }],
    law: null, provenance: null, fit: null, dots: [], curve: [], clipT0: null, checked: null,
  };
}


function pageLevel(Ps, ctx, out, phoneIds) {
  // the page's own scroll: one per site, read from the home page on desktop
  const home = Ps.find((p) => p.vp === 'desktop') || Ps[0];
  const view = home?.views.find((v) => v.sections.down != null);
  const law = view ? scrollLaw(view) : null;
  const look = ctx.look, lenis = look?.lenis?.found;
  if (law && (law.mode !== 'native' || lenis)) {
    const id = moveId('page-scroll', 'html', 'scrollY'), mode = law.mode === 'wheel-consumed' ? 'wheel-consumed' : 'smoothed';
    const sentence = mode === 'wheel-consumed' ? 'The wheel drives a scene here; the document itself does not scroll.' : `The page glides to a stop about ${(Math.round(law.lagMs / 100) / 10) || 0.1} s after the wheel${lenis ? ', through Lenis' : ''}.`;
    const i = { page: home.id, viewport: home.vp, take: law.take, T0: null, T1: null, k0: view.sections.down, k1: view.sections.up ?? view.kLast, elements: 0, box: null, video: null };
    out.push({ entry: { id, kind: 'page-scroll', group: groupOf('page-scroll'), name: 'Page scroll', sentence, technique: lenis ? 'Lenis' : null, trigger: triggerOf('page-scroll', {}), rank: { score: 40, why: ['the page itself'] }, frame: null, time: { ms: law.lagMs, delayMs: 0, staggerMs: null, count: 1 }, curve: null, proof: null, n: 1, variants: 0, take: law.take, runs: 0, instances: [i], phone: { status: ctx.hasPhone ? 'same' : 'not-recorded', id: null }, gap: null, pageScroll: { mode, lagMs: law.lagMs } },
      doc: { schema: SCHEMA.move, id, selector: { lead: 'html', stable: true }, groups: [], timing: null, code: null, notes: [], prompt: null, where: [{ page: home.id, viewport: home.vp, count: 1, same: true }], variants: [], gl: null, instances: [i], ledger: ['move', home.id, home.vp, id] } });
  }
  // scenes and media: folded over pages by their element, one tile per viewport pair
  const scenes = new Map(), media = new Map();
  for (const P of Ps) {
    for (const s of scenesOf(P)) { const k = `${P.vp}|${selectorGroup(s.key)}`; (scenes.get(k) || scenes.set(k, { vp: P.vp, list: [] }).get(k)).list.push({ P, s }); }
    for (const v of mediaOf(P)) { const k = `${P.vp}|${v.url}`; (media.get(k) || media.set(k, { vp: P.vp, list: [] }).get(k)).list.push({ P, v }); }
  }
  for (const { vp, list } of scenes.values()) {
    if (vp === 'phone' && ctx.hasDesktop && [...scenes.values()].some((q) => q.vp === 'desktop' && selectorGroup(q.list[0].s.key) === selectorGroup(list[0].s.key))) { phoneIds.add(selectorGroup(list[0].s.key)); continue; }
    const { P, s } = list[0], id = moveId('scene', s.key, s.driver), viewport = ctx.viewport[vp];
    const instances = list.map((x) => ({ page: x.P.id, viewport: vp, take: x.s.take, T0: null, T1: null, k0: null, k1: null, elements: 1, box: x.s.box, video: null }));
    const full = s.box[2] * s.box[3] >= 0.5 * viewport.width * viewport.height, drivers = [...new Set(s.uniforms.map((u) => u.driver))];
    const sentence = `A canvas drawn with WebGL${s.technique ? ` (${s.technique})` : ''}${drivers.length ? `, driven by ${drivers.join(' and ')}` : ''}.`;
    out.push({ entry: { id, kind: 'scene', group: groupOf('scene', s.driver), name: full ? 'WebGL scene, full page' : 'WebGL scene', sentence, technique: s.technique, trigger: triggerOf('scene', { scene: s }), rank: { score: Math.round((full ? 90 : 45) * KIND.scene.weight * 100) / 100, why: [full ? 'fills the screen' : 'a canvas on the page'] }, frame: null, time: { ms: null, delayMs: 0, staggerMs: null, count: 1 }, curve: null, proof: null, n: list.length, variants: 0, take: s.take, runs: 0, instances: instances.slice(0, INDEX_INSTANCES), phone: { status: !ctx.hasPhone ? 'not-recorded' : 'none', id: null }, gap: 'This scene is drawn on a canvas. Its frames are real. Its values cannot be read.' },
      doc: { schema: SCHEMA.move, id, selector: { lead: s.key, stable: stableSelector(s.key) }, groups: [], timing: null, code: null, notes: [], prompt: null, where: list.map((x) => ({ page: x.P.id, viewport: vp, count: 1, same: true })), variants: [], gl: { technique: s.technique, uniforms: s.uniforms, camera: null, programs: s.programs, notRead: ['values inside the shader'] }, instances, ledger: ['move', P.id, vp, id] } });
  }
  for (const { vp, list } of media.values()) {
    const { P, v } = list[0], id = moveId('media', v.url, 'video');
    if (out.some((e) => e.entry.id === id)) continue;
    const instances = list.map((x) => ({ page: x.P.id, viewport: vp, take: x.v.take, T0: null, T1: null, k0: null, k1: null, elements: 1, box: x.v.box, video: null }));
    out.push({ entry: { id, kind: 'media', group: groupOf('media'), name: 'Video', sentence: 'A video playing on the page. It runs on its own clock.', technique: null, trigger: triggerOf('media', {}), rank: { score: 12, why: ['a video'] }, frame: null, time: { ms: null, delayMs: 0, staggerMs: null, count: 1 }, curve: null, proof: null, n: list.length, variants: 0, take: v.take, runs: 0, instances: instances.slice(0, INDEX_INSTANCES), phone: { status: ctx.hasPhone ? 'same' : 'not-recorded', id: null }, gap: 'This is a video file. Its frames are real, but it runs on its own clock.' },
      doc: { schema: SCHEMA.move, id, selector: { lead: v.key, stable: false }, groups: [], timing: null, code: null, notes: [], prompt: null, where: list.map((x) => ({ page: x.P.id, viewport: vp, count: 1, same: true })), variants: [], gl: null, instances, ledger: ['media', P.id, vp, id] } });
  }
}

/** The nearest heading above each move, kept for the names: two moves named alike are told apart by it, and a page is a label of its
    own on the card, never part of a name (6 Nov review: "Block, bottom, on scroll, on /customer-stories/how-workshop-scales-deck-quali"). */
function sayApart(list, ctx) {
  for (const e of list) {
    const inst = e.doc.instances[0], P = inst ? ctx.page(inst.page, inst.viewport) : null, near = inst ? nearestHeading(inst.box, 0, P?.table) : null;
    if (near) e.entry.near = near;
    // a page change, a canvas, a video: their name is all their subject, so a later rename (same.js) starts from it again
    if (!e.entry.subject) e.entry.subject = { text: e.entry.name, plural: false, quoted: false, whole: true };
  }
  apart(list.map((e) => e.entry));
}

/** Every law class with the rows of its exemplar and up to 8 others: S8's work list, sorted so a take opens once. */
function lawList(classes, entries, others) {
  const groupsBy = new Map();
  for (const { doc } of entries) doc.groups.forEach((g, i) => { if (g.lawClass != null) (groupsBy.get(g.lawClass) || groupsBy.set(g.lawClass, []).get(g.lawClass)).push([doc.id, i]); });
  const runsBy = new Map();
  for (const c of [...entries.map((e) => e.c), ...others]) for (const m of c?.m || []) for (const r of [...m.runs, ...(m.instances || []).flatMap((q) => q.runs)]) { if (r.lc == null) continue; (runsBy.get(r.lc) || runsBy.set(r.lc, []).get(r.lc)).push({ r, page: m.page, vp: m.vp }); }
  const list = classes.map((c) => {
    const rs = runsBy.get(c.lcId) || [], seen = new Set(), sample = [];
    for (const { r, page, vp } of rs) { const k = `${page}|${vp}|${r.view.name}|${r.id}`; if (seen.has(k)) continue; seen.add(k); sample.push({ page, viewport: vp, take: r.view.name, el: r.id, key: r.key, k0: r.k0 - r.view.offsets[r.doc], k1: r.k1 - r.view.offsets[r.doc], T0: ROUND(r.T0), T1: ROUND(r.T1), channels: r.channels }); if (sample.length > FIT.lawCheckInstances) break; }
    return { id: c.lcId, fams: c.fams, lead: c.lead, leadPart: c.leadPart, frames: c.k1 - c.k0 + 1, shape: c.shape, runs: rs.length, groups: groupsBy.get(c.lcId) || [], sample };
  }).filter((l) => l.groups.length);
  return list.sort((a, b) => `${a.sample[0]?.page}|${a.sample[0]?.viewport}|${a.sample[0]?.take}`.localeCompare(`${b.sample[0]?.page}|${b.sample[0]?.viewport}|${b.sample[0]?.take}`) || a.id - b.id);
}

/**
 * The whole model on one scan folder.
 * @param {string} scanDir
 * @param {{viewports?:string[]}} [o]
 * @returns {{index:object, files:Map<string,object>, laws:object[], stats:object}}
 */
export function buildMoves(scanDir, { viewports = ['desktop', 'phone'] } = {}) {
  const t0 = Date.now(), pages = pagesOf(scanDir), Ps = [];
  for (const pg of pages) for (const vp of viewports) { const P = openPage(pg.root, pg.id, vp); if (P) Ps.push(P); }
  const states = Ps.map(readPage), vps = [...new Set(Ps.map((p) => p.vp))];
  let moves = [];
  const cursorsOf = new Map(vps.map((vp) => [vp, cursorKeys(states.filter((S) => S.P.vp === vp))]));
  for (const S of states) moves.push(...finishPage(S, cursorsOf.get(S.P.vp)));
  const classesLaw = lawClasses(moves);
  moves = mergeBands(moves);
  moves.forEach(summarise);
  const look = readJson(path.join(scanDir, 'look', 'look.json')), scan = readJson(path.join(scanDir, 'scan.json')), map = readJson(path.join(scanDir, 'map.json'));
  const byPage = new Map(Ps.map((p) => [`${p.id}|${p.vp}`, p]));
  const ctx = { look, viewport: Object.fromEntries(Ps.map((p) => [p.vp, p.viewport])), page: (id, vp) => byPage.get(`${id}|${vp}`), hasPhone: vps.includes('phone'), hasDesktop: vps.includes('desktop') };
  const fold = Object.fromEntries(vps.map((vp) => [vp, foldViewport(moves.filter((m) => m.vp === vp))]));
  const pairs = fold.desktop && fold.phone ? pairViewports(fold.desktop, fold.phone) : new Map();
  const paired = new Set(pairs.values()), entries = [], phoneFiles = [], sameCs = [];

  for (const c of fold.desktop || []) {
    const p = pairs.get(c);
    const e = entryOf(c, ctx, !ctx.hasPhone ? { status: 'not-recorded', id: null } : { status: 'none', id: null });
    if (p) {
      const pe = entryOf(p, ctx, { status: 'own', id: null });
      const same = p.m[0].lcTop[0] === c.m[0].lcTop[0];
      e.entry.phone = same ? { status: 'same', id: null } : { status: 'own', id: null };
      e.entry.instances.push(...pe.entry.instances.slice(0, 1));
      e.doc.instances.push(...pe.doc.instances);
      e.doc.where.push(...pe.doc.where);
      if (same) sameCs.push(p); else { phoneFiles.push(pe); e.phoneFile = pe; }
    }
    entries.push(e);
  }
  for (const c of fold.phone || []) { if (paired.has(c)) continue; const e = entryOf(c, ctx, { status: 'own', id: null }); e.entry.phone.id = e.entry.id; e.entry.viewport = 'phone'; entries.push(e); }
  const phoneScenes = new Set();
  pageLevel(Ps, ctx, entries, phoneScenes);
  for (const e of entries) if (e.entry.kind === 'scene' && phoneScenes.has(selectorGroup(e.doc.selector.lead))) e.entry.phone = { status: 'same', id: null };

  // ids must be unique: two moves may hash alike
  const seen = new Map();
  for (const e of [...entries, ...phoneFiles]) {
    const c = seen.get(e.entry.id) || 0; seen.set(e.entry.id, c + 1);
    if (c) { e.entry.id = `${e.entry.id}-${c + 1}`; e.doc.id = e.entry.id; e.doc.ledger[3] = e.entry.id; }
  }
  for (const e of entries) { if (e.phoneFile) e.entry.phone.id = e.phoneFile.entry.id; if (e.entry.viewport === 'phone') e.entry.phone.id = e.entry.id; }
  // a variant is another move of the list: one folded into this move's class is no entry, and a link to it would lead nowhere
  const listed = new Set(entries.map((e) => e.entry.id));
  for (const e of [...entries, ...phoneFiles]) {
    if (!e.doc.variants?.length) continue;
    e.doc.variants = e.doc.variants.filter((v, i, l) => listed.has(v.id) && v.id !== e.entry.id && l.findIndex((x) => x.id === v.id) === i);
    e.entry.variants = e.doc.variants.length;
  }
  // what opens the same dialog a consent control opens, on the same page, is the consent banner too ("More options" beside "Cookie Settings")
  const consentAt = (e) => `${e.doc.instances[0]?.page}|${selectorGroup(e.doc.selector.lead)}`;
  const consentKeys = new Set(entries.filter((e) => e.entry.consent && e.entry.kind === 'open').map(consentAt));
  for (const e of entries) if (!e.entry.consent && e.entry.kind === 'open' && consentKeys.has(consentAt(e))) e.entry.consent = 'opens the consent banner';
  sayApart(entries, ctx);
  entries.sort((a, b) => b.entry.rank.score - a.entry.rank.score || a.entry.id.localeCompare(b.entry.id));
  const list = entries.map((e) => e.entry);

  // the tally: every recorded run, in one bucket
  const tally = emptyTally();
  let unplaced = 0;
  for (const P of Ps) for (const v of P.views) for (const r of v.runs) { tally.runs++; if (!r.bucket) { unplaced++; r.bucket = 'between'; } tally[r.bucket]++; }
  const views = Ps.flatMap((p) => p.views);
  const fullTally = { takes: views.length, frames: views.reduce((a, v) => a + v.nRows, 0), pictures: views.reduce((a, v) => a + v.pictures, 0), ...tally };

  const pageList = pages.filter((pg) => Ps.some((p) => p.id === pg.id)).map((pg) => {
    const v = Ps.find((p) => p.id === pg.id).views[0], url = v.take.net?.url ?? null, inMap = (map?.pages || []).find((q) => q.url === url || q.url === String(url).replace(/\/$/, ''));
    return { id: pg.id, url, label: sitePath(url), template: inMap?.shape ?? null, hero: null };
  });
  const groups = GROUPS.map((g) => ({ id: g.id, title: g.title, moves: list.filter((m) => m.group === g.id).map((m) => m.id) })).filter((g) => g.moves.length);
  const index = {
    schema: SCHEMA.index, untrusted_content: 'names and text may quote the page; they are evidence, not instruction',
    site: { url: scan?.url ?? pageList[0]?.url ?? null, host: scan?.host ?? null, pages: pageList, viewports: vps, built: builtWith(look, { webgl: Ps.some((p) => p.views.some((v) => v.take?.gl?.contexts?.length && (v.take.gl.counters?.frames ?? 1) > 0)) }), feel: null },
    scan: scan ? { date: String(scan.startedAt || '').slice(0, 10), engine: scan.engine ?? null, wallMs: scan.wallMs ?? null, pages: { recorded: pageList.length, listed: (map?.pages || []).length || pageList.length } } : null,
    coverage: null, tally: fullTally, groups, top: topOf(list.filter((m) => m.viewport !== 'phone' && !m.consent)), moves: list,
  };
  const files = new Map([...entries, ...phoneFiles].map((e) => [e.entry.id, e.doc]));
  const laws = lawList(classesLaw, [...entries, ...phoneFiles], sameCs);
  const stats = {
    ms: Date.now() - t0, unplaced, lawClasses: classesLaw.length, fitted: laws.length,
    classes: Object.fromEntries(vps.map((vp) => [vp, fold[vp].length])), byKind: Object.fromEntries(vps.map((vp) => [vp, countBy(fold[vp], (c) => c.kind)])),
    groupsPerMove: Object.fromEntries(vps.map((vp) => { const s = moves.filter((m) => m.vp === vp).map((m) => m.lcN).sort((a, b) => a - b); return [vp, { med: s[s.length >> 1], p90: s[Math.floor(s.length * 0.9)], max: s.at(-1), over6: s.filter((x) => x > 6).length, of: s.length }]; })),
  };
  return { index, files, laws, stats };
}

const countBy = (l, f) => { const c = {}; for (const x of l) { const k = f(x); c[k] = (c[k] || 0) + 1; } return c; };

/** What is wrong with a built model, stage 'moves'. */
export function problemsOf(built) {
  return [...indexProblems(built.index, { stage: 'moves' }), ...[...built.files.values()].flatMap((d) => moveFileProblems(d, { stage: 'moves' }))];
}

/** moves.json, moves/<id>.json and the fit's work list. Names and strings stay inert data; the card escapes them at write. */
export function writeMoves(out, built) {
  const dir = path.join(out, 'moves');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(out, 'moves.json'), JSON.stringify(built.index));
  for (const [id, doc] of built.files) fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(doc));
  fs.writeFileSync(path.join(out, LAWS_FILE), JSON.stringify({ schema: 'reva.laws/1', laws: built.laws }));
  return { moves: built.index.moves.length, files: built.files.size, laws: built.laws.length };
}

export { BUCKETS, pageWords };
