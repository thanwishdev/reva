// Freeze config for the fixture. `port` is the fixture server's port; the host names resolve only through the recording-time host rules.
export function fixtureConfig(port, overrides = {}) {
  return {
    id: 'freeze-fixture',
    startUrl: `http://site.fixture.test:${port}/`,
    hostRules: 'MAP *.fixture.test 127.0.0.1', // record time only; replay runs with every name unresolvable
    block: 'telemetry\\.fixture\\.test',
    classes: {
      A: { viewport: { width: 1000, height: 700 } },
      E: { viewport: { width: 390, height: 700 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
    },
    settleMs: 2200, // > the 1.2 s late fetch (T4)
    // Used by the replay check only: the recording does NOT click, so the tab chunks are exactly what URL completion must supply.
    verifySteps: [{ click: '[data-tab="b"]' }, { wait: 250 }, { click: '[data-tab="c"]' }, { wait: 250 }],
    probe: '() => ({ consent: document.getElementById("consent").textContent, flag: document.getElementById("flag").textContent, tab: document.getElementById("tab-body").textContent, imgs: [...document.querySelectorAll("#gallery img")].map(i => i.complete && i.naturalWidth > 0 ? 1 : 0) })',
    expect: { finalUrlPath: '/home' },
    ...overrides,
  };
}
