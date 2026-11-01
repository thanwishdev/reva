// REVA motion card — renderer: card data (data.js) -> one self-contained HTML file.
// No external requests: no fonts, images, scripts or styles from anywhere (a CSP meta forbids them too), so the file
// opens from disk and can be sent around. All page-derived strings are escaped; the code tabs hold the exporters' code.
// Look: pure white (or pure black in dark mode), one sans family, large type, no cards or borders. The first screen is
// the main motion playing; per law the page shows one headline, the specimen and the values, and keeps the curve,
// the code and the reasons behind three quiet disclosures. Monospace is used for code only.
import { designSection, DESIGN_CSS } from './design.js';
import { declaredSection } from './declared.js';
import { cardTitle } from './title.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const jsonForScript = (x) => JSON.stringify(x).replace(/</g, '\\u003c').replace(/[\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16)}`);
const num = (x, d = 3) => (x == null || !Number.isFinite(x) ? '?' : String(Math.round(x * 10 ** d) / 10 ** d));
const ACTION_WORD = { load: 'Load', hover: 'Hover', click: 'Click', scroll: 'Scroll' };

function fmtValue(v) {
  if (v.value == null || !Number.isFinite(v.value)) return v.text || '?';
  const d = Math.abs(v.value) >= 100 ? 0 : Math.abs(v.value) >= 10 ? 1 : Math.abs(v.value) >= 1 ? 2 : 3;
  return `${num(v.value, d)}${v.unit ? (v.unit === '%' ? '%' : ` ${v.unit}`) : ''}`;
}

/** The x unit of a curve: ms, or the scroll map's own driver (window scroll, wheel input, pointer coordinate). */
const unitOf = (c) => (c.axis === 'scroll' ? c.unit || 'px of scroll' : 'ms');
/** A law that moves on y: the hero draws it vertically, a lane says it is drawn sideways. */
const vertical = (c) => !!(c && (c.props || [c.prop]).some((q) => q && q.kind === 'x' && q.dir === 'y'));
/** A map with no recorded frame inside its ramp: the recording never saw the glide, so no box plays it. */
const unmeasured = (c) => !!(c && c.axis === 'scroll' && c.checked === false);
/** A box drawn as a faint outline (the ghost: where the box is when it has faded out) with the ink fill inside. */
const BOX = '<div class="box"><i class="fill"></i></div>';

/** Inline SVG: recorded points (dots) and the fitted curve (line), progress on y. */
function chart(c, id, declared) {
  const pts = [...c.fit, ...c.rec]; if (!pts.length) return '';
  const W = 1000, H = 360, pad = 24;
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const y0 = Math.min(0, ...ys) - 0.06, y1 = Math.max(1, ...ys) + 0.06;
  const X = (x) => (((x - x0) / (x1 - x0 || 1)) * W).toFixed(1), Y = (y) => (pad + (1 - (y - y0) / (y1 - y0)) * (H - 2 * pad)).toFixed(1);
  const guides = [0, 1].map((g) => `<line x1="0" x2="${W}" y1="${Y(g)}" y2="${Y(g)}" class="guide"/>`).join('');
  const line = c.fit.length ? `<path class="fit" d="M${c.fit.map((p) => `${X(p[0])},${Y(p[1])}`).join('L')}"/>` : '';
  const dots = c.rec.length ? `<path class="rec" d="M${c.rec.map((p) => `${X(p[0])},${Y(p[1])}`).join('L')}"/>` : '';
  const unit = unitOf(c);
  return `<figure class="chart" data-chart="${id}" data-x0="${x0}" data-x1="${x1}" data-y0="${y0}" data-y1="${y1}" data-pad="${pad}">
  <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${c.rec.length ? 'Recorded frames and fitted curve' : 'Fitted curve'}">${guides}${dots}${line}<line class="cursor" x1="-10" x2="-10" y1="0" y2="${H}"/></svg>
  <figcaption><span>${esc(num(x0, 0))} ${unit}</span><span class="readout" aria-live="polite">${c.rec.length && c.fit.length ? `The wide grey line is the recording, the thin line the ${declared ? 'declared' : 'fitted'} curve.` : c.rec.length ? 'The recording.' : `The ${declared ? 'declared' : 'fitted'} curve.`}</span><span>${esc(num(x1, 0))} ${unit}</span></figcaption>
</figure>`;
}

/** The first screen: the strongest law, one big box running it on a loop (click replays). */
function heroSpecimen(c, id) {
  const k = c.fit.length ? 'fit' : 'rec';
  const v = c.axis !== 'step' && vertical(c);
  return `<div class="specimen hero-spec" data-spec="${id}" data-hero="1"><div class="lane" data-lane="${k}"><div class="track${v ? ' v' : ''}">${c.axis === 'step' ? '' : '<div class="slot"></div>'}${BOX}</div></div></div>`;
}

function specimen(c, id, stagger, declared) {
  const fw = declared ? 'Declared' : 'Fitted';
  // the demo lane always runs on the viewer's pointer; it names what the site's law follows (scroll, pointer, ...)
  const stepWord = c.follows === 'the pointer' || !c.follows ? 'Follows your pointer' : `Follows ${c.follows} (your pointer drives it here)`;
  const lanes = c.axis === 'step' ? [['fit', stepWord]] : c.rec.length && c.fit.length ? [['rec', 'Recorded'], ['fit', fw]] : c.fit.length ? [['fit', fw]] : [['rec', 'Recorded']];
  const row = (k, word) => `<div class="lane" data-lane="${k}"><span class="lane-word">${word}</span><div class="track">${k === 'stagger' || c.axis === 'step' ? '' : '<div class="slot"></div>'}${BOX}</div></div>`;
  const stag = stagger ? `<div class="lane" data-lane="stagger"><span class="lane-word">Stagger, ${esc(num(stagger.intervalMs, 0))} ms apart</span><div class="track dots">${Array.from({ length: Math.min(stagger.count || 6, 8) }, () => '<div class="box small"></div>').join('')}</div></div>` : '';
  const ctl = c.axis === 'step'
    ? `<button type="button" data-act="play">Jump</button><span class="hint">Move over the lane, or press Jump.</span>`
    : `<button type="button" data-act="play">Replay</button><button type="button" data-act="slow" aria-pressed="false">Quarter speed</button><input type="range" min="0" max="1000" value="0" data-act="scrub" aria-label="Scrub"><span class="time"></span>${vertical(c) ? '<span class="hint">Moves on y; drawn left to right.</span>' : ''}`;
  return `<div class="specimen" data-spec="${id}">${lanes.map(([k, w]) => row(k, w)).join('')}${stag}<div class="controls">${ctl}</div></div>`;
}

function tabs(law, id, extraTabs = []) {
  const all = [...law.tabs];
  for (const t of extraTabs) { const have = all.find((x) => x.lib === t.lib); if (have) have.entries = [...have.entries, ...t.entries]; else all.push(t); }
  if (!all.length) return law.missing.length ? `<p class="quiet">No code: ${esc(law.missing.map((m) => `${m.name} (${m.why})`).join('; '))}</p>` : '';
  const btns = all.map((t, i) => `<button type="button" role="tab" id="${id}-t${i}" aria-controls="${id}-p${i}" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}">${esc(t.name)}</button>`).join('');
  const panels = all.map((t, i) => `<div role="tabpanel" id="${id}-p${i}" aria-labelledby="${id}-t${i}"${i ? ' hidden' : ''}>${t.entries.map((e) => `
      <div class="entry"><div class="entry-head"><p class="fidelity">${esc(e.word)}${e.channel && (t.entries.length > 1 || e.channel === 'stagger') ? ` · ${esc(e.channel === 'stagger' ? 'stagger' : e.chWord || e.channel.replace(/^(ren|drv):/, ''))}` : ''}${e.form ? ` · ${esc(e.form)}` : ''}${e.why ? `<span class="quiet"> — ${esc(e.why)}</span>` : ''}${e.note ? `<span class="quiet"> — ${esc(e.note)}</span>` : ''}</p><button type="button" class="copy">Copy</button></div>
      <pre><code>${esc(e.code)}</code></pre></div>`).join('')}</div>`).join('');
  const miss = law.missing.length ? `<p class="quiet small">Not expressible in ${esc(law.missing.map((m) => `${m.name} (${m.why})`).join('; '))}</p>` : '';
  return `<div class="tabs"><div role="tablist" aria-label="Code">${btns}</div>${panels}${miss}</div>`;
}

function sure(law) {
  const L = [];
  if (law.sentence && law.sentence !== law.headline) L.push(law.sentence);
  if (law.channelWords && law.channelWords.length) L.push(`Moves: ${law.channelWords.join(', ')}${law.trigger ? `; ${law.trigger}` : ''}.`);
  for (const v of law.values) if (v.label === 'unknown' && v.reason) L.push(`${v.name}: unknown, ${v.reason}`);
  if (law.fit) L.push(`Fit: ${law.fit.n ?? '?'} frames, normalised RMS error ${law.fit.nrmse != null ? `${num(law.fit.nrmse * 100, 2)} %` : '?'}${law.fit.holdout ? `, held-out check ${law.fit.holdout.pass === false ? 'failed' : 'passed'}` : ''}.`);
  for (const c of law.ci) L.push(`${c.name}: 95 % interval ${num(c.lo, 4)} to ${num(c.hi, 4)}${c.unit ? ` ${c.unit}` : ''}`);
  if (law.curve && law.curve.gap) L.push(`Largest gap between the recording and the fitted curve on this card: ${law.curve.gap.maxPct < 0.1 ? 'under 0.1' : law.curve.gap.maxPct} % of the travel, at ${law.curve.gap.at} ${unitOf(law.curve)}${law.curve.axis === 'scroll' && law.curve.inRamp ? `, over ${law.curve.inRamp} recorded frame${law.curve.inRamp === 1 ? '' : 's'} inside the ramp` : ''}.`);
  if (law.still) L.push('The fitted map has no travel (its start and end values are equal up to rounding), so there is no curve to draw.');
  if (law.curve && law.curve.scaled) L.push('The recording is drawn on the start and end values that best match the fitted shape (a least-squares offset and travel), so a recording that stops early is still on the right scale.');
  if (law.curve && law.curve.note) L.push(law.curve.note);
  for (const n of law.notes) L.push(n);
  if (law.runs > 1) L.push(`Fitted ${law.runs} times on this element; every value agrees within 3 %, so they are one law. The card draws the first.`);
  else if (law.times > 1) L.push(`The same motion runs ${law.times} times in the recording; the card draws the first.`);
  return L.length ? `<details><summary>How sure</summary><ul>${L.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></details>` : '';
}

/** Provenance once per law (the headline's tag), and a run count when one law was fitted several times. */
const tagOf = (law) => `${law.label}${law.runs > 1 ? ` · ${law.runs} runs` : ''}`;

function lawBlock(law, id, stagger) {
  // values carry a tag only when they are the exception (unknown); the headline already says fitted / exact
  const vals = law.values.length ? `<dl class="values">${law.values.map((v) => `<div><dt>${esc(v.name)}</dt><dd>${esc(fmtValue(v))}${v.label === 'unknown' ? ' <span class="label label-unknown">unknown</span>' : ''}</dd></div>`).join('')}</dl>` : '';
  const c = law.curve;
  const usable = c && (c.fit.length || c.rec.length);
  const code = tabs(law, id, stagger && stagger.tabs ? stagger.tabs : []);
  return `<div class="law">
    <p class="headline">${esc(law.headline)} <span class="label label-${esc(law.label)}">${esc(tagOf(law))}</span></p>
    ${law.still ? '<p class="lede quiet">Did not move.</p>' : unmeasured(c) ? `<p class="lede quiet">${({ pointer: 'The pointer', wheel: 'The wheel input' })[c.driver] || 'The scroll'} jumped across this range between two frames. The recording holds only the start and end values, so the motion between them is not measured.</p>` : usable ? specimen(c, id, stagger && c.axis === 'time' && c.fit.length ? stagger : null, law.label === 'exact') : ''}
    ${vals}
    <div class="more">
      ${usable ? `<details><summary>Curve</summary>${chart(c, id, law.label === 'exact')}</details>` : ''}
      ${code ? `<details><summary>Code</summary>${code}</details>` : ''}
      ${sure(law)}
    </div>
  </div>`;
}

function motionSection(m, i, specs) {
  const laws = m.laws.map((l, j) => {
    const id = `m${i}l${j}`;
    if (l.curve) specs[id] = { axis: l.curve.axis, span: l.curve.span, lead: l.curve.lead, rec: l.curve.rec, fit: l.curve.fit, props: l.curve.props || [l.curve.prop], tau: l.curve.tau || null, stagger: j === 0 && m.stagger && m.stagger.intervalMs ? { interval: m.stagger.intervalMs, n: Math.min(m.count || 6, 8) } : null };
    return lawBlock(l, id, j === 0 ? m.stagger : null);
  }).join('');
  const gaps = [...(m.unknowns || []), ...(m.notFitted || []).map((n) => ({ ...n, kind: 'not fitted' }))];
  const gapList = gaps.length ? `<details><summary>${gaps.length === 1 ? 'One more channel' : `${gaps.length} more channels`} without a model</summary><ul>${gaps.map((g) => `<li>${esc(g.channel.replace(/^(ren|drv):/, ''))}: ${esc(g.reason)}</li>`).join('')}</ul></details>` : '';
  const same = m.selector && m.desc && m.selector.toLowerCase() === m.desc.toLowerCase();
  const why = m.selectorWhy && m.selectorWhy !== 'the --el selector' ? m.selectorWhy : null;
  const sel = same ? (why ? `<p class="quiet sel">${esc(why)}</p>` : '') : m.selector ? `<p class="quiet sel">${esc(m.selector)}${m.selectorWhy && m.selectorWhy !== 'the --el selector' ? ` — ${esc(m.selectorWhy)}` : ''}</p>` : !m.selector && m.selectorWhy ? `<p class="quiet sel">${esc(m.selectorWhy)}${m.leadSelector ? `; one of them: ${esc(m.leadSelector)}` : ''}</p>` : '';
  return `<section class="motion">
  <h2>${esc(same ? m.selector : m.desc || 'Element')}${m.count > 1 ? ` <span class="quiet">×${m.count}</span>` : ''}</h2>
  ${sel || '<div class="sel"></div>'}
  ${m.stagger ? `<p class="lede">${esc(m.stagger.text)}</p>` : ''}
  ${laws || '<p class="lede">Moves, but no law was identified.</p>'}
  ${gapList}
</section>`;
}

/**
 * How directly a law answers the action (lower first): 0 = on the acted-on element, or its trigger is the action
 * (reacts to the pointer, starts after the hover / click, tied to the scroll); 2 = plays on its own time or on load
 * (a page-load leftover that happened to run during a hover); 1 = anything else. A load action ranks every law 1.
 */
export function actionScore(law, m, action) {
  const act = action && action.do; if (!act || act === 'load') return 1;
  if (m && action.el && (m.selectorWhy === 'the --el selector' || m.selector === action.el || m.leadSelector === action.el)) return 0;
  const tr = String((law && law.trigger) || '');
  if ((act === 'hover' || act === 'click') && /reacts to the pointer|starts after the (hover|click)/.test(tr)) return 0;
  if (act === 'scroll' && /scroll/.test(tr)) return 0;
  if (/plays on its own time|plays on load/.test(tr)) return 2;
  return 1;
}

export function renderCard(d0) {
  const specs = {};
  // sections in the order they answer the action (stable: the look's rank breaks ties), so a hover card opens on the
  // hover response, not on a preloader that was still finishing
  const mScore = (m) => Math.min(...(m.laws.length ? m.laws.map((l) => actionScore(l, m, d0.action)) : [1]));
  const d = { ...d0, motions: d0.motions.map((m, i) => [m, mScore(m), i]).sort((a, b) => a[1] - b[1] || a[2] - b[2]).map(([m]) => m) };
  const where = cardTitle(d.source);
  const title = `${ACTION_WORD[d.action.do] || 'Motion'} on ${where}`;
  const pageSec = d.page && d.page.laws.length ? motionSection({ desc: 'Page scroll', count: 1, laws: d.page.laws, unknowns: d.page.unknowns }, 'p', specs) : '';
  const sections = d.motions.map((m, i) => motionSection(m, i, specs)).join('');
  const n = d.motions.length;
  const lede = n ? `${n === 1 ? 'One element moved' : `${n} elements moved`}${d.action.el ? ` (${esc(d.action.el)})` : ''}. Recorded frame by frame at ${esc(d.take.rate)} Hz${d.source.offline ? ', offline' : ''}, fitted, and replayed here on a plain box.` : (d.declaredOnly || []).length ? `No frame-by-frame motion was sampled; the page declares ${d.declaredOnly.length === 1 ? 'one colour / shadow change' : `${d.declaredOnly.length} colour / shadow changes`}${d.action.el ? ` (${esc(d.action.el)})` : ''}, listed below.` : 'Nothing moved during this action.';
  const notes = [...d.errors, ...d.warnings];
  // the hero: the first law (page first, then by rank) with a playable fitted curve; a follower or a recording otherwise
  const all = [...(d.page ? d.page.laws.map((l, j) => [l, `mpl${j}`, 'Page scroll', actionScore(l, null, d.action)]) : []), ...d.motions.flatMap((m, i) => m.laws.map((l, j) => [l, `m${i}l${j}`, m.desc || m.selector || 'Element', actionScore(l, m, d.action)]))]
    .map((x, k) => [...x, k]).sort((a, b) => a[3] - b[3] || a[4] - b[4]);
  const pick = all.find(([l]) => l.curve && l.curve.fit.length && l.curve.axis !== 'step' && !unmeasured(l.curve)) || all.find(([l]) => l.curve && (l.curve.fit.length || l.curve.rec.length) && !unmeasured(l.curve));
  const hero = pick ? `<section class="hero" aria-label="The main motion, replayed">
  <p class="hero-law">${esc(pick[0].hero || pick[0].headline)}</p>
  <p class="quiet hero-el">${esc(pick[2])} · ${esc(tagOf(pick[0]))}</p>
  ${heroSpecimen(pick[0].curve, pick[1])}
</section>` : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'">
<meta name="generator" content="REVA ${esc(d.schema)}">
<title>${esc(title)}</title>
<style>${CSS}${d.design ? DESIGN_CSS : ''}</style>
</head>
<body>
<main>
<header class="top">
  <p class="brand">REVA motion card</p>
  <h1>${esc(title)}</h1>
  ${hero}
  <p class="lede">${lede}</p>
  ${notes.length ? `<ul class="notes">${notes.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
  ${d.recorded ? '' : '<p class="quiet">The recording this result points to was not found, so only the fitted curves are shown.</p>'}
</header>
${pageSec}${sections}
${declaredSection(d.declaredOnly)}
${designSection(d.design)}
<footer>
  <p class="quiet">Every number says where it came from: <em>exact</em> is read from the page, <em>fitted</em> is measured from the frames and fitted, <em>unknown</em> was not identified. Distances are shown as a share of the travel, so this card holds the feel of the motion, not the page.</p>
  <p class="quiet">${esc(d.source.url || '')}${d.take.started ? ` · recorded ${esc(d.take.started)}` : ''} · ${esc(d.take.frames)} frames${d.source.kind === 'archive' && typeof d.take.misses === 'number' ? ` · ${esc(d.take.misses)} network miss${d.take.misses === 1 ? '' : 'es'}` : ''}${d.others ? ` · ${esc(d.others)} more moving element${d.others === 1 ? '' : 's'} not on this card` : ''}</p>
</footer>
</main>
<script type="application/json" id="reva-data">${jsonForScript(specs)}</script>
<script>${JS}</script>
</body>
</html>
`;
}

const CSS = `
:root{--bg:#fff;--ink:#0a0a0a;--mute:#6f6f6f;--faint:#e9e9e9;--band:#d9d9d9;--font:"SF Pro Display","SF Pro Text",-apple-system,BlinkMacSystemFont,"Helvetica Neue",Inter,system-ui,sans-serif;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;--gut:clamp(20px,4vw,64px);--ease:cubic-bezier(0.19,1,0.22,1)}
@media (prefers-color-scheme:dark){:root{--bg:#000;--ink:#f4f4f4;--mute:#8d8d8d;--faint:#1c1c1c;--band:#3a3a3a}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--font);font-size:17px;line-height:1.55;-webkit-font-smoothing:antialiased}
main{max-width:1080px;margin:0 auto;padding:0 var(--gut)}
.top{padding:clamp(40px,8vh,96px) 0 clamp(32px,6vh,72px)}
.brand{margin:0 0 6px;color:var(--mute)}
h1{font-size:clamp(26px,3vw,40px);line-height:1.1;letter-spacing:-0.02em;font-weight:600;margin:0;overflow-wrap:anywhere}
.hero{margin:clamp(36px,7vh,80px) 0 clamp(36px,7vh,80px);--hb:clamp(72px,8.5vw,112px)}
.hero-law{font-size:clamp(34px,5.4vw,76px);line-height:1.04;letter-spacing:-0.032em;font-weight:600;margin:0 0 14px;max-width:16em;overflow-wrap:anywhere}
.hero-el{margin:0;overflow-wrap:anywhere}
.hero-spec{margin:clamp(28px,5vh,56px) 0 0;cursor:pointer}
.hero-spec .lane{grid-template-columns:1fr;min-height:0}
.hero-spec .track{height:calc(var(--hb) + 16px)}
.hero-spec .track.v{height:clamp(240px,38vh,400px)}
.hero-spec .box,.hero-spec .slot{width:var(--hb);height:var(--hb);border-radius:calc(var(--hb) * 0.24)}
h2{font-size:clamp(30px,4.2vw,56px);line-height:1.05;letter-spacing:-0.025em;font-weight:600;margin:0 0 10px;overflow-wrap:anywhere}
.lede{font-size:clamp(20px,2.2vw,26px);line-height:1.4;letter-spacing:-0.01em;max-width:34em;margin:0 0 20px}
.quiet{color:var(--mute)}
.small{font-size:15px}
em{font-style:normal;color:var(--ink)}
.notes{padding:0;list-style:none;margin:24px 0 0;max-width:40em}
.notes li{margin:0 0 8px}
.motion{padding:clamp(80px,14vh,170px) 0 0}
.sel{margin:0 0 40px;overflow-wrap:anywhere}
.law{margin:0 0 clamp(64px,10vh,120px)}
.headline{font-size:clamp(24px,3vw,38px);line-height:1.2;letter-spacing:-0.02em;font-weight:500;margin:0 0 6px;max-width:26em}
.label{font-size:0.5em;font-weight:400;color:var(--mute);letter-spacing:0;vertical-align:0.35em;margin-left:0.3em}
dd .label{font-size:15px;vertical-align:0}
.label-unknown{text-decoration:underline dotted;text-underline-offset:3px}
.specimen{margin:48px 0 40px;overflow-x:clip;overflow-y:visible;padding-block:8px}
.lane{display:grid;grid-template-columns:minmax(120px,180px) 1fr;align-items:center;gap:20px;min-height:84px}
.lane-word{color:var(--mute);font-size:15px}
.track{position:relative;height:64px;touch-action:none}
.track.dots{display:flex;align-items:center;gap:14px;height:64px}
.box{position:absolute;left:0;top:8px;width:48px;height:48px;border-radius:12px;box-shadow:inset 0 0 0 1.5px var(--band);will-change:transform}
.box .fill{position:absolute;inset:0;border-radius:inherit;background:var(--ink);will-change:opacity}
.slot{position:absolute;left:0;top:8px;width:48px;height:48px;border-radius:12px;background:var(--faint)}
.box.small{position:static;width:26px;height:26px;border-radius:7px;background:var(--ink);box-shadow:none}
.controls{display:flex;flex-wrap:wrap;align-items:center;gap:8px 28px;margin:18px 0 0;padding-left:calc(min(180px,max(120px,18%)) + 20px)}
button{font:inherit;color:var(--mute);background:none;border:0;padding:6px 0;cursor:pointer;transition:color .25s var(--ease)}
button:hover,button[aria-pressed=true],button[aria-selected=true]{color:var(--ink)}
button:focus-visible,input:focus-visible,summary:focus-visible{outline:2px solid var(--ink);outline-offset:4px;border-radius:4px}
.hint,.time{color:var(--mute);font-size:15px;font-variant-numeric:tabular-nums}
input[type=range]{-webkit-appearance:none;appearance:none;background:none;width:min(320px,100%);height:28px;margin:0}
input[type=range]::-webkit-slider-runnable-track{height:2px;background:var(--faint)}
input[type=range]::-moz-range-track{height:2px;background:var(--faint)}
input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:14px;height:14px;border-radius:50%;background:var(--ink);margin-top:-6px}
input[type=range]::-moz-range-thumb{width:14px;height:14px;border:0;border-radius:50%;background:var(--ink)}
.values{display:flex;flex-wrap:wrap;gap:20px 56px;margin:0 0 40px}
.values dt{color:var(--mute);font-size:15px}
.values dd{margin:2px 0 0;font-size:clamp(22px,2.4vw,30px);letter-spacing:-0.015em;font-variant-numeric:tabular-nums}
.chart{margin:0 0 40px}
.chart svg{display:block;width:100%;height:clamp(180px,28vw,300px);overflow:visible}
.chart .guide{stroke:var(--faint);stroke-width:1;vector-effect:non-scaling-stroke}
.chart .fit{fill:none;stroke:var(--ink);stroke-width:2.5;vector-effect:non-scaling-stroke;stroke-linejoin:round}
.chart .rec{fill:none;stroke:var(--band);stroke-width:12;stroke-linecap:round;stroke-linejoin:round;vector-effect:non-scaling-stroke}
.chart svg:hover .cursor{opacity:1}
.chart .cursor{opacity:0;stroke:var(--mute);stroke-width:1;vector-effect:non-scaling-stroke}
.chart figcaption{display:flex;justify-content:space-between;gap:16px;color:var(--mute);font-size:15px;margin-top:10px;font-variant-numeric:tabular-nums}
.chart .readout{text-align:center}
.more{display:flex;flex-wrap:wrap;align-items:baseline;column-gap:32px}
.more details{margin:0;min-width:0;max-width:100%}
.tabs,[role=tabpanel],.entry{min-width:0;max-width:100%}
.more details[open]{flex-basis:100%;margin:0 0 12px}
.more .chart{margin:16px 0 8px}
.tabs{margin:8px 0 8px}
[role=tablist]{display:flex;flex-wrap:wrap;gap:4px 28px;margin:0 0 14px}
[role=tab]{font-size:19px}
.entry-head{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:baseline;gap:0 24px;margin:14px 0 4px}
.fidelity{margin:0;font-size:15px;flex:1 1 18em;min-width:0;overflow-wrap:anywhere}
.tabs .small{overflow-wrap:anywhere}
.copy{font-size:15px;flex:none}
.entry pre{margin:0;padding:6px 0 10px;overflow-x:auto;font-family:var(--mono);font-size:13.5px;line-height:1.6;color:var(--ink)}
details{margin:8px 0 0;color:var(--mute)}
summary{cursor:pointer;color:var(--mute);list-style:none;display:inline-block;padding:6px 0;transition:color .25s var(--ease)}
summary::-webkit-details-marker{display:none}
summary:hover,details[open] summary{color:var(--ink)}
details ul{margin:10px 0 0;padding:0;list-style:none;max-width:44em}
details li{margin:0 0 8px}
footer{padding:clamp(80px,14vh,160px) 0 64px}
@media (max-width:640px){.lane{grid-template-columns:1fr;gap:4px;min-height:0;margin-bottom:14px}.controls{padding-left:0}.values{gap:16px 32px}}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
`;

// Specimen runtime: each specimen replays sampled progress (recorded and fitted) on a plain box; followers use the
// fitted law live (x += (target − x)·(1 − e^(−dt/τ)), frame-rate independent, the same form as the JS export).
const JS = `
(() => {
  const data = JSON.parse(document.getElementById('reva-data').textContent);
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const at = (pts, x) => {
    if (!pts.length) return 0; if (x <= pts[0][0]) return pts[0][1]; const n = pts.length; if (x >= pts[n - 1][0]) return pts[n - 1][1];
    let lo = 0, hi = n - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (pts[m][0] <= x) lo = m; else hi = m; }
    const a = pts[lo], b = pts[hi]; return a[1] + (b[1] - a[1]) * ((x - a[0]) / (b[0] - a[0] || 1));
  };
  // all channels of a law on one progress: position (normalised to the lane), scale, turn and fade as recorded
  const lerp = (q, a, b) => a + (b - a) * q;
  // a y motion runs on a vertical track (the hero) so the box moves on the axis it was measured on
  const tr = (ln, x) => (ln.v ? 'translateY(' : 'translateX(') + x + 'px)';
  // a position that decreased (moved up or left) is drawn moving up or left: the lane is mirrored
  const flipOf = (props) => props.some((q) => q.kind === 'x' && Number.isFinite(q.from) && Number.isFinite(q.to) && q.to < q.from);
  const apply = (ln, props, p, travel, lo, hi) => {
    let x = travel / 2, tf = '', op = 1;
    for (const q of props) {
      if (q.kind === 'x') x = flipOf(props) ? travel - ((p - lo) / (hi - lo)) * travel : ((p - lo) / (hi - lo)) * travel;
      else if (q.kind === 'scale') tf += ' scale(' + lerp(p, q.from ?? 0, q.to ?? 1) + ')';
      else if (q.kind === 'rotate') tf += ' rotate(' + lerp(p, q.from ?? 0, q.to ?? 90) + 'deg)';
      else if (q.kind === 'opacity') op = Math.min(1, Math.max(0, lerp(p, q.from ?? 0, q.to ?? 1)));
    }
    // the fill fades, the outline stays: a box that fades out leaves a faint ghost where it is, never a blank stage
    ln.boxes[0].style.transform = tr(ln, x) + tf; (ln.fill || ln.boxes[0]).style.opacity = op;
  };
  const startX = (props, travel, lo, hi) => (props.some((q) => q.kind === 'x') ? (flipOf(props) ? travel - ((0 - lo) / (hi - lo)) * travel : ((0 - lo) / (hi - lo)) * travel) : travel / 2);
  for (const el of document.querySelectorAll('[data-spec]')) {
    const s = data[el.dataset.spec]; if (!s) continue;
    const lanes = [...el.querySelectorAll('.lane')].map((l) => ({ k: l.dataset.lane, track: l.querySelector('.track'), boxes: [...l.querySelectorAll('.box')], fill: l.querySelector('.fill'), slot: l.querySelector('.slot'), v: !!l.querySelector('.track.v') }));
    const travelOf = (ln) => Math.max(0, ln.v ? ln.track.clientHeight - ((ln.boxes[0] && ln.boxes[0].offsetHeight) || 48) : ln.track.clientWidth - ((ln.boxes[0] && ln.boxes[0].offsetWidth) || 48));
    const hero = !!el.dataset.hero; const playBtn = el.querySelector('[data-act=play]');
    const timeEl = el.querySelector('.time'), scrub = el.querySelector('[data-act=scrub]'), slowBtn = el.querySelector('[data-act=slow]');
    if (s.axis === 'step') {
      const ln = lanes[0]; let x = 0, target = 0, last = 0, raf = 0;
      const tick = (now) => { const dt = last ? Math.min(64, now - last) : 16; last = now; x += (target - x) * (1 - Math.exp(-dt / s.tau)); ln.boxes[0].style.transform = 'translateX(' + x + 'px)'; if (Math.abs(target - x) > 0.05) raf = requestAnimationFrame(tick); else { raf = 0; last = 0; } };
      const go = () => { if (!raf) { last = 0; raf = requestAnimationFrame(tick); } };
      ln.track.addEventListener('pointermove', (e) => { const r = ln.track.getBoundingClientRect(); target = Math.min(travelOf(ln), Math.max(0, e.clientX - r.left - ln.boxes[0].offsetWidth / 2)); go(); });
      (playBtn || el).addEventListener('click', () => { target = target > travelOf(ln) / 2 ? 0 : travelOf(ln); go(); });
      continue;
    }
    // overshoot and anticipation stay inside the lane: the lane spans the lowest to the highest progress
    const ps = [...s.fit, ...s.rec].map((q) => q[1]); const lo = Math.min(0, ...ps), hi = Math.max(1, ...ps);
    const x0 = -s.lead, x1 = s.span + (s.axis === 'scroll' ? s.lead : s.span * 0.15);
    const sweepMs = s.axis === 'scroll' ? 2400 : (x1 - x0);
    let pos = x0, playing = false, speed = 1, last = 0, hold = 0;
    // a law that ends invisible (fades to opacity ~0) rests on its start state between loops, not on an empty stage
    const endP = at(s.fit.length ? s.fit : s.rec, x1);
    const fadesOut = s.props.some((q) => q.kind === 'opacity' && lerp(endP, q.from ?? 0, q.to ?? 1) < 0.15);
    const draw = () => {
      for (const ln of lanes) {
        const T = travelOf(ln);
        if (ln.k === 'stagger' && s.stagger) ln.boxes.forEach((b, i) => { const p = at(s.fit, pos - i * s.stagger.interval); b.style.transform = 'translateY(' + (1 - p) * 18 + 'px)'; b.style.opacity = Math.min(1, Math.max(0, p)); });
        else { apply(ln, s.props, at(ln.k === 'rec' ? s.rec : s.fit, pos), T, lo, hi); if (ln.slot) ln.slot.style.transform = tr(ln, startX(s.props, T, lo, hi)); }
      }
      if (timeEl) timeEl.textContent = Math.round(pos) + (s.axis === 'scroll' ? ' px' : ' ms');
      if (scrub && !scrub.matches(':active')) scrub.value = Math.round(((pos - x0) / (x1 - x0)) * 1000);
    };
    const tick = (now) => {
      if (!playing) return; const dt = last ? now - last : 0; last = now;
      if (hold > 0) { hold -= dt; if (hold <= 0) pos = x0; }
      else { pos += (dt * speed * (x1 - x0)) / sweepMs; if (pos >= x1) { pos = x1; hold = el.dataset.loop ? 1100 : 0; if (el.dataset.loop && fadesOut) pos = x0; if (!el.dataset.loop) playing = false; } }
      draw(); if (playing) requestAnimationFrame(tick);
    };
    const play = (loop) => { if (loop) el.dataset.loop = '1'; else delete el.dataset.loop; pos = x0; hold = 0; last = 0; if (!playing) { playing = true; requestAnimationFrame(tick); } };
    if (playBtn) playBtn.addEventListener('click', () => play(false));
    if (hero) el.addEventListener('click', () => play(!reduce));
    if (slowBtn) slowBtn.addEventListener('click', () => { speed = speed === 1 ? 0.25 : 1; slowBtn.setAttribute('aria-pressed', String(speed !== 1)); });
    if (scrub) scrub.addEventListener('input', () => { playing = false; delete el.dataset.loop; pos = x0 + (scrub.value / 1000) * (x1 - x0); draw(); });
    draw(); addEventListener('resize', draw);
    if (!reduce && 'IntersectionObserver' in window) new IntersectionObserver((es) => { for (const e of es) { if (e.isIntersecting && !playing && el.dataset.auto !== 'off') play(true); else if (!e.isIntersecting && el.dataset.loop) { playing = false; } } }, { threshold: 0.4 }).observe(el);
    if (!hero) el.addEventListener('pointerdown', () => { el.dataset.auto = 'off'; }, { once: true });
  }
  // chart readout: the recorded and fitted progress under the pointer
  for (const fig of document.querySelectorAll('[data-chart]')) {
    const s = data[fig.dataset.chart]; if (!s) continue; const svg = fig.querySelector('svg'), cur = fig.querySelector('.cursor'), out = fig.querySelector('.readout'), idle = out.textContent;
    const x0 = +fig.dataset.x0, x1 = +fig.dataset.x1; const unit = s.axis === 'scroll' ? ' px' : ' ms';
    svg.addEventListener('pointermove', (e) => {
      const r = svg.getBoundingClientRect(); const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)); const x = x0 + f * (x1 - x0);
      cur.setAttribute('x1', f * 1000); cur.setAttribute('x2', f * 1000);
      const pct = (p) => Math.round(p * 1000) / 10 + ' %';
      out.textContent = Math.round(x) + unit + (s.rec.length ? ' · recorded ' + pct(at(s.rec, x)) : '') + (s.fit.length ? ' · fitted ' + pct(at(s.fit, x)) : '') + ' of the travel';
    });
    svg.addEventListener('pointerleave', () => { cur.setAttribute('x1', -10); cur.setAttribute('x2', -10); out.textContent = idle; });
  }
  // tabs (arrow keys move between them) and copy
  for (const list of document.querySelectorAll('[role=tablist]')) {
    const ts = [...list.querySelectorAll('[role=tab]')];
    const pick = (t) => { for (const o of ts) { const on = o === t; o.setAttribute('aria-selected', on); o.tabIndex = on ? 0 : -1; document.getElementById(o.getAttribute('aria-controls')).hidden = !on; } };
    ts.forEach((t, i) => { t.addEventListener('click', () => pick(t)); t.addEventListener('keydown', (e) => { const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0; if (d) { const n = ts[(i + d + ts.length) % ts.length]; pick(n); n.focus(); } }); });
  }
  for (const b of document.querySelectorAll('.copy')) b.addEventListener('click', async () => {
    const code = b.closest('.entry').querySelector('code'); const t = code.textContent;
    try { await navigator.clipboard.writeText(t); b.textContent = 'Copied'; } catch { const r = document.createRange(); r.selectNodeContents(code); const s = getSelection(); s.removeAllRanges(); s.addRange(r); b.textContent = 'Selected'; }
    setTimeout(() => { b.textContent = 'Copy'; }, 1400);
  });
})();
`;
