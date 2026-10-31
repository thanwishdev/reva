// Values measured on captured sites that a lab must never reuse as its own parameters. The list is site-derived, so it is
// kept outside the repository; point REVA_BANNED_VALUES at its JSON file to run the "own parameters only" checks.
// Shape: { beziers: [[x1,y1,x2,y2]...], alpha: [..], durationsMs: [..], spring: {k,c,m}, stagger: {base,step},
//          scroll: {smoothstepSpanVh, scrubVh, m02Bounds: [b0,b1]}, strings: [regex source...] }
import fs from 'node:fs';

export function loadBanned(env = process.env) {
  if (!env.REVA_BANNED_VALUES) return null;
  return JSON.parse(fs.readFileSync(env.REVA_BANNED_VALUES, 'utf8'));
}
export const BANNED = loadBanned();
export const bannedSkip = BANNED ? false : 'REVA_BANNED_VALUES not set (the list of values a lab must not reuse is kept outside the repo)';
