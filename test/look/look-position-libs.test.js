// look.json "position" (element boxes at the start / end of each motion + the end crop) and "libraries" (motion / scroll
// libraries with evidence). Unit parts are pure; the end-to-end parts run on our own fixtures (localhost, no network).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { serveFixture } from '../helpers.js';
import { runLook } from '../../src/look/index.js';
import { formatLook } from '../../src/look/cli.js';
import { motionPositions, cropsFor, visiblePart, unionOf } from '../../src/look/position.js';
import { detectFrom, mechanismsOf, librariesLine } from '../../src/look/libs.js';

const VP = { width: 400, height: 300 };
const row = (T, boxes, sy = 0) => ({ T, sy, sx: 0, v: Object.fromEntries(Object.entries(boxes).map(([id, b]) => [id, { 'ren:bx': b[0], 'ren:by': b[1], 'ren:bw': b[2], 'ren:bh': b[3] }])) });
const shotOf = (w, h, rgb) => { const p = new PNG({ width: w, height: h }); for (let i = 0; i < w * h; i++) { p.data[i * 4] = rgb[0]; p.data[i * 4 + 1] = rgb[1]; p.data[i * 4 + 2] = rgb[2]; p.data[i * 4 + 3] = 255; } return PNG.sync.write(p); };

test('position (unit): rest box before the motion, box at its last change, scroll offsets, group union', () => {
  // element 1 slides x 100 -> 160 between T 20 and T 40; members 2 and 3 start 10 ms apart
  const rows = [row(0, { 1: [100, 50, 40, 20], 2: [10, 10, 20, 20], 3: [10, 40, 20, 20] }), row(10, { 1: [100, 50, 40, 20], 2: [10, 10, 20, 20], 3: [10, 40, 20, 20] }),
    row(20, { 1: [110, 50, 40, 20], 2: [10, 10, 20, 20], 3: [10, 40, 20, 20] }, 5), row(30, { 1: [140, 50, 40, 20], 2: [30, 10, 20, 20], 3: [10, 40, 20, 20] }, 5),
    row(40, { 1: [160, 50, 40, 20], 2: [30, 10, 20, 20], 3: [30, 40, 20, 20] }, 5), row(50, { 1: [160, 50, 40, 20], 2: [30, 10, 20, 20], 3: [30, 40, 20, 20] }, 5)];
  const stats = new Map([[1, { firstMoveT: 20, lastMoveT: 40 }], [2, { firstMoveT: 30, lastMoveT: 30 }], [3, { firstMoveT: 40, lastMoveT: 40 }]]);
  const pos = motionPositions({ entries: [{ rank: 1, kind: 'element', lead: 1, ids: [1] }, { rank: 2, kind: 'group', lead: 2, ids: [2, 3] }, { rank: 3, kind: 'element', lead: 9, ids: [9] }], stats: new Map([...stats, [9, { firstMoveT: null }]]), rows, viewport: VP });
  const p = pos.get(1);
  assert.equal(p.label, 'measured'); assert.deepEqual(p.viewport, VP);
  assert.deepEqual([p.start.x, p.start.y, p.start.w, p.start.h, p.start.t], [100, 50, 40, 20, 10], 'rest frame = the last frame before the first change');
  assert.deepEqual([p.end.x, p.end.w, p.end.t], [160, 40, 40]); assert.deepEqual(p.end.scroll, { x: 0, y: 5 });
  const g = pos.get(2).group;
  assert.equal(g.members, 2);
  assert.deepEqual([g.start.x, g.start.y, g.start.w, g.start.h, g.start.t], [10, 10, 20, 50, 30], 'group box at the first member onset');
  assert.deepEqual([g.end.x, g.end.w, g.end.h, g.end.t], [30, 20, 50, 40], 'group box when the last member has stopped');
  assert.equal(pos.get(3), null, 'an element that never moved has no position');
  assert.deepEqual(unionOf([{ x: 0, y: 0, w: 0, h: 5 }, { x: 5, y: 5, w: 5, h: 5 }]), { x: 5, y: 5, w: 5, h: 5 }, 'a box with no area adds nothing');
});

test('crops (unit): full, partly outside, outside, no screenshot; large crops are averaged down', () => {
  const rows = [row(0, { 1: [10, 10, 50, 50], 2: [380, 10, 50, 50], 3: [10, 500, 50, 50], 4: [0, 0, 400, 300] }), row(10, { 1: [10, 10, 50, 50], 2: [380, 10, 50, 50], 3: [10, 500, 50, 50], 4: [0, 0, 400, 300] })];
  const stats = new Map([1, 2, 3, 4].map((id) => [id, { firstMoveT: 0, lastMoveT: 10 }]));
  const entries = [1, 2, 3, 4].map((id) => ({ rank: id, kind: 'element', lead: id, ids: [id] }));
  const run = (screenshot) => { const positions = motionPositions({ entries, stats, rows, viewport: VP }); const files = cropsFor({ positions, screenshot, viewport: VP, fileFor: (r) => `crops/m${r}.png` }); return { positions, files }; };
  const { positions, files } = run(shotOf(400, 300, [10, 20, 30]));
  assert.deepEqual(files.map((f) => f.path), ['crops/m1.png', 'crops/m2.png', 'crops/m4.png']);
  assert.equal(positions.get(1).image.visible, 'full'); assert.deepEqual(positions.get(1).image.box, { x: 10, y: 10, w: 50, h: 50 });
  assert.match(positions.get(2).image.visible, /^partial/); assert.deepEqual(positions.get(2).image.box, { x: 380, y: 10, w: 20, h: 50 });
  const c = PNG.sync.read(files[0].data); assert.deepEqual([c.width, c.height], [50, 50]); assert.deepEqual([...c.data.slice(0, 4)], [10, 20, 30, 255]);
  assert.equal(positions.get(3).image.path, null); assert.match(positions.get(3).image.reason, /outside the viewport/);
  const big = { width: 1200, height: 900 }; const bp = motionPositions({ entries: [entries[3]], stats, rows: [row(0, { 4: [0, 0, 1200, 900] }), row(10, { 4: [0, 0, 1200, 900] })], viewport: big });
  const bf = cropsFor({ positions: bp, screenshot: shotOf(1200, 900, [1, 2, 3]), viewport: big, fileFor: (r) => `crops/m${r}.png` });
  const bi = PNG.sync.read(bf[0].data); assert.deepEqual([bi.width, bi.height], [640, 480], 'a crop larger than 640 px is averaged down'); assert.equal(bp.get(4).image.file.pxPerCssPx, 0.53);
  assert.deepEqual([...bi.data.slice(0, 4)], [1, 2, 3, 255], 'averaging a flat colour keeps it'); assert.equal(files.length, 3);
  const none = run(null); assert.equal(none.files.length, 0); assert.match(none.positions.get(1).image.reason, /no screenshot/);
  assert.equal(visiblePart({ x: 399.5, y: 0, w: 10, h: 10 }, VP), null, 'less than a pixel inside is not a crop');
});

test('libraries (unit): detector input from scripts, evidence cleaned, versions only when they look like versions', () => {
  const ev = { modules: [{ id: 'https://cdn.example/app.js?token=SECRET#frag', kind: 'js', source: '/*!\n * GSAP 3.12.5\n */ var _gsapVersions=["3.12.5"]; window.GreenSockGlobals={};' }, { id: 'inline-script-1.js', kind: 'js', source: 'x' }],
    skipped: [{ file: 'https://cdn.example/big.js', reason: 'larger than 8 MB' }], scriptUrls: ['https://cdn.example/app.js'], dom: { globals: ['gsap'], versions: { gsap: '3.12.5‮<b>' }, classes: [], attrs: [], expandos: {}, engines: [], tags: [], scripts: [] }, inline: 1, bytes: 120, ms: 3, probeError: null };
  const l = detectFrom(ev);
  assert.equal(l.ok, true); const g = l.list.find((x) => x.id === 'gsap');
  assert.equal(g.status, 'detected'); assert.equal(g.label, 'inferred'); assert.equal(g.running.state, 'observed');
  assert.equal(g.version.value, null, 'a "version" with markup / bidi characters is not shown as a version');
  assert.ok(g.evidence.length >= 2 && g.evidence.every((e) => !/SECRET|frag/.test(JSON.stringify(e))), 'query and hash of a script URL are dropped');
  assert.deepEqual(l.scanned.skipped, ev.skipped); assert.equal(l.scanned.inline, 1); assert.equal(l.scanned.scripts, 1);
  const mech = mechanismsOf({ motions: [{ records: [{ tier: 'declared', model: { family: 'declared:css' }, declared: { births: [{ type: 'CSSTransition' }] } }] }], page: null, declaredOnly: [] }, l);
  assert.equal(mech.css_transition, 1); assert.equal(mech.css_only, false, 'a detected library: not CSS only');
  const clean = mechanismsOf({ motions: [{ records: [{ tier: 'declared', model: { family: 'declared:css' }, declared: { births: [{ type: 'CSSAnimation' }] } }] }], page: null, declaredOnly: [] }, detectFrom({ modules: [], skipped: [], scriptUrls: [], dom: null, inline: 0, bytes: 0, ms: 0 }));
  assert.equal(clean.css_only, true);
  assert.match(librariesLine(l, mech), /^libraries: GSAP .*\(detected, running\).* · inferred from signatures · motion made by: CSS transition$/);
  assert.match(librariesLine(detectFrom({ modules: [], skipped: [], scriptUrls: [], dom: null, inline: 0, bytes: 0, ms: 0 }), clean), /^libraries: none detected \(0 script\(s\) scanned; not detected is not absent\) · motion made by: CSS animation \(CSS only\)$/);
});

// ---- end to end (our own fixtures, localhost) ----
let srv;
test.before(async () => { srv = await serveFixture('look'); });
test.after(async () => { await srv.close(); });

test('look on a page that loads a tween-engine bundle and an inline smooth-scroll snippet: libraries with evidence, positions with a crop', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-look-pos-'));
  try {
    const r = await runLook({ input: srv.origin + '/libs.html', design: false, outDir: out });
    assert.equal(r.ok, true);
    // libraries
    const L = r.libraries; assert.equal(L.ok, true); assert.equal(L.label, 'inferred');
    const by = Object.fromEntries(L.list.map((x) => [x.id, x]));
    assert.ok(by.gsap && by['gsap-scrolltrigger'] && by.lenis, L.list.map((x) => x.id).join(','));
    assert.equal(by.gsap.status, 'detected'); assert.deepEqual([by.gsap.version.value, by.gsap.version.provenance], ['3.12.5', 'measured'], 'a live global');
    assert.equal(by.lenis.version.value, '1.0.42'); assert.equal(by.lenis.running.state, 'observed');
    assert.ok(by.gsap.evidence.some((e) => e.where === 'code' && /libs-engine\.js$/.test(e.file) && e.snippet), 'evidence names the script it came from');
    assert.ok(by.lenis.evidence.some((e) => e.where === 'dom' && e.observed === 'lenis'), 'and the run-time trace');
    assert.ok(by.lenis.evidence.some((e) => /^inline-script-/.test(e.file || '')), 'inline scripts are scanned');
    assert.equal(L.scanned.scripts, 1); assert.equal(L.scanned.inline, 1); assert.equal(L.scanned.dom, true);
    assert.equal(L.mechanisms.css_transition >= 1, true); assert.equal(L.mechanisms.css_only, false);
    const text = formatLook(r);
    assert.equal(text.split('\n').filter((l) => /^libraries:/.test(l)).length, 1, 'one libraries line');
    assert.match(text, /^libraries: .*Lenis 1\.0\.42 \(detected, running\).*GSAP 3\.12\.5 \(detected, running\).* · inferred from signatures · motion made by: CSS transition/m);
    // position: #card slides from x 200 (80 + the 120 px transform) to x 80; box 200 x 100 at y 120
    assert.equal(r.motions.length, 1); const p = r.motions[0].position;
    assert.equal(p.label, 'measured'); assert.deepEqual(p.viewport, { width: 1440, height: 900 });
    const near = (a, b) => Math.abs(a - b) < 1.5;
    assert.ok(near(p.start.x, 200) && near(p.start.y, 120) && near(p.start.w, 200) && near(p.start.h, 100), JSON.stringify(p.start));
    assert.ok(near(p.end.x, 80) && near(p.end.y, 120) && near(p.end.w, 200) && near(p.end.h, 100), JSON.stringify(p.end));
    assert.ok(p.start.t < p.end.t); assert.ok(p.end.t > 500, `the motion lasts ~500 ms after the class at 200 ms (end at ${p.end.t})`);
    assert.equal(p.image.path, 'crops/m1.png'); assert.equal(p.image.matchesEnd, true); assert.equal(p.image.visible, 'full');
    const png = PNG.sync.read(fs.readFileSync(path.join(out, p.image.path)));
    assert.deepEqual([png.width, png.height], [200, 100]);
    const mid = (50 * 200 + 100) * 4; assert.ok(Math.abs(png.data[mid] - 0x33) <= 2 && Math.abs(png.data[mid + 1] - 0x33) <= 2 && Math.abs(png.data[mid + 2] - 0x55) <= 2, 'the crop shows the element (#335)');
    // look.json carries the same
    const j = JSON.parse(fs.readFileSync(path.join(out, 'look.json'), 'utf8'));
    assert.deepEqual(j.motions[0].position, p); assert.equal(j.libraries.list.length, L.list.length);
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
});

test('look on a page with no library: none detected, positions of a folded group and of a scroll-linked element', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-look-pos2-'));
  try {
    const r = await runLook({ input: srv.origin + '/', action: 'load', el: '.word', design: false, outDir: out });
    assert.deepEqual(r.libraries.list, []); assert.match(formatLook(r), /^libraries: none detected \(\d+ script\(s\) scanned; not detected is not absent\)/m);
    const m = r.motions[0]; assert.equal(m.kind, 'group');
    const g = m.position.group; assert.equal(g.members, 8);
    assert.ok(g.start && g.end && g.start.t < g.end.t, 'the group box at the first onset, and when the last member stopped (60 ms apart)');
    assert.ok(g.end.w > 500, `8 words of 70 px with 12 px gaps: ${g.end.w}`);
    assert.ok(m.position.image.path && fs.existsSync(path.join(out, m.position.image.path)));
    // scroll: #track is fixed, so its viewport box moves only by its own transform; the scroll offset is recorded with each box
    const s = await runLook({ input: srv.origin + '/', action: 'scroll', el: '#track', design: false, write: false });
    const p = s.motions[0].position;
    assert.ok(p.start.x - p.end.x > 300, `the track slides left: ${p.start.x} -> ${p.end.x}`);
    assert.ok(p.end.scroll.y > p.start.scroll.y, 'the page scroll offset at each frame is recorded');
    assert.equal(p.image.path, null); assert.match(p.image.reason, /write: false/);
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
});
