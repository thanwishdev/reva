// Stand-in for a CDN-hosted animation library: one 600 ms linear slide of #cdnbox, started when the script runs.
(() => {
  const el = document.getElementById('cdnbox'); let t0 = null;
  requestAnimationFrame(function f(t) { if (t0 == null) t0 = t; const p = Math.min(1, (t - t0) / 600); el.style.transform = `translateX(${p * 300}px)`; if (p < 1) requestAnimationFrame(f); });
})();
