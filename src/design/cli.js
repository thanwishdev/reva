// `reva design views|tokens <captureDir>`: the derived views (D3) and the DTCG token export (D4) of a gate
// capture folder (runCaptureSuite `out`, or any folder with cap/table-<cls>.json + point snapshots). No browser.
// Outputs are site-derived: they go next to the capture (default <captureDir>/design), never into the repo.
import fs from 'node:fs';
import path from 'node:path';
import { buildViews, writeViews, summarizeViews, buildTokens } from './run.js';
import { assertOutsideRepo } from '../util/paths.js';

export const DESIGN_HELP = `reva design <url | archive> [--json] [--all] [--tokens] [--cls A] [--out DIR] [--engine cft|chs] [--color-scheme light|dark] [--ignore-robots]
  How the page is designed, in plain words: fonts and their roles, type scale, colours with roles and contrast, spacing,
  radii, shadows, layout (content widths, columns, sections), breakpoints, hover / focus changes. Every value is labelled
  exact (the page's own CSS), measured (computed by the browser) or derived (our arithmetic), with its unit. Content-free:
  no page text, images or font files. One headless session of its own (\`reva look\` records the same data in look.json).
  --json    print design.json   --all  list every type style and shadow   --tokens  also write design-tokens.css / .json
  --engine  browser: cft (Chrome for Testing) or chs (the headless shell); default: cft when installed, else chs
  --color-scheme  read the page in the light (default) or dark colour scheme (what prefers-color-scheme matches); the
            output names the scheme that was read, so a site with a dark palette can be read in both
  --ignore-robots  the site is yours: open it even where its robots.txt disallows REVA (the typed site only)
  A live page is checked first, like reva look: robots.txt (of the page, every redirect and every page it sends the
  browser to) and bot / login / region walls stop the read; a recognised cookie banner is rejected, never accepted.
  Writes design.json (and the static record it came from) to a folder of its own and prints its path.

reva design views <captureDir> [--out DIR] [--target id] [--edges 600,960] [--cls A,C] [--range 320-1920]
reva design tokens <captureDir> [--out DIR] [--cls A,C]
  views   components (repeated structures + variants), sections (page outline), breakpoints (rules that flip at each
          measured edge + the elements/properties that change), assets (element -> file map, requested, archive file)
  tokens  W3C DTCG tokens from the var() graph: base set (root, no condition) + one set per context (selector / @media)
  --target  a frozen-archive target: classes (dpr, touch) + archive manifest for the file of every asset`;

export async function designMain(sub, f) {
  if (sub && !['views', 'tokens'].includes(sub)) return designCommand(f);
  const dir = f._[2];
  if (!['views', 'tokens'].includes(sub) || !dir) { console.log(DESIGN_HELP); return sub ? 2 : 0; }
  const out = path.resolve(f.out || path.join(dir, 'design'));
  assertOutsideRepo(out);
  fs.mkdirSync(out, { recursive: true });
  const only = f.cls ? String(f.cls).split(',') : null;
  if (sub === 'tokens') {
    const tk = buildTokens(dir, { only });
    for (const [cls, d] of Object.entries(tk)) {
      fs.writeFileSync(path.join(out, `tokens-${cls}.json`), JSON.stringify(d.base, null, 1));
      fs.writeFileSync(path.join(out, `tokens-${cls}.contexts.json`), JSON.stringify({ contexts: d.contexts, skipped: d.skipped }, null, 1));
      console.log(`${cls}: ${JSON.stringify(d.stats)}`);
    }
    console.log(`tokens -> ${out}`);
    return 0;
  }
  let classes = {}, fileFor = () => null;
  if (f.target) {
    const { loadTarget } = await import('../replay/target.js');
    const t = loadTarget(f.target);
    classes = t.classes || {};
    const mf = path.join(t.archive, 'manifest.json');
    if (fs.existsSync(mf)) { const m = (m0 => new Map((m0.entries || m0).map(x => [x.url, x.path])))(JSON.parse(fs.readFileSync(mf, 'utf8'))); fileFor = u => m.get(u) || null; }
  }
  const edges = f.edges ? String(f.edges).split(',').map(Number) : null;
  const range = f.range ? (([a, b]) => ({ from: +a, to: +b }))(String(f.range).split('-')) : null;
  const v = buildViews(dir, { edges, classes, fileFor, range, only });
  const files = writeViews(v, out);
  console.log(JSON.stringify(summarizeViews(v), null, 1));
  console.log(`${files.length} files -> ${out}`);
  return 0;
}

/** `reva design <url|archive>`: the design pass alone (no motion take). */
export async function designCommand(f) {
  const input = f._[1];
  if (!input || f.help) { console.log(DESIGN_HELP); return input ? 0 : 2; }
  const { resolveSource } = await import('../look/source.js');
  const { runDesignPass } = await import('./pass.js');
  const { formatDesign } = await import('./text.js');
  const { stripControls, terminalJson } = await import('../report/untrusted.js');
  const { ensureOutDir } = await import('../util/paths.js');
  const cls = typeof f.cls === 'string' ? f.cls : 'A';
  const { parseColorScheme } = await import('../browser/scheme.js');
  let colorScheme;
  try { colorScheme = parseColorScheme(f['color-scheme']); } catch (e) { console.error(e.message); return 2; }
  let src;
  try { src = resolveSource(input, { cls }); } catch (e) { console.error(stripControls(e.message)); return 2; }
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}_design`;
  const log = (m) => process.stderr.write(stripControls(m) + '\n');
  // a live page passes the same safety gate as reva look before any browser starts (src/safety/gate.js), and every page
  // it sends the browser to afterwards is checked against robots.txt too
  let safety = null, navGuard = null;
  if (src.kind === 'url' && src.live) {
    const { safetyGate, navigationGuard } = await import('../safety/gate.js');
    safety = await safetyGate(src.url, { ignoreRobots: !!f['ignore-robots'], who: 'cli', log });
    navGuard = navigationGuard(src.url, { ignoreRobots: !!f['ignore-robots'], who: 'cli', seed: safety.robotsTexts, log });
  }
  const out = typeof f.out === 'string' ? assertOutsideRepo(path.resolve(f.out)) : ensureOutDir('design', id);
  fs.mkdirSync(out, { recursive: true });
  // a hard wall-clock deadline (the same idea as look's): a page that never settles ends in an error, never a hang
  const DEADLINE_MS = 240000; const deadline = AbortSignal.timeout(DEADLINE_MS);
  let d;
  try {
    d = await runDesignPass({ src, cls, outDir: path.join(out, 'static'), engine: typeof f.engine === 'string' ? f.engine : undefined, ...(colorScheme ? { colorScheme } : {}),
      consentClicks: safety ? safety.consent.clicks : null, navGuard, log, signal: deadline });
  } catch (e) {
    if (deadline.aborted) throw Object.assign(new Error(`design: no result within ${DEADLINE_MS / 1000} s (the time limit of one read); the browser was closed. The page may never finish loading.`), { code: 'timeout' });
    throw e;
  }
  // the pass removed what it wrote; the folder goes too when nothing else is in it (never a folder --out named that has files)
  if (d.code === 'blocked_robots') { try { fs.rmdirSync(out); } catch { /* not empty: left as it was */ } throw navGuard.error(); }
  const source = src.kind === 'archive' ? { kind: 'archive', archive: src.archive, startUrl: src.target.startUrl } : { kind: 'url', url: src.url, live: src.live };
  const result = { ...d, source };
  fs.writeFileSync(path.join(out, 'design.json'), JSON.stringify(result, null, 1));
  const files = [path.join(out, 'design.json')];
  if (f.tokens && d.ok !== false) {
    const { designCss, designTokens } = await import('./export.js');
    fs.writeFileSync(path.join(out, 'design-tokens.css'), designCss(d, { families: true }));
    fs.writeFileSync(path.join(out, 'design-tokens.json'), JSON.stringify(designTokens(d, { families: true }), null, 1));
    files.push(path.join(out, 'design-tokens.css'), path.join(out, 'design-tokens.json'));
  }
  if (f.json) process.stdout.write(terminalJson(result, 1) + '\n');
  else {
    const where = src.kind === 'archive' ? `archive ${src.target.startUrl} (frozen, replayed offline)` : `${src.url}${src.live ? '' : ' (local)'}`;
    process.stdout.write(formatDesign(d, { source: stripControls(where), all: !!f.all }) + '\n' + files.map((x) => `${path.basename(x)}: ${x}`).join('\n') + '\n');
  }
  return d.ok === false ? 1 : 0;
}
