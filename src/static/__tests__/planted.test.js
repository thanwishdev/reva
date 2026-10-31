// Planted-value gate for the static layer (PLAN M4 DONE-WHEN "static"): runs the whole extraction ONCE on the own fixture
// fixtures/static and checks every planted value against fixtures/static/truth.json.
//   - every planted value that computed styles expose is recovered, with provenance `measured`
//   - declared sources are the cascade winners (not the losing rule), cross-origin sheets included
//   - what computed styles cannot expose is recovered another way (variants, forced states, breakpoint sweep) or `unknown` with a reason
//   - no wrong value carries `declared` or `measured`
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serveStaticFixture, FIXTURE_DIR } from '../../../fixtures/static/server.js';
import { extractStatic, loadElements, writeRecord } from '../extract.js';
import { assertTagged, walkTagged } from '../prov.js';
import { parseColor, toHex } from '../color.js';
import { parseShadowList } from '../shadow.js';

const truth = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'truth.json'), 'utf8'));
let srv, record, outDir, series = {};
const V = id => record.variants.find(v => v.id === id);
const rows = vid => { if (!series[vid]) series[vid] = loadElements(outDir, V(vid)); return series[vid]; };
const rowOf = (vid, sel) => rows(vid).rows.find(r => r.sel === sel);
const styleOf = (vid, sel, prop) => { const d = rows(vid); const r = rowOf(vid, sel); assert.ok(r, `${vid}: no row for ${sel}`); return d.styles[r.s][d.props.indexOf(prop)]; };
const same = (a, b) => (/^-?[\d.]+px$/.test(String(a)) && /^-?[\d.]+px$/.test(String(b))) ? Math.abs(parseFloat(a) - parseFloat(b)) < 0.011 : a === b;

before(async () => {
  srv = await serveStaticFixture();
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-static-'));
  ({ record } = await extractStatic({ url: srv.origin + '/', outDir, engine: 'chs' }));
  writeRecord(record, outDir);
});
after(async () => { await srv?.close(); if (outDir) fs.rmSync(outDir, { recursive: true, force: true }); });

test('H6: every tagged value in the record is well formed (declared has a source, inferred a "from", unknown a reason and probe)', () => {
  let n = 0; walkTagged(record, (node, p) => { assertTagged(node, p); n++; });
  assert.ok(n > 300, `only ${n} tagged values`);
  for (const u of record.unknowns) assert.ok(u.id.startsWith('unk_') && u.reason && u.probe, JSON.stringify(u));
});

test('planted computed values: recovered from computed styles AND present in the right token family tagged measured', () => {
  for (const t of truth.computed) {
    const got = styleOf(t.variant, t.sel, t.prop);
    assert.ok(same(got, t.expect), `${t.id}: ${t.sel} ${t.prop} = ${got}, planted ${t.expect}`);
    const tok = V(t.variant).tokens;
    let hit;
    if (t.family === 'typography') hit = tok.typography.find(x => same(x[t.field].value, t.expect) && x[t.field].provenance === 'measured');
    else if (t.family === 'color') hit = tok.colors.find(x => x.raw.value === t.expect && x.raw.provenance === 'measured');
    else if (t.family === 'spacing') hit = tok.spacing.scale.find(x => Math.abs(x.px.value - parseFloat(t.expect)) < 0.011 && x.px.provenance === 'measured');
    else if (t.family === 'shadow') hit = tok.shadows.find(x => x.raw.value === t.expect && x.raw.provenance === 'measured');
    else if (t.family === 'radius') hit = tok.radii.find(x => Object.values(x.corners.value).includes(t.expect) && x.corners.provenance === 'measured');
    assert.ok(hit, `${t.id}: no ${t.family} token carries ${t.expect} tagged measured`);
    if (t.rendered === false) assert.equal(rowOf(t.variant, t.sel).rendered, false);
    if (t.hex) { assert.equal(hit.hex.provenance, 'inferred'); assert.equal(hit.hex.value, t.hex); assert.equal(hit.hex.exact, false); }
  }
});

test('typography derived values are inferred, never defaulted (letter-spacing em, line-height ratio, line-height: normal)', () => {
  const t = V('desktop-1440').tokens.typography;
  const h1 = t.find(x => x.fontSize.value === '40px' && x.fontWeight.value === '700');
  assert.equal(h1.letterSpacingEm.provenance, 'inferred'); assert.equal(h1.letterSpacingEm.value, -0.02);
  assert.equal(h1.lineHeightRatio.provenance, 'inferred'); assert.equal(h1.lineHeightRatio.value, 1.15);
  const normal = t.find(x => x.lineHeight.value === 'normal' && x.fontSize.value === '20px');
  assert.equal(normal.letterSpacing.value, 'normal'); // the string, not a made-up 0
  // line-height: normal resolves from font metrics (and from the fallback font where the planted face lacks glyphs), so the
  // expected number is the independently measured box of this single-line element, not a constant
  for (const u of truth.usedLineHeight) {
    const box = rowOf(u.variant, u.sel).rect[3];
    assert.equal(normal.lineHeightRatio.provenance, 'inferred');
    assert.equal(normal.lineHeightRatio.usedPx, box);
    assert.equal(normal.lineHeightRatio.value, +(box / 20).toFixed(4));
  }
});

test('layout boxes: planted sizes measured per viewport; flex direction changes at the planted query', () => {
  for (const l of truth.layout) {
    const b = V(l.variant).tokens.layout.boxes.find(x => x.sel === l.sel);
    assert.ok(b, `${l.id}: no box`);
    assert.equal(b.rect.provenance, 'measured');
    if (l.w != null) { assert.equal(Math.round(b.rect.value.w), l.w, l.id); assert.equal(Math.round(b.rect.value.h), l.h, l.id); }
    if (l.flexDirection) assert.equal(b.flex.value.direction, l.flexDirection, l.id);
  }
});

test('declared sources are the cascade winners with file and provenance declared (cross-origin sheet included, !important respected)', () => {
  for (const d of truth.declared) {
    const row = rowOf(d.variant, d.sel); const dec = row.decl?.[d.prop];
    assert.ok(dec, `${d.id}: no declared source for ${d.sel} ${d.prop}`);
    assert.equal(dec.text, d.text, d.id);
    assert.ok(String(dec.file).endsWith(d.file), `${d.id}: file ${dec.file}`);
    if (d.important) assert.equal(dec.important, true);
    if (d.via) assert.equal(dec.via, d.via);
  }
  // token-level provenance: the lede token carries the declared entry tagged declared
  const lede = V('desktop-1440').tokens.typography.find(t => t.examples.includes('#t-lede'));
  const fs19 = lede.declared.find(x => x.prop === 'font-size');
  assert.equal(fs19.provenance, 'declared'); assert.equal(fs19.value, '19px');
  assert.ok(!lede.declared.some(x => x.value === '20px'), 'the losing 20px rule must not be reported');
});

test('no wrong value is tagged declared: every declared entry agrees with the computed value or says why it is unchecked', () => {
  const vid = 'desktop-1440'; const d = rows(vid);
  let checked = 0, unchecked = 0;
  for (const r of d.rows) for (const [prop, dec] of Object.entries(r.decl || {})) {
    assert.ok(dec.file != null || dec.via === 'inline-style', `${r.sel} ${prop}: declared without a file`);
    if (dec.verified) checked++; else { unchecked++; assert.ok(dec.note, `${r.sel} ${prop}: unverified declared without a note`); }
  }
  assert.ok(checked > 100 && checked > unchecked, `checked ${checked}, unchecked ${unchecked}`);
  // an independent re-check of absolute px declarations against the computed value
  for (const r of d.rows) for (const [prop, dec] of Object.entries(r.decl || {})) {
    const comp = d.styles[r.s][d.props.indexOf(prop)];
    if (/^-?[\d.]+px$/.test(dec.text)) assert.ok(same(comp, dec.text), `${r.sel} ${prop}: declared ${dec.text} vs computed ${comp}`);
    const dc = /^#[0-9a-f]{3,8}$/i.test(dec.text) ? parseColor(dec.text) : null;
    if (dc) { const cc = parseColor(comp); assert.ok(cc && ['r', 'g', 'b'].every(k => Math.abs(dc[k] - cc[k]) <= 1), `${r.sel} ${prop}: declared ${dec.text} vs computed ${comp}`); }
  }
});

test('custom properties are declared with their source', () => {
  for (const c of truth.customProperties) {
    const hit = record.declared.customProperties.find(x => x.name === c.name);
    assert.ok(hit, c.name); assert.equal(hit.value.provenance, 'declared'); assert.equal(hit.value.value, c.value);
  }
});

test('states computed styles cannot show: :hover / :focus recovered by forcing the pseudo class, tagged measured with the state', () => {
  for (const s of truth.states) {
    const hit = V('desktop-1440').states.find(x => x.sel === s.sel && x.state === s.state && x.prop === s.prop);
    assert.ok(hit, s.id); assert.equal(hit.value.provenance, 'measured'); assert.equal(hit.value.state, s.state); assert.equal(hit.value.value, s.expect);
  }
});

test('breakpoints: width sweep + layout signature + binary search finds every planted edge to the pixel and explains it', () => {
  const edges = record.breakpoints.edges;
  assert.equal(edges.length, truth.breakpoints.length, JSON.stringify(edges.map(e => [e.lastOld.value, e.firstNew.value])));
  for (const b of truth.breakpoints) {
    const e = edges.find(x => x.lastOld.value === b.lastOld);
    assert.ok(e, b.id); assert.equal(e.firstNew.value, b.firstNew); assert.equal(e.lastOld.provenance, 'measured');
    if (b.explainedBy) {
      assert.equal(e.explainedBy.length, 1, b.id); assert.equal(e.explainedBy[0].value, b.explainedBy);
      assert.equal(e.explainedBy[0].provenance, 'declared'); assert.equal(e.explainedBy[0].kind, b.kind);
      if (b.crossOriginSheet) assert.ok(String(e.explainedBy[0].source).endsWith('ext.css'));
    } else { assert.equal(e.explanation.provenance, 'unknown'); assert.equal(e.explanation.unknown, b.unknown); assert.ok(e.explanation.reason && e.explanation.probe); }
  }
  assert.ok(record.breakpoints.fluidCells > 0, 'fluid cells should be masked (clamp() text, auto widths)');
});

test('unknowns: what computed styles cannot expose is listed with a reason, never guessed', () => {
  for (const u of truth.unknown) {
    const hit = record.unknowns.find(x => x.id === u.unknown && (u.scope == null || String(x.scope).includes(u.scope)));
    assert.ok(hit, `${u.id}: ${u.unknown} not in the ledger`); assert.ok(hit.reason.length > 10 && hit.probe.length > 5);
    if (u.plantedValue) assert.ok(!JSON.stringify(record).toLowerCase().includes(u.plantedValue), `${u.id}: planted value ${u.plantedValue} leaked into the record`);
  }
  // nothing in the record claims a canvas colour
  assert.ok(!JSON.stringify(record.variants.map(v => v.tokens.colors)).includes('255, 0, 170'));
});

test('fonts: actually used (custom + fallback), declared-but-unused listed, bytes from the session response, no second fetch', () => {
  const f = record.assets.fonts;
  const custom = f.used.find(x => x.familyName.value === truth.fonts.customUsed); assert.ok(custom && custom.isCustomFont.value === true && custom.glyphCount.value > 0);
  assert.ok(f.used.some(x => x.familyName.value === truth.fonts.fallbackUsed && x.isCustomFont.value === false), 'fallback font actually used must be listed');
  assert.ok(!f.used.some(x => x.familyName.value === truth.fonts.declaredNotUsed), 'a declared but unused face must not appear as used');
  assert.ok(f.declaredNotUsed.includes(truth.fonts.declaredNotUsed));
  const file = f.files.find(x => x.url.endsWith('wr-plant.ttf')); assert.equal(file.bytes.value, truth.fonts.fileBytes); assert.equal(file.bytes.provenance, 'measured');
  assert.equal(file.family, truth.fonts.customUsed);
  assert.equal(f.files.length, 1, 'the unused face must not have been fetched');
  assert.equal(fs.statSync(path.join(FIXTURE_DIR, 'wr-plant.ttf')).size, truth.fonts.fileBytes);
});

test('svg inventory: inline svg, external svg with bytes, css-background svg', () => {
  const s = record.assets.svg;
  assert.equal(s.inline.length, 1); assert.equal(s.inline[0].viewBox, truth.svg.inlineViewBox);
  const mark = s.external.find(x => x.url.endsWith(truth.svg.externalImg)); assert.equal(mark.referencedBy, 'img');
  assert.equal(mark.bytes.value, fs.statSync(path.join(FIXTURE_DIR, 'mark.svg')).size);
  const dots = s.external.find(x => x.url.endsWith(truth.svg.externalBackground)); assert.equal(dots.referencedBy, 'css background');
  assert.equal(dots.bytes.value, fs.statSync(path.join(FIXTURE_DIR, 'dots.svg')).size);
});

test('a11y: ariaSnapshot per viewport; the planted nav item disappears on mobile', () => {
  const d = record.a11y.find(a => a.variant === 'desktop-1440').snapshot, m = record.a11y.find(a => a.variant === 'mobile-390').snapshot;
  for (const s of truth.a11y.desktopHas) assert.ok(d.includes(s), `desktop snapshot lacks ${s}`);
  for (const s of truth.a11y.mobileLacks) assert.ok(!m.includes(s), `mobile snapshot should lack ${s}`);
  assert.ok(/\[box=/.test(d), 'boxes requested');
});

test('scripts: external and inline scripts are saved byte-exact under the out dir for the bundle-signature step (libdetect); no library claim is made here', () => {
  const f = record.scripts.files;
  const stub = f.find(x => x.name.endsWith('stub-libs.js')); assert.ok(stub, 'external script saved');
  const body = fs.readFileSync(path.join(outDir, stub.file));
  assert.equal(body.length, fs.statSync(path.join(FIXTURE_DIR, 'stub-libs.js')).size); assert.equal(stub.bytes, body.length);
  assert.ok(f.some(x => x.name.startsWith('inline script')), 'inline script saved');
  assert.ok(body.toString().includes('GreenSock'));
  assert.equal(record.libraries, undefined);
});

test('session hygiene: own session, nothing written to the page but the query log, no live request', () => {
  assert.equal(record.environment.session.value.sharedWithMotionTake, false);
  assert.equal(record.environment.session.value.browserLaunches, 1);
  assert.equal(record.environment.blockedExternalRequests, 0);
  assert.ok(record.target.local);
});

test('variants: dark and reduced-motion are separate passes with deltas reported', () => {
  assert.ok(record.variantDeltas.find(d => d.variant === 'desktop-1440-dark'));
  assert.ok(record.variantDeltas.find(d => d.variant === 'desktop-1440-reduced-motion'));
  assert.equal(V('desktop-1440-dark').media.value.prefersDark, true);
  assert.equal(V('desktop-1440-reduced-motion').media.value.prefersReducedMotion, true);
  assert.equal(V('mobile-390').media.value.pointerCoarse, true);
});
