// The MCP tool `compare`: look at page A, then page B (the look tool's own source checks, guard proxy and robots rules
// apply to each), and say whether B moves like A. Page text (descriptors, selectors, the plain lines that quote them)
// travels as untrusted_content.
import path from 'node:path';
import { comparePair, COMPARE_TOL } from './index.js';
import { recordedEndsOf } from './cli.js';
import { writeCompareCard } from './card.js';
import { untrusted, untrustedSelector } from '../report/untrusted.js';
import { ensureOutDirIn } from '../util/paths.js';

const S = (description, extra = {}) => ({ type: 'string', description, ...extra });
const PAGE = (who) => ({
  type: 'object', additionalProperties: false,
  description: `page ${who}: exactly one of url, archive, fixture (as in the look tool)`,
  properties: {
    url: S('http(s) page (local / private addresses and file: URLs need the server opt-in)', { maxLength: 2048 }),
    archive: S('a frozen archive: archive folder, corpus run folder, target .json or target id (inside the data roots)', { maxLength: 1024 }),
    fixture: S('"demo": REVA\'s own bundled demo page', { maxLength: 120 }),
  },
});
const bad = (m, code = 'bad_arguments') => Object.assign(new Error(m), { code });
/** Custom-property channels carry the page's own names (drv:--x): those travel as untrusted_content. */
const chan = (ch) => (/--/.test(String(ch)) ? untrusted(ch, 'channel', 120) : ch);

/** The comparison in the MCP's compact form (no curves; the card and compare.json have them). */
export function compareRows(c) {
  const side = (m) => ({ element: untrusted(m.desc || '', 'element', 200), ...(m.selector ? { selector: untrustedSelector(m.selector) } : {}), rank: m.rank });
  const valueRow = (v) => { const o = { ...v }; delete o.labels; if (v.labels) { o.label_a = v.labels.a; o.label_b = v.labels.b; } return o; };
  return {
    pairs: c.pairs.map((p) => ({ a: side(p.a), b: side(p.b), paired_by: p.pairedBy, verdict: p.verdict, line: untrusted(p.line, 'compare.line', 600),
      channels: p.channels.map((ch) => ({ channel: chan(ch.channel), verdict: ch.verdict, label_a: ch.labels.a, label_b: ch.labels.b,
        ...(ch.segments.a > 1 || ch.segments.b > 1 ? { segment: ch.segment, segments: ch.segments } : {}),
        values: Object.fromEntries(Object.entries(ch.values).map(([k, v]) => [k, valueRow(v)])) })),
      ...(p.onlyA.length ? { only_a_channels: p.onlyA.map(chan) } : {}), ...(p.onlyB.length ? { only_b_channels: p.onlyB.map(chan) } : {}),
      ...(p.stagger ? { stagger: p.stagger } : {}) })),
    only_a: c.onlyA.map(side), only_b: c.onlyB.map(side),
  };
}

export const compareTool = {
  name: 'compare', title: 'Compare two pages', surface: 'public', heavy: true,
  description: 'Does page B move like page A? Runs look on A, then on B (one browser at a time, the same interaction and target), pairs their motions (same selector first, then start order and visual weight) and compares each pair value by value: start, duration, the eased curve (max gap over 0-1), start / end values and stagger, each as same / close / different with the difference, keeping each side\'s exact / fitted labels. Typical use: A = the original site, B = a rebuild made from REVA\'s numbers. Returns a headline and one plain line per motion; compare.json has everything, card: true also writes compare.html with both curves overlaid.',
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['a', 'b'],
    properties: {
      a: PAGE('A (the reference, e.g. the original site)'),
      b: PAGE('B (the page that should move like A, e.g. a rebuild)'),
      target: S('"auto" ranks the moving elements by visual weight; or a CSS selector to compare just that element (used on both pages)', { default: 'auto', maxLength: 300 }),
      interaction: { type: 'string', enum: ['load', 'hover', 'click', 'scroll'], default: 'load', description: 'what the tool does while recording, the same on both pages (hover and click need target or on)' },
      on: S('hover / click trigger on both pages: a selector or a viewport point "x,y"', { maxLength: 300 }),
      depth: { type: 'string', enum: ['quick', 'full'], default: 'quick', description: 'as in look: quick = top 5 elements, full = top 10 (slower)' },
      card: { type: 'boolean', default: false, description: 'also write compare.html (both curves overlaid per motion, self-contained)' },
      color_scheme: { type: 'string', enum: ['light', 'dark'], description: 'the colour scheme both pages are read in (what prefers-color-scheme matches); default light' },
    },
  },
  annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: true },
  async run(a, ctx = {}) {
    for (const k of ['a', 'b']) {
      const p = a[k] || {}; const given = ['url', 'archive', 'fixture'].filter((x) => p[x] != null);
      if (given.length !== 1) throw bad(`${k}: give exactly one of url, archive, fixture (got ${given.join(', ') || 'none'})`);
    }
    const interaction = a.interaction || 'load';
    // the look tool does the source checks (guard proxy, robots, fixtures); found by name, so a rename there needs no edit here
    const lookTool = ctx.lookTool || (await import('../mcp/reva.js')).PUBLIC_TOOLS.find((t) => t.name === 'look' || t.name === 'analyze');
    if (!lookTool) throw bad('the look tool is not available', 'internal');
    const { loadAnalysis } = await import('../mcp/analysis.js');
    const baseRun = ctx.runLook || (await import('../look/index.js')).runLook;
    // the stability re-take and the design pass are not compared: off, so each look takes half the time
    const lctx = { ...ctx, runLook: (o) => baseRun({ ...o, retake: false, design: false }) };
    const look = async (page) => {
      const res = await lookTool.run({ ...page, target: a.target || 'auto', interaction, ...(a.on ? { on: a.on } : {}), depth: a.depth || 'quick', design: false, ...(a.color_scheme ? { color_scheme: a.color_scheme } : {}) }, lctx);
      const id = res && res.data && res.data.analysis; if (!id) throw bad('look returned no analysis', 'analysis_failed');
      return loadAnalysis(id, ctx.env || process.env).look;
    };
    const lookA = await look(a.a);
    const lookB = await look(a.b);
    const c = comparePair(lookA, lookB, { endsOf: recordedEndsOf });
    const id = `${new Date().toISOString().replace(/[:.]/g, '-')}_${interaction}_${Math.random().toString(16).slice(2, 8)}`;
    const dir = ensureOutDirIn(ctx.env || process.env, 'compare', id);
    const fs = await import('node:fs');
    fs.writeFileSync(path.join(dir, 'compare.json'), JSON.stringify(c, null, 1));
    const artifacts = [{ kind: 'compare.json', path: path.join(dir, 'compare.json') }];
    if (a.card) artifacts.push({ kind: 'compare.html', path: writeCompareCard(c, path.join(dir, 'compare.html')) });
    return {
      headline: c.headline,
      stats: { verdict: c.verdict, ...c.counts, analysis_a: lookA.dir ? path.basename(lookA.dir) : null, analysis_b: lookB.dir ? path.basename(lookB.dir) : null },
      data: { ...compareRows(c), tolerances: COMPARE_TOL },
      artifacts,
      next: [],
      warnings: [],
    };
  },
};
