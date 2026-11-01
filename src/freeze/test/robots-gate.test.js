// 26 Oct (lead item from L1): the bounded freeze's completion fetch obeys robots.txt of the site's own hosts for the exact
// path, with preflight's agents (*, REVA, Anthropic crawlers); a disallowed URL is not fetched and is logged. Stub fetch,
// no network, no browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { robotsFilter, robotsFetcher, notFetchedText } from '../robots-gate.js';

const ROBOTS = {
  'https://www.site.co.th': 'User-agent: *\nDisallow: /api/private\nAllow: /api/private/ok\n\nUser-agent: ClaudeBot\nDisallow: /team\n',
  'https://api.site.co.th': 'User-agent: REVA\nDisallow: /\n',
  'https://cdn.other.com': 'User-agent: *\nDisallow: /\n', // third party: not the site, not checked
};

test('completion candidates: same-site disallowed paths are not fetched; allowed, third-party and robots-less pass', async () => {
  const asked = [];
  const fetchImpl = async (u) => {
    asked.push(u);
    const o = new URL(u).origin;
    if (o === 'https://shop.site.co.th') throw new Error('ECONNRESET'); // unreadable robots.txt: cannot tell, not fetched (PR-07, as preflight)
    return ROBOTS[o] != null ? new Response(ROBOTS[o], { status: 200 }) : new Response('nope', { status: 404 });
  };
  const c = (url) => ({ url, origin: 'miss-driven' });
  const cands = [
    c('https://www.site.co.th/api/public/menu.json'),
    c('https://www.site.co.th/api/private/user.json'), // * disallow
    c('https://www.site.co.th/api/private/ok/x.json'), // longer Allow wins
    c('https://www.site.co.th/team/people.json'), // ClaudeBot disallow
    c('https://api.site.co.th/v1/items?page=2'), // REVA disallow on that host's own robots.txt
    c('https://cdn.other.com/lib.js'), // third party
    c('https://shop.site.co.th/products.json'), // robots.txt unreachable (network error)
    c('https://www.site.co.th/api/public/other.json'),
  ];
  const r = await robotsFilter(cands, { siteUrl: 'https://www.site.co.th/', robotsText: robotsFetcher({ fetchImpl }) });
  assert.deepEqual(r.allowed.map(x => x.url), [
    'https://www.site.co.th/api/public/menu.json', 'https://www.site.co.th/api/private/ok/x.json', 'https://cdn.other.com/lib.js',
    'https://www.site.co.th/api/public/other.json',
  ]);
  assert.deepEqual(r.disallowed.map(x => [x.url, x.reason, x.agent]), [
    ['https://www.site.co.th/api/private/user.json', 'not-fetched:robots', '*'],
    ['https://www.site.co.th/team/people.json', 'not-fetched:robots', 'ClaudeBot'],
    ['https://api.site.co.th/v1/items?page=2', 'not-fetched:robots', 'REVA'],
    ['https://shop.site.co.th/products.json', 'not-fetched:robots-unreachable', null],
  ]);
  // the log lines say what happened in plain words (never "robots.txt disallows robots-unreachable")
  const lines = r.disallowed.map(notFetchedText);
  assert.equal(lines[0], 'completion: not fetched (robots.txt disallows *): https://www.site.co.th/api/private/user.json');
  assert.match(lines[3], /^completion: not fetched \(robots\.txt of https:\/\/shop\.site\.co\.th could not be read \(network error[^)]*\); try again later\): https:\/\/shop\.site\.co\.th\/products\.json$/);
  assert.ok(!lines.some((l) => /disallows robots-unreachable/.test(l)));
  // one robots.txt per same-site origin, never one for a third-party host
  assert.deepEqual(asked.sort(), ['https://api.site.co.th/robots.txt', 'https://shop.site.co.th/robots.txt', 'https://www.site.co.th/robots.txt']);
});
