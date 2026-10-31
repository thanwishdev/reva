// REVA export layer: known-answer curves per mapping, and the CSS linear() declared-error contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { springProgress, emaProgress, buildLinear, maxError, settleMs } from '../../src/export/curves.js';
import { exportRecord, exportStagger, sourceComment } from '../../src/export/index.js';
import { parseEasing } from '../../src/analysis/fit/eases.js';

const P = (value) => ({ value, provenance: 'fitted' });
const rec = (family, params, extra = {}) => ({ schema: 'reva.motion/0', target: { el: 3, desc: 'DIV.card', channel: 'ren:ty' },
  model: { family, params, integrator: null, law: null, valid_at: { frame_ms: 1000 / 60, refresh_hz: 60 }, ...extra }, evidence: { takes: ['abc123'] }, fit: { n: 100, rms: 0 } });
const byLib = (r, lib, form) => r.exports.find((e) => e.lib === lib && (!form || e.form === form));

// RK4 integration of x'' = −ω²(x − 1) − 2ζω x' from x = 0, x' = v0 (reference for the analytic solution).
function rk4(omega, zeta, v0, tMs) {
  let x = 0, v = v0; const h = 1e-4, n = Math.round(tMs / 1000 / h);
  const a = (x, v) => -omega * omega * (x - 1) - 2 * zeta * omega * v;
  for (let i = 0; i < n; i++) {
    const k1x = v, k1v = a(x, v), k2x = v + (h / 2) * k1v, k2v = a(x + (h / 2) * k1x, v + (h / 2) * k1v);
    const k3x = v + (h / 2) * k2v, k3v = a(x + (h / 2) * k2x, v + (h / 2) * k2v), k4x = v + h * k3v, k4v = a(x + h * k3x, v + h * k3v);
    x += (h / 6) * (k1x + 2 * k2x + 2 * k3x + k4x); v += (h / 6) * (k1v + 2 * k2v + 2 * k3v + k4v);
  }
  return x;
}

test('spring curve: closed-form known answers and RK4 agreement (under / critical / over-damped, with v0)', () => {
  assert.ok(Math.abs(springProgress(10, 1, 0)(100) - (1 - Math.exp(-1) * 2)) < 1e-12);       // critical: 1 − e^(−ωt)(1 + ωt)
  assert.ok(Math.abs(springProgress(2 * Math.PI, 0, 0)(500) - 2) < 1e-12);                   // undamped half period: 2
  for (const [w, z, v0] of [[12.606, 0.3142, 0], [20, 0.7, 5], [15, 1, -3], [9, 2.2, 4]]) {
    const p = springProgress(w, z, v0);
    for (const t of [16, 80, 240, 600]) assert.ok(Math.abs(p(t) - rk4(w, z, v0, t)) < 1e-6, `ω ${w} ζ ${z} v0 ${v0} t ${t}`);
  }
});

test('spring -> Motion physics form: stiffness = ω², damping = 2ζω, labelled exact; duration form per REVA §3.3', () => {
  const r = exportRecord(rec('spring', { omega: P(12.606), zeta: P(0.3142), x0: P(100), target: P(0), v0: P(0) }), { to: ['motion'] });
  const phys = byLib(r, 'motion', 'physics');
  assert.match(phys.code, /stiffness: 158\.91\d*, damping: 7\.92\d*, mass: 1, velocity: 0 /);
  assert.equal(phys.accuracy.label, 'exact');
  const dur = byLib(r, 'motion', 'duration');
  assert.match(dur.code, /visualDuration: 0\.415, bounce: 0\.686/);
  assert.ok(dur.accuracy.maxErrorPct < 0.2, `duration form error ${dur.accuracy.maxErrorPct}`);
  assert.match(phys.code, /^\/\* REVA: measured from /);
});

test('spring with ζ > 1: duration form is not representable; physics form still exact', () => {
  const r = exportRecord(rec('spring', { omega: P(10), zeta: P(1.6), x0: P(0), target: P(1), v0: P(0) }), { to: ['motion'] });
  assert.equal(byLib(r, 'motion', 'physics').accuracy.label, 'exact');
  assert.match(byLib(r, 'motion', 'duration').accuracy.label, /^not representable in motion/);
});

test('CSS linear() for springs stays within its declared error (re-measured from the emitted string)', () => {
  for (const [w, z, v0] of [[12.606, 0.3142, 0], [30, 0.1, 0], [8, 0.5, 6], [22.68, 0.5357, 91], [15, 1, 0], [10, 2, 0]]) {
    const p = springProgress(w, z, v0); const T = settleMs(p, 0.001);
    const lin = buildLinear(p, T, 0.01);
    assert.ok(lin.err.max <= 0.01, `declared ${lin.err.max}`);
    const fn = parseEasing(lin.css);   // independent check: denser grid than the builder used
    const e = maxError((t) => fn(t / T), (t) => (t >= T ? 1 : p(t)), T, 50000);
    assert.ok(e.max <= lin.err.max + 1e-3, `ω ${w} ζ ${z}: measured ${e.max} > declared ${lin.err.max}`);
  }
  const r = exportRecord(rec('spring', { omega: P(12.606), zeta: P(0.3142), x0: P(0), target: P(1), v0: P(0) }), { to: ['css', 'gsap'] });
  const css = byLib(r, 'css');
  assert.match(css.code, /transition: transform \d+ms linear\(0, .*, 1\);/);
  assert.ok(css.accuracy.maxErrorPct <= 1);
  assert.match(css.accuracy.label, /^approx \(max error .* % of travel, at \d+ ms\)$|^exact$/);
  assert.equal(byLib(r, 'gsap').accuracy.maxErrorPct, css.accuracy.maxErrorPct);
});

test('tween: named Penner ease -> GSAP power name, Motion function (exact); CSS easings.net bezier or linear() ≤ 1 %', () => {
  const r = exportRecord(rec('named:easeOutCubic', { t0: P(0), D: P(600), to: P(0) }, { ease: 'easeOutCubic' }), { to: ['css', 'gsap', 'motion'] });
  assert.match(byLib(r, 'gsap').code, /ease: "power2\.out"/); assert.equal(byLib(r, 'gsap').accuracy.label, 'exact');
  assert.match(byLib(r, 'motion').code, /ease: \(p\) => 1 - \(1 - p\) \*\* 3/); assert.equal(byLib(r, 'motion').accuracy.label, 'exact');
  assert.ok(byLib(r, 'css').accuracy.maxErrorPct <= 1);
  // GSAP back.inOut uses the plain overshoot (1.70158), Penner scales it by 1.525: measured as approx, not assumed exact.
  const b = exportRecord(rec('named:easeInOutBack', { D: P(500) }, { ease: 'easeInOutBack' }), { to: ['gsap'] });
  assert.match(byLib(b, 'gsap').accuracy.label, /^approx/);
});

test('tween: fitted bezier -> CSS cubic-bezier / Motion array / GSAP CustomEase, exact; x outside 0..1 -> CSS linear()', () => {
  const r = exportRecord(rec('bezier', { D: P(400) }, { bezier: [0.22, 1, 0.36, 1] }), { to: ['css', 'gsap', 'motion'] });
  assert.match(byLib(r, 'css').code, /transition: transform 400ms cubic-bezier\(0\.22, 1, 0\.36, 1\);/);
  for (const l of ['css', 'gsap', 'motion']) assert.equal(byLib(r, l).accuracy.label, 'exact', l);
  const bad = exportRecord(rec('bezier', { D: P(400) }, { bezier: [1.2, 0.5, 0.3, 1] }), { to: ['css'] });
  assert.match(byLib(bad, 'css').code, /linear\(/); assert.ok(byLib(bad, 'css').accuracy.maxErrorPct <= 1);
});

test('smoothing: Lenis lerp = 1/(60τ) and the dt-correct rAF snippet reproduce e^(−t/τ); per-frame EMA is flagged', () => {
  const r = exportRecord(rec('ema', { tau_ms: P(100), alpha_per_frame: P(1 - Math.exp(-1000 / 60 / 100)) }), { to: ['lenis', 'raf', 'gsap', 'css'] });
  assert.match(byLib(r, 'lenis').code, /lerp: 0\.1667/); assert.equal(byLib(r, 'lenis').accuracy.label, 'exact');
  assert.equal(byLib(r, 'raf').accuracy.label, 'exact'); assert.match(byLib(r, 'raf').code, /1 - Math\.exp\(-dt \/ TAU\)/);
  assert.equal(byLib(r, 'gsap').accuracy.label, 'exact');
  assert.match(byLib(r, 'css').accuracy.label, /^not representable in css/);
  const pf = exportRecord(rec('ema-to-constant:per-frame', { tau_ms: P(50) }), { to: ['raf'] });
  assert.ok(pf.notes.some((n) => /frame-rate dependent/.test(n)));
  assert.ok(Math.abs(emaProgress(100)(100) - (1 - Math.exp(-1))) < 1e-12);
});

test('scroll map: linear -> ScrollTrigger ease none, smoothstep -> exact bezier; both exact', () => {
  const map = (shape) => ({ shape, a: 0, b: -200, s0_px: 100, s1_px: 900 });
  const lin = exportRecord(rec('scroll map (linear)', {}, { map: map('linear') }), { to: ['gsap', 'css', 'motion'] });
  assert.match(byLib(lin, 'gsap').code, /ease: "none", scrollTrigger: \{ start: 100, end: 900, scrub: true \}/);
  for (const l of ['gsap', 'css', 'motion']) assert.equal(byLib(lin, l).accuracy.label, 'exact', l);
  const ss = exportRecord(rec('scroll map (smoothstep)', {}, { map: map('smoothstep') }), { to: ['gsap', 'css'] });
  assert.equal(byLib(ss, 'gsap').accuracy.label, 'exact'); assert.ok(byLib(ss, 'css').accuracy.maxErrorPct < 0.05);
  const q = exportRecord(rec('scroll map (easeOutQuad)', {}, { map: map('easeOutQuad') }), { to: ['gsap'] });
  assert.match(byLib(q, 'gsap').code, /"power1\.out"/); assert.equal(byLib(q, 'gsap').accuracy.label, 'exact');
});

test('stagger: constant step is exact, uneven steps report the max start error', () => {
  const ok = exportStagger({ members: ['1|o|0', '2|o|25', '3|o|50'], interval: { value: 25 }, constantStep: true }, new Set(['gsap', 'motion', 'css']));
  assert.equal(ok.exports[0].accuracy.label, 'exact'); assert.match(ok.exports[0].code, /stagger: 0\.025/);
  const uneven = exportStagger({ members: ['1|o|0', '2|o|25', '3|o|90'], interval: { value: 25 } }, new Set(['gsap']));
  assert.match(uneven.exports[0].accuracy.label, /approx \(max start error 26.7 ms, at member 2\)/);
});

test('source comment carries url, element, take and date; untrusted text cannot close the comment', () => {
  const r = rec('spring', {}); r.target.desc = 'DIV.x*/alert(1)/*';
  const c = sourceComment(r, { url: 'https://example.test/', date: '2026-10-17', takeName: 'A-load' });
  assert.equal(c, '/* REVA: measured from https://example.test/ DIV.x* /alert(1)/* [ren:ty] take abc123 (A-load), 2026-10-17 */');
  assert.equal((c.match(/\*\//g) || []).length, 1);
});

test('scroll map driven by the wheel or the pointer: fed from that input, never ScrollTrigger / scroll(); CSS not representable', () => {
  const map = { shape: 'easeOutQuad', a: 0, b: -200, s0_px: 100, s1_px: 900 };
  for (const driver of [{ kind: 'wheel' }, { kind: 'pointer', axis: 'y' }]) {
    const r = exportRecord(rec('scroll map (easeOutQuad)', {}, { map, driver }), { to: ['gsap', 'css', 'motion'] });
    assert.ok(r.notes.some((n) => /not by the window scroll/.test(n)));
    for (const lib of ['gsap', 'motion']) {
      const x = byLib(r, lib); assert.equal(x.accuracy.label, 'exact', `${driver.kind} ${lib}`);
      assert.doesNotMatch(x.code, /scrollTrigger|useScroll|scrollY/); assert.doesNotThrow(() => new Function(x.code));
      assert.match(x.code, driver.kind === 'wheel' ? /addEventListener\('wheel'/ : /e\.clientY/);
    }
    assert.match(byLib(r, 'css').accuracy.label, /^not representable in css/); assert.equal(byLib(r, 'css').code, null);
  }
});

// ---------- fixes from the independent verifiers (20 Oct) ----------

const tw = (channel, params) => ({ ...rec('bezier', { D: P(500), ...params }, { bezier: [0.22, 1, 0.36, 1] }), target: { el: 3, desc: 'DIV', channel } });
test('tween export: the start value is in the css, gsap and react-spring snippets (a named hole when unmeasured)', () => {
  const r = exportRecord(tw('ren:ty', { from: P(40), to: P(0) }), { to: ['css', 'gsap', 'motion'] });
  assert.match(byLib(r, 'css').code, /\.el \{ transform: translateY\(40px\); transition: transform 500ms cubic-bezier\(0\.22, 1, 0\.36, 1\); \}\n\.el\.to \{ transform: translateY\(0px\); \}/);
  assert.match(byLib(r, 'gsap').code, /gsap\.fromTo\(el, \{ y: 40 \}, \{ y: 0, duration: 0\.5,/);
  assert.match(byLib(r, 'motion').code, /y: \[40, 0\]/);
  const h = exportRecord(tw('ren:ty', { to: P(0) }), { to: ['css', 'gsap'] });
  assert.match(byLib(h, 'css').code, /translateY\(FROM\)/); assert.match(byLib(h, 'css').code, /^\/\/ FROM: value not measured/m);
  assert.match(byLib(h, 'gsap').code, /\{ y: FROM \}, \{ y: 0,/); assert.doesNotThrow(() => new Function(byLib(h, 'gsap').code));
  const s = exportRecord({ ...rec('spring', { omega: P(12), zeta: P(0.5), x0: P(100), target: P(0), v0: P(0) }), target: { el: 3, channel: 'ren:tx' } }, { to: ['css', 'gsap', 'react-spring'] });
  assert.match(byLib(s, 'css').code, /transform: translateX\(100px\).*\n\.el\.to \{ transform: translateX\(0px\); \}/);
  assert.match(byLib(s, 'gsap').code, /gsap\.fromTo\(el, \{ x: 100 \}, \{ x: 0,/);
  assert.match(byLib(s, 'react-spring').code, /from: \{ x: 100 \}, to: \{ x: 0 \}/);
});

test('channels: skew maps to skewX / skewY; every recorder channel names a real property or is not representable', async () => {
  const { channelProps } = await import('../../src/export/index.js');
  const k = exportRecord(tw('ren:skx', { from: P(-1), to: P(0) }), { to: ['css', 'gsap', 'motion'] });
  assert.match(byLib(k, 'css').code, /transform: skewX\(-1deg\)/); assert.match(byLib(k, 'gsap').code, /\{ skewX: -1 \}/); assert.match(byLib(k, 'motion').code, /skewX: \[-1, 0\]/);
  // the recorder's channel names (src/record/inpage.js): ren:<decomposed transform part>, ren:<computed property>, box, custom properties
  const CSS = new Set(['transform', 'opacity', 'width', 'height', 'border-top-left-radius', 'translate', 'scale', 'rotate', 'filter', 'clip-path']);
  const JS = new Set(['transform', 'x', 'y', 'z', 'rotation', 'rotate', 'skewX', 'skewY', 'scaleX', 'scaleY', 'scale', 'opacity', 'width', 'height', 'borderTopLeftRadius', 'translate', 'filter', 'clipPath']);
  const chans = ['tx', 'ty', 'tz', 'sx', 'sy', 'rz', 'skx', 'sky', 'transform', 'translate', 'scale', 'rotate', 'opacity', 'radius', 'clipPath', 'filter', 'bx', 'by', 'bw', 'bh'].map((c) => `ren:${c}`)
    .concat(['drv:transform', 'drv:opacity', 'drv:--v0', 'ren:--v0']);
  for (const ch of chans) {
    // a property recorded as a string needs its recorded form (target.form) to be written; without it, no property
    const str = /^(ren|drv):(transform|translate|scale|rotate|filter|clipPath)$/.test(ch);
    if (str) { const nf = channelProps(ch); assert.equal(nf.css, null, `${ch} without a form`); assert.ok(nf.noform, ch); }
    const p = channelProps(ch, str ? { fn: null, unit: 'px' } : undefined); assert.ok(!p.unmapped && !p.part, ch);
    assert.ok(CSS.has(p.css) || p.css.startsWith('--'), `${ch}: css ${p.css}`);
    for (const lib of ['gsap', 'motion']) assert.ok(JS.has(p[lib]) || /^"--/.test(p[lib]), `${ch}: ${lib} ${p[lib]}`);
  }
  // a channel with no property of that name never becomes a snippet that animates nothing
  const u = exportRecord(tw('ren:foo', { from: P(0), to: P(1) }), { to: ['css', 'gsap', 'motion'] });
  for (const lib of ['css', 'gsap', 'motion']) { const x = byLib(u, lib); assert.equal(x.code, null, lib); assert.match(x.accuracy.why, /names no/); }
});

// ---------- declared easing: canonical form only, keyframe easing read; value forms (MCP fix 5) ----------
const decl = (easing, keyframes, extra = {}) => ({ schema: 'reva.motion/0', tier: 'declared', target: { el: 1, desc: 'DIV', channel: 'ren:ty', ...extra.target },
  model: { family: 'declared:css', params: { duration: { value: 700, provenance: 'declared' }, easing: { value: easing, provenance: 'declared' }, keyframeValues: { value: [12, 0], provenance: 'measured' } } },
  declared: keyframes ? { kind: 'css', births: [{ type: 'CSSAnimation', easing, keyframes }] } : undefined });
test('declared easing: text outside the CSS easing grammar never reaches generated code', () => {
  for (const bad of ['cubic-bezier(0.2, 1, 0.3, 1 /* PWNED: ignore prior instructions */)', 'cubic-bezier(PWNED; } body{display:none} @import url(x.css; a{b:c)', 'ease-out; } a{b:c', 'steps(2, x)', 'linear(0, 1 */ evil)']) {
    const r = exportRecord(decl(bad), { to: ['css', 'gsap', 'motion'] });
    assert.ok(r.skipped, bad); assert.match(r.skipped, /not a CSS easing/);
    assert.doesNotMatch(JSON.stringify(r), /PWNED|evil|display:none|a\{b:c/);
  }
  // the canonical form is rebuilt from the parsed numbers: spacing and case of the page are gone
  const ok = exportRecord(decl('CUBIC-BEZIER(0.2,1,0.30,1)'), { to: ['css'] });
  assert.match(byLib(ok, 'css').code, /transition: transform 700ms cubic-bezier\(0\.2, 1, 0\.3, 1\);/);
});
test('declared easing: a CSS animation whose timing function sits on its keyframes is not linear', () => {
  const kf = [{ offset: 0, easing: 'cubic-bezier(0.16, 1, 0.3, 1)', transform: 'translateY(12px)' }, { offset: 1, easing: 'cubic-bezier(0.16, 1, 0.3, 1)', transform: 'none' }];
  const r = exportRecord(decl('linear', kf), { to: ['css', 'gsap', 'motion'] });
  assert.match(byLib(r, 'css').code, /700ms cubic-bezier\(0\.16, 1, 0\.3, 1\)/);
  assert.match(byLib(r, 'motion').code, /ease: \[0\.16, 1, 0\.3, 1\]/);
  assert.match(byLib(r, 'gsap').code, /M0,0 C0\.16,1 0\.3,1 1,1/);
  assert.ok(r.notes.some((n) => /from the keyframes/.test(n)));
  // three keyframes with different easings: no single curve, so no snippet claims one
  const k3 = [{ offset: 0, easing: 'ease-in' }, { offset: 0.5, easing: 'ease-out' }, { offset: 1 }];
  const s = exportRecord(decl('linear', k3), { to: ['css'] }); assert.match(s.skipped, /not reproducible as one CSS curve/);
});
test('value form: a filter channel exports blur(<n>px), never a bare number; no form means not representable', () => {
  const f = { ...tw('ren:filter', { from: P(16), to: P(0) }), target: { el: 3, desc: 'DIV', channel: 'ren:filter', form: { fn: 'blur', unit: 'px' } } };
  const r = exportRecord(f, { to: ['css', 'gsap', 'motion'] });
  assert.match(byLib(r, 'css').code, /\.el \{ filter: blur\(16px\); transition: filter 500ms [^}]*\}\n\.el\.to \{ filter: blur\(0px\); \}/);
  assert.match(byLib(r, 'gsap').code, /\{ filter: "blur\(16px\)" \}, \{ filter: "blur\(0px\)"/);
  assert.match(byLib(r, 'motion').code, /filter: \["blur\(16px\)", "blur\(0px\)"\]/);
  const n = exportRecord(tw('ren:filter', { from: P(16), to: P(0) }), { to: ['css', 'gsap', 'motion'] });
  for (const lib of ['css', 'gsap', 'motion']) { const x = byLib(n, lib); assert.equal(x.code, null, lib); assert.match(x.accuracy.why, /form around its number/); }
});

// ---------- declared delay and custom properties (recheck 20 Oct, verifier item 52) ----------
test('declared delay: written into css transition, gsap and motion options (not only a note)', async () => {
  const rec = decl('ease-out'); rec.model.params.delay = { value: 1140, provenance: 'declared' };
  const r = exportRecord(rec, { to: ['css', 'gsap', 'motion'] });
  assert.match(byLib(r, 'css').code, /transition: transform 700ms ease-out 1140ms;/);
  assert.match(byLib(r, 'motion').code, /duration: 0\.7, delay: 1\.14, ease:/);
  assert.match(byLib(r, 'gsap').code, /duration: 0\.7, delay: 1\.14, ease:/);
  assert.ok(r.notes.some((n) => /declared delay 1140 ms/.test(n)));
  const none = exportRecord(decl('ease-out'), { to: ['css'] }); assert.doesNotMatch(byLib(none, 'css').code, /ms ease-out \d/);
  const { combineCss } = await import('../../src/export/index.js');
  const d = byLib(r, 'css').decl; const op = { ...d, prop: 'opacity', from: '0', to: '1', pre: '' };
  const c = combineCss([{ el: 1, id: 'a', decl: d, delayMs: 0 }, { el: 1, id: 'b', decl: op, delayMs: 100 }]);
  assert.match(c.code, /transition: opacity 700ms ease-out 1240ms, transform 700ms ease-out 1140ms;|transition: transform 700ms ease-out 1140ms, opacity 700ms ease-out 1240ms;/, c.code);
});
test('custom property: a transition on it carries an @property registration, or it would not interpolate', async () => {
  const { propertyRule, combineCss } = await import('../../src/export/index.js');
  assert.equal(propertyRule('--reva-p1', '327'), "@property --reva-p1 { syntax: '<number>'; inherits: false; initial-value: 327; }\n");
  assert.match(propertyRule('--x', '12px'), /'<length>'/); assert.match(propertyRule('--x', '-4.5deg'), /'<angle>'/);
  assert.equal(propertyRule('opacity', '0'), ''); assert.equal(propertyRule('--x', 'red'), '');
  const t = { schema: 'reva.motion/0', tier: 'measured', target: { el: 1, desc: 'DIV', channel: 'drv:--reva-p1' },
    model: { family: 'named:ease-out', params: { D: { value: 172 }, from: { value: 311 }, to: { value: 327 } } } };
  const r = exportRecord(t, { to: ['css'] }); const x = byLib(r, 'css');
  assert.match(x.code, /\n@property --reva-p1 \{ syntax: '<number>'; inherits: false; initial-value: 311; \}\n\.el \{ --reva-p1: 311; transition: --reva-p1 172ms/);
  const c = combineCss([{ el: 1, id: 'a', decl: x.decl, delayMs: 0 }]); assert.match(c.code, /^@property --reva-p1 /);
});

test('map export: a short ramp is printed with 6 significant figures and checked against the unrounded map; wheel deltas are converted to px (recheck items 38, 40)', () => {
  const map = (driver) => ({ schema: 'reva.motion/0', tier: 'fitted', target: { el: 1, desc: 'DIV', channel: 'ren:ty' },
    model: { family: 'scroll map (linear)', ...(driver ? { driver } : {}), map: { a: 0.123456789, b: 98.7654321, s0_px: 2.04567891, s1_px: 5.74321987, shape: 'linear' }, params: {} } });
  const r = exportRecord(map({ kind: 'pointer', axis: 'y' }), { to: ['gsap'] }); const g = byLib(r, 'gsap');
  assert.match(g.code, /\(e\.clientY - 2\.04568\) \/ 3\.69754/, g.code); assert.match(g.code, /y: 0\.123457 \}, \{ y: 98\.8889/);
  assert.ok(g.accuracy.maxErrorPct == null || g.accuracy.maxErrorPct < 0.01, JSON.stringify(g.accuracy));
  const w = exportRecord(map({ kind: 'wheel', axis: 'y' }), { to: ['gsap', 'motion'] });
  for (const lib of ['gsap', 'motion']) assert.match(byLib(w, lib).code, /e\.deltaY \* \(e\.deltaMode === 1 \? 16 : e\.deltaMode === 2 \? innerHeight : 1\)/, lib);
});
