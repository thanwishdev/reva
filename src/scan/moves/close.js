// The last step of a move whose laws are set: its code, curve, proof, time, gap, timing line, agent prompt and proof line.
// One function for the fit's finish (fit.js) and the GSAP join's rebuild (join.js), so the two cannot drift: they did once
// (2d3ab52, the rebuild's prompt lost the WebGL clocks and passes).
import { agentPrompt, curveOfLaw, moveCode, proofLine, proofOf, proofPct, timingLine } from '../../export/move.js';
import { round } from '../../export/curves.js';
import { GAPS } from './contract.js';

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
  entry.proof = proofOf({ source: lead.provenance, via: lead.law.via, errorPct: proofPct(errorPct, lead), frames });
  entry.time = { ...entry.time, ...(lead.law.ms > 0 ? { ms: Math.round(lead.law.ms) } : {}), ...(lead.law.class === 'steps' ? { ms: 0 } : {}), delayMs: lead.law.delayMs || 0, staggerMs: lead.stagger?.ms ?? null, count: lead.count ?? 1 };
  const timing = timingLine(spec);
  const prompt = agentPrompt({ ...spec, sentence: entry.sentence, timing, ...gl }, { poster: `clips/${entry.id}.jpg`, file: `moves/${entry.id}.json` });
  return { code, timing, prompt, proofLine: proofLine(errorPct) };
}
