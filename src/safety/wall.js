// Bot-wall / login-wall / geo-block detection on a fetched page (status + html + headers).

function visibleText(html) {
  return String(html || '')
    .replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const CONTENT_TEXT = 2000, CONTENT_LINKS = 30;

export function detectWall({ status, html, headers, finalUrl } = {}) { // eslint-disable-line no-unused-vars
  const h = String(html || '');
  const text = visibleText(h);
  const small = text.length < 400;
  const lower = h.toLowerCase();

  if (status === 451) return { kind: 'geo', marker: 'status:451' };
  const geo = /not available in your (country|region)|not available in your location/i.exec(text);
  if (geo && (status >= 400 || text.length < 3000)) return { kind: 'geo', marker: geo[0].toLowerCase() };

  if (status === 403 || status === 429 || status === 503) return { kind: 'wall', marker: 'status:' + status };
  if (lower.includes('cf-chl') || lower.includes('challenge-platform')) return { kind: 'wall', marker: 'cloudflare' };
  if (/just a moment\.\.\./i.test(h) && lower.includes('cloudflare')) return { kind: 'wall', marker: 'cloudflare' };
  if (lower.includes('captcha-delivery.com')) return { kind: 'wall', marker: 'datadome' };
  if (small && lower.includes('datadome')) return { kind: 'wall', marker: 'datadome' };
  if (/access denied/i.test(text) && /reference #/i.test(text)) return { kind: 'wall', marker: 'akamai' };
  if (lower.includes('px-captcha')) return { kind: 'wall', marker: 'perimeterx' };
  if (small && h.includes('_pxAppId')) return { kind: 'wall', marker: 'perimeterx' };
  if (lower.includes('incapsula incident') || (small && h.includes('_Incapsula_Resource'))) return { kind: 'wall', marker: 'incapsula' };
  if ((lower.includes('hcaptcha.com/1/api.js') || lower.includes('challenges.cloudflare.com/turnstile')) && small) {
    return { kind: 'wall', marker: 'captcha-interstitial' };
  }

  // a password field is a login wall when the login is what the page IS: a content page (a marketing site with a sign-in form
  // in its header menu, e.g. a library's docs home: 3.5 k characters of text, hundreds of links) is not one. Both must hold to pass: plenty
  // of text and plenty of links. A login page (~0.7 k text, ~15 links) stays a wall.
  if (/<input\b[^>]*\btype\s*=\s*["']?password/i.test(h.replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, ' '))) {
    const links = (h.match(/<a\b[^>]*\bhref\s*=/gi) || []).length;
    if (!(text.length >= CONTENT_TEXT && links >= CONTENT_LINKS)) return { kind: 'login', marker: 'input:password' };
  }
  if (finalUrl) {
    try {
      const p = new URL(finalUrl).pathname;
      if (/(^|\/)(login|log-in|signin|sign-in|auth|account\/login)(\/|$|\.)/i.test(p)) return { kind: 'login', marker: 'path:' + p };
    } catch { /* ignore */ }
  }
  return null;
}
