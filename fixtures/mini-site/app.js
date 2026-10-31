// Own public-safe fixture. `#miss` requests a URL that is NOT in the recorded HAR, to prove the miss logger fires.
document.getElementById('title').dataset.ready = '1';
if (location.hash === '#miss') fetch('/not-recorded.json').catch(() => {});
