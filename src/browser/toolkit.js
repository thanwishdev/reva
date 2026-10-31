// Toolkit = browser build + Playwright library, chosen together (PLAN M1 D2; every take records which one ran).
// t147 is the research toolkit (all W2G1-2 and ARCH golden traces). t155 is the D2 candidate, installed privately
// under <data root>/out/toolkit (never into the user's own browser caches).
import path from 'node:path';
import { createRequire } from 'node:module';
import { privateRoot } from '../util/paths.js';
import { PINNED_BROWSER } from './engines.js';

const require = createRequire(import.meta.url);

export function toolkits(env = process.env) {
  const priv = path.join(privateRoot(env), 'out', 'toolkit');
  return {
    t147: { id: 't147', browser: PINNED_BROWSER, cache: null, playwright: 'playwright-core' },
    t155: { id: 't155', browser: '155.0.8059.79', cache: path.join(priv, 'puppeteer'), playwright: path.join(priv, 'pw-1.64.1', 'node_modules', 'playwright-core') },
  };
}

/** Default toolkit: the D2 decision (docs/DECISIONS.md D-M1-2). Override with REVA_TOOLKIT. */
export const DEFAULT_TOOLKIT = 't147';

export function resolveToolkit(id, env = process.env) {
  const all = toolkits(env);
  const k = id || env.REVA_TOOLKIT || DEFAULT_TOOLKIT;
  if (!all[k]) throw new Error(`unknown toolkit "${k}" (known: ${Object.keys(all).join(', ')})`);
  return all[k];
}

const cache = new Map();
/** Load the Playwright library of a toolkit; returns { chromium, version }. */
export async function loadPlaywright(tk) {
  if (cache.has(tk.id)) return cache.get(tk.id);
  const pkgPath = require.resolve(tk.playwright + '/package.json');
  const version = require(pkgPath).version;
  const mod = require(path.dirname(pkgPath));
  const r = { chromium: mod.chromium, version };
  cache.set(tk.id, r);
  return r;
}
