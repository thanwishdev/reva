// Browser tests (headless Chrome through the repo launcher, H1): the seek contract on every committed lab specimen, and
// live play recorded by the real hx recorder compared with the kernel's expected series.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { launchBrowser } from '../../../browser/launch.js';
import { openSession } from '../../../record/session.js';
import { K } from '../kernel.js';
import { reviveSpec, renderHtml } from '../build.js';
import { serveDir } from './serve.js';
import { REPO } from './helpers.js';

const ROOT = path.join(REPO, 'specimens', 'time');
const haveSet = fs.existsSync(path.join(ROOT, 'manifest.json'));
const specOf = (id, dir = ROOT) => reviveSpec(JSON.parse(fs.readFileSync(path.join(dir, id, 'spec.json'), 'utf8')));
const ids = haveSet ? fs.readdirSync(ROOT).filter((d) => fs.existsSync(path.join(ROOT, d, 'spec.json'))).sort() : [];

/** In-page reader: the value each track currently shows, from the DOM (what the recorder would read). */
function readDom(spec) {
  return `(() => { const out = {}; const spec = ${JSON.stringify({ tracks: spec.tracks.map((t) => ({ id: t.id, el: spec.elements[t.el].id, channel: t.channel, name: t.name })) })};
    for (const t of spec.tracks) { const el = document.getElementById(t.el), cs = getComputedStyle(el);
      if (t.channel === 'var') out[t.id] = parseFloat(el.style.getPropertyValue(t.name));
      else if (t.channel === 'opacity') out[t.id] = +cs.opacity;
      else if (t.channel === 'w') out[t.id] = parseFloat(cs.width); else if (t.channel === 'h') out[t.id] = parseFloat(cs.height);
      else { const m = new DOMMatrixReadOnly(cs.transform); out[t.id] = { tx: m.m41, ty: m.m42, rz: Math.atan2(m.b, m.a) * 180 / Math.PI, sx: Math.hypot(m.a, m.b), sy: (m.a * m.d - m.b * m.c) / Math.hypot(m.a, m.b) }[t.channel]; } }
    return out; })()`;
}
const tol = (spec, tr, v) => (tr.impl !== 'js' || tr.channel !== 'var' ? 2e-3 + 2e-6 * Math.abs(v) : 1e-6 + 1e-9 * Math.abs(v));   // engine / matrix read-back: 6 significant digits

/** seek(t) at shuffled times, twice in opposite orders: DOM == kernel, same t -> same DOM value. Returns the number of comparisons. */
async function seekCheck(page, spec, id, extraTimes = []) {
  let checked = 0;
  const end = spec.timeline.durationMs;
  const ts = [0, 1, 250, 499.5, 500, 617.3, 800, 1000, 1337.77, end * 0.5, end - 1, end, end + 777, ...extraTimes].filter((x) => x >= 0);
  const order = [...ts].map((t, i) => [t, (i * 7) % ts.length]).sort((a, b) => a[1] - b[1]).map((x) => x[0]);        // shuffled
  const seen = new Map();
  for (const pass of [order, [...order].reverse()]) {
    for (const t of pass) {
      const r = await page.evaluate(([t, src]) => { const s = window.seek(t); return { ret: s.values, dom: eval(src) }; }, [t, readDom(spec)]);
      for (const tr of spec.tracks) {
        const want = K.valueAt(tr.motion, t, { frameMs: spec.timeline.frameMs });
        const got = r.dom[tr.id];
        assert.ok(Math.abs(got - want) <= tol(spec, tr, want) + (tr.impl === 'js' && tr.channel !== 'var' ? 2e-3 : 1e-9), `${id} ${tr.id} ${tr.channel} ${tr.impl} t=${t}: dom ${got} vs kernel ${want}`);
        assert.ok(Math.abs(r.ret[tr.id] - want) < 1e-9, `${id} ${tr.id}: seek() return value`);
        const key = tr.id + '@' + t; if (seen.has(key)) assert.equal(got, seen.get(key), `${id} ${key}: same t, same DOM value across passes`); seen.set(key, got);
        checked++;
      }
    }
  }
  return checked;
}

test('lab set exists (run: node src/specimens/time/gen.js lab)', () => { assert.ok(haveSet && ids.length >= 30, `specimens/time has ${ids.length} specimens`); });

test('seek(t): DOM == kernel on every lab specimen, order-independent, repeatable; pages are content-free and offline', { timeout: 300000 }, async () => {
  const srv = await serveDir(ROOT);
  const h = await launchBrowser({ engine: 'chs', context: { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 } });
  try {
    const page = h.page, errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    let checked = 0;
    for (const id of ids) {
      const spec = specOf(id), html = fs.readFileSync(path.join(ROOT, id, 'index.html'), 'utf8');
      assert.equal(html, renderHtml(spec), `${id}: index.html is the rendering of spec.json`);
      assert.ok(!/Date\.now|Math\.random|setTimeout|setInterval|fetch\(|XMLHttpRequest|https?:\/\//.test(html), `${id}: banned API or URL in the page`);
      await page.goto(`http://127.0.0.1:${srv.port}/${id}/index.html`);
      assert.equal(await page.evaluate(() => typeof window.seek), 'function', id);
      // content-free: no text anywhere, only the stage and neutral boxes with ids e<n>
      const shape = await page.evaluate(() => ({ text: document.body.innerText.trim(), nodes: [...document.body.querySelectorAll('*')].filter((e) => e.tagName !== 'SCRIPT').map((e) => e.tagName + '#' + e.id + '.' + e.className), title: document.title }));
      assert.equal(shape.text, '', `${id}: no text`);
      assert.ok(shape.nodes.every((n) => /^DIV#(s\.|e\d+\.b)$/.test(n)), `${id}: only neutral boxes: ${shape.nodes.slice(0, 4)}`);
      assert.equal(shape.nodes.length, 1 + spec.elements.length, id);
      checked += await seekCheck(page, spec, id);
    }
    assert.deepEqual(errors, [], 'no page errors');
    assert.deepEqual(srv.requests.filter((u) => !/\/index\.html$/.test(u) && u !== '/favicon.ico'), [], 'the pages request nothing else');
    console.log(`# seek: ${checked} DOM-vs-kernel comparisons over ${ids.length} specimens`);
  } finally { await h.close(); await srv.close(); }
});

// ---- live play recorded by the hx recorder -----------------------------------------------------------------------------
async function recordLive(srv, id, rate = 120, dir = ROOT) {
  const spec = specOf(id, dir);
  const s = await openSession({ lane: 'hx', rate, engine: 'chs', url: `http://localhost:${srv.port}/${id}/index.html`, viewport: { width: 1280, height: 800 } });
  try {
    await s.goto(); await s.boot({ until: '!!window.__specimen' });
    await s.watch(['.b']);
    await s.ev(() => window.dispatchEvent(new Event('go')));
    const mk = await s.mark('go');
    await s.hold(spec.timeline.durationMs + 100);
    const { take } = await s.finish({ write: false });
    return { spec, take, mk };
  } finally { await s.close(); }
}
/** Recorded value of a track (channel as the recorder names it) in a row. */
function recorded(take, spec, tr, row) {
  const idx = take.els.findIndex((d) => d.startsWith('DIV#' + spec.elements[tr.el].id + '.'));
  const v = row.v[idx] || row.v[String(idx)]; if (!v) return undefined;
  return tr.channel === 'var' ? v['drv:' + tr.name] : tr.channel === 'opacity' ? v['ren:opacity'] : tr.channel === 'w' ? v['ren:bw'] : tr.channel === 'h' ? v['ren:bh'] : v['ren:' + tr.channel];
}
/** Record a specimen live with the hx recorder and compare every recorded frame with the kernel's series on the recorded frame times. */
async function liveCheck(id, dir = ROOT, rate = 120) {
  const srv = await serveDir(dir);
  try {
    const { spec, take, mk } = await recordLive(srv, id, rate, dir);
    const rows = take.data.rows, i0 = rows.findIndex((r) => r.k > mk.k), anchor = rows[i0].T;
    const live = rows.slice(i0), times = live.map((r) => r.T - anchor);
    let worst = 0, moved = 0;
    for (const tr of spec.tracks) {
      const want = K.series(tr.motion, times);
      const got = live.map((r) => recorded(take, spec, tr, r));
      assert.ok(got.every((x) => x !== undefined), `${id} ${tr.id}: channel recorded`);
      const span = Math.max(...want) - Math.min(...want); if (span > 0) moved++;
      const tl = tr.impl !== 'js' || tr.channel !== 'var' ? 3e-3 + 3e-6 * Math.max(...want.map(Math.abs)) : 1e-6 * Math.max(1, ...want.map(Math.abs));
      for (let i = 0; i < times.length; i++) { const d = Math.abs(got[i] - want[i]); worst = Math.max(worst, d); assert.ok(d <= tl, `${id} ${tr.id} (${tr.impl} ${tr.channel}${tr.name || ''}) frame ${i} t=${times[i].toFixed(3)}: recorded ${got[i]} vs kernel ${want[i]} (tol ${tl})`); }
    }
    assert.ok(moved > 0, `${id}: something really moved`);
    assert.deepEqual(take.pageErrors, [], 'no page errors');
    console.log(`# ${id}: ${times.length} frames x ${spec.tracks.length} tracks, worst |recorded - kernel| = ${worst.toExponential(2)}`);
  } finally { await srv.close(); }
}
const LIVE = ['m19-timer', 'm19-retarget', 'm16f-go', 'm07-i1h16-p1000', 'm07-i4-p1000', 'm07-i6-p1000', 'm10-dt-fast', 'm08-z0.25-rest', 'm06-go', 'm18-single', 'm12-go', 'm15-go'];
for (const id of LIVE) {
  test(`hx live play: ${id} matches the kernel's series on the recorded frame times`, { timeout: 120000 }, async (t) => {
    if (!ids.includes(id)) return t.skip('specimen not in the set');
    await liveCheck(id);
  });
}

// ---- synthetic mechanisms the lab does not contain: loops (css, waapi, js), ticks, a stagger, a retargeted chain ------------
const tween = (o = {}) => ({ kind: 'tween', from: 0, to: 100, startMs: 800, durationMs: 500, ease: { kind: 'bezier', p: [0.2, 0.9, 0.3, 1] }, ...o });
const loopKf = (o = {}) => ({ kind: 'keyframes', startMs: 700, durationMs: 600, iterations: Infinity, direction: 'alternate', fill: 'both', easingScope: 'segment', easing: null,
  frames: [{ offset: 0, value: 0, easing: { kind: 'bezier', p: [0.42, 0, 0.58, 1] } }, { offset: 0.5, value: 80, easing: { kind: 'linear' } }, { offset: 1, value: 20 }], ...o });
const SYN = {
  'syn-loop-css': [{ elemKey: 'a', channel: { ch: 'tx' }, motion: loopKf(), impl: 'css' }, { elemKey: 'a', channel: { ch: 'opacity' }, motion: loopKf({ frames: [{ offset: 0, value: 0.2 }, { offset: 1, value: 1 }] }), impl: 'css' }],
  'syn-loop-waapi': [{ elemKey: 'a', channel: { ch: 'rz' }, motion: loopKf({ direction: 'normal', iterations: 3, easingScope: 'effect', easing: { kind: 'steps', n: 4, pos: 'end' } }), impl: 'waapi' },
    { elemKey: 'a', channel: { ch: 'tx' }, motion: loopKf({ direction: 'alternate-reverse' }), impl: 'waapi' }, { elemKey: 'a', channel: { ch: 'sx' }, motion: loopKf({ frames: [{ offset: 0, value: 1 }, { offset: 1, value: 1.5 }] }), impl: 'waapi' }],
  'syn-loop-js-ticks': [{ elemKey: 'a', channel: { ch: 'var', name: '--p', mapTo: 'ty' }, motion: loopKf({ easingScope: 'segment' }) },
    { elemKey: 'b', channel: { ch: 'opacity' }, motion: { kind: 'ticks', startMs: 600, periodMs: 250, values: [1, 0.3, 0.6], iterations: Infinity } }, { elemKey: 'c', channel: { ch: 'w' }, motion: { kind: 'step', atMs: 900, before: 56, after: 120 } }],
  'syn-stagger': Array.from({ length: 6 }, (_, i) => ({ elemKey: 'el' + i, order: i, channel: { ch: 'ty' }, motion: tween({ startMs: 800 + 45 * i, from: 30, to: 0 }), impl: 'waapi' }))
    .concat(Array.from({ length: 6 }, (_, i) => ({ elemKey: 'el' + i, order: i, channel: { ch: 'opacity' }, motion: tween({ startMs: 800 + 45 * i, from: 0, to: 1 }), impl: 'waapi' }))),
  // declared animations that do not exist before their birth (a FLIP created by a click), css with two different births on one element
  'syn-birth': [{ elemKey: 'a', channel: { ch: 'tx' }, motion: tween({ startMs: 1000, birthMs: 900, base: 0, from: -300, to: 0 }), impl: 'waapi' }, { elemKey: 'a', channel: { ch: 'sx' }, motion: tween({ startMs: 1000, birthMs: 900, base: 1, from: 0.5, to: 1 }), impl: 'waapi' },
    { elemKey: 'b', channel: { ch: 'opacity' }, motion: tween({ startMs: 1100, birthMs: 800, base: 1, from: 0, to: 1 }), impl: 'css' }, { elemKey: 'b', channel: { ch: 'ty' }, motion: tween({ startMs: 1500, birthMs: 1300, base: 0, from: 40, to: 0 }), impl: 'css' }],
  'syn-chain-spring': [{ elemKey: 'a', channel: { ch: 'var', name: '--x', mapTo: 'tx' }, motion: { kind: 'chain', parts: [tween(), tween({ startMs: 1000, from: 40, to: -30, durationMs: 400 })] } },
    { elemKey: 'b', channel: { ch: 'var', name: '--y', mapTo: 'ty' }, motion: { kind: 'spring', integrator: { id: 'i7' }, k: 180, c: 11, start: { t: 0, x: 0, v: 0 }, g0: 0, events: [{ t: 700, g: 120 }, { t: 1600, g: 10, v: 400 }], onsetMs: 700, snap: { x: 0.004, v: 0.04 } } }],
};
test('synthetic mechanisms: seek == kernel and live hx recording == kernel (loops, ticks, stagger, chain, spring)', { timeout: 300000 }, async () => {
  const { buildSpec, serializeSpec } = await import('../build.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-syn-'));
  try {
    for (const [id, mechanisms] of Object.entries(SYN)) {
      const spec = buildSpec({ id, origin: 'lab', source: { kind: 'synthetic' }, mechanisms });
      fs.mkdirSync(path.join(dir, id)); fs.writeFileSync(path.join(dir, id, 'index.html'), renderHtml(spec)); fs.writeFileSync(path.join(dir, id, 'spec.json'), serializeSpec(spec));
    }
    const srv = await serveDir(dir), h = await launchBrowser({ engine: 'chs', context: { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 } });
    try {
      const errors = []; h.page.on('pageerror', (e) => errors.push(String(e)));
      for (const id of Object.keys(SYN)) {
        const spec = specOf(id, dir);
        await h.page.goto(`http://127.0.0.1:${srv.port}/${id}/index.html`);
        const n = await seekCheck(h.page, spec, id, [1301, 2000, 3333.3, 9000, 27000]);     // loops: far beyond the first iterations
        assert.ok(n > 20, id);
        // hash modes: #t=<ms> renders that state at load, no go needed
        await h.page.goto(`http://127.0.0.1:${srv.port}/${id}/index.html?reload#t=1234`);
        const dom = await h.page.evaluate(readDom(spec));
        for (const tr of spec.tracks) { const want = K.valueAt(tr.motion, 1234, { frameMs: spec.timeline.frameMs }); assert.ok(Math.abs(dom[tr.id] - want) <= tol(spec, tr, want) + (tr.impl === 'js' && tr.channel !== 'var' ? 2e-3 : 1e-9), `${id} #t=1234 ${tr.id}`); }
      }
      assert.deepEqual(errors, []);
    } finally { await h.close(); await srv.close(); }
    for (const id of Object.keys(SYN)) await liveCheck(id, dir);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- parity with the lab's independent reference simulator (spring replay NRMSE <= 0.005, G1-4 section 8.2) ---------------
const PARITY = [['m07-i1h16-p1000', 120], ['m07-i1h16-p1000', 60], ['m07-i1h2-p400', 120], ['m07-i1h1-p1000', 120], ['m07-i4-p1000', 120], ['m07-i4-p400', 60], ['m07-i5-p400', 120], ['m07-i6-p1000', 120],
  ['m07-i7-p400', 120], ['m07x-verlet-p1000', 120], ['m07x-i1h5-p1000', 60], ['m08-z0.25-rest', 120], ['m08-z0.42-v0', 120], ['m08-z1-retarget', 120], ['m10-dt-fast', 120], ['m10-frame-slow', 60]];
for (const [id, rate] of PARITY) {
  test(`lab refsim parity: ${id} @${rate} Hz (recorded specimen vs the lab's simulator on the same frames)`, { timeout: 120000 }, async (t) => {
    if (!ids.includes(id)) return t.skip('specimen not in the set');
    const { labImport } = await import('./helpers.js');
    const ref = await labImport('lab-springs', 'refsim.mjs'); if (!ref) return t.skip('lab not found');
    const srv = await serveDir(ROOT);
    try {
      const { spec, take, mk } = await recordLive(srv, id, rate);
      const rows = take.data.rows, i0 = rows.findIndex((r) => r.k > mk.k);
      const route = spec.source.route, params = { ...spec.source.params };
      // The specimen timeline is the source timeline plus sourceShiftMs (a whole number of frames); the lab simulator runs on the
      // source timeline, so specimen frame j is compared with lab frame j + off. All lab regimes here are exact hx grids.
      const dt = 1000 / rate, off = Math.round(-spec.timeline.sourceShiftMs / dt), N = rows.length - i0;
      assert.ok(Math.abs(off * dt + spec.timeline.sourceShiftMs) < 1e-6, 'shift is a whole number of frames');
      const r6 = (x) => Math.round(x * 1e6) / 1e6;
      const refFrames = Array.from({ length: N + off + 1 }, (_, j) => ({ k: j, T: r6(j * dt), sy: 0, sx: 0 }));
      const sim = ref.simulate(route, params, { frames: refFrames, trace: params.sched || params.path, anchorIndex: 0 });
      const xs = sim.channels['.b0|drv:--x'];
      const tr = spec.tracks[0], got = rows.slice(i0).map((r) => recorded(take, spec, tr, r));
      // the inertia route: only from the first coast frame on (the drag leg is pointer driven and not part of the specimen)
      const from = route === 'm10' ? Math.ceil((tr.motion.startMs + 1) / dt) : 0;
      let se = 0, n = 0, worst = 0, amp = 0;
      for (let j = from; j < N; j++) { const xr = xs[j + off]; if (xr == null) continue; const d = got[j] - xr; se += d * d; n++; worst = Math.max(worst, Math.abs(d)); amp = Math.max(amp, Math.abs(xr)); }
      const nrmse = Math.sqrt(se / n) / (params.A || amp);
      assert.ok(n > 40, 'enough frames compared: ' + n);
      assert.ok(nrmse <= 0.005, `${id}: NRMSE ${nrmse}`);
      assert.ok(worst < 1e-4, `${id}: max |specimen - lab| = ${worst} (r6-rounded frame times bound this at ~1e-6)`);
      console.log(`# ${id} @${rate}: ${n} frames, NRMSE ${nrmse.toExponential(2)}, max |diff| ${worst.toExponential(2)} px`);
    } finally { await srv.close(); }
  });
}
