import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSpec, renderHtml, serializeSpec, reviveSpec, shiftMotion, digestOf, declaredCapable } from '../build.js';
import { specimensFromFit, specimensFromLabTruth, writeSpecimens, labSpecimenSet } from '../index.js';
import { K } from '../kernel.js';
import { REPO, labRoot } from './helpers.js';

const tween = (o = {}) => ({ kind: 'tween', from: 0, to: 100, startMs: 1000, durationMs: 400, ease: { kind: 'bezier', p: [0.2, 0.9, 0.3, 1] }, ...o });
const mech = (o = {}) => ({ elemKey: 'a', channel: { ch: 'tx' }, motion: tween(), provenance: { tier: 'fitted' }, ...o });

test('time shift: first onset lands at leadMs in whole frames (the frame phase of discrete integrators is kept)', () => {
  const frameMs = 1000 / 120;
  for (const startMs of [1000, 837.033333, 3.3, 508.333333, 12345.678]) {
    const s = buildSpec({ id: 'x', origin: 'lab', source: {}, frameMs, mechanisms: [mech({ motion: tween({ startMs }) })] });
    const k = s.timeline.sourceShiftMs / frameMs; assert.ok(Math.abs(k - Math.round(k)) < 1e-6, `shift ${s.timeline.sourceShiftMs} is a whole number of frames`);
    const on = K.startOf(s.tracks[0].motion); assert.ok(on >= 500 - 1e-6 && on < 500 + frameMs + 1e-6, `onset ${on}`);
    assert.ok(Math.abs(on - (startMs + s.timeline.sourceShiftMs)) < 1e-4);
  }
});
test('shiftMotion moves every time field of every kind and keeps Infinity', () => {
  const ms = [tween(), { kind: 'chain', parts: [tween(), tween({ startMs: 1200 })] }, { kind: 'keyframes', startMs: 10, durationMs: 50, iterations: Infinity, frames: [{ offset: 0, value: 0 }, { offset: 1, value: 1 }] },
    { kind: 'spring', integrator: { id: 'i1', h: 16 }, k: 200, c: 12, start: { t: 5, x: 0, v: 0 }, g0: 1, events: [{ t: 9, g: 2 }], onsetMs: 5 }, { kind: 'friction', startMs: 7, x0: 0, v0: 1, friction: 0.9, law: 'dt' }, { kind: 'step', atMs: 4, before: 0, after: 1 }, { kind: 'ticks', startMs: 3, periodMs: 1000, values: [0, 1] }];
  for (const m of ms) {
    const a = shiftMotion(m, 100), b = shiftMotion(a, -100);
    assert.equal(serializeSpec(b), serializeSpec(m), m.kind + ': round trip');
    assert.ok(Math.abs(K.startOf(a) - K.startOf(m) - 100) < 1e-9, m.kind + ': startOf moved');
  }
  assert.equal(shiftMotion(ms[2], 1).iterations, Infinity);
});
test('elements: channels of one source element share a box; collisions get their own box; vars mapped by stylesheet never share a transform', () => {
  const s = buildSpec({ id: 'x', origin: 'lab', source: {}, mechanisms: [
    mech({ channel: { ch: 'tx' } }), mech({ channel: { ch: 'ty' } }), mech({ channel: { ch: 'opacity' } }),                   // one box
    mech({ channel: { ch: 'tx' } }),                                                                                          // second tx on the same element: new box
    mech({ elemKey: 'b', channel: { ch: 'var', name: '--x', mapTo: 'tx' } }), mech({ elemKey: 'b', channel: { ch: 'ty' } }),  // mapped var + ty: two boxes
    mech({ elemKey: 'c', channel: { ch: 'tx' }, impl: 'waapi' }), mech({ elemKey: 'c', channel: { ch: 'sx' }, impl: 'waapi' }),   // waapi transforms concatenate on one box
    mech({ elemKey: 'd', channel: { ch: 'tx' }, impl: 'waapi' }), mech({ elemKey: 'd', channel: { ch: 'ty' }, impl: 'js' }),     // engine mix: two boxes
  ] });
  const byEl = new Map(); s.tracks.forEach((t) => byEl.set(t.el, [...(byEl.get(t.el) || []), t.channel + ':' + t.impl]));
  const groups = [...byEl.values()].map((v) => v.join(','));
  assert.deepEqual(groups, ['tx:js,ty:js,opacity:js', 'tx:js', 'var:js', 'ty:js', 'tx:waapi,sx:waapi', 'tx:waapi', 'ty:js']);
  assert.ok(s.elements.every((e, i) => e.id === 'e' + i));
});
test('impl: waapi/css only when the engine can run the ease exactly, otherwise the kernel plays it (and says so)', () => {
  const named = tween({ ease: { kind: 'named', name: 'easeOutCubic' } });
  assert.equal(declaredCapable(named), false); assert.equal(declaredCapable(tween()), true); assert.equal(declaredCapable({ kind: 'spring' }), false);
  const s = buildSpec({ id: 'x', origin: 'lab', source: {}, mechanisms: [mech({ impl: 'waapi', motion: named }), mech({ impl: 'waapi', elemKey: 'b' }), mech({ impl: 'css', elemKey: 'c' })] });
  assert.deepEqual(s.tracks.map((t) => t.impl), ['js', 'waapi', 'css']); assert.ok(s.notes.some((n) => /not expressible/.test(n)));
  const forced = buildSpec({ id: 'x', origin: 'lab', source: {}, impl: 'js', mechanisms: [mech({ impl: 'waapi' })] }); assert.equal(forced.tracks[0].impl, 'js');
});
test('duration covers the slowest track plus a tail; loops are flagged', () => {
  const s = buildSpec({ id: 'x', origin: 'lab', source: {}, mechanisms: [mech(), mech({ elemKey: 'l', motion: { kind: 'keyframes', startMs: 100, durationMs: 700, iterations: Infinity, direction: 'alternate', easingScope: 'segment', frames: [{ offset: 0, value: 0 }, { offset: 1, value: 1 }] } })] });
  assert.equal(s.timeline.hasLoop, true); assert.ok(s.timeline.durationMs >= 500 + 3 * 700);
});
test('the page is content-free, self-contained and ban-clean; spec.json round-trips with Infinity; the digest is stable and sensitive', () => {
  const s = buildSpec({ id: 'x-y', origin: 'lab', source: { kind: 'test' }, mechanisms: [mech(), mech({ elemKey: 'l', channel: { ch: 'opacity' }, motion: { kind: 'keyframes', startMs: 0, durationMs: 700, iterations: Infinity, frames: [{ offset: 0, value: 0 }, { offset: 1, value: 1 }] } })] });
  const html = renderHtml(s);
  assert.ok(!/Date\.now|Math\.random|setTimeout|setInterval|fetch\(|XMLHttpRequest|https?:\/\/|<img|<link|src=/.test(html));
  assert.equal((html.match(/<script/g) || []).length, 1); assert.ok(html.includes('<title>x-y</title>'));
  const body = html.slice(html.indexOf('<body>'), html.indexOf('<script')); assert.equal(body.replace(/<[^>]+>/g, '').trim(), '', 'no text in the body');
  const back = reviveSpec(JSON.parse(serializeSpec(s))); assert.equal(back.tracks[1].motion.iterations, Infinity); assert.equal(digestOf(back), s.digest);
  const s2 = buildSpec({ id: 'x-y', origin: 'lab', source: { kind: 'test' }, mechanisms: [mech({ motion: tween({ durationMs: 401 }) }), mech({ elemKey: 'l' })] }); assert.notEqual(s2.digest, s.digest);
  const evil = buildSpec({ id: 'x', origin: 'lab', source: { note: '</script><script>alert(1)</script>' }, mechanisms: [mech()] });
  assert.equal((renderHtml(evil).match(/<script/g) || []).length, 1, 'source text cannot break out of the script element');
});
test('H2: site-derived specimens are refused inside the repo, lab specimens may live there; output outside the repo is fine', () => {
  const fit = [{ schema: 'reva.motion/0', target: { el: 0, channel: 'ren:tx' }, tier: 'fitted', class: 'tween', model: { family: 'x', ease: 'easeOutCubic', params: { t0: { value: 100 }, D: { value: 500 }, from: { value: 0 }, to: { value: 9 } }, valid_at: {} }, derived: {} }];
  const site = specimensFromFit(fit, { id: 's' }); assert.equal(site.specs[0].spec.origin, 'site');
  assert.throws(() => writeSpecimens(site.specs, path.join(REPO, 'specimens', 'time-site-test')), /refusing to write inside the repo/);
  assert.ok(!fs.existsSync(path.join(REPO, 'specimens', 'time-site-test')), 'nothing was created inside the repo, not even the folder');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-spec-'));
  try { const dirs = writeSpecimens(site.specs, tmp); assert.ok(fs.existsSync(path.join(dirs[0], 'index.html')) && fs.existsSync(path.join(dirs[0], 'spec.json'))); }
  finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

// ---- the committed lab set is exactly what the generator produces from the lab truth ---------------------------------
test('specimens/time is up to date with the generator (digests, page text) and its manifest lists every skip with a reason', (t) => {
  const root = labRoot(); const dir = path.join(REPO, 'specimens', 'time');
  if (!root) return t.skip('lab not found'); if (!fs.existsSync(path.join(dir, 'manifest.json'))) return t.skip('set not generated');
  const { specs, skipped } = labSpecimenSet(root);
  const man = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  assert.deepEqual(man.specimens.map((s) => s.id).sort(), specs.map((s) => s.spec.id).sort());
  for (const { spec, html } of specs) {
    assert.equal(fs.readFileSync(path.join(dir, spec.id, 'index.html'), 'utf8'), html, spec.id + ' index.html is stale: run node src/specimens/time/gen.js lab');
    assert.equal(man.specimens.find((s) => s.id === spec.id).digest, spec.digest);
  }
  assert.ok(man.skipped.every((s) => s.reason) && man.skipped.length === skipped.length);
  assert.ok(Object.values(man.notTimeBased).every((r) => r));
});

// ---- truth cross-check: the specimens reproduce the truth's own t10 / t50 / t90 / t99 -----------------------------------
test('lab truth t-points: every tween / declared specimen reaches 10 / 50 / 90 / 99 % of its amplitude at the times the truth says', (t) => {
  const root = labRoot(); if (!root) return t.skip('lab not found');
  let checked = 0;
  for (const f of ['m06.go', 'm12.go', 'm16e.go', 'm16f.go', 'm18.single', 'm19.timer', 'm19.click']) {
    const truth = JSON.parse(fs.readFileSync(path.join(root, 'lab-easing', 'truth', f + '.json'), 'utf8'));
    const { specs } = specimensFromLabTruth(truth); assert.equal(specs.length, 1, f);
    const spec = specs[0].spec;
    for (const it of truth.items) {
      const D = it.derived; if (!D || D.t50 == null || !(D.relative_to === 't0' || D.relative_to === 'start' || D.relative_to === 'onset' || D.relative_to === 'visible_onset')) continue;
      // the matching track: same channel on the same source element
      const [sel, ch] = it.target.split('|'); const name = ch.replace(/^(ren|drv):/, '');
      const tr = spec.tracks.find((x) => spec.elements[x.el].key === sel && (x.channel === name || (x.channel === 'var' && x.name === name))); if (!tr) continue;
      const m = tr.motion; const parts = m.kind === 'chain' ? [m.parts[0]] : [m];
      const p = parts[0];
      let onset, from, to, v;
      if (p.kind === 'tween') { onset = p.startMs; from = p.from; to = p.to; v = (tt) => K.valueAt(m, tt); }
      else { // keyframes with a hold: the visible onset is where the first segment that moves begins
        const F = p.frames; const j = F.findIndex((fr, i) => i > 0 && fr.value !== F[0].value); if (j < 1) continue;
        onset = p.startMs + p.durationMs * F[j - 1].offset; from = F[0].value; to = F[F.length - 1].value; v = (tt) => K.valueAt(m, tt);
        if (D.relative_to === 'onset' || D.relative_to === 'start') onset = p.startMs;
      }
      for (const [k, frac] of [['t10', 0.1], ['t50', 0.5], ['t90', 0.9], ['t99', 0.99]]) {
        const got = (v(onset + D[k]) - from) / (to - from);
        if (m.kind !== 'chain' && p.ease && p.ease.kind === 'bezier' && p.ease.p[1] > 1.2) continue;   // back-out: fraction is non-monotone around the peak
        assert.ok(Math.abs(got - frac) < 0.012, `${f} ${it.target} ${k}: ${got.toFixed(4)} vs ${frac} (derived ${D[k]} ms)`); checked++;
      }
    }
  }
  assert.ok(checked > 40, 'checked ' + checked);
  console.log(`# truth t-points: ${checked} fractions within 1.2 % of amplitude`);
});
