// Fetched late by late.html: wires the hover of #late (rAF tween, easeOutCubic 300 ms, translateY 0 -> -24 px).
(() => {
  const el = document.getElementById('late'); let busy = false;
  el.addEventListener('pointerenter', () => {
    if (busy) return; busy = true; let s = null;
    const tick = (now) => {
      if (s == null) s = now; const p = Math.min(1, (now - s) / 300); const e = 1 - Math.pow(1 - p, 3);
      el.style.transform = `translateY(${-24 * e}px)`;
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
})();
