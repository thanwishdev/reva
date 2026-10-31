// DTCG -> CSS custom properties through Style Dictionary (Apache-2.0, devDependency): an independent DTCG reader.
// The token name is the captured custom property (so `--Brand_Color` is not re-cased); values go through SD's own
// css transforms (DTCG colour / dimension objects -> CSS) with references kept as var().
import StyleDictionary from 'style-dictionary';
import { expectedCss, parseVarBlock, compareVars } from '../../src/design/dtcg.js';

let registered = false;
function register() {
  if (registered) return; registered = true;
  StyleDictionary.registerTransform({ name: 'reva/var-name', type: 'name', transform: t => (t.$extensions?.['com.reva']?.var || `--${t.path.join('-')}`).slice(2) });
}

async function toCss(tokens, names) {
  const sd = new StyleDictionary({
    tokens, usesDtcg: true, log: { verbosity: 'silent', warnings: 'disabled', errors: { brokenReferences: 'console' } },
    platforms: { css: { transforms: ['reva/var-name', 'color/css', 'size/rem', 'cubicBezier/css'], files: [{ destination: 'v.css', format: 'css/variables', filter: t => names.has(t.$extensions?.['com.reva']?.var), options: { outputReferences: true, selector: ':root' } }] } },
  });
  const [r] = await sd.formatPlatform('css');
  return parseVarBlock(r.output);
}

/** Every set (base, then each context with the base underneath for references) -> CSS -> compared with the captured
 *  authored values. Returns {sets, vars, equal, bad[]}. */
export async function roundTrip(d) {
  register();
  const exp = expectedCss(d);
  const strip = t => Object.fromEntries(Object.entries(t).filter(([k]) => !k.startsWith('$')));
  const sets = [d.base, ...d.contexts.map(c => c.tokens)];
  let vars = 0, equal = 0; const bad = [];
  for (let i = 0; i < sets.length; i++) {
    const names = new Set(Object.keys(exp[i].vars));
    const tokens = i === 0 ? strip(d.base) : { ...strip(d.base), ...strip(sets[i]) };
    const got = await toCss(tokens, names);
    const c = compareVars(exp[i].vars, got);
    vars += c.total; equal += c.equal;
    for (const b of c.bad) bad.push({ set: i, selector: exp[i].selector, when: exp[i].when, ...b });
  }
  return { sets: sets.length, vars, equal, bad };
}

/** Base tokens fully resolved by Style Dictionary (references substituted) vs the value the engine resolved at the
 *  root (computed custom property). Skips tokens whose root value includes an active conditional override
 *  (resolvedWith) and values that keep a var() with fallback (SD cannot evaluate it). */
export async function resolvedCheck(d) {
  register();
  const strip = t => Object.fromEntries(Object.entries(t).filter(([k]) => !k.startsWith('$')));
  const sd = new StyleDictionary({ tokens: strip(d.base), usesDtcg: true, log: { verbosity: 'silent', warnings: 'disabled' },
    platforms: { css: { transforms: ['reva/var-name', 'color/css', 'size/rem', 'cubicBezier/css'], files: [{ destination: 'v.css', format: 'css/variables', options: { outputReferences: false } }] } } });
  const got = parseVarBlock((await sd.formatPlatform('css'))[0].output);
  const rows = []; let skipped = 0;
  for (const x of Object.values(strip(d.base))) {
    const e = x.$extensions['com.reva'];
    if (e.resolvedWith || e.resolved == null || /var\(/.test(got[e.var] || '') || /^(initial|inherit|unset|revert|revert-layer)$/i.test(e.authored.trim())) { skipped++; continue; }
    rows.push({ var: e.var, want: e.resolved, got: got[e.var] ?? null });
  }
  const c = compareVars(Object.fromEntries(rows.map(r => [r.var, r.want])), Object.fromEntries(rows.filter(r => r.got != null).map(r => [r.var, r.got])));
  return { checked: rows.length, equal: c.equal, skipped, bad: c.bad };
}
