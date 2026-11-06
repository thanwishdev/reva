// Interactive patterns (PLAN §2, DESIGN 3.3, 3.4): hover, focus and press per pattern, on the virtual clock. The first member of a
// pattern gets the full test with pictures of what moved, the second a short one at the picture floor, and every part ends when the
// page has gone still (W.quiet), so a repeat costs little and a hover that runs on is seen to its end. What a member did is read from
// the take afterwards: the channels that changed in the element and inside it, minus what moved in a control window with no pointer.
// Members that react differently split the pattern. The press never fires a click: a one-shot listener in front of the page swallows
// it, so a link stays a link and a form stays unsent (the click itself is an open state or a page change).
import { loadTake } from '../record/take.js';
import { recordUnit, leftPage } from './moments.js';
import { LISTENER_INIT, stateInPage, stateDiffers, noisyCells, clickVerdict } from './inventory.js';
import { STOP, APPROACH, ARRIVE, SHOTS } from './moves/contract.js';

const CONTROL_MS = 400, LATE_MS = 1500;
/** What the free side of an approach must not land on: a neighbour that would answer in this test. */
const LIVE = 'a[href],button,[role=button],[role=link],[role=tab],[role=menuitem],summary,input,select,textarea,label';

/** The tests of a page's patterns. */
export function planTests(patterns, { members = 2, modes }) {
  const out = [];
  for (const p of patterns) {
    const list = p.members.slice(0, 40); // a spread already; members 0, then the far end, then the middle
    const order = list.length <= 1 ? list : [list[0], list[list.length - 1], ...list.slice(1, -1)];
    for (const [i, m] of order.slice(0, members).entries()) out.push({ id: `${p.id}#${i}`, pattern: p.id, member: i, sel: m.sel, focusable: p.focusable, modes, text: m.text });
  }
  return out;
}

const hitOf = ([q, x, y]) => {
  const e = document.querySelector(q); if (!e) return { gone: true };
  const t = document.elementFromPoint(x, y);
  const sub = [e, ...e.querySelectorAll('*')].slice(0, 400);
  return { hit: !!t && (e === t || e.contains(t) || t.contains(e)), ids: sub.map((d) => window.__WR.idOf(d)) };
};
const armClickGuard = () => { window.__REVA_GUARD = (ev) => { ev.preventDefault(); ev.stopImmediatePropagation(); }; window.addEventListener('click', window.__REVA_GUARD, { capture: true, once: true }); };
const dropClickGuard = () => { window.removeEventListener('click', window.__REVA_GUARD, { capture: true }); };

/**
 * How much of a test a member gets (DESIGN 3.3). The first member is the clip a person watches. The second proves the pattern alike:
 * hover and press decide that (0 of 94 pairs differed only in focus, 4 of 11 splits only in press), at the picture floor, with no
 * approach. Members run after a split are full again, capped at 30 pictures a second. Everything inside an open state stays at the floor.
 */
export function memberPlan(t) {
  const second = t.member === 1;
  return { focus: !second, approach: !second, pictures: second || t.inside ? 'floor' : t.member > 1 ? 'cap' : 'gate' };
}

/** The four points 40 px outside a box, in the order they are tried; only those inside the viewport can be stood on. */
export function approachSides([x, y, w, h], to, { width, height }, out = APPROACH.outsidePx) {
  return [['left', x - out, to.y], ['top', to.x, y - out], ['right', x + w + out, to.y], ['bottom', to.x, y + h + out]].filter(([, px, py]) => px >= 0 && py >= 0 && px < width && py < height);
}

/**
 * The pointer's way in: `steps` moves from the free side to the centre, or from just inside the left edge when no side is free. A jump
 * to the centre gives a magnetic button no pull. `enter` is how many moves after the first the pointer is inside the box: a reaction's
 * lag counts from there, not from the mark, which stands at the first move so that a pull before the edge stays in the hover window.
 */
export function approachPath([x, y, w, h], to, side, { width, height }, { outsidePx: out, insidePx: inn, steps } = APPROACH) {
  const from = { left: [x - out, to.y], top: [to.x, y - out], right: [x + w + out, to.y], bottom: [to.x, y + h + out] }[side] ?? [Math.min(Math.max(1, x + inn), width - 2), to.y];
  const pts = Array.from({ length: steps }, (_, i) => { const f = i / (steps - 1); return [Math.round(from[0] + (to.x - from[0]) * f), Math.round(from[1] + (to.y - from[1]) * f)]; });
  const enter = pts.findIndex(([px, py]) => px >= x && px <= x + w && py >= y && py <= y + h);
  return { pts, enter: Math.max(0, enter), side: side ?? null };
}

const boxOf = (q) => { const e = document.querySelector(q); if (!e) return null; const r = e.getBoundingClientRect(); return { box: [r.x, r.y, r.width, r.height], view: { width: innerWidth, height: innerHeight } }; };
const freeSide = ([spots, live]) => spots.find(([, x, y]) => !document.elementFromPoint(x, y)?.closest(live))?.[0] ?? null;

/** A member's way in, read from the page as it stands now; a target that left gives the plain jump. */
async function pathTo(S, sel, to) {
  const at = await S.evRetry(boxOf, sel);
  if (!at) return null;
  return approachPath(at.box, to, await S.evRetry(freeSide, [approachSides(at.box, to, at.view), LIVE]), at.view);
}

/** One member: control, focus, hover, press, leave. Marks name each part; pictures go to phases of the same name. */
export async function testMember(S, t, { phaseFrames, shot }) {
  const c = await S.locate(t.sel);
  if (!c) return { ...t, gone: true };
  if (c.scrolled) await S.hold(300);
  const now = await S.evRetry(([q, i]) => { const el = document.querySelector(q); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; }, [t.sel, 0]);
  if (!now) return { ...t, gone: true };
  const h = await S.evRetry(hitOf, [t.sel, now.x, now.y]);
  if (h.gone) return { ...t, gone: true };
  if (!h.hit) return { ...t, covered: true };
  const { focus, approach, pictures } = memberPlan(t);
  const stopped = {}, tested = [];
  const sPre = await S.evRetry(stateInPage);
  await S.mark(`${t.id}:control`);
  await S.controlStart(); await S.hold(CONTROL_MS); await S.controlStop();
  const s0 = await S.evRetry(stateInPage);
  const ignore = noisyCells(sPre, s0);
  if (focus && t.modes.includes('focus') && t.focusable) {
    tested.push('focus');
    const [on, off] = STOP.focusFrames, quiet = STOP.quiet.focus;
    await S.cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 });
    await S.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 });
    await S.mark(`${t.id}:focus`);
    await S.partStart();
    await S.evRetry((q) => document.querySelector(q)?.focus({ preventScroll: true }), t.sel);
    stopped.focus = await phaseFrames(`${t.id}:focus`, on, { pictures, quiet });
    await S.partStart();
    await S.evRetry(() => document.activeElement?.blur?.());
    stopped.blur = await phaseFrames(`${t.id}:focus`, off, { pictures, quiet });
  }
  let s1 = null;
  if (t.modes.includes('hover')) {
    tested.push('hover');
    const phase = `${t.id}:hover`, path = approach ? await pathTo(S, t.sel, now) : null;
    await S.mark(phase, path ? { enter: path.enter, side: path.side } : undefined);
    await S.partStart();
    if (path) for (const [x, y] of path.pts) { await S.mouse('mouseMoved', x, y); await shot(phase, { pictures }); }
    else await S.mouse('mouseMoved', now.x, now.y);
    // the quiet count runs from the first move, so `min` keeps it from ending before the pointer has been at rest for as long
    stopped.hover = await phaseFrames(phase, STOP.hoverMax, { pictures, quiet: STOP.quiet.hover, min: STOP.quiet.hover });
    s1 = await S.evRetry(stateInPage);
  }
  if (!t.leaves) {
    tested.push('press');
    const [down, up] = STOP.pressFrames;
    await S.mark(`${t.id}:press`);
    await S.evRetry(armClickGuard);
    if (!t.modes.includes('hover')) await S.mouse('mouseMoved', now.x, now.y);
    await S.partStart();
    await S.mouse('mousePressed', now.x, now.y, { button: 'left', clickCount: 1, buttons: 1 });
    await phaseFrames(`${t.id}:press`, down, { pictures });   // never cut: a reaction to the release needs a release to react to
    await S.partStart();
    await S.mouse('mouseReleased', now.x, now.y, { button: 'left', clickCount: 1 });
    stopped.press = await phaseFrames(`${t.id}:press`, up, { pictures, quiet: STOP.quiet.release });
    await S.evRetry(dropClickGuard);
  }
  tested.push('out');
  await S.mark(`${t.id}:out`);
  await S.partStart();
  await S.mouse('mouseMoved', ...ARRIVE.park);
  stopped.out = await phaseFrames(`${t.id}:out`, STOP.outMax, { pictures, quiet: STOP.quiet.out });
  const s2 = await S.evRetry(stateInPage);
  await S.controlClear();
  await S.mark(`${t.id}:end`);
  const opened = s1 ? stateDiffers(s0, s1, { ignore }) : null;
  const stuck = stateDiffers(s0, s2, { ignore }).changed;
  return { ...t, ids: h.ids, covered: false, hoverOpens: !!opened?.changed && !stuck, opened, stuck, stopped, tested };
}

/**
 * The page keeps its marks only while its document lives, the Node side keeps them all. A take that ended on another document gets
 * them back, in the order they were made: the frame numbers restart there, and the take view reads that drop as the new document.
 */
export const keepMarks = (S) => S.evRetry((list) => { const W = window.__WR; W.marks.length = 0; for (const m of list) W.marks.push(m); }, S.marks);

/** A press took the page away (a site can route on the release, past the click guard). The take stops here. */
export class PageLeft extends Error {
  constructor(url, test) { super(`the page left for ${url}`); this.left = url; this.test = test; }
}

/** Record the tests of one page and viewport as one take. Tests whose element is gone or covered say so in `tests`. */
export async function recordPatterns({ tests, name = 'patterns', at = {}, ...o }) {
  return recordUnit({ ...o, name, init: LISTENER_INIT, dropLeft: true }, async ({ S, ready, phaseFrames, shot, result }) => {
    await ready();
    await S.evRetry(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await S.hold(400);
    const from = await S.evRetry(() => location.href);
    // a route can start seconds after the press, once the site's own cover has drawn: it is blamed on the press, not on the test running then
    let pressed = null;
    const check = async () => { const to = await leftPage(S, from); if (to) throw new PageLeft(to, pressed); };
    result.tests = [];
    for (const t of tests) {
      at.test = t;
      await check();
      try {
        const r = await testMember(S, t, { phaseFrames, shot });
        result.tests.push(r);
        if (!t.leaves && r.ids) pressed = t;
      } catch (e) { if (S.deadError) throw e; result.tests.push({ ...t, error: String(e.message).split('\n')[0].slice(0, 200) }); }
    }
    if (pressed) { await S.hold(LATE_MS); await check(); }
  });
}

const SKIP_CH = /^ren:(bx|by)$/;
const base = (c) => c.replace(/\.[a-z0-9]+$/, '');

/**
 * Read back what each member did, from the take, without decoding it into memory: a decoded row shares every element that
 * did not change, so identity says what did. Adds `reacted: {control, focus, hover, press, out}` (channel lists) to each test.
 */
export function readReactions(takeDir, tests) {
  const { take } = loadTake(takeDir);
  const marks = (take.marks || []).filter((m) => m.name.includes(':'));
  const wins = []; // [T from, T to, test, part]
  const live = tests.filter((t) => t.ids?.length);
  const byId = new Map(live.map((t) => [t.id, t]));
  for (let i = 0; i < marks.length; i++) {
    const m = marks[i], at = m.name.lastIndexOf(':'), id = m.name.slice(0, at), part = m.name.slice(at + 1), t = byId.get(id);
    if (!t || part === 'end') continue;
    wins.push({ from: m.T, to: marks[i + 1]?.T ?? Infinity, part, t, ids: new Set(t.ids), seen: new Set() });
  }
  wins.sort((a, b) => a.from - b.from);
  let w = 0, prev = null;
  const pick = (row) => {
    const T = row.T;
    while (w < wins.length && T >= wins[w].to) w++;
    const win = wins[w];
    if (win && prev && T >= win.from && row.v && prev.v) {
      for (const id of win.ids) {
        const a = row.v[id], b = prev.v[id];
        if (!a || !b || a === b) continue;
        for (const k of Object.keys(a)) { const x = a[k], y = b[k]; if (x !== y && typeof x === 'number' && typeof y === 'number' && Math.abs(x - y) > 1e-6 && !SKIP_CH.test(k)) win.seen.add(k); }
      }
    }
    prev = row;
    return 0;
  };
  loadTake(takeDir, ['rows'], { rows: pick });
  for (const t of live) t.reacted = {};
  for (const x of wins) x.t.reacted[x.part] = [...new Set([...x.seen].map(base))].sort();
  for (const t of live) {
    const ctl = new Set(t.reacted.control || []);
    t.signature = JSON.stringify({ hover: (t.reacted.hover || []).filter((c) => !ctl.has(c)), press: (t.reacted.press || []).filter((c) => !ctl.has(c)) });
    t.reacts = t.signature !== '{"hover":[],"press":[]}' || (t.reacted.focus || []).some((c) => !ctl.has(c));
  }
  return tests;
}

/**
 * Patterns after their tests: alike members stay one pattern, members that differ split it.
 * @returns {{pattern:string, n:number, tested:number, split:boolean, groups:{signature:string, members:object[]}[], covered:boolean, gone:boolean}[]}
 */
export function judgePatterns(patterns, tests) {
  return patterns.map((p) => {
    const own = tests.filter((t) => t.pattern === p.id);
    const usable = own.filter((t) => t.signature != null && !t.covered);
    const groups = new Map();
    for (const t of usable) { if (!groups.has(t.signature)) groups.set(t.signature, []); groups.get(t.signature).push(t); }
    return { pattern: p.id, n: p.n, tested: usable.length, split: groups.size > 1, groups: [...groups].map(([signature, members]) => ({ signature, members })), covered: !usable.length && own.some((t) => t.covered), gone: !usable.length && own.every((t) => t.gone || t.error), hoverOpens: own.some((t) => t.hoverOpens), own };
  });
}

/** What pictures the phases of some tests got, for a row to say the rate where it fell (DESIGN 3.5). */
export function picturesOf(frames, ids) {
  const own = (frames?.phases || []).filter((p) => ids.some((id) => p.name.startsWith(`${id}:`)));
  if (!own.length) return null;
  return { shots: own.reduce((n, p) => n + (p.shots ?? 0), 0), frames: own.reduce((n, p) => n + p.to - p.from, 0), floor: SHOTS.floor };
}

/** The ledger rows of a page and viewport's patterns and open states. */
export function touchRows(ledger, { page, viewport, prefix, slot }) {
  const take = (n) => `${prefix}takes/${viewport}/${n}`, frames = (n) => `${prefix}frames/${viewport}/${n}`;
  const summary = (unit, reason, evidence) => ledger.add({ unit, page, viewport, id: 'all', status: 'captured', reason, evidence });
  if (!slot.survey?.ok) {
    for (const u of ['pattern', 'open-state']) ledger.add({ unit: u, page, viewport, id: 'all', status: 'failed', reason: `the survey of the page failed: ${slot.survey?.error ?? 'it did not run'}` });
    return;
  }
  const fresh = slot.fresh || [];
  const tests = [...(slot.patterns?.tests || []), ...(slot.patterns2?.tests || [])];
  const opensBy = new Map((slot.opens?.tests || []).map((t) => [t.pattern, t]));
  tests.push(...(slot.opens?.tests || []).flatMap((t) => t.insideTests || []));
  const judged = judgePatterns(fresh, tests);
  let splits = 0, reacting = 0;
  for (const j of judged) {
    const p = fresh.find((x) => x.id === j.pattern);
    const o = opensBy.get(p.id);
    const click = o?.skipped ?? (o?.lost ? `the page died on this click: ${o.error}` : o?.over ? 'not tested: over the budget of click tests' : o?.opened ? 'opens something: see its open-state row' : o?.navigated ? `it left the page for ${o.navigated}` : o?.error ?? (o?.gone ? 'gone before the click' : o ? 'no lasting change' : null));
    const stopped = Object.fromEntries(j.own.filter((t) => t.stopped).map((t) => [t.id, t.stopped]));
    const pictures = picturesOf(slot.patterns?.frames, j.own.map((t) => t.id)) ?? picturesOf(slot.patterns2?.frames, j.own.map((t) => t.id));
    const base = { unit: 'pattern', page: p.id ? page : page, viewport, pictures, evidence: { take: take('patterns'), frames: frames('patterns'), kind: p.kind, members: p.n, tested: j.tested, click, text: p.members[0].text, sample: p.members[0].sel, stopped } };
    if (!slot.patterns?.ok) { ledger.add({ ...base, id: p.id, status: 'failed', reason: `the patterns take failed: ${slot.patterns?.error ?? 'it did not run'}`, evidence: null }); continue; }
    if (!j.tested) {
      const died = j.own.find((t) => t.error);
      if (died) { ledger.add({ ...base, id: p.id, status: 'failed', reason: `its test failed: ${died.error}` }); continue; }
      const reason = j.covered ? 'something else lies over it when the pointer reaches it' : j.gone ? 'the element was gone when its test came' : 'not tested';
      ledger.add({ ...base, id: p.id, status: 'not-reached', reason }); continue;
    }
    if (j.groups.some((g) => g.signature !== EMPTY)) reacting++;
    if (j.split) {
      splits++;
      for (const [i, g] of j.groups.entries()) ledger.add({ ...base, id: i ? `${p.id}/split-${i}` : p.id, status: 'captured', reason: `${j.tested} of ${p.n} members tested: they do not all react alike, ${j.groups.length} kinds kept apart`, evidence: { ...base.evidence, reaction: JSON.parse(g.signature), tested: g.members.length, phases: g.members.map((t) => t.id) } });
    } else ledger.add({ ...base, id: p.id, status: 'captured', reason: [j.tested < 2 && p.n > 1 ? 'one member could be tested' : null, j.own.some((t) => t.leaves) ? 'pressing it leaves the page, so the press is its page change, not recorded here' : null].filter(Boolean).join('; ') || null, evidence: { ...base.evidence, reaction: JSON.parse(j.groups[0].signature), phases: j.groups[0].members.map((t) => t.id) } });
    // a second member that answered alike was recorded and proved the same, on what it was tested for
    if (!j.split) for (const t of j.groups[0].members.slice(1)) ledger.add({ unit: 'pattern', page, viewport, id: t.id, status: 'duplicate-of', duplicateOf: j.groups[0].members[0].id, proof: 'recorded', reason: 'a second place of this pattern answered alike', tested: t.tested ?? ['hover', 'press', 'out'], evidence: { take: take('patterns'), phases: [t.id], stopped: t.stopped ?? null } });
    if (j.hoverOpens) ledger.add({ unit: 'open-state', page, viewport, id: `${p.id}/hover`, status: 'captured', reason: 'opened by the pointer resting on it, shut when it left', evidence: { take: take('patterns'), frames: frames('patterns'), phases: j.own.filter((t) => t.hoverOpens).map((t) => `${t.id}:hover`) } });
  }
  for (const p of slot.dups || []) { const d = slot.dupOf(p); ledger.add({ unit: 'pattern', page, viewport, id: p.id, status: 'duplicate-of', duplicateOf: `${d.page} ${d.id}`, proof: 'signature', reason: 'the same pattern was tested on an earlier page', evidence: { members: p.n } }); }
  summary('pattern', `${slot.survey.inv.interactive} interactive elements, ${fresh.length + (slot.dups?.length || 0)} patterns, ${slot.dups?.length || 0} seen on an earlier page, ${reacting} react, ${splits} split`, { css: slot.survey.inv.css, take: take('patterns') });
  if (!slot.opens) { summary('open-state', 'no pattern on this page needs a click test', { tests: 0 }); return; }
  if (!slot.opens.ok) { ledger.add({ unit: 'open-state', page, viewport, id: 'all', status: 'failed', reason: `the click tests failed: ${slot.opens.error}` }); return; }
  const list = slot.opens.tests;
  let opened = 0;
  for (const t of list) {
    if (t.over) { ledger.add({ unit: 'open-state', page, viewport, id: t.pattern, status: 'not-reached', reason: 'over the budget of click tests for this page' }); continue; }
    if (t.lost) { ledger.add({ unit: 'open-state', page, viewport, id: t.pattern, status: 'failed', reason: `the page died on this click: ${t.error}` }); continue; }
    if (!t.opened) continue;
    opened++;
    const pictures = picturesOf(slot.opens.takes?.find((u) => u.take === t.take)?.frames, [t.id]);
    ledger.add({ unit: 'open-state', page, viewport, id: t.pattern, status: 'captured', pictures, reason: t.closedBy ? `opened by a click, closed by ${t.closedBy}` : 'opened by a click; REVA found no way to close it, so it was recorded open and the next test started from a fresh load', evidence: { take: take(t.take), frames: frames(t.take), phases: [`${t.id}:open`, `${t.id}:close`], stopped: t.stopped ?? null, text: t.text, inside: (t.inside || []).map(({ sel, ...x }) => x), closedBy: t.closedBy, diff: { cells: t.diff.cells, view: t.diff.view, shown: t.diff.shown } } });
    for (const q of t.inside || []) if (clickVerdict({ kind: q.kind, members: [{ text: q.text }] }).ok) ledger.add({ unit: 'open-state', page, viewport, id: `${t.pattern}/${q.id}`, status: 'not-reached', reason: 'depth 2: something inside an open state may open further; REVA records depth 1' });
  }
  summary('open-state', `${list.filter((t) => t.id).length} click tests, ${opened} opened something`, { tests: list.length, opened, takes: slot.opens.names });
}
const EMPTY = '{"hover":[],"press":[]}';
