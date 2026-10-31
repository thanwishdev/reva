// Font variation axes as motion channels. The recorder samples one channel per axis (ren:wght, ren:wdth and ren:fvar.<tag> for any
// other axis a page sets in font-variation-settings); this file names them in plain words and reads the page's own declarations
// of them (font-variation-settings, font-weight, font-stretch). No dependencies: words, declared, card and select all import it.

// registered axes: [plain name, unit written after the number]
const AXES = { wght: ['font weight', ''], wdth: ['font width', '%'], slnt: ['font slant', '°'], ital: ['font italic', ''], opsz: ['font optical size', ''] };
export const FONT_PROP = /^(font-variation-settings|font-weight|font-stretch)$/;

/** The axis tag a channel id carries ('ren:wght' -> 'wght', 'ren:fvar.GRAD' -> 'GRAD'), else null. */
export function axisOfChannel(ch) {
  const m = /^ren:(?:(wght|wdth)|fvar\.([A-Za-z0-9]{4}))$/.exec(String(ch || ''));
  return m ? m[1] || m[2] : null;
}
export const axisWord = (tag) => (AXES[tag] ? AXES[tag][0] : `font axis ${tag}`);
export const axisUnit = (tag) => (AXES[tag] ? AXES[tag][1] : '');
const fmt = (x) => String(+Number(x).toPrecision(4));
/** 'font weight 300 → 800', 'font width 75% → 125%'. */
export function travelText(tag, from, to) {
  const u = axisUnit(tag);
  return `${axisWord(tag)} ${fmt(from)}${u} → ${fmt(to)}${u}`;
}

const KW_WEIGHT = { normal: 400, bold: 700 };
const KW_STRETCH = { 'ultra-condensed': 50, 'extra-condensed': 62.5, condensed: 75, 'semi-condensed': 87.5, normal: 100, 'semi-expanded': 112.5, expanded: 125, 'extra-expanded': 150, 'ultra-expanded': 200 };
/**
 * The axis values a declared value of a font property names: font-variation-settings '"wght" 300, "wdth" 80' -> {wght: 300,
 * wdth: 80}; font-weight '700' / 'bold' -> {wght: 700}; font-stretch '75%' / 'condensed' -> {wdth: 75}. null when the text names
 * no value (Chrome serialises a transition's font-variation-settings keyframes as 'normal'; 'bolder' / 'lighter' are relative).
 */
export function parseAxes(prop, text) {
  const s = String(text ?? '').trim().toLowerCase();
  if (prop === 'font-variation-settings') {
    const out = {}; const re = /["']([^"']{4})["']\s+(-?\d*\.?\d+(?:e[+-]?\d+)?)/gi; let m;
    const raw = String(text);
    while ((m = re.exec(raw))) if (/^[A-Za-z0-9]{4}$/.test(m[1])) out[m[1]] = +m[2];
    return Object.keys(out).length ? out : null;
  }
  if (prop === 'font-weight') { const v = KW_WEIGHT[s] ?? (/^\d*\.?\d+$/.test(s) ? +s : null); return v == null ? null : { wght: v }; }
  if (prop === 'font-stretch') { const v = KW_STRETCH[s] ?? (/^\d*\.?\d+%$/.test(s) ? parseFloat(s) : null); return v == null ? null : { wdth: v }; }
  return null;
}
