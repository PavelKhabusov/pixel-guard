import {
  parseCssColor, px, figmaLineHeightPx, figmaLetterSpacingPx,
  textCaseToCss, textAlignToCss, firstFontFamily, solidFill,
} from './normalize.mjs';

const DEFAULT_TOL = { px: 1, geo: 2, textHeight: 10 };

export function compareNode(fig, dom, entry = {}) {
  const tol = { ...DEFAULT_TOL, ...(entry.tolerance ?? {}) };
  const ignore = new Set(entry.ignore ?? []);
  const checks = [];
  const add = (prop, figVal, actVal, pass, delta) => {
    if (ignore.has(prop) || figVal == null || actVal == null) return;
    if (typeof figVal === 'string' && figVal.includes('NaN')) return;
    checks.push({ prop, figma: figVal, actual: actVal, pass, ...(delta != null && { delta }) });
  };
  const numCheck = (prop, figVal, actVal, t) => {
    if (figVal == null || actVal == null) return;
    const d = Math.round((actVal - figVal) * 10) / 10;
    add(prop, `${figVal}px`, `${actVal}px`, Math.abs(d) <= t, `${d > 0 ? '+' : ''}${d}px`);
  };
  const colorCheck = (prop, figHex, figAlpha, cssColor) => {
    const act = parseCssColor(cssColor);
    if (!act || figHex == null) return;
    const pass = act.hex === figHex.toLowerCase() && Math.abs(act.alpha - (figAlpha ?? 1)) < 0.02;
    add(prop, figHex + (figAlpha != null && figAlpha < 1 ? ` / ${figAlpha}` : ''),
      act.hex + (act.alpha < 1 ? ` / ${act.alpha}` : ''), pass);
  };

  const s = dom.styles;

  const hugsWidth = fig.type === 'TEXT' && (fig.autoResize === 'WIDTH_AND_HEIGHT' || fig.autoResize === 'TRUNCATE');
  // A full-width block (as wide as the frame) fills the whole window in the
  // browser — the difference equals the window width, not a markup mismatch.
  const fullWidth = entry.frameW && Math.abs(fig.w - entry.frameW) < 2;
  if (!hugsWidth && !fullWidth) numCheck('width', fig.w, px(dom.rect.width), tol.geo);
  if (fig.type === 'TEXT') {
    const act = px(dom.rect.height);
    const lo = fig.renderH ?? fig.h;
    const hi = Math.max(fig.h ?? 0, fig.renderH ?? 0);
    if (act != null && lo != null) {
      const pass = act >= lo - tol.textHeight && act <= hi + tol.textHeight;
      const near = act < lo ? act - lo : act - hi;
      add('height', `${Math.round(hi * 10) / 10}px`, `${act}px`, pass,
        pass ? undefined : `${near > 0 ? '+' : ''}${Math.round(near * 10) / 10}px`);
    }
  } else {
    numCheck('height', fig.h, px(dom.rect.height), tol.geo);
  }

  if (fig.type === 'TEXT' && fig.font) {
    const f = fig.font;
    if (f.family !== 'mixed')
      add('font-family', f.family, firstFontFamily(s['font-family']),
        f.family.toLowerCase() === (firstFontFamily(s['font-family']) ?? '').toLowerCase());
    if (f.size !== 'mixed') numCheck('font-size', f.size, px(s['font-size']), tol.px);
    if (f.weight !== 'mixed')
      add('font-weight', String(f.weight), s['font-weight'], String(f.weight) === s['font-weight']);
    const lh = figmaLineHeightPx(f.lineHeight, f.size);
    if (lh != null && s['line-height'] !== 'normal')
      numCheck('line-height', Math.round(lh * 10) / 10, px(s['line-height']), tol.px);
    const ls = figmaLetterSpacingPx(f.letterSpacing, f.size);
    if (ls != null && ls !== 0)
      numCheck('letter-spacing', Math.round(ls * 100) / 100,
        s['letter-spacing'] === 'normal' ? 0 : px(s['letter-spacing']), tol.px);
    if (f.case && f.case !== 'mixed') {
      const exp = textCaseToCss(f.case);
      if (exp !== 'none') add('text-transform', exp, s['text-transform'], exp === s['text-transform']);
    }
    if (f.align) {
      const exp = textAlignToCss(f.align);
      const act = s['text-align'] === 'start' ? 'left' : s['text-align'];
      if (exp !== 'left') add('text-align', exp, act, exp === act);
    }
    const fill = solidFill(fig.fills);
    if (fill) colorCheck('color', fill.color, fill.opacity, s.color);
  }

  if (fig.type !== 'TEXT') {
    const fill = solidFill(fig.fills);
    if (fill) colorCheck('background-color', fill.color, fill.opacity, s['background-color']);
    if (fig.cornerRadius != null) {
      const r = Array.isArray(fig.cornerRadius) ? fig.cornerRadius[0] : fig.cornerRadius;
      numCheck('border-radius', r, px(s['border-radius']), tol.px);
    }
    if (fig.strokes?.length && fig.strokeWeight !== 'mixed') {
      numCheck('border-width', fig.strokeWeight, px(s['border-top-width']), tol.px);
      colorCheck('border-color', fig.strokes[0].color, fig.strokes[0].opacity, s['border-top-color']);
    }
    if (fig.layout) {
      const [pt, pr, pb, pl] = fig.layout.padding;
      numCheck('padding-top', pt, px(s['padding-top']), tol.px);
      numCheck('padding-right', pr, px(s['padding-right']), tol.px);
      numCheck('padding-bottom', pb, px(s['padding-bottom']), tol.px);
      numCheck('padding-left', pl, px(s['padding-left']), tol.px);
      if ((s.display === 'flex' || s.display === 'grid') && s.gap !== 'normal')
        numCheck('gap', fig.layout.gap, px(s['row-gap'] === 'normal' ? s['column-gap'] : s['row-gap']), tol.px);
    }
  }

  return checks;
}

export const DOM_PROPS = [
  'font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing',
  'text-transform', 'text-align', 'color',
  'background-color', 'border-radius', 'border-top-width', 'border-top-color',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'display', 'gap', 'row-gap', 'column-gap',
];
