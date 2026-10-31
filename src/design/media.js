// Media / container condition evaluator for the derived views (stage D3). Pure: evaluates a recorded condition text
// (as the engine serialised it in the rule table) against an environment, with three-valued logic: true / false /
// null (a feature this evaluator does not know, or a style() / scroll-state() container query). null is reported,
// never guessed. Used to say which rules start or stop applying at a measured breakpoint edge, from the rule table
// alone (no browser): the engine already parsed the conditions; only the comparison is done here.

const EM = 16; // initial font-size: media query em/rem resolve against it (not the root's font-size)

/** Length in px, or null. */
export function lengthPx(v, env = {}) {
  const m = /^(-?[\d.]+(?:e-?\d+)?)(px|em|rem|vw|vh|vmin|vmax|cm|mm|in|pt|pc|q)?$/i.exec(String(v).trim());
  if (!m) return null;
  const n = parseFloat(m[1]);
  switch ((m[2] || '').toLowerCase()) {
    case '': return n === 0 ? 0 : null;
    case 'px': return n;
    case 'em': case 'rem': return n * EM;
    case 'vw': return env.w != null ? n * env.w / 100 : null;
    case 'vh': return env.h != null ? n * env.h / 100 : null;
    case 'vmin': return env.w != null ? n * Math.min(env.w, env.h) / 100 : null;
    case 'vmax': return env.w != null ? n * Math.max(env.w, env.h) / 100 : null;
    case 'cm': return n * 96 / 2.54; case 'mm': return n * 96 / 25.4; case 'q': return n * 96 / 101.6;
    case 'in': return n * 96; case 'pt': return n * 96 / 72; case 'pc': return n * 16;
  }
  return null;
}
const ratio = v => { const m = /^([\d.]+)\s*(?:\/\s*([\d.]+))?$/.exec(String(v).trim()); return m ? parseFloat(m[1]) / (m[2] ? parseFloat(m[2]) : 1) : null; };
const resolution = v => { const m = /^([\d.]+)(dppx|x|dpi|dpcm)$/i.exec(String(v).trim()); if (!m) return null; const n = parseFloat(m[1]); return { dppx: n, x: n, dpi: n / 96, dpcm: n * 2.54 / 96 }[m[2].toLowerCase()]; };

/** Environment of one viewport (or one container for kind 'container'). reducedMotion defaults to 'no-preference', the
 *  env the gate and capture replay in (D-CORPUS-1); pass 'reduce' for a reduced-motion capture. */
export function mediaEnv({ w, h, dpr = 1, touch = false, reducedMotion = 'no-preference', colorScheme = 'light', scripting = 'enabled' }) {
  return { w, h, dpr, touch, reducedMotion, colorScheme, scripting };
}

// numeric features: value getter + parser of the compared value
function numeric(name, env, kind) {
  const n = name.toLowerCase();
  if (kind === 'container') {
    if (n === 'width' || n === 'inline-size') return env.w != null ? [env.w, lengthPx] : undefined;
    if (n === 'height' || n === 'block-size') return env.h != null ? [env.h, lengthPx] : [null, lengthPx];
    if (n === 'aspect-ratio') return [env.w != null && env.h != null ? env.w / env.h : null, ratio];
    return undefined;
  }
  if (n === 'width') return [env.w, lengthPx];
  if (n === 'height') return [env.h, lengthPx];
  if (n === 'device-width') return [env.w, lengthPx];
  if (n === 'device-height') return [env.h, lengthPx];
  if (n === 'aspect-ratio' || n === 'device-aspect-ratio') return [env.w / env.h, ratio];
  if (n === 'resolution') return [env.dpr, resolution];
  if (n === '-webkit-device-pixel-ratio' || n === 'device-pixel-ratio') return [env.dpr, parseFloat];
  if (n === 'color') return [8, parseFloat];
  if (n === 'monochrome') return [0, parseFloat];
  if (n === 'color-index') return [0, parseFloat];
  return undefined;
}
// discrete features: current value (null = not known to this evaluator)
function discrete(name, env, kind) {
  const n = name.toLowerCase();
  if (kind === 'container') return n === 'orientation' ? (env.h == null ? null : env.h >= env.w ? 'portrait' : 'landscape') : undefined;
  const coarse = !!env.touch;
  return {
    orientation: env.h >= env.w ? 'portrait' : 'landscape',
    'prefers-color-scheme': env.colorScheme, 'prefers-reduced-motion': env.reducedMotion,
    'prefers-contrast': 'no-preference', 'prefers-reduced-transparency': 'no-preference', 'prefers-reduced-data': 'no-preference',
    'forced-colors': 'none', 'inverted-colors': 'none', scripting: env.scripting, 'display-mode': 'browser',
    hover: coarse ? 'none' : 'hover', 'any-hover': coarse ? 'none' : 'hover', pointer: coarse ? 'coarse' : 'fine', 'any-pointer': coarse ? 'coarse' : 'fine',
    'dynamic-range': 'standard', 'video-dynamic-range': 'standard', update: 'fast', 'overflow-block': 'scroll', 'overflow-inline': 'scroll',
    grid: '0', 'color-gamut': 'srgb',
  }[n];
}

function cmp(a, op, b) { const e = 1e-9; return op === '<' ? a < b - e : op === '<=' ? a <= b + e : op === '>' ? a > b + e : op === '>=' ? a >= b - e : Math.abs(a - b) <= e; }
const flip = { '<': '>', '<=': '>=', '>': '<', '>=': '<=', '=': '=' };

/** One parenthesised feature: "width >= 600px", "min-width: 600px", "hover", "400px < width <= 700px". */
function feature(text, env, kind) {
  const t = text.trim();
  // range syntax
  const R = /^(.+?)\s*(<=|>=|<|>|=)\s*(.+?)(?:\s*(<=|>=|<|>|=)\s*(.+))?$/.exec(t);
  if (R && !t.includes(':')) {
    const isName = s => /^-?[a-z][\w-]*$/i.test(s.trim()) && lengthPx(s) === null;
    const parts = [R[1], R[3], R[5]].filter(x => x != null).map(s => s.trim());
    const ops = [R[2], R[4]].filter(Boolean);
    const ni = parts.findIndex(isName);
    if (ni < 0) return null;
    const g = numeric(parts[ni], env, kind);
    if (!g) return null;
    const [cur, parse] = g;
    if (cur == null) return null;
    let ok = true;
    for (let k = 0; k < ops.length; k++) {
      const left = parts[k], right = parts[k + 1];
      if (k === ni) { const v = parse(right, env); if (v == null) return null; ok = ok && cmp(cur, ops[k], v); }
      else if (k + 1 === ni) { const v = parse(left, env); if (v == null) return null; ok = ok && cmp(cur, flip[ops[k]], v); }
    }
    return ok;
  }
  const c = t.indexOf(':');
  const name = (c < 0 ? t : t.slice(0, c)).trim().toLowerCase(), val = c < 0 ? null : t.slice(c + 1).trim();
  const pre = /^(min|max)-(.+)$/.exec(name);
  if (pre) {
    const g = numeric(pre[2], env, kind);
    if (!g || g[0] == null) return null;
    const v = g[1](val, env); if (v == null) return null;
    return cmp(g[0], pre[1] === 'min' ? '>=' : '<=', v);
  }
  const g = numeric(name, env, kind);
  if (g) { if (g[0] == null) return null; if (val == null) return g[0] !== 0; const v = g[1](val, env); return v == null ? null : cmp(g[0], '=', v); }
  const d = discrete(name, env, kind);
  if (d === undefined || d === null) return null;
  if (val == null) return !['none', 'no-preference', '0'].includes(d);
  return d === val.toLowerCase();
}

// three-valued logic
const and3 = (a, b) => (a === false || b === false ? false : a === null || b === null ? null : true);
const or3 = (a, b) => (a === true || b === true ? true : a === null || b === null ? null : false);
const not3 = a => (a === null ? null : !a);

function splitTopWord(s, word) {
  const out = []; let d = 0, cur = '';
  const re = new RegExp(`^\\s${word}\\s`, 'i');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '(') d++; else if (ch === ')') d--;
    if (d === 0 && re.test(s.slice(i, i + word.length + 2))) { out.push(cur); cur = ''; i += word.length; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map(x => x.trim()).filter(Boolean);
}
const wrapped = s => { if (!s.startsWith('(') || !s.endsWith(')')) return false; let d = 0; for (let i = 0; i < s.length; i++) { if (s[i] === '(') d++; else if (s[i] === ')') d--; if (d === 0 && i < s.length - 1) return false; } return true; };

/** A <media-condition> / container condition: "(a) and (b)", "(a) or (b)", "not (a)", nested. */
export function evalCondition(text, env, kind = 'media') {
  let s = String(text).trim();
  if (!s) return true;
  if (/^not\s/i.test(s)) return not3(evalCondition(s.slice(4), env, kind));
  const ors = splitTopWord(s, 'or'); if (ors.length > 1) return ors.map(x => evalCondition(x, env, kind)).reduce(or3);
  const ands = splitTopWord(s, 'and'); if (ands.length > 1) return ands.map(x => evalCondition(x, env, kind)).reduce(and3);
  if (wrapped(s)) {
    const inner = s.slice(1, -1).trim();
    if (inner.startsWith('(') || /^not\s/i.test(inner)) return evalCondition(inner, env, kind);
    return feature(inner, env, kind);
  }
  if (/^(style|scroll-state)\(/i.test(s)) return null;
  return null;
}

/** A media query list (comma-separated). '' / 'all' = true. */
export function evalMedia(list, env) {
  const qs = []; let d = 0, cur = '';
  for (const ch of String(list ?? '')) { if (ch === '(') d++; else if (ch === ')') d--; if (ch === ',' && d === 0) { qs.push(cur); cur = ''; } else cur += ch; }
  qs.push(cur);
  const one = q => {
    let s = q.trim(); if (!s) return true;
    let neg = false;
    const m = /^(not|only)\s+/i.exec(s);
    if (m && !s.slice(m[0].length).startsWith('(')) { neg = m[1].toLowerCase() === 'not'; s = s.slice(m[0].length); }
    const tm = /^([a-z-]+)(?:\s+and\s+([\s\S]+))?$/i.exec(s);
    let r;
    if (tm && !['not'].includes(tm[1].toLowerCase())) {
      const type = tm[1].toLowerCase();
      const tv = type === 'all' || type === 'screen' ? true : type === 'print' || ['tv', 'speech', 'handheld', 'projection', 'braille', 'embossed', 'aural', 'tty'].includes(type) ? false : null;
      r = tm[2] ? and3(tv, evalCondition(tm[2], env)) : tv;
    } else r = evalCondition(s, env);
    return neg ? not3(r) : r;
  };
  return qs.map(one).reduce(or3);
}
