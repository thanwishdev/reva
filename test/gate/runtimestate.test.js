// Corpus stage S3: runtime style state the rule table cannot see (CSS.registerProperty, FontFace added from JS, WAAPI
// effect values) is recorded in the original, stored with the capture, and re-created by the rebuild from that data
// alone (scripts blocked by CSP). One fixture page covers each hook; a unit test covers the table emit.
// Browser test: one headless browser, ~5 s.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchBrowser } from '../../src/browser/launch.js';
import { captureRuleTable } from '../../src/static/ruletable.js';
import { renderRebuild } from '../../src/gate/rebuild.js';
import { runtimeStateRecorder } from '../../src/gate/runtimestate.js';
import { captureRuntimeState, saveRuntimeState, loadRuntimeState, applyRuntimeState, keySelector } from '../../src/gate/runtimeemit.js';
import { REPO_ROOT } from '../../src/util/paths.js';

const ORIGIN = 'http://wr-s3.test';
const FONT = fs.readFileSync(path.join(REPO_ROOT, 'fixtures/static/wr-plant.ttf'));

const PAGE = `<!doctype html><html><head><style>
body { margin: 0; font: 20px/1.2 serif }
.sz { width: var(--wr-size); height: 10px; background: red }
.u { font-family: "WR Url", serif } .b { font-family: "WR Buf", serif }
.pe::before { content: "x"; display: inline-block }
</style></head><body>
<div class="sz" id="sz"><i>inherits?</i></div>
<p><span class="u" id="u">Plant growth 123</span></p>
<p><span class="b" id="b">Plant growth 123</span></p>
<p><span id="ref">Plant growth 123</span></p>
<div id="fade">fade</div><div id="mid">mid</div><div class="pe" id="pe">pe</div>
<script>
CSS.registerProperty({ name: '--wr-size', syntax: '<length>', inherits: false, initialValue: '37px' });
CSS.registerProperty({ name: '--wr-tint', syntax: '<color>', inherits: true, initialValue: 'rgb(1, 2, 3)' });
window.__dupThrows = (() => { try { CSS.registerProperty({ name: '--wr-size', syntax: '<length>', inherits: false, initialValue: '1px' }); return false; } catch (e) { return true; } })();
class MyFace extends FontFace {}
window.__ctor = { inst: new FontFace('T', 'local(Arial)') instanceof FontFace, name: FontFace.name, sub: new MyFace('S', 'local(Arial)') instanceof MyFace };
const u = new FontFace('WR Url', 'url(/wr-plant.ttf)', { display: 'block' }); document.fonts.add(u); u.load();
fetch('/wr-plant.ttf').then(r => r.arrayBuffer()).then(buf => { const f = new FontFace('WR Buf', buf, { weight: '400' }); document.fonts.add(f); return f.load(); }).then(() => { window.__fontsDone = true; });
document.getElementById('fade').animate([{ opacity: 1, transform: 'none' }, { opacity: 0.25, transform: 'translateX(40px)' }], { duration: 400, fill: 'forwards' }).finish();
const m = document.getElementById('mid').animate({ opacity: [1, 0], backgroundColor: ['rgb(0, 0, 255)', 'rgb(255, 0, 0)'] }, { duration: 1000, iterations: Infinity }); m.pause(); m.currentTime = 500;
document.getElementById('pe').animate({ opacity: [1, 0.5] }, { duration: 10, fill: 'forwards', pseudoElement: '::before' }).finish();
</script></body></html>`;

const READ = () => {
  const cs = (id, p, pe) => getComputedStyle(document.getElementById(id), pe).getPropertyValue(p);
  const w = id => document.getElementById(id).getBoundingClientRect().width;
  return {
    size: cs('sz', '--wr-size'), width: cs('sz', 'width'), innerSize: getComputedStyle(document.querySelector('#sz i')).getPropertyValue('--wr-size'),
    tint: cs('u', '--wr-tint'), wu: w('u'), wb: w('b'), wref: w('ref'),
    fade: [cs('fade', 'opacity'), cs('fade', 'transform')], mid: [cs('mid', 'opacity'), cs('mid', 'background-color')], pe: cs('pe', 'opacity', '::before'),
  };
};

async function serve(context, html, rebuilds) {
  await context.route(`${ORIGIN}/**`, r => {
    const u = new URL(r.request().url());
    if (u.pathname === '/wr-plant.ttf') return r.fulfill({ status: 200, contentType: 'font/ttf', body: FONT });
    if (rebuilds[u.pathname]) return r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', headers: { 'content-security-policy': "script-src 'none'" }, body: rebuilds[u.pathname] });
    if (u.pathname === '/') return r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html });
    return r.fulfill({ status: 404, body: '' });
  });
}

test('keySelector maps a table key to an nth-of-type path', () => {
  assert.equal(keySelector('html/body[1]/div[2]/my-el[1]'), 'html>body:nth-of-type(1)>div:nth-of-type(2)>my-el:nth-of-type(1)');
});

test('applyRuntimeState adds one last sheet the renderer turns into @property / @font-face / frozen rules', () => {
  const T = { docs: [{ sheets: [0], tree: { t: 'html', i: 0, c: [{ t: 'body', i: 1, c: ['x'] }] } }], sheets: [{ sid: 0, scope: 'd0', rules: [0] }],
    rules: [{ id: 0, t: 'style', sel: 'body', d: [['margin', '0']], sheet: 0, scope: 'd0', ctx: [] }], els: [{ k: 'html' }, { k: 'html/body[1]', r: [0] }] };
  const st = { recorder: true, props: [{ name: '--a', syntax: '<length>', inherits: false, initialValue: '2px' }, { name: '--any', syntax: '*', inherits: true, initialValue: null }],
    fonts: [{ family: 'My Font', src: 'url("http://x.test/f.woff2")', style: 'normal', weight: '700', display: 'swap', unicodeRange: 'U+0-10FFFF' }],
    waapi: [{ k: 'html/body[1]', name: 'waapi', frozen: { opacity: '0.5' } }, { k: 'html/body[1]', name: 'b', frozen: { transform: 'matrix(1, 0, 0, 1, 4, 0)' } }, { k: 'html/body[9]', name: 'gone', frozen: { opacity: '0' } }], skipped: {} };
  const sum = applyRuntimeState(T, st);
  assert.deepEqual([sum.props, sum.fonts, sum.waapiRules, sum.waapiProps, sum.skipped.waapiNotInTable], [2, 1, 1, 2, 1]);
  assert.equal(applyRuntimeState(T, st), sum, 'idempotent');
  assert.equal(T.rules.length, 5);
  const { html } = renderRebuild(T);
  const css = /<style data-wr-gen>([\s\S]*?)<\/style>/.exec(html)[1];
  assert.match(css, /^body\{margin:0\}\n@property --a\{syntax:"<length>";inherits:false;initial-value:2px\}@property --any\{syntax:"\*";inherits:true\}/);
  assert.match(css, /@font-face\{font-family:"My Font";src:url\("http:\/\/x\.test\/f\.woff2"\);font-weight:700;font-display:swap\}/);
  assert.match(css, /html>body:nth-of-type\(1\)\{opacity:0\.5!important;transform:matrix\(1, 0, 0, 1, 4, 0\)!important\}$/);
  assert.deepEqual(T.els[1].r, [0, 4]);
});

test('runtime state: recorded in the original, re-created by the CSP-blocked rebuild', { timeout: 60000 }, async () => {
  const h = await launchBrowser({ engine: 'chs', context: { viewport: { width: 800, height: 600 } } });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-s3-'));
  try {
    const rebuilds = {};
    await serve(h.context, PAGE, rebuilds);
    await h.context.addInitScript(runtimeStateRecorder);
    await h.page.goto(`${ORIGIN}/`);
    await h.page.waitForFunction(() => window.__fontsDone === true);
    await h.page.evaluate(() => document.fonts.ready);
    // the recorder is transparent: duplicate registration still throws, FontFace keeps instanceof / name / subclassing
    assert.equal(await h.page.evaluate(() => window.__dupThrows), true);
    assert.deepEqual(await h.page.evaluate(() => window.__ctor), { inst: true, name: 'FontFace', sub: true });
    const orig = await h.page.evaluate(READ);
    // the fixture really exercises each gap: registered value on every element, both JS fonts change the text width
    assert.deepEqual([orig.size, orig.width, orig.innerSize, orig.tint], ['37px', '37px', '37px', 'rgb(1, 2, 3)']);
    assert.notEqual(orig.wu, orig.wref); assert.notEqual(orig.wb, orig.wref);
    assert.deepEqual(orig.fade, ['0.25', 'matrix(1, 0, 0, 1, 40, 0)']);
    assert.equal(orig.pe, '0.5');

    const table = await captureRuleTable(h.page, null, { usage: false });
    const stored = saveRuntimeState(await captureRuntimeState(h.page), dir, 'A');
    assert.equal(stored.props.length, 2);
    assert.deepEqual(stored.fonts.map(f => [f.family.replace(/"/g, ''), f.status, !!f.src, !!f.file]), [['WR Url', 'loaded', true, false], ['WR Buf', 'loaded', false, true]]);
    assert.equal(stored.fonts[0].src, `url("${ORIGIN}/wr-plant.ttf")`);
    assert.equal(fs.readFileSync(path.join(dir, stored.fonts[1].file)).equals(FONT), true, 'buffer font stored as an archive file');
    assert.equal(stored.waapi.length, 3);
    assert.ok(stored.waapi.every(a => a.decl.keyframes.length >= 2 && a.provenance === 'declared'));

    rebuilds['/plain'] = renderRebuild(JSON.parse(JSON.stringify(table))).html; // without S3: the gap
    const sum = applyRuntimeState(table, loadRuntimeState(dir, 'A'), { dir });
    assert.deepEqual([sum.props, sum.fonts, sum.waapiRules], [2, 2, 3]);
    rebuilds['/rebuild'] = renderRebuild(table).html;
    assert.ok(!/<script/i.test(rebuilds['/rebuild']));

    const read = async p => { const pg = await h.context.newPage(); try { await pg.goto(`${ORIGIN}${p}`); await pg.evaluate(() => document.fonts.ready); return { v: await pg.evaluate(READ), ran: await pg.evaluate(() => window.__fontsDone === true) }; } finally { await pg.close(); } };
    const plain = await read('/plain'), rb = await read('/rebuild');
    assert.equal(rb.ran, false, 'no site script ran in the rebuild');
    assert.notEqual(plain.v.size, orig.size); assert.notEqual(plain.v.wb, orig.wb); assert.notDeepEqual(plain.v.fade, orig.fade);
    assert.deepEqual(rb.v, orig);
  } finally { await h.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
