export function parseCssColor(s) {
  if (!s) return null;
  const m = s.match(/rgba?\(([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)(?:[,/ ]+([\d.]+))?\)/);
  if (m) {
    const h = (n) => Number(n).toString(16).padStart(2, '0');
    return { hex: `#${h(m[1])}${h(m[2])}${h(m[3])}`, alpha: m[4] === undefined ? 1 : Number(m[4]) };
  }
  if (s.startsWith('#')) {
    const hex = s.length === 4 ? '#' + [...s.slice(1)].map((c) => c + c).join('') : s.slice(0, 7);
    return { hex: hex.toLowerCase(), alpha: 1 };
  }
  return null;
}

export const px = (s) => (s == null ? null : Math.round(parseFloat(s) * 10) / 10);

export function figmaLineHeightPx(lh, fontSize) {
  if (!lh || lh === 'mixed' || lh.unit === 'AUTO') return null;
  if (lh.unit === 'PIXELS') return lh.value;
  if (lh.unit === 'PERCENT') return (lh.value / 100) * fontSize;
  return null;
}

export function figmaLetterSpacingPx(ls, fontSize) {
  if (!ls || ls === 'mixed' || !Number.isFinite(ls.value)) return null;
  if (ls.unit === 'PIXELS') return ls.value;
  if (ls.unit === 'PERCENT')
    return Number.isFinite(fontSize) ? (ls.value / 100) * fontSize : null;
  return null;
}

export const textCaseToCss = (c) =>
  ({ ORIGINAL: 'none', UPPER: 'uppercase', LOWER: 'lowercase', TITLE: 'capitalize' }[c] ?? 'none');

export const textAlignToCss = (a) =>
  ({ LEFT: 'left', CENTER: 'center', RIGHT: 'right', JUSTIFIED: 'justify' }[a] ?? 'left');

export function firstFontFamily(cssStack) {
  if (!cssStack) return null;
  return cssStack.split(',')[0].trim().replace(/^["']|["']$/g, '');
}

export const solidFill = (fills) =>
  Array.isArray(fills) ? fills.find((f) => f.type === 'solid') : null;
