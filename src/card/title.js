// The name of the page a card (or any REVA page about one look) is about: host + path, readable and short.
// One formatter for the motion card page (build.js puts it in the card data; page/template.html titleOf reads it) and the
// MCP card renderer (render.js).
//   https://reva-cli.pages.dev/examples/spring-press/?a=1#x  ->  reva-cli.pages.dev/examples/spring-press
//   REVA's bundled demo page (served on loopback by reva demo, compare "demo" or the MCP fixture "demo")  ->  REVA demo page
//   another page on localhost / 127.0.0.1 / ::1  ->  local page /about   (a file: URL: local page about.html, never the folder)

// control and bidi characters never reach a title (a path is page-chosen text): the report's own list
import { CONTROL_CHARS as CONTROLS } from '../report/untrusted.js';

export const TITLE_MAX = 48;
const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\]|::1|0\.0\.0\.0)$|\.localhost$/i;

/** The middle of a long string replaced by one ellipsis, so the result is at most `max` characters (start and end kept). */
export function middleEllipsis(s, max = TITLE_MAX) {
  const t = String(s);
  if (t.length <= max) return t;
  if (max < 3) return t.slice(0, max);
  const keep = max - 1; const tail = Math.ceil(keep * 0.55); const head = keep - tail;
  return `${t.slice(0, head)}…${t.slice(t.length - tail)}`;
}

/** A URL path made readable: decoded, no trailing slash, no index.html / index.htm, '' for the root. */
export function readablePath(pathname) {
  let p = String(pathname || '/');
  try { p = decodeURIComponent(p); } catch { /* keep the encoded form */ }
  p = p.replace(CONTROLS, '').replace(/\/index\.html?$/i, '/').replace(/\/+$/, '');
  return p;
}

/**
 * @param {object|string} src  look.json "source" ({kind, url | startUrl, demo}) or a URL string
 * @param {object} [o] {max}
 * @returns {string} e.g. "reva-cli.pages.dev/examples/spring-press", "REVA demo page", "local page /about"
 */
export function cardTitle(src, { max = TITLE_MAX } = {}) {
  const s = typeof src === 'string' ? { url: src } : (src || {});
  if (s.demo) return 'REVA demo page';
  const raw = s.startUrl || s.url || '';
  let u; try { u = new URL(raw); } catch { return 'a local page'; }
  if (u.protocol === 'file:') {
    const base = readablePath(u.pathname).split('/').pop();
    return middleEllipsis(base ? `local page ${base}` : 'local page', max);
  }
  if (!/^https?:$/.test(u.protocol)) return 'a local page';
  const p = readablePath(u.pathname);
  if (LOOPBACK.test(u.hostname)) return p ? `local page ${middleEllipsis(p, Math.max(8, max - 11))}` : 'local page';
  const host = u.host.replace(CONTROLS, '');
  if (!p) return middleEllipsis(host, max);
  const full = host + p;
  if (full.length <= max) return full;
  // a long path is shortened in its middle; a host too long to leave room for any path is shortened as a whole
  const room = max - host.length;
  return room >= 12 ? host + middleEllipsis(p, room) : middleEllipsis(full, max);
}
