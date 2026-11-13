// The last step of a move whose laws are set: its code, curve, proof, time, gap, timing line, agent prompt and proof line.
// One function for the fit's finish (fit.js) and the GSAP join's rebuild (join.js), so the two cannot drift: they did once
// (2d3ab52, the rebuild's prompt lost the WebGL clocks and passes).
import { agentPrompt, curveOfLaw, lawName, moveCode, proofLine, proofOf, proofPct, timingLine } from '../../export/move.js';
import { round } from '../../export/curves.js';
import { GAPS } from './contract.js';
import { backOnce, clauseOf, spanOf } from './intent.js';
import { groupNoun } from './name.js';
import { isGlGroup } from './glmove.js';

const secs = (ms) => `${round(ms / 1000, ms >= 10000 ? 0 : ms < 1000 ? 2 : 1)} s`;
const listed = (l) => (l.length < 2 ? l.join('') : `${l.slice(0, -1).join(', ')} and ${l[l.length - 1]}`);
const FRAME_MS = 1000 / 60 + 0.5;
const PART_OPENER = { out: 'On leave: ', close: 'On close: ', press: 'On press: ', focus: 'On focus: ' };
/** One change of a recipe: the sentence's own clause, with the blur's size, since "blurs" alone cannot be built. */
function recipeClause(c, screen) {
  if (c.family === 'filter') {
    const a = /blur\(([\d.]+)px\)/.exec(String(c.from)), b = /blur\(([\d.]+)px\)/.exec(String(c.to));
    if (a && (!b || +b[1] < +a[1])) return `sharpens from a ${round(+a[1], 1)} px blur${b && +b[1] > 0 ? ` to ${round(+b[1], 1)} px` : ''}`;
    if (b && (!a || +a[1] < +b[1])) return `blurs to ${round(+b[1], 1)} px`;
  }
  return clauseOf(c, { screen });
}
/** How a group's time runs, in words, with the same numbers as its code. */
function howOf(law) {
  // under half a frame is no time a person sees: "over 0 s" read as broken (11 Nov, U4)
  if (['tween', 'spring', 'keyframes'].includes(law.class) && Number.isFinite(law.ms) && law.ms < 8.5) return 'at once';
  if (law.class === 'tween') return `over ${secs(law.ms)} on ${lawName(law) ?? 'its curve'}`;
  if (law.class === 'spring') return `on a spring that settles in ${secs(law.ms)}`;
  if (law.class === 'keyframes') return `replayed from the recording over ${secs(law.ms)}`;
  if (law.class === 'map') return 'tied to the scroll';
  if (law.class === 'steps') return 'at once';
  if (law.class === 'smoothing') return `following with a ${round(law.tauMs ?? law.ms / 5, 0)} ms lag`;
  return null;
}
/**
 * One line a person builds a group from (6 Nov review: "Split the heading into words (20 spans) · each word: blur 10 → 0, y 10 → 0,
 * opacity 0 → 1 · 600 ms · 50 ms apart"). The split comes first, since without it the code cannot feel the same. Null when nothing can
 * be said: a canvas layer, a group with no law or no visible change.
 * @returns {string|null}
 */
export function recipeOf(g) {
  if (!g?.law || isGlGroup(g)) return null;
  const said = [...new Set((g.changes || []).map((c) => recipeClause(c, g.screen)).filter(Boolean))].slice(0, 4);
  const how = howOf(g.law);
  if (!said.length || !how) return null;
  const n = g.count || 1, w = groupNoun(g), st = g.stagger?.ms ? `, ${round(g.stagger.ms, 0)} ms apart${g.stagger.from === 'last' ? ', the last one first' : ''}` : '';
  // under a frame is the frame grid, not a wait; under a second reads in ms, as the code writes it
  const wait = (ms) => (ms < 1000 ? `${Math.round(ms)} ms` : secs(ms));
  const after = g.delayMs > FRAME_MS ? `, ${wait(g.delayMs)} after the first part` : g.law.delayMs > FRAME_MS ? `, after a ${wait(g.law.delayMs)} wait` : '';
  const open = PART_OPENER[g.part] ?? '';
  // every clause going and coming back says the return once (11 Nov, U4); each one / each word reads as one
  const does = backOnce(said) ?? listed(said);
  if (g.split && n > 1) return `${open}Split the ${g.split.in} into ${n} ${g.split.unit} spans. Each ${g.split.unit} ${does}, ${how}${st}${after}.`;
  if (n > 1) return `${open}${n} ${w.many}, each one ${does}, ${how}${st}${after}.`;
  const subject = `the ${w.one}`;
  return `${open}${open ? subject : subject.replace(/^./, (c) => c.toUpperCase())} ${does}, ${how}${after}.`;
}

/**
 * Sets `entry.curve`, `proof`, `time` and the no-law `gap` in place; returns what the move's file carries.
 * @param {object} entry  the moves.json entry (its `sentence` is already final)
 * @param {{kind:string, trigger:object, scroll:object|null, groups:object[], name?:string, technique?:string|null}} spec  groups lead first, each with `pts`
 * @param {{frames?:number|null, gl?:object}} [o]  frames the proof counts; the WebGL part of the agent spec (glSpecOf: clocks, passes, programs, shaders, ...)
 * @returns {{code:object, timing:string, prompt:string, proofLine:string|null}}
 */
export function closeMove(entry, spec, { frames = null, gl = {} } = {}) {
  const lead = spec.groups[0];
  const code = moveCode(spec), shown = [code.errorPct.css, code.errorPct.gsap, code.errorPct.motion].filter(Number.isFinite);
  const errorPct = shown.length ? round(Math.max(...shown), 2) : null;
  // a recording says so; a law, fitted or read, never stands beside 'no simple curve fits'
  if (lead.provenance === 'sampled') entry.gap = GAPS.noLaw; else if (entry.gap === GAPS.noLaw) entry.gap = null;
  entry.curve = curveOfLaw(lead.law);
  entry.proof = proofOf({ source: lead.provenance, via: lead.law.via, errorPct: proofPct(errorPct, lead), frames, ...(lead.law.snapped ? { ease: lead.law.declared } : {}) });
  // how each part is known, so one label never speaks for parts known another way (6 Nov review: "Exact" beside a recorded part)
  const mix = {};
  for (const g of spec.groups) { if (g.layer === 'gl' || !g.law) continue; const k = g.provenance === 'declared' ? 'exact' : g.provenance === 'sampled' ? 'recorded' : g.provenance === 'fitted' ? 'measured' : null; if (k) mix[k] = (mix[k] || 0) + 1; }
  if (Object.keys(mix).length > 1) entry.proof.mix = mix; else delete entry.proof.mix;
  // the time a person reads (ZD, intent.js spanOf): of the first measured part; with none, the recording's window unless a jump
  // stretches it, and then none (the window stays as windowMs, for the rank's long-hover check only)
  // a WebGL lead keeps its own fitted clock, as the sentence says it (intent.js glLeads)
  const live = spec.groups.filter((g) => g.law && g.part !== 'out' && g.part !== 'close');
  const span = isGlGroup(lead) ? null : spanOf(live.length ? live : spec.groups), law = span?.g.law ?? lead.law;
  entry.time = { ...entry.time, ...(law.ms > 0 ? { ms: Math.round(law.ms) } : {}), ...(law.class === 'steps' ? { ms: 0 } : {}), delayMs: lead.law.delayMs || 0, staggerMs: lead.stagger?.ms ?? null, count: lead.count ?? 1 };
  delete entry.time.windowMs;
  // withheld: a stretched window; or a part tied to the scroll, whose time is the scroll's, not a duration (the window it was seen in)
  if (span?.withheld || (span && span.ms == null && law.class === 'map')) { if (entry.time.ms > 0) entry.time.windowMs = entry.time.ms; delete entry.time.ms; }
  const timedLead = span?.withheld ? { ...lead, law: { ...lead.law, ms: null } } : span && span.g !== lead ? { ...lead, law: span.g.law } : lead;
  const timing = timingLine(timedLead === lead ? spec : { ...spec, groups: [timedLead, ...spec.groups.slice(1)] });
  // one recipe line per group, on the group itself, so the card, the file and the agent read the same words
  for (const g of spec.groups) { const r = recipeOf(g); if (r) g.recipe = r; else delete g.recipe; }
  const prompt = agentPrompt({ ...spec, sentence: entry.sentence, timing, ...gl }, { poster: `clips/${entry.id}.jpg`, file: `moves/${entry.id}.json` });
  return { code, timing, prompt, proofLine: proofLine(errorPct) };
}
