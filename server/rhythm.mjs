// Design-rule audit that per-node checks and sweep miss: vertical rhythm between blocks,
// plate paddings vs plate shape, labels/titles running to too many lines, tiny text.
// npm run rhythm -- --page catalog [--widths 357,912,1100] [--shots]
//   --shots: also save one viewport screenshot per block to reports/rhythm/<page>-<width>-NN.png
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) args[a.slice(2)] = (process.argv[i + 1] ?? '--').startsWith('--') ? true : process.argv[++i];
}
const pages = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/pages.json'), 'utf8'));
const page = args.page ?? 'home';
const url = args.url ?? pages[page]?.url;
if (!url) { console.error(`No page "${page}"`); process.exit(2); }
const widths = String(args.widths ?? '357,390,600,768,912,992,1100,1199,1300').split(',').map(Number);
const auth = process.env.PG_HTTP_AUTH;

// runs in the page
function probe() {
  const vis = (e) => { const r = e.getBoundingClientRect(); const c = getComputedStyle(e); return r.width > 0 && r.height > 0 && c.visibility !== 'hidden' && c.display !== 'none'; };
  const sel = (el) => {
    const p = [];
    for (let e = el, d = 0; e && e.nodeType === 1 && d < 3; e = e.parentElement, d++) {
      let s = e.tagName.toLowerCase();
      if (e.id) { p.unshift(s + '#' + e.id); break; }
      const cls = [...e.classList].filter((c) => !/^(is-|active|show|swiper-slide-|col-)/.test(c)).slice(0, 2);
      if (cls.length) s += '.' + cls.join('.');
      p.unshift(s);
    }
    return p.join(' > ');
  };
  const header = document.querySelector('.header-wrap, header');
  const footer = document.querySelector('.pr-footer, footer');
  const fTop = footer ? footer.getBoundingClientRect().top + scrollY : Infinity;
  // blocks: descend from body while an element is just a wrapper around the whole content
  let root = document.querySelector('#pp-main, main, #main, .site-content') || document.body;
  const kids = (e) => [...e.children].filter((k) => vis(k) && k.getBoundingClientRect().height > 30 && !['SCRIPT', 'STYLE'].includes(k.tagName) && getComputedStyle(k).position !== 'fixed');
  for (let i = 0; i < 6; i++) { const k = kids(root); if (k.length === 1) root = k[0]; else break; }
  let blocks = kids(root).flatMap((b) => { const k = kids(b); return k.length > 1 && b.getBoundingClientRect().height > 1400 ? k : [b]; });
  blocks = blocks.filter((b) => b.getBoundingClientRect().top + scrollY < fTop);
  const rows = blocks.map((b) => { const r = b.getBoundingClientRect(); return { sel: sel(b), top: Math.round(r.top + scrollY), bottom: Math.round(r.bottom + scrollY), h: Math.round(r.height) }; });
  rows.forEach((r, i) => { r.gap = i ? r.top - rows[i - 1].bottom : r.top - Math.round((header?.getBoundingClientRect().bottom ?? 0) + scrollY); });

  const issues = [];
  for (const el of document.body.querySelectorAll('*')) {
    if (!vis(el) || el.closest('.header-wrap, .pr-footer, footer, .modal:not(.show), [hidden], svg')) continue;
    const c = getComputedStyle(el); const r = el.getBoundingClientRect();
    // plates: a filled or image-backed rounded box with its own padding
    const filled = (c.backgroundColor !== 'rgba(0, 0, 0, 0)' && c.backgroundColor !== 'rgb(255, 255, 255)') || c.backgroundImage !== 'none';
    const pl = parseFloat(c.paddingLeft), pr = parseFloat(c.paddingRight), pt = parseFloat(c.paddingTop), pb = parseFloat(c.paddingBottom);
    if (filled && parseFloat(c.borderTopLeftRadius) >= 6 && r.width >= 120 && r.height >= 70 && (pl || pt) && !el.matches('button, a.pp-btn, input, .btn')) {
      const px = Math.min(pl, pr), py = Math.min(pt, pb);
      if (r.height > r.width * 1.15 && px > py + 1) issues.push({ type: 'pad-vertical-plate', sel: sel(el), info: `${Math.round(r.width)}×${Math.round(r.height)} pad ${py}/${px}` });
      if (r.width > r.height * 1.6 && py > px + 1) issues.push({ type: 'pad-horizontal-plate', sel: sel(el), info: `${Math.round(r.width)}×${Math.round(r.height)} pad ${py}/${px}` });
      if (Math.abs(pl - pr) > 12 && c.textAlign !== 'right') issues.push({ type: 'pad-asymmetric', sel: sel(el), info: `left ${pl} right ${pr}` });
    }
    const own = [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim().length > 1).map((n) => n.textContent.trim()).join(' ');
    if (!own) continue;
    const fs = parseFloat(c.fontSize); const lh = parseFloat(c.lineHeight) || fs * 1.2;
    const rg = document.createRange(); rg.selectNodeContents(el);
    const lines = new Set([...rg.getClientRects()].filter((q) => q.width > 2).map((q) => Math.round(q.top / (lh * 0.6)))).size;
    if (el.closest('.visually-hidden, .sr-only, .screen-reader-text')) continue;
    if (fs < 12) issues.push({ type: 'tiny-text', sel: sel(el), info: `${fs}px «${own.slice(0, 30)}»` });
    const labelish = el.matches('[class*="label"], [class*="badge"], [class*="chip"], [class*="tag"], [class*="tab"] > *, [class*="tab"]') && own.length < 40;
    if (labelish && lines > 1 && c.display !== 'inline') issues.push({ type: 'label-wraps', sel: sel(el), info: `${lines} lines «${own.slice(0, 30)}»` });
    if (/^H[1-4]$/.test(el.tagName) && lines > 3) issues.push({ type: 'heading-long', sel: sel(el), info: `${lines} lines ${fs}px «${own.slice(0, 30)}»` });
    if (el.scrollWidth > el.clientWidth + 2 && c.overflowX === 'hidden' && c.textOverflow !== 'ellipsis' && c.whiteSpace === 'nowrap') issues.push({ type: 'text-cut', sel: sel(el), info: `«${own.slice(0, 30)}»` });
  }
  const seen = new Set();
  return { rows, issues: issues.filter((i) => { const k = i.type + i.sel; if (seen.has(k)) return false; seen.add(k); return true; }) };
}

const browser = await chromium.launch();
const out = {};
const shotDir = path.join(ROOT, 'reports', 'rhythm');
if (args.shots) fs.mkdirSync(shotDir, { recursive: true });
for (const w of widths) {
  const ctx = await browser.newContext({
    viewport: { width: w, height: 1000 },
    ...(auth ? { httpCredentials: { username: auth.split(':')[0], password: auth.split(':').slice(1).join(':') } } : {}),
  });
  const pg = await ctx.newPage();
  await pg.goto(url, { waitUntil: 'load', timeout: 90000 });
  await pg.evaluate(async () => { document.getElementById('cookie-law-div')?.remove(); for (let y = 0; y < document.body.scrollHeight; y += 700) { scrollTo(0, y); await new Promise((r) => setTimeout(r, 70)); } scrollTo(0, 0); });
  await pg.waitForTimeout(500);
  const res = await pg.evaluate(probe);
  out[w] = res;
  console.log(`\n── ${page} @ ${w} ──`);
  for (const r of res.rows) console.log(`  gap ${String(r.gap).padStart(4)}  h ${String(r.h).padStart(5)}  ${r.sel}`);
  for (const i of res.issues) console.log(`  ! ${i.type.padEnd(20)} ${i.info}   ${i.sel}`);
  if (args.shots) {
    let n = 0;
    for (const r of res.rows) {
      n++;
      await pg.evaluate((y) => scrollTo(0, y), Math.max(0, r.top - 140));
      await pg.waitForTimeout(450);
      await pg.screenshot({ path: path.join(shotDir, `${page}-${w}-${String(n).padStart(2, '0')}.png`) });
    }
  }
  await ctx.close();
}
await browser.close();
fs.mkdirSync(path.join(ROOT, 'reports'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'reports', `rhythm-${page}.json`), JSON.stringify(out, null, 1));
console.log(`\n→ reports/rhythm-${page}.json`);
