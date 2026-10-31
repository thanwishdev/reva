// Design tokens export (stage D4): W3C Design Tokens (DTCG, format 2025.10) from the captured var() graph.
// One token per custom property. The BASE set = definitions on the root element with no condition (`:root`, `html`);
// every other definition (another selector, an @media / @supports / @container / @layer chain, an inline style) is a
// CONTEXT: its own DTCG set holding only the tokens it overrides, plus its selector and conditions.
// Values: a whole `var(--x)` becomes the alias "{x}"; var() inside a longer value stays CSS with "{x}" references in
// place (calc({gap} * 2)); literal colours in hex / rgb() become DTCG colour objects (srgb), px / rem lengths
// dimension objects, plain numbers numbers, cubic-bezier() arrays; anything else (oklch(), color-mix(), keywords,
// shorthands, durations) is kept as the authored CSS string without a $type, so nothing is converted lossily.
// Every token carries $extensions["com.reva"]: the custom property name, the authored text, the value the
// engine resolved (computed custom property at an element where that definition applies), and the defining rule.
import { parseColor } from '../static/color.js';
import { decodeComputed, varGraph } from '../static/ruletable.js';

const EXT = 'com.reva';
const VAR_ONLY = /^var\(\s*(--[\w-]+)\s*\)$/;
const VAR_ANY = /var\(\s*(--[\w-]+)\s*\)/g; // no fallback: a reference
const round = x => Math.round(x * 1e6) / 1e6;

/** Token name for a custom property (DTCG forbids '.', '{', '}' and a leading '$'). */
export const tokenName = v => v.replace(/^--/, '').replace(/[.{}]/g, '_').replace(/^\$/, '_');

/** CSS value -> {$value, $type?} (lossless only). names: var -> token name, for aliases. */
export function dtcgValue(css, names) {
  const v = String(css).trim();
  const a = VAR_ONLY.exec(v);
  if (a && names.has(a[1])) return { $value: `{${names.get(a[1])}}` };
  if (/var\(/.test(v)) {
    // references without fallback become {name}; a var() with a fallback stays as CSS (an alias cannot hold it)
    const out = v.replace(VAR_ANY, (m, n) => (names.has(n) ? `{${names.get(n)}}` : m));
    return { $value: out };
  }
  if (/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v) || /^rgba?\(\s*[\d.%\s,/]+\)$/i.test(v)) {
    const c = parseColor(v);
    if (c && c.exact) {
      const val = { colorSpace: 'srgb', components: [c.r, c.g, c.b].map(x => round(x / 255)) };
      if (c.a < 1) val.alpha = c.a;
      val.hex = '#' + [c.r, c.g, c.b].map(x => x.toString(16).padStart(2, '0')).join('');
      return { $type: 'color', $value: val };
    }
  }
  let m = /^(-?(?:\d+\.?\d*|\.\d+))(px|rem)$/i.exec(v);
  if (m) return { $type: 'dimension', $value: { value: parseFloat(m[1]), unit: m[2].toLowerCase() } };
  if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(v)) return { $type: 'number', $value: parseFloat(v) };
  m = /^cubic-bezier\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)$/i.exec(v);
  if (m) return { $type: 'cubicBezier', $value: m.slice(1, 5).map(Number) };
  return { $value: v };
}

/** Condition chain text of a rule: "@media (...) > @layer x". */
function whenOf(table, r) {
  return (r.ctx || []).map(id => table.rules[id]).map(g => g.t === 'import' ? (g.media && g.media !== 'all' ? `@media ${g.media}` : null) : g.head || `@${g.t}`).filter(Boolean).join(' > ');
}
const activeAt = (table, r) => (r.ctx || []).every(id => table.rules[id].active !== false);

/**
 * DTCG from a captured rule table. Returns {base, contexts:[{id, selector, when, scope, kind, active, tokens}],
 * stats, skipped}. base/tokens are DTCG documents (group = file root).
 */
export function dtcgFromTable(table) {
  const vg = table.vars?.vars ? table.vars : varGraph(table);
  const R = table.rules, E = table.els;
  const rootI = table.docs[0].tree.i;
  const names = new Map(); const used = new Set();
  for (const v of Object.keys(vg.vars).sort()) { if (!vg.vars[v].defs.length) continue; let n = tokenName(v); while (used.has(n)) n += '_'; used.add(n); names.set(v, n); }
  const ctxs = new Map(); const skipped = [];
  const comp = new Map(); const C = i => { let m = comp.get(i); if (!m) comp.set(i, m = decodeComputed(table, i)); return m; };
  for (const [v, node] of Object.entries(vg.vars)) {
    for (const d of node.defs) {
      let key, info;
      if (d.keyframe != null) { skipped.push({ var: v, why: `defined in @keyframes ${R[d.rule].name} ${d.keyframe} (animated, not a token)` }); continue; }
      if (d.el != null) { key = `inline|${E[d.el].k}`; info = { kind: 'inline', selector: `[style] ${E[d.el].k}`, when: '', scope: null, els: [d.el], active: true }; }
      else {
        const r = R[d.rule]; const sel = r.full || r.sel; const when = whenOf(table, r);
        key = `${r.scope}|${sel}|${when}`;
        const els = []; E.forEach((e, i) => { if ((e.r || []).includes(r.id) || (e.hr || []).includes(r.id)) els.push(i); });
        info = { kind: 'rule', selector: sel, when, scope: r.scope, els, active: activeAt(table, r), rules: [r.id] };
      }
      let c = ctxs.get(key); if (!c) ctxs.set(key, c = { key, ...info, defs: new Map() });
      if (info.rules) for (const id of info.rules) if (!c.rules.includes(id)) c.rules.push(id);
      c.defs.set(v, { value: d.value, rule: d.rule ?? null }); // later definition in the same context wins (cascade order)
    }
  }
  // base = unconditional contexts matching the document root element, in cascade order
  const isBase = c => c.kind === 'rule' && !c.when && c.scope === 'd0' && c.els.includes(rootI);
  const baseCtx = [...ctxs.values()].filter(isBase);
  const baseDefs = new Map();
  for (const c of baseCtx.sort((a, b) => Math.min(...a.rules) - Math.min(...b.rules))) for (const [v, d] of c.defs) baseDefs.set(v, { ...d, selector: c.selector });
  const rootComp = C(rootI);
  // a reference becomes an alias only when the referenced token is in the base set or in the same context (a token
  // defined only under another selector has no single value to point at: it stays var(--x))
  const aliasable = extra => new Map([...names].filter(([v]) => baseDefs.has(v) || (extra && extra.has(v))));
  const baseNames = aliasable(null);
  const tok = (v, d, resolved, nm = baseNames) => {
    const x = dtcgValue(d.value, nm);
    return { ...x, $extensions: { [EXT]: { var: v, authored: d.value, resolved, ...(d.rule != null ? { rule: d.rule } : {}) } } };
  };
  const base = { $description: `Design tokens captured from ${table.url} (REVA rule table; base context = custom properties on the root element without conditions)` };
  let resolvedBase = 0;
  // conditional contexts active on the root at the capture point (e.g. :root inside a matching @media) override base
  // values there: the root's computed value then shows the override, which the token says
  const rootOver = [...ctxs.values()].filter(c => !isBase(c) && c.active && c.els.includes(rootI));
  const closure = v => { const seen = new Set(); const st = [v]; while (st.length) { const x = st.pop(); if (seen.has(x)) continue; seen.add(x); for (const y of vg.vars[x]?.deps || []) st.push(y); } return seen; };
  for (const [v, d] of [...baseDefs].sort((a, b) => a[0].localeCompare(b[0]))) {
    const r = rootComp.get(v) ?? null; if (r != null) resolvedBase++;
    const t = tok(v, d, r);
    const cl = closure(v);
    const over = rootOver.filter(c => [...c.defs.keys()].some(x => cl.has(x)));
    if (over.length) t.$extensions[EXT].resolvedWith = over.map(c => `${c.selector} ${c.when}`.trim());
    base[names.get(v)] = t;
  }
  const contexts = [];
  for (const c of ctxs.values()) {
    if (isBase(c)) continue;
    // resolved at the first element where the context applies now (null: condition inactive or no element)
    const at = c.active && c.els.length ? c.els[0] : null;
    const tokens = {};
    const nm = aliasable(c.defs);
    for (const [v, d] of [...c.defs].sort((a, b) => a[0].localeCompare(b[0]))) tokens[names.get(v)] = tok(v, d, at != null ? (C(at).get(v) ?? null) : null, nm);
    contexts.push({ id: contexts.length, kind: c.kind, selector: c.selector, when: c.when, scope: c.scope, active: c.active, elements: c.els.length, resolvedAt: at != null ? E[at].k : null, tokens });
  }
  const all = [base, ...contexts.map(c => c.tokens)].flatMap(t => Object.entries(t).filter(([k]) => !k.startsWith('$')).map(([, x]) => x));
  const types = {}; for (const x of all) { const t = x.$type || (String(x.$value).match(/^\{[^}]+\}$/) ? 'alias' : 'css'); types[t] = (types[t] || 0) + 1; }
  return {
    base, contexts, skipped,
    stats: { vars: Object.keys(vg.vars).length, defined: names.size, undefinedRefs: vg.undefinedRefs.length, baseTokens: baseDefs.size, baseResolved: resolvedBase, contexts: contexts.length, contextTokens: contexts.reduce((s, c) => s + Object.keys(c.tokens).length, 0), byType: types, skipped: skipped.length },
  };
}

/** The CSS each set must produce: [{selector, when, vars: {--name: authored}}] (base first). */
export function expectedCss(d) {
  const varsOf = t => Object.fromEntries(Object.entries(t).filter(([k]) => !k.startsWith('$')).map(([, x]) => [x.$extensions[EXT].var, x.$extensions[EXT].authored]));
  return [{ selector: ':root', when: '', vars: varsOf(d.base) }, ...d.contexts.map(c => ({ selector: c.selector, when: c.when, vars: varsOf(c.tokens) }))];
}

/** Parse `--name: value;` declarations out of CSS text (one block). */
export function parseVarBlock(css) {
  const out = {};
  const body = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of body.matchAll(/(--[^\s:]+)\s*:\s*([^;]*);/g)) out[m[1]] = m[2].trim();
  return out;
}

const normCss = s => String(s).replace(/\s+/g, ' ').replace(/\s*([,()/])\s*/g, '$1').trim().toLowerCase().replace(/(^|[^\w.#-])(-?\d*\.?\d+)/g, (m, p, n) => p + String(parseFloat(n)));
/** Same value? Text after whitespace normalisation, else colour / number equality (a converter may re-serialise). */
export function sameValue(a, b) {
  if (normCss(a) === normCss(b)) return true;
  const ca = parseColor(String(a)), cb = parseColor(String(b));
  if (ca && cb) return ca.r === cb.r && ca.g === cb.g && ca.b === cb.b && Math.abs(ca.a - cb.a) < 0.002;
  const na = /^(-?[\d.]+)([a-z%]*)$/i.exec(String(a).trim()), nb = /^(-?[\d.]+)([a-z%]*)$/i.exec(String(b).trim());
  if (na && nb) return parseFloat(na[1]) === parseFloat(nb[1]) && na[2].toLowerCase() === nb[2].toLowerCase();
  return false;
}
/** Compare expected vars with vars produced by a DTCG -> CSS converter. */
export function compareVars(expected, actual) {
  const bad = [];
  for (const [k, v] of Object.entries(expected)) if (!(k in actual)) bad.push({ var: k, want: v, got: null }); else if (!sameValue(v, actual[k])) bad.push({ var: k, want: v, got: actual[k] });
  for (const k of Object.keys(actual)) if (!(k in expected)) bad.push({ var: k, want: null, got: actual[k] });
  return { total: Object.keys(expected).length, equal: Object.keys(expected).length - bad.filter(b => b.want != null).length, bad };
}
