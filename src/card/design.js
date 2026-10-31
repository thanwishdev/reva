// The card's design section: a plain listing of look.json "design" (src/design/summary.js). Data only, no layout ideas
// of its own (the card's look is redesigned separately). Every value shows its unit and label (exact / measured /
// derived). Colours come out of the summary as hex we built ourselves; they are checked again before a swatch uses one.
import { queryList } from '../design/text.js';
import { designGaps } from '../design/summary.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const n = (x) => (typeof x === 'number' ? String(Math.round(x * 100) / 100) : String(x ?? '?'));
const HEX = /^#[0-9a-f]{6}([0-9a-f]{2})?$/i;
const sw = (h) => (HEX.test(h) ? `<span class="sw" style="background:${h}"></span>` : '');
const lab = (l) => (l ? ` <span class="dl dl-${esc(l)}">${esc(l)}</span>` : '');
/** "20.8 px exact (1.3rem)" */
const v = (x) => (x == null ? '—' : typeof x !== 'object' ? esc(x) : `${esc(n(x.value))}${x.unit ? (x.unit === ':1' ? ':1' : ` ${esc(x.unit)}`) : ''}${lab(x.label)}${x.css && x.css !== String(x.value) ? ` <span class="quiet">(${esc(x.css)})</span>` : ''}`);
const tags = (o) => esc(Object.entries(o || {}).map(([t, c]) => `${t} ×${c}`).join(', '));
const table = (head, rows) => (rows.length ? `<div class="dz-wrap"><table class="dz"><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : '<p class="quiet small">none found</p>');

export function designSection(d) {
  if (!d) return '';
  if (d.ok === false) return `<section class="design"><h2>Design</h2><p class="quiet">${esc(d.error)}</p></section>`;
  const T = d.type, P = d.palette, C = d.contrast, S = d.spacing, Y = d.layout, B = d.breakpoints;
  const parts = [];
  parts.push(`<h3>Fonts</h3>${table(['family', 'source', 'weights', 'used on', 'elements'], d.fonts.families.map((f) => [
    `${esc(f.family)}${f.fallbacks.length ? ` <span class="quiet">then ${esc(f.fallbacks.join(', '))}</span>` : ''}`,
    f.loaded === false ? `declared webfont did not load; drawn as ${esc(f.drawnAs && f.drawnAs.length ? f.drawnAs.join(', ') : 'a fallback face')}${lab('measured')}` : v(f.source), esc(f.weights.join(', ')) + (f.styles.includes('italic') ? ' + italic' : ''), tags(f.roles), esc(f.elements)]))}`
    + `${d.fonts.notLoaded ? `<p class="small">${esc(d.fonts.notLoaded)} declared webfont(s) did not load: the type metrics below were measured with the fallback face.</p>` : ''}`
    + `${d.fonts.rendered && d.fonts.rendered.length ? `<p class="quiet small">Drawn with: ${esc([...new Set(d.fonts.rendered.map((r) => `${r.name} (${r.custom ? 'webfont' : 'system'})`))].join(', '))}${lab('measured')}</p>` : ''}`);
  parts.push(`<h3>Type</h3><p class="quiet small">${T.order === 'largest size first' ? 'Largest first' : 'Most used first'}${T.bodySize ? `; body size ${v(T.bodySize)}` : ''}. Line height and tracking also as a ratio of the size.</p>${table(['', 'role', 'size', 'weight', 'line height', 'tracking', 'family', 'used on'], T.styles.map((s) => [
    esc(s.id), esc(s.role) + (s.transform ? ` <span class="quiet">${esc(s.transform.value ?? 'transform withheld')}</span>` : ''), v(s.size), v(s.weight),
    s.lineHeight.value === 'normal' ? `normal${s.lineHeight.used ? ` (${v(s.lineHeight.used)})` : ''}` : `${v(s.lineHeight)}${s.lineHeight.ratio ? ` <span class="quiet">= ${esc(n(s.lineHeight.ratio.value))}×</span>` : ''}`,
    s.letterSpacing.value === 'normal' ? 'normal' : `${v(s.letterSpacing)}${s.letterSpacing.em ? ` <span class="quiet">= ${esc(String(Math.round(s.letterSpacing.em.value * 1e4) / 1e4))} em</span>` : ''}`,
    esc(s.family || '—'), tags(s.usedOn)]))}${T.more ? `<p class="quiet small">${esc(T.more)} rarer style(s) not listed.</p>` : ''}${d.settle && d.settle.textStable === false ? '<p class="quiet small">Text sizes were still changing when the page was read (script-sized text): sizes may be from mid-change.</p>' : ''}`
    + `<p class="small">Sizes: ${esc(T.scale.map((x) => n(x.size.value)).join(' / '))} px${lab('measured')}${d.mobile ? `<br>At ${esc(d.mobile.viewport.width)} px wide: ${esc(d.mobile.typeSizes.map((x) => n(x.size.value)).join(' / '))} px${lab('measured')}` : ''}</p>`);
  parts.push(`<h3>Colours</h3><p class="quiet small">Role is derived from how each colour is used.</p>${table(['', 'colour', 'role', 'used as', 'elements'], P.colours.map((c) => [
    sw(c.hex.value), `${v(c.hex)}${c.alpha < 1 ? ` <span class="quiet">alpha ${esc(c.alpha)}</span>` : ''}`, esc(c.role), tags(c.uses), esc(c.count)]))}`
    + `<p class="small">${P.pageBackground ? `Page background ${sw(P.pageBackground.hex.value)} ${v(P.pageBackground.hex)} <span class="quiet">(${esc(P.pageBackground.from === 'browser default canvas' ? 'html and body transparent: the default canvas' : `from ${P.pageBackground.from}`)})</span><br>` : ''}`
    + `Main background (most visible area) ${P.mainBackground ? `${sw(P.mainBackground)} ${esc(P.mainBackground)}` : '?'} · most used background ${P.mostUsedBackground ? esc(P.mostUsedBackground) : '?'} · main text ${P.mainText ? `${sw(P.mainText)} ${esc(P.mainText)}` : '?'}${lab('derived')}</p>`);
  parts.push(`<h3>Contrast</h3><p class="small">${esc(C.textElements)} text element(s) graded, ${esc(C.failingPairs)} pair(s) under AA (${esc(C.failingElements)} element(s))${[C.overImage ? `${C.overImage} over a CSS image or gradient` : '', C.overMedia ? `${C.overMedia} over an image, video or canvas` : '', C.overlapped ? `${C.overlapped} over another element's background` : '', C.noBackground ? `${C.noBackground} with no background colour set` : '', C.hidden ? `${C.hidden} hidden (opacity 0)` : ''].filter(Boolean).map((x, i) => `${i ? ', ' : '; not graded: '}${esc(x)}`).join('')}${lab('derived')}</p>${table(['text', 'background', 'ratio', 'grade', 'elements', 'smallest'], C.pairs.map((p) => [
    `${sw(p.text)} ${esc(p.text)}`, `${sw(p.background)} ${esc(p.background)}`, v(p.ratio), esc(p.grade), esc(p.count), v(p.smallestSize)]))}`);
  parts.push(`<h3>Spacing</h3><p class="small">${S.base ? `Base ${v(S.base)}. ` : ''}${S.values.map((x) => `${esc(n(x.value))}${x.label === 'exact' ? '*' : ''}`).join(' · ')} px <span class="quiet">(* exact, from the page CSS; the rest measured)</span>${S.negative ? `<br>${esc(S.negative)} negative margin(s)` : ''}</p>`);
  parts.push(`<h3>Radii</h3>${table(['radius', 'elements'], d.radii.values.map((r) => [r.corners ? `${esc(Object.values(r.corners).map((x) => x ?? 'withheld').join(' '))}${lab(r.label)}` : v(r), esc(r.count)]))}`);
  parts.push(`<h3>Shadows</h3>${table(['kind', 'layers (x y blur spread, px)', 'elements'], d.shadows.values.map((s) => [esc(s.kind) + lab(s.label),
    s.layers.map((y) => `${sw(y.color)} ${y.inset ? 'inset ' : ''}${esc([y.x, y.y, y.blur, y.spread].filter((z) => z != null).map(n).join(' '))} ${esc(y.color)}`).join('<br>'), esc(s.count)]))}`);
  parts.push(`<h3>Layout</h3><p class="small">Page ${v(Y.documentHeight)} tall at ${esc(Y.viewport.width)} px wide.${Y.containers.length ? `<br>Content widths (centred): ${Y.containers.map((c) => `${v(c.width)} ×${esc(c.count)}`).join(', ')}` : ''}`
    + `${Y.grids.length ? `<br>Grids: ${Y.grids.map((g) => `${esc(g.columns)} columns (${esc(g.tracks.map(n).join(' '))} px${g.gap ? `, gap ${esc(n(g.gap))} px` : ''}) ×${esc(g.count)}`).join('; ')}${lab('measured')}` : ''}`
    + `${Y.flexRows.length ? `<br>Rows of items: ${Y.flexRows.map((f) => `${esc(f.items)} items${f.gap ? `, gap ${esc(n(f.gap))} px` : ''} ×${esc(f.count)}`).join('; ')}${lab('measured')}` : ''}`
    + `${Y.sections ? `<br>${esc(Y.sections.count)} full-width sections: heights ${esc(Y.sections.heights.map(n).join(' / '))} px${Y.sections.padding ? `; padding ${esc(n(Y.sections.padding.top))} / ${esc(n(Y.sections.padding.bottom))} px` : ''}${lab('measured')}` : ''}</p>`);
  parts.push(`<h3>Breakpoints</h3>${table(['width', 'explained by'], B.layoutChanges.map((e) => [`${esc(n(e.at))} px${lab('measured')}`, e.query ? `${(e.queries || [e.query]).length > 1 ? 'any of: ' : ''}${esc(queryList(e))}${lab('exact')}` : '<span class="quiet">no media query</span>']))}`
    + `${B.declared.length ? `<p class="quiet small">Declared: ${esc(B.declared.map((q) => (q.dependsOnHeight ? `${q.query} (depends on the viewport height)` : `${q.query} (${q.edges.join(', ')} px)`)).join(' | '))}</p>` : ''}`);
  parts.push(`<h3>Hover and focus</h3>${table(['element', 'state', 'what changes', 'elements'], d.states.changes.map((g) => [esc(g.on || '?'), esc(g.state),
    g.changes.map((c) => `${esc(c.property)}: ${HEX.test(c.from) ? sw(c.from) : ''}${esc(c.from ?? '?')} → ${HEX.test(c.to) ? sw(c.to) : ''}${esc(c.to ?? '?')}`).join('<br>'), esc(g.count)]))}`);
  parts.push(`<h3>Custom properties</h3><p class="small">${esc(d.customProperties.count)} on the page (${esc(Object.entries(d.customProperties.byKind).map(([k, c]) => `${c} ${k}`).join(', '))})${lab(d.customProperties.label || 'exact')}${d.customProperties.unreadableSheets ? ` <span class="quiet">${esc(d.customProperties.unreadableSheets)} stylesheet(s) from another origin could not be read: a floor</span>` : ''}</p>`);
  const G = d.gaps || designGaps(d);
  parts.push(`<h3>Not measured</h3>${G.length ? `<p class="small">${G.map((g) => `${esc(g.count)} × ${esc(g.what)}`).join('<br>')}</p>` : '<p class="quiet small">nothing recorded as unknown</p>'}`);
  return `<section class="design" aria-label="Design">
  <h2>Design</h2>
  <p class="quiet">How the page is designed, read at ${esc(d.viewport.width)}×${esc(d.viewport.height)} px${d.scheme && d.scheme.colorScheme ? ` in the ${esc(d.scheme.colorScheme)} colour scheme` : ''} in a separate session${d.timing ? ` (${esc((d.timing.ms / 1000).toFixed(1))} s)` : ''}. <em>exact</em> is the page's own CSS value, <em>measured</em> is what the browser computed, <em>derived</em> is our arithmetic.</p>
  ${parts.join('\n  ')}
</section>`;
}

export const DESIGN_CSS = `
.design{padding:clamp(80px,14vh,170px) 0 0}
.design h3{font-size:20px;font-weight:600;margin:40px 0 10px}
.dz-wrap{overflow-x:auto}
.dz{border-collapse:collapse;font-size:15px;width:100%}
.dz th,.dz td{text-align:left;padding:6px 12px 6px 0;border-bottom:1px solid var(--faint);vertical-align:top}
.dz th{font-weight:500;color:var(--mute)}
.sw{display:inline-block;width:14px;height:14px;border-radius:3px;vertical-align:-2px;box-shadow:inset 0 0 0 1px var(--band)}
.dl{font-size:13px;color:var(--mute);margin-left:4px}
`;
