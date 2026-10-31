// Fetched late by steady.html: plays the preloader exit, then wires the hover of #card and the dots.
(() => {
  const ease = (p) => 1 - Math.pow(1 - p, 3);
  const tween = (ms, f, done) => { let s = null; const tick = (now) => { if (s == null) s = now; const p = Math.min(1, (now - s) / ms); f(ease(p)); if (p < 1) requestAnimationFrame(tick); else if (done) done(); }; requestAnimationFrame(tick); };
  const loader = document.querySelector('.loader');
  tween(1200, (e) => { loader.style.transform = `translateY(${-200 * e}px)`; loader.style.opacity = String(1 - e); });
  const card = document.getElementById('card'); let busy = false;
  card.addEventListener('pointerenter', () => {
    if (busy) return; busy = true;
    tween(400, (e) => { card.style.transform = `scale(${1 + 0.1 * e})`; });
    document.querySelectorAll('.dot').forEach((d, i) => setTimeout(() => tween(300, (e) => { d.style.transform = `translateY(${-30 * e}px)`; }), i * 80));
  });
})();
