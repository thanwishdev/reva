// The Design and Libraries pages of a scan card: one look on the sealed archive gives the design pass (type, colour, spacing,
// layout, breakpoints, hover and focus) and what the page's own libraries report. Its motions are not used: the stage has them all.
import fs from 'node:fs';
import path from 'node:path';
import { runLook } from '../look/index.js';

/**
 * @param {object} target  a loaded target (its archive path is absolute); startUrl says which page
 * @param {string} out     the page's folder; look.json lands in <out>/look/
 * @returns {{ok:boolean, wallMs:number, error?:string}}
 */
export async function designPass(target, out, { engine, cls = 'A', log = () => {}, lookImpl = runLook } = {}) {
  const t0 = Date.now();
  const dir = path.join(out, 'look');
  if (fs.existsSync(path.join(dir, 'look.json'))) return { ok: true, wallMs: 0, resumed: true };
  fs.mkdirSync(dir, { recursive: true });
  const work = fs.mkdtempSync(path.join(out, '.look-'));
  const targetFile = path.join(work, 'target.json');
  { const { _file, ...t } = target; fs.writeFileSync(targetFile, JSON.stringify(t)); }
  const prev = process.env.REVA_OUT;
  process.env.REVA_OUT = work;
  try {
    const r = await lookImpl({ input: targetFile, action: 'load', top: 1, engine, cls, retake: false, log });
    const { motions, page, gl, screens, take, ...keep } = r;
    fs.writeFileSync(path.join(dir, 'look.json'), JSON.stringify({ ...keep, motions: [], page: null, gl: null, screens: null }));
    log(`design and libraries read in ${Math.round((Date.now() - t0) / 1000)} s`);
    return { ok: !!keep.design, wallMs: Date.now() - t0, ...(keep.design ? {} : { error: 'the design pass returned nothing' }) };
  } catch (e) {
    return { ok: false, wallMs: Date.now() - t0, error: String(e.message).split('\n')[0].slice(0, 300) };
  } finally {
    if (prev === undefined) delete process.env.REVA_OUT; else process.env.REVA_OUT = prev;
    fs.rmSync(work, { recursive: true, force: true });
  }
}
