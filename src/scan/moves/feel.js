// How a site moves, in numbers and two sentences (DESIGN 4.2 `site.feel`). One vote per move class, so a list of forty cards does not
// outvote the hero. A move that has no law does not vote, and every share says what it was a share of.
import { round } from '../../export/curves.js';

const quantile = (s, q) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
const roundTo = (x, step) => Math.round(x / step) * step;
const secs = (ms) => `${round(ms / 1000, 1)}`;

/** The curve word of a law: a family a person can compare across moves, or null. */
export function curveFamily(law) {
  if (!law) return null;
  if (law.class === 'spring') return 'spring';
  if (law.class !== 'tween') return null;
  if (law.named) return law.named;
  return law.bezier ? `cubic-bezier(${law.bezier.join(', ')})` : law.declared ?? null;
}
const FEEL_WORDS = [[/\.out$|^ease-out$|^easeOut/, 'an ease-out'], [/\.inOut$|^ease-in-out$|^easeInOut/, 'an ease-in-out'], [/\.in$|^ease-in$|^easeIn/, 'an ease-in'], [/^spring$/, 'a spring'], [/^none$|^linear$/, 'a straight line']];
// a curve with no family word is said by its numbers: a site's own cubic-bezier is the thing to copy, "its own curve" says nothing
const easeWord = (name) => { for (const [re, w] of FEEL_WORDS) if (re.test(name)) return w; return /^cubic-bezier\([^)]*\)$/.test(name) ? name : 'its own curve'; };

/**
 * @param {{kind:string, groups:{law?:object, stagger?:{ms:number}|null}[], time?:object}[]} moves  fitted moves, lead group first
 * @param {{scroll?:{mode:string, lagMs?:number|null}|null, smoother?:string|null}} o
 * @returns {object} site.feel
 */
export function feelOf(moves, { scroll = null, smoother = null } = {}) {
  const leads = moves.filter((m) => m.kind !== 'ambient' && m.kind !== 'media' && m.kind !== 'scene').map((m) => (m.groups || []).find((g) => g.part !== 'out' && g.part !== 'close' && g.law) ?? m.groups?.[0]).filter(Boolean);
  const timed = leads.filter((g) => (g.law?.class === 'tween' || g.law?.class === 'spring' || g.law?.class === 'keyframes') && g.law.ms > 0);
  const ms = timed.map((g) => g.law.ms).sort((a, b) => a - b);
  const duration = ms.length ? { p25: Math.round(quantile(ms, 0.25)), p50: Math.round(quantile(ms, 0.5)), p75: Math.round(quantile(ms, 0.75)), unit: 'ms', n: ms.length } : null;
  const names = new Map(); let voters = 0;
  for (const g of leads) { const c = curveFamily(g.law); if (!c) continue; voters++; names.set(c, (names.get(c) || 0) + 1); }
  const top = [...names].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))[0];
  const curve = top ? { name: top[0], share: round(top[1] / voters, 2), n: voters } : null;
  const steps = new Map(); let staggered = 0;
  for (const m of moves) for (const g of m.groups || []) if (g.stagger?.ms > 0) { staggered++; const s = roundTo(g.stagger.ms, 10) || g.stagger.ms; steps.set(s, (steps.get(s) || 0) + 1); }
  const st = [...steps].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
  const stagger = st ? { ms: st[0], share: round(st[1] / staggered, 2), n: staggered } : null;
  const scrollFeel = scroll ? { kind: scroll.mode === 'smoothed' ? 'smoothed' : scroll.mode === 'wheel-consumed' ? 'wheel-consumed' : 'native', by: smoother ?? null, lagMs: scroll.lagMs ?? null } : null;

  const sentences = [];
  if (duration && curve && duration.n >= 3) sentences.push(`Most things take ${secs(duration.p25)} to ${secs(duration.p75)} s${curve.share >= 0.25 ? ` on ${easeWord(curve.name)}` : ''}.`);
  if (stagger && stagger.n >= 2) sentences.push(`Lists arrive one after another, about ${stagger.ms} ms apart.`);
  if (scrollFeel?.kind === 'smoothed') sentences.push(`Scrolling is smoothed${scrollFeel.by ? ` by ${scrollFeel.by}` : ''}${scrollFeel.lagMs ? `, and the page settles about ${scrollFeel.lagMs} ms after the wheel stops` : ''}.`);
  if (scrollFeel?.kind === 'wheel-consumed') sentences.push('The wheel drives a scene, and the document itself does not scroll.');
  return { duration, curve, stagger, scroll: scrollFeel, sentences };
}
