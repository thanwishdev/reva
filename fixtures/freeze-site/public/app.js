'use strict';
// Planted traps live here. known-urls.json is the ground truth for what this file can request.

// T1: URL templates. A plain load+scroll asks for one width per slug, one hero variant, and one tab chunk.
const SLUGS = ['alpha', 'beta', 'gamma', 'omega'];
const TABS = ['a', 'b', 'c'];
const imgUrl = (slug, w) => `/img/${slug}-${w}.svg`;
const heroUrl = k => '/img/hero-' + k + '.svg';
async function loadTab(id) { return import(`/chunks/tab-${id}.js`); }
// A template that cannot be resolved statically (the hole is a runtime property): must end up in the unknowns ledger, never guessed.
function avatarUrl(state) { return `/api/user/${state.userId}/avatar.png`; }

function renderGallery() {
  const gallery = document.getElementById('gallery');
  const w = innerWidth > 700 ? 960 : 320;
  for (const slug of SLUGS) {
    const img = new Image();
    img.alt = slug + ' ' + w;
    img.src = imgUrl(slug, w);
    gallery.append(img);
  }
  const hero = new Image();
  hero.alt = 'hero';
  hero.src = heroUrl(matchMedia('(prefers-color-scheme: dark)').matches ? 'night' : 'day');
  gallery.append(hero);
}
new IntersectionObserver((entries, io) => { if (entries.some(e => e.isIntersecting)) { renderGallery(); io.disconnect(); } }, { rootMargin: '200px' })
  .observe(document.getElementById('gallery'));

for (const id of TABS) {
  document.querySelector(`[data-tab="${id}"]`).addEventListener('click', async () => {
    document.getElementById('tab-body').textContent = (await loadTab(id)).label;
  });
}
loadTab('a').then(m => { document.getElementById('tab-body').textContent = m.label; });

// T2: telemetry on a third-party host (blocked by the freeze). Failures are expected and ignored.
const TEL = location.protocol + '//telemetry.' + location.host.replace(/^site\./, '');
try { navigator.sendBeacon(TEL + '/track', 'v=1'); } catch {}
new Image().src = TEL + '/pixel.gif?v=1';
fetch(TEL + '/track', { method: 'POST', body: 'v=1', mode: 'no-cors', keepalive: true }).catch(() => {});

// T3: a POST whose answer depends on the exact body.
fetch('/api/consent', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ locale: 'en', v: 3 }) })
  .then(r => r.json()).then(j => { document.getElementById('consent').textContent = 'consent: ' + (j.consent || j.error); })
  .catch(() => { document.getElementById('consent').textContent = 'consent: failed'; });

// T4: a late request whose every failure is swallowed, so a missing archive entry leaves no visible error.
setTimeout(() => {
  fetch('/api/flags.json').then(r => r.json()).then(j => { document.getElementById('flag').textContent = 'flag: ' + j.banner; }).catch(() => {});
}, 1200);

// Something alive on the page (the project cares about motion): an rAF-driven counter next to a CSS animation.
let frames = 0;
(function tick() { document.getElementById('clock').textContent = String(++frames); requestAnimationFrame(tick); })();
window.__fixture = { avatarUrl }; // keeps the unresolvable template referenced
