import test from 'node:test';
import assert from 'node:assert/strict';
import {
  UA, parseRobots, robotsAllows, robotsVerdict, detectWall, detectConsent, CMP_RULES, REJECT_TEXTS, preflight,
} from '../../src/safety/index.js';

const U = 'https://example.com/work/a';

test('robots: star disallow all', () => {
  const v = robotsVerdict('User-agent: *\nDisallow: /\n', [U]);
  assert.equal(v.star, 'disallow');
  assert.equal(v.blocked, true);
  assert.equal(v.reason, 'robots:star');
});

test('robots: star allow + ClaudeBot disallow', () => {
  const v = robotsVerdict('User-agent: *\nAllow: /\n\nUser-agent: ClaudeBot\nDisallow: /\n', [U]);
  assert.equal(v.star, 'allow');
  assert.equal(v.anthropicAgent, 'ClaudeBot');
  assert.equal(v.blocked, true);
  assert.equal(v.reason, 'robots:anthropic');
});

test('robots: anthropic-ai group', () => {
  const v = robotsVerdict('User-agent: anthropic-ai\nDisallow: /\n', [U]);
  assert.equal(v.anthropicAgent, 'anthropic-ai');
  assert.equal(v.blocked, true);
});

test('robots: Claude-User group', () => {
  const v = robotsVerdict('User-agent: Claude-User\nDisallow: /work\n', [U]);
  assert.equal(v.anthropicAgent, 'Claude-User');
  assert.equal(robotsVerdict('User-agent: Claude-User\nDisallow: /work\n', ['https://example.com/about']).blocked, false);
});

test('robots: wildcard in path', () => {
  const p = parseRobots('User-agent: *\nDisallow: /private/*/secret\n');
  assert.equal(robotsAllows(p, 'x', '/private/a/secret').allowed, false);
  assert.equal(robotsAllows(p, 'x', '/private/a/public').allowed, true);
});

test('robots: $ anchor', () => {
  const p = parseRobots('User-agent: *\nDisallow: /*.json$\n');
  assert.equal(robotsAllows(p, 'x', '/a/b.json').allowed, false);
  assert.equal(robotsAllows(p, 'x', '/a/b.json?x=1').allowed, true);
  assert.equal(robotsAllows(p, 'x', '/a/b.jsonx').allowed, true);
});

test('robots: longest match wins, Allow wins ties', () => {
  const p = parseRobots('User-agent: *\nDisallow: /shop\nAllow: /shop/public\n');
  assert.equal(robotsAllows(p, 'x', '/shop/private').allowed, false);
  const r = robotsAllows(p, 'x', '/shop/public/a');
  assert.equal(r.allowed, true);
  assert.equal(r.rule, 'Allow: /shop/public');
  const tie = parseRobots('User-agent: *\nDisallow: /a\nAllow: /a\n');
  assert.equal(robotsAllows(tie, 'x', '/a').allowed, true);
});

test('robots: multiple user-agent lines share a group; comments and case', () => {
  const p = parseRobots('# hi\nUSER-AGENT: GPTBot\nuser-agent: CCBot # c\nDisallow: /\nFoo: bar\nSitemap: https://example.com/s.xml\n');
  assert.equal(p.groups.length, 1);
  assert.deepEqual(p.groups[0].agents, ['gptbot', 'ccbot']);
  assert.deepEqual(p.sitemaps, ['https://example.com/s.xml']);
});

test('robots: crawl-delay parsing', () => {
  const p = parseRobots('User-agent: *\nCrawl-delay: 7\nDisallow: /x\n');
  assert.equal(p.groups[0].crawlDelay, 7);
  assert.equal(robotsVerdict('User-agent: *\nCrawl-delay: 7\n\nUser-agent: ClaudeBot\nCrawl-delay: 12\n', [U]).crawlDelay, 12);
});

test('robots: empty Disallow allows all', () => {
  const v = robotsVerdict('User-agent: *\nDisallow:\n', [U]);
  assert.equal(v.blocked, false);
});

test('robots: GPTBot-only disallow is noted, not blocking', () => {
  const v = robotsVerdict('User-agent: GPTBot\nDisallow: /\n', [U]);
  assert.equal(v.blocked, false);
  assert.equal(v.others.GPTBot, 'disallow');
  assert.equal(v.others.CCBot, 'allow');
});

test('robots: no robots.txt allows everything; /robots.txt always allowed', () => {
  assert.equal(robotsVerdict(null, [U]).blocked, false);
  const p = parseRobots('User-agent: *\nDisallow: /\n');
  assert.equal(robotsAllows(p, 'x', '/robots.txt').allowed, true);
  assert.equal(robotsAllows(p, 'x', 'https://example.com/a').group, 'star');
});

test('robots: percent-encoding tolerant, specific group beats star', () => {
  const p = parseRobots('User-agent: *\nDisallow: /\n\nUser-agent: claudebot\nDisallow: /%7Eme\n');
  assert.equal(robotsAllows(p, 'ClaudeBot', '/~me/x').allowed, false);
  const ok = robotsAllows(p, 'ClaudeBot', '/other');
  assert.equal(ok.allowed, true);
  assert.equal(ok.group, 'specific');
});

const big = '<p>' + 'lorem ipsum dolor '.repeat(60) + '</p>';

test('wall: Cloudflare challenge', () => {
  const html = '<html><title>Just a moment...</title><body>Checking cloudflare <script src="/cdn-cgi/challenge-platform/h/b"></script></body></html>';
  assert.equal(detectWall({ status: 200, html }).kind, 'wall');
  assert.equal(detectWall({ status: 403, html: '' }).kind, 'wall');
});

test('wall: DataDome', () => {
  const html = '<html><body><iframe src="https://geo.captcha-delivery.com/captcha/"></iframe></body></html>';
  assert.deepEqual(detectWall({ status: 200, html }), { kind: 'wall', marker: 'datadome' });
});

test('wall: Akamai Access Denied', () => {
  const html = '<html><body><h1>Access Denied</h1>You don\'t have permission. Reference #18.abc.123</body></html>';
  assert.equal(detectWall({ status: 200, html }).marker, 'akamai');
});

test('login: password field, login path; geo: 451 and text', () => {
  const html = `<html><body>${big}<form><input type="password" name="p"></form></body></html>`;
  assert.equal(detectWall({ status: 200, html }).kind, 'login');
  assert.equal(detectWall({ status: 200, html: big, finalUrl: 'https://example.com/en/sign-in?next=/' }).kind, 'login');
  assert.equal(detectWall({ status: 451, html: '' }).kind, 'geo');
  assert.equal(detectWall({ status: 200, html: '<p>This site is not available in your region.</p>' }).kind, 'geo');
});

test('login: a content page with a sign-in form in its menu is not a wall; a login page and a password selector in CSS behave', () => {
  const nav = Array.from({ length: 40 }, (_, i) => `<a href="/p${i}">page ${i}</a>`).join(' ');
  const content = `<html><body><header><form><input type="email"><input type="password" name="password"></form></header>${nav}<p>${'real page text '.repeat(200)}</p></body></html>`;
  assert.equal(detectWall({ status: 200, html: content }), null, 'text 3 k + 40 links: a public page');
  const fewLinks = `<html><body><form><input type="password"></form><a href="/forgot">Forgot password</a><p>${'welcome back '.repeat(250)}</p></body></html>`;
  assert.equal(detectWall({ status: 200, html: fewLinks }).kind, 'login', 'much text but few links: still a login page');
  const css = `<html><head><style>input[type=password]{width:100%}</style></head><body>${nav}<p>${'text '.repeat(600)}</p></body></html>`;
  assert.equal(detectWall({ status: 200, html: css }), null, 'a password selector in CSS is not a field');
  assert.equal(detectWall({ status: 200, html: '<form><input type="password"></form>' }).kind, 'login');
  for (const ok of ['/authors/jane', '/author', '/authority', '/blog/loginless-future']) assert.equal(detectWall({ status: 200, html: big, finalUrl: 'https://example.com' + ok }), null, ok);
  for (const bad of ['/login', '/en/login/', '/auth', '/account/login', '/sign-in']) assert.equal(detectWall({ status: 200, html: big, finalUrl: 'https://example.com' + bad }).kind, 'login', bad);
});

test('consent: OneTrust script -> reject selector, never accept', () => {
  const html = '<script src="https://cdn.cookielaw.org/scripttemplates/otSDKStub.js"></script>';
  const c = detectConsent(html);
  assert.equal(c.cmp, 'OneTrust');
  assert.deepEqual(c.clicks, ['#onetrust-reject-all-handler']);
  assert.equal(CMP_RULES.length, 10);
  assert.ok(REJECT_TEXTS.includes('Refuser'));
});

test('consent: text fallback needs cookie context', () => {
  const c = detectConsent('<div>We use cookies.<button>Reject all</button><button>Accept all</button></div>');
  assert.deepEqual(c, { cmp: null, clicks: ['text="Reject all"'] });
  assert.deepEqual(detectConsent('<p>Decline the offer</p>').clicks, []);
});

test('normal page: no wall, no clicks', () => {
  const html = `<html><body><h1>Studio</h1>${big}</body></html>`;
  assert.equal(detectWall({ status: 200, html, finalUrl: 'https://example.com/' }), null);
  assert.deepEqual(detectConsent(html), { cmp: null, clicks: [] });
});

function fakeFetch(map) {
  const calls = [];
  const f = async (url, opts) => {
    calls.push({ url, ua: opts?.headers?.['user-agent'] });
    const r = map[url];
    if (r instanceof Error) throw r;
    if (!r) return { status: 404, url, headers: new Headers(), text: async () => '' };
    return { status: r.status ?? 200, url: r.url ?? url, headers: new Headers(), text: async () => r.body ?? '' };
  };
  f.calls = calls;
  return f;
}

test('preflight: end-to-end ok with redirect and consent', async () => {
  const f = fakeFetch({
    'https://example.com/robots.txt': { body: 'User-agent: GPTBot\nDisallow: /\n' },
    'https://example.com/': { url: 'https://www.example.org/home', body: `<html><script src="https://cdn.cookielaw.org/x.js"></script>${big}</html>` },
  });
  let t = 1000;
  const r = await preflight('https://example.com/', { fetchImpl: f, now: () => (t += 5) });
  assert.equal(r.verdict, 'ok');
  assert.equal(r.http, 200);
  assert.equal(r.redirectHost, 'www.example.org');
  assert.equal(r.robots.others.GPTBot, 'disallow');
  assert.equal(r.consent.cmp, 'OneTrust');
  assert.ok(r.robotsText.includes('GPTBot'));
  assert.ok(r.ms > 0);
  assert.equal(f.calls[0].ua, UA);
});

test('preflight: blocked robots, wall, failed network, failed http', async () => {
  const robots = await preflight('https://example.com/a', { fetchImpl: fakeFetch({ 'https://example.com/robots.txt': { body: 'User-agent: *\nDisallow: /\n' } }) });
  assert.equal(robots.verdict, 'blocked:robots');
  const wall = await preflight('https://example.com/', { fetchImpl: fakeFetch({ 'https://example.com/': { status: 403, body: 'no' } }) });
  assert.equal(wall.verdict, 'blocked:wall');
  const net = await preflight('https://example.com/', { fetchImpl: fakeFetch({ 'https://example.com/': new TypeError('fetch failed\nmore') }) });
  assert.equal(net.verdict, 'failed:network');
  assert.ok(!net.reason.includes('\n'));
  const http = await preflight('https://example.com/', { fetchImpl: fakeFetch({ 'https://example.com/': { status: 502, body: 'bad' } }) });
  assert.equal(http.verdict, 'failed:http');
});
