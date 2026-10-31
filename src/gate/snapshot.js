// Element-oracle snapshot (stage G, review F3 layer 1). One snapshot = every rendered element of the document,
// its open shadow roots and same-origin iframes, keyed by a structural path that ignores non-rendered tags
// (script/style/link/meta/...), so a rebuild that drops those still lines up element for element.
// Per element: box (document coordinates), own text, full computed style, computed style of ::before/::after/::marker
// when they exist, and (via CDP) the platform fonts actually used for its text.
// Values are interned (property table + value table) to keep a 2000-element page at a few MB.

/** In-page: build the snapshot. Runs via page.evaluate(inPageSnapshot, opts). Must be self-contained.
 *  asJson (S-SPEED #2b): return JSON.stringify(result) (one string over the protocol, parsed once in node) instead of
 *  the object tree Playwright serialises value by value; if stringify throws (a string over V8's length limit) the
 *  object is returned as before. Every value is a string, a finite number or an array/object of them, so JSON keeps it
 *  (the one in-memory difference, -0 read back as 0, is written as 0 on disk either way and compares equal). */
export function inPageSnapshot({ live = [], asJson = false } = {}) {
  const SKIP = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'TEMPLATE', 'BASE', 'TITLE', 'HEAD']);
  const pl = [], pIdx = new Map(), vt = [], vIdx = new Map();
  const P = p => { let i = pIdx.get(p); if (i === undefined) { i = pl.length; pl.push(p); pIdx.set(p, i); } return i; };
  const V = v => { let i = vIdx.get(v); if (i === undefined) { i = vt.length; vt.push(v); vIdx.set(v, i); } return i; };
  // Margins: getComputedStyle returns a layout-RESOLVED margin, which is not the used value when the element has no
  // fresh layout (measured on a real site: inside a `content-visibility: auto` section that is skipped, an auto margin
  // whose used value is 96px reads back as 0px, while an unskipped copy reads 96px; the boxes are identical).
  // Compare the computed keyword `auto` instead (Typed OM), and the used result through the element box, which the
  // oracle checks separately within BOX_TOL. Non-auto margins keep the resolved value (percentages resolve to px).
  const MARGINS = ['margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'margin-block-start', 'margin-block-end', 'margin-inline-start', 'margin-inline-end'];
  const autoMargins = el => { const s = new Set(); try { const m = el.computedStyleMap(); for (const p of MARGINS) { const v = m.get(p); if (v && v.toString() === 'auto') s.add(p); } } catch {} return s; };
  const flat = (cs, el) => { const auto = el ? autoMargins(el) : null; const out = []; for (let i = 0; i < cs.length; i++) { const p = cs[i]; out.push(P(p), V(auto && auto.has(p) ? 'auto' : cs.getPropertyValue(p))); } return out; };
  // whole-element computed styles are interned too (SVG-heavy pages repeat one style thousands of times): a 31k-element page
  // with ~820 properties each was 51M numbers in one protocol reply and blew the node heap (a large corpus capture)
  const st = [], stIdx = new Map();
  const S = flatArr => { const k = flatArr.join(','); let i = stIdx.get(k); if (i === undefined) { i = st.length; st.push(flatArr); stIdx.set(k, i); } return i; };
  const els = [], textEls = [];
  const sx = scrollX, sy = scrollY;
  function visit(el, key, frameOff, isLive) {
    const win = el.ownerDocument.defaultView;
    const live2 = isLive || live.some(s => { try { return el.matches(s); } catch { return false; } });
    const r = el.getBoundingClientRect();
    const own = [];
    for (const n of el.childNodes) if (n.nodeType === 3) own.push(n.nodeValue);
    // Whitespace collapses unless white-space preserves it, so text is compared as rendered, not as source.
    const ws = win.getComputedStyle(el).whiteSpaceCollapse || win.getComputedStyle(el).whiteSpace;
    const t = /preserve|pre|break-spaces/.test(ws) ? own.join('') : own.join('').replace(/\s+/g, ' ').trim();
    const rec = { k: key, b: [r.x + frameOff[0] + sx, r.y + frameOff[1] + sy, r.width, r.height].map(v => Math.round(v * 100) / 100), t, si: S(flat(win.getComputedStyle(el), el)) };
    const ps = {};
    for (const w of ['::before', '::after', '::marker']) {
      const c = win.getComputedStyle(el, w);
      if (w === '::marker' ? win.getComputedStyle(el).display !== 'list-item' : (c.content === 'none' || c.content === 'normal')) continue;
      ps[w] = flat(c);
    }
    if (Object.keys(ps).length) rec.ps = ps;
    if (live2) rec.live = 1;
    els.push(rec);
    if (t.trim()) { rec.ti = textEls.length; textEls.push(el); }
    if (el.shadowRoot) kids(el.shadowRoot, key + '#s', frameOff, live2);
    if (el.tagName === 'IFRAME') {
      let d = null; try { d = el.contentDocument; } catch {}
      if (d && d.documentElement) {
        const cs = win.getComputedStyle(el);
        const off = [frameOff[0] + r.x + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft), frameOff[1] + r.y + parseFloat(cs.borderTopWidth) + parseFloat(cs.paddingTop)];
        visit(d.documentElement, key + '#f/html', off, live2);
      }
    }
    kids(el, key, frameOff, live2);
  }
  function kids(parent, key, frameOff, isLive) {
    const n = {};
    for (const c of parent.children) {
      if (SKIP.has(c.tagName.toUpperCase())) continue;
      const tag = c.localName;
      n[tag] = (n[tag] || 0) + 1;
      visit(c, `${key}/${tag}[${n[tag]}]`, frameOff, isLive);
    }
  }
  visit(document.documentElement, 'html', [0, 0], false);
  window.__wrTextEls = textEls;
  const res = { url: location.href, vw: innerWidth, vh: innerHeight, docH: document.documentElement.scrollHeight, pl, vt, st, els };
  if (asJson) { try { return JSON.stringify(res); } catch {} }
  return res;
}

/** S-SPEED switches, read per call (tests flip them): REVA_SNAPSHOT_JSONSTR=0 / REVA_FONT_BATCH=0 give the old paths. */
const jsonSnapshots = () => process.env.REVA_SNAPSHOT_JSONSTR !== '0';
const fontBatches = () => process.env.REVA_FONT_BATCH !== '0';
/** Node side of inPageSnapshot's return: a JSON string is parsed once, an object (asJson off, or its fallback) is as is. */
export const snapshotValue = raw => (typeof raw === 'string' ? JSON.parse(raw) : raw);

/** Snapshot <-> interned form. In memory every element has `s` (its flat style list); identical styles share ONE array. On
 *  disk and over the protocol the lists live once in `st` and elements carry `si`. Old files (no `st`) are read as they are. */
export function expandStyles(snap) {
  if (!snap || !snap.st) return snap;
  const st = snap.st;
  for (const e of snap.els) if (e.si !== undefined) { e.s = st[e.si]; delete e.si; }
  delete snap.st;
  return snap;
}
export function internStyles(snap) {
  if (!snap || !Array.isArray(snap.els) || !snap.pl || !snap.vt || snap.st) return snap;
  const ids = new Map(), st = [];
  const els = snap.els.map(e => {
    if (!Array.isArray(e.s)) return e;
    let i = ids.get(e.s); // identity first (arrays shared by expandStyles), content second
    if (i === undefined) { const key = e.s.join(','); i = ids.get(key); if (i === undefined) { i = st.length; st.push(e.s); ids.set(key, i); } ids.set(e.s, i); }
    const { s, ...rest } = e; void s; return { ...rest, si: i };
  });
  return { ...snap, st, els };
}

/** Platform fonts actually used per text element (catches a font that computed font-family hides). */
export async function platformFontsFor(page, count) {
  if (!count) return [];
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
    // depth 0: the agent only needs a document root; DOM.requestNode below pushes the path to each node itself. depth -1 + pierce
    // serialised the WHOLE DOM (shadow roots, iframes) into one protocol reply per session: V8 heap OOM (4 GB) on a large page (a large corpus capture)
    await cdp.send('DOM.getDocument', { depth: 0 });
    const { result } = await cdp.send('Runtime.evaluate', { expression: 'window.__wrTextEls' });
    const { result: props } = await cdp.send('Runtime.getProperties', { objectId: result.objectId, ownProperties: true });
    const out = new Array(count).fill('');
    const fmt = fonts => fonts.map(f => `${f.familyName}${f.isCustomFont ? '*' : ''}:${f.glyphCount}`).sort().join('|');
    if (fontBatches()) {
      // S-SPEED #2a: the same calls as below, sent as two pipelined batches (every DOM.requestNode in element order, then
      // every CSS.getPlatformFontsForNode in element order) instead of two awaited round trips per text element. The page
      // does not change in between (paused clock, settled, nothing else drives it); a failed call gives the same `?<error>`.
      const items = [];
      for (const p of props) { const i = Number(p.name); if (Number.isInteger(i) && p.value?.objectId) items.push({ i, objectId: p.value.objectId }); }
      const settle = pr => pr.then(v => ({ v }), e => ({ e }));
      const nodes = await Promise.all(items.map(x => settle(cdp.send('DOM.requestNode', { objectId: x.objectId }))));
      const fonts = await Promise.all(items.map((x, j) => (nodes[j].e ? null : settle(cdp.send('CSS.getPlatformFontsForNode', { nodeId: nodes[j].v.nodeId })))));
      items.forEach((x, j) => {
        const r = nodes[j].e ? nodes[j] : fonts[j];
        try { if (r.e) throw r.e; out[x.i] = fmt(r.v.fonts); } catch (e) { out[x.i] = `?${e.message.slice(0, 40)}`; }
      });
    } else for (const p of props) {
      const i = Number(p.name);
      if (!Number.isInteger(i) || !p.value?.objectId) continue;
      try {
        const { nodeId } = await cdp.send('DOM.requestNode', { objectId: p.value.objectId });
        const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
        out[i] = fmt(fonts);
      } catch (e) { out[i] = `?${e.message.slice(0, 40)}`; }
    }
    await cdp.send('Runtime.evaluate', { expression: 'delete window.__wrTextEls' });
    return out;
  } finally { await cdp.detach().catch(() => {}); }
}

/** Determinism (review F3): scroll to top, finish every finite CSS/WAAPI animation and transition (rest state),
 *  rewind and pause infinite ones; same frames (shadow roots + same-origin iframes included via getAnimations). */
export function settleAnimations() {
  scrollTo({ left: 0, top: 0, behavior: 'instant' });
  const docs = [document];
  for (const f of document.querySelectorAll('iframe')) { try { if (f.contentDocument) docs.push(f.contentDocument); } catch {} }
  let n = 0;
  for (const d of docs) for (const a of d.getAnimations ? d.getAnimations() : []) {
    try { a.finish(); } catch { try { a.pause(); a.currentTime = 0; } catch {} }
    n++;
  }
  return n;
}

/** In-page: pause every <video>/<audio> (document + same-origin iframes) and seek it to 0; resolves when the seeks
 *  are done (real-timer cap 1 s each). Returns the number of media elements. */
export function freezeMedia() {
  const R = window.__wrReal || { st: setTimeout };
  const docs = [document];
  for (const f of document.querySelectorAll('iframe')) { try { if (f.contentDocument) docs.push(f.contentDocument); } catch {} }
  const waits = []; let n = 0;
  for (const d of docs) for (const m of d.querySelectorAll('video, audio')) {
    n++;
    try {
      if (!m.paused) m.pause();
      if (m.readyState > 0 && m.currentTime !== 0) { waits.push(new Promise(r => { m.addEventListener('seeked', r, { once: true }); R.st(r, 1000); })); m.currentTime = 0; }
    } catch {}
  }
  return Promise.all(waits).then(() => n);
}

/** Snapshot the page as it is now (caller has sized the viewport and settled it). */
export async function takeSnapshot(page, { live = [], fonts = true } = {}) {
  await page.evaluate(freezeMedia);
  await page.evaluate(settleAnimations);
  const snap = expandStyles(snapshotValue(await page.evaluate(inPageSnapshot, jsonSnapshots() ? { live, asJson: true } : { live })));
  const n = snap.els.filter(e => e.ti !== undefined).length;
  const f = fonts ? await platformFontsFor(page, n) : [];
  for (const e of snap.els) if (e.ti !== undefined) { e.f = f[e.ti] ?? ''; delete e.ti; }
  return snap;
}

/** Decode an interned flat [p, v, p, v ...] list into a Map(prop -> value). */
export function decodeStyle(snap, flat) {
  const m = new Map();
  for (let i = 0; i < flat.length; i += 2) m.set(snap.pl[flat[i]], snap.vt[flat[i + 1]]);
  return m;
}
