// `reva compare <a> <b>`: run look on A, then on B (one browser at a time, the same action and target), and say whether B
// moves like A. Shared runner for the CLI and the MCP tool: runCompare.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { comparePair, formatCompare } from './index.js';
import { writeCompareCard } from './card.js';
import { recordedEnds } from '../mcp/analysis.js';
import { ensureOutDirIn } from '../util/paths.js';
import { terminalJson } from '../report/untrusted.js';

export const COMPARE_HELP = `reva compare <url-a> <url-b> [--do load|hover|click|scroll] [--el <selector>] [--on <selector|x,y>] [--json] [--card] [--retake]

  Does B move like A? Runs "reva look" on A, then on B (one after the other, the same action and target), pairs their
  motions (same selector first, then start order and visual weight) and compares them value by value: start, duration,
  curve (the eased curves, sampled), start and end values, stagger. Typical use: A = the original site, B = your rebuild.
  Prints one headline and one plain line per motion: the same / close (with the difference) / different; "only in A" and
  "only in B" for motions with no partner. Each value keeps its label (exact = read from the page, fitted = measured).
  <url-a>, <url-b>  a URL (http(s) or file:), an archive, "demo" (REVA's bundled demo page), or a local .html file / a
            folder with index.html (served on 127.0.0.1 for that look only)
  --do / --el / --on  as in reva look, used for both pages
  --json    print the full comparison (reva.compare/0)
  --card    also write compare.html: both curves overlaid per motion, self-contained
  --retake  also run look's stability re-take on each page (off by default here: twice the time)
  --no-design is implied (the design pass is not compared). Writes compare.json (and compare.html) under the output folder.`;

/** Curve start / end values of a record read from the look's recording (the take folder), labelled fitted (measured). */
export function recordedEndsOf(look, rec) {
  const dir = look && look.take && look.take.dir;
  if (!dir || !fs.existsSync(dir)) return null;
  try { const e = recordedEnds(dir, rec); return e && e.from != null && e.to != null ? { from: e.from, to: e.to, label: 'fitted' } : null; } catch { return null; }
}

/** A CLI input: "demo", a local .html file or a folder with index.html (served), else passed to look as given. */
async function openInput(input) {
  const s = String(input);
  if (s === 'demo') {
    const { serveFixtureDir } = await import('../mcp/fixture.js'); const { DEMO_ROOT } = await import('../demo/cli.js');
    const srv = await serveFixtureDir({ root: DEMO_ROOT, page: 'index.html' }); return { input: srv.url, close: srv.close, shown: 'demo' };
  }
  const p = path.resolve(s);
  if (!/^[a-z]+:\/\//i.test(s) && fs.existsSync(p)) {
    const st = fs.statSync(p);
    const page = st.isFile() && /\.html?$/i.test(p) ? { root: path.dirname(p), page: path.basename(p) }
      : st.isDirectory() && fs.existsSync(path.join(p, 'index.html')) && !fs.existsSync(path.join(p, 'target.json')) && !fs.existsSync(path.join(p, 'archive')) ? { root: p, page: 'index.html' } : null;
    if (page) { const { serveFixtureDir } = await import('../mcp/fixture.js'); const srv = await serveFixtureDir(page); return { input: srv.url, close: srv.close, shown: p }; }
  }
  return { input: s, close: null, shown: s };
}

/**
 * Look at A, then at B, and compare. `look(input, side)` runs one look and returns its result (look.json object);
 * the two never run at the same time.
 */
export async function runCompare({ a, b, look, endsOf = recordedEndsOf, log = () => {} }) {
  log('compare: looking at A …');
  const lookA = await look(a, 'A');
  log('compare: looking at B …');
  const lookB = await look(b, 'B');
  return { lookA, lookB, compare: comparePair(lookA, lookB, { endsOf }) };
}

export async function runCompareCommand(f) {
  const [, a, b] = f._ || [];
  if (f.help || !a || !b) { console.error(COMPARE_HELP); return f.help ? 0 : 2; }
  const { runLook, ACTIONS } = await import('../look/index.js');
  const action = typeof f.do === 'string' ? f.do : 'load';
  if (!ACTIONS.includes(action)) { console.error(`unknown --do ${action} (use ${ACTIONS.join(', ')})`); return 2; }
  const el = typeof f.el === 'string' ? f.el : undefined; const on = typeof f.on === 'string' ? f.on : undefined;
  const look = async (input, side) => {
    const src = await openInput(input);
    try {
      const r = await runLook({ input: src.input, action, el, on, design: false, retake: !!f.retake, log: (m) => process.stderr.write(`[${side}] ${m}\n`) });
      if (src.shown !== src.input) r.source = { ...r.source, shown: src.shown };
      return r;
    } finally { if (src.close) await src.close(); }
  };
  let res;
  try { res = await runCompare({ a, b, look, log: (m) => process.stderr.write(m + '\n') }); } catch (e) {
    if (e && e.code === 'bad_arguments') { console.error(e.message); return 2; }
    throw e;
  }
  const { lookA, lookB, compare: c } = res;
  for (const [side, r] of [['A', lookA], ['B', lookB]]) if (r.status === 'error') c.errors = [...(c.errors || []), `${side}: ${(r.errors || []).join('; ') || 'look failed'}`];
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}_${action}_${crypto.randomBytes(3).toString('hex')}`;
  const dir = ensureOutDirIn(process.env, 'compare', id);
  fs.writeFileSync(path.join(dir, 'compare.json'), JSON.stringify(c, null, 1));
  c.dir = dir;
  if (f.card) c.card = writeCompareCard(c, path.join(dir, 'compare.html'));
  if (f.json) process.stdout.write(terminalJson(c, 1) + '\n');
  else {
    const L = [formatCompare(c)];
    for (const e of c.errors || []) L.splice(1, 0, `! ${e}`);
    L.push(`compare.json: ${path.join(dir, 'compare.json')}`); if (c.card) L.push(`card: ${c.card}`);
    L.push(`looks: A ${lookA.dir ? path.join(lookA.dir, 'look.json') : '-'} · B ${lookB.dir ? path.join(lookB.dir, 'look.json') : '-'}`);
    process.stdout.write(L.join('\n') + '\n');
  }
  return lookA.status === 'error' || lookB.status === 'error' ? 1 : 0;
}
