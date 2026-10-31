// The REAL card: the approved page (CSS + client-side page script in page/template.html) with one look result injected.
// The page script is the renderer; this file only trims the look result to what the page reads, inlines the element crops
// as data URIs and drops every local path (take.dir, archive, record, dir), so the card is one self-contained file.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { restText } from '../look/rest.js';
import { startsText } from '../look/starts.js';
import { gsapLineText } from '../look/gsap.js';
import { lenisDeclaredText, compareLenisTau, fittedTauMs } from '../look/lenis.js';
import { declaredLibLines } from '../look/libprobe.js';
import { execFileSync } from 'node:child_process';
import os from 'node:os';

const TEMPLATE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'page', 'template.html');
const MARK = '/*__DATA__*/null';

function crop(dir, rel) {
  if (!rel || !dir) return null;
  try {
    const abs = path.resolve(dir, rel);
    if (path.relative(path.resolve(dir), abs).startsWith('..')) return null; // never read outside the look folder
    return 'data:image/png;base64,' + fs.readFileSync(abs).toString('base64');
  } catch { return null; }
}

/* ---------- screens (look.json "screens": viewport, before, page) ---------- */
// The card stays one file under ~6 MB: each screen is inlined as a data URI within its own byte budget. A JPEG over the
// budget is resampled (macOS sips, when present) to a smaller longest side; one that still does not fit is left out and the
// card falls back to the crop composite.
const SCREEN_BUDGET = { viewport: 1.3e6, before: 1.3e6, page: 2.6e6 };
function jpegSize(buf) {
  // width and height from the first SOF marker; null if this is not a readable JPEG
  if (!buf || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const mk = buf[i + 1], len = buf.readUInt16BE(i + 2);
    if (mk >= 0xc0 && mk <= 0xcf && mk !== 0xc4 && mk !== 0xc8 && mk !== 0xcc) return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
    i += 2 + len;
  }
  return null;
}
function shrinkJpeg(abs, budget) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-card-'));
  try {
    const sz = jpegSize(fs.readFileSync(abs)); if (!sz) return null;
    let side = Math.max(sz.w, sz.h);
    for (let k = 0; k < 5; k++) {
      side = Math.round(side * 0.72);
      const out = path.join(tmp, `s${k}.jpg`);
      execFileSync('sips', ['-Z', String(side), '-s', 'format', 'jpeg', '-s', 'formatOptions', '72', abs, '--out', out], { stdio: 'ignore', timeout: 20000 });
      const b = fs.readFileSync(out);
      if (b.length <= budget) return b;
    }
    return null;
  } catch { return null; } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
function screenFile(dir, rel, budget) {
  if (!rel || !dir) return null;
  const abs = path.resolve(dir, rel);
  if (path.relative(path.resolve(dir), abs).startsWith('..')) return null;
  let buf; try { buf = fs.readFileSync(abs); } catch { return null; }
  const mime = /\.png$/i.test(rel) ? 'image/png' : 'image/jpeg';
  let shrunk = false;
  if (buf.length > budget) { const b = mime === 'image/jpeg' ? shrinkJpeg(abs, budget) : null; if (!b) return { data: null, dropped: `${Math.round(buf.length / 1024)} KB, over the card's ${Math.round(budget / 1024)} KB budget` }; buf = b; shrunk = true; }
  const px = mime === 'image/jpeg' ? jpegSize(buf) : null;
  return { data: `data:${mime};base64,` + buf.toString('base64'), px, shrunk };
}
/** look.json "screens" -> inlined images with their CSS-pixel size (null parts stay null; an old look has none). */
export function trimScreens(sc, dir) {
  if (!sc || typeof sc !== 'object') return null;
  const one = (k) => {
    const s = sc[k]; if (!s || !s.file) return null;
    const f = screenFile(dir, s.file, SCREEN_BUDGET[k]); if (!f) return null;
    if (!f.data) return { dropped: f.dropped };
    if (k === 'page') {
      // w/h are the page in CSS px when they differ from the image's pixels; when they equal the image's pixels the CSS
      // size is the image divided by scale
      const sc0 = Number.isFinite(s.scale) && s.scale > 0 ? s.scale : 1;
      const img = f.px, same = img && !f.shrunk && Math.abs(img.w - s.w) <= 2 && Math.abs(img.h - s.h) <= 2;
      const cssW = same ? s.w / sc0 : s.w, cssH = same ? s.h / sc0 : s.h;
      return { data: f.data, w: cssW, h: cssH, scale: s.scale ?? null };
    }
    return { data: f.data, w: s.w, h: s.h, scrollY: s.scrollY || 0, dpr: s.dpr || 1 };
  };
  const out = { viewport: one('viewport'), before: one('before'), page: one('page') };
  for (const k of Object.keys(out)) if (out[k] && out[k].dropped) { out.dropped = (out.dropped || []).concat(`${k} screen left out (${out[k].dropped})`); out[k] = null; }
  return out.viewport || out.before || out.page ? out : (out.dropped ? { viewport: null, before: null, page: null, dropped: out.dropped } : null);
}

/* ---------- libraries read exactly from the page (look.json gsap / lenis / declaredLibs) ---------- */
export function trimRead(look) {
  const g = look.gsap, l = look.lenis, dl = look.declaredLibs;
  const gsap = !g ? null : {
    found: !!g.found, version: g.version || null, via: g.via || null, why: g.why || null,
    tweens: g.tweens, timelines: g.timelines, scrollTriggers: g.scrollTriggers, truncated: !!g.truncated, summary: g.summary || null,
    entries: (g.entries || []).map((e) => ({ desc: e.desc, prop: e.prop, status: e.status, channel: e.channel, text: gsapLineText(e), fitted: e.fitted ? { durationMs: e.fitted.durationMs, ease: e.fitted.ease } : null })),
  };
  const lenis = !l ? null : { found: !!l.found, why: l.why || null, version: l.version || null, mode: l.mode || null, tauMs: l.tauMs ?? null, options: l.options || null,
    text: lenisDeclaredText(l), compare: (compareLenisTau(l, fittedTauMs(look.page)) || {}).text || null };
  const other = !dl ? null : { found: !!dl.found, why: dl.why || null, lines: declaredLibLines(dl, null, Infinity),
    counts: { swiper: (dl.swiper || []).length, lottie: (dl.lottie || []).length, locomotive: dl.locomotive ? 1 : 0, anime: (dl.anime || []).length } };
  return gsap || lenis || other ? { gsap, lenis, other } : null;
}

function trimPos(p, dir) {
  if (!p) return null;
  const im = p.image ? { box: p.image.box, visible: p.image.visible, matchesEnd: p.image.matchesEnd, file: p.image.file, reason: p.image.reason, data: crop(dir, p.image.path) } : null;
  return { viewport: p.viewport, start: p.start, end: p.end, group: p.group || null, image: im };
}

function trimLibs(lb) {
  if (!lb) return null;
  return {
    ok: lb.ok, error: lb.error,
    list: (lb.list || []).map((x) => ({ id: x.id, name: x.name, category: x.category, status: x.status, implied: x.implied, version: x.version, running: x.running, calibration: x.calibration, evidenceTotal: x.evidenceTotal, evidence: (x.evidence || []).map((e) => ({ signal: e.signal, where: e.where, role: e.role, weight: e.weight, file: e.file, line: e.line, snippet: e.snippet, observed: e.observed, note: e.note })) })),
    scanned: lb.scanned ? { scripts: lb.scanned.scripts, inline: lb.scanned.inline, bytes: lb.scanned.bytes, dom: lb.scanned.dom, skipped: (lb.scanned.skipped || []).length, skippedReason: lb.scanned.skipped && lb.scanned.skipped[0] ? lb.scanned.skipped[0].reason : null } : null,
    mechanisms: lb.mechanisms || null, note: lb.note,
  };
}

function trimMotion(m, dir) {
  return {
    rank: m.rank && typeof m.rank === 'object' ? { score: m.rank.score, why: m.rank.why || [] } : m.rank, notice: m.notice ? { score: m.notice.score, why: m.notice.why || [] } : null, kind: m.kind, position: trimPos(m.position, dir), desc: m.desc, selector: m.selector, box: m.box, count: m.count,
    weightShare: m.weightShare, channels: m.channels || [], lines: m.lines || [], stagger: m.stagger || null, share: m.share || null,
    covered: m.covered || [], unknowns: m.unknowns || [],
    records: (m.records || []).map((r) => ({
      channel: r.target && r.target.channel, tier: r.tier, class: r.class,
      model: { family: r.model && r.model.family, params: r.model && r.model.params, bezier: (r.model && r.model.bezier) || null, ease: (r.model && r.model.ease) || null, driver: (r.model && r.model.driver) || null, map: (r.model && r.model.map) || null, pin: (r.model && r.model.pin) || null,
        pieces: r.model && Array.isArray(r.model.pieces) ? r.model.pieces.map(x => ({ family: x.family, params: x.params, T0: x.T0, T1: x.T1 })) : undefined },
      derived: r.derived, fit: r.fit,
      runnerUp: r.runnerUp ? { family: r.runnerUp.family, rms: r.runnerUp.rms } : null,
      unknowns: r.unknowns, attribution: r.attribution && r.attribution.label,
    })),
    exports: (m.exports || []).map((e) => ({
      channel: e.channel, family: e.family, kind: e.kind, model: e.model, notes: e.notes, t0: e.t0, fit: e.fit,
      exports: (e.exports || []).map((x) => ({ lib: x.lib, form: x.form, code: x.code, accuracy: x.accuracy, match: x.match, note: x.note })),
    })),
  };
}

// WebGL light: each fitted uniform / camera line is a motion item of its own (the same plots as an element's), the rest
// (shaders with their sources, camera, clocks, what was not read) goes to the WebGL panel. Sources stay collapsed there.
const GL_MOTION = /^(tween|spring|smoothing|asymmetric smoothing|step|ramp|scroll map|restarted tween|periodic|unknown)$/;
function trimGl(g, dir) {
  if (!g || (!g.read && !(g.lines || []).length)) return null;
  const moving = (g.lines || []).filter((l) => GL_MOTION.test(l.kind) && (l.channels || []).length);
  const items = moving.map((l, k) => ({ ...trimMotion({ rank: `gl${k + 1}`, desc: `WebGL ${l.subject || 'value'}`, selector: '(WebGL)', box: null, count: 1, weightShare: 0, channels: l.channels,
    lines: [l], records: (g.records || []).filter((r) => r.target && l.channels.includes(r.target.channel)), exports: [] }, dir), isGl: true }));
  return {
    items, lines: (g.lines || []).filter((l) => !moving.includes(l) && l.kind !== 'shader'),
    programs: (g.programs || []).map((p) => ({ id: p.id, hash: p.hash, used: p.used, summary: p.summary, technique: (p.technique || []).map((t) => ({ text: t.text, evidence: t.evidence })),
      uniforms: p.uniforms || [], vertex: p.vertex, fragment: p.fragment })),
  };
}

/** look result -> the object the page reads (no local paths, crops inlined). */
export function trimLook(look, dir = look.dir) {
  const d = look.design ? JSON.parse(JSON.stringify(look.design)) : null;
  if (d) delete d.record;
  const src = look.source || {};
  return {
    dirName: dir ? path.basename(path.resolve(dir)) : '',
    status: look.status,
    errors: look.errors || [],
    source: { kind: src.kind, startUrl: src.startUrl || src.url || null },
    action: { do: look.action && look.action.do, el: look.action && look.action.el },
    take: { frames: look.take && look.take.frames, rate: look.take && look.take.rate, lane: look.take && look.take.lane, watched: look.take && look.take.watched, misses: look.take && look.take.net && look.take.net.misses, pageErrors: look.take && look.take.pageErrors },
    timing: { totalMs: look.timing && look.timing.totalMs },
    fit: { partial: look.fit && look.fit.partial, records: look.fit && look.fit.records, unknowns: look.fit && look.fit.unknowns, flags: ((look.fit && look.fit.flags) || []).map((f) => f.detail || f) },
    warnings: look.warnings || [],
    page: look.page ? trimMotion(look.page, dir) : null,
    motions: (look.motions || []).map((m, i) => ({ ...trimMotion(m, dir), facts: factsOf(m, look, i) })),
    declaredOnly: (look.declaredOnly || []).slice(0, 20).map((x) => ({ kind: x.kind, desc: x.desc, selector: x.selector || null, durationMs: x.durationMs, delayMs: x.delayMs, easing: x.easing, iterations: x.iterations, t: x.t, css: x.css || null, properties: (x.properties || []).map((p) => ({ prop: p.prop, from: p.from, to: p.to })) })),
    others: (look.others || []).map((o) => ({ rank: o.rank, desc: o.desc, selector: o.selector, box: o.box, weightShare: o.weightShare })),
    unknowns: look.unknowns || [],
    pointerDriven: (look.pointerDriven || []).length,
    alreadyMoving: (look.alreadyMoving || []).length,
    libraries: trimLibs(look.libraries),
    design: d,
    gl: trimGl(look.gl, dir),
    screens: trimScreens(look.screens, dir),
    read: trimRead(look),
  };
}

/** JSON that is safe inside a <script> element. */
export const scriptJson = (v) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

/** look result (object, with .dir for the crops) -> the card page, one self-contained HTML string. */
export function buildCardHtml(look) {
  const tpl = fs.readFileSync(TEMPLATE, 'utf8');
  if (!tpl.includes(MARK)) throw new Error('card template has no data marker');
  return tpl.replace(MARK, () => scriptJson({ look: trimLook(look) }));
}

/** The facts look prints under a motion (src/look/cli.js), as plain sentences for the card panel: the members' start
 *  offsets (no fitted stagger), the rest pose, the page's declared GSAP tweens (identical lines once, with a count) and
 *  the second-run verdict. */
export function factsOf(m, look, idx = null) {
  const out = []; const frame = 1000 / ((look.take && look.take.rate) || 60);
  if (!m.stagger && m.starts) { const t = startsText(m.starts, frame); if (t) out.push(t); }
  const rt = restText(m.rest); if (rt) out.push(rt);
  const by = new Map(); for (const g of m.gsap || []) by.set(g.text, (by.get(g.text) || 0) + 1);
  for (const [t, n] of [...by].slice(0, 6)) out.push(t + (n > 1 ? ` ×${n}` : ''));
  for (const d of m.libDeclared || []) if (d && d.text) out.push(d.text);
  // a WebGL scene carries several lines (uniforms, camera, or what was not measured): each one is a fact of its own
  if (m.kind === 'gl') for (const l of (m.lines || []).slice(1)) if (l && l.text) out.push(l.text);
  // rank is a number in older looks and {score, why} in newer ones; stability then keys by the 1-based order
  const rk = m.rank && typeof m.rank === 'object' ? (idx == null ? null : idx + 1) : m.rank;
  const st = look.stability && look.stability.ran ? (look.stability.motions || []).find((x) => x.rank === rk) : null;
  if (st) out.push(st.verdict === 'varies' && st.text ? st.text : st.verdict === 'stable' ? 'Measured twice from the same files: the same both times.' : `Second run: ${st.verdict}.`);
  return out;
}
