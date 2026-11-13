# Changelog

Notable changes to REVA. Versions follow [semantic versioning](https://semver.org).

## 0.1.0

The first public release.

- **`reva look <url>`** records one page during one action: load, scroll, hover or click, optionally after one click
  first. It records on a virtual 120 fps clock, so a busy machine doesn't change the timing. It reads declared motion
  exactly from CSS, Web Animations, GSAP, Lenis, Swiper, Lottie, Locomotive and anime.js. Everything else is fitted as
  a tween, spring, scroll link, stagger or loop. Every value is marked `exact`, `fitted` or `unknown`.
- **`--card`** writes the motion card: one offline HTML file that replays the page with each moving element outlined
  and plots each motion against its fitted law, in light or dark.
- **`--code`** prints code for CSS, GSAP, Motion, Lenis, requestAnimationFrame and React Spring. Each stack says how
  faithful its code is, or that it can't express the motion.
- **`reva design <url>`** reads fonts, the type scale, colours and contrast, spacing, radii, shadows and breakpoints.
  `--tokens` writes them as design tokens.
- **`reva compare`** looks at two pages the same way and shows how their motion differs.
- **`reva scan <url>`** records one page for each template of a site, on desktop and phone. It writes a card of the
  site's moves, a `moves.json` and a ledger of what was not captured. It reads `robots.txt` first, waits at least
  500 ms between requests to a host and stops on a 429.
- **`reva mcp`** is an MCP server with 11 tools. Text from a page comes back marked as untrusted.
- **`reva demo`** reads REVA's bundled demo page offline and writes its motion card.
- **`reva doctor --install`** downloads REVA's pinned headless browser, sha256-checked, with no sudo.

It runs on macOS on Apple silicon and Linux x64, with Node.js 24 or newer.
