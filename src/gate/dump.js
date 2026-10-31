// Baseline rebuild = R0's T6 primitive ("computed-style dump"), ported so the gate has a known subject:
// every element gets its full computed style inline, pseudo-elements become generated rules keyed by data-wr-k,
// @font-face rules are kept (absolute URLs), open shadow roots become declarative shadow DOM, same-origin iframes
// are serialised as their own documents (served at their original URL). No original stylesheet, inline <style>,
// style attribute or script survives. Expected by design (review F1): exact at the captured viewport, wrong elsewhere.

/** In-page serializer. Runs via page.evaluate(inPageDump). Must be self-contained. */
export function inPageDump() {
  const SKIP = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'TEMPLATE', 'BASE', 'TITLE']);
  const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
  const RAW = new Set(['textarea', 'pre', 'listing']);
  const escT = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const escA = s => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  // Longhands only: a shorthand listed by the computed style (e.g. text-decoration) would reset its longhands when
  // re-applied; app-region reads back as no-drag when set to none (engine quirk) and has no visual effect.
  const NOEMIT = new Set(['text-decoration', 'app-region']);
  // colours equal to `color` are written as currentcolor (the computed value hides the keyword; an explicit rgb()
  // would stop following `color` and changes the text-decoration shorthand).
  const CURRENT = new Set(['text-decoration-color', 'caret-color', '-webkit-text-fill-color', '-webkit-text-stroke-color', 'column-rule-color', 'outline-color', 'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color', 'text-emphasis-color', 'border-block-start-color', 'border-block-end-color', 'border-inline-start-color', 'border-inline-end-color']);
  // Layout snaps to 1/64 px but computed values serialise to ~4 decimals (95.828125 -> "95.8281px"), and re-applying the
  // shorter number truncates to the next lower 1/64 (95.8125): a sub-pixel shift the pixel check sees. Snap such numbers
  // back to the exact 1/64 value they came from.
  const snap64 = v => v.replace(/(-?\d*\.\d+)px/g, (m, n) => { const k = Number(n) * 64, r = Math.round(k); return Math.abs(k - r) < 0.02 ? `${r / 64}px` : m; });
  // transform: the computed matrix() is rounded to ~6 digits (a rotated/translated image resamples differently);
  // Typed OM keeps the computed transform functions at full precision.
  const tf = el => { try { const v = el && el.computedStyleMap ? el.computedStyleMap().get('transform') : null; return v ? v.toString() : null; } catch { return null; } };
  // auto margins: getComputedStyle returns the used length (0px for some flex/grid cases), which loses centring;
  // Typed OM reports the computed keyword.
  const MARGIN = new Set(['margin-top', 'margin-right', 'margin-bottom', 'margin-left']);
  const autoMargin = (el, p) => { try { const v = el.computedStyleMap().get(p); return v && v.toString() === 'auto'; } catch { return false; } };
  const css = (cs, el) => { let t = ''; const col = cs.getPropertyValue('color'); for (let i = 0; i < cs.length; i++) { const p = cs[i]; if (NOEMIT.has(p)) continue; const v = p === 'transform' && el ? (tf(el) || cs.getPropertyValue(p)) : el && MARGIN.has(p) && autoMargin(el, p) ? 'auto' : snap64(cs.getPropertyValue(p)); t += `${p}:${CURRENT.has(p) && v === col ? 'currentcolor' : v};`; } return t; };
  let kn = 0;
  const frames = {};
  function fontFaces(doc) {
    let out = '';
    for (const sh of doc.styleSheets) {
      let rules; try { rules = sh.cssRules; } catch { continue; }
      for (const r of rules) if (r.type === CSSRule.FONT_FACE_RULE) out += r.cssText.replace(/url\("?([^")]+)"?\)/g, (m, u) => `url("${new URL(u, sh.href || doc.baseURI).href}")`) + '\n';
    }
    return out;
  }
  // root: Document or ShadowRoot; rules collect pseudo-element rules for that scope.
  function ser(el, rules) {
    const win = el.ownerDocument.defaultView;
    const tag = el.localName;
    let attrs = '';
    // images: pin the candidate the original actually decoded at this viewport (currentSrc); srcset/sizes and
    // <picture><source> could pick another file in the rebuild
    const pinImg = tag === 'img' && el.currentSrc;
    for (const a of el.attributes) {
      if (a.name === 'style' || a.name.startsWith('on')) continue;
      if (pinImg && (a.name === 'src' || a.name === 'srcset' || a.name === 'sizes')) continue;
      if (tag === 'source' && el.parentElement && el.parentElement.localName === 'picture' && (a.name === 'srcset' || a.name === 'sizes')) continue;
      attrs += ` ${a.name}="${escA(a.value)}"`;
    }
    if (pinImg) attrs += ` src="${escA(el.currentSrc)}"`;
    if ((tag === 'input' || tag === 'option') && el.value !== undefined && !el.hasAttribute('value')) attrs += ` value="${escA(String(el.value))}"`;
    let pseudo = '';
    for (const w of ['::before', '::after', '::marker']) {
      const c = win.getComputedStyle(el, w);
      if (w === '::marker' ? win.getComputedStyle(el).display !== 'list-item' : (c.content === 'none' || c.content === 'normal')) continue;
      pseudo += `${w}{${css(c)}}`;
    }
    if (pseudo) { const k = ++kn; attrs += ` data-wr-k="${k}"`; rules.push(pseudo.replace(/(::[a-z]+)\{/g, `[data-wr-k="${k}"]$1{`)); }
    attrs += ` style="${escA(css(win.getComputedStyle(el), el))}"`;
    let inner = tag === 'html' && el === el.ownerDocument.documentElement ? '\u0000WRHEAD\u0000' : '';
    if (el.shadowRoot) {
      const sr = [];
      const body = kids(el.shadowRoot, sr);
      inner += `<template shadowrootmode="open">${sr.length ? `<style data-wr-gen>${sr.join('\n')}</style>` : ''}${body}</template>`;
    }
    if (tag === 'iframe') {
      let d = null; try { d = el.contentDocument; } catch {}
      if (d && d.documentElement && el.src) frames[new URL(el.getAttribute('src'), el.ownerDocument.baseURI).href] = doc(d);
    }
    if (VOID.has(tag)) return `<${tag}${attrs}>`;
    inner += RAW.has(tag) ? escT(el.textContent) : kids(el, rules);
    return `<${tag}${attrs}>${inner}</${tag}>`;
  }
  function kids(parent, rules) {
    let s = '';
    for (const n of parent.childNodes) {
      if (n.nodeType === 3) s += escT(n.nodeValue);
      else if (n.nodeType === 1 && !SKIP.has(n.tagName.toUpperCase())) {
        if (n.localName === 'head') continue;
        s += ser(n, rules);
      }
    }
    return s;
  }
  function doc(d) {
    const rules = [];
    const html = d.documentElement;
    const body = ser(html, rules); // serialises <html ...><body>...</body></html> (head skipped)
    // the viewport meta is layout input (mobile classes lay out at 980px without it), not style: keep it
    const vpm = d.querySelector('meta[name="viewport"]');
    const head = `<head><meta charset="utf-8">${vpm ? `<meta name="viewport" content="${escA(vpm.content)}">` : ''}<style data-wr-gen>${fontFaces(d)}${rules.join('\n')}</style></head>`;
    return '<!doctype html>' + body.replace('\u0000WRHEAD\u0000', () => head);
  }
  const html = doc(document);
  return { html, frames };
}

/** Dump the page as it is now. Returns {html, frames:{url:html}}. */
export async function computedDump(page) {
  await page.evaluate(() => scrollTo(0, 0));
  return page.evaluate(inPageDump);
}
