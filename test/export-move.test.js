// The move code assembler: what each tab prints, and the error it claims, measured against known curves.
import test from 'node:test';
import assert from 'node:assert/strict';
import { agentPrompt, promptWithShaderPointers, curveOfLaw, easeGap, followGroup, moveCode, pickEase, proofLine, proofOf, relativeForm, slugOf, timingLine } from '../src/export/move.js';
import { sentenceOf } from '../src/scan/moves/intent.js';
import { NAMED } from '../src/export/eases.js';
import { FIT } from '../src/scan/moves/contract.js';

const ptsOf = (fn, ms, n = 40) => Array.from({ length: n + 1 }, (_, i) => [(ms * i) / n, fn(i / n)]);
const quart = NAMED.easeOutQuart.fn;
const rise = { property: 'y', channel: 'ren:ty', family: 'move', unit: 'px', from: 40, to: 0, raw: { from: 40, to: 0 } };
const fade = { property: 'opacity', channel: 'ren:opacity', family: 'fade', unit: '', from: 0, to: 1, raw: { from: 0, to: 1 } };
const grow = { property: 'scale', channel: 'ren:sx', family: 'scale', unit: '', from: 1, to: 1.06, raw: { from: 1, to: 1.0602 } };
const tween = (o = {}) => ({ class: 'tween', ms: 600, delayMs: 0, key: 'easeOutQuart', named: 'power3.out', ...o });

test('a named ease is used only inside 2 % of the recorded frames', () => {
  const hit = pickEase(ptsOf(quart, 600), 600);
  assert.equal(hit.key, 'easeOutQuart'); assert.equal(hit.name, 'power3.out'); assert.ok(hit.errorPct < 0.01);
  const odd = ptsOf((p) => (p < 0.5 ? 0.1 * p : 0.05 + 1.9 * (p - 0.5)), 600);
  assert.equal(pickEase(odd, 600), null);
});

test('a load reveal reads relative to rest, in all three tabs', () => {
  const c = moveCode({ kind: 'load', trigger: { kind: 'load' }, groups: [{ name: 'Hero words', changes: [rise, fade], law: tween(), stagger: { ms: 40, order: 'start', from: 'first' }, count: 3, pts: ptsOf(quart, 600) }] });
  assert.match(c.gsap, /gsap\.from\("\.your-hero-words", \{ y: 40, opacity: 0, duration: 0\.6, ease: "power3\.out", stagger: 0\.04 \}\);/);
  assert.match(c.css, /@keyframes reva-hero-words/);
  assert.match(c.css, /animation-delay: calc\(var\(--i\) \* 40ms\)/);
  assert.match(c.motion, /^import \{ animate, stagger \} from "motion";/);
  assert.match(c.motion, /delay: stagger\(0\.04\)/);
  assert.ok(c.errorPct.gsap < 0.01, 'GSAP prints the exact formula');
  assert.ok(c.errorPct.css <= 1.5, `css ${c.errorPct.css}`);
  assert.equal(c.form, 'relative');
});

test('a hover is a state in CSS and a handler in JS', () => {
  const c = moveCode({ kind: 'touch', trigger: { kind: 'hover' }, groups: [{ name: 'Image', changes: [grow], law: tween(), pts: ptsOf(quart, 600) }] });
  assert.match(c.css, /\.your-image:hover \{ transform: scale\(1\.06\); \}/);
  assert.match(c.css, /transition: transform 600ms/);
  assert.match(c.gsap, /addEventListener\("pointerenter"/);
  assert.match(c.gsap, /gsap\.to\("\.your-image", \{ scale: 1\.06/);
  assert.match(c.motion, /hover\("\.your-trigger"/);
});

test('the leave and the press have their own place', () => {
  const c = moveCode({ kind: 'touch', trigger: { kind: 'hover' }, groups: [
    { name: 'Image', changes: [grow], law: tween(), pts: [] },
    { name: 'Image', changes: [{ ...grow, from: 1.06, to: 1 }], law: tween({ ms: 400 }), part: 'out', pts: [] },
    { name: 'Button', changes: [{ ...grow, to: 0.97, raw: { from: 1, to: 0.97 } }], law: tween({ ms: 100 }), part: 'press', pts: [] },
  ] });
  assert.match(c.gsap, /pointerleave/); assert.match(c.gsap, /pointerdown/);
  assert.match(c.css, /:active/);
});

test('the error a tab claims includes its rounded values', () => {
  const c = moveCode({ kind: 'load', trigger: { kind: 'load' }, groups: [{ name: 'A', changes: [grow], law: tween(), pts: ptsOf(quart, 600) }] });
  assert.ok(c.errorPct.gsap >= 0.3, `0.0002 of a 0.0602 travel is 0.33 %, got ${c.errorPct.gsap}`);
});

test('a spring is physics in Motion, sampled linear() in CSS, and says so', () => {
  const law = { class: 'spring', ms: 900, delayMs: 0, omega: 14, zeta: 0.6, v0: 0, v0n: 0 };
  const c = moveCode({ kind: 'touch', trigger: { kind: 'hover' }, groups: [{ name: 'Card', changes: [grow], law, pts: [] }] });
  assert.match(c.motion, /type: "spring", stiffness: 196, damping: 16\.8/);
  assert.match(c.css, /linear\(/);
  assert.ok(c.notes.some((n) => /no CSS curve/.test(n)));
  assert.deepEqual(curveOfLaw(law).kind, 'spring');
});

test('a scroll map is scrubbed, from box and viewport, never page pixels', () => {
  const law = { class: 'map', s0: 1000, s1: 2000, shape: 'linear', driver: 'scroll' };
  const c = moveCode({ kind: 'scroll', trigger: { kind: 'scroll-linked' }, scroll: { start: 'top 80%', end: 'top 20%' }, groups: [{ name: 'Picture', changes: [{ ...rise, from: 0, to: -120, raw: { from: 0, to: -120 } }], law, pts: ptsOf((p) => p, 1000) }] });
  assert.match(c.gsap, /scrollTrigger: \{ trigger: "\.your-picture", start: "top 80%", end: "top 20%", scrub: true \}/);
  assert.match(c.css, /animation-timeline: view\(\)/);
  assert.match(c.motion, /offset: \["start 80%","start 20%"\]/);
  assert.doesNotMatch(c.gsap, /1000|2000/);
  assert.equal(c.errorPct.gsap, 0);
});

test('a trigger on scroll fires once in view', () => {
  const c = moveCode({ kind: 'scroll', trigger: { kind: 'scroll-triggered' }, scroll: { start: 'top 80%' }, groups: [{ name: 'Text', changes: [rise], law: tween(), pts: [] }] });
  assert.match(c.gsap, /scrollTrigger: \{ trigger: "\.your-text", start: "top 80%" \}/);
  assert.match(c.css, /\.your-text\.is-in/);
  assert.match(c.motion, /inView\(/);
});

test('sampled keyframes paste in all three tabs and say they are a recording', () => {
  const keys = [[0, 0], [100, 30], [200, -4], [300, 0]];
  const law = { class: 'keyframes', ms: 300, delayMs: 0, points: keys.map(([x, y]) => [x, y / 30]), errorPct: 0.8 };
  const c = moveCode({ kind: 'load', trigger: { kind: 'load' }, groups: [{ name: 'Blob', changes: [{ ...rise, from: 0, to: 0, keys }], law, pts: [] }] });
  assert.match(c.css, /33\.33% \{ transform: translateY\(30px\); \}/);
  assert.match(c.gsap, /"66\.67%": \{ y: -4 \}/);
  assert.match(c.gsap, /easeEach: "none"/);
  assert.doesNotMatch(c.gsap, /CustomEase/);
  assert.match(c.motion, /times: \[0, 0\.3333, 0\.6667, 1\]/);
  assert.ok(c.notes.some((n) => /recording/.test(n)));
  assert.equal(c.errorPct.css, 0.8);
});

test('a property off the group law replays its own recording beside the rest', () => {
  const c = moveCode({ kind: 'load', trigger: { kind: 'load' }, groups: [{ name: 'A', changes: [rise, { ...fade, follows: false, keys: [[0, 0], [300, 0.2], [600, 1]] }], law: tween(), pts: [] }] });
  assert.match(c.css, /@keyframes reva-a-opacity/);
  // one rule holds both: a second `animation:` on .your-a would replace the law's
  assert.match(c.css, /\.your-a \{ animation: reva-a 600ms [^;]+ both, reva-a-opacity 600ms linear both; \}/);
  assert.equal((c.css.match(/\.your-a \{ animation:/g) || []).length, 1);
  assert.ok(c.notes.some((n) => /opacity does not follow/.test(n)));
});

// a 3D portfolio site, a menu toggle, H on 3 Nov: three groups each wrote @keyframes reva-x, so the last one played for all, 84.7 % off
test('recorded keyframes of different groups never share a name, and a lead with no law property writes no empty keyframes', () => {
  const x = { property: 'x', channel: 'ren:tx', family: 'move', unit: 'px', follows: false };
  const menu = { name: 'Menu', changes: [{ ...x, from: 0, to: -590, keys: [[0, 0], [500, -380], [1000, -590]] }], law: tween(), pts: [] };
  const text = { name: 'Text', changes: [{ ...x, from: 0, to: 56, keys: [[0, 0], [250, 50], [500, 56]] }], law: tween(), pts: [] };
  const c = moveCode({ kind: 'open', trigger: { kind: 'click' }, groups: [menu, text] });
  const names = [...c.css.matchAll(/@keyframes ([\w-]+)/g)].map((m) => m[1]);
  assert.deepEqual(names, ['reva-menu-x', 'reva-text-2-x']);
  assert.doesNotMatch(c.css, /from \{\s*\} to \{\s*\}/);
  assert.match(c.css, /\.your-menu\.is-open \{ animation: reva-menu-x 1000ms linear both; \}/);
  // a 3D portfolio site, a page change, 6 Nov: the law's call had no property left and GSAP got `{ , duration }`, so the whole tab was withheld
  assert.doesNotMatch(c.gsap, /\{ ,|could not write/); assert.doesNotMatch(c.motion, /could not write/);
  assert.ok(!c.notes.some((n) => /failed a syntax check/.test(n)), c.notes.join(' | '));
  assert.match(c.gsap, /gsap\.to\("\.your-menu", \{ keyframes: \{ "0%": \{ x: 0 \}/);
  const scrolled = moveCode({ kind: 'scroll', trigger: { kind: 'scroll-linked' }, scroll: { start: 'top bottom', end: 'bottom top' }, groups: [{ ...menu, law: { class: 'map', shape: 'linear', s0: 0, s1: 1000 } }] });
  assert.doesNotMatch(scrolled.gsap, /\{ ,|could not write/);
});

test('two recorded transforms on one target add up, and a stagger keeps the delay it adds to', () => {
  const k = (property, channel, keys) => ({ property, channel, family: 'move', unit: 'px', from: keys[0][1], to: keys.at(-1)[1], follows: false, keys });
  const g = { name: 'Box', changes: [k('x', 'ren:tx', [[0, 0], [300, 20]]), k('y', 'ren:ty', [[0, 0], [300, -12]])], law: { class: 'keyframes', ms: 300, points: [], errorPct: 1 }, pts: [] };
  const c = moveCode({ kind: 'load', trigger: { kind: 'load' }, groups: [g] });
  assert.match(c.css, /\.your-box \{ animation: reva-box-x [^,]+, reva-box-y [^;]+; animation-composition: replace, add; \}/);
  const s = moveCode({ kind: 'load', trigger: { kind: 'load' }, groups: [{ name: 'Tile', changes: [rise], law: { ...tween(), delayMs: 1200 }, stagger: { ms: 200 }, pts: [] }] });
  assert.match(s.css, /animation-delay: calc\(1200ms \+ var\(--i\) \* 200ms\)/);
});

test('a cursor is one follow by its law, not the path the test pointer took', () => {
  const big = { property: 'x', channel: 'ren:tx', family: 'move', unit: 'px', from: 1360, to: -35, follows: true };
  const recorded = { name: 'Path', changes: [{ ...big, keys: [[0, 0], [100, 9]] }], law: { class: 'keyframes', ms: 100, points: [], errorPct: 40 }, pts: [] };
  const c = moveCode({ kind: 'cursor', trigger: { kind: 'pointer' }, groups: [recorded, { name: 'Cursor', changes: [big], law: { class: 'tween', ms: 400, delayMs: 0, key: 'easeOutQuart' }, pts: [] }] });
  assert.match(c.css, /CSS cannot do this/);
  assert.match(c.gsap, /gsap\.quickTo\("\.your-cursor", "x", \{ duration: 0\.4, ease: "power3\.out" \}\)/);
  assert.match(c.motion, /^import \{ animate \} from "motion";/); assert.match(c.motion, /e\.clientX/);
  assert.ok(!/1360/.test(c.gsap + c.motion), 'the coordinates of the test are not in the code');
  assert.equal(c.errorPct.css, null); assert.equal(c.errorPct.gsap, 0);
  assert.equal(followGroup([recorded]), null);
  const only = moveCode({ kind: 'cursor', trigger: { kind: 'pointer' }, groups: [recorded] });
  assert.match(only.notes.join(' '), /recording/, 'with no law of time it stays a recording');
  const odd = moveCode({ kind: 'cursor', trigger: { kind: 'pointer' }, groups: [{ name: 'Cursor', changes: [big], law: { class: 'tween', ms: 400, delayMs: 0, declared: 'linear(0, 0.9 50%, 1)' }, pts: [] }] });
  assert.ok(!/could not write/.test(odd.motion), odd.motion);
  assert.match(sentenceOf({ kind: 'cursor' }, [{ name: 'Cursor', changes: [big], law: { class: 'tween', ms: 400 } }]), /^It follows the pointer and catches up in 0\.4 s\.$/);
});

test('a follower has no CSS, and an instant change has no duration', () => {
  const c = moveCode({ kind: 'cursor', trigger: { kind: 'pointer' }, groups: [{ name: 'Dot', changes: [rise], law: { class: 'smoothing', tauMs: 120, ms: 600 }, pts: [] }] });
  assert.match(c.css, /CSS cannot do this/); assert.match(c.gsap, /gsap\.ticker\.add/);
  assert.equal(c.errorPct.gsap, null);
  const s = moveCode({ kind: 'touch', trigger: { kind: 'hover' }, groups: [{ name: 'Tip', changes: [fade], law: { class: 'steps', ms: 0 }, pts: [] }] });
  assert.match(s.gsap, /gsap\.set/); assert.equal(s.errorPct.css, 0);
});

test('page words never reach code', () => {
  assert.equal(slugOf('Book a 15 min call!'), '.your-book-a-15-min-call');
  assert.equal(slugOf('</script><img onerror=x>'), '.your-script-img-onerror-x');
  assert.equal(slugOf('ราคา'), '.your-element');
  const bad = { property: 'filter', channel: 'ren:filter', family: 'filter', unit: '', from: 'url(http://x)', to: 'blur(2px)' };
  const c = moveCode({ kind: 'load', trigger: { kind: 'load' }, groups: [{ name: 'x', changes: [rise, bad], law: tween(), pts: [] }] });
  assert.doesNotMatch(`${c.css}${c.gsap}${c.motion}`, /url\(/);
});

test('every snippet parses', () => {
  const kinds = [['load', 'load'], ['touch', 'hover'], ['open', 'click'], ['change', 'page'], ['ambient', 'time']];
  for (const [kind, t] of kinds) {
    const c = moveCode({ kind, trigger: { kind: t }, groups: [{ name: 'A b', changes: [rise, fade, grow], law: tween(), pts: [] }] });
    for (const src of [c.gsap, c.motion.replace(/^import.*\n/, '')]) assert.doesNotThrow(() => new Function('gsap', 'animate', 'stagger', 'hover', 'press', 'inView', 'scroll', 'CustomEase', src), kind);
    assert.doesNotMatch(c.gsap, /could not write/); assert.doesNotMatch(c.css, /could not write/);
  }
});

test('more groups than a snippet can hold say so', () => {
  const groups = Array.from({ length: 14 }, (_, i) => ({ name: 'Part', changes: [rise], law: tween(), pts: [] }));
  const c = moveCode({ kind: 'load', trigger: { kind: 'load' }, groups });
  assert.ok(c.notes.some((n) => /2 smaller groups/.test(n)));
});

test('words around the code', () => {
  const m = { kind: 'load', name: 'Hero, on load', sentence: 'On load the words rise 40 px, 0.6 s.', trigger: { kind: 'hover', lagMs: 0 }, groups: [{ name: 'Words', count: 3, provenance: 'fitted', changes: [rise], law: tween(), stagger: { ms: 40 } }] };
  assert.equal(timingLine(m), '600 ms, power3.out, 40 ms stagger, on hover');
  assert.equal(proofOf({ source: 'declared', via: 'gsap' }).word, "From the site's own GSAP");
  assert.equal(proofOf({ source: 'declared' }).word, "From the site's CSS");
  assert.equal(proofOf({ source: 'fitted', errorPct: 0.4, frames: 182 }).word, 'Measured, all 182 frames within 0.4 %');
  assert.match(proofOf({ source: 'sampled' }).word, /Recorded frame by frame/);
  assert.equal(proofLine(0.42), 'Played from this code, it stays within 0.4 % of the site on every frame.');
  assert.equal(proofLine(null), null);
  const p = agentPrompt(m, { poster: 'clips/m-1.jpg' });
  assert.match(p, /^Rebuild this motion in my code/); assert.match(p, /Name: Hero, on load/); assert.match(p, /Reference frames: clips\/m-1\.jpg/); assert.match(p, /Spec \(JSON\): \{/);
});

test('the bound of a sampled curve is the contract', () => {
  assert.equal(FIT.keyframesMax, 24);
  assert.ok(Math.abs(easeGap((p) => p, [[0, 0], [50, 0.6], [100, 1]], 100) - 10) < 1e-9);
});

test('the agent spec keeps every group, largest first', () => {
  const groups = Array.from({ length: 18 }, (_, i) => ({ name: `G${i}`, count: 18 - i, provenance: 'fitted', changes: [rise], law: tween() }));
  const p = agentPrompt({ kind: 'load', name: 'Many', sentence: 'x', trigger: { kind: 'load' }, groups });
  const spec = JSON.parse(p.match(/Spec \(JSON\): (\{.*\})/)[1]);
  assert.equal(spec.groups.length, 18);
  assert.equal(spec.groups[0].name, 'G0'); assert.equal(spec.groups[17].name, 'G17');
});

// 6 Nov: 180 of 394 moves on the 3 sealed sites had groups whose start inside the move reached the code but not the agent spec
test('the agent spec says when each group starts inside the move', () => {
  const groups = [{ name: 'First', provenance: 'fitted', changes: [rise], law: tween() }, { name: 'Later', provenance: 'declared', delayMs: 233.3, changes: [fade], law: tween({ delayMs: 50 }) }];
  const p = agentPrompt({ kind: 'change', name: 'Page change', sentence: 'x', trigger: { kind: 'page' }, groups });
  const spec = JSON.parse(p.match(/Spec \(JSON\): (\{.*\})/)[1]);
  assert.equal(spec.groups[0].delayMs, undefined); assert.equal(spec.groups[1].delayMs, 233.3); assert.equal(spec.groups[1].law.delayMs, 50);
  assert.match(p, /delayMs is when it starts after the move's first group/);
  const none = agentPrompt({ kind: 'load', name: 'One', sentence: 'x', trigger: { kind: 'load' }, groups: groups.slice(0, 1) });
  assert.doesNotMatch(none, /delayMs is when/);
});

// 6 Nov: "Fitted values are within 0 %" came from a declared lead's own fit (145 of 394 prompts), and "no delay" was said of an unmeasured lag
test('the prompt states the worst fitted error, only when a group is fitted, and a lag only when measured', () => {
  const declared = { name: 'Lead', provenance: 'declared', fit: { rmsPct: 0.01 }, changes: [rise], law: tween() };
  const fitted = (rmsPct) => ({ name: 'Part', provenance: 'fitted', fit: { rmsPct }, changes: [fade], law: tween() });
  const p = (groups, trigger) => agentPrompt({ kind: 'load', name: 'M', sentence: 'x', trigger, groups });
  const a = p([declared, fitted(0.21), fitted(1.37)], { kind: 'load', lagMs: 0 });
  assert.match(a, /Fitted values follow the recording to 1\.4 % RMS of their travel \(the worst fitted group\)\./); assert.match(a, /Sets it off: page load, at once\./);
  const b = p([declared], { kind: 'page', lagMs: null });
  assert.doesNotMatch(b, /Fitted values/); assert.match(b, /Sets it off: a page change\.\n/);
  const c = p([declared, fitted(0.21)], { kind: 'hover', lagMs: 16.4 });
  assert.match(c, /Sets it off: the pointer arriving, 16 ms later\./); assert.match(c, /to 0\.21 % RMS/);
  const many = moveCode({ kind: 'load', trigger: { kind: 'load' }, groups: Array.from({ length: 14 }, () => ({ name: 'Part', changes: [rise], law: tween(), pts: [] })) });
  assert.ok(many.notes.some((n) => /moves\/<id>\.json/.test(n)));
});

// 6 Nov (owner): the copy-paste prompt carries no page code; the move file keeps the shader sources, the prompt points to them
test('the prompt points to each shader source in the move file and never carries its text', () => {
  const sources = [{ hash: 'd18d10a5900fc3e0', programs: ['p1', 'p4'], vs: 'void main(){gl_Position=vec4(0.);}', fs: 'uniform float u_progress;void main(){}' }];
  const programs = [{ programs: ['p1'], source: 'd18d10a5900fc3e0', set: { u_color: [1, 0.5, 0] }, animated: { u_time: { from: 0, to: 2, as: 'clock' } } }];
  const move = { kind: 'load', name: 'GL', sentence: 'x', trigger: { kind: 'load' }, groups: [{ name: 'Ink', provenance: 'fitted', changes: [rise], law: tween() }], shaders: sources, programs };
  const p = agentPrompt(move, { poster: 'clips/m-1.jpg', file: 'moves/m-1.json' });
  assert.doesNotMatch(p, /void main|u_progress;/);
  const spec = JSON.parse(p.match(/Spec \(JSON\): (\{.*\})/)[1]);
  assert.deepEqual(spec.shaders, [{ programs: ['p1', 'p4'], hash: 'd18d10a5900fc3e0', file: 'moves/m-1.json', vs: 'glSources[0].vs', fs: 'glSources[0].fs' }]);
  assert.deepEqual(spec.programs, programs, 'uniform values stay in the prompt as numbers');
  assert.match(p, /^Shader sources \(not in this text\): moves\/m-1\.json keeps them/m);
  // a prompt stored before 6 Nov gets the same pointers; one that already points is left as it is
  const old = p.replace(/Spec \(JSON\): .*/, `Spec (JSON): ${JSON.stringify({ ...spec, shaders: sources })}`).replace(/^Shader sources.*\n/m, '');
  assert.match(old, /void main/);
  assert.equal(promptWithShaderPointers(old, 'moves/m-1.json'), p);
  assert.equal(promptWithShaderPointers(p, 'moves/m-1.json'), p);
  assert.doesNotMatch(agentPrompt({ ...move, shaders: undefined }), /Shader sources/);
});
