// Which run belongs to what (DESIGN 2.4 steps 5-8): the windows of a page, what reacted in them, and the moves of each occasion.
// Port of design-check/moves4.mjs, whose rules survived stored data. Every run gets exactly one bucket here, through `place`.
// Work is in two passes because a cursor found on one page is a cursor on every page of that viewport: readPage, then finishPage.
import { framesOf, MODEL, selectorGroup } from './contract.js';
import { ambientSet, isNoise, isOwn } from './ambient.js';
import { controlSets, clockKey, lagClocked, onsetClocked } from './clocked.js';
import { groupFollowers, outsideTests, pointerFollowers, sharedKeys, sweepFollows } from './shared.js';
import { partOf, windowsOf } from './takeview.js';

const BURST = framesOf(MODEL.burstGapMs);
const PRE_OPEN = MODEL.clickControlFrames;
const openedOf = (t) => t?.opened === true || !!t?.opened?.changed;
const hasOwnWindow = (w) => w.part === 'open' || w.part === 'close';

/** The first pass over one page and viewport: everything that needs no other page. */
export function readPage(P) {
  const place = (r, b) => { r.bucket = b; };
  const skip = (r) => { if (!isOwn(r)) { place(r, 'rideAlong'); return true; } if (isNoise(r)) { place(r, 'belowNoise'); return true; } return false; };
  for (const v of P.views) for (const r of v.runs) r.view = v;
  const S = { P, place, skip, A: new Set(), ambient: [], load: [], late: [], gate: [], down: [], up: [], sweep: [], reactions: [], windows: [], starts: [], changes: [] };
  const amb = ambientSet(P);
  S.A = amb.keys; S.ambient = amb.runs;
  for (const r of S.ambient) place(r, 'inMoves');
  const inAmb = new Set(S.ambient);

  for (const v of P.views) {
    if (v.role === 'touch') { readTouch(S, v); continue; }
    if (v.role === 'change') { S.changes.push(v); continue; }
    for (const r of v.runs) {
      if (inAmb.has(r)) continue;
      if (skip(r)) continue;
      const part = partOf(v, r);
      if (part === 'setup' || part === 'other') { place(r, 'setup'); continue; }
      if (part === 'between') { place(r, 'between'); continue; }
      if (part === 'gate') { place(r, 'inMoves'); S.gate.push(r); continue; }
      if (S.A.has(r.key)) { place(r, part === 'idle' ? 'inMoves' : 'repeat'); continue; }
      place(r, 'inMoves');
      if (part === 'load') S.load.push(r); else if (part === 'idle') S.late.push(r); else if (part === 'down') S.down.push(r); else if (part === 'up') S.up.push(r); else if (part === 'sweep') S.sweep.push(r);
    }
  }

  // a timer read as a reaction: the lag rule, over every touch test of the page
  const out = lagClocked(S.reactions);
  for (const m of S.reactions) { if (m.kind !== 'touch') continue; const keep = []; for (const r of m.runs) { if (out.has(selectorGroup(r.key))) place(r, 'clocked'); else keep.push(r); } m.runs = keep; }

  // the first reacting member of a pattern is the move; a later member with the same signature is an instance of it
  const firstOf = new Map();
  for (const m of S.reactions) {
    if (m.kind !== 'touch') { S.windows.push(m); continue; }
    const f = firstOf.get(m.pat);
    if (f && sameTest(P, f, m)) { (f.instances ||= []).push(m); continue; }
    if (!f) firstOf.set(m.pat, m);
    S.windows.push(m);
  }
  S.shared = sharedKeys(S.windows);
  return S;
}

/** Members alike by the channel signature the scan judged them on; a test with no signature counts as alike. */
function sameTest(P, a, b) {
  const x = P.tests.get(a.label)?.signature, y = P.tests.get(b.label)?.signature;
  return !x || !y || x === y;
}

function readTouch(S, v) {
  const { P, place, skip } = S;
  const { wins, closes } = windowsOf(v);
  const ctl = controlSets(v.runs, wins), clocked = onsetClocked(v.runs, wins, isOwn);
  const firstK = wins[0]?.from ?? Infinity, byTest = new Map();
  for (const r of v.runs) {
    if (skip(r)) continue;
    if (r.k0 < firstK) { place(r, 'setup'); continue; }
    const w = closes.find((q) => r.k0 >= q.from && r.k0 <= q.to) || wins.find((q) => r.k0 >= q.from && r.k0 < q.to);
    if (!w) { place(r, 'between'); S.starts.push(r); continue; }
    if (w.part === 'control') { place(r, 'control'); S.starts.push(r); continue; }
    if (S.A.has(r.key)) { place(r, 'repeat'); continue; }
    if (r.doc > w.doc) { place(r, 'newDocument'); continue; }
    if (ctl.get(w.id)?.has(r.key)) { place(r, 'control'); continue; }
    if (!hasOwnWindow(w) && clocked.has(clockKey(r))) { place(r, 'clocked'); continue; }
    // a click test has no control window of its own: the 90 frames before it stand in
    if (w.part === 'open' && v.runs.some((q) => q.key === r.key && q.k0 < w.from && q.k1 >= w.from - PRE_OPEN)) { place(r, 'control'); continue; }
    place(r, 'inMoves');
    r.part = w.part; r.rel = Math.max(0, r.k0 - w.from - (w.enter || 0));   // an approach walks in: lag counts from the frame the pointer enters the box
    const e = byTest.get(w.id) || byTest.set(w.id, { rs: [], parts: new Map(), view: v }).get(w.id);
    e.rs.push(r);
    if (!e.parts.has(w.part)) e.parts.set(w.part, { from: w.from, to: w.to, lag: r.rel }); else e.parts.get(w.part).lag = Math.min(e.parts.get(w.part).lag, r.rel);
  }
  for (const [id, e] of byTest) {
    const isOpen = e.parts.has('open') || e.parts.has('close'), t = P.tests.get(id);
    const kind = isOpen ? (t?.navigated ? 'change' : openedOf(t) ? 'open' : 'touch') : 'touch';
    const [pat, member = '0'] = id.split('#');
    S.reactions.push({ kind, label: id, pat, member: +member, inside: id.includes('/'), parts: e.parts, click: isOpen && kind === 'touch', take: e.view, runs: e.rs });
  }
}

/** One pass over all pages of a viewport: the keys that follow the pointer. */
export function cursorKeys(states) {
  const cand = new Map();
  for (const S of states) {
    const keys = new Set(S.shared);
    for (const m of S.windows) for (const r of m.runs) { if (!keys.has(r.key)) continue; (cand.get(r.key) || cand.set(r.key, []).get(r.key)).push(r); }
  }
  return pointerFollowers(cand);
}

/** The second pass: shared followers leave, and the moves of this page come out. */
export function finishPage(S, cursors) {
  const { P, place } = S, moves = [], put = (o) => moves.push({ page: P.id, vp: P.vp, parts: null, ...o });
  // a cursor found on another page is a cursor here too, also when too few windows made it shared on this page
  const F = new Set(S.shared);
  for (const m of S.windows) for (const r of m.runs) if (cursors.has(r.key)) F.add(r.key);
  const followers = [], cursorRuns = [], ambientRuns = [], touchRuns = [];
  for (const m of S.windows) { const keep = []; for (const r of m.runs) { if (F.has(r.key)) followers.push(r); else keep.push(r); } m.runs = keep; for (const q of m.instances || []) q.runs = q.runs.filter((r) => (F.has(r.key) ? (place(r, 'repeat'), false) : true)); }
  const outside = outsideTests(F, S.starts);
  for (const r of followers) (cursors.has(r.key) ? cursorRuns : outside.has(r.key) ? ambientRuns : touchRuns).push(r);
  for (const [label, rs] of groupFollowers(cursorRuns)) put({ kind: 'cursor', label, runs: rs });
  for (const [label, rs] of groupFollowers(ambientRuns)) put({ kind: 'ambient', label, runs: rs });
  for (const [label, rs] of groupFollowers(touchRuns)) put({ kind: 'touch', label, runs: rs, follower: true });

  // arrival
  const drop = (rs) => rs.filter((r) => { if (!F.has(r.key)) return true; place(r, 'repeat'); return false; });
  if (S.gate.length) put({ kind: 'gate', label: 'gate', runs: S.gate });
  const load = drop(S.load).sort((a, b) => a.k0 - b.k0), late = drop(S.late), bursts = [];
  let cur = [], last = null;
  for (const r of load) { if (last != null && r.k0 - last > BURST) { bursts.push(cur); cur = []; } cur.push(r); last = r.k0; }
  if (cur.length) bursts.push(cur);
  if (late.length) { if (bursts.length) bursts[bursts.length - 1].push(...late); else bursts.push(late); }
  bursts.forEach((runs, i) => put({ kind: 'load', label: `burst ${i}`, runs }));

  // scroll, with the band merge of 2.4
  const down = drop(S.down), up = drop(S.up), downKeys = new Set(down.map((r) => r.key));
  const onlyUp = up.filter((r) => !downKeys.has(r.key)), back = up.filter((r) => downKeys.has(r.key));
  if (onlyUp.length) put({ kind: 'scroll-up', label: 'up', runs: onlyUp });
  for (const m of scrollBands(down, P.viewport.height)) { const keys = new Set(m.runs.map((r) => r.key)); put({ ...m, back: back.filter((r) => keys.has(r.key)) }); }
  // the sweep wakes every hover it crosses: only what travels with the pointer is a cursor. A hover a test of this page already holds
  // is a repeat; one the tests never reached is a touch move of its own, one per pass of the pointer
  const sweep = drop(S.sweep), tested = new Set(S.windows.flatMap((m) => m.runs.map((r) => r.key))), follow = [], woke = [];
  for (const r of sweep) { if (cursors.has(r.key) || sweepFollows(r)) follow.push(r); else if (tested.has(r.key)) place(r, 'repeat'); else woke.push(r); }
  if (follow.length) put({ kind: 'cursor', label: 'sweep', runs: follow, sweep: true });
  passesOf(woke).forEach((runs, i) => put({ kind: 'touch', label: `sweep ${i}`, runs, sweep: true }));

  for (const m of S.windows) put(m);
  if (S.ambient.length) put({ kind: 'ambient', label: 'at rest', runs: S.ambient });

  for (const v of S.changes) {
    const mark = v.marks.find((m) => m.name === 'change'), rs = [];
    for (const r of v.runs) {
      if (S.skip(r)) continue;
      if (!mark || r.doc > mark.doc) { place(r, 'newDocument'); continue; }
      if (r.k0 < mark.K) { place(r, 'setup'); continue; }
      if (F.has(r.key)) { place(r, 'repeat'); continue; }
      place(r, 'inMoves'); rs.push(r);
    }
    if (rs.length) put({ kind: 'change', label: v.name, runs: rs, take: v, from: mark.K });
  }
  return moves.filter((m) => m.runs.length);
}

/** Runs split where no onset follows within a burst gap: the pointer reached one thing, then the next. */
function passesOf(runs) {
  const out = []; let cur = [], last = null;
  for (const r of [...runs].sort((a, b) => a.k0 - b.k0)) { if (last != null && r.k0 - last > BURST) { out.push(cur); cur = []; } cur.push(r); last = r.k0; }
  if (cur.length) out.push(cur);
  return out;
}

/** Bands of scrollY at onset, one screen each. */
export function scrollBands(down, vh) {
  const by = new Map();
  for (const r of down) { const b = Math.floor((r.sy0 || 0) / vh); (by.get(b) || by.set(b, []).get(b)).push(r); }
  return [...by].sort((a, c) => a[0] - c[0]).map(([b, rs]) => ({ kind: 'scroll', label: `band ${b}`, band: b, runs: rs }));
}

/**
 * Adjacent bands of one page become one move when their law classes overlap, or the next band is nearly empty (2.4 step 8).
 * It runs after the law classes exist. A section of tiles that scroll in one by one is one motion, seen a screen apart.
 * @param {object[]} moves  moves with `band` and law classes on their runs, in page order
 * @returns {object[]} the moves left
 */
export function mergeBands(moves) {
  const pages = new Map();
  for (const m of moves) if (m.kind === 'scroll') { const k = `${m.page}|${m.vp}`; (pages.get(k) || pages.set(k, []).get(k)).push(m); }
  const gone = new Set();
  for (const l of pages.values()) {
    for (let i = l.length - 1; i > 0; i--) {
      const a = l[i - 1], b = l[i];
      if (b.band !== a.band + 1) continue;
      const ca = new Set(a.runs.map((r) => r.lc)), cb = new Set(b.runs.map((r) => r.lc));
      const n = [...ca].filter((x) => cb.has(x)).length, j = n / (ca.size + cb.size - n);
      if (j >= MODEL.bandJaccard || new Set(b.runs.map((r) => r.key)).size <= MODEL.bandMaxKeys) { a.runs.push(...b.runs); (a.back ||= []).push(...(b.back || [])); gone.add(b); l.splice(i, 1); }
    }
  }
  return moves.filter((m) => !gone.has(m));
}
