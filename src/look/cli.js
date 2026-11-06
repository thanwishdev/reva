// `reva look` / `reva look` on the command line: plain lines first, code on request, JSON for tools.
import { declaredLine } from './declared.js';
import readline from 'node:readline';
import { runLook, ACTIONS } from './index.js';
import { channelWord } from './words.js';
import { restText, noteComment } from './rest.js';
import { startsText, declaredStartText } from './starts.js';
import { combineCss } from '../export/index.js';
import { designHeadline } from '../design/text.js';
import { librariesLine } from './libs.js';
import { lenisPageLines, lenisLibLine } from './lenis.js';
import { declaredLibLines } from './libprobe.js';
import { CONTROL_CHARS, stripControls, terminalJson } from '../report/untrusted.js';
import { parseColorScheme } from '../browser/scheme.js';

export const LOOK_HELP = `reva look <url | archive> [--el <selector> | --pick [key|N]] [--do load|hover|click|scroll] [--on <selector|x,y>] [--after <selector>]
          [--top 5] [--ch ren:ty,ren:opacity] [--max-channels 40] [--members 24] [--fit-budget <evaluations>]
          [--rate 120|60] [--hold <ms>] [--press <ms>] [--wheels <n>] [--json] [--code [css,gsap,motion,lenis,raf,react-spring]] [--card] [--verbose] [--no-keepalive] [--no-design] [--no-retake]
          [--engine chs|cft] [--color-scheme light|dark] [--ignore-robots] [--allow-net <host,...>] [--allow-cdn]

  Records just that element during just that action (on a virtual 120 Hz clock), fits how it moves and prints it in
  plain words. Every number is labelled exact (read from the page's CSS), fitted (measured and fitted) or unknown.
  --el      the element(s) to look at (CSS selector). Without it: the top elements by visual weight (area × travel × time).
  --pick    rank the moving elements and choose one: by its key (a printed selector or descriptor, stable between runs),
            by its rank in this run (a number), or interactively in a terminal.
  --do      the action (default load). hover / click use --on as the trigger, else the --el element itself.
  --on      trigger: a selector, or a viewport point "x,y" (a pointer move there; cursor followers).
  --press   click: how long the button stays down, in ms (default 300). A click is hover (700 ms on the target), press, release;
            each line says which of the three it starts on. A press-and-hold effect (a shake that builds while held) needs a longer --press.
  --after   click this element first, let the page settle, then record and do the --do action: motion that exists only after a
            click (a card that opens a viewer, a toggle that builds a panel). One look; look.json "action.after" names it.
  --card    also write the motion card (card.html, one self-contained file) next to look.json and print its path.
  --verbose also print the "not motion" lines (a value that changed form but not on screen).
  --no-design skip the design pass. By default look also records how the page is designed (fonts, type scale, colours
            and contrast, spacing, radii, shadows, layout, breakpoints, hover / focus) in a second headless session after
            the take: look.json "design", one line here (the time it took is printed); "reva design" prints all of it.
  --no-retake skip the stability check. By default look runs the same action once more in a fresh browser, served from the
            responses of the first run (kept in memory / a temp file for this look only, deleted at its end), fits the top
            motions again and compares duration, start, ease and end values: look.json "stability"; a motion that differs
            between the two runs gets one line ("varies between two runs: ..."). Skipped near the time limit or with --after.
  --engine  the browser: chs (headless shell, what reva doctor --install installs) or cft (full Chrome for Testing, macOS
            arm64, installed separately). Default: cft when it is installed, else chs.
  --color-scheme  read the page in the light (default) or dark colour scheme: what prefers-color-scheme matches, for the
            take and the design pass. look.json "take.colorScheme" and the design section say which scheme was read.
  --ignore-robots  open the page even when its robots.txt disallows it. Only for sites you own or may test; it covers
                   the typed site only. Domains listed under "ownDomains" in ~/.reva/config.json need no flag.
  --allow-net / --allow-cdn  a LOCAL page (http://localhost:<port>/...) is offline by default: every other host is blocked, and
                   the output lists what was blocked (a CDN-hosted GSAP / Lenis / font shows up there). --allow-net cdn.jsdelivr.net,...
                   lets the page fetch from those host names; --allow-cdn from the well-known library and font CDNs
                   (cdnjs.cloudflare.com, cdn.jsdelivr.net, unpkg.com, fonts.googleapis.com, fonts.gstatic.com, code.jquery.com,
                   ajax.googleapis.com). Everything else stays blocked. Local pages only (an archive is always offline).
  Before a live page opens, REVA reads its robots.txt (and that of every redirect hop) and the page once: it stops when a
  robots.txt disallows the page or
  the page is behind a bot, login or region wall, and it clicks "reject" on a cookie banner it recognises (never "accept").
  Writes look.json (and fit.json) for the motion card and the MCP; --json prints it.`;

const list = (v) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : null);
const n = (v) => (v == null || v === true ? undefined : Number(v));
const pct = (x) => `${(100 * x).toFixed(x < 0.1 ? 1 : 0)} %`;

/** Where an entry is on screen when it starts to move (tells apart two rows with the same descriptor). */
export const where = (e) => (e.box ? `at ${e.box.x},${e.box.y} (${e.box.w}×${e.box.h})` : null);
/**
 * The --el hint for an entry: its selector (checked unique in the page, or the descriptor selector of replaced nodes),
 * or why there is none, then a member's own selector, else the stable --pick key (the descriptor). Never a --pick rank:
 * ranks can change between runs.
 */
export function selectorHint(e) {
  const why = e.selectorWhy ?? e.why, n = e.selectorMatches ?? e.matches, gone = e.selectorGone ?? e.gone;   // look.json motions | planFit entries
  if (e.selector) return `(${e.selector}${why && (n > 1 || gone) ? `: ${why}` : ''})`;
  const lead = e.leadSelector ?? null;
  return `(${why || 'no unique selector'}${lead ? `; one of them: ${lead}` : `; or --pick '${e.desc}'`})`;
}

async function ask(entries) {
  process.stderr.write('\nMoving elements, by visual weight:\n');
  for (const e of entries) process.stderr.write(`  ${String(e.rank).padStart(2)}  ${stripControls(e.desc)}${e.count > 1 ? ` ×${e.count}` : ''}  ${where(e) || ''}  ${pct(e.weightShare)}  starts ${e.firstMoveT != null ? Math.round(e.firstMoveT) + ' ms' : '-'}\n`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const a = await new Promise((r) => rl.question('Pick a number: ', r)); rl.close();
  return Number(a);
}

// code line: one word per library; when the element's channels differ (a fitted y and a withheld opacity), each word
// names its channels, so a weak channel never hides a good one (or the reverse)
const lineBlock = (L, l, ind = '   ', frameMs = 16.7) => {
  L.push(`${ind}${l.text}`);
  // a font axis channel carries its start and end ('font weight 300 → 800 [fitted]')
  const chs = [...new Set(l.channels.map((c) => { const t = (l.travel || []).find((x) => x.channel === c); return t ? `${t.text} [${t.label}]` : channelWord(c); }))].join(', ');
  // a declared line: its measured start when that is not the declared delay (a stagger written as a delay that the page shifts)
  const dl = l.kind === 'declared' ? declaredStartText(l.rel, ((l.values || []).find((v) => v.name === 'delay') || {}).value, frameMs) : null;
  L.push(`${ind}  ${[l.trigger, chs, l.times > 1 ? `${l.times} segments` : null, dl].filter(Boolean).join(' · ')}`);
};
function codeBlock(L, exports, code, ind = '   ', note = null) {
  const per = new Map();   // lib -> channel -> word (a lib with several forms: any form with code beats "n/a")
  for (const it of exports) for (const x of it.exports) {
    const w = ((x.match && x.match.word) || 'n/a').replace(/^(approx) \(.*$/, '$1'); const m = per.get(x.lib) || new Map(); per.set(x.lib, m);
    const ch = channelWord(it.channel); if (!m.has(ch) || m.get(ch) === 'n/a') m.set(ch, w);
  }
  const acc = new Map();   // lib -> word -> [channels]
  for (const [lib, m] of per) { const g = new Map(); for (const [ch, w] of m) g.set(w, [...(g.get(w) || []), ch]); acc.set(lib, g); }
  const say = (m) => (m.size === 1 ? [...m.keys()][0] : [...m].map(([w, chs]) => `${w} (${[...new Set(chs)].join(', ')})`).join(' / '));
  if (acc.size) L.push(`${ind}code: ${[...acc].map(([k, m]) => `${k} ${say(m)}`).join(' · ')}${code ? '' : '   (--code to print)'}`);
  if (!code) return;
  const wordOf = (x) => x.match || { word: x.accuracy.label };
  // css: the channels of one element as ONE rule (combineCss, as the MCP code tool does): per-channel rules would override
  // each other's transform and transition when pasted together
  // each channel's measured start offset becomes its transition delay (unknown offsets: none written)
  const cssParts = exports.flatMap((it) => it.exports.filter((x) => x.lib === 'css' && x.code && x.decl).map((x) => ({ el: 1, id: it.channel, decl: x.decl, x, t0: it.t0 })));
  const known = cssParts.every((p) => Number.isFinite(p.t0)); const min = known && cssParts.length ? Math.min(...cssParts.map((p) => p.t0)) : 0;
  const joined = code.includes('css') && cssParts.length > 1 ? combineCss(cssParts.map((p) => ({ ...p, delayMs: known ? p.t0 - min : 0 }))) : null;
  if (joined && joined.code) {
    const words = [...new Set(cssParts.map((p) => wordOf(p.x).word))]; const ids = cssParts.map((p) => p.id);
    const head = String(cssParts[0].x.code.split('\n')[0]); const header = head.startsWith('/*') ? head.replace(`[${ids[0]}]`, `[${ids.join(', ')}]`) : null;
    L.push('', `${ind}-- css · ${ids.join(' + ')} · ${words.join(' / ')} (one rule for these channels)`, ...[header, ...(note ? [noteComment('css', note)] : []), ...joined.code.split('\n')].filter(Boolean).map((s) => ind + s));
  }
  // the same snippet for several channels (a declared transform written whole) is printed once, naming them all
  const groups = new Map();
  for (const it of exports) for (const x of it.exports) {
    if (!x.code || !code.includes(x.lib) || (joined && joined.code && x.lib === 'css' && x.decl)) continue;
    const body = x.code.split('\n').filter((l) => !l.startsWith('/* REVA:')).join('\n');
    const k = `${x.lib}\u0000${body}`; const g = groups.get(k);
    if (g) g.channels.push(it.channel); else groups.set(k, { x, channels: [it.channel] });
  }
  for (const { x, channels } of groups.values()) {
    const m = wordOf(x);
    L.push('', `${ind}-- ${x.lib} · ${channels.join(' + ')} · ${m.word}${m.why ? ` (${m.why})` : ''}`, ...x.code.split('\n').map((s) => ind + s));
  }
}

/** Requested --code stacks that printed nothing for this result, each with a plain reason. */
export function noCodeStacks(r, code) {
  const has = new Set();
  const take = (exps) => { for (const it of exps || []) for (const x of it.exports || []) if (x.code) has.add(x.lib); };
  for (const m of r.motions || []) { take(m.exports); for (const x of (m.stagger && m.stagger.exports) || []) if (x.code) has.add(x.lib); }
  if (r.page && r.page.lines && r.page.lines[0] && r.page.lines[0].kind === 'smoothing') take(r.page.exports);
  const why = { lenis: (r.motions || []).length || r.page ? 'this motion is not page-scroll smoothing' : 'no motion to write code for', raf: 'this motion has no per-frame (requestAnimationFrame) form', 'react-spring': 'this motion is not a spring' };
  return code.filter((lib) => !has.has(lib) && !((r.declaredOnly || []).length && lib === 'css' && (r.declaredOnly || []).some((d) => d.css)))
    .map((lib) => ({ lib, why: why[lib] || ((r.motions || []).length || (r.page && r.page.lines && r.page.lines.length) ? 'this motion has no code in this stack' : 'no motion to write code for') }));
}

/** Text report. */
export function formatLook(r, { code = null, verbose = false } = {}) {
  const L = [];
  const src = r.source.kind === 'archive' ? `archive ${r.source.startUrl} (frozen, replayed offline)` : `${r.source.url}${r.source.live ? '' : ' (local)'}`;
  L.push(`REVA look · ${r.action.do}${r.action.el ? ` ${r.action.el}` : r.action.picked ? ` pick #${r.action.picked.rank} ${r.action.picked.desc}` : ''}${r.action.on ? ` (trigger ${r.action.on})` : ''}${r.action.after ? ` after clicking ${r.action.after}` : ''} · ${src} · ${(r.timing.totalMs / 1000).toFixed(1)} s`);
  L.push(`recorded ${r.take.frames} frames at ${r.take.rate} Hz${r.take.rateRule ? ` (a canvas covers ${Math.round(r.take.rateRule.canvasCover * 100)} % of the viewport, so 60 Hz, not 120)` : ''} · ${r.take.watched} element(s) watched${r.source.kind === 'archive' ? ` · ${r.take.net.misses} network miss(es)` : ''}${r.action.wheels ? ` · ${r.action.wheels} wheel steps${r.action.stoppedEarly ? (r.action.el ? ' (stopped once the element left)' : ' (stopped at the bottom of the page)') : ''}${r.action.pageHeight && r.action.pageHeight.start ? ` · page ${r.action.pageHeight.start} px tall` : ''}` : ''}`);
  for (const e of r.errors) L.push(`! ${e}`);
  for (const w of r.warnings || []) L.push(`! ${w}`);
  // hover / click top-N: rank is visual weight, so an intro or loader that plays during the take can lead the list; say so,
  // and name the rows that do respond to the input (a reader takes rank 1 for "what the hover does")
  if ((r.action.do === 'hover' || r.action.do === 'click') && !r.action.el && !r.action.picked && r.motions.length) {
    const ownTime = (m) => m.lines.length > 0 && m.lines.every((l) => /plays on its own time/.test(l.trigger || ''));
    if (ownTime(r.motions[0])) {
      const reacting = r.motions.filter((m) => !ownTime(m) && m.lines.length).map((m) => m.rank);
      L.push(`! rank 1 plays on its own time (an intro or loader running during the take), not in response to the ${r.action.do}; ${reacting.length ? `rank${reacting.length > 1 ? 's' : ''} ${reacting.join(', ')} respond${reacting.length > 1 ? '' : 's'} to it` : `no ranked row responds to it: aim with --el`}`);
    }
  }
  if (r.page) {
    const l = r.page.lines[0];
    const smooth = l && l.kind === 'smoothing';
    if (r.action.do === 'click') {
      // a click that scrolls the page (an anchor link, a scroll-to button): the page's own scroll tween, read from the root box
      L.push('', `Page scroll after the click (the click scrolls the page): ${!l ? 'no model' : l.text}`);
      for (const u of r.page.unknowns || []) L.push(`   no model [unknown: ${u.reason}]`);
      codeBlock(L, r.page.exports, code);
    } else {
      L.push('', `Page scroll: ${!l ? 'no model' : smooth ? l.text.replace(/^Smooth follow of the scroll/, 'smooth (follows the wheel)') : /^(scroll map|step|pin)$/.test(l.kind) ? 'native: follows the wheel directly, no smoothing seen [fitted]' : l.text}`);
      for (const u of r.page.unknowns || []) L.push(`   no model [unknown: ${u.reason}]`);
      L.push(...lenisPageLines(r.lenis, r.page));
      if (smooth) codeBlock(L, r.page.exports, code);
    }
  }
  const glLines = (r.gl && r.gl.lines) || [];
  const glMoving = glLines.some((l) => !['shader', 'unknown', 'camera'].includes(l.kind));
  // (--el html on a scroll: the page line above IS the answer)
  if (!r.motions.length && !(r.declaredOnly || []).length && !glMoving && !(r.page && r.action.el)) {
    const chosen = r.action.el || r.action.picked;
    const left = (r.alreadyMoving || []).length + (r.pointerDriven || []).length;
    const nfa = r.notFromAction || [];
    if (nfa.length) L.push('', `No change on ${r.action.do} seen for ${r.action.el || 'the chosen element(s)'} during the take.`);
    else L.push('', chosen ? `No motion found on the chosen element(s) during this ${r.action.do}${r.status === 'no-motion' ? ' (see the warnings above)' : ''}.`
      : `No element moved on its own during this ${r.action.do}${r.page ? ': what moved went with the page scroll (the page row above)' : ''}${left ? `; ${left} element(s) are listed apart below` : ''}.`);
  }
  // two rows with the same descriptor never read the same: both say where they are on screen, and when the place is the
  // same too, which one of them it is (the selector then tells them apart)
  const dup = new Set(r.motions.map((m) => m.desc).filter((d, i, a) => a.indexOf(d) !== i));
  const placeKey = (m) => `${m.desc}|${where(m)}`; const samePlace = new Map();
  for (const m of r.motions) if (dup.has(m.desc) && where(m)) samePlace.set(placeKey(m), [...(samePlace.get(placeKey(m)) || []), m.rank]);
  const placeTag = (m) => { const g = samePlace.get(placeKey(m)); return g && g.length > 1 ? ` (${g.indexOf(m.rank) + 1} of ${g.length} here)` : ''; };
  // a long list (a broad --el): rows under 0.1 % of the visual weight are summed up in one line (look.json has them all)
  const tiny = r.motions.length > 10 ? r.motions.filter((m) => m.weightShare != null && m.weightShare < 0.001) : [];
  const shown = tiny.length > 1 ? r.motions.filter((m) => !tiny.includes(m)) : r.motions;
  for (const m of shown) {
    const sel = r.action.el && m.selector === r.action.el ? '' : `   ${selectorHint(m)}`;
    L.push('', `${m.rank}  ${m.desc}${m.count > 1 ? ` ×${m.count}` : ''}${dup.has(m.desc) && where(m) ? ` ${where(m)}${placeTag(m)}` : ''}${sel}${m.weightShare != null && r.motions.length > 1 ? `   ${pct(m.weightShare)} of the visual weight` : ''}`);
    if (m.notice && (m.notice.why || []).length) L.push(`   ranked by: ${m.notice.why.join(', ')}`);
    if (m.stagger) L.push(`   ${m.stagger.text}`);
    else if (m.starts) L.push(`   ${startsText(m.starts, 1000 / (r.take.rate || 60))}`);
    const rt = restText(m.rest); if (rt) L.push(`   ${rt}`);
    if (m.share && m.share.fitted) L.push(`   ${m.share.same} of ${m.share.fitted} fitted members move like the first one on ${channelWord(m.share.channel)}${m.membersNotFitted ? ` (${m.membersNotFitted} more not fitted: budget)` : ''}`);
    for (const l of m.lines) lineBlock(L, l, '   ', 1000 / (r.take.rate || 60));
    // the page's declared GSAP tween of this motion (look.json "gsap"): [exact], or where it disagrees with the fit
    // identical declarations (a group's members, repeated tweens) print once with a count; at most 6 distinct lines (look.json has all)
    { const by = new Map(); for (const g of m.gsap || []) by.set(g.text, (by.get(g.text) || 0) + 1);
      const rows = [...by]; for (const [t, n] of rows.slice(0, 6)) L.push(`   ${t}${n > 1 ? ` ×${n}` : ''}`);
      if (rows.length > 6) L.push(`   … ${rows.length - 6} more declared GSAP tween(s) (look.json "gsap")`); }
    for (const x of (m.libDeclared || []).slice(0, 3)) L.push(`   ${x.text}`);   // anime.js declared values (src/look/libprobe.js)
    // the stability re-take: said only when this motion differed between the two runs (look.json "stability" has all)
    { const st = r.stability && r.stability.ran ? (r.stability.motions || []).find((x) => x.rank === m.rank) : null; if (st && st.verdict === 'varies' && st.text) L.push(`   ! ${st.text}`); }
    // "not motion" lines (equivalent forms, below noise) are noise to a reader: shown only with --verbose, or when they
    // are all this row has to say (look.json keeps them either way)
    const nf = (r.notFitted || []).filter((n) => n.el === m.lead);
    const quiet = (m.unknowns || []).filter((u) => u.kind === 'below noise');
    const showQuiet = verbose || (!m.lines.length && quiet.length === (m.unknowns || []).length && !nf.length);
    for (const u of m.unknowns || []) if (u.kind !== 'below noise' || showQuiet) L.push(u.kind === 'below noise' ? `   ${channelWord(u.channel)}: ${u.reason}` : `   ${channelWord(u.channel)}: moves, no model [unknown: ${u.reason}]`);
    if (quiet.length && !showQuiet) L.push(`   (${quiet.length} channel(s) changed form but not on screen: not motion; --verbose shows them)`);
    for (const n of nf) L.push(`   ${channelWord(n.channel)}: not fitted [unknown: ${n.reason}]`);
    if (!m.lines.length && !(m.unknowns || []).length && !nf.length) L.push('   no fitted motion');
    for (const c of m.covered) L.push(`   ${channelWord(c.channel)}: covered by ${c.by} (not fitted separately)`);
    codeBlock(L, m.exports, code, '   ', m.rest && m.rest.note);
    if (code && m.stagger) for (const x of m.stagger.exports) if (code.includes(x.lib)) L.push('', `   -- ${x.lib} · stagger · ${x.accuracy.label === 'exact' ? 'matches fit' : x.accuracy.label}`, ...x.code.split('\n').map((s) => '   ' + s));
  }
  if (tiny.length > 1) L.push('', `${tiny.length} more row(s) under 0.1 % of the visual weight (ranks ${tiny[0].rank}-${tiny[tiny.length - 1].rank}): ${[...new Set(tiny.map((m) => m.desc))].slice(0, 4).join(', ')}${tiny.length > 4 ? ', …' : ''} (look.json and --json have them)`);
  if ((r.declaredOnly || []).length) {
    L.push('', `Colour, background, shadow and font changes the page declares (${r.motions.length ? 'also ' : ''}read from its CSS / Web Animations, [exact]; the colour between the end values is not sampled frame by frame):`);
    for (const d of r.declaredOnly) {
      L.push(`   ${d.desc}${d.selector ? `   (${d.selector})` : ''}`, `      ${declaredLine(d)}`);
      if (code && d.css) L.push(`      ${d.css}`);
    }
  }
  // WebGL light: shaders, camera and uniforms read from the page's WebGL calls (look.json "gl" has the sources)
  if (glLines.length) {
    const g = r.gl; const ctx = (g.contexts || []).length; const used = (g.programs || []).filter((p) => p.used).length;
    L.push('', `WebGL (read from the page's WebGL calls: ${ctx} context${ctx === 1 ? '' : 's'}, ${(g.programs || []).length} program${(g.programs || []).length === 1 ? '' : 's'}${used ? `, ${used} used` : ''}; shader sources in look.json "gl" and on the card):`);
    for (const l of glLines) L.push(`   ${l.text}`);
    const still = (g.constants && g.constants.uniforms) || 0;
    if (still) L.push(`   (${still} uniform${still === 1 ? '' : 's'} did not change during the take: not motion, left out)`);
  } else if (r.gl && r.gl.error) L.push('', `WebGL: the WebGL calls could not be read (${r.gl.error}) [unknown]`);
  if ((r.pointerDriven || []).length) L.push('', `${r.pointerDriven.length} element(s) left out: they follow the pointer the tool parked mid-viewport to scroll (cursor followers): ${[...new Set(r.pointerDriven.map((p) => p.desc))].slice(0, 4).join(', ')}`);
  // each listed name is something the user can paste back: a selector for --el, else the descriptor as a --pick key
  if ((r.alreadyMoving || []).length) {
    const names = [...new Set(r.alreadyMoving.map((p) => p.selector || p.desc))].slice(0, 4);
    const withSel = r.alreadyMoving.some((p) => p.selector);
    L.push('', `${r.alreadyMoving.length} element(s) left out: already moving before the ${r.action.do} (page load or an ambient loop): ${names.join(', ')}${r.alreadyMoving.length > 4 ? ', …' : ''}${withSel ? ' (--el <selector> looks at one)' : ''}`);
  }
  for (const n of r.notFromAction || []) L.push('', `left out: ${n.selector || n.desc} ${n.lines.map((l) => l.why).join('; ')}, so not the ${r.action.do}'s result (look.json "notFromAction" has the fit)`);
  for (const m of r.motions) for (const b of m.beforeAction || []) L.push('', `left out of ${m.selector || m.desc}: ${b.why} (${b.text.split(' [')[0]})`);
  if (r.others.length) {
    const nm = (o) => (o.selector || o.leadSelector ? (o.selector || o.leadSelector) : `'${o.desc}'`) + (o.count > 1 ? ` ×${o.count}` : '');
    L.push('', `${r.others.length} more moving element(s) not fitted: ${r.others.slice(0, 5).map(nm).join(', ')}${r.others.length > 5 ? ', …' : ''} (a selector goes to --el; a quoted descriptor to --pick)`);
  }
  for (const st of code ? noCodeStacks(r, code) : []) L.push('', `${st.lib}: no code (${st.why})`);
  if (r.design) L.push('', designHeadline(r.design) + (r.design.ok === false ? '' : ' (look.json "design"; reva design prints it in full)'));
  { const ls = declaredLibLines(r.declaredLibs, r.animeRest); if (ls.length) L.push('', ...ls); }   // Swiper / Lottie / Locomotive / unattached anime.js, <= 6 lines
  { const ll = librariesLine(r.libraries, r.libraries && r.libraries.mechanisms); if (ll) L.push(ll); }
  if (!(r.page && r.action.do !== 'click')) { const ln = lenisLibLine(r.lenis); if (ln) L.push(ln); }   // found, but no page-scroll line printed it
  if (r.fit && r.fit.partial) L.push(`fit is partial: ${r.fit.flags.map((f) => f.detail).join('; ')}`);
  L.push('', 'values: exact = read from the page (CSS / WAAPI) · fitted = measured from the frames and fitted · unknown = not identified (reason in brackets)');
  if (glLines.length) L.push('WebGL: measured = decoded from the numbers the page sent to the GPU · derived = a pattern in the shader source, not a fact about what the author meant');
  L.push('code:   as declared = the page\'s own declaration · matches fit = reproduces the fitted curve (as good as the fit, not more) · approx = max error shown · unknown model = built on values the fit withheld');
  if (r.dir) L.push(`look.json: ${r.dir}/look.json`);
  if (r.card) L.push(`card: ${r.card}`);
  // last line of defence: page text (descriptors, names) never reaches the terminal with escapes or bidi overrides
  return L.map((l) => String(l).split('\n').map((x) => x.replace(CONTROL_CHARS, (c) => (c === '\t' ? c : ''))).join('\n')).join('\n');
}

export async function runLookCommand(f) {
  const input = f._[1];
  // asked for help: help on stdout, exit 0; no URL at all: a usage error (as reva scan)
  if (f.help) { process.stdout.write(LOOK_HELP + '\n'); return 0; }
  if (!input) { console.error(LOOK_HELP); return 2; }
  const action = f.do || 'load';
  if (!ACTIONS.includes(action)) { console.error(`unknown --do ${action} (use ${ACTIONS.join(', ')})`); return 2; }
  if (f.el && f.pick) { console.error('use --el or --pick, not both'); return 2; }
  const pick = f.pick ? (f.pick === true ? true : /^\d+$/.test(String(f.pick)) ? Number(f.pick) : String(f.pick)) : false;
  if (typeof pick === 'number' && pick < 1) { console.error(`--pick ${f.pick}: a rank starts at 1 (or give a key: a printed selector or descriptor)`); return 2; }
  if (typeof pick === 'string' && /^[-+]?\d*\.?\d+$/.test(pick)) { console.error(`--pick ${pick}: a rank is a whole number from 1`); return 2; }
  if (pick === true && !process.stdin.isTTY) { console.error('--pick needs a terminal to ask; give a key or a rank: --pick <selector|descriptor> or --pick N'); return 2; }
  let colorScheme;
  try { colorScheme = parseColorScheme(f['color-scheme']); } catch (e) { console.error(e.message); return 2; }
  if (f['allow-net'] === true) { console.error('--allow-net needs host names: --allow-net cdn.jsdelivr.net,unpkg.com (or --allow-cdn for the known library CDNs)'); return 2; }
  let r;
  try {
    r = await runLook({
    input, action, el: typeof f.el === 'string' ? f.el : undefined, on: typeof f.on === 'string' ? f.on : undefined, pick, chooser: ask,
    top: n(f.top), channels: list(f.ch), maxChannels: n(f['max-channels']), maxMembers: n(f.members), fitBudget: n(f['fit-budget']),
    rate: n(f.rate), holdMs: n(f.hold), pressMs: n(f.press), after: typeof f.after === 'string' ? f.after : undefined, n: n(f.wheels), cls: typeof f.cls === 'string' ? f.cls : 'A', keepalive: !f['no-keepalive'], design: !f['no-design'], retake: !f['no-retake'],
    engine: typeof f.engine === 'string' ? f.engine : undefined, ignoreRobots: !!f['ignore-robots'], ...(colorScheme ? { colorScheme } : {}), ...(f._demo === true ? { demo: true } : {}),
    allowNet: typeof f['allow-net'] === 'string' ? f['allow-net'].split(',').map((x) => x.trim()).filter(Boolean) : undefined, allowCdn: !!f['allow-cdn'],
    log: (m) => process.stderr.write(m + '\n'),
    });
  } catch (e) {
    // a usage problem found once the page is open (an invalid selector, a --pick that names nothing): one line, no stack
    if (e && (e.code === 'bad_arguments' || /^look --pick:/.test(e.message))) { console.error(e.message); return e.code === 'bad_arguments' ? 2 : 1; }
    throw e;
  }
  if (f.card && r.dir) { const { writeCard } = await import('../card/index.js'); r.card = writeCard(r); }
  if (f.json) process.stdout.write(terminalJson(r, 1) + '\n');
  else process.stdout.write(formatLook(r, { code: f.code ? (f.code === true ? ['css', 'gsap', 'motion', 'lenis', 'raf', 'react-spring'] : list(f.code)) : null, verbose: !!f.verbose }) + '\n');
  return r.ok ? 0 : 1;
}
