# Contributing to REVA

Thanks for helping. Bug reports, fixes and small, focused features are all welcome.

## Set up

You need Node.js 24 or newer, on macOS (Apple silicon) or Linux x64.

```sh
git clone https://github.com/thanwishdev/reva && cd reva
npm ci
node bin/reva.js doctor --install   # REVA's pinned headless browser, into ~/.reva, no sudo
npm test                            # the quick suite, the same one CI runs
```

`npm run test:unit` runs only the tests under `test/`, one at a time. `node bin/reva.js demo` is the fastest way to
see a change end to end: it reads REVA's bundled demo page offline.

## Ground rules

- **Tests use our own pages only.** Fixtures are pages written for this repository. Don't add a third-party site's
  HTML, images, fonts, text, recordings or measured values, in tests or anywhere else.
- **Say how you know.** Every number REVA prints is `exact`, `fitted` or `unknown`. A new value needs one of those
  labels, and an `unknown` needs its reason.
- **Keep the safety checks.** REVA reads `robots.txt` first, stops at walls, paces its requests and never clicks
  "accept" on a consent banner. A change that weakens any of these won't be merged.
- **Dependencies are pinned exactly.** `npm run check:pins` must pass. Please open an issue before adding one.
- **One change per pull request**, with a test that fails without it.

## Reporting a bug

Open an issue with the command you ran, what you expected, what happened, and the output of `reva doctor`. If the page
is public, include its URL. For a security problem, follow [`SECURITY.md`](SECURITY.md) instead.

## Licence

REVA is licensed under the MIT licence. Unless you say otherwise, anything you contribute is licensed under MIT too.