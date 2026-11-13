// Cookie-consent banner detection: which CMP is on the page and the selectors that reject (never accept) its cookies.

export const CMP_RULES = [
  { cmp: 'OneTrust', markers: [/cdn\.cookielaw\.org|otSDKStub|onetrust/i], reject: ['#onetrust-reject-all-handler'] },
  { cmp: 'Cookiebot', markers: [/consent\.cookiebot\.com|Cookiebot/i], reject: ['#CybotCookiebotDialogBodyButtonDecline'] },
  { cmp: 'Didomi', markers: [/sdk\.privacy-center\.org|didomi/i], reject: ['#didomi-notice-disagree-button'] },
  { cmp: 'Usercentrics', markers: [/usercentrics/i], reject: ['[data-testid="uc-deny-all-button"]'] },
  { cmp: 'Quantcast', markers: [/quantcast\.mgr|cmp2/i], reject: ['.qc-cmp2-summary-buttons button[mode="secondary"]'] },
  { cmp: 'TrustArc', markers: [/consent\.trustarc\.com|truste/i], reject: ['#truste-consent-required'] },
  { cmp: 'Axeptio', markers: [/axept\.io|axeptio/i], reject: ['#axeptio_btn_dismiss'] },
  { cmp: 'iubenda', markers: [/iubenda\.com/i], reject: ['.iubenda-cs-reject-btn'] },
  { cmp: 'Complianz', markers: [/complianz|cmplz/i], reject: ['.cmplz-deny'] },
  { cmp: 'CookieYes', markers: [/cookieyes|cky-consent/i], reject: ['.cky-btn-reject'] },
];

export const REJECT_TEXTS = ['Reject all', 'Decline', 'Only necessary', 'Refuser'];

export function detectConsent(html) {
  const h = String(html || '');
  for (const r of CMP_RULES) {
    if (r.markers.some((m) => m.test(h))) return { cmp: r.cmp, clicks: [...r.reject] };
  }
  const lower = h.toLowerCase();
  const clicks = [];
  for (const t of REJECT_TEXTS) {
    const tl = t.toLowerCase();
    let from = 0;
    for (;;) {
      const i = lower.indexOf(tl, from);
      if (i < 0) break;
      const win = lower.slice(Math.max(0, i - 400), i + tl.length + 400);
      if (/cookie|consent|gdpr/.test(win)) { clicks.push(`text="${t}"`); break; }
      from = i + tl.length;
    }
  }
  return { cmp: null, clicks };
}

/**
 * Runs IN THE PAGE (page.evaluate(clickRejectInPage, clicks)): clicks the first visible match of each reject selector
 * (`text="..."` = a button / link whose own text is exactly that, any case). Never clicks anything else. Returns what it clicked.
 */
export function clickRejectInPage(clicks) {
  // a banner the scan's consent hider took out (src/safety/banner.js) is display: none; its reject button is still the answer
  const visible = (el) => { if (el.closest && el.closest('[data-reva-hidden="consent"]')) return true; const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
  const done = [];
  for (const c of clicks || []) {
    let el = null;
    const m = /^text="(.*)"$/.exec(c);
    try {
      if (m) {
        const want = m[1].trim().toLowerCase();
        el = [...document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]')]
          .find((e) => ((e.innerText || e.value || '').trim().toLowerCase() === want) && visible(e)) || null;
      } else el = [...document.querySelectorAll(c)].find(visible) || null;
    } catch { el = null; }
    if (el) { el.click(); done.push(c); break; } // one reject is the answer; a second click could hit a different dialog
  }
  return done;
}
