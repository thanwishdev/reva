// The element table of a page at rest (PLAN §8): every visible element with its box and the values a person asks about, so an
// element that never moves can be inspected on the stage too. Styles repeat, so each distinct one is stored once.
import fs from 'node:fs';
import path from 'node:path';

/** In the page. Columns of `rows`: tag, selector, x, y (page), w, h, 1 when it stays put on scroll, text, style index. */
export function tableInPage() {
  const WR = window.__WR, styles = [], seen = new Map(), rows = [];
  const stuck = new Map();
  const isStuck = (e) => { if (!e || e === document.documentElement) return false; if (stuck.has(e)) return stuck.get(e); const p = getComputedStyle(e).position; const v = p === 'fixed' || isStuck(e.parentElement); stuck.set(e, v); return v; };
  for (const e of document.querySelectorAll('body, body *')) {
    const r = e.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) continue;
    const c = getComputedStyle(e);
    if (c.display === 'none' || c.visibility === 'hidden' || +c.opacity < 0.02) continue;
    const st = [c.fontFamily.split(',')[0].replace(/["']/g, '').trim(), c.fontSize, c.fontWeight, c.lineHeight, c.letterSpacing, c.color, c.backgroundColor, c.borderRadius, c.boxShadow === 'none' ? '' : c.boxShadow, c.display, c.position].join('|');
    let k = seen.get(st);
    if (k == null) { k = styles.length; styles.push(st); seen.set(st, k); }
    const own = [...e.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(' ').trim().slice(0, 60);
    const fx = isStuck(e) ? 1 : 0;
    let sel = null; try { sel = WR && WR.selectorOf ? WR.selectorOf(e) : null; } catch { /* no selector for this one */ }
    rows.push([e.localName, sel, Math.round(r.x), Math.round(r.y + (fx ? 0 : scrollY)), Math.round(r.width), Math.round(r.height), fx, own, k]);
  }
  return { styles, rows };
}

export const TABLE_FIELDS = ['font', 'size', 'weight', 'line', 'tracking', 'color', 'background', 'radius', 'shadow', 'display', 'position'];

/** Read the table and keep it next to the take's pictures; a failure leaves the stage with moving elements only. */
export async function writeTable(S, dir) {
  try {
    const t = await S.evRetry(tableInPage);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'table.json'), JSON.stringify(t));
    return t.rows.length;
  } catch { return null; }
}
