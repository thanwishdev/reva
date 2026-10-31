// A control's declared CSS transition, read from computed style (transition-property / -duration / -timing-function / -delay):
// how a :hover / :focus change animates, not only where it ends. Pure (string in, rows out): unit-tested without a browser.

/** Split a CSS list on top-level commas ("ease, cubic-bezier(0.2, 0, 0, 1)" is two items, not five). */
export function splitTop(s) {
  const out = []; let depth = 0, cur = '';
  for (const ch of String(s ?? '')) {
    if (ch === '(') depth++; else if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim() || out.length) out.push(cur.trim());
  return out.filter((x) => x !== '');
}
const ms = (t) => { const m = /^(-?[\d.]+)(ms|s)$/.exec(String(t).trim()); return m ? Math.round((m[2] === 's' ? +m[1] * 1000 : +m[1]) * 100) / 100 : null; };

/**
 * Computed style map -> [{property, duration, easing, delay}] (ms). The four lists cycle to the length of transition-property
 * (CSS rule). Rows that cannot animate (duration 0 and delay 0) are dropped; none left -> [].
 */
export function declaredTransition(cs) {
  if (!cs) return [];
  const props = splitTop(cs['transition-property']); if (!props.length || (props.length === 1 && props[0] === 'none')) return [];
  const dur = splitTop(cs['transition-duration']), ease = splitTop(cs['transition-timing-function']), del = splitTop(cs['transition-delay']);
  const at = (l, i, d) => (l.length ? l[i % l.length] : d);
  const out = [];
  props.forEach((p, i) => {
    const duration = ms(at(dur, i, '0s')), delay = ms(at(del, i, '0s'));
    if (!(duration > 0) && !(delay > 0)) return;
    out.push({ property: p, duration, easing: at(ease, i, 'ease'), delay: delay || 0 });
  });
  return out;
}

/** The transitions that cover the changed properties ("all", the property itself, or its shorthand: border-color covers border-top-color). */
export function transitionsFor(list, changedProps) {
  const covers = (t, p) => t.property === 'all' || t.property === p || p.startsWith(`${t.property}-`) || (t.property === 'border-color' && /^border-.*-color$/.test(p)) || (t.property === 'border-radius' && /^border-.*-radius$/.test(p));
  return (list || []).filter((t) => changedProps.some((p) => covers(t, p)));
}
