// Gates (PLAN §2): an Enter screen, a cookie wall, an age gate or a sign-in that covers the page after it has settled. One
// per page and viewport. REVA passes what only asks to go on (Enter, Start, Skip), with no sound when it can choose. It
// never says yes for the visitor: accept, agree, "I am over 18", sign in and pay stay shut, and the ledger says why.

/** A control whose words commit the visitor: never pressed, by the gate, the click tests or anything else in a scan. */
export const NEVER_PRESS = /\b(accept|agree|allow all|allow cookies|consent|i understand|got it|sign[ -]?(in|up)|log[ -]?(in|on)|register|create account|subscribe|buy|pay|checkout|add to (cart|bag)|purchase|order now|delete|remove|send|submit|download|yes|i am|i'm|over \d\d|\d\d\+|of age|older)\b/i;
/** Words of a control that only goes on. */
const GO_ON = /\b(enter|explore|start|begin|continue|proceed|skip|discover|launch|open|go|visit|view|play|experience|see|let'?s)\b/i;
const NO_SOUND = /\b(without|no|off|mute[d]?)\b.*\bsound\b|\bsound\b.*\b(off|no)\b|\bwithout\b.*\b(audio|music)\b|\bno (audio|music)\b/i;
const AGE = /\b(over|under|older|younger)\s+\d\d|\b\d\d\+|\bof (legal )?age\b|\bdate of birth\b|\bage (gate|check|verification)\b|\bhow old\b/i;
const CONSENT = /\bcookies?\b|\bconsent\b|\bprivacy\b|\btracking\b/i;
const SIGN_IN = /\bsign[ -]?in\b|\blog[ -]?in\b|\bpassword\b/i;
const PRESS_ANYWHERE = /\b(click|tap|press)\b.{0,24}\b(anywhere|to (enter|start|begin|continue|explore))\b|\bscroll to (enter|start|begin|explore)\b/i;

/** The full-screen overlay test, run in the page after load has settled (a gate is a coverage unit, PLAN §2). */
export function gateProbe() {
  const vw = innerWidth, vh = innerHeight, area = vw * vh;
  const out = [];
  let visible = 0;
  // a selector that finds the same element again in the next session of the same replay
  const pathOf = (e) => { const p = []; for (let x = e; x && x !== document.documentElement; x = x.parentElement) { const par = x.parentElement; if (!par) break; p.unshift(`${/^[a-z][a-z0-9-]*$/.test(x.localName) ? x.localName : '*'}:nth-child(${[...par.children].indexOf(x) + 1})`); } return 'html>' + p.join('>'); };
  for (const el of document.querySelectorAll('*')) { const q = el.getBoundingClientRect(); if (q.width > 0 && q.height > 0) visible++; }
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (cs.position !== 'fixed') continue; // an absolute or sticky hero that fills the screen is page content, a gate is fixed over it
    if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity < 0.05 || cs.pointerEvents === 'none') continue;
    const r = el.getBoundingClientRect();
    const w = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0)), h = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
    if (w * h < 0.8 * area) continue;
    const top = document.elementFromPoint(vw / 2, vh / 2);
    if (!top || !(el === top || el.contains(top))) continue;
    // a wrapper that holds the page itself (a fixed scroller, a pinned hero) is not a gate: a gate holds a small part of the page
    let inner = 0; for (const d of el.querySelectorAll('*')) { const q = d.getBoundingClientRect(); if (q.width > 0 && q.height > 0) inner++; }
    if (inner > 0.35 * visible) continue;
    // what can be pressed: real controls first, then what the page styles as pressable (a bare div with a click handler)
    const pressable = [...el.querySelectorAll('button, a[href], [role="button"], input[type="button"], input[type="submit"]')];
    for (const d of el.querySelectorAll('*')) if (!pressable.includes(d) && getComputedStyle(d).cursor === 'pointer' && !(d.parentElement && getComputedStyle(d.parentElement).cursor === 'pointer')) pressable.push(d);
    const shown = pressable.filter((b) => { const q = b.getBoundingClientRect(); return q.width > 0 && q.height > 0; }).slice(0, 6);
    const labels = shown.map((b) => (b.innerText || b.value || b.getAttribute('aria-label') || '').trim().slice(0, 40));
    const text = (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    out.push({ tag: el.tagName.toLowerCase(), id: el.id || null, cls: String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className || '').slice(0, 80), cover: +((w * h) / area).toFixed(2), share: +(inner / Math.max(1, visible)).toFixed(3), z: cs.zIndex, clickables: labels,
      choices: shown.map((b, i) => ({ sel: pathOf(b), label: labels[i], type: b.getAttribute('type') || null })), selfSel: pathOf(el), text, password: !!el.querySelector('input[type="password"]'), cursor: cs.cursor });
  }
  return { overlays: out, visible };
}

/**
 * What kind of gate this overlay is, and what could get past it, best first.
 * @param {object} g  one overlay of gateProbe
 * @returns {{kind:'enter'|'consent'|'age'|'login'|'unknown', choices:{sel:string, label:string}[], refused:string[]}}
 */
export function judgeGate(g) {
  const text = g.text || '', all = `${text} ${(g.clickables || []).join(' ')}`;
  const choices = [], refused = [];
  for (const c of g.choices || []) {
    const label = c.label || '';
    if (c.type === 'submit' || NEVER_PRESS.test(label)) { if (label) refused.push(label); continue; }
    if (GO_ON.test(label) || NO_SOUND.test(label)) choices.push({ sel: c.sel, label, rank: NO_SOUND.test(label) ? 0 : 1 });
  }
  choices.sort((a, b) => a.rank - b.rank);
  if (!choices.length && PRESS_ANYWHERE.test(text)) choices.push({ sel: g.selfSel, label: text.slice(0, 40), rank: 2 });
  // a bare control with nothing written on it (an arrow, a logo) inside an overlay that says nothing of cookies, age or sign-in
  if (!choices.length && !refused.length && !CONSENT.test(all) && !AGE.test(all) && !SIGN_IN.test(all)) {
    for (const c of g.choices || []) if (!c.label && c.type !== 'submit') choices.push({ sel: c.sel, label: '', rank: 3 });
  }
  const kind = g.password || SIGN_IN.test(all) ? 'login' : AGE.test(all) ? 'age' : CONSENT.test(all) ? 'consent' : choices.length ? 'enter' : 'unknown';
  if (kind === 'login' || kind === 'age') return { kind, choices: [], refused };
  return { kind, choices: choices.map(({ sel, label }) => ({ sel, label })), refused };
}

/**
 * In a session at rest: is there a gate, and which choice gets past it? Tries the choices in order until the overlay is gone.
 * @returns {{none:true}|{sel:string,label:string,kind:string,tried:number,overlay:object}|{sel:null,kind:string,overlay:object,why:string,refused:string[]}}
 */
export async function findGate(S, { waitMs = 2500, afterMs = 2500 } = {}) {
  let p = await S.evRetry(gateProbe).catch(() => null);
  if (!p) return { sel: null, kind: 'unknown', overlay: null, why: 'the overlay probe could not run in the page', failed: true };
  if (!p.overlays.length) return { none: true, visible: p.visible };
  await S.hold(waitMs); // a loader that is about to leave is not a gate
  p = await S.evRetry(gateProbe).catch(() => p);
  if (!p.overlays.length) return { none: true, visible: p.visible, waited: waitMs };
  const g = p.overlays[0];
  const j = judgeGate(g);
  let tried = 0;
  for (const c of j.choices.slice(0, 4)) {
    tried++;
    await S.click({ target: c.sel, hoverMs: 200 });
    await S.hold(afterMs);
    const q = await S.evRetry(gateProbe).catch(() => null);
    const gone = q && !q.overlays.some((o) => o.selfSel === g.selfSel);
    if (gone) return { sel: c.sel, label: c.label, kind: j.kind, tried, overlay: strip(g), visible: q.visible, visibleBefore: p.visible };
  }
  const why = j.kind === 'login' ? 'it asks for a sign-in; REVA never signs in'
    : j.kind === 'age' ? 'it asks the visitor\'s age; REVA never answers for a person'
    : j.kind === 'consent' ? `its only way past is to agree (${j.refused.join(' | ') || 'no other choice'}); REVA never accepts, so the banner stays in every frame`
    : j.choices.length ? `pressing ${j.choices.map((c) => `"${c.label}"`).join(', ')} did not remove it`
    : 'it offers nothing REVA may press';
  return { sel: null, kind: j.kind, overlay: strip(g), why, refused: j.refused, tried };
}
const strip = ({ choices, selfSel, ...g }) => g;

/** In a take: press the gate's control and keep the pictures of what it starts. False when the control is gone. */
export async function passGate(S, plan, { phaseFrames, phase = null, frames = 150 } = {}) {
  const here = await S.evRetry((q) => !!document.querySelector(q), plan.sel).catch(() => false);
  if (!here) return false;
  if (phase) await S.mark('gate');
  await S.click({ target: plan.sel, hoverMs: 200 });
  if (phase && phaseFrames) await phaseFrames(phase, frames); else await S.hold(2500);
  return true;
}

/** The ledger row of a gate. */
export function gateRowOf(plan, { page, viewport, take }) {
  const base = { unit: 'gate', page, viewport, id: 'start' };
  if (!plan || plan.failed) return { ...base, status: 'failed', reason: plan?.why || 'the survey of the page failed, so the overlay probe never ran' };
  if (plan.none) return { ...base, status: 'captured', reason: 'no full-screen overlay after the page settled', evidence: { take } };
  const label = plan.overlay ? `a full-screen ${plan.overlay.tag} covers ${Math.round(plan.overlay.cover * 100)} % of the viewport after load` : 'an overlay covers the page';
  if (plan.sel) return { ...base, status: 'captured', reason: `${label}; passed by pressing "${plan.label || 'its only control'}" (${plan.kind})`, evidence: { take, frames: 'gate', overlay: plan.overlay, pressed: plan.label, tried: plan.tried } };
  return { ...base, status: plan.kind === 'login' ? 'blocked' : 'not-reached', reason: `${label}: ${plan.why}`, evidence: { take, overlay: plan.overlay } };
}
