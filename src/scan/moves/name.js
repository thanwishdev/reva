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

const placeOf = (key) => (/(^|[\s>.])(header|nav|navigation|menu)\b/i.test(key) ? 'Menu' : /(^|[\s>.])footer\b/i.test(key) ? 'Footer' : null);
const CARD_TAG = /^(ARTICLE|LI|A)\b/i;
const CLOSER = { load: 'on load', gate: 'on entry', scroll: 'on scroll', 'scroll-up': 'on the way back up', ambient: 'always running', cursor: 'follows the pointer', open: 'opens', change: 'page change' };
const PART_WORD = { focus: 'focus', hover: 'hover', press: 'press', click: 'click', out: 'leave' };

const NEAR_KINDS = ['load', 'scroll', 'scroll-up', 'touch', 'open'];
const WEAK = /^(Block|Line|Word|Text|Graphic|Shape|Circle|Section|Link|List|Image$|Main area|Label)/;

/**
 * @param {{kind:string, lead:object, parts?:string[], inside?:boolean, repeated?:boolean, testText?:?string, table?:object, viewport:object, changeTo?:?string}} o
 * @returns {string}
 */
export function nameOf({ kind, lead, parts = [], inside = false, repeated = false, testText = null, table = null, viewport, changeTo = null }) {
  if (kind === 'change') return changeTo ? `Page change to ${changeTo}` : 'Page change';
  const r = lead?.lead, runs = lead?.runs || [];
  const words = fewWords(testText) || (kind === 'touch' || kind === 'open' || kind === 'load' || kind === 'scroll' ? visibleWords(runs, table) : null);
  const firstScreen = r?.box && r.box[1] < viewport.height && (r.sy0 ?? 0) < 1;
  let part;
  if (words) part = `"${words}"`;
  else if (kind === 'open' && !inside && /menu|burger|toggle|nav/i.test(r?.desc || '')) part = 'Menu';
  else if (repeated && CARD_TAG.test(r?.desc || '')) part = `${humanName(r.desc).replace(/ (link|item)$/i, '')} card`.replace(/^Link card$/, 'Card').replace(/^List item card$/, 'Card');
  else part = r ? humanName(r.desc, r.box, viewport) : 'The page';
  if (!words && inside) part = `Menu ${lower(part)}`;
  else if (!words && kind === 'load' && firstScreen && /^(Main heading|Block|Section|Text)/.test(part)) part = `Hero ${lower(part)}`.replace('Hero main heading', 'Hero headline').replace(/^Hero block.*/, 'Hero');
  else if (!words && r && placeOf(r.key) === 'Footer') part = `Footer ${lower(part)}`;
  else if (!words && r && NEAR_KINDS.includes(kind) && WEAK.test(part)) { const near = nearestHeading(r.box, r.sy0, table); if (near) part = `"${near}" section`; }
  const closer = kind === 'touch' ? (PART_WORD[parts.find((p) => p === 'hover') || parts[0]] || 'hover') : CLOSER[kind];
  return closer ? `${part}, ${closer}` : part;
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

/** The noun of a group, for a sentence: no place words, plural when the group holds several. */
function nounOf(g, viewport) {
  const n = lower(humanName(g.lead.desc, null, viewport).split(',')[0]).replace(/ block$/, ' element').replace(/^block$/, 'element');
  return g.count > 1 && !/s$/.test(n) ? `${n}s` : n;
}
/** A verb phrase agrees with its noun: "the words rise", "the word rises". */
const agree = (verb, plural) => (plural ? verb.replace(/^(\w+?)s\b/, '$1') : verb);
const clause = (g, viewport) => `the ${nounOf(g, viewport)} ${agree(verbOf(g.lead), g.count > 1)}`;

/** One plain line from runs, so a move that was never fitted still has words. S8 writes the final one (DESIGN 2.7). */
export function plainSentence({ kind, groups, parts = [], viewport }) {
  const said = [];
  for (const g of groups) { const c = clause(g, viewport); if (!said.some((x) => x.c === c)) said.push({ c, g }); if (said.length === 2) break; }
  const opener = kind === 'touch' && !parts.includes('hover') ? (parts.includes('press') || parts.includes('click') ? 'On press' : parts.includes('focus') ? 'On focus' : 'On hover') : OPENER[kind];
  const longest = Math.max(...said.map((x) => x.g.frames));
  const extra = kind === 'touch' && parts.includes('hover') && parts.includes('press') ? ' It also answers a press.' : '';
  return `${opener} ${said.map((x) => x.c).join(' and ')}, ${secs(longest)}.${extra}`;
}

/** Tonight's one rule for a technique that needs no shader: a part revealed through a clip or a mask. */
export function techniqueOfGroups(groups) {
  const g = groups.find((x) => x.runs.some((r) => r.fams.includes('clip')));
  return g ? `${lower(humanName(g.lead.desc).split(',')[0])} revealed through a mask` : null;
}
