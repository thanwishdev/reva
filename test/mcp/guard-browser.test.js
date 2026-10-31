// The live-page guard in a real headless Chromium (plan item 1.5, MCP part). Fully local: "public.test" and "rebind.test" are
// names only the guard proxy knows (an injected lookup says they are public, 93.184.216.34), and the injected dialer maps that
// one address to a loopback test server. Any other dial is refused, so nothing can reach the internet, and the browser itself
// resolves nothing (all traffic goes to the guard proxy; DNS sinkhole as a second wall).
// What it proves: a real HTTP redirect (top level and subresource), a WebSocket and a rebinding name cannot reach a local
// service, while the public page, its subresources and its WebSocket still work through the proxy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import dgram from 'node:dgram';
import { sandbox } from './helpers.js';
sandbox('guard-browser');
const { startGuardProxy, NO_UDP_APIS_SCRIPT } = await import('../../src/mcp/guard.js');
const { launchBrowser } = await import('../../src/browser/launch.js');
const { runTool } = await import('../../src/mcp/index.js');

const FAKE_PUBLIC = '93.184.216.34';
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

async function world() {
  const hits = []; const pubHits = []; const dials = [];
  const secret = http.createServer((q, r) => { hits.push(`HTTP ${q.url}`); r.writeHead(200, { 'content-type': 'text/html' }); r.end('<title>SECRET-LOCAL-SERVICE</title>secret'); });
  secret.on('upgrade', (q, s) => { hits.push(`WS ${q.url}`); s.destroy(); });
  const S = await listen(secret);
  const pub = http.createServer((q, r) => {
    pubHits.push(q.url);
    if (q.url === '/redir') { r.writeHead(302, { location: `http://127.0.0.1:${S}/via-top-redirect` }); return r.end(); }
    if (q.url === '/redir2') { r.writeHead(302, { location: `http://127.0.0.1:${S}/via-sub-redirect` }); return r.end(); }
    if (q.url === '/redir-meta') { r.writeHead(302, { location: `http://169.254.169.254:${S}/latest/meta-data` }); return r.end(); }
    if (q.url === '/ok.png') { r.writeHead(200, { 'content-type': 'image/gif' }); return r.end(Buffer.from('R0lGODlhAQABAAAAACw=', 'base64')); }
    r.writeHead(200, { 'content-type': 'text/html' });
    r.end(`<title>PUBLIC</title><img src="/ok.png"><img src="/redir2"><img src="http://127.0.0.1:${S}/direct">
<script>
const out = (k, v) => { document.title += ' ' + k + '=' + v; };
try { const w = new WebSocket('ws://127.0.0.1:${S}/via-websocket'); w.onerror = () => out('localws', 'err'); } catch (e) { out('localws', 'throw'); }
try { const w2 = new WebSocket('ws://' + location.host + '/pub-ws'); w2.onerror = () => out('pubws', 'err'); } catch (e) {}
fetch('http://rebind.test:${pubPortRef.p}/one', { mode: 'no-cors' }).then(() => out('rebind1', 'ok'), () => out('rebind1', 'err'))
  .then(() => fetch('http://rebind.test:${pubPortRef.p}/two', { mode: 'no-cors' })).then((x) => out('rebind2', x ? 'ok' : 'err'), () => out('rebind2', 'err'));
</script>`);
  });
  pub.on('upgrade', (q, s) => { pubHits.push(`WS ${q.url}`); s.destroy(); });
  const pubPortRef = { p: 0 };
  const P = await listen(pub); pubPortRef.p = P;
  let rebindCalls = 0;
  const lookup = async (h) => {
    if (h === 'public.test') return [{ address: FAKE_PUBLIC }];
    if (h === 'rebind.test') return [{ address: rebindCalls++ === 0 ? FAKE_PUBLIC : '127.0.0.1' }]; // public first, loopback next (TTL 0)
    throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
  };
  const dial = (ip, port) => {
    dials.push(`${ip}:${port}`);
    if (ip === FAKE_PUBLIC) return net.connect({ host: '127.0.0.1', port });
    const s = new net.Socket(); process.nextTick(() => s.destroy(new Error('test dial refused'))); return s; // never the internet
  };
  return { hits, pubHits, dials, S, P, lookup, dial, close: () => { secret.close(); pub.close(); } };
}

test('guard proxy in a real browser: redirects, WebSockets and rebinding cannot reach a local service', { timeout: 90000 }, async () => {
  const w = await world();
  const proxy = await startGuardProxy({ lookup: w.lookup, dial: w.dial, ports: [w.P] });
  const h = await launchBrowser({ args: [...proxy.args, '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
  let topTitle, metaTitle, pageTitle;
  try {
    await h.page.goto(`http://public.test:${w.P}/redir`, { timeout: 20000 }).catch(() => {});
    topTitle = await h.page.title().catch(() => '');
    await h.page.goto(`http://public.test:${w.P}/redir-meta`, { timeout: 20000 }).catch(() => {});
    metaTitle = await h.page.title().catch(() => '');
    await h.page.goto(`http://public.test:${w.P}/page`, { timeout: 20000 });
    await h.page.waitForFunction(() => /rebind2=/.test(document.title) && /localws=/.test(document.title), null, { timeout: 15000 }).catch(() => {});
    await h.page.waitForTimeout(500);
    pageTitle = await h.page.title();
  } finally { await h.close(); await proxy.close(); w.close(); }
  assert.notEqual(topTitle, 'SECRET-LOCAL-SERVICE', 'top-level redirect to loopback was loaded');
  assert.notEqual(metaTitle, 'SECRET-LOCAL-SERVICE');
  assert.deepEqual(w.hits, [], `the local service was reached: ${w.hits.join(', ')}`);
  assert.match(pageTitle, /^PUBLIC/, 'the public page itself loads through the proxy');
  // rebinding: the first answer (public) reaches the server, the second (127.0.0.1, same name) never leaves the proxy
  assert.ok(w.pubHits.includes('/one'), 'first answer (public) passes'); assert.ok(!w.pubHits.includes('/two'), 'the rebound answer is refused');
  assert.match(pageTitle, /localws=err/);
  assert.ok(w.pubHits.includes('/ok.png'), 'a public subresource loads');
  assert.ok(w.pubHits.includes('WS /pub-ws'), 'a public WebSocket is tunnelled (CONNECT) and reaches its server');
  assert.ok(w.dials.every((d) => d.startsWith(`${FAKE_PUBLIC}:`)), `dialled only the checked address: ${w.dials.join(', ')}`);
  const why = proxy.blocked.map((b) => `${b.host}: ${b.why}`).join(' | ');
  for (const re of [/127\.0\.0\.1 is a loopback/, /169\.254\.169\.254 is a link-local/, /rebind\.test resolves to 127\.0\.0\.1/]) assert.match(why, re);
});

test('look on a live URL launches the browser behind the guard proxy (redirect to loopback refused end to end)', { timeout: 180000 }, async () => {
  const w = await world();
  try {
    const r = await runTool('look', { url: `http://public.test:${w.P}/redir` }, { lookup: w.lookup, dial: w.dial });
    assert.deepEqual(w.hits, [], `the local service was reached: ${w.hits.join(', ')}`);
    assert.ok(w.pubHits.includes('/redir'), 'the page was requested through the proxy');
    console.log('look:', r.ok ? `${r.summary.headline} | stats ${JSON.stringify(r.summary.stats)}` : JSON.stringify(r.error).slice(0, 300));
    if (r.ok) assert.ok(r.summary.stats.blocked_requests >= 1, 'the redirect hop is counted as blocked');
    else assert.ok(['analysis_failed', 'tool_error'].includes(r.error.code), JSON.stringify(r.error).slice(0, 300));
  } finally { w.close(); }
});

// UDP sentinel: WebRTC sends STUN / TURN-over-UDP straight from the browser (no proxy, no route sees it). A loopback UDP
// socket stands for a local service; a public page names it as its STUN / TURN server.
async function udpWorld() {
  const udp = []; const u = dgram.createSocket('udp4');
  u.on('message', (m, ri) => udp.push(`${m.length}B from ${ri.address}:${ri.port}`));
  await new Promise((r) => u.bind(0, '127.0.0.1', r)); const U = u.address().port;
  const page = `<title>P</title><div id=b style="width:200px;height:200px;background:red;transition:transform .4s ease-out">x</div><script>
requestAnimationFrame(() => requestAnimationFrame(() => { document.getElementById('b').style.transform = 'translateX(300px)'; }));
const out = (k, v) => { document.title += ' ' + k + '=' + v; };
(async () => {
  if (typeof RTCPeerConnection !== 'function') return out('rtc', 'none');
  const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:127.0.0.1:${U}' }, { urls: 'turn:127.0.0.1:${U}?transport=udp', username: 'u', credential: 'p' }] });
  const kinds = new Set(); pc.onicecandidate = (e) => { if (e.candidate) kinds.add(e.candidate.type + '/' + e.candidate.protocol); };
  pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') out('rtc', [...kinds].join(',') || 'nocand'); };
  pc.createDataChannel('x'); await pc.setLocalDescription(await pc.createOffer());
})().catch((e) => out('rtc', 'throw'));
</script>`;
  const pub = http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end(page); });
  const P = await listen(pub);
  const lookup = async (h) => { if (h === 'public.test') return [{ address: FAKE_PUBLIC }]; throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }); };
  const dial = (ip, port) => { if (ip === FAKE_PUBLIC) return net.connect({ host: '127.0.0.1', port }); const s = new net.Socket(); process.nextTick(() => s.destroy(new Error('test dial refused'))); return s; };
  return { udp, P, lookup, dial, close: () => { pub.close(); u.close(); } };
}

async function rtcRun(w, { prefs, initScript }) {
  const proxy = await startGuardProxy({ lookup: w.lookup, dial: w.dial, ports: [w.P] });
  const h = await launchBrowser({ args: [...proxy.args, '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'], prefs });
  try {
    if (initScript) await h.context.addInitScript({ content: initScript });
    await h.page.goto(`http://public.test:${w.P}/`, { timeout: 20000 });
    await h.page.waitForFunction(() => /rtc=/.test(document.title), null, { timeout: 10000 }).catch(() => {});
    await h.page.waitForTimeout(800);
    return await h.page.title();
  } finally { await h.close(); await proxy.close(); }
}

test('WebRTC UDP: the sentinel sees datagrams without the pref, none with the guard prefs, none with the API removal', { timeout: 120000 }, async () => {
  const w = await udpWorld();
  try {
    const bare = await rtcRun(w, { prefs: null }); const bareHits = w.udp.length;
    assert.ok(bareHits > 0, `control: without the pref WebRTC reaches the loopback UDP socket (title "${bare}"); else this test proves nothing`);
    w.udp.length = 0;
    const proxy = await startGuardProxy({ lookup: w.lookup, dial: w.dial, ports: [w.P] }); const prefs = proxy.prefs; await proxy.close();
    const pref = await rtcRun(w, { prefs });
    assert.deepEqual(w.udp, [], `the WebRTC pref alone: datagrams reached loopback (title "${pref}")`);
    assert.doesNotMatch(pref, /host\/udp|srflx|relay/, 'no UDP candidate is gathered');
    const gone = await rtcRun(w, { prefs: null, initScript: NO_UDP_APIS_SCRIPT });
    assert.match(gone, /rtc=none/, 'the API removal script leaves no RTCPeerConnection');
    assert.deepEqual(w.udp, []);
  } finally { w.close(); }
});

test('look on a live URL: a page\'s WebRTC cannot send UDP to loopback (zero datagrams)', { timeout: 180000 }, async () => {
  const w = await udpWorld();
  try {
    const r = await runTool('look', { url: `http://public.test:${w.P}/`, interaction: 'load' }, { lookup: w.lookup, dial: w.dial });
    console.log('look:', r.ok ? r.summary.headline : JSON.stringify(r.error).slice(0, 300));
    assert.deepEqual(w.udp, [], `UDP reached loopback during look: ${w.udp.slice(0, 4).join(', ')}`);
  } finally { w.close(); }
});

// A frozen archive is third-party site code too: the replay walls (catch-all route, DNS sinkhole, dead proxy) stop TCP only,
// so the archived page's WebRTC must meet the same no-UDP pref and API removal as a live page (runLook applies both to every source).
test('look on a frozen archive: the archived page\'s WebRTC cannot send UDP to loopback (zero datagrams)', { timeout: 180000 }, async () => {
  const w = await udpWorld();
  const fs = await import('node:fs'); const path = await import('node:path');
  const arch = path.join(process.env.REVA_HOME, 'archives', 'udp-archive'); fs.mkdirSync(path.join(arch, 'har'), { recursive: true });
  const har = path.join(arch, 'har', 'A.har.zip');
  try {
    // record our own test page into a HAR; this recording browser has no guard on purpose, so its datagrams are the control
    const h = await launchBrowser({ args: ['--host-resolver-rules=MAP public.test 127.0.0.1'], context: { recordHar: { path: har }, viewport: { width: 1440, height: 900 } } });
    try { await h.page.goto(`http://public.test:${w.P}/`, { waitUntil: 'load', timeout: 20000 }); await h.page.waitForFunction(() => /rtc=/.test(document.title), null, { timeout: 10000 }).catch(() => {}); await h.page.waitForTimeout(500); } finally { await h.close(); }
    const control = w.udp.length; w.udp.length = 0;
    assert.ok(control > 0, 'control: the unguarded recording browser reaches the loopback UDP socket; else this test proves nothing');
    fs.copyFileSync(har, path.join(arch, 'har', 'all.har.zip'));
    const target = path.join(arch, 'target.json');
    fs.writeFileSync(target, JSON.stringify({ id: 'udp-archive', archive: arch, startUrl: `http://public.test:${w.P}/`, classes: { A: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 } }, seed: 1 }));
    const r = await runTool('look', { archive: target, interaction: 'load' }, {});
    console.log('look (archive):', r.ok ? r.summary.headline : JSON.stringify(r.error).slice(0, 300));
    assert.ok(r.ok, 'the archive replays and is analysed');
    await new Promise((res) => setTimeout(res, 500));
    assert.deepEqual(w.udp, [], `UDP reached loopback during the archive analysis: ${w.udp.slice(0, 4).join(', ')}`);
  } finally { w.close(); }
});
