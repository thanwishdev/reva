# Security

## Supported versions

Security fixes go into the latest release of `reva-cli`.

## Reporting a vulnerability

Please don't open a public issue. Use GitHub's private report form instead: on the repository page, open
**Security**, then **Report a vulnerability**
(<https://github.com/thanwishdev/reva/security/advisories/new>).

Tell us what you found, how to reproduce it and which version you ran (`reva --version`). You'll get an answer within
a week.

## What counts

REVA opens pages you point it at in its own headless browser, and can serve its results to an AI agent over MCP. We
want to hear about anything that lets a page or a tool call:

- reach local addresses, or files outside REVA's output folder, without the documented opt-in (`--allow-local`);
- get page text to an agent without the untrusted mark;
- skip the `robots.txt` check or a wall stop without the documented flag;
- touch your own browser or its profile;
- make REVA install a browser that doesn't match its pinned sha256.
