import { PNG } from 'pngjs';

const parseHex = (c) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(c).trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

export function flattenPng(base64, bg) {
  const rgb = parseHex(bg);
  if (!rgb) return null;
  try {
    const img = PNG.sync.read(Buffer.from(base64, 'base64'));
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const a = d[i + 3] / 255;
      if (a === 1) continue;
      d[i] = Math.round(d[i] * a + rgb[0] * (1 - a));
      d[i + 1] = Math.round(d[i + 1] * a + rgb[1] * (1 - a));
      d[i + 2] = Math.round(d[i + 2] * a + rgb[2] * (1 - a));
      d[i + 3] = 255;
    }
    return PNG.sync.write(img).toString('base64');
  } catch {
    return null;
  }
}
