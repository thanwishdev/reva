// The compare card: one self-contained HTML page, one block per motion pair, A's and B's eased curves overlaid on one
// time axis (ms after the action; px of scroll for a scroll-linked value), the compared values beside them. Page text
// (descriptors, selectors) is escaped; nothing is loaded from the network.
import fs from 'node:fs';
import path from 'node:path';
import { channelWord } from '../look/words.js';
import { assertOutsideRepo } from '../util/paths.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])).replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, '');
const W = 520, H = 200, PAD = { l: 40, r: 12, t: 14, b: 28 };
const fmt = (x) => (x == null ? '–' : Math.abs(x) >= 10 ? String(Math.round(x * 10) / 10) : String(Math.round(x * 1000) / 1000));

/** One SVG: both curves (progress 0-1 against time or scroll), A solid, B dashed. */
export function curveSvg(plotA, plotB, axis = 'time') {
  const pts = [...(plotA || []), ...(plotB || [])];
  if (!pts.length) return '<p class="none">no curve to draw (neither side has a fitted law)</p>';
  let x0 = Math.min(...pts.map((p) => p[0])), x1 = Math.max(...pts.map((p) => p[0]));
  if (x1 - x0 < 1e-6) x1 = x0 + 1;
  const y0 = Math.min(0, ...pts.map((p) => p[1])), y1 = Math.max(1, ...pts.map((p) => p[1]));
  const X = (x) => PAD.l + ((x - x0) / (x1 - x0)) * (W - PAD.l - PAD.r);
  const Y = (y) => H - PAD.b - ((y - y0) / (y1 - y0)) * (H - PAD.t - PAD.b);
  const line = (pl) => (pl && pl.length ? pl.map((p, i) => `${i ? 'L' : 'M'}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join('') : '');
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => x0 + f * (x1 - x0));
  const unit = axis === 'scroll' ? 'px of scroll' : 'ms after the action';
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="A and B progress curves">
  <line class="grid" x1="${PAD.l}" x2="${W - PAD.r}" y1="${Y(0)}" y2="${Y(0)}"/><line class="grid" x1="${PAD.l}" x2="${W - PAD.r}" y1="${Y(1)}" y2="${Y(1)}"/>
  <text class="ax" x="${PAD.l - 6}" y="${Y(0) + 4}" text-anchor="end">0</text><text class="ax" x="${PAD.l - 6}" y="${Y(1) + 4}" text-anchor="end">1</text>
  ${ticks.map((t) => `<text class="ax" x="${X(t).toFixed(1)}" y="${H - 8}" text-anchor="middle">${Math.round(t)}</text>`).join('')}
  <text class="ax" x="${W - PAD.r}" y="${H - PAD.b - 4}" text-anchor="end">${unit}</text>
  <path class="a" d="${line(plotA)}"/><path class="b" d="${line(plotB)}"/>
</svg>`;
}

const ROWS = [['start', 'start'], ['duration', 'duration'], ['scrollStart', 'scroll start'], ['scrollEnd', 'scroll end'], ['curve', 'curve (max gap)'], ['from', 'from'], ['to', 'to'], ['law', 'law']];

function valueRows(ch) {
  return ROWS.filter(([k]) => ch.values[k]).map(([k, word]) => {
    const v = ch.values[k];
    const a = k === 'curve' ? '' : k === 'law' ? esc(v.a) : `${fmt(v.a)}${v.unit ? ` ${esc(v.unit)}` : ''}`;
    const b = k === 'curve' ? `${Math.round(v.maxDiff * 100)} % ${esc(v.where)}` : k === 'law' ? esc(v.b) : `${fmt(v.b)}${v.unit ? ` ${esc(v.unit)}` : ''}`;
    const lab = v.labels ? `<span class="lab">${esc(v.labels.a || '?')} / ${esc(v.labels.b || '?')}</span>` : '';
    return `<tr><td>${esc(word)}</td><td>${a}</td><td>${b}</td><td class="v ${v.verdict}">${esc(v.verdict)}</td><td>${lab}</td></tr>`;
  }).join('');
}

/** The whole page for a reva.compare/0 result. */
export function compareHtml(c) {
  const blocks = c.pairs.map((p) => {
    const chans = p.channels.map((ch) => `<div class="ch">
      <h3>${esc(channelWord(ch.channel))}${ch.segments && (ch.segments.a > 1 || ch.segments.b > 1) ? ` · segment ${ch.segment}` : ''} <span class="v ${ch.verdict}">${esc(ch.verdict)}</span></h3>
      ${curveSvg(ch.plot && ch.plot.a, ch.plot && ch.plot.b, ch.plot && ch.plot.axis)}
      <table><thead><tr><th></th><th>A</th><th>B</th><th></th><th>exact / fitted</th></tr></thead><tbody>${valueRows(ch)}</tbody></table>
    </div>`).join('');
    return `<section class="pair"><h2>${esc(p.a.desc)}${p.a.selector ? ` <code>${esc(p.a.selector)}</code>` : ''} <span class="v ${p.verdict}">${esc(p.verdict)}</span></h2>
      <p class="line">${esc(p.line)}</p>${p.pairedBy !== 'selector' ? `<p class="by">B: ${esc(p.b.desc)}${p.b.selector ? ` <code>${esc(p.b.selector)}</code>` : ''} (paired by ${esc(p.pairedBy)})</p>` : ''}
      ${chans}</section>`;
  }).join('\n');
  const only = [...c.onlyA.map((m) => `<li>only in A: ${esc(m.desc)}${m.selector ? ` <code>${esc(m.selector)}</code>` : ''}</li>`), ...c.onlyB.map((m) => `<li>only in B: ${esc(m.desc)}${m.selector ? ` <code>${esc(m.selector)}</code>` : ''}</li>`)].join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>REVA compare</title>
<style>
  :root { --ink: #16181d; --muted: #646a78; --paper: #fbfaf7; --line: #e4e0d8; --a: #16181d; --b: #e8572a; --same: #2f7d4f; --close: #a86a00; --different: #c0392b; }
  @media (prefers-color-scheme: dark) { :root { --ink: #ecebe7; --muted: #9da3b0; --paper: #15171b; --line: #2c2f36; --a: #ecebe7; --b: #ff7a4d; --same: #5cc28a; --close: #e0a63a; --different: #ff6b5c; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--paper); color: var(--ink); font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 1100px; margin: 0 auto; padding: 48px 16px 80px; }
  h1 { font-size: 26px; margin: 0 0 6px; } .src { color: var(--muted); margin: 0; word-break: break-all; }
  .headline { font-size: 20px; margin: 28px 0 8px; }
  .pair { border-top: 1px solid var(--line); padding: 28px 0; }
  h2 { font-size: 18px; margin: 0 0 6px; } h3 { font-size: 15px; margin: 18px 0 6px; font-weight: 600; }
  .line { margin: 0 0 4px; } .by { color: var(--muted); margin: 0; }
  code { font: 13px ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--muted); }
  .ch { display: grid; grid-template-columns: minmax(0, 1fr); gap: 4px; }
  @media (min-width: 900px) { .ch { grid-template-columns: 520px minmax(0, 1fr); column-gap: 28px; } .ch h3 { grid-column: 1 / -1; } }
  svg { width: 100%; max-width: 520px; height: auto; }
  svg .grid { stroke: var(--line); } svg .ax { fill: var(--muted); font-size: 11px; }
  svg path { fill: none; stroke-width: 2; } svg .a { stroke: var(--a); } svg .b { stroke: var(--b); stroke-dasharray: 6 4; }
  table { border-collapse: collapse; align-self: start; font-variant-numeric: tabular-nums; }
  td, th { padding: 4px 10px 4px 0; text-align: left; font-weight: normal; } th { color: var(--muted); font-size: 13px; }
  .lab { color: var(--muted); font-size: 13px; }
  .v { font-size: 13px; font-weight: 600; } .v.same { color: var(--same); } .v.close { color: var(--close); } .v.different { color: var(--different); } .v.unknown { color: var(--muted); }
  .key { color: var(--muted); font-size: 13px; margin-top: 8px; } .key b.a { color: var(--a); } .key b.b { color: var(--b); }
  ul.only { padding-left: 18px; } .none { color: var(--muted); }
</style></head>
<body><main>
<h1>Does B move like A?</h1>
<p class="src">A: ${esc(c.a.source)}</p><p class="src">B: ${esc(c.b.source)}</p>
<p class="src">action: ${esc(c.action.do || 'load')}${c.action.el ? ` · element ${esc(c.action.el)}` : ''}${c.action.on ? ` · trigger ${esc(c.action.on)}` : ''}</p>
<p class="headline">${esc(c.headline)}</p>
<p class="key"><b class="a">A solid</b> · <b class="b">B dashed</b> · progress of each value's travel (0 = its start value, 1 = its end value)</p>
${only ? `<ul class="only">${only}</ul>` : ''}
${blocks}
<p class="key">same = nobody would see it (time within 1 frame at 120 Hz or 3 %, curve within 2 % of the travel, position 1 px, opacity / scale 0.01) · close = within 4 frames or 10 %, curve 6 % · exact = read from the page, fitted = measured from the frames</p>
</main></body></html>
`;
}

/** Write compare.html; returns its path. Site-derived output: never inside the repo. */
export function writeCompareCard(c, file) {
  assertOutsideRepo(path.dirname(path.resolve(file)));
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, compareHtml(c));
  return file;
}
