// Real-frame keepalive (promoted from the aim-mode spike, 19 Oct 2026).
//
// Why: the hx step waits for two REAL frames per virtual frame (W.realFrame). When the OS frame clock is throttled
// (measured ~8.6-10 Hz on a blank headless page while another full-screen app drove the display), every virtual frame
// costs ~100 ms of wall time and a 4 s take takes a minute. Chromium with --disable-frame-rate-limit produces frames at
// full speed only while real rAF requests and paint damage are continuous; under hx the page's rAF is virtual, so the
// browser sees neither. This script keeps both alive: a native rAF taken from a same-origin about:blank iframe (the
// recorder does not override nested documents) repaints a 1 px box every real frame.
//
// Invisible to the measurement: the iframe and the box live in a CLOSED shadow root appended after <body> at
// DOMContentLoaded, so the recorder's mutation observer, its style hooks and the site's own observers never see them.
// Measured on 8 archived sites: no fitted parameter changed with it on (spike results-pass1/2).
export const KEEPALIVE_ARGS = ['--disable-gpu-vsync', '--disable-frame-rate-limit'];

export function keepaliveRuntime() {
  if (window.top !== window) return;
  let px = null, raf = null, n = 0;
  const tick = () => { px.style.backgroundColor = (n++ & 1) ? 'rgba(0,0,0,0.01)' : 'rgba(0,0,0,0.02)'; raf(tick); };
  const setup = () => {
    if (!document.documentElement) return false;
    const host = document.createElement('wr-keepalive');
    host.setAttribute('aria-hidden', 'true');
    const sr = host.attachShadow({ mode: 'closed' });
    px = document.createElement('div');
    px.setAttribute('style', 'position:fixed;left:0;top:0;width:1px;height:1px;pointer-events:none;z-index:2147483647');
    const ifr = document.createElement('iframe');
    ifr.setAttribute('style', 'position:fixed;left:0;top:0;width:1px;height:1px;border:0;opacity:0;pointer-events:none');
    sr.appendChild(px); sr.appendChild(ifr);
    document.documentElement.appendChild(host);
    const cw = ifr.contentWindow; raf = cw.requestAnimationFrame.bind(cw);
    raf(tick);
    return true;
  };
  // after parsing (DOMContentLoaded), appended after <body>: the parser and a document-level hydration never meet it
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setup, { once: true }); else setup();
}

/** Script text for addInitScript. */
export function keepaliveSource() { return `(${keepaliveRuntime.toString()})();`; }
