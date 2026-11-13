// Names once the fit is done, and repeated moves folded into one pattern (6 Nov review: nearly half of a slide-tool site's top 12 was one motion,
// rise 50 px and fade in over 0.6 s, under twelve names). A fold never deletes: every move stays in moves.json with its own file; a
// move that repeats another carries `same` (the id of the one shown), and the one shown carries `uses` (how many places, on how many
// pages, which moves). Card, highlights and Find show the pattern once.
import { leadGroup, promptWithName } from '../../export/move.js';
import { clauseOf } from './intent.js';
import { composeName, doingName, nameVerb, VERB_KINDS } from './name.js';
import { topOf } from './rank.js';

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
// what a pattern of several moves is called when their subjects differ: their shared noun, or "Content" when that noun says nothing
const PLAIN_NOUNS = new Set(['element', 'text', 'list item', 'graphic', 'line', 'circle', 'figure', 'label', 'field', 'canvas']);
const NAME_TAIL = { load: ' on load', gate: ' on entry', scroll: ' on scroll', 'scroll-up': ' on the way back up' };
const PART_WORD = { focus: 'focus', hover: 'hover', press: 'press', click: 'click', out: 'leave' };

/** Two or more moves named alike: the nearest heading tells one apart, then a number on the same page. A page is never put in a
    name: the card writes it beside the name. Idempotent: it works from the name each move had before it was told apart. */
export function apart(list) {
  const by = new Map();
  // names need only differ on one screen: the card shows desktop or phone moves, never both at once
  for (const m of list) { const k = `${m.name}|${m.viewport ?? 'desktop'}`; (by.get(k) || by.set(k, []).get(k)).push(m); }
  for (const same of by.values()) {
    const name = same[0].name;
    if (same.length < 2) continue;
    same.forEach((m, i) => { if (i && m.near && !name.includes(`"${m.near}"`)) m.name = `${name} near "${m.near}"`; });
    const seen = new Map();
    for (const m of same) {
      const page = m.instances?.[0]?.page ?? '', k = `${m.name}|${page}`, c = seen.get(k) || 0; seen.set(k, c + 1);
      if (c) m.name = `${m.name} ${c + 1}`;
    }
  }
}

/** What a move is called now that the fit knows what its lead does. */
export function nameAfterFit(entry, doc) {
  const s = entry.subject; if (!s) return entry.name;
  if (s.whole) return s.text;
  const lead = doc?.groups?.length ? leadGroup(doc.groups) : null;
  return (lead && doingName(entry, lead, clauseOf)) || composeName(entry.kind, s, (entry.trigger?.parts || []).map((p) => p.kind));
}

/**
 * The key two moves share when they are the same motion: what sets them off, and their lead's law, duration, stagger and the clauses it
 * says (the same numbers the card shows). Null for a move that is no pattern: no law, nothing said, a canvas, a page change.
 */
export function motionKey(entry, doc) {
  if (entry.notMove || entry.consent || ['scene', 'media', 'page-scroll', 'change', 'cursor'].includes(entry.kind)) return null;
  const lead = doc?.groups?.length ? leadGroup(doc.groups) : null, law = lead?.law;
  if (!law || lead.layer === 'gl' || !(lead.said || []).length) return null;
  const curve = law.class === 'tween' ? law.named ?? law.declared ?? (law.bezier || []).map((x) => Math.round(x * 100) / 100).join(',') : law.class === 'map' ? law.shape ?? 'map' : law.class;
  const ms = law.class === 'map' ? 0 : Math.round((law.ms || 0) / 10) * 10;
  const parts = entry.kind === 'touch' || entry.kind === 'open' ? (entry.trigger?.parts || []).map((p) => p.kind).join(',') : '';
  const stagger = lead.stagger?.ms ? Math.round(lead.stagger.ms / 10) * 10 : 0;
  return [entry.kind, parts, entry.trigger?.kind ?? '', law.class, curve, ms, stagger, [...lead.said].sort().join('|'), entry.viewport ?? 'desktop'].join('#');
}

/** Where a move runs, from its file: places on its own screen, and the pages among them. */
function placesOf(entry, doc) {
  const vp = entry.viewport ?? 'desktop', where = (doc?.where || []).filter((w) => w.viewport === vp);
  const list = where.length ? where : (entry.instances || []).filter((i) => i.viewport === vp).map((i) => ({ page: i.page, count: 1 }));
  return { n: list.reduce((a, w) => a + (w.count || 1), 0) || 1, pages: new Set(list.map((w) => w.page)) };
}

/** The name of a pattern whose moves are called differently: "Content rises in on scroll", "\"Product\", \"Resources\" and 2 more, on hover". */
function patternName(rep, members, docs) {
  const all = [rep, ...members], subjects = all.map((m) => m.subject).filter(Boolean);
  if (new Set(all.map((m) => m.subject?.text ?? m.name)).size === 1) return null;
  const quoted = subjects.filter((s) => s.quoted).map((s) => s.text);
  if (!VERB_KINDS.has(rep.kind) && quoted.length >= 2) {
    const list = [...new Set(quoted)], shown = list.slice(0, 2).join(', '), more = list.length - 2;
    return composeName(rep.kind, { text: more > 0 ? `${shown} and ${more} more` : list.join(' and ') }, (rep.trigger?.parts || []).map((p) => p.kind));
  }
  const nouns = new Map();
  for (const s of subjects) { const n = s.noun?.many; if (n) nouns.set(n, (nouns.get(n) || 0) + 1); }
  const top = [...nouns].sort((a, b) => b[1] - a[1])[0], one = subjects.find((s) => s.noun?.many === top?.[0])?.noun?.one;
  const real = top && !PLAIN_NOUNS.has(one);
  const subject = real ? { text: cap(top[0]), plural: true } : { text: 'Content', plural: false };
  if (VERB_KINDS.has(rep.kind)) {
    // no verb a name can carry (a recording that goes and comes back): the best ranked move's own name stands for the pattern
    const lead = leadGroup(docs.get(rep.id)?.groups || []), v = lead && nameVerb(lead, clauseOf);
    return v ? `${subject.text} ${subject.plural ? v.many : v.one}${lead.law.class === 'map' || rep.trigger?.kind === 'scroll-linked' ? ' with the scroll' : NAME_TAIL[rep.kind]}` : null;
  }
  if (rep.kind === 'touch') return `${subject.text}, ${PART_WORD[(rep.trigger?.parts || [])[0]?.kind] || 'hover'}`;
  return composeName(rep.kind, subject, []);
}

/** Two patterns called alike differ in their timing: the one ranked lower says how ("Content rises in on scroll, 20 ms apart"), so
    no pattern needs a number. */
function distinct(list, docs) {
  const by = new Map();
  for (const m of list) { const k = `${m.name}|${m.viewport ?? 'desktop'}`; (by.get(k) || by.set(k, []).get(k)).push(m); }
  const timeOf = (m) => { const g = leadGroup(docs.get(m.id)?.groups || []); return { st: Math.round(g?.stagger?.ms || 0), ms: Math.round(g?.law?.ms || 0) }; };
  for (const same of by.values()) {
    if (same.length < 2) continue;
    const first = timeOf(same[0]);
    for (const m of same.slice(1)) {
      const t = timeOf(m);
      if (t.st !== first.st) m.name += t.st ? `, ${t.st} ms apart` : ', all at once';
      else if (t.ms !== first.ms && t.ms > 0) m.name += `, ${Math.round(t.ms / 10) / 100} s`;
    }
  }
}

const USED_BOOST = 0.15, USED_BOOST_MAX = 1.5;
/**
 * Names, then patterns, on the whole site, after the fit and again after the GSAP join. Changes `index` in place: names, `same`,
 * `uses`, the rank of a pattern (used in many places weighs more, at most ×1.5), the list order and the highlights.
 * @param {object} index  moves.json
 * @param {Map<string, object>} docs  move id -> moves/<id>.json
 * @returns {{patterns:number, folded:number}}
 */
export function siteMoves(index, docs) {
  for (const m of index.moves) { delete m.same; delete m.uses; if (m.own) { m.name = m.own; delete m.own; } m.name = nameAfterFit(m, docs.get(m.id)); }
  apart(index.moves);
  const by = new Map();
  for (const m of index.moves) { const k = motionKey(m, docs.get(m.id)); if (k) (by.get(k) || by.set(k, []).get(k)).push(m); }
  let patterns = 0, folded = 0;
  for (const list of by.values()) {
    if (list.length < 2) continue;
    // the move shown is the best ranked; its rank counts the places the pattern runs in
    const sorted = [...list].sort((a, b) => (b.rank?.score ?? 0) - (a.rank?.score ?? 0) || a.id.localeCompare(b.id)), rep = sorted[0], members = sorted.slice(1);
    let n = 0; const pages = new Set();
    for (const m of sorted) { const p = placesOf(m, docs.get(m.id)); n += p.n; for (const x of p.pages) pages.add(x); }
    for (const m of members) m.same = rep.id;
    rep.uses = { n, pages: pages.size, moves: sorted.map((m) => m.id) };
    const name = patternName(rep, members, docs);
    if (name && name !== rep.name) { rep.own = rep.name; rep.name = name; }
    const boost = Math.min(USED_BOOST_MAX, 1 + USED_BOOST * Math.log2(sorted.length));
    rep.rank = { ...rep.rank, score: Math.round((rep.rank?.score ?? 0) * boost * 100) / 100, why: [...new Set([...(rep.rank?.why || []), `used in ${n} places`])] };
    patterns++; folded += members.length;
  }
  distinct(index.moves.filter((m) => !m.same), docs);
  apart(index.moves.filter((m) => !m.same));
  index.moves.sort((a, b) => b.rank.score - a.rank.score || a.id.localeCompare(b.id));
  const order = new Map(index.moves.map((m, i) => [m.id, i]));
  for (const g of index.groups || []) g.moves.sort((a, b) => order.get(a) - order.get(b));
  index.top = topOf(index.moves.filter((m) => m.viewport !== 'phone' && m.rank?.top !== false && !m.consent && !m.same));
  return { patterns, folded };
}

/**
 * Each move file's prompt says the name the list shows. The fit writes a prompt before siteMoves names the move, and the GSAP join
 * names it again (11 Nov: 49 `Name:` lines differed from the list). A phone file says the name of the move it is the phone of.
 * `save(doc)` writes a changed file (json and js). Returns how many changed.
 */
export function renamePrompts(index, docs, save = () => {}) {
  let n = 0;
  const fix = (id, name) => {
    const d = docs.get(id); if (!d?.prompt) return;
    const p = promptWithName(d.prompt, name);
    if (p === d.prompt) return;
    d.prompt = p; save(d); n++;
  };
  for (const m of index.moves || []) {
    fix(m.id, m.name);
    if (m.phone?.id && m.phone.id !== m.id) fix(m.phone.id, m.name);
  }
  return n;
}
