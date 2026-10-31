// robots.txt matching: REVA's own product token, the RFC 9309 matching rules, and linear time on hostile rules
// (a '*a*a*a...' rule against a long path froze the event loop for hours with the old RegExp matcher).
import test from 'node:test';
import assert from 'node:assert/strict';
import { robotsVerdict, robotsAllows, parseRobots, ruleMatcher, PRODUCT_TOKEN, MAX_ROBOTS_BYTES, readRobotsBody } from '../../src/safety/robots.js';

const U = 'https://a.example/page';

test('a group for REVA itself is obeyed: "User-agent: REVA", any case, with or without a version', () => {
  assert.equal(PRODUCT_TOKEN, 'REVA');
  for (const ua of ['REVA', 'reva', 'Reva/0.1', 'REVA/0.1 (x)']) {
    const v = robotsVerdict(`User-agent: ${ua}\nDisallow: /\n\nUser-agent: *\nAllow: /\n`, [U]);
    assert.equal(v.blocked, true, ua); assert.equal(v.reva, 'disallow', ua); assert.equal(v.reason, 'robots:reva', ua);
  }
  // REVA allowed by its own group although '*' is disallowed: '*' still stops it (the star group speaks to every robot)
  const both = robotsVerdict('User-agent: REVA\nAllow: /\n\nUser-agent: *\nDisallow: /\n', [U]);
  assert.equal(both.blocked, true); assert.equal(both.reason, 'robots:star');
  // another bot's group is not REVA's
  assert.equal(robotsVerdict('User-agent: REVAMP\nDisallow: /\n', [U]).blocked, false);
  assert.equal(robotsVerdict('User-agent: SomeBot\nDisallow: /\n', [U]).blocked, false);
});

test('matching follows RFC 9309: prefix, * anywhere, $ at the end, longest rule wins, Allow wins a tie', () => {
  const m = (rule, p) => ruleMatcher(rule)(p);
  assert.ok(m('/a', '/abc')); assert.ok(!m('/b', '/abc'));
  assert.ok(m('/a*c', '/abxc')); assert.ok(m('/a*c', '/acx')); assert.ok(!m('/a*c', '/ab'));
  assert.ok(m('/*.php$', '/x/y.php')); assert.ok(!m('/*.php$', '/x/y.php?q')); assert.ok(m('/*.php', '/x/y.php?q'));
  assert.ok(m('/a$', '/a')); assert.ok(!m('/a$', '/ab'));
  assert.ok(m('/*a*b$', '/xaxb')); assert.ok(!m('/*a*b$', '/xaxbx')); assert.ok(m('/*ab*ab$', '/abab'));
  assert.ok(!m('/*ab*ab$', '/aba'), 'pieces may not overlap'); assert.ok(m('*', '/anything')); assert.ok(m('/**x', '/yx'));
  const p = parseRobots('User-agent: *\nDisallow: /a\nAllow: /a/b\n');
  assert.equal(robotsAllows(p, '*', '/a/b/c').allowed, true); assert.equal(robotsAllows(p, '*', '/a/c').allowed, false);
  const tie = parseRobots('User-agent: *\nDisallow: /x\nAllow: /x\n');
  assert.equal(robotsAllows(tie, '*', '/x').allowed, true);
});

test('a hostile wildcard rule against a long path is decided in linear time (k = 30 stars well under 50 ms)', () => {
  const rule = '/' + Array.from({ length: 30 }, () => '*a').join('') + 'b';
  const text = `User-agent: *\nDisallow: ${rule}\n`;
  const long = 'https://a.example/' + 'a'.repeat(20000);
  const t0 = performance.now();
  const v = robotsVerdict(text, [long]);
  const ms = performance.now() - t0;
  assert.equal(v.blocked, false);
  assert.ok(ms < 50, `took ${ms.toFixed(1)} ms`);
  // and a whole file of them (at the size cap) stays fast too
  const many = 'User-agent: *\n' + Array.from({ length: 200 }, (_, i) => `Disallow: /${'*a'.repeat(400)}${i}\n`).join('');
  const t1 = performance.now(); robotsVerdict(many, [long]); const ms2 = performance.now() - t1;
  assert.ok(ms2 < 1000, `200 hostile rules took ${ms2.toFixed(1)} ms`);
});

test('size caps: content past 500 KiB and rules longer than 2048 characters are ignored; the body read stops at the cap', async () => {
  const pad = '#'.repeat(MAX_ROBOTS_BYTES);
  assert.equal(robotsVerdict(`User-agent: *\n${pad}\nDisallow: /\n`, [U]).blocked, false, 'a rule past the cap is not read');
  assert.equal(robotsVerdict(`User-agent: *\nDisallow: /${'x'.repeat(3000)}\nDisallow: /\n`, [U]).blocked, true);
  assert.equal(parseRobots(`User-agent: *\nDisallow: /${'x'.repeat(3000)}\n`).groups[0].rules.length, 0);
  const big = new Response('User-agent: *\n' + 'x'.repeat(3 * MAX_ROBOTS_BYTES));
  const body = await readRobotsBody(big);
  assert.ok(body.length <= MAX_ROBOTS_BYTES && body.startsWith('User-agent: *'), String(body.length));
});
