// Fit on open and `--all`: a small pool of worker threads, one motion at a time each. What a person clicks goes to the front.
import fs from 'node:fs';
import os from 'node:os';
import { Worker } from 'node:worker_threads';
import { fitFile, wasCut } from './fitone.js';
import { readPlan } from './stage.js';

/** A fit has its own budgets (at most about 13 s measured); this only catches a worker that hangs. */
export const FIT_LIMIT_MS = 120000;
export const defaultWorkers = () => Math.max(1, Math.min(6, os.cpus().length - 2));

export class FitPool {
  constructor(out, { workers = defaultWorkers(), limitMs = FIT_LIMIT_MS } = {}) {
    this.out = out; this.limitMs = limitMs; this.queue = []; this.jobs = new Map(); this.free = []; this.n = workers; this.all = new Set(); this.closed = false; this.nextId = 1;
    for (let i = 0; i < workers; i++) this.spawn();
  }

  spawn() {
    const w = new Worker(new URL('./fitworker.js', import.meta.url));
    this.all.add(w);
    w.on('message', (m) => {
      if (m.ready) { this.free.push(w); this.pump(); return; }
      const job = w.job; w.job = null; clearTimeout(w.limit);
      this.free.push(w);
      this.jobs.delete(job.key);
      if (m.error) job.no(new Error(m.error)); else job.ok(m);
      this.pump();
    });
    w.on('error', (e) => this.lost(w, e.message));
    return w;
  }

  lost(w, why) {
    this.all.delete(w);
    const job = w.job; w.job = null; clearTimeout(w.limit);
    this.free = this.free.filter((x) => x !== w);
    if (job) { this.jobs.delete(job.key); job.no(new Error(why)); }
    if (!this.closed) { this.spawn(); this.pump(); }
  }

  /** @returns {Promise<{ms:number, cut:string[], cached?:boolean}>} */
  ask(c, lead, { front = false, deep = false } = {}) {
    if (fs.existsSync(fitFile(this.out, c, lead)) && !(deep && wasCut(this.out, c, lead))) return Promise.resolve({ ms: 0, cut: [], cached: true });
    const key = `${c}|${lead}`, have = this.jobs.get(key);
    if (have) { if (front) { const i = this.queue.indexOf(have); if (i > 0) { this.queue.splice(i, 1); this.queue.unshift(have); } } return have.promise; }
    const job = { key, c, lead, deep };
    job.promise = new Promise((ok, no) => { job.ok = ok; job.no = no; });
    this.jobs.set(key, job);
    if (front) this.queue.unshift(job); else this.queue.push(job);
    this.pump();
    return job.promise;
  }

  pump() {
    while (this.free.length && this.queue.length) {
      const w = this.free.shift(), job = this.queue.shift();
      w.job = job;
      w.limit = setTimeout(() => { w.terminate(); this.lost(w, `the fit ran past ${Math.round(this.limitMs / 1000)} s and was stopped`); }, this.limitMs);
      w.postMessage({ id: job.key, out: this.out, c: job.c, lead: job.lead, deep: job.deep });
    }
  }

  /** How many are waiting, so background work can stay out of the way of a click. */
  get waiting() { return this.queue.length; }
  async close() { this.closed = true; for (const j of this.queue) j.no(new Error('closed')); this.queue = []; await Promise.all([...this.all].map((w) => { clearTimeout(w.limit); return w.terminate(); })); }
}

/** Every motion of the scan, best ranked first within each chapter: [{c, lead, rank}]. */
export function allMotions(out, chapters) {
  const list = [];
  for (const c of chapters) {
    const p = readPlan(out, c);
    if (p.pageKey) list.push({ c, lead: 'page', rank: 0 });
    if (p.gl) list.push({ c, lead: 'gl', rank: 0 });
    for (const e of p.entries) list.push({ c, lead: e.lead, rank: e.rank });
  }
  return list;
}
