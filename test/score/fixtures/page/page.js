// Scorer fixture (own parameters, public-safe). One page, one mechanism per element; parameters from the query string.
// Planted-defect variants (?v=): ref | ease (map + transition easing swapped) | hz60 (per-frame EMA replaced by a
// dt-aware lerp tuned on a 60 Hz display) | maskskip (mask jumps open, fade runs early) | none (all motion removed).
// Sampler phase: ?phase=<ms> delays every trigger and scroll input by a sub-frame amount (G1-4 §8.3.1); the page logs
// the exact time of each trigger/input in window.__ev so the scorer aligns on the real input time.
// Every JS motion starts on the frame clock (first rAF timestamp after its trigger), as CSS, GSAP and Motion do.
(() => {
  const q = new URLSearchParams(location.search);
  const num = (k, d) => (q.has(k) ? +q.get(k) : d);
  const V = q.get('v') || 'ref';
  const P = {
    phase: num('phase', 0),
    D: num('D', 560),            // CSS transition duration, ms           [ladder: duration]
    k: num('k', 170), c: num('c', 13), sTo: 180,   // spring (m = 1)      [ladder: k]
    L: num('L', 90), LD: 320,    // lag before a frame-locked tween, ms   [ladder: lag]
    h: num('h', 0.35), HD: 720,  // keyframe hold fraction                [ladder: hold]
    alpha: num('alpha', 0.15),   // per-frame EMA on a scroll map         [ladder: alpha]
  };
  const EASE = V === 'ease' ? 'cubic-bezier(0.6, 0.05, 0.35, 1)' : 'cubic-bezier(0.3, 0.75, 0.35, 1)';
  const $ = (id) => document.getElementById(id);
  const ev = window.__ev = [];
  const none = V === 'none';
  const clamp01 = (x) => Math.max(0, Math.min(1, x));
  const smooth = (t) => t * t * (3 - 2 * t);
  const eioc = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const outCubic = (t) => 1 - Math.pow(1 - t, 3);

  // a frame-locked tween / closed-form motion: t0 = first rAF timestamp after start()
  const run = (fn, dur) => { let t0 = null; const f = (ts) => { if (t0 == null) t0 = ts; const t = ts - t0; fn(t); if (dur == null || t < dur) requestAnimationFrame(f); }; requestAnimationFrame(f); };

  $('cs').style.transition = `transform ${P.D}ms ${EASE}`;
  const start = () => {
    ev.push({ kind: 'time', T: performance.now(), value: 'go' });
    if (none) return;
    $('cs').style.transform = 'translateX(220px)';
    $('wa').animate([{ transform: 'translateX(0px)' }, { transform: 'translateX(220px)' }], { duration: P.D, easing: EASE, fill: 'forwards' });
    // closed-form spring from rest, x0 = 0 -> target sTo
    const w0 = Math.sqrt(P.k), z = P.c / (2 * Math.sqrt(P.k)), A = P.sTo;
    const spring = (t) => {
      const s = t / 1000;
      if (z < 1) { const wd = w0 * Math.sqrt(1 - z * z); return A - A * Math.exp(-z * w0 * s) * (Math.cos(wd * s) + (z * w0 / wd) * Math.sin(wd * s)); }
      return A - A * Math.exp(-w0 * s) * (1 + w0 * s);
    };
    run((t) => { $('sp').style.transform = `translateX(${spring(t)}px)`; }, 2500);
    // delayed tween: the delay runs on the animation's own clock (as CSS transition-delay / GSAP delay), so it is
    // continuous, not rounded to frames
    run((t) => { $('lg').style.transform = `translateX(${160 * outCubic(Math.min(1, Math.max(0, t - P.L) / P.LD))}px)`; }, P.L + P.LD);
    $('hd').animate([{ transform: 'translateX(0px)', offset: 0 }, { transform: 'translateX(0px)', offset: P.h, easing: 'cubic-bezier(0.4, 0, 0.2, 1)' }, { transform: 'translateX(200px)', offset: 1 }],
      { duration: P.HD, fill: 'forwards' });
  };
  window.__go = () => { setTimeout(start, P.phase); };
  window.__scrollAt = (y) => { setTimeout(() => { scrollTo(0, y); ev.push({ kind: 'scroll', T: performance.now(), value: Math.round(scrollY) }); }, P.phase); };

  // scroll-driven: per-frame EMA on a linear map (ref) | dt-aware lerp tuned for 60 Hz (hz60); a pure smoothstep map;
  // a mask (clip-path) then a fade overlay
  let x = 0, last = null;
  const lambda = -Math.log(1 - P.alpha) * 60;   // the rate that gives alpha per frame at 60 Hz
  const loop = (ts) => {
    const dt = last == null ? 1 / 60 : (ts - last) / 1000; last = ts;
    const sy = scrollY;
    if (!none) {
      const g = 300 * clamp01((sy - 100) / 1400);
      if (V === 'hz60') x += (g - x) * (1 - Math.exp(-lambda * dt)); else x += P.alpha * (g - x);
      if (Math.abs(g - x) < 0.005) x = g;
      $('em').style.transform = `translateX(${x}px)`;
      const m = clamp01((sy - 600) / 400);
      $('mp').style.setProperty('--m', String(V === 'ease' ? eioc(m) : smooth(m)));
      const inset = V === 'maskskip' ? (sy >= 300 ? 0 : 36) : 36 * (1 - clamp01((sy - 300) / 400));
      $('mk').style.clipPath = `inset(${inset}%)`;
      $('fd').style.opacity = String(V === 'maskskip' ? clamp01((sy - 300) / 200) : clamp01((sy - 700) / 200));
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  window.__ready = true;
})();
