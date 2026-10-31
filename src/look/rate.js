// Recording rate for a URL (the same rule the corpus runner uses): 60 Hz when one canvas covers more than 30 %
// of the viewport (WebGL-heavy pages under software GL; the cursor springs of such pages are stepped per frame and fit
// differently at 120 Hz), else 120 Hz. An archive uses the rate its corpus run chose (source.js); a URL has no snapshot, so
// the page is measured live after boot.
export const CANVAS_COVER_60HZ = 0.3;

/** The largest share of the viewport one canvas box covers, now. In the page (Playwright evaluate). */
export function canvasCoverInPage() {
  const W = innerWidth, H = innerHeight, area = W * H;
  let max = 0, n = 0;
  const walk = (root) => {
    for (const c of root.querySelectorAll('canvas')) {
      n++;
      const r = c.getBoundingClientRect();
      const iw = Math.max(0, Math.min(r.right, W) - Math.max(r.left, 0)), ih = Math.max(0, Math.min(r.bottom, H) - Math.max(r.top, 0));
      max = Math.max(max, (iw * ih) / area);
    }
    for (const e of root.querySelectorAll('*')) if (e.shadowRoot) walk(e.shadowRoot);
  };
  walk(document);
  return { canvases: n, maxCover: Math.round(max * 1000) / 1000 };
}

/** @returns {Promise<{canvases:number,maxCover:number}|null>} null when the page could not be asked */
export async function measureCanvasCover(S) {
  try { return await S.evRetry(canvasCoverInPage); } catch { return null; }
}
