// Page changes (PLAN §2): one transition per pair of templates that differ, from a real click on a real link. A change that
// stays in the same document is the site's own transition. A plain new document is a load, the same on every pair, so one
// pair stands for the others. A change is never cut before frame 180 and runs on to 360 while anything moves (DESIGN 3.3): half of
// a 3D portfolio site's still moved at 180. Rows wait in the page, so whatever ran since the last drain would die with an old document.
import { urlKey } from './map.js';
import { recordUnit } from './moments.js';
import { keepMarks } from './patterns.js';
import { STOP } from './moves/contract.js';

const CONTROL_MS = 400;

/**
 * Which pairs: for each recorded page and each other template, one link from that page to a page of that template (its
 * recorded page when there is such a link). A template the page does not link to is no pair.
 * @param {{url:string, id:string, cluster:*, links:{href:string, sel:string}[]}[]} pages
 * @param {Map<string,*>} clusterOf  urlKey -> template
 * @returns {{from:string, to:string, href:string, sel:string, fromTemplate:*, toTemplate:*}[]}
 */
export function planChanges(pages, clusterOf) {
  const reps = new Map(pages.map((p) => [p.cluster, p.url]));
  const out = [];
  for (const a of pages) {
    const best = new Map();
    for (const l of a.links || []) {
      let k; try { k = urlKey(l.href); } catch { continue; }
      if (k === urlKey(a.url)) continue;
      const c = clusterOf.get(k);
      if (c == null || c === a.cluster) continue;
      const isRep = reps.get(c) && urlKey(reps.get(c)) === k;
      // a link that opens a new window shows no transition: it stands for its template only when no other link does
      const held = best.get(c);
      if (!held || (held.blank && !l.blank) || (isRep && !l.blank)) best.set(c, { href: l.href, sel: l.sel, blank: !!l.blank });
    }
    for (const [c, l] of best) out.push({ from: a.url, to: l.href, href: l.href, sel: l.sel, fromTemplate: a.cluster, toTemplate: c });
  }
  return out;
}

/** Can the pointer reach this element now? It is brought into view first. */
async function reachable(S, sel) {
  const at = await S.locate(sel);
  if (!at) return false;
  await S.hold(200);
  return S.evRetry((q) => { const e = document.querySelector(q); if (!e) return false; const r = e.getBoundingClientRect(); const t = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return r.width > 0 && !!t && (e === t || e.contains(t) || t.contains(e)); }, sel);
}

/**
 * The frames after the press. Rows are drained every frame until the document goes, so an exit animation before a real navigation
 * survives; a same-document change stays drained to its end. Past STOP.changeMin the change ends at 2 s quiet.
 * @returns {Promise<number>} the frames run
 */
export async function changeFrames(S, shot) {
  await S.drain();   // the frames of the press itself, while their document stands
  let here = await S.evRetry(() => window.__REVA_DOC === 1);
  for (let i = 1; i <= STOP.changeMax; i++) {
    await S.step(1);
    if (here) { await S.drain(); here = await S.evRetry(() => window.__REVA_DOC === 1); }
    const m = await shot('change', { quiet: i >= STOP.changeMin ? STOP.lateQuiet : 0 });
    if (m.quiet) return i;
  }
  return STOP.changeMax;
}

/** One change: at rest on the page, press the link, picture what moves for 3 to 6 s. */
export async function recordChange({ change, name, ...o }) {
  return recordUnit({ ...o, name }, async ({ S, ready, shot, result }) => {
    await ready();
    await S.evRetry(() => { window.__REVA_DOC = 1; });
    if (await S.evRetry((q) => document.querySelector(q)?.closest('a[href]')?.target === '_blank', change.sel)) { result.newWindow = true; return; }
    // a link in a closed menu: open the menu first, as a person would
    let open = await reachable(S, change.sel);
    for (const op of (open ? [] : change.openers || []).slice(0, 2)) {
      await S.click({ target: op, hoverMs: 100 });
      await S.hold(1500);
      open = await reachable(S, change.sel);
      if (open) { result.via = op; break; }
      await S.click({ target: op, hoverMs: 100 }).catch(() => {});
      await S.hold(1000);
    }
    if (!open) { result.gone = true; return; }
    // what moves with nothing touched neither holds the change open nor asks for pictures
    await S.controlStart(); await S.hold(CONTROL_MS); await S.controlStop();
    await S.mark('change');
    await S.partStart();
    await S.drain();
    await S.click({ target: change.sel, hoverMs: 250 });
    const frames = await changeFrames(S, shot);
    await S.mark('change-end');
    const after = await S.evRetry(() => ({ url: location.href, same: window.__REVA_DOC === 1 }));
    if (!after.same) await keepMarks(S);
    const arrived = (() => { try { return urlKey(after.url) === urlKey(change.href); } catch { return false; } })();
    result.change = { ...after, arrived, frames, kind: after.same ? 'same-document' : 'new-document' };
  });
}
