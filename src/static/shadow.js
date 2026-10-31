// box-shadow / text-shadow computed strings -> layers. Splits on TOP-LEVEL commas only (colours contain commas).
export function splitTopLevel(str, sep = ',') {
  const out = []; let depth = 0, cur = '';
  for (const ch of str) {
    if (ch === '(') depth++; else if (ch === ')') depth--;
    if (ch === sep && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
const tokens = layer => {
  const t = []; let depth = 0, cur = '';
  for (const ch of layer) {
    if (ch === '(') depth++; else if (ch === ')') depth--;
    if (/\s/.test(ch) && depth === 0) { if (cur) t.push(cur); cur = ''; } else cur += ch;
  }
  if (cur) t.push(cur);
  return t;
};
const isLen = t => /^-?[\d.]+(px|em|rem)?$/.test(t);

/** @returns {Array<{inset:boolean,x:number,y:number,blur:number,spread:number|null,color:string|null}>|null} null for "none". */
export function parseShadowList(str, { text = false } = {}) {
  if (!str || str === 'none') return null;
  return splitTopLevel(str).map(layer => {
    const t = tokens(layer);
    const inset = t.includes('inset');
    const lens = t.filter(isLen).map(parseFloat);
    const color = t.find(x => !isLen(x) && x !== 'inset') ?? null;
    return { inset, x: lens[0] ?? 0, y: lens[1] ?? 0, blur: lens[2] ?? 0, spread: text ? null : (lens[3] ?? 0), color };
  });
}
