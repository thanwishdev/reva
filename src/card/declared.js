// The card's section for paint-only motion (colour, background, shadow transitions the page declares): a plain list of
// look.json "declaredOnly". Data only, no layout ideas of its own (the card's look is redesigned separately).
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const KIND = { 'css-transition': 'CSS transition', 'css-animation': 'CSS animation', waapi: 'Web Animation' };

export function declaredSection(list) {
  if (!Array.isArray(list) || !list.length) return '';
  const items = list.map((d) => `<li><strong>${esc(d.desc)}</strong>${d.selector ? ` <span class="quiet">${esc(d.selector)}</span>` : ''}<br>${esc(KIND[d.kind] || 'Animation')}, ${esc(d.durationMs)} ms <span class="dl">exact</span>, ${esc(d.easing || 'easing not a single curve')} <span class="dl">exact</span>${d.delayMs ? `, delay ${esc(d.delayMs)} ms <span class="dl">exact</span>` : ''}
<br>${(d.properties || []).map((p) => `${esc(p.word || p.prop)}${p.from != null ? `: ${esc(p.from)} → ${esc(p.to)}` : ''}`).join('<br>')}</li>`).join('\n');
  return `<section class="declared" aria-label="Colour and shadow changes">
  <h2>Colour, background and shadow</h2>
  <p class="quiet">The page declares these changes; timing, easing and end values are read from its CSS, not measured. The colour between the end values is not sampled frame by frame.</p>
  <ul>
${items}
  </ul>
</section>`;
}
