import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { findNode } from './lib/resolve.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) args[a.slice(2)] = (process.argv[i + 1] ?? '--').startsWith('--') ? true : process.argv[++i];
}

const page = args.page ?? 'home';
const viewport = args.viewport ?? 'desktop';
const threshold = Number(args.threshold ?? 0.15);

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const pages = readJson(path.join(ROOT, 'config/pages.json'));
const viewports = readJson(path.join(ROOT, 'config/viewports.json'));
const pageCfg = pages[page];
if (!pageCfg) { console.error(`No page "${page}"`); process.exit(2); }
const width = viewports[viewport];

const frameId = pageCfg.frames?.[viewport];
let snapFile = null;
for (const f of fs.readdirSync(path.join(ROOT, 'snapshots')).filter((f) => f.endsWith('.json') && !f.startsWith('_'))) {
  const j = readJson(path.join(ROOT, 'snapshots', f));
  if (!j.tree) continue;
  if (frameId ? j.frameId === frameId || findNode(j.tree, frameId) : j.breakpoints?.some((b) => b.viewport === viewport)) { snapFile = f; break; }
}
if (!snapFile) { console.error(`Snapshot not found (page=${page}, viewport=${viewport}).`); process.exit(2); }

const pngPath = path.join(ROOT, 'snapshots', snapFile.replace(/\.json$/, '.png'));
if (!fs.existsSync(pngPath)) {
  console.error(`No design PNG: ${path.relative(ROOT, pngPath)}`);
  console.error('Re-export the frame with the plugin with the "export PNG" checkbox enabled.');
  process.exit(2);
}

console.log(`pixdiff: ${page} @ ${viewport} (${width}px) → ${pageCfg.url}`);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width, height: 1000 } });
const pg = await ctx.newPage();
const resp = await pg.goto(pageCfg.url, { waitUntil: 'load', timeout: 60000 });
if (resp && !resp.ok())
  throw new Error(`page responded with HTTP ${resp.status()} — nothing to compare: ${pageCfg.url}`);
await pg.addStyleTag({ content: '*,*::before,*::after{transition:none!important;animation:none!important;scroll-behavior:auto!important}' });
await pg.evaluate(async () => {
  for (let y = 0; y < document.body.scrollHeight; y += 800) { scrollTo(0, y); await new Promise((r) => setTimeout(r, 60)); }
  scrollTo(0, 0);
});
await pg.waitForTimeout(500);
const shotBuf = await pg.screenshot({ fullPage: true });
await browser.close();

const shot = PNG.sync.read(shotBuf);
const design = PNG.sync.read(fs.readFileSync(pngPath));

const w = Math.min(shot.width, design.width);
const h = Math.min(shot.height, design.height);
const crop = (src) => {
  const out = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    src.data.copy(out.data, y * w * 4, y * src.width * 4, y * src.width * 4 + w * 4);
  }
  return out;
};

const a = crop(design);
const b = crop(shot);
const diff = new PNG({ width: w, height: h });
const changed = pixelmatch(a.data, b.data, diff.data, w, h, { threshold, includeAA: true });
const pct = Math.round((changed / (w * h)) * 10000) / 100;

fs.mkdirSync(path.join(ROOT, 'reports'), { recursive: true });
const out = path.join(ROOT, 'reports', `${page}-${viewport}-pixdiff.png`);
fs.writeFileSync(out, PNG.sync.write(diff));

const band = Math.floor(h / 10) || 1;
const bands = [];
for (let i = 0; i < 10; i++) {
  let n = 0;
  for (let y = i * band; y < Math.min((i + 1) * band, h); y++) {
    for (let x = 0; x < w; x++) if (diff.data[(y * w + x) * 4] > 200) n++;
  }
  bands.push(Math.round((n / (band * w)) * 1000) / 10);
}

console.log(`  design ${design.width}×${design.height} · site ${shot.width}×${shot.height} · compared ${w}×${h}`);
if (Math.abs(design.height - shot.height) > 40) {
  console.log(`  ⚠ height differs by ${Math.abs(design.height - shot.height)}px — comparing the common top part`);
}
console.log(`\n  mismatch: ${pct}% of pixels (${changed.toLocaleString('ru')})\n`);
console.log('  vertical (10 bands top to bottom):');
for (const [i, v] of bands.entries()) {
  const bar = '█'.repeat(Math.min(40, Math.round(v / 2)));
  console.log(`   ${String(i * 10).padStart(3)}%  ${String(v).padStart(5)}%  ${bar}`);
}
console.log(`\n→ reports/${path.basename(out)}`);
process.exit(pct > 10 ? 1 : 0);
