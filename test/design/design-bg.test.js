// REVA design pass on a known-answer fixture for the page background, painted area, a webfont that did not load and
// the pinned colour scheme (fixtures/look/design-bg.html, localhost only). The pass runs in a browser whose OS
// appearance is forced dark (--force-dark-mode): the read must still be the light scheme.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox } from '../mcp/helpers.js';
import { serveFixture } from '../helpers.js';

const root = sandbox('design-bg');
const { resolveSource } = await import('../../src/look/source.js');
const { runDesignPass } = await import('../../src/design/pass.js');
const { formatDesign } = await import('../../src/design/text.js');
const { summarizeDesign } = await import('../../src/design/summary.js');
const { loadElements } = await import('../../src/static/extract.js');
const { designSection } = await import('../../src/card/design.js');
const { launchBrowser } = await import('../../src/browser/launch.js');

// A dark OS: --force-dark-mode switches the macOS / Windows native theme; a Linux headless shell has no OS theme, so there the
// same preference is set where Blink reads it (preferredColorScheme 0 = dark). Either way the pass must still read light.
const DARK_OS = process.platform === 'linux' ? ['--blink-settings=preferredColorScheme=0'] : ['--force-dark-mode'];
let srv, d, h;
test.before(async () => {
  srv = await serveFixture('look');
  d = await runDesignPass({ src: resolveSource(`${srv.origin}/design-bg.html`), outDir: path.join(root, 'pass', 'static'), args: DARK_OS });
  h = await runDesignPass({ src: resolveSource(`${srv.origin}/design-bg-h100.html`), outDir: path.join(root, 'h100', 'static') });
});
test.after(async () => { await srv.close(); });

test('control: the forced-dark browser does report a dark OS when nothing is pinned', async () => {
  const h = await launchBrowser({ args: DARK_OS });
  try {
    await h.page.emulateMedia({ colorScheme: null });
    await h.page.goto(`${srv.origin}/design-bg.html`);
    assert.equal(await h.page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches), true, 'the dark-OS emulation works (else the next test proves nothing)');
  } finally { await h.close(); }
});

test('the colour scheme is pinned to light even on a dark OS, and said in the header', () => {
  assert.equal(d.ok, true, d.error);
  assert.equal(d.scheme.colorScheme, 'light'); assert.equal(d.scheme.requested, 'light'); assert.equal(d.scheme.reducedMotion, 'no-preference');
  assert.equal(d.palette.pageBackground.hex.value, '#ffffff', 'the dark-scheme rule did not apply');
  assert.match(formatDesign(d).split('\n')[0], /light scheme/);
  assert.ok(!d.gaps.some((g) => g.id === 'read_in_dark'));
});

test('page background: transparent html and body read as the white default canvas', () => {
  const P = d.palette;
  assert.deepEqual([P.pageBackground.hex.value, P.pageBackground.hex.label, P.pageBackground.from], ['#ffffff', 'derived', 'browser default canvas']);
});

test('main background by visible area: tiny, zero-size and translucent boxes and SVG fills do not win', () => {
  const P = d.palette;
  assert.equal(P.mainBackground, '#ffffff');
  assert.equal(P.mostUsedBackground, '#7f7dfc', 'zero-size red boxes (50) are not counted; the 40 tiny violet boxes are the most used');
  assert.ok(!P.colours.some((c) => c.hex.value === '#ff0000'), 'zero-size boxes paint nothing');
  assert.ok(P.notPainted >= 50);
  const white = P.colours.find((c) => c.hex.value === '#ffffff'); const band = P.colours.find((c) => c.hex.value === '#f5f5f7');
  const violet = P.colours.find((c) => c.hex.value === '#7f7dfc');
  assert.equal(white.role, 'background', 'the canvas colour is the background even though 60 SVG fills use it');
  assert.equal(band.role, 'surface', 'the 400 px band paints well over a tenth of the page');
  assert.notEqual(violet.role, 'background');
  // band share = 1440 x 400 / page area; the white share is the rest of the page minus the small boxes
  const pageArea = d.viewport.width * d.layout.documentHeight.value;
  assert.ok(Math.abs(band.backgroundShare.value - (1440 * 400) / pageArea) < 0.02, `band share ${band.backgroundShare.value}`);
  assert.ok(white.backgroundShare.value > 0.7 && white.backgroundShare.value + band.backgroundShare.value <= 1.01, `white share ${white.backgroundShare.value}`);
  const txt = formatDesign(d); assert.match(txt, /page background #ffffff/); assert.match(txt, /main background \(most visible area\) #ffffff · most used background #7f7dfc/);
  assert.match(designSection(d), /Page background/);
});

test('a declared webfont that did not load: said next to the family, in gaps, text and card; never exact', () => {
  const f = d.fonts.families.find((x) => x.family === 'MissingFace');
  assert.ok(f, 'the declared first family is listed');
  assert.equal(f.loaded, false); assert.notEqual(f.source.label, 'exact'); assert.ok(f.faceStatus.includes('error'));
  // the fallback is the OS's own serif for the stack "MissingFace, Georgia, serif": Georgia on macOS; a Linux machine without
  // Georgia draws its default serif (e.g. Liberation Serif), and the read must name that face, whatever it is
  const fb = process.platform === 'darwin' ? 'Georgia' : f.drawnAs.find((n) => !/missingface/i.test(n));
  assert.ok(fb && f.drawnAs.some((n) => n.toLowerCase() === fb.toLowerCase()), `drawn as ${f.drawnAs}`);
  const esc = fb.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.equal(d.fonts.notLoaded, 1);
  assert.ok(d.gaps.some((g) => g.id === 'webfont_not_loaded' && g.count === 1));
  const txt = formatDesign(d);
  assert.match(txt, new RegExp(`MissingFace .*declared webfont did not load; drawn as ${esc}`));
  assert.match(txt, new RegExp(`drawn with: .*${esc} \\(system\\)`));
  assert.doesNotMatch(txt, /MissingFace[^\n]*webfont \[exact\]/);
  assert.match(designSection(d), new RegExp(`declared webfont did not load; drawn as ${esc}`));
});

// design-bg-h100.html: html, body { height: 100% } on a 5000 px document; expected shares in the fixture's header
test('visible area with html, body at 100 % height: no area counted twice, the shares add up to 1', () => {
  assert.equal(h.ok, true, h.error);
  // the full palette (no cap) from the archive the pass wrote, so colours below the listing cut still show their share
  const dir = path.join(root, 'h100', 'static'); const rec = JSON.parse(fs.readFileSync(path.join(dir, 'static.json'), 'utf8'));
  const P = summarizeDesign(rec, loadElements(dir, rec.variants[0]), { maxColours: 500 }).palette;
  const share = (hex) => { const c = P.colours.find((x) => x.hex.value === hex); return c && c.backgroundShare ? c.backgroundShare.value : 0; };
  assert.equal(h.layout.documentHeight.value, 5000); assert.equal(h.viewport.width, 1440);
  assert.deepEqual([P.pageBackground.hex.value, P.pageBackground.from], ['#ffffff', 'body']);
  assert.equal(P.mainBackground, '#111111', 'the dark section, not the 100 %-tall body, paints the most');
  const want = { '#111111': 0.63, '#ffffff': 0.15, '#0d1738': 0.14, '#333333': 0.07, '#00aa55': 0.01 };
  for (const [hex, v] of Object.entries(want)) assert.ok(Math.abs(share(hex) - v) <= 0.015, `${hex} share ${share(hex)}, want ${v}`);
  const sum = P.colours.reduce((t, c) => t + (c.backgroundShare ? c.backgroundShare.value : 0), 0);
  assert.ok(Math.abs(sum - 1) <= 0.02, `shares add up to ${sum}`);
});

test('a large panel used once is listed even when the palette is full', () => {
  const P = h.palette; const panel = P.colours.find((c) => c.hex.value === '#0d1738');
  assert.ok(P.colours.length <= 16 && P.more > 0, `palette ${P.colours.length}, more ${P.more}: the cap is reached`);
  assert.ok(panel, 'the #0d1738 panel (count 1, 14 % of the page) is listed');
  assert.equal(panel.count, 1); assert.equal(panel.role, 'surface');
});

test('only the main background has the role background; tokens name the page and main backgrounds', async () => {
  const { designCss, designTokens } = await import('../../src/design/export.js');
  for (const x of [d, h]) assert.deepEqual(x.palette.colours.filter((c) => c.role === 'background').map((c) => c.hex.value), [x.palette.mainBackground]);
  assert.equal(h.palette.colours.find((c) => c.hex.value === '#ffffff').role, 'surface', 'the page background is a surface here');
  const css = designCss(h); const tk = designTokens(h);
  const id = (hex) => h.palette.colours.find((c) => c.hex.value === hex).id;
  assert.match(css, new RegExp(`--reva-color-main-bg: var\\(--reva-color-${id('#111111')}\\);[^\\n]*background share 0\\.6`));
  assert.match(css, new RegExp(`--reva-color-page-bg: var\\(--reva-color-${id('#ffffff')}\\);`));
  assert.match(css, /--reva-color-c\d+: #0d1738; \/\* surface; [^*]*background share 0\.14/);
  assert.equal(tk.color['main-bg'].$value, `{color.${id('#111111')}}`); assert.equal(tk.color['page-bg'].$value, `{color.${id('#ffffff')}}`);
  assert.equal(tk.color[id('#0d1738')].$extensions['com.reva'].backgroundShare, 0.14);
});

