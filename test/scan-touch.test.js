// Phase 4 (2 Nov): gates, patterns, open states, page changes, completion. Unit tests of the judgement; the recording itself is
// proven on real sites (PLAN §7 acceptance).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { judgeGate, gateRowOf, NEVER_PRESS } from '../src/scan/gate.js';
import { patternsOf, clickVerdict, stateDiffers, noisyCells, patternId, stateInPage } from '../src/scan/inventory.js';
import { planTests, judgePatterns, memberPlan, approachSides, approachPath, testMember, keepMarks, picturesOf, touchRows } from '../src/scan/patterns.js';
import { planChanges, changeFrames } from '../src/scan/changes.js';
import { STOP, APPROACH, SHOTS } from '../src/scan/moves/contract.js';
import { sortMisses, completeUnits, sameSite, fetchMissing } from '../src/scan/complete.js';
import { packHarZip } from '../src/freeze/sanitize.js';
import { pagesToRecord } from '../src/scan/map.js';
import { Ledger, promisedUnits } from '../src/scan/ledger.js';

const overlay = (labels, text = '', extra = {}) => ({ tag: 'div', cover: 1, text, clickables: labels, selfSel: 'html>body>div', choices: labels.map((label, i) => ({ sel: `#c${i}`, label, type: null })), ...extra });

test('gate: an Enter screen is passed, with no sound when there is the choice', () => {
  const j = judgeGate(overlay(['Enter with audio', 'Enter without audio']));
  assert.equal(j.kind, 'enter');
  assert.equal(j.choices[0].label, 'Enter without audio');
  assert.equal(judgeGate(overlay(['Skip intro'])).choices[0].sel, '#c0');
  assert.equal(judgeGate(overlay([], 'Click anywhere to enter')).choices[0].sel, 'html>body>div');
});

test('gate: REVA never says yes for the visitor', () => {
  const c = judgeGate(overlay(['Accept all', 'More options'], 'We use cookies'));
  assert.equal(c.kind, 'consent');
  assert.deepEqual(c.choices, []);
  assert.equal(judgeGate(overlay(['Agree'], 'Privacy')).choices.length, 0);
  const a = judgeGate(overlay(['Yes, I am over 18', 'Enter'], 'You must be over 18 to enter'));
  assert.equal(a.kind, 'age');
  assert.deepEqual(a.choices, []);
  const l = judgeGate(overlay(['Continue'], 'Sign in to continue', { password: true }));
  assert.equal(l.kind, 'login');
  assert.deepEqual(l.choices, []);
  for (const w of ['Accept', 'I agree', 'Sign up', 'Buy now', 'Yes', 'Subscribe']) assert.match(w, NEVER_PRESS);
  for (const w of ['Enter', 'Menu', 'Next', 'Toggle Sound']) assert.doesNotMatch(w, NEVER_PRESS);
});

test('gate rows: passed, none, refused, sign-in is blocked', () => {
  const at = { page: 'p', viewport: 'desktop', take: 't' };
  assert.equal(gateRowOf({ none: true }, at).status, 'captured');
  const p = gateRowOf({ sel: '#x', label: 'Enter', kind: 'enter', overlay: { tag: 'div', cover: 1 }, tried: 1 }, at);
  assert.equal(p.status, 'captured'); assert.match(p.reason, /passed by pressing "Enter"/);
  assert.equal(gateRowOf({ sel: null, kind: 'consent', why: 'REVA never accepts', overlay: { tag: 'div', cover: 1 } }, at).status, 'not-reached');
  assert.equal(gateRowOf({ sel: null, kind: 'login', why: 'no', overlay: { tag: 'div', cover: 1 } }, at).status, 'blocked');
  assert.equal(gateRowOf(null, at).status, 'failed');
});

const group = (sig, n, kind = 'control', y = 0) => ({ sig, tag: 'a', cls: sig, kind, focusable: true, n, members: Array.from({ length: Math.min(n, 6) }, (_, i) => ({ sel: `#${sig}${i}`, text: `t${i}`, x: 0, y: y + i })) });

test('patterns: ordered by the page, the far member is the second test, ids are stable', () => {
  const ps = patternsOf({ groups: [group('b', 1, 'link', 50), group('a', 4, 'link', 10)] });
  assert.equal(ps[0].sig, 'a');
  assert.equal(patternId(group('a', 4)), patternId(group('a', 9)));
  const t = planTests(ps, { members: 2, modes: ['hover'] });
  assert.deepEqual(t.map((x) => x.sel), ['#a0', '#a3', '#b0']);
  assert.deepEqual(planTests(ps, { members: 4, modes: [] }).filter((x) => x.member >= 2).map((x) => x.sel), ['#a1', '#a2']);
});

test('patterns: alike members stay one, members that differ split, a covered pattern says so', () => {
  const ps = patternsOf({ groups: [group('a', 3), group('b', 2), group('c', 1), group('d', 2)] });
  const [a, b, c, d] = ps.map((p) => p.id);
  const S1 = '{"hover":["ren:ty"],"press":[]}', S2 = '{"hover":["ren:opacity"],"press":[]}';
  const J = judgePatterns(ps, [{ pattern: a, signature: S1 }, { pattern: a, signature: S1 }, { pattern: b, signature: S1 }, { pattern: b, signature: S2 }, { pattern: c, covered: true }, { pattern: d, gone: true }]);
  assert.equal(J[0].split, false); assert.equal(J[0].tested, 2);
  assert.equal(J[1].split, true); assert.equal(J[1].groups.length, 2);
  assert.equal(J[2].covered, true); assert.equal(J[2].tested, 0);
  assert.equal(J[3].gone, true);
});

test('click tests: links are page changes, forms are never sent, words that commit are never pressed', () => {
  assert.equal(clickVerdict(group('a', 1, 'link')).ok, false);
  assert.match(clickVerdict(group('a', 1, 'submit')).why, /never submitted/);
  assert.equal(clickVerdict(group('a', 1, 'input')).ok, false);
  const g = group('a', 1); g.members[0].text = 'Accept all';
  assert.match(clickVerdict(g).why, /never presses/);
  assert.equal(clickVerdict(group('a', 1)).ok, true);
});

const st = (o = {}) => ({ shown: 100, view: 50, expanded: 0, dialogs: 0, marks: '', lock: 'visible/visible', url: 'https://a.test/', grid: Array(64).fill('div.a#'), ...o });

test('open state: a page\'s own small changes are not one; a share of the screen, ARIA, a dialog, a tab or a scroll lock is', () => {
  assert.equal(stateDiffers(st(), st({ view: 55, shown: 104 })).changed, false);
  const g = st().grid.slice(); for (let i = 0; i < 10; i++) g[i] = 'nav.menu#';
  assert.equal(stateDiffers(st(), st({ grid: g })).changed, true);
  assert.equal(stateDiffers(st(), st({ grid: g }), { ignore: noisyCells(st(), st({ grid: g })) }).changed, false, 'a marquee is no open state');
  assert.equal(stateDiffers(st(), st({ expanded: 1 })).changed, true);
  assert.equal(stateDiffers(st(), st({ dialogs: 1 })).changed, true);
  assert.equal(stateDiffers(st(), st({ marks: '2' })).changed, true);
  assert.equal(stateDiffers(st(), st({ lock: 'hidden/hidden' })).changed, true);
  assert.equal(stateDiffers(st(), st({ url: 'https://a.test/x' })).navigated, true);
  assert.equal(stateDiffers(st(), st({ url: 'https://a.test/#x' })).navigated, false);
});

test('page changes: one link per other template, the recorded page preferred, a template not linked is no pair', () => {
  const clusterOf = new Map([['https://a.test', 'h'], ['https://a.test/work', 'w'], ['https://a.test/work/1', 'w2'], ['https://a.test/work/2', 'w2'], ['https://a.test/studio', 's'], ['https://a.test/x', 'x']]);
  const pages = [
    { url: 'https://a.test/', cluster: 'h', links: [{ href: 'https://a.test/work/1', sel: '#1' }, { href: 'https://a.test/work/2', sel: '#2' }, { href: 'https://a.test/studio', sel: '#s' }, { href: 'https://a.test/', sel: '#h' }, { href: 'https://other.test/', sel: '#o' }] },
    { url: 'https://a.test/work/2', cluster: 'w2', links: [{ href: 'https://a.test/work/1', sel: '#same' }, { href: 'https://a.test/', sel: '#home' }] },
    { url: 'https://a.test/studio', cluster: 's', links: [] },
  ];
  const c = planChanges(pages, clusterOf);
  assert.deepEqual(c.map((x) => [x.from, x.sel]), [['https://a.test/', '#2'], ['https://a.test/', '#s'], ['https://a.test/work/2', '#home']]);
});

test('page changes: a link that opens a new window stands for its template only when no other link does', () => {
  const clusters = new Map([['https://a.co/', 'home'], ['https://a.co/x', 'x'], ['https://a.co/y', 'x'], ['https://a.co/z', 'z']]);
  const page = (links) => [{ url: 'https://a.co/', cluster: 'home', links }];
  assert.equal(planChanges(page([{ href: 'https://a.co/x', sel: '#x', blank: true }, { href: 'https://a.co/y', sel: '#y' }]), clusters)[0].sel, '#y');
  assert.equal(planChanges(page([{ href: 'https://a.co/y', sel: '#y' }, { href: 'https://a.co/x', sel: '#x', blank: true }]), clusters)[0].sel, '#y');
  assert.equal(planChanges(page([{ href: 'https://a.co/z', sel: '#z', blank: true }]), clusters)[0].sel, '#z');
});

test('completion: an answer from another origin reads 0 and is fetched; a failed fetch stays failed; a file name never repeats', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-complete-'));
  const archiveDir = path.join(dir, 'archive'); fs.mkdirSync(path.join(archiveDir, 'har'), { recursive: true });
  const fetcher = async (_c, _k, { harPath }) => { fs.writeFileSync(harPath, packHarZip({ har: { log: { entries: [] } }, files: new Map() })); return { extra: [['https://cdn.a.co/1.png', 0], ['https://cdn.a.co/2.png', 'ERR Failed to fetch']] }; };
  const target = { harDir: 'har', harExtras: ['extra-1.har.zip'] };
  const r = await fetchMissing(['https://cdn.a.co/1.png', 'https://cdn.a.co/2.png'], { target, archiveDir, round: 1, engine: 'cft', home: 'https://a.co/', fetcher, robots: async (l) => ({ allowed: l, disallowed: [] }) });
  assert.deepEqual(r.fetched, ['https://cdn.a.co/1.png']);
  assert.equal(r.failed[0].url, 'https://cdn.a.co/2.png');
  assert.equal(r.har, 'extra-2.har.zip');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('pagesToRecord: a small site records a page per path shape, a big one a page per structure', () => {
  const small = { start: 'https://a.test', counts: { shapes: 3 }, clusters: [{ id: 0, rep: 'https://a.test', pages: 3 }], templates: [{ shape: '/', count: 1 }, { shape: '/work/*', count: 2 }, { shape: '/dead', count: 1 }],
    pages: [{ url: 'https://a.test', shape: '/', status: 'sampled', httpStatus: 200 }, { url: 'https://a.test/work/1', shape: '/work/*', status: 'sampled', httpStatus: 200 }, { url: 'https://a.test/dead', shape: '/dead', status: 'sampled', httpStatus: 404 }] };
  assert.deepEqual(pagesToRecord(small).map((p) => p.url), ['https://a.test', 'https://a.test/work/1']);
  const big = { start: 'https://a.test', counts: { shapes: 40 }, clusters: [{ id: 0, rep: 'https://a.test/x', pages: 30 }, { id: 1, rep: 'https://a.test', pages: 2 }], templates: [], pages: [] };
  assert.deepEqual(pagesToRecord(big).map((p) => p.url), ['https://a.test', 'https://a.test/x']);
});

test('completion: units are recorded again one line per viewport, in order within a viewport', async () => {
  const miss = ['GET https://a.test/a.png'];
  const units = ['home/desktop/opens', 'home/phone/opens', 'p1/desktop/opens'].map((key) => ({ key, run: () => {}, result: { ok: false, missList: miss } }));
  const started = []; let open; const hold = new Promise((r) => { open = r; });
  const reRecord = async (u) => { started.push(u.key); if (u.key === 'home/desktop/opens') await hold; return { ok: true, missList: [] }; };
  const fetchImpl = async () => ({ fetched: ['https://a.test/a.png'], failed: [], blocked: [] });
  const done = completeUnits({ units, home: 'https://a.test/', fromArchive: false, target: { harExtras: [] }, reRecord, scan: { steps: {} }, fetchImpl });
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(started, ['home/desktop/opens', 'home/phone/opens']); // the phone goes on while the desktop line holds; p1/desktop waits for its line
  open(); await done;
  assert.deepEqual(started, ['home/desktop/opens', 'home/phone/opens', 'p1/desktop/opens']);
  assert.ok(units.every((u) => u.result.ok));
});

test('misses: only a GET of the site itself may be fetched, the others say why', () => {
  assert.equal(sameSite('https://cdn.a.test/x.png', 'https://www.a.test/'), true);
  assert.equal(sameSite('https://notable.test/', 'https://a.test/'), false);
  const { fetch, left } = sortMisses(['GET https://a.test/x.png', 'GET https://a.test/x.png', 'POST https://a.test/api', 'GET https://cdn.other.test/y.js', 'GET blob:abc'], 'https://a.test/');
  assert.deepEqual(fetch, ['https://a.test/x.png']);
  assert.equal(left.length, 3);
  assert.match(left.find((x) => x.method === 'POST').reason, /POST/);
  assert.match(left.find((x) => x.url.includes('other')).reason, /another site/);
});

test('completion: what was fetched clears the unit, what robots refuse or the site lacks gets a row, at most two rounds', async () => {
  const a = 'GET https://a.test/a.png', b = 'GET https://a.test/b.png', c = 'GET https://a.test/c.png', d = 'POST https://a.test/api';
  let runs = 0; const log = [];
  const unit = { key: 'u1', result: { ok: true, missList: [a, b, c, d] }, run: async () => { runs++; return { ok: true, missList: [c, d] }; }, apply: (r) => log.push(r) };
  const untouched = { key: 'u2', result: { ok: true, missList: [] }, run: async () => { throw new Error('must not run'); } };
  const scan = { steps: {} }; const target = { harExtras: ['extra-1.har.zip'] }; const fetched = [];
  const rows = await completeUnits({ units: [unit, untouched], home: 'https://a.test/', fromArchive: false, target, reRecord: (u) => u.run(), scan,
    fetchImpl: async (urls, o) => { fetched.push([o.round, urls]); return { fetched: urls.filter((u) => /a\.png/.test(u)), failed: urls.filter((u) => /b\.png/.test(u)).map((url) => ({ url, reason: 'the site answered 404' })), blocked: urls.filter((u) => /c\.png/.test(u)).map((url) => ({ url, reason: 'robots.txt disallows it' })) }; } });
  assert.equal(runs, 1);
  assert.equal(log.length, 1);
  assert.deepEqual(fetched.map((f) => f[0]), [1]); // round 2 had nothing new to ask for
  assert.deepEqual(rows.map((r) => [r.url.slice(-6), r.status]).sort(), [['/c.png', 'blocked'], ['st/api', 'not-reached']]);
  assert.deepEqual(rows[0].units, ['u1']);
  assert.equal(scan.steps.completion.rounds[0].fetched, 1);
});

test('completion: a caller\'s archive gets nothing added, the misses are rows', async () => {
  const scan = { steps: {} };
  const rows = await completeUnits({ units: [{ key: 'u', result: { ok: true, missList: ['GET https://a.test/a.png'] } }], home: 'https://a.test/', fromArchive: true, target: {}, reRecord: () => { throw new Error('no'); }, scan, fetchImpl: () => { throw new Error('no fetch on a given archive'); } });
  assert.equal(rows.length, 1);
  assert.match(rows[0].reason, /given by the caller/);
});

test('completion: the many beacons of another site fold into one row per host', async () => {
  const miss = Array.from({ length: 5 }, (_, i) => `GET https://beacon.test/p?id=${i}`);
  const rows = await completeUnits({ units: [{ key: 'u', result: { ok: true, missList: miss } }], home: 'https://a.test/', fromArchive: false, target: {}, reRecord: () => {}, scan: { steps: {} } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].requests, 5);
  assert.equal(rows[0].url, 'https://beacon.test/');
});

test('ledger: a page-level request row and the summary rows of a touch-tested viewport', () => {
  const l = new Ledger();
  l.add({ unit: 'request', id: 'https://a.test/x', status: 'blocked', reason: 'robots' });
  const u = promisedUnits({ pages: ['p'], viewports: ['desktop'], moments: ['load'], laterUnits: ['design'], touchUnits: ['desktop'] });
  assert.ok(u.some((x) => x.unit === 'pattern' && x.id === 'all' && x.viewport === 'desktop'));
  assert.ok(u.some((x) => x.unit === 'open-state' && x.id === 'all'));
  assert.ok(u.some((x) => x.unit === 'page-change' && x.id === 'all'));
  assert.ok(u.some((x) => x.unit === 'design'));
  assert.ok(!u.some((x) => x.unit === 'pattern' && x.id === 'pattern'));
});

// ---------------------------------------------------------------- the touch of DESIGN 3.3 and 3.4, on a session that only keeps a log

/** A session that runs no page: every in-page read is answered from `page`, every call lands in `log`. */
function fakeSession({ side = 'left', box = [100, 100, 200, 100] } = {}) {
  const log = [], S = { marks: [], inputLog: [], log };
  const say = (name) => async (...a) => { log.push([name, ...a]); };
  Object.assign(S, { hold: say('hold'), controlStart: say('controlStart'), controlStop: say('controlStop'), controlClear: say('controlClear'), partStart: say('partStart'), cdp: { send: say('key') } });
  S.locate = async () => ({ x: 200, y: 150 });
  S.mark = async (name, extra) => { log.push(['mark', name, extra]); S.marks.push({ name, extra }); };
  S.mouse = async (type, x, y) => { log.push(['mouse', type, x, y]); };
  S.evRetry = async (fn, arg) => {
    if (fn === stateInPage) return st();
    const src = String(fn);
    if (src.includes('freeSide') || src.includes('closest(')) { log.push(['spots', arg[0].map((p) => p[0])]); return side; }
    if (src.includes('elementFromPoint')) return { hit: true, ids: [1, 2] };
    if (src.includes('innerWidth')) return { box, view: { width: 1440, height: 900 } };
    if (src.includes('Math.round')) return { x: 200, y: 150 };
    return null;
  };
  return S;
}
const fakeFrames = (S, ran = {}) => ({
  phaseFrames: async (phase, n, o = {}) => { S.log.push(['phase', phase, n, o]); return ran[phase.split(':').pop()] ?? n; },
  shot: async (phase, o = {}) => { S.log.push(['shot', phase, o]); return { quiet: null }; },
});
const test1 = (over = {}) => ({ id: 'p#0', pattern: 'p', member: 0, sel: '#a', focusable: true, modes: ['focus', 'hover'], text: 'a', ...over });
const of = (S, name) => S.log.filter((l) => l[0] === name);

test('members: the first is the clip, the second proves it alike at the floor, a split member is full again at 30, inside stays at the floor', () => {
  assert.deepEqual(memberPlan({ member: 0 }), { focus: true, approach: true, pictures: 'gate' });
  assert.deepEqual(memberPlan({ member: 1 }), { focus: false, approach: false, pictures: 'floor' });
  assert.deepEqual(memberPlan({ member: 2 }), { focus: true, approach: true, pictures: 'cap' });
  assert.deepEqual(memberPlan({ member: 3 }), { focus: true, approach: true, pictures: 'cap' });
  assert.deepEqual(memberPlan({ member: 0, inside: true }), { focus: true, approach: true, pictures: 'floor' });
  assert.deepEqual(memberPlan({ member: 1, inside: true }), { focus: false, approach: false, pictures: 'floor' });
});

test('approach: the sides in order, only those on the screen', () => {
  const view = { width: 1440, height: 900 }, to = { x: 200, y: 150 };
  assert.deepEqual(approachSides([100, 100, 200, 100], to, view).map((p) => p.slice(0, 3)), [['left', 60, 150], ['top', 200, 60], ['right', 340, 150], ['bottom', 200, 240]]);
  assert.deepEqual(approachSides([10, 20, 1400, 860], { x: 710, y: 450 }, view).map((p) => p[0]), [], 'a box that fills the screen has no outside');
  assert.deepEqual(approachSides([0, 0, 200, 100], { x: 100, y: 50 }, view).map((p) => p[0]), ['right', 'bottom']);
});

test('approach: 12 moves to the exact centre, from 40 px outside; enter says when the pointer crosses the edge', () => {
  const view = { width: 1440, height: 900 }, to = { x: 200, y: 150 }, box = [100, 100, 200, 100];
  const p = approachPath(box, to, 'left', view);
  assert.equal(p.pts.length, APPROACH.steps);
  assert.deepEqual(p.pts[0], [60, 150]);
  assert.deepEqual(p.pts.at(-1), [200, 150]);
  assert.equal(p.side, 'left');
  assert.ok(p.pts[p.enter][0] >= 100 && p.pts[p.enter - 1][0] < 100, 'the first point inside, the one before it outside');
  assert.deepEqual(approachPath(box, to, 'bottom', view).pts[0], [200, 240]);
});

test('approach: no free side starts just inside the left edge, on the screen, already in', () => {
  const view = { width: 1440, height: 900 };
  const p = approachPath([100, 100, 200, 100], { x: 200, y: 150 }, null, view);
  assert.deepEqual(p.pts[0], [104, 150]);
  assert.equal(p.enter, 0);
  assert.equal(p.side, null);
  assert.equal(approachPath([-50, 0, 1600, 900], { x: 700, y: 450 }, null, view).pts[0][0], 1, 'a box wider than the screen starts on the screen');
});

test('first member: control, focus, the approach with pictures, a hover that runs on to quiet, a press never cut, a leave to quiet', async () => {
  const S = fakeSession(), r = await testMember(S, test1(), fakeFrames(S, { hover: 41, out: 19 }));
  assert.deepEqual(S.marks.map((m) => m.name), ['control', 'focus', 'hover', 'press', 'out', 'end'].map((p) => `p#0:${p}`));
  const names = S.log.map((l) => l[0]);
  assert.ok(names.indexOf('controlStart') < names.indexOf('hold') && names.indexOf('hold') < names.indexOf('controlStop'), 'the control window is the hold');
  assert.ok(names.lastIndexOf('controlClear') < S.log.findIndex((l) => l[0] === 'mark' && l[1] === 'p#0:end'), 'the set ends with the test');
  // every input stands right after its partStart
  assert.equal(of(S, 'partStart').length, 6);
  const moves = of(S, 'mouse').filter((m) => m[1] === 'mouseMoved');
  assert.equal(moves.length, APPROACH.steps + 1);
  assert.deepEqual(moves[0].slice(2), [60, 150]);
  assert.deepEqual(moves[APPROACH.steps - 1].slice(2), [200, 150]);
  assert.deepEqual(moves.at(-1).slice(2), [2, 2], 'leaving stays a jump');
  assert.equal(of(S, 'shot').length, APPROACH.steps, 'a clip has no hole in the approach');
  const hover = S.marks.find((m) => m.name === 'p#0:hover');
  assert.equal(hover.extra.side, 'left'); assert.ok(hover.extra.enter > 0);
  const phase = (p) => of(S, 'phase').filter((l) => l[1] === `p#0:${p}`).map((l) => [l[2], l[3].quiet ?? 0, l[3].pictures]);
  assert.deepEqual(phase('focus'), [[18, 12, 'gate'], [12, 12, 'gate']]);
  assert.deepEqual(phase('hover'), [[STOP.hoverMax, 18, 'gate']]);
  assert.equal(of(S, 'phase').find((l) => l[1] === 'p#0:hover')[3].min, 18);
  assert.deepEqual(phase('press'), [[12, 0, 'gate'], [16, 12, 'gate']]);
  assert.deepEqual(phase('out'), [[STOP.outMax, 18, 'gate']]);
  assert.deepEqual(r.tested, ['focus', 'hover', 'press', 'out']);
  assert.equal(r.stopped.hover, 41); assert.equal(r.stopped.out, 19);
});

test('second member: hover, press and out, no focus, a plain jump, floor pictures, quiet stops, 84 frames when nothing reacts', async () => {
  const S = fakeSession(), r = await testMember(S, test1({ id: 'p#1', member: 1 }), fakeFrames(S, { hover: 18, press: 12, out: 18 }));
  assert.deepEqual(S.marks.map((m) => m.name), ['control', 'hover', 'press', 'out', 'end'].map((p) => `p#1:${p}`));
  assert.equal(of(S, 'mouse').filter((m) => m[1] === 'mouseMoved').length, 2);
  assert.equal(of(S, 'shot').length, 0);
  assert.ok(of(S, 'phase').every((l) => l[3].pictures === 'floor'));
  assert.deepEqual(r.tested, ['hover', 'press', 'out']);
  assert.equal(24 + r.stopped.hover + 12 + r.stopped.press + r.stopped.out, 84);
});

test('a pattern that leaves on the press and a phone test keep their parts', async () => {
  const S = fakeSession(), r = await testMember(S, test1({ leaves: 'https://a.test/x' }), fakeFrames(S));
  assert.deepEqual(r.tested, ['focus', 'hover', 'out']);
  const P = fakeSession(), q = await testMember(P, test1({ modes: [] }), fakeFrames(P));
  assert.deepEqual(q.tested, ['press', 'out']);
  assert.equal(of(P, 'shot').length, 0, 'no approach on a press alone');
});

test('a side taken by a neighbour: the mark says how the pointer came in', async () => {
  const S = fakeSession({ side: null });
  await testMember(S, test1(), fakeFrames(S));
  assert.deepEqual(S.marks.find((m) => m.name === 'p#0:hover').extra, { enter: 0, side: null });
  assert.deepEqual(of(S, 'mouse')[0].slice(2), [104, 150]);
  assert.deepEqual(of(S, 'spots')[0][1], ['left', 'top', 'right', 'bottom']);
});

test('a test ends early on a target that left or is covered, with no control window', async () => {
  const S = fakeSession(); S.locate = async () => null;
  assert.equal((await testMember(S, test1(), fakeFrames(S))).gone, true);
  assert.equal(S.marks.length, 0);
});

test('marks: a take that ended on another document gets the Node side\'s list back, in order', async () => {
  const had = globalThis.window;
  globalThis.window = { __WR: { marks: [{ name: 'change-end', k: 180 }] } };
  try {
    const S = { marks: [{ name: 'boot-done', k: 40 }, { name: 'change', k: 900 }, { name: 'change-end', k: 180 }], evRetry: async (fn, arg) => fn(arg) };
    await keepMarks(S);
    assert.deepEqual(globalThis.window.__WR.marks.map((m) => m.name), ['boot-done', 'change', 'change-end']);
  } finally { if (had === undefined) delete globalThis.window; else globalThis.window = had; }
});

/** A change on a page that says, frame by frame, whether its document stands and whether it has gone quiet. */
function changeRun({ docGoesAt = Infinity, quietFrom = Infinity } = {}) {
  const c = { steps: 0, drains: 0, asked: [] };
  const S = { step: async () => { c.steps++; }, drain: async () => { c.drains++; }, evRetry: async () => c.steps < docGoesAt };
  const shot = async (phase, o) => { assert.equal(phase, 'change'); c.asked.push(o.quiet); return { quiet: !!o.quiet && c.steps >= quietFrom }; };
  return { c, run: () => changeFrames(S, shot) };
}

test('page change: never cut before frame 180, even on a page at rest', async () => {
  const { c, run } = changeRun({ quietFrom: 1 });
  assert.equal(await run(), STOP.changeMin);
  assert.ok(c.asked.slice(0, STOP.changeMin - 1).every((q) => q === 0));
  assert.equal(c.asked[STOP.changeMin - 1], STOP.lateQuiet);
});

test('page change: past 180 it ends at 2 s quiet, at 360 whatever still moves', async () => {
  assert.equal(await changeRun({ quietFrom: 250 }).run(), 250);
  assert.equal(await changeRun().run(), STOP.changeMax);
});

test('page change: every frame is drained until the document goes, then none, so the new page costs no drain', async () => {
  const gone = changeRun({ docGoesAt: 10 }); await gone.run();
  assert.equal(gone.c.drains, 1 + 10);
  const same = changeRun({ quietFrom: 200 }); await same.run();
  assert.equal(same.c.drains, 1 + 200, 'a same-document change stays drained');
});

test('pictures: a row says what its tests got', () => {
  const frames = { phases: [{ name: 'p#0:hover', from: 0, to: 30, shots: 30 }, { name: 'p#0:out', from: 30, to: 50, shots: 4 }, { name: 'q#0:hover', from: 50, to: 60, shots: 10 }] };
  assert.deepEqual(picturesOf(frames, ['p#0']), { shots: 34, frames: 50, floor: SHOTS.floor });
  assert.equal(picturesOf(frames, ['none']), null);
  assert.equal(picturesOf(null, ['p#0']), null);
});

test('rows: a second member that answered alike is a recorded duplicate, an earlier page\'s pattern a signature one, and a v2 ledger takes them', () => {
  const ps = patternsOf({ groups: [group('a', 3), group('b', 2)] }), [a, b] = ps;
  const sig = '{"hover":["ren:ty"],"press":[]}', ledger = new Ledger({ version: 2 });
  const tests = [{ id: `${a.id}#0`, pattern: a.id, signature: sig, stopped: { hover: 30 }, tested: ['focus', 'hover', 'press', 'out'] }, { id: `${a.id}#1`, pattern: a.id, signature: sig, stopped: { hover: 18 }, tested: ['hover', 'press', 'out'] }];
  const frames = { phases: [{ name: `${a.id}#0:hover`, from: 0, to: 30, shots: 30 }, { name: `${a.id}#1:hover`, from: 30, to: 48, shots: 2 }] };
  const dup = { ...b, id: 'old' };
  touchRows(ledger, { page: 'p', viewport: 'desktop', prefix: '', slot: { survey: { ok: true, inv: { interactive: 5, css: 0 } }, fresh: [a], dups: [dup], dupOf: () => ({ page: 'https://a.test/', id: 'x' }), patterns: { ok: true, tests, frames } } });
  const first = ledger.get('pattern', 'p', 'desktop', a.id), second = ledger.get('pattern', 'p', 'desktop', `${a.id}#1`), old = ledger.get('pattern', 'p', 'desktop', 'old');
  assert.equal(first.status, 'captured');
  assert.deepEqual(first.pictures, { shots: 32, frames: 48, floor: SHOTS.floor });
  assert.deepEqual(first.evidence.stopped[`${a.id}#1`], { hover: 18 });
  assert.equal(second.status, 'duplicate-of'); assert.equal(second.proof, 'recorded'); assert.equal(second.duplicateOf, `${a.id}#0`);
  assert.deepEqual(second.tested, ['hover', 'press', 'out']);
  assert.equal(old.proof, 'signature');
  assert.deepEqual(ledger.check([], {}).problems, []);
});
