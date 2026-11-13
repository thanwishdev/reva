// A name and a plain sentence for a move (DESIGN 2.7). Part plus trigger, in the words of the library groups.
// Order of a name: the element's visible words if they are 1-5 words, role plus place, class-name words last.
// Page words are untrusted: stored, shown inert, never followed. `humanName` is a port of the card's function of that name, since the
// card's lives in the browser. Its rules stay the same; only the viewport is passed in.
const NAMEWORD = { ln: 'line', btn: 'button', hdr: 'header', img: 'image', txt: 'text', desc: 'description', lbl: 'label', ttl: 'title', nav: 'navigation', bg: 'background', cta: 'call to action' };
const GENERIC = /^(el|elem|element|item|box|block|wrap|wrapper|inner|outer|container|content|contents|panel|root|main|layer|sampled|active|visible|animate|animated|reveal|inview|in-view)$/i;
const TAGNOUN = { path: 'Line', line: 'Line', circle: 'Circle', ellipse: 'Circle', rect: 'Shape', polygon: 'Shape', g: 'Graphic', svg: 'Graphic', ul: 'List', ol: 'List', li: 'List item', section: 'Section', header: 'Header', footer: 'Footer', main: 'Main area', span: 'Text', a: 'Link', canvas: 'Canvas', video: 'Video' };
const UTILITY = /^(w|h|p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|gap|flex|grid|col|row|text|bg|font|leading|tracking|border|rounded|shadow|opacity|z|top|left|right|bottom|inset|min|max|items|justify|self|overflow|relative|absolute|fixed|sticky|inline|hidden|transition|duration|ease|d)(-|$)/;
const noiseClass = (c) => /^(undefined|null|nan)$/i.test(c) || /^(?=.*\d)(?=.*[A-Z])(?=.*[a-z]).{8,}$/.test(c) || /^(hide|show|sc|css|framer|emotion|jsx|svelte|astro|chakra|mui|wp|elementor|ant|tw)-/i.test(c) || /^[a-z]{1,3}[A-Z0-9][A-Za-z0-9]{4,}$/.test(c) || /^\d/.test(c) || UTILITY.test(c) || (c.length < 3 && !NAMEWORD[c.toLowerCase()]);
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** A person's word for an element, from its descriptor. */
export function humanName(desc, box = null, viewport = { width: 1440, height: 900 }) {
  const m = /^([A-Za-z0-9]+)(.*)$/.exec(desc || '');
  const tag = (m ? m[1] : '').toLowerCase();
  const classes = ((m && m[2]) || '').split(/[.#]/).filter(Boolean).map((c) => c.replace(/^js[-_]/i, '').replace(/^[A-Za-z0-9]{5,7}_/, '').replace(/__(?:[A-Za-z0-9]{4,}|[A-Za-z0-9_-]{5})$/, ''));
  const clean = [...new Set(classes.filter((c) => !noiseClass(c)))];
  const spec = clean.find((c) => !GENERIC.test(c)), gen = clean.find((c) => GENERIC.test(c) && !/^(sampled|active|visible|animate|animated|reveal|inview|in-view)$/i.test(c));
  const wordsOf = (c) => (c ? c.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_]+/g, ' ').toLowerCase().split(' ').filter(Boolean).slice(0, 3).map((w) => NAMEWORD[w] || w) : []);
  const words = wordsOf(spec), genw = wordsOf(gen);
  if (tag === 'h1') return 'Main heading';
  const withNoun = (n) => cap([...words.filter((w, i) => i < words.length - 1 || w !== n), n].join(' '));
  if (/^h[2-6]$/.test(tag)) return withNoun('heading');
  if (tag === 'p') return withNoun('paragraph');
  if (tag === 'nav') return words.includes('sidebar') ? 'Sidebar navigation' : 'Navigation';
  if (tag === 'button') return withNoun('button');
  if (tag === 'img') return withNoun('image');
  if (words.length) return cap(words.join(' ') + (genw.length ? ' ' + genw.join(' ') : ''));
  if (genw.length) return cap(genw.join(' '));
  if (TAGNOUN[tag]) return TAGNOUN[tag];
  if (!box) return `${cap(tag || 'element')} block`;
  const cx = (box[0] + box[2] / 2) / viewport.width, cy = (box[1] + box[3] / 2) / viewport.height;
  const pos = [cy < 0.34 ? 'top' : cy > 0.66 ? 'bottom' : '', cx < 0.34 ? 'left' : cx > 0.66 ? 'right' : ''].filter(Boolean).join(' ');
  return `Block, ${pos || 'centre'}`;
}

/** Page words made safe to store: one line, no control characters. */
export function pageWords(s, max = 60) {
  // eslint-disable-next-line no-control-regex
  return String(s ?? '').replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
const fewWords = (s) => { const t = undoubled(pageWords(s)); const n = t ? t.split(' ').length : 0; return n >= 1 && n <= 5 && /[\p{L}\p{N}]/u.test(t) ? t : null; };

/** A text roll holds its words twice, the copy that replaces them: "Index Index" reads as "Index". */
function undoubled(t) {
  const w = String(t).split(' ');
  if (w.length % 2 === 0 && w.slice(0, w.length / 2).join(' ').toLowerCase() === w.slice(w.length / 2).join(' ').toLowerCase()) return w.slice(0, w.length / 2).join(' ');
  return t;
}

/** Visible words of a group's elements, in document order, from the table of the page at rest. */
export function visibleWords(runs, table) {
  if (!table?.rows) return null;
  const keys = new Set(runs.map((r) => r.key)), parts = [];
  for (const r of table.rows) if (r[7] && keys.has(r[1])) parts.push(r[7]);
  return parts.length ? fewWords(undoubled(pageWords(parts.join(' '), 120))) : null;
}

/** The words of a heading: its own text, or the text of the rows inside its box, since split headings hold their words in spans. */
function headingWords(rows, i) {
  const h = rows[i];
  if (h[7]) return h[7];
  const parts = [];
  for (let j = i + 1; j < rows.length && parts.length < 12; j++) { const r = rows[j]; if (r[3] < h[3] - 1 || r[3] > h[3] + h[5] + 1 || r[2] < h[2] - 1 || r[2] > h[2] + h[4] + 1) break; if (r[7]) parts.push(r[7]); }
  return parts.join(' ');
}

/** The nearest heading above a box, from the table: a word of place when two moves would read alike. */
export function nearestHeading(box, sy, table) {
  if (!table?.rows || !box) return null;
  const y = box[1] + (sy || 0);
  let best = null;
  table.rows.forEach((r, i) => { if (/^h[1-6]$/.test(r[0]) && r[3] <= y && (!best || r[3] > table.rows[best.i][3])) { const w = fewWords(headingWords(table.rows, i)); if (w) best = { i, w }; } });
  return best ? best.w : null;
}

/**
 * How a group's text was cut up to move it: one span per letter, word or line of a heading or paragraph, read from the table's own
 * text of each element (a slide-tool site's hero: 20 one-letter spans under the h1, so letters, not words). Null when the group is no split text.
 * @returns {{unit:'letter'|'word'|'line', n:number, in:'heading'|'paragraph'|'text'}|null}
 */
export function splitOf(runs, table, count = null) {
  if (!table?.rows || !runs?.length) return null;
  const keys = new Set(runs.map((r) => r.key)), texts = [];
  for (const r of table.rows) if (keys.has(r[1]) && r[7] && String(r[7]).trim()) texts.push(String(r[7]).trim());
  if (texts.length < 2 || texts.length < 0.8 * keys.size) return null;
  const host = /^(h[1-6]|p)\b/i.exec(runs[0].key || '')?.[1]?.toLowerCase(), tag = /^([a-z0-9]+)/i.exec(runs[0].desc || '')?.[1]?.toLowerCase();
  const letters = texts.every((t) => [...t].length === 1), words = texts.every((t) => !/\s/.test(t));
  if (!letters && !words && !host) return null;          // a list of links is no split text
  if (!host && tag !== 'span' && tag !== 'div') return null;
  return { unit: letters ? 'letter' : words ? 'word' : 'line', n: count ?? keys.size, in: host === 'p' ? 'paragraph' : host ? 'heading' : 'text' };
}

// a person's noun for what a group moves, in the singular and the plural, so no sentence ever guesses a plural ("block, bottom lefts")
const TAG_NOUN = { a: ['link', 'links'], li: ['list item', 'list items'], img: ['image', 'images'], picture: ['image', 'images'], video: ['video', 'videos'], p: ['paragraph', 'paragraphs'], button: ['button', 'buttons'], svg: ['graphic', 'graphics'], path: ['line', 'lines'], line: ['line', 'lines'], circle: ['circle', 'circles'], article: ['card', 'cards'], figure: ['figure', 'figures'], h1: ['heading', 'headings'], h2: ['heading', 'headings'], h3: ['heading', 'headings'], h4: ['heading', 'headings'], h5: ['heading', 'headings'], h6: ['heading', 'headings'], canvas: ['canvas', 'canvases'], input: ['field', 'fields'], label: ['label', 'labels'], span: ['text', 'pieces of text'] };
/**
 * The noun of a group, both numbers: its split text, its own name when that is a real word, its tag's noun, else "element".
 * @param {{name?:string, elements?:string[], split?:object|null, count?:number}} g  a group of a move file
 * @returns {{one:string, many:string}}
 */
export function groupNoun(g) {
  if (g?.split) return { one: g.split.unit, many: `${g.split.unit}s` };
  const tag = /^([a-z0-9]+)/i.exec((g?.elements || [])[0] || '')?.[1]?.toLowerCase(), name = String(g?.name || '').split(',')[0].trim();
  const t = TAG_NOUN[tag];
  // a real word of the element's own: its plural from a list of known nouns or its tag's ("read more link" -> "read more links"), else
  // counted as elements; "Block" and "Div block" say nothing, so the tag's noun stands in
  if (name && !/^(Block|Element|Main area)$/.test(name) && !/^[A-Za-z0-9]+ block$/.test(name) && !/^(Hero|Footer)\b/.test(name)) {
    const one = lower(name), last = one.split(' ').pop(), head = one.slice(0, one.length - last.length);
    const many = PLURAL[last] ? `${head}${PLURAL[last]}` : t && one.endsWith(t[0]) ? `${one.slice(0, -t[0].length)}${t[1]}` : `${one} elements`;
    return { one, many };
  }
  return t ? { one: t[0], many: t[1] } : { one: 'element', many: 'elements' };
}
const PLURAL = Object.fromEntries(['word', 'letter', 'line', 'image', 'photo', 'picture', 'label', 'card', 'item', 'link', 'menu', 'button', 'icon', 'heading', 'paragraph', 'logo', 'title', 'testimonial', 'arrow', 'dot', 'slide', 'tab', 'tile', 'panel', 'shape', 'circle', 'graphic', 'video', 'section', 'avatar', 'badge', 'chip', 'tag', 'quote', 'number', 'stat', 'field', 'figure', 'caption', 'thumbnail', 'background', 'overlay', 'cursor', 'marker', 'bar', 'column', 'row', 'block'].map((w) => [w, `${w}s`]).concat([['text', 'pieces of text'], ['list item', 'list items'], ['box', 'boxes'], ['glass', 'glasses']]));
/** The subject of a clause about a group: "the main heading", "20 letters of the heading", "7 elements". Agreement follows `count`. */
export function subjectOfGroup(g) {
  const n = g?.count || 1, w = groupNoun(g);
  if (n > 1) return g.split ? `${n} ${w.many} of the ${g.split.in}` : `${n} ${w.many}`;
  return `the ${w.one}`;
}

const placeOf = (key) => (/(^|[\s>.])(header|nav|navigation|menu)\b/i.test(key) ? 'Menu' : /(^|[\s>.])footer\b/i.test(key) ? 'Footer' : null);
const CARD_TAG = /^(ARTICLE|LI|A)\b/i;
const CLOSER = { load: 'on load', gate: 'on entry', scroll: 'on scroll', 'scroll-up': 'on the way back up', ambient: 'always running', cursor: 'follows the pointer', open: 'opens', change: 'page change' };
const PART_WORD = { focus: 'focus', hover: 'hover', press: 'press', click: 'click', out: 'leave' };

const NEAR_KINDS = ['load', 'scroll', 'scroll-up', 'touch', 'open'];
const WEAK = /^(Block|Line|Word|Text|Graphic|Shape|Circle|Section|Link|List|Image$|Main area|Label)/;

/**
 * What a move's name is about, before the fit says what it does: the control's or the element's own words, a role, the hero, the menu,
 * the footer, or the section under the nearest heading. `plural` says how a verb after it agrees, so no name guesses a plural, and
 * `noun` is the plain word a merged pattern of several moves can say (src/scan/moves/same.js).
 * @param {{kind:string, lead:object, inside?:boolean, repeated?:boolean, testText?:?string, table?:object, viewport:object, split?:object|null}} o
 * @returns {{text:string, plural:boolean, quoted:boolean, noun:{one:string, many:string}}}
 */
export function subjectOf({ kind, lead, inside = false, repeated = false, testText = null, table = null, viewport, split = null }) {
  const r = lead?.lead, runs = lead?.runs || [], count = lead?.count || 1;
  const words = fewWords(testText) || (kind === 'touch' || kind === 'open' || kind === 'load' || kind === 'scroll' ? visibleWords(runs, table) : null);
  const firstScreen = r?.box && r.box[1] < viewport.height && (r.sy0 ?? 0) < 1;
  const noun = groupNoun({ name: r ? humanName(r.desc) : '', elements: r ? [r.desc] : [], split });
  if (words) return { text: `"${words}"`, plural: false, quoted: true, noun };
  let part, plural = false;
  // split text moves as one heading: "Hero headline", not "Hero text" (its letters are the recipe's business)
  if (split && split.in !== 'text') part = /^h1\b/i.test(r?.key || '') ? 'Main heading' : split.in === 'paragraph' ? 'Paragraph' : 'Heading';
  else if (kind === 'open' && !inside && /menu|burger|toggle|nav/i.test(r?.desc || '')) part = 'Menu';
  else if (repeated && CARD_TAG.test(r?.desc || '')) part = `${humanName(r.desc).replace(/ (link|item)$/i, '')} card`.replace(/^Link card$/, 'Card').replace(/^List item card$/, 'Card');
  else part = r ? humanName(r.desc, r.box, viewport) : 'The page';
  if (inside) part = `Menu ${lower(part)}`;
  else if (kind === 'load' && firstScreen && /^(Main heading|Heading|Block|Section|Text)/.test(part)) part = `Hero ${lower(part)}`.replace('Hero main heading', 'Hero headline').replace(/^Hero block.*/, 'Hero');
  else if (r && placeOf(r.key) === 'Footer') part = `Footer ${lower(part)}`;
  else if (r && NEAR_KINDS.includes(kind) && WEAK.test(part)) {
    const near = nearestHeading(r.box, r.sy0, table);
    // several alike elements under a heading are its items: "\"OUR WORK\" items", never "Block, bottoms"
    if (near && count > 1 && !split) { part = `"${near}" ${noun.one === 'element' ? 'items' : noun.many}`; plural = true; }
    else if (near) part = `"${near}" section`;
  }
  return { text: part, plural, quoted: false, noun };
}

/**
 * @param {{kind:string, lead:object, parts?:string[], inside?:boolean, repeated?:boolean, testText?:?string, table?:object, viewport:object, changeTo?:?string, split?:object|null}} o
 * @returns {string}
 */
export function nameOf(o) {
  const { kind, parts = [], changeTo = null } = o;
  if (kind === 'change') return changeTo ? `Page change to ${changeTo}` : 'Page change';
  return composeName(kind, subjectOf(o), parts);
}
/** A name from its subject and what sets the move off: "\"Product\", hover", "Menu, opens". A whole-name subject is the name. */
export function composeName(kind, subject, parts = []) {
  if (subject?.whole) return subject.text;
  const part = subject?.text || 'The page';
  const closer = kind === 'touch' ? (PART_WORD[parts.find((p) => p === 'hover') || parts[0]] || 'hover') : CLOSER[kind];
  return closer ? `${part}, ${closer}` : part;
}

// what the lead's first visible change makes of a name, one verb a person says, both numbers: "rise in" / "rises in"
const NAME_VERB = [
  [/^(rise|drop)s? [\d.]+ (px|%)$/, (m) => [`${m[1]} in`, `${m[1]}s in`]],
  [/^slides? (left|right) [\d.]+ (px|%)$/, () => ['slide in', 'slides in']],
  [/^scales? up/, (m, c) => (c.from != null && c.from < 0.05 ? ['scale in', 'scales in'] : ['grow', 'grows'])],
  [/^scales? down/, () => ['shrink', 'shrinks']],
  [/^turns? /, () => ['turn', 'turns']],
  [/^wipes?( |$)/, () => ['wipe in', 'wipes in']],
  [/^draws?$/, () => ['draw on', 'draws on']],
  [/^fades? in$/, () => ['fade in', 'fades in']],
  [/^fades? out$/, () => ['fade out', 'fades out']],
  [/^blurs?$/, () => ['come into focus', 'comes into focus']],
  [/^changes? colour$/, () => ['change colour', 'changes colour']],
];
const FAMILY_ORDER = ['move', 'scale', 'rotate', 'clip', 'dash', 'fade', 'filter', 'colour'];
const NAME_TAIL = { load: ' on load', gate: ' on entry', scroll: ' on scroll', 'scroll-up': ' on the way back up' };
/** Moves whose name says what they do once the fit knows it: they arrive, on load or on scroll. */
export const VERB_KINDS = new Set(Object.keys(NAME_TAIL));
/**
 * The verb of a lead group for a name, or null when its first change says nothing a name can carry (a recording that goes and comes
 * back, a CSS variable). `clause` is clauseOf from intent.js, passed in so this module needs no fit code.
 * @returns {{one:string, many:string}|null}
 */
export function nameVerb(group, clause) {
  const law = group?.law; if (!law || !['tween', 'spring', 'map'].includes(law.class)) return null;
  const changes = (group.changes || []).filter((c) => c.peak == null && !c.back);
  for (const fam of FAMILY_ORDER) for (const c of changes) {
    if (c.family !== fam) continue;
    const said = clause(c, { screen: group.screen }); if (!said) continue;
    for (const [re, f] of NAME_VERB) { const m = re.exec(said); if (m) { const [many, one] = f(m, c); return { one, many }; } }
  }
  return null;
}
/**
 * A name that says what the move does: "\"OUR WORK\" items rise in on scroll", "Hero headline rises in on load". Tied to the scroll it
 * says "with the scroll". Null keeps the name the move has.
 */
export function doingName(entry, lead, clause) {
  if (!VERB_KINDS.has(entry.kind) || !entry.subject?.text) return null;
  const v = nameVerb(lead, clause); if (!v) return null;
  const tail = lead.law.class === 'map' || entry.trigger?.kind === 'scroll-linked' ? ' with the scroll' : NAME_TAIL[entry.kind];
  return `${entry.subject.text} ${entry.subject.plural ? v.many : v.one}${tail}`;
}

const RISE_MIN_PX = 2, MAX_SAID_PCT = 300;
/** What a group does, in a verb phrase, from its lead run. */
function verbOf(r) {
  if (!r) return 'moves';
  const d = r.from != null && r.to != null ? r.to - r.from : null;
  if (r.lead === 'ren:opacity') return d != null && d < 0 ? 'fades out' : 'fades in';
  if (/ren:(sx|sy|scale)/.test(r.lead)) {
    if (d == null) return 'changes size';
    const whole = Math.abs(r.from) < 0.05 || Math.abs(r.to) < 0.05, p = whole ? 0 : Math.round(Math.abs(d / r.from) * 100);
    return (d >= 0 ? (whole ? 'scales in' : 'scales up') : whole ? 'scales away' : 'scales down') + (p >= 1 && p <= MAX_SAID_PCT ? ` ${p} %` : '');
  }
  if (r.lead === 'ren:ty' || (r.lead === 'ren:translate' && r.leadPart === 'y')) return d == null ? 'slides' : d < -RISE_MIN_PX ? 'rises' : d > RISE_MIN_PX ? 'drops' : 'shifts';
  if (r.lead === 'ren:tx' || (r.lead === 'ren:translate' && r.leadPart === 'x')) return 'slides sideways';
  if (r.fams.includes('rotate')) return 'turns';
  if (r.fams.includes('colour')) return 'changes colour';
  if (r.fams.includes('clip')) return 'wipes in';
  if (r.fams.includes('filter')) return 'changes its filter';
  if (r.fams.includes('font')) return 'changes weight';
  if (r.fams.includes('text')) return r.lead === 'ren:text' ? 'counts' : 'swaps its letters';   // a number in a text counts; letters scramble or swap
  if (r.fams.includes('bgpos')) return 'slides its background';
  if (r.fams.includes('radius')) return 'changes its corners';
  if (r.fams.includes('dash')) return 'draws its line';
  if (r.fams.includes('var')) return 'shifts a CSS value';
  if (r.boxOnly) return 'changes size';
  return 'moves';
}
const OPENER = { load: 'On load', gate: 'On entry', scroll: 'While scrolling', 'scroll-up': 'On the way back up', touch: 'On hover', open: 'When clicked', change: 'Between pages', ambient: 'All the time', cursor: 'As the pointer moves' };
const secs = (frames) => `${(Math.round((frames / 60) * 10) / 10).toFixed(1).replace(/\.0$/, '')} s`;
const lower = (s) => s.charAt(0).toLowerCase() + s.slice(1);

/** A verb phrase agrees with its noun: "the words rise", "the word rises". */
const agree = (verb, plural) => (plural ? verb.replace(/^(\w+?)s\b/, '$1').replace(/\bits\b/g, 'their') : verb);
/** "7 elements rise", "the main heading fades in": a counted plural or one named element, never a guessed plural. */
const clause = (g, viewport) => { const many = g.count > 1, w = groupNoun({ name: humanName(g.lead.desc, null, viewport), elements: [g.lead.desc] }); return `${many ? `${g.count} ${w.many}` : `the ${w.one}`} ${agree(verbOf(g.lead), many)}`; };

/** One plain line from runs, so a move that was never fitted still has words. S8 writes the final one (DESIGN 2.7). */
export function plainSentence({ kind, groups, parts = [], viewport }) {
  const said = [];
  for (const g of groups) { const c = clause(g, viewport); if (!said.some((x) => x.c === c)) said.push({ c, g }); if (said.length === 2) break; }
  const opener = kind === 'touch' && !parts.includes('hover') ? (parts.includes('press') || parts.includes('click') ? 'On press' : parts.includes('focus') ? 'On focus' : 'On hover') : OPENER[kind];
  const longest = Math.max(...said.map((x) => x.g.frames));
  const extra = kind === 'touch' && parts.includes('hover') && parts.includes('press') ? ' It also answers a press.' : '';
  // under a tenth of a second rounds to "0 s" (11 Nov, U4): a change in a frame or two is said to happen at once
  return `${opener}${/^\d/.test(said[0].c) ? ',' : ''} ${said.map((x) => x.c).join(' and ')}${longest < 3 ? ', at once' : `, ${secs(longest)}`}.${extra}`;
}

/** Tonight's one rule for a technique that needs no shader: a part revealed through a clip or a mask. */
export function techniqueOfGroups(groups) {
  const g = groups.find((x) => x.runs.some((r) => r.fams.includes('clip')));
  return g ? `${lower(humanName(g.lead.desc).split(',')[0])} revealed through a mask` : null;
}
