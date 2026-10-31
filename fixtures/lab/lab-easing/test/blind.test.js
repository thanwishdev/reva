// Blind mode (design section 11): the served pages and the lab server expose no truth, no mechanism names and no
// driver hints; the server refuses truth, refsim, routes, traces and tooling.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { serveLab, loadRoutes, ROOT } from '../tools/harness.mjs';
import { BANNED, bannedSkip } from '../../banned-values.mjs';

const MECH = /spring|ease|easing|tween|stagger|flip|smil|lerp|\bema\b|inertia|friction|scrub|truth|fixture|bezier|transition|parallax|momentum|hold/i;
const get = async (origin, p) => { const r = await fetch(origin + p); return { status: r.status, text: r.status === 200 ? await r.text() : '' }; };

test('lab server refuses truth, refsim, routes, traces, tests and tools; serves pages and shared modules', async () => {
  const srv = await serveLab();
  try {
    for (const p of ['/truth.mjs', '/refsim.mjs', '/routes.json', '/traces/m19.timer.json', '/traces/', '/truth/m19.json', '/test/core.test.js', '/tools/harness.mjs', '/README.md', '/../index.html', '/%2e%2e/package.json'])
      assert.equal((await get(srv.origin, p)).status, 404, p);
    for (const p of ['/routes/m19.html', '/routes/m19.js', '/core.js', '/pagekit.js']) assert.equal((await get(srv.origin, p)).status, 200, p);
  } finally { await srv.close(); }
});

test('pages: neutral ids, classes and titles; no truth hook, no probe, no driver attribute', async () => {
  const srv = await serveLab();
  try {
    const files = ['/core.js', '/pagekit.js'];
    for (const r of loadRoutes().routes) files.push('/' + r.page, '/' + r.page.replace(/\.html$/, '.js'));
    for (const f of files) {
      const { status, text } = await get(srv.origin, f);
      assert.equal(status, 200, f);
      for (const bad of ['__WR_TRUTH__', '__WR_PROBE', '__GROUND_TRUTH__', 'data-wr', 'truth=1']) assert.ok(!text.includes(bad), `${f} contains ${bad}`);
      if (f.endsWith('.html')) {
        assert.match(text, /<title>lab<\/title>/, f);
        assert.ok(!/data-[a-z-]+=/.test(text), `${f}: data attribute`);
        const names = [...text.matchAll(/\b(?:id|class)="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/)).filter(Boolean);
        assert.ok(names.length > 0);
        for (const n of names) assert.ok(!MECH.test(n), `${f}: ${n}`);
        for (const m of text.matchAll(/(?:^|[}\s,])[#.]([A-Za-z_][\w-]*)/g)) if (!/^[bcnt]\d*$|^on$|^s$|^e$/.test(m[1])) assert.ok(!MECH.test(m[1]), `${f}: css name ${m[1]}`);
      } else if (f.startsWith('/routes/')) {
        for (const m of text.matchAll(/classList\.\w+\('([^']+)'\)/g)) assert.ok(!MECH.test(m[1]), `${f}: class ${m[1]}`);
        for (const m of text.matchAll(/@keyframes\s+([\w-]+)|animation:\s*([\w-]+)/g)) assert.ok(/^k\d/.test(m[1] || m[2] || 'k1'), `${f}: keyframes name`);
      }
    }
  } finally { await srv.close(); }
});

test('the group folder keeps site-derived material out (H2): no archive, no har', () => {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of walk(ROOT)) {
    assert.ok(!/\.(har|zip|png|jpg)$/i.test(f), f);
  }
});

test('the group folder names no captured site (strings from the private banned list)', { skip: bannedSkip }, () => {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const re = new RegExp(BANNED.strings.join('|'), 'i');
  for (const f of walk(ROOT)) {
    if (/\.(har|zip|png|jpg)$/i.test(f)) continue;
    assert.ok(!re.test(fs.readFileSync(f, 'utf8')), `${f}: site reference`);
  }
});
