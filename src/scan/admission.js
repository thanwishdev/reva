// Admission check (PLAN §5/§6): can this machine run a scan at all? A small, honest stop, never a silent drop of data.
// A scan is one browser and one thread at a time (PLAN §4), so the floors are low; below them the scan stops with the
// reason and how to go on, exit code 3, and the ledger says what was left.
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

export const FLOORS = { freeGb: 5, ramGb: 6, cores: 2 };
export const EXIT_ADMISSION = 3;
/** While a scan runs, it stops under this much free disk (it starts with FLOORS.freeGb: pictures and the archive need room). */
export const RUN_FREE_GB = 2;
/** Memory one recording may take (browser and Node, the worst page measured, rounded up). The second lane needs this much free. */
export const LANE_GB = 3;

/** Free bytes on the volume holding `dir` (nearest existing parent), or null when the platform cannot say. */
export function freeDiskBytes(dir) {
  let d = dir;
  while (d && !fs.existsSync(d)) { const p = d.slice(0, d.lastIndexOf('/')) || '/'; if (p === d) break; d = p; }
  try { const s = fs.statfsSync(d); return Number(s.bavail) * Number(s.bsize); } catch { return null; }
}

/** Physical memory that a browser can still take: free + reclaimable pages is not portable, so the total is used
 * with the free figure as a hint only (macOS keeps free low by design). */
export function ramGb() { return os.totalmem() / 1e9; }

/** Memory that can be had now, in GB, or null. macOS counts free, inactive, speculative and purgeable pages; elsewhere the kernel's own figure. */
export function availableGb({ run = execFileSync, platform = process.platform, free = os.freemem } = {}) {
  if (platform !== 'darwin') return +(free() / 1e9).toFixed(1);
  try {
    const t = run('/usr/bin/vm_stat', [], { encoding: 'utf8' });
    const page = +(/page size of (\d+)/.exec(t)?.[1]) || 16384;
    const pages = (name) => +(new RegExp(`Pages ${name}:\\s+(\\d+)`).exec(t)?.[1]) || 0;
    return +(((pages('free') + pages('inactive') + pages('speculative') + pages('purgeable')) * page) / 1e9).toFixed(1);
  } catch { return null; }
}

/**
 * How many viewports record at once: two when there are the cores and the memory for a second browser, else one.
 * Lanes change the time only, never what is recorded.
 * @returns {{lanes:number, why:string}}
 */
export function lanesFor({ cores, availGb, ask = null }) {
  if (ask === 1) return { lanes: 1, why: 'one viewport at a time, as asked' };
  if (cores < 4) return { lanes: 1, why: `one viewport at a time: ${cores} cores` };
  if (availGb != null && availGb < 2 * LANE_GB) return { lanes: 1, why: `one viewport at a time: ${availGb} GB of memory is free (two need ${2 * LANE_GB})` };
  return { lanes: 2, why: 'desktop and phone record side by side' };
}

/**
 * What a scan will take, said before it starts. From whole scans of three sites (2 Nov, M5, 15 cores): 5 to 17 min per recorded
 * page one viewport at a time; two lanes take about 0.75 of that. A slower machine takes longer; the range says so, it is no promise.
 */
export function estimateLine({ pages, lanes }) {
  const f = lanes > 1 ? 0.75 : 1, lo = Math.round(pages * 5 * f), hi = Math.round(pages * 17 * f);
  return `${pages} page${pages === 1 ? '' : 's'} to record: about ${lo} to ${hi} minutes on a fast machine, and up to 3 GB of disk while it runs`;
}

/** The check between units of a running scan: the reason to stop, or null. Finished units are kept, so the same command goes on. */
export function roomNow({ dir, env = {}, floorGb = RUN_FREE_GB }) {
  const freeBytes = env.freeBytes !== undefined ? env.freeBytes : freeDiskBytes(dir);
  if (freeBytes != null && freeBytes / 1e9 < floorGb) return `only ${(freeBytes / 1e9).toFixed(1)} GB of disk is left where the scan writes (it stops under ${floorGb} GB)`;
  return null;
}

/**
 * @param {{dir:string, floors?:Partial<typeof FLOORS>, env?:{freeBytes?:number|null, ramGb?:number, cores?:number}}} o
 * @returns {{ok:boolean, reason:string|null, resume:string|null, measured:{freeGb:number|null, ramGb:number, cores:number}}}
 */
export function admit({ dir, floors = {}, env = {} } = {}) {
  const f = { ...FLOORS, ...floors };
  const freeBytes = env.freeBytes !== undefined ? env.freeBytes : freeDiskBytes(dir);
  const ram = env.ramGb ?? ramGb();
  const cores = env.cores ?? os.availableParallelism?.() ?? os.cpus().length;
  const measured = { freeGb: freeBytes == null ? null : +(freeBytes / 1e9).toFixed(1), ramGb: +ram.toFixed(1), cores };
  const why = [];
  if (measured.freeGb != null && measured.freeGb < f.freeGb) why.push(`only ${measured.freeGb} GB of disk is free where the scan writes (needs ${f.freeGb} GB)`);
  if (ram < f.ramGb) why.push(`this machine has ${measured.ramGb} GB of memory (a scan needs ${f.ramGb} GB: a browser plus the recorded rows)`);
  if (cores < f.cores) why.push(`this machine has ${cores} core (a scan needs ${f.cores})`);
  if (!why.length) return { ok: true, reason: null, resume: null, measured };
  return { ok: false, reason: why.join('; '), resume: 'free the resource and run the same command again; a finished page is kept and not recorded twice', measured };
}
