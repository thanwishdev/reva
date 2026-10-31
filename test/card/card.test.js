// motion card: data (recorded vs fitted progress, travel, tabs), rendering (self-contained, escaped), CLI. No browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildCardData, curveOf, travelOf, headlineOf, tidyNumbers, propOf, fittedProgress, sameLaw, driverAt, driverOf, heroOf, HERO_MAX } from '../../src/card/data.js';
import { exportWord } from '../../src/look/exportword.js';
import { springProgress } from '../../src/export/curves.js';
import { renderCard, actionScore } from '../../src/card/render.js';
import { exportRecord } from '../../src/export/index.js';
import { NAMED } from '../../src/analysis/fit/eases.js';

const BIN = path.resolve(import.meta.dirname, '../../bin/reva.js');
const dt = 1000 / 120;
const ease = NAMED.easeOutCubic.fn;

/** A fitted easeOutCubic tween on ren:ty of element 3, 120 → 20 px, t0 100 ms, D 500 ms. */
function tweenRec({ t0 = 100, D = 500, range = [50, 900] } = {}) {
  return {
    schema: 'reva.motion/0', target: { el: 3, desc: 'DIV.hero', channel: 'ren:ty' }, class: 'tween', tier: 'fitted',
    model: { family: 'named:easeOutCubic', ease: 'easeOutCubic', params: { t0: { value: t0, provenance: 'fitted', unit: 'ms', ci95: [t0 - 0.1, t0 + 0.1] }, D: { value: D, provenance: 'fitted', unit: 'ms', ci95: [D - 1, D + 1] } } },
    derived: { t0 }, fit: { n: 80, rms: 0.01, nrmse: 0.0004 }, evidence: { location: { kind: 'time_range', range } },
  };
}
function rowsFor({ t0 = 100, D = 500, from = 120, to = 20, end = 900 } = {}) {
  const rows = [];
  for (let T = 0; T <= end; T += dt) { const u = Math.min(1, Math.max(0, (T - t0) / D)); rows.push({ T, sy: 0, v: { 3: { 'ren:ty': from + (to - from) * ease(u), 'ren:opacity': 1 } } }); }
  return rows;
}
function lookOf(rec, extra = {}) {
  const it = exportRecord(rec, { meta: { url: 'https://example.com/' } });
  return {
    schema: 'reva.look/0', ok: true, status: 'motion', errors: [], warnings: [],
    source: { kind: 'archive', startUrl: 'https://example.com/', archive: '/x' }, action: { do: 'load', el: null, on: null },
    take: { dir: '/nonexistent/take', rate: 120, frames: 108, net: { misses: 0 } },
    motions: [{
      rank: 1, kind: 'element', desc: 'DIV.hero', selector: 'div.hero', selectorWhy: null, count: 1, lead: 3, weightShare: 1,
      lines: [{ text: 'Tween, easeOutCubic (= GSAP power2.out) [fitted], 500 ms [fitted]', kind: 'tween', family: rec.model.family, label: 'fitted', channels: [rec.target.channel], trigger: 'plays on load', t0: rec.derived.t0, times: 1,
        values: [{ name: 'duration', value: 500, unit: 'ms', label: 'fitted', text: '500 ms [fitted]' }] }],
      records: [rec], exports: [{ channel: it.channel, family: it.family, kind: it.kind, model: it.model, notes: it.notes, fit: it.fit,
        exports: it.exports.map((x) => ({ lib: x.lib, form: x.form || null, code: x.code, accuracy: x.accuracy, note: x.note || null, match: { word: x.code ? 'matches fit' : 'n/a', why: x.code ? null : x.accuracy.why } })) }],
      unknowns: [{ channel: 'ren:filter', kind: 'no model', reason: 'the fitter produced no model for this channel' }], stagger: null,
    }],
    others: [], notFitted: [], ...extra,
  };
}

test('card data: recorded and fitted progress agree for a clean tween; travel and property come from the recording', () => {
  const c = curveOf(tweenRec(), rowsFor());
  assert.equal(c.axis, 'time');
  assert.ok(c.rec.length > 50 && c.fit.length > 100);
  assert.ok(c.gap.maxPct < 0.1, `gap ${c.gap.maxPct}`);
  assert.equal(c.prop.kind, 'x');
  assert.ok(Math.abs(c.prop.from - 120) < 1e-3 && Math.abs(c.prop.to - 20) < 1e-3, `${c.prop.from} -> ${c.prop.to}`);
  const last = c.rec[c.rec.length - 1]; assert.ok(Math.abs(last[1] - 1) < 1e-3);
});

test('card data: a recording cut before the motion ends is still scaled to the true travel (least squares)', () => {
  const rows = rowsFor({ end: 330 });   // stops at 46 % of the duration
  const c = curveOf(tweenRec({ range: [50, 330] }), rows);
  assert.ok(Math.abs(c.prop.to - 20) < 0.01, `to ${c.prop.to}`);
  assert.ok(c.gap.maxPct < 0.1);
  assert.equal(c.scaled, true);
  // plain first/last would have called the end 46 % of the way the end
  const t = travelOf([{ y: 5 }, { y: 5 }], () => 0); assert.deepEqual(t, { from: 5, to: 5, scaled: false });
});

test('card data: spring, smoothing and scroll map evaluate their own laws', () => {
  const spring = { target: { el: 1, channel: 'ren:tx' }, model: { family: 'spring', params: { omega: { value: 12 }, zeta: { value: 0.5 }, v0: { value: 0 } } }, derived: { t0: 0 } };
  const fs1 = fittedProgress(spring); assert.equal(fs1.axis, 'time'); assert.ok(Math.max(...Array.from({ length: 300 }, (_, i) => fs1.fn(i * 3))) > 1.1, 'underdamped overshoots');
  const ema = { target: { el: 1, channel: 'ren:tx' }, model: { family: 'ema (targets from holds)', params: { tau_ms: { value: 40 } } } };
  const c = curveOf(ema, []); assert.equal(c.axis, 'step'); assert.equal(c.rec.length, 0); assert.equal(c.tau, 40); assert.ok(Math.abs(c.fit.at(-1)[1] - (1 - Math.exp(-5))) < 1e-3);
  assert.match(c.note, /moving target/);
  const sm = { target: { el: 2, channel: 'ren:tx' }, model: { family: 'scroll map (linear)', map: { a: 0, b: -800, s0_px: 1000, s1_px: 1800, shape: 'linear' }, params: {} } };
  const rows = Array.from({ length: 50 }, (_, i) => { const sy = 800 + i * 25; return { T: i * dt, sy, v: { 2: { 'ren:tx': -800 * Math.min(1, Math.max(0, (sy - 1000) / 800)) } } }; });
  const c2 = curveOf(sm, rows); assert.equal(c2.axis, 'scroll'); assert.ok(c2.rec.length > 20); assert.ok(c2.gap.maxPct < 0.1); assert.equal(c2.prop.to, -800);
});

test('card data: headline is the first clause without labels or unknown reasons; property words', () => {
  assert.equal(headlineOf('Spring, no bounce (overdamped); settles in 1246 ms [fitted]; stiffness 100 (unknown: integrator set I1(1), I4 disagrees on (k, c) by 2 %)'), 'Spring, no bounce (overdamped)');
  assert.equal(headlineOf('Tween, easeOutCubic (= GSAP power2.out) [fitted], 1200 ms [fitted]'), 'Tween, easeOutCubic (= GSAP power2.out), 1200 ms');
  assert.equal(headlineOf('CSS transition: 600 ms, cubic-bezier(0.215, 0.61, 0.355, 1.000001), y 40 → -0.00000106 [exact]'), 'CSS transition: 600 ms, cubic-bezier(0.215, 0.61, 0.355, 1.000001), y 40 → 0', 'easing values untouched');
  assert.equal(tidyNumbers('x 23.671894 → 0.355'), 'x 23.7 → 0.355');
  assert.equal(propOf('ren:opacity').kind, 'opacity'); assert.equal(propOf('ren:sx').kind, 'scale'); assert.equal(propOf('ren:rz').kind, 'rotate'); assert.equal(propOf('drv:--p').kind, 'x');
});

test('card data: tabs keep only libraries with code, the rest are listed with why; unknown channels carried', () => {
  const d = buildCardData(lookOf(tweenRec()), { rows: rowsFor() });
  const law = d.motions[0].laws[0];
  assert.deepEqual(law.tabs.map((t) => t.lib), ['css', 'gsap', 'motion']);
  assert.ok(law.missing.some((m) => m.lib === 'lenis'));
  assert.equal(d.motions[0].unknowns[0].channel, 'ren:filter');
  assert.equal(d.recorded, true);
  assert.equal(buildCardData(lookOf(tweenRec())).recorded, false, 'missing take dir -> no recording, no throw');
});

test('card data: two laws on one channel each show their OWN code (keyed to the law\'s record, not the channel)', () => {
  const a = tweenRec({ t0: 100, D: 500, range: [50, 700] }), b = tweenRec({ t0: 1500, D: 900, range: [1450, 2600] });
  const look = lookOf(a);
  look.motions[0].records = [a, b];
  look.motions[0].lines = [500, 900].map((D, k) => ({ text: `Tween, easeOutCubic [fitted], ${D} ms [fitted]`, kind: 'tween', family: 'named:easeOutCubic', label: 'fitted', channels: ['ren:ty'], t0: [100, 1500][k], times: 1, values: [{ name: 'duration', value: D, unit: 'ms', label: 'fitted', text: `${D} ms` }] }));
  const rows = [...rowsFor({ t0: 100, D: 500, end: 1400 }), ...rowsFor({ t0: 1500, D: 900, from: 20, to: 120, end: 2600 }).filter((r) => r.T > 1400)];
  const d = buildCardData(look, { rows });
  const [l1, l2] = d.motions[0].laws; const css = (l) => l.tabs.find((t) => t.lib === 'css').entries[0].code;
  assert.match(css(l1), /transform 500ms/); assert.match(css(l2), /transform 900ms/);
  // the recorded ends complete the snippets: no placeholders, and every JS snippet parses
  const gsap2 = l2.tabs.find((t) => t.lib === 'gsap').entries[0].code; assert.match(gsap2, /y: 120,/); assert.ok(!/\bTO\b|\/\* to \*\//.test(gsap2));
  for (const l of [l1, l2]) for (const t of l.tabs) if (t.lib !== 'css') for (const e of t.entries) assert.doesNotThrow(() => new Function(e.code), `${t.lib}: ${e.code}`);
  // a law whose family has no exporter shows no code, even on a channel that has code
  look.motions[0].lines.push({ text: 'Moves, unexplained', kind: 'unexplained', family: 'unexplained', label: 'unknown', channels: ['ren:ty'], t0: 3000, times: 1, values: [] });
  const d2 = buildCardData(look, { rows }); assert.equal(d2.motions[0].laws[2].tabs.length, 0);
});

test('export: unmeasured ends are named placeholders that parse; a compound-value component is not representable', () => {
  const it = exportRecord(tweenRec(), { meta: { url: 'https://example.com/' } });
  for (const x of it.exports) if (x.code && x.lib !== 'css') { assert.doesNotThrow(() => new Function(x.code), x.code); }
  assert.match(it.exports.find((x) => x.lib === 'gsap').code, /not measured in this recording[^\n]*\n.*y: TO,/s);
  const clip = { ...tweenRec(), target: { el: 3, desc: 'DIV', channel: 'ren:clipPath.bottom' } };
  const ci = exportRecord(clip);
  for (const lib of ['css', 'gsap', 'motion']) { const x = ci.exports.find((e) => e.lib === lib); assert.equal(x.code, null, lib); assert.match(x.accuracy.why, /compound value/); }
  const sm = exportRecord({ target: { el: 1, channel: 'ren:ty' }, model: { family: 'ema', params: { tau_ms: { value: 40 } } } });
  assert.match(sm.exports.find((x) => x.lib === 'gsap').code, /gsap\.set\(el, \{ y: x \}\)/);
});

test('card data: a spring\'s fitted v0 is drawn (start value from the recording when the fit kept it fixed)', () => {
  const w = 14, z = 0.6, x0 = 100, tg = 0, v0n = 6, t0 = 200; const p = springProgress(w, z, v0n);
  const rows = []; for (let T = 0; T <= 2200; T += dt) rows.push({ T, sy: 0, v: { 4: { 'ren:tx': T < t0 ? x0 : x0 + (tg - x0) * p(T - t0) } } });
  const rec = { target: { el: 4, channel: 'ren:tx' }, model: { family: 'spring', params: { t0: { value: t0 }, omega: { value: w }, zeta: { value: z }, v0: { value: v0n * (tg - x0) }, target: { value: tg } } }, derived: { t0 }, evidence: { location: { kind: 'time_range', range: [0, 2200] } } };
  const c = curveOf(rec, rows);
  assert.ok(c.gap.maxPct < 0.5, `gap ${c.gap.maxPct} %`); assert.ok(Math.abs(c.x0 - x0) < 1e-6 && Math.abs(c.prop.from - x0) < 1e-3, `${c.x0}`);
  assert.ok(Math.abs(fittedProgress(rec).fn(60) - springProgress(w, z, 0)(60)) < 1e-12, 'without frames the start value is unknown: v0 dropped');
});

test('card data: the same law fitted twice on one element is one law with 2 runs', () => {
  const v = (o) => [{ name: 'overshoot', value: o, unit: '%', label: 'fitted' }, { name: 'settle', value: 1457, unit: 'ms', label: 'fitted' }];
  const L = (o, t0) => ({ text: `Spring, clearly bouncy (overshoots ${o} %)`, kind: 'spring', family: 'spring', label: 'fitted', channels: ['ren:tx'], t0, times: 1, values: v(o) });
  const a = { family: 'spring', kind: 'spring', label: 'fitted', channels: ['ren:tx'], values: v(25.38) };
  assert.ok(sameLaw(a, { ...a, values: v(25.43) })); assert.ok(!sameLaw(a, { ...a, values: v(30) }));
  const look = lookOf(tweenRec()); look.motions[0].lines = [L(25.38, 100), L(25.43, 2000)]; look.motions[0].records = [];
  const law = buildCardData(look, { rows: null }).motions[0].laws; assert.equal(law.length, 1); assert.equal(law[0].runs, 2);
  assert.match(renderCard(buildCardData(look, { rows: null })), /fitted · 2 runs/);
});

test('card html: self-contained (CSP, no external fetches), page strings escaped, data JSON cannot close the script', () => {
  const look = lookOf(tweenRec());
  look.motions[0].desc = 'DIV.<script>alert(1)</script>'; look.motions[0].selector = 'div[data-x="</script><img src=x>"]';
  look.warnings = ['<b>warn</b>'];
  const html = renderCard(buildCardData(look, { rows: rowsFor() }));
  assert.match(html, /<meta http-equiv="Content-Security-Policy" content="default-src 'none'/);
  assert.ok(!/<(script|link|img|iframe)[^>]+(src|href)=/i.test(html), 'no external resource tags');
  assert.ok(!/url\(|@import/.test(html), 'no CSS fetches');
  assert.equal((html.match(/<script/g) || []).length, 2, 'only the data block and the runtime');
  assert.ok(!html.includes('<script>alert(1)') && html.includes('&lt;script&gt;alert(1)'));
  assert.ok(!html.includes('<b>warn</b>'));
  const json = html.slice(html.indexOf('id="reva-data">') + 15, html.indexOf('</script>', html.indexOf('id="reva-data">')));
  const data = JSON.parse(json); assert.ok(data.m0l0 && data.m0l0.fit.length > 100 && data.m0l0.rec.length > 50);
  for (const w of ['Replay', 'Quarter speed', 'How sure', 'CSS', 'GSAP', 'Motion', 'matches fit']) assert.ok(html.includes(w), w);
  // first screen: the main law plays in the hero, before any section; the legend sits in the footer
  const hero = html.indexOf('data-hero="1"'); assert.ok(hero > 0 && hero < html.indexOf('<section class="motion">'), 'hero specimen first');
  assert.ok(html.indexOf('Every number says where it came from') > html.indexOf('<footer>'));
  // quiet page: provenance once per law, no per-value tags unless unknown, no raw channel ids, no "In full"
  assert.ok(!html.includes('>In full<')); assert.ok(!/<dd>[^<]*<span class="label label-fitted"/.test(html));
  assert.ok(!/<p class="quiet">ty\b/.test(html));
  // code and curve behind disclosures; Copy sits in the flow (no absolutely positioned button over text)
  assert.match(html, /<summary>Code<\/summary>/); assert.match(html, /<summary>Curve<\/summary>/);
  assert.ok(!/\.copy\{[^}]*position:absolute/.test(html));
  // design rules: one sans family, monospace only for code, no uppercase micro-labels
  assert.ok(!/text-transform:\s*uppercase/.test(html));
  assert.equal((html.match(/font-family:var\(--mono\)/g) || []).length, 1);
});

test('card CLI: card <look.json> writes card.html next to it; bad input exits 2', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'card-'));
  fs.writeFileSync(path.join(d, 'look.json'), JSON.stringify(lookOf(tweenRec())));
  const r = spawnSync(process.execPath, [BIN, 'card', d], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /card: .*card\.html/);
  const html = fs.readFileSync(path.join(d, 'card.html'), 'utf8');
  assert.match(html, /<title>REVA card<\/title>/); assert.ok(!html.includes('__DATA__'));
  const out = path.join(d, 'x', 'c.html');
  assert.equal(spawnSync(process.execPath, [BIN, 'card', path.join(d, 'look.json'), '--out', out]).status, 0);
  assert.ok(fs.existsSync(out));
  fs.writeFileSync(path.join(d, 'bad.json'), '{"x":1}');
  assert.equal(spawnSync(process.execPath, [BIN, 'card', path.join(d, 'bad.json')]).status, 2);
  fs.rmSync(d, { recursive: true, force: true });
});

// ---- scroll maps on their own driver, zero-travel maps, action ranking (card fix 2)

/** A linear map of the wheel-delta sum 0..400 -> tx 0..-200, wheels of 40 px every 4 page frames, window never scrolls. */
function wheelCase() {
  const rec = { target: { el: 2, channel: 'ren:tx' }, model: { family: 'scroll map (linear)', driver: { kind: 'wheel', provenance: 'measured' }, map: { a: 0, b: -200, s0_px: 0, s1_px: 400, shape: 'linear' }, params: {} }, derived: {} };
  const inputs = []; for (let k = 2; k < 60; k += 4) inputs.push({ type: 'wheel', k, dy: 40 });
  const rows = []; let sum = 0, j = 0;
  for (let k = 0; k < 64; k++) { while (j < inputs.length && inputs[j].k < k) sum += inputs[j++].dy; rows.push({ k, T: k * dt, sy: 0, v: { 2: { 'ren:tx': -200 * Math.min(1, Math.max(0, sum / 400)) } } }); }
  return { rec, rows, inputs };
}

test('card data: a wheel-driven map is drawn on the wheel-delta sum, not on scrollY; no input log -> fitted curve only', () => {
  const { rec, rows, inputs } = wheelCase();
  assert.equal(driverOf(rec).unit, 'px of wheel input');
  const x = driverAt(rows, inputs, driverOf(rec)); assert.equal(x(rows[0]), 0); assert.equal(x(rows[3]), 40);
  const c = curveOf(rec, rows, inputs);
  assert.equal(c.unit, 'px of wheel input'); assert.ok(c.rec.length > 5); assert.ok(c.gap.maxPct < 0.1, `gap ${c.gap.maxPct}`); assert.match(c.note, /wheel deltas/);
  // without the input log: no recorded overlay, no gap, a note naming the driver (before the fix: every point at x = 0, gap ~100 %)
  const c2 = curveOf(rec, rows, null); assert.equal(c2.rec.length, 0); assert.equal(c2.gap, null); assert.match(c2.note, /not by the window scroll/);
  const html = renderCard(buildCardData({ ...lookOf(rec), motions: [{ ...lookOf(rec).motions[0], lines: [{ ...lookOf(rec).motions[0].lines[0], kind: 'scroll map', family: rec.model.family, values: [] }], records: [rec] }] }, { rows, inputs }));
  assert.match(html, /px of wheel input/); assert.doesNotMatch(html, /px of scroll/);
  // a pointer-driven map reads the pointer coordinate held between events
  const pr = { ...rec, model: { ...rec.model, driver: { kind: 'pointer', axis: 'y' } } };
  const px = driverAt(rows, [{ type: 'pointer', k: 5, x: 1, y: 300 }, { type: 'pointer', k: 9, x: 2, y: 310 }], driverOf(pr));
  assert.ok(Number.isNaN(px(rows[5]))); assert.equal(px(rows[6]), 300); assert.equal(px(rows[40]), 310); assert.equal(driverOf(pr).unit, 'px of pointer y');
});

test('card data: a map with zero travel (b ~ 1e-17) did not move: no curve, no gap, law marked still; gaps above 1000 % are dropped', () => {
  const rec = { target: { el: 2, channel: 'ren:opacity' }, model: { family: 'scroll map (linear)', map: { a: 1.5, b: 3e-17, s0_px: -100, s1_px: 40, shape: 'linear' }, params: {} }, derived: {} };
  const rows = Array.from({ length: 30 }, (_, i) => ({ T: i * dt, sy: -120 + i * 6, v: { 2: { 'ren:opacity': 1.5 } } }));
  assert.equal(fittedProgress(rec), null); assert.equal(curveOf(rec, rows), null);
  const look = lookOf(rec); look.motions[0].lines[0] = { ...look.motions[0].lines[0], kind: 'scroll map', family: rec.model.family, values: [] };
  const d = buildCardData(look, { rows }); const law = d.motions[0].laws[0];
  assert.equal(law.still, true); assert.equal(law.curve, null);
  const html = renderCard(d); assert.match(html, /Did not move/); assert.doesNotMatch(html, /Largest gap/);
  // a tiny but non-degenerate travel that still blows the scale: the gap is omitted, not printed as 1e17 %
  const tiny = { ...rec, model: { ...rec.model, map: { ...rec.model.map, b: 1e-6 } } };
  const ct = curveOf(tiny, rows.map((r) => ({ ...r, v: { 2: { 'ren:opacity': 1.7 } } }))); assert.equal(ct.gap, null);
});

test('card html: a hover card opens on the hover response, not on a page-load leftover; y motion runs on a vertical hero track', () => {
  const tween = tweenRec(); const spring = { target: { el: 5, channel: 'ren:ty' }, model: { family: 'spring', params: { omega: { value: 12 }, zeta: { value: 0.5 }, v0: { value: 0 }, target: { value: 0 }, x0: { value: 40 } } }, derived: { t0: 100 }, fit: { n: 50, nrmse: 0.01 } };
  const base = lookOf(tween); const m0 = base.motions[0];
  m0.lines[0] = { ...m0.lines[0], trigger: 'plays on its own time' };
  const m1 = { ...m0, rank: 2, desc: 'DIV.cursor', selector: 'div.cursor', lead: 5, records: [spring], lines: [{ text: 'Spring, slightly bouncy [fitted]', kind: 'spring', family: 'spring', label: 'fitted', channels: ['ren:ty'], trigger: 'reacts to the pointer', t0: 100, times: 1, values: [{ name: 'settle', value: 500, unit: 'ms', label: 'fitted', text: '500 ms' }] }], unknowns: [] };
  const look = { ...base, action: { do: 'hover', el: null, on: '720,450' }, motions: [m0, m1] };
  assert.equal(actionScore(m1.lines[0], m1, look.action), 0); assert.equal(actionScore(m0.lines[0], m0, look.action), 2);
  assert.equal(actionScore(m0.lines[0], m0, { do: 'load' }), 1);
  const html = renderCard(buildCardData(look, { rows: rowsFor() }));
  const hero = html.slice(html.indexOf('class="hero"'), html.indexOf('</section>', html.indexOf('class="hero"')));
  assert.match(hero, /Spring, slightly bouncy/); assert.match(hero, /DIV\.cursor/);
  assert.match(hero, /class="track v"/, 'a y motion is drawn vertically');
  assert.ok(html.indexOf('<h2>div.cursor') > 0 && html.indexOf('<h2>div.cursor') < html.indexOf('<h2>div.hero'), 'the hover response section comes first');
  // the box keeps a ghost outline: opacity goes on the fill, not on the box
  assert.match(html, /<div class="box"><i class="fill"><\/i><\/div>/);
});

// ---- card fix 3: a map is checked only by frames inside its ramp; the hero is one idea; a pointer map says pointer

/** odyssee shape: the pointer took two values (2 and 945) and tx = pointer x; the fit put a 943 px ramp over 7.4 px. */
function pointerJumpCase() {
  const rec = { target: { el: 2, channel: 'ren:tx' }, tier: 'fitted', model: { family: 'scroll map (linear)', driver: { kind: 'pointer', axis: 'x' },
    map: { a: 2, b: 943, s0_px: 2, s1_px: 9.367, shape: 'linear', s0_provenance: 'unknown', s1_provenance: 'unknown', s0_ci95: null, s1_ci95: null }, params: {} }, derived: {} };
  const inputs = [{ type: 'pointer', k: 1, x: 945, y: 10 }, { type: 'pointer', k: 30, x: 2, y: 10 }];
  const rows = Array.from({ length: 60 }, (_, k) => ({ k, T: k * dt, sy: 0, v: { 2: { 'ren:tx': k > 1 && k <= 30 ? 945 : 2 } } }));
  return { rec, rows: rows.slice(2), inputs };
}

test('card data: a map whose recording has no frame inside the ramp shows no gap, no specimen, no hero, and its code is an unknown model', () => {
  const { rec, rows, inputs } = pointerJumpCase();
  const c = curveOf(rec, rows, inputs);
  assert.ok(c.rec.length > 0, 'the two flat ends are still drawn');
  assert.equal(c.checked, false); assert.equal(c.inRamp, 0); assert.equal(c.gap, null);
  assert.match(c.note, /No recorded frame falls inside this range/);
  // the export word: no map parameters, ends unknown with no interval -> unknown model (before: "matches fit")
  const it = exportRecord(rec, { meta: {} }); const x = it.exports.find((e) => e.code);
  assert.equal(exportWord(rec, it, x, 120).word, 'unknown model');
  const look = lookOf(rec); look.action = { do: 'hover', el: null, on: null };
  look.motions[0].lines[0] = { text: 'Scroll-linked (scrubbed): x 2 [fitted] → 945 [fitted] while the page scrolls 2 px [unknown] → 9.367 px [unknown], linear', kind: 'scroll map', family: rec.model.family, label: 'fitted', channels: ['ren:tx'], trigger: 'reacts to the pointer',
    values: [{ name: 'from', value: 2, label: 'fitted', text: '2 [fitted]' }, { name: 'to', value: 945, label: 'fitted', text: '945 [fitted]' },
      { name: 'scrollStart', value: 2, unit: 'px', label: 'unknown', text: '2 px [unknown]' }, { name: 'scrollEnd', value: 9.367, unit: 'px', label: 'unknown', text: '9.367 px [unknown]' }] };
  const d = buildCardData(look, { rows, inputs }); const law = d.motions[0].laws[0];
  assert.match(law.headline, /^Pointer-linked: x 2 → 945 while the pointer x moves/); assert.doesNotMatch(law.sentence, /scroll/i);
  assert.deepEqual(law.values.map((v) => v.name), ['from', 'to', 'pointer x start', 'pointer x end']);
  for (const t of law.tabs) for (const e of t.entries) assert.equal(e.word, 'unknown model', `${t.lib}: ${e.word}`);
  const html = renderCard(d);
  assert.doesNotMatch(html, /Largest gap/); assert.doesNotMatch(html, /matches fit/); assert.doesNotMatch(html, /scrollStart|scrollEnd|while the page scrolls/);
  assert.doesNotMatch(html, /class="hero"/, 'an unmeasured ramp is never the hero');
  assert.doesNotMatch(html, /data-spec="m0l0"/, 'no box plays the unmeasured glide'); assert.match(html, /The pointer jumped across this range/);
  // a wheel map: the same rule, wheel words
  assert.equal(heroOf('x', { head: 'Wheel-linked', what: 'x', from: '0', to: '-200', shape: 'linear' }), 'Wheel-linked: x 0 → -200, linear');
});

test('card data: a map with frames inside its ramp keeps its gap, measured on those frames only', () => {
  const { rec, rows, inputs } = wheelCase();
  const c = curveOf(rec, rows, inputs); assert.equal(c.checked, true); assert.ok(c.inRamp >= 5); assert.ok(c.gap && c.gap.maxPct < 0.1);
  const html = renderCard(buildCardData({ ...lookOf(rec), motions: [{ ...lookOf(rec).motions[0], lines: [{ ...lookOf(rec).motions[0].lines[0], kind: 'scroll map', family: rec.model.family, values: [] }], records: [rec] }] }, { rows, inputs }));
  assert.match(html, /recorded frames inside the ramp/);
});

test('card hero: one idea in display type; equivalents and rates stay in the law below', () => {
  const smooth = 'Smooth follow of the scroll, time constant 166.7 ms, = lerp 0.1 per 60 Hz frame (Lenis default 0.1), closes 4.877 % of the gap each 120 Hz frame';
  assert.equal(heroOf(smooth), 'Smooth follow of the scroll, 166.7 ms');
  assert.equal(heroOf('CSS transition: 600 ms, cubic-bezier(0.2, 0.8, 0.2, 1), delay 50 ms, scale 1 → 1.1'), 'CSS transition: 600 ms, cubic-bezier(0.2, 0.8, 0.2, 1)');
  assert.equal(heroOf('Spring, slightly bouncy (overshoots 7.241 %)'), 'Spring, slightly bouncy (overshoots 7.241 %)');
  for (const h of [smooth, 'Smooth follow of the pointer, time constant 50 ms, = lerp 0.33 per 60 Hz frame, closes 15.4 % of the gap each 120 Hz frame']) assert.ok(heroOf(h).length <= HERO_MAX);
});

test('card --out inside the repo is refused (site-derived output stays out of the repo, recheck item 41)', async () => {
  const { writeCard } = await import('../../src/card/index.js');
  const url = await import('node:url'); const REPO = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..');
  assert.throws(() => writeCard(lookOf(tweenRec()), { out: path.join(REPO, 'card-leak.html') }), /refusing to write inside the repo/);
  assert.ok(!fs.existsSync(path.join(REPO, 'card-leak.html')));
});

test('card specimen: a follower lane names what the law follows (scroll), not "your pointer" (recheck item 33)', () => {
  const ema = { target: { el: 1, channel: 'ren:ty' }, model: { family: 'ema', driver: { kind: 'wheel' }, params: { tau_ms: { value: 40 } } }, derived: { t0: 0 }, fit: { n: 50, nrmse: 0.01 } };
  const c = curveOf(ema, []); assert.equal(c.follows, 'the scroll');
  const p = curveOf({ ...ema, model: { ...ema.model, driver: { kind: 'pointer' } } }, []); assert.equal(p.follows, 'the pointer');
  const html = renderCard(buildCardData(lookOf(ema)));
  assert.match(html, /Follows the scroll \(your pointer drives it here\)/); assert.doesNotMatch(html, />Follows your pointer</);
});

test('card curve: a short ramp keeps its x precision (4 significant digits of the span, recheck item 38)', () => {
  const rec = { target: { el: 2, channel: 'ren:ty' }, model: { family: 'scroll map (linear)', map: { a: 0, b: 100, s0_px: 10, s1_px: 13.7, shape: 'linear' }, params: {} }, derived: {} };
  const rows = Array.from({ length: 40 }, (_, i) => { const sy = 9 + i * 0.15; return { T: i * dt, sy, v: { 2: { 'ren:ty': 100 * Math.min(1, Math.max(0, (sy - 10) / 3.7)) } } }; });
  const c = curveOf(rec, rows); assert.equal(c.span, 3.7);
  const xs = c.fit.map((p) => p[0]); assert.ok(xs.some((x) => Math.round(x * 10) / 10 !== x), 'x carries more than 0.1 px');
  for (const [x, y] of c.fit) if (x >= 0 && x <= 3.7) assert.ok(Math.abs(y - x / 3.7) < 2e-3, `point ${x},${y} on the line`);
});

test('card: paint-only motion gets a plain section (page text escaped), and the lede does not say nothing moved', () => {
  const look = lookOf(tweenRec()); look.motions = []; look.page = null;
  look.action = { do: 'hover', el: '#cta', on: null };
  look.declaredOnly = [{ kind: 'css-transition', desc: 'A#cta<img src=x>', durationMs: 200, delayMs: 0, easing: 'ease-in-out', properties: [{ prop: 'background-color', from: 'rgb(1, 114, 173)', to: 'rgb(2, 101, 154)' }, { prop: 'border-color', from: '<b>x', to: 'y' }] }];
  const html = renderCard(buildCardData(look));
  assert.match(html, /<h2>Colour, background and shadow<\/h2>/);
  assert.match(html, /CSS transition, 200 ms <span class="dl">exact<\/span>, ease-in-out/);
  assert.match(html, /background-color: rgb\(1, 114, 173\) → rgb\(2, 101, 154\)/);
  assert.ok(!html.includes('<img src=x>') && !html.includes('<b>x'), 'escaped');
  assert.doesNotMatch(html, /Nothing moved during this action/);
  assert.match(html, /the page declares one colour \/ shadow change/);
  const none = renderCard(buildCardData({ ...look, declaredOnly: [] }));
  assert.match(none, /Nothing moved during this action/); assert.ok(!none.includes('Colour, background and shadow'));
});

test('card footer: the network miss count shows only for an archive replay; a live or local recording does not claim 0', () => {
  const footer = (html) => html.slice(html.indexOf('<footer>'), html.indexOf('</footer>'));
  const arch = lookOf(tweenRec()); arch.take.net = { misses: 2 };
  assert.match(footer(renderCard(buildCardData(arch, { rows: rowsFor() }))), / · 2 network misses/);
  arch.take.net = { misses: 1 };
  assert.match(footer(renderCard(buildCardData(arch, { rows: rowsFor() }))), / · 1 network miss[^e]/);
  for (const source of [{ kind: 'url', url: 'https://example.com/', live: true }, { kind: 'url', url: 'http://127.0.0.1:8765/', live: false }]) {
    // misses: 0 as written by look.json files made before misses became null for non-archive runs
    for (const net of [{ misses: null }, { misses: 0 }]) {
      const look = { ...lookOf(tweenRec()), source }; look.take = { ...look.take, net };
      const d = buildCardData(look, { rows: rowsFor() });
      assert.equal(d.take.misses, null, `${source.url} ${net.misses}`);
      assert.doesNotMatch(footer(renderCard(d)), /network miss/, `${source.url} ${net.misses}`);
    }
  }
});
