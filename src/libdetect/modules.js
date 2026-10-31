// Module inputs for libdetect. A "module" is {id, kind, source}: one unpacked module, one chunk, one HTML/CSS/JSON file,
// or a whole bundle (a bundle just gives coarser attribution; detection works on text, so no unpacker is required).
// Source maps are expanded into their original modules when they carry sourcesContent, because that is the one honest
// "unpack" that needs no tool (wakaru / webcrack stay deferred, PLAN §7 P4).
import fs from 'node:fs';
import path from 'node:path';

const KIND_BY_EXT = {
  '.js': 'js', '.mjs': 'js', '.cjs': 'js', '.jsx': 'js', '.ts': 'js', '.tsx': 'js',
  '.html': 'html', '.htm': 'html', '.css': 'css', '.json': 'json',
  '.glsl': 'glsl', '.vert': 'glsl', '.frag': 'glsl', '.vs': 'glsl', '.fs': 'glsl',
  '.txt': 'text', '.svg': 'text',
};
export const MAX_FILE_BYTES = 16 * 1024 * 1024;

export function kindOf(id) {
  return KIND_BY_EXT[path.extname(String(id).split('?')[0]).toLowerCase()] || 'text';
}

/** Normalise a caller-supplied module list; rejects non-string sources instead of silently skipping them. */
export function normaliseModules(mods) {
  if (!Array.isArray(mods)) throw new TypeError('modules must be an array of {id, source[, kind]}');
  return mods.map((m, i) => {
    if (typeof m?.source !== 'string') throw new TypeError(`module ${i} (${m?.id}) has no string source`);
    const id = String(m.id ?? `module-${i}`);
    return { id, kind: m.kind || kindOf(id), source: m.source };
  });
}

/** Expand one source map (parsed JSON) into modules; returns [] when it has no sourcesContent. */
export function expandSourceMap(map, mapId = 'map') {
  if (!map || !Array.isArray(map.sources)) return [];
  const out = [];
  map.sources.forEach((src, i) => {
    const content = map.sourcesContent?.[i];
    if (typeof content === 'string') out.push({ id: `${mapId}::${src}`, kind: kindOf(src), source: content });
    else out.push({ id: `${mapId}::${src}`, kind: 'path', source: String(src) }); // path only: still evidence (node_modules/<pkg>/)
  });
  return out;
}

/**
 * Read files/directories into modules. Returns {modules, skipped:[{path, reason}]}.
 * Files above MAX_FILE_BYTES and unreadable files are listed in `skipped`, never dropped silently.
 */
export function loadModules(inputs, { maxFiles = 5000 } = {}) {
  const modules = []; const skipped = [];
  const visit = (p, root) => {
    if (modules.length + skipped.length >= maxFiles) { skipped.push({ path: p, reason: `file limit ${maxFiles} reached` }); return; }
    let st; try { st = fs.statSync(p); } catch (e) { skipped.push({ path: p, reason: e.message }); return; }
    if (st.isDirectory()) {
      for (const n of fs.readdirSync(p).sort()) visit(path.join(p, n), root || p);
      return;
    }
    if (st.size > MAX_FILE_BYTES) { skipped.push({ path: p, reason: `larger than ${MAX_FILE_BYTES} bytes` }); return; }
    const id = root ? path.relative(root, p) : path.basename(p);
    const ext = path.extname(p).toLowerCase();
    let text; try { text = fs.readFileSync(p, 'utf8'); } catch (e) { skipped.push({ path: p, reason: e.message }); return; }
    if (ext === '.map') {
      try { modules.push(...expandSourceMap(JSON.parse(text), id)); } catch (e) { skipped.push({ path: p, reason: `source map is not JSON: ${e.message}` }); }
      return;
    }
    if (!(ext in KIND_BY_EXT)) { skipped.push({ path: p, reason: `unsupported extension ${ext || '(none)'}` }); return; }
    modules.push({ id, kind: KIND_BY_EXT[ext], source: text });
  };
  for (const i of inputs) visit(path.resolve(i), null);
  return { modules, skipped };
}
