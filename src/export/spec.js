// The motion spec of a whole scan: ONE Markdown file the card's finale hands over (owner 5 Nov, D2 of the launch plan).
// Two layers: the site's motion system (sentences + tokens), then the moves that show it best, each referencing the system's
// tokens where it uses the same ease or time. Motion and element behaviour only (D-GOAL-1): no fonts, no images, no page words.
// Names and sentences of moves carry quoted page text ("OUR WORK" items): the file says them without the quotes. The code
// snippets already name elements by placeholders (.your-text), never by the site's selectors.
import { SITE_PROMPT_MOVES } from './move.js';

const STRIP = (s) => String(s || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
/** A quoted run of page text, and a chain of them ("A" and "B", "C"). */
const QUOTED = /(?:["“][^"”]{0,200}["”])(?:\s*(?:,|and|or|&)\s*(?:["“][^"”]{0,200}["”]))*/g;
const cap1 = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** Page words out of a sentence: a quoted run goes, and the sentence closes over the gap. */
export function neutralText(s) {
  return STRIP(String(s || '').replace(QUOTED, ' ')).replace(/\s+([,.;:])/g, '$1').replace(/^[,;:\s]+/, '').replace(/,\s*,/g, ',').replace(/\(\s*\)/g, '').trim();
}

const KIND = { load: 'on load', gate: 'on entry', scroll: 'on scroll', 'scroll-up': 'on scroll up', 'page-scroll': 'with the page scroll', touch: 'hover', open: 'opens', change: 'page change', ambient: 'keeps moving', cursor: 'follows the pointer', media: 'plays', scene: 'WebGL scene' };
/** A move's name without page words: what is left of its own name, or its subject's noun and what sets it off. */
export function neutralName(m) {
  const n = neutralText(m?.name);
  const noun = m?.subject?.noun ? (m.subject.plural ? m.subject.noun.many : m.subject.noun.one) : null;
  // nothing but the trigger is left ('hover', 'items, on scroll'): the noun of what moves goes in front
  if (!n || /^(hover|press|click|tap|on |opens|closes|items\b|apart\b)/i.test(n)) return cap1(`${noun || 'element'}${n ? (/^(items\b)/i.test(n) ? n.replace(/^items/i, '') : `, ${n}`) : `, ${KIND[m?.kind] || m?.kind || 'moves'}`}`.replace(/\s+,/g, ',').trim());
  // a page path is the site's own address, not motion
  return cap1(n.replace(/\s+to\s+\/[\w\-/.%]*/g, ' to another page').replace(/\/[\w\-/.%]{2,}/g, 'another page'));
}

/** The values of the CSS tokens a system writes (--motion-ease, --motion-duration-arrive, ...). */
export function tokenValues(css) {
  const out = {};
  for (const m of String(css || '').matchAll(/--(motion-[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  // a token that is another (--motion-duration-arrive: var(--motion-duration-slow)) has that one's value
  for (const k of Object.keys(out)) { let v = out[k], n = 0; while (n++ < 4 && /^var\(--(motion-[\w-]+)\)$/.test(v)) v = out[/^var\(--(motion-[\w-]+)\)$/.exec(v)[1]] ?? v; out[k] = v; }
  return out;
}
const secsText = (ms) => String(Math.round((ms / 1000) * (ms < 1000 ? 100 : 10)) / (ms < 1000 ? 100 : 10));

/** The numbers the finale moves with: the site's own arrival ease, time, stagger and rise. */
export function finaleMotion(system) {
  if (!system) return null;
  const t = tokenValues(system.tokens?.css), ms = (v) => { const x = parseFloat(v); return Number.isFinite(x) ? x : null; };
  const ease = t['motion-ease'] || system.arrive?.text || system.ease?.text || null;
  if (!ease) return null;
  // fast and slow: the span most motion takes, as the summary's first sentence says it (system.js sentencesOf), ms in steps of 10
  const fast = ms(t['motion-duration-fast']) ?? system.tempo?.fast ?? null, slow = ms(t['motion-duration-slow']) ?? system.tempo?.slow ?? null;
  const range = fast != null && slow != null ? (fast === slow ? `${secsText(fast)} s` : `${secsText(fast)} to ${secsText(slow)} s`) : null;
  return { ease, pointer: t['motion-ease-pointer'] || system.pointer?.text || null, ms: ms(t['motion-duration-arrive']) ?? ms(t['motion-duration']) ?? system.tempo?.arrive ?? 600, stagger: ms(t['motion-stagger']) ?? system.stagger?.ms ?? null, rise: ms(t['motion-rise']) ?? system.shape?.rise ?? null, fast, slow, range };
}

/** The system's token that a move's ease or time is: "--motion-ease", or null. */
function tokenFor(vals, text, prefix, prefer = []) {
  if (!text) return null;
  const norm = (s) => String(s).replace(/\s+/g, '').toLowerCase();
  // the token of the move's own set first (an arrival's time is --motion-duration-arrive before --motion-duration-slow)
  const keys = [...prefer.filter((k) => k in vals), ...Object.keys(vals)];
  for (const k of keys) if (k.startsWith(prefix) && norm(vals[k]) === norm(text)) return `--${k}`;
  return null;
}
const POINTER = new Set(['touch', 'open', 'cursor']);

/** The moves of the spec: the card's highlights, then rank; a repeat once, as its pattern; never a consent banner or a non-move. */
export function specMoves(index, n = SITE_PROMPT_MOVES) {
  const byId = new Map((index.moves || []).map((m) => [m.id, m])), out = [];
  const ok = (m) => m && !m.notMove && !m.consent && !(m.same && byId.has(m.same));
  for (const id of [...(index.top || []), ...(index.moves || []).map((m) => m.id)]) {
    if (out.length >= n) break;
    const m = byId.get(id);
    if (ok(m) && !out.includes(m)) out.push(m);
  }
  return out;
}

/**
 * The whole scan's motion spec.
 * @param {object} index  moves.json
 * @param {(id:string)=>object|null} docOf  a move's own file (moves/<id>.json)
 * @param {{date?:string}} [o]
 * @returns {{file:string, md:string, lines:{id:string,name:string,timing:string}[], motion:object|null}|null}  null when there is nothing to hand over
 */
export function motionSpec(index, docOf = () => null, { date = null } = {}) {
  const site = index.site || {}, sys = site.system || null, host = STRIP(site.host || 'this site');
  const moves = specMoves(index);
  const sentences = (sys?.sentences || []).map(neutralText).filter(Boolean);
  if (!sentences.length && !moves.length) return null;
  const vals = tokenValues(sys?.tokens?.css);
  const md = [`# The motion of ${host}`, '',
    `Read by REVA from a recording of ${host}${date ? ` on ${date}` : ''}. This file holds motion and element behaviour only: no fonts, images or words of the site. Use it to give your own site this motion, not to copy the site.`];
  if (sentences.length || sys?.tokens) {
    md.push('', '## The system', '', ...sentences.map((s) => `- ${s}`));
    const t = sys?.tokens || {};
    if (t.css) md.push('', 'As CSS variables:', '', '```css', STRIP_BLOCK(t.css), '```');
    if (t.gsap) md.push('', 'As GSAP defaults:', '', '```js', STRIP_BLOCK(t.gsap), '```');
    if (t.motion) md.push('', 'As a Motion config:', '', '```js', STRIP_BLOCK(t.motion), '```');
  }
  const lines = [], json = [];
  if (moves.length) md.push('', `## The ${moves.length === 1 ? 'move' : `${moves.length} moves`} that show it best`, '', 'Each move says when it starts, its timing, its parts and its code. A token name in the timing means the move uses the system above.');
  moves.forEach((m, i) => {
    const doc = docOf(m.id) || {}, name = neutralName(m);
    const pct = /(\d+)%/.exec(m.trigger?.scroll?.start || '');
    const when = pct ? `Starts as its top reaches ${pct[1]} % of the screen.` : m.trigger?.word ? `${neutralText(m.trigger.word).replace(/\.$/, '')}.` : '';
    const ease = doc.groups?.find((g) => g.role === 'lead')?.law?.declared || m.curve?.name || null;
    const set = POINTER.has(m.kind) ? 'pointer' : 'arrive';
    const refs = [tokenFor(vals, ease, 'motion-ease', set === 'pointer' ? ['motion-ease-pointer'] : ['motion-ease']), tokenFor(vals, m.time?.ms != null ? `${m.time.ms}ms` : null, 'motion-duration', [`motion-duration-${set}`])].filter(Boolean);
    const timing = neutralText(doc.timing || '');
    lines.push({ id: m.id, name: STRIP(m.name), timing });
    md.push('', `### ${i + 1}. ${name}`, '');
    if (m.sentence) md.push(`What happens: ${neutralText(m.sentence)}`, '');
    if (when) md.push(`When: ${when}`, '');
    if (timing) md.push(`Timing: ${timing}${refs.length ? ` (the system's ${refs.join(' and ')})` : ''}.`, '');
    if (m.uses?.n > 1) md.push(`Used in ${m.uses.n} places${m.uses.pages > 1 ? ` on ${m.uses.pages} pages` : ''}.`, '');
    if (m.proof?.word) md.push(`Known by: ${neutralText(m.proof.word)}.`, '');
    const recipes = (doc.groups || []).map((g) => neutralText(g.recipe)).filter(Boolean);
    if (recipes.length) md.push('Parts:', ...recipes.map((r) => `- ${r}`), '');
    const code = doc.code?.parts?.[0]?.css || doc.code?.css || '';
    if (code) md.push('```css', STRIP_BLOCK(code), '```');
    json.push({ name, kind: m.kind, when: when || null, timing: timing || null, ...(refs.length ? { tokens: refs } : {}), ...(m.uses?.n > 1 ? { uses: m.uses.n } : {}),
      parts: (doc.groups || []).filter((g) => !g.state).map((g) => ({ count: g.count ?? 1, provenance: g.provenance ?? null, law: lawOf(g.law), ...(g.stagger ? { stagger: g.stagger } : {}), changes: (g.changes || []).map(({ property, from, to, unit }) => ({ property, from, to, unit: unit || '' })) })) });
  });
  md.push('', '## How to read the values', '', "Declared values come from the site's own code. Fitted values follow the recording. Sampled values are the recording itself, frame by frame.",
    '', 'The same spec as data:', '', '```json', JSON.stringify({ schema: 'reva.motion-spec/0', site: host, ...(date ? { date } : {}), system: { sentences, tokens: vals }, moves: json }, null, 1), '```', '');
  const safe = host.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'site';
  return { file: `${safe}-motion.md`, md: md.join('\n'), lines, motion: finaleMotion(sys) };
}
/** Control characters out of a block of code, line breaks kept. */
const STRIP_BLOCK = (s) => String(s || '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').replace(/```/g, '`​``').trim();
const lawOf = (law) => { if (!law) return null; const { points, dots, ...rest } = law; return { class: rest.class ?? null, ms: rest.ms ?? null, ...(rest.declared ? { ease: rest.declared } : rest.bezier ? { ease: `cubic-bezier(${rest.bezier.join(', ')})` } : {}), ...(rest.delayMs ? { delayMs: rest.delayMs } : {}) }; };
