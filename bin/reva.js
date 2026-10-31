#!/usr/bin/env node
import { main } from '../src/cli.js';
import { exitFlushed } from '../src/util/exit.js';
// Errors that carry a code were written for the person at the keyboard (bad data folder, browser not installed, ...): print the
// message only. Anything else is a bug and keeps its stack.
const friendly = (e) => e && typeof e.code === 'string' && ['bad_data_root', 'bad_engine', 'engine_unavailable', 'browser_missing', 'blocked_robots', 'blocked_wall', 'preflight_failed', 'timeout', 'navigation_failed'].includes(e.code);
main(process.argv.slice(2)).then(code => exitFlushed(code), e => { console.error(friendly(e) ? `reva: ${e.message}` : (e.stack || e)); exitFlushed(1); });
