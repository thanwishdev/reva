// Declared values into moves (DESIGN 3.6, 4.2): what the site's own GSAP and Lottie files say, joined to what the rows measured. Runs after
// the fit (S8), since a declared law is only taken when it holds on the recorded frames: a tween on the right element and channel whose
// duration and ease reproduce the frames within LAW_CHECK. A law it cannot check (elastic, custom, a keyframes tween) stays measured,
// with the declared words beside it in `group.gsap`. The fit's `moves[].proof` is rebuilt here for each move whose lead group changed.
// Joined by element and channel, never by time: a hover tween plays many times from one birth, a timeline's child starts when it starts.
//   const r = joinDeclared(scanDir, { log });   // { gsap:{found, version, tweens}, groups, moves, lottie, morphs }
import fs from 'node:fs';
import path from 'node:path';
import { readJsonl, resolveSeriesFile } from '../../record/series-io.js';
import { PROP_CHANNELS, gsapEase } from '../../corpus/gsap.js';
import { NAMED, gsapNameFor } from '../../export/eases.js';
import { easeGap, glSpecOf, followGroup, leadGroup } from '../../export/move.js';
import { round } from '../../export/curves.js';
import { LOTTIE_FILE, lottieList } from '../lottie.js';
import { moveScript } from './fit.js';
import { closeMove } from './close.js';
import { rerank } from './rank.js';
import { renamePrompts, siteMoves } from './same.js';
import { systemOf } from './system.js';
import { FIT, GAPS, MODEL, indexProblems, moveFileProblems, selectorGroup } from './contract.js';
import { LAWS_FILE } from './index.js';

const DT = 1000 / 60, SHIFT_FRAMES = 3, LENGTH_SLACK = 1 + MODEL.lengthTolerance;
const CSS_CHANNELS = { color: 'color', backgroundColor: 'bg', fill: 'fill', stroke: 'stroke', clipPath: 'clipPath', filter: 'filter', borderRadius: 'radius', strokeDashoffset: 'dash', backgroundPosition: 'bgPos', fontWeight: 'wght' };
export const WORDS = Object.freeze({ lottie: "From the site's Lottie file", morph: GAPS.morph });

/** Channels a GSAP property drives, as the rows name them. */
export function channelsOf(prop) {
  if (prop.startsWith('--')) return [`ren:${prop}`];
  if (PROP_CHANNELS[prop]) return PROP_CHANNELS[prop].map((c) => `ren:${c}`);
  if (CSS_CHANNELS[prop]) return [`ren:${CSS_CHANNELS[prop]}`];
  return prop === 'translate' || prop === 'rotate' || prop === 'scale' ? [`ren:${prop}`] : [];
}
/** The name by which the code knows a GSAP ease, and its exact curve; null when the tool has no exact form. */
export function easeOfName(name) {
  const e = gsapEase(name); if (!e.fn) return null;
  if (e.name === 'none') return { key: 'linear', named: 'none', fn: (p) => p };
  const key = Object.keys(NAMED).find((k) => gsapNameFor(k) === e.name);
  return key ? { key, named: e.name, fn: e.fn } : null;
}

// ---------------------------------------------------------------- what the takes hold
const takeDir = (out, s) => path.join(out, ...(s.page && s.page !== 'home' ? ['pages', s.page] : []), 'takes', s.viewport, s.take);
/** The `declared` series of one take: its GSAP log and what was read at rest. Only that file is opened, never the rows. */
export function readDeclared(dir) {
  let t; try { t = JSON.parse(fs.readFileSync(path.join(dir, 'take.json'), 'utf8')); } catch { return { tweens: [], rest: null, lottie: [], version: null }; }
  const file = t.series?.declared?.file;
  if (!file) return { tweens: [], rest: null, lottie: [], version: null };
  const out = { tweens: [], rest: null, lottie: [], version: null };
  for (const row of readJsonl(resolveSeriesFile(path.join(dir, file)))) {
    if (row.label === 'gsap-births') { out.tweens.push(...(row.gsap || [])); out.version ??= row.version ?? null; }
    else if (row.label === 'gsap-rest') { out.rest = row.rest ?? null; out.lottie = row.lottie || []; out.version ??= row.rest?.version ?? null; }
  }
  return out;
}

// ---------------------------------------------------------------- does a tween explain a group
/** The tweens of this element that drive this channel. */
export function tweensFor(tweens, el, channel) {
  const id = Number(el), out = [];
  for (const t of tweens) { if (!t.ids?.includes(id) || t.keyframes || !(t.dur > 0)) continue; if (Object.keys(t.props || {}).some((p) => channelsOf(p).includes(channel))) out.push(t); }
  return out;
}
/** Worst gap of a declared curve on recorded progress, with a few frames of play at the start: the rows see a tween a frame or so late. */
export function gapOf(fn, dots, ms) {
  let best = Infinity;
  for (let f = -SHIFT_FRAMES; f <= SHIFT_FRAMES; f += 0.5) { const shifted = dots.map(([x, p]) => [x + f * DT, p]); best = Math.min(best, easeGap(fn, shifted, ms)); }
  return best;
}
/** What a time tween says of this group, or null. `recorded`: how long the run was seen to take, in ms. */
export function judge(t, dots, recorded) {
  const ms = t.dur * 1000, e = easeOfName(t.ease);
  if (t.rep !== 0 && t.rep != null) return null;
  if (recorded > ms * LENGTH_SLACK + 2 * DT) return null;   // a run may read shorter than its tween, as an ease tail goes under a pixel, never longer
  if (!e) return { checked: false, ms, ease: t.ease };
  if (!dots?.length) return null;
  const gap = gapOf(e.fn, dots, ms);
  return gap <= FIT.lawCheckShare * 100 ? { checked: true, ms, ease: e.named, key: e.key, gapPct: round(gap, 2) } : null;
}
const declaredStagger = (t) => (t.off && t.off.length > 1 ? round((t.off[1] - t.off[0]) * 1000, 1) : null);

function matchGroup(g, sample, ofTake) {
  const law = g.law; if (!law) return null;
  const channel = g.lead?.channel; if (!channel) return null;
  const list = sample.filter((s) => selectorGroup(s.key) === g.selector);
  let best = null, note = null;
  for (const s of list.length ? list : sample) {
    const tweens = tweensFor(ofTake(s).tweens, s.el, channel);
    for (const t of tweens) {
      if (t.st?.scrub) { if (law.class === 'map') return { scrub: true, t }; note ??= { t, v: { checked: false, ms: null, ease: t.ease } }; continue; }
      if (law.class === 'map') continue;
      const v = judge(t, g.dots, s.T1 - s.T0);
      if (!v) continue;
      if (!v.checked) { note ??= { t, v }; continue; }
      if (!best || v.gapPct < best.v.gapPct) best = { t, v };
    }
  }
  return best ?? note;
}
function spoken(t, v) { return { ms: v?.ms ?? round(t.dur * 1000, 1), ease: t.ease ?? null, delayMs: t.delay ? round(t.delay * 1000, 1) : 0, stagger: declaredStagger(t), ...(t.st ? { scrollTrigger: t.st } : {}), method: t.m, ...(t.rep ? { repeat: t.rep, yoyo: !!t.yoyo } : {}) }; }

/** A group the site's GSAP explains. True when its law changed. */
function applyGsap(g, hit) {
  g.gsap = spoken(hit.t, hit.v);
  if (hit.scrub) { g.law = { ...g.law, via: 'gsap' }; g.provenance = 'declared'; return true; }
  if (!hit.v.checked) return false;
  g.law = { class: 'tween', ms: hit.v.ms, delayMs: g.law.delayMs ?? 0, key: hit.v.key, named: hit.v.ease, via: 'gsap', fittedMs: g.law.ms ?? null, ...(g.law.runnerUp ? { runnerUp: g.law.runnerUp } : {}) };
  g.provenance = 'declared';
  const fn = easeOfName(hit.v.ease).fn, n = FIT.curveMax - 1;
  g.curve = Array.from({ length: n + 1 }, (_, i) => [round((hit.v.ms * i) / n, 2), round(fn(i / n), 4)]);
  if (g.gsap.stagger && g.stagger) g.stagger = { ...g.stagger, ms: g.gsap.stagger, declared: true };
  return true;
}

// ---------------------------------------------------------------- one move, again
const leadOf = (groups) => leadGroup(groups);
/** Words and code of a move whose laws changed: the same steps as the end of the fit, from what the fit kept. */
function rebuild(entry, doc) {
  const lead = (entry.kind === 'cursor' ? followGroup(doc.groups) : null) ?? leadOf(doc.groups); if (!lead?.law) return;
  const scroll = entry.trigger?.scroll?.start ? entry.trigger.scroll : null;
  const src = [lead, ...doc.groups.filter((g) => g !== lead)], groups = src.map((g) => ({ ...g, pts: g.dots }));
  const spec = { kind: entry.kind, trigger: entry.trigger, scroll, groups, name: entry.name, technique: entry.technique };
  // the same last step as the fit's (close.js); the WebGL clocks, passes and the rest of the GL spec the fit kept go back into the agent spec
  const { code, timing, prompt, proofLine: line } = closeMove(entry, spec, { frames: entry.proof?.frames ?? null, gl: glSpecOf(doc) });
  src.forEach((g, i) => { if (groups[i].recipe) g.recipe = groups[i].recipe; else delete g.recipe; });   // closeMove wrote them on the copies
  doc.timing = timing; doc.code = code; doc.notes = [...code.notes, ...(doc.notes || []).filter((n) => !code.notes.includes(n) && n === WORDS.morph)];
  doc.prompt = prompt;
  if (line) doc.proofLine = line; else delete doc.proofLine;
}
/** A morph or SVG attribute has a channel for its run, and no value CSS or GSAP could be given: it stays out of the code. */
function dropSvgChanges(doc) {
  let hit = false;
  for (const g of doc.groups) {
    const keep = (g.changes || []).filter((c) => !(c.channels?.[0] ?? c.channel ?? '').startsWith('ren:--svg-') && !String(c.property).startsWith('--svg-'));
    if (keep.length !== (g.changes || []).length) { g.changes = keep; hit = true; }
  }
  if (hit && !doc.notes?.includes(WORDS.morph)) doc.notes = [...(doc.notes || []), WORDS.morph];
  return hit;
}

// ---------------------------------------------------------------- Lottie
/** Files loaded by exactly one element: { selector, file }. Anything else is only listed for the site. */
function lottieElements(takes, files) {
  const byUrl = new Map(files.flatMap((f) => [[f.url, f], [f.url.split(/[?#]/)[0], f]])), seen = new Map();
  for (const d of takes) for (const x of d.lottie) { const f = byUrl.get(x.url) ?? byUrl.get(x.url.split(/[?#]/)[0]); if (!f || !x.selector) continue; if (!seen.has(f)) seen.set(f, new Set()); seen.get(f).add(x.selector); }
  return [...seen].filter(([, s]) => s.size === 1).map(([file, s]) => ({ file, selector: selectorGroup([...s][0]) }));
}
function applyLottie(entry, doc, links) {
  const inside = (sel) => links.find((l) => sel === l.selector || sel.startsWith(`${l.selector} `));
  const hit = inside(selectorGroup(doc.selector?.lead ?? '')) ?? doc.groups.map((g) => inside(g.selector ?? '')).find(Boolean);
  if (!hit) return false;
  const a = hit.file.animations[0];
  doc.lottie = { url: hit.file.url, id: a.id, ms: a.ms, fr: a.fr, w: a.w, h: a.h, layers: a.layerCount };
  entry.technique ??= 'A Lottie file';
  entry.proof = { ...(entry.proof || {}), source: 'declared', via: 'lottie', word: WORDS.lottie };
  entry.time = { ...entry.time, ms: Math.round(a.ms) };
  if (entry.gap === GAPS.noLaw) entry.gap = null;
  return true;
}

const write = (file, text) => { const tmp = `${file}.${process.pid}.tmp`; fs.writeFileSync(tmp, text); fs.renameSync(tmp, file); };
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

/**
 * After S8, before S9. Reads moves.json, moves/*.json, moves-laws.json, each take's `declared` series and lottie.json, and writes
 * moves.json and the changed moves back. No browser, no fit. A scan with nothing declared comes out unchanged.
 * @param {string} out  scan folder
 * @returns {{gsap:{found:boolean, version:string|null, tweens:number, takes:number}, groups:number, noted:number, moves:number, lottie:number, morphs:number, problems:string[]}}
 */
export function joinDeclared(out, { log = () => {} } = {}) {
  const index = JSON.parse(fs.readFileSync(path.join(out, 'moves.json'), 'utf8'));
  const laws = (readJson(path.join(out, LAWS_FILE))?.laws || []).filter((l) => l.sample?.length);
  const cache = new Map(), ofTake = (s) => { const d = takeDir(out, s); if (!cache.has(d)) cache.set(d, readDeclared(d)); return cache.get(d); };
  const sampleOf = new Map(laws.map((l) => [l.id, l.sample]));
  for (const l of laws) for (const s of l.sample) ofTake(s);
  for (const m of index.moves) for (const i of m.instances || []) if (i.take && i.page && i.viewport) ofTake(i);
  for (const p of index.site?.pages || []) for (const viewport of index.site?.viewports || []) ofTake({ page: p.id, viewport, take: 'arrive' });   // the read at rest and the Lottie elements
  const takes = [...cache.values()], version = takes.find((d) => d.version)?.version ?? null, tweens = takes.reduce((a, d) => a + d.tweens.length, 0);
  const lottie = readJson(path.join(out, LOTTIE_FILE)), links = lottieElements(takes, lottie?.files || []);
  const stats = { gsap: { found: !!version, version, tweens, takes: takes.filter((d) => d.tweens.length).length }, groups: 0, noted: 0, moves: 0, lottie: 0, morphs: 0, problems: [] };

  const docs = new Map();
  for (const entry of index.moves) {
    const file = path.join(out, 'moves', `${entry.id}.json`), doc = readJson(file);
    if (!doc?.groups) continue;
    docs.set(entry.id, doc);
    let laws0 = false, noted = false;
    for (const g of doc.groups) {
      const sample = sampleOf.get(g.lawClass); if (!sample || !g.law) continue;
      const hit = matchGroup(g, sample, ofTake); if (!hit) continue;
      if (applyGsap(g, hit)) { laws0 = true; stats.groups++; } else { noted = true; stats.noted++; }
    }
    const lead = leadOf(doc.groups), scrollT = lead?.gsap?.scrollTrigger;
    if (scrollT && entry.trigger?.scroll && typeof scrollT.start === 'string') entry.trigger.scroll = { ...entry.trigger.scroll, start: scrollT.start, ...(typeof scrollT.end === 'string' ? { end: scrollT.end } : {}), scrub: scrollT.scrub ?? entry.trigger.scroll.scrub, declared: true };
    const morph = dropSvgChanges(doc); if (morph) stats.morphs++;
    if (laws0 || morph) rebuild(entry, doc);
    if (morph && lead && !lead.changes?.length) entry.gap = WORDS.morph;
    if (links.length && applyLottie(entry, doc, links)) stats.lottie++;
    if (laws0 || noted || morph || doc.lottie) {
      stats.moves++;
      write(file, JSON.stringify(doc));
      write(path.join(out, 'moves', `${entry.id}.js`), moveScript(entry.id, doc));
      stats.problems.push(...moveFileProblems(doc, { stage: 'fit' }));
    }
  }
  if (version) {
    const built = (index.site.built ||= []), at = built.findIndex((b) => b.name === 'GSAP'), one = { name: 'GSAP', version, via: 'read' };
    if (at < 0) built.unshift(one); else built[at] = one;
  }
  if (lottie?.files?.length) index.site.lottie = lottieList(lottie);
  if (stats.moves) {
    rerank(index);   // a law now read from GSAP weighs as declared
    siteMoves(index, docs);   // and may now name, fold and set the system otherwise
    index.site.system = systemOf(index, docs, index.site.feel);
    // and each prompt says the name the list shows, a phone file the name of its move
    for (const m of index.moves) { const id = m.phone?.id; if (id && id !== m.id && !docs.has(id)) { const d = readJson(path.join(out, 'moves', `${id}.json`)); if (d) docs.set(id, d); } }
    renamePrompts(index, docs, (d) => { write(path.join(out, 'moves', `${d.id}.json`), JSON.stringify(d)); write(path.join(out, 'moves', `${d.id}.js`), moveScript(d.id, d)); });
  }
  write(path.join(out, 'moves.json'), JSON.stringify(index));
  stats.problems.push(...indexProblems(index, { stage: 'fit' }));
  log(`join: ${stats.groups} groups from GSAP${version ? ` ${version}` : ''}, ${stats.moves} moves changed, ${stats.lottie} from Lottie files`);
  return stats;
}

