// The computed properties the static layer reads, in a fixed order (rows keep values by index to stay compact).
export const SIDES = ['top', 'right', 'bottom', 'left'];
export const CORNERS = ['top-left', 'top-right', 'bottom-right', 'bottom-left'];

export const PROPS = [
  // typography
  'font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'letter-spacing', 'word-spacing', 'text-transform', 'text-decoration-line', 'text-align',
  // spacing
  ...SIDES.map(s => `margin-${s}`), ...SIDES.map(s => `padding-${s}`), 'row-gap', 'column-gap',
  // colour
  'color', 'background-color', 'background-image', ...SIDES.map(s => `border-${s}-color`), ...SIDES.map(s => `border-${s}-width`), ...SIDES.map(s => `border-${s}-style`),
  'outline-color', 'outline-width', 'outline-style', 'fill', 'stroke',
  // shadows, radii
  'box-shadow', 'text-shadow', ...CORNERS.map(c => `border-${c}-radius`),
  // layout
  'display', 'position', 'flex-direction', 'flex-wrap', 'align-items', 'justify-content', 'grid-template-columns', 'grid-template-rows', 'width', 'height', 'z-index', 'overflow-x', 'overflow-y', 'box-sizing', 'opacity', 'visibility', 'float', 'order',
];
export const IDX = Object.fromEntries(PROPS.map((p, i) => [p, i]));

/** Discrete-ish properties used by the breakpoint layout signature (continuous ones are classified by the sweep itself). */
export const SIG_PROPS = [
  'display', 'position', 'visibility', 'float', 'order', 'flex-direction', 'flex-wrap', 'align-items', 'justify-content', 'text-align', 'overflow-x', 'overflow-y',
  'font-size', 'font-weight', 'line-height', 'letter-spacing', 'text-transform', 'width', 'height',
  ...SIDES.map(s => `margin-${s}`), ...SIDES.map(s => `padding-${s}`), 'row-gap', 'column-gap', ...CORNERS.map(c => `border-${c}-radius`), 'opacity',
];

/** Properties re-read in a forced :hover/:focus state (CDP CSS.getComputedStyleForNode uses CSS names). */
export const STATE_PROPS = ['color', 'background-color', 'background-image', 'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
  'outline-color', 'outline-width', 'outline-style', 'box-shadow', 'text-shadow', 'text-decoration-line', 'opacity',
  'border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius', 'font-weight', 'letter-spacing', 'transform', 'filter'];

/** Properties whose winning declaration we look up (declared source text). */
export const DECLARED_PROPS = ['font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'text-transform', 'color', 'background-color',
  'border-radius', 'box-shadow', 'text-shadow', 'padding', 'margin', 'gap', 'width', 'height', 'border-color', 'border-width'];

/** longhand -> shorthands whose declaration also sets it */
export const SHORTHANDS = (() => {
  const m = {};
  for (const s of SIDES) { m[`padding-${s}`] = ['padding']; m[`margin-${s}`] = ['margin']; m[`border-${s}-color`] = ['border-color', 'border', `border-${s}`]; m[`border-${s}-width`] = ['border-width', 'border', `border-${s}`]; }
  for (const c of CORNERS) m[`border-${c}-radius`] = ['border-radius'];
  m['row-gap'] = ['gap']; m['column-gap'] = ['gap'];
  m['font-size'] = ['font']; m['font-weight'] = ['font']; m['font-family'] = ['font']; m['line-height'] = ['font'];
  m['background-color'] = ['background']; m['background-image'] = ['background'];
  return m;
})();
