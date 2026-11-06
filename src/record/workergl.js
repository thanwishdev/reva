// WebGL in a worker (S1 6 Nov, gap 11): a canvas whose control went to a worker (transferControlToOffscreen) is drawn by code the page's
// recorder never sees. The page's Worker constructor (inpage.js, scan takes) starts each dedicated worker from a small bootstrap that runs
// this tap first and then the page's own script (classic: importScripts; module: import), so the tap is in before the worker's first line.
// (CDP auto-attach with waitForDebuggerOnStart came first: Playwright's own session resumes the worker, which then ran its first lines
// untapped.) The session attaches to the workers only to step them. The tap runs the worker on the page's virtual clock: performance.now, Date,
// timers and requestAnimationFrame advance only when the page steps, frame k at T_k on the same grid, so a worker frame is a page frame.
// What it records is the page recorder's light WebGL, per frame: programs (sources, uniform lists, ints), every float uniform (arrays by
// element), draws per program and target. Program and target ids start at `idBase` (1000, 2000, ...) so they never meet the page's.
// Read-only: every call goes through to the worker's own context unchanged.

/** The tap's source for one worker. @param {{t0:number, dt:number, epoch:number, k0:number, idBase:number, base?:string}} C */
export function workerGlSource(C) {
  return `(${workerTap.toString()})(${JSON.stringify(C)});`;
}
/** The tap as a function source the page keeps (window.__WR_WORKER_TAP), to call with its config in a worker's bootstrap. */
export const WORKER_TAP_SOURCE = workerTap.toString();

/* eslint-disable no-restricted-globals */
function workerTap(C) {
  if (self.__WRW) return;
  // the bootstrap is a blob, so the worker's own relative URLs are resolved against its real script (importScripts, fetch, XHR)
  if (C.base) {
    const abs = (u) => { try { return typeof u === 'string' && !/^[a-z][a-z0-9+.-]*:/i.test(u) ? new URL(u, C.base).href : u; } catch (e) { return u; } };
    try { const IS = self.importScripts; if (typeof IS === 'function') self.importScripts = (...a) => IS.apply(self, a.map(abs)); } catch (e) {}
    try { const F = self.fetch; if (typeof F === 'function') self.fetch = (u, ...a) => F.call(self, typeof u === 'string' ? abs(u) : u, ...a); } catch (e) {}
    try { const O = XMLHttpRequest.prototype.open; XMLHttpRequest.prototype.open = function (m, u, ...a) { return O.call(this, m, abs(u), ...a); }; } catch (e) {}
  }
  const OD = Date, MAXK = 1024, MAXROWS = 20000, MAXSRC = 200000, MAXP = 64;
  const r6 = (x) => Math.round(x * 1e6) / 1e6, Tk = (k) => r6(C.t0 + k * C.dt), SIG = (v) => +(+v).toPrecision(7);
  // the clock is the worker's own until it makes a WebGL context (most workers decode or compute and never draw: stepping them frame by
  // frame cost 7 ms a frame on a 3D portfolio site, 6 Nov); from then the page's virtual clock, once the session has said which frame it is (sync)
  const G = self.__WRW = { clocked: false, synced: false, idBase: C.idBase, k: C.k0, now: Tk(C.k0), timers: new Map(), tid: 1, rafs: new Map(), rid: 1, seq: 1, rows: [], dropped: { rows: 0, keys: 0, programs: 0 },
    progs: [], progOf: new WeakMap(), shaders: new WeakMap(), locs: new WeakMap(), vals: {}, sent: {}, keys: 0, draws: {}, seqd: 0, ctxs: [], ctxIdx: new WeakMap(), cur: new WeakMap(), fbId: new WeakMap(), fbN: 0, curFb: new WeakMap(), ints: {} };
  // ---- the virtual clock: the page steps it (steps(ks)) once the worker draws WebGL; before, every call goes to the worker's own
  const RPN = performance.now.bind(performance), ST = self.setTimeout.bind(self), SI = self.setInterval.bind(self), CT = self.clearTimeout.bind(self), CI = self.clearInterval.bind(self);
  const RAF = self.requestAnimationFrame ? self.requestAnimationFrame.bind(self) : null, CAF = self.cancelAnimationFrame ? self.cancelAnimationFrame.bind(self) : null, VID = 1e9;
  performance.now = () => (G.clocked ? G.now : RPN());
  const FD = function (...a) { const now = G.clocked ? C.epoch + G.now : OD.now(); if (!new.target) return new OD(now).toString(); return a.length ? new OD(...a) : new OD(now); };
  FD.prototype = OD.prototype; FD.now = () => (G.clocked ? C.epoch + G.now : OD.now()); FD.parse = OD.parse; FD.UTC = OD.UTC; self.Date = FD;
  self.setTimeout = (cb, ms, ...a) => { if (!G.clocked) return ST(cb, ms, ...a); const id = VID + G.tid++; G.timers.set(id, { due: r6(G.now + Math.max(0, +ms || 0)), cb, a, every: null, seq: G.seq++ }); return id; };
  self.setInterval = (cb, ms, ...a) => { if (!G.clocked) return SI(cb, ms, ...a); const id = VID + G.tid++, every = Math.max(1, +ms || 0); G.timers.set(id, { due: r6(G.now + every), cb, a, every, seq: G.seq++ }); return id; };
  self.clearTimeout = (id) => { if (id >= VID) G.timers.delete(id); else CT(id); };
  self.clearInterval = (id) => { if (id >= VID) G.timers.delete(id); else CI(id); };
  self.requestAnimationFrame = (cb) => { if (!G.clocked && RAF) return RAF(cb); const id = VID + G.rid++; G.rafs.set(id, cb); return id; };
  self.cancelAnimationFrame = (id) => { if (id >= VID) G.rafs.delete(id); else if (CAF) CAF(id); };
  // the first WebGL context starts the page's clock in this worker (its frame comes with sync)
  try { const OG = OffscreenCanvas.prototype.getContext; OffscreenCanvas.prototype.getContext = function (type, ...a) { if (/webgl/i.test(String(type)) && !G.clocked) G.clocked = true; return OG.call(this, type, ...a); }; } catch (e) {}
  G.sync = (k) => { G.k = k; G.now = Tk(k); G.synced = true; return true; };
  const call = (cb, a) => { try { if (typeof cb === 'function') cb(...a); } catch (e) { /* the worker's own error */ } };
  const mc = new MessageChannel(), mq = []; mc.port1.onmessage = () => { const r = mq.shift(); if (r) r(); };
  const macro = () => new Promise((r) => { mq.push(r); mc.port2.postMessage(0); });
  const next = (target) => { let best = null; for (const [id, t] of G.timers) if (t.due <= target && (!best || t.due < best[1].due || (t.due === best[1].due && t.seq < best[1].seq))) best = [id, t]; return best; };
  G.step = async (k) => {
    const target = Tk(k);
    for (let n = 0; n < 1000; n++) { const nx = next(target); if (!nx) break; const [id, t] = nx; G.now = Math.max(G.now, t.due); if (t.every) { t.due = r6(t.due + t.every); t.seq = G.seq++; } else G.timers.delete(id); call(t.cb, t.a); await macro(); }
    G.k = k; G.now = target;
    const cbs = [...G.rafs.values()]; G.rafs.clear();
    for (const cb of cbs) { call(cb, [G.now]); await null; }
    await macro();
    sample();
  };
  G.steps = async (ks) => { if (!G.clocked || !G.synced) return 0; for (const k of ks) await G.step(k); return G.rows.length; };
  // ---- the GL tap
  const TY = { 5126: 'float', 35664: 'vec2', 35665: 'vec3', 35666: 'vec4', 5124: 'int', 35667: 'ivec2', 35668: 'ivec3', 35669: 'ivec4', 5125: 'uint', 35670: 'bool', 35674: 'mat2', 35675: 'mat3', 35676: 'mat4', 35678: 'sampler2D', 35679: 'sampler3D', 35680: 'samplerCube', 36289: 'sampler2DArray' };
  const ctxOf = (gl) => { let c = G.ctxIdx.get(gl); if (c == null) { c = C.idBase + G.ctxs.length; G.ctxs.push({ gl, id: c, v2: typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext }); G.ctxIdx.set(gl, c); } return c; };
  const listU = (p) => { const out = []; try { const gl = p.gl, n = gl.getProgramParameter(p.p, 35718) || 0; for (let i = 0; i < Math.min(n, 160); i++) { const u = gl.getActiveUniform(p.p, i); if (u) out.push({ name: u.name, type: TY[u.type] || String(u.type), size: u.size }); } } catch (e) { return null; } return out; };
  const put = (key, v) => { if (!(key in G.vals)) { if (G.keys >= MAXK) { G.dropped.keys++; return; } G.keys++; } G.vals[key] = v; };
  const putF = (L, data, off, len, n) => {
    if (data == null) return;
    if (n === 0) { put(L.key, SIG(data)); return; }
    off = off || 0; const total = len || (data.length - off);
    if (total <= n) { const v = []; for (let i = 0; i < n; i++) v.push(SIG(data[off + i])); put(L.key, v.length === 1 ? v[0] : v); return; }
    const base = L.key.replace(/\[0\]$/, '');
    for (let i = 0; i * n < total; i++) { const v = []; for (let j = 0; j < n; j++) v.push(SIG(data[off + i * n + j])); put(base + '[' + i + ']', v); }
  };
  const P = [typeof WebGLRenderingContext !== 'undefined' && WebGLRenderingContext.prototype, typeof WebGL2RenderingContext !== 'undefined' && WebGL2RenderingContext.prototype].filter(Boolean);
  for (const proto of P) {
    const wrap = (fn, make) => { const o = proto[fn]; if (typeof o === 'function') proto[fn] = make(o); };
    wrap('createShader', (o) => function (type) { const sh = o.call(this, type); try { if (sh) G.shaders.set(sh, { type, src: null }); } catch (e) {} return sh; });
    wrap('shaderSource', (o) => function (sh, src) { try { const s = G.shaders.get(sh); if (s) { s.src = String(src).slice(0, MAXSRC); s.len = String(src).length; } } catch (e) {} return o.call(this, sh, src); });
    wrap('createProgram', (o) => function () { const p = o.call(this); try { if (p) { if (G.progs.length < MAXP) { const i = { id: C.idBase + G.progs.length + 1, ctx: ctxOf(this), p, gl: this, sh: new Set(), vs: null, fs: null, vsLen: 0, fsLen: 0 }; G.progs.push(i); G.progOf.set(p, i); } else G.dropped.programs++; } } catch (e) {} return p; });
    wrap('attachShader', (o) => function (p, sh) { try { const i = G.progOf.get(p); if (i) i.sh.add(sh); } catch (e) {} return o.call(this, p, sh); });
    wrap('linkProgram', (o) => function (p) { const r = o.call(this, p); try { const i = G.progOf.get(p); if (i) for (const sh of i.sh) { const s = G.shaders.get(sh); if (!s) continue; if (s.type === 35633) { i.vs = s.src; i.vsLen = s.len || 0; } else if (s.type === 35632) { i.fs = s.src; i.fsLen = s.len || 0; } } } catch (e) {} return r; });
    wrap('useProgram', (o) => function (p) { try { G.cur.set(this, (p && G.progOf.get(p)) || null); } catch (e) {} return o.call(this, p); });
    wrap('getUniformLocation', (o) => function (p, name) { const loc = o.call(this, p, name); try { const i = loc && G.progOf.get(p); if (i) G.locs.set(loc, { info: i, name: String(name), key: 'p' + i.id + '|' + String(name) }); } catch (e) {} return loc; });
    for (const [fn, n] of [['uniform1f', 0], ['uniform2f', 2], ['uniform3f', 3], ['uniform4f', 4]]) wrap(fn, (o) => function (loc, ...a) { try { const L = loc && G.locs.get(loc); if (L) putF(L, n === 0 ? a[0] : a.slice(0, n), 0, n || 1, n); } catch (e) {} return o.call(this, loc, ...a); });
    for (const [fn, n] of [['uniform1fv', 1], ['uniform2fv', 2], ['uniform3fv', 3], ['uniform4fv', 4], ['uniformMatrix2fv', 4], ['uniformMatrix3fv', 9], ['uniformMatrix4fv', 16]]) wrap(fn, (o) => function (loc, ...a) { try { const L = loc && G.locs.get(loc); if (L) { const m = /Matrix/.test(fn); putF(L, m ? a[1] : a[0], m ? a[2] : a[1], m ? a[3] : a[2], n); } } catch (e) {} return o.call(this, loc, ...a); });
    for (const fn of ['uniform1i', 'uniform1ui']) wrap(fn, (o) => function (loc, v) { try { const L = loc && G.locs.get(loc); if (L) { if (L.key in G.vals) put(L.key, v); else if (!(L.key in G.ints)) G.ints[L.key] = v; else if (G.ints[L.key] !== v) put(L.key, v); } } catch (e) {} return o.call(this, loc, v); });
    wrap('bindFramebuffer', (o) => function (t, fb) { try { if (t !== 36008) { let id = 0; if (fb) { id = G.fbId.get(fb); if (id == null) { id = C.idBase + ++G.fbN; G.fbId.set(fb, id); } } G.curFb.set(this, id); } } catch (e) {} return o.call(this, t, fb); });
    for (const fn of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'drawRangeElements']) wrap(fn, (o) => function () {
      try { const p = G.cur.get(this); if (p) { const k = 'p' + p.id, fb = G.curFb.get(this) || 0; let d = G.draws[k]; if (!d) d = G.draws[k] = [0, G.seqd++]; d[0]++; if (d.indexOf(fb, 2) < 0) d.push(fb); } } catch (e) {}
      return o.apply(this, arguments); });
  }
  // one row per frame: what changed since the row before (the reader holds the rest), and who drew into which target
  const sample = () => {
    const gl = {}; let n = 0;
    for (const key in G.vals) { const v = G.vals[key], s = G.sent[key]; if (s === undefined || JSON.stringify(s) !== JSON.stringify(v)) { gl[key] = v; G.sent[key] = v; n++; } }
    if (G.rows.length >= MAXROWS) { G.dropped.rows++; G.draws = {}; G.seqd = 0; return; }
    G.rows.push({ k: G.k, T: G.now, ...(n ? { gl } : {}), gld: G.draws }); G.draws = {}; G.seqd = 0;
  };
  G.drain = () => { const s = JSON.stringify(G.rows); G.rows = []; return s; };
  G.info = () => JSON.stringify({
    contexts: G.ctxs.map((c) => ({ id: c.id, webgl2: c.v2, width: c.gl.canvas ? c.gl.canvas.width : null, height: c.gl.canvas ? c.gl.canvas.height : null })),
    programs: G.progs.map((p) => { const pre = 'p' + p.id + '|', ints = {}; for (const k in G.ints) if (k.startsWith(pre)) ints[k.slice(pre.length)] = G.ints[k]; return { id: p.id, ctx: p.ctx, vs: p.vs, fs: p.fs, vsLen: p.vsLen, fsLen: p.fsLen, uniforms: listU(p), ints, worker: true }; }),
    frames: G.k - C.k0, dropped: G.dropped, clock: 'the page\'s virtual clock, frame for frame',
  });
}

/**
 * Attach to the page's dedicated workers as they start, tap each, and step them with the page.
 * @param {object} S  a session: S.cdp (the page's CDP session), S.cfg (t0, dt, dateEpoch), S.page
 * @returns {Promise<{list:object[], step:(k:number)=>Promise<void>, drain:()=>Promise<void>, finish:()=>Promise<object[]>, rows:object[]}>}
 */
export async function attachWorkers(S) {
  const W = { list: [], rows: [] }, pending = new Map();
  let nextId = 1;
  const send = (sessionId, method, params = {}) => new Promise((res, rej) => {
    const id = nextId++; pending.set(id, { res, rej });
    S.cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method, params }) }).catch((e) => { pending.delete(id); rej(e); });
  });
  S.cdp.on('Target.receivedMessageFromTarget', (e) => {
    let m; try { m = JSON.parse(e.message); } catch { return; }
    const p = m.id != null && pending.get(m.id); if (!p) return;
    pending.delete(m.id); if (m.error) p.rej(new Error(m.error.message)); else p.res(m.result);
  });
  S.cdp.on('Target.attachedToTarget', async (e) => {
    const { sessionId, targetInfo, waitingForDebugger } = e;
    if (targetInfo.type !== 'worker') { if (waitingForDebugger) send(sessionId, 'Runtime.runIfWaitingForDebugger').catch(() => {}); return; }
    const w = { sessionId, url: targetInfo.url, index: W.list.length, ok: false, k: 0 };
    W.list.push(w);
    if (waitingForDebugger) send(sessionId, 'Runtime.runIfWaitingForDebugger').catch(() => {});
  });
  // a worker the bootstrap tapped says so, and whether it has made a WebGL context yet (only then is it stepped with the page: one
  // that never draws keeps its own clock and costs nothing a frame). Asked every 30 page frames.
  const probe = async (w, k) => {
    if (w.gone || w.clocked) return; if (w.askedAt != null && k - w.askedAt < 30) return; w.askedAt = k;
    try { const v = await ev(w, 'self.__WRW ? JSON.stringify({ idBase: self.__WRW.idBase, clocked: self.__WRW.clocked }) : ""'); if (v) { const x = JSON.parse(v); w.ok = true; w.idBase = x.idBase;
      if (x.clocked) { await ev(w, `self.__WRW.sync(${k})`); w.clocked = true; w.k = k; } } } catch { /* not ready */ }
  };
  S.cdp.on('Target.detachedFromTarget', (e) => { const w = W.list.find((x) => x.sessionId === e.sessionId); if (w) w.gone = true; });
  await S.cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: false });
  const ev = (w, expression) => send(w.sessionId, 'Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }).then((r) => r?.result?.value);
  /** Run each tapped worker up to the page's frame k (frame by frame). A worker that does not answer in 2 s is left behind, and said. */
  W.step = async (k) => {
    for (const w of W.list) {
      if (!w.clocked) await probe(w, k);
      if (!w.clocked || w.gone || k <= w.k) continue;
      const ks = []; for (let x = w.k + 1; x <= k; x++) ks.push(x);
      try { await Promise.race([ev(w, `self.__WRW ? self.__WRW.steps(${JSON.stringify(ks)}) : 0`), new Promise((_, rej) => setTimeout(() => rej(new Error('no answer in 2 s')), 2000))]); w.k = k; }
      catch (err) { w.gone = true; w.error = `stopped stepping: ${String(err.message).slice(0, 120)}`; }
    }
  };
  W.drain = async () => {
    for (const w of W.list) {
      if (!w.ok || w.gone) continue;
      try { const s = await ev(w, 'self.__WRW ? self.__WRW.drain() : "[]"'); for (const r of JSON.parse(s)) W.rows.push({ w: w.index, ...r }); } catch { /* a worker that ended took its last rows with it */ }
    }
  };
  W.finish = async () => {
    await W.drain();
    const out = [];
    for (const w of W.list) {
      let info = null;
      if (w.ok && !w.gone) try { info = JSON.parse(await ev(w, 'self.__WRW ? self.__WRW.info() : "null"')); } catch { info = null; }
      out.push({ index: w.index, url: String(w.url).slice(0, 300), idBase: w.idBase, tapped: w.ok, ...(w.error ? { error: w.error } : {}), ...(info || {}) });
    }
    return out;
  };
  return W;
}
