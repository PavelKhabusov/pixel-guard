// Block-by-block review: every block of the design breakpoint frame next to the matching
// block of the live page, one image per pair, plus a diff of the texts (what the design
// shows that the site does not, and the other way round — buttons, phones, labels).
// npm run blocks -- --page home --viewport mobile [--fresh] [--width 390]
// Design blocks are cropped from the cached frame render (snapshots/frames, same cache as compare).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import { findNode } from './lib/resolve.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) args[a.slice(2)] = (process.argv[i + 1] ?? '--').startsWith('--') ? true : process.argv[++i];
}
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const pages = readJson(path.join(ROOT, 'config/pages.json'));
const viewports = readJson(path.join(ROOT, 'config/viewports.json'));
const page = args.page ?? 'home';
const viewport = args.viewport ?? 'mobile';
const cfg = pages[page];
if (!cfg) { console.error(`No page "${page}"`); process.exit(2); }
const width = Number(args.width ?? viewports[viewport]);
const SERVER = process.env.PG_SERVER ?? 'http://127.0.0.1:8971';
const url = args.url ?? cfg.url;

// ── design: breakpoint frame, its blocks, cached render ──
let frame = null;
for (const f of fs.readdirSync(path.join(ROOT, 'snapshots')).filter((f) => f.endsWith('.json') && !f.startsWith('_'))) {
  const j = readJson(path.join(ROOT, 'snapshots', f));
  if (!j.tree) continue;
  const want = cfg.frames?.[viewport];
  const bp = (j.breakpoints ?? []).find((b) => b.viewport === viewport && (!want || b.id === want || findNode(findNode(j.tree, b.id) ?? {}, want)));
  if (bp && (want ? true : (cfg.snapshot ? f.startsWith(cfg.snapshot) : false) || (j.breakpoints ?? []).some((b) => b.id === cfg.frames?.desktop))) { frame = findNode(j.tree, bp.id); break; }
}
if (!frame) { console.error(`No ${viewport} frame for "${page}" (config frames.${viewport})`); process.exit(2); }
const framesDir = path.join(ROOT, 'snapshots', 'frames');
fs.mkdirSync(framesDir, { recursive: true });
const designPath = path.join(framesDir, `${frame.id.replace(/[:;]/g, '_')}.png`);
if (args.fresh || !fs.existsSync(designPath)) {
  console.log(`rendering ${frame.id} via plugin…`);
  const r = await fetch(`${SERVER}/render?id=${encodeURIComponent(frame.id)}&format=PNG&scale=1&timeout=300`);
  if (!r.ok) { console.error(`render failed: ${r.status} — open Figma with the plugin in live mode, or reuse a cached frame`); process.exit(1); }
  fs.writeFileSync(designPath, Buffer.from(await r.arrayBuffer()));
}
const design = PNG.sync.read(fs.readFileSync(designPath));
// a frame that does not clip is rendered with its spilling shadows: extra pixels on the sides and on top are an offset, not a scale
const spill = Math.abs(design.width / frame.w - design.height / frame.h) > 0.003 && design.width - frame.w < 80;
const dScale = spill ? 1 : design.width / frame.w;
const dOx = spill ? (design.width - frame.w) / 2 : 0, dOy = spill ? Math.max(0, design.height - frame.h) : 0;

const texts = (n, out = []) => { if (n.type === 'TEXT' && (n.text ?? n.characters)) out.push(String(n.text ?? n.characters).replace(/\s+/g, ' ').trim()); for (const c of n.children ?? []) texts(c, out); return out; };
const kids = (n) => (n.children ?? []).filter((c) => c.visible !== false && c.h > 24 && c.w > 40);
const dBlocks = [];
const collect = (n, depth) => {
  for (const c of kids(n)) {
    const k = kids(c);
    const wrapper = k.length >= 2 && c.h > 900 && depth < 3 && !(c.fills ?? []).length && !c.cornerRadius;
    if (wrapper || (k.length === 1 && k[0].h > c.h * 0.9 && depth < 3) || (k.length >= 2 && c.h > 1300 && depth < 7 && !/^(footer|header|menu)/i.test(c.name ?? ''))) collect(c, depth + 1);
    else dBlocks.push({ id: c.id, name: c.name, x: c.x - frame.x, y: c.y - frame.y, w: c.w, h: c.h, texts: texts(c) });
  }
};
collect(frame, 0);
dBlocks.sort((a, b) => a.y - b.y);

// ── site blocks ──
function probe() {
  const vis = (e) => { const r = e.getBoundingClientRect(); const c = getComputedStyle(e); return r.width > 40 && r.height > 24 && c.visibility !== 'hidden' && c.display !== 'none'; };
  const sel = (el) => { const p = []; for (let e = el, d = 0; e && e.nodeType === 1 && d < 3; e = e.parentElement, d++) { let s = e.tagName.toLowerCase(); if (e.id) { p.unshift(s + '#' + e.id); break; } const cls = [...e.classList].filter((c) => !/^(is-|active|show|col-|container$|row$)/.test(c)).slice(0, 2); if (cls.length) s += '.' + cls.join('.'); p.unshift(s); } return p.join(' > '); };
  const kids = (e) => [...e.children].filter((k) => vis(k) && !['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(k.tagName) && getComputedStyle(k).position !== 'fixed');
  const out = [];
  const push = (e) => { const r = e.getBoundingClientRect(); e.setAttribute('data-pg-block', out.length); out.push({ sel: sel(e), y: Math.round(r.top + scrollY), h: Math.round(r.height), text: e.innerText.replace(/\s+/g, ' ').trim().slice(0, 4000) }); };
  const walk = (n, depth) => { for (const c of kids(n)) { const k = kids(c); const cs = getComputedStyle(c); const plain = cs.backgroundColor === 'rgba(0, 0, 0, 0)' && cs.backgroundImage === 'none' && parseFloat(cs.borderTopLeftRadius) === 0; const ch = c.getBoundingClientRect().height; if ((k.length >= 2 && ch > 900 && depth < 4 && plain) || (k.length === 1 && depth < 5 && plain) || (k.length >= 1 && ch > 1300 && depth < 9)) walk(c, depth + 1); else push(c); } };
  const header = document.querySelector('.header-wrap'); if (header && vis(header)) push(header);
  walk(document.querySelector('#pp-main, main, #main, .site-content') || document.body, 0);
  for (const q of ['.pr-footer, footer', '.mobil.footer_menu']) { const e = document.querySelector(q); if (e && e.getBoundingClientRect().height > 24 && !e.hasAttribute('data-pg-block')) push(e); }
  return out;
}
const auth = process.env.PG_HTTP_AUTH;
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width, height: 1000 }, ...(auth ? { httpCredentials: { username: auth.split(':')[0], password: auth.split(':').slice(1).join(':') } } : {}) });
const pg = await ctx.newPage();
await pg.goto(url, { waitUntil: 'load', timeout: 90000 });
// fixed bars would sit on top of every block screenshot
await pg.addStyleTag({ content: '*,*::before,*::after{transition:none!important;animation:none!important;scroll-behavior:auto!important}#cookie-law-div,.mobil.footer_menu,.pr-ftab{display:none!important}.header-wrap{position:absolute!important}' + (width < 576 ? 'html{scrollbar-width:none!important;scrollbar-gutter:auto!important}html::-webkit-scrollbar,body::-webkit-scrollbar{display:none!important}' : '') });
// phones have overlay scrollbars: the theme's reserved scrollbar gutter would eat layout width in desktop Chromium
await pg.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 600) { scrollTo(0, y); await new Promise((r) => setTimeout(r, 90)); } scrollTo(0, 0); });
await pg.waitForTimeout(600);
const sBlocks = await pg.evaluate(probe);

// ── pairing by shared words ──
const tok = (s) => new Set(String(s).toLowerCase().match(/[a-zа-яё0-9]{4,}/g) ?? []);
const dTok = dBlocks.map((b) => tok(b.texts.join(' ')));
const sTok = sBlocks.map((b) => tok(b.text));
const score = (a, b) => { if (!a.size || !b.size) return 0; let n = 0; for (const t of a) if (b.has(t)) n++; return n / Math.min(a.size, b.size); };
const cand = [];
dBlocks.forEach((d, i) => sBlocks.forEach((s, j) => { const sc = score(dTok[i], sTok[j]); if (sc >= 0.25) cand.push([sc, i, j]); }));
cand.sort((a, b) => b[0] - a[0]);
const dTo = new Map(), sUsed = new Set();
for (const [, i, j] of cand) if (!dTo.has(i) && !sUsed.has(j)) { dTo.set(i, j); sUsed.add(j); }
// leftovers: pair by position between already matched neighbours (blocks without text — photos, video strips)
for (let i = 0; i < dBlocks.length; i++) {
  if (dTo.has(i)) continue;
  let lo = -1, hi = sBlocks.length;
  for (let a = i - 1; a >= 0; a--) if (dTo.has(a)) { lo = dTo.get(a); break; }
  for (let a = i + 1; a < dBlocks.length; a++) if (dTo.has(a)) { hi = dTo.get(a); break; }
  for (let j = lo + 1; j < hi; j++) if (!sUsed.has(j)) { dTo.set(i, j); sUsed.add(j); break; }
}

// ── images ──
const outDir = path.join(ROOT, 'reports', 'blocks', `${page}-${viewport}`);
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
const MAXH = 1700;
const crop = (b) => {
  const x = Math.max(0, Math.round(b.x * dScale + dOx)), y = Math.max(0, Math.round(b.y * dScale + dOy));
  const w = Math.min(design.width - x, Math.round(b.w * dScale)), h = Math.min(design.height - y, Math.round(Math.min(b.h, MAXH) * dScale));
  if (w <= 0 || h <= 0) return null;
  const o = new PNG({ width: w, height: h });
  PNG.bitblt(design, o, x, y, w, h, 0, 0);
  return o;
};
const siteShot = async (j) => {
  const el = pg.locator(`[data-pg-block="${j}"]`);
  await el.scrollIntoViewIfNeeded().catch(() => {});
  await pg.waitForTimeout(350);
  const box = await el.boundingBox();
  if (!box) return null;
  await pg.setViewportSize({ width, height: Math.min(MAXH, Math.max(300, Math.ceil(box.height) + 140)) });
  await pg.evaluate((j) => { const e = document.querySelector(`[data-pg-block="${j}"]`); scrollTo(0, e.getBoundingClientRect().top + scrollY - 70); }, j);
  await pg.waitForTimeout(450);
  const b2 = await el.boundingBox();
  const buf = await pg.screenshot({ clip: { x: 0, y: Math.max(0, b2.y), width, height: Math.min(MAXH - Math.max(0, b2.y), b2.height) } });
  return PNG.sync.read(buf);
};
const side = (a, b) => {
  const gap = 24, w = (a?.width ?? 0) + gap + (b?.width ?? 0), h = Math.max(a?.height ?? 1, b?.height ?? 1);
  const o = new PNG({ width: w, height: h });
  o.data.fill(0xdd);
  for (let i = 3; i < o.data.length; i += 4) o.data[i] = 255;
  if (a) PNG.bitblt(a, o, 0, 0, a.width, a.height, 0, 0);
  if (b) PNG.bitblt(b, o, 0, 0, b.width, b.height, (a?.width ?? 0) + gap, 0);
  return o;
};
const items = [];
const phrases = (arr) => arr.map((t) => t.trim()).filter((t) => t.length >= 3 && t.length <= 60);
let n = 0;
for (let i = 0; i < dBlocks.length; i++) {
  const d = dBlocks[i], j = dTo.get(i);
  const dImg = crop(d), sImg = j !== undefined ? await siteShot(j) : null;
  const file = `${String(++n).padStart(2, '0')}.png`;
  fs.writeFileSync(path.join(outDir, file), PNG.sync.write(side(dImg, sImg)));
  const s = j !== undefined ? sBlocks[j] : null;
  const sText = s ? s.text.toLowerCase() : '';
  const onlyDesign = s ? phrases(d.texts).filter((t) => !sText.includes(t.toLowerCase())) : [];
  items.push({ file, design: { id: d.id, name: d.name, w: Math.round(d.w), h: Math.round(d.h) }, site: s && { sel: s.sel, h: s.h }, onlyDesign: [...new Set(onlyDesign)].slice(0, 25) });
}
for (let j = 0; j < sBlocks.length; j++) {
  if (sUsed.has(j)) continue;
  const sImg = await siteShot(j);
  const file = `${String(++n).padStart(2, '0')}.png`;
  fs.writeFileSync(path.join(outDir, file), PNG.sync.write(side(null, sImg)));
  items.push({ file, design: null, site: { sel: sBlocks[j].sel, h: sBlocks[j].h }, onlyDesign: [] });
}
await browser.close();
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const html = `<!doctype html><html lang="ru"><meta charset="utf-8"><title>${esc(page)} · ${viewport} — блоки</title><style>body{margin:0;padding:20px;background:#1b1b1b;color:#eee;font:14px/1.45 system-ui,Arial}h1{font-size:20px}section{margin:0 0 34px;padding:14px;background:#262626;border-radius:10px}h2{font-size:15px;margin:0 0 8px}h2 small{color:#999;font-weight:400}img{max-width:100%;height:auto;display:block;border-radius:6px}.miss{color:#ff7b7b}.od{color:#ffd27b;font-size:13px;margin:6px 0 10px}</style><h1>${esc(page)} · ${viewport} (${width}px) — слева макет, справа сайт</h1>`
  + items.map((it) => `<section><h2>${esc(it.file)} · ${it.design ? `макет ${esc(it.design.id)} «${esc(it.design.name)}» ${it.design.w}×${it.design.h}` : '<span class="miss">в макете пары нет</span>'} <small>· ${it.site ? `сайт ${esc(it.site.sel)} h${it.site.h}` : '<span class="miss">на сайте пары нет</span>'}</small></h2>${it.onlyDesign.length ? `<div class="od">Тексты макета, которых нет на сайте: ${it.onlyDesign.map(esc).join(' · ')}</div>` : ''}<img loading="lazy" src="${esc(it.file)}"></section>`).join('');
fs.writeFileSync(path.join(outDir, 'index.html'), html);
fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(items, null, 1));
console.log(`${page} ${viewport}: design blocks ${dBlocks.length}, site blocks ${sBlocks.length}, paired ${dTo.size}`);
for (const it of items) console.log(`  ${it.file}  ${it.design ? it.design.id.padEnd(22) + ' ' + String(it.design.name).slice(0, 24).padEnd(24) : '— нет в макете —'.padEnd(47)}  ${it.site ? it.site.sel.slice(0, 60) : '— нет на сайте —'}${it.onlyDesign.length ? `\n        только в макете: ${it.onlyDesign.slice(0, 8).join(' | ')}` : ''}`);
console.log(`→ reports/blocks/${page}-${viewport}/index.html`);
