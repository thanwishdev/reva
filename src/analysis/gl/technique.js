// Shader technique summary (WebGL light): plain, honest heuristics over the GLSL source text and the WebGL call counters.
// Every item is "derived": a pattern in the code, never a fact about the author's intent (a function called fbm can do
// anything). Each item keeps the evidence it was derived from, so the reader can check it in the source.

/** GLSL without comments (block and line), so commented-out code does not count. */
export function stripComments(src) {
  return String(src || '').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}
const count = (s, re) => (s.match(re) || []).length;
const first = (s, re) => { const m = re.exec(s); return m ? m[0].trim().slice(0, 60) : null; };

const NOISE = [
  ['fbm', /\bfbm\w*\s*\(/i, 'fbm noise'],
  ['simplex', /\b(snoise\w*|simplex\w*)\s*\(/i, 'simplex noise'],
  ['perlin', /\b(cnoise\w*|pnoise\w*|perlin\w*)\s*\(/i, 'Perlin noise'],
  ['cellular', /\b(voronoi\w*|worley\w*|cellular\w*)\s*\(/i, 'cellular (Voronoi / Worley) noise'],
  ['value-noise', /\bnoise\d?\w*\s*\(/i, 'a noise function'],
];
const TEX = /\b(texture(?:2D|Cube|3D)?(?:Lod|Proj|Grad|LodEXT|GradEXT|Offset)?|texelFetch)\s*\(/g;

/**
 * Technique items of one program: [{id, text, label: 'derived', evidence}].
 * @param {{vs?:string, fs?:string, uniforms?:{name:string,type:string,size:number}[], instancedDraws?:number}} prog
 * @param {{framebuffers?:number, instancedDraws?:number, attribDivisors?:number}} [counters] page-wide WebGL counters
 */
export function techniqueOf(prog, counters = {}) {
  const vs = stripComments(prog.vs), fs = stripComments(prog.fs), both = vs + '\n' + fs;
  const uniforms = Array.isArray(prog.uniforms) ? prog.uniforms : [];
  const out = []; const add = (id, text, evidence) => out.push({ id, text, label: 'derived', evidence });
  // noise: the most specific name wins (fbm built on simplex is reported as fbm and simplex, a bare noise() only alone)
  const noise = NOISE.filter(([, re]) => re.test(both));
  for (const [id, re, text] of noise) { if (id === 'value-noise' && noise.length > 1) continue; add(id === 'value-noise' ? 'noise' : id, text, first(both, re)); }
  // fbm written as an octave loop without the name: a loop that halves amplitude and doubles frequency
  if (!noise.some(([id]) => id === 'fbm') && /for\s*\([^)]*\)[\s\S]{0,400}?\*=\s*0?\.5\b[\s\S]{0,200}?\*=\s*2\.0?/.test(both)) add('fbm', 'fbm-like octave loop (amplitude halves, frequency doubles)', 'for (...) { ... *= 0.5; ... *= 2.0 }');
  // raymarching / signed distance fields: a loop that steps a ray by a distance from a scene function
  const sdf = /\b(sd[A-Z]\w*|sdf\w*|map|scene|de)\s*\(/.test(fs) && /\bfor\s*\(/.test(fs) && (/\b(ro|rayOrigin|rd|rayDir|rayDirection)\b/.test(fs) || /\b(t|dist|d0|total)\s*\+=\s*\w+/.test(fs));
  if (sdf) add('raymarch', 'raymarching over a signed distance field (a stepping loop in the fragment shader)', first(fs, /\b(sd[A-Z]\w*|sdf\w*|map|scene)\s*\(/));
  // vertex displacement: the vertex shader moves positions with noise, a texture or a wave
  const vMove = /\b(noise\w*|snoise\w*|cnoise\w*|fbm\w*|texture(?:2D)?(?:Lod)?)\s*\(/.test(vs) || /\b(sin|cos)\s*\([^;]*\b\w*[tT]ime\b/.test(vs);
  const vAssign = /\b(pos\w*|position|transformed|displaced|p)\b(\.\w+)?\s*(\+|-|\*)?=/.test(vs);
  if (vs && vMove && vAssign) add('vertex-displacement', 'vertex displacement (positions moved by noise, a texture or a wave in the vertex shader)', first(vs, /\b(pos\w*|position|transformed|displaced|p)\b(\.\w+)?\s*(\+|-|\*)?=[^;]*/));
  // textures
  const samples = count(fs, TEX) + count(vs, TEX);
  const samplers = uniforms.filter((u) => /^(sampler|isampler|usampler)/.test(u.type)).reduce((a, u) => a + (u.size || 1), 0);
  if (samples || samplers) add('textures', `${samplers} texture${samplers === 1 ? '' : 's'} bound (sampler uniforms), ${samples} texture read${samples === 1 ? '' : 's'} in the source`, `${samplers} sampler uniform(s); ${samples} texture*() call(s)`);
  // time
  const time = uniforms.filter((u) => u.type === 'float' && /time/i.test(u.name)).map((u) => u.name);
  if (time.length) add('time', `a time uniform (${time.slice(0, 2).join(', ')}): animated by a clock`, time.join(', '));
  // instancing
  if ((prog.instancedDraws || 0) > 0 || /\bgl_InstanceID\b/.test(vs)) add('instancing', `instanced drawing${prog.instancedDraws ? ` (${prog.instancedDraws} instanced draw calls)` : ' (gl_InstanceID in the vertex shader)'}`, prog.instancedDraws ? 'drawArraysInstanced / drawElementsInstanced' : 'gl_InstanceID');
  // particles / points
  if (/\bgl_PointSize\s*=/.test(vs)) add('points', 'point sprites (gl_PointSize set: particles or dots)', 'gl_PointSize');
  // a screen-space pass: the vertex shader passes a quad straight through (no matrix), typical of post-processing / full-screen effects
  if (vs && /gl_Position\s*=\s*vec4\s*\(\s*\w+(\.xy)?\s*,/.test(vs) && !/\b(mat4|mat3)\b/.test(vs)) add('screen-pass', 'a full-screen pass (the vertex shader draws a quad without a camera): a screen-space effect or post-processing step', first(vs, /gl_Position\s*=[^;]*/));
  // lighting
  if (/\b(roughness|metalness|BRDF|brdf|GGX|ggx)\b/.test(fs)) add('pbr', 'physically based lighting (roughness / metalness terms)', first(fs, /\b(roughness|metalness|BRDF|brdf|GGX|ggx)\b/));
  else if (/\bdot\s*\(\s*\w*[nN]ormal\w*\s*,\s*\w*[lL]ight\w*/.test(fs) || /\b(lambert|phong|blinn)\w*/i.test(fs)) add('lighting', 'diffuse / specular lighting (a normal-light dot product)', first(fs, /\bdot\s*\(\s*\w*[nN]ormal\w*\s*,[^)]*\)|\b(lambert|phong|blinn)\w*/i));
  if (/\bfresnel\w*|pow\s*\(\s*1\.0?\s*-\s*(max\s*\()?\s*dot\s*\(/i.test(fs)) add('fresnel', 'a fresnel (rim) term', first(fs, /\bfresnel\w*|pow\s*\(\s*1\.0?\s*-[^;]*/i));
  // page-wide: render to texture
  if ((counters.framebuffers || 0) > 0) add('render-to-texture', `render-to-texture: the page binds ${counters.framebuffers} offscreen framebuffer${counters.framebuffers === 1 ? '' : 's'}, so it draws in at least ${counters.framebuffers + 1} passes (page-wide, not this program alone)`, `${counters.framebuffers} framebuffer(s), ${counters.framebufferBinds || 0} bind(s)`);
  return out;
}

/** Short summary for one line: 'fbm noise, 1 texture, 2 passes' (derived). */
export function techniqueSummary(items, counters = {}) {
  const t = []; const has = (id) => items.find((x) => x.id === id);
  for (const id of ['fbm', 'simplex', 'perlin', 'cellular', 'noise']) if (has(id)) t.push(has(id).text.replace(/ \(.*$/, ''));
  if (has('raymarch')) t.push('raymarching (SDF)');
  if (has('vertex-displacement')) t.push('vertex displacement');
  const tex = has('textures'); if (tex) { const n = +/^(\d+)/.exec(tex.text)[1]; t.push(`${n} texture${n === 1 ? '' : 's'}`); }
  if (has('instancing')) t.push('instancing');
  if (has('points')) t.push('point sprites');
  if (has('screen-pass')) t.push('full-screen pass');
  if (has('pbr')) t.push('PBR lighting'); else if (has('lighting')) t.push('lighting');
  if (has('fresnel')) t.push('fresnel');
  if (has('time')) t.push('time uniform');
  if ((counters.framebuffers || 0) > 0) t.push(`${counters.framebuffers + 1} passes`);
  return t.join(', ');
}
