// The ledger as plain sentences, for the Site page of the card (PLAN §8, DESIGN 4.5 and 5.6).
import { reasonOf } from './ledger.js';
const plural = (n, one, many = one + 's') => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
const UNIT = { move: 'Move', media: 'Video or audio', frame: 'Frame of another page', worker: 'Worker', fit: 'Curve fitting', asset: 'Saved copy of the site', request: 'A file the page asked for', page: 'Page', viewport: 'Screen', moment: 'Moment', gate: 'Entry screen', pattern: 'Interactive parts', 'open-state': 'Menus and other open states', 'page-change': 'Changes between pages', 'moving-element': 'Moving element', design: 'Design', canvas: 'Canvas' };
const VP = { desktop: 'desktop', phone: 'phone' };
const MOMENT = { load: 'page load', idle: 'at rest', 'scroll-down': 'scroll down', 'scroll-up': 'scroll back up', 'scroll-rest': 'the rest of the page' };

/**
 * A v2 ledger reads from what its rows prove; a v1 ledger keeps the old sentences until the scan writes v2 (G9 removes `legacyWords`).
 * @returns {{lead:string[], pages:string[], missing:string[], coverage?:{line:string, notOpened:string[], reasons:{class:string, words:string[]}[]}}}
 */
export function siteWords(scan, ledger) {
  const w = ledger.version === 2 ? v2Words(scan, ledger) : legacyWords(scan, ledger);
  const said = consentLine(scan.consent, (scan.pages || []).length || 1);
  if (said) w.coverage = { ...(w.coverage || {}), consent: said };
  return w;
}

const QUOTE_WORDS = 8;
/**
 * One line for the Site page: which cookie-consent banner REVA hid while it recorded, on how many pages, what it lifted that the banner
 * had put on the page, and what it pressed (a clear reject, never an accept). Null when nothing was hidden (11 Nov, audit U1: REVA
 * changed the page while it recorded, and the card must say so).
 * @param {{hidden?:object[], unlocked?:object[]}|undefined} consent  scan.json `consent` (src/scan/index.js)
 * @param {number} total  pages recorded
 * @returns {string|null}
 */
export function consentLine(consent, total = 1) {
  const all = consent?.hidden || [], layers = all.filter((h) => h.how !== 'backdrop');
  if (!layers.length) return null;
  const clean = (t) => String(t || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  const platform = clean(layers.find((h) => h.platform)?.platform);
  const words = clean(layers.find((h) => clean(h.text))?.text).split(' ').filter(Boolean);
  const quote = words.length ? ` (\u201c${words.slice(0, QUOTE_WORDS).join(' ').replace(/[.,;:]$/, '')}${words.length > QUOTE_WORDS ? '\u2026' : ''}\u201d)` : '';
  const pages = new Set(layers.map((h) => h.page)).size;
  const where = total <= 1 ? 'the page' : pages >= total ? 'every page' : `${pages} of ${total} pages`;
  const kinds = new Set((consent.unlocked || []).flatMap((u) => u.undid || []));
  const lifted = [(kinds.has('overflow') || kinds.has('fixed') || kinds.has('pointer')) && 'the scroll lock', kinds.has('inert') && 'the frozen page', all.some((h) => h.how === 'backdrop') && 'the dimmed backdrop'].filter(Boolean);
  const liftWords = lifted.length ? `, and lifted ${lifted.length > 1 ? `${lifted.slice(0, -1).join(', ')} and ${lifted.at(-1)}` : lifted[0]} it put on the page` : '';
  const rejected = [...new Set(layers.map((h) => clean(h.rejected)).filter(Boolean))];
  const pressed = rejected.length ? `it pressed only \u201c${rejected[0].slice(0, 40)}\u201d, never Accept` : 'nothing in it was pressed';
  return `While recording, REVA hid ${platform ? `the site's ${platform} cookie banner` : 'a cookie-consent banner'}${quote} on ${where}${liftWords}, so its motion is not in the moves; ${pressed}.`;
}

/** A stored ledger may say "1 requests of ..." (scans before 11 Nov); the card says it in the singular. */
const oneOf = (s) => (typeof s !== 'string' ? s : s.replace(/^1 requests of\b/, '1 request of').replace(/^1 page-idle waits ended at their\b/, '1 page-idle wait ended at its'));
const cap = (s) => s.replace(/^./, (c) => c.toUpperCase());
const pathOf = (u) => { try { const x = new URL(u); return (x.pathname + x.search) || '/'; } catch { return String(u); } };
/** The five classes of "what could not be read" (DESIGN 5.6). A row may name its own class; otherwise its status decides. */
const CLASS_OF = { refused: 'rule', blocked: 'rule', limit: 'limit', 'predicted-same': 'limit', failed: 'broke', 'not-reached': 'broke', varies: 'broke', opaque: 'impossible', partial: 'impossible' };
export const REASON_CLASSES = ['rule', 'limit', 'notBuilt', 'broke', 'impossible'];
const SKIP = new Set(['captured', 'duplicate-of', 'none']);

function v2Words(scan, ledger) {
  const rows = ledger.rows;
  const of = (u, s) => rows.filter((r) => r.unit === u && (!s || r.status === s));
  const pageRows = of('page');
  const rec = of('page', 'captured').length;
  const counts = scan.map || scan.steps?.map?.counts || {};
  const listed = Math.max(Number.isFinite(counts.listed) ? counts.listed : 0, pageRows.length);
  const notOpenedN = Math.max(0, listed - rec);
  const vps = [...new Set(of('viewport', 'captured').map((r) => VP[r.id] || r.id))];
  const where = vps.length === 2 ? 'desktop and phone' : vps[0] || 'no screen';
  const recorded = notOpenedN ? `${rec.toLocaleString('en-US')} of ${listed.toLocaleString('en-US')} pages recorded.` : rec === 1 ? 'One page recorded.' : `${plural(rec, 'page')} recorded.`;
  const notOpened = notOpenedN ? `${plural(notOpenedN, 'page')} ${notOpenedN === 1 ? 'was' : 'were'} not opened.` : null;
  const lead = [notOpened ? `${recorded} ${notOpened}` : recorded];

  const moves = new Set(of('move', 'captured').map((r) => r.id)).size;
  const partialMoves = new Set(of('move', 'partial').map((r) => r.id)).size;
  const moveBits = [];
  if (moves) moveBits.push(`${plural(moves, 'move')} recorded frame by frame`);
  if (partialMoves) moveBits.push(`${plural(partialMoves, 'more move')} seen with part of the values not read`);
  if (moveBits.length) lead.push(`${cap(where)}: ${moveBits.join(', ')}.`);
  else lead.push(`${cap(where)}: no moves recorded.`);

  const parts = of('pattern', 'captured').length, opens = of('open-state', 'captured').length, changes = of('page-change', 'captured').filter((r) => r.id !== 'all').length;
  const byShape = rows.filter((r) => r.status === 'duplicate-of' && r.proof === 'signature').length;
  const also = [
    parts && plural(parts, 'interactive part') + ' tested with hover, focus and press',
    opens && plural(opens, 'menu or other open state', 'menus and other open states'),
    changes && plural(changes, 'change between pages', 'changes between pages'),
    byShape && `${plural(byShape, 'repeat')} matched an earlier one by shape only and ${byShape === 1 ? 'was' : 'were'} not recorded again`,
  ].filter(Boolean);
  if (also.length) lead.push(`${cap(also.join(', '))}.`);

  // one line per reason, in the class a person recognises; the same reason on many units reads as one line
  const classes = new Map(REASON_CLASSES.map((c) => [c, new Map()]));
  const flat = [];
  for (const r of rows) {
    if (SKIP.has(r.status)) continue;
    if (r.unit === 'page' && r.status === 'predicted-same') continue;   // a page nobody opened is counted in the lead
    const cls = REASON_CLASSES.includes(r.class) ? r.class : CLASS_OF[r.status] || 'broke';
    const name = r.unit === 'moment' ? MOMENT[r.id] || r.id : UNIT[r.unit] || r.unit;
    // a host's folded requests add up: "249 requests: a file of another site" and "83 requests: ..." are one line
    const said = oneOf(reasonOf(r)), m = /^(\d+) requests?: (.*)$/.exec(said || '');
    const why = m ? m[2] : said || 'not recorded';
    const k = `${name}\u0001${why}`;
    const line = classes.get(cls).get(k) || { name, why, n: 0, requests: 0, vps: new Set() };
    line.n++; if (m) line.requests += +m[1]; if (r.viewport) line.vps.add(VP[r.viewport] || r.viewport);
    classes.get(cls).set(k, line);
  }
  const reasons = [];
  for (const [cls, lines] of classes) {
    const words = [...lines.values()].map((l) => {
      const at = l.vps.size === 1 ? `, ${[...l.vps][0]}` : '', head = `${cap(l.name)}${at}: `;
      return l.requests ? `${head}${plural(l.requests, 'request')}: ${l.why}` : `${head}${l.why}${l.n > 1 ? ` (${l.n.toLocaleString('en-US')} of them)` : ''}`;
    });
    if (words.length) { reasons.push({ class: cls, words }); flat.push(...words); }
  }

  const summary = impactOf(rows.filter((r) => !SKIP.has(r.status) && !(r.unit === 'page' && r.status === 'predicted-same')));
  const gone = new Set(['predicted-same', 'blocked', 'refused', 'limit', 'not-reached', 'failed']);
  const notOpenedPaths = pageRows.filter((r) => gone.has(r.status) || (r.status === 'duplicate-of' && r.proof === 'signature')).map((r) => pathOf(r.page || r.id)).slice(0, 50);
  const line = notOpened ? `Recorded ${rec.toLocaleString('en-US')} of ${listed.toLocaleString('en-US')} pages on ${where}. ${notOpened}` : `Recorded ${plural(rec, 'page')} on ${where}.`;
  // notOpenedN is the count the line says; notOpened lists at most 50 of them, so the card says both (6 Nov review: 50 beside 1,009)
  return { lead, pages: pageRows.map((p) => p.page || p.id), missing: flat, coverage: { line, notOpened: notOpenedPaths, notOpenedN, reasons, summary } };
}

/** At most this many lines say what the gaps mean; the raw reasons fold away under them (6 Nov review: 3 to 5 lines, then the log). */
export const SUMMARY_LINES = 4;
/**
 * What the ledger's gaps mean for a person reading the card, most telling first: parts the pointer could not test, menus not
 * recorded in full, page changes not recorded, what only shows as pictures, the saved copy. Counts are rows of the ledger.
 * @param {object[]} rows  ledger rows that are not captured
 * @returns {string[]}
 */
export function impactOf(rows) {
  const of = (u) => rows.filter((r) => (Array.isArray(u) ? u.includes(r.unit) : r.unit === u));
  const out = [];
  const parts = of('pattern').length;
  if (parts) out.push(`${parts === 1 ? 'One interactive part' : `${plural(parts, 'interactive part')}`} could not be tested by the pointer, so ${parts === 1 ? 'its' : 'their'} hover or press may be missing.`);
  const opens = of('open-state'), deeper = opens.filter((r) => /depth/i.test(String(reasonOf(r) || ''))).length;
  const rest = opens.length - deeper, notFull = rest === 1 ? 'one other was not recorded in full' : `${rest.toLocaleString('en-US')} others were not recorded in full`;
  if (deeper) out.push(`Menus were opened one level deep: ${deeper === 1 ? 'one of them' : `${deeper.toLocaleString('en-US')} of them`} may open further inside${rest ? `, and ${notFull}` : ''}.`);
  else if (rest) out.push(`${rest === 1 ? 'One menu or other open state was' : `${plural(rest, 'menu or other open state', 'menus and other open states')} were`} not recorded in full.`);
  const changes = of('page-change').length;
  if (changes) out.push(`${changes === 1 ? 'One change between pages was' : `${plural(changes, 'change between pages', 'changes between pages')} were`} not recorded.`);
  // what no recording can read (the class a person sees as "what no tool can read"); a video that was not stored is in the log only
  const never = (u) => of(u).filter((r) => (REASON_CLASSES.includes(r.class) ? r.class : CLASS_OF[r.status]) === 'impossible');
  const pics = [never('canvas').length || never('move').some((r) => /canvas/i.test(String(reasonOf(r) || ''))) ? 'WebGL canvases (the values inside their shaders)' : null,
    never('media').length || never('move').some((r) => /video/i.test(String(reasonOf(r) || ''))) ? 'videos (they run on their own clock)' : null, never('frame').length ? 'frames of other sites inside the page' : null].filter(Boolean);
  if (pics.length) out.push(`Seen only as pictures: ${pics.length > 1 ? `${pics.slice(0, -1).join(', ')} and ${pics[pics.length - 1]}` : pics[0]}.`);
  if (of(['request', 'asset']).length) out.push("Some files are not in the saved copy of the site: other sites' files, requests only a server can answer, and trackers REVA does not call.");
  return out.slice(0, SUMMARY_LINES);
}

function legacyWords(scan, ledger) {
  const rows = ledger.rows;
  const of = (u, s) => rows.filter((r) => r.unit === u && (!s || r.status === s));
  const lead = [];
  const pages = of('page');
  const rec = of('page', 'captured').length;
  const counts = scan.map || scan.steps?.map?.counts || {};
  const listed = Number.isFinite(counts.listed) ? counts.listed : pages.length;
  const templates = Number.isFinite(counts.templates) ? counts.templates : Number.isFinite(counts.clusters) ? counts.clusters : null;
  if (listed > rec && templates) lead.push(`${plural(rec, 'page')} of ${listed.toLocaleString('en-US')} recorded, the other ${(listed - rec).toLocaleString('en-US')} are the same ${templates === 1 ? 'template' : plural(templates, 'template')}.`);
  else lead.push(rec === 1 ? 'One page recorded.' : `${plural(rec, 'page')} recorded.`);
  const moving = new Set(of('moving-element').map((r) => r.id)).size;
  const vps = of('viewport', 'captured').map((r) => VP[r.id] || r.id);
  const moments = of('moment', 'captured').length;
  lead.push(`${vps.length === 2 ? 'Desktop and phone' : (vps[0] || 'No screen').replace(/^./, (c) => c.toUpperCase())}, ${plural(moments, 'moment')} on the virtual clock, ${plural(moving, 'moving element')} with every value kept.`);
  const parts = of('pattern', 'captured').length, opens = of('open-state', 'captured').length, changes = of('page-change', 'captured').filter((r) => r.id !== 'all').length;
  const also = [parts && plural(parts, 'interactive part') + ' tested with hover, focus and press', opens && plural(opens, 'menu or other open state', 'menus and other open states'), changes && plural(changes, 'change between pages', 'changes between pages')].filter(Boolean);
  if (also.length) lead.push(`${also.join(', ').replace(/^./, (c) => c.toUpperCase())}.`);
  // the same reason on many units reads as one line
  const out = rows.filter((r) => r.unit !== 'moving-element' && !['captured', 'duplicate-of'].includes(r.status));
  const lines = new Map();
  for (const r of out) {
    const name = r.unit === 'moment' ? (MOMENT[r.id] || r.id) : (UNIT[r.unit] || r.unit);
    // a host's folded requests add up: "249 requests: a file of another site" and "83 requests: ..." are one line
    const m = /^(\d+) requests?: (.*)$/.exec(r.reason || '');
    const why = m ? m[2] : r.reason || r.status, k = `${name}\u0001${why}`;
    const line = lines.get(k) || { name, why, n: 0, requests: 0, vps: new Set() };
    line.n++; if (m) line.requests += +m[1]; if (r.viewport) line.vps.add(VP[r.viewport] || r.viewport);
    lines.set(k, line);
  }
  const missing = [...lines.values()].map((l) => {
    const where = l.vps.size === 1 ? `, ${[...l.vps][0]}` : '', head = `${l.name.replace(/^./, (c) => c.toUpperCase())}${where}: `;
    return l.requests ? `${head}${plural(l.requests, 'request')}: ${l.why}` : `${head}${l.why}${l.n > 1 ? ` (${l.n.toLocaleString('en-US')} of them)` : ''}`;
  });
  return { lead, pages: pages.map((p) => p.page || p.id), missing };
}
