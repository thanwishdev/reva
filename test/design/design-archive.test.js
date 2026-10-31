// The design pass on frozen archives (offline replay, no network). Archives are private site data and never in the repo:
// REVA_TEST_ARCHIVES (comma list of archive / corpus run folders) names them; without it the first two corpus runs with an
// archive under the private data root are used; with none the test skips.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { privateRoot } from '../../src/util/paths.js';
import { resolveSource } from '../../src/look/source.js';
import { runDesignPass } from '../../src/design/pass.js';
import { designCss } from '../../src/design/export.js';

function archives() {
  if (process.env.REVA_TEST_ARCHIVES) return process.env.REVA_TEST_ARCHIVES.split(',').map((s) => s.trim()).filter(Boolean);
  const sites = path.join(privateRoot(), 'corpus', 'sites'); const out = [];
  if (!fs.existsSync(sites)) return out;
  for (const s of fs.readdirSync(sites).sort()) {
    const d = path.join(sites, s); if (!fs.statSync(d).isDirectory()) continue;
    for (const r of fs.readdirSync(d).sort()) if (fs.existsSync(path.join(d, r, 'archive', 'target.json'))) { out.push(path.join(d, r)); break; }
    if (out.length >= 2) break;
  }
  return out;
}
const list = archives();
// notes and labels are our own words; everything else in the summary is numbers, units, hex, tags and checked names
const withoutNotes = (d) => JSON.stringify(d, (k, v) => (k === 'note' || k === 'labels' || k === 'record' ? undefined : v));

for (const [i, dir] of list.entries()) {
  test(`archive ${i + 1}: design pass offline, structured, content-free`, { timeout: 180000 }, async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-design-arch-'));
    const t0 = Date.now();
    const d = await runDesignPass({ src: resolveSource(dir), outDir: path.join(out, 'static') });
    const ms = Date.now() - t0;
    assert.equal(d.ok, true, d.error);
    assert.ok(ms < 90000, `design pass took ${ms} ms`);
    assert.ok(d.fonts.families.length >= 1 && d.type.styles.length >= 1 && d.palette.colours.length >= 1, 'fonts, type and colours found');
    for (const s of d.type.styles) { assert.ok(['exact', 'measured'].includes(s.size.label)); assert.equal(s.size.unit, 'px'); }
    for (const c of d.palette.colours) assert.match(c.hex.value, /^#[0-9a-f]{6}([0-9a-f]{2})?$/);
    assert.ok(d.breakpoints.range.from === 320 && d.breakpoints.range.to >= 1840);
    const rec = JSON.parse(fs.readFileSync(d.record, 'utf8'));
    assert.equal(rec.a11y.length, 0, 'no accessibility snapshot (page words)');
    const s = withoutNotes(d);
    assert.doesNotMatch(s, /https?:|<|>|url\(/, 'no URL, markup or selector in the summary');
    assert.match(designCss(d), /^:root \{$/m);
    fs.rmSync(out, { recursive: true, force: true });
    console.log(`archive ${i + 1}: ${(ms / 1000).toFixed(1)} s, ${d.type.styles.length} styles, ${d.palette.colours.length} colours, ${d.breakpoints.layoutChanges.length} breakpoints`);
  });
}
// repeat-run stability: the same archive read twice gives the same type scale (script-sized text waited for) and the
// same breakpoints; a pass that saw text still changing says so (settle.textStable false) instead of passing silently
if (list.length) test('archive 1: two design passes agree on the type scale and breakpoints', { timeout: 300000 }, async () => {
  const runs = [];
  for (let i = 0; i < 2; i++) {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-design-rep-'));
    const d = await runDesignPass({ src: resolveSource(list[0]), outDir: path.join(out, 'static') });
    fs.rmSync(out, { recursive: true, force: true });
    assert.equal(d.ok, true, d.error); assert.equal(typeof d.settle.textStable, 'boolean'); runs.push(d);
  }
  const top = (d) => d.type.scale.slice(0, 6).map((x) => x.size.value);
  if (runs.every((d) => d.settle.textStable)) assert.deepEqual(top(runs[1]), top(runs[0]), 'type scale differs between two runs');
  else console.log('archive 1: text sizes flagged unsettled', runs.map((d) => d.settle.textStable));
  // breakpoints a media query explains are stable; an unexplained one (script-driven or at the edge of fluid sizing) may
  // move by a pixel or come and go between runs, and is printed as unexplained
  const bps = (d) => d.breakpoints.layoutChanges.filter((e) => e.query).map((e) => e.at);
  assert.deepEqual(bps(runs[1]), bps(runs[0]), 'explained breakpoints differ between two runs');
});
if (!list.length) test('archives: none in the private data root', { skip: 'no archive found (set REVA_TEST_ARCHIVES)' }, () => {});
