// Cookie-consent banners during a scan's recordings (T4 X5, owner rules of 6 Nov): REVA never presses Agree / Accept. A banner
// layer is hidden for the whole recording, so its motion never enters a take, a clip or a thumbnail; a clear reject button
// inside it may be pressed (the page then knows the visitor said no), nothing else. Announcement bars, navs and every other
// fixed layer stay: a layer is hidden only when it says it is about cookies or consent.
//
// The page side is one init script (CONSENT_HIDE_INIT) that runs in every document before the page's own scripts:
//   1. a constructed style sheet hides the containers of known consent platforms (OneTrust, Cookiebot, Didomi, ...) the
//      moment they are inserted, before they draw a frame;
//   2. a MutationObserver (inserted nodes, class / hidden / open changes) and a 250 ms sweep find any other fixed layer whose
//      own words are about cookies or consent and that offers a consent control, and mark it data-reva-hidden="consent";
//      the same sheet hides it. The recorder never watches an element under that mark (src/record/inpage.js).
// A scroll lock, an inert page root or a backdrop the banner put up is undone while it is the banner's (see release()).
// What was hidden, unlocked or rejected is read back after each take (consentStateInPage) and lands in take.json extra.consent and in
// scan.json `consent`, so the card can say what was left out.

/** What scan.json `consent` says REVA did, word for word, for the card. */
export const CONSENT_POLICY = 'REVA never accepts cookies. A cookie-consent banner is hidden while the page is recorded, so its motion is not in the moves, and a scroll lock, inert page or backdrop it put on the page is lifted while it is hidden; a clear reject button in it may be pressed, nothing else.';

/** Containers of known consent platforms: hidden from the first frame. Only ids and classes no other kind of layer uses. */
export const CMP_HIDE = Object.freeze([
  ['OneTrust', '#onetrust-consent-sdk'], ['OneTrust', '#onetrust-banner-sdk'], ['OneTrust', '#onetrust-pc-sdk'],
  ['Cookiebot', '#CybotCookiebotDialog'], ['Cookiebot', '#CybotCookiebotDialogBodyUnderlay'],
  ['Didomi', '#didomi-host'], ['Usercentrics', '#usercentrics-root'], ['Usercentrics', '#usercentrics-cmp-ui'],
  ['Quantcast', '#qc-cmp2-container'], ['Quantcast', '.qc-cmp2-container'],
  ['TrustArc', '#truste-consent-track'], ['TrustArc', '#consent_blackbar'], ['TrustArc', '.truste_overlay'], ['TrustArc', '.truste_box_overlay'],
  ['Axeptio', '#axeptio_overlay'], ['iubenda', '#iubenda-cs-banner'],
  ['Complianz', '#cmplz-cookiebanner-container'], ['Complianz', '.cmplz-cookiebanner'],
  ['CookieYes', '.cky-consent-container'], ['CookieYes', '.cky-overlay'], ['CookieYes', '.cky-modal'],
  ['Osano', '.osano-cm-window'], ['Osano', '.osano-cm-dialog'], ['Termly', '#termly-code-snippet-support'],
  ['Klaro', '.klaro .cookie-notice'], ['Klaro', '.klaro .cookie-modal'], ['Borlabs', '#BorlabsCookieBox'],
  ['Cookie Consent', '.cc-window'], ['Cookie Consent', '#cc-main'], ['Cookie Law Info', '#cookie-law-info-bar'],
  ['Cookie Notice', '#cookie-notice'], ['HubSpot', '#hs-eu-cookie-confirmation'], ['Cookie Script', '#cookiescript_injected'],
  ['GDPR Cookie Compliance', '#moove_gdpr_cookie_info_bar'], ['Shopify', '#shopify-pc__banner'], ['Shopify', '#shopify-pc__prefs'],
  ['Sourcepoint', '[id^="sp_message_container_"]'], ['Ketch', '#lanyard_root'], ['tarteaucitron', '#tarteaucitronRoot'],
  ['Cookie Information', '#coiOverlay'], ['CookieFirst', '.cookiefirst-root'], ['Securiti', '#consent-banner-main'],
]);

/**
 * The words that decide, kept as plain strings so the same rules run in the page and in node tests.
 * consent:  the layer's own text (link texts left out) says it is about cookies or consent
 * context:  ... and says something a consent notice says (or offers a consent control)
 * attr:     an id or class of the layer or of what it holds names cookies / consent / a known platform
 * control:  the whole text of a button or link in it is a consent choice (no bare OK / Close: an announcement bar has those)
 * reject:   the whole text is a clear "no" (the only control REVA may press)
 */
export const CONSENT_WORDS = Object.freeze({
  consent: String.raw`\b(cookies?|consent|gdpr|ccpa|einwilligung|consentimiento|consenso|consentement|toestemming|rgpd|dsgvo)\b`,
  context: String.raw`\b(we use|this (web)?site uses|uses cookies|use of cookies|privacy|policy|accept|agree|allow|preferences|settings|necessary|essential|analytics|tracking|third[- ]part(y|ies)|personali[sz]|advertis|marketing|datenschutz|wir verwenden|privacidad|utilizamos|usamos|nous utilisons|confidentialit|utilizziamo|gebruiken)`,
  attr: String.raw`(^|[^a-z])(cookies?|consent|gdpr|onetrust|optanon|cookiebot|cybot|didomi|usercentrics|truste|osano|iubenda|qc-cmp2?|klaro|termly|cookieyes|cky|cmplz|borlabs|cookiefirst|tarteaucitron)([^a-z]|$)`,
  control: String.raw`^(accept|agree|allow|reject|decline|deny|refuse|i agree|i accept|manage|preferences|settings|customi[sz]e|more options|aceptar|rechazar|configurar|akzeptieren|ablehnen|zustimmen|einstellungen|accepter|refuser|param[eè]tres|accetta|accetto|rifiuta|accepteren|weigeren)( all| all cookies| cookies| choices| preferences| settings| selection| and close| alle| tout| tutti)?$|^(cookie|privacy|consent) (settings|preferences|options|policy)$|^manage (cookies|preferences|consent|options)$|^(use )?(only )?(strictly )?(necessary|essential|required)( cookies)?( only)?$|^alle (akzeptieren|ablehnen)$|^tout (accepter|refuser)$|^nur (notwendige|essenzielle)( cookies)?$`,
  reject: String.raw`^(reject|decline|deny|refuse)( all| all cookies| cookies| optional cookies| non-essential cookies)?$|^(use )?(only )?(strictly )?(necessary|essential|required)( cookies)?( only)?$|^(continue|proceed) without accepting$|^rechazar( todo| todas)?$|^(alle )?ablehnen$|^nur (notwendige|essenzielle)( cookies)?$|^(tout )?refuser$|^continuer sans accepter$|^rifiuta( tutto| tutti)?$|^(alles )?weigeren$`,
});

/** Limits that keep a hide away from the page itself: a layer bigger than this is no banner (a smooth-scroll shell is fixed too). */
export const BANNER_LIMITS = Object.freeze({ maxText: 3000, maxNodes: 600, sweepMs: 250, maxRecords: 40 });

/**
 * Runs IN THE PAGE, at document start: (cfg) => installs the hider once per document and returns its state object
 * window.__REVA_CONSENT = { hidden: [...], rejected: [...], reject(), sweep() }.
 */
export function consentHiderInPage(cfg) {
  if (window.__REVA_CONSENT) return window.__REVA_CONSENT;
  const W = cfg.words, L = cfg.limits;
  const RX = { consent: new RegExp(W.consent, 'i'), context: new RegExp(W.context, 'i'), attr: new RegExp(W.attr, 'i'), control: new RegExp(W.control, 'i'), reject: new RegExp(W.reject, 'i') };
  const MARK = 'data-reva-hidden';
  const st = { hidden: [], rejected: [], errors: 0 };
  window.__REVA_CONSENT = st;
  const t0 = () => Math.round(performance.now());
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const short = (e) => {
    let s = e.localName || 'node';
    if (e.id) s += '#' + e.id;
    const c = typeof e.className === 'string' ? e.className.trim().split(/\s+/).filter(Boolean).slice(0, 3) : [];
    for (const x of c) s += '.' + x;
    return s.slice(0, 160);
  };
  // 1. the sheet: known platforms and anything marked, hidden whatever the page's own styles say
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(`${cfg.cmp.map((x) => x[1]).join(',\n')}, [${MARK}="consent"] { display: none !important; }`);
    const add = () => { try { if (!document.adoptedStyleSheets.includes(sheet)) document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]; } catch (e) { st.errors++; } };
    add(); st.ensureSheet = add;
  } catch (e) { st.errors++; st.ensureSheet = () => {}; }

  const isFixed = (e) => { try { return getComputedStyle(e).position === 'fixed'; } catch (x) { return false; } };
  const parentOf = (e) => e.parentElement || (e.parentNode && e.parentNode.host) || null;
  /** Text a person reads in the layer, link texts left out (a nav or footer full of "Cookie policy" links is no notice). */
  const ownText = (e) => {
    let s = '';
    const walk = (n, inLink) => {
      if (s.length > L.maxText + 200) return;
      if (n.nodeType === 3) { if (!inLink) s += n.nodeValue + ' '; return; }
      if (n.nodeType !== 1) return;
      const tag = n.localName;
      if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'template') return;
      const link = inLink || tag === 'a';
      for (const c of n.childNodes) walk(c, link);
      if (n.shadowRoot) for (const c of n.shadowRoot.childNodes) walk(c, link);
    };
    walk(e, false);
    return norm(s);
  };
  const controlsOf = (e) => [...e.querySelectorAll('button, [role="button"], a, input[type="button"], input[type="submit"]')].slice(0, 80);
  const labelOf = (c) => norm(c.innerText || c.textContent || c.value || c.getAttribute('aria-label') || '').toLowerCase().replace(/[.!]+$/, '');
  const attrHit = (e) => {
    const of = (x) => `${x.id || ''} ${typeof x.className === 'string' ? x.className : ''} ${x.getAttribute('aria-label') || ''}`;
    if (RX.attr.test(of(e))) return true;
    let n = 0;
    for (const d of e.querySelectorAll('[id], [class], [aria-label]')) { if (++n > 60) break; if (RX.attr.test(of(d))) return true; }
    return false;
  };
  /** The layer `e` is a consent banner: why, or null. */
  const verdict = (e) => {
    if (e.querySelector('h1, main, nav, [role="main"], [role="navigation"]')) return null;
    if (e.getElementsByTagName('*').length > L.maxNodes) return null;
    const text = ownText(e);
    if (text.length > L.maxText) return null;
    const controls = controlsOf(e).map(labelOf).filter((t) => t && t.length <= 48);
    const choice = controls.some((t) => RX.control.test(t));
    const said = RX.consent.test(text) && (RX.context.test(text) || choice);
    if (said) return { why: 'words', text };
    if (choice && attrHit(e) && (RX.consent.test(text) || controls.some((t) => RX.consent.test(t) || RX.reject.test(t)))) return { why: 'names', text };
    return null;
  };
  const cmpOf = (e) => { for (const [name, sel] of cfg.cmp) { try { if (e.matches(sel)) return name; } catch (x) { /* a selector this engine does not know */ } } return null; };
  const record = (e, why, text, cmp) => {
    if (st.hidden.length >= L.maxRecords) return;
    let r = null; try { r = e.getBoundingClientRect(); } catch (x) { /* detached */ }
    st.hidden.push({ sel: short(e), why, cmp, text: norm(text).slice(0, 160), at: t0(), box: r ? [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] : null, view: [innerWidth, innerHeight] });
  };
  const hide = (e, why, text, cmp) => {
    if (e.closest(`[${MARK}]`)) return false;
    record(e, why, text, cmp); // the box it would have had: read before the mark (a layout, no frame is drawn in between)
    e.setAttribute(MARK, 'consent');
    return true;
  };
  /** From any element of a possible banner: the outermost fixed layer around it that is a banner, hidden. */
  const judge = (el) => {
    if (!el || el.nodeType !== 1 || el === document.body || el === document.documentElement) return false;
    if (el.closest && el.closest(`[${MARK}]`)) return false;
    const chain = [];
    for (let a = el, d = 0; a && a.nodeType === 1 && a !== document.body && a !== document.documentElement && d < 40; a = parentOf(a), d++) if (isFixed(a)) chain.push(a);
    for (let i = chain.length - 1; i >= 0; i--) { const v = verdict(chain[i]); if (v) return hide(chain[i], v.why, v.text, cmpOf(chain[i])); }
    return false;
  };
  const CANDIDATES = '[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog, [id*="cookie" i], [class*="cookie" i], [id*="consent" i], [class*="consent" i], [id*="gdpr" i], [class*="gdpr" i], [aria-label*="cookie" i], [aria-label*="consent" i]';
  const XP = "descendant-or-self::text()[contains(translate(., 'COKIENST', 'cokienst'), 'cookie') or contains(translate(., 'COKIENST', 'cokienst'), 'consent')]";
  const textHits = (root) => {
    const out = [];
    try {
      const it = document.evaluate(XP, root, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      for (let i = 0; i < Math.min(it.snapshotLength, 60); i++) { const p = it.snapshotItem(i).parentElement; if (p) out.push(p); }
    } catch (e) { st.errors++; }
    return out;
  };
  const scan = (root) => {
    if (!root || root.nodeType !== 1) return;
    judge(root);
    try { for (const e of [...root.querySelectorAll(CANDIDATES)].slice(0, 60)) judge(e); } catch (e) { st.errors++; }
    for (const e of textHits(root)) judge(e);
  };
  const known = () => {
    for (const [name, sel] of cfg.cmp) {
      let list; try { list = document.querySelectorAll(sel); } catch (e) { continue; }
      for (const e of list) if (!e.closest(`[${MARK}]`)) hide(e, 'platform', ownText(e).slice(0, 400), name);
    }
  };
  // ---- what a banner does to the rest of the page while it is up: a scroll lock on html / body, a page made inert or
  // pointer-dead, a dimming backdrop beside it. Hiding the banner alone would leave those, and the capture would miss what they
  // block (scroll-driven motion, hovers, clicks). Each is undone only while it is the banner's: it was not there before any banner
  // was hidden (or it names cookies / consent), and no other layer of the page covers the screen (an open menu or a preloader
  // locks scroll on its own, and that stays).
  const UNLOCK = 'data-reva-unlocked';
  st.unlocked = [];
  const unlockSheet = (() => { try { const x = new CSSStyleSheet(); document.adoptedStyleSheets = [...document.adoptedStyleSheets, x]; return x; } catch (e) { st.errors++; return null; } })();
  const free = new Map(), early = new Set(), inertEarly = new Set(), told = new Set();
  const note = (what, kinds, by) => { const k = `${what}|${kinds.join(' ')}`; if (told.has(k) || st.unlocked.length >= L.maxRecords) return; told.add(k); st.unlocked.push({ what, kinds, by, at: t0() }); };
  /** The page's own values for html or body: read with our unlock taken off for the read (no frame is drawn in between). */
  const ownStyle = (el) => {
    const had = el.getAttribute(UNLOCK); if (had != null) el.removeAttribute(UNLOCK);
    const cs = getComputedStyle(el); const v = { overflowX: cs.overflowX, overflowY: cs.overflowY, position: cs.position, top: cs.top, pointerEvents: cs.pointerEvents };
    if (had != null) el.setAttribute(UNLOCK, had);
    return v;
  };
  /** Another shown layer of the page covers most of the screen (two of three probe points land in a big fixed layer). */
  const covered = () => {
    let n = 0;
    for (const [fx, fy] of [[0.5, 0.5], [0.25, 0.3], [0.75, 0.7]]) {
      let h = null; try { h = document.elementFromPoint(innerWidth * fx, innerHeight * fy); } catch (e) { h = null; }
      for (let a = h, d = 0; a && a.nodeType === 1 && a !== document.body && a !== document.documentElement && d < 40; a = parentOf(a), d++) {
        if (!isFixed(a)) continue;
        const r = a.getBoundingClientRect(); if (r.width * r.height >= 0.6 * innerWidth * innerHeight) { n++; break; }
      }
    }
    return n >= 2;
  };
  const rebuild = () => {
    if (!unlockSheet) return;
    const h = free.get(document.documentElement) || {}, b = free.get(document.body) || {};
    unlockSheet.replaceSync([
      `html[${UNLOCK}~="overflow"] { overflow-x: ${h.overflowX || 'visible'} !important; overflow-y: ${h.overflowY || 'visible'} !important; }`,
      `body[${UNLOCK}~="overflow"] { overflow-x: ${b.overflowX || 'visible'} !important; overflow-y: ${b.overflowY || 'visible'} !important; }`,
      `body[${UNLOCK}~="fixed"] { position: ${b.position || 'static'} !important; top: ${b.top || 'auto'} !important; }`,
      `[${UNLOCK}~="pointer"] { pointer-events: auto !important; }`,
    ].join('\n'));
  };
  const release = () => {
    const any = st.hidden.length > 0;
    let cover = null; const isCovered = () => (cover == null ? (cover = covered()) : cover);
    for (const el of [document.documentElement, document.body]) {
      if (!el) continue;
      const v = ownStyle(el), kinds = [];
      if (/hidden|clip/.test(v.overflowY)) kinds.push('overflow');
      if (el === document.body && v.position === 'fixed') kinds.push('fixed');
      if (v.pointerEvents === 'none') kinds.push('pointer');
      if (!kinds.length) { free.set(el, v); early.delete(el); if (el.hasAttribute(UNLOCK)) el.removeAttribute(UNLOCK); continue; }
      if (!any) { early.add(el); continue; }
      const named = RX.attr.test(`${typeof el.className === 'string' ? el.className : ''} ${el.id || ''}`);
      const want = (named || !early.has(el)) && !isCovered() ? kinds.join(' ') : null;
      if (want) { if (el.getAttribute(UNLOCK) !== want) { rebuild(); el.setAttribute(UNLOCK, want); } note(el.localName, kinds, named ? 'names' : 'after a banner'); }
      else if (el.hasAttribute(UNLOCK)) el.removeAttribute(UNLOCK);
    }
    // a page root made inert while the banner was up (a closed menu's inert is no page root and stays)
    for (const el of document.querySelectorAll('[inert]')) {
      if (el.closest(`[${MARK}]`)) continue;
      const root = el === document.body || el.parentElement === document.body || !!el.querySelector('main, h1, [role="main"]');
      if (!root) continue;
      if (!any) { inertEarly.add(el); continue; }
      if (inertEarly.has(el) || isCovered()) continue;
      el.removeAttribute('inert'); note(short(el), ['inert'], 'after a banner');
    }
  };
  /** A backdrop beside a hidden banner: fixed, near full screen, no words, no picture, catching the pointer. */
  const backdrops = (layer) => {
    const p = layer.parentElement; if (!p) return;
    for (const s of p.children) {
      if (s === layer || s.hasAttribute(MARK) || !isFixed(s)) continue;
      const r = s.getBoundingClientRect(); if (r.width * r.height < 0.9 * innerWidth * innerHeight) continue;
      const cs = getComputedStyle(s);
      if (cs.pointerEvents === 'none' || cs.backgroundImage !== 'none' || ownText(s).length || s.querySelector('img, video, canvas, svg, iframe, picture')) continue;
      record(s, 'backdrop', '', null); s.setAttribute(MARK, 'consent');
    }
  };
  st.sweep = () => {
    try {
      st.ensureSheet(); if (!document.body) return;
      known(); scan(document.body);
      for (const l of document.querySelectorAll(`[${MARK}="consent"]`)) if (!l.parentElement || !l.parentElement.closest(`[${MARK}]`)) backdrops(l);
      release();
    } catch (e) { st.errors++; }
  };
  /** Presses one clear reject button inside a hidden banner, once per document. Never anything else. */
  st.reject = () => {
    if (st.rejected.length) return null;
    for (const layer of document.querySelectorAll(`[${MARK}="consent"]`)) {
      const b = controlsOf(layer).find((c) => c.localName !== 'a' && RX.reject.test(labelOf(c)));
      if (!b) continue;
      st.rejected.push({ sel: short(layer), label: labelOf(b).slice(0, 60), at: t0() });
      try { b.click(); } catch (e) { st.errors++; }
      return st.rejected[st.rejected.length - 1];
    }
    return null;
  };
  const start = () => {
    new MutationObserver((list) => {
      for (const r of list) {
        if (r.type === 'childList') { for (const n of r.addedNodes) if (n.nodeType === 1) scan(n); }
        else if (r.target.nodeType === 1 && r.attributeName !== MARK) judge(r.target);
      }
    }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'hidden', 'open', 'aria-hidden', 'aria-modal', 'role'] });
    st.sweep();
    setInterval(st.sweep, L.sweepMs);
  };
  if (document.documentElement) start(); else document.addEventListener('readystatechange', start, { once: true });
  return st;
}

/** The init script: every document of a recording session gets it. */
export const CONSENT_HIDE_INIT = `(${consentHiderInPage.toString()})(${JSON.stringify({ cmp: CMP_HIDE, words: CONSENT_WORDS, limits: BANNER_LIMITS })});`;

/** Runs IN THE PAGE: what the hider did in this document so far (a copy). */
export function consentStateInPage() {
  const s = window.__REVA_CONSENT;
  if (!s) return null;
  try { s.sweep(); } catch (e) { /* the page broke the sweep: what was read stays */ }
  return { hidden: s.hidden.slice(), rejected: s.rejected.slice(), unlocked: (s.unlocked || []).slice(), errors: s.errors };
}

/** Runs IN THE PAGE: press a clear reject button inside a banner the hider took out. */
export function rejectHiddenInPage() {
  const s = window.__REVA_CONSENT;
  return s && s.reject ? s.reject() : null;
}

/** Merge reads of several documents / calls (node side): one entry per layer, the first time it was hidden kept. */
export function mergeConsent(into, read) {
  const out = into || { hidden: [], rejected: [], unlocked: [] };
  out.unlocked ||= [];
  if (!read) return out;
  const key = (x) => `${x.sel || x.what}|${x.text || x.label || (x.kinds || []).join(' ')}`;
  for (const k of ['hidden', 'rejected', 'unlocked']) {
    const have = new Set(out[k].map(key));
    for (const x of read[k] || []) if (!have.has(key(x)) && out[k].length < BANNER_LIMITS.maxRecords) { out[k].push(x); have.add(key(x)); }
  }
  return out;
}
