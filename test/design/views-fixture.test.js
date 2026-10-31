// Stage D3/D4 on the own design fixture, against known answers (fixtures/design/truth.json "views"): components,
// sections and breakpoint flips of index.html; the element -> asset map and the DTCG token export of assets.html,
// with a DTCG -> CSS round trip through Style Dictionary. One capture session per class and page (~40 s).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serveFixture } from '../helpers.js';
import { fixtureSite, pointsFromTruth, captureRun } from '../../src/gate/index.js';
import { gzRead } from '../../src/gate/run.js';
import { ruleTableCapture } from '../../src/gate/capture.js';
import { buildViews, buildTokens, writeViews } from '../../src/design/run.js';
import { ruleStates } from '../../src/design/views.js';
import { mediaEnv } from '../../src/design/media.js';
import { roundTrip, resolvedCheck } from './sd-roundtrip.js';
import { REPO_ROOT } from '../../src/util/paths.js';

const truth = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'fixtures/design/truth.json'), 'utf8'));
const K = truth.views;
const local = u => (u || '').replace(/^https?:\/\/localhost:\d+/, '');

test('derived views and tokens match the fixture known answers', { timeout: 600000 }, async () => {
  const srv = await serveFixture('design');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-d3-'));
  try {
    const site = fixtureSite(srv.origin, truth);
    const points = pointsFromTruth(truth, { perBand: 1 });
    await captureRun(site, points, path.join(out, 'index', 'cap'), { capture: ruleTableCapture() });
    await captureRun({ ...site, url: srv.origin + '/assets.html' }, points.filter(p => p.kind === 'captured'), path.join(out, 'assets', 'cap'), { capture: ruleTableCapture() });
    const fileFor = u => { const p = path.join(REPO_ROOT, 'fixtures/design', new URL(u).pathname); return fs.existsSync(p) ? path.relative(REPO_ROOT, p) : null; };

    // ---- index.html: components, sections, breakpoints
    const v = buildViews(path.join(out, 'index'), { edges: truth.edges, classes: truth.classes, range: truth.range, fileFor });
    assert.ok(writeViews(v, path.join(out, 'views')).length >= 10);
    for (const cls of ['D', 'T', 'M']) {
      const C = v.classes[cls].components.components;
      for (const [name, [n, variants]] of Object.entries(K.components)) {
        const c = C.find(x => x.name === name);
        assert.ok(c, `${cls} component ${name} found (${C.map(x => x.name).join('; ')})`);
        assert.equal(c.instances, n, `${cls} ${name} instances`);
        assert.equal(c.variants.length, variants, `${cls} ${name} variants`);
      }
      for (const [part, of] of Object.entries(K.partOf)) assert.equal(C.find(x => x.id === C.find(y => y.name === part).partOf)?.name, of, `${cls} ${part} is part of ${of}`);
    }
    const D = v.classes.D;
    assert.ok(D.components.components.find(x => x.name === 'button .tab').variants.some(x => x.extraRules.some(r => r.sel === '.tab[aria-selected="true"]')), 'selected tab is the variant');
    const top = D.sections.outline.filter(s => s.depth === 0);
    assert.deepEqual(top.map(s => [s.tag, s.role, s.position ?? null]), K.sections.top);
    const mainKids = D.sections.outline.filter(s => s.depth === 1 && s.parent === D.sections.outline.indexOf(top[1]));
    assert.deepEqual(mainKids.slice(0, 3).map(s => [s.tag, s.label]), K.sections.mainFirst);
    assert.ok(!D.sections.outline.some(s => s.k === K.sections.hidden), 'closed dialog is not in the outline');
    const share = mainKids.reduce((s, x) => s + x.share, 0);
    assert.ok(share > 0.85 && share <= 1.01, `main children cover the page ${share}`);
    assert.deepEqual(v.edges.map(e => e.edge), truth.edges);
    for (const e of v.edges) {
      const want = K.edges[String(e.edge)];
      assert.equal(e.rulesOff.length, want.off.length, `${e.edge} off`);
      assert.equal(e.unknown.length, 0, `${e.edge} unknown ${JSON.stringify(e.unknown)}`);
      assert.deepEqual(e.rulesOn.map(r => r.sel).sort(), want.on.map(x => x[0]).sort(), `${e.edge} on`);
      for (const [sel, when, k, prop] of want.on) {
        const r = e.rulesOn.find(x => x.sel === sel && x.when === when);
        assert.ok(r, `${e.edge} ${sel} ${when}`);
        const el = r.elements.find(x => x.k === k);
        assert.ok(el && el.props[prop], `${e.edge} ${sel} changes ${prop} of ${k}: ${JSON.stringify(r.elements)}`);
      }
    }
    assert.deepEqual(v.declared.T.map(x => x.t), K.declared);
    // rule states at the captured points: container query (.cards container) and the iframe's own media query
    for (const [cls, want] of Object.entries(K.ruleStates)) {
      const t = JSON.parse(fs.readFileSync(path.join(out, 'index', 'cap', `table-${cls}.json`), 'utf8'));
      const { width: w, height: h } = truth.classes[cls].viewport;
      const st = ruleStates(t, gzRead(path.join(out, 'index', 'cap', `${cls}-${w}x${h}.json.gz`)), mediaEnv({ w, h }));
      for (const [sel, val] of Object.entries(want)) {
        const r = t.rules.find(x => x.t === 'style' && x.sel === sel && (x.ctx || []).length);
        assert.equal(st.get(r.id).state, val, `${cls} ${sel}`);
      }
    }

    // ---- assets.html: element -> asset map
    const va = buildViews(path.join(out, 'assets'), { classes: truth.classes, fileFor });
    for (const cls of ['D', 'T', 'M']) {
      const A = va.classes[cls].assets;
      const byK = new Map(A.elements.map(e => [e.k, e.assets]));
      for (const [k, list] of Object.entries({ ...K.assets.all, ...(K.assets[cls] || {}) })) {
        for (const [kind, url, requested] of list) {
          const a = (byK.get(k) || []).find(x => x.kind === kind && local(x.url) === (url ?? ''));
          assert.ok(a || (url === null && (byK.get(k) || []).some(x => x.kind === kind)), `${cls} ${k} ${kind} ${url}: ${JSON.stringify(byK.get(k))}`);
          if (url) assert.equal(a.requested, requested, `${cls} ${k} ${url} requested`);
          if (url && requested) assert.ok(a.file, `${cls} ${url} -> file`);
        }
      }
      assert.deepEqual(A.summary.requestedNotInArchive, [], 'every requested asset maps to a file');
    }

    // ---- assets.html: DTCG tokens + round trip
    const tk = buildTokens(path.join(out, 'assets'));
    for (const cls of ['D', 'M']) {
      const d = tk[cls];
      for (const [name, [type, val]] of Object.entries(K.tokens.base)) {
        const t = d.base[name]; assert.ok(t, `${cls} token ${name}`);
        assert.equal(t.$type ?? null, type, `${cls} ${name} type`);
        if (type === 'color' && typeof val === 'number') assert.equal(t.$value.alpha, val);
        else if (type === 'color') assert.equal(t.$value.hex, val);
        else assert.deepEqual(t.$value, val, `${cls} ${name} value`);
      }
      for (const [key, toks] of Object.entries(K.tokens.contexts)) {
        const [sel, when] = key.split('|');
        const c = d.contexts.find(x => x.selector === sel && x.when === when);
        assert.ok(c, `${cls} context ${key}`);
        for (const [name, hex] of Object.entries(toks)) assert.equal(c.tokens[name].$extensions['com.reva'].authored, hex);
      }
      assert.equal(!!d.base.space.$extensions['com.reva'].resolvedWith, K.tokens.spaceResolvedWith[cls], `${cls} space overridden at root`);
      const rt = await roundTrip(d);
      assert.equal(rt.equal, rt.vars, `round trip ${JSON.stringify(rt.bad)}`);
      assert.ok(rt.vars >= 12);
      const rs = await resolvedCheck(d);
      assert.equal(rs.equal, rs.checked, `resolved ${JSON.stringify(rs.bad)}`);
      assert.ok(rs.checked >= 7, `resolved checked ${rs.checked}`);
    }
  } finally { await srv.close(); fs.rmSync(out, { recursive: true, force: true }); }
});
