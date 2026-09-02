import fs from 'node:fs';
import path from 'node:path';
import { expandTree } from './expand.mjs';

export const slug = (s) =>
  s.toLowerCase().replace(/[^a-z0-9\u0430-\u044f\u0451]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'frame';

export function saveFrames(frames, snapDir, libs = {}) {
  fs.mkdirSync(snapDir, { recursive: true });
  const saved = [];
  for (const f of frames) {
    // two frames with the same name ("Навигация/каталог (modal)" ×2) must not
    // overwrite each other: the second one gets the id appended
    let base = slug(f.frameName);
    const existing = path.join(snapDir, `${base}.json`);
    if (fs.existsSync(existing)) {
      try {
        const prev = JSON.parse(fs.readFileSync(existing, 'utf8'));
        if (prev.frameId && f.frameId && prev.frameId !== f.frameId) base = `${base}-${slug(f.frameId)}`;
      } catch { /* unreadable — overwrite */ }
    }
    const { png, ...meta } = f;
    const compLib = f.compLib ?? libs.compLib;
    if (compLib && meta.tree) meta.tree = expandTree(meta.tree, compLib);
    delete meta.compLib;
    if (libs.svgLib && !meta.svgLib) meta.svgLib = libs.svgLib;
    meta.savedAt = new Date().toISOString();
    fs.writeFileSync(path.join(snapDir, `${base}.json`), JSON.stringify(meta, null, 1));
    saved.push(`snapshots/${base}.json`);
    if (png) {
      fs.writeFileSync(path.join(snapDir, `${base}.png`), Buffer.from(png, 'base64'));
      saved.push(`snapshots/${base}.png`);
    }
    console.log(`[ingest] ${f.frameName} → ${base}.json${png ? ' + png' : ''} (${f.width}×${f.height})`);
  }
  return saved;
}
