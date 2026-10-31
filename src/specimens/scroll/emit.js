// HTML emitter for scroll specimens: one self-contained, content-free page per spec.
//
// The page has no text, no images and no network access: coloured boxes, a tall empty document, sticky runways for pins.
// It carries (1) the spec as JSON, (2) core.js verbatim (top-level `export` removed) and (3) the small runtime below.
// Contract (documented in README.md): window.specimen, window.seek(t), live mode driven by the real scroll offset / wheel /
// pointer, `specimen.go()` for triggered mechanisms (FLIP, view transitions).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cssEase } from './core.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const coreSource = () => fs.readFileSync(path.join(HERE, 'core.js'), 'utf8').replace(/^export /gm, '');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const px = (n) => `${+n.toFixed(4)}px`;

function css(spec) {
  const out = [];
  out.push(':root{color-scheme:dark light}html,body{margin:0;padding:0;background:#15171c}body{min-height:100vh}');
  out.push(`#doc{position:absolute;left:0;top:0;width:1px;height:${px(spec.docHeight)};pointer-events:none}`);
  out.push('.u{box-sizing:border-box;border-radius:10px;transform-origin:50% 50%}');
  const pinned = new Set((spec.pins || []).map((p) => p.subject));
  for (const s of spec.subjects) {
    const b = s.fixedBox || { x: s.x, y: s.y, w: s.w, h: s.h };
    const colour = `hsl(${s.hue} 58% 58%)`;
    if (s.origin) out.push(`#${s.id}{transform-origin:${s.origin}}`);
    if (pinned.has(s.id)) out.push(`#${s.id}{position:sticky;top:0;width:${px(b.w)};height:${px(spec.viewport.height)};background:${colour}}`);
    else out.push(`#${s.id}{position:${s.layoutSwitch || s.vt ? 'absolute' : 'fixed'};left:${px(b.x)};top:${px(b.y)};width:${px(b.w)};height:${px(b.h)};background:${colour}}`);
  }
  for (const p of spec.pins || []) out.push(`#r-${p.subject}{position:absolute;left:0;width:1px;top:${px(p.start)};height:${px(p.end - p.start + spec.viewport.height)}}`);
  for (const m of spec.mechanisms) {
    if (m.kind === 'flip') {
      const s = spec.subjects.find((q) => q.id === m.subject);
      out.push(`#${s.id}.s{left:${px(m.B.x)};top:${px(m.B.y)};width:${px(m.B.w)};height:${px(m.B.h)}}`);
    }
    if (m.kind === 'view-transition') {
      out.push(':root{view-transition-name:none}');
      for (const g of m.groups) {
        const s = spec.subjects.find((q) => q.id === g.subject);
        out.push(`#${s.id}{view-transition-name:${g.name}}#${s.id}.s{left:${px(g.B.x)};top:${px(g.B.y)};width:${px(g.B.w)};height:${px(g.B.h)}}`);
        const ez = cssEase(g.ease);
        out.push(`::view-transition-group(${g.name}){animation-duration:${g.d}ms;${g.delay ? `animation-delay:${g.delay}ms;` : ''}${ez ? `animation-timing-function:${ez};` : ''}}`);
      }
    }
  }
  return out.join('\n');
}

const RUNTIME = String.raw`
(function () {
  var SPEC = JSON.parse(document.getElementById('wr-spec').textContent);
  var eng = new Engine(SPEC);
  var els = {}; SPEC.subjects.forEach(function (s) { els[s.id] = document.getElementById(s.id); });
  var NATIVE = {}; SPEC.mechanisms.forEach(function (m) { if (m.kind === 'flip' || m.kind === 'view-transition') NATIVE[m.subject] = true;
    if (m.kind === 'view-transition') m.groups.forEach(function (g) { NATIVE[g.subject] = true; }); });
  var mode = 'live', k = 0, rep = null, repKey = '', anim = null, rafTw = 0, vtActive = null;
  var sy0 = function () { return window.scrollY || window.pageYOffset || 0; };

  function apply(snap, includeNative) {
    var per = {};
    Object.keys(snap.channels).forEach(function (key) {
      var i = key.indexOf('|'), sid = key.slice(0, i), name = key.slice(i + 1), el = els[sid], v = snap.channels[key];
      if (!el || (NATIVE[sid] && !includeNative)) return;
      if (name.indexOf('drv:') === 0) el.style.setProperty(name.slice(4), String(v));
      else (per[sid] = per[sid] || {})[name.slice(4)] = v;
    });
    Object.keys(per).forEach(function (sid) {
      var p = per[sid], el = els[sid], t = [];
      if (p.tx != null || p.ty != null) t.push('translate(' + (p.tx || 0) + 'px, ' + (p.ty || 0) + 'px)');
      if (p.sx != null || p.sy != null) t.push('scale(' + (p.sx == null ? 1 : p.sx) + ', ' + (p.sy == null ? 1 : p.sy) + ')');
      if (t.length) el.style.transform = t.join(' ');
      if (p.opacity != null) el.style.opacity = String(p.opacity);
    });
  }

  // ---- live mode: the real scroll offset drives the frame, real events drive the inputs
  eng.begin({ k: 0, T: 0, sy: sy0() });
  apply(eng.snapshot(), false);
  function tick(ts) {
    requestAnimationFrame(tick);
    if (mode !== 'live') return;
    k++;
    eng.frame({ k: k, T: ts, sy: sy0() });
    var s = eng.snapshot(); apply(s, false);
    if (s.scrollTo != null && Math.round(sy0()) !== s.scrollTo) window.scrollTo(0, s.scrollTo);
  }
  requestAnimationFrame(tick);
  window.addEventListener('wheel', function (e) {
    if (mode !== 'live') return;
    var r = eng.deliver({ type: 'wheel', dy: e.deltaY }, { T: performance.now(), sy: sy0() });
    for (var i = 0; i < r.length; i++) if (r[i].prevent) { e.preventDefault(); break; }
  }, { passive: false });
  ['down', 'move', 'up'].forEach(function (n) {
    window.addEventListener('pointer' + n, function (e) { if (mode === 'live') eng.deliver({ type: 'pointer' + n, x: e.clientX }, { T: performance.now(), sy: sy0() }); });
  });

  // ---- triggered mechanisms in live mode use the real browser machinery (WAAPI / View Transitions)
  function flipLive(m) {
    var el = els[m.subject], L = SPEC.subjects.filter(function (s) { return s.id === m.subject; })[0];
    var first = el.getBoundingClientRect();
    if (anim) { anim.cancel(); anim = null; } if (rafTw) { cancelAnimationFrame(rafTw); rafTw = 0; } el.style.transform = '';
    el.classList.toggle('s');
    var last = el.getBoundingClientRect();
    var d = { dx: first.left - last.left, dy: first.top - last.top, sx: first.width / last.width, sy: first.height / last.height };
    var inv = function (kk) { return 'translate(' + d.dx * kk + 'px, ' + d.dy * kk + 'px) scale(' + (1 + (d.sx - 1) * kk) + ', ' + (1 + (d.sy - 1) * kk) + ')'; };
    var css = cssEase(m.ease);
    if (m.impl === 'waapi' && css) anim = el.animate([{ transform: inv(1) }, { transform: 'none' }], { duration: m.D, easing: css, fill: 'both' });
    else {
      var E = easeFn(m.ease), t0 = null; el.style.transform = inv(1);
      var loop = function (now) { rafTw = 0; if (t0 == null) t0 = now; var p = (now - t0) / m.D; if (p >= 1) { el.style.transform = ''; return; } el.style.transform = inv(1 - E(p < 0 ? 0 : p)); rafTw = requestAnimationFrame(loop); };
      rafTw = requestAnimationFrame(loop);
    }
  }
  function vtToggle(m, on) { m.groups.forEach(function (g) { els[g.subject].classList[on ? 'add' : 'remove']('s'); }); }
  function vtLive(m) {
    if (!document.startViewTransition) { vtToggle(m, !els[m.groups[0].subject].classList.contains('s')); return null; }
    var on = !els[m.groups[0].subject].classList.contains('s');
    vtActive = document.startViewTransition(function () { vtToggle(m, on); });
    return vtActive;
  }
  function go() {
    eng.deliver({ type: 'trigger' }, { T: performance.now(), sy: sy0() });
    var out = null;
    SPEC.mechanisms.forEach(function (m) { if (m.kind === 'flip') flipLive(m); else if (m.kind === 'view-transition') out = vtLive(m); });
    return out;
  }

  // ---- seek mode: deterministic replay of the spec's input on the frame grid (the same Replayer the simulator uses)
  async function seek(t, opt) {
    opt = opt || {};
    var input = opt.input || SPEC.input || {};
    mode = 'seek';
    if (anim) { anim.cancel(); anim = null; } if (rafTw) { cancelAnimationFrame(rafTw); rafTw = 0; }
    if (vtActive) { try { vtActive.skipTransition(); } catch (e) {} vtActive = null; }
    var key = JSON.stringify(input);
    var K = framesUpTo(input, SPEC.frameMs, t);
    if (!rep || key !== repKey || K < rep.k) { rep = new Replayer(SPEC, input); repKey = key; }
    var snap = rep.to(K);
    SPEC.mechanisms.forEach(function (m) {
      if (m.kind === 'flip') { var q = snap.aux[m.id]; els[m.subject].classList[q.state ? 'add' : 'remove']('s'); }
      if (m.kind === 'view-transition') vtToggle(m, false);
    });
    apply(snap, true);
    var y = snap.scrollTo != null ? snap.scrollTo : (K > 0 ? frameAt(input, SPEC.frameMs, K).sy : sy0());
    if (opt.scroll !== false && Math.round(sy0()) !== Math.round(y)) window.scrollTo(0, y);
    var vt = null;
    for (var i = 0; i < SPEC.mechanisms.length; i++) {
      var m = SPEC.mechanisms[i];
      if (m.kind !== 'view-transition') continue;
      var trig = (input.triggers && input.triggers.length ? input.triggers[0].T : (m.triggers && m.triggers.length ? m.triggers[0] : null));
      if (trig == null) continue;
      var start = trig + (m.latencyFrames == null ? 2 : m.latencyFrames) * SPEC.frameMs;
      if (t < trig) continue;
      var tr = document.startViewTransition ? document.startViewTransition(function () { vtToggle(m, true); }) : null;
      if (!tr) { vtToggle(m, true); continue; }
      vtActive = tr; await tr.ready;
      var anims = document.getAnimations().filter(function (a) { return a.effect && a.effect.pseudoElement && /view-transition/.test(a.effect.pseudoElement); });
      anims.forEach(function (a) { a.pause(); a.currentTime = Math.max(0, t - start); });
      vt = { start: start, animations: anims.length };
    }
    return { t: t, k: K, T: K > 0 ? frameAt(input, SPEC.frameMs, K).T : 0, channels: snap.channels, aux: snap.aux, scrollTo: snap.scrollTo, vt: vt };
  }
  function live() {
    mode = 'live'; eng = new Engine(SPEC); eng.begin({ k: 0, T: 0, sy: sy0() }); k = 0;
    Object.keys(els).forEach(function (id) { els[id].style.transform = ''; els[id].style.opacity = ''; });
    apply(eng.snapshot(), false);
  }
  function readDom() {
    var o = {};
    SPEC.mechanisms.forEach(function (m) {
      m.channels.forEach(function (c) {
        var el = els[m.subject], cs = getComputedStyle(el), key = m.subject + '|' + c.name;
        if (c.kind === 'var') o[key] = parseFloat(el.style.getPropertyValue(c.prop));
        else if (c.prop === 'opacity') o[key] = +cs.opacity;
        else {
          var mt = /matrix\(([^)]+)\)/.exec(cs.transform), v = mt ? mt[1].split(',').map(parseFloat) : [1, 0, 0, 1, 0, 0];
          o[key] = c.prop === 'tx' ? v[4] : c.prop === 'ty' ? v[5] : c.prop === 'sx' ? Math.hypot(v[0], v[1]) : Math.hypot(v[2], v[3]);
        }
      });
    });
    return o;
  }
  window.specimen = {
    schema: SPEC.schema, id: SPEC.id, spec: SPEC, ready: true, frameMs: SPEC.frameMs,
    get mode() { return mode; }, get frame() { return k; },
    seek: seek, live: live, go: go, read: function () { return eng.snapshot(); }, readDom: readDom,
  };
  window.seek = seek;
  // script(input): schedule the pointer events and triggers of an input description at their absolute page times
  var EPS = 0.001;   // an event at T lands just after the frame whose time is T (hx: after frame k, before frame k+1)
  function script(input, base) {
    input = input || SPEC.input || {}; base = base == null ? 0 : base;
    (input.pointer || []).forEach(function (p) {
      setTimeout(function () { window.dispatchEvent(new PointerEvent('pointer' + p.type, { clientX: p.x, clientY: 100, bubbles: true })); }, Math.max(0, base + p.T + EPS - performance.now()));
    });
    (input.triggers || []).forEach(function (t) { setTimeout(go, Math.max(0, base + t.T + EPS - performance.now())); });
  }
  window.specimen.script = script;
  if (/(^|[#&])auto(&|$)/.test(location.hash)) script(SPEC.input, 0);
})();
`;

/** The page for a spec (spec.input may be present; it only matters for seek). */
export function emitHtml(spec) {
  const subjects = spec.subjects.map((s) => (spec.pins || []).some((p) => p.subject === s.id)
    ? `<div id="r-${s.id}"><div class="u" id="${s.id}"></div></div>` : `<div class="u" id="${s.id}"></div>`).join('\n');
  const json = JSON.stringify(spec).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(spec.id)}</title>
<style>
${css(spec)}
</style></head>
<body>
<div id="doc"></div>
${subjects}
<script id="wr-spec" type="application/json">${json}</script>
<script>
${coreSource()}
${RUNTIME}
</script>
</body></html>
`;
}
