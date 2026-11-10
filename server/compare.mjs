// Side-by-side visual review: design frame (rendered by the plugin through the
// running server) next to a full-page screenshot of the site, sliced into
// chunks small enough to look at. Plus pixelmatch % per chunk.
// npm run compare -- --page home --viewport tablet [--fresh] [--chunk 1600]
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
const viewport = args.viewport ?? 'tablet';
const chunk = Number(args.chunk ?? 1600);
const SERVER = process.env.PG_SERVER ?? 'http://127.0.0.1:8971';

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const pages = readJson(path.join(ROOT, 'config/pages.json'));
const viewports = readJson(path.join(ROOT, 'config/viewports.json'));
const cfg = pages[page];
if (!cfg) { console.error(`No page "${page}"`); process.exit(2); }
const width = viewports[viewport];
const frameId = cfg.frames?.[viewport];
if (!frameId) { console.error(`No frames.${viewport} for ${page}`); process.exit(2); }

// render the whole breakpoint frame (with header/footer), even if the map points at its inner 'main'
let renderId = frameId, renderNode = null;
for (const f of fs.readdirSync(path.join(ROOT, 'snapshots')).filter((f) => f.endsWith('.json') && !f.startsWith('_'))) {
  const j = readJson(path.join(ROOT, 'snapshots', f));
  if (!j.tree || !findNode(j.tree, frameId)) continue;
  renderNode = findNode(j.tree, frameId);
  const bp = (j.breakpoints ?? []).find((b) => b.viewport === viewport && (b.id === frameId || findNode(findNode(j.tree, b.id) ?? {}, frameId)));
  if (bp) { renderId = bp.id; renderNode = findNode(j.tree, bp.id); }
  break;
}

const framesDir = path.join(ROOT, 'snapshots', 'frames');
fs.mkdirSync(framesDir, { recursive: true });
const designPath = path.join(framesDir, `${renderId.replace(/[:;]/g, '_')}.png`);
if (args.fresh || !fs.existsSync(designPath)) {
  console.log(`rendering ${renderId} via plugin…`);
  const r = await fetch(`${SERVER}/render?id=${encodeURIComponent(renderId)}&format=PNG&scale=1&timeout=300`);
  if (!r.ok) { console.error(`render failed: ${r.status} ${(await r.text()).slice(0, 300)}`); process.exit(1); }
  fs.writeFileSync(designPath, Buffer.from(await r.arrayBuffer()));
}
const design = PNG.sync.read(fs.readFileSync(designPath));

const auth = process.env.PG_HTTP_AUTH;
const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width, height: 1000 },
  ...(auth ? { httpCredentials: { username: auth.split(':')[0], password: auth.split(':').slice(1).join(':') } } : {}),
});
const pg = await ctx.newPage();
await pg.goto(args.url ?? cfg.url, { waitUntil: 'load', timeout: 90000 });
await pg.addStyleTag({ content: '*,*::before,*::after{transition:none!important;animation:none!important;scroll-behavior:auto!important}' });
await pg.evaluate(async () => {
  for (let y = 0; y < document.body.scrollHeight; y += 700) { scrollTo(0, y); await new Promise((r) => setTimeout(r, 80)); }
  scrollTo(0, 0);
});
await pg.waitForTimeout(800);
// a full-page shot repeats fixed layers (cookie bar, mobile tab bar) mid-page: hide them, unstick sticky ones
await pg.evaluate(() => {
  for (const el of document.querySelectorAll('body *')) {
    const p = getComputedStyle(el).position;
    if (p === 'fixed') el.style.setProperty('display', 'none', 'important');
    else if (p === 'sticky') el.style.setProperty('position', 'static', 'important');
  }
});
await pg.waitForTimeout(200);
const site = PNG.sync.read(await pg.screenshot({ fullPage: true }));
await browser.close();

// design may be rendered at a different scale — normalise to viewport width
const scaleTo = (img, w) => {
  if (img.width === w) return img;
  const k = img.width / w, h = Math.round(img.height / k), out = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const s = (Math.min(img.height - 1, Math.floor(y * k)) * img.width + Math.min(img.width - 1, Math.floor(x * k))) * 4, d = (y * w + x) * 4;
    out.data[d] = img.data[s]; out.data[d + 1] = img.data[s + 1]; out.data[d + 2] = img.data[s + 2]; out.data[d + 3] = 255;
  }
  return out;
};
// shadow bleed around the frame is an offset, not a scale: cut it off instead of squeezing the render
const unbleed = (img) => {
  const bx = img.width - (renderNode?.w ?? img.width);
  if (!renderNode || bx <= 0 || bx >= renderNode.w * 0.15) return img;
  const ox = Math.round(bx / 2), oy = Math.round(Math.max(0, Math.min(img.height - renderNode.h, bx / 2)));
  const out = new PNG({ width: Math.round(renderNode.w), height: img.height - oy });
  PNG.bitblt(img, out, ox, oy, out.width, out.height, 0, 0);
  return out;
};
const D = scaleTo(unbleed(design), width), S = scaleTo(site, width);
const H = Math.max(D.height, S.height), GAP = 16;

const outDir = path.join(ROOT, 'reports', 'compare');
fs.mkdirSync(outDir, { recursive: true });
for (const f of fs.readdirSync(outDir)) if (f.startsWith(`${page}-${viewport}-`)) fs.unlinkSync(path.join(outDir, f));

const files = [];
for (let y0 = 0, n = 1; y0 < H; y0 += chunk, n++) {
  const h = Math.min(chunk, H - y0), W = width * 2 + GAP;
  const out = new PNG({ width: W, height: h });
  out.data.fill(0); for (let i = 3; i < out.data.length; i += 4) out.data[i] = 255;
  for (let i = 0; i < h; i++) for (let x = width; x < width + GAP; x++) { const d = (i * W + x) * 4; out.data[d] = 220; out.data[d + 1] = 30; out.data[d + 2] = 30; }
  const blit = (img, ox) => {
    for (let i = 0; i < h; i++) {
      const sy = y0 + i; if (sy >= img.height) break;
      img.data.copy(out.data, (i * W + ox) * 4, sy * img.width * 4, (sy + 1) * img.width * 4);
    }
  };
  blit(D, 0); blit(S, width + GAP);
  // pixel diff on the overlapping part of this chunk
  const oh = Math.max(0, Math.min(h, D.height - y0, S.height - y0));
  let pct = null;
  if (oh > 0) {
    const a = new PNG({ width, height: oh }), b = new PNG({ width, height: oh });
    D.data.copy(a.data, 0, y0 * width * 4, (y0 + oh) * width * 4);
    S.data.copy(b.data, 0, y0 * width * 4, (y0 + oh) * width * 4);
    pct = (pixelmatch(a.data, b.data, null, width, oh, { threshold: 0.15 }) / (width * oh)) * 100;
  }
  const file = path.join(outDir, `${page}-${viewport}-${String(n).padStart(2, '0')}.png`);
  fs.writeFileSync(file, PNG.sync.write(out));
  files.push(file);
  console.log(`${path.relative(ROOT, file)}  y ${y0}–${y0 + h}  diff ${pct === null ? '—' : pct.toFixed(1) + '%'}`);
}
console.log(`design ${D.height}px · site ${S.height}px (${S.height - D.height >= 0 ? '+' : ''}${S.height - D.height}) · left = design, right = site`);
